import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS } from '../../audit/audit-writer.js';
import { addDays, addMonths, istBusinessDate, isSunday } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors.js';
import { allocateSequence } from '../../database/numbering.js';
import { addMoney, compareMoney, fromCents, isZero, percentOf, subMoney, toCents, BUSINESS_RULES, } from '../../core/money.js';
/**
 * Recurring deposits service (docs/backend-master-spec.md §10).
 *
 * Authority (spec §10.1):
 *  - RD scheme creation → Managing Director; scheme listing → deposits.read
 *  - RD account opening → Managing Director; account/schedule reads →
 *    deposits.read; instalment collection → deposits.write
 *  - penalty waiver & schedule change (reschedule) → President
 *  - early closure (4% fee) → Managing Director
 *  - surplus transfer (excess → linked loan account) → Managing Director
 *  - approvals (fund transfer / approved-fund waiting) → designated person
 *    (President / Managing Director) — stamped on the rd_account approved_by /
 *    approved_on pair as the schema exposes no separate approval entity.
 *
 * Money & time rules (spec §10.5):
 *  - Instalment schedule is generated from first_due_date + frequency over the
 *    term, shifting Sunday due dates to the next working day. Bank-declared
 *    holidays come from the DB calendar and are applied by the same shift when
 *    the calendar is wired to this module (core/time.ts comment).
 *  - Grace tracking: an instalment unpaid 1 month after due becomes
 *    missed/overdue and a penalty is applied (rate from the scheme's
 *    penalty_config JSON — default 5% per missed instalment until the bank's
 *    rate sheet is supplied, spec §10.1 note).
 *  - Part payment: the remainder of a partially paid instalment stays due.
 *  - Several instalments in one payment are allocated oldest-due-first.
 *  - Over-payment beyond every outstanding instalment must be routed to the
 *    linked loan account through /surplus-transfer (spec §10.1 Follow-up rule);
 *    it is never silently swallowed by the instalment endpoint.
 *  - Early closure applies the 4% closure fee on the principal collected so
 *    far (BUSINESS_RULES.RD_EARLY_CLOSURE_FEE_PERCENT) and waives every
 *    uncollected instalment so the schedule ledger closes cleanly.
 *  - Interest is credited yearly or half-yearly (scheme config) by the day
 *    close module using rd_interest_posting (append-only).
 *
 * Every mutation runs inside one DB transaction and appends its audit event in
 * the same transaction (spec §6.3). rd_schedule_change, rd_waiver and
 * rd_interest_posting are append-only — the master schema gives them no
 * updated_at column.
 */
