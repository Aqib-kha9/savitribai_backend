import { z } from 'zod';

/**
 * Loans request schemas (docs/backend-master-spec.md §12).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints in 001_schema.sql
 * (loan_product / loan_application / loan / loan_guarantor / loan_collateral /
 * loan_instalment / loan_surplus / loan_restructure / loan_writeoff) so the
 * boundary rejects unknown vocabulary before it ever reaches SQL.
 *
 * Business rules surfaced here (spec §12.5):
 *  - interest is flat on the original approved amount (per product config);
 *  - instalments due on a holiday are shifted one day to the next working day;
 *  - a short payment is applied interest-first, then per the product's
 *    allocation order (penalty -> fees -> principal);
 *  - any surplus above the instalment is held in the loan account and released
 *    only when the loan is completed;
 *  - collateral valuation supports at most 60% lending (maxLtvPercent);
 *  - a guarantor may back at most GUARANTOR_MAX_ACTIVE_LOANS (2) active loans.
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

/** Loan product interest rate — DB CHECK enforces 4.0000–25.0000. */
const productRateSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,4})?$/, 'Interest rate must be a decimal with at most 4 decimal places')
  .refine((value) => Number(value) >= 4 && Number(value) <= 25, 'Interest rate must be between 4 and 25');

/** Lending limit as a percent of collateral valuation — NUMERIC(5,2) payload. */
const percentSchema = z
  .string()
  .regex(/^\d{1,3}(\.\d{1,2})?$/, 'Percent must be a decimal with at most 2 decimal places')
  .refine((value) => Number(value) >= 0 && Number(value) <= 100, 'Percent must be between 0 and 100');

export const loanCategorySchema = z.enum(['business', 'shg', 'personal', 'mortgage', 'gold', 'other']);
export type LoanCategory = z.infer<typeof loanCategorySchema>;

export const loanInterestMethodSchema = z.enum(['flat', 'reducing']);
export type LoanInterestMethod = z.infer<typeof loanInterestMethodSchema>;

export const loanRatePolicySchema = z.enum(['fixed', 'variable']);
export type LoanRatePolicy = z.infer<typeof loanRatePolicySchema>;

export const loanRepaymentFrequencySchema = z.enum(['daily', 'weekly', 'monthly', 'quarterly']);
export type LoanRepaymentFrequency = z.infer<typeof loanRepaymentFrequencySchema>;

export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money', 'upi', 'neft', 'rtgs']);
export type PaymentMethod = z.infer<typeof paymentMethodSchema>;

export const loanApplicationStatusSchema = z.enum([
  'applied',
  'recommended',
  'approved',
  'rejected',
  'disbursed',
  'cancelled',
]);
export type LoanApplicationStatus = z.infer<typeof loanApplicationStatusSchema>;

export const loanStatusSchema = z.enum(['active', 'overdue', 'rescheduled', 'settled', 'written_off', 'closed']);
export type LoanStatus = z.infer<typeof loanStatusSchema>;

export const loanInstalmentStatusSchema = z.enum(['due', 'paid', 'partial', 'missed', 'overdue', 'waived']);
export type LoanInstalmentStatus = z.infer<typeof loanInstalmentStatusSchema>;

export const surplusEntryTypeSchema = z.enum(['held', 'released', 'applied']);
export type SurplusEntryType = z.infer<typeof surplusEntryTypeSchema>;

export const restructureChangeTypeSchema = z.enum(['reschedule', 'refinance', 'extend']);
export type RestructureChangeType = z.infer<typeof restructureChangeTypeSchema>;

/** Repayment allocation components — order is product-configurable (spec §12.5.3). */
const allocationComponentSchema = z.enum(['interest', 'penalty', 'fees', 'principal']);
type AllocationComponent = z.infer<typeof allocationComponentSchema>;

const defaultAllocationOrder = ['interest', 'penalty', 'fees', 'principal'] as const;

// ---------------------------------------------------------------------------
// Loan products
// ---------------------------------------------------------------------------

