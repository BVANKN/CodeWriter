import config from '../config.js';
import { openStore } from './json-store.js';
import { prefixedId, secureToken, sha256Hex } from '../util/ids.js';
import { createLogger } from '../logger.js';

const log = createLogger('oauth-store');

const DEFAULT = {
  version: 1,
  clients: [],
  codes: [],
  accessTokens: [],
  refreshTokens: []
};

/**
 * Persistence for the OAuth 2.1 authorization server.
 *
 * Two rules shape this file:
 *
 *   - **Nothing bearer-shaped is stored in the clear.** Authorization codes,
 *     access tokens and refresh tokens are stored as SHA-256 hashes. Reading
 *     `oauth.json` off disk gives an attacker no usable credential.
 *   - **Everything expires.** Expired records are swept on boot and on every
 *     lookup, so the file cannot grow without bound.
 */
export class OAuthStore {
  constructor(dataDir = config.dataDir) {
    this.store = openStore(dataDir, 'oauth.json', DEFAULT);
    this.sweep();
  }

  get data() {
    return this.store.data;
  }

  // -- Clients (RFC 7591 dynamic registration) -----------------------------

  getClient(clientId) {
    return this.data.clients.find((c) => c.client_id === clientId) || null;
  }

  /**
   * @param {object} client Full client information, already assigned an id by the SDK.
   */
  async saveClient(client) {
    const existing = this.data.clients.findIndex((c) => c.client_id === client.client_id);
    const record = { ...client, registeredAt: Date.now() };
    if (existing === -1) {
      this.data.clients.push(record);
    } else {
      this.data.clients[existing] = { ...this.data.clients[existing], ...record };
    }
    await this.store.save();
    log.info(`Registered OAuth client ${client.client_id} (${client.client_name || 'unnamed'})`);
    return record;
  }

  listClients() {
    return this.data.clients.map((c) => ({
      client_id: c.client_id,
      client_name: c.client_name,
      redirect_uris: c.redirect_uris,
      registeredAt: c.registeredAt,
      scope: c.scope
    }));
  }

  // -- Authorization codes -------------------------------------------------

  /**
   * @param {object} input
   * @param {string} input.clientId
   * @param {string} input.userId
   * @param {string[]} input.scopes
   * @param {string} input.codeChallenge  PKCE S256 challenge.
   * @param {string} input.redirectUri
   * @param {string} [input.resource]     RFC 8707 resource indicator.
   * @returns {Promise<string>} the authorization code (returned once, never stored in the clear)
   */
  async issueCode({ clientId, userId, scopes, codeChallenge, redirectUri, resource }) {
    const code = secureToken(32);
    this.data.codes.push({
      codeHash: sha256Hex(code),
      clientId,
      userId,
      scopes: [...scopes],
      codeChallenge,
      redirectUri,
      resource: resource || null,
      issuedAt: Date.now(),
      expiresAt: Date.now() + config.authCodeTtl * 1000
    });
    await this.store.save();
    return code;
  }

