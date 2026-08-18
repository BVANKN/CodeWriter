import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(here, '..');

// Minimal .env loader. We deliberately avoid a dependency: the file format we
// support is `KEY=value`, `#` comments, and optional surrounding quotes.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key || key in process.env) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

loadDotEnv(path.join(backendRoot, '.env'));

function int(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Environment variable ${name} must be an integer, got "${raw}"`);
  }
  return parsed;
}

function bool(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return /^(1|true|yes|on)$/i.test(raw);
}

const port = int('PORT', 8721);
const host = process.env.HOST || '127.0.0.1';

const publicUrlRaw = process.env.PUBLIC_URL || `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`;

let publicUrl;
try {
  publicUrl = new URL(publicUrlRaw);
} catch {
  throw new Error(`PUBLIC_URL is not a valid URL: "${publicUrlRaw}"`);
}
// The OAuth issuer must have no query or fragment, and we normalise away a
// trailing slash so that string comparisons downstream are stable.
publicUrl.search = '';
publicUrl.hash = '';
if (publicUrl.pathname !== '/') {
  publicUrl.pathname = publicUrl.pathname.replace(/\/+$/, '');
}

const baseHref = publicUrl.href.replace(/\/$/, '');

function derivedAllowedHosts() {
  const explicit = (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  const hosts = new Set([
    publicUrl.host,
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`
  ]);
  return [...hosts];
}

export const config = {
  backendRoot,
  port,
  host,

  /** Normalised external base URL, e.g. `https://x.trycloudflare.com` (no trailing slash). */
  baseUrl: baseHref,
  /** URL object form of {@link config.baseUrl}. */
  publicUrl,
  /** OAuth issuer identifier. Same as baseUrl by design (we are AS and RS). */
  issuerUrl: new URL(baseHref),
  /** The MCP endpoint clients connect to. This is the URL the user pastes. */
  mcpUrl: `${baseHref}/mcp`,
  /** RFC 8707 resource identifier for tokens minted for the MCP endpoint. */
  resourceUrl: new URL(`${baseHref}/mcp`),

  dataDir: path.resolve(backendRoot, process.env.DATA_DIR || './data'),

  accessTokenTtl: int('ACCESS_TOKEN_TTL', 3600),
  refreshTokenTtl: int('REFRESH_TOKEN_TTL', 60 * 60 * 24 * 30),
  authCodeTtl: int('AUTH_CODE_TTL', 300),
  /** Lifetime of the browser cookie session used by the /authorize login page. */
  browserSessionTtl: int('BROWSER_SESSION_TTL', 60 * 60 * 12),
  /** Lifetime of the opaque token the Electron app uses for /api and the WS bridge. */
  appTokenTtl: int('APP_TOKEN_TTL', 60 * 60 * 24 * 30),

  alwaysPromptConsent: bool('ALWAYS_PROMPT_CONSENT', false),

  mcpAllowedHosts: derivedAllowedHosts(),

  maxReadBytes: int('MAX_READ_BYTES', 1024 * 1024),
  maxFileBytes: int('MAX_FILE_BYTES', 5 * 1024 * 1024),
  /** Upper bound on how long we wait for the Electron agent to answer an RPC. */
  bridgeRpcTimeoutMs: int('BRIDGE_RPC_TIMEOUT_MS', 30_000),
  /** Upper bound for write RPCs, which may need user approval in review mode. */
  bridgeWriteTimeoutMs: int('BRIDGE_WRITE_TIMEOUT_MS', 300_000),

  logLevel: process.env.LOG_LEVEL || 'info',

  /** Scopes this server understands. */
  scopes: ['workspace:read', 'workspace:write'],

  isLoopback: /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(publicUrl.hostname.replace(/^\[|\]$/g, '') === '::1' ? '[::1]' : publicUrl.hostname)
};

export default config;
