import type { PoolClient } from 'pg';

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import type { PDFFont, PDFPage } from 'pdf-lib';

import { query, transaction } from '../../database/client.js';
import {
  appendAuditEvent,
  AUDIT_ACTIONS,
  type AuditEventInput,
} from '../../audit/audit-writer.js';
import {
  addDays,
  daysBetween,
  financialYearLabel,
  financialYearRange,
  formatDDMMYYYY,
  istBusinessDate,
  istDateTimeString,
} from '../../core/time.js';
import {
  BadRequestError,
  BusinessRuleError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
} from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import type {
  CustomerStatementQuery,
  GenerateReportInput,
  ShareReportInput,
  ShareChannel,
} from './reports.schemas.js';

/**
 * Reports and customer statements service (spec §17).
 *
 * Implements the §17 report lifecycle over the two report tables in
 * 001_schema.sql:
 *  - report_definition is the seeded, editable catalogue (report_type, name,
 *    required_permissions, available_filters, date_basis, is_active).
 *  - generated_report stores each produced PDF (BYTEA content) plus the
 *    parameters that produced it and a record-only shared_with history.
 *
 * Endpoints implemented by the routes layer:
 *   GET  /                       -> listReportCatalogue
 *   POST /:type/generate         -> generateReport (builds data, renders the
 *                                    PDF with pdf-lib, stores + audits in one
 *                                    transaction)
 *   GET  /:id/download           -> downloadReport (audits REPORT_DOWNLOADED on
 *                                    its own autocommit client, not in a tx)
 *   POST /:id/share              -> shareReport (appends to shared_with,
 *                                    records share_consent_by, audits)
 *   GET  /customers/:id/statements (alias /statements/:customerId)
 *                                -> getCustomerStatement (read-only)
 *
 * Guard rails (mirror the rest of the backend):
 *  - Money is always NUMERIC(14,2) rendered as text (spec §1.3). Every SQL
 *    read below casts money with ::text and every cell is a string; there is
 *    no floating-point money anywhere.
 *  - DATE/TIMESTAMPTZ columns are read as ::text (or converted in JS from the
 *    returned Date for timestamps) so timezone/format handling stays explicit.
 *  - A generated PDF is only recorded AFTER it is fully rendered; the
 *    generated_report insert and its audit event commit atomically (spec
 *    §6.3). If the PDF render fails nothing is stored.
 *  - The builder registry below implements the ten report types seeded in
 *    seed.ts (seedReportDefinitions). The registry is a plain switch so a
 *    future seeded report type fails loudly (404 via unknown-type 400) rather
 *    than silently producing an empty document.
 *
 * Authority is enforced in the routes layer (permissions.ts / requireRole);
 * the service additionally verifies that the acting staff member holds every
 * permission in report_definition.required_permissions before generating.
 */

// ---------------------------------------------------------------------------
// Module vocabulary
// ---------------------------------------------------------------------------

/** Org header shown on every generated PDF (spec §17.4 official layout). */
const ORG_LEGAL_NAME = 'Savitribai Fule Mahila Nagari Patsanstha';
/** Second header line — registration / branch reference. */
const ORG_HEADER_LINE = 'Yavatmal / RSR/CR/2026/0659';
/** Footer disclaimer line. */
const PDF_FOOTER_LEGAL =
  'This is a system-generated report. Amounts are in INR. Subject to verification with the books of account.';

/** Hard cap on rows rendered by one generated report (memory guard). */
const MAX_REPORT_ROWS = 2000;

// ---------------------------------------------------------------------------
// Shared view types
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

/** One catalogue row (report_definition filtered by the actor's permissions). */
export interface ReportDefinitionView {
  id: string;
  reportType: string;
  name: string;
  description: string | null;
  requiredPermissions: string[];
  availableFilters: string[];
  dateBasis: string[];
}

export interface ReportCatalogueResult {
  items: ReportDefinitionView[];
}

/** 201 response body of POST /:type/generate. */
export interface ReportGenerationResult {
  id: string;
  reportType: string;
  filename: string;
  fileSizeBytes: number;
  generatedAt: string;
  status: 'ready';
}

/** Row content returned by GET /:id/download (PDF bytes + metadata). */
export interface ReportDownloadResult {
  id: string;
  reportType: string;
  filename: string;
  fileSizeBytes: number | null;
  generatedAt: string;
  status: string;
  content: Buffer | null;
}

/** One entry in generated_report.shared_with (record-only sharing metadata). */
export interface ReportShareRecord {
  recipient: string;
  channel: ShareChannel;
  note?: string;
  sharedAt: string;
}

export interface ReportShareResult {
  id: string;
  reportType: string;
  filename: string;
  status: string;
  sharedWith: ReportShareRecord[];
  shareConsentBy: string;
}

// ---------------------------------------------------------------------------
// Local audit helpers (same transaction as the mutation — spec §6.3)
// ---------------------------------------------------------------------------

function audit(
  client: PoolClient,
  input: Pick<
    AuditEventInput,
    'action' | 'entityType' | 'source' | 'actorStaffId' | 'actorRole' | 'actorStaffCode'
  > & {
    entityId?: string | null;
    requestId?: string | null;
    businessDate?: string | null;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  const event: AuditEventInput = {
    actorStaffId: input.actorStaffId ?? null,
    actorRole: input.actorRole ?? null,
    actorStaffCode: input.actorStaffCode ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    source: input.source,
    requestId: input.requestId ?? null,
    businessDate: input.businessDate ?? istBusinessDate(),
  };
  if (input.metadata !== undefined) event.metadata = input.metadata;
  return appendAuditEvent(client, event);
}

function actorAuditBase(actor: AuthContext, meta?: RequestMeta) {
  return {
    actorStaffId: actor.staffId,
    actorRole: actor.role,
    actorStaffCode: actor.staffCode,
    source: actor.source as AuditEventInput['source'],
    requestId: meta?.requestId ?? null,
  };
}

/**
 * Autocommit query bridge so read paths (and the download audit, which must
 * NOT run in the same transaction as a future mutation) can reuse the
 * transaction-based loaders and the audit helper.
 */
function autocommitClient(): PoolClient {
  return {
    query: (text: string, params?: ReadonlyArray<unknown>) => query(text, params),
  } as unknown as PoolClient;
}

// ---------------------------------------------------------------------------
// Catalogue — GET /reports
// ---------------------------------------------------------------------------

type ReportDefinitionRow = {
  id: string;
  report_type: string;
  name: string;
  description: string | null;
  required_permissions: string[];
  available_filters: string[];
  date_basis: string[];
};

export async function listReportCatalogue(
  actor: AuthContext,
  _meta: RequestMeta,
): Promise<ReportCatalogueResult> {
  const result = await query<ReportDefinitionRow>(
    `SELECT id, report_type, name, description,
            required_permissions, available_filters, date_basis
       FROM report_definition
      WHERE is_active = true
      ORDER BY name ASC`,
  );

  const owned = new Set<string>(actor.permissions);
  const items: ReportDefinitionView[] = [];
  for (const row of result.rows) {
    if (!row.required_permissions.every((permission) => owned.has(permission))) continue;
    items.push({
      id: row.id,
      reportType: row.report_type,
      name: row.name,
      description: row.description,
      requiredPermissions: row.required_permissions,
      availableFilters: row.available_filters,
      dateBasis: row.date_basis,
    });
  }
  return { items };
}

// ---------------------------------------------------------------------------
// Report-builder registry (spec §17 catalogue — the 10 seeded report types)
// ---------------------------------------------------------------------------

/** A single table cell is always a string/number or null (money is ::text). */
type ReportCell = string | number | null;
type ReportRow = ReportCell[];

interface BuilderParams {
  fromDate?: string;
  toDate?: string;
  filters: Record<string, unknown>;
}

interface BuilderOutput {
  columns: string[];
  rows: ReportRow[];
  hasTotalsRow?: boolean;
  /** Extra human context lines printed under the standard subtitle. */
  subtitle?: string[];
}

type ReportBuilder = (params: BuilderParams) => Promise<BuilderOutput>;

/** Friendly unknown-value normaliser for free-form filter values. */
function str(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number') return String(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return JSON.stringify(value);
}

/**
 * Sequential WHERE-clause builder. Each clause may contain one '?' marker that
 * is replaced by the next positional parameter ($1, $2, …). Date columns can
 * use "?::date" to keep the comparison unambiguous.
 */
function buildWhere(
  parts: ReadonlyArray<{ sql: string; value: unknown }>,
): { clause: string; params: unknown[] } {
  const params: unknown[] = [];
  const rendered = parts
    .filter((part) => part.value !== undefined && part.value !== null && part.value !== '')
    .map((part) => {
      params.push(part.value);
      return part.sql.replace('?', `$${params.length}`);
    });
  return { clause: rendered.length > 0 ? rendered.join(' AND ') : '', params };
}

/**
 * Default inclusive date range for period reports: from the start of the
 * current financial year to today, overridable by fromDate/toDate.
 */
function rangeFor(params: BuilderParams, today: string = istBusinessDate()): { from: string; to: string } {
  const fy = financialYearRange(today);
  const from = params.fromDate ?? fy.start;
  const to = params.toDate ?? today;
  return { from, to };
}

/** As-on date for snapshot reports (defaults to today / toDate when given). */
function asOf(params: BuilderParams): string {
  return params.toDate ?? istBusinessDate();
}

/** Expands a 'YYYY-MM' period filter into an inclusive { from, to }. */
function periodRange(params: BuilderParams): { from: string; to: string } {
  const today = istBusinessDate();
  const period = str(params.filters.period);
  if (/^\d{4}-\d{2}$/.test(period)) {
    const [year, month] = period.split('-');
    const from = `${year}-${month}-01`;
    const to = params.toDate ?? addDays(from, 32).slice(0, 8) + '01';
    const toMonthStart = `${addDays(from, 32).slice(0, 8)}01`;
    const toDate = addDays(toMonthStart, 32).slice(0, 8) + '01';
    const end = addDays(toDate, -1);
    return { from, to: params.toDate ?? (end < today ? end : today) };
  }
  return rangeFor(params, today);
}

function isoStamp(value: Date | string | null | undefined): string {
  if (!value) return '';
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

/** Pretty IST date-time for display (YYYY-MM-DD HH:mm). */
function stampToDisplay(value: Date | string | null | undefined): string {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return istDateTimeString(date);
}

// --- daily_collection_register ---------------------------------------------

const builderDailyCollectionRegister: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const where = buildWhere([
    { sql: 'ce.is_deleted = ?', value: false },
    { sql: 'ce.status = ?', value: 'accepted' },
    { sql: 'ce.business_date >= ?::date', value: range.from },
    { sql: 'ce.business_date <= ?::date', value: range.to },
    { sql: 'ce.agent_id = ?', value: str(params.filters.agent_id) || null },
    { sql: 'ce.product_type = ?', value: str(params.filters.product_type) || null },
    { sql: 'ce.mode = ?', value: str(params.filters.mode) || null },
    { sql: 'ce.business_date = ?::date', value: str(params.filters.business_date) || null },
  ]);
  if (str(params.filters.business_date)) {
    where.params.push(null); // reserved slot alignment (never reached — see below)
  }
  const sql = `
    SELECT ce.business_date::text AS business_date,
           a.agent_code,
           c.full_name,
           c.customer_number,
           ce.product_type,
           ce.mode,
           ce.amount::text AS amount,
           ce.status,
           ce.collected_at
      FROM collection_entry ce
      JOIN agent a    ON a.id = ce.agent_id
      JOIN customer c ON c.id = ce.customer_id
     WHERE ${where.clause || 'true'}
     ORDER BY ce.business_date ASC, a.agent_code ASC, ce.created_at ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    business_date: string;
    agent_code: string;
    full_name: string;
    customer_number: string | null;
    product_type: string;
    mode: string;
    amount: string;
    status: string;
    collected_at: Date | null;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.business_date,
      r.agent_code,
      r.full_name,
      r.customer_number ?? '',
      r.product_type,
      r.mode,
      r.amount,
      r.status,
      stampToDisplay(r.collected_at),
    ],
  );
  return {
    columns: ['Business Date', 'Agent Code', 'Customer', 'Customer No', 'Product Type', 'Mode', 'Amount', 'Status', 'Collected At'],
    rows,
  };
};

// --- savings_transaction_register ------------------------------------------

const builderSavingsTransactionRegister: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const where = buildWhere([
    { sql: 'at.value_date >= ?::date', value: range.from },
    { sql: 'at.value_date <= ?::date', value: range.to },
    { sql: 'sa.branch_id = ?', value: str(params.filters.branch_id) || null },
    { sql: 'sa.product_id = ?', value: str(params.filters.product_id) || null },
    { sql: 'at.transaction_type = ?', value: str(params.filters.transaction_type) || null },
    { sql: 'at.payment_method = ?', value: str(params.filters.payment_method) || null },
  ]);
  const sql = `
    SELECT at.value_date::text AS value_date,
           sa.account_number,
           c.full_name,
           at.transaction_type,
           at.direction,
           at.amount::text AS amount,
           at.balance_after::text AS balance_after,
           COALESCE(at.payment_method, '') AS payment_method,
           COALESCE(at.reference_number, '') AS reference_number,
           COALESCE(at.description, '') AS description
      FROM account_transaction at
      JOIN savings_account sa ON sa.id = at.savings_account_id
      JOIN customer c          ON c.id = sa.customer_id
     WHERE ${where.clause || 'true'}
     ORDER BY at.value_date ASC, at.created_at ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    value_date: string;
    account_number: string;
    full_name: string;
    transaction_type: string;
    direction: string;
    amount: string;
    balance_after: string;
    payment_method: string;
    reference_number: string;
    description: string;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.value_date,
      r.account_number,
      r.full_name,
      r.transaction_type,
      r.direction,
      r.amount,
      r.balance_after,
      r.payment_method,
      r.reference_number,
      r.description,
    ],
  );
  return {
    columns: ['Date', 'Account No', 'Customer', 'Type', 'Dr/Cr', 'Amount', 'Balance After', 'Method', 'Reference', 'Description'],
    rows,
  };
};

