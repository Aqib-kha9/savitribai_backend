import { query, transaction } from '../../database/client.js';
import { randomUUID } from 'node:crypto';
import { appendAuditEvent, AUDIT_ACTIONS, } from '../../audit/audit-writer.js';
import { istBusinessDate, isPastIstDeadline } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, DeadlineExceededError, NotFoundError, } from '../../core/errors.js';
import { allocateSequence } from '../../database/numbering.js';
import { evaluateOfflineLate, lookupCollectionReplay, lookupVisitReplay, } from '../sync/sync.service.js';
/**
 * Doorstep collections service (docs/backend-master-spec.md §14).
 *
 * This module is the OFFICE GATEWAY for the doorstep-collection lifecycle: it
 * records agent submissions and visits (replay-safe push paths shared with the
 * sync protocol §20), tracks office review / reversal / duplicate / short-payment
 * decisions, issues the mandatory receipt for every collection (§14.3), and
 * serves the office list + total-amount report.
 *
 * Accepted-collection postings are NOT performed here. Downstream product
 * modules (rd / loans / deposits) reference `collection_entry_id`
 * (rd_instalment.collection_entry_id) when they post an accepted collection to
 * the product ledger; this module records status / review / reversal records
 * and receipts only. The reconciliation module (§16) nets accepted entries
 * against collection_reversal rows.
 *
 * Receipts are issued from the central number sequences (§4) seeded as
 * `receipt_daily` (RCPT-D, resets daily) and `receipt_monthly` (RCPT-M,
 * resets monthly). `collection_receipt` is APPEND-ONLY (reject_mutation trigger)
 * — a duplicate deletion soft-deletes the collection_entry only and a dispute
 * reversal inserts a NEW corrected entry + a NEW receipt; receipts are never
 * updated or deleted.
 *
 * Deadlines (IST): cash handover is 16:00 (§14.1) and submission is 17:00
 * (§14.5/§16.5). The server enforces 17:00 on submitCollection AFTER the
 * idempotent-replay check — replays always succeed, mirroring agents.submitDayClose.
 * recordVisit is NOT deadline-gated (visit evidence is not money). The 16:00 cash
 * handover itself is enforced by the reconciliation module (§16), not here.
 *
 * Shared protocol helpers (replay lookups + evaluateOfflineLate) are imported
 * from the sync module; resolveAgent / assertAgentOperational are copied here
 * because sync's resolveAgent and agents' helpers are module-private.
 */
// Submission deadline for collections — 17:00 IST (spec §14.5/§16.5).
const SUBMISSION_DEADLINE_HOUR = 17;
// ---------------------------------------------------------------------------
// Local audit helpers (same transaction as the mutation — spec §6.3)
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
/** Autocommit bridge for the few helpers that need a client outside a transaction. */
function poolForEvent() {
    return {
        query: (text, params) => query(text, params),
    };
}
function isUniqueViolation(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505');
}
/** Resolves the agent profile bound to the authenticated staff account. */
async function resolveAgent(actor) {
    const result = await query(`SELECT id, agent_code, status FROM agent WHERE staff_id = $1 LIMIT 1`, [actor.staffId]);
    const row = result.rows[0];
    if (!row) {
        throw new BusinessRuleError('No agent profile is linked to this account — contact the managing director', 'AGENT_PROFILE_REQUIRED');
    }
    return row;
}
/** Push paths only operate for an active, collectible agent. */
function assertAgentOperational(agent) {
    if (agent.status !== 'active') {
        throw new BusinessRuleError(`Agent is ${agent.status} — collections are unavailable`, 'AGENT_NOT_ACTIVE');
    }
}
/**
 * Canonical office-facing SELECT. `count(*) OVER()` keeps the shared list +
 * single-row paths consistent; review / receipt / account detail ride along on
 * LEFT JOINs (collection_review.collection_id is UNIQUE so at most one row).
 */
const COLLECTION_SELECT = `ce.id, ce.idempotency_key, ce.agent_id, a.agent_code,
      ce.customer_id, c.full_name AS customer_name,
      ce.product_type, ce.amount, ce.mode, ce.status, ce.is_partial, ce.is_advance,
      ce.instrument_ref, ce.instrument_date,
      ce.business_date, ce.collected_at, ce.submitted_at, ce.submitted_from_offline,
      ce.offline_late, ce.visit_log_id, ce.allocation, ce.is_deleted,
      ce.deleted_at, ce.deletion_reason, ce.created_at,
      count(*) OVER()::int AS total,
      COALESCE(sa.id, ra.id, l.id) AS account_id,
      COALESCE(sa.account_number, ra.account_number, l.loan_number) AS account_number,
      COALESCE(dp.name, rs.name, lp.name) AS product_label,
      cr.receipt_number, cr.receipt_kind, COALESCE(cr.acknowledged, false) AS acknowledged,
      rv.decision AS review_decision, rv.remarks AS review_remarks, rv.reviewed_at`;
