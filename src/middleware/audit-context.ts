import type { Request } from 'express';
import { istBusinessDate } from '../core/time.js';
import type { AuditEventInput } from '../audit/audit-writer.js';

/**
 * Audit request context (docs/backend-master-spec.md §21).
 *
 * Modules write audit events in the SAME transaction as the mutation they
 * describe via appendAuditEvent(client, event). These helpers derive the actor
 * / channel / request / business-date fields from the authenticated request so
 * handlers only supply `action`, `entityType`, `entityId` and `metadata`.
 */

export function auditEventFrom(
  request: Request,
  action: string,
  entityType: string,
  extra: { entityId?: string | null; metadata?: Record<string, unknown> } = {},
): AuditEventInput {
  const auth = request.auth;
  const event: AuditEventInput = {
    actorStaffId: auth?.staffId ?? null,
    actorRole: auth?.role ?? null,
    actorStaffCode: auth?.staffCode ?? null,
    action,
    entityType,
    entityId: extra.entityId ?? null,
    source: auth?.source ?? 'system',
    requestId: request.id ?? null,
    businessDate: istBusinessDate(),
  };
  if (extra.metadata !== undefined) event.metadata = extra.metadata;
  return event;
}
