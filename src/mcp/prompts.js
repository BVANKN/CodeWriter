import * as z from 'zod';

/**
 * MCP prompts: reusable, user-invocable workflows.
 *
 * These are not a second copy of the server instructions. Instructions state
 * the rules that always apply; a prompt front-loads a *procedure* for one kind
 * of task at the moment the user picks it, when it is the most recent thing in
 * context and carries the most weight.
 */
export function registerPrompts(server, ctx) {
  server.registerPrompt(
    'analyze_code',
    {
      title: 'Analyse code (no changes)',
      description:
        'Answer a question about the code by reading it, not by recalling it. Makes no edits.',
      argsSchema: {
        question: z.string().describe('What you want to know about this codebase.'),
        workspaceId: z.string().optional().describe('Which workspace, if several are open.')
      }
    },
    ({ question, workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Question about the code: ${question}`,
              '',
              'Answer it from the actual source, not from memory. Specifically:',
              '',
              '1. Do not rely on recollection of this project from earlier in the conversation, on how',
              '   a similarly named library normally behaves, or on what the code probably does. Those',
              '   are guesses. Read the code.',
              '2. Start with get_workspace_overview' + (workspaceId ? ` for workspace ${workspaceId}` : '') + '.',
              '3. Use search_files to find the relevant code, then read_files to read it in full —',
              '   including the files that call into it, since behaviour usually lives in the seams.',
              '4. Follow the real imports and call sites. Where you assume something you did not verify,',
              '   say so explicitly rather than presenting it as fact.',
              '5. Cite specific files and line numbers so the answer can be checked.',
              '',
              'Make no changes. This is a read-only investigation.'
            ].join('\n')
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'implement_change',
    {
      title: 'Implement a change (with verification)',
      description:
        'Make a code change end to end: investigate, edit, run the project\'s checks, report.',
      argsSchema: {
        request: z.string().describe('What should change.'),
        workspaceId: z.string().optional().describe('Which workspace, if several are open.')
      }
    },
    ({ request, workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              `Change requested: ${request}`,
              '',
              'Work through this in order. Do not skip ahead to writing code.',
              '',
              'UNDERSTAND',
              `  - get_workspace_overview${workspaceId ? ` (workspaceId: ${workspaceId})` : ''}. Note the`,
              '    required checks; they define what "done" means here.',
              '  - search_files for the relevant code and for every caller of anything you will change.',
              '  - read_files on all of it, in full. Reading is what unlocks writing, and your memory',
              '    of these files is not evidence about their current content.',
              '',
              'DECIDE',
              '  - Work out the smallest change that actually solves the problem.',
              '  - Check whether this pattern already exists in the project and follow it rather than',
              '    introducing your own.',
              '  - If the request is ambiguous in a way that changes the implementation, ask before',
              '    building the wrong thing.',
              '',
              'IMPLEMENT',
              '  - One write_files call with every affected file, each carrying its COMPLETE new',
              '    content and its baseRevision.',
              '',
              'VERIFY',
              '  - run_command for each required check.',
              '  - If one fails: read the output, re-read the files (they include your own edit, so',
              '    what you remember is out of date), fix the real cause, run it again.',
              '  - git_diff is worth a look before you declare victory.',
              '',
              'REPORT',
              '  - finish_task with a summary the user can read, plus anything you deliberately left',
              '    undone. It will refuse while any check is unverified — that is the point.'
            ].join('\n')
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'review_changes',
    {
      title: 'Review uncommitted changes',
      description: 'Review what is currently uncommitted in the working tree.',
      argsSchema: {
        workspaceId: z.string().optional().describe('Which workspace, if several are open.')
      }
    },
    ({ workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              'Review the uncommitted changes in this workspace.',
              '',
              `  1. git_status${workspaceId ? ` (workspaceId: ${workspaceId})` : ''} to see what has changed.`,
              '  2. git_diff to read the changes themselves.',
              '  3. read_files on each changed file in full — a diff hides the context that determines',
              '     whether a change is correct.',
              '  4. search_files for other places that follow the same pattern and may need the same fix.',
              '',
              'Report: correctness bugs first, then anything that will break a caller, then',
              'simplifications. Be specific about file and line. Say plainly if it looks fine.',
              '',
              'Do not change anything unless asked.'
            ].join('\n')
          }
        }
      ]
    })
  );

  server.registerPrompt(
    'fix_failing_check',
    {
      title: 'Fix a failing build or test',
      description: 'Diagnose and fix a failing project check.',
      argsSchema: {
        commandId: z.string().optional().describe('Which check is failing, e.g. "npm run test".'),
        workspaceId: z.string().optional().describe('Which workspace, if several are open.')
      }
    },
    ({ commandId, workspaceId }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              commandId ? `The check "${commandId}" is failing. Fix it.` : 'A project check is failing. Fix it.',
              '',
              `  1. run_command${commandId ? ` with commandId "${commandId}"` : ' for the failing check'} to see`,
              '     the current failure. Do not work from a remembered error message.',
              '  2. Read the output properly and identify the actual cause, not the first line that',
              '     looks like an error.',
              '  3. read_files on every file named in the trace.',
              '  4. Fix the cause. Do not delete the assertion, loosen the type, or catch and swallow',
              '     the error to make the check pass — a green check that hides a real bug is worse',
              '     than a red one.',
              '  5. Run the check again, then the other required checks, since a fix in one place',
              '     often breaks another.',
              '  6. finish_task once they all pass.',
              '',
              'If the check is failing for a reason unrelated to any recent change (a missing',
              'dependency, a broken environment), say so instead of editing code to work around it.'
            ].join('\n')
          }
        }
      ]
    })
  );
}
