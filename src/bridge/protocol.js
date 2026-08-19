/**
 * The wire protocol between the backend and the CodeWriter desktop agent.
 *
 * It is a small JSON-over-WebSocket protocol with three frame kinds:
 *
 *   `req` / `res`   Request/response, correlated by `id`. Either side may be
 *                   the requester, though in practice the backend asks and the
 *                   agent answers.
 *   `event`         Fire-and-forget, in both directions. Index updates and
 *                   command output flow up; MCP activity notifications flow
 *                   down so the desktop UI can show what the model is doing.
 *
 * Frames are kept deliberately flat and versioned so that a desktop app built
 * against an older backend fails with a clear message rather than by silently
 * misreading a field.
 */

export const PROTOCOL_VERSION = 1;

export const FRAME = {
  HELLO: 'hello',
  WELCOME: 'welcome',
  REQUEST: 'req',
  RESPONSE: 'res',
  EVENT: 'event'
};

/** Methods the backend invokes on the desktop agent. */
export const AGENT_METHOD = {
  READ_FILES: 'readFiles',
  WRITE_FILES: 'writeFiles',
  DELETE_FILES: 'deleteFiles',
  MOVE_FILE: 'moveFile',
  SEARCH: 'search',
  GIT_STATUS: 'gitStatus',
  GIT_DIFF: 'gitDiff',
  GIT_CHECKPOINT: 'gitCheckpoint',
  RUN_COMMAND: 'runCommand',
  CANCEL_COMMAND: 'cancelCommand',
  REINDEX: 'reindex',
  DESCRIBE_ENVIRONMENT: 'describeEnvironment',
  PING: 'ping'
};

/** Events the agent sends up to the backend. */
export const AGENT_EVENT = {
  WORKSPACE_OPENED: 'workspace-opened',
  MANIFEST_CHUNK: 'manifest-chunk',
  INDEX_COMPLETE: 'index-complete',
  FILE_CHANGED: 'file-changed',
  WORKSPACE_CLOSED: 'workspace-closed',
  COMMAND_OUTPUT: 'command-output',
  COMMAND_EXIT: 'command-exit',
  EDITOR_STATE: 'editor-state'
};

/** Events the backend pushes down to the agent, for display in the desktop UI. */
export const SERVER_EVENT = {
  MCP_ACTIVITY: 'mcp-activity',
  CHANGES_APPLIED: 'changes-applied',
  VERIFICATION_REQUIRED: 'verification-required',
  CLIENT_CONNECTED: 'client-connected',
  ERROR: 'error'
};

/**
 * Error codes the agent may return, which the backend translates into messages
 * an MCP client can act on rather than a generic failure.
 */
export const AGENT_ERROR = {
  NOT_FOUND: 'FILE_NOT_FOUND',
  OUTSIDE_ROOT: 'OUTSIDE_WORKSPACE_ROOT',
  BINARY: 'BINARY_FILE',
  TOO_LARGE: 'FILE_TOO_LARGE',
  REVISION_MISMATCH: 'REVISION_MISMATCH',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  REJECTED_BY_USER: 'REJECTED_BY_USER',
  COMMAND_NOT_ALLOWED: 'COMMAND_NOT_ALLOWED',
  COMMAND_TIMEOUT: 'COMMAND_TIMEOUT',
  WORKSPACE_GONE: 'WORKSPACE_GONE'
};

/** Rejects frames that are not shaped like anything we handle. */
export function isValidFrame(frame) {
  if (!frame || typeof frame !== 'object') return false;
  switch (frame.t) {
    case FRAME.HELLO:
    case FRAME.WELCOME:
      return true;
    case FRAME.REQUEST:
      return typeof frame.id === 'string' && typeof frame.method === 'string';
    case FRAME.RESPONSE:
      return typeof frame.id === 'string' && typeof frame.ok === 'boolean';
    case FRAME.EVENT:
      return typeof frame.event === 'string';
    default:
      return false;
  }
}
