-- =============================================================================
-- Migration 003 — Super-administrator role & immutable protected accounts
--
-- Adds:
--   1. staff.is_protected — a boolean flag marking an account as immutable. A
--      protected account can never be edited, demoted or deactivated (backend
--      service guards + UI). Used for the root super-administrator.
--   2. role 'super_admin'   — a dedicated, system-level root role that holds
--      every permission unconditionally and bypasses all role/permission gates
--      (enforced in backend/src/core/permissions.ts + middleware/auth.ts).
--
-- The role ↔ permission matrix and the protected bootstrap account are
-- (re)seeded from backend/src/database/seed.ts on deploy, so this migration
-- only provisions the schema/role envelope and is safe to re-run.
--
-- Conventions follow 001_schema.sql / 002_*.sql: idempotent DDL, system roles
-- flagged is_system = true, soft state transitions only.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Immutable-account flag on the staff register
-- ---------------------------------------------------------------------------
ALTER TABLE staff ADD COLUMN IF NOT EXISTS is_protected BOOLEAN NOT NULL DEFAULT false;

-- ---------------------------------------------------------------------------
-- 2. Dedicated super-administrator role (system-owned, never editable away)
-- ---------------------------------------------------------------------------
INSERT INTO role (code, label, is_system)
VALUES ('super_admin', 'Super Administrator', true)
ON CONFLICT (code) DO UPDATE
  SET label = EXCLUDED.label,
      is_system = true,
      updated_at = now();
