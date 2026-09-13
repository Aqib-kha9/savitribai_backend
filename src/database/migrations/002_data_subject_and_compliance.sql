-- =============================================================================
-- Migration 002 — Data-subject rights & compliance (docs/backend-master-spec.md §24)
--
-- Adds:
--   1. data_subject_request — customer copy / correction / restriction /
--                             deletion requests with an M.D. decision trail
--                             (spec §24.2: "Data-subject request endpoints:
--                             copy, correction, restriction, deletion (per
--                             customer request)"). Requests are append-only;
--                             even a completed deletion keeps the request row
--                             and the customer record (soft state transition —
--                             financial records are MANDATORILY RETAINED).
--   2. customer status extension — 'restricted' and 'deleted' are added to the
--                             customer.status CHECK domain. 'restricted'
--                             freezes further product opening / withdrawal
--                             activity pending resolution; 'deleted' marks the
--                             profile closed to further use while balance,
--                             loan and repayment-schedule records stay intact
--                             (spec §24.1 / §24.2). No hard delete ever occurs.
--
-- Privacy notice + consent wording (spec §24.2) is stored as JSONB templates
-- under app_setting keys 'privacy.notice' / 'privacy.consent' (seeded in
-- seed.ts). The generic app_setting store already supplies append-only
-- setting_change_history and an M.D. edit path (PATCH /settings) with audit —
-- so no dedicated template table is needed.
--
-- Conventions follow 001_schema.sql: UUID PKs, TIMESTAMPTZ in UTC, money as
-- NUMERIC(14,2), soft state transitions with an append-only history trail.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Data-subject request register (spec §24.2)
-- ---------------------------------------------------------------------------
CREATE TABLE data_subject_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  request_type TEXT NOT NULL
    CHECK (request_type IN ('copy', 'correction', 'restriction', 'deletion')),
  status TEXT NOT NULL DEFAULT 'received'
    CHECK (status IN ('received', 'in_progress', 'completed', 'rejected')),
  details TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Resolution trail (M.D. decides; spec §24.1 external reporting contact).
  decided_by UUID REFERENCES staff(id),
  decided_at TIMESTAMPTZ,
  decision_notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_data_subject_request_customer ON data_subject_request(customer_id, requested_at DESC);
CREATE INDEX idx_data_subject_request_status ON data_subject_request(status);

-- ---------------------------------------------------------------------------
-- Extend the customer status domain with 'restricted' and 'deleted'
-- (001_schema.sql defines the CHECK inline; it must be dropped and re-added).
-- ---------------------------------------------------------------------------
ALTER TABLE customer DROP CONSTRAINT customer_status_check;
ALTER TABLE customer ADD CONSTRAINT customer_status_check
  CHECK (status IN ('active','inactive','blocked','deceased','transferred','closed','restricted','deleted'));
