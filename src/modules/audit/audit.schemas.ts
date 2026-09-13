import { z } from 'zod';

/**
 * Audit trail query schemas (docs/backend-master-spec.md §21).
 *
 * The audit module is read-only over the append-only audit_event table
 * (001_schema.sql — the table rejects UPDATE/DELETE at the DB level via
 * reject_mutation triggers). These schemas only shape the two M.D. query
 * surfaces:
 *  - GET /events   — filtered, paginated trail
 *  - GET /summary  — aggregate counts
 *
 * Vocabulary mirrors audit_event CHECK constraints / audit-writer.ts:
 *  - source: admin_web | agent_mobile | system (system rows are written by the
 *    backend itself, e.g. lockout sweeps; AuthSource only covers interactive
 *    sessions, so the wider enum lives here).
 *  - action: free text (values come from AUDIT_ACTIONS, e.g.
 *    'reports.report.generated') — the query filter is an exact match.
 *
 * Dates travel as YYYY-MM-DD strings (spec §1.3). occurred_at is a timestamptz;
 * a from/to day filter is applied as a half-open IST day range in the service,
 * so "to = 2026-09-05" means up to (not including) 2026-09-06.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Audit-event source — wider than the interactive AuthSource union. */
export const auditSourceSchema = z.enum(['admin_web', 'agent_mobile', 'system']);
export type AuditSource = z.infer<typeof auditSourceSchema>;

/**
 * GET /events query. page/pageSize use the codebase convention of
 * z.coerce.number() so Express query strings (always strings) parse cleanly.
 */
export const auditEventsQuerySchema = z
  .object({
    /** Inclusive IST day bounds on audit_event.occurred_at (YYYY-MM-DD). */
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    /** Exact match on audit_event.action (e.g. reports.report.generated). */
    action: z.string().trim().min(1).max(200).optional(),
    /** Exact match on actor_staff_id (UUID). */
    actorStaffId: uuidSchema.optional(),
    /** Exact match on entity_type. */
    entityType: z.string().trim().min(1).max(200).optional(),
    /** Exact match on entity_id (free text — not all entities are UUIDs). */
    entityId: z.string().trim().min(1).max(200).optional(),
    /** Exact match on audit_event.source. */
    source: auditSourceSchema.optional(),
    /** Exact match on the request correlation id. */
    requestId: z.string().trim().min(1).max(200).optional(),
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
export type AuditEventsQuery = z.infer<typeof auditEventsQuerySchema>;

/**
 * GET /summary query — same filter vocabulary minus pagination (aggregates are
 * always small: one row per action / one row per actor).
 */
export const auditSummaryQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    action: z.string().trim().min(1).max(200).optional(),
    actorStaffId: uuidSchema.optional(),
    entityType: z.string().trim().min(1).max(200).optional(),
    entityId: z.string().trim().min(1).max(200).optional(),
    source: auditSourceSchema.optional(),
    requestId: z.string().trim().min(1).max(200).optional(),
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
export type AuditSummaryQuery = z.infer<typeof auditSummaryQuerySchema>;
