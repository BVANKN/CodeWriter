import { badRequest } from './errors.js';

/**
 * Every path that crosses a CodeWriter boundary is a *relative POSIX path*
 * rooted at the workspace directory: `src/app/main.js`, never `/Users/...` and
 * never `..\\..\\etc`. The backend never sees or stores absolute paths for file
 * operations, and the Electron agent re-validates independently before it
 * touches the disk. Both sides run this check; neither trusts the other.
 *
 * @param {unknown} input
 * @param {string} [label] Used in the error message.
 * @returns {string} The normalised relative path.
 */
export function normalizeRelPath(input, label = 'path') {
  if (typeof input !== 'string') {
    throw badRequest(`${label} must be a string.`);
  }
  let p = input.trim();
  if (!p) throw badRequest(`${label} must not be empty.`);

  if (p.includes('\0')) {
    throw badRequest(`${label} must not contain null bytes.`);
  }

  // Accept Windows-style separators from clients, normalise to POSIX.
  p = p.replace(/\\/g, '/');

  if (/^[a-zA-Z]:\//.test(p)) {
    throw badRequest(`${label} must be relative to the workspace root, but looks like a Windows absolute path: "${input}"`);
  }
  if (p.startsWith('/')) {
    throw badRequest(`${label} must be relative to the workspace root, not absolute: "${input}"`);
  }
  if (p.startsWith('~')) {
    throw badRequest(`${label} must not start with "~": "${input}"`);
  }

  const segments = [];
  for (const segment of p.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      throw badRequest(`${label} must not escape the workspace root with "..": "${input}"`);
    }
    segments.push(segment);
  }
  if (!segments.length) {
    throw badRequest(`${label} resolved to the workspace root itself, which is not a file: "${input}"`);
  }

  return segments.join('/');
}

/** Like {@link normalizeRelPath} but allows the empty path, meaning "the root". */
export function normalizeRelDir(input, label = 'path') {
  if (input === undefined || input === null || input === '' || input === '.' || input === '/') return '';
  return normalizeRelPath(input, label);
}

/** True when `child` is `parent` itself or lives underneath it. Both relative POSIX. */
export function isUnder(parent, child) {
  if (parent === '') return true;
  return child === parent || child.startsWith(parent + '/');
}

/** The `a/b/c.js` -> `c.js` part. */
export function baseName(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? relPath : relPath.slice(idx + 1);
}

/** The `a/b/c.js` -> `a/b` part. Empty string at the root. */
export function dirName(relPath) {
  const idx = relPath.lastIndexOf('/');
  return idx === -1 ? '' : relPath.slice(0, idx);
}

/** Lowercased extension including the dot, or '' when there is none. */
export function extName(relPath) {
  const base = baseName(relPath);
  const idx = base.lastIndexOf('.');
  if (idx <= 0) return '';
  return base.slice(idx).toLowerCase();
}

/**
 * Compiles a glob into a RegExp. Supports the subset that matters for source
 * trees: `*` (no slash), `**` (any depth), `?`, `[abc]`, and `{a,b}` groups.
 *
 * @param {string} glob
 * @returns {RegExp}
 */
export function globToRegExp(glob) {
  let out = '';
  let i = 0;
  const braceStack = [];

  while (i < glob.length) {
    const ch = glob[i];

    if (ch === '*') {
      const isDouble = glob[i + 1] === '*';
      if (isDouble) {
        const nextIsSlash = glob[i + 2] === '/';
        if (nextIsSlash) {
          // `**/` matches zero or more leading directories.
          out += '(?:[^/]*\\/)*';
          i += 3;
        } else {
          out += '.*';
          i += 2;
        }
      } else {
        out += '[^/]*';
        i += 1;
      }
      continue;
    }

    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }

    if (ch === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close === -1) {
        out += '\\[';
        i += 1;
        continue;
      }
      let set = glob.slice(i + 1, close);
      let negate = '';
      if (set.startsWith('!') || set.startsWith('^')) {
        negate = '^';
        set = set.slice(1);
      }
      out += `[${negate}${set.replace(/\\/g, '\\\\')}]`;
      i = close + 1;
      continue;
    }

    if (ch === '{') {
      braceStack.push(true);
      out += '(?:';
      i += 1;
      continue;
    }
    if (ch === '}' && braceStack.length) {
      braceStack.pop();
      out += ')';
      i += 1;
      continue;
    }
    if (ch === ',' && braceStack.length) {
      out += '|';
      i += 1;
      continue;
    }

    out += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    i += 1;
  }

  return new RegExp(`^${out}$`);
}

/**
 * Builds a matcher from a list of globs. An empty or absent list matches
 * everything. Globs prefixed with `!` are exclusions applied after includes.
 *
 * @param {string[] | undefined} globs
 * @returns {(relPath: string) => boolean}
 */
export function buildGlobMatcher(globs) {
  if (!globs || !globs.length) return () => true;

  const includes = [];
  const excludes = [];
  for (const raw of globs) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    const glob = raw.trim();
    if (glob.startsWith('!')) {
      excludes.push(globToRegExp(glob.slice(1)));
    } else {
      includes.push(globToRegExp(glob));
    }
  }

  return (relPath) => {
    if (excludes.some((re) => re.test(relPath))) return false;
    if (!includes.length) return true;
    return includes.some((re) => re.test(relPath));
  };
}
