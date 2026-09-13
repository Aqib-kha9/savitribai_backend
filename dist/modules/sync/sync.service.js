import { query, transaction } from '../../database/client.js';
import { env } from '../../config/env.js';
import { appendAuditEvent, AUDIT_ACTIONS } from '../../audit/audit-writer.js';
import { daysBetween, istBusinessDate, isValidDateString } from '../../core/time.js';
import { BusinessRuleError, ValidationError } from '../../core/errors.js';
/**
 * Offline sync & mobile support service (docs/backend-master-spec.md §20).
 *
 * The spec's sync protocol is cross-cutting: the push endpoints (`POST
 * /collections`, `POST /visits`) are owned by the collections module and the
 * pull read model (`GET /agents/me/assignments`) by the agents module. This
 * module therefore hosts the SHARED protocol infrastructure those modules
 * reuse — idempotency-key replay lookups, offline-limit enforcement, and
 * conflict escalation — plus the agent-facing submission-status surface
 * (§20.3.6: an agent sees status only — waiting / accepted / rejected /
 * requiresReview — never office decision details).
 *
 * The server remains authoritative for financial state (§20.2); nothing here
 * mutates a financial record and replays never silently overwrite a decision.
 */
// Server-side offline ceiling (env OFFLINE_LIMIT_HOURS, default 36). The app
// warns at its own 1-day limit (spec §20.1) but the server is authoritative.
export const OFFLINE_LIMIT_HOURS = env.offlineLimitHours;
// ---------------------------------------------------------------------------
// Local helpers (mirror identity.service conventions)
// ---------------------------------------------------------------------------
/**
 * Local audit writer: every conflict escalation commits in the SAME
 * transaction as the mutation it describes (spec §6.3 financial integrity
 * gate). `businessDate` defaults to the current IST business date.
 */
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
const iso = (value) => (value ? value.toISOString() : null);
/**
 * Resolves the agent profile bound to the authenticated staff account.
 * `agent.staff_id` is UNIQUE — every collection agent has exactly one profile.
 */
async function resolveAgent(actor) {
    const result = await query(`SELECT id, agent_code, status FROM agent WHERE staff_id = $1 LIMIT 1`, [actor.staffId]);
    const row = result.rows[0];
    if (!row) {
        throw new BusinessRuleError('No agent profile is linked to this account — contact the managing director', 'AGENT_PROFILE_REQUIRED');
    }
    return row;
}
/**
 * Returns the original response for an already-processed collection
 * submission, scoped to the acting agent so keys cannot be probed across
 * agents. `null` means the key is unknown — the caller may proceed to insert.
 */
export async function lookupCollectionReplay(agentId, idempotencyKey) {
    const result = await query(`SELECT ce.id, ce.idempotency_key, ce.status, ce.is_deleted, ce.customer_id, ce.amount,
            ce.mode, ce.business_date, cr.receipt_number
       FROM collection_entry ce
       LEFT JOIN collection_receipt cr ON cr.collection_id = ce.id
      WHERE ce.idempotency_key = $1 AND ce.agent_id = $2
      LIMIT 1`, [idempotencyKey, agentId]);
    const row = result.rows[0];
    if (!row)
        return null;
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        status: row.status,
        isDeleted: row.is_deleted,
        customerId: row.customer_id,
        amount: row.amount,
        mode: row.mode,
        businessDate: row.business_date,
        receiptNumber: row.receipt_number,
    };
}
/** Original-response lookup for an already-processed visit submission. */
export async function lookupVisitReplay(agentId, idempotencyKey) {
    const result = await query(`SELECT id, idempotency_key, customer_id, visit_date, visited_at, outcome, remark
       FROM visit_log
      WHERE idempotency_key = $1 AND agent_id = $2
      LIMIT 1`, [idempotencyKey, agentId]);
    const row = result.rows[0];
    if (!row)
        return null;
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        customerId: row.customer_id,
        visitDate: row.visit_date,
        visitedAt: iso(row.visited_at),
        outcome: row.outcome,
        remark: row.remark,
    };
}
// ---------------------------------------------------------------------------
// Offline-limit enforcement (§20.3.4) — server is authoritative
// ---------------------------------------------------------------------------
/**
 * Flags whether an offline capture is "late" under spec §20.3.4 (entries older
 * than one day un-uploaded are flagged; the server ceiling is the env
 * OFFLINE_LIMIT_HOURS). When an exact capture timestamp is available it is
 * compared directly against the offline ceiling; otherwise the entry's
 * business date is compared to the server's current IST business date.
 */
