import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  listSchemes,
  createScheme,
  openAccount,
  listAccounts,
  getAccount,
  getSchedule,
  recordInstalmentPayment,
  waivePenalty,
  rescheduleAccount,
  closeEarlyAccount,
  surplusTransfer,
  approveAccount,
} from './rd.service.js';
import type { RequestMeta } from './rd.service.js';
import {
  createSchemeSchema,
  listSchemesQuerySchema,
  createAccountSchema,
  listAccountsQuerySchema,
  instalmentPaymentSchema,
  scheduleQuerySchema,
  penaltyWaiverSchema,
  rescheduleSchema,
  closeEarlySchema,
  surplusTransferSchema,
  approvalSchema,
  idParamSchema,
} from './rd.schemas.js';
import type {
  CreateSchemeInput,
  ListSchemesQuery,
  CreateAccountInput,
  ListAccountsQuery,
  InstalmentPaymentInput,
  ScheduleQuery,
  PenaltyWaiverInput,
  RescheduleInput,
  CloseEarlyInput,
  SurplusTransferInput,
  ApprovalInput,
} from './rd.schemas.js';

/**
 * Recurring deposits HTTP surface (docs/backend-master-spec.md §10).
 *
 * Mounted at /api/v1/rd. Authority mapping follows spec §5.2 / §10.3:
 *  - browse schemes / accounts / schedule ledger       -> deposits.read
 *  - define an RD scheme                               -> Managing Director
 *  - open an RD account                                -> Managing Director
 *    (starts 'pending_approval'; must be approved before active)
 *  - record instalment payments (full/part/multiple)   -> deposits.write
 *    (cashier & manager counters; agents via collections module §14)
 *  - waive penalty / reschedule (schedule change)      -> President
 *  - close early (4% closure fee)                      -> Managing Director
 *  - surplus transfer to linked loan account           -> Managing Director
 *    (requires the separate approval flow — fund transfer)
 *  - approve an account (second reviewer / designated
 *    person for opening and fund-transfer approvals)   -> President (or M.D.)
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

/** Path helper for routes that carry an RD-account id path parameter. */
function accountIdParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

export const rdRouter = Router();

// ---------------------------------------------------------------------------
// RD schemes
// ---------------------------------------------------------------------------

// GET /api/v1/rd/schemes — searchable, filterable scheme list (spec §10.3).
rdRouter.get('/schemes', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listSchemesQuerySchema, request.query) as ListSchemesQuery;
  const result = await listSchemes(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/rd/schemes — define an RD scheme (M.D. only). Scheme defines
// frequency, instalment limits, term, interest, penalty configuration.
rdRouter.post('/schemes', authenticate, requireRole('managing_director'), validateBody(createSchemeSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateSchemeInput;
  const scheme = await createScheme(actor, input, requestMeta(request));
  response.status(201).json(scheme);
});

// ---------------------------------------------------------------------------
// RD accounts
// ---------------------------------------------------------------------------

// GET /api/v1/rd/accounts — searchable, filterable account list.
rdRouter.get('/accounts', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listAccountsQuerySchema, request.query) as ListAccountsQuery;
  const result = await listAccounts(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/rd/accounts — open an RD account (M.D. only). Frequency is
// daily/weekly/monthly/quarterly per scheme (spec §10.1). The account starts
// in 'pending_approval' and must be approved before it becomes active.
rdRouter.post('/accounts', authenticate, requireRole('managing_director'), validateBody(createAccountSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateAccountInput;
  const account = await openAccount(actor, input, requestMeta(request));
  response.status(201).json(account);
});

// GET /api/v1/rd/accounts/:id — full RD account detail.
rdRouter.get('/accounts/:id', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const account = await getAccount(actor, accountIdParam(request), requestMeta(request));
  response.status(200).json(account);
});

// ---------------------------------------------------------------------------
// Instalments, schedule and account lifecycle actions
// ---------------------------------------------------------------------------

// POST /api/v1/rd/accounts/:id/instalments — record an instalment payment
// (full / part / multiple-in-one) against the oldest-due-first allocation
// (cashier & manager counters). A returned InstalmentPaymentResult describes
// how the paid amount was allocated across instalments, penalties and surplus.
rdRouter.post(
  '/accounts/:id/instalments',
  authenticate,
  requirePermission('deposits.write'),
  validateBody(instalmentPaymentSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as InstalmentPaymentInput;
    const result = await recordInstalmentPayment(actor, accountIdParam(request), input, requestMeta(request));
    response.status(201).json(result);
  },
);

// GET /api/v1/rd/accounts/:id/schedule — expected instalments ledger with
// paid/missed/waived status and penalty information (spec §10.1 ledger).
rdRouter.get('/accounts/:id/schedule', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(scheduleQuerySchema, request.query) as ScheduleQuery;
  const schedule = await getSchedule(actor, accountIdParam(request), query, requestMeta(request));
  response.status(200).json(schedule);
});

// POST /api/v1/rd/accounts/:id/penalty-waiver — waive a late/missed penalty
// (President only — spec §10.3, §5.2).
rdRouter.post(
  '/accounts/:id/penalty-waiver',
  authenticate,
  requireRole('president'),
  validateBody(penaltyWaiverSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as PenaltyWaiverInput;
    const result = await waivePenalty(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/rd/accounts/:id/reschedule — due-date / instalment-amount /
// both schedule change (President only — spec §10.1 due-date changes and
// §10.3 reschedule). Persists rd_schedule_change history.
rdRouter.post(
  '/accounts/:id/reschedule',
  authenticate,
  requireRole('president'),
  validateBody(rescheduleSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as RescheduleInput;
    const result = await rescheduleAccount(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/rd/accounts/:id/close-early — close before maturity; a 4%
// early-closure fee is applied (spec §10.1).
rdRouter.post(
  '/accounts/:id/close-early',
  authenticate,
  requireRole('managing_director'),
  validateBody(closeEarlySchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as CloseEarlyInput;
    const result = await closeEarlyAccount(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/rd/accounts/:id/surplus-transfer — move excess over the
// expected amount into the member's linked loan account; released only when
// the loan completes (spec §10.1 follow-up rule).
rdRouter.post(
  '/accounts/:id/surplus-transfer',
  authenticate,
  requireRole('managing_director'),
  validateBody(surplusTransferSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as SurplusTransferInput;
    const result = await surplusTransfer(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/rd/accounts/:id/approvals — second reviewer / designated
// person approval: account opening and fund-transfer / approved-fund-waiting
// actions (spec §10.3). President or M.D.
rdRouter.post(
  '/accounts/:id/approvals',
  authenticate,
  requireRole('president', 'managing_director'),
  validateBody(approvalSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as ApprovalInput;
    const account = await approveAccount(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(account);
  },
);
