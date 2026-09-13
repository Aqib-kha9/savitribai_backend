import { z } from 'zod';
/**
 * Collection agents request schemas (docs/backend-master-spec.md §15 / §14.4).
 *
 * All request bodies are validated with Zod at the API boundary (spec §2.4).
 * Enumerations mirror the DB CHECK constraints on agent / route_exchange /
 * agent_customer_assignment in 001_schema.sql so the boundary rejects unknown
 * vocabulary before it ever reaches SQL:
 *  - agent.status:        pending | active | suspended | deactivated | locked
 *  - route_exchange:      pending | approved | rejected | completed | cancelled
 *
 * Business rules surfaced here (spec §15.1 / §14.1 / §16.5):
 *  - ID proof AND address proof are mandatory when onboarding an agent;
 *  - lifecycle moves (activate / suspend / reactivate / deactivate / lock) are
 *    managing-director decisions and are exposed as dedicated endpoints, not as
 *    a settable status field on the update payload;
 *  - temporary route exchanges are approved by the managing director;
 *  - deactivation ends active customer assignments (customers are transferred
 *    to another agent);
 *  - device lost/stolen → the managing director disables the device, freezing
 *    the agent account temporarily;
 *  - day close is only allowed once every entry for the business date has been
 *    submitted, and never after the 17:00 IST submission deadline (spec §16.1).
 */
export const uuidSchema = z.string().uuid('Invalid id format');
const dateOnlySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Date must be in YYYY-MM-DD format');
/** Money amount — /^\d{1,12}(\.\d{1,2})?$/ travels as a string (spec §1.3). */
const amountSchema = z
    .string()
    .regex(/^\d{1,12}(\.\d{1,2})?$/, 'Amount must be a non-negative amount with at most 2 decimal places')
    .refine((value) => Number(value) > 0, 'Amount must be greater than zero');
/** Agent lifecycle status — agent.status CHECK in 001_schema.sql. */
export const agentStatusSchema = z.enum(['pending', 'active', 'suspended', 'deactivated', 'locked']);
/** Route exchange lifecycle — route_exchange.status CHECK in 001_schema.sql. */
export const routeExchangeStatusSchema = z.enum(['pending', 'approved', 'rejected', 'completed', 'cancelled']);
const phoneSchema = z.string().trim().max(20).optional();
const emailSchema = z.string().trim().email('Invalid email address').max(120).optional();
const noteSchema = z.string().trim().max(500).optional();
const referenceSchema = z.string().trim().max(200).optional();
/**
 * Onboard a collection agent (spec §15.1 / §15.3). `staffId` links the agent to
 * an existing staff login; `agentCode` is chosen by the office (agent codes are
 * NOT number-sequence allocated — see the 'AG-YTM-001' seed literal). ID and
 * address proofs are mandatory and mirror agent.id_proof_* / address_proof_*.
 */
export const onboardAgentSchema = z.object({
    staffId: uuidSchema,
    agentCode: z.string().trim().min(1).max(50),
    branchId: z.string().uuid('Invalid branch id').nullable().optional(),
    phone: phoneSchema,
    email: emailSchema,
    resumeReference: referenceSchema,
    verificationReference: referenceSchema,
    /** Spec §15.1 — identity documents are mandatory for onboarding. */
    idProofType: z.string().trim().min(1).max(50),
    idProofReference: z.string().trim().min(1).max(200),
    addressProofType: z.string().trim().min(1).max(50),
    addressProofReference: z.string().trim().min(1).max(200),
    emergencyContactName: z.string().trim().max(100).optional(),
    emergencyContactPhone: phoneSchema,
    trainingStatus: z.string().trim().max(50).optional(),
    startDate: dateOnlySchema.nullable().optional(),
    endDate: dateOnlySchema.nullable().optional(),
    dailyCashLimit: amountSchema.optional(),
});
/**
 * Update profile details of an agent. Status is deliberately absent — lifecycle
 * moves go through the dedicated activate/suspend/reactivate/deactivate/lock
 * endpoints (spec §15.1, M.D. authority). Null clears a DB-nullable column,
 * absent leaves it unchanged.
 */
