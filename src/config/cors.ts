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
 * Requests without an `Origin` header are allowed: CORS is a browser protection
 * and origin-less callers (health probes, server-to-server calls, native mobile
 * HTTP clients) gain no access from it. When an unknown origin is supplied the
 * request is not rejected outright — the CORS headers are simply withheld, so
 * the browser blocks it while logging stays clean.
 */
export const corsOptions: CorsOptions = {
  origin(origin, callback) {
    if (!origin || env.webOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
  credentials: true,
};
