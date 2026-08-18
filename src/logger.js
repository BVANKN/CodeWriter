import config from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

const ESC = '\u001b[';
const COLORS = {
  debug: `${ESC}90m`,
  info: `${ESC}36m`,
  warn: `${ESC}33m`,
  error: `${ESC}31m`
};
const RESET = `${ESC}0m`;
const useColor = process.stdout.isTTY;

function emit(level, scope, message, detail) {
  if (LEVELS[level] < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const tag = level.toUpperCase().padEnd(5);
  const head = useColor ? `${COLORS[level]}${tag}${RESET}` : tag;
  const line = `${stamp} ${head} [${scope}] ${message}`;
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  if (detail === undefined) {
    stream.write(line + '\n');
  } else {
    stream.write(`${line} ${safeInspect(detail)}\n`);
  }
}

function safeInspect(value) {
  if (value instanceof Error) {
    return `${value.name}: ${value.message}${value.stack ? '\n' + value.stack : ''}`;
  }
  try {
    return JSON.stringify(value, replacer);
  } catch {
    return String(value);
  }
}

// Never let a secret reach the log, even accidentally.
const SECRET_KEYS =
  /^(password|secret|client_secret|token|access_token|refresh_token|authorization|code_verifier|appToken)$/i;

function replacer(key, value) {
  if (SECRET_KEYS.test(key) && typeof value === 'string') return 'redacted';
  if (typeof value === 'string' && value.length > 500) {
    return value.slice(0, 500) + `...(${value.length} chars)`;
  }
  return value;
}

export function createLogger(scope) {
  return {
    debug: (message, detail) => emit('debug', scope, message, detail),
    info: (message, detail) => emit('info', scope, message, detail),
    warn: (message, detail) => emit('warn', scope, message, detail),
    error: (message, detail) => emit('error', scope, message, detail),
    child: (sub) => createLogger(`${scope}:${sub}`)
  };
}

export default createLogger;
