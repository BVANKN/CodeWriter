import config from '../config.js';
import { AppError, badRequest, conflict, forbidden, tooLarge } from '../util/errors.js';
import { normalizeRelPath } from '../util/paths.js';
import { REMINDERS } from './instructions.js';

/**
 * The checks that stand between a model's intention and the user's disk.
 *
 * Each one exists because of a specific way this goes wrong in practice, and
 * each returns an error that tells the model exactly how to recover. An error
 * that only says "invalid request" teaches a model nothing and usually produces
 * an identical retry.
 */

/** Scopes required by each mutating tool. */
export const WRITE_SCOPE = 'workspace:write';
export const READ_SCOPE = 'workspace:read';

/**
 * @param {import('@modelcontextprotocol/sdk/server/auth/types.js').AuthInfo} authInfo
 * @param {string} scope
 */
export function assertScope(authInfo, scope) {
  const scopes = authInfo?.scopes || [];
  if (!scopes.includes(scope)) {
    throw forbidden(
      `This action requires the "${scope}" scope, but your token only has: ${scopes.join(', ') || '(none)'}. ` +
        'Reconnect and approve the missing permission.'
    );
  }
}

/**
 * Validates one entry of a `write_files` call against the current index.
 *
 * @param {object} params
 * @param {import('./session.js').McpSession} params.session
 * @param {import('../workspace/registry.js').Workspace} params.workspace
 * @param {{ path: string, content: string, baseRevision?: string, action?: string }} params.change
 * @returns {{ path: string, content: string, action: 'create'|'update', existing: object|null }}
 */
export function validateWrite({ session, workspace, change }) {
  if (!change || typeof change !== 'object') {
    throw badRequest('Each entry in "changes" must be an object.');
  }

  const path = normalizeRelPath(change.path, 'changes[].path');

  if (typeof change.content !== 'string') {
    throw badRequest(
      `changes[].content must be a string containing the COMPLETE new content of "${path}". ` +
        'Partial content, diffs, and placeholders such as "... rest unchanged ..." are not supported.'
    );
  }

  const contentBytes = Buffer.byteLength(change.content, 'utf8');
  if (contentBytes > config.maxFileBytes) {
    throw tooLarge(
      `The content for "${path}" is ${contentBytes} bytes, over the ${config.maxFileBytes}-byte limit.`
    );
  }

  const existing = workspace.getFile(path);
  const declaredAction = change.action;

  if (declaredAction && declaredAction !== 'create' && declaredAction !== 'update') {
    throw badRequest(`changes[].action must be "create" or "update", got "${declaredAction}".`);
  }

  // -- Creating a new file -------------------------------------------------
  if (!existing) {
    if (declaredAction === 'update') {
      throw new AppError(
        'FILE_NOT_FOUND',
        `"${path}" does not exist, but action was "update". ` +
          'Use action "create" for a new file, or check the path with list_files.',
        { status: 404 }
      );
    }
    if (change.baseRevision) {
      throw badRequest(
        `"${path}" does not exist, so it has no baseRevision. Omit baseRevision when creating a file.`
      );
    }
    return { path, content: change.content, action: 'create', existing: null };
  }

  // -- Updating an existing file -------------------------------------------
  if (declaredAction === 'create') {
    throw conflict(
      `"${path}" already exists (revision ${existing.revision}), but action was "create". ` +
        'Read it first, then write with action "update" and its baseRevision. ' +
        'If you genuinely mean to replace it wholesale, say so explicitly with action "update".'
    );
  }

  if (existing.binary) {
    throw badRequest(
      `"${path}" is a binary file. CodeWriter only writes text files, to avoid corrupting binary content.`
    );
  }

  if (!change.baseRevision) {
    throw badRequest(
      `"${path}" exists at revision ${existing.revision}, but no baseRevision was supplied.\n\n` +
        'Every update must quote the revision it was based on, so the server can tell whether the\n' +
        'file changed underneath you. Read the file, then pass the revision it returns.'
    );
  }

  if (change.baseRevision !== existing.revision) {
    throw new AppError('STALE_REVISION', REMINDERS.staleWrite(path, change.baseRevision, existing.revision), {
      status: 409,
      details: { path, expected: change.baseRevision, actual: existing.revision }
    });
  }

  // The revision matches the disk, but has this session actually *seen* that
  // content? A model can learn a revision from list_files without reading the
  // file, and a full-file write from a model that has not read the file is a
  // blind overwrite.
  if (!session.hasFreshRead(workspace.id, path, existing.revision)) {
    throw new AppError('UNREAD_FILE', REMINDERS.unreadWrite(path), {
      status: 409,
      details: { path, currentRevision: existing.revision }
    });
  }

  return { path, content: change.content, action: 'update', existing };
}

/**
 * Validates a whole `write_files` batch before any of it is applied.
 *
 * Batches are all-or-nothing: if one entry is bad, none are applied. A
 * half-applied refactor is worse than a rejected one, because it leaves the
 * project in a state neither the user nor the model expected.
 */
export function validateWriteBatch({ session, workspace, changes }) {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw badRequest('"changes" must be a non-empty array of files to write.');
  }
  if (changes.length > 100) {
    throw badRequest(`A single write_files call is limited to 100 files; you sent ${changes.length}.`);
  }

  const seen = new Set();
  const validated = [];
  const problems = [];

  for (const change of changes) {
    try {
      const result = validateWrite({ session, workspace, change });
      if (seen.has(result.path)) {
        throw badRequest(
          `"${result.path}" appears twice in the same write_files call. ` +
            'Send one entry per file, containing its final content.'
        );
      }
      seen.add(result.path);
      validated.push(result);
    } catch (err) {
      if (err instanceof AppError) {
        problems.push({ path: change?.path ?? '(unknown)', code: err.code, message: err.message });
      } else {
        throw err;
      }
    }
  }

  if (problems.length) {
    // Report every problem at once. Returning them one at a time turns a
    // five-file batch into five round trips.
    const detail = problems
      .map((p, i) => `${i + 1}. ${p.path} [${p.code}]\n${indent(p.message, '   ')}`)
      .join('\n\n');
    throw new AppError(
      'WRITE_REJECTED',
      `None of the ${changes.length} file(s) were written. ${problems.length} problem(s):\n\n${detail}\n\n` +
        'The batch is all-or-nothing, so nothing changed on disk. Fix these and resend.',
      { status: 409, details: { problems } }
    );
  }

  return validated;
}

/** Validates a delete request. Deletion needs the same freshness proof as a write. */
export function validateDelete({ session, workspace, path: rawPath, baseRevision }) {
  const path = normalizeRelPath(rawPath, 'paths[]');
  const existing = workspace.getFile(path);
  if (!existing) {
    throw new AppError('FILE_NOT_FOUND', `"${path}" does not exist in this workspace.`, { status: 404 });
  }
  if (!baseRevision) {
    throw badRequest(
      `Deleting "${path}" requires its baseRevision (currently ${existing.revision}). ` +
        'Read the file first so you know what you are removing.'
    );
  }
  if (baseRevision !== existing.revision) {
    throw new AppError('STALE_REVISION', REMINDERS.staleWrite(path, baseRevision, existing.revision), {
      status: 409,
      details: { path, expected: baseRevision, actual: existing.revision }
    });
  }
  if (!session.hasFreshRead(workspace.id, path, existing.revision)) {
    throw new AppError('UNREAD_FILE', REMINDERS.unreadWrite(path), {
      status: 409,
      details: { path }
    });
  }
  return { path, existing };
}

function indent(text, prefix) {
  return text
    .split('\n')
    .map((line) => prefix + line)
    .join('\n');
}
