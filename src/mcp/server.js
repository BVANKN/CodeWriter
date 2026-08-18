import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import config from '../config.js';
import { buildServerInstructions } from './instructions.js';
import { registerWorkspaceTools } from './tools/workspace-tools.js';
import { registerReadTools } from './tools/read-tools.js';
import { registerWriteTools } from './tools/write-tools.js';
import { registerCommandTools } from './tools/command-tools.js';
import { registerGitTools } from './tools/git-tools.js';
import { registerPrompts } from './prompts.js';
import { registerResources } from './resources.js';

/**
 * Builds an MCP server instance.
 *
 * One instance is created per transport session rather than shared, which is
 * what the SDK expects: a `Server` owns its transport and its notification
 * state. The expensive things — the workspace index, the content cache, the
 * bridge to the desktop app — live in `ctx` and are shared across all sessions.
 *
 * @param {object} ctx
 * @param {import('../workspace/registry.js').WorkspaceRegistry} ctx.registry
 * @param {import('../bridge/hub.js').AgentHub} ctx.hub
 * @param {import('../workspace/content-cache.js').ContentCache} ctx.contentCache
 * @param {import('./session.js').SessionRegistry} ctx.sessions
 * @param {Map<string, object>} ctx.activeRuns
 */
export function createMcpServer(ctx) {
  const server = new McpServer(
    {
      name: 'codewriter',
      version: '1.0.0',
      title: 'CodeWriter'
    },
    {
      instructions: buildServerInstructions({ mcpUrl: config.mcpUrl }),
      capabilities: {
        tools: { listChanged: true },
        prompts: {},
        resources: { listChanged: true },
        logging: {}
      }
    }
  );

  registerWorkspaceTools(server, ctx);
  registerReadTools(server, ctx);
  registerWriteTools(server, ctx);
  registerCommandTools(server, ctx);
  registerGitTools(server, ctx);
  registerPrompts(server, ctx);
  registerResources(server, ctx);

  return server;
}
