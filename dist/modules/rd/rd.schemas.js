import { z } from 'zod';
/**
 * Recurring deposits request schemas (docs/backend-master-spec.md §10).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints in 001_schema.sql
 * (rd_scheme / rd_account / rd_instalment / rd_penalty) so the boundary
 * rejects unknown vocabulary before it ever reaches SQL.
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
export const rdFrequencySchema = z.enum(['daily', 'weekly', 'monthly', 'quarterly']);
export const rdAccountStatusSchema = z.enum([
    'active',
    'overdue',
    'completed',
    'matured',
    'closed_early',
    'suspended',
    'cancelled',
]);
export const rdInstalmentStatusSchema = z.enum(['due', 'paid', 'partial', 'missed', 'overdue', 'waived']);
export const rdPenaltyStatusSchema = z.enum(['due', 'paid', 'waived']);
export const interestCreditFrequencySchema = z.enum(['yearly', 'half_yearly']);
export const rdScheduleChangeTypeSchema = z.enum(['due_date_change', 'instalment_amount_change', 'both']);
export const paymentMethodSchema = z.enum(['cash', 'bank_transfer', 'cheque', 'mobile_money', 'upi', 'neft', 'rtgs']);
// ---------------------------------------------------------------------------
// RD schemes
// ---------------------------------------------------------------------------
export const createSchemeSchema = z.object({
    code: z.string().trim().min(2, 'Scheme code is required').max(40),
    name: z.string().trim().min(2, 'Scheme name is required').max(160),
    description: z.string().trim().max(500).optional(),
    frequency: rdFrequencySchema,
    minInstalmentAmount: amountSchema.default('100.00'),
    maxInstalmentAmount: amountSchema.nullable().optional(),
    minDurationMonths: z.coerce.number().int().min(1).max(120).default(6),
    maxDurationMonths: z.coerce.number().int().min(1).max(120).default(120),
    gracePeriodMonths: z.coerce.number().int().min(0).max(12).default(1),
    interestRate: rateSchema.default('6.0000'),
    interestCreditFrequency: interestCreditFrequencySchema.default('yearly'),
    earlyClosureFeePercent: rateSchema.default('4.00'),
    penaltyConfig: z.record(z.unknown()).optional(),
});
export const listSchemesQuerySchema = z.object({
    search: z.string().trim().max(80).optional(),
    includeInactive: z.enum(['true', 'false']).default('false'),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
// ---------------------------------------------------------------------------
// RD accounts
// ---------------------------------------------------------------------------
/**
 * Opening an RD account requires either an explicit maturity date or a term in
 * months. Exactly one of the two must be present — the service derives the
 * instalment schedule from firstDueDate + frequency over the chosen term.
 */
export const createAccountSchema = z
    .object({
    customerId: z.string().uuid('Invalid customer id'),
    schemeId: z.string().uuid('Invalid scheme id'),
    branchId: z.string().uuid('Invalid branch id'),
    instalmentAmount: amountSchema,
    frequency: rdFrequencySchema,
    startDate: dateOnlySchema.optional(),
    firstDueDate: dateOnlySchema,
    maturityDate: dateOnlySchema.optional(),
    durationMonths: z.coerce.number().int().min(1).max(120).optional(),
    paymentMethod: paymentMethodSchema.default('cash'),
    referenceNumber: z.string().trim().max(60).optional(),
    description: z.string().trim().max(300).optional(),
})
    .refine((value) => value.maturityDate !== undefined || value.durationMonths !== undefined, 'Provide either a maturityDate or a durationMonths term for the RD account');
export const listAccountsQuerySchema = z.object({
    search: z.string().trim().max(80).optional(),
    customerId: z.string().uuid('Invalid customer id').optional(),
    schemeId: z.string().uuid('Invalid scheme id').optional(),
    branchId: z.string().uuid('Invalid branch id').optional(),
    status: rdAccountStatusSchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
// ---------------------------------------------------------------------------
// Instalments & schedule
// ---------------------------------------------------------------------------
export const instalmentPaymentSchema = z.object({
    amount: amountSchema,
    paidOn: dateOnlySchema.optional(),
    paymentMethod: paymentMethodSchema.default('cash'),
    referenceNumber: z.string().trim().max(60).optional(),
    collectionEntryId: z.string().uuid('Invalid collection entry id').optional(),
});
export const scheduleQuerySchema = z.object({
    status: rdInstalmentStatusSchema.optional(),
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(200),
    offset: z.coerce.number().int().min(0).default(0),
});
// ---------------------------------------------------------------------------
// Penalty waiver (President), reschedule (President), closure, surplus
// ---------------------------------------------------------------------------
export const penaltyWaiverSchema = z.object({
    penaltyId: z.string().uuid('Invalid penalty id'),
    amount: amountSchema.optional(),
    reason: z.string().trim().min(1, 'A waiver reason is required').max(500),
});
export const rescheduleSchema = z
    .object({
    changeType: rdScheduleChangeTypeSchema.default('both'),
    effectiveFrom: dateOnlySchema,
    newInstalmentAmount: amountSchema.optional(),
    reason: z.string().trim().min(1, 'A reschedule reason is required').max(500),
})
    .refine((value) => value.changeType === 'due_date_change'
    ? value.newInstalmentAmount === undefined
    : value.newInstalmentAmount !== undefined, 'instalment_amount_change requires a newInstalmentAmount; due_date_change must not carry one');
export const closeEarlySchema = z.object({
    reason: z.string().trim().min(1, 'A closure reason is required').max(500),
    paymentMethod: paymentMethodSchema.default('cash'),
    referenceNumber: z.string().trim().max(60).optional(),
});
export const surplusTransferSchema = z.object({
    loanId: z.string().uuid('Invalid loan id'),
    amount: amountSchema,
    reason: z.string().trim().max(500).optional(),
});
export const approvalSchema = z.object({
    note: z.string().trim().max(300).optional(),
});
export const idParamSchema = z.object({
    id: uuidSchema,
});
