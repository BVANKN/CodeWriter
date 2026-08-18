import config from '../config.js';
import { openStore } from './json-store.js';
import { prefixedId, secureToken, sha256Hex } from '../util/ids.js';
import { hashPassword, verifyPassword, burnPasswordTime, isValidEmail, assertPasswordShape } from '../auth/passwords.js';
import { AppError, badRequest, conflict, unauthorized } from '../util/errors.js';
import { createLogger } from '../logger.js';

const log = createLogger('users');

const USERS_DEFAULT = { version: 1, users: [] };
const TOKENS_DEFAULT = { version: 1, tokens: [] };

/**
 * The user directory. Accounts are shared between two very different login
 * surfaces:
 *
 *   - The Electron app, which logs in over `/api/auth/*` and receives an
 *     opaque **app token** used for REST calls and the WebSocket bridge.
 *   - The OAuth `/authorize` page, which the MCP client opens in a browser and
 *     which issues an authorization code bound to the same user id.
 *
 * That shared identity is the whole point: the workspaces you opened in the
 * desktop app are exactly the workspaces the MCP token can reach.
 */
export class UserStore {
  constructor(dataDir = config.dataDir) {
    this.users = openStore(dataDir, 'users.json', USERS_DEFAULT);
    this.appTokens = openStore(dataDir, 'app-tokens.json', TOKENS_DEFAULT);
    this.#pruneExpiredTokens();
  }

  /** @returns {number} how many accounts exist; used to show a first-run signup screen. */
  count() {
    return this.users.data.users.length;
  }

  findById(userId) {
    return this.users.data.users.find((u) => u.id === userId) || null;
  }

  findByEmail(email) {
    if (typeof email !== 'string') return null;
    const key = email.trim().toLowerCase();
    return this.users.data.users.find((u) => u.emailLower === key) || null;
  }

  /**
   * Creates an account.
   * @param {{ email: string, password: string, name?: string }} input
   * @returns {Promise<object>} the public user record
   */
  async createUser({ email, password, name }) {
    if (!isValidEmail(email)) {
      throw badRequest('Enter a valid email address.');
    }
    try {
      assertPasswordShape(password);
    } catch (err) {
      throw badRequest(err.message);
    }
    if (this.findByEmail(email)) {
      throw conflict('An account with that email already exists.');
    }

    const now = Date.now();
    const user = {
      id: prefixedId('usr'),
      email: email.trim(),
      emailLower: email.trim().toLowerCase(),
      name: (typeof name === 'string' && name.trim()) || email.trim().split('@')[0],
      passwordHash: await hashPassword(password),
      createdAt: now,
      lastLoginAt: null,
      // clientId -> { scopes, approvedAt }. Lets us skip the consent screen for
      // a client the user has already approved with the same or wider scopes.
      approvedClients: {}
    };

    this.users.data.users.push(user);
    await this.users.save();
    log.info(`Created account ${user.email} (${user.id})`);
    return toPublicUser(user);
  }

  /**
   * Verifies credentials. Always spends comparable CPU whether or not the
   * account exists, so timing does not reveal which emails are registered.
   *
   * @returns {Promise<object>} the internal user record
   * @throws {AppError} UNAUTHORIZED with a deliberately vague message
   */
  async authenticate(email, password) {
    const user = this.findByEmail(email);
    if (!user) {
      await burnPasswordTime();
      throw unauthorized('Incorrect email or password.');
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      throw unauthorized('Incorrect email or password.');
    }
    user.lastLoginAt = Date.now();
    await this.users.save();
    return user;
  }

  async changePassword(userId, currentPassword, newPassword) {
    const user = this.findById(userId);
    if (!user) throw unauthorized('Not signed in.');
    if (!(await verifyPassword(currentPassword, user.passwordHash))) {
      throw unauthorized('Current password is incorrect.');
    }
    try {
      assertPasswordShape(newPassword);
    } catch (err) {
      throw badRequest(err.message);
    }
    user.passwordHash = await hashPassword(newPassword);
    await this.users.save();

    // Changing a password invalidates every device session.
    this.appTokens.data.tokens = this.appTokens.data.tokens.filter((t) => t.userId !== userId);
    await this.appTokens.save();
    log.info(`Password changed for ${user.id}; all app sessions revoked`);
  }

