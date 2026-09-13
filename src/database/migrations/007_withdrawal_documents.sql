-- 007_withdrawal_documents
-- The AdminPages withdrawal workflow captures several controlled-transaction
-- fields (identity verification reference, purpose code, destination account
-- reference, bank UTR / external reference, supporting documents, consent
-- reference, cash handover reference, maker reference, device reference,
-- location, offline sync reference) that have no dedicated columns on
-- withdrawal_request. Mirror the loans module precedent
-- (loan_application.documents JSONB) and store them in a free-form `documents`
-- JSONB payload so the operator's worksheet round-trips with the request
-- without widening the validated request schema.

ALTER TABLE withdrawal_request
  ADD COLUMN IF NOT EXISTS documents JSONB;

COMMENT ON COLUMN withdrawal_request.documents IS
  'Free-form operator worksheet captured with the withdrawal request (identity / purpose / destination / settlement evidence references).';
