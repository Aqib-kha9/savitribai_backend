import type { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, BadRequestError, mapDatabaseError } from '../core/errors.js';
import type { PgErrorLike } from '../core/pg-error.js';
import { logger } from '../core/logger.js';

/**
 * Terminal error handling (docs/backend-master-spec.md §2.4, §28.10).
 * Every error response uses the envelope:
 *   { "error": { "code": string, "message": string, "requestId": string } }
 * Operational AppErrors surface verbatim (with optional `details`); anything
 * else is logged and returned as a generic 500 so internals never leak.
 */

const PG_VIOLATION_CODES = new Set(['23505', '23503', '23514', '40001', '23P01']);

function toRequestId(value: unknown): string {
  return typeof value === 'string' && value.length > 0 ? value : 'unknown';
}

function isPgViolation(error: unknown): error is PgErrorLike {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && PG_VIOLATION_CODES.has(code);
}

/** Maps non-AppError HTTP-styled failures (e.g. body-parser) onto the hierarchy. */
function fromHttpStyleError(error: unknown): AppError | null {
  if (typeof error !== 'object' || error === null) return null;
  const candidate = error as {
    status?: unknown;
    statusCode?: unknown;
    type?: unknown;
  };
  const status =
    typeof candidate.status === 'number'
      ? candidate.status
      : typeof candidate.statusCode === 'number'
        ? candidate.statusCode
        : 0;
  if (status < 400 || status >= 500) return null;
  if (candidate.type === 'entity.parse.failed') {
    return new BadRequestError('Malformed JSON body', 'INVALID_JSON');
  }
  return new BadRequestError('Request could not be processed');
}

export const notFoundHandler: RequestHandler = (request, response) => {
  response.status(404).json({
    error: {
      code: 'NOT_FOUND',
      message: 'Resource not found',
      requestId: toRequestId(request.id),
    },
  });
};

/**
 * Express error middleware — the 4-parameter signature is what marks it as an
 * error handler in Express. Registered LAST, after all routes.
 */
export const errorHandler: ErrorRequestHandler = (error, request, response, next) => {
  if (response.headersSent) {
    // Can no longer shape the response — delegate to the platform default.
    next(error);
    return;
  }

  const appError: AppError =
    error instanceof AppError
      ? error
      : isPgViolation(error)
        ? mapDatabaseError(error) ?? new AppError(500, 'INTERNAL_ERROR', 'An internal error occurred', undefined, false)
        : fromHttpStyleError(error) ?? new AppError(500, 'INTERNAL_ERROR', 'An internal error occurred', undefined, false);

  const requestId = toRequestId(request.id);
  const body = {
    error: {
      code: appError.code,
      message: appError.message,
      requestId,
      ...(appError.details !== undefined ? { details: appError.details } : {}),
    },
  };

  response.status(appError.statusCode);

  if (appError.statusCode === 429) {
    const details = appError.details as { retryAfterSeconds?: unknown } | undefined;
    if (typeof details?.retryAfterSeconds === 'number') {
      response.setHeader('Retry-After', String(details.retryAfterSeconds));
    }
  }

  response.json(body);

  const logFields = {
    requestId,
    method: request.method,
    path: request.originalUrl,
    status: appError.statusCode,
    code: appError.code,
  };

  if (appError.statusCode >= 500) {
    logger.error({ ...logFields, err: error }, 'request failed');
  } else {
    logger.warn(logFields, `request rejected: ${appError.code}`);
  }
};
