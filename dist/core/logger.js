import pino from 'pino';
import { env } from '../config/env.js';
/**
 * Structured logger (observability layer).
 * Sensitive fields are redacted — no financial data, credentials, or tokens in logs
 * (docs/security-baseline.md, spec §28.12).
 */
export const logger = pino({
    level: env.logLevel,
    base: { service: 'api', env: env.nodeEnv },
    redact: {
        paths: [
            'password',
            'currentPassword',
            'newPassword',
            'passwordHash',
            'mfaSecret',
            'token',
            'accessToken',
            'refreshToken',
            'idempotencyKey',
            'req.headers.authorization',
            'req.headers.cookie',
            'instrument_reference',
            '*.password',
            '*.passwordHash',
            '*.accessToken',
            '*.refreshToken',
        ],
        censor: '[REDACTED]',
    },
    ...(env.isProduction
        ? {}
        : {
            transport: {
                target: 'pino-pretty',
                options: { colorize: true, translateTime: 'SYS:standard' },
            },
        }),
});
