import { query } from '../../database/client.js';
import { istBusinessDate } from '../../core/time.js';
import { NotFoundError } from '../../core/errors.js';
import type { StaffRole } from '../../core/permissions.js';
import type { AuthContext } from '../../types/auth-context.js';
import type { PendingItemKind } from './dashboard.schemas.js';
import type {
  AgentPerformanceDashboardQuery,
  DashboardOverviewQuery,
  DashboardPendingQuery,
  RecentTransactionsQuery,
} from './dashboard.schemas.js';

/**
 * Dashboard service (docs/backend-master-spec.md §23, Module 17).
 *
 * The client questionnaire §2 was entirely unanswered (open item #1), so every
 * §23.3 decision is implemented as a 🔧 default pending client confirmation:
 *
 *   1. Figures depend on the caller's role. Collection agents see only their
 *      own day; office roles see the whole organisation (branchId is null for
 *      admin roles in AuthContext, so whole-org is the default scope — #2).
 *   3. "Today" is the IST organisation business date (istBusinessDate()).
 *   4. Pending items: unreviewed/requires-review collections, unapproved
 *      withdrawals, overdue loans, unresolved reconciliation differences and
 *      open complaints. Which kinds a role may see is driven by permissions
 *      (#7): withdrawals need withdrawals.read, overdue loans loans.read,
 *      differences reconciliation.read, complaints office roles only.
 *   5. Urgency: every list is newest first; overdue loans are ordered by due
 *      date ascending (most overdue first).
 *   6. Exception thresholds: loans overdue ≥ 1 day (next_due_date < today),
 *      unresolved differences / open complaints are any age (#6 — conservative).
 *   8. Cash / digital (UPI) / bank (NEFT, RTGS, cheque) amounts are reported
 *      separately, with a per-mode breakdown for drill-down.
 *  11. Every aggregate figure carries ids/dates so the client can drill down
 *      to the underlying lists.
 *  12. Branch/agent comparison is served by the agent performance surface.
 *  13/14. Daily targets are NOT implemented — no target tables exist in the
 *      schema (pending client decision).
 *  15. Reversed and rejected items are excluded from every aggregate:
 *      `NOT EXISTS` on collection_reversal plus a status filter, so a
 *      corrected or reversed item never distorts today's figures.
 *
 * The whole module is read-only, so — following the audit.routes.ts precedent —
 * no audit events are written for dashboard reads (querying the trail for
 * every page load would be noise; mutations are audited by their own modules).
 *
 * Money is emitted as a JSON number here because these results feed chart and
 * aggregate views, not ledger storage (same precedent as getAgentPerformance).
 */

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface CollectionModeBreakdown {
  mode: string;
  entryCount: number;
  amount: number;
}

export interface RecentTransactionView {
  id: string;
  transactionType: string;
  direction: string;
  amount: number;
  valueDate: string;
  paymentMethod: string | null;
  referenceNumber: string | null;
  description: string | null;
  performedSource: string;
  createdAt: string;
  accountNumber: string;
  customerName: string;
}

export interface DashboardOverviewView {
  date: string;
  collections: {
    entryCount: number;
    totalAmount: number;
    cashAmount: number;
    digitalAmount: number;
    bankAmount: number;
    byMode: CollectionModeBreakdown[];
    acceptedCount: number;
    waitingCount: number;
  };
  activeAgents: { total: number; activeToday: number };
  averageCollection: { perEntry: number; perActiveAgent: number };
  pendingCounts: Partial<Record<PendingItemKind, number>>;
  /** Empty unless the caller holds deposits.read (role visibility, #7). */
  recentTransactions: RecentTransactionView[];
}

export type PendingItemView =
  | {
      kind: 'collections';
      id: string;
      status: string;
      amount: number;
      mode: string;
      businessDate: string;
      customerName: string;
      agentCode: string;
    }
  | {
      kind: 'withdrawals';
      id: string;
      requestNumber: string;
      amount: number;
      customerName: string;
      requestedOn: string;
    }
  | {
      kind: 'overdueLoans';
      id: string;
      loanNumber: string;
      outstandingAmount: number;
      customerName: string;
      nextDueDate: string | null;
      daysOverdue: number;
    }
  | {
      kind: 'reconciliationDifferences';
      id: string;
      differenceType: string;
      amount: number;
      agentCode: string;
      createdOn: string;
    }
  | {
      kind: 'complaints';
      id: string;
      customerName: string;
      category: string | null;
      status: string;
      createdOn: string;
    };

