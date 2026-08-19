import * as z from 'zod';
import { ok, fail, toolHandler, renderFileList } from '../format.js';
import { callContext, resolveTarget, boundedInt, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, READ_SCOPE } from '../guards.js';
import { buildGlobMatcher, normalizeRelDir } from '../../util/paths.js';
import { formatBytes } from '../../util/text.js';

/**
 * Orientation tools: what is open, what kind of project it is, and what is in
 * it. These are what a model should reach for before touching anything, which
 * is why their descriptions say so explicitly.
 */
export function registerWorkspaceTools(server, ctx) {
  server.registerTool(
    'list_workspaces',
    {
      title: 'List open workspaces',
      description:
        'Lists the projects and files currently open in the user\'s CodeWriter desktop app.\n\n' +
        'Call this first if you do not already know which workspace you are working in, or if a tool ' +
        'reports that a workspaceId is required. Workspaces exist only while the desktop app has them ' +
        'open; ids are not stable across app restarts.',
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler(
      'list_workspaces',
      async (_args, extra) => {
        const { userId, session } = callContext(ctx, extra);
        assertScope(extra.authInfo, READ_SCOPE);
        session.countCall('list_workspaces');

        const workspaces = ctx.registry.listForUser(userId);
        if (!workspaces.length) {
          return ok(
            'No workspaces are open.\n\n' +
              'The user needs to open a folder or a file in the CodeWriter desktop app before you can ' +
              'read or change anything. Tell them that; there is nothing you can do from here until they do.'
          );
        }

        const lines = workspaces.map((w) => {
          const v = w.verification.toJSON();
          const checks = v.enforced
            ? `verification required (${v.commands.filter((c) => c.required).length} command(s))`
            : 'no verification required';
          return [
            `${w.id}`,
            `  name:      ${w.name}`,
            `  path:      ${w.rootPath}`,
            `  kind:      ${w.kind}`,
            `  files:     ${w.fileCount} indexed (${formatBytes(w.indexedBytes)})`,
            `  git:       ${w.git.isRepo ? `branch ${w.git.branch || 'unknown'}` : 'not a git repository'}`,
            `  checks:    ${checks}`
          ].join('\n');
        });

        return ok(
          `${workspaces.length} workspace(s) open:\n\n${lines.join('\n\n')}\n\n` +
            'Next: call get_workspace_overview for the one you will work in.',
          { workspaces: workspaces.map((w) => w.toJSON()) }
        );
      }
    )
  );

  server.registerTool(
    'get_workspace_overview',
    {
      title: 'Get workspace overview',
      description:
        'Describes one workspace: its root path, size, git state, detected project type, and — importantly — ' +
        'the exact build/test commands you will be required to run after making changes.\n\n' +
        'Call this before your first edit in a workspace. It tells you how this project verifies itself, ' +
        'which determines what "done" means for any task here.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('get_workspace_overview', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace } = await resolveTarget(ctx, extra, args.workspaceId, { toolName: 'get_workspace_overview' });

      const v = workspace.verification.toJSON();
      const top = workspace.listDirectory('');
      const langs = workspace.languageBreakdown(10);

      const sections = [
        `WORKSPACE: ${workspace.name}  (${workspace.id})`,
        `Root:      ${workspace.rootPath}`,
        `Kind:      ${workspace.kind}`,
        `Indexed:   ${workspace.fileCount} files, ${formatBytes(workspace.indexedBytes)}` +
          (workspace.indexComplete ? '' : '  [INDEX STILL BUILDING]')
      ];

      if (workspace.skipped.ignored || workspace.skipped.binary || workspace.skipped.tooLarge) {
        sections.push(
          `Excluded:  ${workspace.skipped.ignored} by .gitignore, ` +
            `${workspace.skipped.binary} binary, ${workspace.skipped.tooLarge} over the size limit`
        );
      }

      if (workspace.git.isRepo) {
        sections.push(
          '',
          'GIT',
          `  branch:          ${workspace.git.branch || 'unknown'}`,
          `  uncommitted:     ${workspace.git.dirtyFileCount} file(s)`,
          ...(workspace.git.remote ? [`  remote:          ${workspace.git.remote}`] : [])
        );
      }

      const pkg = workspace.project.packageJson;
      if (pkg || workspace.project.frameworks?.length) {
        sections.push('', 'PROJECT');
        if (pkg?.name) sections.push(`  name:            ${pkg.name}${pkg.version ? ` v${pkg.version}` : ''}`);
        if (workspace.project.packageManager) {
          sections.push(`  package manager: ${workspace.project.packageManager}`);
        }
        if (workspace.project.frameworks?.length) {
          sections.push(`  detected:        ${workspace.project.frameworks.join(', ')}`);
        }
        if (pkg?.scripts) {
          const names = Object.keys(pkg.scripts);
          sections.push(`  scripts:         ${names.join(', ')}`);
        }
      }

      sections.push('', 'TOP LEVEL');
      sections.push(
        ...top.directories.map((d) => `  ${d}/`),
        ...top.files.slice(0, 40).map((f) => `  ${f.path}`)
      );
      if (top.files.length > 40) sections.push(`  ... and ${top.files.length - 40} more files`);

      if (langs.length) {
        sections.push('', 'FILE TYPES');
        sections.push(...langs.map((l) => `  ${l.ext.padEnd(14)} ${l.count}`));
      }

      sections.push('', 'VERIFICATION');
      if (!v.enforced) {
        sections.push(
          workspace.kind === 'file'
            ? '  Not required: this is a single open file, not a project.'
            : '  No build or test commands were detected for this project.',
          '  You should still reason carefully about correctness; there is just nothing to run.'
        );
      } else {
        sections.push(
          '  REQUIRED after every write. finish_task will fail until these pass:',
          ...v.commands
            .filter((c) => c.required)
            .map((c, i) => `    ${i + 1}. ${c.label}      (${c.kind}, from ${c.source})`)
        );
        const optional = v.commands.filter((c) => !c.required);
        if (optional.length) {
          sections.push('  Optional but useful:', ...optional.map((c) => `    - ${c.label}  (${c.kind})`));
        }
        sections.push(
          '',
          v.satisfied
            ? '  Current state: clean - no unverified changes.'
            : `  Current state: ${v.dirtyPaths.length} file(s) changed and NOT yet verified.`
        );
      }

      return ok(sections.join('\n'), workspace.toJSON());
    })
  );

  server.registerTool(
    'list_files',
    {
      title: 'List files',
      description:
        'Lists indexed files in a workspace, with their sizes and current revisions.\n\n' +
        'The index already excludes anything matched by .gitignore, plus node_modules, build output, ' +
        'lockfiles and binaries — so what you see here is the project\'s actual source.\n\n' +
        'Use `path` to scope to a directory and `glob` to filter (for example `src/**/*.ts`, or ' +
        '`!**/*.test.js` to exclude). Results are paginated; a truncated result tells you so.\n\n' +
        'Note: the revision shown here is NOT sufficient to write a file. You must read a file before ' +
        'writing it.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        path: z.string().optional().describe('Limit to this directory, relative to the workspace root.'),
        glob: z
          .array(z.string())
          .optional()
          .describe(
            'Glob patterns. Supports *, **, ?, [abc] and {a,b}. Prefix with ! to exclude. ' +
              'An entry list with only exclusions includes everything else.'
          ),
        limit: z.number().int().optional().describe('Max files to return (1-2000, default 500).'),
        offset: z.number().int().optional().describe('Skip this many results, for paging.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('list_files', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace } = await resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'list_files',
        summary: args.path || args.glob?.join(' ') || 'all files'
      });

      const limit = boundedInt(args.limit, { name: 'limit', min: 1, max: 2000, fallback: 500 });
      const offset = boundedInt(args.offset, { name: 'offset', min: 0, max: 1_000_000, fallback: 0 });
      const dir = normalizeRelDir(args.path, 'path');
      const matches = buildGlobMatcher(args.glob);

      const prefix = dir ? `${dir}/` : '';
      const all = [...workspace.files.values()]
        .filter((entry) => (prefix ? entry.path.startsWith(prefix) : true))
        .filter((entry) => matches(entry.path))
        .sort((a, b) => a.path.localeCompare(b.path));

      const page = all.slice(offset, offset + limit);

      if (!all.length) {
        const hint = dir
          ? `Nothing matched under "${dir}".`
          : 'Nothing matched.';
        return ok(
          `${hint}\n\nThe workspace has ${workspace.fileCount} indexed files. ` +
            'Check the path and glob, or call list_files with no filters to see what is there.'
        );
      }

      const header =
        `${all.length} file(s) matched` +
        (dir ? ` under ${dir}` : '') +
        (args.glob?.length ? ` matching ${args.glob.join(', ')}` : '') +
        (all.length > page.length ? `; showing ${offset + 1}-${offset + page.length}` : '');

      const footer =
        offset + page.length < all.length
          ? `\n\nMore results: call again with offset=${offset + page.length}.`
          : '';

      return ok(`${header}\n\n${renderFileList(page)}${footer}`, {
        total: all.length,
        offset,
        returned: page.length,
        files: page.map((f) => ({ path: f.path, size: f.size, revision: f.revision, binary: f.binary, dirty: f.dirty }))
      });
    })
  );

  server.registerTool(
    'diagnose_connection',
    {
      title: 'Diagnose the connection',
      description:
        'Checks every hop between you and the user\'s machine, and reports which one is broken.\n\n' +
        'Run this the moment a write or a command fails in a way you did not expect — especially if it ' +
        'timed out. Read-only tools are answered from the backend\'s index and keep working even when ' +
        'the link to the desktop app is dead, so "reading works" is NOT evidence that writing will.\n\n' +
        'This performs a real round trip to the user\'s machine, so it distinguishes a genuinely live ' +
        'connection from one that only looks live.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION)
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('diagnose_connection', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { userId, session, clientName } = callContext(ctx, extra);
      session.countCall('diagnose_connection');

      const lines = ['CONNECTION DIAGNOSTIC', ''];
      const findings = {};

      lines.push(`MCP client:        ${clientName} (session ${session.key.slice(0, 12)})`);
      lines.push(`Backend uptime:    ${Math.floor(process.uptime())}s`);
      findings.backendUptimeSec = Math.floor(process.uptime());

      // Hop 1: is a desktop app connected for this user at all?
      const agents = ctx.hub.agentsForUser(userId);
      findings.desktopAppsConnected = agents.length;
      lines.push(`Desktop apps:      ${agents.length} connected`);

      if (!agents.length) {
        lines.push(
          '',
          'PROBLEM: no CodeWriter desktop app is connected for this account.',
          '',
          'Nothing can be read from or written to the user\'s disk until it reconnects.',
          'Ask the user to open CodeWriter and check the Connection panel. If the backend was',
          'restarted (free hosting sleeps when idle), the app reconnects on its own within a',
          'few seconds.'
        );
        return fail(lines.join('\n'), findings);
      }

      // Hop 2: workspaces.
      const workspaces = ctx.registry.listForUser(userId);
      findings.workspaces = workspaces.length;
      lines.push(`Open workspaces:   ${workspaces.length}`);

      if (!workspaces.length) {
        lines.push('', 'PROBLEM: no workspace is open. Ask the user to open a folder in CodeWriter.');
        return fail(lines.join('\n'), findings);
      }

      // Hop 3: a real round trip for the target workspace.
      let workspace;
      try {
        workspace = ctx.registry.resolve(userId, args.workspaceId);
      } catch (err) {
        lines.push('', `PROBLEM resolving the workspace: ${err.message}`);
        return fail(lines.join('\n'), findings);
      }

      lines.push(`Target workspace:  ${workspace.name} (${workspace.id})`);
      lines.push(`Indexed files:     ${workspace.fileCount}`);

      const agent = ctx.hub.agents.get(workspace.agentId);
      if (!agent) {
        lines.push(
          '',
          'PROBLEM: the workspace is registered but the desktop app that served it has gone.',
          'Reads may still appear to work because they come from the backend index, but every',
          'write and command will fail. Ask the user to reopen the folder in CodeWriter.'
        );
        return fail(lines.join('\n'), findings);
      }

      const started = Date.now();
      try {
        await agent.ensureAlive();
        const rtt = Date.now() - started;
        findings.roundTripMs = rtt;
        findings.healthy = true;
        lines.push(`Round trip:        ${rtt}ms  OK`);
        lines.push(
          '',
          'All hops healthy. Writes and commands should work.',
          '',
          'If a write still fails, the cause is at the far end rather than in the connection:',
          '  - CodeWriter may be set to "ask me before each change", and the prompt is waiting',
          '    in the app unanswered. The error text will say so.',
          '  - The program you tried to run may not be on the allowed list.',
          'Both report a specific reason; read it rather than retrying the same call.'
        );
        return ok(lines.join('\n'), findings);
      } catch (err) {
        findings.healthy = false;
        findings.error = err.code;
        lines.push(
          `Round trip:        FAILED after ${Date.now() - started}ms`,
          '',
          `PROBLEM: ${err.message}`,
          '',
          'The connection looked open but the desktop app did not answer. It has been dropped so',
          'the app reconnects. Wait a few seconds and retry.'
        );
        return fail(lines.join('\n'), findings);
      }
    })
  );

  server.registerTool(
    'get_recent_changes',
    {
      title: 'Get recent changes',
      description:
        'Lists changes to the workspace since you last checked: your own writes, the user\'s edits in ' +
        'their editor, and anything else that touched the files (a git checkout, a formatter, a build).\n\n' +
        'Call this when returning to a task after any gap, and before a second round of edits. ' +
        'It is the cheap way to discover that the ground moved without re-reading the whole tree.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        sinceSeq: z
          .number()
          .int()
          .optional()
          .describe('Return changes after this sequence number. Omit to continue from your last call.'),
        limit: z.number().int().optional().describe('Max entries to return (1-200, default 50).')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('get_recent_changes', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace, session } = await resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'get_recent_changes'
      });

      const limit = boundedInt(args.limit, { name: 'limit', min: 1, max: 200, fallback: 50 });
      const since = args.sinceSeq ?? session.getChangeCursor(workspace.id);
      const changes = workspace.changesSince(since).slice(-limit);
      session.setChangeCursor(workspace.id, workspace.changeSeq);

      if (!changes.length) {
        return ok(
          `No changes since sequence ${since}. The workspace is at sequence ${workspace.changeSeq}.`,
          { changes: [], latestSeq: workspace.changeSeq }
        );
      }

      const lines = changes.map((c) => {
        const who = c.actor === 'mcp' ? `MCP client${c.actorName ? ` (${c.actorName})` : ''}` : c.actor === 'user' ? 'the user' : 'an external process';
        const when = new Date(c.at).toISOString().slice(11, 19);
        const move = c.fromPath ? ` (from ${c.fromPath})` : '';
        return `  [${c.seq}] ${when}  ${c.type.padEnd(8)} ${c.path}${move}  by ${who}` +
          (c.revision ? `  -> ${c.revision}` : '');
      });

      const externalEdits = changes.filter((c) => c.actor !== 'mcp');
      const warning = externalEdits.length
        ? `\n\n${externalEdits.length} of these were NOT made by you. Any file among them that you plan to ` +
          'edit must be re-read before you write to it; your copy is out of date.'
        : '';

      return ok(
        `${changes.length} change(s) since sequence ${since}:\n\n${lines.join('\n')}${warning}`,
        { changes, latestSeq: workspace.changeSeq }
      );
    })
  );
}
