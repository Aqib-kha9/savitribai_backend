import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission, requireRole, requireSource } from '../../middleware/auth.js';
import { parse, validateBody } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  listAgents,
  getAgent,
  onboardAgent,
  updateAgent,
  activateAgent,
  suspendAgent,
  reactivateAgent,
  deactivateAgent,
  assignCustomers,
  requestRouteExchange,
  approveOutOfArea,
  disableAgentDevice,
  getAgentPerformance,
  getMyAssignments,
  getMyDayTotals,
  submitDayClose,
  recordFieldVerification,
} from './agents.service.js';
import type { RequestMeta } from './agents.service.js';
import {
  listAgentsQuerySchema,
  onboardAgentSchema,
  updateAgentSchema,
  assignmentSchema,
  routeExchangeSchema,
  outOfAreaApprovalSchema,
  disableDeviceSchema,
  performanceQuerySchema,
  dayTotalsQuerySchema,
  dayCloseSchema,
  fieldVerificationSchema,
  idParamSchema,
  agentDeviceIdParamSchema,
} from './agents.schemas.js';
import type {
  ListAgentsQuery,
  OnboardAgentInput,
  UpdateAgentInput,
  AssignmentInput,
  RouteExchangeInput,
  OutOfAreaApprovalInput,
  DisableDeviceInput,
  PerformanceQuery,
  DayTotalsQuery,
  DayCloseInput,
  FieldVerificationInput,
} from './agents.schemas.js';

/**
 * Collection agents HTTP surface (docs/backend-master-spec.md §15, Module 9).
 *
 * Mounted at /api/v1/agents — this router owns the whole /agents prefix.
 * Authority mapping follows spec §15.3 + §14.4:
 *  - self-service /me/* endpoints      -> collection_agent role, agent_mobile source
 *  - list / get / performance          -> agents.read permission
 *  - onboard + lifecycle + assignments -> managing_director role
 *  - route-exchange (approve), out-of-area approval, device disable
 *                                       -> managing_director role
 *
 * Self-service endpoints are registered BEFORE the /:id routes so that the
 * literal `me` segment is never captured as an agent id by Express.
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

/** Agent id path parameter helper for the /:id routes. */
function idParam(request: Request): string {
  return parse(idParamSchema, request.params).id;
}

/** Path helpers for POST /agents/:id/devices/:deviceId/disable. */
function agentIdParam(request: Request): string {
  return parse(agentDeviceIdParamSchema, request.params).id;
}

function deviceIdParam(request: Request): string {
  return parse(agentDeviceIdParamSchema, request.params).deviceId;
}

export const agentsRouter = Router();

// ---------------------------------------------------------------------------
// Self-service (spec §14.4 — signed-in collection agent, agent_mobile only)
// ---------------------------------------------------------------------------

// GET /api/v1/agents/me/assignments — the agent's active assigned customers.
agentsRouter.get(
  '/me/assignments',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  async (request, response) => {
    const actor = authOf(request);
    const result = await getMyAssignments(actor, requestMeta(request));
    response.status(200).json(result);
  },
);

