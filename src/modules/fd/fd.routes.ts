import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  listRateCards,
  createRateCard,
  openAccount,
  listAccounts,
  getAccount,
  updateAccount,
  getHistory,
  lien,
  closeEarly,
  maturityAction,
  loanAgainstFd,
} from './fd.service.js';
import type { RequestMeta } from './fd.service.js';
import {
  createRateCardSchema,
  listRateCardsQuerySchema,
  createAccountSchema,
  listAccountsQuerySchema,
  updateAccountSchema,
  lienSchema,
  closeEarlySchema,
  maturityActionSchema,
  loanAgainstFdSchema,
  historyQuerySchema,
  idParamSchema,
} from './fd.schemas.js';
import type {
  CreateRateCardInput,
  ListRateCardsQuery,
  CreateAccountInput,
  ListAccountsQuery,
  UpdateAccountInput,
  LienInput,
  CloseEarlyInput,
  MaturityActionInput,
  LoanAgainstFdInput,
  HistoryQuery,
} from './fd.schemas.js';

/**
 * Fixed deposits HTTP surface (docs/backend-master-spec.md §11).
 *
 * Mounted at /api/v1/fd. Authority mapping follows spec §5.2 / §11.3:
 *  - browse rate cards / accounts / account history       -> deposits.read
 *  - define a rate card                                   -> Managing Director
 *  - open an FD account                                   -> Managing Director
 *  - request / release a lien                             -> Managing Director
 *  - close early (penalty per rate card holding window)   -> Managing Director
 *  - maturity action (renew / transfer / settle)          -> Managing Director
 *  - loan against FD (85% of deposit, flat-interest)      -> Managing Director
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

/** Path helper for routes that carry an FD-account id path parameter. */
function accountIdParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

export const fdRouter = Router();

// ---------------------------------------------------------------------------
// FD rate cards
// ---------------------------------------------------------------------------

// GET /api/v1/fd/rate-card — searchable, filterable rate-card list
// (band by amount + tenure, per spec §11.1 / §11.3).
fdRouter.get('/rate-card', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listRateCardsQuerySchema, request.query) as ListRateCardsQuery;
  const result = await listRateCards(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/fd/rate-card — define an FD rate card (M.D. only). Each card
// scopes an interest rate / early-closure penalty to an amount band + tenure;
// overlapping live cards are rejected.
fdRouter.post('/rate-card', authenticate, requireRole('managing_director'), validateBody(createRateCardSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateRateCardInput;
  const rateCard = await createRateCard(actor, input, requestMeta(request));
  response.status(201).json(rateCard);
});

// ---------------------------------------------------------------------------
// FD accounts
// ---------------------------------------------------------------------------

// GET /api/v1/fd/accounts — searchable, filterable FD account list.
fdRouter.get('/accounts', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listAccountsQuerySchema, request.query) as ListAccountsQuery;
  const result = await listAccounts(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/fd/accounts — open an FD account (M.D. only). Deposit must fall
// inside the rate card's amount band with an exact tenure match (spec §11.1).
fdRouter.post('/accounts', authenticate, requireRole('managing_director'), validateBody(createAccountSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as CreateAccountInput;
  const account = await openAccount(actor, input, requestMeta(request));
  response.status(201).json(account);
});

// GET /api/v1/fd/accounts/:id — full FD account detail (incl. rate-card band).
fdRouter.get('/accounts/:id', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const account = await getAccount(actor, accountIdParam(request), requestMeta(request));
  response.status(200).json(account);
});

// PATCH /api/v1/fd/accounts/:id — edit the live terms of an FD account
// (M.D. only). Only the rate card / interest rate / fixed-rate flag and the
// interest-disposition instructions are editable.
fdRouter.patch(
  '/accounts/:id',
  authenticate,
  requireRole('managing_director'),
  validateBody(updateAccountSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as UpdateAccountInput;
    const account = await updateAccount(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(account);
  },
);

// GET /api/v1/fd/accounts/:id/history — time-ordered feed of maturity events,
// liens and interest dispositions for the account.
fdRouter.get('/accounts/:id/history', authenticate, requirePermission('deposits.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(historyQuerySchema, request.query) as HistoryQuery;
  const history = await getHistory(actor, accountIdParam(request), query, requestMeta(request));
  response.status(200).json(history);
});

// ---------------------------------------------------------------------------
// Account lifecycle actions
// ---------------------------------------------------------------------------

// POST /api/v1/fd/accounts/:id/lien — request or release a lien (M.D. only).
// A liened account is not settleable / closeable / renewable until released.
fdRouter.post(
  '/accounts/:id/lien',
  authenticate,
  requireRole('managing_director'),
  validateBody(lienSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as LienInput;
    const account = await lien(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(account);
  },
);

// POST /api/v1/fd/accounts/:id/close-early — close before maturity (M.D.
// only); a penalty applies when closure falls inside the rate card's minimum
// holding window (spec §11.1).
fdRouter.post(
  '/accounts/:id/close-early',
  authenticate,
  requireRole('managing_director'),
  validateBody(closeEarlySchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as CloseEarlyInput;
    const result = await closeEarly(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/fd/accounts/:id/maturity-action — settle a matured FD (M.D.
// only): renew principal + interest / renew principal / transfer to savings /
// pay cash / pay bank. Interest is simple interest over the term.
fdRouter.post(
  '/accounts/:id/maturity-action',
  authenticate,
  requireRole('managing_director'),
  validateBody(maturityActionSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as MaturityActionInput;
    const result = await maturityAction(actor, accountIdParam(request), input, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/fd/accounts/:id/loan — disburse an immediate loan secured
// against the FD (M.D. only), capped at 85% of the deposit (spec §11.1).
fdRouter.post(
  '/accounts/:id/loan',
  authenticate,
  requireRole('managing_director'),
  validateBody(loanAgainstFdSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as LoanAgainstFdInput;
    const result = await loanAgainstFd(actor, accountIdParam(request), input, requestMeta(request));
    response.status(201).json(result);
  },
);
