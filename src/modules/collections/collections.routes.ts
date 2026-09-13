import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole, requireSource } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  allocateShortPayment,
  approveEmergencyCollection,
  deleteDuplicateCollection,
  getCollectionStatus,
  getCollectionTotals,
  listCollections,
  recordVisit,
  reviewCollection,
  reverseCollection,
  submitCollection,
} from './collections.service.js';
import type { RequestMeta } from './collections.service.js';
import {
  allocateCollectionSchema,
  collectionTotalsQuerySchema,
  deleteDuplicateSchema,
  emergencyApprovalSchema,
  idempotencyKeySchema,
  idParamSchema,
  listCollectionsQuerySchema,
  reviewCollectionSchema,
  reverseCollectionSchema,
  submitCollectionSchema,
  visitSchema,
} from './collections.schemas.js';
import type {
  AllocateCollectionInput,
  CollectionTotalsQuery,
  DeleteDuplicateInput,
  EmergencyApprovalInput,
  ListCollectionsQuery,
  ReviewCollectionInput,
  ReverseCollectionInput,
  SubmitCollectionInput,
  VisitInput,
} from './collections.schemas.js';

/**
 * Doorstep collections HTTP surface (docs/backend-master-spec.md §14).
 *
 * Mounted at /api/v1/collections. Authority mapping follows spec §14.3:
 *  - POST /                            -> collection_agent on agent_mobile; a
 *    client-generated 32-hex key in the `Idempotency-Key` HTTP header makes
 *    the push replay-safe (201 on first insert, 200 with the ORIGINAL result
 *    on replay)
 *  - GET  /:id/status                  -> collection_agent on agent_mobile
 *    (scoped to the caller's own agent profile)
 *  - POST /visits                      -> collection_agent on agent_mobile
 *    (replay-safe via the same header; 201)
 *  - GET  /                            -> collections.read (office list)
 *  - GET  /reports/collection-totals   -> collections.read (total-amount report)
 *  - POST /emergency-approval          -> managing_director
 *  - POST /:id/review                  -> managing_director
 *  - POST /:id/reverse                 -> managing_director
 *  - POST /:id/delete-duplicate        -> managing_director | manager
 *  - POST /:id/allocate                -> managing_director
 *
 * The two literal paths (/emergency-approval, /reports/collection-totals) are
 * registered BEFORE the /:id parameterised routes so Express never binds them
 * to a collection id.
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

/**
 * The client-generated idempotency key arrives in the HTTP `Idempotency-Key`
 * header (NOT the body — see submitCollectionSchema module doc). Missing or
 * malformed keys are rejected here before the service is called.
 */
function idempotencyKey(request: Request): string {
  return parse(
    idempotencyKeySchema,
    request.get('Idempotency-Key'),
    'Idempotency-Key header is required and must be a 32-character lowercase hexadecimal key',
  );
}

/** Path helper for the /:id routes. */
function idParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

export const collectionsRouter = Router();

// ---------------------------------------------------------------------------
// Agent mobile — collection submission & status surface
// ---------------------------------------------------------------------------

// POST /api/v1/collections — an agent submits one collection (§14.1). The
// entry is created 'waiting' with an issued receipt. 201 when created; 200 with
// the ORIGINAL result when the Idempotency-Key replays an existing submission.
collectionsRouter.post(
  '/',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  validateBody(submitCollectionSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as SubmitCollectionInput;
    const result = await submitCollection(actor, input, idempotencyKey(request), requestMeta(request));
    response.status(result.created ? 201 : 200).json(result);
  },
);

// GET /api/v1/collections/:id/status — the agent's own submission status +
// receipt (§14.3). Scoped to the caller's agent profile in the service, so ids
// cannot be probed across agents.
collectionsRouter.get(
  '/:id/status',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  async (request, response) => {
    const actor = authOf(request);
    const result = await getCollectionStatus(actor, idParam(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/visits — an agent records a customer visit (§14.3). Replay-safe
// via the Idempotency-Key header; always answers 201 on success.
collectionsRouter.post(
  '/visits',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  validateBody(visitSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as VisitInput;
    const result = await recordVisit(actor, input, idempotencyKey(request), requestMeta(request));
    response.status(201).json(result);
  },
);

// ---------------------------------------------------------------------------
// Office browse & reporting
// ---------------------------------------------------------------------------

// GET /api/v1/collections — office collection list with filters. Soft-deleted
// duplicates are hidden unless `isDeleted=true` is explicitly requested.
collectionsRouter.get('/', authenticate, requirePermission('collections.read'), async (request, response) => {
  const query = parse(listCollectionsQuerySchema, request.query) as ListCollectionsQuery;
  const result = await listCollections(query);
  response.status(200).json(result);
});

// GET /api/v1/collections/reports/collection-totals — total-amount collection
// report (§14.4). Literal path registered BEFORE /:id routes.
collectionsRouter.get(
  '/reports/collection-totals',
  authenticate,
  requirePermission('collections.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(collectionTotalsQuerySchema, request.query) as CollectionTotalsQuery;
    const result = await getCollectionTotals(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Managing-director office actions
// ---------------------------------------------------------------------------

// POST /api/v1/collections/emergency-approval — M.D. approves a collection from
// an unassigned customer; the entry is created directly in 'accepted' state
// (§14.1). Literal path registered BEFORE /:id routes.
collectionsRouter.post(
  '/emergency-approval',
  authenticate,
  requireRole('managing_director'),
  validateBody(emergencyApprovalSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as EmergencyApprovalInput;
    const collection = await approveEmergencyCollection(actor, input, requestMeta(request));
    response.status(201).json(collection);
  },
);

// POST /api/v1/collections/:id/review — M.D. accepts / rejects / escalates a
// waiting submission (spec §14.5).
collectionsRouter.post(
  '/:id/review',
  authenticate,
  requireRole('managing_director'),
  validateBody(reviewCollectionSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as ReviewCollectionInput;
    const collection = await reviewCollection(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(collection);
  },
);

// POST /api/v1/collections/:id/reverse — M.D. reverses a disputed collection
// (reversal + corrected replacement entry, never a direct edit — spec §14.5).
collectionsRouter.post(
  '/:id/reverse',
  authenticate,
  requireRole('managing_director'),
  validateBody(reverseCollectionSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as ReverseCollectionInput;
    const reversal = await reverseCollection(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(reversal);
  },
);

// POST /api/v1/collections/:id/delete-duplicate — M.D. or manager soft-deletes
// a duplicate entry (is_deleted=true); accepted collections must instead be
// reversed. Only the entry is deleted — its receipt is never removed.
collectionsRouter.post(
  '/:id/delete-duplicate',
  authenticate,
  requireRole('managing_director', 'manager'),
  validateBody(deleteDuplicateSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as DeleteDuplicateInput;
    const collection = await deleteDuplicateCollection(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(collection);
  },
);

// POST /api/v1/collections/:id/allocate — M.D. decides how a short-paid
// collection is allocated across principal / interest / penalty / fees buckets
// (§14.1).
collectionsRouter.post(
  '/:id/allocate',
  authenticate,
  requireRole('managing_director'),
  validateBody(allocateCollectionSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as AllocateCollectionInput;
    const collection = await allocateShortPayment(actor, idParam(request), input, requestMeta(request));
    response.status(200).json(collection);
  },
);
