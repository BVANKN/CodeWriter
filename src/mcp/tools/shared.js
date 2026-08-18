import config from '../../config.js';
import { sha256Hex } from '../../util/ids.js';
import { AppError, badRequest } from '../../util/errors.js';
import { AGENT_METHOD, SERVER_EVENT } from '../../bridge/protocol.js';
import { createLogger } from '../../logger.js';

const log = createLogger('mcp-shared');

/**
 * Everything a tool handler needs, derived from the authenticated request.
 *
 * @param {object} ctx   Server-wide dependencies.
 * @param {object} extra The SDK's `RequestHandlerExtra`.
 */
export function callContext(ctx, extra) {
  const authInfo = extra?.authInfo;
  if (!authInfo?.extra?.userId) {
    // Should be impossible: the bearer middleware runs before the transport.
    throw new AppError('UNAUTHENTICATED', 'This request carried no valid access token.', { status: 401 });
  }

  const userId = authInfo.extra.userId;
  const clientName = authInfo.extra.clientName || authInfo.clientId;

  // Prefer the transport's session id. A stateless client gets a stable key
  // derived from its token, so read tracking still works across its calls
  // without letting two different clients share a session.
  const sessionKey = extra.sessionId || `token:${sha256Hex(authInfo.token).slice(0, 32)}`;

  const session = ctx.sessions.get(sessionKey, {
    userId,
    clientId: authInfo.clientId,
    clientName
  });

  return { authInfo, userId, clientName, session };
}

/**
 * Resolves the workspace a call targets and the agent that serves it, and
 * reports the call to the desktop UI so the user can see what the model is
 * doing in real time.
 *
 * @param {object} [options]
 * @param {boolean} [options.requireLiveAgent] Verify the desktop app really
 *   answers before proceeding. Use for anything that mutates or runs commands:
 *   those are the operations that would otherwise hang on a half-open socket.
 */
export async function resolveTarget(ctx, extra, workspaceId, { toolName, summary, requireLiveAgent } = {}) {
  const call = callContext(ctx, extra);
  const workspace = ctx.registry.resolve(call.userId, workspaceId);
  const agent = ctx.hub.agentForWorkspace(workspace);

  if (requireLiveAgent) {
    const rttMs = await agent.ensureAlive();
    log.debug(`Agent liveness confirmed in ${rttMs}ms before ${toolName}`);
  }

  if (toolName) {
    call.session.countCall(toolName);
    agent.emit(SERVER_EVENT.MCP_ACTIVITY, {
      workspaceId: workspace.id,
      tool: toolName,
      clientName: call.clientName,
      summary: summary || null,
      at: Date.now()
    });
  }

  return { ...call, workspace, agent };
}

/**
 * Fetches file contents, using the revision-keyed cache and falling back to the
 * desktop agent.
 *
 * The agent is asked for the *live* content — the editor buffer when the file
 * is open and unsaved, otherwise the disk. It returns the revision it actually
 * read, which may differ from the index if the file changed a moment ago; the
 * caller is given that revision, never the stale indexed one.
 *
 * @returns {Promise<Array<{ path: string, content?: string, revision?: string, error?: string, message?: string, binary?: boolean, dirty?: boolean }>>}
 */
export async function fetchFiles(ctx, { workspace, agent, paths }) {
  const results = [];
  const misses = [];

  for (const path of paths) {
    const entry = workspace.getFile(path);
    if (entry && !entry.dirty) {
      const cached = ctx.contentCache.get(workspace.id, path, entry.revision);
      if (cached !== null) {
        results.push({ path, content: cached, revision: entry.revision, dirty: false, cached: true });
        continue;
      }
    }
    misses.push(path);
  }

  if (misses.length) {
    const response = await agent.request(
      AGENT_METHOD.READ_FILES,
      { workspaceId: workspace.id, paths: misses, maxBytes: config.maxFileBytes },
      { timeoutMs: config.bridgeRpcTimeoutMs }
    );

    for (const file of response.files || []) {
      if (file.error) {
        results.push({ path: file.path, error: file.error, message: file.message });
        continue;
      }
      // Cache only clean files: an unsaved buffer's "revision" describes
      // content that is not on disk and may change with the next keystroke.
      if (!file.dirty && typeof file.content === 'string' && file.revision) {
        ctx.contentCache.set(workspace.id, file.path, file.revision, file.content);
      }
      // Keep the index honest if the agent saw something newer than we had.
      const indexed = workspace.getFile(file.path);
      if (indexed && file.revision && indexed.revision !== file.revision) {
        log.debug(`Index was stale for ${file.path}: ${indexed.revision} -> ${file.revision}`);
        indexed.revision = file.revision;
        indexed.size = file.size ?? indexed.size;
        indexed.dirty = Boolean(file.dirty);
      }
      results.push(file);
    }
  }

  // Preserve the caller's ordering; models correlate results positionally.
  const byPath = new Map(results.map((r) => [r.path, r]));
  return paths.map(
    (path) => byPath.get(path) || { path, error: 'FILE_NOT_FOUND', message: `"${path}" was not returned by the desktop app.` }
  );
}

/** Parses and bounds a positive integer argument. */
export function boundedInt(value, { name, min, max, fallback }) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw badRequest(`"${name}" must be an integer.`);
  }
  if (parsed < min || parsed > max) {
    throw badRequest(`"${name}" must be between ${min} and ${max}, got ${parsed}.`);
  }
  return parsed;
}

/** Shared description fragment so every tool names the workspace argument the same way. */
export const WORKSPACE_ID_DESCRIPTION =
  'Which open workspace to act on. Optional when exactly one is open; required when several are. ' +
  'Get ids from list_workspaces.';
