-- Migration 016: Allow setting adjustment_id on account_transaction while preserving append-only financial immutability

CREATE OR REPLACE FUNCTION check_account_transaction_mutation() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    -- Allow closing the circular FK between account_transaction and account_adjustment
    -- Only allow updating adjustment_id from NULL to non-NULL.
    -- All financial attributes (id, savings_account_id, direction, amount, balance_after, value_date, etc.) MUST remain strictly immutable.
    IF OLD.adjustment_id IS NULL AND NEW.adjustment_id IS NOT NULL
       AND OLD.id = NEW.id
       AND OLD.savings_account_id = NEW.savings_account_id
       AND OLD.transaction_type = NEW.transaction_type
       AND OLD.direction = NEW.direction
       AND OLD.amount = NEW.amount
       AND OLD.balance_after = NEW.balance_after
       AND OLD.value_date = NEW.value_date
       AND OLD.created_at = NEW.created_at THEN
      RETURN NEW;
    END IF;

    RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
      USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_account_transaction_append_only ON account_transaction;

CREATE TRIGGER trg_account_transaction_append_only
  BEFORE UPDATE OR DELETE ON account_transaction
  FOR EACH ROW EXECUTE FUNCTION check_account_transaction_mutation();
