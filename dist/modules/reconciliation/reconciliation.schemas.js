import { z } from 'zod';
/**
 * Daily handover and reconciliation request schemas (docs/backend-master-spec.md §16).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints on day_close / cash_handover /
 * digital_settlement / reconciliation_difference in 001_schema.sql so the
 * boundary rejects unknown vocabulary before it ever reaches SQL:
 *  - day_close.status:               open | submitted | closed | reopened | locked
 *  - cash_handover.status:           pending | counted | confirmed | difference
 *  - digital_settlement.method:      bank_transfer | cheque | UPI | NEFT | RTGS
 *  - reconciliation_difference.type: (free text — see difference_type on the row)
 *  - reconciliation_difference.status: unresolved | explained | accepted |
 *                                     recovered | waived
 *
 * Business rules surfaced here (spec §16.1 / §16.5):
 *  - agent submission deadline is 17:00 IST and cash-handover deadline 16:00 IST
 *    (deadline checks live in the service layer, never in the schema);
 *  - cash denominations are recorded per handover (denomination × note count
 *    is summed into cash_handover / denomination_breakup by the service);
 *  - the cashier counts and confirms the handed-over cash; a genuine mismatch
 *    is recorded as a reconciliation_difference flagged to the M.D.;
 *  - difference lifecycle (explained/accepted/recovered/waived/unresolved) is an
 *    M.D. decision; unresolved differences escalate to the M.D.;
 *  - reopening a completed reconciliation is a President approval and the
 *    subsequent lock-after-approval is the default (spec §16.5).
 *
 * Money always travels as a decimal string (spec §1.3 — NUMERIC(14,2) rendered
 * as text); it is never parsed to a JavaScript float.
 */
export const uuidSchema = z.string().uuid('Invalid id format');
const dateOnlySchema = z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
/**
 * Non-negative money amount — /^\d{1,12}(\.\d{1,2})?$/ as a string (spec §1.3).
 * Handover and digital-settlement amounts may legitimately be zero when there
 * is no cash / no digital movement on the day, so this is non-negative.
 */
const nonNegativeAmountSchema = z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a non-negative amount with at most 2 decimal places');
/**
 * Positive money amount — used when the caller must declare a movement
 * (a denomination line, or a digitally settled sum).
 */
const positiveAmountSchema = z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a positive amount with at most 2 decimal places')
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero');
const referenceSchema = z.string().trim().max(200);
const noteSchema = z.string().trim().max(1000);
/** day_close.status CHECK in 001_schema.sql. */
export const dayCloseStatusSchema = z.enum(['open', 'submitted', 'closed', 'reopened', 'locked']);
/** cash_handover.status CHECK in 001_schema.sql. */
export const handoverStatusSchema = z.enum(['pending', 'counted', 'confirmed', 'difference']);
/** digital_settlement.method CHECK in 001_schema.sql. */
export const settlementMethodSchema = z.enum(['bank_transfer', 'cheque', 'UPI', 'NEFT', 'RTGS']);
/** reconciliation_difference.status CHECK in 001_schema.sql. */
export const differenceStatusSchema = z.enum(['unresolved', 'explained', 'accepted', 'recovered', 'waived']);
/**
 * One cash denomination line (spec §16.2 — denominations recorded per handover).
 * `denomination` is the note value in rupees (positive SMALLINT), `count` the
 * number of notes. The service derives `amount = denomination × count` and the
 * DB stores it on denomination_breakup.amount (001_schema.sql).
 */
export const denominationEntrySchema = z.object({
    denomination: z.number().int().positive('Denomination must be a positive note value'),
    count: z.number().int().nonnegative('Note count must be zero or more'),
});
/**
 * Section-wise daily cash report that accompanies a handover (spec §16.1 —
 * "Daily cash report of all collections, section-wise"). Free-form JSONB; the
 * office layout is not constrained by the schema so the client owns the shape.
 */
