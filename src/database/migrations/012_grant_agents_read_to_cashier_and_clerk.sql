-- ---------------------------------------------------------------------------
-- Migration 012: Grant 'agents.read' to cashier and clerk roles
-- ---------------------------------------------------------------------------

-- Grant 'agents.read' to cashier and clerk roles in role_permission matrix
-- so they can view and select assigned collection agents during customer onboarding.
INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
  FROM role r
  CROSS JOIN permission p
 WHERE r.code IN ('cashier', 'clerk')
   AND p.code = 'agents.read'
ON CONFLICT DO NOTHING;
