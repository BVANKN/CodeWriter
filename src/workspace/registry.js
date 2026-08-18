import config from '../config.js';
import { createLogger } from '../logger.js';
import { prefixedId } from '../util/ids.js';
import { badRequest, notFound, unavailable } from '../util/errors.js';
import { extName, dirName } from '../util/paths.js';
import { languageForExt } from '../util/text.js';
import { detectVerificationCommands, VerificationState } from './verification.js';

const log = createLogger('workspace');

/**
 * How many change-log entries we keep per workspace. This feeds
 * `get_recent_changes`, which exists so a model that has been away for a few
 * turns can find out what moved underneath it without re-reading the tree.
 */
const CHANGE_LOG_LIMIT = 500;

/**
 * @typedef {object} FileEntry
 * @property {string} path      Relative POSIX path from the workspace root.
 * @property {number} size      Bytes on disk.
 * @property {string} revision  Content hash; the token a write must quote.
 * @property {number} mtime     Last modified, epoch ms.
 * @property {boolean} binary   True when we will refuse to hand it to a model as text.
 * @property {boolean} dirty    True when the editor holds unsaved changes.
 * @property {string} ext
 * @property {string} language
 */

/**
 * One open project (or single file) belonging to one user.
 *
 * The backend does **not** own the filesystem. The Electron agent does. What
 * lives here is an index: paths, sizes, revisions, and enough project metadata
 * to answer questions without a round trip. Content is fetched on demand and
 * cached by revision.
 *
 * That split is deliberate. The editor knows about unsaved buffers, the user's
 * gitignore rules, and which files are actually open; it is the only component
 * that can answer "what does this file contain *right now*" correctly. A
 * backend that read the disk directly would happily hand a model the saved
 * version of a file the user has been editing for ten minutes.
 */
export class Workspace {
  constructor({ id, userId, agentId, name, rootPath, kind }) {
    this.id = id;
    this.userId = userId;
    this.agentId = agentId;
    this.name = name;
    this.rootPath = rootPath;
    /** @type {'folder' | 'file'} */
    this.kind = kind;

    /** @type {Map<string, FileEntry>} */
    this.files = new Map();

    this.indexedAt = null;
    this.indexComplete = false;
    this.indexedBytes = 0;

    /** Counts of what the scanner skipped, so the UI can explain the file count. */
    this.skipped = { ignored: 0, binary: 0, tooLarge: 0 };

    this.git = { isRepo: false, branch: null, remote: null, dirtyFileCount: 0 };
    this.project = { packageManager: null, packageJson: null, topLevelFiles: [], frameworks: [] };

    this.verification = new VerificationState();

    /** @type {Array<object>} Newest first. */
    this.changeLog = [];
    this.changeSeq = 0;

    this.createdAt = Date.now();
    this.updatedAt = Date.now();
  }

  get connected() {
    return this.agentId !== null;
  }

  get fileCount() {
    return this.files.size;
  }

  /** Replaces or extends the file index from a manifest chunk. */
  ingestManifest(entries, { reset = false } = {}) {
    if (reset) {
      this.files.clear();
      this.indexedBytes = 0;
    }
    for (const raw of entries) {
      const entry = normaliseEntry(raw);
      if (!entry) continue;
      const previous = this.files.get(entry.path);
      if (previous) this.indexedBytes -= previous.size;
      this.files.set(entry.path, entry);
      this.indexedBytes += entry.size;
    }
    this.updatedAt = Date.now();
  }

  /** Called when the manifest has been fully delivered. */
  finishIndex({ skipped, git, project } = {}) {
    this.indexComplete = true;
    this.indexedAt = Date.now();
    if (skipped) this.skipped = { ...this.skipped, ...skipped };
    if (git) this.git = { ...this.git, ...git };
    if (project) this.project = { ...this.project, ...project };

    const commands = detectVerificationCommands({
      topLevelFiles: this.project.topLevelFiles || [],
      packageJson: this.project.packageJson || null,
      allPaths: [...this.files.keys()]
    });
    // Verification is only enforced for folders. Opening one loose file to ask
    // a question about it should not demand a build.
    this.verification.setCommands(commands, { enforced: this.kind === 'folder' });

    log.info(
      `Indexed ${this.name}: ${this.files.size} files, ${commands.length} verification command(s), ` +
        `enforced=${this.verification.enforced}`
    );
  }

  getFile(relPath) {
    return this.files.get(relPath) || null;
  }

