import * as z from 'zod';
import { ok, fail, toolHandler, renderCommandOutput } from '../format.js';
import { resolveTarget, boundedInt, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, WRITE_SCOPE, READ_SCOPE } from '../guards.js';
import { REMINDERS } from '../instructions.js';
import { AGENT_METHOD, SERVER_EVENT, AGENT_ERROR } from '../../bridge/protocol.js';
import { badRequest } from '../../util/errors.js';
import { uuid } from '../../util/ids.js';
import { createLogger } from '../../logger.js';

const log = createLogger('mcp-command');

/** Output budget per stream in a tool result. Enough for a stack trace, not a whole build log. */
const MAX_OUTPUT_CHARS = 24_000;

/** Hard ceiling on how long any single command may run. */
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_TIMEOUT_SEC = 240;

export function registerCommandTools(server, ctx) {
  server.registerTool(
    'run_command',
    {
      title: 'Run a project command',
      description:
        'Runs a command in the workspace root on the user\'s machine and returns its exit code, stdout ' +
        'and stderr.\n\n' +
        'This is how you verify your work. After changing code in a project folder you are REQUIRED to ' +
        'run the checks listed by get_workspace_overview and get them passing; finish_task will refuse ' +
        'to succeed otherwise.\n\n' +
        'Prefer `commandId` — pass the exact id of a detected check — over spelling out `argv`. Detected ' +
        'checks are pre-approved and use the project\'s own package manager.\n\n' +
        'Arguments are passed directly to the process. There is no shell, so pipes, redirects, `&&`, ' +
        'globs and variable expansion do not work; pass a real argv array. Commands the user has not ' +
        'allowed are refused, and long-running commands (dev servers, watchers) are not permitted — they ' +
        'never exit, so they can only time out.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        commandId: z
          .string()
          .optional()
          .describe('Id of a detected verification command, e.g. "npm run build". Preferred.'),
        argv: z
          .array(z.string())
          .optional()
          .describe(
            'Program and arguments, e.g. ["npm","run","test"]. Used when commandId is not given. ' +
              'No shell: ["npm","test","&&","npm","build"] will not do what you want.'
          ),
        cwd: z
          .string()
          .optional()
          .describe('Subdirectory of the workspace to run in, e.g. "packages/api". Defaults to the root.'),
        timeoutSec: z
          .number()
          .int()
          .optional()
          .describe(`Seconds before the command is killed (1-${MAX_TIMEOUT_SEC}, default ${DEFAULT_TIMEOUT_SEC}).`),
        reason: z
          .string()
          .optional()
          .describe('Why you are running this. Shown to the user alongside the output.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    toolHandler('run_command', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { workspace, agent, clientName } = resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'run_command',
        summary: args.commandId || args.argv?.join(' ')
      });

      // Resolve what to run.
      let argv;
      let commandId = args.commandId || null;
      let detected = null;

      if (commandId) {
        detected = workspace.verification.commands.find((c) => c.id === commandId);
        if (!detected) {
          const available = workspace.verification.commands.map((c) => `"${c.id}"`).join(', ') || '(none detected)';
          return fail(
            `No detected command with id "${commandId}".\n\nAvailable: ${available}\n\n` +
              'Use get_workspace_overview to see them, or pass an explicit argv array instead.'
          );
        }
        argv = detected.argv;
      } else if (Array.isArray(args.argv) && args.argv.length) {
        argv = args.argv;
        if (argv.some((part) => typeof part !== 'string')) {
          throw badRequest('Every element of "argv" must be a string.');
        }
        commandId = argv.join(' ');
      } else {
        throw badRequest(
          'Provide either "commandId" (preferred, from get_workspace_overview) or a non-empty "argv" array.'
        );
      }

      const timeoutSec = boundedInt(args.timeoutSec, {
        name: 'timeoutSec',
        min: 1,
        max: MAX_TIMEOUT_SEC,
        fallback: DEFAULT_TIMEOUT_SEC
      });

      const runId = uuid();
      const started = Date.now();

      // Accumulate streamed output. If the command outlives the RPC we can
      // still hand back what it printed, which is usually where the useful
      // information is.
      let streamedOut = '';
      let streamedErr = '';
      const detach = ctx.hub.attachCommandStream(agent, runId, (frame) => {
        if (frame.stream === 'stderr') streamedErr += frame.chunk || '';
        else streamedOut += frame.chunk || '';
      });

      ctx.activeRuns.set(runId, { workspaceId: workspace.id, commandId, startedAt: started, agentId: agent.id });

      let response;
      try {
        response = await agent.request(
          AGENT_METHOD.RUN_COMMAND,
          {
            workspaceId: workspace.id,
            runId,
            argv,
            commandId,
            cwd: args.cwd || null,
            timeoutMs: timeoutSec * 1000,
            meta: { actor: 'mcp', actorName: clientName, reason: args.reason || null, preApproved: Boolean(detected) }
          },
          // Give the agent a grace period beyond the command's own timeout so
          // that a killed process still reports back through the normal path.
          { timeoutMs: timeoutSec * 1000 + 30_000 }
        );
      } catch (err) {
        agent
          .request(AGENT_METHOD.CANCEL_COMMAND, { runId }, { timeoutMs: 5000 })
          .catch(() => {});
        const partial = [
          renderCommandOutput('stdout so far', streamedOut, MAX_OUTPUT_CHARS / 2),
          renderCommandOutput('stderr so far', streamedErr, MAX_OUTPUT_CHARS / 2)
        ].join('\n\n');
        return fail(
          `The command did not complete: ${err.message}\n\n${partial}\n\n` +
            'It has been cancelled. If this command is long-running by nature (a dev server, a watcher), ' +
            'it is not something to run here — pick the project\'s one-shot build or test command instead.',
          { runId, error: err.code }
        );
      } finally {
        detach();
        ctx.activeRuns.delete(runId);
      }

      const durationMs = response.durationMs ?? Date.now() - started;
      const exitCode = response.exitCode;
      const passed = exitCode === 0 && !response.timedOut;

      if (response.error === AGENT_ERROR.COMMAND_NOT_ALLOWED) {
        return fail(
          `The user has not allowed "${argv.join(' ')}" to run.\n\n${response.message || ''}\n\n` +
            'The detected verification commands are pre-approved; prefer those. If this command genuinely ' +
            'needs to run, ask the user to allow it in CodeWriter\'s command settings. You cannot grant ' +
            'this yourself.',
          { error: response.error }
        );
      }

      // Record the run against the verification state, but only for commands
      // the project actually declared as checks.
      if (detected) {
        workspace.verification.recordRun({
          commandId: detected.id,
          label: detected.label,
          ok: passed,
          exitCode,
          startedAt: started,
          finishedAt: Date.now(),
          summary: passed ? 'passed' : response.timedOut ? 'timed out' : `exit ${exitCode}`
        });

        const evaluation = workspace.verification.evaluate();
        if (evaluation.satisfied) workspace.verification.markClean();
      }

      ctx.hub.notifyUser(workspace.userId, SERVER_EVENT.MCP_ACTIVITY, {
        workspaceId: workspace.id,
        tool: 'run_command',
        clientName,
        summary: `${argv.join(' ')} -> exit ${exitCode}`,
        at: Date.now()
      });

      log.info(`${clientName} ran "${argv.join(' ')}" in ${workspace.name}: exit ${exitCode} in ${durationMs}ms`);

      const header = [
        `COMMAND: ${argv.join(' ')}`,
        `CWD:     ${args.cwd ? `${workspace.rootPath}/${args.cwd}` : workspace.rootPath}`,
        `EXIT:    ${response.timedOut ? `timed out after ${timeoutSec}s` : exitCode}`,
        `TIME:    ${(durationMs / 1000).toFixed(1)}s`,
        `RESULT:  ${passed ? 'PASSED' : 'FAILED'}`
      ].join('\n');

      const body = [
        renderCommandOutput('STDOUT', response.stdout || streamedOut, MAX_OUTPUT_CHARS),
        renderCommandOutput('STDERR', response.stderr || streamedErr, MAX_OUTPUT_CHARS)
      ].join('\n\n');

      const verification = workspace.verification.toJSON();
      const trailer = passed ? summariseRemaining(verification) : `\n\n${REMINDERS.afterFailedCommand()}`;

      const result = `${header}\n\n${body}${trailer}`;

      return passed
        ? ok(result, { runId, exitCode, durationMs, passed, verification })
        : fail(result, { runId, exitCode, durationMs, passed, verification });
    })
  );

  server.registerTool(
    'finish_task',
    {
      title: 'Finish the task',
      description:
        'Declares a piece of work complete, and records a summary the user will see in their editor.\n\n' +
        'This is a gate, not a formality. In a project folder it FAILS if any required check has not ' +
        'passed since your most recent write — including checks that passed earlier and were invalidated ' +
        'by a later edit. When it fails it tells you exactly which commands still need to run.\n\n' +
        'Call this as the last step of any task that changed files. If it fails, you are not finished: ' +
        'run what it names, fix what breaks, and call it again.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        summary: z
          .string()
          .min(1)
          .describe('What you changed and why, in the user\'s terms. This is shown to them directly.'),
        followUps: z
          .array(z.string())
          .optional()
          .describe('Anything you noticed but deliberately did not do. Be honest about known gaps.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    toolHandler('finish_task', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { workspace, session, clientName } = resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'finish_task',
        summary: args.summary
      });

      const evaluation = workspace.verification.evaluate();

      if (!evaluation.satisfied) {
        const lines = ['This task is NOT complete. Required checks have not passed since your last write.', ''];

        if (evaluation.pending.length) {
          lines.push('Never run:', ...evaluation.pending.map((c) => `  - ${c.label}   (commandId: "${c.id}")`), '');
        }
        if (evaluation.stale.length) {
          lines.push(
            'Ran, but BEFORE your most recent edit, so the result no longer applies:',
            ...evaluation.stale.map((c) => `  - ${c.label}   (commandId: "${c.id}")`),
            ''
          );
        }
        if (evaluation.failed.length) {
          lines.push(
            'Ran and FAILED:',
            ...evaluation.failed.map(
              (c) => `  - ${c.label}   (exit ${c.lastRun.exitCode}, commandId: "${c.id}")`
            ),
            ''
          );
        }

        lines.push(
          `Files changed and not yet verified: ${[...workspace.verification.dirtyPaths].join(', ') || '(none listed)'}`,
          '',
          'Run each command above with run_command. If one fails, read the output, re-read the files',
          'involved, fix the actual cause, and run it again. Then call finish_task.'
        );

        return fail(lines.join('\n'), { verification: workspace.verification.toJSON() });
      }

      ctx.hub.notifyUser(workspace.userId, SERVER_EVENT.MCP_ACTIVITY, {
        workspaceId: workspace.id,
        tool: 'finish_task',
        clientName,
        summary: args.summary,
        followUps: args.followUps || [],
        completed: true,
        at: Date.now()
      });

      log.info(`${clientName} completed a task in ${workspace.name}: ${args.summary}`);

      const written = [...session.writtenPaths]
        .filter((key) => key.startsWith(`${workspace.id}\n`))
        .map((key) => key.split('\n')[1]);

      const verification = workspace.verification.toJSON();
      const passed = verification.lastRuns.filter((r) => r.ok).map((r) => r.label || r.commandId);

      const parts = ['Task recorded as complete.', '', `Summary: ${args.summary}`];
      if (written.length) {
        parts.push('', `Files you changed in this session (${written.length}):`, ...written.map((p) => `  ${p}`));
      }
      if (passed.length) {
        parts.push('', 'Checks passed:', ...passed.map((p) => `  ${p}`));
      } else if (!verification.enforced) {
        parts.push('', 'No project checks were required for this workspace.');
      }
      if (args.followUps?.length) {
        parts.push('', 'Noted as not done:', ...args.followUps.map((f) => `  - ${f}`));
      }

      return ok(parts.join('\n'), { verification, filesChanged: written });
    })
  );

  server.registerTool(
    'cancel_command',
    {
      title: 'Cancel a running command',
      description:
        'Stops a command started by run_command that is still running. Use the runId from the ' +
        'run_command result. Cancelling a check does not count as running it.',
      inputSchema: {
        runId: z.string().describe('The runId returned by run_command.')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false }
    },
    toolHandler('cancel_command', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { userId } = resolveTargetless(ctx, extra);

      const run = ctx.activeRuns.get(args.runId);
      if (!run) {
        return ok(`No running command with id "${args.runId}". It has already finished or was cancelled.`);
      }

      const workspace = ctx.registry.get(run.workspaceId, userId);
      const agent = ctx.hub.agentForWorkspace(workspace);
      await agent.request(AGENT_METHOD.CANCEL_COMMAND, { runId: args.runId }, { timeoutMs: 10_000 });
      ctx.activeRuns.delete(args.runId);

      return ok(`Cancelled "${run.commandId}".`);
    })
  );
}

/** Context for tools that do not target a specific workspace. */
function resolveTargetless(ctx, extra) {
  const userId = extra.authInfo?.extra?.userId;
  return { userId };
}

/** After a passing check, say what is still outstanding rather than implying "done". */
function summariseRemaining(verification) {
  if (!verification.enforced) return '';
  if (verification.satisfied) {
    return '\n\nAll required checks have now passed for the current state of the code. Call finish_task.';
  }
  const outstanding = [...verification.pending, ...verification.stale, ...verification.failed];
  if (!outstanding.length) return '';
  return (
    '\n\nStill outstanding before finish_task will succeed:\n' +
    outstanding.map((id) => `  - ${id}`).join('\n')
  );
}
