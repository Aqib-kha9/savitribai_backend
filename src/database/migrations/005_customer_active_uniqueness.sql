-- ---------------------------------------------------------------------------
-- 005_customer_active_uniqueness.sql
--
-- Production uniqueness for customer identity.
--
-- Until now a customer profile could be saved with exactly the same mobile
-- number (and the same Aadhaar / PAN) as an existing profile: the table only
-- had a plain, non-unique index on `mobile` (001_schema.sql) and no rule at all
-- on `customer_identity_document.document_number`. That let two identical
-- "Test Customer One" rows (TEST 0001 / TEST 0002, both mobile 9555500001) sit
-- side by side.
--
-- Policy (confirmed): a customer's mobile number and their Aadhaar / PAN
-- number must be unique among *active* customers. We deliberately scope the
-- rules to non-terminal customers so the documented "shared contact details"
-- allowance still holds for historical / closed records, and so the audit trail
-- of a merged (closed) profile is never rewritten.
--
-- Three parts, all idempotent inside the migration transaction:
--   A. Close the pre-existing duplicate active profiles that would block the
--      new index, keeping the earliest record and linking the rest to it via
--      `merged_into_customer_id` (never a hard delete — spec §8.1). Every
--      closure is written to `customer_status_history`.
--   B. A partial UNIQUE index on `customer.mobile` scoped to active customers.
--      A partial index predicate cannot contain a sub-query, but it can
--      reference this table's own columns, so the scope is expressed directly
--      through `status`.
--   C. The identity-document rule needs the *owning customer's* status, which a
--      plain index predicate cannot see, so it is enforced by a trigger that
--      raises SQLSTATE 23505 (unique_violation) with a stable constraint name.
--      The API maps that to a friendly 409 just like the mobile clash.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- A. Close duplicate active profiles that share a mobile number.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  dup_mobile      TEXT;
  keeper_id       UUID;
  keeper_number   TEXT;
  keeper_status   TEXT;
  dup             RECORD;
BEGIN
  FOR dup_mobile IN
    SELECT mobile
      FROM customer
     WHERE status NOT IN ('deceased', 'closed', 'deleted')
       AND mobile IS NOT NULL
     GROUP BY mobile
    HAVING count(*) > 1
  LOOP
    -- Keep the oldest active profile; everything else is linked to it.
    SELECT id, customer_number, status
      INTO keeper_id, keeper_number, keeper_status
      FROM customer
     WHERE mobile = dup_mobile
       AND status NOT IN ('deceased', 'closed', 'deleted')
     ORDER BY created_at ASC, id ASC
     LIMIT 1;

    FOR dup IN
      SELECT id, customer_number, status
        FROM customer
       WHERE mobile = dup_mobile
         AND status NOT IN ('deceased', 'closed', 'deleted')
         AND id <> keeper_id
       ORDER BY created_at ASC, id ASC
    LOOP
      UPDATE customer
         SET status = 'closed',
             merged_into_customer_id = keeper_id,
             updated_at = now()
       WHERE id = dup.id;

      INSERT INTO customer_status_history (customer_id, from_status, to_status, reason)
      VALUES (
        dup.id,
        COALESCE(dup.status, 'active'),
        'closed',
        'Auto-closed by migration 005 - duplicate active profile for mobile ' || dup_mobile
          || ' (merged into ' || COALESCE(keeper_number, keeper_id::text) || ')'
      );

      INSERT INTO customer_status_history (customer_id, from_status, to_status, reason)
      VALUES (
        keeper_id,
        COALESCE(keeper_status, 'active'),
        COALESCE(keeper_status, 'active'),
        'Duplicate active profile ' || COALESCE(dup.customer_number, dup.id::text)
          || ' merged into this record by migration 005'
      );
    END LOOP;
  END LOOP;
END $$;

-- Any duplicate active identity documents belonging to a now-closed profile are
-- left untouched: the trigger below ignores terminal customers, so the closed
-- record keeps its document for audit purposes without blocking new customers.
-- (No DELETE is run, so no historical data is destroyed.)

-- ---------------------------------------------------------------------------
-- B. Active customers' mobile numbers must be unique.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS uq_customer_active_mobile
  ON customer (mobile)
  WHERE status NOT IN ('deceased', 'closed', 'deleted');

-- ---------------------------------------------------------------------------
-- C. Active customers' Aadhaar / PAN numbers must be unique.
--
-- The number is normalised the same way the API normalises it (case-insensitive,
-- separators such as the spaces in "1234 5678 9012" removed) so the same
-- document typed with or without spaces is caught. A trigger is used instead of
-- a unique index because the rule must look at the owning customer's status, and
-- an index predicate cannot reference another row / table.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_active_identity_document_uniqueness()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Only strong identity documents participate; proof-of-address bills do not.
  IF NEW.document_type IN ('aadhaar', 'pan') THEN
    IF EXISTS (
      SELECT 1
        FROM customer_identity_document d
        JOIN customer c ON c.id = d.customer_id
       WHERE d.id <> NEW.id
         AND d.document_type = NEW.document_type
         AND upper(regexp_replace(d.document_number, '[^A-Za-z0-9]', '', 'g'))
             = upper(regexp_replace(NEW.document_number, '[^A-Za-z0-9]', '', 'g'))
         AND c.status NOT IN ('deceased', 'closed', 'deleted')
    ) THEN
      RAISE EXCEPTION 'An active customer already uses this identity document number'
        USING ERRCODE = '23505',
              CONSTRAINT = 'uq_customer_identity_document_number';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customer_identity_document_uniqueness
  ON customer_identity_document;
CREATE TRIGGER trg_customer_identity_document_uniqueness
  BEFORE INSERT OR UPDATE ON customer_identity_document
  FOR EACH ROW EXECUTE FUNCTION enforce_active_identity_document_uniqueness();
