import { AGENT_METHOD } from '../bridge/protocol.js';
import { createLogger } from '../logger.js';

const log = createLogger('checkpoint');

/**
 * Git safety checkpoints around an AI session.
 *
 * Two commits bracket the work:
 *
 *   - **Before the first change.** Whatever the user had uncommitted at the
 *     moment the AI started is committed as-is. This is the commit they reset
 *     to if the session goes badly, and it has to exist *before* anything is
 *     overwritten — afterwards is too late.
 *   - **When the task finishes**, or when something goes wrong. The AI's work
 *     is committed so it survives the app closing, a crash, or the next
 *     session.
 *
 * Both are best-effort by design. A repository with a hostile pre-commit hook,
 * a read-only directory, or no git at all must not stop the user's actual work
 * — a safety net that blocks the thing it protects is worse than no safety net.
 * Failures are reported and then stepped over.
 */

/** Checkpoint timeouts are short: this runs inside a tool call's budget. */
const CHECKPOINT_TIMEOUT_MS = 20_000;

/**
 * Commits the user's pre-existing work, once per workspace per session.
 *
 * @param {object} ctx
 * @param {object} workspace
 * @param {object} agent
 * @param {string} clientName
 * @returns {Promise<object|null>} the checkpoint result, or null when skipped
 */
export async function checkpointBeforeChanges(ctx, { workspace, agent, clientName }) {
  if (workspace.baselineCheckpoint) return workspace.baselineCheckpoint;

  // Claim it immediately so two concurrent writes cannot both commit.
  workspace.baselineCheckpoint = { pending: true };

  try {
    const result = await agent.request(
      AGENT_METHOD.GIT_CHECKPOINT,
      {
        workspaceId: workspace.id,
        message:
          `CodeWriter: checkpoint before ${clientName || 'AI'} changes\n\n` +
          'Automatic snapshot of your work as it was before this session.\n' +
          'Reset here to undo everything the AI did.'
      },
      { timeoutMs: CHECKPOINT_TIMEOUT_MS }
    );

    workspace.baselineCheckpoint = { ...result, at: Date.now() };
    if (result.committed) {
      log.info(`Baseline checkpoint for ${workspace.name}: ${result.sha}`);
    } else {
      log.debug(`No baseline checkpoint needed for ${workspace.name}: ${result.reason}`);
    }
    return workspace.baselineCheckpoint;
  } catch (err) {
    // Record the failure so we do not retry on every single write, but keep
    // the reason so it can be reported honestly.
    workspace.baselineCheckpoint = { committed: false, failed: true, reason: err.message, at: Date.now() };
    log.warn(`Baseline checkpoint failed for ${workspace.name}: ${err.message}`);
    return workspace.baselineCheckpoint;
  }
}

/**
 * Commits the AI's work. Called when a task completes, and when a session ends.
 *
 * @returns {Promise<object|null>}
 */
export async function checkpointAfterChanges(ctx, { workspace, agent, summary, clientName }) {
  try {
    const result = await agent.request(
      AGENT_METHOD.GIT_CHECKPOINT,
      {
        workspaceId: workspace.id,
        message: `CodeWriter: ${summary || 'AI session changes'}\n\nMade via CodeWriter by ${clientName || 'an MCP client'}.`
      },
      { timeoutMs: CHECKPOINT_TIMEOUT_MS }
    );

    if (result.committed) log.info(`Session checkpoint for ${workspace.name}: ${result.sha}`);
    workspace.lastCheckpoint = { ...result, at: Date.now() };
    return workspace.lastCheckpoint;
  } catch (err) {
    log.warn(`Session checkpoint failed for ${workspace.name}: ${err.message}`);
    return { committed: false, failed: true, reason: err.message };
  }
}

/** One line describing a checkpoint, for inclusion in tool output. */
export function describeCheckpoint(checkpoint, { baseline = false } = {}) {
  if (!checkpoint) return null;
  if (checkpoint.failed) {
    return `Git checkpoint could not be created (${checkpoint.reason}). Your work is NOT snapshotted in git; ` +
      'the per-file undo history in CodeWriter still applies.';
  }
  if (!checkpoint.committed) return null;
  return baseline
    ? `Git checkpoint ${checkpoint.sha} captures the project as it was before these changes. ` +
      `Reset to it to undo everything from this session.`
    : `Committed as ${checkpoint.sha}.`;
}
