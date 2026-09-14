-- 009_withdrawal_reversal
-- Reversal path for a PAID/CONFIRMED withdrawal payout (docs/backend-master-spec.md §13).
--
-- Before this migration the module could only CANCEL a request *before* payout
-- (migration 008). Once a payout had been posted and the savings ledger debited
-- there was no way to undo it through the domain — an operator would have had to
-- fall back to the unrelated savings-adjustment flow. A cash/bank payout that is
-- recalled (wrong amount, recalled transfer, customer dispute) therefore had no
-- auditable, module-owned path.
--
-- The reversal mirrors the immutable-ledger rule (§9.1 "original never
-- modified"): the original withdrawal debit row is untouched; a new compensating
-- 'reversal' CREDIT is appended to account_transaction and the request moves to
-- the terminal 'reversed' state.
--
-- 1. Reversed status + event vocabulary on the CHECK constraints.
-- 2. Columns capturing who reversed a payout, when, why, and the compensating
--    ledger entry id (the immutable link back to the credit that restored funds).

-- 1. Extend the status / event vocabulary (names are PostgreSQL's default
--    derived names for the inline CHECK constraints in 001_schema.sql).
ALTER TABLE withdrawal_request DROP CONSTRAINT IF EXISTS withdrawal_request_status_check;
ALTER TABLE withdrawal_request ADD CONSTRAINT withdrawal_request_status_check
  CHECK (status IN ('pending','approved','rejected','paid','confirmed','cancelled','reversed'));

ALTER TABLE withdrawal_event DROP CONSTRAINT IF EXISTS withdrawal_event_event_type_check;
ALTER TABLE withdrawal_event ADD CONSTRAINT withdrawal_event_event_type_check
  CHECK (event_type IN ('requested','approved','rejected','paid','confirmed','changed','cancelled','reversed'));

-- 2. Reversal columns. `reversal_transaction_id` is the compensating ledger
--    entry (null for non-savings kinds whose instrument encashment lives in its
--    own module, matching the existing payout boundary documented in the service).
ALTER TABLE withdrawal_request
  ADD COLUMN IF NOT EXISTS reversed_by UUID REFERENCES staff(id),
  ADD COLUMN IF NOT EXISTS reversed_on TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reversal_reason TEXT,
  ADD COLUMN IF NOT EXISTS reversal_transaction_id UUID REFERENCES account_transaction(id);

COMMENT ON COLUMN withdrawal_request.reversed_by IS
  'Managing Director who reversed a paid/confirmed payout.';
COMMENT ON COLUMN withdrawal_request.reversal_transaction_id IS
  'Compensating account_transaction credit that restored a savings payout (null for non-savings kinds).';