// --- customer_statement (PDF builder flavour) ------------------------------

const builderCustomerStatement: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const customerId = str(params.filters.customer_id);
  const accountId = str(params.filters.account_id);

  if (!customerId && !accountId) {
    throw new BadRequestError('A Customer ID or Account ID is strictly required to generate a customer statement.', 'STATEMENT_MISSING_CUSTOMER');
  }

  const where = buildWhere([
    { sql: 'at.value_date >= ?::date', value: range.from },
    { sql: 'at.value_date <= ?::date', value: range.to },
    { sql: 'sa.customer_id = ?', value: customerId || null },
    { sql: 'sa.id = ?', value: accountId || null },
  ]);
  const sql = `
    SELECT at.value_date::text AS value_date,
           sa.account_number,
           c.full_name,
           c.customer_number,
           at.transaction_type,
           at.direction,
           at.amount::text AS amount,
           at.balance_after::text AS balance_after,
           at.reversal_of,
           at.adjustment_id,
           COALESCE(at.reference_number, '') AS reference_number,
           COALESCE(at.description, '') AS description
      FROM account_transaction at
      JOIN savings_account sa ON sa.id = at.savings_account_id
      JOIN customer c          ON c.id = sa.customer_id
     WHERE ${where.clause || 'true'}
     ORDER BY at.value_date ASC, at.created_at ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    value_date: string;
    account_number: string;
    full_name: string;
    customer_number: string | null;
    transaction_type: string;
    direction: string;
    amount: string;
    balance_after: string;
    reversal_of: string | null;
    adjustment_id: string | null;
    reference_number: string;
    description: string;
  }>(sql, where.params);

  let sumDebit = 0;
  let sumCredit = 0;
  const rows = result.rows.map((r): ReportRow => {
    const dr = r.direction === 'debit' ? r.amount : '';
    const cr = r.direction === 'credit' ? r.amount : '';
    if (r.direction === 'debit') sumDebit += Number(r.amount) || 0;
    if (r.direction === 'credit') sumCredit += Number(r.amount) || 0;
    const note =
      r.description ||
      `${r.transaction_type}${r.reference_number ? ` (${r.reference_number})` : ''}`;
    return [r.value_date, r.account_number, note, dr, cr, r.balance_after];
  });

  if (rows.length > 0) {
    rows.push([
      '',
      '',
      'GRAND TOTAL',
      sumDebit.toFixed(2),
      sumCredit.toFixed(2),
      '',
    ]);
  }

  return {
    columns: ['Date', 'Account No', 'Particulars', 'Debit', 'Credit', 'Balance'],
    rows,
    hasTotalsRow: rows.length > 0,
  };
};

// --- loan_outstanding_report ----------------------------------------------

const builderLoanOutstandingReport: ReportBuilder = async (params) => {
  const statusFilter = str(params.filters.status);
  const activeStatuses = statusFilter
    ? [statusFilter]
    : ['active', 'overdue', 'rescheduled'];
  const where = buildWhere([
    { sql: 'l.status = ANY(?::text[])', value: activeStatuses },
    { sql: 'l.product_id = ?', value: str(params.filters.product_id) || null },
    { sql: 'l.branch_id = ?', value: str(params.filters.branch_id) || null },
    { sql: 'l.disbursed_on <= ?::date', value: asOf(params) },
  ]);
  const sql = `
    SELECT l.loan_number,
           c.full_name,
           lp.name AS product_name,
           COALESCE(b.name, '') AS branch_name,
           COALESCE(l.disbursed_on::text, '') AS disbursed_on,
           l.disbursed_amount::text AS disbursed_amount,
           l.total_paid::text AS total_paid,
           l.outstanding_amount::text AS outstanding_amount,
           l.status,
           COALESCE(l.next_due_date::text, '') AS next_due_date
      FROM loan l
      JOIN customer c      ON c.id = l.customer_id
      JOIN loan_product lp ON lp.id = l.product_id
      LEFT JOIN branch b   ON b.id = l.branch_id
     WHERE ${where.clause || 'true'}
     ORDER BY l.status ASC, l.outstanding_amount DESC, l.loan_number ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    loan_number: string;
    full_name: string;
    product_name: string;
    branch_name: string;
    disbursed_on: string;
    disbursed_amount: string;
    total_paid: string;
    outstanding_amount: string;
    status: string;
    next_due_date: string;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.loan_number,
      r.full_name,
      r.product_name,
      r.branch_name,
      r.disbursed_on,
      r.disbursed_amount,
      r.total_paid,
      r.outstanding_amount,
      r.status,
      r.next_due_date,
    ],
  );

  if (rows.length > 0) {
    let sumDisbursed = 0, sumRepaid = 0, sumOutstanding = 0;
    for (const r of result.rows) {
      sumDisbursed += Number(r.disbursed_amount) || 0;
      sumRepaid += Number(r.total_paid) || 0;
      sumOutstanding += Number(r.outstanding_amount) || 0;
    }
    rows.push([
      '',
      'GRAND TOTAL',
      '',
      '',
      '',
      sumDisbursed.toFixed(2),
      sumRepaid.toFixed(2),
      sumOutstanding.toFixed(2),
      '',
      '',
    ]);
  }

  return {
    columns: ['Loan No', 'Customer', 'Product', 'Branch', 'Disbursed On', 'Disbursed', 'Repaid', 'Outstanding', 'Status', 'Next Due'],
    rows,
    hasTotalsRow: rows.length > 0,
    subtitle: [`Outstanding position as on ${formatDDMMYYYY(asOf(params))}`],
  };
};

