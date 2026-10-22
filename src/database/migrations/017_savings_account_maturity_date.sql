-- =============================================================================
-- Migration 017 — Savings account maturity date & DAILY-180 scheme update
-- =============================================================================

-- Add maturity_date to savings_account for fixed-term deposit schemes (e.g. DAILY-180)
ALTER TABLE savings_account
  ADD COLUMN IF NOT EXISTS maturity_date DATE;

CREATE INDEX IF NOT EXISTS idx_savings_maturity_date ON savings_account(maturity_date);

-- Update the DAILY-180 scheme interest rate to 4.0000%
UPDATE deposit_product
   SET interest_rate = 4.0000,
       updated_at = now()
 WHERE code = 'DAILY-180';
