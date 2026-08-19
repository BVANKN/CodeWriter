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

import { createPkce, registerClient, createAccount, authorizeInteractively, exchangeCode, waitFor } from './helpers.mjs';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const { WorkspaceAgent } = require(path.resolve(here, '../../frontend/electron/agent/workspace-agent.cjs'));
const { CommandPolicy } = require(path.resolve(here, '../../frontend/electron/fs/runner.cjs'));

/**
 * Regression tests for the class of bug that produced:
 *
 *   "Workspace connection works. File writes time out. Commands also time out.
 *    No files were created."
 *
 * The cause was never the protocol. It was that a *human-facing prompt* sat on
 * the path of an MCP tool call and could block longer than the client's 60s
 * budget — 4 minutes for the review-mode approval, unbounded for the command
 * confirmation dialog. The client gave up first, so the real reason never
 * reached the model and every failure looked identical: "timed out".
 *
 * The invariant these tests defend is simple and absolute:
 *
 *   **No MCP tool call may take longer than the client will wait, for any
 *   reason, including a human not answering.** A slow human must produce a
 *   fast, explanatory failure.
 */

const PORT = 8940 + (process.pid % 50);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://127.0.0.1:9912/callback';
const PASSWORD = 'blocking-test-password';

/** The client's real budget. Nothing may exceed it. */
const CLIENT_BUDGET_MS = 60_000;

let dataDir;
let projectDir;
let server;
let backend;
let agent;
let socket;
let mcpClient;

/** Simulates a user who never answers the prompt. */
const neverAnswers = () => new Promise(() => {});

test.before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-block-data-'));
  projectDir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-block-proj-')));
  await fsp.writeFile(path.join(projectDir, 'existing.js'), 'export const a = 1;\n', 'utf8');

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

  const account = await createAccount(BASE_URL, {
    email: 'block@example.com',
    password: PASSWORD,
    name: 'Block'
  });

  const WebSocket = require('ws');
  socket = new WebSocket(`${BASE_URL.replace('http', 'ws')}/bridge`, {
    headers: { Authorization: `Bearer ${account.token}` }
  });

  // The agent is wired the way the desktop app wires it in the WORST case:
  // review mode with nobody at the keyboard, and a command policy that forces a
  // confirmation prompt nobody answers.
  agent = new WorkspaceAgent({
    send: (frame) => socket.readyState === 1 && socket.send(JSON.stringify(frame)),
    commandPolicy: new CommandPolicy({ mode: 'prompt', allowedPrograms: [] }),
    approve: neverAnswers,
    confirmCommand: neverAnswers
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
          JSON.stringify({ t: 'res', id: frame.id, ok: false, error: { code: err.code, message: err.message } })
        );
      }
    } else if (frame.t === 'event' && frame.event === 'workspace-registered') {
      await agent.onWorkspaceRegistered(frame);
    }
  });

  await agent.openWorkspace(projectDir, { kind: 'folder' });
  await waitFor(() => agent.byWorkspaceId.size > 0, { label: 'workspace registration', timeoutMs: 20_000 });

  const client = await registerClient(BASE_URL, { name: 'Blocking Test', redirectUri: REDIRECT_URI });
  const { verifier, challenge } = createPkce();
  const { code } = await authorizeInteractively(BASE_URL, {
    clientId: client.client_id,
    redirectUri: REDIRECT_URI,
    challenge,
    scope: 'workspace:read workspace:write',
    email: 'block@example.com',
    password: PASSWORD,
    resource: `${BASE_URL}/mcp`
  });
  const tokens = await exchangeCode(BASE_URL, {
    clientId: client.client_id,
    code,
    verifier,
    redirectUri: REDIRECT_URI,
    resource: `${BASE_URL}/mcp`
  });

  mcpClient = new Client({ name: 'blocking-test', version: '1.0.0' });
  await mcpClient.connect(
    new StreamableHTTPClientTransport(new URL(`${BASE_URL}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } }
    })
  );
});

test.after(async () => {
  await mcpClient?.close().catch(() => {});
  socket?.close();
  await agent?.shutdown();
  await backend?.close();
  await new Promise((resolve) => server?.close(resolve));
  await fsp.rm(dataDir, { recursive: true, force: true });
  await fsp.rm(projectDir, { recursive: true, force: true });
});

/** Runs a tool and asserts it answers inside the client's budget. */
async function withinBudget(name, args) {
  const started = Date.now();
  const result = await mcpClient.callTool({ name, arguments: args }, undefined, { timeout: CLIENT_BUDGET_MS });
  const elapsed = Date.now() - started;
  assert.ok(
    elapsed < CLIENT_BUDGET_MS,
    `${name} took ${elapsed}ms, at or beyond the client's ${CLIENT_BUDGET_MS}ms budget`
  );
  return { result, elapsed };
}

test('a write blocked on an unanswered approval fails fast and explains why', async () => {
  const read = await withinBudget('read_files', { paths: ['existing.js'] });
  const revision = read.result.structuredContent.files[0].revision;

  const { result, elapsed } = await withinBudget('write_files', {
    summary: 'Should not hang',
    changes: [{ path: 'existing.js', content: 'export const a = 2;\n', baseRevision: revision }]
  });

  assert.equal(result.isError, true, 'an unapproved write must report an error, not silently succeed');

  const text = result.content[0].text;
  // The message must name the actual cause. "The user declined" would be a lie
  // and would send the model down the wrong recovery path.
  assert.match(
    text,
    /did not respond|no response|not open|approval/i,
    `error should explain the approval problem, got: ${text.slice(0, 300)}`
  );

  console.log(`      write answered in ${(elapsed / 1000).toFixed(1)}s`);
});

test('a command blocked on an unanswered confirmation fails fast and explains why', async () => {
  const { result, elapsed } = await withinBudget('run_command', {
    argv: ['some-unlisted-program', '--version']
  });

  assert.equal(result.isError, true);
  const text = result.content[0].text;
  assert.match(
    text,
    /did not respond|no response|not allowed|confirm/i,
    `error should explain the confirmation problem, got: ${text.slice(0, 300)}`
  );

  console.log(`      command answered in ${(elapsed / 1000).toFixed(1)}s`);
});

test('nothing was written while approval was pending', async () => {
  const onDisk = await fsp.readFile(path.join(projectDir, 'existing.js'), 'utf8');
  assert.equal(onDisk, 'export const a = 1;\n', 'an unapproved change must not reach the disk');
});

test('reads still work normally while approvals are blocked', async () => {
  // Confirms the failure is isolated to the approval path and has not been
  // "fixed" by breaking everything equally.
  const { result } = await withinBudget('list_files', {});
  assert.notEqual(result.isError, true);
  assert.match(result.content[0].text, /existing\.js/);
});
