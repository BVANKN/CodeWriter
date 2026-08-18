import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTargetError,
  InvalidTokenError,
  ServerError
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import config from '../config.js';
import { createLogger } from '../logger.js';

const log = createLogger('oauth');

/**
 * Compares two resource identifiers per RFC 8707 / the MCP authorization spec:
 * the fragment is ignored, and a trailing slash is not significant.
 */
function resourceMatches(a, b) {
  if (!a || !b) return false;
  const norm = (value) => {
    try {
      const url = new URL(String(value));
      url.hash = '';
      let href = url.href;
      if (href.endsWith('/')) href = href.slice(0, -1);
      return href.toLowerCase();
    } catch {
      return String(value).toLowerCase();
    }
  };
  return norm(a) === norm(b);
}

/**
 * CodeWriter's OAuth 2.1 authorization server.
 *
 * This server is both the authorization server and the protected resource: the
 * MCP endpoint it guards lives at the same origin. That keeps the deployment to
 * a single process with no external identity provider, which is the right shape
 * for a tool that is fundamentally about *your* machine and *your* files.
 *
 * What the spec requires and this implements:
 *   - Authorization code grant with PKCE S256 (the SDK verifies the challenge;
 *     we store it and hand it back).
 *   - Dynamic client registration (RFC 7591), so a client like Claude can
 *     register itself the first time a user pastes the URL.
 *   - Resource indicators (RFC 8707): tokens are minted for, and validated
 *     against, this server's MCP endpoint. A token issued for a different
 *     resource is rejected rather than silently accepted.
 *   - Refresh token rotation.
 *   - Token revocation (RFC 7009).
 */
export class CodeWriterOAuthProvider {
  /**
   * @param {object} deps
   * @param {import('../store/users.js').UserStore} deps.users
   * @param {import('../store/oauth-store.js').OAuthStore} deps.oauth
   * @param {import('./browser-session.js').BrowserSessionStore} deps.sessions
   * @param {import('./browser-session.js').PendingAuthorizations} deps.pending
   */
  constructor({ users, oauth, sessions, pending }) {
    this.users = users;
    this.oauth = oauth;
    this.sessions = sessions;
    this.pending = pending;

    /**
     * The SDK's registration handler generates the client id and secret, then
     * hands us the full record to persist.
     * @type {import('@modelcontextprotocol/sdk/server/auth/clients.js').OAuthRegisteredClientsStore}
     */
    this.clientsStore = {
      getClient: (clientId) => this.oauth.getClient(clientId) ?? undefined,
      registerClient: async (client) => {
        const saved = await this.oauth.saveClient(client);
        return saved;
      }
    };
  }

  /**
   * Step 1 of the flow. We cannot finish here: the user has to sign in and
   * consent first. So we validate everything we can, park the request, and
   * redirect the browser to our own pages. `/oauth/consent` finishes the job.
   *
   * @param {object} client
   * @param {{ state?: string, scopes?: string[], codeChallenge: string, redirectUri: string, resource?: URL }} params
   * @param {import('express').Response} res
   */
  async authorize(client, params, res) {
    const requestedScopes = params.scopes?.length ? params.scopes : ['workspace:read', 'workspace:write'];

    const unknown = requestedScopes.filter((scope) => !config.scopes.includes(scope));
    if (unknown.length) {
      throw new InvalidScopeError(
        `Unsupported scope(s): ${unknown.join(', ')}. This server supports: ${config.scopes.join(', ')}.`
      );
    }

    // RFC 8707. Clients should name the resource they want a token for. If they
    // name one, it has to be this MCP endpoint; if they omit it, we bind the
    // token to our endpoint anyway so it can never be replayed elsewhere.
    if (params.resource && !resourceMatches(params.resource, config.resourceUrl)) {
      throw new InvalidTargetError(
        `This authorization server only issues tokens for ${config.mcpUrl}, not ${params.resource}.`
      );
    }

    if (!params.codeChallenge) {
      // The SDK's schema already requires this; belt and braces, because a
      // missing challenge would silently downgrade the flow's security.
      throw new ServerError('A PKCE code_challenge is required.');
    }

    const txId = this.pending.create({
      clientId: client.client_id,
      clientName: client.client_name,
      clientUri: client.client_uri,
      scopes: requestedScopes,
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      state: params.state,
      resource: params.resource ? String(params.resource) : String(config.resourceUrl)
    });

    // Express assigns `res.req`; the provider interface does not hand us the
    // request, and we need it to read the browser session cookie.
    const req = res.req;
    const userId = req ? this.sessions.read(req) : null;

    if (userId && this.users.findById(userId) && this.users.hasApproved(userId, client.client_id, requestedScopes)) {
      // Already signed in and already approved this client for these scopes:
      // complete without showing a screen the user has seen before.
      log.info(`Auto-approving ${client.client_id} for ${userId} (previously consented)`);
      const redirectTo = await this.completeAuthorization(txId, userId);
      res.redirect(302, redirectTo);
      return;
    }

    const target = userId ? `/oauth/consent?tx=${encodeURIComponent(txId)}` : `/oauth/login?tx=${encodeURIComponent(txId)}`;
    res.redirect(302, target);
  }

