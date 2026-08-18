/**
 * A small fixed-window rate limiter kept in memory.
 *
 * The SDK already rate-limits its own OAuth endpoints. This one guards the
 * pieces we add: the interactive login form and the desktop app's auth API,
 * where the thing being protected is a password.
 */
export class RateLimiter {
  /**
   * @param {object} options
   * @param {number} options.windowMs
   * @param {number} options.max      Attempts permitted per key per window.
   */
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    /** @type {Map<string, { count: number, resetAt: number }>} */
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), windowMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /**
   * @param {string} key
   * @returns {{ allowed: boolean, retryAfterSeconds: number, remaining: number }}
   */
  check(key) {
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + this.windowMs };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    const allowed = bucket.count <= this.max;
    return {
      allowed,
      remaining: Math.max(0, this.max - bucket.count),
      retryAfterSeconds: Math.ceil((bucket.resetAt - now) / 1000)
    };
  }

  /** Clears a key, e.g. after a successful login. */
  reset(key) {
    this.buckets.delete(key);
  }

  sweep() {
    const now = Date.now();
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }

  stop() {
    clearInterval(this.timer);
  }
}

/** Best-effort client identity for rate limiting. */
export function clientKey(req) {
  return req.ip || req.socket?.remoteAddress || 'unknown';
}