// GET /api/v1/agents/me/day-totals — today's collection totals (spec §16.3).
agentsRouter.get(
  '/me/day-totals',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(dayTotalsQuerySchema, request.query) as DayTotalsQuery;
    const result = await getMyDayTotals(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// POST /api/v1/agents/me/day-close — submit the day close (spec §16.3/§16.5).
// Server enforces the 17:00 IST deadline and that every entry for the day has
// been submitted; totals are snapshotted onto day_close.
agentsRouter.post(
  '/me/day-close',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  validateBody(dayCloseSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as DayCloseInput;
    const result = await submitDayClose(actor, input, requestMeta(request));
    response.status(201).json(result);
  },
);

// POST /api/v1/agents/me/field-verifications — record the physical field
// verification of an active customer's address (spec §8.1 — address proof is
// verified in person by the collection field agent). 201 on success.
agentsRouter.post(
  '/me/field-verifications',
  authenticate,
  requireRole('collection_agent'),
  requireSource('agent_mobile'),
  validateBody(fieldVerificationSchema),
  async (request, response) => {
    const actor = authOf(request);
    const input = request.body as FieldVerificationInput;
    const result = await recordFieldVerification(actor, input, requestMeta(request));
    response.status(201).json(result);
  },
);

// ---------------------------------------------------------------------------
// Agent directory
// ---------------------------------------------------------------------------

// GET /api/v1/agents — list agents with optional status/branch/search filters.
agentsRouter.get('/', authenticate, requirePermission('agents.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(listAgentsQuerySchema, request.query) as ListAgentsQuery;
  const result = await listAgents(actor, query, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/agents — onboard a collection agent (spec §15.1). The staff
// member must hold the collection_agent role; ID/address proof is mandatory.
agentsRouter.post('/', authenticate, requireRole('managing_director'), validateBody(onboardAgentSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as OnboardAgentInput;
  const agent = await onboardAgent(actor, input, requestMeta(request));
  response.status(201).json(agent);
});

// ---------------------------------------------------------------------------
// Agent detail + lifecycle (spec §15.1/§15.3)
// ---------------------------------------------------------------------------

// GET /api/v1/agents/:id — single agent detail.
agentsRouter.get('/:id', authenticate, requirePermission('agents.read'), async (request, response) => {
  const actor = authOf(request);
  const agent = await getAgent(actor, idParam(request), requestMeta(request));
  response.status(200).json(agent);
});

// PATCH /api/v1/agents/:id — update agent profile details (no status changes).
agentsRouter.patch('/:id', authenticate, requireRole('managing_director'), validateBody(updateAgentSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as UpdateAgentInput;
  const agent = await updateAgent(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(agent);
});

// POST /api/v1/agents/:id/activate — activate a pending/suspended agent.
agentsRouter.post('/:id/activate', authenticate, requireRole('managing_director'), async (request, response) => {
  const actor = authOf(request);
  const agent = await activateAgent(actor, idParam(request), requestMeta(request));
  response.status(200).json(agent);
});

// POST /api/v1/agents/:id/suspend — suspend an active agent.
agentsRouter.post('/:id/suspend', authenticate, requireRole('managing_director'), async (request, response) => {
  const actor = authOf(request);
  const agent = await suspendAgent(actor, idParam(request), requestMeta(request));
  response.status(200).json(agent);
});

// POST /api/v1/agents/:id/reactivate — reactivate a suspended agent.
agentsRouter.post('/:id/reactivate', authenticate, requireRole('managing_director'), async (request, response) => {
  const actor = authOf(request);
  const agent = await reactivateAgent(actor, idParam(request), requestMeta(request));
  response.status(200).json(agent);
});

// POST /api/v1/agents/:id/deactivate — deactivate an agent. Active customer
// assignments are closed so the customers can be reassigned.
agentsRouter.post('/:id/deactivate', authenticate, requireRole('managing_director'), async (request, response) => {
  const actor = authOf(request);
  const agent = await deactivateAgent(actor, idParam(request), requestMeta(request));
  response.status(200).json(agent);
});

// ---------------------------------------------------------------------------
// Assignments + route exchange + approvals (spec §15.1/§15.4)
// ---------------------------------------------------------------------------

// POST /api/v1/agents/:id/assignments — assign (or re-assign) customers.
agentsRouter.post('/:id/assignments', authenticate, requireRole('managing_director'), validateBody(assignmentSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as AssignmentInput;
  const result = await assignCustomers(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/agents/:id/route-exchange — M.D. approves a route exchange that
// transfers the agent's customers (and optionally route) to another agent.
agentsRouter.post('/:id/route-exchange', authenticate, requireRole('managing_director'), validateBody(routeExchangeSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as RouteExchangeInput;
  const exchange = await requestRouteExchange(actor, idParam(request), input, requestMeta(request));
  response.status(201).json(exchange);
});

// POST /api/v1/agents/:id/out-of-area-approval — M.D. approves emergency
// collections outside the agent's normal area (spec §14.1). Recorded as an
// audit event (no dedicated table exists); the agent device gets the approval.
agentsRouter.post('/:id/out-of-area-approval', authenticate, requireRole('managing_director'), validateBody(outOfAreaApprovalSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as OutOfAreaApprovalInput;
  const result = await approveOutOfArea(actor, idParam(request), input, requestMeta(request));
  response.status(200).json(result);
});

// POST /api/v1/agents/:id/devices/:deviceId/disable — disable a lost/stolen
// device and revoke its live sessions immediately (spec §15.1).
agentsRouter.post('/:id/devices/:deviceId/disable', authenticate, requireRole('managing_director'), validateBody(disableDeviceSchema), async (request, response) => {
  const actor = authOf(request);
  const input = request.body as DisableDeviceInput;
  const result = await disableAgentDevice(
    actor,
    agentIdParam(request),
    deviceIdParam(request),
    input,
    requestMeta(request),
  );
  response.status(200).json(result);
});

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

// GET /api/v1/agents/:id/performance — per-day collection performance.
agentsRouter.get('/:id/performance', authenticate, requirePermission('agents.read'), async (request, response) => {
  const actor = authOf(request);
  const query = parse(performanceQuerySchema, request.query) as PerformanceQuery;
  const result = await getAgentPerformance(actor, idParam(request), query, requestMeta(request));
  response.status(200).json(result);
});
