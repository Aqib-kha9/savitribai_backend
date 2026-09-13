import type { RequestHandler } from 'express';
import type { ZodType } from 'zod';
import { ValidationError } from '../core/errors.js';

/**
 * Request validation helpers (docs/backend-master-spec.md §2.4).
 *
 * `validateBody` is an Express middleware that replaces `request.body` with the
 * parsed, typed payload — handlers therefore always receive validated data.
 * `parse` is the non-middleware companion for query-string / path-parameter
 * objects that are awkward to swap in place.
 */

/** Parses `data` against `schema` or throws a 400 ValidationError. */
export function parse<T>(schema: ZodType<T>, data: unknown, message = 'Validation failed'): T {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ValidationError(message, result.error.issues);
  }
  return result.data;
}

export function validateBody<T>(schema: ZodType<T>): RequestHandler {
  return (request, _response, next) => {
    try {
      request.body = parse(schema, request.body, 'Invalid request body');
      next();
    } catch (error) {
      next(error);
    }
  };
}
