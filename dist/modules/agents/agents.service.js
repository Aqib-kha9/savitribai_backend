import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS, } from '../../audit/audit-writer.js';
import { istBusinessDate, isPastIstDeadline } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, DeadlineExceededError, NotFoundError, } from '../../core/errors.js';
/**
 * Module-local audit vocabulary. The shared AUDIT_ACTIONS table in
 * audit-writer.ts intentionally keeps only cross-cutting constants; agent
 * profile updates and out-of-area approvals are agent-module events and are
 * recorded with plain string actions (see the same convention in
 * customers.service.ts module header).
 */
const ACTION_AGENT_UPDATED = 'agents.agent.updated';
const ACTION_OUT_OF_AREA_APPROVED = 'agents.agent.out_of_area_approved';
const ACTION_FIELD_VERIFICATION_RECORDED = 'agents.field_verification.recorded';
/** Submission deadline for day close — 17:00 IST (spec §14.5/§16.5). */
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
/** Autocommit audit bridge used on the few read paths that still audit. */
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
async function assertBranchExists(client, branchId) {
    const result = await client.query('SELECT 1 FROM branch WHERE id = $1', [branchId]);
    if (result.rowCount === 0) {
        throw new BadRequestError('Branch does not exist');
    }
}
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
/** Self-service endpoints only operate for an active, collectible agent. */
function assertAgentOperational(agent) {
    if (agent.status !== 'active') {
        throw new BusinessRuleError(`Agent is ${agent.status} — collections are unavailable`, 'AGENT_NOT_ACTIVE');
    }
}
const AGENT_SELECT_COLUMNS = `
  SELECT a.id,
         a.staff_id,
         st.staff_code,
         st.full_name,
         a.branch_id,
         b.code   AS branch_code,
         b.name   AS branch_name,
         a.agent_code,
         a.phone,
         a.email,
         a.status,
         a.resume_reference,
         a.verification_reference,
         a.id_proof_type,
         a.id_proof_reference,
         a.address_proof_type,
         a.address_proof_reference,
         a.emergency_contact_name,
         a.emergency_contact_phone,
         a.training_status,
         a.start_date::text          AS start_date,
         a.end_date::text            AS end_date,
         a.daily_cash_limit::text    AS daily_cash_limit,
         a.created_at,
         a.updated_at
    FROM agent a
    LEFT JOIN staff st ON st.id = a.staff_id
    LEFT JOIN branch b ON b.id = a.branch_id`;
