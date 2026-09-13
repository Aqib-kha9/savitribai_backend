import { z } from 'zod';
/**
 * Validated environment configuration (docs/backend-master-spec.md §2, §6).
 * The API refuses to boot with an invalid or missing configuration.
 */
const environmentSchema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    API_PORT: z.coerce.number().int().positive().default(4000),
    WEB_ORIGIN: z.string().url().default('http://localhost:5173'),
    DATABASE_URL: z.string().min(1),
    REDIS_URL: z.string().min(1).default('redis://localhost:6379'),
    JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
    JWT_ISSUER: z.string().min(1).default('cooperative-finance-api'),
    JWT_AUDIENCE: z.string().min(1).default('cooperative-finance-clients'),
    ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().positive().default(15),
    REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),
    SESSION_IDLE_MINUTES: z.coerce.number().int().min(30).max(60).default(60),
    MAX_LOGIN_ATTEMPTS: z.coerce.number().int().positive().default(5),
    LOCKOUT_MINUTES: z.coerce.number().int().positive().default(15),
    DB_POOL_MAX: z.coerce.number().int().positive().default(10),
    CASH_HANDOVER_DEADLINE_HOUR: z.coerce.number().int().min(0).max(23).default(16),
    SUBMISSION_DEADLINE_HOUR: z.coerce.number().int().min(0).max(23).default(17),
    OFFLINE_LIMIT_HOURS: z.coerce.number().int().positive().default(36),
    MFA_ISSUER: z.string().min(1).default('Savitribai Fule Mahila Nagari Sahakari Patsanstha'),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
    RATE_LIMIT_MAX: z.coerce.number().int().positive().default(300),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
    // Seed-time only
    BOOTSTRAP_ADMIN_STAFF_CODE: z.string().min(1).default('MD-001'),
    BOOTSTRAP_ADMIN_PASSWORD: z.string().min(8).default('ChangeMe#2026'),
    SEED_DEMO_DATA: z
        .enum(['true', 'false'])
        .default('true')
        .transform((value) => value === 'true'),
});
const parsed = environmentSchema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
}
const data = parsed.data;
export const env = {
    nodeEnv: data.NODE_ENV,
    isProduction: data.NODE_ENV === 'production',
    isDevelopment: data.NODE_ENV === 'development',
    port: data.API_PORT,
    webOrigin: data.WEB_ORIGIN,
    databaseUrl: data.DATABASE_URL,
    redisUrl: data.REDIS_URL,
    jwt: {
        accessSecret: data.JWT_ACCESS_SECRET,
        issuer: data.JWT_ISSUER,
        audience: data.JWT_AUDIENCE,
        accessTokenTtlMinutes: data.ACCESS_TOKEN_TTL_MINUTES,
        refreshTokenTtlDays: data.REFRESH_TOKEN_TTL_DAYS,
    },
    session: {
        idleMinutes: data.SESSION_IDLE_MINUTES,
        maxLoginAttempts: data.MAX_LOGIN_ATTEMPTS,
        lockoutMinutes: data.LOCKOUT_MINUTES,
    },
    dbPoolMax: data.DB_POOL_MAX,
    deadlines: {
        cashHandoverHour: data.CASH_HANDOVER_DEADLINE_HOUR,
        submissionHour: data.SUBMISSION_DEADLINE_HOUR,
    },
    offlineLimitHours: data.OFFLINE_LIMIT_HOURS,
    mfaIssuer: data.MFA_ISSUER,
    rateLimit: {
        windowMs: data.RATE_LIMIT_WINDOW_MS,
        max: data.RATE_LIMIT_MAX,
    },
    logLevel: data.LOG_LEVEL,
    seed: {
        bootstrapAdminStaffCode: data.BOOTSTRAP_ADMIN_STAFF_CODE,
        bootstrapAdminPassword: data.BOOTSTRAP_ADMIN_PASSWORD,
        demoData: data.SEED_DEMO_DATA,
    },
};