  /**
   * Issues the authorization code for a pending transaction and returns the
   * URL to redirect the browser to. Called from the consent route once the
   * user has signed in and approved.
   *
   * @param {string} txId
   * @param {string} userId
   * @returns {Promise<string>} absolute redirect URL including `code` and `state`
   */
  async completeAuthorization(txId, userId) {
    const tx = this.pending.consume(txId);
    if (!tx) {
      throw new InvalidGrantError('This authorization request expired. Start again from your MCP client.');
    }

    const code = await this.oauth.issueCode({
      clientId: tx.clientId,
      userId,
      scopes: tx.scopes,
      codeChallenge: tx.codeChallenge,
      redirectUri: tx.redirectUri,
      resource: tx.resource
    });

    await this.users.recordApproval(userId, tx.clientId, tx.scopes);

    const url = new URL(tx.redirectUri);
    url.searchParams.set('code', code);
    if (tx.state !== undefined) url.searchParams.set('state', tx.state);
    log.info(`Issued authorization code to ${tx.clientId} for user ${userId} (scopes: ${tx.scopes.join(' ')})`);
    return url.toString();
  }

  /** Builds the redirect URL used when the user denies consent. */
  buildDenialRedirect(tx) {
    const url = new URL(tx.redirectUri);
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'The user denied the authorization request.');
    if (tx.state !== undefined) url.searchParams.set('state', tx.state);
    return url.toString();
  }

  /** The SDK verifies PKCE itself; it just needs the challenge we stored. */
  async challengeForAuthorizationCode(client, authorizationCode) {
    const record = this.oauth.peekCode(authorizationCode);
    if (!record) {
      throw new InvalidGrantError('Authorization code is invalid or has expired.');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client.');
    }
    return record.codeChallenge;
  }

  /**
   * Step 2: code for tokens. The code is consumed atomically before any token
   * is issued, so a replay attempt after a race still finds nothing.
   */
  async exchangeAuthorizationCode(client, authorizationCode, _codeVerifier, redirectUri, resource) {
    const record = await this.oauth.consumeCode(authorizationCode);
    if (!record) {
      throw new InvalidGrantError('Authorization code is invalid, expired, or has already been used.');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Authorization code was issued to a different client.');
    }
    // RFC 6749 §4.1.3: when a redirect_uri was used in the authorization
    // request, the token request must present the identical value.
    if (redirectUri !== undefined && redirectUri !== record.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the value used in the authorization request.');
    }
    if (resource && record.resource && !resourceMatches(resource, record.resource)) {
      throw new InvalidTargetError('resource does not match the value used in the authorization request.');
    }

    const user = this.users.findById(record.userId);
    if (!user) {
      throw new InvalidGrantError('The account this code was issued to no longer exists.');
    }

    const { accessToken, refreshToken, expiresIn } = await this.oauth.issueTokens({
      clientId: client.client_id,
      userId: record.userId,
      scopes: record.scopes,
      resource: record.resource || String(config.resourceUrl)
    });

    log.info(`Issued access token to ${client.client_id} for ${user.email}`);

    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: expiresIn,
      refresh_token: refreshToken ?? undefined,
      scope: record.scopes.join(' ')
    };
  }

  /**
   * Refresh with rotation: the presented refresh token is invalidated and a new
   * one issued alongside the access token.
   */
  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    const record = await this.oauth.rotateRefreshToken(refreshToken);
    if (!record) {
      throw new InvalidGrantError('Refresh token is invalid, expired, or has already been used.');
    }
    if (record.clientId !== client.client_id) {
      throw new InvalidGrantError('Refresh token was issued to a different client.');
    }

    const user = this.users.findById(record.userId);
    if (!user) {
      throw new InvalidGrantError('The account this token was issued to no longer exists.');
    }

    // A refresh may narrow scope but never widen it.
    let grantedScopes = record.scopes;
    if (scopes?.length) {
      const widened = scopes.filter((scope) => !record.scopes.includes(scope));
      if (widened.length) {
        throw new InvalidScopeError(`Cannot widen scope on refresh. Not previously granted: ${widened.join(', ')}.`);
      }
      grantedScopes = scopes;
    }

    const targetResource = resource ? String(resource) : record.resource || String(config.resourceUrl);
    if (record.resource && !resourceMatches(targetResource, record.resource)) {
      throw new InvalidTargetError('resource does not match the resource this refresh token was issued for.');
    }

    const issued = await this.oauth.issueTokens({
      clientId: client.client_id,
      userId: record.userId,
      scopes: grantedScopes,
      resource: targetResource
    });

    return {
      access_token: issued.accessToken,
      token_type: 'Bearer',
      expires_in: issued.expiresIn,
      refresh_token: issued.refreshToken ?? undefined,
      scope: grantedScopes.join(' ')
    };
  }

  /**
   * Validates a bearer token for the MCP endpoint.
   *
   * The audience check is the part people skip and should not: without it, a
   * token this server minted for some other resource, or a token from another
   * deployment, would be honoured here. We require the token's recorded
   * resource to be this server's MCP URL.
   *
   * @returns {Promise<import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo>}
   */
  async verifyAccessToken(token) {
    const record = this.oauth.findAccessToken(token);
    if (!record) {
      throw new InvalidTokenError('Access token is invalid or has expired.');
    }
    if (record.resource && !resourceMatches(record.resource, config.resourceUrl)) {
      throw new InvalidTokenError('Access token was issued for a different resource.');
    }
    const user = this.users.findById(record.userId);
    if (!user) {
      throw new InvalidTokenError('The account this token belongs to no longer exists.');
    }
    const client = this.oauth.getClient(record.clientId);

    return {
      token,
      clientId: record.clientId,
      scopes: record.scopes,
      // AuthInfo.expiresAt is seconds since epoch, not milliseconds.
      expiresAt: Math.floor(record.expiresAt / 1000),
      resource: new URL(String(record.resource || config.resourceUrl)),
      extra: {
        userId: user.id,
        userEmail: user.email,
        userName: user.name,
        clientName: client?.client_name || record.clientId
      }
    };
  }

  /** RFC 7009. Revoking an unknown token is a success, per the spec. */
  async revokeToken(client, request) {
    const token = request.token;
    if (!token) return;

    const access = this.oauth.findAccessToken(token);
    const refresh = this.oauth.findRefreshToken(token);
    const record = access || refresh;
    if (record && record.clientId !== client.client_id) {
      // Do not let one client revoke another's tokens.
      throw new InvalidGrantError('Token was not issued to this client.');
    }
    await this.oauth.revokeToken(token);
    log.info(`Revoked a token for client ${client.client_id}`);
  }
}
