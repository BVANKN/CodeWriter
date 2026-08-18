import express from 'express';
import config from '../config.js';
import { asyncRoute, badRequest } from '../util/errors.js';
import { toPublicUser } from '../store/users.js';
import { requireAppToken } from '../auth/app-auth.js';
import { RateLimiter, clientKey } from '../util/rate-limit.js';
import { createLogger } from '../logger.js';

const log = createLogger('api-auth');

/**
 * Authentication API for the Electron app.
 *
 * @param {object} deps
 * @param {import('../store/users.js').UserStore} deps.users
 * @param {import('../store/oauth-store.js').OAuthStore} deps.oauth
 * @param {import('../auth/browser-session.js').BrowserSessionStore} deps.sessions
 */
export function createAuthRouter({ users, oauth, sessions }) {
  const router = express.Router();
  router.use(express.json({ limit: '64kb' }));

  const limiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 30 });
  router.stopLimiter = () => limiter.stop();

  const guard = requireAppToken(users);

  /**
   * Bootstrap information for the login screen. Tells the app whether this is a
   * first run (no accounts yet) so it can lead with "create account".
   */
  router.get('/bootstrap', (_req, res) => {
    res.json({
      hasAccounts: users.count() > 0,
      mcpUrl: config.mcpUrl,
      baseUrl: config.baseUrl,
      scopes: config.scopes,
      serverVersion: '1.0.0'
    });
  });

  router.post(
    '/signup',
    asyncRoute(async (req, res) => {
      const check = limiter.check(`signup:${clientKey(req)}`);
      if (!check.allowed) throw badRequest(`Too many attempts. Try again in ${check.retryAfterSeconds}s.`);

      const { email, password, name, deviceName } = req.body || {};
      const user = await users.createUser({ email, password, name });
      const token = await users.issueAppToken(user.id, deviceName);
      res.status(201).json({ user, ...token });
    })
  );

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const check = limiter.check(`login:${clientKey(req)}`);
      if (!check.allowed) throw badRequest(`Too many attempts. Try again in ${check.retryAfterSeconds}s.`);

      const { email, password, deviceName } = req.body || {};
      const user = await users.authenticate(email, password);
      limiter.reset(`login:${clientKey(req)}`);
      const token = await users.issueAppToken(user.id, deviceName);
      log.info(`Desktop sign-in for ${user.email}`);
      res.json({ user: toPublicUser(user), ...token });
    })
  );

  router.post(
    '/logout',
    guard,
    asyncRoute(async (req, res) => {
      await users.revokeAppToken(req.appToken);
      res.json({ ok: true });
    })
  );

  router.get('/me', guard, (req, res) => {
    res.json({
      user: toPublicUser(req.user),
      mcpUrl: config.mcpUrl,
      grants: oauth.listGrantsForUser(req.user.id)
    });
  });

  router.post(
    '/change-password',
    guard,
    asyncRoute(async (req, res) => {
      const { currentPassword, newPassword } = req.body || {};
      await users.changePassword(req.user.id, currentPassword, newPassword);
      sessions.destroyAllForUser(req.user.id);
      await oauth.revokeAllForUser(req.user.id);
      res.json({ ok: true, message: 'Password changed. All sessions and MCP grants were revoked.' });
    })
  );

  // -- Connected MCP clients ------------------------------------------------

  router.get('/grants', guard, (req, res) => {
    res.json({ grants: oauth.listGrantsForUser(req.user.id) });
  });

  router.delete(
    '/grants/:clientId',
    guard,
    asyncRoute(async (req, res) => {
      await oauth.revokeAllForUser(req.user.id, req.params.clientId);
      await users.revokeApproval(req.user.id, req.params.clientId);
      log.info(`Revoked grant for client ${req.params.clientId} (user ${req.user.id})`);
      res.json({ ok: true });
    })
  );

  return router;
}