const COLLECTION_FROM = `FROM collection_entry ce
       JOIN agent a ON a.id = ce.agent_id
       JOIN customer c ON c.id = ce.customer_id
       LEFT JOIN savings_account sa ON sa.id = ce.savings_account_id
       LEFT JOIN deposit_product dp ON dp.id = sa.product_id
       LEFT JOIN rd_account ra ON ra.id = ce.rd_account_id
       LEFT JOIN rd_scheme rs ON rs.id = ra.scheme_id
       LEFT JOIN loan l ON l.id = ce.loan_id
       LEFT JOIN loan_product lp ON lp.id = l.product_id
       LEFT JOIN collection_receipt cr ON cr.collection_id = ce.id
       LEFT JOIN collection_review rv ON rv.collection_id = ce.id`;
function toSubmissionView(row) {
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        isDeleted: row.is_deleted,
        customerId: row.customer_id,
        customerName: row.customer_name,
        productType: row.product_type,
        amount: row.amount,
        mode: row.mode,
        isPartial: row.is_partial,
        isAdvance: row.is_advance,
        instrumentRef: row.instrument_ref,
        instrumentDate: row.instrument_date,
        businessDate: row.business_date,
        collectedAt: iso(row.collected_at),
        submittedAt: row.submitted_at.toISOString(),
        submittedFromOffline: row.submitted_from_offline,
        offlineLate: row.offline_late,
        visitLogId: row.visit_log_id,
        createdAt: row.created_at.toISOString(),
        receiptNumber: row.receipt_number,
        receiptKind: row.receipt_kind ?? null,
        acknowledged: row.acknowledged,
        agentId: row.agent_id,
        agentCode: row.agent_code,
        accountId: row.account_id,
        accountNumber: row.account_number,
        productLabel: row.product_label,
    };
}
function toCollectionView(row) {
    return {
        ...toSubmissionView(row),
        deletedAt: iso(row.deleted_at),
        deletionReason: row.deletion_reason,
        allocation: row.allocation,
        review: row.review_decision
            ? {
                decision: row.review_decision,
                remarks: row.review_remarks,
                reviewedAt: iso(row.reviewed_at),
            }
            : null,
    };
}
/** Loads one collection row (optionally scoped to an agent) through `client`. */
async function selectCollectionById(client, id, agentId) {
    const params = [id];
    let scopeSql = '';
    if (agentId) {
        params.push(agentId);
        scopeSql = ' AND ce.agent_id = $2';
    }
    const result = await client.query(`SELECT ${COLLECTION_SELECT}
       ${COLLECTION_FROM}
      WHERE ce.id = $1${scopeSql}`, params);
    return result.rows[0] ?? null;
}
/** Replay path — the entry exists (scoped to the agent), so re-read the full view. */
async function loadSubmissionReplay(agentId, replay) {
    const row = await selectCollectionById(poolForEvent(), replay.id, agentId);
    if (!row) {
        throw new NotFoundError('Collection');
    }
    return toSubmissionView(row);
}
function toVisitView(row) {
    const photos = Array.isArray(row.photos) ? row.photos : null;
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        customerId: row.customer_id,
        customerName: row.customer_name,
        visitDate: row.visit_date,
        visitedAt: iso(row.visited_at),
        outcome: row.outcome,
        remark: row.remark,
        photos,
        createdAt: row.created_at.toISOString(),
    };
}
async function selectVisitById(client, id, agentId) {
    const params = [id];
    let scopeSql = '';
    if (agentId) {
        params.push(agentId);
        scopeSql = ' AND v.agent_id = $2';
    }
    const result = await client.query(`SELECT v.id, v.idempotency_key, v.customer_id, c.full_name AS customer_name,
            v.visit_date, v.visited_at, v.outcome, v.remark, v.photos, v.created_at
       FROM visit_log v
       JOIN customer c ON c.id = v.customer_id
      WHERE v.id = $1${scopeSql}`, params);
    return result.rows[0] ?? null;
}
async function loadVisitReplay(agentId, replay) {
    const row = await selectVisitById(poolForEvent(), replay.id, agentId);
    if (!row) {
        throw new NotFoundError('Visit');
    }
    return toVisitView(row);
}
// ---------------------------------------------------------------------------
// Customer / account / assignment validation
// ---------------------------------------------------------------------------
async function selectCustomer(client, customerId) {
    const result = await client.query(`SELECT full_name, status FROM customer WHERE id = $1`, [customerId]);
    return result.rows[0] ?? null;
}
/** Collections can only be raised for an active customer (§14). */
async function assertCollectibleCustomer(client, customerId) {
    const customer = await selectCustomer(client, customerId);
    if (!customer) {
        throw new NotFoundError('Customer');
    }
    if (customer.status !== 'active') {
        throw new BusinessRuleError(`Customer is ${customer.status} — collections cannot be recorded`, 'CUSTOMER_NOT_ACTIVE');
    }
    return { id: customerId, full_name: customer.full_name };
}
/** Regular submissions require an ACTIVE route assignment (spec §14.1). */
async function assertActiveAssignment(client, agentId, customerId) {
    const result = await client.query(`SELECT 1
       FROM agent_customer_assignment
      WHERE agent_id = $1 AND customer_id = $2 AND is_active
        AND (effective_to IS NULL OR effective_to >= CURRENT_DATE)
      LIMIT 1`, [agentId, customerId]);
    if (result.rowCount === 0) {
        throw new BusinessRuleError('Customer is not assigned to this agent', 'CUSTOMER_NOT_ASSIGNED');
    }
}
/**
 * Maps the submitted product account to the matching collection_entry FK column.
 * productType must match the provided field (already enforced by the schema
 * superRefine); a `penalty` entry attaches to exactly one underlying account.
 */
