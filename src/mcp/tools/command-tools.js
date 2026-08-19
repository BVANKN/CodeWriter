import * as z from 'zod';
import config from '../../config.js';
import { ok, fail, toolHandler, renderCommandOutput } from '../format.js';
import { resolveTarget, callContext, boundedInt, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, WRITE_SCOPE, READ_SCOPE } from '../guards.js';
import { REMINDERS } from '../instructions.js';
import { AGENT_METHOD, SERVER_EVENT, AGENT_ERROR } from '../../bridge/protocol.js';
import { badRequest } from '../../util/errors.js';
import { uuid } from '../../util/ids.js';
import { createLogger } from '../../logger.js';
import { checkpointAfterChanges, describeCheckpoint } from '../../workspace/checkpoint.js';

const log = createLogger('mcp-command');

/** Output budget per stream in a tool result. Enough for a stack trace, not a whole build log. */
const MAX_OUTPUT_CHARS = 24_000;

/** Hard ceiling on how long any single command may run. */
const MAX_TIMEOUT_SEC = 900;
const DEFAULT_TIMEOUT_SEC = 240;

/**
 * How long `run_command` waits before handing back a runId to poll.
 *
 * Sized so a short command still answers in one call while leaving generous
 * room inside the client's 60s budget for network latency and a cold backend.
 */
