import { z } from 'zod';
import {
  ALL_PERMISSIONS,
  STAFF_ROLES,
  SUPER_ADMIN_ROLE,
  type Permission,
  type StaffRole,
} from '../../core/permissions.js';

/**
 * Identity & access management request schemas (docs/backend-master-spec.md §7).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 */

export const staffCodeSchema = z
  .string()
  .trim()
  .min(2, 'Staff code must be at least 2 characters')
  .max(20, 'Staff code must be at most 20 characters')
  .regex(/^[A-Za-z0-9._-]+$/, 'Staff code may contain letters, digits, dots, dashes and underscores');

export const uuidSchema = z.string().uuid('Invalid id format');

export const deviceFingerprintSchema = z
  .string()
  .trim()
  .min(8, 'deviceFingerprint is too short')
  .max(200, 'deviceFingerprint is too long');

const roleCodeSchema = z.enum(STAFF_ROLES as [StaffRole, ...StaffRole[]]);
// Staff can be created/updated into any role EXCEPT the immutable super-admin.
const assignableRoleCodeSchema = roleCodeSchema.exclude([SUPER_ADMIN_ROLE]);
const permissionCodeSchema = z.enum(ALL_PERMISSIONS as [Permission, ...Permission[]]);

const passwordSchema = z.string().min(8, 'Password must be at least 8 characters').max(128, 'Password is too long');
const optionalPasswordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .max(128, 'Password is too long')
  .optional();

const branchIdSchema = z.string().uuid('Invalid branch id').nullable().optional();

const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
  .optional();

export const loginSchema = z
  .object({
    staffCode: staffCodeSchema,
    password: z.string().min(1, 'Password is required').max(128),
    source: z.enum(['admin_web', 'agent_mobile']),
    deviceFingerprint: deviceFingerprintSchema.optional(),
    deviceName: z.string().trim().max(120).optional(),
    appVersion: z.string().trim().max(40).optional(),
  })
  .superRefine((value, context) => {
    if (value.source === 'agent_mobile' && !value.deviceFingerprint) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'deviceFingerprint is required for agent mobile sign-in',
        path: ['deviceFingerprint'],
      });
    }
  });

export type LoginInput = z.infer<typeof loginSchema>;

export const refreshSchema = z.object({
  refreshToken: z.string().trim().min(1, 'refreshToken is required').max(512),
});
export type RefreshInput = z.infer<typeof refreshSchema>;

// Self-service credential rotation: the caller proves ownership of the current
// password before a new one is accepted (production standard, spec §7.1/§6.2).
export const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required').max(128),
    newPassword: passwordSchema,
  })
  .superRefine((value, context) => {
    if (value.currentPassword === value.newPassword) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'New password must be different from the current password',
        path: ['newPassword'],
      });
    }
  });
export type ChangePasswordInput = z.infer<typeof changePasswordSchema>;

export const registerDeviceSchema = z.object({
  deviceFingerprint: deviceFingerprintSchema,
  deviceName: z.string().trim().max(120).optional(),
  appVersion: z.string().trim().max(40).optional(),
});
export type RegisterDeviceInput = z.infer<typeof registerDeviceSchema>;

export const disableDeviceSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500).optional(),
});
export type DisableDeviceInput = z.infer<typeof disableDeviceSchema>;

export const createStaffSchema = z.object({
  staffCode: staffCodeSchema,
  fullName: z.string().trim().min(3, 'Full name is required').max(120),
  roleCode: assignableRoleCodeSchema,
  branchId: branchIdSchema,
  email: z.string().email('Invalid email').max(160).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  password: passwordSchema,
  ndaSigned: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
  exitDate: dateSchema,
});
export type CreateStaffInput = z.infer<typeof createStaffSchema>;

export const updateStaffSchema = z.object({
  fullName: z.string().trim().min(3).max(120).optional(),
  roleCode: assignableRoleCodeSchema.optional(),
  branchId: branchIdSchema,
  email: z.string().email().max(160).nullable().optional(),
  phone: z.string().trim().max(20).nullable().optional(),
  password: optionalPasswordSchema,
  ndaSigned: z.boolean().optional(),
  mfaEnabled: z.boolean().optional(),
  exitDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format')
    .nullable()
    .optional(),
});
export type UpdateStaffInput = z.infer<typeof updateStaffSchema>;

export const deactivateStaffSchema = z.object({
  reason: z.string().trim().min(1, 'A reason is required').max(500).optional(),
});
export type DeactivateStaffInput = z.infer<typeof deactivateStaffSchema>;

export const listStaffQuerySchema = z.object({
  search: z.string().trim().max(80).optional(),
  role: roleCodeSchema.optional(),
  status: z.enum(['active', 'locked', 'disabled']).optional(),
  branchId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListStaffQuery = z.infer<typeof listStaffQuerySchema>;

export const rolePermissionsSchema = z.object({
  permissionCodes: z.array(permissionCodeSchema).default([]),
});
export type RolePermissionsInput = z.infer<typeof rolePermissionsSchema>;

export const idParamSchema = z.object({
  id: uuidSchema,
});
