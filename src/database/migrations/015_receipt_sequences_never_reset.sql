-- Migration 015: Ensure receipt sequences never reset and stay monotonic across days/months
UPDATE number_sequence
   SET reset_period = 'never'
 WHERE entity_type IN (
   'receipt_daily',
   'receipt_monthly',
   'receipt_loan',
   'receipt_rd',
   'receipt_dd',
   'receipt_sb'
 );
