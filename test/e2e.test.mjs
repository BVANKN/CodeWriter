import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createPkce, registerClient, createAccount, authorizeInteractively, exchangeCode, refresh, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));

// The desktop agent is exercised directly rather than mocked. A mock would only
// prove the mock behaves; this proves the code that ships does.
const { WorkspaceAgent } = require(path.resolve(here, '../../frontend/electron/agent/workspace-agent.cjs'));

const PORT = 8900 + (process.pid % 200);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://127.0.0.1:9911/callback';
const PASSWORD = 'a-sufficiently-long-password';

let dataDir;
let projectDir;
let server;
let backend;
let agent;
let mcpClient;
let accessToken;

/** Builds a small but realistic project to operate on. */
async function makeProject() {
  const root = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-project-')));
  const write = async (rel, content) => {
    await fsp.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await fsp.writeFile(path.join(root, rel), content, 'utf8');
  };

  await write(
    'package.json',
    JSON.stringify(
      {
        name: 'sample-project',
        version: '1.0.0',
        scripts: {
          build: 'node scripts/build.mjs',
          test: 'node scripts/test.mjs',
          dev: 'node scripts/dev.mjs'
        }
      },
      null,
      2
    )
  );
  await write('scripts/build.mjs', 'console.log("build ok");\n');
  // The test script asserts on the source, so an edit can genuinely break it.
  await write(
    'scripts/test.mjs',
    [
      'import fs from "node:fs";',
      'const src = fs.readFileSync(new URL("../src/math.js", import.meta.url), "utf8");',
      'if (!src.includes("export function add")) { console.error("FAIL: add() is missing"); process.exit(1); }',
      'console.log("tests passed");'
    ].join('\n') + '\n'
  );
  await write('src/math.js', 'export function add(a, b) {\n  return a + b;\n}\n');
  await write('src/index.js', 'import { add } from "./math.js";\nconsole.log(add(1, 2));\n');
  await write('.gitignore', 'dist/\n*.log\n');
  await write('dist/ignored.js', 'IGNORED');
  await write('debug.log', 'IGNORED');
  await write('.env', 'SECRET=hunter2');
  await fsp.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await write('node_modules/pkg/index.js', 'IGNORED');

  return root;
}

test.before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-data-'));
  projectDir = await makeProject();

  process.env.PORT = String(PORT);
  process.env.HOST = '127.0.0.1';
  process.env.PUBLIC_URL = BASE_URL;
  process.env.DATA_DIR = dataDir;
  process.env.LOG_LEVEL = 'error';

  const { createApp } = await import('../src/app.js');
  backend = createApp();
  server = http.createServer(backend.app);
  backend.hub.attach(server);
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
});

test.after(async () => {
  await mcpClient?.close().catch(() => {});
  await agent?.shutdown();
  agentBridge?.close();
  await backend?.close();
  await new Promise((resolve) => server?.close(resolve));
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(projectDir, { recursive: true, force: true });
});

let appToken;
let agentBridge;

test('the desktop app signs up and connects the bridge', async () => {
  const account = await createAccount(BASE_URL, {
    email: 'dev@example.com',
    password: PASSWORD,
    name: 'Dev'
  });
  assert.ok(account.token, 'signup returns an app token');
  appToken = account.token;

  // A minimal stand-in for Electron's main process: the real agent, driven by
  // a plain WebSocket rather than the BridgeClient's reconnect machinery.
  const WebSocket = require('ws');
  const socket = new WebSocket(`${BASE_URL.replace('http', 'ws')}/bridge`, {
    headers: { Authorization: `Bearer ${appToken}` }
  });
  agentBridge = socket;

  agent = new WorkspaceAgent({
    send: (frame) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(frame));
    }
  });

  await new Promise((resolve, reject) => {
    socket.on('open', resolve);
    socket.on('error', reject);
  });

  socket.on('message', async (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.t === 'req') {
      try {
        const result = await agent.handleRequest(frame.method, frame.params || {});
        socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: true, result }));
      } catch (err) {
        socket.send(
          JSON.stringify({
            t: 'res',
            id: frame.id,
            ok: false,
            error: { code: err.code || 'AGENT_ERROR', message: err.message }
          })
        );
      }
    } else if (frame.t === 'event' && frame.event === 'workspace-registered') {
      await agent.onWorkspaceRegistered(frame);
    }
  });

  await waitFor(() => backend.hub.agents.size === 1, { label: 'the bridge to connect' });
});