export function evaluateOfflineLate(businessDate, capturedAt = null, submittedAt = new Date()) {
    if (capturedAt) {
        const captured = typeof capturedAt === 'string' ? new Date(capturedAt) : capturedAt;
        if (!Number.isNaN(captured.getTime())) {
            const ageHours = (submittedAt.getTime() - captured.getTime()) / 3_600_000;
            return ageHours > OFFLINE_LIMIT_HOURS;
        }
    }
    return daysBetween(businessDate, istBusinessDate(submittedAt)) > 1;
}
const SUBMISSION_SELECT = `ce.id, ce.idempotency_key, ce.customer_id, c.full_name AS customer_name,
      ce.product_type, ce.amount, ce.mode, ce.status, ce.is_partial, ce.is_advance,
      ce.business_date, ce.collected_at, ce.submitted_at, ce.submitted_from_offline,
      ce.offline_late, ce.created_at, count(*) OVER()::int AS total`;
function toSubmissionStatusView(row) {
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        customerId: row.customer_id,
        customerName: row.customer_name,
        productType: row.product_type,
        amount: row.amount,
        mode: row.mode,
        status: row.status,
        isPartial: row.is_partial,
        isAdvance: row.is_advance,
        businessDate: row.business_date,
        collectedAt: iso(row.collected_at),
        submittedAt: iso(row.submitted_at),
        submittedFromOffline: row.submitted_from_offline,
        offlineLate: row.offline_late,
        createdAt: row.created_at.toISOString(),
    };
}
/**
 * Lists the authenticated agent's submitted collections (status only —
 * §20.3.6). Deleted entries are never shown and the scope is always the
 * caller's own agent profile.
 */