function pickAccountField(productType, value) {
    if (productType === 'savingsDeposit') {
        return { column: 'savings_account_id', id: value.savingsAccountId };
    }
    if (productType === 'recurringDeposit') {
        return { column: 'rd_account_id', id: value.rdAccountId };
    }
    if (productType === 'loan') {
        return { column: 'loan_id', id: value.loanId };
    }
    const present = [];
    if (value.savingsAccountId)
        present.push(['savings_account_id', value.savingsAccountId]);
    if (value.rdAccountId)
        present.push(['rd_account_id', value.rdAccountId]);
    if (value.loanId)
        present.push(['loan_id', value.loanId]);
    if (present.length !== 1) {
        throw new BadRequestError('A penalty entry must attach to exactly one product account');
    }
    return { column: present[0][0], id: present[0][1] };
}
/**
 * Resolves the account number + product label for the collection receipt and
 * enforces account ownership (customer_id) and collectability status.
 */
async function resolveAccountTarget(client, column, accountId, customerId) {
    if (column === 'savings_account_id') {
        const result = await client.query(`SELECT sa.account_number, dp.name AS product_label, sa.status
         FROM savings_account sa
         JOIN deposit_product dp ON dp.id = sa.product_id
        WHERE sa.id = $1 AND sa.customer_id = $2`, [accountId, customerId]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Savings account');
        if (row.status !== 'active') {
            throw new BusinessRuleError(`Savings account is ${row.status} — deposits are not accepted`, 'ACCOUNT_NOT_COLLECTABLE');
        }
        return { accountNumber: row.account_number, productLabel: row.product_label };
    }
    if (column === 'rd_account_id') {
        const result = await client.query(`SELECT ra.account_number, rs.name AS product_label, ra.status
         FROM rd_account ra
         JOIN rd_scheme rs ON rs.id = ra.scheme_id
        WHERE ra.id = $1 AND ra.customer_id = $2`, [accountId, customerId]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Recurring deposit account');
        if (row.status !== 'active' && row.status !== 'overdue') {
            throw new BusinessRuleError(`Recurring deposit account is ${row.status} — instalments are not accepted`, 'ACCOUNT_NOT_COLLECTABLE');
        }
        return { accountNumber: row.account_number, productLabel: row.product_label };
    }
    const result = await client.query(`SELECT l.loan_number AS account_number, lp.name AS product_label, l.status
       FROM loan l
       JOIN loan_product lp ON lp.id = l.product_id
      WHERE l.id = $1 AND l.customer_id = $2`, [accountId, customerId]);
    const row = result.rows[0];
    if (!row)
        throw new NotFoundError('Loan');
    if (row.status !== 'active' && row.status !== 'overdue') {
        throw new BusinessRuleError(`Loan is ${row.status} — repayments are not accepted`, 'ACCOUNT_NOT_COLLECTABLE');
    }
    return { accountNumber: row.account_number, productLabel: row.product_label };
}
/**
 * Inserts the collection_entry + its mandatory receipt atomically (spec §14.3).
 * MUST run inside the caller's transaction; the receipt number is allocated
 * from the central sequences inside the same transaction so allocation and
 * record commit or roll back together. Receipts are never updated afterwards.
 */
async function insertCollectionEntry(client, p) {
    const entry = await client.query(`INSERT INTO collection_entry
       (idempotency_key, agent_id, customer_id, product_type, ${p.accountColumn},
        amount, mode, status, is_partial, is_advance, instrument_ref, instrument_date,
        business_date, collected_at, submitted_from_offline, offline_late,
        device_id, visit_log_id, submitted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, now())
     RETURNING id`, [
        p.idempotencyKey,
        p.agentId,
        p.customerId,
        p.productType,
        p.accountId,
        p.amount,
        p.mode,
        p.status,
        p.isPartial,
        p.isAdvance,
        p.instrumentRef,
        p.instrumentDate,
        p.businessDate,
        p.collectedAt,
        p.submittedFromOffline,
        p.offlineLate,
        p.deviceId,
        p.visitLogId,
    ]);
    const row = entry.rows[0];
    const sequence = await allocateSequence(client, p.receiptKind === 'monthly' ? 'receipt_monthly' : 'receipt_daily');
    await client.query(`INSERT INTO collection_receipt
       (collection_id, receipt_number, receipt_kind, agent_code, customer_name,
        account_number, product_label, amount, mode, instrument_ref, acknowledged)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
        row.id,
        sequence.formatted,
        p.receiptKind,
        p.agentCode,
        p.customerName,
        p.accountNumber,
        p.productLabel,
        p.amount,
        p.mode,
        p.instrumentRef,
        p.acknowledged,
    ]);
    return row;
}
// ---------------------------------------------------------------------------
// Push path: submit collection (POST /collections) — agent mobile
// ---------------------------------------------------------------------------
export async function submitCollection(actor, input, idempotencyKey, meta = {}) {
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    // Idempotent replay — returns the ORIGINAL result BEFORE the deadline gate so
    // retries always succeed (spec §20.3.2), mirroring agents.submitDayClose.
    const replay = await lookupCollectionReplay(agent.id, idempotencyKey);
    if (replay) {
        const submission = await loadSubmissionReplay(agent.id, replay);
        return { created: false, submission };
    }
    if (isPastIstDeadline(SUBMISSION_DEADLINE_HOUR)) {
        throw new DeadlineExceededError(`Collections must be submitted before ${SUBMISSION_DEADLINE_HOUR}:00 IST`);
    }
    const businessDate = input.businessDate ?? istBusinessDate();
    try {
        return await transaction(async (client) => {
            const customer = await assertCollectibleCustomer(client, input.customerId);
            await assertActiveAssignment(client, agent.id, input.customerId);
            const account = pickAccountField(input.productType, input);
            const target = await resolveAccountTarget(client, account.column, account.id, input.customerId);
            const created = await insertCollectionEntry(client, {
                idempotencyKey,
                agentId: agent.id,
                agentCode: agent.agent_code,
                customerId: input.customerId,
                customerName: customer.full_name,
                productType: input.productType,
                accountColumn: account.column,
                accountId: account.id,
                accountNumber: target.accountNumber,
                productLabel: target.productLabel,
                amount: input.amount,
                mode: input.mode,
                status: 'waiting',
                isPartial: input.isPartial,
                isAdvance: input.isAdvance,
                instrumentRef: input.instrumentRef ?? null,
                instrumentDate: input.instrumentDate ?? null,
                businessDate,
                collectedAt: input.collectedAt ? new Date(input.collectedAt) : null,
                submittedFromOffline: input.submittedFromOffline,
                offlineLate: input.submittedFromOffline
                    ? evaluateOfflineLate(businessDate, input.collectedAt ?? null)
                    : false,
                visitLogId: input.visitLogId ?? null,
                deviceId: actor.deviceId,
                acknowledged: input.acknowledged,
                receiptKind: input.receiptKind,
            });
            const submissionRow = await selectCollectionById(client, created.id, agent.id);
            if (!submissionRow)
                throw new NotFoundError('Collection');
            await audit(client, {
                ...actorAuditBase(actor),
                requestId: meta.requestId ?? null,
                action: AUDIT_ACTIONS.COLLECTION_SUBMITTED,
                entityType: 'collection_entry',
                entityId: created.id,
                businessDate,
                metadata: {
                    agentId: agent.id,
                    agentCode: agent.agent_code,
                    customerId: input.customerId,
                    productType: input.productType,
                    amount: input.amount,
                    mode: input.mode,
                    submittedFromOffline: input.submittedFromOffline,
                    offlineLate: submissionRow.offline_late,
                },
            });
            return { created: true, submission: toSubmissionView(submissionRow) };
        });
    }
    catch (error) {
        // Concurrent duplicate of the same idempotency key — the winning insert
        // committed; return its original response instead of failing (only safe
        // because collection_entry.idempotency_key is the sole unique constraint
        // exercised here and the receipt number comes from a serialised sequence).
        if (isUniqueViolation(error)) {
            const racedReplay = await lookupCollectionReplay(agent.id, idempotencyKey);
            if (racedReplay) {
                const submission = await loadSubmissionReplay(agent.id, racedReplay);
                return { created: false, submission };
            }
        }
        throw error;
    }
}
// ---------------------------------------------------------------------------
// Submission status (GET /collections/:id/status) — agent mobile
// ---------------------------------------------------------------------------
export async function getCollectionStatus(actor, id) {
    const agent = await resolveAgent(actor);
    // Scoped to the caller's own agent profile so ids cannot be probed across agents.
    const row = await selectCollectionById(poolForEvent(), id, agent.id);
    if (!row) {
        throw new NotFoundError('Collection');
    }
    return toSubmissionView(row);
}
// ---------------------------------------------------------------------------
// Push path: record visit (POST /visits) — agent mobile
// ---------------------------------------------------------------------------
export async function recordVisit(actor, input, idempotencyKey, meta = {}) {
    void meta;
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    const replay = await lookupVisitReplay(agent.id, idempotencyKey);
    if (replay) {
        const visit = await loadVisitReplay(agent.id, replay);
        return { created: false, visit };
    }
    try {
        return await transaction(async (client) => {
            // Visit evidence needs a real customer record; no active-customer or
            // assignment gate — a visit is observation, not money.
            const customer = await selectCustomer(client, input.customerId);
            if (!customer)
                throw new NotFoundError('Customer');
            const inserted = await client.query(`INSERT INTO visit_log
           (idempotency_key, agent_id, customer_id, visit_date, visited_at,
            outcome, remark, photos)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`, [
                idempotencyKey,
                agent.id,
                input.customerId,
                input.visitDate,
                input.visitedAt ? new Date(input.visitedAt) : null,
                input.outcome,
                input.remark ?? null,
                input.photos && input.photos.length > 0 ? JSON.stringify(input.photos) : null,
            ]);
            const row = inserted.rows[0];
            // No AUDIT_ACTIONS key exists for visits (evidence log, not a decision).
            const visitRow = await selectVisitById(client, row.id, agent.id);
            if (!visitRow)
                throw new NotFoundError('Visit');
            return { created: true, visit: toVisitView(visitRow) };
        });
    }
    catch (error) {
        if (isUniqueViolation(error)) {
            const racedReplay = await lookupVisitReplay(agent.id, idempotencyKey);
            if (racedReplay) {
                const visit = await loadVisitReplay(agent.id, racedReplay);
                return { created: false, visit };
            }
        }
        throw error;
    }
}
// ---------------------------------------------------------------------------
// Office read model: list (GET /collections) — collections.read
// ---------------------------------------------------------------------------
export async function listCollections(queryInput) {
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    // Soft-deleted duplicates are hidden unless explicitly requested.
    if (queryInput.isDeleted !== 'true') {
        where.push('ce.is_deleted = false');
    }
    if (queryInput.status)
        where.push(`ce.status = ${addParam(queryInput.status)}`);
    if (queryInput.agentId)
        where.push(`ce.agent_id = ${addParam(queryInput.agentId)}`);
    if (queryInput.customerId)
        where.push(`ce.customer_id = ${addParam(queryInput.customerId)}`);
    if (queryInput.productType)
        where.push(`ce.product_type = ${addParam(queryInput.productType)}`);
    if (queryInput.mode)
        where.push(`ce.mode = ${addParam(queryInput.mode)}`);
    if (queryInput.dateFrom)
        where.push(`ce.business_date >= ${addParam(queryInput.dateFrom)}`);
    if (queryInput.dateTo)
        where.push(`ce.business_date <= ${addParam(queryInput.dateTo)}`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query(`SELECT ${COLLECTION_SELECT}
       ${COLLECTION_FROM}
       ${whereSql}
      ORDER BY ce.business_date DESC, ce.submitted_at DESC
      LIMIT ${queryInput.limit} OFFSET ${queryInput.offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    return { total, items: result.rows.map(toCollectionView) };
}
// ---------------------------------------------------------------------------
// M.D. review (POST /collections/:id/review) — managing_director
// ---------------------------------------------------------------------------
export async function reviewCollection(actor, id, input, meta = {}) {
    return transaction(async (client) => {
        const row = await selectCollectionById(client, id);
        if (!row)
            throw new NotFoundError('Collection');
        if (row.is_deleted) {
            throw new ConflictError('Collection has been deleted', 'COLLECTION_DELETED');
        }
        // A decision is final once accepted or rejected; re-review is only allowed
        // while the entry still awaits a decision (incl. requiresReview follow-ups).
        if (row.status !== 'waiting' && row.status !== 'requiresReview') {
            throw new ConflictError(`Collection is already ${row.status} — it cannot be reviewed again`, 'ALREADY_REVIEWED');
        }
        await client.query(`UPDATE collection_entry
          SET status = $2, updated_at = now()
        WHERE id = $1`, [id, input.decision]);
        // collection_review.collection_id is UNIQUE — a follow-up review replaces
        // the earlier requiresReview record.
        await client.query(`INSERT INTO collection_review (collection_id, reviewed_by, decision, remarks)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (collection_id)
       DO UPDATE SET decision = EXCLUDED.decision,
                     remarks = EXCLUDED.remarks,
                     reviewed_by = EXCLUDED.reviewed_by,
                     reviewed_at = now()`, [id, actor.staffId, input.decision, input.remarks ?? null]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.COLLECTION_REVIEWED,
            entityType: 'collection_entry',
            entityId: id,
            businessDate: row.business_date,
            metadata: {
                decision: input.decision,
                previousStatus: row.status,
                remarks: input.remarks ?? null,
                customerId: row.customer_id,
                agentId: row.agent_id,
            },
        });
        const updated = await selectCollectionById(client, id);
        if (!updated)
            throw new NotFoundError('Collection');
        return toCollectionView(updated);
    });
}
// ---------------------------------------------------------------------------
// Dispute reversal (POST /collections/:id/reverse) — managing_director
// ---------------------------------------------------------------------------
export async function reverseCollection(actor, id, input, meta = {}) {
    return transaction(async (client) => {
        const row = await selectCollectionById(client, id);
        if (!row)
            throw new NotFoundError('Collection');
        if (row.is_deleted) {
            throw new ConflictError('Collection has been deleted', 'COLLECTION_DELETED');
        }
        // Only accepted money can be reversed; an un-accepted wrong entry is either
        // corrected via review (rejected) or removed as a duplicate.
        if (row.status !== 'accepted') {
            throw new BusinessRuleError(`Only an accepted collection can be reversed (current status: ${row.status})`, 'COLLECTION_NOT_REVERSIBLE');
        }
        const existing = await client.query(`SELECT id FROM collection_reversal WHERE original_collection_id = $1 LIMIT 1`, [id]);
        if (existing.rows[0]) {
            throw new ConflictError('Collection has already been reversed', 'COLLECTION_ALREADY_REVERSED');
        }
        // A dispute resolves as reversal + corrected NEW entry — never a direct edit
        // of the original (spec §14.5). The corrected entry is created through the
        // full entry + receipt path (its own fresh receipt number), linked back via
        // collection_reversal.replacement_collection_id.
        let replacementId = null;
        let replacementView = null;
        if (input.replacement) {
            const repl = input.replacement;
            const customer = await assertCollectibleCustomer(client, repl.customerId);
            const account = pickAccountField(repl.productType, repl);
            const target = await resolveAccountTarget(client, account.column, account.id, repl.customerId);
            const created = await insertCollectionEntry(client, {
                // Server-generated key — the replacement travels in the reversal body,
                // not through the Idempotency-Key header.
                idempotencyKey: `reversal-${randomUUID()}`,
                agentId: row.agent_id,
                agentCode: row.agent_code,
                customerId: repl.customerId,
                customerName: customer.full_name,
                productType: repl.productType,
                accountColumn: account.column,
                accountId: account.id,
                accountNumber: target.accountNumber,
                productLabel: target.productLabel,
                amount: repl.amount,
                mode: repl.mode,
                status: 'accepted',
                isPartial: repl.isPartial,
                isAdvance: repl.isAdvance,
                instrumentRef: repl.instrumentRef ?? null,
                instrumentDate: repl.instrumentDate ?? null,
                // An office correction is dated to the original entry unless the body
                // explicitly overrides the business date.
                businessDate: repl.businessDate ?? row.business_date,
                collectedAt: repl.collectedAt ? new Date(repl.collectedAt) : null,
                submittedFromOffline: false,
                offlineLate: false,
                visitLogId: repl.visitLogId ?? null,
                deviceId: null,
                acknowledged: repl.acknowledged,
                receiptKind: repl.receiptKind,
            });
            replacementId = created.id;
            const replacementRow = await selectCollectionById(client, created.id);
            if (replacementRow)
                replacementView = toSubmissionView(replacementRow);
        }
        const reversal = await client.query(`INSERT INTO collection_reversal
         (original_collection_id, replacement_collection_id, reason, proof_of_record,
          customer_notified, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`, [
            id,
            replacementId,
            input.reason,
            input.proofOfRecord ? JSON.stringify(input.proofOfRecord) : null,
            input.customerNotified,
            actor.staffId,
        ]);
        const reversalRow = reversal.rows[0];
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.COLLECTION_REVERSED,
            entityType: 'collection_entry',
            entityId: id,
            businessDate: row.business_date,
            metadata: {
                replacementCollectionId: replacementId,
                reason: input.reason,
                customerNotified: input.customerNotified,
                customerId: row.customer_id,
                agentId: row.agent_id,
            },
        });
        return {
            id: reversalRow.id,
            originalCollectionId: id,
            replacementCollectionId: replacementId,
            reason: input.reason,
            customerNotified: input.customerNotified,
            createdAt: reversalRow.created_at.toISOString(),
            replacement: replacementView,
        };
    });
}
// ---------------------------------------------------------------------------
// Duplicate deletion (POST /collections/:id/delete-duplicate) — M.D. / manager
// ---------------------------------------------------------------------------
export async function deleteDuplicateCollection(actor, id, input, meta = {}) {
    return transaction(async (client) => {
        const row = await selectCollectionById(client, id);
        if (!row)
            throw new NotFoundError('Collection');
        if (row.is_deleted) {
            throw new ConflictError('Collection is already deleted', 'COLLECTION_ALREADY_DELETED');
        }
        // Accepted money has reached the ledger — it is corrected by reversal, not
        // deleted. Only un-accepted duplicates are removable.
        if (row.status === 'accepted') {
            throw new BusinessRuleError('An accepted collection must be reversed, not deleted as a duplicate', 'ACCEPTED_COLLECTION_NOT_DELETABLE');
        }
        // Soft delete on the entry only — collection_receipt is append-only and its
        // number stays reserved for the audit trail (spec §14.5, §4).
        await client.query(`UPDATE collection_entry
          SET is_deleted = true,
              deleted_by = $2,
              deleted_at = now(),
              deletion_reason = $3,
              updated_at = now()
        WHERE id = $1`, [id, actor.staffId, input.reason]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.COLLECTION_DUPLICATE_DELETED,
            entityType: 'collection_entry',
            entityId: id,
            businessDate: row.business_date,
            metadata: {
                reason: input.reason,
                customerId: row.customer_id,
                agentId: row.agent_id,
                amount: row.amount,
            },
        });
        const updated = await selectCollectionById(client, id);
        if (!updated)
            throw new NotFoundError('Collection');
        return toCollectionView(updated);
    });
}
// ---------------------------------------------------------------------------
// Short-payment allocation (POST /collections/:id/allocate) — managing_director
// ---------------------------------------------------------------------------
export async function allocateShortPayment(actor, id, input, meta = {}) {
    return transaction(async (client) => {
        const row = await selectCollectionById(client, id);
        if (!row)
            throw new NotFoundError('Collection');
        if (row.is_deleted) {
            throw new ConflictError('Collection has been deleted', 'COLLECTION_DELETED');
        }
        if (row.status === 'rejected') {
            throw new BusinessRuleError('A rejected collection cannot be allocated', 'COLLECTION_NOT_ALLOCATABLE');
        }
        const existing = await client.query(`SELECT id FROM short_payment_allocation WHERE collection_id = $1 LIMIT 1`, [id]);
        if (existing.rows[0]) {
            throw new ConflictError('Allocation has already been decided', 'ALLOCATION_ALREADY_DECIDED');
        }
        const allocation = {
            entries: input.allocation,
            note: input.note ?? null,
            decidedBy: actor.staffCode,
        };
        await client.query(`UPDATE collection_entry
          SET allocation = $2::jsonb, updated_at = now()
        WHERE id = $1`, [id, JSON.stringify(allocation)]);
        await client.query(`INSERT INTO short_payment_allocation (collection_id, allocation, decided_by)
       VALUES ($1, $2::jsonb, $3)`, [id, JSON.stringify(allocation), actor.staffId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.COLLECTION_ALLOCATION_DECIDED,
            entityType: 'collection_entry',
            entityId: id,
            businessDate: row.business_date,
            metadata: {
                allocation: input.allocation,
                note: input.note ?? null,
                customerId: row.customer_id,
                agentId: row.agent_id,
            },
        });
        const updated = await selectCollectionById(client, id);
        if (!updated)
            throw new NotFoundError('Collection');
        return toCollectionView(updated);
    });
}
// ---------------------------------------------------------------------------
// Emergency approval (POST /collections/emergency-approval) — managing_director
// ---------------------------------------------------------------------------
export async function approveEmergencyCollection(actor, input, meta = {}) {
    return transaction(async (client) => {
        // The collecting agent is identified explicitly (collection_entry.agent_id is
        // NOT NULL) — the active-assignment check performed for regular submissions
        // is deliberately skipped for this unassigned-customer flow (§14.1).
        const agentResult = await client.query(`SELECT id, agent_code, status FROM agent WHERE id = $1 LIMIT 1`, [input.agentId]);
        const agentRow = agentResult.rows[0];
        if (!agentRow)
            throw new NotFoundError('Agent');
        if (agentRow.status !== 'active') {
            throw new BusinessRuleError(`Agent is ${agentRow.status} — collections are unavailable`, 'AGENT_NOT_ACTIVE');
        }
        const customer = await assertCollectibleCustomer(client, input.customerId);
        const account = pickAccountField(input.productType, input);
        const target = await resolveAccountTarget(client, account.column, account.id, input.customerId);
        const businessDate = input.businessDate ?? istBusinessDate();
        const created = await insertCollectionEntry(client, {
            // Server-generated key — approved directly by the M.D., never a client push.
            idempotencyKey: `emergency-${randomUUID()}`,
            agentId: agentRow.id,
            agentCode: agentRow.agent_code,
            customerId: input.customerId,
            customerName: customer.full_name,
            productType: input.productType,
            accountColumn: account.column,
            accountId: account.id,
            accountNumber: target.accountNumber,
            productLabel: target.productLabel,
            amount: input.amount,
            mode: input.mode,
            // The M.D. approves the entry, so it is created directly in accepted state.
            status: 'accepted',
            isPartial: input.isPartial,
            isAdvance: input.isAdvance,
            instrumentRef: input.instrumentRef ?? null,
            instrumentDate: input.instrumentDate ?? null,
            businessDate,
            collectedAt: input.collectedAt ? new Date(input.collectedAt) : null,
            submittedFromOffline: false,
            offlineLate: false,
            visitLogId: null,
            deviceId: null,
            acknowledged: input.acknowledged,
            receiptKind: input.receiptKind,
        });
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.COLLECTION_SUBMITTED,
            entityType: 'collection_entry',
            entityId: created.id,
            businessDate,
            metadata: {
                emergencyApproval: true,
                agentId: agentRow.id,
                agentCode: agentRow.agent_code,
                customerId: input.customerId,
                productType: input.productType,
                amount: input.amount,
                mode: input.mode,
                remark: input.remark ?? null,
                status: 'accepted',
            },
        });
        const createdRow = await selectCollectionById(client, created.id);
        if (!createdRow)
            throw new NotFoundError('Collection');
        return toCollectionView(createdRow);
    });
}
// ---------------------------------------------------------------------------
// Total-amount report (GET /reports/collection-totals) — collections.read
// ---------------------------------------------------------------------------
export async function getCollectionTotals(actor, queryInput, meta = {}) {
    const dateFrom = queryInput.dateFrom ?? istBusinessDate();
    const dateTo = queryInput.dateTo ?? istBusinessDate();
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    where.push('ce.is_deleted = false');
    // Only booked (accepted) and awaiting-decision (waiting) money counts; a
    // reversed original is excluded so its replacement (if any) is the only
    // accepted record counted (reconciliation §16 nets the ledger).
    where.push(`ce.status IN ('accepted', 'waiting')`);
    where.push(`NOT EXISTS (SELECT 1 FROM collection_reversal crv WHERE crv.original_collection_id = ce.id)`);
    where.push(`ce.business_date >= ${addParam(dateFrom)}`);
    where.push(`ce.business_date <= ${addParam(dateTo)}`);
    if (queryInput.agentId)
        where.push(`ce.agent_id = ${addParam(queryInput.agentId)}`);
    if (queryInput.customerId)
        where.push(`ce.customer_id = ${addParam(queryInput.customerId)}`);
    if (queryInput.productType)
        where.push(`ce.product_type = ${addParam(queryInput.productType)}`);
    if (queryInput.mode)
        where.push(`ce.mode = ${addParam(queryInput.mode)}`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const totalResult = await query(`SELECT COALESCE(SUM(ce.amount), 0)::text AS total_amount,
            COUNT(*)::int AS total_count
       FROM collection_entry ce
       ${whereSql}`, params);
    const totalRow = totalResult.rows[0];
    const productResult = await query(`SELECT ce.product_type AS key,
            COALESCE(SUM(ce.amount), 0)::text AS amount,
            COUNT(*)::int AS count
       FROM collection_entry ce
       ${whereSql}
      GROUP BY ce.product_type
      ORDER BY ce.product_type`, params);
    const modeResult = await query(`SELECT ce.mode AS key,
            COALESCE(SUM(ce.amount), 0)::text AS amount,
            COUNT(*)::int AS count
       FROM collection_entry ce
       ${whereSql}
      GROUP BY ce.mode
      ORDER BY ce.mode`, params);
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.REPORT_GENERATED,
        entityType: 'collection_report',
        businessDate: istBusinessDate(),
        metadata: {
            report: 'collection-totals',
            dateFrom,
            dateTo,
            totalAmount: totalRow.total_amount,
            totalCount: totalRow.total_count,
        },
    });
    return {
        dateFrom,
        dateTo,
        totalAmount: totalRow.total_amount,
        totalCount: totalRow.total_count,
        byProductType: productResult.rows,
        byMode: modeResult.rows,
    };
}
