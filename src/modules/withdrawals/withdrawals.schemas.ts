import { z } from 'zod';
import { idempotencyKeySchema } from '../sync/sync.schemas.js';

/**
 * Withdrawals request schemas (docs/backend-master-spec.md §13).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints on withdrawal_request /
 * withdrawal_event in 001_schema.sql so the boundary rejects unknown
 * vocabulary before it ever reaches SQL:
 *  - account_kind:    savings | rd | fd | loan_surplus
 *  - payment_method:  cash | bank_transfer | cheque | mobile_money
 *  - status:          pending | approved | rejected | paid | confirmed | cancelled | reversed
 *  - event_type:      requested | approved | rejected | paid | confirmed | changed | cancelled | reversed
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
export type AccountKind = z.infer<typeof accountKindSchema>;

/** Payout method — withdrawal_request.payment_method CHECK (exactly these four). */
export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

/** Withdrawal lifecycle — withdrawal_request.status CHECK. */
export const withdrawalStatusSchema = z.enum(['pending', 'approved', 'rejected', 'paid', 'confirmed', 'cancelled', 'reversed']);
export type WithdrawalStatus = z.infer<typeof withdrawalStatusSchema>;

/** History event kinds appended to withdrawal_event per state change. */
export const withdrawalEventTypeSchema = z.enum([
  'requested',
  'approved',
  'rejected',
  'paid',
  'confirmed',
  'changed',
  'cancelled',
  'reversed',
]);
export type WithdrawalEventType = z.infer<typeof withdrawalEventTypeSchema>;

/**
 * Identity checks performed before payout (spec §13.1). Flags are stored on
 * withdrawal_request (identity_verified_passbook / _signature / _aadhaar).
 */
export const identityVerificationSchema = z.object({
  passbook: z.boolean().default(false),
  signature: z.boolean().default(false),
  aadhaar: z.boolean().default(false),
});
export type IdentityVerification = z.infer<typeof identityVerificationSchema>;

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
export type RequestWithdrawalInput = z.infer<typeof requestWithdrawalSchema>;

export const listWithdrawalsQuerySchema = z.object({
  status: withdrawalStatusSchema.optional(),
  accountKind: accountKindSchema.optional(),
  /** Requested-on date range, inclusive (YYYY-MM-DD). */
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListWithdrawalsQuery = z.infer<typeof listWithdrawalsQuerySchema>;

export const approveWithdrawalSchema = z.object({
  comment: z.string().trim().max(500).optional(),
});
export type ApproveWithdrawalInput = z.infer<typeof approveWithdrawalSchema>;

export const rejectWithdrawalSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type RejectWithdrawalInput = z.infer<typeof rejectWithdrawalSchema>;

export const payWithdrawalSchema = z.object({
  /** Bank/digital reference for the payout — mandatory for non-cash methods (enforced in the service). */
  payoutReference: z.string().trim().min(1).max(200).optional(),
  /** Identity checks may also be confirmed at payout time when not yet captured at request. */
  identityVerified: identityVerificationSchema.optional(),
});
export type PayWithdrawalInput = z.infer<typeof payWithdrawalSchema>;

export const confirmWithdrawalSchema = z.object({});
export type ConfirmWithdrawalInput = z.infer<typeof confirmWithdrawalSchema>;

export const changeWithdrawalSchema = z.object({
  amount: amountSchema,
  reason: z.string().trim().min(1).max(200),
  freeTextReason: z.string().trim().max(1000).optional(),
});
export type ChangeWithdrawalInput = z.infer<typeof changeWithdrawalSchema>;

/**
 * Cancel a withdrawal before payout. Only a pending or approved request may be
 * cancelled; a paid/confirmed payout must be reversed through the ledger, never
 * silently cancelled (enforced in the service).
 */
export const cancelWithdrawalSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type CancelWithdrawalInput = z.infer<typeof cancelWithdrawalSchema>;

/**
 * Reverse a PAID or CONFIRMED payout. Because the funds have already left the
 * bank, the reversal posts a compensating credit back into the source account
 * (the original debit is never modified) and records the mandatory reason.
 * Reserved to the Managing Director (enforced in the service).
 */
export const reverseWithdrawalSchema = z.object({
  reason: z.string().trim().min(1).max(1000),
});
export type ReverseWithdrawalInput = z.infer<typeof reverseWithdrawalSchema>;

/** Path parameter schema shared by /:id routes. */
export const idParamSchema = z.object({ id: uuidSchema });

/**
 * Client-generated idempotency key for POST /withdrawals. The key is mandatory
 * (enforced at the route) so a repeated submit can never create a duplicate
 * money movement; it reuses the shared 32-char lowercase hex contract from the
 * sync protocol.
 */
export { idempotencyKeySchema };
export type { IdempotencyKey } from '../sync/sync.schemas.js';
