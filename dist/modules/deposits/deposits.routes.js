import { Router } from 'express';
import { authenticate, requirePermission, requireRole } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import { listProducts, createProduct, createAccount, listAccounts, getAccount, updateAccount, freezeAccount, closeAccount, reopenAccount, approveAccount, postTransaction, listTransactions, createAdjustment, getStatement, } from './deposits.service.js';
import { createProductSchema, listProductsQuerySchema, createAccountSchema, updateAccountSchema, freezeAccountSchema, closeAccountSchema, reopenAccountSchema, approveAccountSchema, listAccountsQuerySchema, postTransactionSchema, listTransactionsQuerySchema, createAdjustmentSchema, statementQuerySchema, idParamSchema, } from './deposits.schemas.js';
/**
 * Deposits / savings HTTP surface (docs/backend-master-spec.md §9).
 *
 * Mounted at /api/v1/deposits. Authority mapping follows spec §9.1 / §9.3:
 *  - browse products / accounts / ledger / statements  -> deposits.read
 *  - create a deposit product                          -> Managing Director
 *  - open / edit / freeze / close / reopen an account  -> Managing Director
 *  - approve an account (second reviewer / designated
 *    person for opening and closure)                   -> President (or M.D.)
 *  - post deposit / withdrawal transactions            -> deposits.write
 *    (cashier & manager counters, agents via collections module §14)
 *  - corrections / adjustments                         -> Managing Director
 *    (original ledger row is never modified — spec §9.1)
 */
/**
 * The `authenticate` middleware guarantees `request.auth` is present once the
 * chain reaches the handler; this narrows the optional type for TypeScript and
 * guards against a future chain reorder.
 */
function authOf(request) {
    if (!request.auth)
        throw new UnauthorizedError();
    return request.auth;
}
/** Builds service-layer RequestMeta from the live request. */
function requestMeta(request) {
    const meta = {};
    const ip = request.ip;
    if (ip)
        meta.ipAddress = ip;
    const userAgent = request.get('user-agent');
    if (userAgent)
        meta.userAgent = userAgent;
    if (request.id)
        meta.requestId = request.id;
    return meta;
}
/** Path helper for routes that carry a savings-account id path parameter. */
function idParam(request) {
    return parse(idParamSchema, request.params).id;
}
export const depositsRouter = Router();
// ---------------------------------------------------------------------------
// Deposit products
// ---------------------------------------------------------------------------
// GET /api/v1/deposits/products — searchable product list (spec §9.3).
depositsRouter.get('/products', authenticate, requirePermission('deposits.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listProductsQuerySchema, request.query);
    const result = await listProducts(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/deposits/products — define a deposit product (M.D. only).
depositsRouter.post('/products', authenticate, requireRole('managing_director'), validateBody(createProductSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const product = await createProduct(actor, input, requestMeta(request));
    response.status(201).json(product);
});
// ---------------------------------------------------------------------------
// Savings accounts
// ---------------------------------------------------------------------------
// GET /api/v1/deposits/accounts — searchable, filterable account list.
depositsRouter.get('/accounts', authenticate, requirePermission('deposits.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listAccountsQuerySchema, request.query);
    const result = await listAccounts(actor, query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/deposits/accounts — open a savings account (M.D. only). The
// account starts in 'pending_approval' and must be approved before it becomes
// active (spec §9.1 — opening approved by the designated person).
depositsRouter.post('/accounts', authenticate, requireRole('managing_director'), validateBody(createAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await createAccount(actor, input, requestMeta(request));
    response.status(201).json(account);
});
// GET /api/v1/deposits/accounts/:id — full account detail.
depositsRouter.get('/accounts/:id', authenticate, requirePermission('deposits.read'), async (request, response) => {
    const actor = authOf(request);
    const account = await getAccount(actor, idParam(request), requestMeta(request));
    response.status(200).json(account);
});
// PATCH /api/v1/deposits/accounts/:id — edit account terms (M.D. only):
// product change or a variable interest-rate change (spec §9.1).
depositsRouter.patch('/accounts/:id', authenticate, requireRole('managing_director'), validateBody(updateAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await updateAccount(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(account);
});
// POST /api/v1/deposits/accounts/:id/freeze — freeze an account (M.D. only).
depositsRouter.post('/accounts/:id/freeze', authenticate, requireRole('managing_director'), validateBody(freezeAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await freezeAccount(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(account);
});
// POST /api/v1/deposits/accounts/:id/close — close an account (M.D. only).
// Balance must be zero (spec §9.1); closure is approved by the designated
// person on a separate approval flow in the corrections module (spec §19).
depositsRouter.post('/accounts/:id/close', authenticate, requireRole('managing_director'), validateBody(closeAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await closeAccount(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(account);
});
// POST /api/v1/deposits/accounts/:id/reopen — reopen a frozen or closed
// account (M.D. only).
depositsRouter.post('/accounts/:id/reopen', authenticate, requireRole('managing_director'), validateBody(reopenAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await reopenAccount(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(account);
});
// POST /api/v1/deposits/accounts/:id/approve — second reviewer / designated
// person approval for an account opening (spec §9.1). President or M.D.
depositsRouter.post('/accounts/:id/approve', authenticate, requireRole('president', 'managing_director'), validateBody(approveAccountSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const account = await approveAccount(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(account);
});
// ---------------------------------------------------------------------------
// Ledger transactions
// ---------------------------------------------------------------------------
// GET /api/v1/deposits/accounts/:id/transactions — paginated ledger for an
// account (history remains visible after closure — spec §9.1).
depositsRouter.get('/accounts/:id/transactions', authenticate, requirePermission('deposits.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(listTransactionsQuerySchema, request.query);
    const result = await listTransactions(actor, idParam(request), query, requestMeta(request));
    response.status(200).json(result);
});
// POST /api/v1/deposits/accounts/:id/transactions — post a deposit or
// withdrawal to an active account (cashier / manager counters).
depositsRouter.post('/accounts/:id/transactions', authenticate, requirePermission('deposits.write'), validateBody(postTransactionSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const transaction = await postTransaction(actor, idParam(request), input, requestMeta(request));
    response.status(201).json(transaction);
});
// ---------------------------------------------------------------------------
// Adjustments and statements
// ---------------------------------------------------------------------------
// POST /api/v1/deposits/accounts/:id/adjustments — create a compensating
// adjustment entry (M.D. only). The original ledger row is never modified; a
// fresh entry is appended and linked through account_adjustment (spec §9.1).
depositsRouter.post('/accounts/:id/adjustments', authenticate, requireRole('managing_director'), validateBody(createAdjustmentSchema), async (request, response) => {
    const actor = authOf(request);
    const input = request.body;
    const adjustment = await createAdjustment(actor, idParam(request), input, requestMeta(request));
    response.status(201).json(adjustment);
});
// GET /api/v1/deposits/accounts/:id/statements — account statement over a
// from/to window with opening/closing balances (spec §9.3 statements).
depositsRouter.get('/accounts/:id/statements', authenticate, requirePermission('deposits.read'), async (request, response) => {
    const actor = authOf(request);
    const query = parse(statementQuerySchema, request.query);
    const statement = await getStatement(actor, idParam(request), query, requestMeta(request));
    response.status(200).json(statement);
});
