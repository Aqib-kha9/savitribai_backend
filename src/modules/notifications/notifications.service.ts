import type { PoolClient } from 'pg';
import { query, transaction } from '../../database/client.js';
import {
  appendAuditEvent,
  type AuditEventInput,
} from '../../audit/audit-writer.js';
import { istBusinessDate, addDays } from '../../core/time.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import type {
  CreateTemplateInput,
  ListOutboxQuery,
  ListTemplatesQuery,
  NotificationChannel,
  NotificationEventType,
  NotificationStatus,
  UpdateTemplateInput,
} from './notifications.schemas.js';

/**
 * Notifications service (docs/backend-master-spec.md §18).
 *
 * Implements the notification OUTBOX as an administration surface:
 *   - template CRUD over notification_template (unique event/channel/language);
 *   - outbox listing / detail with the delivery history
 *     (notification_delivery_log) and retry / cancel actions.
 *
 * Delivery itself is intentionally OUT OF SCOPE here: no real gateway is wired
 * in this codebase, so the worker contract is expressed via the outbox rows
 * (status queued -> sending -> sent/failed/skipped) and the delivery log, which
 * the platform team can connect to any provider. `enqueueNotification` is the
 * public helper business modules use to write a delivery row atomically with
 * their own mutation (spec §6.3 same-transaction guarantee).
 *
 * Mandatory templates (is_mandatory) cannot be deactivated or demoted — the
 * transaction-balance and approval messages are legally required (§18.1).
 */

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface NotificationTemplateView {
  id: string;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  language: string;
  templateBody: string;
  isMandatory: boolean;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TemplateListResult {
  items: NotificationTemplateView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface OutboxItemView {
  id: string;
  templateId: string | null;
  eventType: NotificationEventType;
  channel: NotificationChannel;
  customerId: string | null;
  staffId: string | null;
  recipient: string;
  payload: Record<string, unknown>;
  consentRequired: boolean;
  consentVerified: boolean;
  status: NotificationStatus;
  scheduledAt: string;
  sentAt: string | null;
  retryCount: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface OutboxListResult {
  items: OutboxItemView[];
  total: number;
  page: number;
  pageSize: number;
}

export interface DeliveryLogEntryView {
  id: string;
  outboxId: string;
  deliveredAt: string;
  status: 'delivered' | 'failed' | 'bounced';
  gatewayResponse: string | null;
  createdAt: string;
}

export interface OutboxDetailView extends OutboxItemView {
  deliveryLog: DeliveryLogEntryView[];
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type TemplateRow = {
  id: string;
  event_type: NotificationEventType;
  channel: NotificationChannel;
  language: string;
  template_body: string;
  is_mandatory: boolean;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type OutboxRow = {
  id: string;
  template_id: string | null;
  event_type: NotificationEventType;
  channel: NotificationChannel;
  customer_id: string | null;
  staff_id: string | null;
  recipient: string;
  payload: Record<string, unknown>;
  consent_required: boolean;
  consent_verified: boolean;
  status: NotificationStatus;
  scheduled_at: Date;
  sent_at: Date | null;
  retry_count: number;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
};

type DeliveryLogRow = {
  id: string;
  outbox_id: string;
  delivered_at: Date;
  status: 'delivered' | 'failed' | 'bounced';
  gateway_response: string | null;
  created_at: Date;
};

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

/** Autocommit audit bridge used on the few read paths that still audit. */
function poolForEvent(): PoolClient {
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
// Mappers
// ---------------------------------------------------------------------------

function toTemplateView(row: TemplateRow): NotificationTemplateView {
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

function toOutboxView(row: OutboxRow): OutboxItemView {
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
export async function listTemplates(
  _actor: AuthContext,
  input: ListTemplatesQuery,
  _meta: RequestMeta,
): Promise<TemplateListResult> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    clauses.push(clause);
    params.push(value);
  };

  if (input.eventType !== undefined) push(`event_type = $${params.length + 1}`, input.eventType);
  if (input.channel !== undefined) push(`channel = $${params.length + 1}`, input.channel);
  if (input.language !== undefined) push(`language = $${params.length + 1}`, input.language);
  if (input.isActive !== undefined) {
    push(`is_active = $${params.length + 1}`, input.isActive === 'true');
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const { page, pageSize } = input;
  const offset = (page - 1) * pageSize;

  type Row = TemplateRow & { total_count: string };
  const result = await query<Row>(
    `SELECT id, event_type, channel, language, template_body,
            is_mandatory, is_active, created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM notification_template
       ${whereSql}
      ORDER BY event_type, channel, language
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );

  const rows = result.rows;
  const items = rows.map((row) => toTemplateView(row));
  const total = rows.length > 0 ? Number(rows[0]?.total_count ?? 0) : 0;
  return { items, total, page, pageSize };
}

/**
 * Creates a template. Duplicate (event_type, channel, language) rows are
 * rejected by the UNIQUE constraint — surfaced as a ConflictError.
 */
export async function createTemplate(
  actor: AuthContext,
  input: CreateTemplateInput,
  meta: RequestMeta,
): Promise<NotificationTemplateView> {
  const created = await transaction<TemplateRow>(async (client) => {
    const result = await client.query<TemplateRow>(
      `INSERT INTO notification_template
         (event_type, channel, language, template_body, is_mandatory, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, event_type, channel, language, template_body,
                 is_mandatory, is_active, created_at, updated_at`,
      [
        input.eventType,
        input.channel,
        input.language,
        input.templateBody,
        input.isMandatory,
        input.isActive,
      ],
    );
    const row = result.rows[0];
    if (!row) throw new BadRequestError('Template was not created');

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
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) {
      throw new ConflictError(
        `A template for ${input.eventType} on ${input.channel} (${input.language}) already exists`,
      );
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
export async function updateTemplate(
  actor: AuthContext,
  templateId: string,
  input: UpdateTemplateInput,
  meta: RequestMeta,
): Promise<NotificationTemplateView> {
  const updated = await transaction<TemplateRow>(async (client) => {
    const current = await client.query<TemplateRow>(
      `SELECT id, event_type, channel, language, template_body,
              is_mandatory, is_active, created_at, updated_at
         FROM notification_template
        WHERE id = $1`,
      [templateId],
    );
    const existing = current.rows[0];
    if (!existing) throw new NotFoundError('Notification template not found');

    if (existing.is_mandatory && input.isActive === false) {
      throw new BadRequestError(
        'Mandatory templates cannot be deactivated (spec §18.1)',
      );
    }
    if (existing.is_mandatory && input.isMandatory === false) {
      throw new BadRequestError(
        'Mandatory templates cannot be demoted to non-mandatory (spec §18.1)',
      );
    }

    const sets: string[] = [];
    const params: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      sets.push(`${column} = $${params.length + 1}`);
      params.push(value);
    };

    if (input.templateBody !== undefined) push('template_body', input.templateBody);
    if (input.isActive !== undefined) push('is_active', input.isActive);
    if (input.isMandatory !== undefined) push('is_mandatory', input.isMandatory);

    params.push(templateId);
    const result = await client.query<TemplateRow>(
      `UPDATE notification_template
          SET ${sets.join(', ')}, updated_at = now()
        WHERE id = $${params.length}
       RETURNING id, event_type, channel, language, template_body,
                 is_mandatory, is_active, created_at, updated_at`,
      params,
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Notification template not found');

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
export async function listOutbox(
  _actor: AuthContext,
  input: ListOutboxQuery,
  _meta: RequestMeta,
): Promise<OutboxListResult> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const push = (clause: string, value: unknown): void => {
    clauses.push(clause);
    params.push(value);
  };

  if (input.status !== undefined) push(`status = $${params.length + 1}`, input.status);
  if (input.eventType !== undefined) push(`event_type = $${params.length + 1}`, input.eventType);
  if (input.channel !== undefined) push(`channel = $${params.length + 1}`, input.channel);
  if (input.customerId !== undefined) {
    push(`customer_id = $${params.length + 1}::uuid`, input.customerId);
  }
  if (input.staffId !== undefined) push(`staff_id = $${params.length + 1}::uuid`, input.staffId);
  if (input.from !== undefined) {
    push(
      `scheduled_at >= $${params.length + 1}::timestamptz`,
      `${input.from}T00:00:00+05:30`,
    );
  }
  if (input.to !== undefined) {
    push(
      `scheduled_at < $${params.length + 1}::timestamptz`,
      `${addDays(input.to, 1)}T00:00:00+05:30`,
    );
  }

  const whereSql = clauses.length > 0 ? `WHERE ${clauses.join('\n  AND ')}` : '';
  const { page, pageSize } = input;
  const offset = (page - 1) * pageSize;

  type Row = OutboxRow & { total_count: string };
  const result = await query<Row>(
    `SELECT id, template_id, event_type, channel, customer_id, staff_id,
            recipient, payload, consent_required, consent_verified, status,
            scheduled_at, sent_at, retry_count, last_error, created_at, updated_at,
            COUNT(*) OVER() AS total_count
       FROM notification_outbox
       ${whereSql}
      ORDER BY scheduled_at DESC, id DESC
      LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, pageSize, offset],
  );

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
export async function getOutboxDetail(
  _actor: AuthContext,
  outboxId: string,
  _meta: RequestMeta,
): Promise<OutboxDetailView> {
  const itemResult = await query<OutboxRow>(
    `SELECT id, template_id, event_type, channel, customer_id, staff_id,
            recipient, payload, consent_required, consent_verified, status,
            scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
       FROM notification_outbox
      WHERE id = $1`,
    [outboxId],
  );
  const row = itemResult.rows[0];
  if (!row) throw new NotFoundError('Notification outbox item not found');

  const logResult = await query<DeliveryLogRow>(
    `SELECT id, outbox_id, delivered_at, status, gateway_response, created_at
       FROM notification_delivery_log
      WHERE outbox_id = $1
      ORDER BY delivered_at DESC, id DESC`,
    [outboxId],
  );

  const deliveryLog = logResult.rows.map((logRow): DeliveryLogEntryView => ({
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
export async function retryOutboxItem(
  actor: AuthContext,
  outboxId: string,
  meta: RequestMeta,
): Promise<OutboxItemView> {
  const updated = await transaction<OutboxRow>(async (client) => {
    const current = await client.query<OutboxRow>(
      `SELECT id, template_id, event_type, channel, customer_id, staff_id,
              recipient, payload, consent_required, consent_verified, status,
              scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
         FROM notification_outbox
        WHERE id = $1`,
      [outboxId],
    );
    const existing = current.rows[0];
    if (!existing) throw new NotFoundError('Notification outbox item not found');

    if (existing.status !== 'failed' && existing.status !== 'skipped') {
      throw new BadRequestError(
        `Only failed or skipped items can be retried (current status: ${existing.status})`,
      );
    }

    const result = await client.query<OutboxRow>(
      `UPDATE notification_outbox
          SET status = 'queued',
              retry_count = retry_count + 1,
              last_error = NULL,
              updated_at = now()
        WHERE id = $1
       RETURNING id, template_id, event_type, channel, customer_id, staff_id,
                 recipient, payload, consent_required, consent_verified, status,
                 scheduled_at, sent_at, retry_count, last_error, created_at, updated_at`,
      [outboxId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Notification outbox item not found');

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
export async function cancelOutboxItem(
  actor: AuthContext,
  outboxId: string,
  meta: RequestMeta,
): Promise<OutboxItemView> {
  const updated = await transaction<OutboxRow>(async (client) => {
    const current = await client.query<OutboxRow>(
      `SELECT id, template_id, event_type, channel, customer_id, staff_id,
              recipient, payload, consent_required, consent_verified, status,
              scheduled_at, sent_at, retry_count, last_error, created_at, updated_at
         FROM notification_outbox
        WHERE id = $1`,
      [outboxId],
    );
    const existing = current.rows[0];
    if (!existing) throw new NotFoundError('Notification outbox item not found');

    if (existing.status !== 'queued') {
      throw new BadRequestError(
        `Only queued items can be cancelled (current status: ${existing.status})`,
      );
    }

    const result = await client.query<OutboxRow>(
      `UPDATE notification_outbox
          SET status = 'skipped',
              last_error = 'cancelled by staff',
              updated_at = now()
        WHERE id = $1
       RETURNING id, template_id, event_type, channel, customer_id, staff_id,
                 recipient, payload, consent_required, consent_verified, status,
                 scheduled_at, sent_at, retry_count, last_error, created_at, updated_at`,
      [outboxId],
    );
    const row = result.rows[0];
    if (!row) throw new NotFoundError('Notification outbox item not found');

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

// ---------------------------------------------------------------------------
// Enqueue helper (used by business modules inside their own transactions)
// ---------------------------------------------------------------------------

export interface EnqueueNotificationInput {
  eventType: NotificationEventType;
  channel: NotificationChannel;
  recipient: string;
  templateId?: string | null;
  customerId?: string | null;
  staffId?: string | null;
  payload?: Record<string, unknown>;
  consentRequired?: boolean;
  consentVerified?: boolean;
  scheduledAt?: Date;
}

/**
 * Writes a notification_outbox row. Intended to be called with a PoolClient
 * inside the CALLER's transaction so a notification enqueues atomically with
 * the business mutation that triggers it (spec §6.3 same-transaction rule).
 * No audit event is written here — the caller's mutation owns the audit trail
 * and records the notification alongside its own action.
 */
export async function enqueueNotification(
  client: PoolClient,
  input: EnqueueNotificationInput,
): Promise<{ id: string }> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO notification_outbox
       (template_id, event_type, channel, customer_id, staff_id, recipient,
        payload, consent_required, consent_verified, scheduled_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
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
    ],
  );
  const row = result.rows[0];
  if (!row) throw new BadRequestError('Notification was not enqueued');
  return { id: row.id };
}