// --- weekly_loan_collection_register ----------------------------------------

/**
 * Official weekly loan collection format (client [Follow-up 31 Aug]): the
 * instalments due in the selected period for loans scheduled on a weekly
 * collection basis (loan product repayment_frequency = 'weekly'), with the
 * expected amount, what has been collected so far, and the instalment status.
 */
const builderWeeklyLoanCollectionRegister: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const where = buildWhere([
    { sql: "l.repayment_frequency = 'weekly'", value: 'true' },
    { sql: "l.status IN ('active','overdue','rescheduled')", value: 'true' },
    { sql: 'l.product_id = ?', value: str(params.filters.product_id) || null },
    { sql: 'l.branch_id = ?', value: str(params.filters.branch_id) || null },
    { sql: 'li.status = ?', value: str(params.filters.status) || null },
    { sql: 'li.due_date >= ?::date', value: range.from },
    { sql: 'li.due_date <= ?::date', value: range.to },
  ]);
  const sql = `
    SELECT l.loan_number,
           c.full_name,
           c.customer_number,
           lp.name AS product_name,
           COALESCE(b.name, '') AS branch_name,
           li.instalment_number,
           li.due_date::text AS due_date,
           li.expected_amount::text AS expected_amount,
           li.paid_amount::text AS paid_amount,
           li.status
      FROM loan_instalment li
      JOIN loan l       ON l.id = li.loan_id
      JOIN customer c   ON c.id = l.customer_id
      JOIN loan_product lp ON lp.id = l.product_id
      LEFT JOIN branch b   ON b.id = l.branch_id
     WHERE ${where.clause || 'true'}
     ORDER BY li.due_date ASC, l.loan_number ASC, li.instalment_number ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    loan_number: string;
    full_name: string;
    customer_number: string | null;
    product_name: string;
    branch_name: string;
    instalment_number: string;
    due_date: string;
    expected_amount: string;
    paid_amount: string;
    status: string;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.due_date,
      r.loan_number,
      r.full_name,
      r.customer_number ?? '',
      r.product_name,
      r.branch_name,
      r.instalment_number,
      r.expected_amount,
      r.paid_amount,
      r.status,
    ],
  );

  if (rows.length > 0) {
    let sumExpected = 0, sumCollected = 0;
    for (const r of result.rows) {
      sumExpected += Number(r.expected_amount) || 0;
      sumCollected += Number(r.paid_amount) || 0;
    }
    rows.push([
      '',
      'GRAND TOTAL',
      '',
      '',
      '',
      '',
      '',
      sumExpected.toFixed(2),
      sumCollected.toFixed(2),
      '',
    ]);
  }

  return {
    columns: ['Due Date', 'Loan No', 'Customer', 'Customer No', 'Product', 'Branch', 'Instalment', 'Expected', 'Collected', 'Status'],
    rows,
    hasTotalsRow: rows.length > 0,
    subtitle: [`Weekly loan collection register for ${formatDDMMYYYY(range.from)} to ${formatDDMMYYYY(range.to)}`],
  };
};

// --- overdue_loan_report ---------------------------------------------------

const OVERDUE_BUCKETS: ReadonlyArray<{ code: string; label: string }> = [
  { code: '0-30', label: '0-30 days' },
  { code: '31-60', label: '31-60 days' },
  { code: '61-90', label: '61-90 days' },
  { code: '90+', label: 'Above 90 days' },
];

function overdueBucket(days: number): { code: string; label: string } {
  if (days <= 30) return OVERDUE_BUCKETS[0] ?? { code: '0-30', label: '0-30 days' };
  if (days <= 60) return OVERDUE_BUCKETS[1] ?? { code: '31-60', label: '31-60 days' };
  if (days <= 90) return OVERDUE_BUCKETS[2] ?? { code: '61-90', label: '61-90 days' };
  return OVERDUE_BUCKETS[3] ?? { code: '90+', label: 'Above 90 days' };
}

const builderOverdueLoanReport: ReportBuilder = async (params) => {
  const today = asOf(params);
  const bucketFilter = str(params.filters.ageing_bucket);
  const where = buildWhere([
    { sql: "li.status IN ('overdue','missed','partial')", value: 'true' },
    { sql: 'li.due_date <= ?::date', value: today },
    { sql: 'lp.id = ?', value: str(params.filters.product_id) || null },
  ]);
  const sql = `
    SELECT l.loan_number,
           c.full_name,
           lp.name AS product_name,
           li.instalment_number,
           li.due_date::text AS due_date,
           li.expected_amount::text AS expected_amount,
           li.principal_component::text AS principal_component,
           li.interest_component::text AS interest_component,
           li.penalty_component::text AS penalty_component,
           li.paid_amount::text AS paid_amount,
           li.status
      FROM loan_instalment li
      JOIN loan l          ON l.id = li.loan_id
      JOIN customer c      ON c.id = l.customer_id
      JOIN loan_product lp ON lp.id = l.product_id
     WHERE ${where.clause || 'true'}
     ORDER BY li.due_date ASC, l.loan_number ASC, li.instalment_number ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    loan_number: string;
    full_name: string;
    product_name: string;
    instalment_number: number;
    due_date: string;
    expected_amount: string;
    principal_component: string;
    interest_component: string;
    penalty_component: string;
    paid_amount: string;
    status: string;
  }>(sql, where.params);

  const rows: ReportRow[] = [];
  for (const r of result.rows) {
    const days = daysBetween(r.due_date, today);
    const bucket = overdueBucket(days);
    if (bucketFilter && bucket.code !== bucketFilter) continue;
    rows.push([
      r.loan_number,
      r.full_name,
      r.product_name,
      String(r.instalment_number),
      r.due_date,
      r.expected_amount,
      r.principal_component,
      r.interest_component,
      r.penalty_component,
      r.paid_amount,
      String(days),
      bucket.label,
    ]);
  }

  if (rows.length > 0) {
    let sumExpected = 0, sumPrincipal = 0, sumInterest = 0, sumPenalty = 0, sumPaid = 0;
    for (const r of result.rows) {
      // Must recalculate bucket filtering condition since it filters result.rows
      const days = daysBetween(r.due_date, today);
      const bucket = overdueBucket(days);
      if (bucketFilter && bucket.code !== bucketFilter) continue;
      
      sumExpected += Number(r.expected_amount) || 0;
      sumPrincipal += Number(r.principal_component) || 0;
      sumInterest += Number(r.interest_component) || 0;
      sumPenalty += Number(r.penalty_component) || 0;
      sumPaid += Number(r.paid_amount) || 0;
    }
    rows.push([
      '',
      'GRAND TOTAL',
      '',
      '',
      '',
      sumExpected.toFixed(2),
      sumPrincipal.toFixed(2),
      sumInterest.toFixed(2),
      sumPenalty.toFixed(2),
      sumPaid.toFixed(2),
      '',
      '',
    ]);
  }

  return {
    columns: ['Loan No', 'Customer', 'Product', 'Instalment', 'Due Date', 'Expected', 'Principal', 'Interest', 'Penalty', 'Paid', 'Days Overdue', 'Ageing'],
    rows,
    hasTotalsRow: rows.length > 0,
    subtitle: [`Overdue position as on ${formatDDMMYYYY(today)}`],
  };
};

// --- day_close_summary -----------------------------------------------------

