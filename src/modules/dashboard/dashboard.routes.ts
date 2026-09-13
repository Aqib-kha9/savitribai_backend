import { Router } from 'express';
import type { Request } from 'express';
import { authenticate, requirePermission } from '../../middleware/auth.js';
import { parse } from '../../middleware/validate.js';
import { UnauthorizedError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import {
  getAgentPerformanceDashboard,
  getDashboardOverview,
  getDashboardPending,
  getRecentTransactions,
} from './dashboard.service.js';
import type { RequestMeta } from './dashboard.service.js';
import {
  agentPerformanceDashboardQuerySchema,
  dashboardOverviewQuerySchema,
  dashboardPendingQuerySchema,
  recentTransactionsQuerySchema,
} from './dashboard.schemas.js';
import type {
  AgentPerformanceDashboardQuery,
  DashboardOverviewQuery,
  DashboardPendingQuery,
  RecentTransactionsQuery,
} from './dashboard.schemas.js';

/**
 * Dashboard HTTP surface (docs/backend-master-spec.md §23, Module 17).
 *
 * Mounted at /api/v1/dashboard. The dashboard is a read-only aggregation
 * surface available to every authenticated role — collections.read is the only
 * permission held by all seven roles, so it is the universal base gate here.
 * Finer visibility (which pending kinds, whether recent transactions are shown)
 * is resolved inside the service from the caller's role/permissions (decision
 * #7), so a figure is never shown to a role that could not open the underlying
 * list. No audit events are written for dashboard reads (see service header).
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

export const dashboardRouter = Router();

// ---------------------------------------------------------------------------
// Overview (decision #1/#2/#3/#8)
// ---------------------------------------------------------------------------

// GET /api/v1/dashboard/overview — today's collections, active agents,
// averages, pending counts and (for deposit readers) recent transactions.
dashboardRouter.get(
  '/overview',
  authenticate,
  requirePermission('collections.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(dashboardOverviewQuerySchema, request.query) as DashboardOverviewQuery;
    const result = await getDashboardOverview(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Pending work (decision #4/#5/#6)
// ---------------------------------------------------------------------------

// GET /api/v1/dashboard/pending — per-kind counts and the newest items of
// each visible pending kind (optionally narrowed with ?kinds=...).
dashboardRouter.get(
  '/pending',
  authenticate,
  requirePermission('collections.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(dashboardPendingQuerySchema, request.query) as DashboardPendingQuery;
    const result = await getDashboardPending(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Agent performance (decision #12)
// ---------------------------------------------------------------------------

// GET /api/v1/dashboard/performance/agents — per-agent collection aggregation
// over a date window (defaults to today), paginated, with a whole-window
// summary. Collection agents are always scoped to their own record.
dashboardRouter.get(
  '/performance/agents',
  authenticate,
  requirePermission('collections.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(
      agentPerformanceDashboardQuerySchema,
      request.query,
    ) as AgentPerformanceDashboardQuery;
    const result = await getAgentPerformanceDashboard(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);

// ---------------------------------------------------------------------------
// Recent transactions (deposits.read-gated in the service)
// ---------------------------------------------------------------------------

// GET /api/v1/dashboard/transactions/recent — most recent ledger rows,
// newest first. Returns an empty list for roles without deposits.read.
dashboardRouter.get(
  '/transactions/recent',
  authenticate,
  requirePermission('collections.read'),
  async (request, response) => {
    const actor = authOf(request);
    const query = parse(recentTransactionsQuerySchema, request.query) as RecentTransactionsQuery;
    const result = await getRecentTransactions(actor, query, requestMeta(request));
    response.status(200).json(result);
  },
);
