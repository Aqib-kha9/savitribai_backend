-- Migration 019: Fix savings account numbering, deposit products and convert accidental DDA accounts to SBA

-- 1. Ensure savings_account number sequence uses prefix SBA
UPDATE number_sequence
   SET prefix = 'SBA'
 WHERE entity_type = 'savings_account';

-- 2. Rename SAV-DLY product to avoid confusion with Daily Deposit (DD)
UPDATE deposit_product
   SET name = 'Doorstep Bachat Khata (Doorstep Savings)',
       description = 'Doorstep collection savings account for daily/regular-income customers'
 WHERE code = 'SAV-DLY';

-- 3. Convert any savings accounts created under SAV-STD or SAV-DLY that were mistakenly assigned DDA numbers
UPDATE savings_account
   SET account_number = REPLACE(account_number, 'DDA', 'SBA'),
       maturity_date = NULL
 WHERE product_id IN (SELECT id FROM deposit_product WHERE code IN ('SAV-STD', 'SAV-DLY'))
   AND account_number LIKE 'DDA%';

-- 4. Update any collection receipts generated for those converted accounts
UPDATE collection_receipt
   SET account_number = REPLACE(account_number, 'DDA', 'SBA')
 WHERE account_number LIKE 'DDA%'
   AND collection_id IN (
     SELECT ce.id FROM collection_entry ce
      JOIN savings_account sa ON sa.id = ce.savings_account_id
      JOIN deposit_product dp ON dp.id = sa.product_id
     WHERE dp.code IN ('SAV-STD', 'SAV-DLY')
   );