export const sectionReportSchema = z.record(z.string(), z.unknown());
/** GET /day-close/:agentId/:date — path params. */
export const dayCloseParamSchema = z.object({
    agentId: uuidSchema,
    date: dateOnlySchema,
});
/**
 * POST /submit — agent day-close submission (spec §16.3/§16.5).
 * Same-day only; the business date defaults to today's IST date in the service.
 * Amounts are NOT accepted from the agent — the service derives the day totals
 * from collection_entry so a submission can never over/under-state the close.
 */
export const submitDayCloseSchema = z.object({
    businessDate: dateOnlySchema.optional(),
});
/**
 * POST /handover — record the cash handed over + section-wise cash report
 * (spec §16.1/§16.5, deadline 16:00 IST). The declared cash amount is validated
 * against day_close.cash_amount by the service (idempotent replays permitted).
 */
export const recordHandoverSchema = z.object({
    /** Defaults to today's IST business date — closing is same-day only. */
    businessDate: dateOnlySchema.optional(),
    amount: nonNegativeAmountSchema,
    /** Daily cash report of all collections, section-wise (JSONB on cash_handover). */
    sectionReport: sectionReportSchema.optional(),
});
/**
 * POST /denominations — record the denomination-wise cash breakup for a
 * handover (spec §16.1 — "Cash denominations recorded: Yes"). Body supplies
 * note counts per denomination; the service recomputes line amounts.
 */
export const recordDenominationsSchema = z.object({
    handoverId: uuidSchema,
    entries: z.array(denominationEntrySchema).min(1, 'At least one denomination is required'),
});
/**
 * POST /count — cashier counts and confirms the handed-over cash (spec §16.1 —
 * "Who counts and confirms cash: Cashier"). A mismatch between the declared
 * handover amount and the counted amount records a reconciliation_difference
 * (difference_type shortage/excess) for the M.D.; exact match confirms the
 * handover (status confirmed / counted).
 */
export const countHandoverSchema = z.object({
    handoverId: uuidSchema,
    countedAmount: nonNegativeAmountSchema,
    notes: noteSchema.optional(),
});
/**
 * POST /digital-settlement — evidence for a digital/bank settlement: transfer
 * receipt, name-wise breakdown and cheque dates (spec §16.1/§16.2).
 * `dayCloseId` pins the evidence to a day close (digital_settlement.day_close_id
 * is NOT NULL in 001_schema.sql). Office staff resolve the day close from the
 * reconciliation detail screen before attaching evidence.
 */
export const recordDigitalSettlementSchema = z.object({
    /** Day close the settlement evidence is attached to. */
    dayCloseId: uuidSchema,
    /**
     * Optional business-date override — when supplied it must match the day
     * close's own business date (validated by the service).
     */
    businessDate: dateOnlySchema.optional(),
    settlementReference: referenceSchema,
    bankName: referenceSchema.optional(),
    /** Defaults to the day close's business date. */
    settlementDate: dateOnlySchema.optional(),
    method: settlementMethodSchema,
    amount: positiveAmountSchema,
    nameWiseDetails: z.record(z.string(), z.unknown()).optional(),
    receiptReference: referenceSchema.optional(),
});
/**
 * POST /difference — M.D. marks a reconciliation difference as
 * explained/accepted/recovered/waived/unresolved (spec §16.1/§16.5). `status`
 * and `resolutionNote` describe the M.D.'s decision.
 */
export const markDifferenceSchema = z.object({
    differenceId: uuidSchema,
    status: differenceStatusSchema,
    resolutionNote: noteSchema.optional(),
});
/** POST /:id/reopen — President approves reopening a completed reconciliation. */
export const reopenDayCloseSchema = z.object({
    reopenReason: z.string().trim().min(1).max(500, 'A reopen reason is required'),
});
/**
 * POST /:id/lock — lock-after-approval (default; spec §16.5). An empty body is
 * valid, but a reason keeps the audit record useful.
 */
export const lockDayCloseSchema = z.object({
    reason: noteSchema.optional(),
});
/** POST /:id/escalate — an unresolved difference is escalated to the M.D. */
export const escalateDifferenceSchema = z.object({
    /** A note keeps the escalation auditable. */
    note: noteSchema.optional(),
});
/** Path parameter schema shared by the /:id routes. */
export const idParamSchema = z.object({ id: uuidSchema });
