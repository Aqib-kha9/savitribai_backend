import type { PoolClient } from 'pg';

import { query, transaction } from '../../database/client.js';
import {
  appendAuditEvent,
  AUDIT_ACTIONS,
  type AuditEventInput,
} from '../../audit/audit-writer.js';
import { istBusinessDate, isPastIstDeadline } from '../../core/time.js';
import {
  BadRequestError,
  BusinessRuleError,
  ConflictError,
  DeadlineExceededError,
  NotFoundError,
} from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import type {
  CountHandoverInput,
  DayCloseParams,
  DayCloseStatus,
  DifferenceStatus,
  DenominationEntry,
  EscalateDifferenceInput,
  HandoverStatus,
  LockDayCloseInput,
  MarkDifferenceInput,
  RecordDenominationsInput,
  RecordDigitalSettlementInput,
  RecordHandoverInput,
  ReopenDayCloseInput,
  SubmitDayCloseInput,
} from './reconciliation.schemas.js';

/**
 * Daily handover and reconciliation service (spec §16).
 *
 * Implements the §16 workflow over the six reconciliation tables
 * (day_close, cash_handover, denomination_breakup, digital_settlement,
 * reconciliation_difference, reconciliation_event) in 001_schema.sql.
 *
 * Guard rails:
 *  - Money is always NUMERIC(14,2) rendered as text (spec §1.3). Every SQL
 *    read casts money with ::text and every view type carries a string; the
 *    only JS arithmetic is integer-paise math used for comparisons, never a
 *    floating-point money value.
 *  - Day-close submission is gated at 17:00 IST and cash handover at 16:00
 *    IST (spec §16.5). Idempotent replays are resolved BEFORE the deadline
 *    gate so a device retry after the deadline still returns the original
 *    response instead of failing (same convention as collections.submitCollection).
 *  - reconciliation_event is append-only: the service only ever INSERTs rows
 *    and never UPDATEs or DELETEs them (the audit trail is permanent evidence,
 *    spec §16.1/§16.5).
 *  - Every mutation audits inside the same transaction (spec §6.3) and writes
 *    a reconciliation_event history line.
 *
 * Authority is enforced in the routes layer (permissions.ts / requireRole);
 * the service assumes an authorised actor has already reached it.
 *
 * Status flow on day_close:
 *   open -> submitted (agent, before 17:00 IST)
 *   submitted -> closed -> locked (office closes then locks; default lock after
 *   approval, spec §16.5). A completed (closed/locked) day can only be changed
 *   again after the President reopens it (status 'reopened').
 *
 * Handover status flow on cash_handover:
 *   pending -> confirmed  (cashier count matches the declared amount)
 *   pending -> difference (cashier count mismatches; a reconciliation_difference
 *   row is flagged to the M.D., spec §16.5).
 */

// ---------------------------------------------------------------------------
// Deadlines & module vocabulary
// ---------------------------------------------------------------------------

/** Cash handover deadline — 16:00 IST (spec §16.5). */
const CASH_HANDOVER_DEADLINE_HOUR = 16;
/** Agent day-close submission deadline — 17:00 IST (spec §16.5). */
const SUBMISSION_DEADLINE_HOUR = 17;

/**
 * Module-local audit vocabulary. The shared AUDIT_ACTIONS table keeps only
 * cross-cutting constants; the reconciliation-recorded events below are
 * module-local and are written with plain string actions (same convention as
 * the agents / customers modules).
 */
const ACTION_HANDOVER_RECORDED = 'reconciliation.cash_handover.recorded';
const ACTION_DENOMINATIONS_RECORDED = 'reconciliation.denominations.recorded';
const ACTION_DIGITAL_SETTLEMENT_RECORDED = 'reconciliation.digital_settlement.recorded';
const ACTION_DIFFERENCE_ESCALATED = 'reconciliation.difference.escalated';

