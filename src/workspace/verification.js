import { createLogger } from '../logger.js';

const log = createLogger('verification');

/**
 * Verification is the difference between "the model wrote plausible code" and
 * "the change actually works".
 *
 * When a folder is opened (as opposed to a single loose file), CodeWriter works
 * out how this project is built and tested, and then *requires* the MCP client
 * to run those commands after it writes. The requirement is not a suggestion in
 * a prompt that a model may or may not follow: `finish_task` refuses to succeed
 * while any required command has not passed since the last write.
 *
 * Detection is conservative. We only propose a command when the project itself
 * declares it (a script in package.json, a Cargo manifest, a go.mod), because
 * inventing a build command that does not exist would fail every run for a
 * reason that has nothing to do with the model's change.
 */

/** @typedef {'typecheck'|'build'|'test'|'lint'} VerificationKind */

/**
 * The order matters: it is the order we ask the model to run things in, and it
 * is chosen so the fastest, most localised failure surfaces first. A type error
 * should not wait behind a full test suite.
 */
const KIND_ORDER = ['typecheck', 'build', 'lint', 'test'];

/**
 * Which package.json scripts map to which kind of check. Matched against the
 * script *name*, most specific first.
 */
const SCRIPT_PATTERNS = [
  { kind: 'typecheck', patterns: [/^typecheck$/i, /^type-check$/i, /^tsc$/i, /^types$/i, /^check-types$/i] },
  { kind: 'build', patterns: [/^build$/i, /^compile$/i, /^bundle$/i] },
  { kind: 'lint', patterns: [/^lint$/i, /^eslint$/i, /^check$/i] },
  { kind: 'test', patterns: [/^test$/i, /^tests$/i, /^test:unit$/i, /^unit$/i, /^vitest$/i, /^jest$/i] }
];

/** Scripts we must never auto-run: they are long-lived, destructive, or interactive. */
const SCRIPT_DENYLIST = [
  /^(dev|start|serve|watch|preview)$/i,
  /^.*:watch$/i,
  /^watch:.*/i,
  /^(deploy|publish|release|prepublish|prepublishOnly)$/i,
  /^(eject|clean|reset)$/i,
  /^(e2e|test:e2e|cypress|playwright)$/i,
  /^(postinstall|preinstall|prepare)$/i
];

/**
 * Picks the package manager from the lockfiles present. Using the wrong one is
 * not merely stylistic: `npm run` in a pnpm workspace can resolve a different
 * dependency tree than the one the project actually installs.
 */
export function detectPackageManager(filePaths) {
  const has = (name) => filePaths.includes(name);
  if (has('pnpm-lock.yaml')) return 'pnpm';
  if (has('yarn.lock')) return 'yarn';
  if (has('bun.lockb') || has('bun.lock')) return 'bun';
  return 'npm';
}

/**
 * Proposes verification commands for a project.
 *
 * @param {object} project
 * @param {string[]} project.topLevelFiles  File names at the workspace root.
 * @param {object|null} project.packageJson Parsed package.json, when present.
 * @param {string[]} [project.allPaths]     Every indexed relative path, for deeper signals.
 * @returns {Array<{ id: string, kind: VerificationKind, label: string, argv: string[], source: string, required: boolean }>}
 */
