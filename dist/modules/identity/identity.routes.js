import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { authRateLimiter } from '../../middleware/rate-limiter.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { login, refresh, logout, changeOwnPassword, getSession, registerDevice, listDevices, confirmDevice, disableDevice, createStaff, updateStaff, unlockStaff, deactivateStaff, listStaff, listRoles, patchRolePermissions, } from './identity.service.js';
import { loginSchema, refreshSchema, changePasswordSchema, registerDeviceSchema, disableDeviceSchema, createStaffSchema, updateStaffSchema, deactivateStaffSchema, listStaffQuerySchema, rolePermissionsSchema, idParamSchema, } from './identity.schemas.js';
/**
 * Identity & access management HTTP surface (docs/backend-master-spec.md §7.2).
 *
 * `authRouter`     -> mounted at /api/v1/auth     (session, token, device registry)
 * `identityRouter` -> mounted at /api/v1/identity (staff + role/permission matrix)
 *
 * Authentication rules enforced here (spec §7.1):
 *  - new-device sign-in runs through the device registry (register -> confirm)
 *  - confirm/disable device and staff lifecycle are M.D. actions
 *  - account unlock uses the M.D.-only `security.unlock_accounts` permission
 *  - role-matrix editing uses the M.D.-only `settings.write` permission
 */
const DEVICE_STATUSES = ['pending', 'confirmed', 'disabled'];
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
/** Path helper for device and staff routes that carry an id path parameter. */
function idParam(request) {
    return parse(idParamSchema, request.params).id;
}
export const authRouter = Router();
// POST /api/v1/auth/login — staff + agent sign-in (returns token pair).
// Errors thrown by the service (invalid credentials, account locked, device
// pending/disabled) carry structured codes via the global error handler.
authRouter.post('/login', authRateLimiter, validateBody(loginSchema), async (request, response) => {
    const input = request.body;
    const result = await login(input, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/auth/refresh — rotates the refresh token (reuse revokes family).
authRouter.post('/refresh', authRateLimiter, validateBody(refreshSchema), async (request, response) => {
    const input = request.body;
    const result = await refresh(input, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/auth/logout — revoke the current session.
authRouter.post('/logout', authenticate, async (request, response) => {
    const actor = authOf(request);
    const result = await logout(actor, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/auth/change-password — self-service credential rotation for the
// authenticated principal (including the protected root account, which cannot
// be edited through the identity staff endpoints). Requires the current
// password; revokes every other live session for the caller on success.
authRouter.post('/change-password', authenticate, authRateLimiter, validateBody(changePasswordSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await changeOwnPassword(actor, input, requestMeta(request));
    response.status(200).json(result);
});
// GET /api/v1/auth/session — current session info, staff profile and expiry.
authRouter.get('/session', authenticate, async (request, response) => {
    const actor = authOf(request);
    const session = await getSession(actor);
    response.status(200).json(session);
});
// POST /api/v1/auth/devices — register a device for the authenticated staff
// member (new-device confirmation flow, spec §7.1). Idempotent: a confirmed
// device is returned as-is; a pending device re-raises AUTH_DEVICE_PENDING.
authRouter.post('/devices', authenticate, validateBody(registerDeviceSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const device = await registerDevice(actor, input, requestMeta(request));
    response.status(201).json(device);
});
// GET /api/v1/auth/devices — list the device registry. Holders of
// `security.read` may filter by staffId and see all staff devices; everyone
// else is scoped to their own devices (service enforces the scope).
authRouter.get('/devices', authenticate, async (request, response) => {
    const actor = authOf(request);
    const filters = {};
    const status = request.query.status;
    if (typeof status === 'string' && DEVICE_STATUSES.includes(status)) {
        filters.status = status;
    }
    const staffId = request.query.staffId;
    if (typeof staffId === 'string' && staffId.length > 0)
        filters.staffId = staffId;
    const limit = Number(request.query.limit);
    if (Number.isFinite(limit))
        filters.limit = Math.min(Math.max(Math.trunc(limit), 1), 100);
    const offset = Number(request.query.offset);
    if (Number.isFinite(offset) && offset >= 0)
        filters.offset = Math.trunc(offset);
    const devices = await listDevices(actor, filters, requestMeta(request));
    response.status(200).json(devices);
});
// POST /api/v1/auth/devices/:id/confirm — approve a pending device (M.D.).
authRouter.post('/devices/:id/confirm', authenticate, requireRole('managing_director'), async (request, response) => {
    const actor = authOf(request);
    const device = await confirmDevice(idParam(request), actor, requestMeta(request));
    response.status(200).json(device);
});
// DELETE /api/v1/auth/devices/:id — disable a device immediately (M.D.).
// Also revokes every live session bound to the device.
authRouter.delete('/devices/:id', authenticate, requireRole('managing_director'), validateBody(disableDeviceSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const device = await disableDevice(idParam(request), actor, input, requestMeta(request));
    response.status(200).json(device);
});
export const identityRouter = Router();
// GET /api/v1/identity/staff — list/search staff (requires security.read).
identityRouter.get('/staff', authenticate, requirePermission('security.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listStaffQuerySchema, request.query);
    const result = await listStaff(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/identity/staff — create a staff account (M.D.).
identityRouter.post('/staff', authenticate, requireRole('managing_director'), validateBody(createStaffSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const staff = await createStaff(actor, input, requestMeta(request));
    response.status(201).json(staff);
});
// PATCH /api/v1/identity/staff/:id — update staff profile / re-register (M.D.).
// Reactivation of a disabled account requires a new password + N.D.A. flag.
identityRouter.patch('/staff/:id', authenticate, requireRole('managing_director'), validateBody(updateStaffSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const staff = await updateStaff(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(staff);
});
// POST /api/v1/identity/staff/:id/unlock — unlock a locked account (M.D. only,
// enforced by the M.D.-exclusive security.unlock_accounts permission).
identityRouter.post('/staff/:id/unlock', authenticate, requirePermission('security.unlock_accounts'), async (request, response) => {
    const actor = authOf(request);
    const staff = await unlockStaff(actor, idParam(request), requestMeta(request));
    response.status(200).json(staff);
});
// POST /api/v1/identity/staff/:id/deactivate — staff exit process (M.D.).
identityRouter.post('/staff/:id/deactivate', authenticate, requireRole('managing_director'), validateBody(deactivateStaffSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const staff = await deactivateStaff(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(staff);
});
// GET /api/v1/identity/roles — roles + permission matrix (requires security.read).
identityRouter.get('/roles', authenticate, requirePermission('security.read'), async (request, response) => {
    const actor = authOf(request);
    const roles = await listRoles(actor, requestMeta(request));
    response.status(200).json(roles);
});
// PATCH /api/v1/identity/roles/:id/permissions — M.D. edits the runtime matrix
// (enforced by the M.D.-exclusive settings.write permission).
identityRouter.patch('/roles/:id/permissions', authenticate, requirePermission('settings.write'), validateBody(rolePermissionsSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const result = await patchRolePermissions(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(result);
});
