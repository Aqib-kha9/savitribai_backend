import { Router } from 'express';
import { authenticate, requirePermission, requireRole, requireSource } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { getDayCloseSummary, submitDayClose, recordHandover, recordDenominations, countHandover, recordDigitalSettlement, markDifference, reopenDayClose, lockDayClose, escalateDifference, getReconciliationDetail, } from './reconciliation.service.js';
import { dayCloseParamSchema, submitDayCloseSchema, recordHandoverSchema, recordDenominationsSchema, countHandoverSchema, recordDigitalSettlementSchema, markDifferenceSchema, reopenDayCloseSchema, lockDayCloseSchema, escalateDifferenceSchema, idParamSchema, } from './reconciliation.schemas.js';
/**
 * Reconciliation HTTP surface (docs/backend-master-spec.md §16).
 *
 * Mounted at /api/v1/reconciliation. Authority mapping follows spec §16.3/§16.5:
 *  - browse a day-close summary / full record set -> reconciliation.read
 *  - agent self-service write (submit / handover / denominations) ->
 *    collection_agent role on the agent mobile source only
 *  - cashier count-confirm + digital settlement evidence + lock-after-approval
 *    + escalation -> reconciliation.write
 *  - difference lifecycle decisions (explained/accepted/recovered/waived/
 *    unresolved) -> managing_director only
 *  - reopening a completed reconciliation -> president only
 *
 * Literal routes (/day-close, /submit, /handover, /denominations, /count,
 * /digital-settlement, /difference) are registered before the /:id routes so
 * Express never mis-routes a literal segment as an id parameter.
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
/** Path helper for routes that carry a day-close id path parameter. */
function idParam(request) {
    return parse(idParamSchema, request.params).id;
}
export const reconciliationRouter = Router();
// ---------------------------------------------------------------------------
// Literal routes — registered before the /:id routes.
// ---------------------------------------------------------------------------
// GET /api/v1/reconciliation/day-close/:agentId/:date — day-close summary for
// an agent on a business date (spec §16.1). Future dates are not reachable.
reconciliationRouter.get('/day-close/:agentId/:date', authenticate, requirePermission('reconciliation.read'), async (request, response) => {
    const actor = authOf(request);
    const params = parse(dayCloseParamSchema, request.params);
    const summary = await getDayCloseSummary(actor, params, requestMeta(request));
    response.status(200).json(summary);
});
// POST /api/v1/reconciliation/submit — agent day-close submission before
// 17:00 IST (spec §16.5). The day totals are derived by the service from
// collection_entry — the agent never supplies amounts.
reconciliationRouter.post('/submit', authenticate, requireRole('collection_agent'), requireSource('agent_mobile'), validateBody(submitDayCloseSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const submission = await submitDayClose(actor, input, requestMeta(request));
    response.status(201).json(submission);
});
// POST /api/v1/reconciliation/handover — record the cash handed over with the
// section-wise daily cash report, before 16:00 IST (spec §16.1/§16.5).
reconciliationRouter.post('/handover', authenticate, requireRole('collection_agent'), requireSource('agent_mobile'), validateBody(recordHandoverSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const handover = await recordHandover(actor, input, requestMeta(request));
    response.status(201).json(handover);
});
// POST /api/v1/reconciliation/denominations — denomination-wise cash breakup
// for a handover (spec §16.1). Line amounts are recomputed by the service.
reconciliationRouter.post('/denominations', authenticate, requireRole('collection_agent'), requireSource('agent_mobile'), validateBody(recordDenominationsSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const handover = await recordDenominations(actor, input, requestMeta(request));
    response.status(201).json(handover);
});
// POST /api/v1/reconciliation/count — the cashier counts and confirms the
// handed-over cash (spec §16.1). A genuine mismatch records an unresolved
// reconciliation_difference flagged to the M.D.
reconciliationRouter.post('/count', authenticate, requirePermission('reconciliation.write'), validateBody(countHandoverSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await countHandover(actor, input, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/reconciliation/digital-settlement — evidence for a
// digital/bank settlement (receipt, name-wise breakdown, dates).
reconciliationRouter.post('/digital-settlement', authenticate, requirePermission('reconciliation.write'), validateBody(recordDigitalSettlementSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const settlement = await recordDigitalSettlement(actor, input, requestMeta(request));
    response.status(201).json(settlement);
});
// POST /api/v1/reconciliation/difference — M.D. marks a reconciliation
// difference explained/accepted/recovered/waived/unresolved (spec §16.1/§16.5).
reconciliationRouter.post('/difference', authenticate, requireRole('managing_director'), validateBody(markDifferenceSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const difference = await markDifference(actor, input, requestMeta(request));
    response.status(200).json(difference);
});
// ---------------------------------------------------------------------------
// /:id routes — full record set, reopen, lock, escalate.
// ---------------------------------------------------------------------------
// GET /api/v1/reconciliation/:id — full permanent record set for a day close:
// summary, handovers + denominations, digital settlements, differences and the
// chronological event trail (spec §16.1/§16.5).
reconciliationRouter.get('/:id', authenticate, requirePermission('reconciliation.read'), async (request, response) => {
    const actor = authOf(request);
    const detail = await getReconciliationDetail(actor, idParam(request), requestMeta(request));
    response.status(200).json(detail);
});
// POST /api/v1/reconciliation/:id/reopen — President approves reopening a
// completed (closed/locked) reconciliation (spec §16.5). The day returns to
// 'reopened' and must be re-approved before it is locked again.
reconciliationRouter.post('/:id/reopen', authenticate, requireRole('president'), validateBody(reopenDayCloseSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const dayClose = await reopenDayClose(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(dayClose);
});
// POST /api/v1/reconciliation/:id/lock — lock-after-approval, the default on
// a closed or reopened reconciliation (spec §16.5).
reconciliationRouter.post('/:id/lock', authenticate, requirePermission('reconciliation.write'), validateBody(lockDayCloseSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const dayClose = await lockDayClose(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(dayClose);
});
// POST /api/v1/reconciliation/:id/escalate — unresolved differences are
// escalated to the M.D. (spec §16.1). The event is recorded on the day close.
reconciliationRouter.post('/:id/escalate', authenticate, requirePermission('reconciliation.write'), validateBody(escalateDifferenceSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await escalateDifference(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(result);
});
