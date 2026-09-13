import { z } from 'zod';

/**
 * Offline sync request schemas (docs/backend-master-spec.md §20).
 *
 * The sync module hosts the SHARED protocol infrastructure (idempotency-key
 * shape, submission status vocabulary) plus the agent-facing status surface.
 * The actual push endpoints (`POST /collections`, `POST /visits`) and the pull
 * read model (`GET /agents/me/assignments`) are owned by the collections and
 * agents modules respectively; they reuse the exports declared here.
 */

/**
 * Client-generated idempotency key. The mobile app (`IdGenerator.idempotencyKey()`)
 * emits exactly 32 lowercase hexadecimal characters. Replays of a failed or
 * repeated submission carry the SAME key and must return the original response;
 * a resubmit after an office decision carries a FRESH key (never collides).
 */
export const idempotencyKeySchema = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{32}$/, 'idempotencyKey must be a 32-character lowercase hexadecimal string');
export type IdempotencyKey = z.infer<typeof idempotencyKeySchema>;

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/**
 * Submission status the agent is allowed to observe (spec §20.1 / §20.3.6 —
 * status only, never the office decision details). Mirrors the DB CHECK on
 * collection_entry.status and the mobile SubmissionStatus enum.
 */
export const collectionSubmissionStatusSchema = z.enum([
  'waiting',
  'accepted',
  'rejected',
  'requiresReview',
]);
export type CollectionSubmissionStatus = z.infer<typeof collectionSubmissionStatusSchema>;

export const collectionProductTypeSchema = z.enum([
  'savingsDeposit',
  'recurringDeposit',
  'loan',
  'penalty',
]);
export type CollectionProductType = z.infer<typeof collectionProductTypeSchema>;

export const collectionModeSchema = z.enum(['cash', 'UPI', 'NEFT', 'RTGS', 'cheque']);

export const visitOutcomeSchema = z.enum(['collected', 'notAvailable', 'promised', 'refused']);
export type VisitOutcome = z.infer<typeof visitOutcomeSchema>;

/**
 * Agent-facing submission listing. Scope is always the authenticated agent —
 * there is deliberately no `agentId` parameter; a caller cannot list another
 * agent's submissions through this surface.
 */
export const syncSubmissionsQuerySchema = z.object({
  status: collectionSubmissionStatusSchema.optional(),
  productType: collectionProductTypeSchema.optional(),
  mode: collectionModeSchema.optional(),
  businessDate: dateOnlySchema.optional(),
  fromDate: dateOnlySchema.optional(),
  toDate: dateOnlySchema.optional(),
  offlineLate: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SyncSubmissionsQuery = z.infer<typeof syncSubmissionsQuerySchema>;

export const syncVisitsQuerySchema = z.object({
  outcome: visitOutcomeSchema.optional(),
  visitDate: dateOnlySchema.optional(),
  fromDate: dateOnlySchema.optional(),
  toDate: dateOnlySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type SyncVisitsQuery = z.infer<typeof syncVisitsQuerySchema>;

/**
 * Entities that carry an idempotency key and can therefore be escalated as a
 * device-vs-office conflict (spec §20.3.3). `collection_entry` holds the
 * four-state submission lifecycle; `visit_log` holds evidence-only records.
 */
export const syncEntityTypeSchema = z.enum(['collection_entry', 'visit_log']);
export type SyncEntityType = z.infer<typeof syncEntityTypeSchema>;

/**
 * Device-initiated conflict report (spec §20.3.3). When the device still holds
 * a draft whose content differs from the latest office decision it received
 * (matching idempotency key), it escalates here instead of silently
 * overwriting. The server records the escalation (sync.conflict.escalated);
 * the President decides the correct version through the office surface.
 */
export const reportConflictSchema = z.object({
  entityType: syncEntityTypeSchema.default('collection_entry'),
  idempotencyKey: idempotencyKeySchema,
  summary: z.string().trim().min(1, 'summary is required').max(300, 'summary is too long'),
  reason: z.string().trim().max(500).optional(),
  deviceSnapshot: z.record(z.string(), z.unknown()).optional(),
  officeSnapshot: z.record(z.string(), z.unknown()).optional(),
});
export type ReportConflictInput = z.infer<typeof reportConflictSchema>;
