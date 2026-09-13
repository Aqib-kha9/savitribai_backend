import { z } from 'zod';
/**
 * Settings and organisation administration query/body schemas
 * (docs/backend-master-spec.md §22).
 *
 * Surface split:
 *   - GET/PATCH /organisation  — single organisation row (name, registration,
 *     address, contacts, financial year, time zone, working days, hours);
 *   - GET/POST /branches, PATCH /branches/:id — branch registry;
 *   - GET/POST /holidays, DELETE /holidays/:id — holiday calendar;
 *   - GET /settings — current app_setting rows (operational preferences);
 *   - PATCH /settings — bulk app_setting update with an audited
 *     setting_change_history entry per change;
 *   - GET /settings/history — append-only change history.
 *
 * JSONB convention: app_setting.value is JSONB and therefore accepts scalars,
 * arrays, and objects (e.g. notifications.enabled_channels is an array). Every
 * value below is stored with JSON.stringify on the way in and arrives back as
 * a parsed JS value.
 *
 * Dates travel as YYYY-MM-DD (spec §1.3). holiday_date is a DATE column; the
 * calendar_year column is derived from it when not supplied so the seeded
 * holiday rows and the calendar stay consistent.
 */
export const uuidSchema = z.string().uuid('Invalid id format');
const dateOnlySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
/** Working-day codes used by organisation.working_days. */
const workingDaySchema = z.enum(['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']);
/**
 * PATCH /organisation — every field optional, at least one present. Fields are
 * non-transaction business info the administrators may change themselves
 * (§22.1); financial year and time zone also live here (organisation table).
 */
export const updateOrganisationSchema = z
    .object({
    legalName: z.string().trim().min(2).max(200).optional(),
    displayName: z.string().trim().min(2).max(200).optional(),
    registrationNumber: z.string().trim().min(1).max(100).optional(),
    legalAddress: z.string().trim().min(5).max(500).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    email: z.string().trim().email().max(200).nullable().optional(),
    timezone: z.string().trim().min(1).max(100).optional(),
    currency: z.string().trim().length(3).toUpperCase().optional(),
    locale: z.string().trim().min(2).max(20).optional(),
    financialYearStartMonth: z.number().int().min(1).max(12).optional(),
    workingDays: z
        .array(workingDaySchema)
        .min(1)
        .max(7)
        .superRefine((value, ctx) => {
        if (new Set(value).size !== value.length) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'workingDays must not contain duplicates',
            });
        }
    })
        .optional(),
    operatingHours: z
        .string()
        .trim()
        .regex(/^\d{1,2}:\d{2}\s*-\s*\d{1,2}:\d{2}$/, 'Use 24h format, e.g. 10:30-17:30')
        .optional(),
})
    .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one organisation field must be provided',
});
/** POST /branches — new branch under the single organisation. */
export const createBranchSchema = z.object({
    code: z.string().trim().min(2).max(20).toUpperCase(),
    name: z.string().trim().min(2).max(200),
    address: z.string().trim().min(5).max(500),
    phone: z.string().trim().max(30).nullable().optional(),
    isActive: z.boolean().optional().default(true),
});
/** PATCH /branches/:id — at least one field present. */
export const updateBranchSchema = z
    .object({
    code: z.string().trim().min(2).max(20).toUpperCase().optional(),
    name: z.string().trim().min(2).max(200).optional(),
    address: z.string().trim().min(5).max(500).optional(),
    phone: z.string().trim().max(30).nullable().optional(),
    isActive: z.boolean().optional(),
})
    .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one branch field must be provided',
});
/** GET /branches — optional active filter plus pagination. */
export const listBranchesQuerySchema = z.object({
    isActive: z.enum(['true', 'false']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
/** POST /holidays — calendar_year derives from holidayDate unless given. */
export const createHolidaySchema = z.object({
    holidayDate: dateOnlySchema,
    occasion: z.string().trim().min(2).max(200),
    isGovernment: z.boolean().optional().default(true),
    calendarYear: z.number().int().min(2000).max(2200).optional(),
});
/** GET /holidays — optional year filter plus pagination. */
export const listHolidaysQuerySchema = z.object({
    year: z.coerce.number().int().min(2000).max(2200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
/** Route params that carry a UUID. */
export const branchIdParamSchema = z.object({ id: uuidSchema });
export const holidayIdParamSchema = z.object({ id: uuidSchema });
/**
 * PATCH /settings — bulk operational-preference update. Each change must name an
 * existing app_setting key; the row is updated, a setting_change_history entry
 * is appended with the old/new value and the actor's reason, and an audit event
 * (settings.setting.changed) is written in the same transaction (§22.2 audited
 * history). Keys are validated for duplicates so one request cannot write the
 * same key twice.
 */
export const updateSettingsSchema = z
    .object({
    changes: z
        .array(z.object({
        key: z.string().trim().min(1).max(200),
        value: z.unknown(),
        reason: z.string().trim().max(500).optional(),
    }))
        .min(1)
        .max(50),
})
    .superRefine((value, ctx) => {
    const keys = value.changes.map((change) => change.key);
    if (new Set(keys).size !== keys.length) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['changes'],
            message: 'changes must not contain duplicate setting keys',
        });
    }
});
/** GET /settings — optional category filter. */
export const listSettingsQuerySchema = z.object({
    category: z.string().trim().min(1).max(100).optional(),
});
/**
 * GET /settings/history — append-only setting_change_history trail. Optionally
 * filter by setting key and an inclusive IST day range over created_at.
 */
export const listSettingHistoryQuerySchema = z
    .object({
    settingKey: z.string().trim().min(1).max(200).optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
})
    .superRefine((value, ctx) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['from'],
            message: 'from must not be after to',
        });
    }
});
