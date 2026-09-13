import { z } from 'zod';

/**
 * Customers & nominees request schemas (docs/backend-master-spec.md §8).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints in 001_schema.sql so the
 * boundary rejects unknown vocabulary before it ever reaches SQL.
 */

export const uuidSchema = z.string().uuid('Invalid id format');

const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');

export const customerTypeSchema = z.enum([
  'Individual',
  'Cooperation',
  'Group',
  'SHG',
  'Organisation',
  'Minor',
  'Joint',
]);
export type CustomerType = z.infer<typeof customerTypeSchema>;

export const customerStatusSchema = z.enum([
  'active',
  'inactive',
  'blocked',
  'deceased',
  'transferred',
  'closed',
  // Data-subject rights (spec §24.2): 'restricted' freezes product activity
  // pending resolution; 'deleted' marks the profile closed to further use
  // while balance / loan / repayment-schedule records are mandatorily retained.
  'restricted',
  'deleted',
]);
export type CustomerStatus = z.infer<typeof customerStatusSchema>;

export const membershipCategorySchema = z.enum(['Loan', 'Savings', 'Daily', 'RD', 'Current']);
export type MembershipCategory = z.infer<typeof membershipCategorySchema>;

export const addressTypeSchema = z.enum(['permanent', 'current', 'work', 'collection']);
export type AddressType = z.infer<typeof addressTypeSchema>;

export const identityDocumentTypeSchema = z.enum(['aadhaar', 'pan', 'electricity_bill']);
export type IdentityDocumentType = z.infer<typeof identityDocumentTypeSchema>;

export const kycStatusSchema = z.enum(['pending', 'approved', 'rejected', 'expired']);
export type KycStatus = z.infer<typeof kycStatusSchema>;

export const consentChannelSchema = z.enum([
  'sms',
  'whatsapp',
  'email',
  'call',
  'location_visit',
  'promotional',
  'printed_receipt',
  'app_notification',
  'voice_call',
]);
export type ConsentChannel = z.infer<typeof consentChannelSchema>;

export const complaintStatusSchema = z.enum(['open', 'in_progress', 'resolved', 'closed']);
export type ComplaintStatus = z.infer<typeof complaintStatusSchema>;

// Optional address fields map to nullable DB columns, so accept an explicit
// null as well as omission — otherwise clients that send `null` (rather than
// omitting the key) fail validation with 400 VALIDATION_ERROR: null is not a
// valid string for `.optional()`-only fields.
const addressSchema = z.object({
  addressType: addressTypeSchema,
  line1: z.string().trim().min(1, 'Address line 1 is required').max(255),
  line2: z.string().trim().max(255).nullable().optional(),
  city: z.string().trim().max(100).nullable().optional(),
  district: z.string().trim().max(100).nullable().optional(),
  state: z.string().trim().max(100).nullable().optional(),
  pincode: z.string().trim().max(10).nullable().optional(),
  landmark: z.string().trim().max(255).nullable().optional(),
});
export type AddressItem = z.infer<typeof addressSchema>;

const identityDocumentSchema = z.object({
  documentType: identityDocumentTypeSchema,
  documentNumber: z.string().trim().min(1, 'Document number is required').max(100),
  issueDate: dateOnlySchema.optional(),
  expiryDate: dateOnlySchema.optional(),
  issuingAuthority: z.string().trim().max(160).optional(),
  copyReference: z.string().trim().max(200).optional(),
  isVerified: z.boolean().optional(),
});

