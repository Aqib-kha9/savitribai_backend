import { Router } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { createBranch, createHoliday, deleteHoliday, getOrganisation, listBranches, listHolidays, listSettingHistory, listSettings, updateBranch, updateOrganisation, updateSettings, } from './settings.service.js';
import { branchIdParamSchema, createBranchSchema, createHolidaySchema, holidayIdParamSchema, listBranchesQuerySchema, listHolidaysQuerySchema, listSettingHistoryQuerySchema, listSettingsQuerySchema, updateBranchSchema, updateOrganisationSchema, updateSettingsSchema, } from './settings.schemas.js';
/**
 * Settings and organisation administration HTTP surface
 * (docs/backend-master-spec.md §22).
 *
 * Mounted at /api/v1/settings. Authority follows the permission matrix
 * (core/permissions.ts):
 *   - settings.read  — President / VP / Manager / M.D. may view every surface
 *     (organisation, branches, holidays, settings, change history);
 *   - settings.write — M.D. only may mutate any surface.
 *
 * The §22.1 "business-info corrections after go-live" requirement is covered
 * by the Manager holding settings.read (view/correct view of business info);
 * the write path intentionally stays with the M.D. exactly as the matrix
 * dictates.
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
export const settingsRouter = Router();
// ---------------------------------------------------------------------------
// Organisation (settings.read to view, settings.write to update)
// ---------------------------------------------------------------------------
// GET /api/v1/settings/organisation — the single organisation row.
settingsRouter.get('/organisation', authenticate, requirePermission('settings.read'), async (request, response) => {
    const actor = authOf(request);
    const result = await getOrganisation(actor, requestMeta(request));
    response.status(200).json(result);
});
// PATCH /api/v1/settings/organisation — update non-transaction business info.
settingsRouter.patch('/organisation', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const body = parse(updateOrganisationSchema, request.body);
    const result = await updateOrganisation(actor, body, requestMeta(request));
    response.status(200).json(result);
});
// ---------------------------------------------------------------------------
// Branches (settings.read to view, settings.write to mutate)
// ---------------------------------------------------------------------------
// GET /api/v1/settings/branches — paginated branch registry.
settingsRouter.get('/branches', authenticate, requirePermission('settings.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listBranchesQuerySchema, request.query);
    const result = await listBranches(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/settings/branches — create a branch under the organisation.
settingsRouter.post('/branches', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const body = parse(createBranchSchema, request.body);
    const result = await createBranch(actor, body, requestMeta(request));
    response.status(201).json(result);
});
// PATCH /api/v1/settings/branches/:id — edit branch details or active flag.
settingsRouter.patch('/branches/:id', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const params = parse(branchIdParamSchema, request.params);
    const body = parse(updateBranchSchema, request.body);
    const result = await updateBranch(actor, params.id, body, requestMeta(request));
    response.status(200).json(result);
});
// ---------------------------------------------------------------------------
// Holiday calendar (settings.read to view, settings.write to mutate)
// ---------------------------------------------------------------------------
// GET /api/v1/settings/holidays — paginated holiday calendar.
settingsRouter.get('/holidays', authenticate, requirePermission('settings.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listHolidaysQuerySchema, request.query);
    const result = await listHolidays(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/settings/holidays — add a calendar holiday.
settingsRouter.post('/holidays', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const body = parse(createHolidaySchema, request.body);
    const result = await createHoliday(actor, body, requestMeta(request));
    response.status(201).json(result);
});
// DELETE /api/v1/settings/holidays/:id — remove a calendar holiday.
settingsRouter.delete('/holidays/:id', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const params = parse(holidayIdParamSchema, request.params);
    const result = await deleteHoliday(actor, params.id, requestMeta(request));
    response.status(200).json(result);
});
// ---------------------------------------------------------------------------
// App settings (operational preferences)
// ---------------------------------------------------------------------------
// GET /api/v1/settings — current app_setting rows.
settingsRouter.get('/', authenticate, requirePermission('settings.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listSettingsQuerySchema, request.query);
    const result = await listSettings(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// PATCH /api/v1/settings — bulk update with audited change history.
settingsRouter.patch('/', authenticate, requirePermission('settings.write'), async (request, response) => {
    const actor = authOf(request);
    const body = parse(updateSettingsSchema, request.body);
    const result = await updateSettings(actor, body, requestMeta(request));
    response.status(200).json(result);
});
// GET /api/v1/settings/history — append-only change history.
settingsRouter.get('/history', authenticate, requirePermission('settings.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listSettingHistoryQuerySchema, request.query);
    const result = await listSettingHistory(actor, query, requestMeta(request));
    response.status(200).json(result);
});
