-- Migration 013: Number sequences for daily loans (DLA) and daily deposits (DDA), plus product receipts
INSERT INTO number_sequence (entity_type, prefix, next_value, padding, reset_period, allow_cancelled_reuse)
VALUES
  ('daily_loan', 'DLA', 1, 4, 'never', false),
  ('daily_deposit', 'DDA', 1, 4, 'never', false),
  ('receipt_loan', 'RCPT-LN', 1, 5, 'daily', false),
  ('receipt_rd', 'RCPT-RD', 1, 5, 'daily', false),
  ('receipt_dd', 'RCPT-DD', 1, 5, 'daily', false),
  ('receipt_sb', 'RCPT-SB', 1, 5, 'daily', false)
ON CONFLICT (entity_type) DO NOTHING;
