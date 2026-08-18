import express from 'express';
import { renderLoginPage, renderConsentPage, renderErrorPage } from './pages.js';
import { RateLimiter, clientKey } from '../util/rate-limit.js';
import { asyncRoute } from '../util/errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('oauth-ui');

/**
 * The interactive half of the OAuth flow: sign in, create an account, and
 * approve a client. `provider.authorize()` parks a transaction and redirects
 * here; these routes finish it.
 *
 * @param {object} deps
 * @param {import('./provider.js').CodeWriterOAuthProvider} deps.provider
 * @param {import('../store/users.js').UserStore} deps.users
 * @param {import('./browser-session.js').BrowserSessionStore} deps.sessions
 * @param {import('./browser-session.js').PendingAuthorizations} deps.pending
 */
export function createOAuthUiRouter({ provider, users, sessions, pending }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false, limit: '32kb' }));

  const loginLimiter = new RateLimiter({ windowMs: 15 * 60 * 1000, max: 20 });
  router.stopLimiter = () => loginLimiter.stop();

  const html = (res, status, body) => {
    res
      .status(status)
      .set('Content-Type', 'text/html; charset=utf-8')
      // These pages carry a session cookie and a consent decision. Nothing
      // about them should be cached, framed, or sniffed.
      .set('Cache-Control', 'no-store')
      .set('X-Frame-Options', 'DENY')
      .set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'")
      .set('X-Content-Type-Options', 'nosniff')
      .send(body);
  };

  /** Loads the pending transaction or renders a terminal error page. */
  const requireTx = (req, res) => {
    const txId = req.method === 'GET' ? req.query.tx : req.body?.tx;
    const tx = pending.get(txId);
    if (!tx) {
      html(
        res,
        400,
        renderErrorPage(
          'Request expired',
          'This authorization request is no longer valid.',
          'Authorization requests expire after 10 minutes. Return to your MCP client and connect again.'
        )
      );
      return null;
    }
    return { txId: String(txId), tx };
  };

  // -- Sign in -------------------------------------------------------------

  router.get('/login', (req, res) => {
    const found = requireTx(req, res);
    if (!found) return;
    html(
      res,
      200,
      renderLoginPage({
        txId: found.txId,
        clientName: found.tx.clientName,
        allowSignup: true
      })
    );
  });

  router.post(
    '/login',
    asyncRoute(async (req, res) => {
      const found = requireTx(req, res);
      if (!found) return;

      const limit = loginLimiter.check(`login:${clientKey(req)}`);
      if (!limit.allowed) {
        html(
          res,
          429,
          renderLoginPage({
            txId: found.txId,
            clientName: found.tx.clientName,
            allowSignup: true,
            email: req.body.email,
            error: `Too many attempts. Try again in ${limit.retryAfterSeconds} seconds.`
          })
        );
        return;
      }

      try {
        const user = await users.authenticate(req.body.email, req.body.password);
        loginLimiter.reset(`login:${clientKey(req)}`);
        sessions.create(res, user.id);
        res.redirect(302, `/oauth/consent?tx=${encodeURIComponent(found.txId)}`);
      } catch (err) {
        log.warn(`Failed sign-in attempt from ${clientKey(req)}`);
        html(
          res,
          401,
          renderLoginPage({
            txId: found.txId,
            clientName: found.tx.clientName,
            allowSignup: true,
            email: req.body.email,
            error: err.expose ? err.message : 'Sign-in failed.'
          })
        );
      }
    })
  );

  // -- Create account ------------------------------------------------------

  router.get('/signup', (req, res) => {
    const found = requireTx(req, res);
    if (!found) return;
    html(
      res,
      200,
      renderLoginPage({
        txId: found.txId,
        clientName: found.tx.clientName,
        allowSignup: true,
        signupMode: true
      })
    );
  });

  router.post(
    '/signup',
    asyncRoute(async (req, res) => {
      const found = requireTx(req, res);
      if (!found) return;

      const limit = loginLimiter.check(`signup:${clientKey(req)}`);
      if (!limit.allowed) {
        html(res, 429, renderErrorPage('Slow down', 'Too many attempts. Try again shortly.'));
        return;
      }

      const fail = (message) =>
        html(
          res,
          400,
          renderLoginPage({
            txId: found.txId,
            clientName: found.tx.clientName,
            allowSignup: true,
            signupMode: true,
            email: req.body.email,
            error: message
          })
        );

      if (req.body.password !== req.body.confirm) {
        fail('The two passwords do not match.');
        return;
      }

      try {
        const created = await users.createUser({
          email: req.body.email,
          password: req.body.password,
          name: req.body.name
        });
        sessions.create(res, created.id);
        res.redirect(302, `/oauth/consent?tx=${encodeURIComponent(found.txId)}`);
      } catch (err) {
        fail(err.expose ? err.message : 'Could not create the account.');
      }
    })
  );

  // -- Consent -------------------------------------------------------------

  router.get('/consent', (req, res) => {
    const found = requireTx(req, res);
    if (!found) return;

    const userId = sessions.read(req);
    if (!userId) {
      res.redirect(302, `/oauth/login?tx=${encodeURIComponent(found.txId)}`);
      return;
    }
    const user = users.findById(userId);
    if (!user) {
      sessions.destroy(req, res);
      res.redirect(302, `/oauth/login?tx=${encodeURIComponent(found.txId)}`);
      return;
    }

    html(
      res,
      200,
      renderConsentPage({
        txId: found.txId,
        clientName: found.tx.clientName,
        clientUri: found.tx.clientUri,
        redirectUri: found.tx.redirectUri,
        scopes: found.tx.scopes,
        userEmail: user.email
      })
    );
  });

  router.post(
    '/consent',
    asyncRoute(async (req, res) => {
      const found = requireTx(req, res);
      if (!found) return;

      const userId = sessions.read(req);
      if (!userId || !users.findById(userId)) {
        res.redirect(302, `/oauth/login?tx=${encodeURIComponent(found.txId)}`);
        return;
      }

      if (req.body.decision !== 'allow') {
        pending.consume(found.txId);
        log.info(`User ${userId} denied ${found.tx.clientId}`);
        res.redirect(302, provider.buildDenialRedirect(found.tx));
        return;
      }

      try {
        const redirectTo = await provider.completeAuthorization(found.txId, userId);
        res.redirect(302, redirectTo);
      } catch (err) {
        html(
          res,
          400,
          renderErrorPage('Could not complete authorization', err.message || 'Unknown error.')
        );
      }
    })
  );

  // -- Session management --------------------------------------------------

  router.post('/logout', (req, res) => {
    sessions.destroy(req, res);
    res.redirect(302, '/');
  });

  return router;
}