export const updateAgentSchema = z.object({
    branchId: z.string().uuid('Invalid branch id').nullable().optional(),
    phone: z.string().trim().max(20).nullable().optional(),
    email: z.string().trim().email('Invalid email address').max(120).nullable().optional(),
    resumeReference: referenceSchema.nullable(),
    verificationReference: referenceSchema.nullable(),
    idProofType: z.string().trim().max(50).nullable().optional(),
    idProofReference: referenceSchema.nullable(),
    addressProofType: z.string().trim().max(50).nullable().optional(),
    addressProofReference: referenceSchema.nullable(),
    emergencyContactName: z.string().trim().max(100).nullable().optional(),
    emergencyContactPhone: z.string().trim().max(20).nullable().optional(),
    trainingStatus: z.string().trim().max(50).nullable().optional(),
    startDate: dateOnlySchema.nullable().optional(),
    endDate: dateOnlySchema.nullable().optional(),
    dailyCashLimit: amountSchema.nullable().optional(),
});
export const listAgentsQuerySchema = z.object({
    status: agentStatusSchema.optional(),
    branchId: z.string().uuid('Invalid branch id').optional(),
    /** Search across agent code and the linked staff's full name / staff code. */
    q: z.string().trim().max(80).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
/**
 * Assign (or re-assign) customers to an agent — agent_customer_assignment.
 * Re-issuing a customer id here closes the previous active assignment and
 * opens a new effective one (action 'reassigned' on agent_transfer_log).
 */
export const assignmentSchema = z.object({
    customerIds: z.array(uuidSchema).min(1),
    reason: noteSchema,
    effectiveFrom: dateOnlySchema.optional(),
});
/**
 * Temporary route exchange between two agents (spec §15.1). A route exchange
 * may cover whole routes (`routeId`) and/or specific customers (`customerIds`).
 * M.D. approval is required — the request is recorded on route_exchange.
 */
export const routeExchangeSchema = z.object({
    toAgentId: uuidSchema,
    routeId: z.string().uuid('Invalid route id').nullable().optional(),
    customerIds: z.array(uuidSchema).optional(),
    startDate: dateOnlySchema,
    endDate: dateOnlySchema.nullable().optional(),
    reason: z.string().trim().min(1).max(500),
});
/** Out-of-area / emergency collection approval (spec §14.1 — M.D. approves). */
export const outOfAreaApprovalSchema = z.object({
    customerId: uuidSchema.optional(),
    /** The business date of the collection being approved outside the area. */
    businessDate: dateOnlySchema.optional(),
    reason: z.string().trim().min(1).max(500),
});
/** Disable a lost/stolen agent device (spec §15.1 — M.D. disables the device). */
export const disableDeviceSchema = z.object({
    reason: z.string().trim().min(1).max(500),
});
export const performanceQuerySchema = z.object({
    /** Inclusive performance window (YYYY-MM-DD), defaulting to the current business date. */
    from: dateOnlySchema.optional(),
    to: dateOnlySchema.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).default(0),
});
/** Day totals query (self-service, spec §14.4 / §16.3). */
export const dayTotalsQuerySchema = z.object({
    /** Defaults to today's IST business date. */
    businessDate: dateOnlySchema.optional(),
});
/** Day close submission body (self-service, spec §16.3/§16.5). */
export const dayCloseSchema = z.object({
    /** Defaults to today's IST business date — closing is same-day only. */
    businessDate: dateOnlySchema.optional(),
});
/**
 * Record a field verification of a customer's address (spec §8.1 — address
 * proof is physically verified by the collection field agent). Each request
 * writes one row to field_verification (customer, agent, date, outcome).
 * `verificationDate` defaults to today's IST business date.
 */
export const fieldVerificationSchema = z.object({
    customerId: uuidSchema,
    verificationDate: dateOnlySchema.optional(),
    addressVerified: z.boolean(),
    outcome: z.string().trim().max(200).optional(),
    remarks: z.string().trim().max(500).optional(),
});
/** Path parameter schema shared by the /:id routes. */
export const idParamSchema = z.object({ id: uuidSchema });
/** Path parameters for POST /:id/devices/:deviceId/disable. */
export const agentDeviceIdParamSchema = z.object({
    id: uuidSchema,
    deviceId: uuidSchema,
});