export interface DashboardPendingResult {
  date: string;
  /** The kinds actually returned after the role/permission filter. */
  kinds: PendingItemKind[];
  counts: Partial<Record<PendingItemKind, number>>;
  items: PendingItemView[];
  perKindLimit: number;
}

export interface AgentPerformanceEntryView {
  agentId: string;
  agentCode: string;
  agentName: string;
  entryCount: number;
  totalAmount: number;
  cashAmount: number;
  digitalAmount: number;
  customerCount: number;
  acceptedCount: number;
  waitingCount: number;
}

export interface AgentPerformanceDashboardResult {
  items: AgentPerformanceEntryView[];
  total: number;
  summary: {
    from: string;
    to: string;
    agentCount: number;
    entryCount: number;
    totalAmount: number;
  };
}

export interface RecentTransactionsResult {
  items: RecentTransactionView[];
  total: number;
  page: number;
  pageSize: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type OverviewAggRow = {
  entryCount: number;
  totalAmount: number;
  cashAmount: number;
  digitalAmount: number;
  bankAmount: number;
  acceptedCount: number;
  waitingCount: number;
  activeAgentsToday: number;
};

type ModeBreakdownRow = CollectionModeBreakdown;

type CountRow = { total: number };

type RecentTransactionRow = RecentTransactionView;

type PendingCollectionRow = {
  id: string;
  status: string;
  amount: number;
  mode: string;
  businessDate: string;
  customerName: string;
  agentCode: string;
};

type PendingWithdrawalRow = {
  id: string;
  requestNumber: string;
  amount: number;
  customerName: string;
  requestedOn: string;
};

type PendingLoanRow = {
  id: string;
  loanNumber: string;
  outstandingAmount: number;
  customerName: string;
  nextDueDate: string | null;
  daysOverdue: number;
};

type PendingDifferenceRow = {
  id: string;
  differenceType: string;
  amount: number;
  agentCode: string;
  createdOn: string;
};

type PendingComplaintRow = {
  id: string;
  customerName: string;
  category: string | null;
  status: string;
  createdOn: string;
};

type PerformanceRow = {
  agentId: string;
  agentCode: string;
  agentName: string;
  entryCount: number;
  totalAmount: number;
  cashAmount: number;
  digitalAmount: number;
  customerCount: number;
  acceptedCount: number;
  waitingCount: number;
  total: number;
};

type PerformanceSummaryRow = {
  agentCount: number;
  entryCount: number;
  totalAmount: number;
};

// ---------------------------------------------------------------------------
// Scope & role visibility
// ---------------------------------------------------------------------------

/** A collection agent is always scoped to their own record (#1/#2 defaults). */
type DashboardScope = { agentId: string | null };

async function resolveScope(actor: AuthContext): Promise<DashboardScope> {
  if (actor.role !== 'collection_agent') return { agentId: null };
  const result = await query<{ id: string }>(
    'SELECT id FROM agent WHERE staff_id = $1',
    [actor.staffId],
  );
  const row = result.rows[0];
  if (!row) throw new NotFoundError('Agent profile not found for the current staff member');
  return { agentId: row.id };
}

/** Complaints are an office surface — agents and cashiers never see them. */
const COMPLAINT_VISIBLE_ROLES: ReadonlySet<StaffRole> = new Set([
  'managing_director',
  'president',
  'vice_president',
  'manager',
  'clerk',
]);

/**
 * Which pending-item kinds the caller may see (#7). Route middleware already
 * guarantees collections.read (held by every role); finer kinds are gated on
 * the permissions that own them so a figure is never shown to a role that
 * could not open the underlying list.
 */
function visibleKinds(actor: AuthContext, scope: DashboardScope): PendingItemKind[] {
  if (scope.agentId !== null) {
    const kinds: PendingItemKind[] = [];
    if (actor.permissions.includes('collections.read')) kinds.push('collections');
    if (actor.permissions.includes('reconciliation.read')) kinds.push('reconciliationDifferences');
    return kinds;
  }
  const kinds: PendingItemKind[] = [];
  if (actor.permissions.includes('collections.read')) kinds.push('collections');
  if (actor.permissions.includes('withdrawals.read')) kinds.push('withdrawals');
  if (actor.permissions.includes('loans.read')) kinds.push('overdueLoans');
  if (actor.permissions.includes('reconciliation.read')) kinds.push('reconciliationDifferences');
  if (COMPLAINT_VISIBLE_ROLES.has(actor.role)) kinds.push('complaints');
  return kinds;
}

// ---------------------------------------------------------------------------
// Pending work: counts + items (decision #4)
// ---------------------------------------------------------------------------

const PENDING_ITEM_LIMIT = 10;

async function countPendingItems(
  scope: DashboardScope,
  kinds: PendingItemKind[],
  date: string,
): Promise<Partial<Record<PendingItemKind, number>>> {
  const counts: Partial<Record<PendingItemKind, number>> = {};
  const jobs: Promise<void>[] = [];

  for (const kind of kinds) {
    switch (kind) {
      case 'collections': {
        const params: unknown[] = [];
        const where: string[] = [
          `ce.status IN ('waiting','requiresReview')`,
          `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
        ];
        if (scope.agentId !== null) {
          params.push(scope.agentId);
          where.push(`ce.agent_id = $${params.length}`);
        }
        jobs.push(
          query<CountRow>(
            `SELECT COUNT(*)::int AS total
               FROM collection_entry ce
              WHERE ce.is_deleted = false AND ${where.join(' AND ')}`,
            params,
          ).then((result) => {
            counts.collections = result.rows[0]?.total ?? 0;
          }),
        );
        break;
      }
      case 'withdrawals': {
        jobs.push(
          query<CountRow>(
            `SELECT COUNT(*)::int AS total FROM withdrawal_request WHERE status = 'pending'`,
          ).then((result) => {
            counts.withdrawals = result.rows[0]?.total ?? 0;
          }),
        );
        break;
      }
      case 'overdueLoans': {
        jobs.push(
          query<CountRow>(
            `SELECT COUNT(*)::int AS total
               FROM loan
              WHERE status = 'overdue'
                 OR (status IN ('active','rescheduled')
                     AND next_due_date IS NOT NULL AND next_due_date < $1::date)`,
            [date],
          ).then((result) => {
            counts.overdueLoans = result.rows[0]?.total ?? 0;
          }),
        );
        break;
      }
      case 'reconciliationDifferences': {
        const params: unknown[] = [];
        let where = `rd.status = 'unresolved'`;
        if (scope.agentId !== null) {
          params.push(scope.agentId);
          where += ` AND dc.agent_id = $${params.length}`;
        }
        jobs.push(
          query<CountRow>(
            `SELECT COUNT(*)::int AS total
               FROM reconciliation_difference rd
               JOIN day_close dc ON dc.id = rd.day_close_id
              WHERE ${where}`,
            params,
          ).then((result) => {
            counts.reconciliationDifferences = result.rows[0]?.total ?? 0;
          }),
        );
        break;
      }
      case 'complaints': {
        jobs.push(
          query<CountRow>(
            `SELECT COUNT(*)::int AS total
               FROM customer_complaint
              WHERE status IN ('open','in_progress')`,
          ).then((result) => {
            counts.complaints = result.rows[0]?.total ?? 0;
          }),
        );
        break;
      }
    }
  }

  await Promise.all(jobs);
  return counts;
}

async function fetchPendingItems(
  scope: DashboardScope,
  kinds: PendingItemKind[],
  date: string,
): Promise<PendingItemView[]> {
  const items: PendingItemView[] = [];

  for (const kind of kinds) {
    switch (kind) {
      case 'collections': {
        const params: unknown[] = [];
        const where: string[] = [
          `ce.status IN ('waiting','requiresReview')`,
          `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
        ];
        if (scope.agentId !== null) {
          params.push(scope.agentId);
          where.push(`ce.agent_id = $${params.length}`);
        }
        params.push(PENDING_ITEM_LIMIT);
        const result = await query<PendingCollectionRow>(
          `SELECT ce.id, ce.status, ce.amount::float8 AS amount, ce.mode,
                  ce.business_date::text AS "businessDate",
                  c.full_name AS "customerName", a.agent_code AS "agentCode"
             FROM collection_entry ce
             JOIN customer c ON c.id = ce.customer_id
             JOIN agent a ON a.id = ce.agent_id
            WHERE ce.is_deleted = false AND ${where.join(' AND ')}
            ORDER BY ce.submitted_at DESC
            LIMIT $${params.length}`,
          params,
        );
        items.push(...result.rows.map((row) => ({ kind: 'collections' as const, ...row })));
        break;
      }
      case 'withdrawals': {
        const result = await query<PendingWithdrawalRow>(
          `SELECT wr.id, wr.request_number AS "requestNumber", wr.amount::float8 AS amount,
                  c.full_name AS "customerName", wr.requested_on::text AS "requestedOn"
             FROM withdrawal_request wr
             JOIN customer c ON c.id = wr.customer_id
            WHERE wr.status = 'pending'
            ORDER BY wr.created_at DESC
            LIMIT $1`,
          [PENDING_ITEM_LIMIT],
        );
        items.push(...result.rows.map((row) => ({ kind: 'withdrawals' as const, ...row })));
        break;
      }
      case 'overdueLoans': {
        const result = await query<PendingLoanRow>(
          `SELECT l.id, l.loan_number AS "loanNumber", l.outstanding_amount::float8 AS "outstandingAmount",
                  c.full_name AS "customerName", l.next_due_date::text AS "nextDueDate",
                  COALESCE(GREATEST(($1::date - l.next_due_date), 0), 0)::int AS "daysOverdue"
             FROM loan l
             JOIN customer c ON c.id = l.customer_id
            WHERE l.status = 'overdue'
               OR (l.status IN ('active','rescheduled')
                   AND l.next_due_date IS NOT NULL AND l.next_due_date < $1::date)
            ORDER BY l.next_due_date ASC NULLS LAST
            LIMIT $2`,
          [date, PENDING_ITEM_LIMIT],
        );
        items.push(...result.rows.map((row) => ({ kind: 'overdueLoans' as const, ...row })));
        break;
      }
      case 'reconciliationDifferences': {
        const params: unknown[] = [];
        let where = `rd.status = 'unresolved'`;
        if (scope.agentId !== null) {
          params.push(scope.agentId);
          where += ` AND dc.agent_id = $${params.length}`;
        }
        params.push(PENDING_ITEM_LIMIT);
        const result = await query<PendingDifferenceRow>(
          `SELECT rd.id, rd.difference_type AS "differenceType", rd.amount::float8 AS amount,
                  a.agent_code AS "agentCode", rd.created_at::text AS "createdOn"
             FROM reconciliation_difference rd
             JOIN day_close dc ON dc.id = rd.day_close_id
             JOIN agent a ON a.id = dc.agent_id
            WHERE ${where}
            ORDER BY rd.created_at DESC
            LIMIT $${params.length}`,
          params,
        );
        items.push(
          ...result.rows.map((row) => ({ kind: 'reconciliationDifferences' as const, ...row })),
        );
        break;
      }
      case 'complaints': {
        const result = await query<PendingComplaintRow>(
          `SELECT cc.id, c.full_name AS "customerName", cc.category, cc.status,
                  cc.created_at::text AS "createdOn"
             FROM customer_complaint cc
             JOIN customer c ON c.id = cc.customer_id
            WHERE cc.status IN ('open','in_progress')
            ORDER BY cc.created_at DESC
            LIMIT $1`,
          [PENDING_ITEM_LIMIT],
        );
        items.push(...result.rows.map((row) => ({ kind: 'complaints' as const, ...row })));
        break;
      }
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// Dashboard overview (GET /overview)
// ---------------------------------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Most recent ledger rows (reversal entries excluded, decision #15). */
async function getRecentTransactionRows(limit: number): Promise<RecentTransactionView[]> {
  const result = await query<RecentTransactionRow>(
    `SELECT at.id, at.transaction_type AS "transactionType", at.direction, at.amount::float8 AS amount,
            at.value_date::text AS "valueDate", at.payment_method AS "paymentMethod",
            at.reference_number AS "referenceNumber", at.description,
            at.performed_source AS "performedSource", at.created_at::text AS "createdAt",
            sa.account_number AS "accountNumber", c.full_name AS "customerName"
       FROM account_transaction at
       JOIN savings_account sa ON sa.id = at.savings_account_id
       JOIN customer c ON c.id = sa.customer_id
      WHERE at.reversal_of IS NULL
      ORDER BY at.created_at DESC
      LIMIT $1`,
    [limit],
  );
  return result.rows;
}

export async function getDashboardOverview(
  actor: AuthContext,
  input: DashboardOverviewQuery,
  _meta: RequestMeta = {},
): Promise<DashboardOverviewView> {
  const date = input.date ?? istBusinessDate();
  const scope = await resolveScope(actor);
  const kinds = visibleKinds(actor, scope);

  const where: string[] = [
    `ce.is_deleted = false`,
    `ce.business_date = $1::date`,
    `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
  ];
  const params: unknown[] = [date];
  if (scope.agentId !== null) {
    params.push(scope.agentId);
    where.push(`ce.agent_id = $${params.length}`);
  }
  const whereSql = where.join(' AND ');

  const agentParams: unknown[] = [date];
  let agentWhere = `a.status = 'active'`;
  if (scope.agentId !== null) {
    agentParams.push(scope.agentId);
    agentWhere += ` AND a.id = $${agentParams.length}`;
  }

  const [aggResult, modeResult, agentsResult, pendingCounts] = await Promise.all([
    query<OverviewAggRow>(
      `SELECT COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'cash'), 0)::float8 AS "cashAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'UPI'), 0)::float8 AS "digitalAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode IN ('NEFT','RTGS','cheque')), 0)::float8 AS "bankAmount",
              COUNT(*) FILTER (WHERE ce.status = 'accepted')::int AS "acceptedCount",
              COUNT(*) FILTER (WHERE ce.status = 'waiting')::int AS "waitingCount"
         FROM collection_entry ce
        WHERE ${whereSql}`,
      params,
    ),
    query<ModeBreakdownRow>(
      `SELECT ce.mode AS mode, COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS amount
         FROM collection_entry ce
        WHERE ${whereSql}
        GROUP BY ce.mode
        ORDER BY amount DESC`,
      params,
    ),
    query<{ total: number; activeToday: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM collection_entry ce2
                 WHERE ce2.agent_id = a.id AND ce2.is_deleted = false
                   AND ce2.business_date = $1::date
                   AND NOT EXISTS (SELECT 1 FROM collection_reversal crv2
                                    WHERE crv2.original_collection_id = ce2.id)
              ))::int AS "activeToday"
         FROM agent a
        WHERE ${agentWhere}`,
      agentParams,
    ),
    countPendingItems(scope, kinds, date),
  ]);

  const agg = aggResult.rows[0] ?? {
    entryCount: 0,
    totalAmount: 0,
    cashAmount: 0,
    digitalAmount: 0,
    bankAmount: 0,
    acceptedCount: 0,
    waitingCount: 0,
    activeAgentsToday: 0,
  };

  const totalAgents = agentsResult.rows[0]?.total ?? 0;
  const activeToday = agentsResult.rows[0]?.activeToday ?? 0;

  const recentTransactions = actor.permissions.includes('deposits.read')
    ? await getRecentTransactionRows(7)
    : [];

  return {
    date,
    collections: {
      entryCount: agg.entryCount,
      totalAmount: agg.totalAmount,
      cashAmount: agg.cashAmount,
      digitalAmount: agg.digitalAmount,
      bankAmount: agg.bankAmount,
      byMode: modeResult.rows,
      acceptedCount: agg.acceptedCount,
      waitingCount: agg.waitingCount,
    },
    activeAgents: {
      total: totalAgents,
      activeToday,
    },
    averageCollection: {
      perEntry: agg.entryCount > 0 ? round2(agg.totalAmount / agg.entryCount) : 0,
      perActiveAgent: activeToday > 0 ? round2(agg.totalAmount / activeToday) : 0,
    },
    pendingCounts,
    recentTransactions,
  };
}

