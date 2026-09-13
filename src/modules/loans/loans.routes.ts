import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  listProducts,
  createProduct,
  listApplications,
  listLoans,
  createApplication,
  recommendApplication,
  approveApplication,
  disburseLoan,
  getLoan,
  getSchedule,
  recordRepayment,
  correctRepayment,
  rescheduleLoan,
  settleLoan,
  writeOffLoan,
  transferLoan,
  grantWaiver,
  releaseSurplus,
  getStatements,
} from './loans.service.js';
import type { RequestMeta } from './loans.service.js';
import {
  createProductSchema,
  listProductsQuerySchema,
  createApplicationSchema,
  listApplicationsQuerySchema,
  listLoansQuerySchema,
  recommendSchema,
  approveSchema,
  disburseSchema,
  recordRepaymentSchema,
  correctRepaymentSchema,
  rescheduleSchema,
  settleSchema,
  writeOffSchema,
  transferSchema,
  waiverSchema,
  surplusReleaseSchema,
  scheduleQuerySchema,
  statementsQuerySchema,
  idParamSchema,
  uuidSchema,
} from './loans.schemas.js';
import type {
  CreateProductInput,
  ListProductsQuery,
  CreateApplicationInput,
  ListApplicationsQuery,
  ListLoansQuery,
  RecommendInput,
  ApproveInput,
  DisburseInput,
  RecordRepaymentInput,
  CorrectRepaymentInput,
  RescheduleInput,
  SettleInput,
  WriteOffInput,
  TransferInput,
  WaiverInput,
  SurplusReleaseInput,
  ScheduleQuery,
  StatementsQuery,
} from './loans.schemas.js';

/**
 * Loans HTTP surface (docs/backend-master-spec.md §12).
 *
 * Mounted at /api/v1/loans. Authority mapping follows spec §12.1 / §12.3 and
 * the role matrix:
 *  - browse loan products / applications           -> loans.read
 *  - define a loan product (product configuration) -> Managing Director
 *  - open a loan application                       -> loans.write
 *  - recommend an application                      -> loans.approve (officer)
 *  - approve / reject an application               -> President (M.D. secondary)
 *  - disburse an approved application              -> loans.write
 *  - view a loan / schedule / statements           -> loans.read
 *    (statements on customer request only, spec §12.3)
 *  - record / correct repayments                   -> loans.write (M.D. for the
 *    correction, spec §19.2 universal correction pattern)
 *  - reschedule / settle / write-off / transfer / waiver / surplus-release
 *                                                 -> President
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

/** Path helper for routes carrying a loan id path parameter. */
function loanIdParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

/** Path helper for routes carrying a loan application id path parameter. */
function applicationIdParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

/** Path helper for the repayment-id segment of the correction route. */
function repaymentIdParam(request: Request): string {
  return parse(uuidSchema, request.params.rid);
}

export const loansRouter = Router();

// ---------------------------------------------------------------------------
// Loan products
// ---------------------------------------------------------------------------

