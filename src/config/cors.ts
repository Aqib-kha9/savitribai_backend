import type { CorsOptions } from 'cors';
import { env } from './env.js';

/**
 * CORS policy (docs/backend-master-spec.md §6).
 *
 * The API is consumed from browsers by the admin web panel, so the calling
 * origin must be allow-listed explicitly. `WEB_ORIGIN` accepts a comma-separated
 * list of absolute origins, which lets a single deployment serve the local Vite
 * dev server, the deployed panel and any preview URL without resorting to the
 * insecure `*` wildcard (which cannot be combined with credentials anyway).
 *
 * Exact matches are preferred. A single `*` may appear in a host entry to cover
 * rotatable deployment URLs (for example `https://sfmspmy-*.vercel.app`); the
 * pattern is anchored to the full origin so it can never widen to another host.
 *
 * Requests without an `Origin` header are allowed: CORS is a browser protection
 * and origin-less callers (health probes, server-to-server calls, native mobile
 * HTTP clients) gain no access from it. When an unknown origin is supplied the
 * request is not rejected outright — the CORS headers are simply withheld, so
 * the browser blocks it while logging stays clean.
 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAllowedOrigin(origin: string, allowed: string): boolean {
  if (allowed === origin) return true;
  if (!allowed.includes('*')) return false;
  const pattern = allowed.split('*').map(escapeRegExp).join('.*');
  return new RegExp(`^${pattern}$`, 'i').test(origin);
}

export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    const allowed = !origin || env.webOrigins.some((entry) => matchesAllowedOrigin(origin, entry));
    callback(null, allowed);
  },
  credentials: true,
};