// ---------------------------------------------------------------------------
// Pending work (GET /pending)
// ---------------------------------------------------------------------------

export async function getDashboardPending(
  actor: AuthContext,
  input: DashboardPendingQuery,
  _meta: RequestMeta = {},
): Promise<DashboardPendingResult> {
  const scope = await resolveScope(actor);
  const visible = visibleKinds(actor, scope);
  const kinds = (input.kinds ?? visible).filter((kind) => visible.includes(kind));
  const date = istBusinessDate();
  const [counts, items] = await Promise.all([
    countPendingItems(scope, kinds, date),
    fetchPendingItems(scope, kinds, date),
  ]);
  return { date, kinds, counts, items, perKindLimit: PENDING_ITEM_LIMIT };
}

// ---------------------------------------------------------------------------
// Agent performance (GET /performance/agents, decision #12)
// ---------------------------------------------------------------------------

export async function getAgentPerformanceDashboard(
  actor: AuthContext,
  input: AgentPerformanceDashboardQuery,
  _meta: RequestMeta = {},
): Promise<AgentPerformanceDashboardResult> {
  const scope = await resolveScope(actor);
  const from = input.from ?? istBusinessDate();
  const to = input.to ?? from;

  const params: unknown[] = [from, to];
  const where: string[] = [
    `ce.is_deleted = false`,
    `ce.business_date >= $1 AND ce.business_date <= $2`,
    `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
  ];
  if (scope.agentId !== null) {
    params.push(scope.agentId);
    where.push(`ce.agent_id = $${params.length}`);
  } else if (input.agentId !== undefined) {
    params.push(input.agentId);
    where.push(`ce.agent_id = $${params.length}`);
  }
  const filterParams = params.slice();
  const whereSql = where.join(' AND ');
  params.push(input.pageSize, (input.page - 1) * input.pageSize);

  const [list, summary] = await Promise.all([
    query<PerformanceRow>(
      `SELECT a.id AS "agentId", a.agent_code AS "agentCode", s.full_name AS "agentName",
              COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'cash'), 0)::float8 AS "cashAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode <> 'cash'), 0)::float8 AS "digitalAmount",
              COUNT(DISTINCT ce.customer_id)::int AS "customerCount",
              COUNT(*) FILTER (WHERE ce.status = 'accepted')::int AS "acceptedCount",
              COUNT(*) FILTER (WHERE ce.status = 'waiting')::int AS "waitingCount",
              COUNT(*) OVER()::int AS total
         FROM collection_entry ce
         JOIN agent a ON a.id = ce.agent_id
         JOIN staff s ON s.id = a.staff_id
        WHERE ${whereSql}
        GROUP BY a.id, a.agent_code, s.full_name
        ORDER BY "totalAmount" DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    ),
    query<PerformanceSummaryRow>(
      `SELECT COUNT(DISTINCT ce.agent_id)::int AS "agentCount",
              COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount"
         FROM collection_entry ce
        WHERE ${whereSql}`,
      filterParams,
    ),
  ]);

  const total = list.rows[0]?.total ?? 0;
  const summaryRow = summary.rows[0] ?? { agentCount: 0, entryCount: 0, totalAmount: 0 };

  return {
    items: list.rows.map(({ total: _omitted, ...entry }) => entry),
    total,
    summary: {
      from,
      to,
      agentCount: summaryRow.agentCount,
      entryCount: summaryRow.entryCount,
      totalAmount: summaryRow.totalAmount,
    },
  };
}

