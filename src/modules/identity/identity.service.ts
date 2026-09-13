import { hash, verify } from '@node-rs/argon2';
import type { PoolClient } from 'pg';
import { query, transaction } from '../../database/client.js';
import { env } from '../../config/env.js';
import { generateOpaqueToken, sha256Hex, signAccessToken } from '../../core/token.js';
import { appendAuditEvent, AUDIT_ACTIONS, type AuditEventInput } from '../../audit/audit-writer.js';
import { istBusinessDate } from '../../core/time.js';
import {
  AccountLockedError,
  BadRequestError,
  BusinessRuleError,
  ConflictError,
  DeviceDisabledError,
  DevicePendingError,
  ForbiddenError,
  InvalidCredentialsError,
  NotFoundError,
  RefreshTokenError,
  SessionExpiredError,
  UnauthorizedError,
} from '../../core/errors.js';
import { logger } from '../../core/logger.js';
import type { AuthContext } from '../../types/auth-context.js';
import type { StaffRole } from '../../core/permissions.js';
import type {
  ChangePasswordInput,
  CreateStaffInput,
  DeactivateStaffInput,
  DisableDeviceInput,
  ListStaffQuery,
  LoginInput,
  RefreshInput,
  RegisterDeviceInput,
  RolePermissionsInput,
  UpdateStaffInput,
} from './identity.schemas.js';

/**
 * Identity & access management service (docs/backend-master-spec.md §7).
 *
 * Every authentication / account mutation writes its login_event and audit
 * record in the SAME transaction as the mutation (spec §6.3) — except the
 * failure/lockout paths, which intentionally run in autocommit statements so
 * they persist even though an error is raised afterwards (a thrown error would
 * otherwise roll the audit trail back with it).
 */

// Argon2id OWASP parameters — identical to database/seed.ts.
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const REFRESH_TTL_MS = env.jwt.refreshTokenTtlDays * 24 * 60 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface LoginResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  /** Access-token lifetime in seconds. */
  expiresIn: number;
  staff: {
    id: string;
    staffCode: string;
    fullName: string;
    role: StaffRole;
    branchId: string | null;
    source: 'admin_web' | 'agent_mobile';
  };
}

export interface TokenResult {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  session: { id: string; expiresAt: string };
}