export const createCustomerSchema = z.object({
  fullName: z.string().trim().min(2, 'Customer name is required').max(160),
  customerType: customerTypeSchema.default('Individual'),
  mobile: z.string().trim().min(7, 'Mobile number is required (spec §8.1)').max(20),
  alternatePhone: z.string().trim().max(20).optional(),
  email: z.string().email('Invalid email').max(160).optional(),
  dateOfBirth: dateOnlySchema.optional(),
  gender: z.string().trim().max(20).optional(),
  occupation: z.string().trim().max(120).optional(),
  businessType: z.string().trim().max(120).optional(),
  branchId: z.string().uuid('Invalid branch id'),
  membershipCategory: membershipCategorySchema.default('Savings'),
  riskCategory: z.string().trim().max(80).optional(),
  amlRisk: z.string().trim().max(80).optional(),
  sourceOfFunds: z.string().trim().max(200).optional(),
  guardianName: z.string().trim().max(120).optional(),
  guardianPhone: z.string().trim().max(20).optional(),
  kycMethod: z.string().trim().max(40).optional(),
  addresses: z
    .array(addressSchema)
    .min(1, 'At least one address is required (spec §8.1 — address is mandatory)'),
  identityDocuments: z.array(identityDocumentSchema).optional(),
});
export type CreateCustomerInput = z.infer<typeof createCustomerSchema>;

export const updateCustomerSchema = z.object({
  fullName: z.string().trim().min(2).max(160).optional(),
  mobile: z.string().trim().min(7).max(20).optional(),
  alternatePhone: z.string().trim().max(20).nullable().optional(),
  email: z.string().email('Invalid email').max(160).nullable().optional(),
  dateOfBirth: dateOnlySchema.optional(),
  gender: z.string().trim().max(20).nullable().optional(),
  occupation: z.string().trim().max(120).optional(),
  businessType: z.string().trim().max(120).optional(),
  riskCategory: z.string().trim().max(80).nullable().optional(),
  amlRisk: z.string().trim().max(80).nullable().optional(),
  sourceOfFunds: z.string().trim().max(200).optional(),
  guardianName: z.string().trim().max(120).nullable().optional(),
  guardianPhone: z.string().trim().max(20).nullable().optional(),
  kycMethod: z.string().trim().max(40).optional(),
  addresses: z.array(addressSchema).optional(),
  identityDocuments: z.array(identityDocumentSchema).optional(),
});
export type UpdateCustomerInput = z.infer<typeof updateCustomerSchema>;

export const changeStatusSchema = z.object({
  status: customerStatusSchema,
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type ChangeStatusInput = z.infer<typeof changeStatusSchema>;

export const transferCustomerSchema = z.object({
  toBranchId: z.string().uuid('Invalid branch id'),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type TransferCustomerInput = z.infer<typeof transferCustomerSchema>;

export const kycApproveSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    method: z.string().trim().max(40).optional(),
    rejectionReason: z.string().trim().max(500).optional(),
  })
  .superRefine((value, context) => {
    if (value.status === 'rejected' && !value.rejectionReason) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'rejectionReason is required when rejecting KYC',
        path: ['rejectionReason'],
      });
    }
  });
export type KycApproveInput = z.infer<typeof kycApproveSchema>;

export const nomineeSchema = z.object({
  name: z.string().trim().min(1, 'Nominee name is required').max(160),
  relationship: z.string().trim().min(1, 'Relationship is required').max(120),
  dateOfBirth: dateOnlySchema.optional(),
  identityDocumentType: identityDocumentTypeSchema.optional(),
  identityDocumentNumber: z.string().trim().max(100).optional(),
  address: z.string().trim().max(300).optional(),
  phone: z.string().trim().max(20).optional(),
  sharePercentage: z.coerce.number().min(0.01).max(100).default(100),
  guardianName: z.string().trim().max(120).optional(),
  guardianPhone: z.string().trim().max(20).optional(),
});
export type NomineeInput = z.infer<typeof nomineeSchema>;

export const consentsSchema = z.object({
  consents: z
    .array(
      z.object({
        channel: consentChannelSchema,
        granted: z.boolean(),
      }),
    )
    .min(1, 'At least one consent channel is required'),
});
export type ConsentsInput = z.infer<typeof consentsSchema>;

export const complaintSchema = z.object({
  category: z.string().trim().max(100).optional(),
  description: z.string().trim().min(1, 'Description is required').max(1000),
});
export type ComplaintInput = z.infer<typeof complaintSchema>;

