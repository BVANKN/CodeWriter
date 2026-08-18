import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { callContext, resolveTarget, fetchFiles } from './tools/shared.js';
import { assertScope, READ_SCOPE } from './guards.js';
import { normalizeRelPath } from '../util/paths.js';
import { languageForExt, formatBytes } from '../util/text.js';
import { extName } from '../util/paths.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-resources');

/**
 * Resources expose the workspace as addressable URIs.
 *
 * These exist for clients that let a *person* attach context by hand — picking
 * a file from a list rather than asking the model to go and find it. They are
 * a convenience layer over the same data the tools serve.
 *
 * One important difference: reading a file through a resource does **not**
 * count as the session having read it. Resource reads are usually initiated by
 * the user's UI rather than by the model's own reasoning, and the read-tracking
 * guard is specifically about what the *model* has seen. Treating a
 * user-attached file as a model read would quietly open the hole that guard
 * exists to close.
 */
export function registerResources(server, ctx) {
  server.registerResource(
    'workspaces',
    'codewriter://workspaces',
    {
      title: 'Open workspaces',
      description: 'The projects and files currently open in the CodeWriter desktop app.',
      mimeType: 'application/json'
    },
    async (uri, extra) => {
      const { userId } = callContext(ctx, extra);
      assertScope(extra.authInfo, READ_SCOPE);

      const workspaces = ctx.registry.listForUser(userId).map((w) => w.toJSON());
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify({ workspaces }, null, 2)
          }
        ]
      };
    }
  );

  server.registerResource(
    'workspace-file',
    new ResourceTemplate('codewriter://workspace/{workspaceId}/file/{+path}', {
      list: async (extra) => {
        try {
          const { userId } = callContext(ctx, extra);
          const resources = [];
          for (const workspace of ctx.registry.listForUser(userId)) {
            // Cap the listing: a large monorepo would otherwise produce a
            // resource list no client can render and no context can hold.
            const files = [...workspace.files.values()].filter((f) => !f.binary).slice(0, 500);
            for (const file of files) {
              resources.push({
                uri: `codewriter://workspace/${workspace.id}/file/${file.path}`,
                name: file.path,
                title: `${workspace.name}: ${file.path}`,
                description: `${formatBytes(file.size)}, revision ${file.revision}`,
                mimeType: mimeForPath(file.path)
              });
            }
          }
          return { resources };
        } catch (err) {
          log.debug('Resource listing failed', err);
          return { resources: [] };
        }
      },
      complete: {
        path: async (value, extra) => {
          try {
            const { userId } = callContext(ctx, extra);
            const workspaces = ctx.registry.listForUser(userId);
            const matches = [];
            for (const workspace of workspaces) {
              for (const path of workspace.files.keys()) {
                if (path.startsWith(value)) matches.push(path);
                if (matches.length >= 100) return matches;
              }
            }
            return matches;
          } catch {
            return [];
          }
        }
      }
    }),
    {
      title: 'Workspace file',
      description: 'The current content of one file in an open workspace.'
    },
    async (uri, variables, extra) => {
      assertScope(extra.authInfo, READ_SCOPE);
      const workspaceId = String(variables.workspaceId);
      const relPath = normalizeRelPath(
        Array.isArray(variables.path) ? variables.path.join('/') : String(variables.path),
        'path'
      );

      const { workspace, agent } = resolveTarget(ctx, extra, workspaceId);
      const [file] = await fetchFiles(ctx, { workspace, agent, paths: [relPath] });

      if (file.error) {
        throw new Error(`${relPath}: ${file.message || file.error}`);
      }
      if (file.binary) {
        throw new Error(`${relPath} is a binary file and cannot be returned as text.`);
      }

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: mimeForPath(relPath),
            text: file.content ?? '',
            // Carrying the revision here means a model that read the file via a
            // resource can still see which revision it would be writing over —
            // it just has to read it properly first to be allowed to.
            _meta: { revision: file.revision, language: languageForExt(extName(relPath)) }
          }
        ]
      };
    }
  );
}

const MIME_BY_LANGUAGE = {
  javascript: 'text/javascript',
  typescript: 'text/typescript',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
  markdown: 'text/markdown',
  xml: 'application/xml',
  yaml: 'application/yaml'
};

function mimeForPath(path) {
  const language = languageForExt(extName(path));
  return MIME_BY_LANGUAGE[language] || 'text/plain';
}