// GET /api/v1/loans/products — searchable, filterable product list (spec §12.3).
loansRouter.get('/products', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listProductsQuerySchema, request.query) as ListProductsQuery;
  const result = await listProducts(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/loans/products — define a loan product (M.D. only). Per-product
// configuration: rate policy, repayment frequency incl. weekly, penalty
// configuration and allocation order (spec §12.1, §12.3).
loansRouter.post('/products', authenticate, requireRole('managing_director'), validateBody(createProductSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateProductInput;
  const product = await createProduct(actor, input, requestMeta(request));
  response.status(201).json(product);
});

// ---------------------------------------------------------------------------
// Loan applications
// ---------------------------------------------------------------------------

// GET /api/v1/loans/applications — searchable, filterable application list.
loansRouter.get('/applications', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listApplicationsQuerySchema, request.query) as ListApplicationsQuery;
  const result = await listApplications(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/loans/applications — open a loan application. Home-loan purposes
// are rejected by the schema (spec §12.1).
loansRouter.post('/applications', authenticate, requirePermission('loans.write'), validateBody(createApplicationSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateApplicationInput;
  const application = await createApplication(actor, input, requestMeta(request));
  response.status(201).json(application);
});

// POST /api/v1/loans/applications/:id/recommend — recommend an applied
// application for approval; the recommending officer is recorded.
loansRouter.post(
  '/applications/:id/recommend',
  authenticate,
  requirePermission('loans.approve'),
  validateBody(recommendSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as RecommendInput;
    const application = await recommendApplication(actor, applicationIdParam(request), input, requestMeta(request));
    response.status(200).json(application);
  },
);

// POST /api/v1/loans/applications/:id/approve — approve or reject a recommended
// application (President; M.D. secondary).
loansRouter.post(
  '/applications/:id/approve',
  authenticate,
  requireRole('president', 'managing_director'),
  validateBody(approveSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as ApproveInput;
    const application = await approveApplication(actor, applicationIdParam(request), input, requestMeta(request));
    response.status(200).json(application);
  },
);

// ---------------------------------------------------------------------------
// Loan disbursal
// ---------------------------------------------------------------------------

// POST /api/v1/loans/:id/disburse — convert an approved application into a
// live loan (materialises guarantors/collateral and generates the schedule).
loansRouter.post(
  '/:id/disburse',
  authenticate,
  requirePermission('loans.write'),
  validateBody(disburseSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as DisburseInput;
    const result = await disburseLoan(actor, loanIdParam(request), input, requestMeta(request));
    response.status(201).json(result);
  },
);

// ---------------------------------------------------------------------------
// Disbursed loans (collection-level list)
// ---------------------------------------------------------------------------

// GET /api/v1/loans — searchable, filterable list of disbursed loan accounts.
// Registered before /:id so the collection route is not shadowed.
loansRouter.get('/', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listLoansQuerySchema, request.query) as ListLoansQuery;
  const result = await listLoans(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// ---------------------------------------------------------------------------
// Loan detail & repayment schedule
// ---------------------------------------------------------------------------

// GET /api/v1/loans/:id — full loan detail with instalment ledger.
loansRouter.get('/:id', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const detail = await getLoan(actor, loanIdParam(request), requestMeta(request));
  response.status(200).json(detail);
});

// GET /api/v1/loans/:id/schedule — repayment schedule (due dates shifted to
// the next working day for Sundays, spec §12.5.2).
loansRouter.get('/:id/schedule', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(scheduleQuerySchema, request.query) as ScheduleQuery;
  const schedule = await getSchedule(actor, loanIdParam(request), query, requestMeta(request));
  response.status(200).json(schedule);
});

// ---------------------------------------------------------------------------
// Repayments
// ---------------------------------------------------------------------------

// POST /api/v1/loans/:id/repayments — record a repayment through the allocation
// engine (interest first on short payment; surplus held on the loan account).
loansRouter.post(
  '/:id/repayments',
  authenticate,
  requirePermission('loans.write'),
  validateBody(recordRepaymentSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as RecordRepaymentInput;
    const result = await recordRepayment(actor, loanIdParam(request), input, requestMeta(request));
    response.status(201).json(result);
  },
);

// POST /api/v1/loans/:id/repayments/:rid/correct — M.D. correction of a
// wrongly-recorded repayment on one instalment (adjustment record, spec §12.3,
// §19.2).
loansRouter.post(
  '/:id/repayments/:rid/correct',
  authenticate,
  requireRole('managing_director'),
  validateBody(correctRepaymentSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as CorrectRepaymentInput;
    const result = await correctRepayment(actor, loanIdParam(request), repaymentIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Loan lifecycle completion (spec §12.3; President authorities)
// ---------------------------------------------------------------------------

// POST /api/v1/loans/:id/reschedule — re-amortise the remaining principal over
// a new term (President).
loansRouter.post(
  '/:id/reschedule',
  authenticate,
  requireRole('president'),
  validateBody(rescheduleSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as RescheduleInput;
    const result = await rescheduleLoan(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/loans/:id/settle — full settlement of a fully-paid loan
// (President).
loansRouter.post(
  '/:id/settle',
  authenticate,
  requireRole('president'),
  validateBody(settleSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as SettleInput;
    const result = await settleLoan(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/loans/:id/write-off — write off the outstanding balance
// (President).
loansRouter.post(
  '/:id/write-off',
  authenticate,
  requireRole('president'),
  validateBody(writeOffSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as WriteOffInput;
    const result = await writeOffLoan(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/loans/:id/transfer — move the loan to another branch; recorded
// as a refinance restructure (spec §12.3).
loansRouter.post(
  '/:id/transfer',
  authenticate,
  requireRole('president'),
  validateBody(transferSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as TransferInput;
    const result = await transferLoan(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/loans/:id/waiver — waive a specific unpaid instalment or a
// capped amount of the outstanding balance (President).
loansRouter.post(
  '/:id/waiver',
  authenticate,
  requireRole('president'),
  validateBody(waiverSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as WaiverInput;
    const result = await grantWaiver(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/loans/:id/surplus-release — release the held surplus once the
// loan is completed (spec §12.3, §12.5.4).
loansRouter.post(
  '/:id/surplus-release',
  authenticate,
  requireRole('president'),
  validateBody(surplusReleaseSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as SurplusReleaseInput;
    const result = await releaseSurplus(actor, loanIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Loan statements (spec §12.3 — on customer request only)
// ---------------------------------------------------------------------------

// GET /api/v1/loans/:id/statements — activity statement (audit trail) for the
// loan; read is limited to loans.read.
loansRouter.get('/:id/statements', authenticate, requirePermission('loans.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(statementsQuerySchema, request.query) as StatementsQuery;
  const statement = await getStatements(actor, loanIdParam(request), query, requestMeta(request));
  response.status(200).json(statement);
});
