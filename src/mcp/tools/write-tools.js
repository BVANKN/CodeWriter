import * as z from 'zod';
import config from '../../config.js';
import { ok, fail, toolHandler, renderWriteSummary } from '../format.js';
import { resolveTarget, fetchFiles, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, WRITE_SCOPE, validateWriteBatch, validateDelete } from '../guards.js';
import { REMINDERS } from '../instructions.js';
import { normalizeRelPath } from '../../util/paths.js';
import { diffSummary } from '../../util/text.js';
import { AGENT_METHOD, SERVER_EVENT, AGENT_ERROR } from '../../bridge/protocol.js';
import { AppError } from '../../util/errors.js';
import { createLogger } from '../../logger.js';

const log = createLogger('mcp-write');

export function registerWriteTools(server, ctx) {
  server.registerTool(
    'write_files',
    {
      title: 'Write files',
      description:
        'Writes complete file contents to the workspace. Changes appear in the user\'s editor immediately.\n\n' +
        'CONTRACT — every one of these is enforced, not merely requested:\n' +
        '  * `content` is the ENTIRE new file. It replaces what is there. There is no patch mode and no ' +
        'way to say "the rest is unchanged". If you write a partial file, the rest of it is gone.\n' +
        '  * `baseRevision` must be the revision you got from read_files, and must still be current.\n' +
        '  * You must have read the file at that revision in this session. Knowing a revision is not the ' +
        'same as knowing the content.\n' +
        '  * The batch is all-or-nothing. If any entry is rejected, nothing is written.\n\n' +
        'Send every file of a related change in ONE call, so the user never sees a half-applied refactor.\n\n' +
        'After a successful write to a project folder, the workspace is marked unverified and you MUST ' +
        'run the project\'s checks with run_command before calling finish_task.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        changes: z
          .array(
            z.object({
              path: z
                .string()
                .describe('Relative path from the workspace root, e.g. "src/components/Button.jsx".'),
              content: z
                .string()
                .describe(
                  'The COMPLETE new content of the file. Not a diff, not an excerpt, no elisions.'
                ),
              baseRevision: z
                .string()
                .optional()
                .describe('Revision from read_files. Required for updates; omit when creating a new file.'),
              action: z
                .enum(['create', 'update'])
                .optional()
                .describe('Declare intent explicitly. Inferred from whether the file exists when omitted.')
            })
          )
          .min(1)
          .max(100)
          .describe('One entry per file. Each entry carries that file\'s entire new content.'),
        summary: z
          .string()
          .optional()
          .describe(
            'One line describing what this change does and why. Shown to the user in their editor, ' +
              'so write it for them, not for yourself.'
          )
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    toolHandler('write_files', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { workspace, agent, session, clientName } = resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'write_files',
        summary: args.summary || `${args.changes.length} file(s)`
      });

      // Everything is validated before anything is sent to the agent.
      const validated = validateWriteBatch({ session, workspace, changes: args.changes });

      // Capture the "before" content so we can report a useful diff summary.
      const updates = validated.filter((v) => v.action === 'update');
      const before = new Map();
      if (updates.length) {
        const previous = await fetchFiles(ctx, {
          workspace,
          agent,
          paths: updates.map((u) => u.path)
        });
        for (const file of previous) {
          if (typeof file.content === 'string') before.set(file.path, file.content);
        }
      }

      // Re-check revisions after that fetch. The read above is a real round
      // trip to the user's machine, and a file can change during it; without
      // this the window between validation and write is a genuine race.
      for (const item of updates) {
        const current = workspace.getFile(item.path);
        if (current && item.existing && current.revision !== item.existing.revision) {
          throw new AppError(
            'STALE_REVISION',
            REMINDERS.staleWrite(item.path, item.existing.revision, current.revision),
            { status: 409, details: { path: item.path } }
          );
        }
      }

      const response = await agent.request(
        AGENT_METHOD.WRITE_FILES,
        {
          workspaceId: workspace.id,
          changes: validated.map((v) => ({
            path: v.path,
            content: v.content,
            action: v.action,
            baseRevision: v.existing?.revision ?? null
          })),
          meta: {
            actor: 'mcp',
            actorName: clientName,
            summary: args.summary || null,
            at: Date.now()
          }
        },
        { timeoutMs: config.bridgeWriteTimeoutMs }
      );

      const results = response.results || [];
      const applied = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);

      // Update the index from what the agent actually did.
      for (const result of applied) {
        const item = validated.find((v) => v.path === result.path);
        const previousContent = before.get(result.path);
        const diff =
          previousContent !== undefined && item ? diffSummary(previousContent, item.content) : null;

        workspace.applyChange({
          type: result.action === 'create' ? 'created' : 'updated',
          path: result.path,
          entry: {
            path: result.path,
            size: result.size,
            revision: result.revision,
            mtime: result.mtime ?? Date.now(),
            binary: false,
            dirty: false
          },
          revision: result.revision,
          actor: 'mcp',
          actorName: clientName,
          summary: args.summary || null
        });

        ctx.contentCache.set(workspace.id, result.path, result.revision, item.content);
        session.noteWrite(workspace.id, result.path, result.revision);
        result.diff = diff;
      }

      if (rejected.length && !applied.length) {
        return fail(
          `The desktop app refused all ${rejected.length} write(s):\n\n` +
            rejected.map((r) => `  ${r.path}: ${r.message || r.error}`).join('\n') +
            explainAgentRejections(rejected),
          { results }
        );
      }

      // Any write invalidates prior verification for this workspace.
      if (applied.length) {
        workspace.verification.markDirty(applied.map((r) => r.path));
      }

      const verification = workspace.verification.toJSON();

      ctx.hub.notifyUser(workspace.userId, SERVER_EVENT.CHANGES_APPLIED, {
        workspaceId: workspace.id,
        clientName,
        summary: args.summary || null,
        paths: applied.map((r) => r.path),
        verification
      });

      log.info(
        `${clientName} wrote ${applied.length} file(s) to ${workspace.name}` +
          (rejected.length ? ` (${rejected.length} rejected)` : '')
      );

      const parts = [
        `Applied ${applied.length} change(s) to ${workspace.name}:`,
        '',
        renderWriteSummary(applied)
      ];

      if (rejected.length) {
        parts.push(
          '',
          `${rejected.length} change(s) were rejected by the desktop app:`,
          ...rejected.map((r) => `  ${r.path}: ${r.message || r.error}`),
          explainAgentRejections(rejected)
        );
      }

      parts.push('', '='.repeat(72), REMINDERS.afterWrite(verification));

      return ok(parts.join('\n'), {
        applied: applied.map((r) => ({ path: r.path, revision: r.revision, action: r.action, diff: r.diff })),
        rejected,
        verification
      });
    })
  );

  server.registerTool(
    'delete_files',
    {
      title: 'Delete files',
      description:
        'Deletes files from the workspace. The user\'s editor closes any affected tab and keeps an undo ' +
        'snapshot, but this still removes real files from their disk.\n\n' +
        'Each path needs its current `baseRevision` and must have been read in this session — you should ' +
        'know what you are deleting. Prefer leaving a file in place over deleting one you are unsure about; ' +
        'an unused file costs nothing, a wrongly deleted one costs the user their work.\n\n' +
        'Directories are not deleted directly; delete the files and the directory goes with them.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        files: z
          .array(
            z.object({
              path: z.string().describe('Relative path from the workspace root.'),
              baseRevision: z.string().describe('Current revision, from read_files.')
            })
          )
          .min(1)
          .max(50),
        reason: z.string().describe('Why these files should be removed. Shown to the user.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    toolHandler('delete_files', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { workspace, agent, session, clientName } = resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'delete_files',
        summary: args.reason
      });

      const validated = args.files.map((file) =>
        validateDelete({
          session,
          workspace,
          path: file.path,
          baseRevision: file.baseRevision
        })
      );

      const response = await agent.request(
        AGENT_METHOD.DELETE_FILES,
        {
          workspaceId: workspace.id,
          paths: validated.map((v) => v.path),
          meta: { actor: 'mcp', actorName: clientName, reason: args.reason, at: Date.now() }
        },
        { timeoutMs: config.bridgeWriteTimeoutMs }
      );

      const results = response.results || [];
      const deleted = results.filter((r) => r.ok);

      for (const result of deleted) {
        workspace.applyChange({ type: 'deleted', path: result.path, actor: 'mcp', actorName: clientName });
        ctx.contentCache.dropFile(workspace.id, result.path);
        session.noteDelete(workspace.id, result.path);
      }

      if (deleted.length) workspace.verification.markDirty(deleted.map((r) => r.path));
      const verification = workspace.verification.toJSON();

      ctx.hub.notifyUser(workspace.userId, SERVER_EVENT.CHANGES_APPLIED, {
        workspaceId: workspace.id,
        clientName,
        summary: args.reason,
        deletedPaths: deleted.map((r) => r.path),
        verification
      });

      const failed = results.filter((r) => !r.ok);
      const parts = [`Deleted ${deleted.length} file(s):`, ...deleted.map((r) => `  ${r.path}`)];
      if (failed.length) {
        parts.push('', `${failed.length} could not be deleted:`, ...failed.map((r) => `  ${r.path}: ${r.message || r.error}`));
      }
      if (deleted.length) parts.push('', REMINDERS.afterWrite(verification));

      return ok(parts.join('\n'), { results, verification });
    })
  );

  server.registerTool(
    'move_file',
    {
      title: 'Move or rename a file',
      description:
        'Moves or renames a file within the workspace, preserving its content.\n\n' +
        'Moving a file does not update anything that imports it. Before you move, use search_files to ' +
        'find every reference to the old path, and include those updates in the same piece of work — ' +
        'otherwise you will leave the project unable to build, which the required checks will then catch.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        from: z.string().describe('Current relative path.'),
        to: z.string().describe('New relative path. Parent directories are created as needed.'),
        baseRevision: z.string().describe('Current revision of the source file, from read_files.')
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false }
    },
    toolHandler('move_file', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { workspace, agent, session, clientName } = resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'move_file',
        summary: `${args.from} -> ${args.to}`
      });

      const from = normalizeRelPath(args.from, 'from');
      const to = normalizeRelPath(args.to, 'to');

      if (from === to) return fail('"from" and "to" are the same path; nothing to do.');

      const source = workspace.getFile(from);
      if (!source) {
        return fail(`"${from}" does not exist in this workspace. Check the path with list_files.`);
      }
      if (source.revision !== args.baseRevision) {
        return fail(REMINDERS.staleWrite(from, args.baseRevision, source.revision));
      }
      if (workspace.getFile(to)) {
        return fail(
          `"${to}" already exists. Choose a different destination, or delete the existing file first ` +
            'if replacing it is genuinely what you intend.'
        );
      }

      const response = await agent.request(
        AGENT_METHOD.MOVE_FILE,
        {
          workspaceId: workspace.id,
          from,
          to,
          meta: { actor: 'mcp', actorName: clientName, at: Date.now() }
        },
        { timeoutMs: config.bridgeWriteTimeoutMs }
      );

      workspace.applyChange({
        type: 'moved',
        path: to,
        fromPath: from,
        revision: response.revision,
        actor: 'mcp',
        actorName: clientName
      });
      ctx.contentCache.dropFile(workspace.id, from);
      session.noteDelete(workspace.id, from);
      if (response.revision) session.noteWrite(workspace.id, to, response.revision);

      workspace.verification.markDirty([to, from]);
      const verification = workspace.verification.toJSON();

      ctx.hub.notifyUser(workspace.userId, SERVER_EVENT.CHANGES_APPLIED, {
        workspaceId: workspace.id,
        clientName,
        summary: `Moved ${from} to ${to}`,
        paths: [to],
        verification
      });

      return ok(
        `Moved ${from} -> ${to} (revision ${response.revision}).\n\n` +
          'Anything that imported the old path is now broken unless you also updated it. ' +
          'Use search_files to confirm.\n\n' +
          REMINDERS.afterWrite(verification),
        { from, to, revision: response.revision, verification }
      );
    })
  );
}

/** Turns agent-side rejection codes into advice a model can act on. */
function explainAgentRejections(rejected) {
  const codes = new Set(rejected.map((r) => r.error));
  const notes = [];

  if (codes.has(AGENT_ERROR.REJECTED_BY_USER)) {
    notes.push(
      'The user declined these changes in the review panel. Do not simply resend them. ' +
        'Ask what they want different, or explain why the change is needed.'
    );
  }
  if (codes.has(AGENT_ERROR.PERMISSION_DENIED)) {
    notes.push('The file is read-only or the app lacks permission. The user has to fix this; you cannot.');
  }
  if (codes.has(AGENT_ERROR.REVISION_MISMATCH)) {
    notes.push(
      'The file changed between validation and write. Re-read it and retry with the fresh revision.'
    );
  }
  if (codes.has(AGENT_ERROR.OUTSIDE_ROOT)) {
    notes.push(
      'The path resolved outside the workspace root and was refused. Paths must be relative to the ' +
        'workspace and must not traverse upward.'
    );
  }

  return notes.length ? `\n\n${notes.join('\n')}` : '';
}
