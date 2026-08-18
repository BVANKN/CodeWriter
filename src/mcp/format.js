import { AppError } from '../util/errors.js';
import { formatBytes, withLineNumbers } from '../util/text.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-tools');

/**
 * Tool results are read by a model, so they are formatted for a model: the
 * facts it needs to act on come first, structure is explicit, and nothing is
 * padded out with prose it has to skim past.
 *
 * Where a result has machine-usable shape (revisions, exit codes, file lists)
 * it is also returned as `structuredContent`, so clients that surface typed
 * output do not have to parse the text back.
 */

/** A successful tool result. */
export function ok(text, structured) {
  return {
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {})
  };
}

/**
 * A failed tool result.
 *
 * This returns `isError: true` rather than throwing, because a thrown error
 * becomes a JSON-RPC protocol error, which many clients surface as an opaque
 * failure the model never sees. A model that cannot read the error cannot
 * recover from it — and almost every error this server produces is one the
 * model is meant to recover from.
 */
export function fail(text, structured) {
  return {
    isError: true,
    content: [{ type: 'text', text }],
    ...(structured ? { structuredContent: structured } : {})
  };
}

/**
 * Wraps a tool handler so that expected errors become readable tool results and
 * unexpected ones are logged in full but reported without internal detail.
 *
 * @param {string} toolName
 * @param {(args: object, extra: object) => Promise<object>} handler
 */
export function toolHandler(toolName, handler) {
  return async (args, extra) => {
    const started = Date.now();
    try {
      const result = await handler(args, extra);
      log.debug(`${toolName} completed in ${Date.now() - started}ms`);
      return result;
    } catch (err) {
      if (err instanceof AppError) {
        log.info(`${toolName} rejected: ${err.code}`);
        return fail(`${err.message}`, { error: err.code, ...(err.details ? { details: err.details } : {}) });
      }
      log.error(`${toolName} threw an unexpected error`, err);
      return fail(
        `An internal error occurred while running "${toolName}". ` +
          'This is a bug in CodeWriter, not something you can fix by retrying with different arguments. ' +
          'Report it to the user.',
        { error: 'INTERNAL' }
      );
    }
  };
}

/** Renders one file for `read_files`. */
export function renderFile({ path, revision, content, language, lineCount, truncated, omittedLines, startLine, showLineNumbers, dirty }) {
  const header = [`FILE: ${path}`, `REVISION: ${revision}`];
  if (lineCount !== undefined) header.push(`LINES: ${lineCount}`);
  if (dirty) header.push('NOTE: this file has unsaved changes in the editor; the content below is the live buffer');
  if (startLine !== undefined && startLine !== 1) header.push(`RANGE: from line ${startLine}`);

  const body = showLineNumbers ? withLineNumbers(content, startLine || 1) : content;
  const fence = pickFence(body);

  const parts = [header.join('\n'), '', `${fence}${language || ''}`, body, fence];

  if (truncated) {
    parts.push(
      '',
      `!! TRUNCATED: ${omittedLines} more line(s) were not returned.`,
      'You do NOT have the complete file. A full-file write based on this content would delete',
      'everything below the cut. Re-read with an explicit startLine/endLine range to see the rest.'
    );
  }

  return parts.join('\n');
}

/**
 * Picks a fence long enough that content containing backticks cannot terminate
 * it early. A model that sees a prematurely closed fence may treat the tail of
 * the file as commentary.
 */
function pickFence(content) {
  let longest = 0;
  const matches = content.match(/`+/g);
  if (matches) {
    for (const run of matches) longest = Math.max(longest, run.length);
  }
  return '`'.repeat(Math.max(3, longest + 1));
}

/** Renders a compact file listing. */
export function renderFileList(entries, { showRevisions = true } = {}) {
  if (!entries.length) return '(no files)';
  const pathWidth = Math.min(80, Math.max(...entries.map((e) => e.path.length)));
  return entries
    .map((entry) => {
      const size = formatBytes(entry.size).padStart(9);
      const rev = showRevisions ? `  ${entry.revision}` : '';
      const flags = [entry.binary ? 'binary' : null, entry.dirty ? 'unsaved' : null]
        .filter(Boolean)
        .join(',');
      return `${entry.path.padEnd(pathWidth)}  ${size}${rev}${flags ? `  [${flags}]` : ''}`;
    })
    .join('\n');
}

/** A short human summary of a batch of applied writes. */
export function renderWriteSummary(results) {
  return results
    .map((r) => {
      const verb = r.action === 'create' ? 'created' : 'updated';
      const delta =
        r.diff && r.action === 'update'
          ? ` (+${r.diff.added}/-${r.diff.removed}, first change at line ${r.diff.firstChangedLine})`
          : '';
      return `  ${verb}  ${r.path}  -> revision ${r.revision}${delta}`;
    })
    .join('\n');
}

/** Clamps and reports command output so a runaway build cannot flood the context. */
export function renderCommandOutput(label, text, maxChars) {
  if (!text) return `${label}: (empty)`;
  if (text.length <= maxChars) return `${label}:\n${text}`;

  // Keep the head and the tail: a compiler names the file at the top and
  // summarises the failure at the bottom, and losing either is losing the
  // point of running it.
  const head = Math.floor(maxChars * 0.35);
  const tail = maxChars - head;
  return [
    `${label} (${text.length} chars, showing first ${head} and last ${tail}):`,
    text.slice(0, head),
    `\n... [${text.length - maxChars} characters omitted] ...\n`,
    text.slice(-tail)
  ].join('\n');
}
