import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, } from '../../audit/audit-writer.js';
import { istBusinessDate, addDays } from '../../core/time.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
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
// ---------------------------------------------------------------------------
// Mappers
// ---------------------------------------------------------------------------
function toTemplateView(row) {
    return {
        id: row.id,
        eventType: row.event_type,
        channel: row.channel,
        language: row.language,
        templateBody: row.template_body,
        isMandatory: row.is_mandatory,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
function toOutboxView(row) {
    return {
        id: row.id,
        templateId: row.template_id,
        eventType: row.event_type,
        channel: row.channel,
        customerId: row.customer_id,
        staffId: row.staff_id,
        recipient: row.recipient,
        payload: row.payload,
        consentRequired: row.consent_required,
        consentVerified: row.consent_verified,
        status: row.status,
        scheduledAt: row.scheduled_at.toISOString(),
        sentAt: row.sent_at ? row.sent_at.toISOString() : null,
        retryCount: row.retry_count,
        lastError: row.last_error,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
// ---------------------------------------------------------------------------
// Template administration
// ---------------------------------------------------------------------------
/**
 * Lists notification templates, newest-first. The page total is fetched with a
 * window COUNT(*) OVER() so one round trip serves both items and the total.
 */
export async function listTemplates(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        clauses.push(clause);
        params.push(value);
    };
    if (input.eventType !== undefined)
        push(`event_type = $${params.length + 1}`, input.eventType);
    if (input.channel !== undefined)
        push(`channel = $${params.length + 1}`, input.channel);
    if (input.language !== undefined)
        push(`language = $${params.length + 1}`, input.language);
    if (input.isActive !== undefined) {
        push(`is_active = $${params.length + 1}`, input.isActive === 'true');
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT id, event_type, channel, language, template_body,
            is_mandatory, is_active, created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM notification_template
       ${whereSql}
      ORDER BY event_type, channel, language
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
    const rows = result.rows;
    const items = rows.map((row) => toTemplateView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total, page, pageSize };
}
/**
 * Creates a template. Duplicate (event_type, channel, language) rows are
 * rejected by the UNIQUE constraint — surfaced as a ConflictError.
 */
export async function createTemplate(actor, input, meta) {
    const created = await transaction(async (client) => {
        const result = await client.query(`INSERT INTO notification_template
         (event_type, channel, language, template_body, is_mandatory, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_type, channel, language, template_body,
                 is_mandatory, is_active, created_at, updated_at`, [
            input.eventType,
            input.channel,
            input.language,
            input.templateBody,
            input.isMandatory,
            input.isActive,
        ]);
        const row = result.rows[0];
        if (!row)
            throw new BadRequestError('Template was not created');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'notifications.template.created',
            entityType: 'notification_template',
            entityId: row.id,
            metadata: {
                eventType: row.event_type,
                channel: row.channel,
                language: row.language,
                isMandatory: row.is_mandatory,
            },
        });
        return row;
    }).catch((error) => {
        if (isUniqueViolation(error)) {
            throw new ConflictError(`A template for ${input.eventType} on ${input.channel} (${input.language}) already exists`);
        }
        throw error;
    });
    return toTemplateView(created);
}
/**
 * Updates a template. Mandatory templates can never be deactivated or demoted
 * (spec §18.1 — transaction-balance and approval messages are required), so
 * those fields are rejected with a BadRequestError.
 */
export async function updateTemplate(actor, templateId, input, meta) {
    const updated = await transaction(async (client) => {
        const current = await client.query(`SELECT id, event_type, channel, language, template_body,
              is_mandatory, is_active, created_at, updated_at
         FROM notification_template
        WHERE id = $1`, [templateId]);
        const existing = current.rows[0];
        if (!existing)
            throw new NotFoundError('Notification template not found');
        if (existing.is_mandatory && input.isActive === false) {
            throw new BadRequestError('Mandatory templates cannot be deactivated (spec §18.1)');
        }
        if (existing.is_mandatory && input.isMandatory === false) {
            throw new BadRequestError('Mandatory templates cannot be demoted to non-mandatory (spec §18.1)');
        }
        const sets = [];
        const params = [];
        const push = (column, value) => {
            sets.push(`${column} = $${params.length + 1}`);
            params.push(value);
        };
        if (input.templateBody !== undefined)
            push('template_body', input.templateBody);
        if (input.isActive !== undefined)
            push('is_active', input.isActive);
        if (input.isMandatory !== undefined)
            push('is_mandatory', input.isMandatory);
        params.push(templateId);
        const result = await client.query(`UPDATE notification_template
          SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
       RETURNING id, event_type, channel, language, template_body,
                 is_mandatory, is_active, created_at, updated_at`, params);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Notification template not found');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'notifications.template.updated',
            entityType: 'notification_template',
            entityId: row.id,
            metadata: { changes: input },
        });
        return row;
    });
    return toTemplateView(updated);
}
// ---------------------------------------------------------------------------
// Outbox & delivery history
// ---------------------------------------------------------------------------
/**
 * Lists outbox rows newest-first, optionally filtered by status / event /
 * channel / actor and a half-open IST day range on scheduled_at.
 */
