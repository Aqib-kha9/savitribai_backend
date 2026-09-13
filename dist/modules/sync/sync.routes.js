import { Router } from 'express';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { listMySubmissions, listMyVisits, getSyncStatus, reportConflict, } from './sync.service.js';
import { reportConflictSchema, syncSubmissionsQuerySchema, syncVisitsQuerySchema } from './sync.schemas.js';
/**
 * Offline sync & mobile support HTTP surface (docs/backend-master-spec.md §20).
 *
 * Mounted at /api/v1/sync. This surface is strictly agent-facing:
 *  - GET /submissions — the agent's submission list (status only, §20.3.6)
 *  - GET /visits      — the agent's recorded visits (§20.3.6)
 *  - GET /status      — per-agent submission/offline summary for the sync screen
 *  - POST /conflicts  — device-initiated conflict escalation (§20.3.3)
 *
 * Every route resolves the agent profile bound to the authenticated staff
 * account via `agent.staff_id`, so scope is always the caller's own data — a
 * caller can never list or escalate another agent's records.
 *
 * The push endpoints (POST /collections, POST /visits) and the pull read model
 * (GET /agents/me/assignments) belong to the collections and agents modules.
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
export const syncRouter = Router();
// GET /api/v1/sync/submissions — agent's submitted collections (status only,
// §20.3.6). Filters mirror the mobile sync screen (status, product, mode, date
// range, offline-late flag). Scope is always the authenticated agent.
syncRouter.get('/submissions', authenticate, requireRole('collection_agent'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(syncSubmissionsQuerySchema, request.query);
    const result = await listMySubmissions(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// GET /api/v1/sync/visits — the agent's recorded visits (§20.3.6).
syncRouter.get('/visits', authenticate, requireRole('collection_agent'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(syncVisitsQuerySchema, request.query);
    const result = await listMyVisits(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// GET /api/v1/sync/status — compact per-agent sync summary (counts per status
// plus offline-late total) rendered on the mobile sync screen.
syncRouter.get('/status', authenticate, requireRole('collection_agent'), async (request, response) => {
    const actor = authOf(request);
    const result = await getSyncStatus(actor, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/sync/conflicts — device-initiated conflict escalation (§20.3.3).
// The server never silently overwrites an office decision; it records the
// escalation (sync.conflict.escalated, append-only) for the President to decide.
syncRouter.post('/conflicts', authenticate, requireRole('collection_agent'), validateBody(reportConflictSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await reportConflict(actor, input, requestMeta(request));
    response.status(201).json(result);
});
