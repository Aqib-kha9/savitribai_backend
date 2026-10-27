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