const builderDayCloseSummary: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const where = buildWhere([
    { sql: 'dc.business_date >= ?::date', value: range.from },
    { sql: 'dc.business_date <= ?::date', value: range.to },
    { sql: 'dc.agent_id = ?', value: str(params.filters.agent_id) || null },
    { sql: 'dc.business_date = ?::date', value: str(params.filters.business_date) || null },
  ]);
  const sql = `
    SELECT dc.business_date::text AS business_date,
           a.agent_code,
           dc.status,
           dc.total_amount::text AS total_amount,
           dc.cash_amount::text AS cash_amount,
           dc.digital_amount::text AS digital_amount,
           dc.entry_count,
           (SELECT COALESCE(sum(ch.amount), 0)::numeric(14,2)::text
              FROM cash_handover ch WHERE ch.day_close_id = dc.id) AS handover_declared,
           (SELECT COALESCE(sum(ch.confirmed_amount), 0)::numeric(14,2)::text
              FROM cash_handover ch WHERE ch.day_close_id = dc.id) AS handover_confirmed,
           (SELECT COALESCE(sum(ds.amount), 0)::numeric(14,2)::text
              FROM digital_settlement ds WHERE ds.day_close_id = dc.id) AS settlements,
           (SELECT count(*) FROM reconciliation_difference rd
             WHERE rd.day_close_id = dc.id AND rd.status = 'unresolved') AS unresolved
      FROM day_close dc
      JOIN agent a ON a.id = dc.agent_id
     WHERE ${where.clause || 'true'}
     ORDER BY dc.business_date ASC, a.agent_code ASC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    business_date: string;
    agent_code: string;
    status: string;
    total_amount: string;
    cash_amount: string;
    digital_amount: string;
    entry_count: number;
    handover_declared: string;
    handover_confirmed: string;
    settlements: string;
    unresolved: number;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.business_date,
      r.agent_code,
      r.status,
      r.total_amount,
      r.cash_amount,
      r.digital_amount,
      String(r.entry_count),
      r.handover_declared,
      r.handover_confirmed,
      r.settlements,
      String(r.unresolved),
    ],
  );

  if (rows.length > 0) {
    let sumDeclared = 0, sumCash = 0, sumDigital = 0, sumEntries = 0;
    let sumHandoverD = 0, sumHandoverC = 0, sumSettlements = 0, sumUnresolved = 0;
    for (const r of result.rows) {
      sumDeclared += Number(r.total_amount) || 0;
      sumCash += Number(r.cash_amount) || 0;
      sumDigital += Number(r.digital_amount) || 0;
      sumEntries += Number(r.entry_count) || 0;
      sumHandoverD += Number(r.handover_declared) || 0;
      sumHandoverC += Number(r.handover_confirmed) || 0;
      sumSettlements += Number(r.settlements) || 0;
      sumUnresolved += Number(r.unresolved) || 0;
    }
    rows.push([
      '',
      'GRAND TOTAL',
      '',
      sumDeclared.toFixed(2),
      sumCash.toFixed(2),
      sumDigital.toFixed(2),
      String(sumEntries),
      sumHandoverD.toFixed(2),
      sumHandoverC.toFixed(2),
      sumSettlements.toFixed(2),
      String(sumUnresolved),
    ]);
  }

  return {
    columns: ['Business Date', 'Agent Code', 'Status', 'Declared Total', 'Cash', 'Digital', 'Entries', 'Handover Declared', 'Handover Confirmed', 'Settlements', 'Unresolved Diffs'],
    rows,
    hasTotalsRow: rows.length > 0,
  };
};

// --- agent_performance_report ---------------------------------------------

const builderAgentPerformanceReport: ReportBuilder = async (params) => {
  const range = periodRange(params);
  const agentFilter = str(params.filters.agent_id);
  const where = buildWhere([
    { sql: 'a.id = ?', value: agentFilter || null },
  ]);
  const sql = `
    WITH accepted AS (
      SELECT ce.agent_id,
             count(*) AS entry_count,
             count(*) FILTER (WHERE ce.status = 'accepted') AS accepted_count,
             COALESCE(sum(ce.amount) FILTER (WHERE ce.status = 'accepted'), 0)::numeric(14,2)::text
               AS accepted_amount
        FROM collection_entry ce
       WHERE ce.is_deleted = false
         AND ce.business_date >= $1::date
         AND ce.business_date <= $2::date
       GROUP BY ce.agent_id
    ),
    visits AS (
      SELECT vl.agent_id,
             count(*) AS visit_count,
             count(*) FILTER (WHERE vl.outcome = 'collected') AS collected_count
        FROM visit_log vl
       WHERE vl.visit_date >= $1::date
         AND vl.visit_date <= $2::date
       GROUP BY vl.agent_id
    ),
    assignments AS (
      SELECT aca.agent_id, count(DISTINCT aca.customer_id) AS assigned_customers
        FROM agent_customer_assignment aca
       GROUP BY aca.agent_id
    )
    SELECT a.agent_code,
           COALESCE(s.full_name, '') AS agent_name,
           COALESCE(acc.accepted_count, 0)::text AS accepted_count,
           COALESCE(acc.entry_count, 0)::text AS entry_count,
           COALESCE(acc.accepted_amount, '0.00') AS accepted_amount,
           COALESCE(v.visit_count, 0)::text AS visit_count,
           COALESCE(v.collected_count, 0)::text AS collected_count,
           COALESCE(ass.assigned_customers, 0)::text AS assigned_customers
      FROM agent a
      LEFT JOIN staff s       ON s.id = a.staff_id
      LEFT JOIN accepted acc  ON acc.agent_id = a.id
      LEFT JOIN visits v      ON v.agent_id = a.id
      LEFT JOIN assignments ass ON ass.agent_id = a.id
     WHERE a.status IN ('active', 'suspended') ${where.clause ? `AND ${where.clause}` : ''}
     ORDER BY a.agent_code ASC`;
  const result = await query<{
    agent_code: string;
    agent_name: string;
    accepted_count: string;
    entry_count: string;
    accepted_amount: string;
    visit_count: string;
    collected_count: string;
    assigned_customers: string;
  }>(sql, [range.from, range.to, ...where.params]);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.agent_code,
      r.agent_name,
      r.accepted_count,
      r.entry_count,
      r.accepted_amount,
      r.visit_count,
      r.collected_count,
      r.assigned_customers,
    ],
  );

  if (rows.length > 0) {
    let sumAccepted = 0, sumEntries = 0, sumAmount = 0, sumVisits = 0, sumCollectedVisits = 0, sumAssigned = 0;
    for (const r of result.rows) {
      sumAccepted += Number(r.accepted_count) || 0;
      sumEntries += Number(r.entry_count) || 0;
      sumAmount += Number(r.accepted_amount) || 0;
      sumVisits += Number(r.visit_count) || 0;
      sumCollectedVisits += Number(r.collected_count) || 0;
      sumAssigned += Number(r.assigned_customers) || 0;
    }
    rows.push([
      '',
      'GRAND TOTAL',
      String(sumAccepted),
      String(sumEntries),
      sumAmount.toFixed(2),
      String(sumVisits),
      String(sumCollectedVisits),
      String(sumAssigned),
    ]);
  }

  return {
    columns: ['Agent Code', 'Agent Name', 'Accepted Collections', 'Total Entries', 'Amount Collected', 'Visits', 'Collected Visits', 'Assigned Customers'],
    rows,
    hasTotalsRow: rows.length > 0,
    subtitle: [`Period: ${formatDDMMYYYY(range.from)} to ${formatDDMMYYYY(range.to)}`],
  };
};

// --- interest_posting_register ---------------------------------------------

const builderInterestPostingRegister: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const productId = str(params.filters.product_id) || null;
  const accountId = str(params.filters.account_id) || null;

  const customerId = str(params.filters.customer_id) || null;

  const sql = `
    SELECT * FROM (
      SELECT ip.posting_date::text AS posting_date,
             sa.account_number AS account_number,
             c.full_name AS customer_name,
             dp.name AS product_name,
             ip.rate_applied::text AS rate_applied,
             ip.amount::text AS amount,
             ip.period_start::text AS period_start,
             ip.period_end::text AS period_end,
             'Savings' AS subledger
        FROM interest_posting ip
        JOIN savings_account sa ON sa.id = ip.savings_account_id
        JOIN deposit_product dp  ON dp.id = sa.product_id
        JOIN customer c          ON c.id = sa.customer_id
       WHERE ip.posting_date BETWEEN $1::date AND $2::date
         AND ($3::uuid IS NULL OR sa.product_id = $3::uuid)
         AND ($4::uuid IS NULL OR sa.id = $4::uuid)
         AND ($5::uuid IS NULL OR sa.customer_id = $5::uuid)
      UNION ALL
      SELECT rip.posting_date::text,
             ra.account_number,
             c.full_name,
             rs.name,
             rip.rate_applied::text,
             rip.amount::text,
             rip.period_start::text,
             rip.period_end::text,
             'Recurring Deposit'
        FROM rd_interest_posting rip
        JOIN rd_account ra   ON ra.id = rip.rd_account_id
        JOIN rd_scheme rs    ON rs.id = ra.scheme_id
        JOIN customer c      ON c.id = ra.customer_id
       WHERE rip.posting_date BETWEEN $1::date AND $2::date
         AND ($4::uuid IS NULL OR ra.id = $4::uuid)
         AND ($5::uuid IS NULL OR ra.customer_id = $5::uuid)
      UNION ALL
      SELECT fp.payout_date::text,
             fa.account_number,
             c.full_name,
             'Fixed Deposit',
             fa.interest_rate::text,
             fp.amount::text,
             fp.period_start::text,
             fp.period_end::text,
             'Fixed Deposit'
        FROM fd_interest_payout fp
        JOIN fd_account fa ON fa.id = fp.fd_account_id
        JOIN customer c    ON c.id = fa.customer_id
       WHERE fp.payout_date BETWEEN $1::date AND $2::date
         AND ($4::uuid IS NULL OR fa.id = $4::uuid)
         AND ($5::uuid IS NULL OR fa.customer_id = $5::uuid)
    ) u
    ORDER BY u.posting_date ASC
    LIMIT ${MAX_REPORT_ROWS}`;

  const result = await query<{
    posting_date: string;
    account_number: string;
    customer_name: string;
    product_name: string;
    rate_applied: string;
    amount: string;
    period_start: string;
    period_end: string;
    subledger: string;
  }>(sql, [range.from, range.to, productId, accountId, customerId]);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.posting_date,
      r.subledger,
      r.account_number,
      r.customer_name,
      r.product_name,
      r.rate_applied,
      r.amount,
      r.period_start,
      r.period_end,
    ],
  );
  return {
    columns: ['Posting Date', 'Sub-ledger', 'Account No', 'Customer', 'Product / Scheme', 'Rate', 'Amount', 'Period From', 'Period To'],
    rows,
  };
};

// --- dispute_register ------------------------------------------------------

const builderDisputeRegister: ReportBuilder = async (params) => {
  const range = rangeFor(params);
  const where = buildWhere([
    { sql: 'dc.raised_on >= ?::date', value: range.from },
    { sql: 'dc.raised_on <= ?::date', value: range.to },
    { sql: 'dc.status = ?', value: str(params.filters.status) || null },
    { sql: 'dc.customer_id = ?', value: str(params.filters.customer_id) || null },
  ]);
  const sql = `
    SELECT dc.dispute_number,
           dc.raised_on::text AS raised_on,
           COALESCE(c.full_name, 'Walk-in') AS customer_name,
           COALESCE(c.customer_number, '') AS customer_number,
           dc.disputed_entity_type,
           dc.disputed_entity_id::text AS disputed_entity_id,
           dc.description,
           dc.status,
           COALESCE(dc.resolution, '') AS resolution,
           COALESCE(st.staff_code, '') AS resolved_by_code,
           COALESCE(dc.resolved_on, NULL) AS resolved_on
      FROM dispute_case dc
      LEFT JOIN customer c  ON c.id = dc.customer_id
      LEFT JOIN staff st    ON st.id = dc.resolved_by
     WHERE ${where.clause || 'true'}
     ORDER BY dc.raised_on DESC, dc.created_at DESC
     LIMIT ${MAX_REPORT_ROWS}`;
  const result = await query<{
    dispute_number: string;
    raised_on: string;
    customer_name: string;
    customer_number: string;
    disputed_entity_type: string;
    disputed_entity_id: string;
    description: string;
    status: string;
    resolution: string;
    resolved_by_code: string;
    resolved_on: Date | null;
  }>(sql, where.params);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.dispute_number,
      r.raised_on,
      r.customer_name,
      r.customer_number,
      r.disputed_entity_type,
      r.disputed_entity_id,
      r.description,
      r.status,
      r.resolution,
      r.resolved_by_code,
      stampToDisplay(r.resolved_on),
    ],
  );
  return {
    columns: ['Dispute No', 'Raised On', 'Customer', 'Customer No', 'Entity Type', 'Entity ID', 'Description', 'Status', 'Resolution', 'Resolved By', 'Resolved On'],
    rows,
  };
};

// --- audit_event_report ----------------------------------------------------

const builderAuditEventReport: ReportBuilder = async (params) => {
  const today = istBusinessDate();
  const from = params.fromDate ?? addDays(today, -6);
  const to = params.toDate ?? today;
  const where = buildWhere([
    { sql: "a.action = ?", value: str(params.filters.action) || null },
    { sql: 'a.actor_staff_id = ?', value: str(params.filters.actor_staff_id) || null },
    { sql: 'a.entity_type = ?', value: str(params.filters.entity_type) || null },
  ]);
  const sql = `
    SELECT a.occurred_at,
           a.actor_staff_code,
           a.actor_role,
           a.action,
           a.entity_type,
           a.entity_id,
           a.source,
           a.request_id,
           a.business_date::text AS business_date
      FROM audit_event a
     WHERE (a.occurred_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN $1::date AND $2::date
       ${where.clause ? `AND ${where.clause}` : ''}
     ORDER BY a.occurred_at DESC
     LIMIT 5000`;
  const result = await query<{
    occurred_at: Date;
    actor_staff_code: string | null;
    actor_role: string | null;
    action: string;
    entity_type: string;
    entity_id: string | null;
    source: string;
    request_id: string | null;
    business_date: string | null;
  }>(sql, [from, to, ...where.params]);

  const rows = result.rows.map(
    (r): ReportRow => [
      stampToDisplay(r.occurred_at),
      r.actor_staff_code ?? '',
      r.actor_role ?? '',
      r.action,
      r.entity_type,
      r.entity_id ?? '',
      r.source,
      r.request_id ?? '',
      r.business_date ?? '',
    ],
  );
  return {
    columns: ['Occurred At', 'Actor Code', 'Actor Role', 'Action', 'Entity Type', 'Entity Id', 'Source', 'Request Id', 'Business Date'],
    rows,
    subtitle: [`Events from ${formatDDMMYYYY(from)} to ${formatDDMMYYYY(to)}`],
  };
};

// --- yearly_authority_report ----------------------------------------------
// Spec §24.2 / §17: yearly authority reporting support. Month-by-month summary
// of the financial year's activity — registrations, savings accounts, deposits,
// withdrawals, interest, RD/FD openings, loan disbursements and collections,
// total accepted collections, and disputes — for submission to the regulator.

const builderYearlyAuthorityReport: ReportBuilder = async (params) => {
  const today = istBusinessDate();
  const fy = financialYearRange(today);
  const from = params.fromDate ?? fy.start;
  const to = params.toDate ?? fy.end;
  if (from > to) {
    throw new BadRequestError('fromDate must not be after toDate', 'INVALID_DATE_RANGE');
  }

  const sql = `
    WITH months AS (
      SELECT to_char(gs::date, 'Mon YYYY') AS month_label,
             gs::date AS month_start,
             (gs + interval '1 month' - interval '1 day')::date AS month_end
        FROM generate_series($1::date, $2::date, interval '1 month') AS gs
    )
    SELECT m.month_label AS month_label,
           (SELECT COUNT(*)::text FROM customer c
             WHERE c.registration_date BETWEEN m.month_start AND m.month_end) AS new_customers,
           (SELECT COUNT(*)::text FROM savings_account sa
             WHERE sa.opened_on BETWEEN m.month_start AND m.month_end
               AND sa.status <> 'pending_approval') AS savings_opened,
           (SELECT COALESCE(SUM(at.amount), 0)::text FROM account_transaction at
             WHERE at.value_date BETWEEN m.month_start AND m.month_end
               AND at.transaction_type = 'deposit') AS savings_deposits,
           (SELECT COALESCE(SUM(at.amount), 0)::text FROM account_transaction at
             WHERE at.value_date BETWEEN m.month_start AND m.month_end
               AND at.transaction_type = 'withdrawal') AS withdrawals_paid,
           (SELECT COALESCE(SUM(ip.amount), 0)::text FROM interest_posting ip
             WHERE ip.posting_date BETWEEN m.month_start AND m.month_end) AS interest_posted,
           (SELECT COUNT(*)::text FROM rd_account ra
             WHERE ra.start_date BETWEEN m.month_start AND m.month_end) AS rd_opened,
           (SELECT COUNT(*)::text FROM fd_account fa
             WHERE fa.start_date BETWEEN m.month_start AND m.month_end) AS fd_opened,
           (SELECT COUNT(*)::text FROM loan l
             WHERE l.disbursed_on BETWEEN m.month_start AND m.month_end) AS loans_disbursed,
           (SELECT COALESCE(SUM(l.disbursed_amount), 0)::text FROM loan l
             WHERE l.disbursed_on BETWEEN m.month_start AND m.month_end) AS loan_amount,
           (SELECT COALESCE(SUM(li.paid_amount), 0)::text FROM loan_instalment li
             WHERE li.paid_on BETWEEN m.month_start AND m.month_end) AS loan_collections,
           (SELECT COALESCE(SUM(ce.amount), 0)::text FROM collection_entry ce
             WHERE ce.business_date BETWEEN m.month_start AND m.month_end
               AND ce.status = 'accepted'
               AND NOT ce.is_deleted) AS total_collections,
           (SELECT COUNT(*)::text FROM dispute_case dc
             WHERE dc.raised_on BETWEEN m.month_start AND m.month_end) AS disputes_raised
      FROM months m
     ORDER BY m.month_start`;

  const result = await query<{
    month_label: string;
    new_customers: string;
    savings_opened: string;
    savings_deposits: string;
    withdrawals_paid: string;
    interest_posted: string;
    rd_opened: string;
    fd_opened: string;
    loans_disbursed: string;
    loan_amount: string;
    loan_collections: string;
    total_collections: string;
    disputes_raised: string;
  }>(sql, [from, to]);

  const rows = result.rows.map(
    (r): ReportRow => [
      r.month_label,
      r.new_customers,
      r.savings_opened,
      r.savings_deposits,
      r.withdrawals_paid,
      r.interest_posted,
      r.rd_opened,
      r.fd_opened,
      r.loans_disbursed,
      r.loan_amount,
      r.loan_collections,
      r.total_collections,
      r.disputes_raised,
    ],
  );

  if (rows.length > 0) {
    let sNewCust = 0, sSavOpened = 0, sSavDep = 0, sWithPaid = 0, sIntPosted = 0;
    let sRdOpened = 0, sFdOpened = 0, sLoansDisb = 0, sLoanAmt = 0;
    let sLoanColl = 0, sTotalColl = 0, sDisputes = 0;

    for (const r of result.rows) {
      sNewCust += Number(r.new_customers) || 0;
      sSavOpened += Number(r.savings_opened) || 0;
      sSavDep += Number(r.savings_deposits) || 0;
      sWithPaid += Number(r.withdrawals_paid) || 0;
      sIntPosted += Number(r.interest_posted) || 0;
      sRdOpened += Number(r.rd_opened) || 0;
      sFdOpened += Number(r.fd_opened) || 0;
      sLoansDisb += Number(r.loans_disbursed) || 0;
      sLoanAmt += Number(r.loan_amount) || 0;
      sLoanColl += Number(r.loan_collections) || 0;
      sTotalColl += Number(r.total_collections) || 0;
      sDisputes += Number(r.disputes_raised) || 0;
    }

    rows.push([
      'GRAND TOTAL',
      String(sNewCust),
      String(sSavOpened),
      sSavDep.toFixed(2),
      sWithPaid.toFixed(2),
      sIntPosted.toFixed(2),
      String(sRdOpened),
      String(sFdOpened),
      String(sLoansDisb),
      sLoanAmt.toFixed(2),
      sLoanColl.toFixed(2),
      sTotalColl.toFixed(2),
      String(sDisputes),
    ]);
  }

  return {
    columns: [
      'Month',
      'New Customers',
      'Savings Opened',
      'Savings Deposits (₹)',
      'Withdrawals Paid (₹)',
      'Interest Posted (₹)',
      'RD Opened',
      'FD Opened',
      'Loans Disbursed',
      'Loan Amount (₹)',
      'Loan Collections (₹)',
      'Total Collections (₹)',
      'Disputes Raised',
    ],
    rows,
    hasTotalsRow: rows.length > 0,
  };
};

/** Registry — one builder per seeded report_type (seed.ts REPORT_DEFINITIONS). */
const REPORT_BUILDERS: Record<string, ReportBuilder> = {
  daily_collection_register: builderDailyCollectionRegister,
  savings_transaction_register: builderSavingsTransactionRegister,
  customer_statement: builderCustomerStatement,
  loan_outstanding_report: builderLoanOutstandingReport,
  weekly_loan_collection_register: builderWeeklyLoanCollectionRegister,
  overdue_loan_report: builderOverdueLoanReport,
  day_close_summary: builderDayCloseSummary,
  agent_performance_report: builderAgentPerformanceReport,
  interest_posting_register: builderInterestPostingRegister,
  dispute_register: builderDisputeRegister,
  audit_event_report: builderAuditEventReport,
  yearly_authority_report: builderYearlyAuthorityReport,
};

// ---------------------------------------------------------------------------
// PDF rendering (pdf-lib, tiny module-private helper)
// ---------------------------------------------------------------------------

const PAGE_WIDTH = 612; // US Letter width (points)
const PAGE_HEIGHT = 792; // US Letter height
const MARGIN_X = 40;
const MARGIN_BOTTOM = 48;
const FONT_SIZE_DATA = 8;
const FONT_SIZE_HEAD = 8;
const LINE_HEIGHT_DATA = 10;
const CELL_PAD_Y = 4;
const FIRST_PAGE_HEADER_BLOCK = 176;
const CONTINUATION_HEADER_BLOCK = 64;

interface PdfReportOptions {
  title: string;
  subtitleLines: string[];
  columns: string[];
  rows: ReportRow[];
  hasTotalsRow?: boolean;
  generatedBy: string;
}

function wrapText(font: PDFFont, text: string, maxWidth: number, size: number): string[] {
  if (text === '') return [''];
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = '';
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (font.widthOfTextAtSize(candidate, size) <= maxWidth || current === '') {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = word;
  }
  if (current) lines.push(current);

  // Hard-break any single token that still exceeds the column width.
  const broken: string[] = [];
  for (const line of lines) {
    if (font.widthOfTextAtSize(line, size) <= maxWidth) {
      broken.push(line);
      continue;
    }
    let token = line;
    let slice = '';
    while (token.length > 0) {
      const test = slice + token[0];
      if (token[0] && font.widthOfTextAtSize(test, size) <= maxWidth) {
        slice += token[0];
        token = token.slice(1);
      } else {
        if (slice === '') {
          slice = token[0] ?? '';
          token = token.slice(1);
        }
        broken.push(slice);
        slice = '';
      }
    }
    if (slice) broken.push(slice);
  }
  return broken.length > 0 ? broken : lines;
}

function isNumericText(value: string): boolean {
  return /^-?\d[\d,]*\.?\d*$/.test(value) && value.trim() !== '';
}

async function renderPdfReport(options: PdfReportOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.32, 0.32, 0.32);
  const light = rgb(0.78, 0.78, 0.78);

  const contentWidth = PAGE_WIDTH - MARGIN_X * 2;
  const nColumns = options.columns.length;
  const columnWidth = contentWidth / nColumns;

  // Precompute wrapped cell lines per row.
  const cellLines: string[][][] = options.rows.map((row) =>
    options.columns.map((_, colIndex) => {
      const raw = row[colIndex];
      const text = raw === null || raw === undefined ? '' : String(raw);
      return wrapText(font, text, Math.max(columnWidth - 6, 10), FONT_SIZE_DATA);
    }),
  );

  const rowHeights = cellLines.map((linesPerCell) => {
    const maxLines = Math.max(1, ...linesPerCell.map((lines) => lines.length));
    return Math.max(18, maxLines * LINE_HEIGHT_DATA + CELL_PAD_Y * 2);
  });

  // --- page packing (simulate so the "Page X of Y" footer is accurate) ----
  const firstPageRows = PAGE_HEIGHT - FIRST_PAGE_HEADER_BLOCK - MARGIN_BOTTOM;
  const continuationRows = PAGE_HEIGHT - CONTINUATION_HEADER_BLOCK - MARGIN_BOTTOM;
  const pages: number[][] = [];
  let current: number[] = [];
  let used = 0;
  const capacityFor = (index: number): number =>
    index === 0 ? firstPageRows : continuationRows;

  const pushPage = (): void => {
    if (current.length > 0) pages.push(current);
    current = [];
    used = 0;
  };

  for (let i = 0; i < rowHeights.length; i += 1) {
    const height = rowHeights[i] ?? 0;
    const pageIndex = pages.length; // pages so far == current page index
    const capacity = capacityFor(pageIndex);
    if (current.length > 0 && used + height > capacity) pushPage();
    current.push(i);
    used += height;
  }
  pushPage();
  const totalPages = Math.max(pages.length, 1);

  // If there are no data rows ensure at least one empty page exists.
  if (totalPages === 0) {
    pages.push([]);
  }

  const drawTableHead = (page: PDFPage, topY: number): number => {
    const headerLines = options.columns.map((header) =>
      wrapText(bold, header, Math.max(columnWidth - 6, 10), FONT_SIZE_HEAD)
    );
    const maxLines = Math.max(1, ...headerLines.map((lines) => lines.length));
    const rowHeight = Math.max(18, maxLines * LINE_HEIGHT_DATA + CELL_PAD_Y * 2);
    
    const y = topY - rowHeight;
    page.drawRectangle({
      x: MARGIN_X,
      y,
      width: contentWidth,
      height: rowHeight,
      color: rgb(0.9, 0.92, 0.94),
    });
    
    headerLines.forEach((lines, colIndex) => {
      const x = MARGIN_X + colIndex * columnWidth;
      let textY = topY - CELL_PAD_Y - FONT_SIZE_HEAD;
      for (const line of lines) {
        page.drawText(line, {
          x: x + 3,
          y: textY,
          size: FONT_SIZE_HEAD,
          font: bold,
          color: black,
        });
        textY -= LINE_HEIGHT_DATA;
      }
    });
    
    page.drawLine({
      start: { x: MARGIN_X, y },
      end: { x: PAGE_WIDTH - MARGIN_X, y },
      thickness: 0.6,
      color: black,
    });
    return y;
  };

  const drawHeader = (page: PDFPage, pageIndex: number): number => {
    if (pageIndex === 0) {
      page.drawText(ORG_LEGAL_NAME, {
        x: MARGIN_X,
        y: PAGE_HEIGHT - 42,
        size: 14,
        font: bold,
        color: black,
      });
      page.drawText(ORG_HEADER_LINE, {
        x: MARGIN_X,
        y: PAGE_HEIGHT - 58,
        size: 9,
        font,
        color: gray,
      });

      // Title (centred)
      const titleWidth = bold.widthOfTextAtSize(options.title, 13);
      page.drawText(options.title, {
        x: (PAGE_WIDTH - titleWidth) / 2,
        y: PAGE_HEIGHT - 86,
        size: 13,
        font: bold,
        color: black,
      });

      // Subtitle lines
      let lineY = PAGE_HEIGHT - 104;
      for (const line of options.subtitleLines) {
        page.drawText(line, {
          x: MARGIN_X,
          y: lineY,
          size: 8,
          font,
          color: gray,
        });
        lineY -= 11;
      }
      page.drawLine({
        start: { x: MARGIN_X, y: lineY - 6 },
        end: { x: PAGE_WIDTH - MARGIN_X, y: lineY - 6 },
        thickness: 1,
        color: black,
      });
      return lineY - 6 - 16; // y from which the table header starts
    }

    // Continuation header — running title + "continued"
    page.drawText(options.title, {
      x: MARGIN_X,
      y: PAGE_HEIGHT - 34,
      size: 10,
      font: bold,
      color: black,
    });
    page.drawText('(continued)', {
      x: PAGE_WIDTH - MARGIN_X - 70,
      y: PAGE_HEIGHT - 34,
      size: 8,
      font,
      color: gray,
    });
    page.drawLine({
      start: { x: MARGIN_X, y: PAGE_HEIGHT - 42 },
      end: { x: PAGE_WIDTH - MARGIN_X, y: PAGE_HEIGHT - 42 },
      thickness: 0.8,
      color: black,
    });
    return PAGE_HEIGHT - 42 - 24;
  };

  const drawFooter = (page: PDFPage, pageIndex: number): void => {
    const pageNumber = pageIndex + 1;
    const footerText = `Page ${pageNumber} of ${totalPages}`;
    const width = font.widthOfTextAtSize(footerText, 8);
    page.drawText(PDF_FOOTER_LEGAL, {
      x: MARGIN_X,
      y: 30,
      size: 6.5,
      font,
      color: gray,
    });
    page.drawText(footerText, {
      x: PAGE_WIDTH - MARGIN_X - width,
      y: 30,
      size: 8,
      font,
      color: gray,
    });
  };

  const drawDataRow = (
    page: PDFPage,
    topY: number,
    rowIndex: number,
    rowLines: string[][],
    height: number,
    isTotal: boolean,
  ): void => {
    // bottom y of this row
    const bottomY = topY - height;

    rowLines.forEach((lines, colIndex) => {
      const x = MARGIN_X + colIndex * columnWidth;
      const numeric = lines.length === 1 && isNumericText(lines[0] ?? '');
      const textX = numeric ? x + columnWidth - 3 - font.widthOfTextAtSize(lines[0] ?? '', FONT_SIZE_DATA) : x + 3;
      const blockHeight = lines.length * LINE_HEIGHT_DATA;
      let textY = topY - CELL_PAD_Y - FONT_SIZE_DATA;
      for (const line of lines) {
        page.drawText(line, { x: textX, y: textY, size: FONT_SIZE_DATA, font: isTotal ? bold : font, color: black });
        textY -= LINE_HEIGHT_DATA;
      }
      void blockHeight;
      // Vertical cell separator
      page.drawLine({
        start: { x, y: bottomY },
        end: { x, y: topY },
        thickness: 0.2,
        color: light,
      });
    });

    // thin row rule or thick for total
    page.drawLine({
      start: { x: MARGIN_X, y: bottomY },
      end: { x: PAGE_WIDTH - MARGIN_X, y: bottomY },
      thickness: isTotal ? 0.8 : 0.2,
      color: isTotal ? black : light,
    });
    
    if (isTotal) {
       page.drawLine({
         start: { x: MARGIN_X, y: topY },
         end: { x: PAGE_WIDTH - MARGIN_X, y: topY },
         thickness: 0.8,
         color: black,
       });
    }
    void rowIndex;
  };

  for (let pageIndex = 0; pageIndex < totalPages; pageIndex += 1) {
    const page = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    const headerBottom = drawHeader(page, pageIndex);
    const tableHeadBottom = drawTableHead(page, headerBottom);
    let y = tableHeadBottom;

    const rowsOnPage = pages[pageIndex] ?? [];
    for (const rowIndex of rowsOnPage) {
      const lines = cellLines[rowIndex] ?? [];
      const height = rowHeights[rowIndex] ?? LINE_HEIGHT_DATA + CELL_PAD_Y;
      const isTotal = options.hasTotalsRow ? rowIndex === options.rows.length - 1 : false;
      drawDataRow(page, y, rowIndex, lines, height, isTotal);
      y -= height;
    }
    drawFooter(page, pageIndex);
  }

  return doc.save();
}

// ---------------------------------------------------------------------------
// Report generation — POST /reports/:type/generate
// ---------------------------------------------------------------------------

type GeneratedReportInsertRow = {
  id: string;
  report_type: string;
  filename: string;
  file_size_bytes: number | null;
  generated_at: Date;
};

export async function generateReport(
  actor: AuthContext,
  reportType: string,
  input: GenerateReportInput,
  meta: RequestMeta,
): Promise<ReportGenerationResult> {
  const definition = await query<ReportDefinitionRow>(
    `SELECT id, report_type, name, description,
            required_permissions, available_filters, date_basis
       FROM report_definition
      WHERE report_type = $1 AND is_active = true
      LIMIT 1`,
    [reportType],
  );
  const def = definition.rows[0];
  if (!def) {
    throw new NotFoundError('Report type is not available');
  }

  // Authority: the acting staff member must hold every required permission.
  const owned = new Set<string>(actor.permissions);
  const missing = def.required_permissions.filter((permission) => !owned.has(permission));
  if (missing.length > 0) {
    throw new ForbiddenError('You do not have permission to generate this report', 'REPORT_PERMISSION_DENIED');
  }

  // Filter keys must be a subset of the definition's available_filters.
  const filterKeys = Object.keys(input.filters ?? {});
  const unknownKeys = filterKeys.filter((key) => !def.available_filters.includes(key));
  if (unknownKeys.length > 0) {
    throw new BadRequestError(
      `Unknown filter${unknownKeys.length > 1 ? 's' : ''}: ${unknownKeys.join(', ')}`,
      'UNKNOWN_REPORT_FILTER',
    );
  }

  const builder = REPORT_BUILDERS[def.report_type];
  if (!builder) {
    throw new BadRequestError(
      `Report builder for '${def.report_type}' is not available`,
      'REPORT_BUILDER_UNAVAILABLE',
    );
  }

  const builderParams: BuilderParams = { filters: input.filters ?? {} };
  if (input.fromDate !== undefined) builderParams.fromDate = input.fromDate;
  if (input.toDate !== undefined) builderParams.toDate = input.toDate;

  let built: BuilderOutput;
  try {
    built = await builder(builderParams);
  } catch (error) {
    if (error instanceof BusinessRuleError || error instanceof BadRequestError) throw error;
    throw new BadRequestError(
      `Could not build report data: ${error instanceof Error ? error.message : 'unknown error'}`,
      'REPORT_BUILD_FAILED',
    );
  }

  if (built.rows.length > MAX_REPORT_ROWS) {
    built.rows = built.rows.slice(0, MAX_REPORT_ROWS);
  }

  // Subtitle: period + financial-year context + filter summary.
  const subtitleLines: string[] = [];
  const today = istBusinessDate();
  const periodText = (() => {
    if (input.fromDate && input.toDate) {
      return `${formatDDMMYYYY(input.fromDate)} to ${formatDDMMYYYY(input.toDate)}`;
    }
    if (input.fromDate) return `From ${formatDDMMYYYY(input.fromDate)}`;
    if (input.toDate) return `Up to ${formatDDMMYYYY(input.toDate)}`;
    const fy = financialYearRange(today);
    return `${formatDDMMYYYY(fy.start)} to ${formatDDMMYYYY(fy.end)}`;
  })();
  subtitleLines.push(
    `Period: ${periodText}   |   Financial Year ${financialYearLabel(today)} (1 Apr - 31 Mar)`,
  );
  const filterText = Object.entries(builderParams.filters)
    .map(([key, value]) => `${key}: ${str(value)}`)
    .join('  |  ');
  subtitleLines.push(filterText ? `Filters: ${filterText}` : 'Filters: none');
  if (built.subtitle && built.subtitle.length > 0) subtitleLines.push(...built.subtitle);
  subtitleLines.push(`Generated by ${actor.fullName} (${actor.staffCode}) on ${istDateTimeString(new Date())} IST`);

  // Render the PDF (fails fast — nothing stored on failure).
  let pdfBytes: Uint8Array;
  try {
    pdfBytes = await renderPdfReport({
      title: def.name,
      subtitleLines,
      columns: built.columns,
      rows: built.rows,
      hasTotalsRow: built.hasTotalsRow ?? false,
      generatedBy: `${actor.fullName} (${actor.staffCode})`,
    });
  } catch (error) {
    throw new BusinessRuleError(
      `PDF generation failed: ${error instanceof Error ? error.message : 'unknown error'}`,
      'PDF_RENDER_FAILED',
    );
  }

  const pdfBuffer = Buffer.from(pdfBytes);
  const filename = `${def.report_type}_${today}.pdf`;
  const parameters = JSON.stringify({
    fromDate: input.fromDate ?? null,
    toDate: input.toDate ?? null,
    filters: input.filters ?? {},
  });

  const result = await transaction<ReportGenerationResult>(async (client) => {
    const inserted = await client.query<GeneratedReportInsertRow>(
      `INSERT INTO generated_report
         (report_type, definition_id, generated_by, parameters,
          period_start, period_end, content, filename, file_size_bytes, status)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9, 'ready')
       RETURNING id, report_type, filename, file_size_bytes, generated_at`,
      [
        def.report_type,
        def.id,
        actor.staffId,
        parameters,
        input.fromDate ?? null,
        input.toDate ?? null,
        pdfBuffer,
        filename,
        pdfBuffer.byteLength,
      ],
    );
    const row = inserted.rows[0];
    if (!row) throw new InternalError('Generated report insert returned no row');

    await audit(client, {
      ...actorAuditBase(actor, meta),
      action: AUDIT_ACTIONS.REPORT_GENERATED,
      entityType: 'generated_report',
      entityId: row.id,
      requestId: meta.requestId ?? null,
      metadata: {
        reportType: def.report_type,
        filename: row.filename,
        fileSizeBytes: row.file_size_bytes ?? pdfBuffer.byteLength,
        periodStart: input.fromDate ?? null,
        periodEnd: input.toDate ?? null,
      },
    });

    return {
      id: row.id,
      reportType: row.report_type,
      filename: row.filename,
      fileSizeBytes: row.file_size_bytes ?? pdfBuffer.byteLength,
      generatedAt: row.generated_at.toISOString(),
      status: 'ready',
    };
  });

  return result;
}

// ---------------------------------------------------------------------------
// Report download — GET /reports/:id/download
// ---------------------------------------------------------------------------

type GeneratedReportRow = {
  id: string;
  report_type: string;
  filename: string;
  file_size_bytes: number | null;
  generated_at: Date;
  status: string;
  content: Buffer | null;
};

async function selectGeneratedReport(reportId: string): Promise<GeneratedReportRow | null> {
  const result = await query<GeneratedReportRow>(
    `SELECT id, report_type, filename, file_size_bytes, generated_at, status, content
       FROM generated_report
      WHERE id = $1
      LIMIT 1`,
    [reportId],
  );
  return result.rows[0] ?? null;
}

export async function downloadReport(
  actor: AuthContext,
  reportId: string,
  meta: RequestMeta,
): Promise<ReportDownloadResult> {
  const report = await selectGeneratedReport(reportId);
  if (!report) {
    throw new NotFoundError('Generated report not found');
  }
  if (report.content === null) {
    if (report.status === 'failed') {
      throw new ConflictError(
        'This report failed to generate and has no downloadable content',
        'REPORT_FAILED',
      );
    }
    throw new ConflictError(
      'This report has no downloadable content yet',
      'REPORT_NOT_READY',
    );
  }

  // The download audit is a standalone autocommit write (spec §6.3 allows
  // read-side events to use their own client; no transaction is needed here).
  await audit(autocommitClient(), {
    ...actorAuditBase(actor, meta),
    action: AUDIT_ACTIONS.REPORT_DOWNLOADED,
    entityType: 'generated_report',
    entityId: report.id,
    requestId: meta.requestId ?? null,
    metadata: {
      reportType: report.report_type,
      filename: report.filename,
      fileSizeBytes: report.file_size_bytes ?? report.content.byteLength,
    },
  });

  return {
    id: report.id,
    reportType: report.report_type,
    filename: report.filename,
    fileSizeBytes: report.file_size_bytes ?? report.content.byteLength,
    generatedAt: report.generated_at.toISOString(),
    status: report.status,
    content: report.content,
  };
}

// ---------------------------------------------------------------------------
// Report share — POST /reports/:id/share (record-only)
// ---------------------------------------------------------------------------

type SharedReportRow = {
  id: string;
  report_type: string;
  filename: string;
  status: string;
  shared_with: unknown;
  share_consent_by: string | null;
};

const SHARE_CHANNELS = new Set<string>(['email', 'whatsapp', 'sms']);

function toShareRecords(value: unknown): ReportShareRecord[] {
  if (!Array.isArray(value)) return [];
  const records: ReportShareRecord[] = [];
  for (const item of value) {
    const obj = (item ?? {}) as Record<string, unknown>;
    const channelRaw = str(obj.channel);
    const channel: ShareChannel = SHARE_CHANNELS.has(channelRaw)
      ? (channelRaw as ShareChannel)
      : 'email';
    const record: ReportShareRecord = {
      recipient: str(obj.recipient),
      channel,
      sharedAt: str(obj.sharedAt),
    };
    const note = obj.note;
    if (note !== undefined && note !== null && note !== '') record.note = str(note);
    records.push(record);
  }
  return records;
}

export async function shareReport(
  actor: AuthContext,
  reportId: string,
  input: ShareReportInput,
  meta: RequestMeta,
): Promise<ReportShareResult> {
  return transaction<ReportShareResult>(async (client) => {
    const existing = await client.query<GeneratedReportRow>(
      `SELECT id, report_type, filename, status FROM generated_report WHERE id = $1 LIMIT 1`,
      [reportId],
    );
    const report = existing.rows[0];
    if (!report) throw new NotFoundError('Generated report not found');

    const sharedAt = istDateTimeString(new Date());
    const newRecord: ReportShareRecord = {
      recipient: input.recipient,
      channel: input.channel,
      sharedAt,
    };
    if (input.note !== undefined) newRecord.note = input.note;

    await client.query(
      `UPDATE generated_report
          SET shared_with = COALESCE(shared_with, '[]'::jsonb) || $2::jsonb,
              share_consent_by = $3
        WHERE id = $1`,
      [report.id, JSON.stringify([newRecord]), actor.staffId],
    );

    await audit(client, {
      ...actorAuditBase(actor, meta),
      action: AUDIT_ACTIONS.REPORT_SHARED,
      entityType: 'generated_report',
      entityId: report.id,
      requestId: meta.requestId ?? null,
      metadata: {
        recipient: input.recipient,
        channel: input.channel,
        note: input.note ?? null,
        sharedAt,
      },
    });

    const updated = await client.query<SharedReportRow>(
      `SELECT id, report_type, filename, status, shared_with, share_consent_by
         FROM generated_report
        WHERE id = $1
        LIMIT 1`,
      [report.id],
    );
    const row = updated.rows[0];
    if (!row) throw new InternalError('Share update returned no row');

    return {
      id: row.id,
      reportType: row.report_type,
      filename: row.filename,
      status: row.status,
      sharedWith: toShareRecords(row.shared_with),
      shareConsentBy: row.share_consent_by ?? actor.staffId,
    };
  });
}

// ---------------------------------------------------------------------------
// Customer statement — GET /reports/customers/:id/statements
// ---------------------------------------------------------------------------

export interface CustomerStatementCustomer {
  id: string;
  fullName: string;
  customerCode: string;
}

export interface CustomerStatementAccount {
  id: string;
  accountNumber: string;
  productType: 'savingsDeposit';
  status: string;
  currentBalance: string;
}

export interface CustomerStatementEntry {
  date: string;
  productType: 'savingsDeposit';
  accountId: string;
  description: string;
  debit?: string;
  credit?: string;
  balance: string;
  correctionNote?: string;
  reversalOf?: string;
}

export interface CustomerStatementView {
  customer: CustomerStatementCustomer;
  accounts: CustomerStatementAccount[];
  period: { from: string; to: string };
  entries: CustomerStatementEntry[];
  openingBalance: string;
  closingBalance: string;
}

type CustomerRow = {
  id: string;
  full_name: string;
  customer_number: string | null;
};

type SavingsAccountRow = {
  id: string;
  account_number: string;
  status: string;
  current_balance: string;
};

type StatementTxnRow = {
  id: string;
  value_date: string;
  savings_account_id: string;
  account_number: string;
  transaction_type: string;
  direction: string;
  amount: string;
  balance_after: string;
  description: string | null;
  reference_number: string | null;
  reversal_of: string | null;
  adjustment_id: string | null;
  adjustment_reason: string | null;
};

function statementDescription(row: StatementTxnRow): string {
  const parts: string[] = [];
  if (row.description) parts.push(row.description);
  else parts.push(row.transaction_type);
  if (row.reference_number) parts.push(`Ref: ${row.reference_number}`);
  return parts.join(' — ');
}

export async function getCustomerStatement(
  actor: AuthContext,
  customerId: string,
  input: CustomerStatementQuery,
  _meta: RequestMeta,
): Promise<CustomerStatementView> {
  // Only the savings sub-ledger is fully implemented; RD/FD/loan product
  // filters return a graceful empty statement (best-effort union, spec §17.6).
  const productType = input.productType;
  if (productType !== undefined && productType !== 'savingsDeposit') {
    const customerResult = await query<CustomerRow>(
      `SELECT id, full_name, customer_number FROM customer WHERE id = $1 LIMIT 1`,
      [customerId],
    );
    const customer = customerResult.rows[0];
    if (!customer) throw new NotFoundError('Customer not found');

    const today = istBusinessDate();
    const fy = financialYearRange(today);
    const from = input.fromDate ?? fy.start;
    const to = input.toDate ?? today;
    return {
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        customerCode: customer.customer_number ?? '',
      },
      accounts: [],
      period: { from, to },
      entries: [],
      openingBalance: '0.00',
      closingBalance: '0.00',
    };
  }

  const today = istBusinessDate();
  const fy = financialYearRange(today);
  const from = input.fromDate ?? fy.start;
  const to = input.toDate ?? today;

  const customerResult = await query<CustomerRow>(
    `SELECT id, full_name, customer_number FROM customer WHERE id = $1 LIMIT 1`,
    [customerId],
  );
  const customer = customerResult.rows[0];
  if (!customer) throw new NotFoundError('Customer not found');

  // Savings accounts for the customer (optionally narrowed by accountId).
  const accountFilter = input.accountId ? 'AND sa.id = $2' : '';
  const accountParams: unknown[] = [customerId];
  if (input.accountId) accountParams.push(input.accountId);

  const accountsResult = await query<SavingsAccountRow>(
    `SELECT sa.id, sa.account_number, sa.status, sa.current_balance::text AS current_balance
       FROM savings_account sa
      WHERE sa.customer_id = $1
        ${accountFilter}
      ORDER BY sa.created_at ASC`,
    accountParams,
  );
  const accounts = accountsResult.rows;

  // If accountId was given but does not belong to this customer, treat as a
  // valid empty statement (no data leak — nothing cross-customer is shown).
  if (input.accountId && accounts.length === 0) {
    return {
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        customerCode: customer.customer_number ?? '',
      },
      accounts: [],
      period: { from, to },
      entries: [],
      openingBalance: '0.00',
      closingBalance: '0.00',
    };
  }

  const accountIds = accounts.map((account) => account.id);

  if (accountIds.length === 0) {
    return {
      customer: {
        id: customer.id,
        fullName: customer.full_name,
        customerCode: customer.customer_number ?? '',
      },
      accounts: [],
      period: { from, to },
      entries: [],
      openingBalance: '0.00',
      closingBalance: '0.00',
    };
  }

  // Opening balance: last ledger balance strictly before the period.
  const openingResult = await query<{ balance_after: string }>(
    `SELECT at.balance_after::text AS balance_after
       FROM account_transaction at
      WHERE at.savings_account_id = ANY($1::uuid[])
        AND at.value_date < $2::date
      ORDER BY at.value_date DESC, at.created_at DESC
      LIMIT 1`,
    [accountIds, from],
  );
  const openingBalance = openingResult.rows[0]?.balance_after ?? '0.00';

  // Ledger rows inside the period (chronological).
  const txnResult = await query<StatementTxnRow>(
    `SELECT at.id,
            at.value_date::text AS value_date,
            at.savings_account_id,
            sa.account_number,
            at.transaction_type,
            at.direction,
            at.amount::text AS amount,
            at.balance_after::text AS balance_after,
            at.description,
            at.reference_number,
            at.reversal_of::text AS reversal_of,
            at.adjustment_id,
            adj.reason AS adjustment_reason
       FROM account_transaction at
       JOIN savings_account sa ON sa.id = at.savings_account_id
       LEFT JOIN account_adjustment adj
         ON adj.adjustment_transaction_id = at.id
      WHERE at.savings_account_id = ANY($1::uuid[])
        AND at.value_date >= $2::date
        AND at.value_date <= $3::date
      ORDER BY at.value_date ASC, at.created_at ASC
      LIMIT ${MAX_REPORT_ROWS}`,
    [accountIds, from, to],
  );

  const entries: CustomerStatementEntry[] = [];
  let closingBalance = openingBalance;
  for (const row of txnResult.rows) {
    const entry: CustomerStatementEntry = {
      date: row.value_date,
      productType: 'savingsDeposit',
      accountId: row.savings_account_id,
      description: statementDescription(row),
      balance: row.balance_after,
    };
    if (row.direction === 'debit') entry.debit = row.amount;
    if (row.direction === 'credit') entry.credit = row.amount;
    if (row.adjustment_id) {
      entry.correctionNote = row.adjustment_reason ?? 'Adjustment entry';
    }
    if (row.reversal_of) entry.reversalOf = row.reversal_of;
    closingBalance = row.balance_after;
    entries.push(entry);
  }

  return {
    customer: {
      id: customer.id,
      fullName: customer.full_name,
      customerCode: customer.customer_number ?? '',
    },
    accounts: accounts.map((account): CustomerStatementAccount => ({
      id: account.id,
      accountNumber: account.account_number,
      productType: 'savingsDeposit',
      status: account.status,
      currentBalance: account.current_balance,
    })),
    period: { from, to },
    entries,
    openingBalance,
    closingBalance,
  };
}

