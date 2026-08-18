import express from 'express';
import cors from 'cors';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import config from './config.js';
import { createLogger } from './logger.js';
import { errorMiddleware, notFound } from './util/errors.js';

import { UserStore } from './store/users.js';
import { OAuthStore } from './store/oauth-store.js';
import { BrowserSessionStore, PendingAuthorizations } from './auth/browser-session.js';
import { CodeWriterOAuthProvider } from './auth/provider.js';
import { createOAuthUiRouter } from './auth/oauth-routes.js';
import { createAuthRouter } from './api/auth-routes.js';
import { createWorkspaceRouter, createStatusRouter } from './api/workspace-routes.js';

import { ContentCache } from './workspace/content-cache.js';
import { WorkspaceRegistry } from './workspace/registry.js';
import { AgentHub } from './bridge/hub.js';
import { SessionRegistry } from './mcp/session.js';
import { createMcpRouter } from './mcp/http.js';
import { renderErrorPage } from './auth/pages.js';

const log = createLogger('app');

/**
 * Wires the whole backend together and returns the Express app plus the pieces
 * that need explicit shutdown.
 *
 * Route order matters here in one specific way: `mcpAuthRouter` must be mounted
 * at the application root, because it serves `/.well-known/*` metadata that MCP
 * clients fetch from the origin, not from a sub-path.
 */
export function createApp() {
  const users = new UserStore();
  const oauth = new OAuthStore();
  const browserSessions = new BrowserSessionStore();
  const pendingAuthorizations = new PendingAuthorizations();

  const provider = new CodeWriterOAuthProvider({
    users,
    oauth,
    sessions: browserSessions,
    pending: pendingAuthorizations
  });

  const contentCache = new ContentCache();
  const registry = new WorkspaceRegistry({ contentCache });
  const hub = new AgentHub({ users, registry });
  const mcpSessions = new SessionRegistry();

  /** Shared context handed to every MCP tool. */
  const ctx = {
    registry,
    hub,
    contentCache,
    sessions: mcpSessions,
    users,
    /** Commands currently executing, keyed by runId. */
    activeRuns: new Map()
  };

  const app = express();

  // Behind a tunnel (cloudflared, ngrok) the client IP arrives in a header.
  // Trusting exactly one hop is right for that setup and avoids the spoofing
  // that `trust proxy: true` would allow.
  app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    next();
  });

  // MCP clients are frequently browser-based, and the spec requires the session
  // header to be readable by them.
  app.use(
    cors({
      origin: true,
      credentials: false,
      exposedHeaders: ['Mcp-Session-Id', 'WWW-Authenticate'],
      allowedHeaders: ['Content-Type', 'Authorization', 'Mcp-Session-Id', 'MCP-Protocol-Version', 'Last-Event-ID'],
      methods: ['GET', 'POST', 'DELETE', 'OPTIONS']
    })
  );

  // -- OAuth 2.1: metadata, registration, authorize, token, revoke ---------
  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: config.issuerUrl,
      baseUrl: config.publicUrl,
      resourceServerUrl: new URL(config.mcpUrl),
      resourceName: 'CodeWriter workspace',
      scopesSupported: config.scopes,
      serviceDocumentationUrl: new URL(`${config.baseUrl}/docs`)
    })
  );

  // -- Interactive login / consent pages ----------------------------------
  const oauthUi = createOAuthUiRouter({
    provider,
    users,
    sessions: browserSessions,
    pending: pendingAuthorizations
  });
  app.use('/oauth', oauthUi);

  // -- The MCP endpoint ----------------------------------------------------
  const mcpRouter = createMcpRouter(ctx, provider);
  app.use('/mcp', mcpRouter);

  // -- Desktop app API -----------------------------------------------------
  const authRouter = createAuthRouter({ users, oauth, sessions: browserSessions });
  app.use('/api/auth', authRouter);
  app.use('/api/workspaces', createWorkspaceRouter({ users, registry }));
  app.use(
    '/api/status',
    createStatusRouter({ users, registry, hub, sessions: mcpSessions, mcpRouter, contentCache })
  );

  // -- A landing page, so pasting the base URL into a browser explains itself
  app.get('/', (_req, res) => {
    res
      .status(200)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send(
        renderErrorPage(
          'CodeWriter is running',
          `MCP endpoint: ${config.mcpUrl}`,
          'Paste that URL into your MCP client. It will bring you back here to sign in and approve access. ' +
            'Open the CodeWriter desktop app and open a folder before connecting, or there will be nothing for the client to read.'
        ).replace('class="error"', 'class="client"')
      );
  });

  app.get('/docs', (_req, res) => {
    res.redirect(302, 'https://modelcontextprotocol.io/docs/concepts/architecture');
  });

  app.use((req, _res, next) => {
    next(notFound(`No route for ${req.method} ${req.path}`));
  });

  app.use(errorMiddleware(log));

  return {
    app,
    ctx,
    hub,
    users,
    oauth,
    registry,
    mcpRouter,
    mcpSessions,
    browserSessions,
    pendingAuthorizations,
    contentCache,
    async close() {
      await mcpRouter.close();
      await hub.close();
      mcpSessions.stop();
      browserSessions.stop();
      pendingAuthorizations.stop();
      oauthUi.stopLimiter?.();
      authRouter.stopLimiter?.();
      await Promise.all([users.close(), oauth.close()]);
    }
  };
}
