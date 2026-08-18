/**
 * Cookie helpers. Express 5 does not ship a cookie parser and we only need a
 * couple of well-understood cookies, so a dependency is not worth it.
 */

/** @returns {Record<string, string>} */
export function parseCookies(req) {
  const header = req.headers?.cookie;
  if (!header) return {};
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {import('express').Response} res
 * @param {string} name
 * @param {string} value
 * @param {object} options
 * @param {number} options.maxAge  Seconds.
 * @param {boolean} options.secure Send only over HTTPS.
 * @param {string} [options.sameSite] Defaults to 'Lax'.
 * @param {string} [options.path] Defaults to '/'.
 */
export function setCookie(res, name, value, options) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path || '/'}`);
  parts.push('HttpOnly');
  // SameSite=Lax is right for the OAuth login page: the browser arrives via a
  // top-level GET redirect from the MCP client, which Lax permits, while
  // cross-site POSTs still cannot carry the session.
  parts.push(`SameSite=${options.sameSite || 'Lax'}`);
  if (options.secure) parts.push('Secure');
  if (typeof options.maxAge === 'number') {
    parts.push(`Max-Age=${Math.floor(options.maxAge)}`);
    parts.push(`Expires=${new Date(Date.now() + options.maxAge * 1000).toUTCString()}`);
  }
  appendSetCookie(res, parts.join('; '));
}

export function clearCookie(res, name, options = {}) {
  const parts = [
    `${name}=`,
    `Path=${options.path || '/'}`,
    'HttpOnly',
    `SameSite=${options.sameSite || 'Lax'}`,
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT'
  ];
  if (options.secure) parts.push('Secure');
  appendSetCookie(res, parts.join('; '));
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookie]);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookie]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookie]);
  }
}