  /**
   * Applies an index update reported by the agent (a write we made, or an
   * external change the watcher saw).
   *
   * @param {object} change
   * @param {'created'|'updated'|'deleted'|'moved'} change.type
   * @param {string} change.path
   * @param {string} [change.fromPath] For moves.
   * @param {'mcp'|'user'|'external'} change.actor
   */
  applyChange(change) {
    const { type, path: relPath } = change;

    if (type === 'deleted') {
      const existing = this.files.get(relPath);
      if (existing) this.indexedBytes -= existing.size;
      this.files.delete(relPath);
    } else if (type === 'moved') {
      const existing = this.files.get(change.fromPath);
      if (existing) {
        this.files.delete(change.fromPath);
        this.files.set(relPath, { ...existing, path: relPath, ext: extName(relPath), language: languageForExt(extName(relPath)) });
      }
    } else {
      const entry = normaliseEntry(change.entry || change);
      if (entry) {
        const previous = this.files.get(entry.path);
        if (previous) this.indexedBytes -= previous.size;
        this.files.set(entry.path, entry);
        this.indexedBytes += entry.size;
      }
    }

    this.changeSeq += 1;
    this.changeLog.unshift({
      seq: this.changeSeq,
      at: Date.now(),
      type,
      path: relPath,
      fromPath: change.fromPath,
      revision: change.revision ?? change.entry?.revision ?? null,
      actor: change.actor || 'external',
      actorName: change.actorName || null,
      summary: change.summary || null
    });
    if (this.changeLog.length > CHANGE_LOG_LIMIT) this.changeLog.length = CHANGE_LOG_LIMIT;
    this.updatedAt = Date.now();
  }

  /** Change-log entries newer than `sinceSeq`, oldest first. */
  changesSince(sinceSeq = 0) {
    return this.changeLog.filter((c) => c.seq > sinceSeq).reverse();
  }

  /** Aggregate counts by extension, for the workspace overview. */
  languageBreakdown(limit = 12) {
    const counts = new Map();
    for (const file of this.files.values()) {
      const key = file.ext || '(no extension)';
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([ext, count]) => ({ ext, count }));
  }

  /** Immediate children of a directory, for tree listings. */
  listDirectory(relDir) {
    const dirs = new Set();
    const files = [];
    const prefix = relDir ? `${relDir}/` : '';

    for (const entry of this.files.values()) {
      if (prefix && !entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf('/');
      if (slash === -1) {
        files.push(entry);
      } else {
        dirs.add(rest.slice(0, slash));
      }
    }

    return {
      directories: [...dirs].sort((a, b) => a.localeCompare(b)),
      files: files.sort((a, b) => a.path.localeCompare(b.path))
    };
  }

  /** Compact JSON view for the API and for MCP tool output. */
  toJSON({ includeVerification = true } = {}) {
    return {
      id: this.id,
      name: this.name,
      rootPath: this.rootPath,
      kind: this.kind,
      connected: this.connected,
      fileCount: this.files.size,
      indexedBytes: this.indexedBytes,
      indexComplete: this.indexComplete,
      indexedAt: this.indexedAt,
      skipped: this.skipped,
      git: this.git,
      project: {
        packageManager: this.project.packageManager,
        topLevelFiles: this.project.topLevelFiles,
        frameworks: this.project.frameworks,
        name: this.project.packageJson?.name ?? null,
        scripts: this.project.packageJson?.scripts ?? null
      },
      ...(includeVerification ? { verification: this.verification.toJSON() } : {}),
      latestChangeSeq: this.changeSeq,
      updatedAt: this.updatedAt
    };
  }
}

function normaliseEntry(raw) {
  if (!raw || typeof raw.path !== 'string' || !raw.path) return null;
  const ext = extName(raw.path);
  return {
    path: raw.path,
    size: Number.isFinite(raw.size) ? raw.size : 0,
    revision: typeof raw.revision === 'string' ? raw.revision : '',
    mtime: Number.isFinite(raw.mtime) ? raw.mtime : Date.now(),
    binary: Boolean(raw.binary),
    dirty: Boolean(raw.dirty),
    ext,
    language: languageForExt(ext)
  };
}

/**
 * All open workspaces, across all users and all connected desktop agents.
 *
 * Workspaces are intentionally *not* persisted. A workspace is a live thing: it
 * exists because an editor has that folder open and can service reads and
 * writes for it. Persisting one would mean advertising a workspace to an MCP
 * client that nothing can actually serve.
 */
export class WorkspaceRegistry {
  constructor({ contentCache }) {
    /** @type {Map<string, Workspace>} */
    this.workspaces = new Map();
    this.contentCache = contentCache;
    /** @type {Set<(event: object) => void>} */
    this.listeners = new Set();
  }

