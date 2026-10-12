-- ---------------------------------------------------------------------------
-- Migration 011: Customer Pending Approval Status & Cashier Permissions
-- ---------------------------------------------------------------------------

-- 1. Allow 'pending_approval' status in customer table
ALTER TABLE customer DROP CONSTRAINT IF EXISTS customer_status_check;
ALTER TABLE customer ADD CONSTRAINT customer_status_check
  CHECK (status IN (
    'active',
    'pending_approval',
    'inactive',
    'blocked',
    'deceased',
    'transferred',
    'closed',
    'restricted',
    'deleted'
  ));

-- 2. Grant 'customers.write' to cashier role in role_permission matrix
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r
  CROSS JOIN permission p
 WHERE r.code = 'cashier'
   AND p.code = 'customers.write'
ON CONFLICT DO NOTHING;
