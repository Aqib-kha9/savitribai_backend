import { query } from '../../database/client.js';
import { istBusinessDate } from '../../core/time.js';
import { NotFoundError } from '../../core/errors.js';
async function resolveScope(actor) {
    if (actor.role !== 'collection_agent')
        return { agentId: null };
    const result = await query('SELECT id FROM agent WHERE staff_id = $1', [actor.staffId]);
    const row = result.rows[0];
    if (!row)
        throw new NotFoundError('Agent profile not found for the current staff member');
    return { agentId: row.id };
}
/** Complaints are an office surface — agents and cashiers never see them. */
const COMPLAINT_VISIBLE_ROLES = new Set([
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
function visibleKinds(actor, scope) {
    if (scope.agentId !== null) {
        const kinds = [];
        if (actor.permissions.includes('collections.read'))
            kinds.push('collections');
        if (actor.permissions.includes('reconciliation.read'))
            kinds.push('reconciliationDifferences');
        return kinds;
    }
    const kinds = [];
    if (actor.permissions.includes('collections.read'))
        kinds.push('collections');
    if (actor.permissions.includes('withdrawals.read'))
        kinds.push('withdrawals');
    if (actor.permissions.includes('loans.read'))
        kinds.push('overdueLoans');
    if (actor.permissions.includes('reconciliation.read'))
        kinds.push('reconciliationDifferences');
    if (COMPLAINT_VISIBLE_ROLES.has(actor.role))
        kinds.push('complaints');
    return kinds;
}
// ---------------------------------------------------------------------------
// Pending work: counts + items (decision #4)
// ---------------------------------------------------------------------------
const PENDING_ITEM_LIMIT = 10;
async function countPendingItems(scope, kinds, date) {
    const counts = {};
    const jobs = [];
    for (const kind of kinds) {
        switch (kind) {
            case 'collections': {
                const params = [];
                const where = [
                    `ce.status IN ('waiting','requiresReview')`,
                    `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
                ];
                if (scope.agentId !== null) {
                    params.push(scope.agentId);
                    where.push(`ce.agent_id = $${params.length}`);
                }
                jobs.push(query(`SELECT COUNT(*)::int AS total
               FROM collection_entry ce
              WHERE ce.is_deleted = false AND ${where.join(' AND ')}`, params).then((result) => {
                    counts.collections = result.rows[0]?.total ?? 0;
                }));
                break;
            }
            case 'withdrawals': {
                jobs.push(query(`SELECT COUNT(*)::int AS total FROM withdrawal_request WHERE status = 'pending'`).then((result) => {
                    counts.withdrawals = result.rows[0]?.total ?? 0;
                }));
                break;
            }
            case 'overdueLoans': {
                jobs.push(query(`SELECT COUNT(*)::int AS total
               FROM loan
              WHERE status = 'overdue'
                 OR (status IN ('active','rescheduled')
                     AND next_due_date IS NOT NULL AND next_due_date < $1::date)`, [date]).then((result) => {
                    counts.overdueLoans = result.rows[0]?.total ?? 0;
                }));
                break;
            }
            case 'reconciliationDifferences': {
                const params = [];
                let where = `rd.status = 'unresolved'`;
                if (scope.agentId !== null) {
                    params.push(scope.agentId);
                    where += ` AND dc.agent_id = $${params.length}`;
                }
                jobs.push(query(`SELECT COUNT(*)::int AS total
               FROM reconciliation_difference rd
               JOIN day_close dc ON dc.id = rd.day_close_id
              WHERE ${where}`, params).then((result) => {
                    counts.reconciliationDifferences = result.rows[0]?.total ?? 0;
                }));
                break;
            }
            case 'complaints': {
                jobs.push(query(`SELECT COUNT(*)::int AS total
               FROM customer_complaint
              WHERE status IN ('open','in_progress')`).then((result) => {
                    counts.complaints = result.rows[0]?.total ?? 0;
                }));
                break;
            }
        }
    }
    await Promise.all(jobs);
    return counts;
}
async function fetchPendingItems(scope, kinds, date) {
    const items = [];
    for (const kind of kinds) {
        switch (kind) {
            case 'collections': {
                const params = [];
                const where = [
                    `ce.status IN ('waiting','requiresReview')`,
                    `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
                ];
                if (scope.agentId !== null) {
                    params.push(scope.agentId);
                    where.push(`ce.agent_id = $${params.length}`);
                }
                params.push(PENDING_ITEM_LIMIT);
                const result = await query(`SELECT ce.id, ce.status, ce.amount::float8 AS amount, ce.mode,
                  ce.business_date::text AS "businessDate",
                  c.full_name AS "customerName", a.agent_code AS "agentCode"
             FROM collection_entry ce
             JOIN customer c ON c.id = ce.customer_id
             JOIN agent a ON a.id = ce.agent_id
            WHERE ce.is_deleted = false AND ${where.join(' AND ')}
            ORDER BY ce.submitted_at DESC
            LIMIT $${params.length}`, params);
                items.push(...result.rows.map((row) => ({ kind: 'collections', ...row })));
                break;
            }
            case 'withdrawals': {
                const result = await query(`SELECT wr.id, wr.request_number AS "requestNumber", wr.amount::float8 AS amount,
                  c.full_name AS "customerName", wr.requested_on::text AS "requestedOn"
             FROM withdrawal_request wr
             JOIN customer c ON c.id = wr.customer_id
            WHERE wr.status = 'pending'
            ORDER BY wr.created_at DESC
            LIMIT $1`, [PENDING_ITEM_LIMIT]);
                items.push(...result.rows.map((row) => ({ kind: 'withdrawals', ...row })));
                break;
            }
            case 'overdueLoans': {
                const result = await query(`SELECT l.id, l.loan_number AS "loanNumber", l.outstanding_amount::float8 AS "outstandingAmount",
                  c.full_name AS "customerName", l.next_due_date::text AS "nextDueDate",
                  COALESCE(GREATEST(($1::date - l.next_due_date), 0), 0)::int AS "daysOverdue"
             FROM loan l
             JOIN customer c ON c.id = l.customer_id
            WHERE l.status = 'overdue'
               OR (l.status IN ('active','rescheduled')
                   AND l.next_due_date IS NOT NULL AND l.next_due_date < $1::date)
            ORDER BY l.next_due_date ASC NULLS LAST
            LIMIT $2`, [date, PENDING_ITEM_LIMIT]);
                items.push(...result.rows.map((row) => ({ kind: 'overdueLoans', ...row })));
                break;
            }
            case 'reconciliationDifferences': {
                const params = [];
                let where = `rd.status = 'unresolved'`;
                if (scope.agentId !== null) {
                    params.push(scope.agentId);
                    where += ` AND dc.agent_id = $${params.length}`;
                }
                params.push(PENDING_ITEM_LIMIT);
                const result = await query(`SELECT rd.id, rd.difference_type AS "differenceType", rd.amount::float8 AS amount,
                  a.agent_code AS "agentCode", rd.created_at::text AS "createdOn"
             FROM reconciliation_difference rd
             JOIN day_close dc ON dc.id = rd.day_close_id
             JOIN agent a ON a.id = dc.agent_id
            WHERE ${where}
            ORDER BY rd.created_at DESC
            LIMIT $${params.length}`, params);
                items.push(...result.rows.map((row) => ({ kind: 'reconciliationDifferences', ...row })));
                break;
            }
            case 'complaints': {
                const result = await query(`SELECT cc.id, c.full_name AS "customerName", cc.category, cc.status,
                  cc.created_at::text AS "createdOn"
             FROM customer_complaint cc
             JOIN customer c ON c.id = cc.customer_id
            WHERE cc.status IN ('open','in_progress')
            ORDER BY cc.created_at DESC
            LIMIT $1`, [PENDING_ITEM_LIMIT]);
                items.push(...result.rows.map((row) => ({ kind: 'complaints', ...row })));
                break;
            }
        }
    }
    return items;
}
// ---------------------------------------------------------------------------
// Dashboard overview (GET /overview)
// ---------------------------------------------------------------------------
function round2(value) {
    return Math.round(value * 100) / 100;
}
/** Most recent ledger rows (reversal entries excluded, decision #15). */
async function getRecentTransactionRows(limit) {
    const result = await query(`SELECT at.id, at.transaction_type AS "transactionType", at.direction, at.amount::float8 AS amount,
            at.value_date::text AS "valueDate", at.payment_method AS "paymentMethod",
            at.reference_number AS "referenceNumber", at.description,
            at.performed_source AS "performedSource", at.created_at::text AS "createdAt",
            sa.account_number AS "accountNumber", c.full_name AS "customerName"
       FROM account_transaction at
       JOIN savings_account sa ON sa.id = at.savings_account_id
       JOIN customer c ON c.id = sa.customer_id
      WHERE at.reversal_of IS NULL
      ORDER BY at.created_at DESC
      LIMIT $1`, [limit]);
    return result.rows;
}
export async function getDashboardOverview(actor, input, _meta = {}) {
    const date = input.date ?? istBusinessDate();
    const scope = await resolveScope(actor);
    const kinds = visibleKinds(actor, scope);
    const where = [
        `ce.is_deleted = false`,
        `ce.business_date = $1::date`,
        `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
    ];
    const params = [date];
    if (scope.agentId !== null) {
        params.push(scope.agentId);
        where.push(`ce.agent_id = $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const agentParams = [date];
    let agentWhere = `a.status = 'active'`;
    if (scope.agentId !== null) {
        agentParams.push(scope.agentId);
        agentWhere += ` AND a.id = $${agentParams.length}`;
    }
    const [aggResult, modeResult, agentsResult, pendingCounts] = await Promise.all([
        query(`SELECT COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'cash'), 0)::float8 AS "cashAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'UPI'), 0)::float8 AS "digitalAmount",
              COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode IN ('NEFT','RTGS','cheque')), 0)::float8 AS "bankAmount",
              COUNT(*) FILTER (WHERE ce.status = 'accepted')::int AS "acceptedCount",
              COUNT(*) FILTER (WHERE ce.status = 'waiting')::int AS "waitingCount"
         FROM collection_entry ce
        WHERE ${whereSql}`, params),
        query(`SELECT ce.mode AS mode, COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS amount
         FROM collection_entry ce
        WHERE ${whereSql}
        GROUP BY ce.mode
        ORDER BY amount DESC`, params),
        query(`SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM collection_entry ce2
                 WHERE ce2.agent_id = a.id AND ce2.is_deleted = false
                   AND ce2.business_date = $1::date
                   AND NOT EXISTS (SELECT 1 FROM collection_reversal crv2
                                    WHERE crv2.original_collection_id = ce2.id)
              ))::int AS "activeToday"
         FROM agent a
        WHERE ${agentWhere}`, agentParams),
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
export async function getDashboardPending(actor, input, _meta = {}) {
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
export async function getAgentPerformanceDashboard(actor, input, _meta = {}) {
    const scope = await resolveScope(actor);
    const from = input.from ?? istBusinessDate();
    const to = input.to ?? from;
    const params = [from, to];
    const where = [
        `ce.is_deleted = false`,
        `ce.business_date >= $1 AND ce.business_date <= $2`,
        `NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`,
    ];
    if (scope.agentId !== null) {
        params.push(scope.agentId);
        where.push(`ce.agent_id = $${params.length}`);
    }
    else if (input.agentId !== undefined) {
        params.push(input.agentId);
        where.push(`ce.agent_id = $${params.length}`);
    }
    const filterParams = params.slice();
    const whereSql = where.join(' AND ');
    params.push(input.pageSize, (input.page - 1) * input.pageSize);
    const [list, summary] = await Promise.all([
        query(`SELECT a.id AS "agentId", a.agent_code AS "agentCode", s.full_name AS "agentName",
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
        LIMIT $${params.length - 1} OFFSET $${params.length}`, params),
        query(`SELECT COUNT(DISTINCT ce.agent_id)::int AS "agentCount",
              COUNT(*)::int AS "entryCount",
              COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount"
         FROM collection_entry ce
        WHERE ${whereSql}`, filterParams),
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
export async function getRecentTransactions(actor, input, _meta = {}) {
    const { page, pageSize } = input;
    if (!actor.permissions.includes('deposits.read')) {
        return { items: [], total: 0, page, pageSize };
    }
    const offset = (page - 1) * pageSize;
    const [itemsResult, totalResult] = await Promise.all([
        query(`SELECT at.id, at.transaction_type AS "transactionType", at.direction, at.amount::float8 AS amount,
              at.value_date::text AS "valueDate", at.payment_method AS "paymentMethod",
              at.reference_number AS "referenceNumber", at.description,
              at.performed_source AS "performedSource", at.created_at::text AS "createdAt",
              sa.account_number AS "accountNumber", c.full_name AS "customerName"
         FROM account_transaction at
         JOIN savings_account sa ON sa.id = at.savings_account_id
         JOIN customer c ON c.id = sa.customer_id
        WHERE at.reversal_of IS NULL
        ORDER BY at.created_at DESC
        LIMIT $1 OFFSET $2`, [pageSize, offset]),
        query(`SELECT COUNT(*)::int AS total
         FROM account_transaction at
        WHERE at.reversal_of IS NULL`),
    ]);
    return {
        items: itemsResult.rows,
        total: totalResult.rows[0]?.total ?? 0,
        page,
        pageSize,
    };
}
