import type { Request, RequestHandler } from 'express';
import { env } from '../config/env.js';
import { TooManyRequestsError } from '../core/errors.js';

/**
 * Sliding-window rate limiter (docs/backend-master-spec.md §28.10).
 *
 * The infrastructure runs a single API instance behind the load balancer, so
 * the limiter is an in-memory per-key window (a Redis-backed limiter can be
 * swapped in later by changing this module only — the middleware contract is
 * unchanged). Stale buckets are swept periodically so the map cannot grow
 * without bound.
 */

interface RateLimitOptions {
  windowMs?: number;
  max?: number;
  keyGenerator?: (request: Request) => string;
}

interface Bucket {
  hits: number[];
}

function defaultKey(request: Request): string {
  return `${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
}

export function createRateLimiter(options: RateLimitOptions = {}): RequestHandler {
  const windowMs = options.windowMs ?? env.rateLimit.windowMs;
  const max = options.max ?? env.rateLimit.max;
  const keyFor = options.keyGenerator ?? defaultKey;
  const buckets = new Map<string, Bucket>();

  const prune = (): void => {
    const cutoff = Date.now() - windowMs;
    for (const [key, bucket] of buckets) {
      bucket.hits = bucket.hits.filter((hit) => hit > cutoff);
      if (bucket.hits.length === 0) buckets.delete(key);
    }
  };

  // Periodic sweep to bound memory. Unref'd so it never keeps the process alive.
  if (env.nodeEnv !== 'test') {
    const timer = setInterval(prune, Math.min(windowMs, 60_000));
    timer.unref?.();
  }

  return (request, response, next) => {
    const now = Date.now();
    const key = keyFor(request);
    const cutoff = now - windowMs;

    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hits: [] };
      buckets.set(key, bucket);
    }
    bucket.hits = bucket.hits.filter((hit) => hit > cutoff);

    response.setHeader('X-RateLimit-Limit', String(max));
    response.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.hits.length)));

    if (bucket.hits.length >= max) {
      // Oldest surviving hit determines when the window reopens.
      const oldest = bucket.hits[0] ?? now;
      const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      response.setHeader('Retry-After', String(retryAfterSeconds));
      next(new TooManyRequestsError(retryAfterSeconds));
      return;
    }

    bucket.hits.push(now);
    next();
  };
}

/** Broad per-IP limiter applied to every API route. */
export const apiRateLimiter: RequestHandler = createRateLimiter();

/**
 * Stricter limiter for authentication endpoints (login, refresh, device
 * registration). Brute-force protection is additionally enforced by the
 * per-account lockout logic (staff.failed_login_attempts / locked_until).
 */
export const authRateLimiter: RequestHandler = createRateLimiter({
  windowMs: 60_000,
  max: 20,
});
