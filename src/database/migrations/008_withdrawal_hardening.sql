-- 008_withdrawal_hardening
-- Production hardening for the withdrawals module (docs/backend-master-spec.md §13).
--
-- 1. Idempotency key — mirrors collection_entry.idempotency_key. A client
--    (mobile/office integration) may replay POST /withdrawals after a network
--    failure; the SAME key must return the ORIGINAL request instead of creating
--    a duplicate money movement. Nullable so historical rows stay valid and
--    callers that omit the key keep their current behaviour.
-- 2. Cancellation columns — the `cancelled` status/event vocabulary already
--    exists (001_schema.sql CHECK constraints) but had no columns to record who
--    cancelled a withdrawal, when, and why. Add them so the terminal state is
--    auditable and the detail/history view can render the reason.
-- 3. Lookup indexes — a per-customer daily-limit check aggregates requests by
--    (customer_id, requested_on); a dedicated index keeps that O(log n).

ALTER TABLE withdrawal_request
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT,
  ADD COLUMN IF NOT EXISTS cancelled_by UUID REFERENCES staff(id),
  ADD COLUMN IF NOT EXISTS cancelled_on TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS cancellation_reason TEXT;

-- Unique when present; PostgreSQL allows many NULLs in a UNIQUE index, so the
-- historical (key-less) rows are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_idempotency
  ON withdrawal_request(idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- Per-customer daily-limit aggregate (business date + customer).
CREATE INDEX IF NOT EXISTS idx_withdrawal_customer_date
  ON withdrawal_request(customer_id, requested_on);

-- Pending-work queue scan used by the office dashboard.
CREATE INDEX IF NOT EXISTS idx_withdrawal_pending
  ON withdrawal_request(status)
  WHERE status IN ('pending','approved');

COMMENT ON COLUMN withdrawal_request.idempotency_key IS
  'Client-supplied 32-char lowercase hex key; replays of the same key return the original request.';
COMMENT ON COLUMN withdrawal_request.cancellation_reason IS
  'Reason recorded when a pending/approved withdrawal is cancelled before payout.';
