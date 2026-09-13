import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { listAuditEvents, getAuditSummary, } from './audit.service.js';
import { auditEventsQuerySchema, auditSummaryQuerySchema, } from './audit.schemas.js';
/**
 * Audit trail HTTP surface (docs/backend-master-spec.md §21).
 *
 * Mounted at /api/v1/audit. The audit trail is M.D.-only: both read surfaces
 * require the managing_director role AND security.audit.read. The role check
 * is essential — the President also holds security.audit.read, so the
 * permission alone would over-expose the trail. See §21 authority mapping.
 *
 * Read-only by design: audit_event rejects UPDATE/DELETE at the database level
 * (001_schema.sql reject_mutation triggers), so no mutation routes exist here
 * and no audit-event-of-the-audit-read is written (querying the trail would
 * recurse).
 */
/**
 * The `authenticate` middleware guarantees `request.auth` is present once the
 * chain reaches the handler; this narrows the optional type for TypeScript and
 * guards against a future chain reorder.
 */
function authOf(request) {
    if (!request.auth)
        throw new UnauthorizedError();
    return request.auth;
}
/** Builds service-layer RequestMeta from the live request. */
function requestMeta(request) {
    const meta = {};
    const ip = request.ip;
    if (ip)
        meta.ipAddress = ip;
    const userAgent = request.get('user-agent');
    if (userAgent)
        meta.userAgent = userAgent;
    if (request.id)
        meta.requestId = request.id;
    return meta;
}
export const auditRouter = Router();
// ---------------------------------------------------------------------------
// Audit trail queries (managing_director + security.audit.read)
// ---------------------------------------------------------------------------
// GET /api/v1/audit/events — filtered, paginated audit trail, newest first.
auditRouter.get('/events', authenticate, requireRole('managing_director'), requirePermission('security.audit.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(auditEventsQuerySchema, request.query);
    const result = await listAuditEvents(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// GET /api/v1/audit/summary — counts by action and by acting staff + total.
auditRouter.get('/summary', authenticate, requireRole('managing_director'), requirePermission('security.audit.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(auditSummaryQuerySchema, request.query);
    const result = await getAuditSummary(actor, query, requestMeta(request));
    response.status(200).json(result);
});
