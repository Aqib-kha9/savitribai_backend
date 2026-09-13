import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { istBusinessDate } from '../../core/time.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  createCustomer,
  listCustomers,
  exportCustomers,
  getCustomer,
  listCustomerDocuments,
  updateCustomer,
  changeCustomerStatus,
  deathNotification,
  transferCustomer,
  approveKyc,
  setNominee,
  recordConsents,
  recordComplaint,
  mergeCustomers,
  listFieldVerifications,
  createDataSubjectRequest,
  listDataSubjectRequests,
  decideDataSubjectRequest,
} from './customers.service.js';
import type { RequestMeta } from './customers.service.js';
import {
  createCustomerSchema,
  updateCustomerSchema,
  changeStatusSchema,
  transferCustomerSchema,
  kycApproveSchema,
  nomineeSchema,
  consentsSchema,
  complaintSchema,
  mergeSchema,
  deathNotificationSchema,
  listCustomersQuerySchema,
  exportCustomersQuerySchema,
  idParamSchema,
  createDataSubjectRequestSchema,
  decideDataSubjectRequestSchema,
  dataSubjectRequestIdParamSchema,
} from './customers.schemas.js';
import type {
  CreateCustomerInput,
  UpdateCustomerInput,
  ChangeStatusInput,
  TransferCustomerInput,
  KycApproveInput,
  NomineeInput,
  ConsentsInput,
  ComplaintInput,
  MergeInput,
  DeathNotificationInput,
  ListCustomersQuery,
  ExportCustomersQuery,
  CreateDataSubjectRequestInput,
  DecideDataSubjectRequestInput,
} from './customers.schemas.js';

/**
 * Customer registry HTTP surface (docs/backend-master-spec.md §8).
 *
 * Mounted at /api/v1/customers. Authority mapping follows spec §8.1 / §8.3:
 *  - view customers / read the customer detail        -> customers.read
 *  - create / update profile, nominee, consents,
 *    complaints                                       -> customers.write
 *  - change status, duplicate merge, death
 *    notification                                     -> Managing Director
 *  - branch transfer, KYC approval                    -> Manager (or M.D.)
 *  - identity-document listing                        -> Clerk and above
 *
 * Statement endpoints (GET /customers/:id/statements) live in the reports
 * module (spec §17) and mount the same resource path later.
 */

/**
 * The `authenticate` middleware guarantees `request.auth` is present once the
 * chain reaches the handler; this narrows the optional type for TypeScript and
 * guards against a future chain reorder.
 */
function authOf(request: Request): AuthContext {
  if (!request.auth) throw new UnauthorizedError();
  return request.auth;
}

/** Builds service-layer RequestMeta from the live request. */
function requestMeta(request: Request): RequestMeta {
  const meta: RequestMeta = {};
  const ip = request.ip;
  if (ip) meta.ipAddress = ip;
  const userAgent = request.get('user-agent');
  if (userAgent) meta.userAgent = userAgent;
  if (request.id) meta.requestId = request.id;
  return meta;
}

/** Path helper for routes that carry a customer id path parameter. */
function idParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

export const customersRouter = Router();

/**
 * Escapes a value for CSV output (RFC 4180): doubles embedded quotes and always
 * wraps the field so commas / newlines / quotes inside a customer name cannot
 * break the column layout or allow a formula-injection payload to leak.
 */
function csvCell(value: string | null | undefined): string {
  const text = value ?? '';
  return `"${text.replace(/"/g, '""')}"`;
}

