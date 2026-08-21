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

/**
 * A tool result carries two representations of the same answer: rendered text
 * in `content`, and machine-readable `structuredContent`. The MCP spec permits
 * a client to use either, so **both must be self-sufficient**.
 *
 * This suite exists because they were not. `read_files` put the source in the
 * text block and shipped `{ path, revision, lineCount, dirty }` as structured
 * output — file metadata with no file. A client that preferred structured
 * content therefore saw every read "succeed" while returning nothing usable,
 * and correctly refused to edit anything, reporting:
 *
 *   "its file-reading endpoint is currently returning file metadata without
 *    the actual source contents"
 *
 * Nothing failed on the server, and testing through `content[0].text` — as the
 * rest of the suite does — could never see it. So these tests deliberately
 * ignore the text block entirely and assert only on `structuredContent`.
 */

const PORT = 8960 + (process.pid % 30);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const REDIRECT_URI = 'http://127.0.0.1:9916/callback';
const PASSWORD = 'structured-test-password';

let dataDir;
let projectDir;
let server;
let backend;
let agent;
let socket;
let mcpClient;

const SOURCE = [
  "import React from 'react';",
  '',
  'export const ListRenderer = ({ items }) => (',
  '  <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>',
  ');',
  ''
].join('\n');

test.before(async () => {
  dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-struct-data-'));
  projectDir = fs.realpathSync.native(await fsp.mkdtemp(path.join(os.tmpdir(), 'cw-struct-proj-')));
  await fsp.writeFile(path.join(projectDir, 'ListRenderer.tsx'), SOURCE, 'utf8');
  await fsp.writeFile(
    path.join(projectDir, 'package.json'),
    JSON.stringify({ name: 'struct', scripts: { build: 'node -e "console.log(\'BUILD_MARKER\')"' } }, null, 2)
  );

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

  const account = await createAccount(BASE_URL, { email: 'struct@example.com', password: PASSWORD, name: 'S' });

  const WebSocket = require('ws');
  socket = new WebSocket(`${BASE_URL.replace('http', 'ws')}/bridge`, {
    headers: { Authorization: `Bearer ${account.token}` }
  });
  agent = new WorkspaceAgent({ send: (f) => socket.readyState === 1 && socket.send(JSON.stringify(f)) });

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
        socket.send(JSON.stringify({ t: 'res', id: frame.id, ok: false, error: { code: err.code, message: err.message } }));
      }
    } else if (frame.t === 'event' && frame.event === 'workspace-registered') {
      await agent.onWorkspaceRegistered(frame);
    }
  });

  await agent.openWorkspace(projectDir, { kind: 'folder' });
  await waitFor(() => agent.byWorkspaceId.size > 0, { label: 'registration', timeoutMs: 20_000 });

  const client = await registerClient(BASE_URL, { name: 'Structured Test', redirectUri: REDIRECT_URI });
  const { verifier, challenge } = createPkce();
  const { code } = await authorizeInteractively(BASE_URL, {
    clientId: client.client_id,
    redirectUri: REDIRECT_URI,
    challenge,
    scope: 'workspace:read workspace:write',
    email: 'struct@example.com',
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

  mcpClient = new Client({ name: 'structured-test', version: '1.0.0' });
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

test('read_files puts the source in structuredContent, not only in the text', async () => {
  const result = await mcpClient.callTool({ name: 'read_files', arguments: { paths: ['ListRenderer.tsx'] } });

  const structured = result.structuredContent;
  assert.ok(structured, 'read_files must return structuredContent');

  const file = structured.files?.[0];
  assert.ok(file, 'structuredContent.files must be present');

  // The whole point: a client reading ONLY this must get the source.
  assert.equal(typeof file.content, 'string', 'structuredContent must carry the file content');
  assert.match(file.content, /ListRenderer/, 'the content must be the real source');
  assert.equal(file.content, SOURCE, 'the content must match the file exactly');

  // And the metadata a write needs.
  assert.ok(file.revision, 'structuredContent must carry the revision');
  assert.equal(file.truncated, false);
});

test('a client using only structuredContent can complete a read-then-write cycle', async () => {
  // Simulates a client that never looks at the rendered text.
  const read = await mcpClient.callTool({ name: 'read_files', arguments: { paths: ['ListRenderer.tsx'] } });
  const { content, revision } = read.structuredContent.files[0];

  const updated = content.replace('{i}</li>', '{i.toUpperCase()}</li>');
  assert.notEqual(updated, content, 'the edit must be derivable from structured content alone');

  const write = await mcpClient.callTool({
    name: 'write_files',
    arguments: { summary: 'Uppercase items', changes: [{ path: 'ListRenderer.tsx', content: updated, baseRevision: revision }] }
  });
  assert.notEqual(write.isError, true, `write failed: ${write.content[0].text}`);

  const onDisk = await fsp.readFile(path.join(projectDir, 'ListRenderer.tsx'), 'utf8');
  assert.match(onDisk, /toUpperCase/, 'the change must reach the real file');
});

test('run_command puts stdout in structuredContent, not only in the text', async () => {
  const result = await mcpClient.callTool({
    name: 'run_command',
    arguments: { argv: ['node', '-e', "console.log('BUILD_MARKER')"] }
  });

  const structured = result.structuredContent;
  assert.ok(structured, 'run_command must return structuredContent');
  assert.equal(structured.exitCode, 0);
  assert.equal(typeof structured.stdout, 'string', 'structuredContent must carry stdout');
  assert.match(structured.stdout, /BUILD_MARKER/, 'the actual output must be present');
  assert.equal(typeof structured.stderr, 'string');
});

test('edit_file needs neither a prior read nor a revision', async () => {
  // The anchored path: no read, no baseRevision, no full content.
  const result = await mcpClient.callTool({
    name: 'edit_file',
    arguments: {
      path: 'ListRenderer.tsx',
      summary: 'Add a wrapper div',
      edits: [{ find: '  <ul>', replace: '  <ul className="list">' }]
    }
  });

  assert.notEqual(result.isError, true, `edit_file failed: ${result.content[0].text}`);
  assert.ok(result.structuredContent?.revision, 'edit_file must report the new revision');

  const onDisk = await fsp.readFile(path.join(projectDir, 'ListRenderer.tsx'), 'utf8');
  assert.match(onDisk, /className="list"/);
});

test('a stale anchor fails loudly instead of overwriting', async () => {
  const result = await mcpClient.callTool({
    name: 'edit_file',
    arguments: { path: 'ListRenderer.tsx', edits: [{ find: 'this text is definitely not present', replace: 'x' }] }
  });

  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /not found/i);

  const onDisk = await fsp.readFile(path.join(projectDir, 'ListRenderer.tsx'), 'utf8');
  assert.match(onDisk, /className="list"/, 'a failed edit must leave the file untouched');
});