export const mergeSchema = z.object({
  mergeIntoCustomerId: z.string().uuid('Invalid customer id'),
  reason: z.string().trim().min(1, 'A reason is required').max(500),
});
export type MergeInput = z.infer<typeof mergeSchema>;

export const deathNotificationSchema = z.object({
  dateOfDeath: dateOnlySchema.optional(),
  note: z.string().trim().max(500).optional(),
});
export type DeathNotificationInput = z.infer<typeof deathNotificationSchema>;

export const listCustomersQuerySchema = z
  .object({
    search: z.string().trim().max(80).optional(),
    type: customerTypeSchema.optional(),
    status: customerStatusSchema.optional(),
    membershipCategory: membershipCategorySchema.optional(),
    branchId: z.string().uuid('Invalid branch id').optional(),
    agentId: z.string().uuid('Invalid agent id').optional(),
    customerId: z.string().uuid('Invalid customer id').optional(),
    registeredFrom: dateOnlySchema.optional(),
    registeredTo: dateOnlySchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((value, context) => {
    if (value.registeredFrom && value.registeredTo && value.registeredFrom > value.registeredTo) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'registeredFrom must be on or before registeredTo',
        path: ['registeredFrom'],
      });
    }
  });
export type ListCustomersQuery = z.infer<typeof listCustomersQuerySchema>;

/** Query params for GET /customers/export (CSV download of the filtered list). */
export const exportCustomersQuerySchema = z
  .object({
    search: z.string().trim().max(80).optional(),
    type: customerTypeSchema.optional(),
    status: customerStatusSchema.optional(),
    membershipCategory: membershipCategorySchema.optional(),
    branchId: z.string().uuid('Invalid branch id').optional(),
    agentId: z.string().uuid('Invalid agent id').optional(),
    customerId: z.string().uuid('Invalid customer id').optional(),
    registeredFrom: dateOnlySchema.optional(),
    registeredTo: dateOnlySchema.optional(),
  })
  .superRefine((value, context) => {
    if (value.registeredFrom && value.registeredTo && value.registeredFrom > value.registeredTo) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'registeredFrom must be on or before registeredTo',
        path: ['registeredFrom'],
      });
    }
  });
export type ExportCustomersQuery = z.infer<typeof exportCustomersQuerySchema>;

export const idParamSchema = z.object({
  id: uuidSchema,
});

// ---------------------------------------------------------------------------
// Data-subject rights (spec §24.2)
// ---------------------------------------------------------------------------

export const dataSubjectRequestTypeSchema = z.enum(['copy', 'correction', 'restriction', 'deletion']);
export type DataSubjectRequestType = z.infer<typeof dataSubjectRequestTypeSchema>;

export const dataSubjectRequestStatusSchema = z.enum(['received', 'in_progress', 'completed', 'rejected']);
export type DataSubjectRequestStatus = z.infer<typeof dataSubjectRequestStatusSchema>;

/** Raise a data-subject request on a customer's behalf (office staff). */
export const createDataSubjectRequestSchema = z.object({
  requestType: dataSubjectRequestTypeSchema,
  details: z.string().trim().min(1, 'Details are required').max(1000),
});
export type CreateDataSubjectRequestInput = z.infer<typeof createDataSubjectRequestSchema>;

/** Decision by the Managing Director (spec §24.1 external reporting contact). */
export const decideDataSubjectRequestSchema = z
  .object({
    status: z.enum(['in_progress', 'completed', 'rejected']),
    decisionNotes: z.string().trim().min(1, 'Decision notes are required').max(1000),
  })
  .superRefine((value, context) => {
    if (value.status === 'completed' && value.decisionNotes.length < 10) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'decisionNotes must explain how the request was fulfilled (min 10 chars)',
        path: ['decisionNotes'],
      });
    }
  });
export type DecideDataSubjectRequestInput = z.infer<typeof decideDataSubjectRequestSchema>;

/** Path params for /customers/:id/data-subject-requests. */
export const dataSubjectRequestIdParamSchema = z.object({
  id: uuidSchema,
  requestId: uuidSchema,
});
