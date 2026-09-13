import { z } from 'zod';
import {
  collectionModeSchema,
  collectionProductTypeSchema,
  collectionSubmissionStatusSchema,
  idempotencyKeySchema,
  visitOutcomeSchema,
} from '../sync/sync.schemas.js';

/**
 * Doorstep collections request schemas (docs/backend-master-spec.md §14).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints on collection_entry / visit_log
 * / collection_review in 001_schema.sql so the boundary rejects unknown
 * vocabulary before it ever reaches SQL:
 *  - product_type:  savingsDeposit | recurringDeposit | loan | penalty
 *  - mode:          cash | UPI | NEFT | RTGS | cheque
 *  - status:        waiting | accepted | rejected | requiresReview
 *  - visit outcome: collected | notAvailable | promised | refused
 *  - receipt_kind:  daily | monthly
 *
 * Shared protocol vocabulary (idempotency-key shape, status, product type,
 * mode, visit outcome) is imported from the sync module — the sync module
 * hosts the shared protocol infrastructure and the collections module reuses
 * its exports (see sync/sync.schemas.ts module doc).
 *
 * Business rules surfaced here (spec §14.5 / §14.1):
 *  - every submission carries a client-generated 32-hex idempotency key
 *    (HTTP `Idempotency-Key` header, NOT in the body);
 *  - product account id must match the product type — exactly one of
 *    savingsAccountId (savingsDeposit), rdAccountId (recurringDeposit),
 *    loanId (loan); a penalty attaches to the underlying product account
 *    (any one of the three, exactly one);
 *  - customer acknowledgement is mandatory (acknowledged must be true —
 *    receipt is the accepted acknowledgement form, §14.1);
 *  - cash handover before 16:00 IST and submission before 17:00 IST are
 *    enforced in the service, not the boundary.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/**
 * ISO-8601 instant accepted for `collectedAt` / `visitedAt`. The mobile app
 * serialises with DateTime.toIso8601String(): a `T`-separated instant with an
 * optional millisecond fraction and an optional `Z`/`±HH:MM` offset (Flutter
 * local DateTimes carry no offset). Postgres receives the instant through a
 * TIMESTAMPTZ parameter and normalises to UTC.
 */
const isoDateTimeSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/,
    'Timestamp must be an ISO-8601 instant (YYYY-MM-DDThh:mm:ss[.sss][Z|±hh:mm])',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Timestamp must be a valid date-time');

/** Money amount — /^\d{1,12}(\.\d{1,2})?$/ travels as a string (spec §1.3). */
const amountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a positive amount with at most 2 decimal places')
  .refine((value) => Number(value) > 0, 'Amount must be greater than zero');

/** Receipt format issued for a collection — collection_receipt.receipt_kind CHECK. */
export const receiptKindSchema = z.enum(['daily', 'monthly']);
export type ReceiptKind = z.infer<typeof receiptKindSchema>;

/**
 * Review decision — collection_review.decision CHECK. Identical vocabulary to
 * the submission status on collection_entry; a review moves the entry to the
 * matching status.
 */
export const reviewDecisionSchema = z.enum(['accepted', 'rejected', 'requiresReview']);
export type ReviewDecision = z.infer<typeof reviewDecisionSchema>;

/**
 * One collection submitted by an agent (POST /api/v1/collections).
 *
 * The idempotency key is deliberately absent — it arrives in the HTTP
 * `Idempotency-Key` header and is validated against idempotencyKeySchema in
 * the route.
 *
 * Account ownership: the DDL keeps three separate product-account FKs
 * (savings_account_id, rd_account_id, loan_id on collection_entry) so the
 * payload names the account with the column-matching field. Exactly one must
 * be present and it must match productType. A `penalty` entry attaches to the
 * underlying product account the penalty accrued on (RD instalment penalty,
 * loan penalty component, or a savings account penalty) — any one of the
 * three, exactly one.
 */