const FIRST_WAIT_MS = 25_000;

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
        'never exit, so they can only time out.\n\n' +
        'LONG COMMANDS: if a command is still running when the response budget runs out, this returns a ' +
        'runId with STATUS "still running" instead of blocking. That is NOT a failure and the command is ' +
        'NOT cancelled — call get_command_result with the runId to collect the result. A real npm install ' +
        'or a cold build normally needs one or two polls.',
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
      const { workspace, agent, clientName } = await resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'run_command',
        requireLiveAgent: true,
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

      // Start the command without waiting for it here.
      //
      // A real `npm install` or a cold build takes minutes, and the MCP client
      // gives up after 60 seconds. Blocking on the full run therefore *cannot*
      // work for exactly the commands that matter most — the client times out,
      // reports nothing useful, and the process keeps running orphaned.
      //
      // So the run is detached: we wait only as long as we safely can, and if
      // it is still going we hand back the runId and the output so far. The
      // model polls with get_command_result. Short commands still return in one
      // call, so the common case is unchanged.
      const runPromise = agent
        .request(
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
          // Grace beyond the command's own timeout so a killed process still
          // reports back through the normal path.
          { timeoutMs: timeoutSec * 1000 + 30_000 }
        )
        .then(
          (value) => ({ ok: true, value }),
          (error) => ({ ok: false, error })
        );

      const record = {
        runId,
        workspaceId: workspace.id,
        commandId,
        argv,
        detected,
        startedAt: started,
        agentId: agent.id,
        clientName,
        promise: runPromise,
        settled: null,
        get output() {
          return { stdout: streamedOut, stderr: streamedErr };
        },
        detach
      };
      ctx.activeRuns.set(runId, record);

      // Retain the outcome so a later poll can still read it, and keep the
      // stream attached until it finishes.
      runPromise.then((settled) => {
        record.settled = settled;
        record.finishedAt = Date.now();
        detach();
      });

      // Deliberately well short of the client's budget rather than right up
      // against it. Waiting 48s of a 60s allowance leaves no room for network
      // latency or a cold instance, and the only thing the extra seconds buy
      // is occasionally avoiding one cheap poll. Returning early is not a
      // failure here — get_command_result picks the run straight back up.
      const waitMs = Math.min(timeoutSec * 1000 + 30_000, FIRST_WAIT_MS);
      const outcome = await Promise.race([
        runPromise,
        new Promise((resolve) => {
          const timer = setTimeout(() => resolve(null), waitMs);
          if (typeof timer.unref === 'function') timer.unref();
        })
      ]);

      if (outcome === null) {
        // Still running. Report honestly rather than pretending it failed.
        return ok(
          [
            `COMMAND: ${argv.join(' ')}`,
            `STATUS:  still running after ${(waitMs / 1000).toFixed(0)}s`,
            `RUN ID:  ${runId}`,
            '',
            renderCommandOutput('OUTPUT SO FAR', streamedOut + streamedErr, MAX_OUTPUT_CHARS / 2),
            '',
            'This command is still executing on the user\'s machine. It has NOT been cancelled.',
            '',
            `Call get_command_result with runId "${runId}" to wait for the rest. Long installs and`,
            'cold builds routinely need two or three polls; that is normal, not a failure.'
          ].join('\n'),
          { runId, status: 'running', partial: true }
        );
      }

      ctx.activeRuns.delete(runId);

      if (!outcome.ok) {
        const err = outcome.error;
        agent.request(AGENT_METHOD.CANCEL_COMMAND, { runId }, { timeoutMs: 5000 }).catch(() => {});
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
      }

      const response = outcome.value;

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
      const { workspace, session, clientName } = await resolveTarget(ctx, extra, args.workspaceId, {
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

      // Commit the work so it survives the app closing, a crash, or the next
      // session. Best effort: a failed commit is reported, never fatal.
      let checkpoint = null;
      if (written.length) {
        const agent = ctx.hub.agentsForUser(workspace.userId).find((a) => a.id === workspace.agentId);
        if (agent) {
          checkpoint = await checkpointAfterChanges(ctx, {
            workspace,
            agent,
            summary: args.summary,
            clientName
          });
          const note = describeCheckpoint(checkpoint);
          if (note) parts.push('', note);
        }
      }

      return ok(parts.join('\n'), { verification, filesChanged: written, checkpoint });
    })
  );

  server.registerTool(
    'get_command_result',
    {
      title: 'Get the result of a running command',
      description:
        'Waits for a command started by run_command that had not finished yet, and returns its exit code ' +
        'and output.\n\n' +
        'run_command returns early when a command is still going, because no MCP client waits more than ' +
        'about a minute and a real `npm install` or cold build takes longer. That is not a failure — the ' +
        'command is still running on the user\'s machine. Call this with the runId to collect the result.\n\n' +
        'If it reports "still running" again, call it again. Several polls for a large install is normal.',
      inputSchema: {
        runId: z.string().describe('The runId returned by run_command.'),
        waitSec: z
          .number()
          .int()
          .optional()
          .describe('How long to wait on this poll before reporting back (1-45, default 30).')
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    toolHandler('get_command_result', async (args, extra) => {
      assertScope(extra.authInfo, WRITE_SCOPE);
      const { userId } = callContext(ctx, extra);

      const record = ctx.activeRuns.get(args.runId);
      if (!record) {
        return fail(
          `No command with runId "${args.runId}" is tracked.\n\n` +
            'Either it finished and its result was already returned, or the backend restarted. ' +
            'Run the command again if you still need its output.'
        );
      }

      const workspace = ctx.registry.get(record.workspaceId, userId);
      const waitSec = boundedInt(args.waitSec, { name: 'waitSec', min: 1, max: 45, fallback: 30 });

      const outcome =
        record.settled ??
        (await Promise.race([
          record.promise,
          new Promise((resolve) => {
            const timer = setTimeout(() => resolve(null), waitSec * 1000);
            if (typeof timer.unref === 'function') timer.unref();
          })
        ]));

      const { stdout: soFar, stderr: errSoFar } = record.output;

      if (outcome === null) {
        const elapsed = ((Date.now() - record.startedAt) / 1000).toFixed(0);
        return ok(
          [
            `COMMAND: ${record.argv.join(' ')}`,
            `STATUS:  still running after ${elapsed}s total`,
            `RUN ID:  ${record.runId}`,
            '',
            renderCommandOutput('OUTPUT SO FAR', soFar + errSoFar, MAX_OUTPUT_CHARS / 2),
            '',
            'Still executing. Call get_command_result again with the same runId.'
          ].join('\n'),
          { runId: record.runId, status: 'running', partial: true }
        );
      }

      ctx.activeRuns.delete(args.runId);
      record.detach?.();

      if (!outcome.ok) {
        return fail(
          `The command failed to complete: ${outcome.error.message}\n\n` +
            renderCommandOutput('OUTPUT', soFar + errSoFar, MAX_OUTPUT_CHARS),
          { runId: record.runId, error: outcome.error.code }
        );
      }

      const response = outcome.value;
      const passed = response.exitCode === 0 && !response.timedOut;

      if (record.detected) {
        workspace.verification.recordRun({
          commandId: record.detected.id,
          label: record.detected.label,
          ok: passed,
          exitCode: response.exitCode,
          startedAt: record.startedAt,
          finishedAt: record.finishedAt ?? Date.now(),
          summary: passed ? 'passed' : response.timedOut ? 'timed out' : `exit ${response.exitCode}`
        });
        if (workspace.verification.evaluate().satisfied) workspace.verification.markClean();
      }

      const verification = workspace.verification.toJSON();
      const header = [
        `COMMAND: ${record.argv.join(' ')}`,
        `EXIT:    ${response.timedOut ? 'timed out' : response.exitCode}`,
        `TIME:    ${(((record.finishedAt ?? Date.now()) - record.startedAt) / 1000).toFixed(1)}s`,
        `RESULT:  ${passed ? 'PASSED' : 'FAILED'}`
      ].join('\n');

      const body = [
        renderCommandOutput('STDOUT', response.stdout || soFar, MAX_OUTPUT_CHARS),
        renderCommandOutput('STDERR', response.stderr || errSoFar, MAX_OUTPUT_CHARS)
      ].join('\n\n');

      const trailer = passed ? summariseRemaining(verification) : `\n\n${REMINDERS.afterFailedCommand()}`;
      const text = `${header}\n\n${body}${trailer}`;

      return passed
        ? ok(text, { runId: record.runId, exitCode: response.exitCode, passed, verification })
        : fail(text, { runId: record.runId, exitCode: response.exitCode, passed, verification });
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
      const { userId } = callContext(ctx, extra);

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
