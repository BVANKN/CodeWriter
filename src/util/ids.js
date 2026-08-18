import crypto from 'node:crypto';

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

/** URL-safe, high-entropy opaque token. Used for OAuth codes and tokens. */
export function secureToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Short, human-scannable identifier with a namespace prefix (e.g. `ws_k3f9x2`). */
export function prefixedId(prefix, bytes = 12) {
  const buf = crypto.randomBytes(bytes);
  let out = '';
  for (const byte of buf) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${out}`;
}

export function uuid() {
  return crypto.randomUUID();
}

/**
 * Constant-time string comparison. Returns false for non-strings and for
 * mismatched lengths, but still performs a comparison so the cost is similar.
 */
export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * SHA-256 of a string, hex encoded. Bearer tokens and app tokens are stored
 * hashed at rest so a leaked data file does not hand over live credentials.
 */
export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}
