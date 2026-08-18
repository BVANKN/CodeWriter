import { WebSocketServer } from 'ws';
import config from '../config.js';
import { createLogger } from '../logger.js';
import { prefixedId, uuid } from '../util/ids.js';
import { AppError, unavailable } from '../util/errors.js';
import { FRAME, AGENT_EVENT, SERVER_EVENT, PROTOCOL_VERSION, isValidFrame } from './protocol.js';

const log = createLogger('bridge');

/** Frames larger than this are refused outright rather than buffered. */
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/**
 * How often we ping; a connection that misses two in a row is dropped.
 *
 * Kept well under a minute because hosting proxies drop idle WebSockets, and a
 * zombie connection is worse than a closed one: a closed one fails fast, a
 * zombie swallows requests until they time out.
 */
const HEARTBEAT_MS = 15_000;

/**
 * One connected CodeWriter desktop app.
 *
 * Every filesystem operation the MCP server performs is a request across this
 * socket. That indirection is the security model as much as the architecture:
 * the backend cannot touch a path the agent will not touch for it, and the
 * agent revalidates every path against the workspace root it actually opened.
 */
class AgentConnection {
  /**
   * @param {import('ws').WebSocket} socket
   * @param {object} context
   * @param {object} context.user
   * @param {AgentHub} context.hub
   */
  constructor(socket, { user, hub, info }) {
    this.id = prefixedId('agent');
    this.socket = socket;
    this.user = user;
    this.hub = hub;
    this.info = info || {};
    this.connectedAt = Date.now();
    this.alive = true;

    /** @type {Map<string, { resolve: Function, reject: Function, timer: NodeJS.Timeout, method: string }>} */
    this.pending = new Map();

    /** Live command runs, so output events can be routed to their waiters. */
    this.commandStreams = new Map();
  }

  get userId() {
    return this.user.id;
  }

  /**
   * Sends a request and waits for the matching response.
   *
   * @param {string} method
   * @param {object} params
   * @param {object} [options]
   * @param {number} [options.timeoutMs]
   * @returns {Promise<object>}
   */
  request(method, params, { timeoutMs = config.bridgeRpcTimeoutMs } = {}) {
    if (this.socket.readyState !== this.socket.OPEN) {
      return Promise.reject(
        unavailable('The CodeWriter desktop app disconnected. Reopen it and try again.')
      );
    }

    const id = uuid();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new AppError(
            'AGENT_TIMEOUT',
            `The desktop app did not respond to "${method}" within ${Math.round(timeoutMs / 1000)}s.`,
            { status: 504 }
          )
        );
      }, timeoutMs);
      // A slow build must not be able to hold the process open by itself.
      if (typeof timer.unref === 'function') timer.unref();

      this.pending.set(id, { resolve, reject, timer, method });
      this.send({ t: FRAME.REQUEST, id, method, params });
    });
  }

  /**
   * Confirms the desktop app is genuinely reachable, not just that the socket
   * claims to be open.
   *
   * A WebSocket through a proxy can be half-open: the far side is gone, no
   * close frame ever arrived, `readyState` still reads OPEN, and everything we
   * send disappears. Reads keep working because they come from the backend's
   * own index, so the failure looks like "reads fine, writes hang" — which is
   * maddening to diagnose from the client side.
   *
   * One cheap round trip before any mutation turns that into an immediate,
   * accurate error. If it fails we tear the connection down so the desktop app
   * reconnects rather than lingering as a zombie.
   *
   * @returns {Promise<number>} round-trip time in ms
   */
  async ensureAlive() {
    const started = Date.now();
    try {
      await this.request('ping', {}, { timeoutMs: config.bridgePingTimeoutMs });
      return Date.now() - started;
    } catch (err) {
      log.warn(`Agent ${this.id} failed a liveness check; terminating the socket`, err.message);
      try {
        this.socket.terminate();
      } catch {
        /* the close handler will clean up */
      }
      throw unavailable(
        'The CodeWriter desktop app is not responding. Its connection appears to have dropped ' +
          'without closing cleanly. It should reconnect automatically within a few seconds - ' +
          'wait a moment and retry. If it does not, bring the app to the foreground and check the ' +
          'Connection panel.'
      );
    }
  }

  /** Fire-and-forget event down to the desktop app. */
  emit(event, payload) {
    this.send({ t: FRAME.EVENT, event, ...payload });
  }

  send(frame) {
    if (this.socket.readyState !== this.socket.OPEN) return;
    let serialised;
    try {
      serialised = JSON.stringify(frame);
    } catch (err) {
      log.error('Failed to serialise a frame', err);
      return;
    }
    this.socket.send(serialised);
  }

  settle(id, ok, payload) {
    const waiter = this.pending.get(id);
    if (!waiter) {
      // A response to a request we already timed out. Nothing to do, but worth
      // knowing about: it usually means the timeout is tuned too tightly.
      log.debug(`Late response for request ${id}`);
      return;
    }
    this.pending.delete(id);
    clearTimeout(waiter.timer);

    if (ok) {
      waiter.resolve(payload);
    } else {
      const error = payload || {};
      waiter.reject(
        new AppError(error.code || 'AGENT_ERROR', error.message || 'The desktop app reported an error.', {
          status: error.status || 502,
          details: error.details
        })
      );
    }
  }

  /** Fails every in-flight request. Called when the socket closes. */
  abortAll(reason) {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer);
      waiter.reject(unavailable(`${reason} (while waiting for "${waiter.method}")`));
      this.pending.delete(id);
    }
  }

  close(code = 1000, reason = 'Server closing') {
    try {
      this.socket.close(code, reason);
    } catch {
      /* already closed */
    }
  }
}