  /** Looks up a code without consuming it. Returns null when missing or expired. */
  peekCode(code) {
    const hash = sha256Hex(code);
    const record = this.data.codes.find((c) => c.codeHash === hash);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  /**
   * Consumes a code. Authorization codes are strictly single-use: the record is
   * removed before any token is minted, so a replayed code cannot produce a
   * second token even if two requests race.
   */
  async consumeCode(code) {
    const hash = sha256Hex(code);
    const index = this.data.codes.findIndex((c) => c.codeHash === hash);
    if (index === -1) return null;
    const [record] = this.data.codes.splice(index, 1);
    await this.store.save();
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  // -- Tokens --------------------------------------------------------------

  /**
   * Mints an access token and (optionally) a refresh token for a user/client pair.
   * @returns {Promise<{ accessToken: string, refreshToken: string | null, expiresIn: number }>}
   */
  async issueTokens({ clientId, userId, scopes, resource, withRefresh = true }) {
    const now = Date.now();
    const accessToken = secureToken(32);
    const accessRecord = {
      id: prefixedId('at'),
      tokenHash: sha256Hex(accessToken),
      clientId,
      userId,
      scopes: [...scopes],
      resource: resource ? String(resource) : null,
      issuedAt: now,
      expiresAt: now + config.accessTokenTtl * 1000
    };
    this.data.accessTokens.push(accessRecord);

    let refreshToken = null;
    if (withRefresh) {
      refreshToken = secureToken(32);
      this.data.refreshTokens.push({
        id: prefixedId('rt'),
        tokenHash: sha256Hex(refreshToken),
        clientId,
        userId,
        scopes: [...scopes],
        resource: resource ? String(resource) : null,
        issuedAt: now,
        expiresAt: now + config.refreshTokenTtl * 1000
      });
    }

    await this.store.save();
    return { accessToken, refreshToken, expiresIn: config.accessTokenTtl };
  }

  /** @returns {object | null} the access token record, or null when unknown/expired. */
  findAccessToken(token) {
    const hash = sha256Hex(token);
    const record = this.data.accessTokens.find((t) => t.tokenHash === hash);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  findRefreshToken(token) {
    const hash = sha256Hex(token);
    const record = this.data.refreshTokens.find((t) => t.tokenHash === hash);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  /**
   * Rotates a refresh token: the presented token is invalidated and a new pair
   * is issued. Rotation means a stolen refresh token is usable at most once,
   * and the legitimate client's next refresh fails loudly instead of silently
   * sharing a session with an attacker.
   */
  async rotateRefreshToken(oldToken) {
    const hash = sha256Hex(oldToken);
    const index = this.data.refreshTokens.findIndex((t) => t.tokenHash === hash);
    if (index === -1) return null;
    const [record] = this.data.refreshTokens.splice(index, 1);
    await this.store.save();
    if (record.expiresAt <= Date.now()) return null;
    return record;
  }

  async revokeToken(token) {
    const hash = sha256Hex(token);
    const beforeAccess = this.data.accessTokens.length;
    const beforeRefresh = this.data.refreshTokens.length;
    this.data.accessTokens = this.data.accessTokens.filter((t) => t.tokenHash !== hash);
    this.data.refreshTokens = this.data.refreshTokens.filter((t) => t.tokenHash !== hash);
    const changed =
      this.data.accessTokens.length !== beforeAccess || this.data.refreshTokens.length !== beforeRefresh;
    if (changed) await this.store.save();
    return changed;
  }

  /** Revokes every token for a user, optionally limited to one client. */
  async revokeAllForUser(userId, clientId = null) {
    const keep = (t) => t.userId !== userId || (clientId && t.clientId !== clientId);
    this.data.accessTokens = this.data.accessTokens.filter(keep);
    this.data.refreshTokens = this.data.refreshTokens.filter(keep);
    this.data.codes = this.data.codes.filter(keep);
    await this.store.save();
  }

  /** Active grants for a user, for the "connected apps" list in the UI. */
  listGrantsForUser(userId) {
    const byClient = new Map();
    for (const token of this.data.accessTokens) {
      if (token.userId !== userId || token.expiresAt <= Date.now()) continue;
      const client = this.getClient(token.clientId);
      const entry = byClient.get(token.clientId) || {
        clientId: token.clientId,
        clientName: client?.client_name || token.clientId,
        scopes: new Set(),
        lastIssuedAt: 0,
        accessTokenCount: 0
      };
      for (const scope of token.scopes) entry.scopes.add(scope);
      entry.lastIssuedAt = Math.max(entry.lastIssuedAt, token.issuedAt);
      entry.accessTokenCount += 1;
      byClient.set(token.clientId, entry);
    }
    return [...byClient.values()].map((e) => ({ ...e, scopes: [...e.scopes] }));
  }

  /** Drops everything that has expired. Cheap; safe to call often. */
  sweep() {
    const now = Date.now();
    const before =
      this.data.codes.length + this.data.accessTokens.length + this.data.refreshTokens.length;
    this.data.codes = this.data.codes.filter((c) => c.expiresAt > now);
    this.data.accessTokens = this.data.accessTokens.filter((t) => t.expiresAt > now);
    this.data.refreshTokens = this.data.refreshTokens.filter((t) => t.expiresAt > now);
    const after =
      this.data.codes.length + this.data.accessTokens.length + this.data.refreshTokens.length;
    if (after !== before) {
      log.debug(`Swept ${before - after} expired OAuth records`);
      this.store.save();
    }
  }

  async close() {
    await this.store.close();
  }
}