export interface DeviceView {
  id: string;
  deviceType: 'admin_web' | 'agent_mobile';
  deviceName: string | null;
  appVersion: string | null;
  status: 'pending' | 'confirmed' | 'disabled';
  confirmedAt: string | null;
  disabledAt: string | null;
  disabledReason: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface StaffView {
  id: string;
  staffCode: string;
  fullName: string;
  roleCode: StaffRole;
  branchId: string | null;
  /** true when the account is immutable (protected root super-admin) */
  isProtected: boolean;
  email: string | null;
  phone: string | null;
  status: 'active' | 'locked' | 'disabled';
  mfaEnabled: boolean;
  ndaSigned: boolean;
  exitDate: string | null;
  lockedUntil: string | null;
  failedLoginAttempts: number;
  lastLoginAt: string | null;
  createdAt: string;
}

export interface RoleView {
  id: string;
  code: string;
  label: string;
  description: string | null;
  isSystem: boolean;
  permissions: string[];
}

// ---------------------------------------------------------------------------
// Row shapes (type aliases — implicit index signature satisfies QueryResultRow)
// ---------------------------------------------------------------------------

type StaffAuthRow = {
  id: string;
  role_id: string;
  role_code: string;
  staff_code: string;
  full_name: string;
  branch_id: string | null;
  email: string | null;
  phone: string | null;
  password_hash: string;
  status: 'active' | 'locked' | 'disabled';
  failed_login_attempts: number;
  locked_until: Date | null;
  mfa_enabled: boolean;
  nda_signed: boolean;
  exit_date: string | null;
  last_login_at: Date | null;
};

type DeviceRow = {
  id: string;
  staff_id: string;
  device_type: 'admin_web' | 'agent_mobile';
  device_name: string | null;
  device_fingerprint: string;
  app_version: string | null;
  status: 'pending' | 'confirmed' | 'disabled';
  confirmed_at: Date | null;
  confirmed_by: string | null;
  disabled_at: Date | null;
  disabled_by: string | null;
  disabled_reason: string | null;
  last_used_at: Date | null;
  created_at: Date;
  updated_at: Date;
};

type RefreshLookupRow = {
  token_id: string;
  session_id: string;
  staff_id: string;
  token_hash: string;
  used_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  session_source: 'admin_web' | 'agent_mobile';
  session_device_id: string | null;
  session_revoked_at: Date | null;
  session_expires_at: Date;
  staff_code: string;
  full_name: string;
  branch_id: string | null;
  staff_status: 'active' | 'locked' | 'disabled';
  nda_signed: boolean;
  exit_date: string | null;
  locked_until: Date | null;
  role_code: string;
};

type IdRow = { id: string };
type CountRow = { count: number };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

type LoginOutcome = 'success' | 'failure' | 'locked_out' | 'device_pending';

async function insertLoginEvent(
  client: PoolClient,
  fields: {
    staffId: string | null;
    staffCode: string;
    outcome: LoginOutcome;
    failureReason?: string;
    deviceId?: string | null;
    ipAddress?: string | null | undefined;
    userAgent?: string | null | undefined;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO login_event
       (staff_id, staff_code, outcome, failure_reason, ip_address, user_agent, device_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      fields.staffId,
      fields.staffCode,
      fields.outcome,
      fields.failureReason ?? null,
      fields.ipAddress ?? null,
      fields.userAgent ?? null,
      fields.deviceId ?? null,
    ],
  );
}

/**
 * Appends an audit event with exact-optional-safe metadata assignment.
 * `businessDate`/`requestId` default to null-safe values when not supplied.
 */
function audit(
  client: PoolClient,
  input: Pick<
    AuditEventInput,
    'action' | 'entityType' | 'source' | 'actorStaffId' | 'actorRole' | 'actorStaffCode'
  > & {
    entityId?: string | null;
    requestId?: string | null;
    businessDate?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const event: AuditEventInput = {
    actorStaffId: input.actorStaffId ?? null,
    actorRole: input.actorRole ?? null,
    actorStaffCode: input.actorStaffCode ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    source: input.source,
    requestId: input.requestId ?? null,
    businessDate: input.businessDate ?? istBusinessDate(),
  };
  if (input.metadata !== undefined) event.metadata = input.metadata;
  return appendAuditEvent(client, event);
}

function actorAuditBase(actor: AuthContext) {
  return {
    actorStaffId: actor.staffId,
    actorRole: actor.role,
    actorStaffCode: actor.staffCode,
    source: actor.source as AuditEventInput['source'],
    requestId: null as string | null,
  };
}

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

function toDeviceView(row: DeviceRow): DeviceView {
  return {
    id: row.id,
    deviceType: row.device_type,
    deviceName: row.device_name,
    appVersion: row.app_version,
    status: row.status,
    confirmedAt: iso(row.confirmed_at),
    disabledAt: iso(row.disabled_at),
    disabledReason: row.disabled_reason,
    lastUsedAt: iso(row.last_used_at),
    createdAt: row.created_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Password handling
// ---------------------------------------------------------------------------

/** Timing-equalizer for unknown staff codes (generic error, spec §6.2). */
let placeholderHashPromise: Promise<string> | null = null;
async function verifyAgainstPlaceholder(password: string): Promise<void> {
  placeholderHashPromise ??= hash('cooperative-finance-placeholder', ARGON2_OPTIONS);
  const placeholder = await placeholderHashPromise;
  await verify(placeholder, password);
}

async function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_OPTIONS);
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

async function findStaffByCode(staffCode: string): Promise<StaffAuthRow | null> {
  const result = await query<StaffAuthRow>(
    `SELECT st.*, r.code AS role_code
       FROM staff st
       JOIN role r ON r.id = st.role_id
      WHERE st.staff_code = $1
      LIMIT 1`,
    [staffCode],
  );
  return result.rows[0] ?? null;
}

async function findDevice(staffId: string, fingerprint: string): Promise<DeviceRow | null> {
  const result = await query<DeviceRow>(
    `SELECT * FROM device WHERE staff_id = $1 AND device_fingerprint = $2 LIMIT 1`,
    [staffId, fingerprint],
  );
  return result.rows[0] ?? null;
}

/**
 * Creates a confirmed-session for `staff`. Device resolution must already have
 * happened (confirmed device id or null for admin_web) before calling this.
 */
async function openSession(
  staff: StaffAuthRow,
  source: 'admin_web' | 'agent_mobile',
  deviceId: string | null,
  meta: RequestMeta,
): Promise<LoginResult> {
  return transaction(async (client) => {
    const issuedAt = new Date();
    const expiresAt = new Date(issuedAt.getTime() + REFRESH_TTL_MS);

    const session = await client.query<IdRow>(
      `INSERT INTO staff_session (staff_id, device_id, source, ip_address, user_agent, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id`,
      [
        staff.id,
        deviceId,
        source,
        meta.ipAddress ?? null,
        meta.userAgent ?? null,
        expiresAt,
      ],
    );
    const sessionId = session.rows[0]?.id;
    if (!sessionId) throw new Error('failed to create staff session');

    const refreshToken = generateOpaqueToken();
    const tokenHash = sha256Hex(refreshToken);
    await client.query(
      `INSERT INTO refresh_token (session_id, staff_id, token_hash, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [sessionId, staff.id, tokenHash, expiresAt],
    );

    // Fresh successful sign-in clears any expired lock and resets counters.
    await client.query(
      `UPDATE staff
          SET status = 'active', failed_login_attempts = 0, locked_until = NULL,
              last_login_at = now(), updated_at = now()
        WHERE id = $1`,
      [staff.id],
    );
    if (deviceId) {
      await client.query(`UPDATE device SET last_used_at = now() WHERE id = $1`, [deviceId]);
    }

    await insertLoginEvent(client, {
      staffId: staff.id,
      staffCode: staff.staff_code,
      outcome: 'success',
      deviceId,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const auditMeta: Record<string, unknown> = { source };
    if (deviceId) auditMeta.deviceId = deviceId;
    await audit(client, {
      ...actorAuditBase({
        staffId: staff.id,
        staffCode: staff.staff_code,
        fullName: staff.full_name,
        role: staff.role_code as StaffRole,
        branchId: staff.branch_id,
        isProtected: false,
        source,
        sessionId,
        deviceId,
        permissions: [],
      }),
      action: AUDIT_ACTIONS.AUTH_LOGIN_SUCCESS,
      entityType: 'session',
      entityId: sessionId,
      metadata: auditMeta,
    });

    const accessToken = await signAccessToken({
      staffId: staff.id,
      staffCode: staff.staff_code,
      role: staff.role_code as StaffRole,
      source,
      sessionId,
      deviceId,
      branchId: staff.branch_id,
    });

    return {
      accessToken,
      refreshToken,
      tokenType: 'Bearer' as const,
      expiresIn: env.jwt.accessTokenTtlMinutes * 60,
      staff: {
        id: staff.id,
        staffCode: staff.staff_code,
        fullName: staff.full_name,
        role: staff.role_code as StaffRole,
        branchId: staff.branch_id,
        source,
      },
    };
  });
}

export async function login(input: LoginInput, meta: RequestMeta = {}): Promise<LoginResult> {
  const staff = await findStaffByCode(input.staffCode);

  if (!staff) {
    // Equalize timing, then log the unknown-code attempt (autocommit so it
    // survives the throw) and respond with the generic credential error.
    await verifyAgainstPlaceholder(input.password);
    await query(
      `INSERT INTO login_event (staff_code, outcome, failure_reason, ip_address, user_agent)
       VALUES ($1, 'failure', 'unknown_staff_code', $2, $3)`,
      [input.staffCode, meta.ipAddress ?? null, meta.userAgent ?? null],
    );
    throw new InvalidCredentialsError();
  }

  // Account state pre-checks (generic messages only; spec §6.2).
  if (staff.status === 'disabled' || (staff.exit_date && staff.exit_date <= istBusinessDate())) {
    await insertLoginEvent(await poolForEvent(), {
      staffId: staff.id,
      staffCode: staff.staff_code,
      outcome: 'failure',
      failureReason: 'account_disabled',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    throw new UnauthorizedError('Account has been deactivated', 'AUTH_ACCOUNT_DISABLED');
  }

  // Active lock window → locked_out event + AccountLockedError.
  if (staff.status === 'locked' && staff.locked_until && staff.locked_until.getTime() > Date.now()) {
    await query(
      `INSERT INTO login_event (staff_id, staff_code, outcome, failure_reason, ip_address, user_agent)
       VALUES ($1, $2, 'locked_out', 'lock_active', $3, $4)`,
      [staff.id, staff.staff_code, meta.ipAddress ?? null, meta.userAgent ?? null],
    );
    throw new AccountLockedError(staff.locked_until.toISOString());
  }

  // Lock window has expired → auto-unlock before this attempt (fresh window).
  if (staff.status === 'locked') {
    await query(
      `UPDATE staff SET status = 'active', failed_login_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [staff.id],
    );
    staff.status = 'active';
    staff.failed_login_attempts = 0;
    staff.locked_until = null;
  }

  const passwordValid = await verify(staff.password_hash, input.password);
  if (!passwordValid) {
    const attempts = staff.failed_login_attempts + 1;
    if (attempts >= env.session.maxLoginAttempts) {
      const lockedUntil = new Date(Date.now() + env.session.lockoutMinutes * 60_000);
      await query(
        `UPDATE staff
            SET status = 'locked', locked_until = $2, failed_login_attempts = $3, updated_at = now()
          WHERE id = $1`,
        [staff.id, lockedUntil, attempts],
      );
      await insertLoginEvent(await poolForEvent(), {
        staffId: staff.id,
        staffCode: staff.staff_code,
        outcome: 'locked_out',
        failureReason: 'max_attempts',
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      logger.warn({ staffCode: staff.staff_code }, 'staff account locked after repeated failures');
      throw new AccountLockedError(lockedUntil.toISOString());
    }
    await query(
      `UPDATE staff SET failed_login_attempts = $2, updated_at = now() WHERE id = $1`,
      [staff.id, attempts],
    );
    await insertLoginEvent(await poolForEvent(), {
      staffId: staff.id,
      staffCode: staff.staff_code,
      outcome: 'failure',
      failureReason: 'invalid_password',
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });
    throw new InvalidCredentialsError();
  }

  // NDA gate — login is refused until a signed NDA is on file.
  if (!staff.nda_signed) {
    throw new ForbiddenError('Your account must have a signed NDA on file', 'AUTH_NDA_REQUIRED');
  }

  // Device resolution (agent_mobile only; admin_web sessions are not bound).
  let deviceId: string | null = null;
  if (input.source === 'agent_mobile') {
    if (!input.deviceFingerprint) {
      throw new UnauthorizedError('Device identification is required for mobile sign-in', 'AUTH_DEVICE_INVALID');
    }
    const device = await findDevice(staff.id, input.deviceFingerprint);
    if (!device) {
      // First contact from this device → register a pending device and halt.
      const created = await query<IdRow>(
        `INSERT INTO device (staff_id, device_type, device_name, device_fingerprint, app_version, status)
         VALUES ($1, 'agent_mobile', $2, $3, $4, 'pending')
         RETURNING id`,
        [staff.id, input.deviceName ?? null, input.deviceFingerprint, input.appVersion ?? null],
      );
      const newDeviceId = created.rows[0]?.id;
      if (!newDeviceId) throw new Error('failed to register device');
      await insertLoginEvent(await poolForEvent(), {
        staffId: staff.id,
        staffCode: staff.staff_code,
        outcome: 'device_pending',
        deviceId: newDeviceId,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new DevicePendingError(newDeviceId);
    }
    if (device.status === 'pending') {
      await insertLoginEvent(await poolForEvent(), {
        staffId: staff.id,
        staffCode: staff.staff_code,
        outcome: 'device_pending',
        deviceId: device.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new DevicePendingError(device.id);
    }
    if (device.status === 'disabled') {
      await insertLoginEvent(await poolForEvent(), {
        staffId: staff.id,
        staffCode: staff.staff_code,
        outcome: 'failure',
        failureReason: 'device_disabled',
        deviceId: device.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
      });
      throw new DeviceDisabledError();
    }
    deviceId = device.id;
  }

  return openSession(staff, input.source, deviceId, meta);
}

/**
 * The failure paths above run autocommit statements on the pool. This helper
 * returns a PoolClient-compatible adapter only for inserts; the pool `query`
 * function is used directly to keep signatures uniform.
 */
function poolForEvent(): PoolClient {
  // `query` from client.ts is pool-backed and autocommits — acceptable as a
  // minimal PoolClient stand-in for single INSERT statements.
  return { query: (text: string, params?: ReadonlyArray<unknown>) => query(text, params) } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// Refresh rotation (spec §7.1 — reuse detection + successor chain)
// ---------------------------------------------------------------------------

export async function refresh(input: RefreshInput, meta: RequestMeta = {}): Promise<TokenResult> {
  const tokenHash = sha256Hex(input.refreshToken);

  const lookup = await query<RefreshLookupRow>(
    `SELECT rt.id AS token_id, rt.session_id, rt.staff_id, rt.token_hash, rt.used_at,
            rt.expires_at, rt.revoked_at,
            ss.source AS session_source, ss.device_id AS session_device_id,
            ss.revoked_at AS session_revoked_at, ss.expires_at AS session_expires_at,
            st.staff_code, st.full_name, st.branch_id, st.status AS staff_status,
            st.nda_signed, st.exit_date, st.locked_until, r.code AS role_code
       FROM refresh_token rt
       JOIN staff_session ss ON ss.id = rt.session_id
       JOIN staff st ON st.id = rt.staff_id
       JOIN role r ON r.id = st.role_id
      WHERE rt.token_hash = $1
      LIMIT 1`,
    [tokenHash],
  );
  const row = lookup.rows[0];
  if (!row || row.revoked_at) {
    throw new RefreshTokenError();
  }

  // Account state that would invalidate any session.
  if (
    row.staff_status === 'disabled' ||
    (row.exit_date && row.exit_date <= istBusinessDate())
  ) {
    throw new UnauthorizedError('Account has been deactivated', 'AUTH_ACCOUNT_DISABLED');
  }
  if (row.staff_status === 'locked' && row.locked_until && row.locked_until.getTime() > Date.now()) {
    throw new AccountLockedError(row.locked_until.toISOString());
  }
  if (row.session_revoked_at) {
    throw new SessionExpiredError();
  }
  if (row.session_expires_at.getTime() <= Date.now()) {
    throw new SessionExpiredError();
  }
  if (row.used_at) {
    // A previously-rotated token presented again → compromise. Revoke the whole
    // session family (autocommit so the cascade survives the throw below).
    await revokeSessionFamily(poolForEvent(), row.session_id, 'refresh token reuse detected');
    await appendAuditEvent(await poolForEvent(), {
      action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
      entityType: 'session',
      entityId: row.session_id,
      source: row.session_source,
      requestId: meta.requestId ?? null,
      businessDate: istBusinessDate(),
      metadata: { tokenId: row.token_id, staffCode: row.staff_code },
    });
    logger.warn(
      { staffCode: row.staff_code, sessionId: row.session_id },
      'refresh token reuse detected — session revoked',
    );
    throw new RefreshTokenError();
  }

  // Rotate atomically. The UPDATE ... WHERE used_at IS NULL is the concurrency
  // guard: the second of two simultaneous refreshes matches zero rows and is
  // treated as reuse.
  type RotationOutcome =
    | { ok: true; refreshToken: string; expiresAt: Date }
    | { ok: false; reason: 'reuse' };

  const outcome = await transaction<RotationOutcome>(async (client) => {
    const claim = await client.query<IdRow>(
      `UPDATE refresh_token
          SET used_at = now()
        WHERE id = $1 AND used_at IS NULL AND revoked_at IS NULL
        RETURNING id`,
      [row.token_id],
    );
    if (claim.rows.length === 0) {
      await revokeSessionFamily(client, row.session_id, 'refresh token reuse detected');
      await audit(client, {
        action: AUDIT_ACTIONS.AUTH_REFRESH_REUSE_DETECTED,
        entityType: 'session',
        entityId: row.session_id,
        source: row.session_source,
        requestId: meta.requestId ?? null,
        metadata: { tokenId: row.token_id, staffCode: row.staff_code },
      });
      return { ok: false as const, reason: 'reuse' as const };
    }

    // Slide the session forward (keeps interactive sessions alive across
    // refreshes) and issue the successor token (successor chain).
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);
    await client.query(
      `UPDATE staff_session
          SET expires_at = $2, last_seen_at = now(), updated_at = now()
        WHERE id = $1 AND revoked_at IS NULL`,
      [row.session_id, expiresAt],
    );

    const nextRefreshToken = generateOpaqueToken();
    await client.query(
      `INSERT INTO refresh_token (session_id, staff_id, token_hash, expires_at, successor_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [row.session_id, row.staff_id, sha256Hex(nextRefreshToken), expiresAt, row.token_id],
    );

    const auditMeta: Record<string, unknown> = { source: row.session_source };
    if (row.session_device_id) auditMeta.deviceId = row.session_device_id;
    await audit(client, {
      actorStaffId: row.staff_id,
      actorRole: row.role_code,
      actorStaffCode: row.staff_code,
      action: AUDIT_ACTIONS.AUTH_REFRESH_ROTATED,
      entityType: 'session',
      entityId: row.session_id,
      source: row.session_source,
      requestId: meta.requestId ?? null,
      metadata: auditMeta,
    });

    return { ok: true as const, refreshToken: nextRefreshToken, expiresAt };
  });

  if (!outcome.ok) {
    throw new RefreshTokenError();
  }

  const accessToken = await signAccessToken({
    staffId: row.staff_id,
    staffCode: row.staff_code,
    role: row.role_code as StaffRole,
    source: row.session_source,
    sessionId: row.session_id,
    deviceId: row.session_device_id,
    branchId: row.branch_id,
  });

  return {
    accessToken,
    refreshToken: outcome.refreshToken,
    tokenType: 'Bearer',
    expiresIn: env.jwt.accessTokenTtlMinutes * 60,
    session: { id: row.session_id, expiresAt: outcome.expiresAt.toISOString() },
  };
}

async function revokeSessionFamily(client: PoolClient, sessionId: string, reason: string): Promise<void> {
  await client.query(
    `UPDATE refresh_token SET revoked_at = now(), revoked_reason = $2
      WHERE session_id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
  await client.query(
    `UPDATE staff_session SET revoked_at = now(), revoked_reason = $2 WHERE id = $1 AND revoked_at IS NULL`,
    [sessionId, reason],
  );
}

// ---------------------------------------------------------------------------
// Logout & session info
// ---------------------------------------------------------------------------

export interface ChangePasswordResult {
  success: true;
  /** Number of OTHER sessions revoked because the credential rotated. */
  revokedOtherSessions: number;
}

/**
 * Self-service credential rotation (spec §7.1, §6.2).
 *
 * Any authenticated principal — including the immutable protected root
 * account — may rotate its OWN password after proving ownership of the current
 * one. The `PROTECTED_ACCOUNT` immutability guarantee is intentionally NOT
 * applied here: it protects the account from demotion / deactivation / deletion
 * by others, but the owner must always be able to change their own credential
 * (a standard production requirement — otherwise the root credential could
 * never be rotated). Ownership is enforced structurally: the update is scoped
 * to `actor.staffId` and there is no id parameter to target another account.
 *
 * Every OTHER live session for the caller is revoked so a leaked credential
 * cannot persist after rotation; the calling session stays valid.
 */
export async function changeOwnPassword(
  actor: AuthContext,
  input: ChangePasswordInput,
  meta: RequestMeta = {},
): Promise<ChangePasswordResult> {
  const revokedOtherSessions = await transaction<number>(async (client) => {
    const found = await client.query<StaffAuthRow>(
      `SELECT st.*, r.code AS role_code
         FROM staff st
         JOIN role r ON r.id = st.role_id
        WHERE st.id = $1
        LIMIT 1
        FOR UPDATE`,
      [actor.staffId],
    );
    const existing = found.rows[0];
    if (!existing) throw new UnauthorizedError();

    const currentValid = await verify(existing.password_hash, input.currentPassword);
    if (!currentValid) {
      throw new UnauthorizedError(
        'Current password is incorrect',
        'AUTH_CURRENT_PASSWORD_INVALID',
      );
    }

    const passwordHash = await hashPassword(input.newPassword);
    await client.query(`UPDATE staff SET password_hash = $1, updated_at = now() WHERE id = $2`, [
      passwordHash,
      actor.staffId,
    ]);

    // Revoke every other session (and its refresh tokens) for this staff member.
    const revoked = await client.query(
      `UPDATE staff_session SET revoked_at = now(), revoked_reason = $2
        WHERE staff_id = $1 AND id <> $3 AND revoked_at IS NULL`,
      [actor.staffId, 'password_changed', actor.sessionId],
    );
    await client.query(
      `UPDATE refresh_token SET revoked_at = now(), revoked_reason = $2
        WHERE session_id IN (SELECT id FROM staff_session WHERE staff_id = $1 AND id <> $3)
          AND revoked_at IS NULL`,
      [actor.staffId, 'password_changed', actor.sessionId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_PASSWORD_CHANGED,
      entityType: 'staff',
      entityId: actor.staffId,
      metadata: { revokedOtherSessions: revoked.rowCount ?? 0 },
    });

    return revoked.rowCount ?? 0;
  });

  return { success: true, revokedOtherSessions };
}

export async function logout(actor: AuthContext, meta: RequestMeta = {}): Promise<{ success: true }> {
  await transaction(async (client) => {
    await revokeSessionFamily(client, actor.sessionId, 'logout');
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_LOGOUT,
      entityType: 'session',
      entityId: actor.sessionId,
    });
  });
  return { success: true };
}

type SessionInfoRow = {
  session_id: string;
  source: 'admin_web' | 'agent_mobile';
  ip_address: string | null;
  user_agent: string | null;
  issued_at: Date;
  last_seen_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
  revoked_reason: string | null;
  device_id: string | null;
  device_name: string | null;
  device_status: 'pending' | 'confirmed' | 'disabled' | null;
  staff_id: string;
  staff_code: string;
  full_name: string;
  role_code: string;
  branch_id: string | null;
};

export interface SessionInfo {
  id: string;
  staff: {
    id: string;
    staffCode: string;
    fullName: string;
    role: StaffRole;
    branchId: string | null;
  };
  source: 'admin_web' | 'agent_mobile';
  ipAddress: string | null;
  userAgent: string | null;
  issuedAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedReason: string | null;
  idleTimeoutMinutes: number;
  device: { id: string; deviceName: string | null; status: 'pending' | 'confirmed' | 'disabled' } | null;
}

export async function getSession(actor: AuthContext): Promise<SessionInfo> {
  const result = await query<SessionInfoRow>(
    `SELECT ss.id AS session_id, ss.source, ss.ip_address, ss.user_agent,
            ss.issued_at, ss.last_seen_at, ss.expires_at, ss.revoked_at, ss.revoked_reason,
            ss.device_id, d.device_name, d.status AS device_status,
            st.id AS staff_id, st.staff_code, st.full_name, st.branch_id, r.code AS role_code
       FROM staff_session ss
       JOIN staff st ON st.id = ss.staff_id
       JOIN role r ON r.id = st.role_id
       LEFT JOIN device d ON d.id = ss.device_id
      WHERE ss.id = $1
      LIMIT 1`,
    [actor.sessionId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new SessionExpiredError();
  }
  return {
    id: row.session_id,
    staff: {
      id: row.staff_id,
      staffCode: row.staff_code,
      fullName: row.full_name,
      role: row.role_code as StaffRole,
      branchId: row.branch_id,
    },
    source: row.source,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    issuedAt: row.issued_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    revokedAt: iso(row.revoked_at),
    revokedReason: row.revoked_reason,
    idleTimeoutMinutes: env.session.idleMinutes,
    device: row.device_id
      ? { id: row.device_id, deviceName: row.device_name, status: row.device_status ?? 'pending' }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Device registry (spec §7.1 — register / confirm / disable / list)
// ---------------------------------------------------------------------------

export async function registerDevice(
  actor: AuthContext,
  input: RegisterDeviceInput,
  meta: RequestMeta = {},
): Promise<DeviceView> {
  const existing = await findDevice(actor.staffId, input.deviceFingerprint);
  if (existing) {
    if (existing.status === 'confirmed') return toDeviceView(existing);
    if (existing.status === 'disabled') throw new DeviceDisabledError();
    throw new DevicePendingError(existing.id);
  }

  const created = await transaction<DeviceRow>(async (client) => {
    const insert = await client.query<DeviceRow>(
      `INSERT INTO device (staff_id, device_type, device_name, device_fingerprint, app_version, status)
       VALUES ($1, 'agent_mobile', $2, $3, $4, 'pending')
       RETURNING *`,
      [actor.staffId, input.deviceName ?? null, input.deviceFingerprint, input.appVersion ?? null],
    );
    const deviceRow = insert.rows[0];
    if (!deviceRow) throw new Error('failed to register device');
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_DEVICE_REGISTERED,
      entityType: 'device',
      entityId: deviceRow.id,
      metadata: { deviceType: deviceRow.device_type, deviceName: deviceRow.device_name ?? null },
    });
    return deviceRow;
  });
  return toDeviceView(created);
}

export async function listDevices(
  actor: AuthContext,
  filters: { status?: 'pending' | 'confirmed' | 'disabled'; staffId?: string; limit?: number; offset?: number },
  meta: RequestMeta = {},
): Promise<{ total: number; items: DeviceView[] }> {
  void meta;
  const canViewAll = actor.permissions.includes('security.read');
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (canViewAll && filters.staffId) {
    where.push(`d.staff_id = ${addParam(filters.staffId)}`);
  } else if (!canViewAll) {
    where.push(`d.staff_id = ${addParam(actor.staffId)}`);
  }
  if (filters.status) {
    where.push(`d.status = ${addParam(filters.status)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(filters.limit ?? 50, 1), 100);
  const offset = Math.max(filters.offset ?? 0, 0);

  const result = await query<DeviceRow & { total: number }>(
    `SELECT d.*, count(*) OVER()::int AS total
       FROM device d
       ${whereSql}
      ORDER BY d.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  return { total, items: result.rows.map((row) => toDeviceView(row)) };
}

async function findDeviceById(deviceId: string): Promise<DeviceRow | null> {
  const result = await query<DeviceRow>(`SELECT * FROM device WHERE id = $1 LIMIT 1`, [deviceId]);
  return result.rows[0] ?? null;
}

export async function confirmDevice(
  deviceId: string,
  actor: AuthContext,
  meta: RequestMeta = {},
): Promise<DeviceView> {
  const device = await findDeviceById(deviceId);
  if (!device) throw new NotFoundError('Device');
  if (device.status === 'disabled') {
    throw new BusinessRuleError('A disabled device cannot be confirmed', 'DEVICE_DISABLED');
  }
  if (device.status === 'confirmed') return toDeviceView(device);

  const confirmed = await transaction<DeviceRow>(async (client) => {
    const update = await client.query<DeviceRow>(
      `UPDATE device
          SET status = 'confirmed', confirmed_at = now(), confirmed_by = $2, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [deviceId, actor.staffId],
    );
    const row = update.rows[0];
    if (!row) throw new NotFoundError('Device');
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_DEVICE_CONFIRMED,
      entityType: 'device',
      entityId: row.id,
      metadata: { staffId: row.staff_id, confirmedBy: actor.staffId },
    });
    return row;
  });
  return toDeviceView(confirmed);
}

export async function disableDevice(
  deviceId: string,
  actor: AuthContext,
  input: DisableDeviceInput,
  meta: RequestMeta = {},
): Promise<DeviceView> {
  const device = await findDeviceById(deviceId);
  if (!device) throw new NotFoundError('Device');
  if (device.status === 'disabled') {
    throw new ConflictError('Device is already disabled', 'ALREADY_DISABLED');
  }

  const disabled = await transaction<DeviceRow>(async (client) => {
    const update = await client.query<DeviceRow>(
      `UPDATE device
          SET status = 'disabled', disabled_at = now(), disabled_by = $2,
              disabled_reason = $3, updated_at = now()
        WHERE id = $1
        RETURNING *`,
      [deviceId, actor.staffId, input.reason ?? null],
    );
    const row = update.rows[0];
    if (!row) throw new NotFoundError('Device');

    // Immediately revoke every live session bound to this device.
    const sessions = await client.query<IdRow>(
      `SELECT id FROM staff_session WHERE device_id = $1 AND revoked_at IS NULL`,
      [deviceId],
    );
    const sessionIds = sessions.rows.map((s) => s.id);
    if (sessionIds.length > 0) {
      await client.query(
        `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'device disabled'
          WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [sessionIds],
      );
      await client.query(
        `UPDATE staff_session SET revoked_at = now(), revoked_reason = 'device disabled', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [sessionIds],
      );
    }

    const auditMeta: Record<string, unknown> = { staffId: row.staff_id, disabledBy: actor.staffId };
    if (row.disabled_reason) auditMeta.reason = row.disabled_reason;
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_DEVICE_DISABLED,
      entityType: 'device',
      entityId: row.id,
      metadata: auditMeta,
    });
    return row;
  });
  return toDeviceView(disabled);
}

// ---------------------------------------------------------------------------
// Staff administration (spec §7.1 — create / update / unlock / deactivate)
// ---------------------------------------------------------------------------

type StaffSelectRow = {
  id: string;
  staff_code: string;
  full_name: string;
  role_code: string;
  branch_id: string | null;
  is_protected: boolean;
  email: string | null;
  phone: string | null;
  status: 'active' | 'locked' | 'disabled';
  mfa_enabled: boolean;
  nda_signed: boolean;
  exit_date: string | null;
  locked_until: Date | null;
  failed_login_attempts: number;
  last_login_at: Date | null;
  created_at: Date;
};

async function selectStaffById(client: PoolClient, staffId: string): Promise<StaffSelectRow | null> {
  const result = await client.query<StaffSelectRow>(
    `SELECT st.id, st.staff_code, st.full_name, r.code AS role_code, st.branch_id, st.is_protected,
            st.email, st.phone, st.status, st.mfa_enabled, st.nda_signed, st.exit_date,
            st.locked_until, st.failed_login_attempts, st.last_login_at, st.created_at
       FROM staff st
       JOIN role r ON r.id = st.role_id
      WHERE st.id = $1
      LIMIT 1`,
    [staffId],
  );
  return result.rows[0] ?? null;
}

function toStaffView(row: StaffSelectRow): StaffView {
  return {
    id: row.id,
    staffCode: row.staff_code,
    fullName: row.full_name,
    roleCode: row.role_code as StaffRole,
    branchId: row.branch_id,
    isProtected: row.is_protected,
    email: row.email,
    phone: row.phone,
    status: row.status,
    mfaEnabled: row.mfa_enabled,
    ndaSigned: row.nda_signed,
    exitDate: row.exit_date,
    lockedUntil: iso(row.locked_until),
    failedLoginAttempts: row.failed_login_attempts,
    lastLoginAt: iso(row.last_login_at),
    createdAt: row.created_at.toISOString(),
  };
}

async function resolveRoleId(client: PoolClient, roleCode: string): Promise<string> {
  const result = await client.query<IdRow>(`SELECT id FROM role WHERE code = $1 LIMIT 1`, [roleCode]);
  const roleId = result.rows[0]?.id;
  if (!roleId) {
    throw new BusinessRuleError(`Role '${roleCode}' is not recognised`, 'UNKNOWN_ROLE');
  }
  return roleId;
}

async function assertBranchExists(client: PoolClient, branchId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM branch WHERE id = $1`, [branchId]);
  if (result.rows.length === 0) {
    throw new BadRequestError('Branch does not exist');
  }
}

export async function createStaff(
  actor: AuthContext,
  input: CreateStaffInput,
  meta: RequestMeta = {},
): Promise<StaffView> {
  const created = await transaction<StaffSelectRow>(async (client) => {
    const roleId = await resolveRoleId(client, input.roleCode);
    if (input.branchId) await assertBranchExists(client, input.branchId);

    const passwordHash = await hashPassword(input.password);
    let staffId: string;
    try {
      const insert = await client.query<IdRow>(
        `INSERT INTO staff
           (staff_code, full_name, role_id, branch_id, email, phone, password_hash,
            status, nda_signed, mfa_enabled, exit_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8, $9, $10, $11)
         RETURNING id`,
        [
          input.staffCode,
          input.fullName,
          roleId,
          input.branchId ?? null,
          input.email ?? null,
          input.phone ?? null,
          passwordHash,
          input.ndaSigned ?? false,
          input.mfaEnabled ?? false,
          input.exitDate ?? null,
          actor.staffId,
        ],
      );
      const inserted = insert.rows[0];
      if (!inserted) throw new Error('failed to create staff');
      staffId = inserted.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError(
          'A staff member with this code already exists',
          'STAFF_CODE_EXISTS',
          { staffCode: input.staffCode },
        );
      }
      throw error;
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.STAFF_CREATED,
      entityType: 'staff',
      entityId: staffId,
      metadata: {
        staffCode: input.staffCode,
        role: input.roleCode,
        branchId: input.branchId ?? null,
        createdBy: actor.staffId,
      },
    });

    const row = await selectStaffById(client, staffId);
    if (!row) throw new Error('failed to load created staff');
    return row;
  });
  return toStaffView(created);
}

export async function updateStaff(
  actor: AuthContext,
  staffId: string,
  input: UpdateStaffInput,
  meta: RequestMeta = {},
): Promise<StaffView> {
  const updated = await transaction<StaffSelectRow>(async (client) => {
    const existing = await selectStaffById(client, staffId);
    if (!existing) throw new NotFoundError('Staff');
    if (existing.is_protected) {
      throw new BusinessRuleError(
        'This is a protected system account and cannot be modified',
        'PROTECTED_ACCOUNT',
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    if (input.fullName !== undefined) push('full_name', input.fullName);
    if (input.roleCode !== undefined) {
      const roleId = await resolveRoleId(client, input.roleCode);
      push('role_id', roleId);
      // Never leave the organisation without an active Managing Director.
      if (
        existing.role_code === 'managing_director' &&
        input.roleCode !== 'managing_director' &&
        !(await hasOtherActiveManagingDirector(client, staffId))
      ) {
        throw new BusinessRuleError(
          'The organisation must keep at least one active Managing Director',
          'LAST_MANAGING_DIRECTOR',
        );
      }
    }
    if (input.branchId !== undefined) {
      if (input.branchId) await assertBranchExists(client, input.branchId);
      push('branch_id', input.branchId);
    }
    if (input.email !== undefined) push('email', input.email);
    if (input.phone !== undefined) push('phone', input.phone);
    if (input.password !== undefined) push('password_hash', await hashPassword(input.password));
    if (input.ndaSigned !== undefined) push('nda_signed', input.ndaSigned);
    if (input.mfaEnabled !== undefined) push('mfa_enabled', input.mfaEnabled);
    if (input.exitDate !== undefined) push('exit_date', input.exitDate);

    // Re-registration of a deactivated account (spec §7.1 — no self-service
    // reset): a fresh password plus a signed NDA reactivates the record.
    const reactivating =
      existing.status === 'disabled' && input.password !== undefined && input.ndaSigned === true;
    if (reactivating) {
      push('status', 'active');
      push('failed_login_attempts', 0);
      push('locked_until', null);
      push('exit_date', null);
    }

    if (sets.length === 0) {
      // Nothing to change — return current state untouched.
      return existing;
    }

    await client.query(`UPDATE staff SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length + 1}`, [
      ...values,
      staffId,
    ]);

    const changed = await selectStaffById(client, staffId);
    if (!changed) throw new Error('failed to reload staff');

    const auditMeta: Record<string, unknown> = {
      fields: input !== null ? Object.keys(input).filter((k) => input[k as keyof UpdateStaffInput] !== undefined) : [],
      updatedBy: actor.staffId,
    };
    if (reactivating) auditMeta.reactivated = true;
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.STAFF_UPDATED,
      entityType: 'staff',
      entityId: staffId,
      metadata: auditMeta,
    });
    return changed;
  });
  return toStaffView(updated);
}

async function hasOtherActiveManagingDirector(client: PoolClient, excludeStaffId: string): Promise<boolean> {
  const result = await client.query<CountRow>(
    `SELECT count(*)::int AS count
       FROM staff st
       JOIN role r ON r.id = st.role_id
      WHERE r.code = 'managing_director' AND st.status = 'active' AND st.id <> $1`,
    [excludeStaffId],
  );
  return (result.rows[0]?.count ?? 0) > 0;
}

export async function unlockStaff(
  actor: AuthContext,
  staffId: string,
  meta: RequestMeta = {},
): Promise<StaffView> {
  const result = await transaction<StaffSelectRow>(async (client) => {
    const existing = await selectStaffById(client, staffId);
    if (!existing) throw new NotFoundError('Staff');

    if (existing.status !== 'locked') {
      return existing;
    }

    await client.query(
      `UPDATE staff SET status = 'active', failed_login_attempts = 0, locked_until = NULL, updated_at = now()
        WHERE id = $1`,
      [staffId],
    );
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.AUTH_ACCOUNT_UNLOCKED,
      entityType: 'staff',
      entityId: staffId,
      metadata: { staffCode: existing.staff_code, unlockedBy: actor.staffId },
    });

    const row = await selectStaffById(client, staffId);
    if (!row) throw new Error('failed to reload staff');
    return row;
  });
  return toStaffView(result);
}

export async function deactivateStaff(
  actor: AuthContext,
  staffId: string,
  input: DeactivateStaffInput,
  meta: RequestMeta = {},
): Promise<StaffView> {
  const result = await transaction<StaffSelectRow>(async (client) => {
    const existing = await selectStaffById(client, staffId);
    if (!existing) throw new NotFoundError('Staff');
    if (existing.is_protected) {
      throw new BusinessRuleError(
        'This is a protected system account and cannot be deactivated',
        'PROTECTED_ACCOUNT',
      );
    }
    if (existing.id === actor.staffId) {
      throw new BusinessRuleError('You cannot deactivate your own account', 'SELF_DEACTIVATION');
    }
    if (existing.status === 'disabled') {
      throw new ConflictError('Staff account is already deactivated', 'ALREADY_DEACTIVATED');
    }
    if (
      existing.role_code === 'managing_director' &&
      !(await hasOtherActiveManagingDirector(client, staffId))
    ) {
      throw new BusinessRuleError(
        'The organisation must keep at least one active Managing Director',
        'LAST_MANAGING_DIRECTOR',
      );
    }

    await client.query(
      `UPDATE staff
          SET status = 'disabled', exit_date = COALESCE(exit_date, $2), updated_at = now()
        WHERE id = $1`,
      [staffId, istBusinessDate()],
    );

    // Revoke all live sessions for the leaving staff member.
    const sessions = await client.query<IdRow>(
      `SELECT id FROM staff_session WHERE staff_id = $1 AND revoked_at IS NULL`,
      [staffId],
    );
    const sessionIds = sessions.rows.map((s) => s.id);
    if (sessionIds.length > 0) {
      await client.query(
        `UPDATE refresh_token SET revoked_at = now(), revoked_reason = 'staff deactivated'
          WHERE session_id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [sessionIds],
      );
      await client.query(
        `UPDATE staff_session SET revoked_at = now(), revoked_reason = 'staff deactivated', updated_at = now()
          WHERE id = ANY($1::uuid[]) AND revoked_at IS NULL`,
        [sessionIds],
      );
    }

    const auditMeta: Record<string, unknown> = { staffCode: existing.staff_code, deactivatedBy: actor.staffId };
    if (input.reason) auditMeta.reason = input.reason;
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.STAFF_DEACTIVATED,
      entityType: 'staff',
      entityId: staffId,
      metadata: auditMeta,
    });

    const row = await selectStaffById(client, staffId);
    if (!row) throw new Error('failed to reload staff');
    return row;
  });
  return toStaffView(result);
}

// ---------------------------------------------------------------------------
// Staff listing / roles & permission matrix
// ---------------------------------------------------------------------------

type StaffListRow = StaffSelectRow & {
  branch_name: string | null;
  role_label: string;
  total: number;
};

export async function listStaff(
  actor: AuthContext,
  queryInput: ListStaffQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: StaffView[] }> {
  void actor;
  void meta;
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (queryInput.search) {
    const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    where.push(`(st.staff_code ILIKE ${addParam(pattern)} ESCAPE '\\' OR st.full_name ILIKE ${addParam(pattern)} ESCAPE '\\')`);
  }
  if (queryInput.role) {
    where.push(`r.code = ${addParam(queryInput.role)}`);
  }
  if (queryInput.status) {
    where.push(`st.status = ${addParam(queryInput.status)}`);
  }
  if (queryInput.branchId) {
    where.push(`st.branch_id = ${addParam(queryInput.branchId)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<StaffListRow>(
    `SELECT st.id, st.staff_code, st.full_name, r.code AS role_code, r.label AS role_label,
            st.branch_id, st.is_protected, b.name AS branch_name, st.email, st.phone, st.status,
            st.mfa_enabled, st.nda_signed, st.exit_date, st.locked_until,
            st.failed_login_attempts, st.last_login_at, st.created_at,
            count(*) OVER()::int AS total
       FROM staff st
       JOIN role r ON r.id = st.role_id
       LEFT JOIN branch b ON b.id = st.branch_id
       ${whereSql}
      ORDER BY st.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): StaffView & { roleLabel: string; branchName: string | null } => {
    const { role_label: roleLabel, branch_name: branchName, ...rest } = row;
    return { ...toStaffView(rest), roleLabel, branchName };
  });
  return { total, items };
}

export async function listRoles(actor: AuthContext, meta: RequestMeta = {}): Promise<RoleView[]> {
  void actor;
  void meta;
  const roles = await query<{ id: string; code: string; label: string; description: string | null; is_system: boolean }>(
    `SELECT id, code, label, description, is_system FROM role ORDER BY is_system DESC, code ASC`,
  );
  const permissions = await query<{ role_id: string; code: string }>(
    `SELECT rp.role_id, p.code
       FROM role_permission rp
       JOIN permission p ON p.id = rp.permission_id
      ORDER BY p.code ASC`,
  );

  const byRole = new Map<string, string[]>();
  for (const permission of permissions.rows) {
    const list = byRole.get(permission.role_id) ?? [];
    list.push(permission.code);
    byRole.set(permission.role_id, list);
  }

  return roles.rows.map((role) => ({
    id: role.id,
    code: role.code,
    label: role.label,
    description: role.description,
    isSystem: role.is_system,
    permissions: byRole.get(role.id) ?? [],
  }));
}

export async function patchRolePermissions(
  actor: AuthContext,
  roleId: string,
  input: RolePermissionsInput,
  meta: RequestMeta = {},
): Promise<{ roleId: string; permissionCodes: string[] }> {
  await transaction(async (client) => {
    const role = await client.query<IdRow>(`SELECT id FROM role WHERE id = $1 LIMIT 1`, [roleId]);
    if (!role.rows[0]) throw new NotFoundError('Role');

    // All supplied permission codes must exist.
    if (input.permissionCodes.length > 0) {
      const found = await client.query<{ code: string }>(
        `SELECT code FROM permission WHERE code = ANY($1::text[])`,
        [input.permissionCodes],
      );
      const foundSet = new Set(found.rows.map((f) => f.code));
      const missing = input.permissionCodes.filter((code) => !foundSet.has(code));
      if (missing.length > 0) {
        throw new BusinessRuleError(
          `Unknown permission codes: ${missing.join(', ')}`,
          'UNKNOWN_PERMISSION',
        );
      }
    }

    await client.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
    for (const code of input.permissionCodes) {
      const permission = await client.query<IdRow>(`SELECT id FROM permission WHERE code = $1 LIMIT 1`, [code]);
      const permissionId = permission.rows[0]?.id;
      if (!permissionId) {
        throw new BusinessRuleError(`Unknown permission code: ${code}`, 'UNKNOWN_PERMISSION');
      }
      await client.query(
        `INSERT INTO role_permission (role_id, permission_id) VALUES ($1, $2)`,
        [roleId, permissionId],
      );
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.ROLE_PERMISSIONS_UPDATED,
      entityType: 'role',
      entityId: roleId,
      metadata: { permissionCodes: input.permissionCodes, updatedBy: actor.staffId },
    });
  });
  return { roleId, permissionCodes: input.permissionCodes };
}

// ---------------------------------------------------------------------------
// pg error helpers
// ---------------------------------------------------------------------------

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === '23505'
  );
}