export async function listOutbox(_actor, input, _meta) {
    const clauses = [];
    const params = [];
    const push = (clause, value) => {
        clauses.push(clause);
        params.push(value);
    };
    if (input.status !== undefined)
        push(`status = $${params.length + 1}`, input.status);
    if (input.eventType !== undefined)
        push(`event_type = $${params.length + 1}`, input.eventType);
    if (input.channel !== undefined)
        push(`channel = $${params.length + 1}`, input.channel);
    if (input.customerId !== undefined) {
        push(`customer_id = $${params.length + 1}::uuid`, input.customerId);
    }
    if (input.staffId !== undefined)
        push(`staff_id = $${params.length + 1}::uuid`, input.staffId);
    if (input.from !== undefined) {
        push(`scheduled_at >= $${params.length + 1}::timestamptz`, `${input.from}T00:00:00+05:30`);
    }
    if (input.to !== undefined) {
        push(`scheduled_at < $${params.length + 1}::timestamptz`, `${addDays(input.to, 1)}T00:00:00+05:30`);
    }
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
    const { page, pageSize } = input;
    const offset = (page - 1) * pageSize;
    const result = await query(`SELECT id, template_id, event_type, channel, customer_id, staff_id,
            recipient, payload, consent_required, consent_verified, status,
            scheduled_at, sent_at, retry_count, last_error, created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM notification_outbox
       ${whereSql}
      ORDER BY scheduled_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pageSize, offset]);
    const rows = result.rows;
    const items = rows.map((row) => toOutboxView(row));
    const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
    return { items, total, page, pageSize };
}
/**
 * Returns a single outbox item with its delivery history (spec §18.1 — the
 * 30-day retention window is enforced by the retention policy outside this
 * module; the delivery_log rows are read as-is).
 */
export async function getOutboxDetail(_actor, outboxId, _meta) {
    const itemResult = await query(`SELECT id, template_id, event_type, channel, customer_id, staff_id,
            recipient, payload, consent_required, consent_verified, status,
            scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
       FROM notification_outbox
      WHERE id = $1`, [outboxId]);
    const row = itemResult.rows[0];
    if (!row)
        throw new NotFoundError('Notification outbox item not found');
    const logResult = await query(`SELECT id, outbox_id, delivered_at, status, gateway_response, created_at
       FROM notification_delivery_log
      WHERE outbox_id = $1
      ORDER BY delivered_at DESC, id DESC`, [outboxId]);
    const deliveryLog = logResult.rows.map((logRow) => ({
        id: logRow.id,
        outboxId: logRow.outbox_id,
        deliveredAt: logRow.delivered_at.toISOString(),
        status: logRow.status,
        gatewayResponse: logRow.gateway_response,
        createdAt: logRow.created_at.toISOString(),
    }));
    return { ...toOutboxView(row), deliveryLog };
}
// ---------------------------------------------------------------------------
// Outbox actions — retry & cancel
// ---------------------------------------------------------------------------
/**
 * Retries a failed or skipped outbox item: resets the status to queued so the
 * delivery worker picks it up again. Items in a terminal delivered state cannot
 * be retried.
 */
export async function retryOutboxItem(actor, outboxId, meta) {
    const updated = await transaction(async (client) => {
        const current = await client.query(`SELECT id, template_id, event_type, channel, customer_id, staff_id,
              recipient, payload, consent_required, consent_verified, status,
              scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
         FROM notification_outbox
        WHERE id = $1`, [outboxId]);
        const existing = current.rows[0];
        if (!existing)
            throw new NotFoundError('Notification outbox item not found');
        if (existing.status !== 'failed' && existing.status !== 'skipped') {
            throw new BadRequestError(`Only failed or skipped items can be retried (current status: ${existing.status})`);
        }
        const result = await client.query(`UPDATE notification_outbox
          SET status = 'queued',
              retry_count = retry_count + 1,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
       RETURNING id, template_id, event_type, channel, customer_id, staff_id,
                 recipient, payload, consent_required, consent_verified, status,
                 scheduled_at, sent_at, retry_count, last_error, created_at, updated_at`, [outboxId]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Notification outbox item not found');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'notifications.outbox.retried',
            entityType: 'notification_outbox',
            entityId: row.id,
            metadata: { previousStatus: existing.status, retryCount: row.retry_count },
        });
        return row;
    });
    return toOutboxView(updated);
}
/**
 * Cancels a queued outbox item (status -> skipped, spec §18). Only items that
 * have not left the queue can be cancelled; already-sent items cannot be
 * recalled.
 */
export async function cancelOutboxItem(actor, outboxId, meta) {
    const updated = await transaction(async (client) => {
        const current = await client.query(`SELECT id, template_id, event_type, channel, customer_id, staff_id,
              recipient, payload, consent_required, consent_verified, status,
              scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
         FROM notification_outbox
        WHERE id = $1`, [outboxId]);
        const existing = current.rows[0];
        if (!existing)
            throw new NotFoundError('Notification outbox item not found');
        if (existing.status !== 'queued') {
            throw new BadRequestError(`Only queued items can be cancelled (current status: ${existing.status})`);
        }
        const result = await client.query(`UPDATE notification_outbox
          SET status = 'skipped',
              last_error = 'cancelled by staff',
              updated_at = now()
        WHERE id = $1
       RETURNING id, template_id, event_type, channel, customer_id, staff_id,
                 recipient, payload, consent_required, consent_verified, status,
                 scheduled_at, sent_at, retry_count, last_error, created_at, updated_at`, [outboxId]);
        const row = result.rows[0];
        if (!row)
            throw new NotFoundError('Notification outbox item not found');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: 'notifications.outbox.cancelled',
            entityType: 'notification_outbox',
            entityId: row.id,
            metadata: { previousStatus: existing.status },
        });
        return row;
    });
    return toOutboxView(updated);
}
/**
 * Writes a notification_outbox row. Intended to be called with a PoolClient
 * inside the CALLER's transaction so a notification enqueues atomically with
 * the business mutation that triggers it (spec §6.3 same-transaction rule).
 * No audit event is written here — the caller's mutation owns the audit trail
 * and records the notification alongside its own action.
 */
export async function enqueueNotification(client, input) {
    const result = await client.query(`INSERT INTO notification_outbox
       (template_id, event_type, channel, customer_id, staff_id, recipient,
        payload, consent_required, consent_verified, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`, [
        input.templateId ?? null,
        input.eventType,
        input.channel,
        input.customerId ?? null,
        input.staffId ?? null,
        input.recipient,
        input.payload ?? {},
        input.consentRequired ?? false,
        input.consentVerified ?? false,
        input.scheduledAt ?? new Date(),
    ]);
    const row = result.rows[0];
    if (!row)
        throw new BadRequestError('Notification was not enqueued');
    return { id: row.id };
}
