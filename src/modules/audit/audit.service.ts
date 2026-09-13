import { query } from '../../database/client.js';
import { addDays } from '../../core/time.js';
import type { AuthContext } from '../../types/auth-context.js';
import type { AuditSource } from '../../audit/audit-writer.js';
import type { AuditEventsQuery, AuditSummaryQuery } from './audit.schemas.js';

/**
 * Audit trail query service (docs/backend-master-spec.md §21).
 *
 * Pure read surface over the append-only audit_event table. The table rejects
 * UPDATE/DELETE at the database level (001_schema.sql reject_mutation triggers),
 * so this service only ever SELECTs — there is deliberately no mutation path
 * and no audit-event-of-the-audit-read (querying the trail would recurse).
 *
 * Endpoints implemented by the routes layer (M.D. role + security.audit.read
 * enforced there):
 *   GET /events   -> listAuditEvents   (filtered, paginated trail, newest first)
 *   GET /summary  -> getAuditSummary   (counts by action / by actor + total)
 *
 * occurred_at is a TIMESTAMPTZ, while the filter dates are IST YYYY-MM-DD days.
 * Day bounds are therefore converted to explicit +05:30 instants in JS:
 *   - from = 'YYYY-MM-DDT00:00:00+05:30'                 (inclusive)
 *   - to   = next-day 'YYYY-MM-DDT00:00:00+05:30'        (exclusive)
 * The offset literal keeps the comparison independent of the session
 * TimeZone, so a filter of "today" always means the full IST calendar day.
 *
 * Metadata is returned as parsed JSON (pg decodes jsonb) and count aggregates
 * are cast ::int so they arrive as plain numbers, not bigint strings.
 */

// ---------------------------------------------------------------------------
// Shared view types
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/** One audit_event row rendered camelCase for the API (spec §1.4 JSON). */
export interface AuditEventView {
  id: string;
  /** occurred_at rendered as an ISO-8601 UTC instant. */
  occurredAt: string;
  actorStaffId: string | null;
  actorRole: string | null;
  actorStaffCode: string | null;
  action: string;
  entityType: string;
  entityId: string | null;
  source: AuditSource;
  requestId: string | null;
  /** business_date as YYYY-MM-DD (cast ::text in SQL). */
  businessDate: string | null;
  metadata: Record<string, unknown>;
}

/** GET /events response body. */
export interface AuditEventsResult {
  items: AuditEventView[];
  total: number;
  page: number;
  pageSize: number;
}

/** One row of the by-action summary bucket. */
export interface AuditSummaryByAction {
  action: string;
  count: number;
}

/** One row of the by-actor summary bucket. */
export interface AuditSummaryByActor {
  actorStaffId: string | null;
  actorStaffCode: string | null;
  actorRole: string | null;
  count: number;
}

/** GET /summary response body. */
export interface AuditSummaryResult {
  total: number;
  byAction: AuditSummaryByAction[];
  byActor: AuditSummaryByActor[];
}

// ---------------------------------------------------------------------------
// Query building
// ---------------------------------------------------------------------------

/**
 * Filter fields shared by /events and /summary (minus pagination).
 *
 * Each optional field is declared `?: string | undefined` (not just
 * `?: string`) so objects produced by `z.infer` — which carry optional
 * properties typed `string | undefined` even when absent — are assignable
 * under `exactOptionalPropertyTypes`.
 */
interface AuditFilters {
  from?: string | undefined;
  to?: string | undefined;
  action?: string | undefined;
  actorStaffId?: string | undefined;
  entityType?: string | undefined;
  entityId?: string | undefined;
  source?: string | undefined;
  requestId?: string | undefined;
}

/**
 * Builds the audit_event WHERE clause + positional parameters for a filter
 * set. Clause order mirrors the filter order above; each returned clause is
 * independently parameterised so filters compose safely.
 */