export const createProductSchema = z
  .object({
    code: z
      .string()
      .trim()
      .min(2)
      .max(20)
      .regex(/^[A-Z0-9][A-Z0-9_-]*$/, 'Code must be uppercase letters, digits, underscore or hyphen'),
    name: z.string().trim().min(2).max(120),
    category: loanCategorySchema,
    minAmount: amountSchema.default('5000.00'),
    maxAmount: amountSchema.default('500000.00'),
    minTenureMonths: z.coerce.number().int().min(1).max(120).default(3),
    maxTenureMonths: z.coerce.number().int().min(1).max(240).default(120),
    interestMethod: loanInterestMethodSchema.default('flat'),
    interestRate: productRateSchema.default('12.0000'),
    ratePolicy: loanRatePolicySchema.default('variable'),
    repaymentFrequency: loanRepaymentFrequencySchema.default('monthly'),
    penaltyConfig: z.record(z.string(), z.unknown()).optional(),
    allocationOrder: z
      .array(allocationComponentSchema)
      .min(2)
      .max(4)
      .default([...defaultAllocationOrder]),
    guarantorLimit: z.coerce.number().int().min(0).max(20).default(2),
    collateralRequired: z.boolean().default(false),
    maxLtvPercent: percentSchema.default('60.00'),
    allowedPurposes: z.array(z.string().trim().min(1).max(300)).max(30).optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: string, message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (Number(value.minAmount) > Number(value.maxAmount)) {
      addIssue('minAmount', 'minAmount cannot exceed maxAmount');
    }
    if (value.minTenureMonths > value.maxTenureMonths) {
      addIssue('minTenureMonths', 'minTenureMonths cannot exceed maxTenureMonths');
    }
    const unique = new Set<string>(value.allocationOrder);
    if (unique.size !== value.allocationOrder.length) {
      addIssue('allocationOrder', 'allocationOrder components must be unique');
    }
    if (!value.allocationOrder.includes('interest')) {
      addIssue('allocationOrder', "allocationOrder must include 'interest'");
    }
    if (!value.allocationOrder.includes('principal')) {
      addIssue('allocationOrder', "allocationOrder must include 'principal'");
    }
  });
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const listProductsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  category: loanCategorySchema.optional(),
  includeInactive: z.enum(['true', 'false']).default('false'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListProductsQuery = z.infer<typeof listProductsQuerySchema>;

// ---------------------------------------------------------------------------
// Loan applications
// ---------------------------------------------------------------------------

/** A proposed guarantor — captured at application time and stored with the
 * application documents, then materialised into loan_guarantor on disbursal. */
const guarantorSchema = z.object({
  customerId: uuidSchema.optional(),
  name: z.string().trim().min(1, 'A guarantor name is required').max(200),
  relationship: z.string().trim().max(80).optional(),
  identityDocumentType: z.string().trim().max(40).optional(),
  identityDocumentNumber: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).optional(),
  address: z.string().trim().max(300).optional(),
});
export type GuarantorInput = z.infer<typeof guarantorSchema>;

/** Proposed collateral — materialised into loan_collateral on disbursal. The
 * 60% lending limit (spec §12.5.5) is enforced against valuation_amount. */
const collateralSchema = z.object({
  collateralType: z.string().trim().min(1, 'A collateral type is required').max(80),
  description: z.string().trim().max(300).optional(),
  valuationAmount: amountSchema,
  valuationDate: dateOnlySchema.optional(),
  documentReference: z.string().trim().max(120).optional(),
});
export type CollateralInput = z.infer<typeof collateralSchema>;

export const createApplicationSchema = z
  .object({
    customerId: z.string().uuid('Invalid customer id'),
    productId: z.string().uuid('Invalid loan product id'),
    branchId: z.string().uuid('Invalid branch id'),
    purpose: z.string().trim().min(3, 'A loan purpose is required').max(300),
    requestedAmount: amountSchema,
    tenureMonths: z.coerce.number().int().min(1).max(240),
    repaymentFrequency: loanRepaymentFrequencySchema,
    proposedInterestRate: rateSchema.optional(),
    guarantors: z.array(guarantorSchema).max(20).optional(),
    collateral: z.array(collateralSchema).max(20).optional(),
    documents: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: string, message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    // Home loans are not offered (spec §12.1) — a mortgage product application
    // must state a non-home purpose explicitly.
    if (value.purpose.toLowerCase().includes('home loan')) {
      addIssue('purpose', 'Home loans are not offered');
    }
    if (value.collateral && value.collateral.length > 0) {
      const names = new Set(value.collateral.map((item) => item.collateralType.toLowerCase()));
      if (names.size !== value.collateral.length) {
        addIssue('collateral', 'Collateral types must be unique');
      }
    }
  });
export type CreateApplicationInput = z.infer<typeof createApplicationSchema>;

export const listApplicationsQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  customerId: z.string().uuid('Invalid customer id').optional(),
  productId: z.string().uuid('Invalid loan product id').optional(),
  status: loanApplicationStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListApplicationsQuery = z.infer<typeof listApplicationsQuerySchema>;

/** Query filters for the disbursed loan list (spec §12.3, list loans). */
export const listLoansQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  customerId: z.string().uuid('Invalid customer id').optional(),
  productId: z.string().uuid('Invalid loan product id').optional(),
  status: loanStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListLoansQuery = z.infer<typeof listLoansQuerySchema>;

/** Recommendation is a status transition with no further data (spec §12.3). */
export const recommendSchema = z.object({});
export type RecommendInput = z.infer<typeof recommendSchema>;

/**
 * Approval (President, M.D. secondary). Either approve with an approved amount
 * (+ optional final rate / tenure) or reject with a reason — never both.
 */