test('opening a folder indexes it, honouring .gitignore', async () => {
  await agent.openWorkspace(projectDir, { kind: 'folder' });

  const workspace = await waitFor(
    () => {
      const [first] = backend.registry.listForUser(backend.users.findByEmail('dev@example.com').id);
      return first?.indexComplete ? first : null;
    },
    { label: 'the workspace to finish indexing', timeoutMs: 15_000 }
  );

  const paths = [...workspace.files.keys()];
  assert.ok(paths.includes('src/math.js'), 'source files are indexed');
  assert.ok(paths.includes('package.json'));
  assert.ok(!paths.includes('dist/ignored.js'), 'gitignored directories are excluded');
  assert.ok(!paths.includes('debug.log'), 'gitignored globs are excluded');
  assert.ok(!paths.includes('.env'), 'secrets are excluded');
  assert.ok(!paths.some((p) => p.startsWith('node_modules/')), 'node_modules is excluded');

  // Verification must be detected and enforced for a folder.
  assert.equal(workspace.verification.enforced, true);
  const labels = workspace.verification.commands.map((c) => c.label);
  assert.ok(labels.includes('npm run build'), `expected build command, got ${labels.join(', ')}`);
  assert.ok(labels.includes('npm run test'));
  assert.ok(!labels.some((l) => l.includes('dev')), 'the dev script is never a verification command');
});

