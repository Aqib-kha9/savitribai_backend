import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { listReportCatalogue, generateReport, downloadReport, shareReport, getCustomerStatement, } from './reports.service.js';
import { reportTypeParamSchema, idParamSchema, customerIdParamSchema, generateReportSchema, shareReportSchema, customerStatementQuerySchema, } from './reports.schemas.js';
/**
 * Reports HTTP surface (docs/backend-master-spec.md §17).
 *
 * Mounted at /api/v1/reports. Route-level authority:
 *  - browse the report catalogue          -> reports.read
 *  - generate a report (:type/generate)   -> reports.read (base) AND every
 *    permission in report_definition.required_permissions for that report —
 *    the per-report gate is enforced in the service so a catalogue row the
 *    actor cannot produce yields 403, not 404.
 *  - download a generated PDF             -> reports.export
 *  - share a generated PDF                -> reports.export AND Managing
 *    Director role (record-only share consent).
 *  - customer statements                  -> customers.read
 *
 * The literal statement routes are registered before the parameterised
 * /:id routes so Express never routes /customers/<uuid>/statements or
 * /statements/<uuid> through a :id pattern.
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
/** Path helper for the generated-report :id routes (download / share). */
function idParam(request) {
    return parse(idParamSchema, request.params).id;
}
/** Path helper for POST /:type/generate (report_definition.report_type). */
function typeParam(request) {
    return parse(reportTypeParamSchema, request.params).type;
}
/** Path helper for the alias GET /statements/:customerId. */
function customerIdParam(request) {
    return parse(customerIdParamSchema, request.params).customerId;
}
export const reportsRouter = Router();
// ---------------------------------------------------------------------------
// Report catalogue
// ---------------------------------------------------------------------------
// GET /api/v1/reports — active report_definition rows the actor may generate
// (required_permissions must be a subset of the actor's permissions).
reportsRouter.get('/', authenticate, requirePermission('reports.read'), async (request, response) => {
    const actor = authOf(request);
    const catalogue = await listReportCatalogue(actor, requestMeta(request));
    response.status(200).json(catalogue);
});
// ---------------------------------------------------------------------------
// Report generation / download / share
// ---------------------------------------------------------------------------
// POST /api/v1/reports/:type/generate — build report data, render the PDF with
// pdf-lib, and store the generated_report row + REPORT_GENERATED audit event in
// one transaction (spec §17.3). Per-report permissions are verified in the
// service; a definition the actor cannot produce yields 403.
reportsRouter.post('/:type/generate', authenticate, requirePermission('reports.read'), validateBody(generateReportSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await generateReport(actor, typeParam(request), input, requestMeta(request));
    response.status(201).json(result);
});
// GET /api/v1/reports/:id/download — stream a stored PDF. The REPORT_DOWNLOADED
// audit event is written on its own autocommit client (never rolled back with a
// failed download) and the PDF bytes are sent straight to the wire.
reportsRouter.get('/:id/download', authenticate, requirePermission('reports.export'), async (request, response) => {
    const actor = authOf(request);
    const report = await downloadReport(actor, idParam(request), requestMeta(request));
    response.setHeader('Content-Type', 'application/pdf');
    const safeName = report.filename.replace(/["\r\n]/g, '');
    response.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    response.status(200).send(report.content);
});
// POST /api/v1/reports/:id/share — record-only sharing consent. Appends
// {recipient, channel, note?, sharedAt} to generated_report.shared_with, sets
// share_consent_by, and audits REPORT_SHARED. Managing Director role only.
reportsRouter.post('/:id/share', authenticate, requirePermission('reports.export'), requireRole('managing_director'), validateBody(shareReportSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await shareReport(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(result);
});
// ---------------------------------------------------------------------------
// Customer statements (read-only)
// ---------------------------------------------------------------------------
// GET /api/v1/reports/customers/:id/statements — savings sub-ledger statement
// for one customer, optionally narrowed by accountId / productType / period.
reportsRouter.get('/customers/:id/statements', authenticate, requirePermission('customers.read'), async (request, response) => {
    const actor = authOf(request);
    const statement = await getCustomerStatement(actor, idParam(request), parse(customerStatementQuerySchema, request.query), requestMeta(request));
    response.status(200).json(statement);
});
// GET /api/v1/reports/statements/:customerId — alias of the route above with a
// customerId-flavoured path parameter (both hit the same service function).
reportsRouter.get('/statements/:customerId', authenticate, requirePermission('customers.read'), async (request, response) => {
    const actor = authOf(request);
    const statement = await getCustomerStatement(actor, customerIdParam(request), parse(customerStatementQuerySchema, request.query), requestMeta(request));
    response.status(200).json(statement);
});