// Module-local action vocabulary. The shared audit-writer keeps the constants
// for opened / instalment paid / penalty waived / rescheduled / closed_early;
// the remaining RD actions have no shared constant and are plain strings here
// (mirroring the deposits module's approach for approval / read paths).
const ACTION_SCHEME_CREATED = 'rd.scheme.created';
const ACTION_ACCOUNT_VIEWED = 'rd.account.viewed';
const ACTION_SCHEDULE_VIEWED = 'rd.schedule.viewed';
const ACTION_PENALTY_APPLIED = 'rd.penalty.applied';
const ACTION_ACCOUNT_APPROVED = 'rd.account.approved';
const ACTION_SURPLUS_TRANSFERRED = 'rd.surplus.transferred';
/** Per-scheme penalty rate until the bank's rate sheet is supplied (spec §10.1). */
const DEFAULT_RD_PENALTY_PERCENT = '5.00';
/** '0.00' means uncapped. Scheme penalty_config may carry { penaltyPercent, penaltyCap }. */
const DEFAULT_RD_PENALTY_CAP = '0.00';
/** Hard safety bound on generated instalments (max term 120 months × daily). */
const MAX_SCHEDULE_INSTALMENTS = 10_000;
/** RD accounts that can still be acted upon (payment / waiver / reschedule / closure). */
const OPEN_STATUSES = ['active', 'overdue'];
/** Terminal loan statuses — a surplus can only be held while the loan is live. */
const CLOSED_LOAN_STATUSES = ['settled', 'written_off', 'closed'];
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function audit(client, input) {
    const event = {
        actorStaffId: input.actorStaffId ?? null,
        actorRole: input.actorRole ?? null,
        actorStaffCode: input.actorStaffCode ?? null,
        action: input.action,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        source: input.source,
        requestId: input.requestId ?? null,
        businessDate: input.businessDate ?? istBusinessDate(),
    };
    if (input.metadata !== undefined)
        event.metadata = input.metadata;
    return appendAuditEvent(client, event);
}
function actorAuditBase(actor) {
    return {
        actorStaffId: actor.staffId,
        actorRole: actor.role,
        actorStaffCode: actor.staffCode,
        source: actor.source,
        requestId: null,
    };
}
const iso = (value) => value ? value.toISOString() : null;
/** Autocommit adapter for audit events written outside a mutation transaction (reads). */
function poolForEvent() {
    return { query: (text, params) => query(text, params) };
}
function isUniqueViolation(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
async function assertBranchExists(client, branchId) {
    const result = await client.query(`SELECT 1 FROM branch WHERE id = $1`, [branchId]);
    if (result.rows.length === 0) {
        throw new BadRequestError('Branch does not exist');
    }
}
async function selectCustomerEligibility(client, customerId) {
    const result = await client.query(`SELECT id, status FROM customer WHERE id = $1 LIMIT 1`, [customerId]);
    return result.rows[0] ?? null;
}
/** An RD account can only be opened for a customer whose record is not terminal. */
async function assertCustomerEligible(client, customerId) {
    const customer = await selectCustomerEligibility(client, customerId);
    if (!customer)
        throw new NotFoundError('Customer');
    // 'restricted' (data-subject restriction) and 'deleted' (data-subject soft
    // delete, spec §24.2) also freeze new product openings.
    if (customer.status === 'deceased' ||
        customer.status === 'closed' ||
        customer.status === 'restricted' ||
        customer.status === 'deleted') {
        throw new BusinessRuleError(`Customer is ${customer.status}; no new RD account can be opened for this profile`, 'CUSTOMER_NOT_ELIGIBLE');
    }
}
function penaltySettings(scheme) {
    const config = (scheme.penalty_config ?? null);
    const percentRaw = config?.penaltyPercent;
    const capRaw = config?.penaltyCap;
    const percent = typeof percentRaw === 'string' && percentRaw.length > 0 ? percentRaw : DEFAULT_RD_PENALTY_PERCENT;
    const cap = typeof capRaw === 'string' && capRaw.length > 0 ? capRaw : DEFAULT_RD_PENALTY_CAP;
    return { percent, cap };
}
/** Shift a Sunday due date forward to the next working day (Monday). */
function toWorkingDay(date) {
    let shifted = date;
    while (isSunday(shifted)) {
        shifted = addDays(shifted, 1);
    }
    return shifted;
}
function nextDueDate(date, frequency) {
    switch (frequency) {
        case 'daily':
            return addDays(date, 1);
        case 'weekly':
            return addDays(date, 7);
        case 'monthly':
            return addMonths(date, 1);
        case 'quarterly':
            return addMonths(date, 3);
    }
}
/**
 * Generate due dates from `start` (inclusive) at `frequency` until the cursor
 * passes `end`. Sunday due dates are shifted to the next working day without
 * disturbing the underlying date grid, so the term length is preserved.
 */
function generateInstalmentDates(start, end, frequency) {
    const dates = [];
    let cursor = start;
    while (cursor <= end && dates.length < MAX_SCHEDULE_INSTALMENTS) {
        dates.push(toWorkingDay(cursor));
        cursor = nextDueDate(cursor, frequency);
    }
    return dates;
}
/** `start + count` due dates at the given frequency (used by reschedule). */
function regenerateInstalmentDates(start, count, frequency) {
    const dates = [];
    let cursor = start;
    while (dates.length < count && dates.length < MAX_SCHEDULE_INSTALMENTS) {
        dates.push(toWorkingDay(cursor));
        cursor = nextDueDate(cursor, frequency);
    }
    return dates;
}
// ---------------------------------------------------------------------------
// Scheme helpers
// ---------------------------------------------------------------------------
const SCHEME_SELECT = `
  SELECT id, code, name, description, frequency,
         min_instalment_amount::text AS min_instalment_amount,
         max_instalment_amount::text AS max_instalment_amount,
         min_duration_months, max_duration_months, grace_period_months,
         interest_rate::text AS interest_rate, interest_credit_frequency,
         early_closure_fee_percent::text AS early_closure_fee_percent,
         penalty_config, is_active, created_at, updated_at
    FROM rd_scheme
`;
async function selectSchemeById(client, schemeId) {
    const result = await client.query(`${SCHEME_SELECT} WHERE id = $1 LIMIT 1`, [schemeId]);
    return result.rows[0] ?? null;
}
async function selectSchemeByCode(client, code) {
    const result = await client.query(`${SCHEME_SELECT} WHERE code = $1 LIMIT 1`, [code]);
    return result.rows[0] ?? null;
}
function toSchemeView(row) {
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        frequency: row.frequency,
        minInstalmentAmount: row.min_instalment_amount,
        maxInstalmentAmount: row.max_instalment_amount,
        minDurationMonths: row.min_duration_months,
        maxDurationMonths: row.max_duration_months,
        gracePeriodMonths: row.grace_period_months,
        interestRate: row.interest_rate,
        interestCreditFrequency: row.interest_credit_frequency,
        earlyClosureFeePercent: row.early_closure_fee_percent,
        penaltyConfig: row.penalty_config ?? {},
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function loadScheme(client, schemeId) {
    const scheme = await selectSchemeById(client, schemeId);
    if (!scheme)
        throw new NotFoundError('RD scheme');
    return toSchemeView(scheme);
}
// ---------------------------------------------------------------------------
// RD account helpers
// ---------------------------------------------------------------------------
const RD_ACCOUNT_SELECT = `
  SELECT ra.id, ra.account_number, ra.customer_id,
         c.customer_number, c.full_name AS customer_name,
         ra.scheme_id, s.code AS scheme_code, s.name AS scheme_name,
         ra.branch_id, b.name AS branch_name,
         ra.instalment_amount::text AS instalment_amount,
         ra.frequency,
         ra.start_date::text AS start_date,
         ra.first_due_date::text AS first_due_date,
         ra.maturity_date::text AS maturity_date,
         ra.status,
         ra.total_expected::text AS total_expected,
         ra.total_paid::text AS total_paid,
         ra.pending_amount::text AS pending_amount,
         ra.grace_period_months,
         ra.opened_by, op.full_name AS opened_by_name,
         ra.approved_by, ap.full_name AS approved_by_name,
         ra.closed_on::text AS closed_on,
         ra.closure_fee::text AS closure_fee,
         ra.linked_loan_id, l.loan_number AS linked_loan_number,
         ra.created_at, ra.updated_at
    FROM rd_account ra
    JOIN customer c ON c.id = ra.customer_id
    JOIN rd_scheme s ON s.id = ra.scheme_id
    JOIN branch b ON b.id = ra.branch_id
    LEFT JOIN staff op ON op.id = ra.opened_by
    LEFT JOIN staff ap ON ap.id = ra.approved_by
    LEFT JOIN loan l ON l.id = ra.linked_loan_id
`;
async function selectRdAccountById(client, accountId) {
    const result = await client.query(`${RD_ACCOUNT_SELECT} WHERE ra.id = $1 LIMIT 1`, [accountId]);
    return result.rows[0] ?? null;
}
function toRdAccountView(row) {
    return {
        id: row.id,
        accountNumber: row.account_number,
        customerId: row.customer_id,
        customerNumber: row.customer_number,
        customerName: row.customer_name,
        schemeId: row.scheme_id,
        schemeCode: row.scheme_code,
        schemeName: row.scheme_name,
        branchId: row.branch_id,
        branchName: row.branch_name,
        instalmentAmount: row.instalment_amount,
        frequency: row.frequency,
        startDate: row.start_date,
        firstDueDate: row.first_due_date,
        maturityDate: row.maturity_date,
        status: row.status,
        totalExpected: row.total_expected,
        totalPaid: row.total_paid,
        pendingAmount: row.pending_amount,
        gracePeriodMonths: row.grace_period_months,
        openedBy: row.opened_by,
        openedByName: row.opened_by_name,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        closedOn: row.closed_on,
        closureFee: row.closure_fee,
        linkedLoanId: row.linked_loan_id,
        linkedLoanNumber: row.linked_loan_number,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function loadRdAccountDetail(client, accountId) {
    const account = await selectRdAccountById(client, accountId);
    if (!account)
        throw new NotFoundError('RD account');
    return toRdAccountView(account);
}
// ---------------------------------------------------------------------------
// Instalment / penalty helpers
// ---------------------------------------------------------------------------
const INSTALMENT_SELECT = `
  SELECT id, instalment_number, due_date::text AS due_date,
         expected_amount::text AS expected_amount,
         paid_amount::text AS paid_amount,
         status,
         paid_on::text AS paid_on,
         payment_method, reference_number, collection_entry_id,
         allocation, created_at, updated_at
    FROM rd_instalment
`;
function toInstalmentView(row) {
    return {
        id: row.id,
        instalmentNumber: row.instalment_number,
        dueDate: row.due_date,
        expectedAmount: row.expected_amount,
        paidAmount: row.paid_amount,
        status: row.status,
        paidOn: row.paid_on,
        paymentMethod: row.payment_method,
        referenceNumber: row.reference_number,
        collectionEntryId: row.collection_entry_id,
        allocation: Array.isArray(row.allocation) ? row.allocation : null,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function selectInstalmentsByIds(client, accountId, ids) {
    if (ids.length === 0)
        return [];
    const result = await client.query(`${INSTALMENT_SELECT} WHERE rd_account_id = $1 AND id = ANY($2::uuid[]) ORDER BY instalment_number ASC`, [accountId, ids]);
    return result.rows;
}
const PENALTY_SELECT = `
  SELECT rp.id, rp.rd_account_id, rp.instalment_id,
         ri.instalment_number, ri.due_date::text AS due_date,
         rp.penalty_amount::text AS penalty_amount,
         rp.reason, rp.status,
         rp.waived_by, w.full_name AS waived_by_name,
         rp.waived_on, rp.created_at
    FROM rd_penalty rp
    LEFT JOIN rd_instalment ri ON ri.id = rp.instalment_id
    LEFT JOIN staff w ON w.id = rp.waived_by
`;
function toPenaltyView(row) {
    return {
        id: row.id,
        rdAccountId: row.rd_account_id,
        instalmentId: row.instalment_id,
        instalmentNumber: row.instalment_number,
        dueDate: row.due_date,
        penaltyAmount: row.penalty_amount,
        reason: row.reason,
        status: row.status,
        waivedBy: row.waived_by,
        waivedByName: row.waived_by_name,
        waivedOn: iso(row.waived_on),
        createdAt: row.created_at.toISOString(),
    };
}
async function selectPenaltiesForAccount(client, accountId, limit = 500) {
    const result = await client.query(`${PENALTY_SELECT} WHERE rp.rd_account_id = $1 ORDER BY rp.created_at DESC LIMIT $2`, [accountId, limit]);
    return result.rows;
}
const WAIVER_SELECT = `
  SELECT rw.id, rw.rd_account_id, rw.penalty_id,
         rw.amount::text AS amount,
         rw.reason, rw.approved_by, a.full_name AS approved_by_name,
         rw.created_at
    FROM rd_waiver rw
    LEFT JOIN staff a ON a.id = rw.approved_by
`;
async function selectWaiverById(client, waiverId) {
    const result = await client.query(`${WAIVER_SELECT} WHERE rw.id = $1 LIMIT 1`, [waiverId]);
    return result.rows[0] ?? null;
}
function toWaiverView(row) {
    return {
        id: row.id,
        rdAccountId: row.rd_account_id,
        penaltyId: row.penalty_id,
        amount: row.amount,
        reason: row.reason,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        createdAt: row.created_at.toISOString(),
    };
}
const SCHEDULE_CHANGE_SELECT = `
  SELECT rsc.id, rsc.rd_account_id, rsc.change_type,
         rsc.old_value, rsc.new_value, rsc.reason,
         rsc.approved_by, a.full_name AS approved_by_name,
         rsc.effective_from::text AS effective_from,
         rsc.created_at
    FROM rd_schedule_change rsc
    LEFT JOIN staff a ON a.id = rsc.approved_by
`;
async function selectScheduleChangeById(client, changeId) {
    const result = await client.query(`${SCHEDULE_CHANGE_SELECT} WHERE rsc.id = $1 LIMIT 1`, [changeId]);
    return result.rows[0] ?? null;
}
function toScheduleChangeView(row) {
    return {
        id: row.id,
        rdAccountId: row.rd_account_id,
        changeType: row.change_type,
        oldValue: row.old_value ?? {},
        newValue: row.new_value ?? {},
        reason: row.reason,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        effectiveFrom: row.effective_from,
        createdAt: row.created_at.toISOString(),
    };
}
/**
 * Recompose the account totals from its instalment ledger and choose the
 * account status:
 *  - 'overdue'  — any missed/overdue instalment still has an outstanding amount
 *  - 'completed' — nothing is outstanding (every instalment fully paid/waived)
 *  - 'matured'  — term end reached with an outstanding balance
 *  - 'active'   — in term, nothing overdue
 */
async function recomputeAccountTotals(client, accountId) {
    const result = await client.query(`SELECT COALESCE(SUM(expected_amount), 0)::numeric::text AS expected,
            COALESCE(SUM(paid_amount), 0)::numeric::text AS paid,
            COALESCE(SUM(expected_amount - paid_amount)
              FILTER (WHERE status IN ('due','partial','missed','overdue')), 0)::numeric::text AS pending,
            COUNT(*) FILTER (WHERE status IN ('missed','overdue') AND expected_amount > paid_amount)::int
              AS overdue_outstanding,
            COUNT(*) FILTER (WHERE status IN ('due','partial','missed','overdue'))::int AS pending_count
       FROM rd_instalment
      WHERE rd_account_id = $1`, [accountId]);
    const totals = result.rows[0] ?? {
        expected: '0.00',
        paid: '0.00',
        pending: '0.00',
        overdue_outstanding: 0,
        pending_count: 0,
    };
    const account = await selectRdAccountById(client, accountId);
    const today = istBusinessDate();
    const isOverdue = (totals.overdue_outstanding ?? 0) > 0;
    const pending = totals.pending ?? '0.00';
    const expected = totals.expected ?? '0.00';
    const paid = totals.paid ?? '0.00';
    let status;
    if (isOverdue) {
        status = 'overdue';
    }
    else if (isZero(pending)) {
        status = 'completed';
    }
    else if (account && account.maturity_date && account.maturity_date <= today) {
        status = 'matured';
    }
    else {
        status = 'active';
    }
    await client.query(`UPDATE rd_account
        SET total_expected = $1::numeric,
            total_paid = $2::numeric,
            pending_amount = $3::numeric,
            status = $4,
            updated_at = now()
      WHERE id = $5`, [expected, paid, pending, status, accountId]);
    return { ...totals, expected, paid, pending };
}
/**
 * Grace sweep (spec §10.5): an instalment unpaid grace_period_months after its
 * due date becomes missed (no money collected) or overdue (partial amount
 * collected) and a penalty is applied once per instalment. Called at the start
 * of every financial mutation so state is never allowed to drift.
 */
async function sweepMissedInstalments(client, account, actor, meta) {
    const scheme = await selectSchemeById(client, account.scheme_id);
    if (!scheme)
        throw new NotFoundError('RD scheme');
    const { percent, cap } = penaltySettings(scheme);
    const today = istBusinessDate();
    // due_date + grace months <= today  ⇔  due_date <= today − grace months
    const cutoff = addMonths(today, -account.grace_period_months);
    const due = await client.query(`SELECT id, instalment_number, due_date::text AS due_date,
            expected_amount::text AS expected_amount,
            paid_amount::text AS paid_amount,
            status, allocation
       FROM rd_instalment
      WHERE rd_account_id = $1 AND status IN ('due','partial') AND due_date <= $2::date
      ORDER BY due_date ASC, instalment_number ASC
      FOR UPDATE`, [account.id, cutoff]);
    let applied = 0;
    for (const row of due.rows) {
        const penaltyCheck = await client.query(`SELECT EXISTS (
         SELECT 1 FROM rd_penalty WHERE instalment_id = $1
       ) AS existing`, [row.id]);
        const exists = penaltyCheck.rows[0]?.existing ?? false;
        if (exists)
            continue;
        const newStatus = isZero(row.paid_amount) ? 'missed' : 'overdue';
        await client.query(`UPDATE rd_instalment SET status = $1, updated_at = now() WHERE id = $2`, [newStatus, row.id]);
        let penaltyAmount = percentOf(row.expected_amount, percent);
        if (!isZero(cap) && compareMoney(penaltyAmount, cap) > 0) {
            penaltyAmount = cap;
        }
        const reason = `Instalment #${row.instalment_number} (due ${row.due_date}) unpaid beyond ${account.grace_period_months}-month grace period`;
        const inserted = await client.query(`INSERT INTO rd_penalty (rd_account_id, instalment_id, penalty_amount, reason)
       VALUES ($1, $2, $3, $4)
       RETURNING id`, [account.id, row.id, penaltyAmount, reason]);
        const penaltyId = inserted.rows[0]?.id;
        if (!penaltyId)
            throw new Error('failed to apply RD penalty');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_PENALTY_APPLIED,
            entityType: 'rd_penalty',
            entityId: penaltyId,
            metadata: {
                rdAccountId: account.id,
                accountNumber: account.account_number,
                instalmentId: row.id,
                instalmentNumber: row.instalment_number,
                instalmentStatus: newStatus,
                penaltyAmount,
                reason,
            },
        });
        applied += 1;
    }
    return applied;
}
// ---------------------------------------------------------------------------
// RD schemes — list, create
// ---------------------------------------------------------------------------
export async function listSchemes(actor, queryInput, meta = {}) {
    void actor;
    void meta;
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (queryInput.search) {
        const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        where.push(`(code ILIKE ${addParam(pattern)} ESCAPE '\\' OR name ILIKE ${addParam(pattern)} ESCAPE '\\')`);
    }
    if (queryInput.includeInactive !== 'true') {
        where.push('is_active = true');
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`SELECT id, code, name, description, frequency,
            min_instalment_amount::text AS min_instalment_amount,
            max_instalment_amount::text AS max_instalment_amount,
            min_duration_months, max_duration_months, grace_period_months,
            interest_rate::text AS interest_rate, interest_credit_frequency,
            early_closure_fee_percent::text AS early_closure_fee_percent,
            penalty_config, is_active, created_at, updated_at,
            count(*) OVER()::int AS total
       FROM rd_scheme
       ${whereSql}
      ORDER BY name ASC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toSchemeView(row));
    return { total, items };
}
export async function createScheme(actor, input, meta = {}) {
    const created = await transaction(async (client) => {
        if (input.minDurationMonths > input.maxDurationMonths) {
            throw new BusinessRuleError('minDurationMonths cannot exceed maxDurationMonths', 'SCHEME_DURATION_RANGE_INVALID');
        }
        if (input.maxInstalmentAmount && compareMoney(input.minInstalmentAmount, input.maxInstalmentAmount) > 0) {
            throw new BusinessRuleError('minInstalmentAmount cannot exceed maxInstalmentAmount', 'SCHEME_AMOUNT_RANGE_INVALID');
        }
        let schemeId;
        try {
            const insert = await client.query(`INSERT INTO rd_scheme
           (code, name, description, frequency, min_instalment_amount,
            max_instalment_amount, min_duration_months, max_duration_months,
            grace_period_months, interest_rate, interest_credit_frequency,
            early_closure_fee_percent, penalty_config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING id`, [
                input.code,
                input.name,
                input.description ?? null,
                input.frequency,
                input.minInstalmentAmount,
                input.maxInstalmentAmount ?? null,
                input.minDurationMonths,
                input.maxDurationMonths,
                input.gracePeriodMonths,
                input.interestRate,
                input.interestCreditFrequency,
                input.earlyClosureFeePercent,
                JSON.stringify(input.penaltyConfig ?? {}),
            ]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create RD scheme');
            schemeId = inserted.id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError('A RD scheme with this code already exists', 'SCHEME_CODE_EXISTS');
            }
            throw error;
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_SCHEME_CREATED,
            entityType: 'rd_scheme',
            entityId: schemeId,
            metadata: {
                code: input.code,
                name: input.name,
                frequency: input.frequency,
                minInstalmentAmount: input.minInstalmentAmount,
                maxInstalmentAmount: input.maxInstalmentAmount ?? null,
                minDurationMonths: input.minDurationMonths,
                maxDurationMonths: input.maxDurationMonths,
                gracePeriodMonths: input.gracePeriodMonths,
                interestRate: input.interestRate,
                interestCreditFrequency: input.interestCreditFrequency,
                earlyClosureFeePercent: input.earlyClosureFeePercent,
                createdBy: actor.staffId,
            },
        });
        return loadScheme(client, schemeId);
    });
    return created;
}
// ---------------------------------------------------------------------------
// RD accounts — open, read, list
// ---------------------------------------------------------------------------
export async function openAccount(actor, input, meta = {}) {
    const created = await transaction(async (client) => {
        await assertCustomerEligible(client, input.customerId);
        await assertBranchExists(client, input.branchId);
        const scheme = await selectSchemeById(client, input.schemeId);
        if (!scheme)
            throw new NotFoundError('RD scheme');
        if (!scheme.is_active) {
            throw new BusinessRuleError('This RD scheme is not active', 'SCHEME_INACTIVE');
        }
        // The customer picks the scheme (which carries a frequency). The account
        // snapshots that frequency plus grace period at opening.
        if (input.frequency !== scheme.frequency) {
            throw new BusinessRuleError(`Instalment frequency ${input.frequency} does not match the scheme frequency ${scheme.frequency}`, 'FREQUENCY_MISMATCH');
        }
        if (compareMoney(input.instalmentAmount, scheme.min_instalment_amount) < 0) {
            throw new BusinessRuleError(`Instalment amount is below the scheme minimum of ${scheme.min_instalment_amount}`, 'INSTALMENT_BELOW_MIN');
        }
        if (scheme.max_instalment_amount && compareMoney(input.instalmentAmount, scheme.max_instalment_amount) > 0) {
            throw new BusinessRuleError(`Instalment amount exceeds the scheme maximum of ${scheme.max_instalment_amount}`, 'INSTALMENT_ABOVE_MAX');
        }
        const startDate = input.startDate ?? istBusinessDate();
        const firstDueDate = input.firstDueDate;
        if (firstDueDate < startDate) {
            throw new BusinessRuleError('firstDueDate cannot precede the start date', 'FIRST_DUE_BEFORE_START');
        }
        // Resolve the maturity date: explicit input wins; otherwise the term is
        // durationMonths measured from firstDueDate (refined by the schema).
        let maturityDate;
        if (input.maturityDate) {
            if (input.maturityDate <= firstDueDate) {
                throw new BusinessRuleError('maturityDate must fall after firstDueDate', 'MATURITY_BEFORE_FIRST_DUE');
            }
            maturityDate = input.maturityDate;
        }
        else if (input.durationMonths !== undefined) {
            maturityDate = addMonths(firstDueDate, input.durationMonths);
        }
        else {
            throw new BusinessRuleError('Provide either a maturityDate or a durationMonths term for the RD account', 'TERM_MISSING');
        }
        // Term must fall inside the scheme's duration window.
        const lowerBound = addMonths(firstDueDate, scheme.min_duration_months);
        const upperBound = addMonths(firstDueDate, scheme.max_duration_months);
        if (maturityDate < lowerBound) {
            throw new BusinessRuleError(`Term is below the scheme minimum of ${scheme.min_duration_months} months`, 'TERM_BELOW_MIN');
        }
        if (maturityDate > upperBound) {
            throw new BusinessRuleError(`Term exceeds the scheme maximum of ${scheme.max_duration_months} months`, 'TERM_ABOVE_MAX');
        }
        const dueDates = generateInstalmentDates(firstDueDate, maturityDate, input.frequency);
        if (dueDates.length === 0) {
            throw new BusinessRuleError('No instalments can be scheduled for this term', 'SCHEDULE_EMPTY');
        }
        const totalExpected = fromCents(toCents(input.instalmentAmount) * BigInt(dueDates.length));
        const sequence = await allocateSequence(client, 'rd_account');
        const accountNumber = sequence.formatted;
        let accountId;
        try {
            const insert = await client.query(`INSERT INTO rd_account
           (account_number, customer_id, scheme_id, branch_id,
            instalment_amount, frequency, start_date, first_due_date, maturity_date,
            status, total_expected, total_paid, pending_amount,
            grace_period_months, opened_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'active', $10, '0.00', $11, $12, $13)
         RETURNING id`, [
                accountNumber,
                input.customerId,
                input.schemeId,
                input.branchId,
                input.instalmentAmount,
                input.frequency,
                startDate,
                firstDueDate,
                maturityDate,
                totalExpected,
                totalExpected,
                scheme.grace_period_months,
                actor.staffId,
            ]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create RD account');
            accountId = inserted.id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError('RD account number collision — please retry', 'ACCOUNT_NUMBER_COLLISION');
            }
            throw error;
        }
        // Materialise the whole schedule in one statement so opening and the
        // expected-instalment ledger commit atomically.
        const instalmentNumbers = dueDates.map((_date, index) => index + 1);
        await client.query(`INSERT INTO rd_instalment (rd_account_id, instalment_number, due_date, expected_amount)
       SELECT $1, num, due, $2::numeric
         FROM unnest($3::int[], $4::date[]) AS t(num, due)`, [accountId, input.instalmentAmount, instalmentNumbers, dueDates]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.RD_ACCOUNT_OPENED,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber,
                customerId: input.customerId,
                schemeId: input.schemeId,
                branchId: input.branchId,
                instalmentAmount: input.instalmentAmount,
                frequency: input.frequency,
                startDate,
                firstDueDate,
                maturityDate,
                instalmentCount: dueDates.length,
                totalExpected,
                gracePeriodMonths: scheme.grace_period_months,
                status: 'active',
                openedBy: actor.staffId,
            },
        });
        return loadRdAccountDetail(client, accountId);
    });
    return created;
}
export async function listAccounts(actor, queryInput, meta = {}) {
    void actor;
    void meta;
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (queryInput.search) {
        const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        where.push(`(ra.account_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.mobile ILIKE ${addParam(pattern)} ESCAPE '\\')`);
    }
    if (queryInput.customerId) {
        where.push(`ra.customer_id = ${addParam(queryInput.customerId)}`);
    }
    if (queryInput.schemeId) {
        where.push(`ra.scheme_id = ${addParam(queryInput.schemeId)}`);
    }
    if (queryInput.branchId) {
        where.push(`ra.branch_id = ${addParam(queryInput.branchId)}`);
    }
    if (queryInput.status) {
        where.push(`ra.status = ${addParam(queryInput.status)}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`${RD_ACCOUNT_SELECT.replace('FROM rd_account ra', ', count(*) OVER()::int AS total FROM rd_account ra')}
         ${whereSql}
        ORDER BY ra.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toRdAccountView(row));
    return { total, items };
}
export async function getAccount(actor, accountId, meta = {}) {
    const detail = await transaction(async (client) => {
        return loadRdAccountDetail(client, accountId);
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: ACTION_ACCOUNT_VIEWED,
        entityType: 'rd_account',
        entityId: accountId,
        metadata: { viewedBy: actor.staffId },
    });
    return detail;
}
export async function getSchedule(actor, accountId, queryInput, meta = {}) {
    const schedule = await transaction(async (client) => {
        const account = await loadRdAccountDetail(client, accountId);
        const where = ['rd_account_id = $1'];
        const params = [accountId];
        const addParam = (value) => {
            params.push(value);
            return `$${params.length}`;
        };
        if (queryInput.status) {
            where.push(`status = ${addParam(queryInput.status)}`);
        }
        if (queryInput.from) {
            where.push(`due_date >= ${addParam(queryInput.from)}::date`);
        }
        if (queryInput.to) {
            where.push(`due_date <= ${addParam(queryInput.to)}::date`);
        }
        const whereSql = `WHERE ${where.join(' AND ')}`;
        const limit = queryInput.limit;
        const offset = queryInput.offset;
        const instalments = await client.query(`SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              paid_amount::text AS paid_amount,
              status,
              paid_on::text AS paid_on,
              payment_method, reference_number, collection_entry_id,
              allocation, created_at, updated_at,
              count(*) OVER()::int AS total
         FROM rd_instalment
         ${whereSql}
        ORDER BY due_date ASC, instalment_number ASC
        LIMIT ${limit} OFFSET ${offset}`, params);
        const total = instalments.rows[0]?.total ?? 0;
        const items = instalments.rows.map((row) => toInstalmentView(row));
        const penaltyRows = await selectPenaltiesForAccount(client, accountId);
        const penalties = penaltyRows.map((row) => toPenaltyView(row));
        return { account, total, items, penalties };
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: ACTION_SCHEDULE_VIEWED,
        entityType: 'rd_account',
        entityId: accountId,
        metadata: {
            viewedBy: actor.staffId,
            status: queryInput.status ?? null,
            from: queryInput.from ?? null,
            to: queryInput.to ?? null,
        },
    });
    return schedule;
}
// ---------------------------------------------------------------------------
// Instalment collection (full / part / multiple)
// ---------------------------------------------------------------------------
export async function recordInstalmentPayment(actor, accountId, input, meta = {}) {
    const result = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        if (!OPEN_STATUSES.includes(account.status)) {
            throw new BusinessRuleError(`Instalments can only be recorded on an active or overdue RD account (current status: ${account.status})`, 'ACCOUNT_NOT_PAYABLE');
        }
        // State is kept honest before we touch the money.
        await sweepMissedInstalments(client, account, actor, meta);
        const due = await client.query(`SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              paid_amount::text AS paid_amount,
              status, allocation
         FROM rd_instalment
        WHERE rd_account_id = $1 AND status IN ('due','partial','missed','overdue')
        ORDER BY due_date ASC, instalment_number ASC
        FOR UPDATE`, [accountId]);
        const dueRows = due.rows;
        if (dueRows.length === 0) {
            throw new BusinessRuleError('This RD account has no unpaid instalments', 'NO_DUE_INSTALMENTS');
        }
        const paidOn = input.paidOn ?? istBusinessDate();
        const paymentMethod = input.paymentMethod;
        const referenceNumber = input.referenceNumber ?? null;
        const collectionEntryId = input.collectionEntryId ?? null;
        // Allocate the payment across due instalments, oldest first (spec §10.5).
        const allocationEvents = [];
        let remaining = toCents(input.amount);
        for (const row of dueRows) {
            if (remaining <= 0n)
                break;
            const outstanding = subMoney(row.expected_amount, row.paid_amount);
            const outstandingCents = toCents(outstanding);
            if (remaining >= outstandingCents) {
                remaining -= outstandingCents;
                allocationEvents.push({
                    row,
                    amountPaid: outstanding,
                    newPaidAmount: row.expected_amount,
                    newStatus: 'paid',
                });
            }
            else {
                const partPaid = fromCents(remaining);
                allocationEvents.push({
                    row,
                    amountPaid: partPaid,
                    newPaidAmount: addMoney(row.paid_amount, partPaid),
                    newStatus: 'partial',
                });
                remaining = 0n;
                break;
            }
        }
        if (allocationEvents.length === 0) {
            throw new BusinessRuleError('This RD account has no unpaid instalments', 'NO_DUE_INSTALMENTS');
        }
        if (remaining > 0n) {
            throw new BusinessRuleError('Payment exceeds all outstanding instalments. Any excess must be routed to the linked loan account through surplus-transfer (spec §10.1 Follow-up rule)', 'EXCESS_PAYMENT_REQUIRES_SURPLUS_TRANSFER');
        }
        const appliedIds = [];
        for (const event of allocationEvents) {
            const { row } = event;
            const prior = Array.isArray(row.allocation) ? row.allocation : [];
            const eventRecord = {
                instalmentNumber: row.instalment_number,
                dueDate: row.due_date,
                amountPaid: event.amountPaid,
                newPaidAmount: event.newPaidAmount,
                statusAfter: event.newStatus,
                paymentMethod,
                paidOn,
                referenceNumber: referenceNumber ?? null,
                collectionEntryId: collectionEntryId ?? null,
                paidBy: actor.staffId,
            };
            await client.query(`UPDATE rd_instalment
            SET paid_amount = $1::numeric,
                status = $2,
                paid_on = $3,
                payment_method = $4,
                reference_number = $5,
                collection_entry_id = $6,
                allocation = $7::jsonb,
                updated_at = now()
          WHERE id = $8`, [
                event.newPaidAmount,
                event.newStatus,
                paidOn,
                paymentMethod,
                referenceNumber,
                collectionEntryId,
                JSON.stringify([...prior, eventRecord]),
                row.id,
            ]);
            appliedIds.push(row.id);
        }
        // Recompose account totals + status from the ledger.
        await recomputeAccountTotals(client, accountId);
        const refreshed = await selectRdAccountById(client, accountId);
        if (!refreshed)
            throw new NotFoundError('RD account');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.RD_INSTALMENT_PAID,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber: account.account_number,
                amount: input.amount,
                paidOn,
                paymentMethod,
                referenceNumber: referenceNumber ?? null,
                collectionEntryId: collectionEntryId ?? null,
                instalmentsCovered: allocationEvents.length,
                allocations: allocationEvents.map((event) => ({
                    instalmentId: event.row.id,
                    instalmentNumber: event.row.instalment_number,
                    amountPaid: event.amountPaid,
                    statusAfter: event.newStatus,
                })),
                totalPaid: refreshed.total_paid,
                pendingAmount: refreshed.pending_amount,
                accountStatus: refreshed.status,
                recordedBy: actor.staffId,
            },
        });
        const appliedRows = await selectInstalmentsByIds(client, accountId, appliedIds);
        const accountView = await loadRdAccountDetail(client, accountId);
        return { account: accountView, appliedTo: appliedRows.map(toInstalmentView) };
    });
    return result;
}
// ---------------------------------------------------------------------------
// Penalty waiver (President)
// ---------------------------------------------------------------------------
export async function waivePenalty(actor, accountId, input, meta = {}) {
    const result = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        const penalty = await client.query(`${PENALTY_SELECT} WHERE rp.id = $1 AND rp.rd_account_id = $2 LIMIT 1`, [input.penaltyId, accountId]);
        const penaltyRow = penalty.rows[0] ?? null;
        if (!penaltyRow)
            throw new NotFoundError('RD penalty');
        if (penaltyRow.status !== 'due') {
            throw new BusinessRuleError(`Only a due penalty can be waived (current status: ${penaltyRow.status})`, 'PENALTY_NOT_WAIVABLE');
        }
        if (input.amount !== undefined && input.amount !== penaltyRow.penalty_amount) {
            throw new BusinessRuleError('A penalty waiver must cover the full penalty amount — rd_penalty.status has no partial-waiver state', 'PARTIAL_WAIVER_NOT_SUPPORTED');
        }
        const inserted = await client.query(`INSERT INTO rd_waiver (rd_account_id, penalty_id, amount, reason, approved_by)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`, [accountId, input.penaltyId, penaltyRow.penalty_amount, input.reason, actor.staffId]);
        const waiverId = inserted.rows[0]?.id;
        if (!waiverId)
            throw new Error('failed to create RD waiver');
        await client.query(`UPDATE rd_penalty
          SET status = 'waived', waived_by = $1, waived_on = now(), updated_at = now()
        WHERE id = $2`, [actor.staffId, input.penaltyId]);
        const waiverRow = await selectWaiverById(client, waiverId);
        if (!waiverRow)
            throw new Error('failed to reload RD waiver');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.RD_PENALTY_WAIVED,
            entityType: 'rd_penalty',
            entityId: input.penaltyId,
            metadata: {
                rdAccountId: accountId,
                accountNumber: account.account_number,
                waiverId,
                penaltyAmount: penaltyRow.penalty_amount,
                instalmentNumber: penaltyRow.instalment_number ?? null,
                reason: input.reason,
                approvedBy: actor.staffId,
            },
        });
        const accountView = await loadRdAccountDetail(client, accountId);
        return { account: accountView, waiver: toWaiverView(waiverRow) };
    });
    return result;
}
// ---------------------------------------------------------------------------
// Reschedule — due-date / instalment-amount change (President)
// ---------------------------------------------------------------------------
export async function rescheduleAccount(actor, accountId, input, meta = {}) {
    const result = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        if (!OPEN_STATUSES.includes(account.status)) {
            throw new BusinessRuleError(`Only an active or overdue RD account can be rescheduled (current status: ${account.status})`, 'ACCOUNT_NOT_RESCHEDULABLE');
        }
        if (account.approved_by === null) {
            throw new BusinessRuleError('Rescheduling requires the account to be approved first (spec §10.1 approval gate)', 'ACCOUNT_NOT_APPROVED');
        }
        const changeType = input.changeType;
        const effectiveFrom = input.effectiveFrom;
        const changesAmount = changeType !== 'due_date_change';
        const newAmount = changesAmount ? input.newInstalmentAmount : account.instalment_amount;
        const maxBefore = await client.query(`SELECT COALESCE(MAX(instalment_number), 0)::int AS max_number
         FROM rd_instalment
        WHERE rd_account_id = $1 AND due_date < $2`, [accountId, effectiveFrom]);
        const keptNumber = maxBefore.rows[0]?.max_number ?? 0;
        const affected = await client.query(`SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              paid_amount::text AS paid_amount,
              status, allocation
         FROM rd_instalment
        WHERE rd_account_id = $1 AND due_date >= $2
        ORDER BY instalment_number ASC`, [accountId, effectiveFrom]);
        const affectedRows = affected.rows;
        if (affectedRows.length === 0) {
            throw new BusinessRuleError('There are no instalments on or after the reschedule effective date', 'NO_INSTALMENTS_TO_RESCHEDULE');
        }
        if (affectedRows.some((row) => toCents(row.paid_amount) > 0n)) {
            throw new BusinessRuleError('Cannot reschedule instalments that already carry collected money — move the effective date past the last paid instalment', 'RESCHEDULE_AFTER_PAYMENTS');
        }
        const oldExpected = await client.query(`SELECT COALESCE(SUM(expected_amount), 0)::numeric::text AS expected
         FROM rd_instalment WHERE rd_account_id = $1`, [accountId]);
        const oldTotalExpected = oldExpected.rows[0]?.expected ?? '0.00';
        await client.query(`DELETE FROM rd_instalment WHERE rd_account_id = $1 AND due_date >= $2`, [
            accountId,
            effectiveFrom,
        ]);
        const newDates = regenerateInstalmentDates(effectiveFrom, affectedRows.length, account.frequency);
        if (newDates.length !== affectedRows.length) {
            throw new BusinessRuleError('Failed to regenerate the instalment schedule', 'SCHEDULE_REGEN_FAILED');
        }
        // Continue numbering from the last kept instalment so instalment_number
        // stays monotonic and unique across the whole term.
        const numbers = newDates.map((_d, index) => keptNumber + index + 1);
        await client.query(`INSERT INTO rd_instalment (rd_account_id, instalment_number, due_date, expected_amount)
       SELECT $1, num, due, $2::numeric
         FROM unnest($3::int[], $4::date[]) AS t(num, due)`, [accountId, newAmount ?? account.instalment_amount, numbers, newDates]);
        const newMaturityDate = newDates[newDates.length - 1] ?? account.maturity_date;
        await client.query(`UPDATE rd_account
          SET instalment_amount = $1::numeric,
              maturity_date = $2::date,
              updated_at = now()
        WHERE id = $3`, [newAmount ?? account.instalment_amount, newMaturityDate, accountId]);
        // Recompute totals/status and capture the new expected total for the log.
        const recomputed = await recomputeAccountTotals(client, accountId);
        const oldValue = {
            maturityDate: account.maturity_date,
            instalmentAmount: account.instalment_amount,
            totalExpected: oldTotalExpected,
            frequency: account.frequency,
        };
        const newValue = {
            effectiveFrom,
            maturityDate: newMaturityDate,
            instalmentAmount: newAmount ?? account.instalment_amount,
            totalExpected: recomputed.expected,
            frequency: account.frequency,
        };
        const inserted = await client.query(`INSERT INTO rd_schedule_change
         (rd_account_id, change_type, old_value, new_value, reason, approved_by, effective_from)
       VALUES ($1, $2, $3::jsonb, $4::jsonb, $5, $6, $7)
       RETURNING id`, [
            accountId,
            changeType,
            JSON.stringify(oldValue),
            JSON.stringify(newValue),
            input.reason,
            actor.staffId,
            effectiveFrom,
        ]);
        const changeId = inserted.rows[0]?.id;
        if (!changeId)
            throw new Error('failed to record RD schedule change');
        const changeRow = await selectScheduleChangeById(client, changeId);
        if (!changeRow)
            throw new Error('failed to reload RD schedule change');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.RD_RESCHEDULED,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber: account.account_number,
                changeType,
                effectiveFrom,
                oldValue,
                newValue,
                reason: input.reason,
                instalmentsRegenerated: affectedRows.length,
                approvedBy: actor.staffId,
            },
        });
        const accountView = await loadRdAccountDetail(client, accountId);
        return { account: accountView, change: toScheduleChangeView(changeRow) };
    });
    return result;
}
// ---------------------------------------------------------------------------
// Early closure — 4% closure fee (Managing Director)
// ---------------------------------------------------------------------------
export async function closeEarlyAccount(actor, accountId, input, meta = {}) {
    const result = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        if (!OPEN_STATUSES.includes(account.status)) {
            throw new BusinessRuleError(`Only an active or overdue RD account can be closed early (current status: ${account.status})`, 'ACCOUNT_NOT_CLOSEABLE');
        }
        const closedOn = istBusinessDate();
        // Closure fee applies to the principal collected so far (4% of total_paid)
        // until the bank specifies a different basis (spec §10.1: closure fee 4%).
        const closureFee = percentOf(account.total_paid, String(BUSINESS_RULES.RD_EARLY_CLOSURE_FEE_PERCENT));
        // Every instalment that is not yet fully collected is waived by the closure
        // so the schedule ledger reads cleanly after the account goes terminal.
        const unpaid = await client.query(`SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              paid_amount::text AS paid_amount,
              status, allocation
         FROM rd_instalment
        WHERE rd_account_id = $1 AND status IN ('due','partial','missed','overdue')
        FOR UPDATE`, [accountId]);
        const unpaidIds = unpaid.rows.map((row) => row.id);
        if (unpaidIds.length > 0) {
            await client.query(`UPDATE rd_instalment
            SET status = 'waived', updated_at = now()
          WHERE id = ANY($1::uuid[])`, [unpaidIds]);
        }
        const recomputed = await recomputeAccountTotals(client, accountId);
        await client.query(`UPDATE rd_account
          SET status = 'closed_early',
              closed_on = $1::date,
              closure_fee = $2::numeric,
              updated_at = now()
        WHERE id = $3`, [closedOn, closureFee, accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.RD_CLOSED_EARLY,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber: account.account_number,
                reason: input.reason,
                closedOn,
                closureFee,
                closureFeePercent: String(BUSINESS_RULES.RD_EARLY_CLOSURE_FEE_PERCENT),
                feeBasis: account.total_paid,
                totalPaid: recomputed.paid,
                totalExpected: recomputed.expected,
                pendingBeforeClosure: account.pending_amount,
                pendingAfterClosure: recomputed.pending,
                instalmentsWaived: unpaidIds.length,
                paymentMethod: input.paymentMethod,
                referenceNumber: input.referenceNumber ?? null,
                closedBy: actor.staffId,
            },
        });
        const accountView = await loadRdAccountDetail(client, accountId);
        return { account: accountView, closureFee };
    });
    return result;
}
// ---------------------------------------------------------------------------
// Surplus transfer — excess → linked loan account (Managing Director)
// ---------------------------------------------------------------------------
export async function surplusTransfer(actor, accountId, input, meta = {}) {
    const result = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        if (!OPEN_STATUSES.includes(account.status)) {
            throw new BusinessRuleError(`A surplus can only be held for an active or overdue RD account (current status: ${account.status})`, 'ACCOUNT_NOT_TRANSFERABLE');
        }
        if (account.linked_loan_id !== null && account.linked_loan_id !== input.loanId) {
            throw new BusinessRuleError('This RD account is already linked to a different loan account; the surplus cannot be moved elsewhere', 'LINKED_LOAN_MISMATCH');
        }
        const loan = await client.query(`SELECT id, loan_number, customer_id, status FROM loan WHERE id = $1 LIMIT 1`, [input.loanId]);
        const loanRow = loan.rows[0] ?? null;
        if (!loanRow)
            throw new NotFoundError('Loan account');
        if (CLOSED_LOAN_STATUSES.includes(loanRow.status)) {
            throw new BusinessRuleError(`A surplus can only be held while the loan is live (current loan status: ${loanRow.status})`, 'LOAN_NOT_ACTIVE');
        }
        if (loanRow.customer_id !== account.customer_id) {
            throw new BusinessRuleError('The surplus must be held in a loan account belonging to the same customer', 'LOAN_CUSTOMER_MISMATCH');
        }
        // Link the account to the loan if it is not linked yet.
        if (account.linked_loan_id === null) {
            await client.query(`UPDATE rd_account SET linked_loan_id = $1, updated_at = now() WHERE id = $2`, [input.loanId, accountId]);
        }
        const inserted = await client.query(`INSERT INTO loan_surplus (loan_id, entry_type, amount, source_collection_id)
       VALUES ($1, 'held', $2, $3)
       RETURNING id`, [input.loanId, input.amount, null]);
        const surplusId = inserted.rows[0]?.id;
        if (!surplusId)
            throw new Error('failed to hold RD surplus');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_SURPLUS_TRANSFERRED,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber: account.account_number,
                loanId: input.loanId,
                loanNumber: loanRow.loan_number,
                amount: input.amount,
                loanSurplusId: surplusId,
                entryType: 'held',
                reason: input.reason ?? null,
                linkedBy: actor.staffId,
            },
        });
        const accountView = await loadRdAccountDetail(client, accountId);
        return {
            account: accountView,
            held: { loanId: input.loanId, amount: input.amount, entryType: 'held' },
        };
    });
    return result;
}
// ---------------------------------------------------------------------------
// Approval — fund transfer / approved-fund-waiting sign-off
// ---------------------------------------------------------------------------
export async function approveAccount(actor, accountId, input, meta = {}) {
    const approved = await transaction(async (client) => {
        const account = await selectRdAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('RD account');
        if (account.status === 'closed_early' || account.status === 'cancelled') {
            throw new BusinessRuleError(`A ${account.status} RD account cannot be approved`, 'ACCOUNT_NOT_APPROVABLE');
        }
        if (account.approved_by !== null) {
            throw new BusinessRuleError('This RD account has already been approved', 'RD_ACCOUNT_ALREADY_APPROVED');
        }
        await client.query(`UPDATE rd_account
          SET approved_by = $1, updated_at = now()
        WHERE id = $2`, [actor.staffId, accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_ACCOUNT_APPROVED,
            entityType: 'rd_account',
            entityId: accountId,
            metadata: {
                accountNumber: account.account_number,
                note: input.note ?? null,
                approvedBy: actor.staffId,
            },
        });
        return loadRdAccountDetail(client, accountId);
    });
    return approved;
}
