import { query } from '../database/client.js';
import { verifyAccessToken } from '../core/token.js';
import { AccountLockedError, DeviceDisabledError, DevicePendingError, ForbiddenError, PermissionDeniedError, SessionExpiredError, UnauthorizedError, } from '../core/errors.js';
import { isSuperAdmin, isValidPermission, isValidStaffRole, } from '../core/permissions.js';
import { env } from '../config/env.js';
import { istBusinessDate } from '../core/time.js';
/** Extracts the opaque bearer token from `Authorization: Bearer <token>`. */
function readBearer(request) {
    const header = request.header('authorization');
    if (!header)
        return null;
    const parts = header.split(' ');
    const [scheme, token, extra] = parts;
    if (scheme?.toLowerCase() !== 'bearer' || !token || extra)
        return null;
    return token;
}
function mapVerificationError(error) {
    const code = typeof error === 'object' && error !== null && 'code' in error
        ? error.code
        : undefined;
    if (code === 'ERR_JWT_EXPIRED')
        return new SessionExpiredError();
    if (error instanceof Error && error.message === 'Malformed access token payload') {
        return new UnauthorizedError('Invalid access token', 'AUTH_TOKEN_INVALID');
    }
    return new UnauthorizedError('Invalid or expired access token', 'AUTH_TOKEN_INVALID');
}
export const authenticate = async (request, _response, next) => {
    try {
        const token = readBearer(request);
        if (!token) {
            next(new UnauthorizedError());
            return;
        }
        let verified;
        try {
            verified = await verifyAccessToken(token);
        }
        catch (error) {
            next(mapVerificationError(error));
            return;
        }
        const session = await query(`SELECT s.id AS staff_id, s.role_id, s.staff_code, s.full_name,
              r.code AS role_code, s.branch_id, s.is_protected,
              s.status AS staff_status,
              s.locked_until, s.nda_signed, s.exit_date,
              ss.id AS session_id, ss.source AS session_source,
              ss.device_id AS session_device_id, ss.expires_at AS session_expires_at,
              ss.revoked_at AS session_revoked_at, ss.last_seen_at AS session_last_seen_at,
              d.status AS device_status
         FROM staff s
         JOIN role r ON r.id = s.role_id
         JOIN staff_session ss ON ss.staff_id = s.id AND ss.id = $2
         LEFT JOIN device d ON d.id = ss.device_id
        WHERE s.id = $1
        LIMIT 1`, [verified.staffId, verified.sessionId]);
        const row = session.rows[0];
        if (!row) {
            next(new UnauthorizedError('Session is no longer valid', 'AUTH_SESSION_INVALID'));
            return;
        }
        const now = new Date();
        // Account state
        if (row.staff_status === 'locked') {
            next(new AccountLockedError(row.locked_until?.toISOString() ?? now.toISOString()));
            return;
        }
        if (row.staff_status === 'disabled' || (row.exit_date && row.exit_date <= istBusinessDate())) {
            next(new UnauthorizedError('Account has been deactivated', 'AUTH_ACCOUNT_DISABLED'));
            return;
        }
        if (!row.nda_signed) {
            next(new ForbiddenError('Your account must have a signed NDA on file', 'AUTH_NDA_REQUIRED'));
            return;
        }
        // Session state
        if (row.session_revoked_at) {
            next(new SessionExpiredError());
            return;
        }
        if (row.session_expires_at.getTime() <= now.getTime()) {
            next(new SessionExpiredError());
            return;
        }
        const idleMs = env.session.idleMinutes * 60_000;
        if (now.getTime() - row.session_last_seen_at.getTime() > idleMs) {
            await query('UPDATE staff_session SET revoked_at = now(), revoked_reason = $2 WHERE id = $1', [
                row.session_id,
                'idle timeout',
            ]);
            next(new SessionExpiredError());
            return;
        }
        // Device state (only when the session is bound to a device)
        const deviceId = row.session_device_id;
        if (deviceId) {
            if (row.device_status === 'pending') {
                next(new DevicePendingError(deviceId));
                return;
            }
            if (row.device_status === 'disabled') {
                next(new DeviceDisabledError());
                return;
            }
            if (!row.device_status) {
                next(new UnauthorizedError('Session device is not available', 'AUTH_DEVICE_INVALID'));
                return;
            }
        }
        // Touch activity timestamps.
        await query('UPDATE staff_session SET last_seen_at = now() WHERE id = $1', [row.session_id]);
        if (deviceId) {
            await query('UPDATE device SET last_used_at = now() WHERE id = $1', [deviceId]);
        }
        // Load live permissions from the role_permission matrix (runtime-editable).
        const permissionRows = await query(`SELECT p.code
         FROM role_permission rp
         JOIN permission p ON p.id = rp.permission_id
        WHERE rp.role_id = $1`, [row.role_id]);
        const permissions = permissionRows.rows.map((item) => item.code).filter(isValidPermission);
        const role = row.role_code;
        if (!isValidStaffRole(role)) {
            next(new UnauthorizedError('Account role is not recognized', 'AUTH_ROLE_INVALID'));
            return;
        }
        request.auth = {
            staffId: row.staff_id,
            staffCode: row.staff_code,
            fullName: row.full_name,
            role,
            branchId: row.branch_id,
            isProtected: row.is_protected,
            source: row.session_source,
            sessionId: row.session_id,
            deviceId,
            permissions,
        };
        next();
    }
    catch (error) {
        next(error);
    }
};
/** Restricts the route to staff holding every listed permission. */
export function requirePermission(...required) {
    return (request, _response, next) => {
        const auth = request.auth;
        if (!auth) {
            next(new UnauthorizedError());
            return;
        }
        // The super-administrator holds every permission unconditionally.
        if (isSuperAdmin(auth.role)) {
            next();
            return;
        }
        const missing = required.filter((permission) => !auth.permissions.includes(permission));
        if (missing.length > 0) {
            next(new PermissionDeniedError(missing.join(', ')));
            return;
        }
        next();
    };
}
/** Restricts the route to one of the listed roles (coarser than permissions). */
export function requireRole(...roles) {
    return (request, _response, next) => {
        const auth = request.auth;
        if (!auth) {
            next(new UnauthorizedError());
            return;
        }
        // The super-administrator bypasses every role gate.
        if (isSuperAdmin(auth.role)) {
            next();
            return;
        }
        if (!roles.includes(auth.role)) {
            next(new ForbiddenError('You are not allowed to use this endpoint', 'ROLE_FORBIDDEN'));
            return;
        }
        next();
    };
}
/** Restricts the route to a channel (admin_web vs agent_mobile). */
export function requireSource(...sources) {
    return (request, _response, next) => {
        const auth = request.auth;
        if (!auth) {
            next(new UnauthorizedError());
            return;
        }
        if (!sources.includes(auth.source)) {
            next(new ForbiddenError('This endpoint is not available from your channel', 'SOURCE_FORBIDDEN'));
            return;
        }
        next();
    };
}
