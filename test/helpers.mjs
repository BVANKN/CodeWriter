import crypto from 'node:crypto';

/**
 * Test helpers that drive the real OAuth 2.1 flow over HTTP, exactly as an MCP
 * client and a browser would: dynamic registration, PKCE, the interactive login
 * and consent pages, then the code-for-token exchange.
 *
 * Nothing here shortcuts the server's own logic — no reaching into stores, no
 * minting tokens directly. A test that fakes the handshake proves only that the
 * fake works.
 */

/** PKCE S256 pair. */
export function createPkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** Minimal cookie jar, so the login POST and the consent GET share a session. */
export class CookieJar {
  constructor() {
    this.cookies = new Map();
  }

  absorb(response) {
    const raw = response.headers.getSetCookie?.() ?? [];
    for (const cookie of raw) {
      const [pair] = cookie.split(';');
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      if (value === '' || /Max-Age=0/i.test(cookie)) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

/** Registers an OAuth client via RFC 7591 dynamic client registration. */
export async function registerClient(baseUrl, { name, redirectUri }) {
  const response = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: name,
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope: 'workspace:read workspace:write'
    })
  });
  if (!response.ok) {
    throw new Error(`Client registration failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/** Creates an account through the desktop API and returns its app token. */
export async function createAccount(baseUrl, { email, password, name }) {
  const response = await fetch(`${baseUrl}/api/auth/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name, deviceName: 'test-suite' })
  });
  if (!response.ok) {
    throw new Error(`Signup failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

/**
 * Walks the entire authorization-code flow the way a browser does, following
 * each redirect by hand so the test can assert on the intermediate steps.
 *
 * @returns {Promise<{ code: string, state: string, redirectUrl: URL }>}
 */
export async function authorizeInteractively(
  baseUrl,
  { clientId, redirectUri, challenge, scope, email, password, resource }
) {
  const jar = new CookieJar();

  const state = crypto.randomBytes(8).toString('hex');
  const authorizeUrl = new URL(`${baseUrl}/authorize`);
  authorizeUrl.searchParams.set('client_id', clientId);
  authorizeUrl.searchParams.set('redirect_uri', redirectUri);
  authorizeUrl.searchParams.set('response_type', 'code');
  authorizeUrl.searchParams.set('code_challenge', challenge);
  authorizeUrl.searchParams.set('code_challenge_method', 'S256');
  authorizeUrl.searchParams.set('state', state);
  if (scope) authorizeUrl.searchParams.set('scope', scope);
  if (resource) authorizeUrl.searchParams.set('resource', resource);

  // 1. /authorize parks the request and redirects to the login page.
  const step1 = await fetch(authorizeUrl, { redirect: 'manual' });
  jar.absorb(step1);
  if (step1.status !== 302) {
    throw new Error(`Expected a redirect from /authorize, got ${step1.status}: ${await step1.text()}`);
  }
  const loginLocation = new URL(step1.headers.get('location'), baseUrl);
  const tx = loginLocation.searchParams.get('tx');
  if (!tx) throw new Error(`No transaction id in redirect: ${loginLocation}`);

  // 2. Sign in.
  const step2 = await fetch(`${baseUrl}/oauth/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
    body: new URLSearchParams({ tx, email, password })
  });
  jar.absorb(step2);
  if (step2.status !== 302) {
    throw new Error(`Login did not redirect (${step2.status}): ${await step2.text()}`);
  }

  const afterLogin = new URL(step2.headers.get('location'), baseUrl);

  // The server may skip consent when this client was approved before.
  if (afterLogin.pathname === '/oauth/consent') {
    const consentPage = await fetch(afterLogin, { headers: { Cookie: jar.header() } });
    const html = await consentPage.text();
    if (!html.includes('Authorize access')) {
      throw new Error('Consent page did not render as expected');
    }

    const step3 = await fetch(`${baseUrl}/oauth/consent`, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: jar.header() },
      body: new URLSearchParams({ tx, decision: 'allow' })
    });
    if (step3.status !== 302) {
      throw new Error(`Consent did not redirect (${step3.status}): ${await step3.text()}`);
    }
    const final = new URL(step3.headers.get('location'));
    return { code: final.searchParams.get('code'), state: final.searchParams.get('state'), redirectUrl: final, jar };
  }

  return {
    code: afterLogin.searchParams.get('code'),
    state: afterLogin.searchParams.get('state'),
    redirectUrl: afterLogin,
    jar
  };
}

/** Exchanges an authorization code for tokens. */
export async function exchangeCode(baseUrl, { clientId, code, verifier, redirectUri, resource }) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  });
  if (resource) body.set('resource', resource);

  const response = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await response.json();
  if (!response.ok) {
    throw new Error(`Token exchange failed: ${response.status} ${JSON.stringify(json)}`);
  }
  return json;
}

/** Refreshes an access token. */
export async function refresh(baseUrl, { clientId, refreshToken, resource }) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    refresh_token: refreshToken
  });
  if (resource) body.set('resource', resource);

  const response = await fetch(`${baseUrl}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  });
  const json = await response.json();
  if (!response.ok) throw new Error(`Refresh failed: ${response.status} ${JSON.stringify(json)}`);
  return json;
}

/** Waits for a predicate, polling. Keeps async tests free of arbitrary sleeps. */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25, label = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await predicate();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