/**
 * Accepts and tracks desktop-agent connections.
 *
 * The hub is where "which process can actually reach this user's files" is
 * answered. An MCP tool call arrives holding an OAuth token for some user; the
 * hub finds that user's connected desktop app, or reports honestly that there
 * is none, which is a much better outcome than a tool that appears to work and
 * silently operates on nothing.
 */
export class AgentHub {
  /**
   * @param {object} deps
   * @param {import('../store/users.js').UserStore} deps.users
   * @param {import('../workspace/registry.js').WorkspaceRegistry} deps.registry
   */
  constructor({ users, registry }) {
    this.users = users;
    this.registry = registry;

    /** @type {Map<string, AgentConnection>} */
    this.agents = new Map();
    /** @type {Map<string, Set<string>>} userId -> agent ids */
    this.byUser = new Map();

    this.wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
    this.heartbeat = setInterval(() => this.#sweep(), HEARTBEAT_MS);
    if (typeof this.heartbeat.unref === 'function') this.heartbeat.unref();
  }

  /**
   * Wires the hub into an HTTP server's upgrade event.
   * @param {import('node:http').Server} server
   */
  attach(server) {
    server.on('upgrade', (req, socket, head) => {
      let url;
      try {
        url = new URL(req.url, config.baseUrl);
      } catch {
        socket.destroy();
        return;
      }
      if (url.pathname !== '/bridge') {
        // Some other upgrade (or a typo). Refuse rather than leaving it hanging.
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }

      // The Node `ws` client can set headers, so the desktop app uses
      // Authorization. The query parameter is the fallback for environments
      // where headers are not available on the WebSocket API.
      const header = req.headers.authorization;
      const bearer = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header.trim())?.[1] : null;
      const token = bearer || url.searchParams.get('token');

      const result = token ? this.users.verifyAppToken(token) : null;
      if (!result) {
        log.warn('Rejected an unauthenticated bridge connection');
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.#accept(ws, result.user, {
          platform: url.searchParams.get('platform'),
          appVersion: url.searchParams.get('appVersion'),
          remoteAddress: req.socket.remoteAddress
        });
      });
    });
  }

  #accept(socket, user, info) {
    const agent = new AgentConnection(socket, { user, hub: this, info });
    this.agents.set(agent.id, agent);
    if (!this.byUser.has(user.id)) this.byUser.set(user.id, new Set());
    this.byUser.get(user.id).add(agent.id);

    log.info(`Desktop app connected: ${agent.id} for ${user.email}`);

    socket.on('pong', () => {
      agent.alive = true;
    });

    socket.on('message', (raw) => {
      let frame;
      try {
        frame = JSON.parse(raw.toString('utf8'));
      } catch {
        log.warn(`Agent ${agent.id} sent malformed JSON`);
        return;
      }
      if (!isValidFrame(frame)) {
        log.warn(`Agent ${agent.id} sent an unrecognised frame`, { t: frame?.t });
        return;
      }
      this.#handleFrame(agent, frame).catch((err) => {
        log.error(`Error handling frame from ${agent.id}`, err);
      });
    });

    socket.on('close', (code, reason) => {
      log.info(`Desktop app disconnected: ${agent.id} (${code} ${reason || ''})`);
      agent.abortAll('The CodeWriter desktop app disconnected.');
      this.agents.delete(agent.id);
      this.byUser.get(user.id)?.delete(agent.id);
      if (!this.byUser.get(user.id)?.size) this.byUser.delete(user.id);
      // The workspaces this agent served can no longer be served by anyone.
      const closed = this.registry.closeForAgent(agent.id);
      if (closed.length) log.info(`Closed ${closed.length} workspace(s) belonging to ${agent.id}`);
    });

    socket.on('error', (err) => {
      log.warn(`Socket error on ${agent.id}`, err);
    });

    agent.send({
      t: FRAME.WELCOME,
      agentId: agent.id,
      protocolVersion: PROTOCOL_VERSION,
      user: { id: user.id, email: user.email, name: user.name },
      mcpUrl: config.mcpUrl
    });
  }

  async #handleFrame(agent, frame) {
    switch (frame.t) {
      case FRAME.HELLO:
        agent.info = { ...agent.info, ...frame.info };
        return;

      case FRAME.RESPONSE:
        agent.settle(frame.id, frame.ok, frame.ok ? frame.result : frame.error);
        return;

      case FRAME.EVENT:
        await this.#handleEvent(agent, frame);
        return;

      case FRAME.REQUEST:
        // The agent has no need to call the backend; everything it needs is on
        // the REST API. Reply with an error rather than silently dropping it.
        agent.send({
          t: FRAME.RESPONSE,
          id: frame.id,
          ok: false,
          error: { code: 'NOT_SUPPORTED', message: 'The backend does not expose bridge methods.' }
        });
        return;

      default:
        log.debug(`Ignoring frame type ${frame.t}`);
    }
  }

  async #handleEvent(agent, frame) {
    const { event } = frame;

    switch (event) {
      case AGENT_EVENT.WORKSPACE_OPENED: {
        const workspace = this.registry.register({
          userId: agent.userId,
          agentId: agent.id,
          name: frame.name,
          rootPath: frame.rootPath,
          kind: frame.kind
        });
        // Echo the assigned id back so the agent can label subsequent frames.
        agent.emit('workspace-registered', {
          localId: frame.localId,
          workspaceId: workspace.id,
          rootPath: workspace.rootPath
        });
        return;
      }

      case AGENT_EVENT.MANIFEST_CHUNK: {
        const workspace = this.#workspaceFor(agent, frame.workspaceId);
        if (!workspace) return;
        workspace.ingestManifest(frame.files || [], { reset: Boolean(frame.reset) });
        return;
      }

      case AGENT_EVENT.INDEX_COMPLETE: {
        const workspace = this.#workspaceFor(agent, frame.workspaceId);
        if (!workspace) return;
        workspace.finishIndex({
          skipped: frame.skipped,
          git: frame.git,
          project: frame.project
        });
        agent.emit('index-acknowledged', {
          workspaceId: workspace.id,
          fileCount: workspace.fileCount,
          verification: workspace.verification.toJSON()
        });
        return;
      }

      case AGENT_EVENT.FILE_CHANGED: {
        const workspace = this.#workspaceFor(agent, frame.workspaceId);
        if (!workspace) return;
        for (const change of frame.changes || []) {
          workspace.applyChange({ ...change, actor: change.actor || 'external' });
          if (change.type === 'deleted' || change.type === 'moved') {
            this.registry.contentCache.dropFile(workspace.id, change.fromPath || change.path);
          }
        }
        return;
      }

      case AGENT_EVENT.EDITOR_STATE: {
        const workspace = this.#workspaceFor(agent, frame.workspaceId);
        if (!workspace) return;
        // Mark which files have unsaved editor buffers, so reads can say so.
        const dirty = new Set(frame.dirtyPaths || []);
        for (const [path, entry] of workspace.files) {
          entry.dirty = dirty.has(path);
        }
        return;
      }

      case AGENT_EVENT.WORKSPACE_CLOSED: {
        if (frame.workspaceId) this.registry.close(frame.workspaceId);
        return;
      }

      case AGENT_EVENT.COMMAND_OUTPUT:
      case AGENT_EVENT.COMMAND_EXIT: {
        // Command runs resolve through the normal request/response path; these
        // events exist so the desktop UI can stream output live. The backend
        // forwards them to any registered listener (used by run_command to
        // accumulate output for the MCP response).
        const stream = agent.commandStreams.get(frame.runId);
        if (stream) stream(frame);
        return;
      }

      default:
        log.debug(`Unhandled agent event "${event}"`);
    }
  }

  /** Resolves and ownership-checks a workspace named in an agent frame. */
  #workspaceFor(agent, workspaceId) {
    if (!workspaceId) return null;
    const workspace = this.registry.workspaces.get(workspaceId);
    if (!workspace) {
      log.debug(`Agent referenced unknown workspace ${workspaceId}`);
      return null;
    }
    if (workspace.agentId !== agent.id) {
      log.warn(`Agent ${agent.id} referenced workspace ${workspaceId} owned by ${workspace.agentId}`);
      return null;
    }
    return workspace;
  }

  /**
   * The agent that serves a given workspace.
   * @throws {AppError} UNAVAILABLE when the desktop app is not connected
   */
  agentForWorkspace(workspace) {
    const agent = this.agents.get(workspace.agentId);
    if (!agent) {
      throw unavailable(
        `The CodeWriter desktop app that has "${workspace.name}" open is no longer connected. ` +
          'Reopen the app and the workspace, then retry.'
      );
    }
    return agent;
  }

  /** Every agent connected for a user. */
  agentsForUser(userId) {
    const ids = this.byUser.get(userId);
    if (!ids) return [];
    return [...ids].map((id) => this.agents.get(id)).filter(Boolean);
  }

  /** Pushes an event to every desktop app a user has open. */
  notifyUser(userId, event, payload) {
    for (const agent of this.agentsForUser(userId)) {
      agent.emit(event, payload);
    }
  }

  /** Registers a listener for a command run's streamed output. */
  attachCommandStream(agent, runId, listener) {
    agent.commandStreams.set(runId, listener);
    return () => agent.commandStreams.delete(runId);
  }

  #sweep() {
    for (const agent of this.agents.values()) {
      if (!agent.alive) {
        log.warn(`Agent ${agent.id} missed a heartbeat; terminating`);
        agent.socket.terminate();
        continue;
      }
      agent.alive = false;
      try {
        agent.socket.ping();
      } catch {
        /* the close handler will clean up */
      }
    }
  }

  async close() {
    clearInterval(this.heartbeat);
    for (const agent of this.agents.values()) {
      agent.abortAll('The server is shutting down.');
      agent.close(1001, 'Server shutting down');
    }
    await new Promise((resolve) => this.wss.close(resolve));
  }

  stats() {
    return {
      agents: this.agents.size,
      users: this.byUser.size,
      connections: [...this.agents.values()].map((a) => ({
        id: a.id,
        userId: a.userId,
        connectedAt: a.connectedAt,
        pendingRequests: a.pending.size,
        platform: a.info.platform
      }))
    };
  }
}

export { SERVER_EVENT };
