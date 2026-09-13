import { z } from 'zod';

/**
 * Dashboard query schemas (docs/backend-master-spec.md §23).
 *
 * The dashboard module exposes read-only aggregation surfaces. Because the
 * client questionnaire §2 was entirely unanswered (open item #1), every §23.3
 * decision is implemented as a 🔧 default pending client confirmation:
 *
 *   1. Figures shown depend on the caller's role (President/VP/Manager see the
 *      whole organisation; cashier sees collections/withdrawals work; clerk
 *      sees operational lists; collection_agent sees only their own day).
 *   2. Scope defaults to the whole organisation for admin roles; collection
 *      agents are always scoped to their own assignments (decision #2).
 *   3. "Today" defaults to the IST organisation business date
 *      (decision #3 — istBusinessDate()).
 *   4. Pending items include unreviewed/requires-review collections,
 *      unapproved withdrawals, overdue loans, unresolved reconciliation
 *      differences, and open complaints (decision #4).
 *   5. Urgency: items are listed newest first; overdue loans are ordered by
 *      days overdue descending (decision #5).
 *   6. Exception thresholds: loans overdue ≥ 1 day; unresolved differences and
 *      open complaints age ≥ 1 day (decision #6 — conservative defaults).
 *   7. Role visibility is enforced both at the route layer
 *      (requirePermission) and inside the service (decision #7).
 *   8. Cash / digital / bank (UPI, NEFT, RTGS, cheque) amounts are reported
 *      separately (decision #8 — recommended "yes").
 *   9. Refresh frequency is a client concern (front-end polling); the API
 *      always returns fresh data (decision #9).
 *  10. Quick actions are a front-end concern keyed on role (decision #10).
 *  11. Every figure carries an id/date so the client can drill down to the
 *      underlying list (decision #11).
 *  12. Branch/agent comparison is exposed via the agent performance surface
 *      (decision #12 — no target progress until targets exist).
 *  13. Daily targets: not implemented — no target tables exist in the schema
 *      (decision #13 pending).
 *  14. Target change authority: pending (decision #14).
 *  15. Reversed/rejected items are excluded from aggregates (collection
 *      reversals via NOT EXISTS; rejected status excluded) so a corrected or
 *      reversed item does not distort today's figures (decision #15).
 *
 * Date-only values travel as YYYY-MM-DD strings (spec §1.3).
 */

const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

/**
 * GET /overview query — nothing is required; every default is server-side.
 * A date can be supplied for historical views (defaults to today's IST
 * business date).
 */
export const dashboardOverviewQuerySchema = z.object({
  date: dateOnlySchema.optional(),
});
export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;

/**
 * The pending-work item kinds a dashboard can surface (decision #4).
 */
export const pendingItemKindSchema = z.enum([
  'collections',
  'withdrawals',
  'overdueLoans',
  'reconciliationDifferences',
  'complaints',
]);
export type PendingItemKind = z.infer<typeof pendingItemKindSchema>;

/**
 * GET /pending query — the pending-work surface. Items are always returned;
 * a `kinds` filter can narrow the set. Query-string arrays travel as
 * comma-separated values (e.g. ?kinds=collections,withdrawals), so the raw
 * string is split before validation.
 */
export const dashboardPendingQuerySchema = z.object({
  /** Pending-item kinds to include (default: all). */
  kinds: z.preprocess(
    (value) => {
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part.length > 0);
      }
      return value;
    },
    z.array(pendingItemKindSchema).optional(),
  ),
});
export type DashboardPendingQuery = z.infer<typeof dashboardPendingQuerySchema>;

/**
 * GET /performance/agents query — per-agent aggregation over a date window.
 */
export const agentPerformanceDashboardQuerySchema = z
  .object({
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    agentId: z.string().uuid('Invalid agent id').optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
  })
  .superRefine((value, ctx) => {
    if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['from'],
        message: 'from must not be after to',
      });
    }
  });
export type AgentPerformanceDashboardQuery = z.infer<typeof agentPerformanceDashboardQuerySchema>;

/**
 * GET /transactions/recent query — most recent account_transaction rows.
 */
export const recentTransactionsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});
export type RecentTransactionsQuery = z.infer<typeof recentTransactionsQuerySchema>;
