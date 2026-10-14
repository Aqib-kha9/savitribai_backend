-- Migration 015: Sync terminal statuses for accounts linked to deleted customer profiles.
-- When a customer profile is marked deleted, any active deposit (savings), RD, or FD accounts
-- belonging to them must also transition to their terminal status (closed / cancelled).

UPDATE savings_account
   SET status = 'closed',
       closed_on = CURRENT_DATE,
       closure_reason = 'Customer profile deleted',
       updated_at = now()
 WHERE customer_id IN (SELECT id FROM customer WHERE status = 'deleted')
   AND status != 'closed';

UPDATE rd_account
   SET status = 'cancelled',
       updated_at = now()
 WHERE customer_id IN (SELECT id FROM customer WHERE status = 'deleted')
   AND status != 'cancelled';

UPDATE fd_account
   SET status = 'closed',
       closed_on = CURRENT_DATE,
       updated_at = now()
 WHERE customer_id IN (SELECT id FROM customer WHERE status = 'deleted')
   AND status != 'closed';