export const submitCollectionSchema = z
  .object({
    productType: collectionProductTypeSchema,
    customerId: uuidSchema,
    savingsAccountId: uuidSchema.optional(),
    rdAccountId: uuidSchema.optional(),
    loanId: uuidSchema.optional(),
    amount: amountSchema,
    mode: collectionModeSchema,
    isPartial: z.boolean().default(false),
    isAdvance: z.boolean().default(false),
    /** Cheque number / bank UTR for non-cash payments (collection_entry.instrument_ref). */
    instrumentRef: z.string().trim().max(200).optional(),
    /** Date on the cheque instrument, when paid by cheque. */
    instrumentDate: dateOnlySchema.optional(),
    /** Defaults to the IST business date in the service. */
    businessDate: dateOnlySchema.optional(),
    /** Capture instant on the device; defaults to submitted_at in the service. */
    collectedAt: isoDateTimeSchema.optional(),
    /** True when this entry was created while the device had no connectivity. */
    submittedFromOffline: z.boolean().default(false),
    /**
     * Server-authoritative offline-lateness flag (sync OFFLINE_LIMIT_HOURS);
     * set from evaluateOfflineLate() in the service — never trusted from the client.
     */
    offlineLate: z.boolean().optional(),
    /** Evidence visit this entry is backed by (collection_entry.visit_log_id). */
    visitLogId: uuidSchema.optional(),
    /**
     * Customer acknowledgement captured on device — mandatory true. The
     * receipt is the accepted acknowledgement form (§14.1) and every
     * collection issues one.
     */
    acknowledged: z
      .boolean()
      .refine((value) => value === true, 'Customer acknowledgement is mandatory — acknowledged must be true'),
    receiptKind: receiptKindSchema.default('daily'),
  })
  .superRefine((value, ctx) => {
    const accountFields = {
      savingsDeposit: 'savingsAccountId',
      recurringDeposit: 'rdAccountId',
      loan: 'loanId',
      penalty: null,
    } as const;
    const productFieldOptions = ['savingsAccountId', 'rdAccountId', 'loanId'] as const;
    type ProductField = (typeof productFieldOptions)[number];

    const provided = productFieldOptions.filter((field) => value[field] !== undefined);

    if (provided.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account'],
        message: `A product account id is required for productType '${value.productType}'`,
      });
      return;
    }
    if (provided.length > 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['account'],
        message: 'Exactly one product account id must be provided',
      });
      return;
    }

    const providedField = provided[0] as ProductField;
    const expected = accountFields[value.productType];
    if (expected !== null && providedField !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [providedField],
        message: `productType '${value.productType}' requires '${expected}', not '${providedField}'`,
      });
    }
  });
export type SubmitCollectionInput = z.infer<typeof submitCollectionSchema>;

/**
 * A single visit recorded by an agent (POST /api/v1/visits). Replay-safe via
 * the idempotency key in the HTTP header; visit evidence (outcome + optional
 * photos) backs the collection log (§14.3).
 */
export const visitSchema = z.object({
  customerId: uuidSchema,
  visitDate: dateOnlySchema,
  visitedAt: isoDateTimeSchema.optional(),
  outcome: visitOutcomeSchema,
  remark: z.string().trim().max(1000).optional(),
  photos: z.array(z.string().url('Photo evidence must be a URL/URI')).max(20).optional(),
});
export type VisitInput = z.infer<typeof visitSchema>;

/**
 * Office collection list query — GET /api/v1/collections. Scope is office
 * (all agents), optionally filtered. `isDeleted` defaults to false so soft-
 * deleted duplicates never appear unless explicitly requested.
 */
export const listCollectionsQuerySchema = z.object({
  status: collectionSubmissionStatusSchema.optional(),
  agentId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  productType: collectionProductTypeSchema.optional(),
  mode: collectionModeSchema.optional(),
  /** business_date range, inclusive (YYYY-MM-DD). */
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  isDeleted: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListCollectionsQuery = z.infer<typeof listCollectionsQuerySchema>;

/** M.D. review of a submitted collection — POST /:id/review. */
export const reviewCollectionSchema = z.object({
  decision: reviewDecisionSchema,
  remarks: z.string().trim().max(1000).optional(),
});
export type ReviewCollectionInput = z.infer<typeof reviewCollectionSchema>;

/**
 * Reversal of a disputed collection — POST /:id/reverse (spec §14.5). A
 * dispute is resolved with proof of record and implemented as reversal +
 * corrected new entry — never a direct edit. The replacement entry re-uses
 * the submit contract; when the reversal is a plain refund the corrected
 * entry may be omitted, but `customerNotified` must still be confirmed.
 */
export const reverseCollectionSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(1000),
  /** Evidence backing the bank's resolution of the dispute (proof of record). */
  proofOfRecord: z.array(z.record(z.string(), z.unknown())).max(20).optional(),
  replacement: submitCollectionSchema.optional(),
  customerNotified: z
    .boolean()
    .refine((value) => value === true, 'Customer must be notified of the reversal'),
});
export type ReverseCollectionInput = z.infer<typeof reverseCollectionSchema>;