// ---------------------------------------------------------------------------
// Recent transactions (GET /transactions/recent)
// ---------------------------------------------------------------------------

export async function getRecentTransactions(
  actor: AuthContext,
  input: RecentTransactionsQuery,
  _meta: RequestMeta = {},
): Promise<RecentTransactionsResult> {
  const { page, pageSize } = input;
  if (!actor.permissions.includes('deposits.read')) {
    return { items: [], total: 0, page, pageSize };
  }
  const offset = (page - 1) * pageSize;

  const [itemsResult, totalResult] = await Promise.all([
    query<RecentTransactionRow>(
      `SELECT at.id, at.transaction_type AS "transactionType", at.direction, at.amount::float8 AS amount,
              at.value_date::text AS "valueDate", at.payment_method AS "paymentMethod",
              at.reference_number AS "referenceNumber", at.description,
              at.performed_source AS "performedSource", at.created_at::text AS "createdAt",
              sa.account_number AS "accountNumber", c.full_name AS "customerName"
         FROM account_transaction at
         JOIN savings_account sa ON sa.id = at.savings_account_id
         JOIN customer c ON c.id = sa.customer_id
        WHERE at.reversal_of IS NULL
        ORDER BY at.created_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    query<CountRow>(
      `SELECT COUNT(*)::int AS total
         FROM account_transaction at
        WHERE at.reversal_of IS NULL`,
    ),
  ]);

  return {
    items: itemsResult.rows,
    total: totalResult.rows[0]?.total ?? 0,
    page,
    pageSize,
  };
}