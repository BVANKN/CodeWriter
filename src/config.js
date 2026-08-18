import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const backendRoot = path.resolve(here, '..');

// ============================================================================
// CodeWriter Backend Configuration
// ============================================================================
// Configure your server settings directly in this file.
// ============================================================================

/** Port the HTTP server binds to. */
export const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 8721;

/** Interface to bind. Use 127.0.0.1 for local only, 0.0.0.0 for reverse proxy/tunnel. */
export const HOST = process.env.HOST || '127.0.0.1';

/**
 * The externally reachable base URL of this server.
 * Local only:         http://127.0.0.1:8721
 * Behind cloudflared: https://something.trycloudflare.com
 * Behind ngrok:       https://abcd-1-2-3-4.ngrok-free.app
 */
export const PUBLIC_URL =
  process.env.PUBLIC_URL || `http://${HOST === '0.0.0.0' ? '127.0.0.1' : HOST}:${PORT}`;

/** Where the JSON database lives (relative to backend root or absolute path). */
export const DATA_DIR = process.env.DATA_DIR || './data';

/** Access token lifetime in seconds (default 1 hour). */
export const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL
  ? parseInt(process.env.ACCESS_TOKEN_TTL, 10)
  : 3600;

/** Refresh token lifetime in seconds (default 30 days). */
export const REFRESH_TOKEN_TTL = process.env.REFRESH_TOKEN_TTL
  ? parseInt(process.env.REFRESH_TOKEN_TTL, 10)
  : 60 * 60 * 24 * 30;

/** Authorization code lifetime in seconds (default 5 minutes). */
export const AUTH_CODE_TTL = process.env.AUTH_CODE_TTL
  ? parseInt(process.env.AUTH_CODE_TTL, 10)
  : 300;

/** Lifetime of the browser cookie session used by the /authorize login page (in seconds, default 12 hours). */
export const BROWSER_SESSION_TTL = process.env.BROWSER_SESSION_TTL
  ? parseInt(process.env.BROWSER_SESSION_TTL, 10)
  : 60 * 60 * 12;

/** Lifetime of the opaque token the Electron app uses for /api and the WS bridge (in seconds, default 30 days). */
export const APP_TOKEN_TTL = process.env.APP_TOKEN_TTL
  ? parseInt(process.env.APP_TOKEN_TTL, 10)
  : 60 * 60 * 24 * 30;

/**
 * Set to true to require an existing user to explicitly approve every new OAuth client.
 * Set to false to auto-approve clients the user has already approved once.
 */
export const ALWAYS_PROMPT_CONSENT =
  process.env.ALWAYS_PROMPT_CONSENT !== undefined
    ? /^(1|true|yes|on)$/i.test(process.env.ALWAYS_PROMPT_CONSENT)
    : false;

/** Comma-separated Host header allowlist or array for DNS-rebinding protection on /mcp (empty to auto-derive). */
export const MCP_ALLOWED_HOSTS = process.env.MCP_ALLOWED_HOSTS || '';

/** Max bytes of file content the MCP server will return in a single tool call (default 1MB). */
export const MAX_READ_BYTES = process.env.MAX_READ_BYTES
  ? parseInt(process.env.MAX_READ_BYTES, 10)
  : 1024 * 1024;

/** Max bytes of a single file the frontend will index / allow to be written (default 5MB). */
export const MAX_FILE_BYTES = process.env.MAX_FILE_BYTES
  ? parseInt(process.env.MAX_FILE_BYTES, 10)
  : 5 * 1024 * 1024;

/** Upper bound on how long we wait for the Electron agent to answer an RPC (in milliseconds). */
export const BRIDGE_RPC_TIMEOUT_MS = process.env.BRIDGE_RPC_TIMEOUT_MS
  ? parseInt(process.env.BRIDGE_RPC_TIMEOUT_MS, 10)
  : 30_000;

