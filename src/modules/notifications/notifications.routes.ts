import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  cancelOutboxItem,
  createTemplate,
  getOutboxDetail,
  listOutbox,
  listTemplates,
  retryOutboxItem,
  updateTemplate,
} from './notifications.service.js';
import type { RequestMeta } from './notifications.service.js';
import {
  createTemplateSchema,
  listOutboxQuerySchema,
  listTemplatesQuerySchema,
  outboxIdParamSchema,
  templateIdParamSchema,
  updateTemplateSchema,
} from './notifications.schemas.js';
import type {
  CreateTemplateInput,
  ListOutboxQuery,
  ListTemplatesQuery,
  OutboxIdParam,
  TemplateIdParam,
  UpdateTemplateInput,
} from './notifications.schemas.js';

/**
 * Notifications HTTP surface (docs/backend-master-spec.md §18).
 *
 * Mounted at /api/v1/notifications. There is no notification-specific
 * permission in the 25-permission matrix (core/permissions.ts), so these routes
 * reuse the closest operational pair:
 *   - template administration and outbox admin actions reuse settings.write
 *     (the operational-preferences permission);
 *   - read surfaces reuse settings.read.
 *
 * The enqueue path is intentionally NOT exposed over HTTP: business modules
 * write outbox rows inside their own transaction via enqueueNotification()
 * (spec §6.3 same-transaction guarantee), and a worker drains the queue. This
 * module only administers templates and the outbox.
 */

/**
 * The `authenticate` middleware guarantees `request.auth` is present once the
 * chain reaches the handler; this narrows the optional type for TypeScript and
 * guards against a future chain reorder.
 */
function authOf(request: Request): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

/** Builds service-layer RequestMeta from the live request. */
function requestMeta(request: Request): RequestMeta {
  const meta: RequestMeta = {};
  const ip = request.ip;
  if (ip) meta.ipAddress = ip;
  const userAgent = request.get('user-agent');
  if (userAgent) meta.userAgent = userAgent;
  if (request.id) meta.requestId = request.id;
  return meta;
}

export const notificationsRouter = Router();

// ---------------------------------------------------------------------------
// Template administration (settings.write for mutations, settings.read to view)
// ---------------------------------------------------------------------------

// GET /api/v1/notifications/templates — list / filter templates.
notificationsRouter.get(
  '/templates',
  authenticate,
  requirePermission('settings.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(listTemplatesQuerySchema, request.query) as ListTemplatesQuery;
    const result = await listTemplates(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/notifications/templates — create a template.
notificationsRouter.post(
  '/templates',
  authenticate,
  requirePermission('settings.write'),
  async (request, response) => {
    const actor = authOf(request);
    const body = parse(createTemplateSchema, request.body) as CreateTemplateInput;
    const result = await createTemplate(actor, body, requestMeta(request));
    response.status(201).json(result);
  },
);

// PATCH /api/v1/notifications/templates/:id — update a template (mandatory
// templates cannot be deactivated or demoted).
notificationsRouter.patch(
  '/templates/:id',
  authenticate,
  requirePermission('settings.write'),
  async (request, response) => {
    const actor = authOf(request);
    const params = parse(templateIdParamSchema, request.params) as TemplateIdParam;
    const body = parse(updateTemplateSchema, request.body) as UpdateTemplateInput;
    const result = await updateTemplate(actor, params.id, body, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Outbox & delivery history (settings.read to view, settings.write to act)
// ---------------------------------------------------------------------------

// GET /api/v1/notifications/outbox — filtered, paginated outbox list.
notificationsRouter.get(
  '/outbox',
  authenticate,
  requirePermission('settings.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(listOutboxQuerySchema, request.query) as ListOutboxQuery;
    const result = await listOutbox(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// GET /api/v1/notifications/outbox/:id — outbox item + delivery history.
notificationsRouter.get(
  '/outbox/:id',
  authenticate,
  requirePermission('settings.read'),
  async (request, response) => {
    const actor = authOf(request);
    const params = parse(outboxIdParamSchema, request.params) as OutboxIdParam;
    const result = await getOutboxDetail(actor, params.id, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/notifications/outbox/:id/retry — requeue a failed/skipped item.
notificationsRouter.post(
  '/outbox/:id/retry',
  authenticate,
  requirePermission('settings.write'),
  async (request, response) => {
    const actor = authOf(request);
    const params = parse(outboxIdParamSchema, request.params) as OutboxIdParam;
    const result = await retryOutboxItem(actor, params.id, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/notifications/outbox/:id/cancel — cancel a queued item.
notificationsRouter.post(
  '/outbox/:id/cancel',
  authenticate,
  requirePermission('settings.write'),
  async (request, response) => {
    const actor = authOf(request);
    const params = parse(outboxIdParamSchema, request.params) as OutboxIdParam;
    const result = await cancelOutboxItem(actor, params.id, requestMeta(request));
    response.status(200).json(result);
  },
);