/** Serialises exported customer rows into an RFC 4180 CSV document. */
function toCustomersCsv(rows: Awaited<ReturnType<typeof exportCustomers>>): string {
  const header = [
    'Customer No',
    'Name',
    'Customer Type',
    'Account Type',
    'Mobile',
    'Email',
    'Branch',
    'Status',
    'Risk',
    'Registration Date',
  ];
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.customerNumber),
        csvCell(row.fullName),
        csvCell(row.customerType),
        csvCell(row.membershipCategory),
        csvCell(row.mobile),
        csvCell(row.email),
        csvCell(row.branchName),
        csvCell(row.status),
        csvCell(row.riskCategory),
        csvCell(row.registrationDate),
      ].join(','),
    );
  }
  // Prepend a UTF-8 BOM so Excel renders non-ASCII customer names correctly.
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// GET /api/v1/customers — searchable, filterable customer list (spec §8.3).
customersRouter.get('/', authenticate, requirePermission('customers.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listCustomersQuerySchema, request.query) as ListCustomersQuery;
  const result = await listCustomers(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/customers — register a customer (KYC documents optional at
// registration; KYC lifecycle starts pending). 201 on success.
customersRouter.post('/', authenticate, requirePermission('customers.write'), validateBody(createCustomerSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateCustomerInput;
  const customer = await createCustomer(actor, input, requestMeta(request));
  response.status(201).json(customer);
});

// GET /api/v1/customers/export — CSV download of the filtered registry.
// Declared before '/:id' so the literal path is not captured as a customer id.
// Requires customers.export (super admin / managing director / manager) and is
// audited because it discloses personal data in bulk (spec §6.3).
customersRouter.get('/export', authenticate, requirePermission('customers.export'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(exportCustomersQuerySchema, request.query) as ExportCustomersQuery;
  const rows = await exportCustomers(actor, query, requestMeta(request));
  const filename = `customers-${istBusinessDate()}.csv`;
  response.setHeader('Content-Type', 'text/csv; charset=utf-8');
  response.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  response.status(200).send(toCustomersCsv(rows));
});

// GET /api/v1/customers/:id — full customer detail (profile + addresses +
// identity documents + KYC + nominee + consents + complaints).
customersRouter.get('/:id', authenticate, requirePermission('customers.read'), async (request, response) => {
  const actor = authOf(request);
  const customer = await getCustomer(actor, idParam(request), requestMeta(request));
  response.status(200).json(customer);
});

// PATCH /api/v1/customers/:id — profile update. Replacing identity documents
// resets KYC to pending (spec §8.1 — a fresh approval is required).
customersRouter.patch('/:id', authenticate, requirePermission('customers.write'), validateBody(updateCustomerSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as UpdateCustomerInput;
  const customer = await updateCustomer(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/status — change customer status (M.D. only).
customersRouter.post('/:id/status', authenticate, requireRole('managing_director'), validateBody(changeStatusSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ChangeStatusInput;
  const customer = await changeCustomerStatus(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/transfer — branch transfer (Manager approves;
// spec §8.1 / §8.3). Managing Director is allowed as the senior authority.
customersRouter.post('/:id/transfer', authenticate, requireRole('manager', 'managing_director'), validateBody(transferCustomerSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as TransferCustomerInput;
  const customer = await transferCustomer(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/kyc/approve — approve/reject a customer's KYC
// (Manager, or the M.D. as senior authority).
customersRouter.post('/:id/kyc/approve', authenticate, requireRole('manager', 'managing_director'), validateBody(kycApproveSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as KycApproveInput;
  const customer = await approveKyc(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/nominee — set/replace the current nominee
// (previous nominee is superseded and retained in nominee_history).
customersRouter.post('/:id/nominee', authenticate, requirePermission('customers.write'), validateBody(nomineeSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as NomineeInput;
  const customer = await setNominee(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/consents — record per-channel communication
// consents (spec §8.1 — all channels captured).
customersRouter.post('/:id/consents', authenticate, requirePermission('customers.write'), validateBody(consentsSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ConsentsInput;
  const customer = await recordConsents(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/complaints — record a complaint / service request.
customersRouter.post('/:id/complaints', authenticate, requirePermission('customers.write'), validateBody(complaintSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ComplaintInput;
  const complaint = await recordComplaint(actor, idParam(request), input, requestMeta(request));
  response.status(201).json(complaint);
});

// POST /api/v1/customers/:id/merge — duplicate-profile merge (M.D. only).
// The source customer is closed and linked to the surviving profile; its data
// is never hard-deleted (spec §8.1).
customersRouter.post('/:id/merge', authenticate, requireRole('managing_director'), validateBody(mergeSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as MergeInput;
  const customer = await mergeCustomers(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// POST /api/v1/customers/:id/death-notification — report the death of a
// customer (M.D. only). Moves the profile to status 'deceased'.
customersRouter.post('/:id/death-notification', authenticate, requireRole('managing_director'), validateBody(deathNotificationSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as DeathNotificationInput;
  const customer = await deathNotification(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(customer);
});

// GET /api/v1/customers/:id/documents — identity documents of a customer.
// Restricted to Clerk and above (spec §8.3 — Clerk+ only; agents are excluded
// even though they carry customers.read).
customersRouter.get(
  '/:id/documents',
  authenticate,
  requireRole('clerk', 'cashier', 'manager', 'vice_president', 'president', 'managing_director'),
  async (request, response) => {
    const actor = authOf(request);
    const documents = await listCustomerDocuments(actor, idParam(request), requestMeta(request));
    response.status(200).json(documents);
  },
);

// GET /api/v1/customers/:id/field-verifications — field (address) verification
// history for a customer (spec §8.1 — address proof is physically verified by
// a collection field agent on the mobile app; this read is office-side).
customersRouter.get('/:id/field-verifications', authenticate, requirePermission('customers.read'), async (request, response) => {
  const actor = authOf(request);
  const verifications = await listFieldVerifications(actor, idParam(request), requestMeta(request));
  response.status(200).json(verifications);
});

// ---------------------------------------------------------------------------
// Data-subject rights (spec §24.2)
// ---------------------------------------------------------------------------

// POST /api/v1/customers/:id/data-subject-requests — raise a copy / correction /
// restriction / deletion request on a customer's behalf (office staff with
// customer write access). The register is append-only.
customersRouter.post(
  '/:id/data-subject-requests',
  authenticate,
  requirePermission('customers.write'),
  validateBody(createDataSubjectRequestSchema),
  async (request, response) => {
    const actor = authOf(request);
    const customerId = idParam(request);
    const input = request.body as CreateDataSubjectRequestInput;
    const created = await createDataSubjectRequest(actor, customerId, input, requestMeta(request));
    response.status(201).json(created);
  },
);

// GET /api/v1/customers/:id/data-subject-requests — the request register for a
// customer, newest first (audited as a customer data access).
customersRouter.get(
  '/:id/data-subject-requests',
  authenticate,
  requirePermission('customers.read'),
  async (request, response) => {
    const actor = authOf(request);
    const requests = await listDataSubjectRequests(actor, idParam(request), requestMeta(request));
    response.status(200).json(requests);
  },
);

// PATCH /api/v1/customers/:id/data-subject-requests/:requestId — M.D. decision
// (spec §24.1 external reporting contact). Completing a deletion moves the
// profile to soft 'deleted'; a restriction request to 'restricted'.
customersRouter.patch(
  '/:id/data-subject-requests/:requestId',
  authenticate,
  requireRole('managing_director'),
  validateBody(decideDataSubjectRequestSchema),
  async (request, response) => {
    const actor = authOf(request);
    const { id, requestId } = dataSubjectRequestIdParamSchema.parse(request.params);
    const input = request.body as DecideDataSubjectRequestInput;
    const decided = await decideDataSubjectRequest(actor, id, requestId, input, requestMeta(request));
    response.status(200).json(decided);
  },
);
