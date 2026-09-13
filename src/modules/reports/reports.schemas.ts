import { z } from 'zod';

/**
 * Reports request schemas (docs/backend-master-spec.md §17).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Dates travel as YYYY-MM-DD strings (spec §1.3) and are compared lexically,
 * which is safe for ISO-8601 calendar dates.
 *
 * Vocabulary mirrored here:
 *  - share channel : email | whatsapp | sms   (generated_report.shared_with)
 *  - statement product types : savingsDeposit | recurringDeposit | fixedDeposit | loan
 *
 * Filter keys are validated against report_definition.available_filters in the
 * service layer (the seed catalogue is the source of truth, not a hard-coded
 * union) so a newly seeded report works without a schema change.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/** Report share channel — delivered channels of a shared report record. */
export const shareChannelSchema = z.enum(['email', 'whatsapp', 'sms']);
export type ShareChannel = z.infer<typeof shareChannelSchema>;

/** Customer statement product filter (best-effort union across sub-ledgers). */
export const statementProductTypeSchema = z.enum([
  'savingsDeposit',
  'recurringDeposit',
  'fixedDeposit',
  'loan',
]);
export type StatementProductType = z.infer<typeof statementProductTypeSchema>;

/** Path parameter for /:type — report_definition.report_type (free text, seeded). */
export const reportTypeParamSchema = z.object({
  type: z.string().trim().min(1).max(80),
});
export type ReportTypeParam = z.infer<typeof reportTypeParamSchema>;

/** Path parameter shared by /:id routes (download / share) and /customers/:id. */
export const idParamSchema = z.object({ id: uuidSchema });

/** Path parameter for the alias route GET /statements/:customerId. */
export const customerIdParamSchema = z.object({ customerId: uuidSchema });

/**
 * POST /:type/generate body.
 *
 *  - fromDate / toDate are optional YYYY-MM-DD bounds (inclusive).
 *  - filters keys are validated against the definition's available_filters in
 *    the service; values stay unknown here because each report interprets its
 *    own filter vocabulary (ids are validated by the target builder).
 */
export const generateReportSchema = z
  .object({
    fromDate: dateOnlySchema.optional(),
    toDate: dateOnlySchema.optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.fromDate !== undefined && value.toDate !== undefined && value.fromDate > value.toDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromDate'],
        message: 'fromDate must not be after toDate',
      });
    }
  });
export type GenerateReportInput = z.infer<typeof generateReportSchema>;

/** POST /:id/share body — record-only sharing metadata (no outbound delivery). */
export const shareReportSchema = z.object({
  recipient: z.string().trim().min(1).max(500),
  channel: shareChannelSchema,
  note: z.string().trim().max(1000).optional(),
});
export type ShareReportInput = z.infer<typeof shareReportSchema>;

/**
 * GET /customers/:id/statements (and alias /statements/:customerId) query.
 * accountId / productType narrow the statement to one sub-ledger.
 */
export const customerStatementQuerySchema = z
  .object({
    fromDate: dateOnlySchema.optional(),
    toDate: dateOnlySchema.optional(),
    accountId: uuidSchema.optional(),
    productType: statementProductTypeSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.fromDate !== undefined && value.toDate !== undefined && value.fromDate > value.toDate) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['fromDate'],
        message: 'fromDate must not be after toDate',
      });
    }
  });
export type CustomerStatementQuery = z.infer<typeof customerStatementQuerySchema>;
