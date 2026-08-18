import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../logger.js';

const log = createLogger('store');

/**
 * A tiny durable JSON document store. There is no database in CodeWriter by
 * design, so this has to be careful about the three ways a plain
 * `writeFile(JSON.stringify(...))` loses data:
 *
 *   1. A crash mid-write truncates the file. We write to `<file>.tmp` and
 *      `rename()` it over the target, which is atomic on APFS/HFS+ and ext4.
 *   2. Concurrent writers interleave. Every write goes through a single
 *      promise chain per file, so writes are serialised.
 *   3. A corrupt file on boot takes the server down. We move the bad file
 *      aside as `<file>.corrupt-<timestamp>` and start from the default.
 *
 * Writes are debounced: callers mutate `store.data` freely and call
 * `store.save()`, which coalesces bursts into one flush.
 */
export class JsonStore {
  /**
   * @param {string} filePath Absolute path to the JSON file.
   * @param {object} defaultValue Value used when the file does not exist.
   * @param {object} [options]
   * @param {number} [options.debounceMs] Coalescing window for save(). 0 writes immediately.
   */
  constructor(filePath, defaultValue, options = {}) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.tmp`;
    this.debounceMs = options.debounceMs ?? 150;
    this.defaultValue = defaultValue;

    this.data = this.#load();

    this.#queue = Promise.resolve();
    this.#timer = null;
    this.#pending = null;
  }

  #queue;
  #timer;
  #pending;

  #load() {
    try {
      if (!fs.existsSync(this.filePath)) {
        return structuredClone(this.defaultValue);
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      if (!raw.trim()) return structuredClone(this.defaultValue);
      const parsed = JSON.parse(raw);
      // Merge onto the default so a field added in a later version of the app
      // is present even in a file written by an older one.
      return { ...structuredClone(this.defaultValue), ...parsed };
    } catch (err) {
      const backup = `${this.filePath}.corrupt-${Date.now()}`;
      log.error(`Could not parse ${path.basename(this.filePath)}; moving it to ${path.basename(backup)}`, err);
      try {
        fs.renameSync(this.filePath, backup);
      } catch (renameErr) {
        log.error('Failed to move the corrupt file aside', renameErr);
      }
      return structuredClone(this.defaultValue);
    }
  }

  /** Schedules a debounced atomic write. Returns a promise for that write. */
  save() {
    if (this.debounceMs === 0) return this.flush();

    if (!this.#pending) {
      let resolve;
      let reject;
      const promise = new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      });
      this.#pending = { promise, resolve, reject };
    }

    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const pending = this.#pending;
      this.#pending = null;
      this.flush().then(pending.resolve, pending.reject);
    }, this.debounceMs);
    // Deliberately NOT unref()d: a pending write must not be lost if the
    // process is about to exit. Shutdown calls close(), which flushes.

    return this.#pending.promise;
  }

  /** Writes immediately, waiting for any in-flight write to finish first. */
  flush() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = null;
      const pending = this.#pending;
      this.#pending = null;
      if (pending) pending.resolve();
    }

    this.#queue = this.#queue.then(
      () => this.#write(),
      () => this.#write()
    );
    return this.#queue;
  }

  async #write() {
    const serialised = JSON.stringify(this.data, null, 2);
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await fsp.open(this.tmpPath, 'w');
    try {
      await handle.writeFile(serialised, 'utf8');
      // fsync before rename: rename is atomic, but only durable once the data
      // it points at has actually reached the disk.
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fsp.rename(this.tmpPath, this.filePath);
  }

  /** Flushes and stops the debounce timer. Call on shutdown. */
  async close() {
    await this.flush();
  }
}

/**
 * Opens (or creates) a JSON store inside the configured data directory.
 * @param {string} dataDir
 * @param {string} fileName
 * @param {object} defaultValue
 * @param {object} [options]
 */
export function openStore(dataDir, fileName, defaultValue, options) {
  fs.mkdirSync(dataDir, { recursive: true });
  return new JsonStore(path.join(dataDir, fileName), defaultValue, options);
}
