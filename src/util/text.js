/**
 * Heuristic binary sniff. A NUL byte in the first 8 KiB is the classic signal
 * (it is what git itself uses); we also bail out when the ratio of bytes that
 * are neither printable ASCII nor valid UTF-8 continuation is implausible for
 * source code.
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
export function looksBinary(buf) {
  const len = Math.min(buf.length, 8192);
  if (len === 0) return false;

  let suspicious = 0;
  for (let i = 0; i < len; i += 1) {
    const byte = buf[i];
    if (byte === 0) return true;
    // Control characters other than tab, LF, CR, FF, ESC.
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13 && byte !== 12 && byte !== 27) {
      suspicious += 1;
    }
  }
  return suspicious / len > 0.3;
}

/** Counts lines the way an editor does: content with no trailing newline still has a last line. */
export function countLines(text) {
  if (text === '') return 0;
  let count = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) count += 1;
  }
  // A trailing newline does not open a new line for our purposes.
  if (text.charCodeAt(text.length - 1) === 10) count -= 1;
  return count;
}

/** Detects the dominant line ending so writes can preserve the file's style. */
export function detectEol(text) {
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(?<!\r)\n/g) || []).length;
  return crlf > lf ? 'crlf' : 'lf';
}

/** Whether the text ends with a newline, so writes can preserve that too. */
export function hasTrailingNewline(text) {
  return text.length > 0 && text.endsWith('\n');
}

/**
 * Slices a 1-indexed, inclusive line range out of a document.
 * @returns {{ text: string, startLine: number, endLine: number, totalLines: number }}
 */
export function sliceLines(text, startLine, endLine) {
  const lines = text.split('\n');
  const hadTrailing = lines.length > 1 && lines[lines.length - 1] === '';
  if (hadTrailing) lines.pop();

  const total = lines.length;
  const start = Math.max(1, Math.min(startLine ?? 1, total || 1));
  const end = Math.max(start, Math.min(endLine ?? total, total));
  return {
    text: lines.slice(start - 1, end).join('\n'),
    startLine: start,
    endLine: end,
    totalLines: total
  };
}

/** Prefixes each line with a right-aligned line number, as `  12 | code`. */
export function withLineNumbers(text, startLine = 1) {
  const lines = text.split('\n');
  const width = String(startLine + lines.length - 1).length;
  return lines.map((line, i) => `${String(startLine + i).padStart(width, ' ')} | ${line}`).join('\n');
}

/**
 * Truncates to a byte budget on a line boundary, appending an explicit marker
 * so a model can never mistake a truncated file for a complete one. This
 * matters: a model that thinks it has the whole file will happily return a
 * "full rewrite" that silently deletes the tail.
 *
 * @returns {{ text: string, truncated: boolean, omittedLines: number, returnedLines: number }}
 */
export function truncateToBytes(text, maxBytes) {
  const size = Buffer.byteLength(text, 'utf8');
  if (size <= maxBytes) {
    return { text, truncated: false, omittedLines: 0, returnedLines: countLines(text) };
  }

  const lines = text.split('\n');
  const kept = [];
  let used = 0;
  for (const line of lines) {
    const cost = Buffer.byteLength(line, 'utf8') + 1;
    if (used + cost > maxBytes) break;
    kept.push(line);
    used += cost;
  }

  const omitted = lines.length - kept.length;
  return {
    text: kept.join('\n'),
    truncated: true,
    omittedLines: omitted,
    returnedLines: kept.length
  };
}

/**
 * A cheap line-level diff summary (added/removed counts plus the first changed
 * line). Used for the change log in the UI and for write confirmations; it is
 * not a patch format and nothing depends on it being minimal.
 */
export function diffSummary(before, after) {
  if (before === after) {
    return { changed: false, added: 0, removed: 0, firstChangedLine: null };
  }
  const a = before.split('\n');
  const b = after.split('\n');

  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;

  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  return {
    changed: true,
    added: Math.max(0, b.length - prefix - suffix),
    removed: Math.max(0, a.length - prefix - suffix),
    firstChangedLine: prefix + 1
  };
}

/** Human byte sizes for logs and tool output. */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Maps an extension to a language id for syntax highlighting and fenced blocks. */
const LANGUAGE_BY_EXT = {
  '.js': 'javascript', '.jsx': 'javascript', '.mjs': 'javascript', '.cjs': 'javascript',
  '.ts': 'typescript', '.tsx': 'typescript', '.mts': 'typescript', '.cts': 'typescript',
  '.json': 'json', '.jsonc': 'json', '.json5': 'json',
  '.css': 'css', '.scss': 'scss', '.sass': 'scss', '.less': 'less',
  '.html': 'html', '.htm': 'html', '.vue': 'html', '.svelte': 'html',
  '.md': 'markdown', '.mdx': 'markdown', '.markdown': 'markdown',
  '.py': 'python', '.rb': 'ruby', '.go': 'go', '.rs': 'rust',
  '.java': 'java', '.kt': 'kotlin', '.kts': 'kotlin', '.scala': 'scala',
  '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.cc': 'cpp', '.hpp': 'cpp', '.cxx': 'cpp',
  '.cs': 'csharp', '.php': 'php', '.swift': 'swift', '.m': 'objective-c',
  '.sh': 'shell', '.bash': 'shell', '.zsh': 'shell', '.fish': 'shell',
  '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml', '.ini': 'ini',
  '.xml': 'xml', '.svg': 'xml', '.sql': 'sql', '.graphql': 'graphql', '.gql': 'graphql',
  '.dockerfile': 'dockerfile', '.tf': 'hcl', '.lua': 'lua', '.r': 'r', '.dart': 'dart'
};

export function languageForExt(ext) {
  return LANGUAGE_BY_EXT[ext] || 'plaintext';
}