function buildAuditWhere(filters: AuditFilters): { whereSql: string; params: unknown[] } {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    clauses.push(clause);
    params.push(value);
  };

  if (filters.from !== undefined) {
    push(`occurred_at >= $${params.length + 1}::timestamptz`, `${filters.from}T00:00:00+05:30`);
  }
  if (filters.to !== undefined) {
    push(`occurred_at < $${params.length + 1}::timestamptz`, `${addDays(filters.to, 1)}T00:00:00+05:30`);
  }
  if (filters.action !== undefined) push(`action = $${params.length + 1}`, filters.action);
  if (filters.actorStaffId !== undefined) {
    push(`actor_staff_id = $${params.length + 1}::uuid`, filters.actorStaffId);
  }
  if (filters.entityType !== undefined) push(`entity_type = $${params.length + 1}`, filters.entityType);
  if (filters.entityId !== undefined) push(`entity_id = $${params.length + 1}`, filters.entityId);
  if (filters.source !== undefined) push(`source = $${params.length + 1}`, filters.source);
  if (filters.requestId !== undefined) push(`request_id = $${params.length + 1}`, filters.requestId);

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '',
    params,
  };
}

/** audit_event row as read from the database (occurred_at stays a Date). */
type AuditEventRow = {
  id: string;
  occurred_at: Date;
  actor_staff_id: string | null;
  actor_role: string | null;
  actor_staff_code: string | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  source: AuditSource;
  request_id: string | null;
  business_date: string | null;
  metadata: Record<string, unknown>;
};

function toAuditEventView(row: AuditEventRow): AuditEventView {
  return {
    id: row.id,
    occurredAt: row.occurred_at.toISOString(),
    actorStaffId: row.actor_staff_id,
    actorRole: row.actor_role,
    actorStaffCode: row.actor_staff_code,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    source: row.source,
    requestId: row.request_id,
    businessDate: row.business_date,
    metadata: row.metadata,
  };
}

// ---------------------------------------------------------------------------
// GET /events — filtered, paginated trail
// ---------------------------------------------------------------------------

/**
 * Lists audit events newest-first. The page total is fetched with a window
 * COUNT(*) OVER() so the item query doubles as the count query (one round
 * trip, and the page is consistent for the rows returned).
 */
export async function listAuditEvents(
  _actor: AuthContext,
  input: AuditEventsQuery,
  _meta: RequestMeta,
): Promise<AuditEventsResult> {
  const { whereSql, params } = buildAuditWhere(input);
  const { page, pageSize } = input;
  const offset = (page - 1) * pageSize;

  type Row = AuditEventRow & { total_count: string };
  const result = await query<Row>(
    `SELECT id, occurred_at, actor_staff_id, actor_role, actor_staff_code,
            action, entity_type, entity_id, source, request_id,
            business_date::text AS business_date, metadata,
            COUNT(*) OVER() AS total_count
       FROM audit_event
       ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );

  const rows = result.rows;
  const items = rows.map((row) => toAuditEventView(row));
  const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
  return { items, total, page, pageSize };
}

// ---------------------------------------------------------------------------
// GET /summary — counts by action and by actor + total
// ---------------------------------------------------------------------------

/**
 * Aggregate counts over the same filter set: one row per action, one row per
 * acting staff member (grouped by actor identity columns so distinct staff
 * codes stay apart even if an id is missing), and a grand total.
 */
export async function getAuditSummary(
  _actor: AuthContext,
  input: AuditSummaryQuery,
  _meta: RequestMeta,
): Promise<AuditSummaryResult> {
  const { whereSql, params } = buildAuditWhere(input);

  const totalResult = await query<{ count: number }>(
    `SELECT COUNT(*)::int AS count FROM audit_event ${whereSql}`,
    params,
  );
  const total = totalResult.rows[0]?.count ?? 0;

  const byActionResult = await query<{ action: string; count: number }>(
    `SELECT action, COUNT(*)::int AS count
       FROM audit_event
       ${whereSql}
      GROUP BY action
      ORDER BY count DESC, action ASC`,
    params,
  );
  const byAction: AuditSummaryByAction[] = byActionResult.rows.map((row) => ({
    action: row.action,
    count: row.count,
  }));

  const byActorResult = await query<{
    actor_staff_id: string | null;
    actor_staff_code: string | null;
    actor_role: string | null;
    count: number;
  }>(
    `SELECT actor_staff_id, actor_staff_code, actor_role, COUNT(*)::int AS count
       FROM audit_event
       ${whereSql}
      GROUP BY actor_staff_id, actor_staff_code, actor_role
      ORDER BY count DESC, actor_staff_id ASC NULLS LAST`,
    params,
  );
  const byActor: AuditSummaryByActor[] = byActorResult.rows.map((row) => ({
    actorStaffId: row.actor_staff_id,
    actorStaffCode: row.actor_staff_code,
    actorRole: row.actor_role,
    count: row.count,
  }));

  return { total, byAction, byActor };
}
