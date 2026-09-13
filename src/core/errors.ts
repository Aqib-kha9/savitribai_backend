/**
 * Structured application error hierarchy.
 * Every error surfaced to a client uses the envelope:
 *   { "error": { "code": string, "message": string, "requestId": string } }
 * (docs/backend-master-spec.md §2.4, §28.10)
 */

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: string;
  public readonly details?: unknown;
  public readonly isOperational: boolean;

  constructor(statusCode: number, code: string, message: string, details?: unknown, isOperational = true) {
    super(message);
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** 400 — malformed or invalid request payload (outside schema validation). */
export class BadRequestError extends AppError {
  constructor(message = 'Bad request', details?: unknown) {
    super(400, 'BAD_REQUEST', message, details);
  }
}

/** 400 — Zod schema validation failure. */
export class ValidationError extends AppError {
  constructor(message = 'Validation failed', details?: unknown) {
    super(400, 'VALIDATION_ERROR', message, details);
  }
}

/** 401 — authentication required / failed. Generic messages only (§28.10). */
export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', code = 'UNAUTHORIZED', details?: unknown) {
    super(401, code, message, details);
  }
}

export class InvalidCredentialsError extends UnauthorizedError {
  constructor() {
    super('Invalid staff code or password', 'AUTH_INVALID_CREDENTIALS');
  }
}

export class AccountLockedError extends UnauthorizedError {
  constructor(lockedUntil: string) {
    super('Account is locked. Contact the Managing Director to unlock.', 'AUTH_LOCKED_OUT', { lockedUntil });
  }
}

export class SessionExpiredError extends UnauthorizedError {
  constructor() {
    super('Session expired. Please sign in again.', 'AUTH_SESSION_EXPIRED');
  }
}

export class RefreshTokenError extends UnauthorizedError {
  constructor(message = 'Invalid refresh token', code = 'AUTH_REFRESH_INVALID') {
    super(message, code);
  }
}

export class DevicePendingError extends UnauthorizedError {
  constructor(deviceId: string) {
    super('New device requires confirmation before sign-in.', 'AUTH_DEVICE_PENDING', { deviceId });
  }
}

export class DeviceDisabledError extends UnauthorizedError {
  constructor() {
    super('This device has been disabled.', 'AUTH_DEVICE_DISABLED');
  }
}

/** 403 — authenticated but not authorized for this action/resource. */
export class ForbiddenError extends AppError {
  constructor(message = 'You are not authorized to perform this action', code = 'FORBIDDEN', details?: unknown) {
    super(403, code, message, details);
  }
}

export class PermissionDeniedError extends ForbiddenError {
  constructor(permission: string) {
    super(`Missing permission: ${permission}`, 'PERMISSION_DENIED', { permission });
  }
}

/** 404 */
export class NotFoundError extends AppError {
  constructor(resource = 'Resource') {
    super(404, 'NOT_FOUND', `${resource} not found`);
  }
}

/** 409 — state conflicts, duplicates, business rule violations. */
export class ConflictError extends AppError {
  constructor(message = 'Conflicting state', code = 'CONFLICT', details?: unknown) {
    super(409, code, message, details);
  }
}

export class BusinessRuleError extends AppError {
  constructor(message: string, code = 'BUSINESS_RULE_VIOLATION', details?: unknown) {
    super(422, code, message, details);
  }
}

export class DeadlineExceededError extends BusinessRuleError {
  constructor(message: string, details?: unknown) {
    super(message, 'DEADLINE_EXCEEDED', details);
  }
}

/** 429 — rate limited or too many attempts. */
export class TooManyRequestsError extends AppError {
  constructor(retryAfterSeconds: number) {
    super(429, 'RATE_LIMITED', 'Too many requests. Please slow down.', { retryAfterSeconds });
  }
}

/** 500 — unexpected failure; never leaks internals. */
export class InternalError extends AppError {
  constructor(message = 'An internal error occurred') {
    super(500, 'INTERNAL_ERROR', message, undefined, false);
  }
}

import type { PgErrorLike } from './pg-error.js';

/** Maps PostgreSQL driver errors onto the application error hierarchy. */
export function mapDatabaseError(error: PgErrorLike): AppError | null {
  switch (error.code) {
    case '23505': // unique_violation
      return new ConflictError('A record with the same unique value already exists', 'DUPLICATE_RECORD');
    case '23503': // foreign_key_violation
      return new BadRequestError('Referenced record does not exist', 'FK_VIOLATION');
    case '23514': // check_violation
      return new BusinessRuleError('Value violates a data integrity rule', 'CHECK_VIOLATION');
    case '40001': // serialization_failure
      return new ConflictError('Concurrent update detected, please retry', 'SERIALIZATION_CONFLICT');
    case '23P01': // exclusion_violation
      return new ConflictError('Conflicting record', 'EXCLUSION_VIOLATION');
    default:
      return null;
  }
}
