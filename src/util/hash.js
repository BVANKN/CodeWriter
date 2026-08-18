import crypto from 'node:crypto';

/**
 * The revision of a file is a short content hash. Using content rather than a
 * counter means the value is stable across restarts, identical for identical
 * content, and cannot drift out of sync with what is actually on disk. Every
 * write must quote the revision it was based on, which is how we detect that a
 * model is working from stale content.
 *
 * @param {string | Buffer} content
 * @returns {string} 16 hex characters, e.g. `9f2c1ab4d0e77c31`.
 */
export function contentRevision(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

/** Full SHA-256 of a buffer, hex encoded. */
export function sha256(content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** Stable hash of an arbitrary JSON-serialisable value (key order independent). */
export function stableHash(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16);
}

function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}
