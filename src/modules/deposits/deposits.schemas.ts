import { z } from 'zod';

/**
 * Deposits / savings request schemas (docs/backend-master-spec.md §9).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints in 001_schema.sql
 * (deposit_product / savings_account / account_transaction /
 *  account_adjustment) so the boundary rejects unknown vocabulary before it
 * ever reaches SQL.
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

export const depositInterestMethodSchema = z.enum(['flat', 'reducing', 'tiered']);
export type DepositInterestMethod = z.infer<typeof depositInterestMethodSchema>;

export const depositInterestFrequencySchema = z.enum(['daily', 'monthly', 'quarterly', 'yearly']);
export type DepositInterestFrequency = z.infer<typeof depositInterestFrequencySchema>;

export const ratePolicySchema = z.enum(['fixed', 'variable']);
export type RatePolicy = z.infer<typeof ratePolicySchema>;

export const savingsAccountStatusSchema = z.enum(['pending_approval', 'active', 'frozen', 'closed']);
export type SavingsAccountStatus = z.infer<typeof savingsAccountStatusSchema>;

export const transactionTypeSchema = z.enum(['deposit', 'withdrawal', 'interest', 'adjustment', 'reversal']);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const directionSchema = z.enum(['credit', 'debit']);
export type Direction = z.infer<typeof directionSchema>;

export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money', 'upi', 'neft', 'rtgs']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const adjustmentTypeSchema = z.enum(['reversal', 'correction', 'replacement']);
export type AdjustmentType = z.infer<typeof adjustmentTypeSchema>;

// ---------------------------------------------------------------------------
// Deposit products
// ---------------------------------------------------------------------------

export const createProductSchema = z.object({
  code: z.string().trim().min(2, 'Product code is required').max(40),
  name: z.string().trim().min(2, 'Product name is required').max(160),
  description: z.string().trim().max(500).optional(),
  minOpeningAmount: amountSchema.default('100.00'),
  minBalance: amountSchema.default('100.00'),
  maxBalance: amountSchema.nullable().optional(),
  interestMethod: depositInterestMethodSchema.default('flat'),
  interestFrequency: depositInterestFrequencySchema.default('quarterly'),
  interestRate: rateSchema.default('4.0000'),
  ratePolicy: ratePolicySchema.default('variable'),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const listProductsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ---------------------------------------------------------------------------
// Savings accounts
// ---------------------------------------------------------------------------

export const createAccountSchema = z.object({
  customerId: z.string().uuid('Invalid customer id'),
  productId: z.string().uuid('Invalid product id'),
  branchId: z.string().uuid('Invalid branch id'),
  openingAmount: amountSchema,
  openedOn: dateOnlySchema.optional(),
  interestRate: rateSchema.optional(),
  paymentMethod: paymentMethodSchema.default('cash'),
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
});
export type CreateAccountInput = z.infer<typeof createAccountSchema>;

export const updateAccountSchema = z.object({
  productId: z.string().uuid('Invalid product id').optional(),
  interestRate: rateSchema.nullable().optional(),
});
export type UpdateAccountInput = z.infer<typeof updateAccountSchema>;

export const freezeAccountSchema = z.object({
  reason: z.string().trim().min(1, 'A freeze reason is required').max(500),
});
export type FreezeAccountInput = z.infer<typeof freezeAccountSchema>;

export const closeAccountSchema = z.object({
  reason: z.string().trim().min(1, 'A closure reason is required').max(500),
});
export type CloseAccountInput = z.infer<typeof closeAccountSchema>;

export const reopenAccountSchema = z.object({
  note: z.string().trim().max(500).optional(),
});
export type ReopenAccountInput = z.infer<typeof reopenAccountSchema>;

export const approveAccountSchema = z.object({
  note: z.string().trim().max(300).optional(),
});
export type ApproveAccountInput = z.infer<typeof approveAccountSchema>;

export const listAccountsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  customerId: z.string().uuid('Invalid customer id').optional(),
  productId: z.string().uuid('Invalid product id').optional(),
  branchId: z.string().uuid('Invalid branch id').optional(),
  status: savingsAccountStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuerySchema>;

// ---------------------------------------------------------------------------
// Ledger transactions, adjustments, statements
// ---------------------------------------------------------------------------

export const postTransactionSchema = z.object({
  transactionType: z.enum(['deposit', 'withdrawal']),
  amount: amountSchema,
  valueDate: dateOnlySchema.optional(),
  paymentMethod: paymentMethodSchema.default('cash'),
  referenceNumber: z.string().trim().max(60).optional(),
  description: z.string().trim().max(300).optional(),
});
export type PostTransactionInput = z.infer<typeof postTransactionSchema>;

export const listTransactionsQuerySchema = z.object({
  type: transactionTypeSchema.optional(),
  direction: directionSchema.optional(),
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

export const createAdjustmentSchema = z.object({
  adjustmentType: adjustmentTypeSchema,
  originalTransactionId: z.string().uuid('Invalid transaction id'),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
  evidenceReferences: z.array(z.string().trim().min(1).max(200)).max(20).optional(),
  customerConfirmed: z.boolean().default(false),
});
export type CreateAdjustmentInput = z.infer<typeof createAdjustmentSchema>;

export const statementQuerySchema = z.object({
  from: dateOnlySchema.optional(),
  to: dateOnlySchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StatementQuery = z.infer<typeof statementQuerySchema>;

export const idParamSchema = z.object({
  id: uuidSchema,
});
