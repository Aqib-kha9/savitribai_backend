import { z } from 'zod';

/**
 * Fixed deposits request schemas (docs/backend-master-spec.md §11).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints in 001_schema.sql
 * (fd_rate_card / fd_account / fd_lien / fd_maturity_event / fd_interest_payout)
 * so the boundary rejects unknown vocabulary before it ever reaches SQL.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Money amount — /^\d{1,12}(\.\d{1,2})?$/ travels as a string (spec §1.3). */
const amountSchema = z
  .string()
  .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a non-negative amount with at most 2 decimal places')
  .refine((value) => Number(value) > 0, 'Amount must be greater than zero');

/** Interest rate — NUMERIC(7,4) payload, up to four decimal places. */
const rateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Interest rate must be a decimal with at most 4 decimal places')
  .refine((value) => Number(value) > 0 && Number(value) <= 25, 'Interest rate must be between 0 and 25');

/** Early-closure penalty percent — NUMERIC(5,2) payload (a penalty may be 0). */
const penaltyPercentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Penalty percent must be a decimal with at most 2 decimal places')
  .refine((value) => Number(value) >= 0 && Number(value) <= 100, 'Penalty percent must be between 0 and 100');

export const fdPayoutFrequencySchema = z.enum(['monthly', 'quarterly', 'yearly', 'at_maturity']);
export type FdPayoutFrequency = z.infer<typeof fdPayoutFrequencySchema>;

export const fdPayoutModeSchema = z.enum(['payout', 'reinvest']);
export type FdPayoutMode = z.infer<typeof fdPayoutModeSchema>;

export const fdMaturityActionSchema = z.enum([
  'pending',
  'renew_principal_interest',
  'renew_principal',
  'transfer_to_savings',
  'pay_cash',
  'pay_bank',
]);
export type FdMaturityAction = z.infer<typeof fdMaturityActionSchema>;

export const fdAccountStatusSchema = z.enum([
  'active',
  'matured',
  'closed_early',
  'under_lien',
  'closed',
  'renewed',
]);
export type FdAccountStatus = z.infer<typeof fdAccountStatusSchema>;

export const fdLienStatusSchema = z.enum(['active', 'released']);
export type FdLienStatus = z.infer<typeof fdLienStatusSchema>;

export const fdMaturityEventTypeSchema = z.enum([
  'pre_maturity_notice',
  'matured',
  'action_taken',
  'renewed',
  'transferred',
  'closed_early',
]);
export type FdMaturityEventType = z.infer<typeof fdMaturityEventTypeSchema>;

export const loanRepaymentFrequencySchema = z.enum(['daily', 'weekly', 'monthly', 'quarterly']);
export type LoanRepaymentFrequency = z.infer<typeof loanRepaymentFrequencySchema>;

export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money', 'upi', 'neft', 'rtgs']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

// ---------------------------------------------------------------------------
// FD rate cards
// ---------------------------------------------------------------------------

export const createRateCardSchema = z
  .object({
    minAmount: amountSchema,
    maxAmount: amountSchema,
    tenureMonths: z.coerce.number().int().min(1).max(120),
    interestRate: rateSchema,
    earlyClosurePenaltyPercent: penaltyPercentSchema.default('1.00'),
    minHoldingMonths: z.coerce.number().int().min(0).max(120).default(0),
    effectiveFrom: dateOnlySchema.optional(),
    isActive: z.boolean().optional(),
  })
  .refine(
    (value) => Number(value.minAmount) <= Number(value.maxAmount),
    'minAmount cannot exceed maxAmount',
  );
export type CreateRateCardInput = z.infer<typeof createRateCardSchema>;

export const listRateCardsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  tenureMonths: z.coerce.number().int().min(1).max(120).optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListRateCardsQuery = z.infer<typeof listRateCardsQuerySchema>;

// ---------------------------------------------------------------------------
// FD accounts
// ---------------------------------------------------------------------------

/**
 * Opening an FD account picks a rate card (amount band + tenure → rate) and
 * carries a deposit between ₹1,000 and ₹1,00,000 (spec §11.1, enforced by the
 * service and the DB CHECK on fd_account.deposit_amount).
 */