export async function listMySubmissions(actor, queryInput, meta = {}) {
    void meta;
    const agent = await resolveAgent(actor);
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    where.push(`ce.agent_id = ${addParam(agent.id)}`);
    where.push(`ce.is_deleted = false`);
    if (queryInput.status)
        where.push(`ce.status = ${addParam(queryInput.status)}`);
    if (queryInput.productType)
        where.push(`ce.product_type = ${addParam(queryInput.productType)}`);
    if (queryInput.mode)
        where.push(`ce.mode = ${addParam(queryInput.mode)}`);
    if (queryInput.businessDate)
        where.push(`ce.business_date = ${addParam(queryInput.businessDate)}`);
    if (queryInput.fromDate)
        where.push(`ce.business_date >= ${addParam(queryInput.fromDate)}`);
    if (queryInput.toDate)
        where.push(`ce.business_date <= ${addParam(queryInput.toDate)}`);
    if (queryInput.offlineLate === 'true')
        where.push(`ce.offline_late = true`);
    if (queryInput.offlineLate === 'false')
        where.push(`ce.offline_late = false`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`SELECT ${SUBMISSION_SELECT}
       FROM collection_entry ce
       JOIN customer c ON c.id = ce.customer_id
       ${whereSql}
      ORDER BY ce.business_date DESC, ce.submitted_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map(toSubmissionStatusView);
    return { total, items };
}
function toVisitStatusView(row) {
    return {
        id: row.id,
        idempotencyKey: row.idempotency_key,
        customerId: row.customer_id,
        customerName: row.customer_name,
        visitDate: row.visit_date,
        visitedAt: iso(row.visited_at),
        outcome: row.outcome,
        remark: row.remark,
        createdAt: row.created_at.toISOString(),
    };
}
/** Lists the authenticated agent's recorded visits (§20.3.6). */
export async function listMyVisits(actor, queryInput, meta = {}) {
    void meta;
    const agent = await resolveAgent(actor);
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    where.push(`v.agent_id = ${addParam(agent.id)}`);
    if (queryInput.outcome)
        where.push(`v.outcome = ${addParam(queryInput.outcome)}`);
    if (queryInput.visitDate)
        where.push(`v.visit_date = ${addParam(queryInput.visitDate)}`);
    if (queryInput.fromDate)
        where.push(`v.visit_date >= ${addParam(queryInput.fromDate)}`);
    if (queryInput.toDate)
        where.push(`v.visit_date <= ${addParam(queryInput.toDate)}`);
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`SELECT v.id, v.idempotency_key, v.customer_id, c.full_name AS customer_name,
            v.visit_date, v.visited_at, v.outcome, v.remark, v.created_at,
            count(*) OVER()::int AS total
       FROM visit_log v
       JOIN customer c ON c.id = v.customer_id
       ${whereSql}
      ORDER BY v.visit_date DESC, v.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map(toVisitStatusView);
    return { total, items };
}
/** Aggregated submission status counts for the authenticated agent. */
export async function getSyncStatus(actor, meta = {}) {
    void meta;
    const agent = await resolveAgent(actor);
    const result = await query(`SELECT count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
            count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'requiresReview')::int AS requires_review,
            count(*) FILTER (WHERE offline_late)::int AS offline_late,
            max(submitted_at) AS last_submitted_at
       FROM collection_entry
      WHERE agent_id = $1 AND is_deleted = false`, [agent.id]);
    const row = result.rows[0];
    if (!row) {
        throw new BusinessRuleError('No submission summary could be computed', 'SYNC_SUMMARY_FAILED');
    }
    const waiting = row.waiting;
    const accepted = row.accepted;
    const rejected = row.rejected;
    const requiresReview = row.requires_review;
    return {
        agentId: agent.id,
        agentCode: agent.agent_code,
        asOf: new Date().toISOString(),
        submissions: {
            waiting,
            accepted,
            rejected,
            requiresReview,
            total: waiting + accepted + rejected + requiresReview,
        },
        offlineLate: row.offline_late,
        lastSubmittedAt: iso(row.last_submitted_at),
    };
}
// ---------------------------------------------------------------------------
// Conflict escalation (§20.3.3) — server never silently overwrites
// ---------------------------------------------------------------------------
/**
 * Resolves the office record id for an escalated entity. Only the owning agent
 * may escalate (idempotency keys cannot be probed across agents). Soft-deleted
 * records are still matched: the office decision exists and the President may
 * need to resolve the remaining device draft against it.
 */
async function findEntityIdByKey(entityType, agentId, idempotencyKey) {
    const table = entityType === 'collection_entry' ? 'collection_entry' : 'visit_log';
    const result = await query(`SELECT id FROM ${table} WHERE idempotency_key = $1 AND agent_id = $2 LIMIT 1`, [idempotencyKey, agentId]);
    return result.rows[0]?.id ?? null;
}
/**
 * Records a device-initiated conflict escalation (§20.3.3). When the device
 * still holds a draft whose content differs from the latest office decision it
 * received (matching idempotency key), it reports the conflict here instead of
 * silently overwriting. The escalation is written as a `sync.conflict.escalated`
 * audit event (append-only, §21); the President/M.D. decides the correct
 * version through the office surface.
 */
export async function reportConflict(actor, input, meta = {}) {
    const agent = await resolveAgent(actor);
    // A true conflict requires an office record with the same key. If the key is
    // unknown server-side, the office has never decided — nothing to resolve yet.
    const entityId = await findEntityIdByKey(input.entityType, agent.id, input.idempotencyKey);
    if (!entityId) {
        throw new BusinessRuleError('No office record matches this idempotency key — nothing to escalate yet', 'CONFLICT_NO_OFFICE_RECORD');
    }
    const metadata = {
        idempotencyKey: input.idempotencyKey,
        summary: input.summary,
        agentId: agent.id,
        agentCode: agent.agent_code,
    };
    if (input.reason)
        metadata.reason = input.reason;
    if (input.deviceSnapshot !== undefined)
        metadata.deviceSnapshot = input.deviceSnapshot;
    if (input.officeSnapshot !== undefined)
        metadata.officeSnapshot = input.officeSnapshot;
    await transaction(async (client) => {
        await audit(client, {
            ...actorAuditBase(actor),
            action: AUDIT_ACTIONS.SYNC_CONFLICT_ESCALATED,
            entityType: input.entityType,
            entityId,
            requestId: meta.requestId ?? null,
            metadata,
        });
    });
    return {
        escalated: true,
        entityType: input.entityType,
        idempotencyKey: input.idempotencyKey,
        entityId,
        recordedAt: new Date().toISOString(),
    };
}
// Re-exported for convenience so consumers never hand-build these helpers.
export function assertCalendarDate(value, field) {
    if (!isValidDateString(value)) {
        throw new ValidationError(`${field} must be a valid calendar date (YYYY-MM-DD)`);
    }
}
