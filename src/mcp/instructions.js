/**
 * The `instructions` string advertised in the MCP `initialize` response.
 *
 * Most MCP clients place this near the top of the model's context for the whole
 * session, which makes it the right place for rules that must hold across every
 * tool call — as opposed to per-call rules, which belong in tool descriptions
 * where they are read immediately before use. Both are used here.
 *
 * Two things worth being explicit about, because they shape the tone:
 *
 *   1. Every rule stated here that *can* be enforced mechanically *is* enforced
 *      mechanically. The text explains the contract; `guards.js` and
 *      `verification.js` are what actually hold the line. Prompt text alone is
 *      not a safety mechanism, and writing it as though it were is how these
 *      systems quietly fail.
 *   2. The rules are justified, not just asserted. A model that understands
 *      *why* stale writes destroy work generalises to cases this text does not
 *      enumerate; one that has merely been told "always re-read" does not.
 */

export function buildServerInstructions({ mcpUrl }) {
  return `# CodeWriter

You are connected to a live code workspace on the user's own machine, through the
CodeWriter desktop app. Files you read are the files open in their editor right
now, including unsaved buffers. Files you write land in that editor immediately.
There is no staging area and no separate review queue by default: a write is a
real edit to real code the user is working on.

Endpoint: ${mcpUrl}

## The revision contract

Every file has a **revision** — a short hash of its current content. Reads give
you the revision. Writes must quote the revision they were based on, as
\`baseRevision\`.

A write is rejected when its \`baseRevision\` is not the file's current revision.
This is not bureaucracy. Between your read and your write, the user may have
typed in that file, switched branches, or run a formatter. If you write a "full
file" built on content that is no longer current, you do not merge with their
work — you silently delete it. The revision check makes that impossible, and the
cost of the check is one extra read.

The server additionally requires that **this session has actually read the
revision it is writing over**. Quoting a revision you learned from a directory
listing is not enough; you must have seen the content.

## Rules

**1. Return complete file content. Never fragments.**
\`write_files\` replaces the entire file with what you send. There is no patch
mode, no "..." elision, no "rest of file unchanged". Every change is expressed
as: relative path + the complete new content of that file.

If a file is too large to reproduce in full, do not guess at a partial write.
Say so and propose a different approach — splitting the file, or making a
narrower change to a smaller file.

**2. Read before you write. Every time.**
Before editing a file, read it in this session. Before editing it *again* after
any other write, read it *again*. Your memory of a file from earlier in the
conversation is not evidence about its current state, and after your own
multi-file edit the surrounding code may no longer be what you remember.

**3. Do not answer from memory. Analyse the actual code.**
When asked how something works, what a change should be, or why something
breaks, base the answer on files you have read in this session. Do not rely on
recollection of this project, on how a similarly named library usually behaves,
or on what the code "probably" does. Read it. Search for the real call sites.
Follow the actual imports. If you have not looked, say you have not looked.

**4. Understand the change before making it.**
A one-line edit in the wrong place is worse than no edit. Before writing:
find every caller of what you are changing (\`search_files\`), read the files
that will be affected, and check whether the pattern you are introducing already
exists elsewhere in the project. Match the surrounding code's conventions rather
than importing your own.

**5. Verify your work by running the project's own commands.**
For a folder workspace, CodeWriter detects how the project builds and tests
itself (\`get_workspace_overview\` lists the commands). After writing, you must
run them with \`run_command\` and get them passing.

\`finish_task\` will refuse to succeed while any required check has not passed
since your most recent write. If a check fails, fix the cause and run it again.
Do not report a task complete because the code looks right; report it complete
because the project's own checks say it is.

Single-file workspaces are exempt — there is no project to build.

**6. Multi-file changes are one unit.**
Send related edits in a single \`write_files\` call. It applies them together, so
the user's editor never shows a half-applied refactor.

## Recommended sequence

1. \`get_workspace_overview\` — what this project is, how it is built and tested.
2. \`list_files\` / \`search_files\` — locate the relevant code.
3. \`read_files\` — read every file you will change, plus its callers.
4. \`write_files\` — complete content, correct \`baseRevision\`, all files at once.
5. \`run_command\` — run each required check.
6. Fix and repeat 3-5 until the checks pass.
7. \`finish_task\` — summarise what changed and why.

## If something goes wrong

Errors from this server are written to be acted on: they say what was wrong and
what to do next. A rejected write is normally fixed by re-reading the file and
retrying with the fresh revision, not by retrying the same call. If a tool
reports the desktop app is disconnected, stop and tell the user — nothing you do
will reach their files until they reopen it.`;
}

/**
 * A compact restatement of the rules, appended to write and command results.
 *
 * Instructions delivered at `initialize` can be thousands of tokens back by the
 * time they matter. Repeating the two or three rules that apply *right now*, at
 * the moment the model is deciding what to do next, is far more effective than
 * relying on the header alone.
 */
export const REMINDERS = {
  afterWrite: (verification) => {
    if (!verification || !verification.enforced) {
      return 'Reminder: re-read any file you intend to edit again before writing to it.';
    }
    const commands = verification.commands.filter((c) => c.required).map((c) => c.label);
    return [
      'REQUIRED NEXT STEP - this change is not verified yet.',
      '',
      `Run each of these with run_command and get them passing:`,
      ...commands.map((label, i) => `  ${i + 1}. ${label}`),
      '',
      'finish_task will fail until every one of them has passed since this write.',
      'If you edit again afterwards, the checks must be re-run: an edit invalidates them.'
    ].join('\n');
  },

  afterFailedCommand: () =>
    [
      'This check failed. Before changing anything:',
      '  1. Read the error output above and identify the actual cause.',
      '  2. Re-read the files involved with read_files — they include your last write,',
      '     so your memory of them is out of date.',
      '  3. Fix the cause rather than suppressing the symptom.',
      '  4. Run the check again.'
    ].join('\n'),

  staleWrite: (path, expected, actual) =>
    [
      `"${path}" changed since you read it.`,
      `  You based your edit on revision ${expected}; the file is now at ${actual}.`,
      '',
      'Someone edited this file after your read - probably the user, in their editor.',
      'Writing your version now would delete their work.',
      '',
      'Call read_files for this path, re-apply your intended change on top of the',
      'content you get back, and write again with the new baseRevision.'
    ].join('\n'),

  unreadWrite: (path) =>
    [
      `You have not read "${path}" in this session.`,
      '',
      'A full-file write replaces everything in the file. Without having read its',
      'current content, you cannot know what you would be discarding.',
      '',
      'Call read_files for this path first, then write.'
    ].join('\n')
};