test('an MCP client completes the OAuth flow and connects', async () => {
  const client = await registerClient(BASE_URL, { name: 'Test MCP Client', redirectUri: REDIRECT_URI });
  assert.ok(client.client_id, 'dynamic client registration works');

  const { verifier, challenge } = createPkce();
  const { code, state } = await authorizeInteractively(BASE_URL, {
    clientId: client.client_id,
    redirectUri: REDIRECT_URI,
    challenge,
    scope: 'workspace:read workspace:write',
    email: 'dev@example.com',
    password: PASSWORD,
    resource: `${BASE_URL}/mcp`
  });
  assert.ok(code, 'the consent flow yields an authorization code');
  assert.ok(state, 'state is round-tripped');

  const tokens = await exchangeCode(BASE_URL, {
    clientId: client.client_id,
    code,
    verifier,
    redirectUri: REDIRECT_URI,
    resource: `${BASE_URL}/mcp`
  });
  assert.ok(tokens.access_token);
  assert.equal(tokens.token_type, 'Bearer');
  accessToken = tokens.access_token;

  // A code is single use.
  await assert.rejects(
    () => exchangeCode(BASE_URL, { clientId: client.client_id, code, verifier, redirectUri: REDIRECT_URI }),
    /Token exchange failed/,
    'replaying an authorization code is rejected'
  );

  // Refresh works and rotates.
  const refreshed = await refresh(BASE_URL, {
    clientId: client.client_id,
    refreshToken: tokens.refresh_token,
    resource: `${BASE_URL}/mcp`
  });
  assert.ok(refreshed.access_token);
  assert.notEqual(refreshed.refresh_token, tokens.refresh_token, 'refresh tokens rotate');
  accessToken = refreshed.access_token;

  mcpClient = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${accessToken}` } }
  });
  await mcpClient.connect(transport);

  const capabilities = mcpClient.getServerCapabilities();
  assert.ok(capabilities.tools, 'the server advertises tools');
  assert.ok(capabilities.prompts, 'the server advertises prompts');

  const instructions = mcpClient.getInstructions();
  assert.match(instructions, /revision/i, 'instructions explain the revision contract');
  assert.match(instructions, /COMPLETE file content|Return complete file content/i);
});

test('tools are discoverable and describe the contract', async () => {
  const { tools } = await mcpClient.listTools();
  const names = tools.map((t) => t.name).sort();

  for (const expected of [
    'list_workspaces',
    'get_workspace_overview',
    'list_files',
    'read_files',
    'search_files',
    'write_files',
    'delete_files',
    'move_file',
    'run_command',
    'finish_task',
    'git_status',
    'git_diff'
  ]) {
    assert.ok(names.includes(expected), `missing tool: ${expected}`);
  }

  const write = tools.find((t) => t.name === 'write_files');
  assert.match(write.description, /ENTIRE new file/, 'write_files states the full-content rule');
  assert.match(write.description, /baseRevision/, 'write_files states the revision rule');

  const { prompts } = await mcpClient.listPrompts();
  assert.ok(prompts.some((p) => p.name === 'implement_change'));
  assert.ok(prompts.some((p) => p.name === 'analyze_code'));
});

test('reading is required before writing', async () => {
  const overview = await mcpClient.callTool({ name: 'get_workspace_overview', arguments: {} });
  const overviewText = overview.content[0].text;
  assert.match(overviewText, /VERIFICATION/);
  assert.match(overviewText, /npm run build/);

  const listing = await mcpClient.callTool({ name: 'list_files', arguments: { glob: ['src/**'] } });
  assert.match(listing.content[0].text, /src\/math\.js/);

  // A write attempt with a revision learned from the listing, but no read.
  const revision = listing.structuredContent.files.find((f) => f.path === 'src/math.js').revision;
  const blind = await mcpClient.callTool({
    name: 'write_files',
    arguments: {
      changes: [{ path: 'src/math.js', content: 'export function add(){}\n', baseRevision: revision }]
    }
  });
  assert.equal(blind.isError, true, 'a blind write is rejected');
  assert.match(blind.content[0].text, /have not read/i);

  // Now read it properly.
  const read = await mcpClient.callTool({ name: 'read_files', arguments: { paths: ['src/math.js'] } });
  assert.match(read.content[0].text, /export function add/);
  assert.match(read.content[0].text, /baseRevision:/);
  const freshRevision = read.structuredContent.files[0].revision;

  // A stale revision is still rejected even after reading.
  const stale = await mcpClient.callTool({
    name: 'write_files',
    arguments: {
      changes: [{ path: 'src/math.js', content: 'x\n', baseRevision: 'deadbeefdeadbeef' }]
    }
  });
  assert.equal(stale.isError, true);
  assert.match(stale.content[0].text, /STALE|changed since|revision/i);

  // The correct write succeeds.
  const good = await mcpClient.callTool({
    name: 'write_files',
    arguments: {
      summary: 'Add a subtract function',
      changes: [
        {
          path: 'src/math.js',
          content: 'export function add(a, b) {\n  return a + b;\n}\n\nexport function subtract(a, b) {\n  return a - b;\n}\n',
          baseRevision: freshRevision
        }
      ]
    }
  });
  assert.notEqual(good.isError, true, `write failed: ${good.content[0].text}`);
  assert.match(good.content[0].text, /REQUIRED NEXT STEP/, 'a write demands verification');

  // And it really landed on disk.
  const onDisk = await fsp.readFile(path.join(projectDir, 'src/math.js'), 'utf8');
  assert.match(onDisk, /export function subtract/, 'the change reached the real file');
});

test('finish_task is gated on verification actually passing', async () => {
  const premature = await mcpClient.callTool({
    name: 'finish_task',
    arguments: { summary: 'Added subtract' }
  });
  assert.equal(premature.isError, true, 'finish_task refuses while checks are unverified');
  assert.match(premature.content[0].text, /NOT complete/);
  assert.match(premature.content[0].text, /npm run build/);

  const build = await mcpClient.callTool({
    name: 'run_command',
    arguments: { commandId: 'npm run build' }
  });
  assert.notEqual(build.isError, true, `build failed: ${build.content[0].text}`);
  assert.match(build.content[0].text, /build ok/);

  // One passing check is not enough while another is outstanding.
  const stillBlocked = await mcpClient.callTool({
    name: 'finish_task',
    arguments: { summary: 'Added subtract' }
  });
  assert.equal(stillBlocked.isError, true, 'a partially verified change is still blocked');
  assert.match(stillBlocked.content[0].text, /npm run test/);

  const tests = await mcpClient.callTool({ name: 'run_command', arguments: { commandId: 'npm run test' } });
  assert.notEqual(tests.isError, true, `tests failed: ${tests.content[0].text}`);

  const done = await mcpClient.callTool({
    name: 'finish_task',
    arguments: { summary: 'Added a subtract function to src/math.js' }
  });
  assert.notEqual(done.isError, true, `finish_task failed: ${done.content[0].text}`);
  assert.match(done.content[0].text, /complete/i);
});

test('a later edit invalidates earlier verification', async () => {
  const read = await mcpClient.callTool({ name: 'read_files', arguments: { paths: ['src/math.js'] } });
  const revision = read.structuredContent.files[0].revision;

  // Break the project: the test script asserts add() exists.
  const write = await mcpClient.callTool({
    name: 'write_files',
    arguments: {
      summary: 'Rename add to plus',
      changes: [
        {
          path: 'src/math.js',
          content: 'export function plus(a, b) {\n  return a + b;\n}\n',
          baseRevision: revision
        }
      ]
    }
  });
  assert.notEqual(write.isError, true);

  const blocked = await mcpClient.callTool({ name: 'finish_task', arguments: { summary: 'Renamed' } });
  assert.equal(blocked.isError, true, 'the previous passing runs no longer count');
  assert.match(blocked.content[0].text, /BEFORE your most recent edit|Never run/);

  const failing = await mcpClient.callTool({ name: 'run_command', arguments: { commandId: 'npm run test' } });
  assert.equal(failing.isError, true, 'a failing check is reported as an error result');
  assert.match(failing.content[0].text, /add\(\) is missing/, 'the real failure output reaches the model');
  assert.match(failing.content[0].text, /re-read the files/i, 'the failure carries recovery guidance');

  const stillBlocked = await mcpClient.callTool({ name: 'finish_task', arguments: { summary: 'Renamed' } });
  assert.equal(stillBlocked.isError, true, 'a failing check blocks completion');
});

test('dangerous commands are refused', async () => {
  const push = await mcpClient.callTool({ name: 'run_command', arguments: { argv: ['git', 'push'] } });
  assert.equal(push.isError, true);
  assert.match(push.content[0].text, /not permitted|not allowed/i);

  const shell = await mcpClient.callTool({
    name: 'run_command',
    arguments: { argv: ['bash', '-c', 'echo pwned'] }
  });
  assert.equal(shell.isError, true, 'a shell is never allowed');

  const dev = await mcpClient.callTool({ name: 'run_command', arguments: { argv: ['npm', 'run', 'dev'] } });
  assert.equal(dev.isError, true, 'long-running scripts are refused');
});

test('search finds real call sites', async () => {
  const result = await mcpClient.callTool({
    name: 'search_files',
    arguments: { query: 'add', glob: ['src/**'] }
  });
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /src\/index\.js/, 'the caller in index.js is found');
});

test('path traversal is refused at the tool boundary', async () => {
  for (const badPath of ['../../etc/passwd', '/etc/passwd', 'src/../../escape.js']) {
    const result = await mcpClient.callTool({
      name: 'read_files',
      arguments: { paths: [badPath] }
    });
    assert.equal(result.isError, true, `${badPath} should be refused`);
  }

  const write = await mcpClient.callTool({
    name: 'write_files',
    arguments: { changes: [{ path: '../escape.js', content: 'x' }] }
  });
  assert.equal(write.isError, true, 'traversal in a write is refused');
  assert.ok(!fs.existsSync(path.join(path.dirname(projectDir), 'escape.js')), 'nothing was written outside');
});

test('an unauthenticated or wrong-audience token cannot reach the MCP endpoint', async () => {
  const noAuth = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(noAuth.status, 401);
  assert.match(noAuth.headers.get('www-authenticate') || '', /resource_metadata=/);

  const badToken = await fetch(`${BASE_URL}/mcp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer not-a-real-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
  });
  assert.equal(badToken.status, 401);
});

test('external edits are detected and force a re-read', async () => {
  // Simulate the user editing in their editor while the model is working.
  await fsp.writeFile(
    path.join(projectDir, 'src/math.js'),
    'export function plus(a, b) {\n  return a + b;\n}\n\n// edited by the user\n',
    'utf8'
  );

  const workspace = backend.registry.listForUser(backend.users.findByEmail('dev@example.com').id)[0];
  await waitFor(
    () => workspace.changeLog.some((c) => c.path === 'src/math.js' && c.actor === 'external'),
    { label: 'the watcher to notice the external edit', timeoutMs: 10_000 }
  );

  const changes = await mcpClient.callTool({ name: 'get_recent_changes', arguments: {} });
  assert.match(changes.content[0].text, /src\/math\.js/);
  assert.match(changes.content[0].text, /NOT made by you/);
});