  // -- OAuth client consent ------------------------------------------------

  /** True when this user has already approved `clientId` for at least `scopes`. */
  hasApproved(userId, clientId, scopes) {
    if (config.alwaysPromptConsent) return false;
    const user = this.findById(userId);
    const record = user?.approvedClients?.[clientId];
    if (!record) return false;
    const approved = new Set(record.scopes || []);
    return (scopes || []).every((s) => approved.has(s));
  }

  async recordApproval(userId, clientId, scopes) {
    const user = this.findById(userId);
    if (!user) return;
    if (!user.approvedClients) user.approvedClients = {};
    const existing = new Set(user.approvedClients[clientId]?.scopes || []);
    for (const scope of scopes || []) existing.add(scope);
    user.approvedClients[clientId] = {
      scopes: [...existing],
      approvedAt: Date.now()
    };
    await this.users.save();
  }

  async revokeApproval(userId, clientId) {
    const user = this.findById(userId);
    if (!user?.approvedClients) return;
    delete user.approvedClients[clientId];
    await this.users.save();
  }

  // -- App tokens (Electron client) ---------------------------------------

  /**
   * Issues an opaque bearer token for the desktop app. Only the SHA-256 of the
   * token is persisted, so the data file never contains a usable credential.
   *
   * @returns {Promise<{ token: string, expiresAt: number }>}
   */
  async issueAppToken(userId, deviceName = 'CodeWriter Desktop') {
    const token = secureToken(32);
    const now = Date.now();
    const record = {
      id: prefixedId('apt'),
      tokenHash: sha256Hex(token),
      userId,
      deviceName: String(deviceName).slice(0, 100),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + config.appTokenTtl * 1000
    };
    this.appTokens.data.tokens.push(record);
    await this.appTokens.save();
    return { token, expiresAt: record.expiresAt };
  }

  /**
   * Resolves an app token to a user, sliding `lastSeenAt` forward.
   * @returns {{ user: object, tokenId: string } | null}
   */
  verifyAppToken(token) {
    if (typeof token !== 'string' || !token) return null;
    const hash = sha256Hex(token);
    const record = this.appTokens.data.tokens.find((t) => t.tokenHash === hash);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.appTokens.data.tokens = this.appTokens.data.tokens.filter((t) => t.id !== record.id);
      this.appTokens.save();
      return null;
    }
    const user = this.findById(record.userId);
    if (!user) return null;

    // Only persist the heartbeat once a minute; this runs on every request.
    if (Date.now() - record.lastSeenAt > 60_000) {
      record.lastSeenAt = Date.now();
      this.appTokens.save();
    }
    return { user, tokenId: record.id };
  }

  async revokeAppToken(token) {
    const hash = sha256Hex(token);
    const before = this.appTokens.data.tokens.length;
    this.appTokens.data.tokens = this.appTokens.data.tokens.filter((t) => t.tokenHash !== hash);
    if (this.appTokens.data.tokens.length !== before) await this.appTokens.save();
  }

  #pruneExpiredTokens() {
    const now = Date.now();
    const before = this.appTokens.data.tokens.length;
    this.appTokens.data.tokens = this.appTokens.data.tokens.filter((t) => t.expiresAt > now);
    if (this.appTokens.data.tokens.length !== before) {
      log.debug(`Pruned ${before - this.appTokens.data.tokens.length} expired app tokens`);
      this.appTokens.save();
    }
  }

  async close() {
    await Promise.all([this.users.close(), this.appTokens.close()]);
  }
}

/** Strips the password hash and internal fields before sending a user anywhere. */
export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt,
    lastLoginAt: user.lastLoginAt,
    approvedClients: Object.entries(user.approvedClients || {}).map(([clientId, v]) => ({
      clientId,
      scopes: v.scopes,
      approvedAt: v.approvedAt
    }))
  };
}

export { AppError };