/** reconciliation_event.event_type vocabulary (free text column). */
const EVENT_SUBMITTED = 'submitted';
const EVENT_HANDOVER_RECORDED = 'handover_recorded';
const EVENT_DENOMINATIONS_RECORDED = 'denominations_recorded';
const EVENT_HANDOVER_COUNTED = 'handover_counted';
const EVENT_DIGITAL_SETTLEMENT_RECORDED = 'digital_settlement_recorded';
const EVENT_DIFFERENCE_MARKED = 'difference_marked';
const EVENT_REOPENED = 'reopened';
const EVENT_CLOSED = 'closed';
const EVENT_LOCKED = 'locked';
const EVENT_ESCALATED = 'escalated';

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Local audit helpers (same transaction as the mutation — spec §6.3)
// ---------------------------------------------------------------------------

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

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/** Autocommit query bridge so read paths can reuse the transaction loaders. */
function autocommitClient(): PoolClient {
  return {
    query: (text: string, params?: ReadonlyArray<unknown>) => query(text, params),
  } as unknown as PoolClient;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

// ---------------------------------------------------------------------------
// Money helpers — integer paise only, never floating-point money
// ---------------------------------------------------------------------------

function amountToPaise(value: string): number {
  const [wholeRaw, fractionRaw = ''] = value.split('.');
  const whole = wholeRaw ?? '0';
  const fraction = (fractionRaw + '00').slice(0, 2);
  return Number(whole) * 100 + Number(fraction === '' ? '0' : fraction);
}

function paiseToAmount(paise: number): string {
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  const whole = Math.floor(abs / 100).toString();
  const fraction = (abs % 100).toString().padStart(2, '0');
  return `${sign}${whole}.${fraction}`;
}

// ---------------------------------------------------------------------------
// Agent resolution (module-private copies — see collections module header)
// ---------------------------------------------------------------------------

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

/** Self-service endpoints only operate for an active, operating agent. */
function assertAgentOperational(agent: AgentRefRow): void {
  if (agent.status !== 'active') {
    throw new BusinessRuleError(
      `Agent is ${agent.status} — reconciliation is unavailable`,
      'AGENT_NOT_ACTIVE',
    );
  }
}

// ---------------------------------------------------------------------------
// Shared day-close read model
// ---------------------------------------------------------------------------

type DayCloseSummaryRow = {
  id: string;
  agent_id: string;
  agent_code: string;
  agent_name: string;
  branch_id: string | null;
  branch_name: string | null;
  business_date: string;
  status: DayCloseStatus;
  total_amount: string;
  entry_count: number;
  cash_amount: string;
  digital_amount: string;
  queued_count: number;
  waiting_count: number;
  rejected_count: number;
  submitted_at: Date | null;
  closed_at: Date | null;
  locked_at: Date | null;
  locked_by_name: string | null;
  reopened_at: Date | null;
  reopened_by_name: string | null;
  reopen_reason: string | null;
  created_at: Date;
  updated_at: Date;
  handover_count: number;
  digital_settlement_count: number;
  difference_count: number;
};

export interface DayCloseSummaryView {
  id: string;
  agentId: string;
  agentCode: string;
  agentName: string;
  branchId: string | null;
  branchName: string | null;
  businessDate: string;
  status: DayCloseStatus;
  totalAmount: string;
  entryCount: number;
  cashAmount: string;
  digitalAmount: string;
  queuedCount: number;
  waitingCount: number;
  rejectedCount: number;
  submittedAt: string | null;
  closedAt: string | null;
  lockedAt: string | null;
  lockedByName: string | null;
  reopenedAt: string | null;
  reopenedByName: string | null;
  reopenReason: string | null;
  handoverCount: number;
  digitalSettlementCount: number;
  differenceCount: number;
  createdAt: string;
  updatedAt: string;
}

const DAY_CLOSE_SUMMARY_SELECT = `
  SELECT dc.id,
         dc.agent_id,
         a.agent_code,
         st.full_name AS agent_name,
         a.branch_id,
         b.name AS branch_name,
         dc.business_date::text AS business_date,
         dc.status,
         dc.total_amount::text AS total_amount,
         dc.entry_count::int AS entry_count,
         dc.cash_amount::text AS cash_amount,
         dc.digital_amount::text AS digital_amount,
         dc.queued_count::int AS queued_count,
         dc.waiting_count::int AS waiting_count,
         dc.rejected_count::int AS rejected_count,
         dc.submitted_at,
         dc.closed_at,
         dc.locked_at,
         lock_s.full_name AS locked_by_name,
         dc.reopened_at,
         reopen_s.full_name AS reopened_by_name,
         dc.reopen_reason,
         dc.created_at,
         dc.updated_at,
         (SELECT COUNT(*)::int FROM cash_handover ch
           WHERE ch.day_close_id = dc.id) AS handover_count,
         (SELECT COUNT(*)::int FROM digital_settlement ds
           WHERE ds.day_close_id = dc.id) AS digital_settlement_count,
         (SELECT COUNT(*)::int FROM reconciliation_difference diff
           WHERE diff.day_close_id = dc.id) AS difference_count
    FROM day_close dc
    JOIN agent a ON a.id = dc.agent_id
    JOIN staff st ON st.id = a.staff_id
    LEFT JOIN branch b ON b.id = a.branch_id
    LEFT JOIN staff lock_s ON lock_s.id = dc.locked_by
    LEFT JOIN staff reopen_s ON reopen_s.id = dc.reopened_by
`;

async function selectDayCloseSummary(
  client: PoolClient,
  dayCloseId: string,
): Promise<DayCloseSummaryRow | null> {
  const result = await client.query<DayCloseSummaryRow>(
    `${DAY_CLOSE_SUMMARY_SELECT} WHERE dc.id = $1 LIMIT 1`,
    [dayCloseId],
  );
  return result.rows[0] ?? null;
}

async function selectDayCloseByAgentAndDate(
  client: PoolClient,
  agentId: string,
  businessDate: string,
): Promise<DayCloseSummaryRow | null> {
  const result = await client.query<DayCloseSummaryRow>(
    `${DAY_CLOSE_SUMMARY_SELECT} WHERE dc.agent_id = $1 AND dc.business_date = $2 LIMIT 1`,
    [agentId, businessDate],
  );
  return result.rows[0] ?? null;
}

async function requireDayCloseSummary(
  client: PoolClient,
  dayCloseId: string,
): Promise<DayCloseSummaryRow> {
  const row = await selectDayCloseSummary(client, dayCloseId);
  if (!row) throw new NotFoundError('Day close');
  return row;
}

function toDayCloseSummaryView(row: DayCloseSummaryRow): DayCloseSummaryView {
  return {
    id: row.id,
    agentId: row.agent_id,
    agentCode: row.agent_code,
    agentName: row.agent_name,
    branchId: row.branch_id,
    branchName: row.branch_name,
    businessDate: row.business_date,
    status: row.status,
    totalAmount: row.total_amount,
    entryCount: row.entry_count,
    cashAmount: row.cash_amount,
    digitalAmount: row.digital_amount,
    queuedCount: row.queued_count,
    waitingCount: row.waiting_count,
    rejectedCount: row.rejected_count,
    submittedAt: iso(row.submitted_at),
    closedAt: iso(row.closed_at),
    lockedAt: iso(row.locked_at),
    lockedByName: row.locked_by_name,
    reopenedAt: iso(row.reopened_at),
    reopenedByName: row.reopened_by_name,
    reopenReason: row.reopen_reason,
    handoverCount: row.handover_count,
    digitalSettlementCount: row.digital_settlement_count,
    differenceCount: row.difference_count,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}

/** Guards mutations that are not permitted once a day close is finalised. */
function assertDayCloseMutable(status: DayCloseStatus, action: string): void {
  if (status === 'locked') {
    throw new ConflictError(`Day close is locked — ${action} is not permitted`, 'DAY_CLOSE_LOCKED');
  }
  if (status === 'closed') {
    throw new ConflictError(`Day close is closed — ${action} is not permitted`, 'DAY_CLOSE_CLOSED');
  }
}

function assertSameBusinessDate(businessDate: string, action: string): void {
  const today = istBusinessDate();
  if (businessDate !== today) {
    throw new BusinessRuleError(
      `${action} is only permitted on the business date itself (expected ${today}, got ${businessDate})`,
      'SAME_DAY_ONLY',
    );
  }
}

// ---------------------------------------------------------------------------
// Day totals (derived live from collection_entry — same source the agents
// module snapshots, rendered as text instead of float8)
// ---------------------------------------------------------------------------

type DayTotalsTextRow = {
  total_amount: string;
  entry_count: number;
  cash_amount: string;
  digital_amount: string;
  queued_count: number;
  waiting_count: number;
  rejected_count: number;
};

export interface ReconciliationTotalsView {
  businessDate: string;
  totalAmount: string;
  entryCount: number;
  cashAmount: string;
  digitalAmount: string;
  queuedCount: number;
  waitingCount: number;
  rejectedCount: number;
}

const DAY_TOTALS_SQL = `
  SELECT COALESCE(SUM(amount), 0)::text AS total_amount,
         COUNT(*)::int AS entry_count,
         COALESCE(SUM(amount) FILTER (WHERE mode = 'cash'), 0)::text AS cash_amount,
         COALESCE(SUM(amount) FILTER (WHERE mode <> 'cash'), 0)::text AS digital_amount,
         0::int AS queued_count,
         COUNT(*) FILTER (WHERE status = 'waiting')::int AS waiting_count,
         COUNT(*) FILTER (WHERE status = 'rejected')::int AS rejected_count
    FROM collection_entry
   WHERE agent_id = $1 AND business_date = $2 AND is_deleted = false`;

const ZERO_TOTALS: Omit<DayTotalsTextRow, 'total_amount' | 'cash_amount' | 'digital_amount'> & {
  total_amount: string;
  cash_amount: string;
  digital_amount: string;
} = {
  total_amount: '0.00',
  entry_count: 0,
  cash_amount: '0.00',
  digital_amount: '0.00',
  queued_count: 0,
  waiting_count: 0,
  rejected_count: 0,
};

function toReconciliationTotalsView(businessDate: string, row: DayTotalsTextRow): ReconciliationTotalsView {
  return {
    businessDate,
    totalAmount: row.total_amount,
    entryCount: row.entry_count,
    cashAmount: row.cash_amount,
    digitalAmount: row.digital_amount,
    queuedCount: row.queued_count,
    waitingCount: row.waiting_count,
    rejectedCount: row.rejected_count,
  };
}

// ---------------------------------------------------------------------------
// Handover / denominations read model
// ---------------------------------------------------------------------------

export interface DenominationView {
  denomination: number;
  noteCount: number;
  amount: string;
}

export interface HandoverView {
  id: string;
  dayCloseId: string;
  agentId: string;
  handedOverAt: string | null;
  amount: string;
  sectionReport: unknown;
  status: HandoverStatus;
  countedBy: string | null;
  countedByName: string | null;
  countedAt: string | null;
  confirmedAmount: string | null;
  differenceAmount: string | null;
  createdAt: string;
  updatedAt: string;
  denominations: DenominationView[];
}

type HandoverRow = {
  id: string;
  day_close_id: string;
  day_close_status: DayCloseStatus;
  business_date: string;
  agent_id: string;
  handed_over_at: Date | null;
  amount: string;
  section_report: unknown;
  status: HandoverStatus;
  counted_by: string | null;
  counted_by_name: string | null;
  counted_at: Date | null;
  confirmed_amount: string | null;
  difference_amount: string | null;
  created_at: Date;
  updated_at: Date;
};

const HANDOVER_SELECT = `
  SELECT ch.id,
         ch.day_close_id,
         ch.agent_id,
         ch.handed_over_at,
         ch.amount::text AS amount,
         ch.section_report,
         ch.status,
         ch.counted_by,
         cs.full_name AS counted_by_name,
         ch.counted_at,
         ch.confirmed_amount::text AS confirmed_amount,
         ch.difference_amount::text AS difference_amount,
         dc.business_date::text AS business_date,
         dc.status AS day_close_status,
         ch.created_at,
         ch.updated_at
    FROM cash_handover ch
    LEFT JOIN staff cs ON cs.id = ch.counted_by
    LEFT JOIN day_close dc ON dc.id = ch.day_close_id
`;

async function selectHandoverById(client: PoolClient, handoverId: string): Promise<HandoverRow | null> {
  const result = await client.query<HandoverRow>(
    `${HANDOVER_SELECT} WHERE ch.id = $1 LIMIT 1`,
    [handoverId],
  );
  return result.rows[0] ?? null;
}

async function selectHandoversForDayClose(
  client: PoolClient,
  dayCloseId: string,
): Promise<HandoverRow[]> {
  const result = await client.query<HandoverRow>(
    `${HANDOVER_SELECT} WHERE ch.day_close_id = $1 ORDER BY ch.created_at, ch.id`,
    [dayCloseId],
  );
  return result.rows;
}

type DenominationRow = {
  cash_handover_id: string;
  denomination: number;
  note_count: number;
  amount: string;
};

/** Loads every denomination line for a day close, keyed by handover id. */
async function selectDenominationBreakdown(
  client: PoolClient,
  dayCloseId: string,
): Promise<Map<string, DenominationView[]>> {
  const result = await client.query<DenominationRow>(
    `SELECT db.cash_handover_id,
            db.denomination::int AS denomination,
            db.note_count::int AS note_count,
            db.amount::text AS amount
       FROM denomination_breakup db
       JOIN cash_handover ch ON ch.id = db.cash_handover_id
      WHERE ch.day_close_id = $1
      ORDER BY db.denomination`,
    [dayCloseId],
  );
  const breakdown = new Map<string, DenominationView[]>();
  for (const row of result.rows) {
    const key = row.cash_handover_id;
    const list = breakdown.get(key) ?? [];
    list.push({
      denomination: row.denomination,
      noteCount: row.note_count,
      amount: row.amount,
    });
    breakdown.set(key, list);
  }
  return breakdown;
}

function toHandoverView(row: HandoverRow, denominations: DenominationView[]): HandoverView {
  return {
    id: row.id,
    dayCloseId: row.day_close_id,
    agentId: row.agent_id,
    handedOverAt: iso(row.handed_over_at),
    amount: row.amount,
    sectionReport: row.section_report ?? null,
    status: row.status,
    countedBy: row.counted_by,
    countedByName: row.counted_by_name,
    countedAt: iso(row.counted_at),
    confirmedAmount: row.confirmed_amount,
    differenceAmount: row.difference_amount,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
    denominations,
  };
}

async function loadHandoverView(client: PoolClient, handoverId: string): Promise<HandoverView> {
  const row = await selectHandoverById(client, handoverId);
  if (!row) throw new NotFoundError('Cash handover');
  const breakdown = await selectDenominationBreakdown(client, row.day_close_id);
  return toHandoverView(row, breakdown.get(row.id) ?? []);
}

type HandoverWithDayCloseRow = HandoverRow;

async function selectHandoverWithDayClose(
  client: PoolClient,
  handoverId: string,
): Promise<HandoverWithDayCloseRow | null> {
  return selectHandoverById(client, handoverId);
}

// ---------------------------------------------------------------------------
// Digital settlement / difference / event read models
// ---------------------------------------------------------------------------

export interface DigitalSettlementView {
  id: string;
  dayCloseId: string;
  settlementReference: string;
  bankName: string | null;
  settlementDate: string;
  method: string;
  amount: string;
  nameWiseDetails: unknown;
  receiptReference: string | null;
  createdAt: string;
}

type DigitalSettlementRow = {
  id: string;
  day_close_id: string;
  settlement_reference: string;
  bank_name: string | null;
  settlement_date: string;
  method: string;
  amount: string;
  name_wise_details: unknown;
  receipt_reference: string | null;
  created_at: Date;
};

async function selectDigitalSettlementById(
  client: PoolClient,
  settlementId: string,
): Promise<DigitalSettlementRow | null> {
  const result = await client.query<DigitalSettlementRow>(
    `SELECT id,
            day_close_id,
            settlement_reference,
            bank_name,
            settlement_date::text AS settlement_date,
            method,
            amount::text AS amount,
            name_wise_details,
            receipt_reference,
            created_at
       FROM digital_settlement
      WHERE id = $1 LIMIT 1`,
    [settlementId],
  );
  return result.rows[0] ?? null;
}

async function selectDigitalSettlementsForDayClose(
  client: PoolClient,
  dayCloseId: string,
): Promise<DigitalSettlementView[]> {
  const result = await client.query<DigitalSettlementRow>(
    `SELECT id,
            day_close_id,
            settlement_reference,
            bank_name,
            settlement_date::text AS settlement_date,
            method,
            amount::text AS amount,
            name_wise_details,
            receipt_reference,
            created_at
       FROM digital_settlement
      WHERE day_close_id = $1
      ORDER BY created_at, id`,
    [dayCloseId],
  );
  return result.rows.map((row) => toDigitalSettlementView(row));
}

function toDigitalSettlementView(row: DigitalSettlementRow): DigitalSettlementView {
  return {
    id: row.id,
    dayCloseId: row.day_close_id,
    settlementReference: row.settlement_reference,
    bankName: row.bank_name,
    settlementDate: row.settlement_date,
    method: row.method,
    amount: row.amount,
    nameWiseDetails: row.name_wise_details ?? null,
    receiptReference: row.receipt_reference,
    createdAt: iso(row.created_at) ?? '',
  };
}

export interface DifferenceView {
  id: string;
  dayCloseId: string;
  differenceType: string;
  amount: string;
  reason: string | null;
  status: DifferenceStatus;
  markedBy: string | null;
  markedByName: string | null;
  markedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

type DifferenceRow = {
  id: string;
  day_close_id: string;
  difference_type: string;
  amount: string;
  reason: string | null;
  status: DifferenceStatus;
  marked_by: string | null;
  marked_by_name: string | null;
  marked_at: Date | null;
  resolution_note: string | null;
  created_at: Date;
  updated_at: Date;
};

const DIFFERENCE_SELECT = `
  SELECT diff.id,
         diff.day_close_id,
         diff.difference_type,
         diff.amount::text AS amount,
         diff.reason,
         diff.status,
         diff.marked_by,
         ms.full_name AS marked_by_name,
         diff.marked_at,
         diff.resolution_note,
         diff.created_at,
         diff.updated_at
    FROM reconciliation_difference diff
    LEFT JOIN staff ms ON ms.id = diff.marked_by
`;

async function selectDifferenceById(client: PoolClient, differenceId: string): Promise<DifferenceRow | null> {
  const result = await client.query<DifferenceRow>(
    `${DIFFERENCE_SELECT} WHERE diff.id = $1 LIMIT 1`,
    [differenceId],
  );
  return result.rows[0] ?? null;
}

async function selectDifferencesForDayClose(
  client: PoolClient,
  dayCloseId: string,
): Promise<DifferenceView[]> {
  const result = await client.query<DifferenceRow>(
    `${DIFFERENCE_SELECT} WHERE diff.day_close_id = $1 ORDER BY diff.created_at, diff.id`,
    [dayCloseId],
  );
  return result.rows.map((row) => toDifferenceView(row));
}

async function selectUnresolvedDifferencesForDayClose(
  client: PoolClient,
  dayCloseId: string,
): Promise<DifferenceView[]> {
  const result = await client.query<DifferenceRow>(
    `${DIFFERENCE_SELECT}
      WHERE diff.day_close_id = $1 AND diff.status = 'unresolved'
      ORDER BY diff.created_at, diff.id`,
    [dayCloseId],
  );
  return result.rows.map((row) => toDifferenceView(row));
}

async function selectLatestCountDifference(
  client: PoolClient,
  dayCloseId: string,
): Promise<DifferenceView | null> {
  const result = await client.query<DifferenceRow>(
    `${DIFFERENCE_SELECT}
      WHERE diff.day_close_id = $1
        AND diff.difference_type IN ('cash_shortage', 'cash_excess')
      ORDER BY diff.created_at DESC, diff.id DESC
      LIMIT 1`,
    [dayCloseId],
  );
  const row = result.rows[0];
  return row ? toDifferenceView(row) : null;
}

function toDifferenceView(row: DifferenceRow): DifferenceView {
  return {
    id: row.id,
    dayCloseId: row.day_close_id,
    differenceType: row.difference_type,
    amount: row.amount,
    reason: row.reason,
    status: row.status,
    markedBy: row.marked_by,
    markedByName: row.marked_by_name,
    markedAt: iso(row.marked_at),
    resolutionNote: row.resolution_note,
    createdAt: iso(row.created_at) ?? '',
    updatedAt: iso(row.updated_at) ?? '',
  };
}

export interface ReconciliationEventView {
  id: string;
  dayCloseId: string;
  eventType: string;
  eventData: unknown;
  performedBy: string | null;
  performedByName: string | null;
  performedSource: string | null;
  createdAt: string;
}

type ReconciliationEventRow = {
  id: string;
  day_close_id: string;
  event_type: string;
  event_data: unknown;
  performed_by: string | null;
  performed_by_name: string | null;
  performed_source: string | null;
  created_at: Date;
};

async function selectEventsForDayClose(
  client: PoolClient,
  dayCloseId: string,
): Promise<ReconciliationEventView[]> {
  const result = await client.query<ReconciliationEventRow>(
    `SELECT ev.id,
            ev.day_close_id,
            ev.event_type,
            ev.event_data,
            ev.performed_by,
            ps.full_name AS performed_by_name,
            ev.performed_source,
            ev.created_at
       FROM reconciliation_event ev
       LEFT JOIN staff ps ON ps.id = ev.performed_by
      WHERE ev.day_close_id = $1
      ORDER BY ev.created_at, ev.id`,
    [dayCloseId],
  );
  return result.rows.map((row) => ({
    id: row.id,
    dayCloseId: row.day_close_id,
    eventType: row.event_type,
    eventData: row.event_data ?? null,
    performedBy: row.performed_by,
    performedByName: row.performed_by_name,
    performedSource: row.performed_source,
    createdAt: iso(row.created_at) ?? '',
  }));
}

/**
 * Appends one immutable history line to reconciliation_event. The service
 * never UPDATEs or DELETEs reconciliation_event rows.
 */
async function appendReconciliationEvent(
  client: PoolClient,
  dayCloseId: string,
  eventType: string,
  actor: AuthContext,
  eventData?: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO reconciliation_event
       (day_close_id, event_type, event_data, performed_by, performed_source)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      dayCloseId,
      eventType,
      eventData !== undefined ? JSON.stringify(eventData) : null,
      actor.staffId,
      actor.source,
    ],
  );
}

// ---------------------------------------------------------------------------
// Full record set (permanent evidence — spec §16.1/§16.5)
// ---------------------------------------------------------------------------

export interface ReconciliationDetailView {
  dayClose: DayCloseSummaryView;
  handovers: HandoverView[];
  digitalSettlements: DigitalSettlementView[];
  differences: DifferenceView[];
  events: ReconciliationEventView[];
}

// ---------------------------------------------------------------------------
// Endpoint: GET /day-close/:agentId/:date — day summary
// ---------------------------------------------------------------------------

export async function getDayCloseSummary(
  _actor: AuthContext,
  input: DayCloseParams,
  _meta: RequestMeta = {},
): Promise<DayCloseSummaryView> {
  const today = istBusinessDate();
  if (input.date > today) {
    throw new NotFoundError('Day close');
  }
  const client = autocommitClient();
  const row = await selectDayCloseByAgentAndDate(client, input.agentId, input.date);
  if (!row) throw new NotFoundError('Day close');
  return toDayCloseSummaryView(row);
}

// ---------------------------------------------------------------------------
// Endpoint: POST /submit — agent submission (before 17:00 IST)
// ---------------------------------------------------------------------------

export interface DayCloseSubmissionView {
  dayCloseId: string;
  businessDate: string;
  status: 'submitted';
  submittedAt: string;
  totals: ReconciliationTotalsView;
}

export async function submitDayClose(
  actor: AuthContext,
  input: SubmitDayCloseInput,
  meta: RequestMeta = {},
): Promise<DayCloseSubmissionView> {
  const agent = await resolveAgent(actor);
  assertAgentOperational(agent);
  const businessDate = input.businessDate ?? istBusinessDate();
  assertSameBusinessDate(businessDate, 'Day-close submission');

  return transaction<DayCloseSubmissionView>(async (client) => {
    const existing = await selectDayCloseByAgentAndDate(client, agent.id, businessDate);

    // Idempotent replay: an already-submitted day is returned as-is — this
    // runs BEFORE the deadline gate so a retry after 17:00 IST still succeeds.
    if (existing && existing.status === 'submitted') {
      return {
        dayCloseId: existing.id,
        businessDate: existing.business_date,
        status: 'submitted',
        submittedAt: iso(existing.submitted_at) ?? new Date().toISOString(),
        totals: toReconciliationTotalsView(existing.business_date, {
          total_amount: existing.total_amount,
          entry_count: existing.entry_count,
          cash_amount: existing.cash_amount,
          digital_amount: existing.digital_amount,
          queued_count: existing.queued_count,
          waiting_count: existing.waiting_count,
          rejected_count: existing.rejected_count,
        }),
      };
    }
    if (existing && (existing.status === 'closed' || existing.status === 'locked')) {
      throw new ConflictError(
        `Day close is already ${existing.status} for ${businessDate}`,
        'DAY_ALREADY_CLOSED',
      );
    }

    if (isPastIstDeadline(SUBMISSION_DEADLINE_HOUR)) {
      throw new DeadlineExceededError(
        `Day close must be submitted before ${SUBMISSION_DEADLINE_HOUR}:00 IST`,
      );
    }

    const totalsResult = await client.query<DayTotalsTextRow>(DAY_TOTALS_SQL, [
      agent.id,
      businessDate,
    ]);
    const totalsRow = totalsResult.rows[0] ?? ZERO_TOTALS;

    const upserted = await client.query<{ id: string; submitted_at: Date | null }>(
      `INSERT INTO day_close
         (agent_id, business_date, status,
          total_amount, entry_count, cash_amount, digital_amount,
          queued_count, waiting_count, rejected_count, submitted_at)
       VALUES ($1, $2, 'submitted', $3, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (agent_id, business_date)
       DO UPDATE SET
         status = 'submitted',
         total_amount = EXCLUDED.total_amount,
         entry_count = EXCLUDED.entry_count,
         cash_amount = EXCLUDED.cash_amount,
         digital_amount = EXCLUDED.digital_amount,
         queued_count = EXCLUDED.queued_count,
         waiting_count = EXCLUDED.waiting_count,
         rejected_count = EXCLUDED.rejected_count,
         submitted_at = now(),
         updated_at = now()
       RETURNING id, submitted_at`,
      [
        agent.id,
        businessDate,
        totalsRow.total_amount,
        totalsRow.entry_count,
        totalsRow.cash_amount,
        totalsRow.digital_amount,
        totalsRow.queued_count,
        totalsRow.waiting_count,
        totalsRow.rejected_count,
      ],
    );
    const dayCloseRow = upserted.rows[0]!;
    const dayCloseId = dayCloseRow.id;

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.DAY_CLOSE_SUBMITTED,
      entityType: 'day_close',
      entityId: dayCloseId,
      businessDate,
      metadata: {
        agentId: agent.id,
        agentCode: agent.agent_code,
        totals: totalsRow,
      },
    });
    await appendReconciliationEvent(client, dayCloseId, EVENT_SUBMITTED, actor, {
      agentId: agent.id,
      totals: totalsRow,
    });

    return {
      dayCloseId,
      businessDate,
      status: 'submitted',
      submittedAt: iso(dayCloseRow.submitted_at) ?? new Date().toISOString(),
      totals: toReconciliationTotalsView(businessDate, totalsRow),
    };
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /handover — cash handover (before 16:00 IST)
// ---------------------------------------------------------------------------

export async function recordHandover(
  actor: AuthContext,
  input: RecordHandoverInput,
  meta: RequestMeta = {},
): Promise<HandoverView> {
  const agent = await resolveAgent(actor);
  assertAgentOperational(agent);
  const businessDate = input.businessDate ?? istBusinessDate();
  assertSameBusinessDate(businessDate, 'Cash handover');
  const declaredPaise = amountToPaise(input.amount);

  return transaction<HandoverView>(async (client) => {
    const existing = await selectDayCloseByAgentAndDate(client, agent.id, businessDate);

    // Idempotent replay / duplicate guard — resolved BEFORE the deadline gate.
    if (existing) {
      const handovers = await selectHandoversForDayClose(client, existing.id);
      if (handovers.length > 0) {
        const prior = handovers[0]!;
        if (amountToPaise(prior.amount) === declaredPaise) {
          const breakdown = await selectDenominationBreakdown(client, existing.id);
          return toHandoverView(prior, breakdown.get(prior.id) ?? []);
        }
        throw new ConflictError(
          'Cash handover has already been recorded for this day close',
          'HANDOVER_ALREADY_RECORDED',
        );
      }
    }

    if (existing) {
      assertDayCloseMutable(existing.status, 'recording a cash handover');
    }

    if (isPastIstDeadline(CASH_HANDOVER_DEADLINE_HOUR)) {
      throw new DeadlineExceededError(
        `Cash handover must be recorded before ${CASH_HANDOVER_DEADLINE_HOUR}:00 IST`,
      );
    }

    // The agent cannot hand over more cash than was collected that day. A lower
    // declaration is allowed and, if genuine, is flagged by the cashier count.
    const cashResult = await client.query<{ cash_amount: string }>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE mode = 'cash'), 0)::text AS cash_amount
         FROM collection_entry
        WHERE agent_id = $1 AND business_date = $2 AND is_deleted = false`,
      [agent.id, businessDate],
    );
    const cashAmountText = cashResult.rows[0]?.cash_amount ?? '0.00';
    if (declaredPaise > amountToPaise(cashAmountText)) {
      throw new BusinessRuleError(
        `Handover amount exceeds the day's cash collections (${cashAmountText})`,
        'HANDOVER_EXCEEDS_CASH',
      );
    }

    // Ensure a day_close row exists (open when the handover precedes submit).
    let dayCloseRow = existing;
    let dayCloseId: string;
    if (!dayCloseRow) {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO day_close (agent_id, business_date, status)
         VALUES ($1, $2, 'open')
         ON CONFLICT (agent_id, business_date) DO NOTHING
         RETURNING id`,
        [agent.id, businessDate],
      );
      if (inserted.rows[0]) {
        dayCloseId = inserted.rows[0].id;
      } else {
        const found = await client.query<{ id: string }>(
          `SELECT id FROM day_close WHERE agent_id = $1 AND business_date = $2 LIMIT 1`,
          [agent.id, businessDate],
        );
        dayCloseId = found.rows[0]!.id;
      }
    } else {
      dayCloseId = dayCloseRow.id;
    }

    const inserted = await client.query<{ id: string }>(
      `INSERT INTO cash_handover
         (day_close_id, agent_id, handed_over_at, amount, section_report, status)
       VALUES ($1, $2, now(), $3::numeric, $4, 'pending')
       RETURNING id`,
      [
        dayCloseId,
        agent.id,
        input.amount,
        input.sectionReport !== undefined ? JSON.stringify(input.sectionReport) : null,
      ],
    );
    const handoverId = inserted.rows[0]!.id;

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_HANDOVER_RECORDED,
      entityType: 'cash_handover',
      entityId: handoverId,
      businessDate,
      metadata: {
        agentId: agent.id,
        agentCode: agent.agent_code,
        dayCloseId,
        amount: input.amount,
      },
    });
    await appendReconciliationEvent(client, dayCloseId, EVENT_HANDOVER_RECORDED, actor, {
      agentId: agent.id,
      handoverId,
      amount: input.amount,
    });

    return loadHandoverView(client, handoverId);
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /denominations — denomination-wise cash breakup
// ---------------------------------------------------------------------------

function denominationKey(entry: DenominationEntry): string {
  return `${entry.denomination}:${entry.count}`;
}

export async function recordDenominations(
  actor: AuthContext,
  input: RecordDenominationsInput,
  meta: RequestMeta = {},
): Promise<HandoverView> {
  const agent = await resolveAgent(actor);
  assertAgentOperational(agent);

  return transaction<HandoverView>(async (client) => {
    const handover = await selectHandoverWithDayClose(client, input.handoverId);
    if (!handover) throw new NotFoundError('Cash handover');
    if (handover.agent_id !== agent.id) {
      throw new BusinessRuleError('This handover does not belong to your agent profile', 'NOT_YOUR_HANDOVER');
    }

    const existingBreakdown = await selectDenominationBreakdown(client, handover.day_close_id);
    const existingLines = existingBreakdown.get(handover.id) ?? [];
    const existingKeys = new Set(existingLines.map((line) => `${line.denomination}:${line.noteCount}`));
    const incomingKeys = input.entries.map(denominationKey);

    // Idempotent replay: identical breakup is returned as-is before the gate.
    const identical =
      existingLines.length === input.entries.length &&
      incomingKeys.every((key) => existingKeys.has(key));
    if (identical) {
      return toHandoverView(handover, existingLines);
    }

    assertDayCloseMutable(handover.day_close_status, 'recording denominations');
    if (handover.status !== 'pending') {
      throw new ConflictError(
        'Cash handover has already been counted — denominations can no longer be changed',
        'HANDOVER_ALREADY_COUNTED',
      );
    }
    if (isPastIstDeadline(CASH_HANDOVER_DEADLINE_HOUR)) {
      throw new DeadlineExceededError(
        `Denominations must be recorded before ${CASH_HANDOVER_DEADLINE_HOUR}:00 IST`,
      );
    }

    await client.query(
      `DELETE FROM denomination_breakup WHERE cash_handover_id = $1`,
      [handover.id],
    );

    let totalPaise = 0;
    for (const entry of input.entries) {
      const linePaise = entry.denomination * entry.count * 100;
      totalPaise += linePaise;
      await client.query(
        `INSERT INTO denomination_breakup
           (cash_handover_id, denomination, note_count, amount)
         VALUES ($1, $2, $3, $4::numeric)`,
        [handover.id, entry.denomination, entry.count, paiseToAmount(linePaise)],
      );
    }
    await client.query(
      `UPDATE cash_handover SET updated_at = now() WHERE id = $1`,
      [handover.id],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_DENOMINATIONS_RECORDED,
      entityType: 'denomination_breakup',
      entityId: handover.id,
      businessDate: handover.business_date,
      metadata: {
        dayCloseId: handover.day_close_id,
        agentId: agent.id,
        lineCount: input.entries.length,
        totalAmount: paiseToAmount(totalPaise),
      },
    });
    await appendReconciliationEvent(client, handover.day_close_id, EVENT_DENOMINATIONS_RECORDED, actor, {
      agentId: agent.id,
      handoverId: handover.id,
      lineCount: input.entries.length,
      totalAmount: paiseToAmount(totalPaise),
    });

    return loadHandoverView(client, handover.id);
  });
}

/**
 * Auto-completes a day close: when cash has been confirmed AND no unresolved
 * difference remains, the day transitions open/submitted/reopened -> closed
 * (spec §16.5 — lock-after-approval is an explicit office action that runs on
 * POST /:id/lock afterwards). The transition runs only while the day is still
 * in a mutable state so the guarded UPDATE is race-safe. Returns true when the
 * day was closed by this call.
 */
async function closeDayCloseIfReady(
  client: PoolClient,
  dayCloseId: string,
  businessDate: string,
  status: DayCloseStatus,
  actor: AuthContext,
  meta: RequestMeta,
  triggeredBy: string,
): Promise<boolean> {
  if (status !== 'open' && status !== 'submitted' && status !== 'reopened') {
    return false;
  }
  const open = await client.query<{ count: number }>(
    `SELECT COUNT(*)::int AS count
       FROM reconciliation_difference
      WHERE day_close_id = $1 AND status = 'unresolved'`,
    [dayCloseId],
  );
  if ((open.rows[0]?.count ?? 0) > 0) return false;

  const updated = await client.query<{ id: string }>(
    `UPDATE day_close
        SET status = 'closed',
            closed_at = now(),
            updated_at = now()
      WHERE id = $1 AND status IN ('open', 'submitted', 'reopened')
      RETURNING id`,
    [dayCloseId],
  );
  if (!updated.rows[0]) return false;

  await audit(client, {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: AUDIT_ACTIONS.DAY_CLOSE_CLOSED,
    entityType: 'day_close',
    entityId: dayCloseId,
    businessDate,
    metadata: { triggeredBy },
  });
  await appendReconciliationEvent(client, dayCloseId, EVENT_CLOSED, actor, { triggeredBy });
  return true;
}

// ---------------------------------------------------------------------------
// Endpoint: POST /count — cashier counts and confirms the cash
// ---------------------------------------------------------------------------

export interface CountHandoverResult {
  handover: HandoverView;
  difference: DifferenceView | null;
  /** day_close.status — 'closed' when the confirmed count completed the day. */
  dayCloseStatus: DayCloseStatus;
}

export async function countHandover(
  actor: AuthContext,
  input: CountHandoverInput,
  meta: RequestMeta = {},
): Promise<CountHandoverResult> {
  const countedPaise = amountToPaise(input.countedAmount);

  return transaction<CountHandoverResult>(async (client) => {
    const handover = await selectHandoverWithDayClose(client, input.handoverId);
    if (!handover) throw new NotFoundError('Cash handover');

    // Idempotent replay: an already-counted handover returns the original
    // result when the recounted amount matches the stored confirmed amount.
    if (handover.status !== 'pending') {
      if (handover.confirmed_amount !== null && amountToPaise(handover.confirmed_amount) === countedPaise) {
        const breakdown = await selectDenominationBreakdown(client, handover.day_close_id);
        const difference =
          handover.status === 'confirmed'
            ? null
            : await selectLatestCountDifference(client, handover.day_close_id);
        return {
          handover: toHandoverView(handover, breakdown.get(handover.id) ?? []),
          difference,
          dayCloseStatus: handover.day_close_status,
        };
      }
      throw new ConflictError(
        'Cash handover has already been counted — recount with the same counted amount to replay',
        'HANDOVER_ALREADY_COUNTED',
      );
    }

    assertDayCloseMutable(handover.day_close_status, 'counting a handover');

    const declaredPaise = amountToPaise(handover.amount);
    const matches = declaredPaise === countedPaise;
    const nextStatus: HandoverStatus = matches ? 'confirmed' : 'difference';
    const differencePaise = declaredPaise - countedPaise;

    const updated = await client.query<{ id: string }>(
      `UPDATE cash_handover
          SET status = $2,
              counted_by = $3,
              counted_at = now(),
              confirmed_amount = $4::numeric,
              difference_amount = $5::numeric,
              updated_at = now()
        WHERE id = $1
        RETURNING id`,
      [
        handover.id,
        nextStatus,
        actor.staffId,
        input.countedAmount,
        matches ? null : paiseToAmount(differencePaise),
      ],
    );
    if (!updated.rows[0]) throw new NotFoundError('Cash handover');

    let difference: DifferenceView | null = null;
    if (!matches) {
      const differenceType =
        differencePaise < 0 ? 'cash_excess' : 'cash_shortage';
      const reason =
        input.notes ??
        `Cashier counted ${input.countedAmount} against declared ${handover.amount}`;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO reconciliation_difference
           (day_close_id, difference_type, amount, reason, status)
         VALUES ($1, $2, $3::numeric, $4, 'unresolved')
         RETURNING id`,
        [handover.day_close_id, differenceType, paiseToAmount(Math.abs(differencePaise)), reason],
      );
      const diffId = inserted.rows[0]!.id;
      const diffRow = await client.query<DifferenceRow>(
        `${DIFFERENCE_SELECT} WHERE diff.id = $1 LIMIT 1`,
        [diffId],
      );
      difference = diffRow.rows[0] ? toDifferenceView(diffRow.rows[0]) : null;
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.CASH_HANDOVER_COUNTED,
      entityType: 'cash_handover',
      entityId: handover.id,
      businessDate: handover.business_date,
      metadata: {
        dayCloseId: handover.day_close_id,
        handoverAmount: handover.amount,
        countedAmount: input.countedAmount,
        matched: matches,
        differenceAmount: matches ? null : paiseToAmount(Math.abs(differencePaise)),
        notes: input.notes ?? null,
      },
    });
    await appendReconciliationEvent(
      client,
      handover.day_close_id,
      EVENT_HANDOVER_COUNTED,
      actor,
      {
        handoverId: handover.id,
        countedBy: actor.staffId,
        countedAmount: input.countedAmount,
        matched: matches,
        differenceId: difference?.id ?? null,
      },
    );

    // A clean count with no unresolved difference completes the day close
    // (open/submitted/reopened -> closed, spec §16.5). A mismatch leaves the
    // day open with an unresolved difference flagged to the M.D.
    let dayCloseStatus: DayCloseStatus = handover.day_close_status;
    if (matches) {
      const closed = await closeDayCloseIfReady(
        client,
        handover.day_close_id,
        handover.business_date,
        handover.day_close_status,
        actor,
        meta,
        'cash_handover_count_confirmed',
      );
      if (closed) dayCloseStatus = 'closed';
    }

    const breakdown = await selectDenominationBreakdown(client, handover.day_close_id);
    const view = (await selectHandoverById(client, handover.id))!;
    return {
      handover: toHandoverView(view, breakdown.get(handover.id) ?? []),
      difference,
      dayCloseStatus,
    };
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /digital-settlement — digital / bank settlement evidence
// ---------------------------------------------------------------------------