/** Upper bound for write RPCs, which may need user approval in review mode (in milliseconds). */
export const BRIDGE_WRITE_TIMEOUT_MS = process.env.BRIDGE_WRITE_TIMEOUT_MS
  ? parseInt(process.env.BRIDGE_WRITE_TIMEOUT_MS, 10)
  : 300_000;

/** Log level: debug | info | warn | error */
export const LOG_LEVEL = process.env.LOG_LEVEL || 'info';

let parsedPublicUrl;
try {
  parsedPublicUrl = new URL(PUBLIC_URL);
} catch {
  throw new Error(`PUBLIC_URL is not a valid URL: "${PUBLIC_URL}"`);
}
// The OAuth issuer must have no query or fragment, and we normalise away a
// trailing slash so that string comparisons downstream are stable.
parsedPublicUrl.search = '';
parsedPublicUrl.hash = '';
if (parsedPublicUrl.pathname !== '/') {
  parsedPublicUrl.pathname = parsedPublicUrl.pathname.replace(/\/+$/, '');
}

const baseHref = parsedPublicUrl.href.replace(/\/$/, '');

function derivedAllowedHosts() {
  const explicit = (typeof MCP_ALLOWED_HOSTS === 'string' ? MCP_ALLOWED_HOSTS : '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length) return explicit;
  if (Array.isArray(MCP_ALLOWED_HOSTS) && MCP_ALLOWED_HOSTS.length) return MCP_ALLOWED_HOSTS;
  const hosts = new Set([
    parsedPublicUrl.host,
    `127.0.0.1:${PORT}`,
    `localhost:${PORT}`,
    `[::1]:${PORT}`
  ]);
  return [...hosts];
}

export const config = {
  backendRoot,
  port: PORT,
  host: HOST,

  /** Normalised external base URL, e.g. `https://x.trycloudflare.com` (no trailing slash). */
  baseUrl: baseHref,
  /** URL object form of {@link config.baseUrl}. */
  publicUrl: parsedPublicUrl,
  /** OAuth issuer identifier. Same as baseUrl by design (we are AS and RS). */
  issuerUrl: new URL(baseHref),
  /** The MCP endpoint clients connect to. This is the URL the user pastes. */
  mcpUrl: `${baseHref}/mcp`,
  /** RFC 8707 resource identifier for tokens minted for the MCP endpoint. */
  resourceUrl: new URL(`${baseHref}/mcp`),

  dataDir: path.resolve(backendRoot, DATA_DIR),

  accessTokenTtl: ACCESS_TOKEN_TTL,
  refreshTokenTtl: REFRESH_TOKEN_TTL,
  authCodeTtl: AUTH_CODE_TTL,
  /** Lifetime of the browser cookie session used by the /authorize login page. */
  browserSessionTtl: BROWSER_SESSION_TTL,
  /** Lifetime of the opaque token the Electron app uses for /api and the WS bridge. */
  appTokenTtl: APP_TOKEN_TTL,

  alwaysPromptConsent: ALWAYS_PROMPT_CONSENT,

  mcpAllowedHosts: derivedAllowedHosts(),

  maxReadBytes: MAX_READ_BYTES,
  maxFileBytes: MAX_FILE_BYTES,
  /** Upper bound on how long we wait for the Electron agent to answer an RPC. */
  bridgeRpcTimeoutMs: BRIDGE_RPC_TIMEOUT_MS,
  /** Upper bound for write RPCs, which may need user approval in review mode. */
  bridgeWriteTimeoutMs: BRIDGE_WRITE_TIMEOUT_MS,

  logLevel: LOG_LEVEL,

  /** Scopes this server understands. */
  scopes: ['workspace:read', 'workspace:write'],

  isLoopback: /^(127\.0\.0\.1|localhost|\[::1\])$/i.test(
    parsedPublicUrl.hostname.replace(/^\[|\]$/g, '') === '::1'
      ? '[::1]'
      : parsedPublicUrl.hostname
  )
};

export default config;
