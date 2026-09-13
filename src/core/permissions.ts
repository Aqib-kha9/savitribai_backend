/**
 * Permission catalogue — mirrors admin-panel/src/lib/permissions/permissions.ts
 * exactly. The backend enforces this matrix server-side (spec §5.3).
 * Permissions are also stored in the DB (role_permission) and seeded from here;
 * the M.D. may edit the DB matrix later.
 */

export type Permission =
  | 'customers.read'
  | 'customers.write'
  | 'customers.export'
  | 'deposits.read'
  | 'deposits.write'
  | 'loans.read'
  | 'loans.write'
  | 'loans.approve'
  | 'withdrawals.read'
  | 'withdrawals.create'
  | 'withdrawals.approve'
  | 'withdrawals.approve_high_value'
  | 'collections.read'
  | 'collections.write'
  | 'reconciliation.read'
  | 'reconciliation.write'
  | 'reports.read'
  | 'reports.export'
  | 'agents.read'
  | 'agents.write'
  | 'security.read'
  | 'security.unlock_accounts'
  | 'security.audit.read'
  | 'settings.read'
  | 'settings.write';

export type StaffRole =
  | 'super_admin'
  | 'managing_director'
  | 'president'
  | 'vice_president'
  | 'manager'
  | 'cashier'
  | 'clerk'
  | 'collection_agent';

export const ALL_PERMISSIONS: Permission[] = [
  'customers.read',
  'customers.write',
  'customers.export',
  'deposits.read',
  'deposits.write',
  'loans.read',
  'loans.write',
  'loans.approve',
  'withdrawals.read',
  'withdrawals.create',
  'withdrawals.approve',
  'withdrawals.approve_high_value',
  'collections.read',
  'collections.write',
  'reconciliation.read',
  'reconciliation.write',
  'reports.read',
  'reports.export',
  'agents.read',
  'agents.write',
  'security.read',
  'security.unlock_accounts',
  'security.audit.read',
  'settings.read',
  'settings.write',
];

export const STAFF_ROLES: StaffRole[] = [
  'super_admin',
  'managing_director',
  'president',
  'vice_president',
  'manager',
  'cashier',
  'clerk',
  'collection_agent',
];

export const ROLE_LABELS: Record<StaffRole, string> = {
  super_admin: 'Super Administrator',
  managing_director: 'Managing Director',
  president: 'President',
  vice_president: 'Vice President',
  manager: 'Manager',
  cashier: 'Cashier',
  clerk: 'Clerk',
  collection_agent: 'Collection Agent',
};

/**
 * The immutable super-administrator. It holds every permission unconditionally
 * and its staff account can never be edited, demoted or deactivated.
 */
export const SUPER_ADMIN_ROLE: StaffRole = 'super_admin';

export function isSuperAdmin(role: StaffRole): boolean {
  return role === SUPER_ADMIN_ROLE;
}

export const ROLE_PERMISSIONS: Record<StaffRole, Permission[]> = {
  super_admin: ALL_PERMISSIONS,
  managing_director: ALL_PERMISSIONS,
  president: [
    'customers.read',
    'deposits.read',
    'loans.read',
    'loans.approve',
    'withdrawals.read',
    'withdrawals.approve',
    'withdrawals.approve_high_value',
    'collections.read',
    'reconciliation.read',
    'reports.read',
    'reports.export',
    'agents.read',
    'security.read',
    'security.audit.read',
    'settings.read',
  ],
  vice_president: [
    'customers.read',
    'deposits.read',
    'loans.read',
    'loans.approve',
    'withdrawals.read',
    'withdrawals.approve',
    'collections.read',
    'reconciliation.read',
    'reports.read',
    'reports.export',
    'agents.read',
    'security.read',
    'settings.read',
  ],
  manager: [
    'customers.read',
    'customers.write',
    'customers.export',
    'deposits.read',
    'deposits.write',
    'loans.read',
    'loans.write',
    'loans.approve',
    'withdrawals.read',
    'withdrawals.create',
    'withdrawals.approve',
    'collections.read',
    'collections.write',
    'reconciliation.read',
    'reconciliation.write',
    'reports.read',
    'reports.export',
    'agents.read',
    'agents.write',
    'security.read',
    'settings.read',
  ],
  cashier: [
    'customers.read',
    'deposits.read',
    'deposits.write',
    'withdrawals.read',
    'withdrawals.create',
    'collections.read',
    'collections.write',
    'reconciliation.read',
    'reconciliation.write',
    'reports.read',
  ],
  clerk: [
    'customers.read',
    'customers.write',
    'deposits.read',
    'deposits.write',
    'loans.read',
    'withdrawals.read',
    'withdrawals.create',
    'collections.read',
    'reports.read',
  ],
  collection_agent: ['customers.read', 'collections.read', 'collections.write', 'reconciliation.read'],
};

/** Client rule: withdrawals above ₹2,00,000 require President approval. */
export const HIGH_VALUE_WITHDRAWAL_LIMIT = 200000;

export function canApproveWithdrawal(role: StaffRole, permissions: Permission[], amount: number): boolean {
  if (isSuperAdmin(role)) return true;
  if (amount > HIGH_VALUE_WITHDRAWAL_LIMIT) return role === 'president';
  return permissions.includes('withdrawals.approve');
}

export function hasPermission(permissions: Permission[], permission: Permission): boolean {
  return permissions.includes(permission);
}

export function isValidPermission(value: string): value is Permission {
  return (ALL_PERMISSIONS as string[]).includes(value);
}

export function isValidStaffRole(value: string): value is StaffRole {
  return (STAFF_ROLES as string[]).includes(value);
}
