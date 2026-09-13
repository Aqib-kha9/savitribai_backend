import { env } from '../config/env.js';
import { TooManyRequestsError } from '../core/errors.js';
function defaultKey(request) {
    return `${request.ip ?? request.socket.remoteAddress ?? 'unknown'}`;
}
export function createRateLimiter(options = {}) {
    const windowMs = options.windowMs ?? env.rateLimit.windowMs;
    const max = options.max ?? env.rateLimit.max;
    const keyFor = options.keyGenerator ?? defaultKey;
    const buckets = new Map();
    const prune = () => {
        const cutoff = Date.now() - windowMs;
        for (const [key, bucket] of buckets) {
            bucket.hits = bucket.hits.filter((hit) => hit > cutoff);
            if (bucket.hits.length === 0)
                buckets.delete(key);
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
export const apiRateLimiter = createRateLimiter();
/**
 * Stricter limiter for authentication endpoints (login, refresh, device
 * registration). Brute-force protection is additionally enforced by the
 * per-account lockout logic (staff.failed_login_attempts / locked_until).
 */
export const authRateLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
});
