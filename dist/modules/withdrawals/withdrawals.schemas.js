import { z } from 'zod';
/**
 * Withdrawals request schemas (docs/backend-master-spec.md §13).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints on withdrawal_request /
 * withdrawal_event in 001_schema.sql so the boundary rejects unknown
 * vocabulary before it ever reaches SQL:
 *  - account_kind:    savings | rd | fd | loan_surplus
 *  - payment_method:  cash | bank_transfer | cheque | mobile_money
 *  - status:          pending | approved | rejected | paid | confirmed | cancelled
 *  - event_type:      requested | approved | rejected | paid | confirmed | changed | cancelled
 *
 * Business rules surfaced here (spec §13.1 / §13.4):
 *  - minimum balance after withdrawal is ₹100 (MIN_BALANCE_AFTER_WITHDRAWAL);
 *  - amounts above ₹2,00,000 require the President (high-value approval);
 *  - identity checks (passbook, signature, Aadhaar) are recorded before payout;
 *  - an approved withdrawal may be changed by the President only — the original
 *    decision is preserved in the event history (never overwritten).
 */
export const uuidSchema = z.string().uuid('Invalid id format');
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
/** Money amount — /^\d{1,12}(\.\d{1,2})?$/ travels as a string (spec §1.3). */
const amountSchema = z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a non-negative amount with at most 2 decimal places')
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero');
/** The account kind a withdrawal is drawn against — withdrawal_request.account_kind CHECK. */
export const accountKindSchema = z.enum(['savings', 'rd', 'fd', 'loan_surplus']);
/** Payout method — withdrawal_request.payment_method CHECK (exactly these four). */
export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money']);
/** Withdrawal lifecycle — withdrawal_request.status CHECK. */
export const withdrawalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'paid', 'confirmed', 'cancelled']);
/** History event kinds appended to withdrawal_event per state change. */
export const withdrawalEventTypeSchema = z.enum([
    'requested',
    'approved',
    'rejected',
    'paid',
    'confirmed',
    'changed',
    'cancelled',
]);
/**
 * Identity checks performed before payout (spec §13.1). Flags are stored on
 * withdrawal_request (identity_verified_passbook / _signature / _aadhaar).
 */
export const identityVerificationSchema = z.object({
    passbook: z.boolean().default(false),
    signature: z.boolean().default(false),
    aadhaar: z.boolean().default(false),
});
export const requestWithdrawalSchema = z.object({
    accountKind: accountKindSchema,
    accountId: uuidSchema,
    amount: amountSchema,
    paymentMethod: paymentMethodSchema,
    /** Identity confirmation captured at the counter (spec §13.4: recorded before payout). */
    identityVerified: identityVerificationSchema.optional(),
    /** Selectable reason; free text carries the detail where the bank requires it. */
    reason: z.string().trim().min(1).max(200),
    freeTextReason: z.string().trim().max(1000).optional(),
    /**
     * Free-form operator worksheet (identity / purpose / destination / settlement
     * evidence references). Stored on withdrawal_request.documents JSONB so the
     * captured fields round-trip without widening the validated request schema.
     */
    documents: z.record(z.string(), z.unknown()).optional(),
});
export const listWithdrawalsQuerySchema = z.object({
    status: withdrawalStatusSchema.optional(),
    accountKind: accountKindSchema.optional(),
    /** Requested-on date range, inclusive (YYYY-MM-DD). */
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
export const approveWithdrawalSchema = z.object({
    comment: z.string().trim().max(500).optional(),
});
export const rejectWithdrawalSchema = z.object({
    reason: z.string().trim().min(1).max(1000),
});
export const payWithdrawalSchema = z.object({
    /** Bank/digital reference for the payout — mandatory for non-cash methods (enforced in the service). */
    payoutReference: z.string().trim().min(1).max(200).optional(),
    /** Identity checks may also be confirmed at payout time when not yet captured at request. */
    identityVerified: identityVerificationSchema.optional(),
});
export const confirmWithdrawalSchema = z.object({});
export const changeWithdrawalSchema = z.object({
    amount: amountSchema,
    reason: z.string().trim().min(1).max(200),
    freeTextReason: z.string().trim().max(1000).optional(),
});
/** Path parameter schema shared by /:id routes. */
export const idParamSchema = z.object({ id: uuidSchema });
