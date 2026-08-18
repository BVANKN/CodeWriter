import express from 'express';
import config from '../config.js';
import { asyncRoute } from '../util/errors.js';
import { requireAppToken } from '../auth/app-auth.js';

/**
 * Status API for the desktop app's UI.
 *
 * The desktop app does not need REST endpoints to *do* anything — it drives its
 * workspaces over the WebSocket bridge. What it needs is a way to see the
 * backend's view of the world: which workspaces the backend believes are open,
 * which MCP clients are connected, and whether the current changes are
 * verified. That is what these return.
 */
export function createWorkspaceRouter({ users, registry }) {
  const router = express.Router();
  const guard = requireAppToken(users);

  router.get(
    '/',
    guard,
    asyncRoute(async (req, res) => {
      res.json({ workspaces: registry.listForUser(req.user.id).map((w) => w.toJSON()) });
    })
  );

  router.get(
    '/:workspaceId',
    guard,
    asyncRoute(async (req, res) => {
      const workspace = registry.get(req.params.workspaceId, req.user.id);
      res.json({
        workspace: workspace.toJSON(),
        recentChanges: workspace.changesSince(Math.max(0, workspace.changeSeq - 50))
      });
    })
  );

  router.get(
    '/:workspaceId/files',
    guard,
    asyncRoute(async (req, res) => {
      const workspace = registry.get(req.params.workspaceId, req.user.id);
      res.json({
        files: [...workspace.files.values()].map((f) => ({
          path: f.path,
          size: f.size,
          revision: f.revision,
          binary: f.binary,
          dirty: f.dirty
        }))
      });
    })
  );

  return router;
}

/** Server status, for the desktop app's connection panel. */
export function createStatusRouter({ users, registry, hub, sessions, mcpRouter, contentCache }) {
  const router = express.Router();
  const guard = requireAppToken(users);

  // Unauthenticated liveness probe. Deliberately reveals nothing beyond the
  // fact that the server is up and where its MCP endpoint is.
  router.get('/', (_req, res) => {
    res.json({
      ok: true,
      version: '1.0.0',
      mcpUrl: config.mcpUrl,
      uptimeSeconds: Math.floor(process.uptime())
    });
  });

  router.get('/detail', guard, (req, res) => {
    res.json({
      mcpUrl: config.mcpUrl,
      baseUrl: config.baseUrl,
      workspaces: registry.listForUser(req.user.id).map((w) => w.toJSON()),
      mcpSessions: sessions.listForUser(req.user.id).map((s) => s.toJSON()),
      transportSessions: mcpRouter.stats().sessions,
      bridge: { connected: hub.agentsForUser(req.user.id).length },
      cache: contentCache.stats(),
      uptimeSeconds: Math.floor(process.uptime())
    });
  });

  return router;
}