export function detectVerificationCommands({ topLevelFiles = [], packageJson = null, allPaths = [] }) {
  const commands = [];
  const seen = new Set();

  const add = (command) => {
    const id = command.argv.join(' ');
    if (seen.has(id)) return;
    seen.add(id);
    commands.push({ id, required: true, ...command });
  };

  // -- Node / JavaScript / TypeScript --------------------------------------
  if (packageJson && typeof packageJson.scripts === 'object' && packageJson.scripts) {
    const pm = detectPackageManager(topLevelFiles);
    const runPrefix = pm === 'npm' ? ['npm', 'run'] : pm === 'bun' ? ['bun', 'run'] : [pm, 'run'];
    const scriptNames = Object.keys(packageJson.scripts);

    for (const { kind, patterns } of SCRIPT_PATTERNS) {
      const match = scriptNames.find(
        (name) => patterns.some((re) => re.test(name)) && !SCRIPT_DENYLIST.some((re) => re.test(name))
      );
      if (!match) continue;

      const argv = [...runPrefix, match];
      // `npm test` and `npm run test` both work, but the explicit form is
      // unambiguous across package managers, so we always use `run`.
      add({
        kind,
        label: `${pm} run ${match}`,
        argv,
        source: `package.json scripts.${match}`
      });
    }

    // A TypeScript project with no typecheck script still benefits from one.
    const hasTsConfig = topLevelFiles.includes('tsconfig.json');
    const alreadyTypechecks = commands.some((c) => c.kind === 'typecheck');
    if (hasTsConfig && !alreadyTypechecks) {
      add({
        kind: 'typecheck',
        label: 'tsc --noEmit',
        argv: ['npx', '--no-install', 'tsc', '--noEmit'],
        source: 'tsconfig.json',
        // Not required: `tsc` may not be installed, and we do not want a hard
        // gate that fails for a reason unrelated to the model's change.
        required: false
      });
    }
  }

  // -- Rust ----------------------------------------------------------------
  if (topLevelFiles.includes('Cargo.toml')) {
    add({ kind: 'build', label: 'cargo check', argv: ['cargo', 'check'], source: 'Cargo.toml' });
    add({ kind: 'test', label: 'cargo test', argv: ['cargo', 'test'], source: 'Cargo.toml' });
  }

  // -- Go ------------------------------------------------------------------
  if (topLevelFiles.includes('go.mod')) {
    add({ kind: 'build', label: 'go build ./...', argv: ['go', 'build', './...'], source: 'go.mod' });
    add({ kind: 'test', label: 'go test ./...', argv: ['go', 'test', './...'], source: 'go.mod' });
  }

  // -- Python --------------------------------------------------------------
  const pyProject = topLevelFiles.includes('pyproject.toml');
  const hasPytestConfig =
    pyProject ||
    topLevelFiles.includes('pytest.ini') ||
    topLevelFiles.includes('tox.ini') ||
    topLevelFiles.includes('setup.cfg');
  const hasTests = allPaths.some((p) => /(^|\/)tests?\//.test(p) && p.endsWith('.py'));
  if (hasPytestConfig && hasTests) {
    add({ kind: 'test', label: 'pytest', argv: ['pytest', '-q'], source: 'pytest configuration' });
  }

  // -- Java / Kotlin -------------------------------------------------------
  if (topLevelFiles.includes('gradlew')) {
    add({ kind: 'build', label: './gradlew build', argv: ['./gradlew', 'build', '--console=plain'], source: 'gradlew' });
  } else if (topLevelFiles.includes('pom.xml')) {
    add({ kind: 'build', label: 'mvn -q verify', argv: ['mvn', '-q', 'verify'], source: 'pom.xml' });
  }

  commands.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  log.debug(`Detected ${commands.length} verification command(s)`, commands.map((c) => c.label));
  return commands;
}

/**
 * Tracks, per workspace, whether the code currently on disk has been verified
 * since the last write.
 *
 * The state machine is small on purpose:
 *
 *   clean --(write)--> dirty --(all required commands pass)--> clean
 *
 * A run only counts if it *started after* the write it is meant to verify. A
 * test run that began before the edit landed proves nothing about the edit,
 * and accepting it would be the easiest way for this whole mechanism to become
 * theatre.
 */
export class VerificationState {
  constructor() {
    /** Commands proposed for this workspace. */
    this.commands = [];
    /** Whether verification is enforced at all (folder workspaces with commands). */
    this.enforced = false;
    /** Timestamp of the most recent write, or null when nothing is pending. */
    this.lastWriteAt = null;
    /** Files touched since the last clean state, for the reminder message. */
    this.dirtyPaths = new Set();
    /** @type {Map<string, { commandId: string, ok: boolean, exitCode: number, startedAt: number, finishedAt: number, summary: string }>} */
    this.lastRunByCommand = new Map();
    /** Rolling history for the UI. */
    this.history = [];
  }

  setCommands(commands, { enforced }) {
    this.commands = commands;
    this.enforced = enforced && commands.some((c) => c.required);
  }

  /** Commands whose success is required before a task may be declared complete. */
  requiredCommands() {
    return this.commands.filter((c) => c.required);
  }

  /** Records that files changed, which invalidates any earlier verification. */
  markDirty(paths) {
    this.lastWriteAt = Date.now();
    for (const path of paths) this.dirtyPaths.add(path);
  }

  /** Records the outcome of a command run. */
  recordRun(run) {
    this.lastRunByCommand.set(run.commandId, run);
    this.history.unshift(run);
    if (this.history.length > 50) this.history.length = 50;
  }

  /**
   * @returns {{ satisfied: boolean, pending: object[], failed: object[], stale: object[] }}
   *   `pending` never ran, `stale` ran before the last write, `failed` ran and
   *   exited non-zero.
   */
  evaluate() {
    if (!this.enforced || this.lastWriteAt === null) {
      return { satisfied: true, pending: [], failed: [], stale: [] };
    }

    const pending = [];
    const failed = [];
    const stale = [];

    for (const command of this.requiredCommands()) {
      const run = this.lastRunByCommand.get(command.id);
      if (!run) {
        pending.push(command);
        continue;
      }
      if (run.startedAt <= this.lastWriteAt) {
        stale.push({ ...command, lastRun: run });
        continue;
      }
      if (!run.ok) {
        failed.push({ ...command, lastRun: run });
      }
    }

    return {
      satisfied: pending.length === 0 && failed.length === 0 && stale.length === 0,
      pending,
      failed,
      stale
    };
  }

  /** Called once every required command has passed after the last write. */
  markClean() {
    this.lastWriteAt = null;
    this.dirtyPaths.clear();
  }

  /** Snapshot for the API and the UI. */
  toJSON() {
    const evaluation = this.evaluate();
    return {
      enforced: this.enforced,
      commands: this.commands,
      lastWriteAt: this.lastWriteAt,
      dirtyPaths: [...this.dirtyPaths],
      satisfied: evaluation.satisfied,
      pending: evaluation.pending.map((c) => c.id),
      failed: evaluation.failed.map((c) => c.id),
      stale: evaluation.stale.map((c) => c.id),
      lastRuns: [...this.lastRunByCommand.values()],
      history: this.history.slice(0, 20)
    };
  }
}
