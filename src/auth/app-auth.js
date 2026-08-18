import { unauthorized } from '../util/errors.js';

/**
 * Authenticates the Electron desktop app.
 *
 * This is deliberately a different credential from the OAuth tokens the MCP
 * client uses. The desktop app is the *owner* of a workspace: it opens folders,
 * reads and writes the disk, runs commands. The MCP client is a *guest* that
 * acts through it under a scoped grant. Giving them separate credentials means
 * revoking an AI client's access never signs you out of your editor, and a
 * leaked MCP token cannot register new workspaces.
 *
 * @param {import('../store/users.js').UserStore} users
 */
export function requireAppToken(users) {
  return (req, res, next) => {
    const token = extractToken(req);
    if (!token) {
      res.set('WWW-Authenticate', 'Bearer realm="CodeWriter"');
      next(unauthorized('Missing app token. Sign in from the CodeWriter desktop app.'));
      return;
    }
    const result = users.verifyAppToken(token);
    if (!result) {
      res.set('WWW-Authenticate', 'Bearer realm="CodeWriter", error="invalid_token"');
      next(unauthorized('Your session has expired. Sign in again.'));
      return;
    }
    req.user = result.user;
    req.appTokenId = result.tokenId;
    req.appToken = token;
    next();
  };
}

/** Populates `req.user` when a token is present, but never rejects. */
export function optionalAppToken(users) {
  return (req, _res, next) => {
    const token = extractToken(req);
    if (token) {
      const result = users.verifyAppToken(token);
      if (result) {
        req.user = result.user;
        req.appTokenId = result.tokenId;
        req.appToken = token;
      }
    }
    next();
  };
}

/**
 * Reads the token from the `Authorization: Bearer` header. The WebSocket
 * bridge additionally accepts it as a query parameter, because the browser
 * WebSocket API cannot set headers; that path is handled in the bridge itself.
 */
export function extractToken(req) {
  const header = req.headers?.authorization;
  if (typeof header === 'string') {
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (match) return match[1].trim();
  }
  return null;
}
