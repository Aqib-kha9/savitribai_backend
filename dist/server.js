import 'dotenv/config';
import express from 'express';
import compression from 'compression';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { corsOptions } from './config/cors.js';
import { requestId } from './middleware/request-id.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { apiRateLimiter } from './middleware/rate-limiter.js';
import { healthRouter } from './modules/health/health.routes.js';
import { authRouter, identityRouter } from './modules/identity/identity.routes.js';
import { syncRouter } from './modules/sync/sync.routes.js';
import { customersRouter } from './modules/customers/customers.routes.js';
import { depositsRouter } from './modules/deposits/deposits.routes.js';
import { rdRouter } from './modules/rd/rd.routes.js';
import { fdRouter } from './modules/fd/fd.routes.js';
import { loansRouter } from './modules/loans/loans.routes.js';
import { withdrawalsRouter } from './modules/withdrawals/withdrawals.routes.js';
import { agentsRouter } from './modules/agents/agents.routes.js';
import { collectionsRouter } from './modules/collections/collections.routes.js';
import { reconciliationRouter } from './modules/reconciliation/reconciliation.routes.js';
import { reportsRouter } from './modules/reports/reports.routes.js';
import { auditRouter } from './modules/audit/audit.routes.js';
import { notificationsRouter } from './modules/notifications/notifications.routes.js';
import { scheduleEODJobs } from './core/jobs/scheduler.js';
import { settingsRouter } from './modules/settings/settings.routes.js';
import { dashboardRouter } from './modules/dashboard/dashboard.routes.js';
import { query } from './database/client.js';
const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(cors(corsOptions));
app.use(compression());
// Request correlation id must be assigned before body parsing so even parse
// failures carry a requestId in the error envelope.
app.use(requestId);
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: false, limit: '50kb' }));
// Liveness/health endpoints are exempt so probes are never throttled.
app.get('/live', (_request, response) => response.status(200).json({ status: 'ok' }));
app.use('/api/v1/health', healthRouter);
// Global per-IP rate limiting for all API traffic (spec §28.10).
app.use('/api/v1', apiRateLimiter);
// Identity & access management (spec §7) — auth (session/token/device registry)
// and staff/role administration. Both mount under the shared API rate limiter.
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/identity', identityRouter);
// Offline sync & mobile support (spec §20) — agent-facing submission status
// surface, per-agent sync summary, and device conflict escalation. Push/pull
// endpoints live with their owning modules (collections / agents).
app.use('/api/v1/sync', syncRouter);
// Customer registry (spec §8) — profile CRUD, status, transfer, KYC approval,
// nominee, consents, complaints, duplicate merge, death notification, documents.
app.use('/api/v1/customers', customersRouter);
// Deposits / savings (spec §9) — deposit products, savings accounts (open /
// edit / freeze / close / reopen / approve), ledger postings, adjustments,
// statements.
app.use('/api/v1/deposits', depositsRouter);
// Recurring deposits (spec §10) — RD schemes, accounts (open / schedule /
// instalment payments / penalty waiver / reschedule / close early /
// surplus-transfer / approvals).
app.use('/api/v1/rd', rdRouter);
// Fixed deposits (spec §11) — FD rate cards, accounts (open / lien / close
// early / maturity action / loan against FD / history).
app.use('/api/v1/fd', fdRouter);
// Loans (spec §12) — products, applications (apply / recommend / approve),
// disburse, schedule, repayments, corrections, reschedule, settle, write-off,
// transfer, waiver, surplus-release, statements.
app.use('/api/v1/loans', loansRouter);
// Withdrawals (spec §13) — request, approve, reject, pay, confirm, change,
// history. High-value (> ₹2,00,000) approvals route to the President.
app.use('/api/v1/withdrawals', withdrawalsRouter);
// Agents (spec §15) — onboarding, status, assignments, route exchange,
// out-of-area approval, devices, performance.
app.use('/api/v1/agents', agentsRouter);
// Collections (spec §14) — idempotent submission from the agent mobile app,
// status, visits, review, reversal, duplicate deletion, allocation,
// emergency approvals, reports.
app.use('/api/v1/collections', collectionsRouter);
// Reconciliation (spec §16) — day close, cash handover, denominations,
// counting, digital settlement, differences, reopen / lock / escalate.
app.use('/api/v1/reconciliation', reconciliationRouter);
// Reports (spec §17) — catalogue, generate, download, share, customer
// statements.
app.use('/api/v1/reports', reportsRouter);
// Audit trail (spec §21) — append-only; M.D.-only query surface.
app.use('/api/v1/audit', auditRouter);
// Notifications (spec §18) — templates, outbox, delivery logs, retry and
// cancel actions, and the internal enqueue surface used by other modules.
app.use('/api/v1/notifications', notificationsRouter);
// Settings (spec §22) — organisation profile, branches, holidays, app
// settings and their change history.
app.use('/api/v1/settings', settingsRouter);
// Dashboard (spec §23) — read-only aggregation: today's overview, pending
// work, per-agent performance and recent transactions (role-scoped).
app.use('/api/v1/dashboard', dashboardRouter);
app.use(notFoundHandler);
app.use(errorHandler);
async function runSelfHealingMigrations() {
    try {
        await query(`
      UPDATE number_sequence 
         SET reset_period = 'never' 
       WHERE entity_type LIKE 'receipt_%';
    `);
        const sequences = [
            { type: 'receipt_loan', prefix: 'RCPT-LN' },
            { type: 'receipt_rd', prefix: 'RCPT-RD' },
            { type: 'receipt_dd', prefix: 'RCPT-DD' },
            { type: 'receipt_sb', prefix: 'RCPT-SB' },
            { type: 'receipt_daily', prefix: 'RCPT-D' },
            { type: 'receipt_monthly', prefix: 'RCPT-M' },
        ];
        for (const seq of sequences) {
            const res = await query(`SELECT MAX(SUBSTRING(receipt_number FROM '[0-9]+')::BIGINT) as max_val
           FROM collection_receipt
          WHERE receipt_number LIKE $1`, [`${seq.prefix}%`]);
            const maxVal = res.rows[0]?.max_val ? Number(res.rows[0].max_val) : 0;
            if (maxVal > 0) {
                await query(`UPDATE number_sequence
              SET next_value = GREATEST(next_value, $1 + 1)
            WHERE entity_type = $2`, [maxVal, seq.type]);
            }
        }
        // Ensure savings_account number sequence uses prefix SBA
        await query(`
      UPDATE number_sequence
         SET prefix = 'SBA'
       WHERE entity_type = 'savings_account';
    `);
        // Rename SAV-DLY product to avoid confusion with Daily Deposit (DD)
        await query(`
      UPDATE deposit_product
         SET name = 'Doorstep Bachat Khata (Doorstep Savings)',
             description = 'Doorstep collection savings account for daily/regular-income customers'
       WHERE code = 'SAV-DLY';
    `);
        // Convert any savings accounts created under SAV-STD or SAV-DLY that were mistakenly assigned DDA numbers
        await query(`
      UPDATE savings_account
         SET account_number = REPLACE(account_number, 'DDA', 'SBA'),
             maturity_date = NULL
       WHERE product_id IN (SELECT id FROM deposit_product WHERE code IN ('SAV-STD', 'SAV-DLY'))
         AND account_number LIKE 'DDA%';
    `);
        await query(`
      UPDATE collection_receipt
         SET account_number = REPLACE(account_number, 'DDA', 'SBA')
       WHERE account_number LIKE 'DDA%'
         AND collection_id IN (
           SELECT ce.id FROM collection_entry ce
            JOIN savings_account sa ON sa.id = ce.savings_account_id
            JOIN deposit_product dp ON dp.id = sa.product_id
           WHERE dp.code IN ('SAV-STD', 'SAV-DLY')
         );
    `);
        console.log('Self-healing migrations: receipt sequences & savings accounts configured and synced.');
    }
    catch (err) {
        console.warn('Self-healing migration notice:', err);
    }
}
app.listen(env.port, async () => {
    console.log(`API listening on port ${env.port}`);
    // Self-heal sequence monotonicity and collision resilience
    await runSelfHealingMigrations();
    // Initialize BullMQ EOD schedules
    if (env.isProduction || env.nodeEnv === 'development') {
        await scheduleEODJobs();
    }
});
export { app };
