import http from 'node:http';
import config from './config.js';
import { createLogger } from './logger.js';
import { createApp } from './app.js';

const log = createLogger('server');

const { app, hub, close } = createApp();

const server = http.createServer(app);

// The WebSocket bridge shares the HTTP server so the desktop app needs only one
// port, and so a tunnel that forwards one port forwards everything.
hub.attach(server);

server.listen(config.port, config.host, () => {
  const banner = [
    '',
    '  CodeWriter backend',
    `  ------------------------------------------------------------`,
    `  Listening   http://${config.host}:${config.port}`,
    `  Public URL  ${config.baseUrl}`,
    '',
    `  MCP endpoint (paste this into your MCP client):`,
    `      ${config.mcpUrl}`,
    '',
    `  OAuth issuer            ${config.baseUrl}`,
    `  Authorization metadata  ${config.baseUrl}/.well-known/oauth-authorization-server`,
    `  Resource metadata       ${config.baseUrl}/.well-known/oauth-protected-resource/mcp`,
    `  Desktop bridge          ws://${config.host}:${config.port}/bridge`,
    `  Data directory          ${config.dataDir}`,
    ''
  ];

  if (config.isLoopback) {
    banner.push(
      '  Note: this URL is loopback-only. A cloud-hosted MCP client (claude.ai,',
      '  chatgpt.com) cannot reach it. For those, expose the port with a tunnel',
      '  and set PUBLIC_URL to the tunnel URL:',
      '',
      `      cloudflared tunnel --url http://127.0.0.1:${config.port}`,
      ''
    );
  }

  for (const line of banner) console.log(line);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    log.error(
      `Port ${config.port} is already in use. Change PORT in src/config.js, or stop whatever is using it.`
    );
    process.exit(1);
  }
  log.error('HTTP server error', err);
  process.exit(1);
});

/**
 * Graceful shutdown.
 *
 * The JSON stores debounce their writes, so exiting without flushing can lose
 * the last few seconds of state — a just-registered OAuth client, a fresh
 * token. `close()` flushes them, which is the whole reason this is not just
 * `process.exit()`.
 */
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`Received ${signal}, shutting down`);

  const force = setTimeout(() => {
    log.warn('Shutdown timed out; exiting anyway');
    process.exit(1);
  }, 10_000);
  force.unref();

  server.close();
  try {
    await close();
    log.info('Shutdown complete');
    process.exit(0);
  } catch (err) {
    log.error('Error during shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

process.on('unhandledRejection', (reason) => {
  log.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (err) => {
  log.error('Uncaught exception', err);
  void shutdown('uncaughtException');
});
