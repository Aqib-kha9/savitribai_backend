import type { Permission, StaffRole } from '../core/permissions.js';

/**
 * Shared request/auth type augmentation.
 * `authenticate` populates `request.auth`; the `requestId` middleware sets
 * `request.id`. Kept in one file so every request handler sees the same
 * shape (docs/backend-master-spec.md §7, §28.10).
 */

export type AuthSource = 'admin_web' | 'agent_mobile';

/** Authenticated staff context attached to every authorized request. */
export interface AuthContext {
  /** staff.id */
  staffId: string;
  /** e.g. MD-001 / AGT-001 */
  staffCode: string;
  fullName: string;
  role: StaffRole;
  branchId: string | null;
  /** true when the staff account is immutable (the protected super-admin) */
  isProtected: boolean;
  /** where the session was created (admin_web vs agent_mobile) */
  source: AuthSource;
  /** staff_session.id bound to this access token */
  sessionId: string;
  /** confirmed device id when the session is device-bound */
  deviceId: string | null;
  /** live permission codes from role_permission (runtime-editable matrix) */
  permissions: Permission[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Request correlation id set by the requestId middleware. */
      id?: string;
      /** Authenticated staff context — populated by the authenticate middleware. */
      auth?: AuthContext;
    }
  }
}

export {};
