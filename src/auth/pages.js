import config from '../config.js';

/**
 * The browser-facing pages for the OAuth flow.
 *
 * These are rendered by the backend, not the Electron app, because the MCP
 * client opens them in the user's real browser. They are deliberately plain,
 * self-contained HTML with no external requests: no CDN, no fonts, no
 * analytics. A consent screen that phones out to a third party is a consent
 * screen you cannot reason about.
 */

/** Escapes text for interpolation into HTML. */
export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BASE_CSS = `
  :root {
    color-scheme: light dark;
    --bg: #f6f7f9;
    --panel: #ffffff;
    --text: #14161a;
    --muted: #5c6370;
    --border: #dfe3e8;
    --accent: #2f6feb;
    --accent-text: #ffffff;
    --danger: #c0392b;
    --danger-bg: #fdeceb;
    --ok: #1f7a4d;
    --code-bg: #f0f2f5;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #121417;
      --panel: #1b1e23;
      --text: #e6e8eb;
      --muted: #9aa1ad;
      --border: #2b3038;
      --accent: #4a86ff;
      --accent-text: #ffffff;
      --danger: #ff6b5e;
      --danger-bg: #33201e;
      --ok: #4fc98a;
      --code-bg: #23272e;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  }
  .card {
    width: 100%;
    max-width: 460px;
    background: var(--panel);
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 28px;
    box-shadow: 0 8px 30px rgba(0,0,0,0.06);
  }
  .brand {
    display: flex; align-items: center; gap: 10px;
    font-weight: 650; font-size: 16px; margin-bottom: 20px;
  }
  .brand .dot {
    width: 22px; height: 22px; border-radius: 6px;
    background: var(--accent); color: var(--accent-text);
    display: grid; place-items: center; font-size: 13px; font-weight: 700;
  }
  h1 { font-size: 19px; margin: 0 0 6px; letter-spacing: -0.01em; }
  p.sub { margin: 0 0 20px; color: var(--muted); font-size: 14px; }
  label { display: block; font-size: 13px; font-weight: 600; margin: 14px 0 6px; }
  input[type=email], input[type=password], input[type=text] {
    width: 100%; padding: 10px 12px; font-size: 14px;
    border: 1px solid var(--border); border-radius: 8px;
    background: var(--bg); color: var(--text);
  }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; border-color: transparent; }
  button {
    width: 100%; margin-top: 20px; padding: 11px 14px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    border: 1px solid transparent; border-radius: 8px;
    background: var(--accent); color: var(--accent-text);
  }
  button:hover { filter: brightness(1.08); }
  button.secondary {
    background: transparent; color: var(--muted);
    border-color: var(--border); margin-top: 8px;
  }
  .error {
    background: var(--danger-bg); color: var(--danger);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    padding: 10px 12px; border-radius: 8px; font-size: 13.5px; margin-bottom: 4px;
  }
  .client {
    background: var(--code-bg); border: 1px solid var(--border);
    border-radius: 8px; padding: 12px 14px; margin: 4px 0 16px; font-size: 13.5px;
  }
  .client .name { font-weight: 650; }
  .client .uri { color: var(--muted); font-size: 12.5px; word-break: break-all; margin-top: 4px; }
  ul.scopes { list-style: none; padding: 0; margin: 0 0 4px; }
  ul.scopes li {
    display: flex; gap: 9px; align-items: flex-start;
    padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 14px;
  }
  ul.scopes li:last-child { border-bottom: 0; }
  ul.scopes .mark { color: var(--ok); font-weight: 700; line-height: 1.4; }
  ul.scopes .desc { color: var(--muted); font-size: 12.5px; display: block; margin-top: 2px; }
  .foot { margin-top: 18px; font-size: 12.5px; color: var(--muted); text-align: center; }
  code { background: var(--code-bg); padding: 1px 5px; border-radius: 4px; font-size: 12.5px; }
  .row { display: flex; gap: 10px; }
  .row button { margin-top: 20px; }
`;

function layout(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)}</title>
<style>${BASE_CSS}</style>
</head>
<body>
<div class="card">
  <div class="brand"><span class="dot">CW</span> CodeWriter</div>
  ${body}