  /** Subscribe to registry events (used to push updates to the desktop UI). */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn('Workspace listener threw', err);
      }
    }
  }

  /**
   * Registers a newly opened workspace.
   * @returns {Workspace}
   */
  register({ userId, agentId, name, rootPath, kind }) {
    if (kind !== 'folder' && kind !== 'file') {
      throw badRequest(`Workspace kind must be "folder" or "file", got "${kind}".`);
    }

    // Re-opening the same path from the same agent reuses the id, so an MCP
    // client that has been told a workspace id does not lose it on a refresh.
    const existing = [...this.workspaces.values()].find(
      (w) => w.userId === userId && w.rootPath === rootPath && w.agentId === agentId
    );
    if (existing) {
      existing.files.clear();
      existing.indexedBytes = 0;
      existing.indexComplete = false;
      log.info(`Re-indexing existing workspace ${existing.id} (${rootPath})`);
      return existing;
    }

    const workspace = new Workspace({
      id: prefixedId('ws'),
      userId,
      agentId,
      name,
      rootPath,
      kind
    });
    this.workspaces.set(workspace.id, workspace);
    log.info(`Opened workspace ${workspace.id}: ${rootPath} (${kind})`);
    this.emit({ type: 'workspace-opened', workspaceId: workspace.id, userId });
    return workspace;
  }

  close(workspaceId) {
    const workspace = this.workspaces.get(workspaceId);
    if (!workspace) return false;
    this.workspaces.delete(workspaceId);
    this.contentCache.dropWorkspace(workspaceId);
    log.info(`Closed workspace ${workspaceId} (${workspace.rootPath})`);
    this.emit({ type: 'workspace-closed', workspaceId, userId: workspace.userId });
    return true;
  }

  /** Closes every workspace owned by a disconnected agent. */
  closeForAgent(agentId) {
    const closed = [];
    for (const workspace of [...this.workspaces.values()]) {
      if (workspace.agentId === agentId) {
        this.close(workspace.id);
        closed.push(workspace.id);
      }
    }
    return closed;
  }

  listForUser(userId) {
    return [...this.workspaces.values()].filter((w) => w.userId === userId);
  }

  /**
   * Looks up a workspace, enforcing ownership.
   * @throws {AppError} NOT_FOUND when it does not exist or belongs to someone else
   */
  get(workspaceId, userId) {
    const workspace = this.workspaces.get(workspaceId);
    // Same error either way: a caller must not be able to probe for the
    // existence of another user's workspace ids.
    if (!workspace || workspace.userId !== userId) {
      throw notFound(`No open workspace with id "${workspaceId}".`);
    }
    return workspace;
  }

  /**
   * Resolves the workspace a tool call should act on.
   *
   * When the user has exactly one thing open, requiring the model to name it
   * every time is friction with no benefit, so we default to it. When there are
   * several, we refuse and list them rather than guessing, because guessing
   * wrong here means writing a file into the wrong project.
   *
   * @param {string} userId
   * @param {string} [workspaceId]
   * @returns {Workspace}
   */
  resolve(userId, workspaceId) {
    if (workspaceId) return this.get(workspaceId, userId);

    const open = this.listForUser(userId);
    if (open.length === 1) return open[0];

    if (open.length === 0) {
      throw unavailable(
        'No workspace is open. Open a folder or file in the CodeWriter desktop app, then try again.'
      );
    }

    throw badRequest(
      `Several workspaces are open, so "workspaceId" is required. Open workspaces: ` +
        open.map((w) => `${w.id} (${w.name})`).join(', ')
    );
  }

  /** Total indexed files across everything open, for the status bar. */
  stats() {
    let files = 0;
    let bytes = 0;
    for (const workspace of this.workspaces.values()) {
      files += workspace.files.size;
      bytes += workspace.indexedBytes;
    }
    return { workspaces: this.workspaces.size, files, bytes };
  }
}

export { config };

/** Convenience for tools that need the parent directory listing of a path. */
export function parentOf(relPath) {
  return dirName(relPath);
}
