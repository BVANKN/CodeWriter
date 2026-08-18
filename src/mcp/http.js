import express from 'express';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import config from '../config.js';
import { createMcpServer } from './server.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-http');

/** Sessions idle for this long are torn down. */
const SESSION_IDLE_MS = 60 * 60 * 1000;

/**
 * The MCP endpoint.
 *
 * This is the URL the user pastes into their MCP client. It speaks Streamable
 * HTTP: POST carries JSON-RPC in both directions (or upgrades to SSE when the
 * server needs to stream), GET opens a server-to-client notification stream,
 * and DELETE ends a session.
 *
 * Session handling is stateful, one `McpServer` per session, because the read
 * tracking that guards writes is inherently per-connection: "has *this* client
 * read *this* revision" is not a question a stateless server can answer.
 *
 * @param {object} ctx  Shared server context (registry, hub, caches, sessions).
 * @param {import('../auth/provider.js').CodeWriterOAuthProvider} provider
 */
export function createMcpRouter(ctx, provider) {
  const router = express.Router();

  /**
   * Live transports keyed by MCP session id.
   * @type {Map<string, { transport: StreamableHTTPServerTransport, server: object, userId: string, lastSeen: number }>}
   */
  const sessions = new Map();

  const sweeper = setInterval(() => {
    const cutoff = Date.now() - SESSION_IDLE_MS;
    for (const [id, session] of sessions) {
      if (session.lastSeen < cutoff) {
        log.info(`Closing idle MCP session ${id}`);
        void closeSession(id);
      }
    }
  }, 10 * 60 * 1000);
  if (typeof sweeper.unref === 'function') sweeper.unref();

  async function closeSession(sessionId) {
    const session = sessions.get(sessionId);
    if (!session) return;
    sessions.delete(sessionId);
    ctx.sessions.drop(sessionId);
    try {
      await session.transport.close();
    } catch (err) {
      log.debug(`Error closing transport for ${sessionId}`, err);
    }
    try {
      await session.server.close();
    } catch (err) {
      log.debug(`Error closing server for ${sessionId}`, err);
    }
  }

  // Every request to /mcp must carry a valid bearer token. On failure this
  // emits the WWW-Authenticate header pointing at our protected-resource
  // metadata, which is how a compliant client discovers where to authenticate.
  const auth = requireBearerAuth({
    verifier: provider,
    requiredScopes: [],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(new URL(config.mcpUrl))
  });

  // The SDK's transport reads the raw body itself when we do not pre-parse, but
  // pre-parsing lets us reject oversized payloads cleanly and reuse the parsed
  // body for the initialize check below.
  const json = express.json({ limit: '64mb' });

  router.post('/', auth, json, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const userId = req.auth?.extra?.userId;

    try {
      if (typeof sessionId === 'string' && sessions.has(sessionId)) {
        const session = sessions.get(sessionId);

        // A session belongs to the user who created it. Without this check, a
        // second user's token could drive an existing session and act on the
        // first user's workspaces.
        if (session.userId !== userId) {
          log.warn(`Session ${sessionId} was addressed by a different user`);
          res.status(403).json(rpcError(-32600, 'This session belongs to a different account.'));
          return;
        }

        session.lastSeen = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }

      if (typeof sessionId === 'string') {
        // The client believes it has a session we do not know about, usually
        // because we restarted. Tell it plainly so it re-initializes rather
        // than retrying forever.
        res.status(404).json(rpcError(-32001, 'Unknown session. Re-initialize to obtain a new session id.'));
        return;
      }

      if (!isInitializeRequest(req.body)) {
        res
          .status(400)
          .json(rpcError(-32000, 'The first request of a session must be "initialize", and must not carry a session id.'));
        return;
      }

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        // DNS-rebinding protection: a page on some other origin must not be
        // able to drive a locally bound MCP server through the user's browser.
        enableDnsRebindingProtection: true,
        allowedHosts: config.mcpAllowedHosts,
        onsessioninitialized: (id) => {
          sessions.set(id, { transport, server, userId, lastSeen: Date.now() });
          log.info(`MCP session ${id} initialized for ${req.auth?.extra?.userEmail} via ${req.auth?.extra?.clientName}`);
        },
        onsessionclosed: (id) => {
          log.info(`MCP session ${id} closed by the client`);
          void closeSession(id);
        }
      });

      const server = createMcpServer(ctx);

      transport.onclose = () => {
        if (transport.sessionId) void closeSession(transport.sessionId);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('Error handling an MCP POST', err);
      if (!res.headersSent) {
        res.status(500).json(rpcError(-32603, 'Internal server error.'));
      }
    }
  });

  // Server-to-client notification stream.
  router.get('/', auth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(404).json(rpcError(-32001, 'Unknown or missing session id.'));
      return;
    }
    if (session.userId !== req.auth?.extra?.userId) {
      res.status(403).json(rpcError(-32600, 'This session belongs to a different account.'));
      return;
    }

    session.lastSeen = Date.now();
    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      log.error('Error handling an MCP GET', err);
      if (!res.headersSent) res.status(500).end();
    }
  });

  // Explicit session termination.
  router.delete('/', auth, async (req, res) => {
    const sessionId = req.headers['mcp-session-id'];
    const session = typeof sessionId === 'string' ? sessions.get(sessionId) : null;

    if (!session) {
      res.status(404).json(rpcError(-32001, 'Unknown or missing session id.'));
      return;
    }
    if (session.userId !== req.auth?.extra?.userId) {
      res.status(403).json(rpcError(-32600, 'This session belongs to a different account.'));
      return;
    }

    try {
      await session.transport.handleRequest(req, res);
    } catch (err) {
      log.error('Error handling an MCP DELETE', err);
      if (!res.headersSent) res.status(500).end();
    } finally {
      await closeSession(sessionId);
    }
  });

  router.close = async () => {
    clearInterval(sweeper);
    await Promise.all([...sessions.keys()].map((id) => closeSession(id)));
  };

  router.stats = () => ({
    sessions: sessions.size,
    detail: [...sessions.entries()].map(([id, s]) => ({
      id,
      userId: s.userId,
      lastSeen: s.lastSeen
    }))
  });

  return router;
}

function rpcError(code, message) {
  return { jsonrpc: '2.0', error: { code, message }, id: null };
}