export const approveSchema = z
  .object({
    approvedAmount: amountSchema.optional(),
    approvedTenureMonths: z.coerce.number().int().min(1).max(240).optional(),
    finalInterestRate: rateSchema.optional(),
    rejectionReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: string, message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (value.rejectionReason) {
      if (value.approvedAmount !== undefined) {
        addIssue('approvedAmount', 'approvedAmount must not be provided when rejecting');
      }
    } else if (value.approvedAmount === undefined) {
      addIssue('approvedAmount', 'approvedAmount is required when approving a loan');
    }
  });
export type ApproveInput = z.infer<typeof approveSchema>;

// ---------------------------------------------------------------------------
// Loan lifecycle actions
// ---------------------------------------------------------------------------

/** Disbursal happens on the approved application; date defaults to today. */
export const disburseSchema = z.object({
  disbursedOn: dateOnlySchema.optional(),
});
export type DisburseInput = z.infer<typeof disburseSchema>;

/** Record a repayment against the loan (allocation engine, spec §12.5.3/4). */
export const recordRepaymentSchema = z
  .object({
    amount: amountSchema,
    paidOn: dateOnlySchema.optional(),
    paymentMethod: paymentMethodSchema,
    referenceNumber: z.string().trim().max(60).optional(),
    collectionEntryId: z.string().uuid('Invalid collection entry id').optional(),
  })
  .superRefine((value, context) => {
    const addIssue = (field: string, message: string): void => {
      context.addIssue({ code: z.ZodIssueCode.custom, path: [field], message });
    };
    if (value.paymentMethod !== 'cash' && value.paymentMethod !== 'mobile_money') {
      if (!value.referenceNumber) {
        addIssue('referenceNumber', 'referenceNumber is required for electronic or cheque payments');
      }
    }
  });
export type RecordRepaymentInput = z.infer<typeof recordRepaymentSchema>;

/** M.D. correction of a wrongly-recorded repayment on one instalment. */
export const correctRepaymentSchema = z.object({
  correctedAmount: amountSchema,
  reason: z.string().trim().min(3, 'A correction reason is required').max(500),
});
export type CorrectRepaymentInput = z.infer<typeof correctRepaymentSchema>;

/** Reschedule spreads the remaining balance over a new term (President). */
export const rescheduleSchema = z.object({
  effectiveFrom: dateOnlySchema,
  newTenureMonths: z.coerce.number().int().min(1).max(240).optional(),
  newInterestRate: rateSchema.optional(),
  reason: z.string().trim().min(3, 'A reschedule reason is required').max(500),
});
export type RescheduleInput = z.infer<typeof rescheduleSchema>;

/** Full settlement — the loan must have no outstanding amount. */
export const settleSchema = z.object({
  settledOn: dateOnlySchema.optional(),
  reason: z.string().trim().max(500).optional(),
});
export type SettleInput = z.infer<typeof settleSchema>;

/** Write-off of the outstanding balance (President). */
export const writeOffSchema = z.object({
  reason: z.string().trim().min(3, 'A write-off reason is required').max(500),
});
export type WriteOffInput = z.infer<typeof writeOffSchema>;

/** Transfer of the loan to another branch (recorded as a refinance restructure). */
export const transferSchema = z.object({
  toBranchId: z.string().uuid('Invalid branch id'),
  reason: z.string().trim().min(3, 'A transfer reason is required').max(500),
});
export type TransferInput = z.infer<typeof transferSchema>;

/**
 * Waiver (President) — waive a specific unpaid instalment or a capped amount
 * of the outstanding balance.
 */
export const waiverSchema = z
  .object({
    instalmentId: z.string().uuid('Invalid instalment id').optional(),
    amount: amountSchema.optional(),
    reason: z.string().trim().min(3, 'A waiver reason is required').max(500),
  })
  .refine((value) => value.instalmentId !== undefined || value.amount !== undefined, {
    message: 'Provide either an instalmentId or an amount to waive',
    path: ['instalmentId'],
  });
export type WaiverInput = z.infer<typeof waiverSchema>;

/** Release a held surplus — only once the loan is completed (spec §12.5.4). */
export const surplusReleaseSchema = z.object({
  amount: amountSchema.optional(),
  reason: z.string().trim().max(500).optional(),
});
export type SurplusReleaseInput = z.infer<typeof surplusReleaseSchema>;

// ---------------------------------------------------------------------------
// Schedule / statements & path params
// ---------------------------------------------------------------------------

export const scheduleQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(1000).default(500),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ScheduleQuery = z.infer<typeof scheduleQuerySchema>;

export const statementsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type StatementsQuery = z.infer<typeof statementsQuerySchema>;

export const idParamSchema = z.object({
  id: uuidSchema,
});

export const repaymentIdParamSchema = z.object({
  id: uuidSchema,
});
