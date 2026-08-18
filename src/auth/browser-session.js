import config from '../config.js';
import { secureToken } from '../util/ids.js';
import { parseCookies, setCookie, clearCookie } from '../util/cookies.js';

export const SESSION_COOKIE = 'cw_session';

/**
 * Server-side session table for the browser-facing OAuth pages.
 *
 * These sessions exist only so that a user who authorises a second MCP client
 * does not have to type their password again. They are intentionally kept in
 * memory and not persisted: a backend restart signing everyone out of the
 * *login page* costs one extra password entry, whereas persisting them would
 * put another long-lived credential on disk for no real benefit.
 */
export class BrowserSessionStore {
  constructor() {
    /** @type {Map<string, { userId: string, createdAt: number, expiresAt: number }>} */
    this.sessions = new Map();
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  create(res, userId) {
    const id = secureToken(24);
    const now = Date.now();
    this.sessions.set(id, {
      userId,
      createdAt: now,
      expiresAt: now + config.browserSessionTtl * 1000
    });
    setCookie(res, SESSION_COOKIE, id, {
      maxAge: config.browserSessionTtl,
      secure: config.publicUrl.protocol === 'https:'
    });
    return id;
  }

  /** @returns {string | null} the user id, or null when there is no valid session. */
  read(req) {
    const cookies = parseCookies(req);
    const id = cookies[SESSION_COOKIE];
    if (!id) return null;
    const session = this.sessions.get(id);
    if (!session) return null;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return null;
    }
    return session.userId;
  }

  destroy(req, res) {
    const cookies = parseCookies(req);
    const id = cookies[SESSION_COOKIE];
    if (id) this.sessions.delete(id);
    clearCookie(res, SESSION_COOKIE, { secure: config.publicUrl.protocol === 'https:' });
  }

  /** Invalidates every browser session for a user (used after a password change). */
  destroyAllForUser(userId) {
    for (const [id, session] of this.sessions) {
      if (session.userId === userId) this.sessions.delete(id);
    }
  }

  sweep() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(id);
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
  }
}

/**
 * Pending `/authorize` requests.
 *
 * `provider.authorize()` cannot finish synchronously: it has to show a login
 * and consent page first. So it parks the validated request parameters here
 * under a random transaction id and redirects the browser to our own page. The
 * consent POST looks the transaction back up and only then issues a code.
 *
 * Keeping these server-side (rather than round-tripping them through a hidden
 * form field) means the client cannot tamper with the redirect URI, scopes, or
 * PKCE challenge between the two steps.
 */
export class PendingAuthorizations {
  constructor(ttlMs = 10 * 60 * 1000) {
    /** @type {Map<string, object>} */
    this.pending = new Map();
    this.ttlMs = ttlMs;
    this.sweepTimer = setInterval(() => this.sweep(), 60 * 1000);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  create(payload) {
    const id = secureToken(24);
    this.pending.set(id, { ...payload, createdAt: Date.now(), expiresAt: Date.now() + this.ttlMs });
    return id;
  }

  get(id) {
    if (typeof id !== 'string') return null;
    const record = this.pending.get(id);
    if (!record) return null;
    if (record.expiresAt <= Date.now()) {
      this.pending.delete(id);
      return null;
    }
    return record;
  }

  consume(id) {
    const record = this.get(id);
    if (record) this.pending.delete(id);
    return record;
  }

  sweep() {
    const now = Date.now();
    for (const [id, record] of this.pending) {
      if (record.expiresAt <= now) this.pending.delete(id);
    }
  }

  stop() {
    clearInterval(this.sweepTimer);
  }
}
