/**
 * A typed error we are willing to show to an API caller or an MCP client.
 * Anything that is not an AppError is treated as internal and its message is
 * never leaked to the caller.
 */
export class AppError extends Error {
  /**
   * @param {string} code     Stable machine-readable code, e.g. `WORKSPACE_NOT_FOUND`.
   * @param {string} message  Human-readable explanation, safe to expose.
   * @param {object} [options]
   * @param {number} [options.status]  HTTP status to use when thrown from a route.
   * @param {Record<string, unknown>} [options.details] Extra structured context.
   * @param {unknown} [options.cause]
   */
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'AppError';
    this.code = code;
    this.status = options.status ?? 400;
    this.details = options.details;
    this.expose = true;
  }

  toJSON() {
    return {
      error: this.code,
      message: this.message,
      ...(this.details ? { details: this.details } : {})
    };
  }
}

export const notFound = (message, details) => new AppError('NOT_FOUND', message, { status: 404, details });
export const badRequest = (message, details) => new AppError('BAD_REQUEST', message, { status: 400, details });
export const unauthorized = (message, details) => new AppError('UNAUTHORIZED', message, { status: 401, details });
export const forbidden = (message, details) => new AppError('FORBIDDEN', message, { status: 403, details });
export const conflict = (message, details) => new AppError('CONFLICT', message, { status: 409, details });
export const unavailable = (message, details) => new AppError('UNAVAILABLE', message, { status: 503, details });
export const tooLarge = (message, details) => new AppError('TOO_LARGE', message, { status: 413, details });

/** Express error handler. Keep this last in the middleware chain. */
export function errorMiddleware(logger) {
  // eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity.
  return (err, req, res, _next) => {
    if (err instanceof AppError) {
      logger.debug(`${req.method} ${req.path} -> ${err.status} ${err.code}`, err.message);
      if (res.headersSent) return;
      res.status(err.status).json(err.toJSON());
      return;
    }
    logger.error(`Unhandled error on ${req.method} ${req.path}`, err);
    if (res.headersSent) return;
    res.status(500).json({ error: 'INTERNAL', message: 'Internal server error.' });
  };
}

/** Wraps an async Express handler so rejections reach the error middleware. */
export function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