export async function recordDigitalSettlement(
  actor: AuthContext,
  input: RecordDigitalSettlementInput,
  meta: RequestMeta = {},
): Promise<DigitalSettlementView> {
  return transaction<DigitalSettlementView>(async (client) => {
    const dayClose = await requireDayCloseSummary(client, input.dayCloseId);
    if (dayClose.status === 'locked') {
      throw new ConflictError(
        'Day close is locked — digital settlement evidence can no longer be attached',
        'DAY_CLOSE_LOCKED',
      );
    }

    // A caller-supplied business date, when present, must agree with the day
    // close the settlement evidence is attached to.
    if (input.businessDate !== undefined && input.businessDate !== dayClose.business_date) {
      throw new BadRequestError(
        `businessDate ${input.businessDate} does not match the day close business date ${dayClose.business_date}`,
      );
    }

    // Idempotent replay: the same settlement reference for the same day close
    // returns the original evidence row instead of inserting a duplicate.
    const existing = await client.query<DigitalSettlementRow>(
      `SELECT id,
              day_close_id,
              settlement_reference,
              bank_name,
              settlement_date::text AS settlement_date,
              method,
              amount::text AS amount,
              name_wise_details,
              receipt_reference,
              created_at
         FROM digital_settlement
        WHERE day_close_id = $1 AND settlement_reference = $2
        LIMIT 1`,
      [dayClose.id, input.settlementReference],
    );
    if (existing.rows[0]) {
      return toDigitalSettlementView(existing.rows[0]);
    }

    const settlementDate = input.settlementDate ?? dayClose.business_date;
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO digital_settlement
         (day_close_id, settlement_reference, bank_name, settlement_date,
          method, amount, name_wise_details, receipt_reference)
       VALUES ($1, $2, $3, $4::date, $5, $6::numeric, $7, $8)
       RETURNING id`,
      [
        dayClose.id,
        input.settlementReference,
        input.bankName ?? null,
        settlementDate,
        input.method,
        input.amount,
        input.nameWiseDetails !== undefined ? JSON.stringify(input.nameWiseDetails) : null,
        input.receiptReference ?? null,
      ],
    );
    const settlementId = inserted.rows[0]!.id;

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_DIGITAL_SETTLEMENT_RECORDED,
      entityType: 'digital_settlement',
      entityId: settlementId,
      businessDate: dayClose.business_date,
      metadata: {
        dayCloseId: dayClose.id,
        agentId: dayClose.agent_id,
        settlementReference: input.settlementReference,
        method: input.method,
        amount: input.amount,
      },
    });
    await appendReconciliationEvent(client, dayClose.id, EVENT_DIGITAL_SETTLEMENT_RECORDED, actor, {
      settlementId,
      agentId: dayClose.agent_id,
      settlementReference: input.settlementReference,
      method: input.method,
      amount: input.amount,
    });

    const row = await selectDigitalSettlementById(client, settlementId);
    return toDigitalSettlementView(row!);
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /difference — M.D. marks a difference resolved / unresolved
// ---------------------------------------------------------------------------

export async function markDifference(
  actor: AuthContext,
  input: MarkDifferenceInput,
  meta: RequestMeta = {},
): Promise<DifferenceView> {
  return transaction<DifferenceView>(async (client) => {
    const differenceRow = await selectDifferenceById(client, input.differenceId);
    if (!differenceRow) throw new NotFoundError('Reconciliation difference');

    const dayClose = await requireDayCloseSummary(client, differenceRow.day_close_id);
    if (dayClose.status === 'locked') {
      throw new ConflictError(
        'Day close is locked — differences can no longer be marked',
        'DAY_CLOSE_LOCKED',
      );
    }

    // Idempotent replay: repeating the same decision returns the current row.
    if (differenceRow.status === input.status) {
      return toDifferenceView(differenceRow);
    }

    // Locked days are rejected earlier (DAY_CLOSE_LOCKED), so by this point the
    // only finalised state still reachable is 'closed'.
    if (dayClose.status === 'closed' && input.status === 'unresolved') {
      throw new ConflictError(
        'Day close is finalised — a difference cannot be returned to unresolved without reopening the day',
        'DAY_CLOSE_CLOSED',
      );
    }

    const resolutionNote = input.resolutionNote ?? differenceRow.resolution_note;
    await client.query(
      `UPDATE reconciliation_difference
          SET status = $2,
              marked_by = $3,
              marked_at = now(),
              resolution_note = $4,
              updated_at = now()
        WHERE id = $1`,
      [differenceRow.id, input.status, actor.staffId, resolutionNote],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.RECONCILIATION_DIFFERENCE_MARKED,
      entityType: 'reconciliation_difference',
      entityId: differenceRow.id,
      businessDate: dayClose.business_date,
      metadata: {
        dayCloseId: dayClose.id,
        previousStatus: differenceRow.status,
        status: input.status,
        resolutionNote: resolutionNote ?? null,
      },
    });
    await appendReconciliationEvent(client, dayClose.id, EVENT_DIFFERENCE_MARKED, actor, {
      differenceId: differenceRow.id,
      previousStatus: differenceRow.status,
      status: input.status,
      resolutionNote: resolutionNote ?? null,
    });

    // Resolving the last unresolved difference completes the day close.
    if (input.status !== 'unresolved') {
      await closeDayCloseIfReady(
        client,
        dayClose.id,
        dayClose.business_date,
        dayClose.status,
        actor,
        meta,
        'difference_resolved',
      );
    }

    const refreshed = await selectDifferenceById(client, differenceRow.id);
    return toDifferenceView(refreshed!);
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /:id/reopen — President approves reopening a reconciliation
// ---------------------------------------------------------------------------

export async function reopenDayClose(
  actor: AuthContext,
  dayCloseId: string,
  input: ReopenDayCloseInput,
  meta: RequestMeta = {},
): Promise<DayCloseSummaryView> {
  return transaction<DayCloseSummaryView>(async (client) => {
    const dayClose = await requireDayCloseSummary(client, dayCloseId);

    // Idempotent replay — reopening an already-reopened day returns it as-is.
    if (dayClose.status === 'reopened') {
      return toDayCloseSummaryView(dayClose);
    }
    if (dayClose.status !== 'closed' && dayClose.status !== 'locked') {
      throw new ConflictError(
        `Day close is ${dayClose.status} — only a closed or locked reconciliation can be reopened`,
        'DAY_CLOSE_NOT_REOPENABLE',
      );
    }

    await client.query(
      `UPDATE day_close
          SET status = 'reopened',
              reopened_at = now(),
              reopened_by = $2,
              reopen_reason = $3,
              updated_at = now()
        WHERE id = $1`,
      [dayClose.id, actor.staffId, input.reopenReason],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.DAY_CLOSE_REOPENED,
      entityType: 'day_close',
      entityId: dayClose.id,
      businessDate: dayClose.business_date,
      metadata: { reopenReason: input.reopenReason },
    });
    await appendReconciliationEvent(client, dayClose.id, EVENT_REOPENED, actor, {
      reopenReason: input.reopenReason,
    });

    const refreshed = await requireDayCloseSummary(client, dayClose.id);
    return toDayCloseSummaryView(refreshed);
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /:id/lock — lock-after-approval (default, spec §16.5)
// ---------------------------------------------------------------------------

export async function lockDayClose(
  actor: AuthContext,
  dayCloseId: string,
  input: LockDayCloseInput,
  meta: RequestMeta = {},
): Promise<DayCloseSummaryView> {
  return transaction<DayCloseSummaryView>(async (client) => {
    const dayClose = await requireDayCloseSummary(client, dayCloseId);
    if (dayClose.status === 'locked') {
      throw new ConflictError('Day close is already locked', 'DAY_ALREADY_LOCKED');
    }
    if (dayClose.status !== 'closed' && dayClose.status !== 'reopened') {
      throw new ConflictError(
        `Day close is ${dayClose.status} — only a closed reconciliation can be locked`,
        'DAY_CLOSE_NOT_CLOSED',
      );
    }

    await client.query(
      `UPDATE day_close
          SET status = 'locked',
              locked_at = now(),
              locked_by = $2,
              updated_at = now()
        WHERE id = $1`,
      [dayClose.id, actor.staffId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.DAY_CLOSE_LOCKED,
      entityType: 'day_close',
      entityId: dayClose.id,
      businessDate: dayClose.business_date,
      metadata: { reason: input.reason ?? null },
    });
    await appendReconciliationEvent(client, dayClose.id, EVENT_LOCKED, actor, {
      reason: input.reason ?? null,
    });

    const refreshed = await requireDayCloseSummary(client, dayClose.id);
    return toDayCloseSummaryView(refreshed);
  });
}

// ---------------------------------------------------------------------------
// Endpoint: POST /:id/escalate — unresolved differences -> M.D.
// ---------------------------------------------------------------------------

export interface EscalateDifferenceResult {
  dayCloseId: string;
  escalatedDifferenceIds: string[];
  unresolvedCount: number;
  escalatedAt: string;
}

export async function escalateDifference(
  actor: AuthContext,
  dayCloseId: string,
  input: EscalateDifferenceInput,
  meta: RequestMeta = {},
): Promise<EscalateDifferenceResult> {
  return transaction<EscalateDifferenceResult>(async (client) => {
    const dayClose = await requireDayCloseSummary(client, dayCloseId);
    if (dayClose.status === 'locked') {
      throw new ConflictError(
        'Day close is locked — differences can no longer be escalated',
        'DAY_CLOSE_LOCKED',
      );
    }
    const unresolved = await selectUnresolvedDifferencesForDayClose(client, dayCloseId);
    if (unresolved.length === 0) {
      throw new ConflictError(
        'There are no unresolved differences to escalate on this day close',
        'NO_UNRESOLVED_DIFFERENCES',
      );
    }

    const escalatedAt = new Date();
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_DIFFERENCE_ESCALATED,
      entityType: 'day_close',
      entityId: dayClose.id,
      businessDate: dayClose.business_date,
      metadata: {
        note: input.note ?? null,
        differenceIds: unresolved.map((d) => d.id),
      },
    });
    await appendReconciliationEvent(client, dayClose.id, EVENT_ESCALATED, actor, {
      note: input.note ?? null,
      differenceIds: unresolved.map((d) => d.id),
    });

    return {
      dayCloseId: dayClose.id,
      escalatedDifferenceIds: unresolved.map((d) => d.id),
      unresolvedCount: unresolved.length,
      escalatedAt: iso(escalatedAt) ?? escalatedAt.toISOString(),
    };
  });
}

// ---------------------------------------------------------------------------
// Endpoint: GET /:id — full record set (permanent evidence — spec §16.1/§16.5)
// ---------------------------------------------------------------------------

export async function getReconciliationDetail(
  _actor: AuthContext,
  dayCloseId: string,
  _meta: RequestMeta = {},
): Promise<ReconciliationDetailView> {
  const client = autocommitClient();
  const dayCloseRow = await selectDayCloseSummary(client, dayCloseId);
  if (!dayCloseRow) throw new NotFoundError('Day close');

  const handoverRows = await selectHandoversForDayClose(client, dayCloseId);
  const breakdown = await selectDenominationBreakdown(client, dayCloseId);
  const handovers = handoverRows.map((row) =>
    toHandoverView(row, breakdown.get(row.id) ?? []),
  );

  return {
    dayClose: toDayCloseSummaryView(dayCloseRow),
    handovers,
    digitalSettlements: await selectDigitalSettlementsForDayClose(client, dayCloseId),
    differences: await selectDifferencesForDayClose(client, dayCloseId),
    events: await selectEventsForDayClose(client, dayCloseId),
  };
}
