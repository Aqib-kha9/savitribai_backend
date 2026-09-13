import { query } from '../../database/client.js';
import { addDays } from '../../core/time.js';
/**
 * Builds the audit_event WHERE clause + positional parameters for a filter
 * set. Clause order mirrors the filter order above; each returned clause is
 * independently parameterised so filters compose safely.
 */
function buildAuditWhere(filters) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        clauses.push(clause);
        params.push(value);
    };
    if (filters.from !== undefined) {
        push(`occurred_at >= $${params.length + 1}::timestamptz`, `${filters.from}T00:00:00+05:30`);
    }
    if (filters.to !== undefined) {
        push(`occurred_at < $${params.length + 1}::timestamptz`, `${addDays(filters.to, 1)}T00:00:00+05:30`);
    }
    if (filters.action !== undefined)
        push(`action = $${params.length + 1}`, filters.action);
    if (filters.actorStaffId !== undefined) {
        push(`actor_staff_id = $${params.length + 1}::uuid`, filters.actorStaffId);
    }
    if (filters.entityType !== undefined)
        push(`entity_type = $${params.length + 1}`, filters.entityType);
    if (filters.entityId !== undefined)
        push(`entity_id = $${params.length + 1}`, filters.entityId);
    if (filters.source !== undefined)
        push(`source = $${params.length + 1}`, filters.source);
    if (filters.requestId !== undefined)
        push(`request_id = $${params.length + 1}`, filters.requestId);
    return {
        whereSql: clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '',
        params,
    };
}
function toAuditEventView(row) {
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
export async function listAuditEvents(_actor, input, _meta) {
    const { whereSql, params } = buildAuditWhere(input);
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT id, occurred_at, actor_staff_id, actor_role, actor_staff_code,
            action, entity_type, entity_id, source, request_id,
            business_date::text AS business_date, metadata,
            COUNT(*) OVER() AS total_count
       FROM audit_event
       ${whereSql}
      ORDER BY occurred_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
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
export async function getAuditSummary(_actor, input, _meta) {
    const { whereSql, params } = buildAuditWhere(input);
    const totalResult = await query(`SELECT COUNT(*)::int AS count FROM audit_event ${whereSql}`, params);
    const total = totalResult.rows[0]?.count ?? 0;
    const byActionResult = await query(`SELECT action, COUNT(*)::int AS count
       FROM audit_event
       ${whereSql}
      GROUP BY action
      ORDER BY count DESC, action ASC`, params);
    const byAction = byActionResult.rows.map((row) => ({
        action: row.action,
        count: row.count,
    }));
    const byActorResult = await query(`SELECT actor_staff_id, actor_staff_code, actor_role, COUNT(*)::int AS count
       FROM audit_event
       ${whereSql}
      GROUP BY actor_staff_id, actor_staff_code, actor_role
      ORDER BY count DESC, actor_staff_id ASC NULLS LAST`, params);
    const byActor = byActorResult.rows.map((row) => ({
        actorStaffId: row.actor_staff_id,
        actorStaffCode: row.actor_staff_code,
        actorRole: row.actor_role,
        count: row.count,
    }));
    return { total, byAction, byActor };
}
