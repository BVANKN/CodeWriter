import * as z from 'zod';
import config from '../../config.js';
import { ok, fail, toolHandler, renderFile } from '../format.js';
import { resolveTarget, fetchFiles, boundedInt, WORKSPACE_ID_DESCRIPTION } from './shared.js';
import { assertScope, READ_SCOPE } from '../guards.js';
import { normalizeRelPath, buildGlobMatcher, normalizeRelDir } from '../../util/paths.js';
import { countLines, sliceLines, truncateToBytes, languageForExt } from '../../util/text.js';
import { extName } from '../../util/paths.js';
import { AGENT_METHOD } from '../../bridge/protocol.js';

export function registerReadTools(server, ctx) {
  server.registerTool(
    'read_files',
    {
      title: 'Read files',
      description:
        'Reads the current content of one or more files, returning each with its revision.\n\n' +
        'This is the only way to obtain the `baseRevision` a write requires, and reading is tracked: ' +
        'the server will refuse to let you overwrite a file this session has not read at its current ' +
        'revision. That is deliberate — a full-file write from an unread file is a blind overwrite.\n\n' +
        'Read every file you intend to change, plus the files that call into it. Batch them in one call ' +
        'rather than making several; it is faster and gives you a consistent snapshot.\n\n' +
        'Reading a line range does NOT license a full-file write: you have only seen part of the file, ' +
        'so writing it whole would discard the rest.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        paths: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe('Relative paths from the workspace root, e.g. ["src/app.js", "src/lib/util.js"].'),
        startLine: z
          .number()
          .int()
          .optional()
          .describe('1-indexed first line. Only valid when reading exactly one path.'),
        endLine: z.number().int().optional().describe('1-indexed last line, inclusive.'),
        lineNumbers: z
          .boolean()
          .optional()
          .describe('Prefix each line with its number. Useful for discussion; do NOT copy the numbers into a write.')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('read_files', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace, agent, session } = await resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'read_files',
        summary: args.paths.join(', ')
      });

      const paths = args.paths.map((p) => normalizeRelPath(p, 'paths[]'));
      const isRange = args.startLine !== undefined || args.endLine !== undefined;

      if (isRange && paths.length > 1) {
        return fail(
          'startLine/endLine can only be used when reading a single file. ' +
            'Either drop the range, or call read_files once per file you want a range from.'
        );
      }

      const files = await fetchFiles(ctx, { workspace, agent, paths });

      const rendered = [];
      const structured = [];
      const errors = [];

      for (const file of files) {
        if (file.error) {
          errors.push(`  ${file.path}: ${file.message || file.error}`);
          structured.push({ path: file.path, error: file.error });
          continue;
        }

        if (file.binary) {
          rendered.push(`FILE: ${file.path}\nSKIPPED: binary file (${file.size ?? 0} bytes). CodeWriter does not return binary content.`);
          structured.push({ path: file.path, binary: true });
          continue;
        }

        const language = languageForExt(extName(file.path));
        let content = file.content ?? '';
        let startLine = 1;
        let partial = false;

        if (isRange) {
          const slice = sliceLines(content, args.startLine, args.endLine);
          content = slice.text;
          startLine = slice.startLine;
          partial = slice.startLine !== 1 || slice.endLine !== slice.totalLines;
        }

        const budget = truncateToBytes(content, config.maxReadBytes);
        const truncated = budget.truncated;
        content = budget.text;

        // Only a complete, untruncated read proves the session has seen the
        // whole file. Anything less must not unlock a full-file write.
        if (!partial && !truncated) {
          session.noteRead(workspace.id, file.path, file.revision);
        } else {
          session.notePartialRead(workspace.id, file.path);
        }

        rendered.push(
          renderFile({
            path: file.path,
            revision: file.revision,
            content,
            language,
            lineCount: countLines(file.content ?? ''),
            truncated,
            omittedLines: budget.omittedLines,
            startLine,
            showLineNumbers: Boolean(args.lineNumbers),
            dirty: file.dirty
          })
        );

        // The content MUST be here, not only in the text block.
        //
        // A tool result carries two representations, and the MCP spec lets a
        // client use `structuredContent` in preference to the rendered text.
        // Omitting the source from it meant such a client received
        // `{ path, revision, lineCount, dirty }` — file metadata with no file —
        // and correctly concluded it could not safely edit anything. The text
        // block was fine, which is exactly why this was invisible from the
        // server side.
        //
        // Rule for every tool here: structured output must stand on its own.
        // If the interesting payload is only in the prose, it is a bug.
        structured.push({
          path: file.path,
          content,
          revision: file.revision,
          language,
          lineCount: countLines(file.content ?? ''),
          partial: partial || truncated,
          truncated,
          ...(truncated ? { omittedLines: budget.omittedLines } : {}),
          ...(partial ? { startLine, endLine: startLine + countLines(content) - 1 } : {}),
          encoding: file.encoding || 'utf8',
          dirty: Boolean(file.dirty)
        });
      }

      let text = rendered.join('\n\n' + '-'.repeat(72) + '\n\n');

      if (errors.length) {
        text +=
          `\n\n${errors.length} file(s) could not be read:\n${errors.join('\n')}\n\n` +
          'Check the paths with list_files; they are relative to the workspace root.';
      }

      if (!rendered.length && errors.length) {
        return fail(`No files could be read.\n\n${errors.join('\n')}`, { files: structured });
      }

      const writable = structured.filter((s) => s.revision && !s.partial);
      if (writable.length) {
        text +=
          `\n\n${'='.repeat(72)}\n` +
          'To edit any of these, send the COMPLETE new content with its baseRevision:\n' +
          writable.map((s) => `  ${s.path}  baseRevision: ${s.revision}`).join('\n');
      }

      return ok(text, { files: structured });
    })
  );

  server.registerTool(
    'search_files',
    {
      title: 'Search files',
      description:
        'Searches file contents across the workspace and returns matches with surrounding context.\n\n' +
        'Use this before editing anything shared: find every caller of a function before you change its ' +
        'signature, every place a constant is used before you rename it, every import of a module before ' +
        'you move it. Guessing at the blast radius of a change from memory is how a working codebase ' +
        'gets broken by a "small" edit.\n\n' +
        'Searching is not reading. You still need read_files before you can write.',
      inputSchema: {
        workspaceId: z.string().optional().describe(WORKSPACE_ID_DESCRIPTION),
        query: z.string().min(1).describe('Text to find, or a regular expression when isRegex is true.'),
        isRegex: z.boolean().optional().describe('Treat query as a JavaScript regular expression. Default false.'),
        caseSensitive: z.boolean().optional().describe('Default false.'),
        wholeWord: z.boolean().optional().describe('Match only whole words. Default false.'),
        path: z.string().optional().describe('Limit the search to this directory.'),
        glob: z.array(z.string()).optional().describe('Glob filters, same syntax as list_files.'),
        contextLines: z.number().int().optional().describe('Lines of context around each match (0-10, default 2).'),
        maxResults: z.number().int().optional().describe('Max matches to return (1-500, default 100).')
      },
      annotations: { readOnlyHint: true, openWorldHint: false }
    },
    toolHandler('search_files', async (args, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const { workspace, agent } = await resolveTarget(ctx, extra, args.workspaceId, {
        toolName: 'search_files',
        summary: args.query
      });

      const contextLines = boundedInt(args.contextLines, { name: 'contextLines', min: 0, max: 10, fallback: 2 });
      const maxResults = boundedInt(args.maxResults, { name: 'maxResults', min: 1, max: 500, fallback: 100 });
      const dir = normalizeRelDir(args.path, 'path');

      if (args.isRegex) {
        // Compile here so a bad pattern is a clear message rather than a
        // failure deep inside the agent.
        try {
          new RegExp(args.query);
        } catch (err) {
          return fail(`"${args.query}" is not a valid regular expression: ${err.message}`);
        }
      }

      const matcher = buildGlobMatcher(args.glob);
      const candidates = [...workspace.files.values()]
        .filter((f) => !f.binary)
        .filter((f) => (dir ? f.path.startsWith(`${dir}/`) : true))
        .filter((f) => matcher(f.path))
        .map((f) => f.path);

      if (!candidates.length) {
        return ok('No files matched the path/glob filters, so there was nothing to search.');
      }

      const response = await agent.request(
        AGENT_METHOD.SEARCH,
        {
          workspaceId: workspace.id,
          query: args.query,
          isRegex: Boolean(args.isRegex),
          caseSensitive: Boolean(args.caseSensitive),
          wholeWord: Boolean(args.wholeWord),
          paths: candidates,
          contextLines,
          maxResults
        },
        { timeoutMs: config.bridgeRpcTimeoutMs }
      );

      const matches = response.matches || [];
      if (!matches.length) {
        return ok(
          `No matches for ${args.isRegex ? 'pattern' : 'text'} "${args.query}" in ${candidates.length} file(s).\n\n` +
            'If you expected matches: check spelling and case, try isRegex for a looser pattern, or widen ' +
            'the path/glob filters. Files excluded by .gitignore are not indexed and are never searched.',
          { matches: [], filesSearched: candidates.length }
        );
      }

      const byFile = new Map();
      for (const match of matches) {
        if (!byFile.has(match.path)) byFile.set(match.path, []);
        byFile.get(match.path).push(match);
      }

      const blocks = [];
      for (const [path, fileMatches] of byFile) {
        const entry = workspace.getFile(path);
        const lines = [`${path}  (${fileMatches.length} match${fileMatches.length === 1 ? '' : 'es'})${entry ? `  revision ${entry.revision}` : ''}`];
        for (const match of fileMatches) {
          for (const line of match.context || []) {
            const marker = line.lineNumber === match.line ? '>' : ' ';
            lines.push(`  ${marker} ${String(line.lineNumber).padStart(5)} | ${line.text}`);
          }
          lines.push('');
        }
        blocks.push(lines.join('\n').trimEnd());
      }

      const truncatedNote = response.truncated
        ? `\n\nResults were capped at ${maxResults}. Narrow the query or the path filter to see the rest.`
        : '';

      return ok(
        `${matches.length} match(es) in ${byFile.size} file(s), from ${candidates.length} searched:\n\n` +
          blocks.join('\n\n') +
          truncatedNote,
        { matches, filesSearched: candidates.length, truncated: Boolean(response.truncated) }
      );
    })
  );
}