/** Office deletion of a duplicate — POST /:id/delete-duplicate (authorised person only). */
export const deleteDuplicateSchema = z.object({
  reason: z.string().trim().min(1, 'reason is required').max(1000),
});
export type DeleteDuplicateInput = z.infer<typeof deleteDuplicateSchema>;

/**
 * Allocation bucket for a short-paid collection — the bank decides how a
 * payment splits across principal / interest / penalty / fees / product
 * buckets (§14.1). Stored verbatim on collection_entry.allocation and echoed
 * into short_payment_allocation.
 */
export const allocationEntrySchema = z.object({
  bucket: z.string().trim().min(1).max(50),
  amount: amountSchema,
});
export type AllocationEntry = z.infer<typeof allocationEntrySchema>;

/** Short-payment allocation decision — POST /:id/allocate (M.D.). */
export const allocateCollectionSchema = z.object({
  allocation: z.array(allocationEntrySchema).min(1, 'At least one allocation entry is required'),
  note: z.string().trim().max(500).optional(),
});
export type AllocateCollectionInput = z.infer<typeof allocateCollectionSchema>;

/**
 * Emergency approval of a collection from an unassigned customer —
 * POST /api/v1/collections/emergency-approval (M.D., spec §14.1). The M.D.
 * approves the entry, so it is created directly in `accepted` state; the
 * collecting agent is identified explicitly (collection_entry.agent_id is NOT
 * NULL) and the assignment check performed for regular submissions is
 * skipped.
 */
export const emergencyApprovalSchema = z.object({
  agentId: uuidSchema,
  customerId: uuidSchema,
  productType: collectionProductTypeSchema,
  savingsAccountId: uuidSchema.optional(),
  rdAccountId: uuidSchema.optional(),
  loanId: uuidSchema.optional(),
  amount: amountSchema,
  mode: collectionModeSchema,
  isPartial: z.boolean().default(false),
  isAdvance: z.boolean().default(false),
  instrumentRef: z.string().trim().max(200).optional(),
  instrumentDate: dateOnlySchema.optional(),
  businessDate: dateOnlySchema.optional(),
  collectedAt: isoDateTimeSchema.optional(),
  receiptKind: receiptKindSchema.default('daily'),
  acknowledged: z.boolean().default(false),
  remark: z.string().trim().max(1000).optional(),
}).superRefine((value, ctx) => {
  const accountFields = {
    savingsDeposit: 'savingsAccountId',
    recurringDeposit: 'rdAccountId',
    loan: 'loanId',
    penalty: null,
  } as const;
  const productFieldOptions = ['savingsAccountId', 'rdAccountId', 'loanId'] as const;
  type ProductField = (typeof productFieldOptions)[number];

  const provided = productFieldOptions.filter((field) => value[field] !== undefined);

  if (provided.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['account'],
      message: `A product account id is required for productType '${value.productType}'`,
    });
    return;
  }
  if (provided.length > 1) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['account'],
      message: 'Exactly one product account id must be provided',
    });
    return;
  }

  const providedField = provided[0] as ProductField;
  const expected = accountFields[value.productType];
  if (expected !== null && providedField !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [providedField],
      message: `productType '${value.productType}' requires '${expected}', not '${providedField}'`,
    });
  }
});
export type EmergencyApprovalInput = z.infer<typeof emergencyApprovalSchema>;

/**
 * Total-amount collection report query — GET /reports/collection-totals.
 * Aggregates accepted + waiting office collections; `isDeleted` entries are
 * always excluded. Ranges default to the current IST business day.
 */
export const collectionTotalsQuerySchema = z.object({
  dateFrom: dateOnlySchema.optional(),
  dateTo: dateOnlySchema.optional(),
  agentId: uuidSchema.optional(),
  customerId: uuidSchema.optional(),
  productType: collectionProductTypeSchema.optional(),
  mode: collectionModeSchema.optional(),
});
export type CollectionTotalsQuery = z.infer<typeof collectionTotalsQuerySchema>;

/** Path parameter schema shared by /:id routes. */
export const idParamSchema = z.object({ id: uuidSchema });

/** Idempotency key shape validated from the HTTP header (shared protocol vocabulary). */
export type { IdempotencyKey } from '../sync/sync.schemas.js';
export { idempotencyKeySchema, collectionProductTypeSchema, collectionModeSchema } from '../sync/sync.schemas.js';