</div>
</body>
</html>`;
}

/**
 * The sign-in step of the OAuth flow.
 * @param {object} options
 * @param {string} options.txId       Pending authorization id.
 * @param {string} [options.error]    Message to show above the form.
 * @param {string} [options.email]    Pre-filled email.
 * @param {string} [options.clientName]
 * @param {boolean} [options.allowSignup] Show the "create account" toggle.
 * @param {boolean} [options.signupMode]  Render as a signup form.
 */
export function renderLoginPage({ txId, error, email, clientName, allowSignup, signupMode }) {
  const action = signupMode ? '/oauth/signup' : '/oauth/login';
  const heading = signupMode ? 'Create your CodeWriter account' : 'Sign in to CodeWriter';
  const sub = clientName
    ? `${escapeHtml(clientName)} is asking to connect to your workspaces.`
    : 'An MCP client is asking to connect to your workspaces.';

  return layout(heading, `
  <h1>${escapeHtml(heading)}</h1>
  <p class="sub">${sub}</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <form method="post" action="${action}" autocomplete="on">
    <input type="hidden" name="tx" value="${escapeHtml(txId)}">
    ${signupMode ? `
    <label for="name">Name</label>
    <input id="name" name="name" type="text" autocomplete="name" placeholder="Optional">` : ''}
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="username"
           value="${escapeHtml(email || '')}" autofocus>
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required
           autocomplete="${signupMode ? 'new-password' : 'current-password'}">
    ${signupMode ? `
    <label for="confirm">Confirm password</label>
    <input id="confirm" name="confirm" type="password" required autocomplete="new-password">` : ''}
    <button type="submit">${signupMode ? 'Create account and continue' : 'Sign in'}</button>
  </form>
  ${allowSignup ? `
  <form method="get" action="${signupMode ? '/oauth/login' : '/oauth/signup'}">
    <input type="hidden" name="tx" value="${escapeHtml(txId)}">
    <button class="secondary" type="submit">
      ${signupMode ? 'I already have an account' : 'Create a new account'}
    </button>
  </form>` : ''}
  <div class="foot">Signing in on <code>${escapeHtml(config.publicUrl.host)}</code></div>
`);
}

const SCOPE_COPY = {
  'workspace:read': {
    title: 'Read your open workspaces',
    desc: 'List files, read file contents, search, and inspect git status for projects you have open in CodeWriter.'
  },
  'workspace:write': {
    title: 'Write files and run project commands',
    desc: 'Create, edit, move and delete files in your open workspaces, and run build/test commands you have allowed.'
  }
};

/**
 * The consent step. Shows exactly which client is asking, where it will be
 * redirected, and what each scope actually permits.
 */
export function renderConsentPage({ txId, clientName, clientUri, redirectUri, scopes, userEmail, error }) {
  const scopeItems = scopes
    .map((scope) => {
      const copy = SCOPE_COPY[scope] || { title: scope, desc: '' };
      return `<li><span class="mark">&#10003;</span><span>${escapeHtml(copy.title)}
        ${copy.desc ? `<span class="desc">${escapeHtml(copy.desc)}</span>` : ''}
        <span class="desc"><code>${escapeHtml(scope)}</code></span></span></li>`;
    })
    .join('');

  return layout('Authorize access', `
  <h1>Authorize access</h1>
  <p class="sub">Signed in as ${escapeHtml(userEmail)}</p>
  ${error ? `<div class="error">${escapeHtml(error)}</div>` : ''}
  <div class="client">
    <div class="name">${escapeHtml(clientName || 'Unnamed MCP client')}</div>
    ${clientUri ? `<div class="uri">${escapeHtml(clientUri)}</div>` : ''}
    <div class="uri">Redirects to ${escapeHtml(redirectUri)}</div>
  </div>
  <ul class="scopes">${scopeItems}</ul>
  <form method="post" action="/oauth/consent">
    <input type="hidden" name="tx" value="${escapeHtml(txId)}">
    <input type="hidden" name="decision" value="allow">
    <button type="submit">Allow access</button>
  </form>
  <form method="post" action="/oauth/consent">
    <input type="hidden" name="tx" value="${escapeHtml(txId)}">
    <input type="hidden" name="decision" value="deny">
    <button class="secondary" type="submit">Deny</button>
  </form>
  <div class="foot">
    You can revoke this at any time from the Connections panel in CodeWriter.
  </div>
`);
}

/** Terminal error page, used when we cannot safely redirect back to the client. */
export function renderErrorPage(title, message, detail) {
  return layout(title, `
  <h1>${escapeHtml(title)}</h1>
  <div class="error">${escapeHtml(message)}</div>
  ${detail ? `<p class="sub" style="margin-top:14px">${escapeHtml(detail)}</p>` : ''}
  <div class="foot">You can close this window.</div>
`);
}

/** Shown when the client has no redirect URI we can bounce back to. */
export function renderSuccessPage(message) {
  return layout('Done', `
  <h1>Authorized</h1>
  <p class="sub">${escapeHtml(message || 'You can close this window and return to your MCP client.')}</p>
`);
}
