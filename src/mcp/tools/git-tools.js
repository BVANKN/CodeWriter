import * as z from 'zod';
import config from '../../config.js';
import { ok, toolHandler, renderCommandOutput } from '../format.js';
import { resolveTarget, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, READ_SCOPE } from '../guards.js';
import { normalizeRelPath } from '../../util/paths.js';
import { AGENT_METHOD } from '../../bridge/protocol.js';

/**
 * Read-only git tools.
 *
 * There is deliberately no commit, push, branch, or reset here. Those are
 * decisions about a shared, published history, and they belong to the person
 * whose name goes on the commit. Reading the working tree, on the other hand,
 * is exactly the context a model needs: it shows what has already changed in
 * this session versus what was there before.
 */
export function registerGitTools(server, ctx) {
  server.registerTool(
    'git_status',
    {
      title: 'Git status',
      description:
        'Shows the git working-tree status: current branch, staged and unstaged changes, untracked files.\n\n' +
        'Useful for telling apart "the user was already mid-change here" from "I changed this". ' +
        'Read-only: this server cannot commit, push, or otherwise alter git history.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('git_status', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace, agent } = await resolveTarget(ctx, extra, args.workspaceId, { toolName: 'git_status' });

      if (!workspace.git.isRepo) {
        return ok(`"${workspace.name}" is not a git repository, so there is no status to report.`);
      }

      const response = await agent.request(
        AGENT_METHOD.GIT_STATUS,
        { workspaceId: workspace.id },
        { timeoutMs: config.bridgeRpcTimeoutMs }
      );

      const entries = response.entries || [];
      if (!entries.length) {
        return ok(`Working tree clean on branch ${response.branch || 'unknown'}.`, response);
      }

      const grouped = { staged: [], unstaged: [], untracked: [] };
      for (const entry of entries) {
        (grouped[entry.group] || grouped.unstaged).push(entry);
      }

      const parts = [`Branch: ${response.branch || 'unknown'}`];
      if (response.ahead || response.behind) {
        parts.push(`Tracking: ${response.ahead || 0} ahead, ${response.behind || 0} behind`);
      }
      for (const [group, label] of [
        ['staged', 'Staged'],
        ['unstaged', 'Not staged'],
        ['untracked', 'Untracked']
      ]) {
        if (!grouped[group].length) continue;
        parts.push('', `${label} (${grouped[group].length}):`);
        parts.push(...grouped[group].map((e) => `  ${e.status.padEnd(3)} ${e.path}`));
      }

      return ok(parts.join('\n'), response);
    })
  );

  server.registerTool(
    'git_diff',
    {
      title: 'Git diff',
      description:
        'Shows the diff of uncommitted changes in the working tree, optionally for a single file.\n\n' +
        'The best way to check what you actually changed, as opposed to what you meant to change. ' +
        'Worth running before finish_task on any non-trivial edit.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        path: z.string().optional().describe('Limit the diff to this file, relative to the workspace root.'),
        staged: z.boolean().optional().describe('Show staged changes instead of unstaged. Default false.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('git_diff', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace, agent } = await resolveTarget(ctx, extra, args.workspaceId, { toolName: 'git_diff' });

      if (!workspace.git.isRepo) {
        return ok(`"${workspace.name}" is not a git repository, so there is no diff to show.`);
      }

      const path = args.path ? normalizeRelPath(args.path, 'path') : null;

      const response = await agent.request(
        AGENT_METHOD.GIT_DIFF,
        { workspaceId: workspace.id, path, staged: Boolean(args.staged) },
        { timeoutMs: config.bridgeRpcTimeoutMs }
      );

      if (!response.diff?.trim()) {
        return ok(
          path
            ? `No ${args.staged ? 'staged' : 'unstaged'} changes in "${path}".`
            : `No ${args.staged ? 'staged' : 'unstaged'} changes in the working tree.`
        );
      }

      return ok(renderCommandOutput(`Diff (${args.staged ? 'staged' : 'unstaged'})`, response.diff, 40_000), {
        diff: response.diff
      });
    })
  );
}
