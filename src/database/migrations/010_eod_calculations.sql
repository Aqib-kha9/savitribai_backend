-- Savings daily balance snapshot for quarterly interest calculation
CREATE TABLE IF NOT EXISTS savings_daily_balance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_account_id UUID NOT NULL REFERENCES savings_account(id),
  balance NUMERIC(14,2) NOT NULL,
  snapshot_date DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (savings_account_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_savings_daily_balance_date ON savings_daily_balance(snapshot_date);
