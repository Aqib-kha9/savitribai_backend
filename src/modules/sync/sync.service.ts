import type { PoolClient } from 'pg';
import { query, transaction } from '../../database/client.js';
import { env } from '../../config/env.js';
import { appendAuditEvent, AUDIT_ACTIONS, type AuditEventInput } from '../../audit/audit-writer.js';
import { daysBetween, istBusinessDate, isValidDateString } from '../../core/time.js';
import { BusinessRuleError, ValidationError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import type {
  CollectionProductType,
  CollectionSubmissionStatus,
  IdempotencyKey,
  ReportConflictInput,
  SyncEntityType,
  SyncSubmissionsQuery,
  SyncVisitsQuery,
  VisitOutcome,
} from './sync.schemas.js';

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
// Types
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/** Agent-facing view of a submitted collection (status only, §20.3.6). */
export interface SubmissionStatusView {
  id: string;
  idempotencyKey: string;
  customerId: string;
  customerName: string;
  productType: CollectionProductType;
  amount: string;
  mode: string;
  status: CollectionSubmissionStatus;
  isPartial: boolean;
  isAdvance: boolean;
  businessDate: string;
  collectedAt: string | null;
  submittedAt: string | null;
  submittedFromOffline: boolean;
  offlineLate: boolean;
  createdAt: string;
}

/** Agent-facing view of a recorded visit (§20.3.6). */
export interface VisitStatusView {
  id: string;
  idempotencyKey: string;
  customerId: string;
  customerName: string;
  visitDate: string;
  visitedAt: string | null;
  outcome: VisitOutcome;
  remark: string | null;
  createdAt: string;
}

/** Compact per-agent sync summary for the mobile sync screen. */
export interface SyncStatusView {
  agentId: string;
  agentCode: string;
  asOf: string;
  submissions: {
    waiting: number;
    accepted: number;
    rejected: number;
    requiresReview: number;
    total: number;
  };
  offlineLate: number;
  lastSubmittedAt: string | null;
}

/** Replay payload for an already-processed collection submission (§20.3.2). */
export interface SubmissionReplay {
  id: string;
  idempotencyKey: string;
  status: CollectionSubmissionStatus;
  isDeleted: boolean;
  customerId: string;
  amount: string;
  mode: string;
  businessDate: string;
  receiptNumber: string | null;
}

/** Replay payload for an already-processed visit submission (§20.3.2). */
export interface VisitReplay {
  id: string;
  idempotencyKey: string;
  customerId: string;
  visitDate: string;
  visitedAt: string | null;
  outcome: VisitOutcome;
  remark: string | null;
}

/** Receipt returned to the device after a conflict escalation (§20.3.3). */
export interface ConflictEscalationResult {
  escalated: true;
  entityType: SyncEntityType;
  idempotencyKey: string;
  /** Matching office record id, when one exists. */
  entityId: string | null;
  recordedAt: string;
}

// ---------------------------------------------------------------------------
// Local helpers (mirror identity.service conventions)
// ---------------------------------------------------------------------------

/**
 * Local audit writer: every conflict escalation commits in the SAME
 * transaction as the mutation it describes (spec §6.3 financial integrity
 * gate). `businessDate` defaults to the current IST business date.
 */
function audit(
  client: PoolClient,
  input: Pick<
    AuditEventInput,
    'action' | 'entityType' | 'source' | 'actorStaffId' | 'actorRole' | 'actorStaffCode'
  > & {
    entityId?: string | null;
    requestId?: string | null;
    businessDate?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const event: AuditEventInput = {
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
  if (input.metadata !== undefined) event.metadata = input.metadata;
  return appendAuditEvent(client, event);
}

function actorAuditBase(actor: AuthContext) {
  return {
    actorStaffId: actor.staffId,
    actorRole: actor.role,
    actorStaffCode: actor.staffCode,
    source: actor.source as AuditEventInput['source'],
    requestId: null as string | null,
  };
}

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

type AgentRefRow = {
  id: string;
  agent_code: string;
  status: 'pending' | 'active' | 'suspended' | 'deactivated' | 'locked';
};

/**
 * Resolves the agent profile bound to the authenticated staff account.
 * `agent.staff_id` is UNIQUE — every collection agent has exactly one profile.
 */
async function resolveAgent(actor: AuthContext): Promise<AgentRefRow> {
  const result = await query<AgentRefRow>(
    `SELECT id, agent_code, status FROM agent WHERE staff_id = $1 LIMIT 1`,
    [actor.staffId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new BusinessRuleError(
      'No agent profile is linked to this account — contact the managing director',
      'AGENT_PROFILE_REQUIRED',
    );
  }
  return row;
}

// ---------------------------------------------------------------------------
// Shared replay lookups (§20.3.2) — used by the collections module push paths
// ---------------------------------------------------------------------------

type SubmissionReplayRow = {
  id: string;
  idempotency_key: string;
  status: CollectionSubmissionStatus;
  is_deleted: boolean;
  customer_id: string;
  amount: string;
  mode: string;
  business_date: string;
  receipt_number: string | null;
};

/**
 * Returns the original response for an already-processed collection
 * submission, scoped to the acting agent so keys cannot be probed across
 * agents. `null` means the key is unknown — the caller may proceed to insert.
 */
export async function lookupCollectionReplay(
  agentId: string,
  idempotencyKey: IdempotencyKey,
): Promise<SubmissionReplay | null> {
  const result = await query<SubmissionReplayRow>(
    `SELECT ce.id, ce.idempotency_key, ce.status, ce.is_deleted, ce.customer_id, ce.amount,
            ce.mode, ce.business_date, cr.receipt_number
       FROM collection_entry ce
       LEFT JOIN collection_receipt cr ON cr.collection_id = ce.id
      WHERE ce.idempotency_key = $1 AND ce.agent_id = $2
      LIMIT 1`,
    [idempotencyKey, agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
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

type VisitReplayRow = {
  id: string;
  idempotency_key: string;
  customer_id: string;
  visit_date: string;
  visited_at: Date | null;
  outcome: VisitOutcome;
  remark: string | null;
};

/** Original-response lookup for an already-processed visit submission. */
export async function lookupVisitReplay(
  agentId: string,
  idempotencyKey: IdempotencyKey,
): Promise<VisitReplay | null> {
  const result = await query<VisitReplayRow>(
    `SELECT id, idempotency_key, customer_id, visit_date, visited_at, outcome, remark
       FROM visit_log
      WHERE idempotency_key = $1 AND agent_id = $2
      LIMIT 1`,
    [idempotencyKey, agentId],
  );
  const row = result.rows[0];
  if (!row) return null;
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
export function evaluateOfflineLate(
  businessDate: string,
  capturedAt: Date | string | null = null,
  submittedAt: Date = new Date(),
): boolean {
  if (capturedAt) {
    const captured = typeof capturedAt === 'string' ? new Date(capturedAt) : capturedAt;
    if (!Number.isNaN(captured.getTime())) {
      const ageHours = (submittedAt.getTime() - captured.getTime()) / 3_600_000;
      return ageHours > OFFLINE_LIMIT_HOURS;
    }
  }
  return daysBetween(businessDate, istBusinessDate(submittedAt)) > 1;
}

// ---------------------------------------------------------------------------
// Agent-facing submission & visit surfaces (§20.3.6)
// ---------------------------------------------------------------------------

type SubmissionListRow = {
  id: string;
  idempotency_key: string;
  customer_id: string;
  customer_name: string;
  product_type: CollectionProductType;
  amount: string;
  mode: string;
  status: CollectionSubmissionStatus;
  is_partial: boolean;
  is_advance: boolean;
  business_date: string;
  collected_at: Date | null;
  submitted_at: Date;
  submitted_from_offline: boolean;
  offline_late: boolean;
  created_at: Date;
  total?: number;
};

const SUBMISSION_SELECT = `ce.id, ce.idempotency_key, ce.customer_id, c.full_name AS customer_name,
      ce.product_type, ce.amount, ce.mode, ce.status, ce.is_partial, ce.is_advance,
      ce.business_date, ce.collected_at, ce.submitted_at, ce.submitted_from_offline,
      ce.offline_late, ce.created_at, count(*) OVER()::int AS total`;

function toSubmissionStatusView(row: SubmissionListRow): SubmissionStatusView {
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
export async function listMySubmissions(
  actor: AuthContext,
  queryInput: SyncSubmissionsQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: SubmissionStatusView[] }> {
  void meta;
  const agent = await resolveAgent(actor);

  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  where.push(`ce.agent_id = ${addParam(agent.id)}`);
  where.push(`ce.is_deleted = false`);

  if (queryInput.status) where.push(`ce.status = ${addParam(queryInput.status)}`);
  if (queryInput.productType) where.push(`ce.product_type = ${addParam(queryInput.productType)}`);
  if (queryInput.mode) where.push(`ce.mode = ${addParam(queryInput.mode)}`);
  if (queryInput.businessDate) where.push(`ce.business_date = ${addParam(queryInput.businessDate)}`);
  if (queryInput.fromDate) where.push(`ce.business_date >= ${addParam(queryInput.fromDate)}`);
  if (queryInput.toDate) where.push(`ce.business_date <= ${addParam(queryInput.toDate)}`);
  if (queryInput.offlineLate === 'true') where.push(`ce.offline_late = true`);
  if (queryInput.offlineLate === 'false') where.push(`ce.offline_late = false`);

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<SubmissionListRow>(
    `SELECT ${SUBMISSION_SELECT}
       FROM collection_entry ce
       JOIN customer c ON c.id = ce.customer_id
       ${whereSql}
      ORDER BY ce.business_date DESC, ce.submitted_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map(toSubmissionStatusView);
  return { total, items };
}

type VisitListRow = {
  id: string;
  idempotency_key: string;
  customer_id: string;
  customer_name: string;
  visit_date: string;
  visited_at: Date | null;
  outcome: VisitOutcome;
  remark: string | null;
  created_at: Date;
  total?: number;
};

function toVisitStatusView(row: VisitListRow): VisitStatusView {
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
export async function listMyVisits(
  actor: AuthContext,
  queryInput: SyncVisitsQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: VisitStatusView[] }> {
  void meta;
  const agent = await resolveAgent(actor);

  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  where.push(`v.agent_id = ${addParam(agent.id)}`);

  if (queryInput.outcome) where.push(`v.outcome = ${addParam(queryInput.outcome)}`);
  if (queryInput.visitDate) where.push(`v.visit_date = ${addParam(queryInput.visitDate)}`);
  if (queryInput.fromDate) where.push(`v.visit_date >= ${addParam(queryInput.fromDate)}`);
  if (queryInput.toDate) where.push(`v.visit_date <= ${addParam(queryInput.toDate)}`);

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<VisitListRow>(
    `SELECT v.id, v.idempotency_key, v.customer_id, c.full_name AS customer_name,
            v.visit_date, v.visited_at, v.outcome, v.remark, v.created_at,
            count(*) OVER()::int AS total
       FROM visit_log v
       JOIN customer c ON c.id = v.customer_id
       ${whereSql}
      ORDER BY v.visit_date DESC, v.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map(toVisitStatusView);
  return { total, items };
}

/** Aggregated submission status counts for the authenticated agent. */
export async function getSyncStatus(
  actor: AuthContext,
  meta: RequestMeta = {},
): Promise<SyncStatusView> {
  void meta;
  const agent = await resolveAgent(actor);

  const result = await query<{
    waiting: number;
    accepted: number;
    rejected: number;
    requires_review: number;
    offline_late: number;
    last_submitted_at: Date | null;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'waiting')::int AS waiting,
            count(*) FILTER (WHERE status = 'accepted')::int AS accepted,
            count(*) FILTER (WHERE status = 'rejected')::int AS rejected,
            count(*) FILTER (WHERE status = 'requiresReview')::int AS requires_review,
            count(*) FILTER (WHERE offline_late)::int AS offline_late,
            max(submitted_at) AS last_submitted_at
       FROM collection_entry
      WHERE agent_id = $1 AND is_deleted = false`,
    [agent.id],
  );
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
async function findEntityIdByKey(
  entityType: SyncEntityType,
  agentId: string,
  idempotencyKey: string,
): Promise<string | null> {
  const table = entityType === 'collection_entry' ? 'collection_entry' : 'visit_log';
  const result = await query<{ id: string }>(
    `SELECT id FROM ${table} WHERE idempotency_key = $1 AND agent_id = $2 LIMIT 1`,
    [idempotencyKey, agentId],
  );
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
export async function reportConflict(
  actor: AuthContext,
  input: ReportConflictInput,
  meta: RequestMeta = {},
): Promise<ConflictEscalationResult> {
  const agent = await resolveAgent(actor);

  // A true conflict requires an office record with the same key. If the key is
  // unknown server-side, the office has never decided — nothing to resolve yet.
  const entityId = await findEntityIdByKey(input.entityType, agent.id, input.idempotencyKey);
  if (!entityId) {
    throw new BusinessRuleError(
      'No office record matches this idempotency key — nothing to escalate yet',
      'CONFLICT_NO_OFFICE_RECORD',
    );
  }

  const metadata: Record<string, unknown> = {
    idempotencyKey: input.idempotencyKey,
    summary: input.summary,
    agentId: agent.id,
    agentCode: agent.agent_code,
  };
  if (input.reason) metadata.reason = input.reason;
  if (input.deviceSnapshot !== undefined) metadata.deviceSnapshot = input.deviceSnapshot;
  if (input.officeSnapshot !== undefined) metadata.officeSnapshot = input.officeSnapshot;

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
export function assertCalendarDate(value: string, field: string): void {
  if (!isValidDateString(value)) {
    throw new ValidationError(`${field} must be a valid calendar date (YYYY-MM-DD)`);
  }
}