export const createAccountSchema = z.object({
  customerId: z.string().uuid('Invalid customer id'),
  rateCardId: z.string().uuid('Invalid rate card id'),
  branchId: z.string().uuid('Invalid branch id'),
  depositAmount: amountSchema,
  tenureMonths: z.coerce.number().int().min(1).max(120),
  startDate: dateOnlySchema.optional(),
  payoutFrequency: fdPayoutFrequencySchema,
  payoutMode: fdPayoutModeSchema.default('reinvest'),
  maturityAction: fdMaturityActionSchema.default('pending'),
  rateIsFixed: z.boolean().optional(),
  paymentMethod: paymentMethodSchema.default('cash'),
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const listAccountsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  customerId: z.string().uuid('Invalid customer id').optional(),
  rateCardId: z.string().uuid('Invalid rate card id').optional(),
  branchId: z.string().uuid('Invalid branch id').optional(),
  status: fdAccountStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

/**
 * Editing an FD account (M.D. only). Only the terms that can legitimately change
 * while the deposit is live are editable: a new rate card (with a matching
 * amount band + tenure re-checked by the service), the carried interest rate,
 * the fixed/floating flag and the interest-disposition instructions
 * (payout frequency / mode and the maturity action).
 *
 * The principal (`depositAmount`), tenure, customer, branch, start date and
 * status are immutable through this endpoint — those move via the lifecycle
 * actions (renewal / closure / payout / lien) instead.
 */
export const updateAccountSchema = z
  .object({
    rateCardId: z.string().uuid('Invalid rate card id').optional(),
    interestRate: rateSchema.optional(),
    rateIsFixed: z.boolean().optional(),
    payoutFrequency: fdPayoutFrequencySchema.optional(),
    payoutMode: fdPayoutModeSchema.optional(),
    maturityAction: fdMaturityActionSchema.optional(),
  })
  .refine(
    (value) => Object.values(value).some((field) => field !== undefined),
    'Provide at least one field to update',
  );
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

// ---------------------------------------------------------------------------
// Account lifecycle actions
// ---------------------------------------------------------------------------

/** Lien request/release on an FD account (Managing Director — spec §11.3). */
export const lienSchema = z
  .object({
    action: z.enum(['request', 'release']),
    lienAmount: amountSchema.optional(),
    reason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: 'lienAmount' | 'reason', message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (value.action === 'request') {
      if (value.lienAmount === undefined) {
        addIssue('lienAmount', 'lienAmount is required when requesting a lien');
      }
      if (!value.reason) {
        addIssue('reason', 'A lien reason is required when requesting a lien');
      }
    } else if (value.lienAmount !== undefined) {
      addIssue('lienAmount', 'lienAmount must not be provided when releasing a lien');
    }
  });
export type LienInput = z.infer<typeof lienSchema>;

export const closeEarlySchema = z.object({
  reason: z.string().trim().min(1, 'A closure reason is required').max(500),
  paymentMethod: paymentMethodSchema.default('cash'),
  referenceNumber: z.string().trim().max(60).optional(),
});
export type CloseEarlyInput = z.infer<typeof closeEarlySchema>;

/**
 * Maturity action — all options per spec §11.1: renew principal + interest,
 * renew principal only, transfer to savings, pay cash, pay bank.
 */
export const maturityActionSchema = z
  .object({
    action: z.enum([
      'renew_principal_interest',
      'renew_principal',
      'transfer_to_savings',
      'pay_cash',
      'pay_bank',
    ]),
    tenureMonths: z.coerce.number().int().min(1).max(120).optional(),
    savingsAccountId: z.string().uuid('Invalid savings account id').optional(),
    paymentMethod: paymentMethodSchema.optional(),
    referenceNumber: z.string().trim().max(60).optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: string, message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (value.action === 'transfer_to_savings') {
      if (!value.savingsAccountId) {
        addIssue('savingsAccountId', 'savingsAccountId is required when transferring to a savings account');
      }
    } else if (value.savingsAccountId !== undefined) {
      addIssue('savingsAccountId', 'savingsAccountId is only valid for transfer_to_savings');
    }
    if (value.action === 'pay_cash' || value.action === 'pay_bank') {
      if (!value.paymentMethod) {
        addIssue('paymentMethod', 'paymentMethod is required for cash or bank settlement');
      }
    }
    if (value.action !== 'renew_principal_interest' && value.action !== 'renew_principal') {
      if (value.tenureMonths !== undefined) {
        addIssue('tenureMonths', 'tenureMonths is only valid for renewal actions');
      }
    }
  });
export type MaturityActionInput = z.infer<typeof maturityActionSchema>;

/** Loan against FD — capped at 85% of the deposit by the service (spec §11.1). */
export const loanAgainstFdSchema = z.object({
  loanProductId: z.string().uuid('Invalid loan product id'),
  amount: amountSchema,
  tenureMonths: z.coerce.number().int().min(1).max(120),
  interestRate: rateSchema,
  repaymentFrequency: loanRepaymentFrequencySchema,
  purpose: z.string().trim().min(1, 'A loan purpose is required').max(300),
});
export type LoanAgainstFdInput = z.infer<typeof loanAgainstFdSchema>;

// ---------------------------------------------------------------------------
// History & path params
// ---------------------------------------------------------------------------

export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;

export const idParamSchema = z.object({
  id: uuidSchema,
});