function toAgentView(row) {
    return {
        id: row.id,
        staffId: row.staff_id,
        staffCode: row.staff_code,
        fullName: row.full_name,
        branchId: row.branch_id,
        branchCode: row.branch_code,
        branchName: row.branch_name,
        agentCode: row.agent_code,
        phone: row.phone,
        email: row.email,
        status: row.status,
        resumeReference: row.resume_reference,
        verificationReference: row.verification_reference,
        idProofType: row.id_proof_type,
        idProofReference: row.id_proof_reference,
        addressProofType: row.address_proof_type,
        addressProofReference: row.address_proof_reference,
        emergencyContactName: row.emergency_contact_name,
        emergencyContactPhone: row.emergency_contact_phone,
        trainingStatus: row.training_status,
        startDate: row.start_date,
        endDate: row.end_date,
        dailyCashLimit: row.daily_cash_limit,
        createdAt: iso(row.created_at) ?? row.created_at.toISOString(),
        updatedAt: iso(row.updated_at) ?? row.updated_at.toISOString(),
    };
}
async function selectAgentRow(client, agentId) {
    const result = await client.query(`${AGENT_SELECT_COLUMNS} WHERE a.id = $1`, [agentId]);
    return result.rows[0] ?? null;
}
/** GET /agents — list agents with optional status/branch/search filters. */
export async function listAgents(_actor, input, _meta = {}) {
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (input.status)
        where.push(`a.status = ${addParam(input.status)}`);
    if (input.branchId)
        where.push(`a.branch_id = ${addParam(input.branchId)}`);
    if (input.q) {
        const pattern = `%${input.q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
        where.push(`(a.agent_code ILIKE ${addParam(pattern)} ESCAPE '\\'` +
            ` OR st.full_name ILIKE ${addParam(pattern)} ESCAPE '\\'` +
            ` OR st.staff_code ILIKE ${addParam(pattern)} ESCAPE '\\')`);
    }
    const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const result = await query(`${AGENT_SELECT_COLUMNS}
      ${whereClause}
     ORDER BY a.created_at DESC
     LIMIT ${addParam(input.limit)} OFFSET ${addParam(input.offset)}`, params);
    const total = result.rows[0]?.total ?? 0;
    return {
        items: result.rows.map((row) => toAgentView(row)),
        total,
    };
}
/**
 * GET /agents/:id — a read only; no agents.* read-audit key exists in
 * AUDIT_ACTIONS, so reads are not audited (spec §6.3 audits mutations).
 */
export async function getAgent(_actor, agentId, _meta = {}) {
    const result = await query(`${AGENT_SELECT_COLUMNS} WHERE a.id = $1`, [agentId]);
    const row = result.rows[0];
    if (!row)
        throw new NotFoundError('Agent');
    return toAgentView(row);
}
/**
 * POST /agents — onboard a collection agent (spec §15.1). The staff member must
 * hold the collection_agent role and must not already have an agent profile
 * (agent.staff_id is UNIQUE). ID and address proof are mandatory.
 */
export async function onboardAgent(actor, input, meta = {}) {
    return transaction(async (client) => {
        const staff = await client.query(`SELECT st.id, r.code AS role_code
         FROM staff st
         LEFT JOIN role r ON r.id = st.role_id
        WHERE st.id = $1`, [input.staffId]);
        const staffRow = staff.rows[0];
        if (!staffRow)
            throw new NotFoundError('Staff');
        if (staffRow.role_code !== 'collection_agent') {
            throw new BusinessRuleError('Only staff with the collection agent role can be onboarded as agents', 'INVALID_STAFF_ROLE');
        }
        const duplicate = await client.query('SELECT 1 FROM agent WHERE staff_id = $1', [input.staffId]);
        if (duplicate.rowCount !== 0) {
            throw new ConflictError('This staff member is already onboarded as a collection agent', 'AGENT_ALREADY_EXISTS');
        }
        const codeTaken = await client.query('SELECT 1 FROM agent WHERE agent_code = $1', [
            input.agentCode,
        ]);
        if (codeTaken.rowCount !== 0) {
            throw new ConflictError('Agent code is already in use', 'DUPLICATE_AGENT_CODE');
        }
        if (input.branchId)
            await assertBranchExists(client, input.branchId);
        let insertedId;
        try {
            const inserted = await client.query(`INSERT INTO agent (
           staff_id, agent_code, branch_id, phone, email,
           resume_reference, verification_reference,
           id_proof_type, id_proof_reference,
           address_proof_type, address_proof_reference,
           emergency_contact_name, emergency_contact_phone,
           training_status, start_date, end_date, daily_cash_limit,
           status
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending'
         )
         RETURNING id`, [
                input.staffId,
                input.agentCode,
                input.branchId ?? null,
                input.phone ?? null,
                input.email ?? null,
                input.resumeReference ?? null,
                input.verificationReference ?? null,
                input.idProofType,
                input.idProofReference,
                input.addressProofType,
                input.addressProofReference,
                input.emergencyContactName ?? null,
                input.emergencyContactPhone ?? null,
                input.trainingStatus ?? null,
                input.startDate ?? null,
                input.endDate ?? null,
                input.dailyCashLimit ?? null,
            ]);
            insertedId = inserted.rows[0].id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError('Agent code is already in use', 'DUPLICATE_AGENT_CODE');
            }
            throw error;
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.AGENT_ONBOARDED,
            entityType: 'agent',
            entityId: insertedId,
            metadata: { agentCode: input.agentCode, onboardedBy: actor.staffId },
        });
        const row = await selectAgentRow(client, insertedId);
        if (!row)
            throw new NotFoundError('Agent');
        return toAgentView(row);
    });
}
/**
 * PATCH /agents/:id — update agent profile details. `status` is deliberately
 * absent from the payload (lifecycle moves use dedicated M.D. endpoints).
 * Null clears a DB-nullable column; absent leaves it unchanged.
 */
export async function updateAgent(actor, agentId, input, meta = {}) {
    return transaction(async (client) => {
        const existing = await selectAgentRow(client, agentId);
        if (!existing)
            throw new NotFoundError('Agent');
        const sets = [];
        const values = [];
        const push = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if (input.branchId !== undefined) {
            if (input.branchId !== null)
                await assertBranchExists(client, input.branchId);
            push('branch_id', input.branchId);
        }
        if (input.phone !== undefined)
            push('phone', input.phone);
        if (input.email !== undefined)
            push('email', input.email);
        if (input.resumeReference !== undefined)
            push('resume_reference', input.resumeReference);
        if (input.verificationReference !== undefined)
            push('verification_reference', input.verificationReference);
        if (input.idProofType !== undefined)
            push('id_proof_type', input.idProofType);
        if (input.idProofReference !== undefined)
            push('id_proof_reference', input.idProofReference);
        if (input.addressProofType !== undefined)
            push('address_proof_type', input.addressProofType);
        if (input.addressProofReference !== undefined)
            push('address_proof_reference', input.addressProofReference);
        if (input.emergencyContactName !== undefined)
            push('emergency_contact_name', input.emergencyContactName);
        if (input.emergencyContactPhone !== undefined)
            push('emergency_contact_phone', input.emergencyContactPhone);
        if (input.trainingStatus !== undefined)
            push('training_status', input.trainingStatus);
        if (input.startDate !== undefined)
            push('start_date', input.startDate);
        if (input.endDate !== undefined)
            push('end_date', input.endDate);
        if (input.dailyCashLimit !== undefined)
            push('daily_cash_limit', input.dailyCashLimit);
        if (sets.length > 0) {
            await client.query(`UPDATE agent SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length + 1}`, [...values, agentId]);
            await audit(client, {
                ...actorAuditBase(actor),
                requestId: meta.requestId ?? null,
                action: ACTION_AGENT_UPDATED,
                entityType: 'agent',
                entityId: agentId,
                metadata: { updatedBy: actor.staffId },
            });
        }
        const row = await selectAgentRow(client, agentId);
        if (!row)
            throw new NotFoundError('Agent');
        return toAgentView(row);
    });
}
// ---------------------------------------------------------------------------
// Agent lifecycle (spec §15.1 — M.D. decisions)
// ---------------------------------------------------------------------------
/**
 * Applies a lifecycle move inside one transaction: UPDATE agent.status + audit
 * AGENT_STATUS_CHANGED. Idempotent — moving to the current status is a no-op.
 * When `releaseAssignments` is set (deactivation) every active assignment is
 * closed (effective_to = today) and logged on agent_transfer_log as
 * 'transferred_out' (customers are transferred to another agent afterwards).
 */
async function changeAgentStatus(actor, agentId, toStatus, meta, releaseAssignments) {
    return transaction(async (client) => {
        const existing = await selectAgentRow(client, agentId);
        if (!existing)
            throw new NotFoundError('Agent');
        const fromStatus = existing.status;
        if (fromStatus === toStatus)
            return toAgentView(existing);
        await client.query('UPDATE agent SET status = $1, updated_at = now() WHERE id = $2', [
            toStatus,
            agentId,
        ]);
        if (releaseAssignments) {
            const closed = await client.query(`UPDATE agent_customer_assignment
            SET is_active = false, effective_to = CURRENT_DATE, updated_at = now()
          WHERE agent_id = $1 AND is_active
          RETURNING customer_id`, [agentId]);
            for (const assignment of closed.rows) {
                await client.query(`INSERT INTO agent_transfer_log
             (agent_id, customer_id, from_agent_id, action, reason, performed_by)
           VALUES ($1, $2, $3, 'transferred_out', $4, $5)`, [agentId, assignment.customer_id, agentId, 'Agent deactivated', actor.staffId]);
            }
            if (closed.rows.length > 0) {
                await audit(client, {
                    ...actorAuditBase(actor),
                    requestId: meta.requestId ?? null,
                    action: AUDIT_ACTIONS.AGENT_ASSIGNMENT_CHANGED,
                    entityType: 'agent',
                    entityId: agentId,
                    metadata: {
                        fromAgentId: agentId,
                        action: 'transferred_out',
                        customerCount: closed.rows.length,
                        changedBy: actor.staffId,
                    },
                });
            }
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.AGENT_STATUS_CHANGED,
            entityType: 'agent',
            entityId: agentId,
            metadata: { fromStatus, toStatus, reason: 'M.D. lifecycle decision', changedBy: actor.staffId },
        });
        const row = await selectAgentRow(client, agentId);
        if (!row)
            throw new NotFoundError('Agent');
        return toAgentView(row);
    });
}
/** POST /agents/:id/activate — M.D. activates a pending or suspended agent. */
export function activateAgent(actor, agentId, meta = {}) {
    return changeAgentStatus(actor, agentId, 'active', meta, false);
}
/** POST /agents/:id/suspend — M.D. suspends an active agent. */
export function suspendAgent(actor, agentId, meta = {}) {
    return changeAgentStatus(actor, agentId, 'suspended', meta, false);
}
/** POST /agents/:id/reactivate — M.D. reactivates a suspended agent. */
export function reactivateAgent(actor, agentId, meta = {}) {
    return changeAgentStatus(actor, agentId, 'active', meta, false);
}
/**
 * POST /agents/:id/deactivate — M.D. deactivates an agent. Active customer
 * assignments are closed and logged 'transferred_out' (spec §15.1) so the
 * customers can be reassigned to another agent.
 */
export function deactivateAgent(actor, agentId, meta = {}) {
    return changeAgentStatus(actor, agentId, 'deactivated', meta, true);
}
// ---------------------------------------------------------------------------
// Customer assignments (many-to-many — spec §15.1/§15.4)
// ---------------------------------------------------------------------------
/**
 * POST /agents/:id/assignments — assign (or re-assign) customers to an agent.
 * Re-issuing a customer closes the previous ACTIVE assignment (owned by any
 * agent) and opens a new effective one, with the move recorded on
 * agent_transfer_log as 'assigned' or 'reassigned'. One customer may be
 * assigned to several agents concurrently, but only ever one ACTIVE
 * assignment per agent per customer.
 */
export async function assignCustomers(actor, agentId, input, meta = {}) {
    return transaction(async (client) => {
        const agent = await client.query('SELECT id FROM agent WHERE id = $1', [agentId]);
        if (agent.rowCount === 0)
            throw new NotFoundError('Agent');
        const customers = await client.query('SELECT id FROM customer WHERE id = ANY($1::uuid[])', [input.customerIds]);
        if (customers.rowCount !== input.customerIds.length) {
            throw new BadRequestError('One or more customers do not exist');
        }
        const effectiveFrom = input.effectiveFrom ?? istBusinessDate();
        const assignedCustomerIds = [];
        let anyReassigned = false;
        for (const customerId of input.customerIds) {
            const active = await client.query(`SELECT id, agent_id
             FROM agent_customer_assignment
            WHERE customer_id = $1 AND is_active
            ORDER BY effective_from DESC, created_at DESC
            LIMIT 1`, [customerId]);
            const activeRow = active.rows[0];
            // Idempotent — the customer is already assigned to this agent.
            if (activeRow && activeRow.agent_id === agentId) {
                assignedCustomerIds.push(customerId);
                continue;
            }
            if (activeRow) {
                await client.query(`UPDATE agent_customer_assignment
                SET is_active = false, effective_to = $1, updated_at = now()
              WHERE id = $2`, [effectiveFrom, activeRow.id]);
                await client.query(`INSERT INTO agent_transfer_log
               (agent_id, customer_id, from_agent_id, action, reason, performed_by)
             VALUES ($1, $2, $3, 'reassigned', $4, $5)`, [agentId, customerId, activeRow.agent_id, input.reason ?? null, actor.staffId]);
                anyReassigned = true;
            }
            else {
                await client.query(`INSERT INTO agent_transfer_log
               (agent_id, customer_id, from_agent_id, action, reason, performed_by)
             VALUES ($1, $2, NULL, 'assigned', $3, $4)`, [agentId, customerId, input.reason ?? null, actor.staffId]);
            }
            await client.query(`INSERT INTO agent_customer_assignment
             (agent_id, customer_id, assigned_by, effective_from)
           VALUES ($1, $2, $3, $4)`, [agentId, customerId, actor.staffId, effectiveFrom]);
            assignedCustomerIds.push(customerId);
        }
        const action = anyReassigned ? 'reassigned' : 'assigned';
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.AGENT_ASSIGNMENT_CHANGED,
            entityType: 'agent',
            entityId: agentId,
            metadata: {
                customerIds: assignedCustomerIds,
                effectiveFrom,
                action,
                reason: input.reason ?? null,
                changedBy: actor.staffId,
            },
        });
        return { assignedCustomerIds, action };
    });
}
function toRouteExchangeView(row) {
    return {
        id: row.id,
        fromAgentId: row.from_agent_id,
        toAgentId: row.to_agent_id,
        routeId: row.route_id,
        customerIds: row.customer_ids,
        startDate: row.start_date,
        endDate: row.end_date,
        reason: row.reason,
        status: row.status,
        approvedBy: row.approved_by,
        approvedAt: iso(row.approved_at),
    };
}
/**
 * POST /agents/:id/route-exchange — M.D. approves a temporary route exchange
 * (agent `:id` hands part of its coverage to `toAgentId`). Recorded directly
 * as 'approved' on route_exchange with approved_by/approved_at.
 */
export async function requestRouteExchange(actor, agentId, input, meta = {}) {
    return transaction(async (client) => {
        const from = await client.query('SELECT id FROM agent WHERE id = $1', [agentId]);
        if (from.rowCount === 0)
            throw new NotFoundError('Agent');
        const to = await client.query('SELECT id FROM agent WHERE id = $1', [input.toAgentId]);
        if (to.rowCount === 0)
            throw new NotFoundError('Agent');
        if (input.toAgentId === agentId) {
            throw new BadRequestError('Route exchange must target a different agent');
        }
        if (input.endDate !== null && input.endDate !== undefined && input.endDate < input.startDate) {
            throw new BadRequestError('endDate cannot be before startDate');
        }
        if (input.routeId) {
            const route = await client.query('SELECT id FROM agent_route WHERE id = $1 AND is_active', [
                input.routeId,
            ]);
            if (route.rowCount === 0)
                throw new BadRequestError('Route does not exist or is inactive');
        }
        if (input.customerIds && input.customerIds.length > 0) {
            const assigned = await client.query(`SELECT customer_id
           FROM agent_customer_assignment
          WHERE agent_id = $1 AND is_active AND customer_id = ANY($2::uuid[])`, [agentId, input.customerIds]);
            if (assigned.rowCount !== input.customerIds.length) {
                throw new BusinessRuleError('All exchange customers must be currently assigned to this agent', 'CUSTOMER_NOT_ASSIGNED');
            }
        }
        const inserted = await client.query(`INSERT INTO route_exchange
         (from_agent_id, to_agent_id, route_id, customer_ids,
          start_date, end_date, reason, status, approved_by, approved_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'approved', $8, now())
       RETURNING id, from_agent_id, to_agent_id, route_id, customer_ids,
                 start_date::text, end_date::text, reason, status,
                 approved_by, approved_at`, [
            agentId,
            input.toAgentId,
            input.routeId ?? null,
            input.customerIds ?? null,
            input.startDate,
            input.endDate ?? null,
            input.reason,
            actor.staffId,
        ]);
        const row = inserted.rows[0];
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.ROUTE_EXCHANGE_APPROVED,
            entityType: 'route_exchange',
            entityId: row.id,
            metadata: {
                fromAgentId: agentId,
                toAgentId: input.toAgentId,
                routeId: input.routeId ?? null,
                customerIds: input.customerIds ?? [],
                startDate: input.startDate,
                endDate: input.endDate ?? null,
            },
        });
        return toRouteExchangeView(row);
    });
}
/**
 * POST /agents/:id/out-of-area-approval — M.D. approves collecting outside the
 * agent's normal area (spec §14.1/§15.1). No dedicated approval table exists in
 * the schema, so the decision is recorded on the audit trail with module-local
 * vocabulary (ACTION_OUT_OF_AREA_APPROVED).
 */
export async function approveOutOfArea(actor, agentId, input, meta = {}) {
    const agent = await query('SELECT id, agent_code FROM agent WHERE id = $1', [agentId]);
    if (agent.rowCount === 0)
        throw new NotFoundError('Agent');
    const businessDate = input.businessDate ?? istBusinessDate();
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: ACTION_OUT_OF_AREA_APPROVED,
        entityType: 'agent',
        entityId: agentId,
        businessDate,
        metadata: {
            customerId: input.customerId ?? null,
            businessDate,
            reason: input.reason,
            approvedBy: actor.staffId,
        },
    });
    return {
        outOfAreaApprovalRecorded: true,
        agentId,
        customerId: input.customerId ?? null,
        businessDate,
        reason: input.reason,
    };
}
/**
 * POST /agents/:id/devices/:deviceId/disable — disables a lost/stolen device.
 * The device registry is global (device.staff_id); the agent's devices are the
 * rows whose staff_id matches agent.staff_id (see the agent_device view), so
 * the UPDATE is scoped through the agent. Live sessions on that device are
 * revoked immediately (same idiom as identity.service disableDevice).
 */
export async function disableAgentDevice(actor, agentId, deviceId, input, meta = {}) {
    return transaction(async (client) => {
        const device = await client.query(`SELECT d.id, d.staff_id, d.status, d.device_name, a.agent_code
         FROM device d
         JOIN agent a ON a.staff_id = d.staff_id
        WHERE d.id = $1 AND a.id = $2`, [deviceId, agentId]);
        const deviceRow = device.rows[0];
        if (!deviceRow)
            throw new NotFoundError('Device');
        if (deviceRow.status === 'disabled') {
            throw new ConflictError('Device is already disabled', 'ALREADY_DISABLED');
        }
        await client.query(`UPDATE device
          SET status = 'disabled', disabled_at = now(), disabled_by = $2,
              disabled_reason = $3, updated_at = now()
        WHERE id = $1`, [deviceId, actor.staffId, input.reason]);
        await client.query(`UPDATE refresh_token rt
          SET revoked_at = now(), revoked_reason = $1
        WHERE rt.revoked_at IS NULL
          AND rt.session_id IN (
            SELECT ss.id FROM staff_session ss WHERE ss.device_id = $2 AND ss.revoked_at IS NULL
          )`, ['device disabled', deviceId]);
        await client.query(`UPDATE staff_session
          SET revoked_at = now(), revoked_reason = $1
        WHERE device_id = $2 AND revoked_at IS NULL`, ['device disabled', deviceId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.AUTH_DEVICE_DISABLED,
            entityType: 'device',
            entityId: deviceId,
            metadata: {
                agentId,
                agentCode: deviceRow.agent_code,
                staffId: deviceRow.staff_id,
                deviceName: deviceRow.device_name,
                disabledBy: actor.staffId,
                reason: input.reason,
            },
        });
        return {
            deviceId,
            status: 'disabled',
            disabledAt: new Date().toISOString(),
            disabledBy: actor.staffId,
            disabledReason: input.reason,
        };
    });
}
/**
 * Daily collection performance for one agent over the window, aggregated from
 * collection_entry (is_deleted = false). Money is emitted as a JSON number
 * here because the result feeds chart/aggregate views, not ledger storage.
 */
export async function getAgentPerformance(_actor, agentId, input, _meta = {}) {
    const from = input.from ?? istBusinessDate();
    const to = input.to ?? from;
    const list = await query(`SELECT ce.business_date::text AS "businessDate",
            COUNT(*)::int AS "entryCount",
            COALESCE(SUM(ce.amount), 0)::float8 AS "totalAmount",
            COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode = 'cash'), 0)::float8 AS "cashAmount",
            COALESCE(SUM(ce.amount) FILTER (WHERE ce.mode <> 'cash'), 0)::float8 AS "digitalAmount",
            COUNT(*) FILTER (WHERE ce.status = 'accepted')::int AS "acceptedCount",
            COUNT(*) FILTER (WHERE ce.status = 'waiting')::int AS "waitingCount",
            COUNT(*) FILTER (WHERE ce.status = 'rejected')::int AS "rejectedCount",
            COUNT(*) FILTER (WHERE ce.status = 'requiresReview')::int AS "requiresReviewCount",
            COUNT(*) OVER()::int AS total
       FROM collection_entry ce
      WHERE ce.agent_id = $1 AND ce.is_deleted = false
        AND ce.business_date >= $2 AND ce.business_date <= $3
      GROUP BY ce.business_date
      ORDER BY ce.business_date DESC
      LIMIT $4 OFFSET $5`, [agentId, from, to, input.limit, input.offset]);
    const summary = await query(`SELECT COUNT(DISTINCT business_date)::int AS "workingDays",
            COUNT(*)::int AS "entryCount",
            COALESCE(SUM(amount), 0)::float8 AS "totalAmount"
       FROM collection_entry
      WHERE agent_id = $1 AND is_deleted = false
        AND business_date >= $2 AND business_date <= $3`, [agentId, from, to]);
    const total = list.rows[0]?.total ?? 0;
    const summaryRow = summary.rows[0] ?? { workingDays: 0, entryCount: 0, totalAmount: 0 };
    return {
        items: list.rows.map(({ total: _omitted, ...entry }) => entry),
        total,
        summary: {
            from,
            to,
            workingDays: summaryRow.workingDays,
            entryCount: summaryRow.entryCount,
            totalAmount: summaryRow.totalAmount,
        },
    };
}
function formatAddress(row) {
    return [row.line1, row.line2, row.city, row.district, row.state, row.pincode]
        .filter((part) => part !== null && part !== undefined && part.trim() !== '')
        .join(', ');
}
/**
 * GET /agents/me/assignments — customers assigned to the signed-in agent with
 * their collectible product accounts. Field names mirror the mobile contract
 * (mobile-app/lib/core/models/customer.dart): product type values use the
 * collection_entry product_type vocabulary ('savingsDeposit',
 * 'recurringDeposit', 'loan'); customer type values use the customer_type
 * labels ('Individual', 'SHG', ...).
 */
export async function getMyAssignments(actor, _meta = {}) {
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    const customers = await query(`SELECT c.id,
            c.customer_number,
            c.customer_type,
            c.full_name,
            c.mobile,
            aca.agent_id
       FROM customer c
       JOIN agent_customer_assignment aca ON aca.customer_id = c.id
      WHERE aca.agent_id = $1
        AND aca.is_active
        AND (aca.effective_to IS NULL OR aca.effective_to >= CURRENT_DATE)
        AND c.status = 'active'
      ORDER BY c.full_name`, [agent.id]);
    if (customers.rows.length === 0)
        return [];
    const customerIds = customers.rows.map((row) => row.id);
    const addresses = await query(`SELECT customer_id, address_type, line1, line2, city, district, state, pincode
       FROM customer_address
      WHERE customer_id = ANY($1::uuid[])
      ORDER BY customer_id, address_type`, [customerIds]);
    const addressesByCustomer = new Map();
    for (const address of addresses.rows) {
        const bucket = addressesByCustomer.get(address.customer_id) ?? {};
        bucket[address.address_type] = formatAddress(address);
        addressesByCustomer.set(address.customer_id, bucket);
    }
    // Active savings accounts (no fixed installment; outstanding is 0).
    const savings = await query(`SELECT sa.id, sa.customer_id, sa.account_number
       FROM savings_account sa
      WHERE sa.customer_id = ANY($1::uuid[]) AND sa.status = 'active'`, [customerIds]);
    // Active / overdue recurring deposit accounts.
    const rd = await query(`SELECT ra.id,
            ra.customer_id,
            ra.account_number,
            ra.instalment_amount::float8 AS instalment_amount,
            ra.pending_amount::float8     AS pending_amount,
            ra.frequency
       FROM rd_account ra
      WHERE ra.customer_id = ANY($1::uuid[]) AND ra.status IN ('active', 'overdue')`, [customerIds]);
    // Active / overdue loans (installment varies by schedule; outstanding shown).
    const loans = await query(`SELECT l.id,
            l.customer_id,
            l.loan_number AS account_number,
            l.outstanding_amount::float8 AS outstanding_amount,
            l.repayment_frequency        AS frequency
       FROM loan l
      WHERE l.customer_id = ANY($1::uuid[]) AND l.status IN ('active', 'overdue')`, [customerIds]);
    const productsByCustomer = new Map();
    for (const row of savings.rows) {
        const bucket = productsByCustomer.get(row.customer_id) ?? [];
        bucket.push({
            id: row.id,
            type: 'savingsDeposit',
            accountNumber: row.account_number,
            installmentAmount: 0,
            outstandingAmount: 0,
            frequency: null,
        });
        productsByCustomer.set(row.customer_id, bucket);
    }
    for (const row of rd.rows) {
        const bucket = productsByCustomer.get(row.customer_id) ?? [];
        bucket.push({
            id: row.id,
            type: 'recurringDeposit',
            accountNumber: row.account_number,
            installmentAmount: row.instalment_amount,
            outstandingAmount: row.pending_amount ?? 0,
            frequency: row.frequency,
        });
        productsByCustomer.set(row.customer_id, bucket);
    }
    for (const row of loans.rows) {
        const bucket = productsByCustomer.get(row.customer_id) ?? [];
        bucket.push({
            id: row.id,
            type: 'loan',
            accountNumber: row.account_number,
            installmentAmount: 0,
            outstandingAmount: row.outstanding_amount ?? 0,
            frequency: row.frequency,
        });
        productsByCustomer.set(row.customer_id, bucket);
    }
    return customers.rows.map((row) => ({
        id: row.id,
        name: row.full_name,
        accountNumber: row.customer_number ?? row.id,
        type: row.customer_type,
        phone: row.mobile,
        addresses: addressesByCustomer.get(row.id) ?? {},
        products: productsByCustomer.get(row.id) ?? [],
        assignedAgentId: row.agent_id,
    }));
}
const DAY_TOTALS_SQL = `
  SELECT COALESCE(SUM(amount), 0)::float8 AS "totalAmount",
         COUNT(*)::int AS "entryCount",
         COALESCE(SUM(amount) FILTER (WHERE mode = 'cash'), 0)::float8 AS "cashAmount",
         COALESCE(SUM(amount) FILTER (WHERE mode <> 'cash'), 0)::float8 AS "digitalAmount",
         0::int AS "queuedCount",
         COUNT(*) FILTER (WHERE status = 'waiting')::int AS "waitingCount",
         COUNT(*) FILTER (WHERE status = 'rejected')::int AS "rejectedCount"
    FROM collection_entry
   WHERE agent_id = $1 AND business_date = $2 AND is_deleted = false`;
function toDayTotalsView(businessDate, row) {
    return {
        businessDate,
        totalAmount: row.totalAmount,
        entryCount: row.entryCount,
        cashAmount: row.cashAmount,
        digitalAmount: row.digitalAmount,
        queuedCount: row.queuedCount,
        waitingCount: row.waitingCount,
        rejectedCount: row.rejectedCount,
    };
}
/**
 * GET /agents/me/day-totals — today's collections from collection_entry for the
 * signed-in agent (spec §16.3). `queuedCount` is always 0 server-side: queued
 * entries are device-local and only reach the server after submission.
 */
export async function getMyDayTotals(actor, input, _meta = {}) {
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    const businessDate = input.businessDate ?? istBusinessDate();
    const result = await query(DAY_TOTALS_SQL, [agent.id, businessDate]);
    const row = result.rows[0] ?? {
        totalAmount: 0,
        entryCount: 0,
        cashAmount: 0,
        digitalAmount: 0,
        queuedCount: 0,
        waitingCount: 0,
        rejectedCount: 0,
    };
    return toDayTotalsView(businessDate, row);
}
/**
 * POST /agents/me/day-close — submits the day close (spec §16.3/§16.5).
 * Guards: (a) only an active agent may close; (b) never after the 17:00 IST
 * submission deadline; (c) a day already in submitted/closed/locked cannot be
 * re-submitted. The computed totals are snapshotted onto day_close (UNIQUE
 * agent_id + business_date) and the submission is audited with
 * DAY_CLOSE_SUBMITTED in the same transaction.
 *
 * Queued (device-local) entries never reach the server — the mobile app is
 * responsible for syncing every queued entry before calling this endpoint, and
 * blocks locally while queued entries remain (mobile day_close_controller).
 */
export async function submitDayClose(actor, input, meta = {}) {
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    const businessDate = input.businessDate ?? istBusinessDate();
    if (isPastIstDeadline(SUBMISSION_DEADLINE_HOUR)) {
        throw new DeadlineExceededError(`Day close must be submitted before ${SUBMISSION_DEADLINE_HOUR}:00 IST`);
    }
    return transaction(async (client) => {
        const existing = await client.query(`SELECT id, status FROM day_close WHERE agent_id = $1 AND business_date = $2`, [agent.id, businessDate]);
        const existingRow = existing.rows[0];
        if (existingRow && ['submitted', 'closed', 'locked'].includes(existingRow.status)) {
            throw new ConflictError(`Day close is already ${existingRow.status} for ${businessDate}`, 'DAY_ALREADY_CLOSED');
        }
        const totalsResult = await client.query(DAY_TOTALS_SQL, [
            agent.id,
            businessDate,
        ]);
        const totalsRow = totalsResult.rows[0] ?? {
            totalAmount: 0,
            entryCount: 0,
            cashAmount: 0,
            digitalAmount: 0,
            queuedCount: 0,
            waitingCount: 0,
            rejectedCount: 0,
        };
        const upserted = await client.query(`INSERT INTO day_close
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
       RETURNING id, submitted_at`, [
            agent.id,
            businessDate,
            totalsRow.totalAmount,
            totalsRow.entryCount,
            totalsRow.cashAmount,
            totalsRow.digitalAmount,
            totalsRow.queuedCount,
            totalsRow.waitingCount,
            totalsRow.rejectedCount,
        ]);
        const dayCloseRow = upserted.rows[0];
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.DAY_CLOSE_SUBMITTED,
            entityType: 'day_close',
            entityId: dayCloseRow.id,
            businessDate,
            metadata: {
                agentId: agent.id,
                agentCode: agent.agent_code,
                ...totalsRow,
            },
        });
        return {
            businessDate,
            submitted: true,
            submittedAt: iso(dayCloseRow.submitted_at) ?? new Date().toISOString(),
            totals: toDayTotalsView(businessDate, totalsRow),
        };
    });
}
/**
 * POST /agents/me/field-verifications — records a physical (in-person) field
 * verification of an active customer's address by the signed-in collection
 * agent (spec §8.1 — "Address proof + field verification ... performed by
 * collection field agent"). Writes one field_verification row and audits with
 * a module-local action in the same transaction. The customer must exist and
 * be active; no assignment coupling is enforced because a newly registered
 * customer is verified in the field before being assigned to a route.
 */
export async function recordFieldVerification(actor, input, meta = {}) {
    const agent = await resolveAgent(actor);
    assertAgentOperational(agent);
    const verificationDate = input.verificationDate ?? istBusinessDate();
    return transaction(async (client) => {
        const customerResult = await client.query(`SELECT status FROM customer WHERE id = $1`, [input.customerId]);
        const customer = customerResult.rows[0];
        if (!customer)
            throw new NotFoundError('Customer');
        if (customer.status !== 'active') {
            throw new BusinessRuleError(`Field verification can only be recorded against an active customer (status is ${customer.status})`, 'CUSTOMER_NOT_ACTIVE');
        }
        const inserted = await client.query(`INSERT INTO field_verification
         (customer_id, agent_id, verification_date, address_verified, outcome, remarks)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, verification_date::text AS verification_date, created_at`, [
            input.customerId,
            agent.id,
            verificationDate,
            input.addressVerified,
            input.outcome ?? null,
            input.remarks ?? null,
        ]);
        const row = inserted.rows[0];
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_FIELD_VERIFICATION_RECORDED,
            entityType: 'field_verification',
            entityId: row.id,
            metadata: {
                customerId: input.customerId,
                agentId: agent.id,
                agentCode: agent.agent_code,
                verificationDate,
                addressVerified: input.addressVerified,
                outcome: input.outcome ?? null,
            },
        });
        return {
            id: row.id,
            customerId: input.customerId,
            agentId: agent.id,
            verificationDate: row.verification_date,
            addressVerified: input.addressVerified,
            outcome: input.outcome ?? null,
            remarks: input.remarks ?? null,
            createdAt: iso(row.created_at) ?? row.created_at.toISOString(),
        };
    });
}
