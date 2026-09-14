import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  listWithdrawals,
  getWithdrawal,
  requestWithdrawal,
  approveWithdrawal,
  rejectWithdrawal,
  payWithdrawal,
  confirmWithdrawal,
  changeWithdrawal,
  getWithdrawalHistory,
  cancelWithdrawal,
  reverseWithdrawal,
} from './withdrawals.service.js';
import type { RequestMeta } from './withdrawals.service.js';
import {
  listWithdrawalsQuerySchema,
  requestWithdrawalSchema,
  approveWithdrawalSchema,
  rejectWithdrawalSchema,
  payWithdrawalSchema,
  confirmWithdrawalSchema,
  changeWithdrawalSchema,
  cancelWithdrawalSchema,
  reverseWithdrawalSchema,
  idempotencyKeySchema,
  idParamSchema,
} from './withdrawals.schemas.js';
import type {
  ListWithdrawalsQuery,
  RequestWithdrawalInput,
  ApproveWithdrawalInput,
  RejectWithdrawalInput,
  PayWithdrawalInput,
  ConfirmWithdrawalInput,
  ChangeWithdrawalInput,
  CancelWithdrawalInput,
  ReverseWithdrawalInput,
} from './withdrawals.schemas.js';

/**
 * Withdrawals HTTP surface (docs/backend-master-spec.md §13).
 *
 * Mounted at /api/v1/withdrawals. Authority mapping follows spec §13.3:
 *  - browse requests / read history              -> withdrawals.read
 *  - create a withdrawal request                 -> withdrawals.create
 *  - approve / reject / pay / confirm a request  -> withdrawals.approve
 *    (requests above ₹2,00,000 additionally require the President — enforced
 *    in the service via canApproveWithdrawal)
 *  - change an approved request                  -> President only
 *  - reverse a paid/confirmed payout             -> Managing Director only
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

/** Path helper for routes that carry a withdrawal-request id path parameter. */
function idParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

/**
 * Reads and validates the client-generated `Idempotency-Key` header. The key is
 * mandatory on POST /withdrawals so a retried submit (double-click, flaky
 * network) can never create a duplicate money movement — the service replays the
 * original result instead (spec §1.3, mirrors the sync protocol contract).
 */
function idempotencyKey(request: Request): string {
  return parse(
    idempotencyKeySchema,
    request.get('Idempotency-Key'),
    'Idempotency-Key header is required and must be a 32-character lowercase hexadecimal key',
  );
}

export const withdrawalsRouter = Router();

// ---------------------------------------------------------------------------
// Withdrawal requests
// ---------------------------------------------------------------------------

// GET /api/v1/withdrawals — searchable, filterable withdrawal request list.
withdrawalsRouter.get('/', authenticate, requirePermission('withdrawals.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listWithdrawalsQuerySchema, request.query) as ListWithdrawalsQuery;
  const result = await listWithdrawals(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// GET /api/v1/withdrawals/:id — single withdrawal request with the full
// operator worksheet (documents) resolved from the backend, so the detail view
// never relies on a list row.
withdrawalsRouter.get('/:id', authenticate, requirePermission('withdrawals.read'), async (request, response) => {
  const actor = authOf(request);
  const withdrawal = await getWithdrawal(actor, idParam(request), requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals — create a withdrawal request against a savings,
// RD, FD or loan-surplus source (spec §13.1). The request starts 'pending' and
// must be approved before payout. Idempotent: a replayed Idempotency-Key returns
// the original request (200) instead of creating a duplicate (201).
withdrawalsRouter.post('/', authenticate, requirePermission('withdrawals.create'), validateBody(requestWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as RequestWithdrawalInput;
  const result = await requestWithdrawal(actor, input, requestMeta(request), idempotencyKey(request));
  response.status(result.created ? 201 : 200).json(result);
});

// POST /api/v1/withdrawals/:id/approve — approve a pending request. Requests
// above ₹2,00,000 are additionally gated on the President in the service.
withdrawalsRouter.post('/:id/approve', authenticate, requirePermission('withdrawals.approve'), validateBody(approveWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ApproveWithdrawalInput;
  const withdrawal = await approveWithdrawal(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals/:id/reject — reject a pending (or approved) request.
// The original approval decision is never overwritten — rejection reason is
// recorded and the trail keeps the approval event.
withdrawalsRouter.post('/:id/reject', authenticate, requirePermission('withdrawals.approve'), validateBody(rejectWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as RejectWithdrawalInput;
  const withdrawal = await rejectWithdrawal(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals/:id/pay — record identity verification + payout
// reference and debit the linked savings ledger (spec §13.4).
withdrawalsRouter.post('/:id/pay', authenticate, requirePermission('withdrawals.approve'), validateBody(payWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as PayWithdrawalInput;
  const withdrawal = await payWithdrawal(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals/:id/confirm — confirm a paid payout (terminal state).
withdrawalsRouter.post('/:id/confirm', authenticate, requirePermission('withdrawals.approve'), validateBody(confirmWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ConfirmWithdrawalInput;
  const withdrawal = await confirmWithdrawal(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals/:id/change — Presidential change of an approved
// request (spec §13.1). The request re-enters the pending queue; the original
// approval decision is preserved in the event history.
withdrawalsRouter.post('/:id/change', authenticate, requireRole('president'), validateBody(changeWithdrawalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as ChangeWithdrawalInput;
  const withdrawal = await changeWithdrawal(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(withdrawal);
});

// POST /api/v1/withdrawals/:id/cancel — cancel a pending or approved request
// before payout (spec §13.1). A paid/confirmed payout can never be cancelled —
// it must be reversed through the ledger. Cancellation is recorded as an event
// and an audit entry so the trail is never rewritten.
withdrawalsRouter.post(
  '/:id/cancel',
  authenticate,
  requirePermission('withdrawals.approve'),
  validateBody(cancelWithdrawalSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as CancelWithdrawalInput;
    const withdrawal = await cancelWithdrawal(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(withdrawal);
  },
);

// POST /api/v1/withdrawals/:id/reverse — recall a PAID/CONFIRMED payout. Unlike
// cancel, the money has already left the bank, so a compensating credit is
// posted back into the source savings account (the original debit stays
// immutable) and the request moves to the terminal 'reversed' state. Reserved to
// the Managing Director.
withdrawalsRouter.post(
  '/:id/reverse',
  authenticate,
  requireRole('managing_director'),
  validateBody(reverseWithdrawalSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as ReverseWithdrawalInput;
    const withdrawal = await reverseWithdrawal(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(withdrawal);
  },
);

// GET /api/v1/withdrawals/:id/history — chronological event trail for a
// withdrawal request (requested -> approved/rejected -> paid -> confirmed).
withdrawalsRouter.get('/:id/history', authenticate, requirePermission('withdrawals.read'), async (request, response) => {
  const actor = authOf(request);
  const history = await getWithdrawalHistory(actor, idParam(request), requestMeta(request));
  response.status(200).json(history);
});
