import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

/**
 * scrypt parameters. N=2^15 with r=8 costs roughly 100 ms and 32 MiB per
 * hash on a modern Mac, which is the right order of magnitude for an
 * interactive login and expensive enough to make offline cracking of the
 * JSON file painful.
 */
const PARAMS = { N: 32768, r: 8, p: 1, keylen: 64 };
const SALT_BYTES = 16;

/**
 * Encoded form: `scrypt$N$r$p$saltBase64$hashBase64`. The parameters travel
 * with the hash so they can be raised later without invalidating old records.
 *
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  assertPasswordShape(password);
  const salt = crypto.randomBytes(SALT_BYTES);
  const derived = await scrypt(normalize(password), salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 256 * 1024 * 1024
  });
  return [
    'scrypt',
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString('base64'),
    derived.toString('base64')
  ].join('$');
}

/**
 * Constant-time verification against an encoded hash.
 * @param {string} password
 * @param {string} encoded
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, encoded) {
  if (typeof password !== 'string' || typeof encoded !== 'string') return false;

  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number.parseInt(parts[1], 10);
  const r = Number.parseInt(parts[2], 10);
  const p = Number.parseInt(parts[3], 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }
  if (!salt.length || !expected.length) return false;

  let derived;
  try {
    derived = await scrypt(normalize(password), salt, expected.length, {
      N,
      r,
      p,
      maxmem: 256 * 1024 * 1024
    });
  } catch {
    return false;
  }

  return crypto.timingSafeEqual(derived, expected);
}

/**
 * Burns roughly the same CPU as a real verification. Called when the email is
 * unknown so that "no such user" and "wrong password" take the same time and
 * an attacker cannot enumerate accounts from response latency.
 */
export async function burnPasswordTime() {
  const salt = crypto.randomBytes(SALT_BYTES);
  await scrypt('timing-equalisation', salt, PARAMS.keylen, {
    N: PARAMS.N,
    r: PARAMS.r,
    p: PARAMS.p,
    maxmem: 256 * 1024 * 1024
  });
}

/** Unicode-normalise so the same typed password matches across input methods. */
function normalize(password) {
  return password.normalize('NFKC');
}

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;

/**
 * @param {unknown} password
 * @throws {Error} with a message suitable for display when the shape is wrong.
 */
export function assertPasswordShape(password) {
  if (typeof password !== 'string') {
    throw new Error('Password must be a string.');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new Error(`Password must be at least ${PASSWORD_MIN_LENGTH} characters.`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new Error(`Password must be at most ${PASSWORD_MAX_LENGTH} characters.`);
  }
}

/** Basic, permissive email validation. We are not trying to out-clever RFC 5322. */
export function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}
