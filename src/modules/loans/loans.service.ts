/**
 * Loans domain service (docs/backend-master-spec.md §12).
 *
 * Lifecycle:
 *   createApplication  (loans.application.submitted)
 *     -> recommendApplication (loans.application.recommended)
 *     -> approveApplication  (loans.application.approved / rejected)
 *     -> disburseLoan        (loans.loan.disbursed)  materialises guarantors +
 *                            collateral, generates the flat-interest schedule
 *     -> recordRepayment     (loans.repayment.recorded) allocation engine with
 *                            product-configurable component order; any surplus
 *                            above the instalment is held on the loan account
 *     -> correctRepayment    (M.D. correction of one instalment)
 *     -> rescheduleLoan      (loans.loan.rescheduled)
 *     -> settleLoan          (loans.loan.settled)      terminal
 *     -> writeOffLoan        (loans.loan.written_off)  terminal
 *     -> transferLoan        (branch change recorded as a refinance restructure)
 *     -> waiver              (loans.loan.waived)       President
 *     -> surplusRelease      (loans.surplus.released)  only on terminal loans
 *
 * Interest is flat on the approved amount (spec §12.1). Instalments due on a
 * Sunday shift to the next working day. A short payment is applied interest
 * first, then per the product's allocation order. A surplus above the
 * instalment is held in the loan account and released only once the loan is
 * completed.
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS, type AuditEventInput } from '../../audit/audit-writer.js';
import { addDays, addMonths, istBusinessDate, isSunday } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import { allocateSequence } from '../../database/numbering.js';
import {
  addMoney,
  allocateByWeights,
  compareMoney,
  fromCents,
  isZero,
  percentOf,
  subMoney,
  toCents,
  BUSINESS_RULES,
} from '../../core/money.js';
import type {
  ApproveInput,
  CollateralInput,
  CorrectRepaymentInput,
  CreateApplicationInput,
  CreateProductInput,
  DisburseInput,
  GuarantorInput,
  ListApplicationsQuery,
  ListLoansQuery,
  ListProductsQuery,
  LoanApplicationStatus,
  LoanCategory,
  LoanInstalmentStatus,
  LoanInterestMethod,
  LoanRatePolicy,
  LoanRepaymentFrequency,
  LoanStatus,
  PaymentMethod,
  RecommendInput,
  RecordRepaymentInput,
  RescheduleInput,
  RestructureChangeType,
  ScheduleQuery,
  SettleInput,
  StatementsQuery,
  SurplusReleaseInput,
  TransferInput,
  WaiverInput,
  WriteOffInput,
} from './loans.schemas.js';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Open loans accept repayments, reschedules and waivers. */
const OPEN_LOAN_STATUSES: LoanStatus[] = ['active', 'overdue', 'rescheduled'];

/** Terminal loans no longer accept any money movement. */
const TERMINAL_LOAN_STATUSES: LoanStatus[] = ['settled', 'written_off', 'closed'];

const MAX_SCHEDULE_INSTALMENTS = 10_000;

/** Repayment allocation components — the order is product-configurable. */
type AllocationComponent = 'interest' | 'penalty' | 'fees' | 'principal';

/** Actions not covered by the shared audit catalogue (read views, transfers, corrections). */
const ACTION_PRODUCT_CREATED = 'loans.product.created';
const ACTION_LOAN_VIEWED = 'loans.loan.viewed';
const ACTION_SCHEDULE_VIEWED = 'loans.schedule.viewed';
const ACTION_STATEMENTS_VIEWED = 'loans.statements.viewed';
const ACTION_LOAN_TRANSFERRED = 'loans.loan.transferred';
const ACTION_REPAYMENT_CORRECTED = 'loans.repayment.corrected';

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface LoanProductView {
  id: string;
  code: string;
  name: string;
  category: LoanCategory;
  minAmount: string;
  maxAmount: string;
  minTenureMonths: number;
  maxTenureMonths: number;
  interestMethod: LoanInterestMethod;
  interestRate: string;
  ratePolicy: LoanRatePolicy;
  repaymentFrequency: LoanRepaymentFrequency;
  penaltyConfig: Record<string, unknown>;
  allocationOrder: AllocationComponent[];
  guarantorLimit: number;
  collateralRequired: boolean;
  maxLtvPercent: string;
  allowedPurposes: string[] | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface LoanApplicationView {
  id: string;
  applicationNumber: string;
  customerId: string;
  customerName: string;
  customerNumber: string | null;
  productId: string;
  productCode: string;
  productName: string;
  branchId: string | null;
  purpose: string;
  requestedAmount: string;
  approvedAmount: string | null;
  tenureMonths: number;
  repaymentFrequency: LoanRepaymentFrequency;
  proposedInterestRate: string | null;
  finalInterestRate: string | null;
  approvedTenureMonths: number | null;
  status: LoanApplicationStatus;
  appliedOn: string;
  appliedBy: string | null;
  appliedByName: string | null;
  appliedByCode: string | null;
  recommendedBy: string | null;
  recommendedByName: string | null;
  recommendedOn: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedOn: string | null;
  rejectionReason: string | null;
  guarantors: GuarantorInput[];
  collateral: CollateralInput[];
  documents: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface LoanView {
  id: string;
  loanNumber: string;
  applicationNumber: string;
  customerId: string;
  customerName: string;
  customerNumber: string | null;
  productId: string;
  productCode: string;
  productName: string;
  purpose: string;
  documents: Record<string, unknown>;
  branchId: string;
  branchName: string;
  status: LoanStatus;
  approvedAmount: string;
  disbursedAmount: string;
  disbursedOn: string | null;
  disbursedBy: string | null;
  disbursedByName: string | null;
  disbursedByCode: string | null;
  tenureMonths: number;
  repaymentFrequency: LoanRepaymentFrequency;
  interestMethod: LoanInterestMethod;
  interestRate: string;
  flatInterestTotal: string;
  totalPayable: string;
  totalPaid: string;
  outstandingAmount: string;
  nextDueDate: string | null;
  againstFdAccountId: string | null;
  closedOn: string | null;
  closureType: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Lightweight loan reference returned by lifecycle actions. */
export interface LoanRefView {
  id: string;
  loanNumber: string;
  applicationNumber: string;
  customerId: string;
  productId: string;
  amount: string;
  totalPayable: string;
  totalPaid: string;
  status: LoanStatus;
  instalmentCount: number;
  nextDueDate: string | null;
  createdAt: string;
}

export interface InstalmentView {
  id: string;
  instalmentNumber: number;
  dueDate: string;
  expectedAmount: string;
  principalComponent: string;
  interestComponent: string;
  penaltyComponent: string;
  feesComponent: string;
  paidAmount: string;
  status: LoanInstalmentStatus;
  paidOn: string | null;
  allocation: AllocationEvent[] | null;
  createdAt: string;
  updatedAt: string;
}

export interface ScheduleChangeView {
  id: string;
  loanId: string;
  changeType: RestructureChangeType;
  oldTerms: Record<string, unknown>;
  newTerms: Record<string, unknown>;
  reason: string;
  approvedBy: string;
  approvedByName: string | null;
  approvedOn: string;
  effectiveFrom: string;
  createdAt: string;
}

/** One payment applied to one instalment, with the component split. */
export interface AllocationEvent {
  paidOn: string;
  amount: string;
  paymentMethod?: PaymentMethod;
  referenceNumber?: string | null;
  sourceCollectionId?: string | null;
  corrected?: boolean;
  components: {
    interest: string;
    penalty: string;
    fees: string;
    principal: string;
  };
}

export interface AllocationEventView {
  instalmentId: string;
  instalmentNumber: number;
  amount: string;
  status: LoanInstalmentStatus;
  components: {
    interest: string;
    penalty: string;
    fees: string;
    principal: string;
  };
}

export interface LoanProductListResult {
  items: LoanProductView[];
  total: number;
}

export interface LoanApplicationListResult {
  items: LoanApplicationView[];
  total: number;
}

export interface LoanListResult {
  items: LoanView[];
  total: number;
}

export interface LoanDetailView {
  loan: LoanView;
  instalments: InstalmentView[];
  instalmentCount: number;
}

export interface ScheduleView {
  loan: LoanRefView;
  items: InstalmentView[];
  total: number;
}

export interface RepaymentResult {
  loan: LoanRefView;
  instalments: AllocationEventView[];
  surplusHeld: string | null;
  outstandingAmount: string;
}

export interface CorrectRepaymentResult {
  loan: LoanRefView;
  instalment: InstalmentView;
}

export interface RescheduleResult {
  loan: LoanRefView;
  scheduleChange: ScheduleChangeView;
}

export interface SettleResult {
  loan: LoanRefView;
}

export interface WriteOffResult {
  loan: LoanRefView;
  writeOffId: string;
  amount: string;
}

export interface TransferResult {
  loan: LoanRefView;
}

export interface WaiverResult {
  loan: LoanRefView;
  instalment: InstalmentView | null;
  waivedAmount: string;
}

export interface SurplusReleaseResult {
  releasedAmount: string;
  heldBalance: string;
}

export interface StatementEntryView {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actorStaffId: string | null;
  actorStaffName: string | null;
  actorStaffCode: string | null;
  actorRole: string | null;
  source: string | null;
  createdAt: string;
  metadata: Record<string, unknown> | null;
}

export interface StatementView {
  loan: LoanRefView;
  items: StatementEntryView[];
  total: number;
}

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

type IdRow = { id: string };

type CustomerEligibilityRow = { id: string; status: string; branch_id: string | null };

type LoanProductRow = {
  id: string;
  code: string;
  name: string;
  category: string;
  min_amount: string;
  max_amount: string;
  min_tenure_months: number;
  max_tenure_months: number;
  interest_method: string;
  interest_rate: string;
  rate_policy: string;
  repayment_frequency: string;
  penalty_config: Record<string, unknown>;
  allocation_order: string[];
  guarantor_limit: number;
  collateral_required: boolean;
  max_ltv_percent: string;
  allowed_purposes: string[] | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  total?: number;
};

type ApplicationDocuments = {
  branchId?: string;
  guarantors?: GuarantorInput[];
  collateral?: CollateralInput[];
  approvedTenureMonths?: number;
  finalInterestRate?: string;
};

type LoanApplicationRow = {
  id: string;
  application_number: string;
  customer_id: string;
  customer_name: string;
  customer_number: string | null;
  product_id: string;
  product_code: string;
  product_name: string;
  purpose: string;
  requested_amount: string;
  approved_amount: string | null;
  tenure_months: number;
  repayment_frequency: string;
  proposed_interest_rate: string | null;
  status: string;
  applied_on: string;
  applied_by: string | null;
  applied_by_name: string | null;
  applied_by_code: string | null;
  recommended_by: string | null;
  recommended_by_name: string | null;
  recommended_by_code: string | null;
  recommended_on: Date | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_by_code: string | null;
  approved_on: Date | null;
  rejection_reason: string | null;
  documents: unknown;
  created_at: Date;
  updated_at: Date;
  total?: number;
};

type LoanRow = {
  id: string;
  loan_number: string;
  application_id: string;
  application_number: string;
  customer_id: string;
  customer_name: string;
  customer_number: string | null;
  product_id: string;
  product_code: string;
  product_name: string;
  purpose: string;
  documents: unknown;
  branch_id: string;
  branch_name: string;
  status: string;
  approved_amount: string;
  disbursed_amount: string;
  disbursed_on: string | null;
  disbursed_by: string | null;
  disbursed_by_name: string | null;
  disbursed_by_code: string | null;
  tenure_months: number;
  repayment_frequency: string;
  interest_method: string;
  interest_rate: string;
  flat_interest_total: string;
  total_payable: string;
  total_paid: string;
  outstanding_amount: string;
  next_due_date: string | null;
  against_fd_account_id: string | null;
  closed_on: string | null;
  closure_type: string | null;
  created_at: Date;
  updated_at: Date;
  total?: number;
};

type LoanRefRow = {
  id: string;
  loan_number: string;
  application_number: string;
  customer_id: string;
  product_id: string;
  amount: string;
  total_payable: string;
  total_paid: string;
  status: string;
  instalment_count: number;
  next_due_date: string | null;
  created_at: Date;
};

type InstalmentRow = {
  id: string;
  loan_id: string;
  instalment_number: number;
  due_date: string;
  expected_amount: string;
  principal_component: string;
  interest_component: string;
  penalty_component: string;
  fees_component: string;
  paid_amount: string;
  status: string;
  paid_on: string | null;
  allocation: unknown;
  created_at: Date;
  updated_at: Date;
  total?: number;
};

type InstalmentDueRow = {
  id: string;
  instalment_number: number;
  due_date: string;
  expected_amount: string;
  principal_component: string;
  interest_component: string;
  penalty_component: string;
  fees_component: string;
  paid_amount: string;
  status: string;
  allocation: unknown;
};

type LoanTotalsRow = {
  total_paid: string;
  outstanding: string;
  overdue_outstanding: number;
  next_due_date: string | null;
};

type ScheduleChangeRow = {
  id: string;
  loan_id: string;
  change_type: string;
  old_terms: unknown;
  new_terms: unknown;
  reason: string;
  approved_by: string;
  approved_by_name: string | null;
  approved_on: Date;
  effective_from: string;
  created_at: Date;
};

type AuditEntryRow = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_staff_id: string | null;
  actor_staff_name: string | null;
  actor_staff_code: string | null;
  actor_role: string | null;
  source: string | null;
  created_at: Date;
  metadata: unknown;
  total?: number;
};

type SurplusBalanceRow = {
  held: string;
  released: string;
};

// ---------------------------------------------------------------------------
// SELECT fragments
// ---------------------------------------------------------------------------

const PRODUCT_COLUMNS = `
  id, code, name, category,
  min_amount::text AS min_amount, max_amount::text AS max_amount,
  min_tenure_months, max_tenure_months, interest_method,
  interest_rate::text AS interest_rate, rate_policy, repayment_frequency,
  penalty_config, allocation_order, guarantor_limit, collateral_required,
  max_ltv_percent::text AS max_ltv_percent, allowed_purposes, is_active,
  created_at, updated_at`;

const APPLICATION_COLUMNS = `
  la.id, la.application_number, la.customer_id, c.full_name AS customer_name,
  c.customer_number, la.product_id, p.code AS product_code, p.name AS product_name,
  la.purpose, la.requested_amount::text AS requested_amount,
  la.approved_amount::text AS approved_amount, la.tenure_months,
  la.repayment_frequency, la.proposed_interest_rate::text AS proposed_interest_rate,
  la.status, la.applied_on::text AS applied_on,
  la.applied_by, sab.full_name AS applied_by_name,
  sab.staff_code AS applied_by_code, la.recommended_by,
  srb.full_name AS recommended_by_name, srb.staff_code AS recommended_by_code,
  la.recommended_on, la.approved_by, sap.full_name AS approved_by_name,
  sap.staff_code AS approved_by_code, la.approved_on, la.rejection_reason,
  la.documents, la.created_at, la.updated_at`;

const APPLICATION_FROM = `
  FROM loan_application la
  JOIN customer c ON c.id = la.customer_id
  JOIN loan_product p ON p.id = la.product_id
  LEFT JOIN staff sab ON sab.id = la.applied_by
  LEFT JOIN staff srb ON srb.id = la.recommended_by
  LEFT JOIN staff sap ON sap.id = la.approved_by`;

const LOAN_COLUMNS = `
  l.id, l.loan_number, l.application_id,
  la.application_number, l.customer_id, c.full_name AS customer_name,
  c.customer_number, l.product_id, p.code AS product_code, p.name AS product_name,
  la.purpose, la.documents,
  l.branch_id, b.name AS branch_name,
  l.status, l.approved_amount::text AS approved_amount,
  l.disbursed_amount::text AS disbursed_amount,
  l.disbursed_on::text AS disbursed_on,
  l.disbursed_by, sdb.full_name AS disbursed_by_name,
  sdb.staff_code AS disbursed_by_code, l.tenure_months,
  l.repayment_frequency, l.interest_method,
  l.interest_rate::text AS interest_rate,
  l.flat_interest_total::text AS flat_interest_total,
  l.total_payable::text AS total_payable,
  l.total_paid::text AS total_paid,
  l.outstanding_amount::text AS outstanding_amount,
  l.next_due_date::text AS next_due_date,
  l.against_fd_account_id, l.closed_on::text AS closed_on, l.closure_type,
  l.created_at, l.updated_at`;

const LOAN_FROM = `
  FROM loan l
  JOIN loan_application la ON la.id = l.application_id
  JOIN customer c ON c.id = l.customer_id
  JOIN loan_product p ON p.id = l.product_id
  JOIN branch b ON b.id = l.branch_id
  LEFT JOIN staff sdb ON sdb.id = l.disbursed_by`;

const LOAN_REF_COLUMNS = `
  l.id, l.loan_number, la.application_number, l.customer_id, l.product_id,
  l.approved_amount::text AS amount, l.total_payable::text AS total_payable,
  l.total_paid::text AS total_paid, l.status,
  l.next_due_date::text AS next_due_date,
  l.created_at,
  (SELECT COUNT(*)::int
     FROM loan_instalment li
    WHERE li.loan_id = l.id) AS instalment_count`;

const LOAN_REF_FROM = `
  FROM loan l
  JOIN loan_application la ON la.id = l.application_id`;

const INSTALMENT_COLUMNS = `
  id, loan_id, instalment_number, due_date::text AS due_date,
  expected_amount::text AS expected_amount,
  principal_component::text AS principal_component,
  interest_component::text AS interest_component,
  penalty_component::text AS penalty_component,
  fees_component::text AS fees_component,
  paid_amount::text AS paid_amount, status,
  paid_on::text AS paid_on, allocation, created_at, updated_at`;

const SCHEDULE_CHANGE_SELECT = `
  SELECT sr.id, sr.loan_id, sr.change_type,
         sr.old_terms, sr.new_terms, sr.reason,
         sr.approved_by, sap.full_name AS approved_by_name,
         sr.approved_on, sr.effective_from::text AS effective_from, sr.created_at
    FROM loan_restructure sr
    LEFT JOIN staff sap ON sap.id = sr.approved_by
`;

const AUDIT_ENTRY_SELECT = `
  SELECT ae.id, ae.action, ae.entity_type, ae.entity_id,
         ae.actor_staff_id, sa.full_name AS actor_staff_name,
         sa.staff_code AS actor_staff_code, ae.actor_role,
         ae.source, ae.created_at, ae.metadata
    FROM audit_event ae
    LEFT JOIN staff sa ON sa.id = ae.actor_staff_id
`;

// ---------------------------------------------------------------------------
// Helpers
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

function actorAuditBase(actor: AuthContext) {
  return {
    actorStaffId: actor.staffId,
    actorRole: actor.role,
    actorStaffCode: actor.staffCode,
    source: actor.source as AuditEventInput['source'],
    requestId: null as string | null,
  };
}

const iso = (value: Date | null | undefined): string | null =>
  value ? value.toISOString() : null;

/** Autocommit adapter for audit events written outside a mutation transaction (reads). */
function poolForEvent(): PoolClient {
  return { query: (text: string, params?: ReadonlyArray<unknown>) => query(text, params) } as unknown as PoolClient;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === '23505';
}

async function assertBranchExists(client: PoolClient, branchId: string): Promise<void> {
  const result = await client.query(`SELECT 1 FROM branch WHERE id = $1`, [branchId]);
  if (result.rows.length === 0) {
    throw new BadRequestError('Branch does not exist');
  }
}

async function selectCustomerEligibility(client: PoolClient, customerId: string): Promise<CustomerEligibilityRow | null> {
  const result = await client.query<CustomerEligibilityRow>(
    `SELECT id, status, branch_id FROM customer WHERE id = $1 LIMIT 1`,
    [customerId],
  );
  return result.rows[0] ?? null;
}

/** A loan can only be disbursed for a customer whose record is not terminal. */
async function assertCustomerEligible(client: PoolClient, customerId: string): Promise<void> {
  const customer = await selectCustomerEligibility(client, customerId);
  if (!customer) throw new NotFoundError('Customer');
  // 'restricted' (data-subject restriction) and 'deleted' (data-subject soft
  // delete, spec §24.2) also freeze new loan disbursement.
  if (
    customer.status === 'deceased' ||
    customer.status === 'closed' ||
    customer.status === 'restricted' ||
    customer.status === 'deleted'
  ) {
    throw new BusinessRuleError(
      `Customer is ${customer.status}; no loan can be disbursed for this profile`,
      'CUSTOMER_NOT_ELIGIBLE',
    );
  }
}

/** Shift a Sunday due date forward to the next working day (Monday). */
function toWorkingDay(date: string): string {
  let shifted = date;
  while (isSunday(shifted)) {
    shifted = addDays(shifted, 1);
  }
  return shifted;
}

/** Next schedule step from `date` for a repayment frequency. */
function nextStep(date: string, frequency: LoanRepaymentFrequency): string {
  switch (frequency) {
    case 'daily':
      return addDays(date, 1);
    case 'weekly':
      return addDays(date, 7);
    case 'monthly':
      return addMonths(date, 1);
    case 'quarterly':
      return addMonths(date, 3);
  }
}

/**
 * Simple interest over a whole term (spec §12.1: interest = amount × rate% ×
 * tenureMonths/12, flat on the original approved amount). The rate is
 * NUMERIC(7,4), so the computation avoids the two-decimal `percentOf` helper
 * and works on BigInt paise directly:
 *   interestPaise = amountPaise × rateE4 × tenureMonths / 12_000_000
 * where rateE4 = round(rate × 10_000).
 */
function simpleInterest(amount: string, rate: string, tenureMonths: number): string {
  const rateE4 = BigInt(Math.round(Number(rate) * 10_000));
  const interestCents = (toCents(amount) * rateE4 * BigInt(tenureMonths)) / 12_000_000n;
  return fromCents(interestCents);
}

/**
 * The application row carries branch_id, guarantors, collateral and approval
 * terms in its documents JSONB. When absent (older rows) the callers fall back
 * to the visible columns or the product defaults.
 */
function parseApplicationDocuments(value: unknown): ApplicationDocuments {
  if (typeof value !== 'object' || value === null) return {};
  const record = value as Record<string, unknown>;
  const documents: ApplicationDocuments = {};
  if (typeof record['branchId'] === 'string') documents.branchId = record['branchId'];
  if (Array.isArray(record['guarantors'])) documents.guarantors = record['guarantors'] as GuarantorInput[];
  if (Array.isArray(record['collateral'])) documents.collateral = record['collateral'] as CollateralInput[];
  if (typeof record['approvedTenureMonths'] === 'number') {
    documents.approvedTenureMonths = record['approvedTenureMonths'];
  }
  if (typeof record['finalInterestRate'] === 'string') {
    documents.finalInterestRate = record['finalInterestRate'];
  }
  return documents;
}

// ---------------------------------------------------------------------------
// Mappers and loaders
// ---------------------------------------------------------------------------

function toRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function toLoanProductView(row: LoanProductRow): LoanProductView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    category: row.category as LoanCategory,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    minTenureMonths: row.min_tenure_months,
    maxTenureMonths: row.max_tenure_months,
    interestMethod: row.interest_method as LoanInterestMethod,
    interestRate: row.interest_rate,
    ratePolicy: row.rate_policy as LoanRatePolicy,
    repaymentFrequency: row.repayment_frequency as LoanRepaymentFrequency,
    penaltyConfig: row.penalty_config,
    allocationOrder: row.allocation_order as AllocationComponent[],
    guarantorLimit: row.guarantor_limit,
    collateralRequired: row.collateral_required,
    maxLtvPercent: row.max_ltv_percent,
    allowedPurposes: row.allowed_purposes,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function selectProductById(client: PoolClient, productId: string): Promise<LoanProductRow | null> {
  const result = await client.query<LoanProductRow>(
    `SELECT ${PRODUCT_COLUMNS} FROM loan_product WHERE id = $1 LIMIT 1`,
    [productId],
  );
  return result.rows[0] ?? null;
}

async function loadProduct(client: PoolClient, productId: string): Promise<LoanProductView> {
  const row = await selectProductById(client, productId);
  if (!row) throw new NotFoundError('Loan product');
  return toLoanProductView(row);
}

function toLoanApplicationView(row: LoanApplicationRow): LoanApplicationView {
  const documents = parseApplicationDocuments(row.documents);
  return {
    id: row.id,
    applicationNumber: row.application_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerNumber: row.customer_number,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    branchId: documents.branchId ?? null,
    purpose: row.purpose,
    requestedAmount: row.requested_amount,
    approvedAmount: row.approved_amount,
    tenureMonths: row.tenure_months,
    repaymentFrequency: row.repayment_frequency as LoanRepaymentFrequency,
    proposedInterestRate: row.proposed_interest_rate,
    finalInterestRate: documents.finalInterestRate ?? null,
    approvedTenureMonths: documents.approvedTenureMonths ?? null,
    status: row.status as LoanApplicationStatus,
    appliedOn: row.applied_on,
    appliedBy: row.applied_by,
    appliedByName: row.applied_by_name,
    appliedByCode: row.applied_by_code,
    recommendedBy: row.recommended_by,
    recommendedByName: row.recommended_by_name,
    recommendedOn: iso(row.recommended_on),
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedOn: iso(row.approved_on),
    rejectionReason: row.rejection_reason,
    guarantors: documents.guarantors ?? [],
    collateral: documents.collateral ?? [],
    documents: toRecord(row.documents),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function selectLoanApplicationById(client: PoolClient, applicationId: string): Promise<LoanApplicationRow | null> {
  const result = await client.query<LoanApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS} ${APPLICATION_FROM} WHERE la.id = $1 LIMIT 1`,
    [applicationId],
  );
  return result.rows[0] ?? null;
}

async function loadLoanApplication(client: PoolClient, applicationId: string): Promise<LoanApplicationView> {
  const row = await selectLoanApplicationById(client, applicationId);
  if (!row) throw new NotFoundError('Loan application');
  return toLoanApplicationView(row);
}

function toLoanView(row: LoanRow): LoanView {
  return {
    id: row.id,
    loanNumber: row.loan_number,
    applicationNumber: row.application_number,
    customerId: row.customer_id,
    customerName: row.customer_name,
    customerNumber: row.customer_number,
    productId: row.product_id,
    productCode: row.product_code,
    productName: row.product_name,
    purpose: row.purpose,
    documents: toRecord(row.documents),
    branchId: row.branch_id,
    branchName: row.branch_name,
    status: row.status as LoanStatus,
    approvedAmount: row.approved_amount,
    disbursedAmount: row.disbursed_amount,
    disbursedOn: row.disbursed_on,
    disbursedBy: row.disbursed_by,
    disbursedByName: row.disbursed_by_name,
    disbursedByCode: row.disbursed_by_code,
    tenureMonths: row.tenure_months,
    repaymentFrequency: row.repayment_frequency as LoanRepaymentFrequency,
    interestMethod: row.interest_method as LoanInterestMethod,
    interestRate: row.interest_rate,
    flatInterestTotal: row.flat_interest_total,
    totalPayable: row.total_payable,
    totalPaid: row.total_paid,
    outstandingAmount: row.outstanding_amount,
    nextDueDate: row.next_due_date,
    againstFdAccountId: row.against_fd_account_id,
    closedOn: row.closed_on,
    closureType: row.closure_type,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function selectLoanById(client: PoolClient, loanId: string): Promise<LoanRow | null> {
  const result = await client.query<LoanRow>(
    `SELECT ${LOAN_COLUMNS} ${LOAN_FROM} WHERE l.id = $1 LIMIT 1`,
    [loanId],
  );
  return result.rows[0] ?? null;
}

async function loadLoan(client: PoolClient, loanId: string): Promise<LoanView> {
  const row = await selectLoanById(client, loanId);
  if (!row) throw new NotFoundError('Loan');
  return toLoanView(row);
}

function toInstalmentView(row: InstalmentRow): InstalmentView {
  return {
    id: row.id,
    instalmentNumber: row.instalment_number,
    dueDate: row.due_date,
    expectedAmount: row.expected_amount,
    principalComponent: row.principal_component,
    interestComponent: row.interest_component,
    penaltyComponent: row.penalty_component,
    feesComponent: row.fees_component,
    paidAmount: row.paid_amount,
    status: row.status as LoanInstalmentStatus,
    paidOn: row.paid_on,
    allocation: Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function selectInstalmentsByIds(client: PoolClient, loanId: string, ids: string[]): Promise<InstalmentRow[]> {
  if (ids.length === 0) return [];
  const result = await client.query<InstalmentRow>(
    `SELECT ${INSTALMENT_COLUMNS}
       FROM loan_instalment
      WHERE loan_id = $1 AND id = ANY($2::uuid[])
      ORDER BY instalment_number`,
    [loanId, ids],
  );
  return result.rows;
}

async function selectInstalmentsForLoan(client: PoolClient, loanId: string): Promise<InstalmentRow[]> {
  const result = await client.query<InstalmentRow>(
    `SELECT ${INSTALMENT_COLUMNS}
       FROM loan_instalment
      WHERE loan_id = $1
      ORDER BY instalment_number`,
    [loanId],
  );
  return result.rows;
}

function toLoanRefView(row: LoanRefRow): LoanRefView {
  return {
    id: row.id,
    loanNumber: row.loan_number,
    applicationNumber: row.application_number,
    customerId: row.customer_id,
    productId: row.product_id,
    amount: row.amount,
    totalPayable: row.total_payable,
    totalPaid: row.total_paid,
    status: row.status as LoanStatus,
    instalmentCount: row.instalment_count,
    nextDueDate: row.next_due_date,
    createdAt: row.created_at.toISOString(),
  };
}

async function loadLoanRef(client: PoolClient, loanId: string): Promise<LoanRefView> {
  const result = await client.query<LoanRefRow>(
    `SELECT ${LOAN_REF_COLUMNS} ${LOAN_REF_FROM} WHERE l.id = $1 LIMIT 1`,
    [loanId],
  );
  const row = result.rows[0] ?? null;
  if (!row) throw new NotFoundError('Loan');
  return toLoanRefView(row);
}

function toScheduleChangeView(row: ScheduleChangeRow): ScheduleChangeView {
  return {
    id: row.id,
    loanId: row.loan_id,
    changeType: row.change_type as RestructureChangeType,
    oldTerms: toRecord(row.old_terms),
    newTerms: toRecord(row.new_terms),
    reason: row.reason,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedOn: row.approved_on.toISOString(),
    effectiveFrom: row.effective_from,
    createdAt: row.created_at.toISOString(),
  };
}

async function selectScheduleChangeById(client: PoolClient, changeId: string): Promise<ScheduleChangeRow | null> {
  const result = await client.query<ScheduleChangeRow>(
    `${SCHEDULE_CHANGE_SELECT} WHERE sr.id = $1 LIMIT 1`,
    [changeId],
  );
  return result.rows[0] ?? null;
}

function toAuditEntryView(row: AuditEntryRow): StatementEntryView {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    actorStaffId: row.actor_staff_id,
    actorStaffName: row.actor_staff_name,
    actorStaffCode: row.actor_staff_code,
    actorRole: row.actor_role,
    source: row.source,
    createdAt: row.created_at.toISOString(),
    metadata: row.metadata === null || row.metadata === undefined ? null : toRecord(row.metadata),
  };
}

async function selectAuditEntries(
  client: PoolClient,
  loanId: string,
  limit: number,
  offset: number,
): Promise<AuditEntryRow[]> {
  const result = await client.query<AuditEntryRow>(
    `${AUDIT_ENTRY_SELECT}
      WHERE ae.entity_type = 'loan' AND ae.entity_id = $1
      ORDER BY ae.created_at DESC
      LIMIT $2 OFFSET $3`,
    [loanId, limit, offset],
  );
  return result.rows;
}

// ---------------------------------------------------------------------------
// Recompute + sweep
// ---------------------------------------------------------------------------

/**
 * Recompute a loan's running totals from its instalment ledger and refresh the
 * loan row. An instalment still carrying an outstanding balance is counted as
 * overdue once its due date is strictly before today's business date
 * (spec §12.1). Terminal states (settled / written_off / closed) are never
 * demoted; every other state is promoted to 'overdue' while any instalment is
 * genuinely past due.
 */
async function recomputeLoanTotals(client: PoolClient, loanId: string): Promise<LoanTotalsRow> {
  const today = istBusinessDate();
  const result = await client.query<LoanTotalsRow>(
    `SELECT COALESCE(SUM(paid_amount), 0)::numeric::text AS total_paid,
            COALESCE(SUM(expected_amount - paid_amount)
              FILTER (WHERE status IN ('due','partial','missed','overdue')), 0)::numeric::text
              AS outstanding,
            COALESCE(COUNT(*) FILTER (
              WHERE status IN ('due','partial','missed','overdue')
                AND expected_amount > paid_amount
                AND due_date < $2::date), 0)::int AS overdue_outstanding,
            MIN(due_date) FILTER (WHERE status IN ('due','partial','missed','overdue'))::text
              AS next_due_date
       FROM loan_instalment
      WHERE loan_id = $1`,
    [loanId, today],
  );
  const totals = result.rows[0] ?? {
    total_paid: '0.00',
    outstanding: '0.00',
    overdue_outstanding: 0,
    next_due_date: null,
  };

  await client.query(
    `UPDATE loan
        SET total_paid = $1::numeric,
            outstanding_amount = $2::numeric,
            next_due_date = $3::date,
            status = CASE
              WHEN status IN ('settled','written_off','closed') THEN status
              WHEN $4::int > 0 THEN 'overdue'
              ELSE status
            END,
            updated_at = now()
      WHERE id = $5`,
    [totals.total_paid, totals.outstanding, totals.next_due_date, totals.overdue_outstanding, loanId],
  );

  return totals;
}

/**
 * Daily sweep (spec §12.1): an instalment wholly unpaid past its due date
 * becomes 'missed', a partially paid one becomes 'overdue'. Loans carry no
 * grace period and no late penalty is created here. Runs at the start of every
 * financial mutation so loan state never drifts; affected loans are re-totalled
 * inline. No per-flip audit is written.
 */
async function sweepMissedInstalments(client: PoolClient): Promise<void> {
  const today = istBusinessDate();
  const flipped = await client.query<{ loan_id: string }>(
    `UPDATE loan_instalment li
        SET status = CASE WHEN li.paid_amount > 0 THEN 'overdue' ELSE 'missed' END,
            updated_at = now()
      FROM (
        SELECT id FROM loan_instalment
         WHERE status IN ('due','partial') AND due_date < $1::date
      ) sel
     WHERE li.id = sel.id
     RETURNING li.loan_id`,
    [today],
  );

  const loanIds = [...new Set(flipped.rows.map((row) => row.loan_id))];
  for (const loanId of loanIds) {
    await recomputeLoanTotals(client, loanId);
  }
}

// ---------------------------------------------------------------------------
// Loan products — list, create
// ---------------------------------------------------------------------------

/**
 * List loan products (spec §12.3). Reads are never audited; the caller is
 * ignored unless a future data-scoping rule requires it.
 */
export async function listProducts(
  actor: AuthContext,
  queryInput: ListProductsQuery,
  meta: RequestMeta = {},
): Promise<LoanProductListResult> {
  void actor;
  void meta;
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (queryInput.search) {
    const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    where.push(
      `(p.code ILIKE ${addParam(pattern)} ESCAPE '\\' OR p.name ILIKE ${addParam(pattern)} ESCAPE '\\')`,
    );
  }
  if (queryInput.category) {
    where.push(`p.category = ${addParam(queryInput.category)}`);
  }
  if (queryInput.includeInactive !== 'true') {
    where.push('p.is_active = true');
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<LoanProductRow>(
    `SELECT ${PRODUCT_COLUMNS},
            count(*) OVER()::int AS total
       FROM loan_product p
       ${whereSql}
      ORDER BY p.name ASC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): LoanProductView => toLoanProductView(row));
  return { total, items };
}

/**
 * Create a loan product (spec §12.3, product configuration). Products are
 * active from creation. Codes are unique — a duplicate surfaces a
 * PRODUCT_CODE_EXISTS conflict.
 */
export async function createProduct(
  actor: AuthContext,
  input: CreateProductInput,
  meta: RequestMeta = {},
): Promise<LoanProductView> {
  const created = await transaction<LoanProductView>(async (client) => {
    let productId: string;
    try {
      const insert = await client.query<IdRow>(
        `INSERT INTO loan_product
           (code, name, category, min_amount, max_amount, min_tenure_months,
            max_tenure_months, interest_method, interest_rate, rate_policy,
            repayment_frequency, penalty_config, allocation_order, guarantor_limit,
            collateral_required, max_ltv_percent, allowed_purposes, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 $12::jsonb, $13, $14, $15, $16, $17, true)
         RETURNING id`,
        [
          input.code,
          input.name,
          input.category,
          input.minAmount,
          input.maxAmount,
          input.minTenureMonths,
          input.maxTenureMonths,
          input.interestMethod,
          input.interestRate,
          input.ratePolicy,
          input.repaymentFrequency,
          JSON.stringify(input.penaltyConfig ?? {}),
          input.allocationOrder,
          input.guarantorLimit,
          input.collateralRequired,
          input.maxLtvPercent,
          input.allowedPurposes ?? null,
        ],
      );
      const inserted = insert.rows[0];
      if (!inserted) throw new Error('failed to create loan product');
      productId = inserted.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('A loan product with this code already exists', 'PRODUCT_CODE_EXISTS');
      }
      throw error;
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_PRODUCT_CREATED,
      entityType: 'loan_product',
      entityId: productId,
      metadata: {
        code: input.code,
        name: input.name,
        category: input.category,
        interestMethod: input.interestMethod,
        interestRate: input.interestRate,
        repaymentFrequency: input.repaymentFrequency,
        createdBy: actor.staffId,
      },
    });

    return loadProduct(client, productId);
  });
  return created;
}

// ---------------------------------------------------------------------------
// Loan applications — list, create, recommend, approve
// ---------------------------------------------------------------------------

/**
 * List loan applications (spec §12.3). Filters: application/customer search,
 * customer, product and status. Reads are never audited.
 */
export async function listApplications(
  actor: AuthContext,
  queryInput: ListApplicationsQuery,
  meta: RequestMeta = {},
): Promise<LoanApplicationListResult> {
  void actor;
  void meta;
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (queryInput.search) {
    const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    where.push(
      `(la.application_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\')`,
    );
  }
  if (queryInput.customerId) {
    where.push(`la.customer_id = ${addParam(queryInput.customerId)}`);
  }
  if (queryInput.productId) {
    where.push(`la.product_id = ${addParam(queryInput.productId)}`);
  }
  if (queryInput.status) {
    where.push(`la.status = ${addParam(queryInput.status)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<LoanApplicationRow>(
    `SELECT ${APPLICATION_COLUMNS},
            count(*) OVER()::int AS total
       ${APPLICATION_FROM}
       ${whereSql}
      ORDER BY la.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): LoanApplicationView => toLoanApplicationView(row));
  return { total, items };
}

/**
 * List disbursed loans (spec §12.3). Filters: loan/application/customer
 * search, customer, product and loan status. Reads are never audited.
 * Mirror of listApplications over the loan table.
 */
export async function listLoans(
  actor: AuthContext,
  queryInput: ListLoansQuery,
  meta: RequestMeta = {},
): Promise<LoanListResult> {
  void actor;
  void meta;
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (queryInput.search) {
    const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
    const pattern = `%${escaped}%`;
    where.push(
      `(l.loan_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR la.application_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\')`,
    );
  }
  if (queryInput.customerId) {
    where.push(`l.customer_id = ${addParam(queryInput.customerId)}`);
  }
  if (queryInput.productId) {
    where.push(`l.product_id = ${addParam(queryInput.productId)}`);
  }
  if (queryInput.status) {
    where.push(`l.status = ${addParam(queryInput.status)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<LoanRow>(
    `SELECT ${LOAN_COLUMNS},
            count(*) OVER()::int AS total
       ${LOAN_FROM}
       ${whereSql}
      ORDER BY l.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): LoanView => toLoanView(row));
  return { total, items };
}

/**
 * Open a new loan application (spec §12.3). The customer, branch and product
 * must all be live; requested terms are validated against the product envelope
 * (amount, tenure, frequency), and the product's guarantor / collateral
 * requirements are checked up front. Guarantor and collateral captures, plus
 * the branch, are stored in the application documents JSONB and materialised
 * on disbursal. The application leaves the queue as 'applied'.
 */
export async function createApplication(
  actor: AuthContext,
  input: CreateApplicationInput,
  meta: RequestMeta = {},
): Promise<LoanApplicationView> {
  const created = await transaction<LoanApplicationView>(async (client) => {
    await assertBranchExists(client, input.branchId);
    await assertCustomerEligible(client, input.customerId);

    const product = await selectProductById(client, input.productId);
    if (!product) throw new NotFoundError('Loan product');
    if (!product.is_active) {
      throw new BusinessRuleError('This loan product is not active', 'LOAN_PRODUCT_INACTIVE');
    }
    if (compareMoney(input.requestedAmount, product.min_amount) < 0) {
      throw new BusinessRuleError(
        `Requested amount is below the product minimum of ${product.min_amount}`,
        'AMOUNT_BELOW_PRODUCT_MIN',
      );
    }
    if (compareMoney(input.requestedAmount, product.max_amount) > 0) {
      throw new BusinessRuleError(
        `Requested amount exceeds the product maximum of ${product.max_amount}`,
        'AMOUNT_ABOVE_PRODUCT_MAX',
      );
    }
    if (input.tenureMonths < product.min_tenure_months || input.tenureMonths > product.max_tenure_months) {
      throw new BusinessRuleError(
        `Tenure ${input.tenureMonths} months falls outside the product's ${product.min_tenure_months}–${product.max_tenure_months} month range`,
        'TERM_OUTSIDE_PRODUCT',
      );
    }
    if (input.repaymentFrequency !== product.repayment_frequency) {
      throw new BusinessRuleError(
        `Repayment frequency ${input.repaymentFrequency} does not match the loan product's ${product.repayment_frequency}`,
        'FREQUENCY_MISMATCH',
      );
    }
    const guarantors = input.guarantors ?? [];
    const collateral = input.collateral ?? [];
    if (guarantors.length > product.guarantor_limit) {
      throw new BusinessRuleError(
        `This product allows at most ${product.guarantor_limit} guarantor(s)`,
        'GUARANTOR_LIMIT_EXCEEDED',
      );
    }
    if (product.collateral_required && collateral.length === 0) {
      throw new BusinessRuleError(
        'This product requires collateral security; none was provided',
        'COLLATERAL_REQUIRED',
      );
    }
    if (collateral.length > 0) {
      const valuation = collateral.reduce((sum, item) => addMoney(sum, item.valuationAmount), '0.00');
      const maxSecured = percentOf(valuation, product.max_ltv_percent);
      if (compareMoney(input.requestedAmount, maxSecured) > 0) {
        throw new BusinessRuleError(
          `Collateral of ${valuation} supports at most ${product.max_ltv_percent}% lending (${maxSecured})`,
          'COLLATERAL_VALUE_INSUFFICIENT',
        );
      }
    }

    const businessDate = istBusinessDate();
    const sequence = await allocateSequence(client, 'loan_application');
    const applicationNumber = sequence.formatted;
    const documents: Record<string, unknown> = {
      ...(input.documents ?? {}),
      branchId: input.branchId,
      guarantors,
      collateral,
    };

    const insert = await client.query<IdRow>(
      `INSERT INTO loan_application
         (application_number, customer_id, product_id, purpose,
          requested_amount, tenure_months, repayment_frequency,
          proposed_interest_rate, status, applied_on, applied_by, documents)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'applied', $9, $10, $11::jsonb)
       RETURNING id`,
      [
        applicationNumber,
        input.customerId,
        input.productId,
        input.purpose,
        input.requestedAmount,
        input.tenureMonths,
        input.repaymentFrequency,
        input.proposedInterestRate ?? null,
        businessDate,
        actor.staffId,
        JSON.stringify(documents),
      ],
    );
    const inserted = insert.rows[0];
    if (!inserted) throw new Error('failed to create loan application');

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_APPLICATION_SUBMITTED,
      entityType: 'loan_application',
      entityId: inserted.id,
      businessDate,
      metadata: {
        applicationNumber,
        customerId: input.customerId,
        productId: input.productId,
        productCode: product.code,
        branchId: input.branchId,
        requestedAmount: input.requestedAmount,
        tenureMonths: input.tenureMonths,
        repaymentFrequency: input.repaymentFrequency,
        proposedInterestRate: input.proposedInterestRate ?? null,
      },
    });

    return loadLoanApplication(client, inserted.id);
  });
  return created;
}

/**
 * Recommend an application for approval (spec §12.3). Only an application in
 * 'applied' state may be recommended; the recommending officer is recorded.
 */
export async function recommendApplication(
  actor: AuthContext,
  applicationId: string,
  _input: RecommendInput,
  meta: RequestMeta = {},
): Promise<LoanApplicationView> {
  void _input;
  const updated = await transaction<LoanApplicationView>(async (client) => {
    const application = await selectLoanApplicationById(client, applicationId);
    if (!application) throw new NotFoundError('Loan application');
    if (application.status !== 'applied') {
      throw new BusinessRuleError(
        `Only an applied application can be recommended (current status: ${application.status})`,
        'APPLICATION_NOT_APPLIED',
      );
    }

    const now = new Date();
    await client.query(
      `UPDATE loan_application
          SET status = 'recommended',
              recommended_by = $1,
              recommended_on = $2,
              updated_at = $2
        WHERE id = $3`,
      [actor.staffId, now, applicationId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_APPLICATION_RECOMMENDED,
      entityType: 'loan_application',
      entityId: applicationId,
      metadata: { applicationNumber: application.application_number },
    });

    return loadLoanApplication(client, applicationId);
  });
  return updated;
}

/**
 * Approve or reject a recommended application (spec §12.3; President, M.D.
 * secondary). Approval fixes the approved amount and records any approved
 * tenure / final rate into the application documents; rejection records a
 * reason. Both decisions audit under loans.application.approved with a
 * `decision` facet so the workflow trail stays on one catalogue action.
 */
export async function approveApplication(
  actor: AuthContext,
  applicationId: string,
  input: ApproveInput,
  meta: RequestMeta = {},
): Promise<LoanApplicationView> {
  const updated = await transaction<LoanApplicationView>(async (client) => {
    const application = await selectLoanApplicationById(client, applicationId);
    if (!application) throw new NotFoundError('Loan application');
    if (application.status !== 'recommended') {
      throw new BusinessRuleError(
        `Only a recommended application can be approved or rejected (current status: ${application.status})`,
        'APPLICATION_NOT_RECOMMENDED',
      );
    }

    const now = new Date();
    if (input.rejectionReason) {
      await client.query(
        `UPDATE loan_application
            SET status = 'rejected',
                rejection_reason = $1,
                approved_by = $2,
                approved_on = $3,
                updated_at = $3
          WHERE id = $4`,
        [input.rejectionReason, actor.staffId, now, applicationId],
      );
      await audit(client, {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.LOAN_APPLICATION_APPROVED,
        entityType: 'loan_application',
        entityId: applicationId,
        metadata: {
          applicationNumber: application.application_number,
          decision: 'rejected',
          rejectionReason: input.rejectionReason,
        },
      });
      return loadLoanApplication(client, applicationId);
    }

    const approvedAmount = input.approvedAmount;
    if (approvedAmount === undefined) {
      throw new BusinessRuleError('approvedAmount is required when approving a loan', 'APPROVED_AMOUNT_REQUIRED');
    }
    const previous = parseApplicationDocuments(application.documents);
    const documents: Record<string, unknown> = { ...toRecord(application.documents) };
    if (input.approvedTenureMonths !== undefined) {
      documents.approvedTenureMonths = input.approvedTenureMonths;
    } else if (previous.approvedTenureMonths === undefined) {
      documents.approvedTenureMonths = application.tenure_months;
    }
    if (input.finalInterestRate !== undefined) {
      documents.finalInterestRate = input.finalInterestRate;
    } else if (previous.finalInterestRate === undefined && application.proposed_interest_rate) {
      documents.finalInterestRate = application.proposed_interest_rate;
    }

    await client.query(
      `UPDATE loan_application
          SET status = 'approved',
              approved_amount = $1::numeric,
              approved_by = $2,
              approved_on = $3,
              documents = $4::jsonb,
              updated_at = $3
        WHERE id = $5`,
      [approvedAmount, actor.staffId, now, JSON.stringify(documents), applicationId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_APPLICATION_APPROVED,
      entityType: 'loan_application',
      entityId: applicationId,
      metadata: {
        applicationNumber: application.application_number,
        decision: 'approved',
        approvedAmount,
        approvedTenureMonths: documents.approvedTenureMonths ?? null,
        finalInterestRate: documents.finalInterestRate ?? null,
      },
    });

    return loadLoanApplication(client, applicationId);
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Disbursal (§12.5) — converts an approved application into a live loan.
// Interest is flat on the approved amount, the schedule is generated with the
// repayment frequency stepping from the disbursal date (Sundays shifted to the
// next working day), and any guarantors / collateral captured on the
// application documents are materialised into loan_guarantor / loan_collateral.
// ---------------------------------------------------------------------------
export async function disburseLoan(
  actor: AuthContext,
  applicationId: string,
  input: DisburseInput,
  meta: RequestMeta = {},
): Promise<{ loan: LoanRefView }> {
  const result = await transaction<{ loan: LoanRefView }>(async (client) => {
    const application = await selectLoanApplicationById(client, applicationId);
    if (!application) throw new NotFoundError('Loan application');
    if (application.status !== 'approved') {
      throw new BusinessRuleError(
        `Only an approved application can be disbursed (current status: ${application.status})`,
        'APPLICATION_NOT_APPROVED',
      );
    }

    await assertCustomerEligible(client, application.customer_id);

    const documents = parseApplicationDocuments(application.documents);
    const branchId = documents.branchId;
    if (!branchId) {
      throw new BusinessRuleError('This application has no recorded branch', 'APPLICATION_BRANCH_MISSING');
    }
    await assertBranchExists(client, branchId);

    const product = await selectProductById(client, application.product_id);
    if (!product) throw new NotFoundError('Loan product');
    if (!product.is_active) {
      throw new BusinessRuleError('This loan product is not active', 'LOAN_PRODUCT_INACTIVE');
    }
    if (product.interest_method !== 'flat') {
      throw new BusinessRuleError(
        'Only flat-interest loan products are supported by the disbursal engine; configure the product to flat',
        'REDUCING_NOT_SUPPORTED',
      );
    }

    const approvedAmount = application.approved_amount;
    if (!approvedAmount) {
      throw new BusinessRuleError('This application has no approved amount', 'APPROVED_AMOUNT_REQUIRED');
    }
    if (compareMoney(approvedAmount, product.min_amount) < 0) {
      throw new BusinessRuleError(
        `Approved amount is below the product minimum of ${product.min_amount}`,
        'AMOUNT_BELOW_PRODUCT_MIN',
      );
    }
    if (compareMoney(approvedAmount, product.max_amount) > 0) {
      throw new BusinessRuleError(
        `Approved amount exceeds the product maximum of ${product.max_amount}`,
        'AMOUNT_ABOVE_PRODUCT_MAX',
      );
    }

    const tenureMonths = documents.approvedTenureMonths ?? application.tenure_months;
    if (tenureMonths < product.min_tenure_months || tenureMonths > product.max_tenure_months) {
      throw new BusinessRuleError(
        `Tenure ${tenureMonths} months falls outside the product's ${product.min_tenure_months}–${product.max_tenure_months} month range`,
        'TERM_OUTSIDE_PRODUCT',
      );
    }

    const frequency = application.repayment_frequency as LoanRepaymentFrequency;
    const rate = documents.finalInterestRate ?? application.proposed_interest_rate ?? product.interest_rate;
    const businessDate = input.disbursedOn ?? istBusinessDate();

    // --- schedule (flat interest over the term, equal instalments) ----------
    const totalInterest = simpleInterest(approvedAmount, rate, tenureMonths);
    const totalPayable = addMoney(approvedAmount, totalInterest);

    const maturity = addMonths(businessDate, tenureMonths);
    const dueDates: string[] = [];
    let cursor = businessDate;
    while (dueDates.length < MAX_SCHEDULE_INSTALMENTS) {
      const next = nextStep(cursor, frequency);
      if (next > maturity) break;
      dueDates.push(toWorkingDay(next));
      cursor = next;
    }
    if (dueDates.length === 0) {
      throw new BusinessRuleError('No instalments can be scheduled for this loan term', 'SCHEDULE_EMPTY');
    }
    const equalWeights = Array<bigint>(dueDates.length).fill(1n);
    const instalmentAmounts = allocateByWeights(totalPayable, equalWeights);

    // --- loan ---------------------------------------------------------------
    const loanSequence = await allocateSequence(client, 'loan');
    const loanNumber = loanSequence.formatted;
    let loanId: string;
    try {
      const loanInsert = await client.query<IdRow>(
        `INSERT INTO loan
           (loan_number, application_id, customer_id, product_id, branch_id,
            status, approved_amount, disbursed_amount, disbursed_on, disbursed_by,
            tenure_months, repayment_frequency, interest_method, interest_rate,
            flat_interest_total, total_payable, total_paid, outstanding_amount,
            next_due_date)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, '0.00', $14, $15)
         RETURNING id`,
        [
          loanNumber,
          applicationId,
          application.customer_id,
          product.id,
          branchId,
          approvedAmount,
          businessDate,
          actor.staffId,
          tenureMonths,
          frequency,
          product.interest_method,
          rate,
          totalInterest,
          totalPayable,
          dueDates[0] ?? null,
        ],
      );
      const insertedLoan = loanInsert.rows[0];
      if (!insertedLoan) throw new Error('failed to create loan');
      loanId = insertedLoan.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Loan number collision — please retry', 'LOAN_NUMBER_COLLISION');
      }
      throw error;
    }

    // --- instalments --------------------------------------------------------
    const instalmentNumbers = dueDates.map((_date, index) => index + 1);
    await client.query(
      `INSERT INTO loan_instalment
         (loan_id, instalment_number, due_date, expected_amount)
       SELECT $1, num, due, amt::numeric
         FROM unnest($2::int[], $3::date[], $4::text[]) AS t(num, due, amt)`,
      [loanId, instalmentNumbers, dueDates, instalmentAmounts],
    );

    // --- guarantors (spec §12.5.6: a guarantor may back at most 2 active loans)
    const guarantors = documents.guarantors ?? [];
    for (const guarantor of guarantors) {
      if (guarantor.customerId) {
        const active = await client.query<{ active_count: number }>(
          `SELECT COUNT(*)::int AS active_count
             FROM loan_guarantor g
             JOIN loan l ON l.id = g.loan_id
            WHERE g.guarantor_customer_id = $1
              AND l.status = ANY($2::text[])
              AND l.id <> $3`,
          [guarantor.customerId, OPEN_LOAN_STATUSES, loanId],
        );
        const activeCount = active.rows[0]?.active_count ?? 0;
        if (activeCount >= BUSINESS_RULES.GUARANTOR_MAX_ACTIVE_LOANS) {
          throw new BusinessRuleError(
            `Guarantor ${guarantor.name} already guarantees ${activeCount} active loan(s); the limit is ${BUSINESS_RULES.GUARANTOR_MAX_ACTIVE_LOANS}`,
            'GUARANTOR_LOAN_LIMIT_REACHED',
          );
        }
      }
      await client.query(
        `INSERT INTO loan_guarantor
           (loan_id, guarantor_customer_id, name, relationship,
            identity_document_type, identity_document_number, phone, address)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          loanId,
          guarantor.customerId ?? null,
          guarantor.name,
          guarantor.relationship ?? null,
          guarantor.identityDocumentType ?? null,
          guarantor.identityDocumentNumber ?? null,
          guarantor.phone ?? null,
          guarantor.address ?? null,
        ],
      );
    }

    // --- collateral (spec §12.5.5: lending ≤ product LTV of the valuation) --
    const collateral = documents.collateral ?? [];
    if (collateral.length > 0) {
      const valuation = collateral.reduce((sum, item) => addMoney(sum, item.valuationAmount), '0.00');
      const maxSecured = percentOf(valuation, product.max_ltv_percent);
      if (compareMoney(approvedAmount, maxSecured) > 0) {
        throw new BusinessRuleError(
          `Collateral of ${valuation} supports at most ${product.max_ltv_percent}% lending (${maxSecured})`,
          'COLLATERAL_VALUE_INSUFFICIENT',
        );
      }
    }
    for (const item of collateral) {
      await client.query(
        `INSERT INTO loan_collateral
           (loan_id, collateral_type, description, valuation_amount,
            valuation_date, document_reference, status)
         VALUES ($1, $2, $3, $4, $5, $6, 'held')`,
        [
          loanId,
          item.collateralType,
          item.description ?? null,
          item.valuationAmount,
          item.valuationDate ?? null,
          item.documentReference ?? null,
        ],
      );
    }

    // --- application → disbursed --------------------------------------------
    await client.query(
      `UPDATE loan_application
          SET status = 'disbursed',
              updated_at = $1
        WHERE id = $2`,
      [new Date(), applicationId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_DISBURSED,
      entityType: 'loan',
      entityId: loanId,
      businessDate,
      metadata: {
        applicationNumber: application.application_number,
        applicationId,
        customerId: application.customer_id,
        productId: product.id,
        productCode: product.code,
        branchId,
        loanNumber,
        amount: approvedAmount,
        tenureMonths,
        repaymentFrequency: frequency,
        interestRate: rate,
        interestMethod: product.interest_method,
        totalInterest,
        totalPayable,
        instalmentCount: dueDates.length,
        firstDueDate: dueDates[0] ?? null,
        disbursedOn: businessDate,
        disbursedBy: actor.staffId,
        guarantorCount: guarantors.length,
        collateralCount: collateral.length,
      },
    });

    return { loan: await loadLoanRef(client, loanId) };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLoan(
  actor: AuthContext,
  loanId: string,
  meta: RequestMeta = {},
): Promise<LoanDetailView> {
  const detail = await transaction<LoanDetailView>(async (client) => {
    const loan = await loadLoan(client, loanId);
    const instalments = await selectInstalmentsForLoan(client, loanId);
    return {
      loan,
      instalments: instalments.map((row): InstalmentView => toInstalmentView(row)),
      instalmentCount: instalments.length,
    };
  });

  await audit(poolForEvent(), {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: ACTION_LOAN_VIEWED,
    entityType: 'loan',
    entityId: loanId,
    metadata: { viewedBy: actor.staffId },
  });
  return detail;
}

export async function getSchedule(
  actor: AuthContext,
  loanId: string,
  queryInput: ScheduleQuery,
  meta: RequestMeta = {},
): Promise<ScheduleView> {
  const schedule = await transaction<ScheduleView>(async (client) => {
    const loan = await loadLoanRef(client, loanId);
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const instalments = await client.query<InstalmentRow>(
      `SELECT ${INSTALMENT_COLUMNS}, count(*) OVER()::int AS total
         FROM loan_instalment
        WHERE loan_id = $1
        ORDER BY instalment_number
        LIMIT $2 OFFSET $3`,
      [loanId, limit, offset],
    );
    const total = instalments.rows[0]?.total ?? 0;
    return {
      loan,
      items: instalments.rows.map((row): InstalmentView => toInstalmentView(row)),
      total,
    };
  });

  await audit(poolForEvent(), {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: ACTION_SCHEDULE_VIEWED,
    entityType: 'loan',
    entityId: loanId,
    metadata: {
      viewedBy: actor.staffId,
      limit: queryInput.limit,
      offset: queryInput.offset,
    },
  });
  return schedule;
}

// ---------------------------------------------------------------------------
// Repayment engine (spec §12.5.3 interest-first; §12.5.4 surplus held)
// ---------------------------------------------------------------------------

/**
 * Component split for one payment applied to a single instalment. Interest is
 * paid first (spec §12.5.3); loans currently generate no penalty or fee
 * balances, so whatever remains after the still-unpaid interest of that
 * instalment goes to principal. The per-instalment interest share is the flat
 * `flat_interest_total` spread evenly across the schedule (the same split the
 * disbursal engine used), so an instalment's scheduled interest is only ever
 * paid once — earlier payments, including part payments, reduce the interest
 * still due on it.
 */
function splitLoanPayment(
  row: InstalmentDueRow,
  interestSplit: string[],
  payCents: bigint,
): { interest: string; penalty: string; fees: string; principal: string } {
  const interestShare = interestSplit[row.instalment_number - 1] ?? '0.00';
  const prior = Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : [];
  const interestPaid = prior.reduce((sum, event) => addMoney(sum, event.components.interest), '0.00');
  let interestRemaining = toCents(subMoney(interestShare, interestPaid));
  if (interestRemaining < 0n) interestRemaining = 0n;
  const interestCents = payCents < interestRemaining ? payCents : interestRemaining;
  return {
    interest: fromCents(interestCents),
    penalty: '0.00',
    fees: '0.00',
    principal: fromCents(payCents - interestCents),
  };
}

export async function recordRepayment(
  actor: AuthContext,
  loanId: string,
  input: RecordRepaymentInput,
  meta: RequestMeta = {},
): Promise<RepaymentResult> {
  const result = await transaction<RepaymentResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Repayments can only be recorded on an open loan (current status: ${loan.status})`,
        'LOAN_NOT_PAYABLE',
      );
    }

    // State is kept honest before any money moves.
    await sweepMissedInstalments(client);

    const due = await client.query<InstalmentDueRow>(
      `SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              principal_component::text AS principal_component,
              interest_component::text AS interest_component,
              penalty_component::text AS penalty_component,
              fees_component::text AS fees_component,
              paid_amount::text AS paid_amount,
              status, allocation
         FROM loan_instalment
        WHERE loan_id = $1 AND status IN ('due','partial','missed','overdue')
        ORDER BY due_date ASC, instalment_number ASC
        FOR UPDATE`,
      [loanId],
    );
    const dueRows = due.rows;

    const paidOn = input.paidOn ?? istBusinessDate();
    const paymentMethod = input.paymentMethod;
    const referenceNumber = input.referenceNumber ?? null;
    const collectionEntryId = input.collectionEntryId ?? null;

    // Per-instalment scheduled interest (flat interest spread over the schedule).
    const countResult = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM loan_instalment WHERE loan_id = $1`,
      [loanId],
    );
    const instalmentCount = countResult.rows[0]?.total ?? 0;
    const equalWeights = Array<bigint>(instalmentCount).fill(1n);
    const interestSplit = allocateByWeights(loan.flat_interest_total, equalWeights);

    // Allocate the payment across outstanding instalments, oldest first.
    const allocationUpdates: Array<{
      row: InstalmentDueRow;
      amountPaid: string;
      newPaidAmount: string;
      newStatus: LoanInstalmentStatus;
      components: { interest: string; penalty: string; fees: string; principal: string };
      interestShare: string;
      principalShare: string;
    }> = [];
    let remaining = toCents(input.amount);
    for (const row of dueRows) {
      if (remaining <= 0n) break;
      const outstanding = subMoney(row.expected_amount, row.paid_amount);
      const outstandingCents = toCents(outstanding);
      if (outstandingCents <= 0n) continue;
      const paymentCents = remaining >= outstandingCents ? outstandingCents : remaining;
      const interestShare = interestSplit[row.instalment_number - 1] ?? '0.00';
      const principalShare = subMoney(row.expected_amount, interestShare);
      const components = splitLoanPayment(row, interestSplit, paymentCents);
      const newPaidAmount = addMoney(row.paid_amount, fromCents(paymentCents));
      remaining -= paymentCents;

      const newStatus: LoanInstalmentStatus =
        compareMoney(newPaidAmount, row.expected_amount) >= 0
          ? 'paid'
          : row.due_date < paidOn
            ? 'overdue'
            : 'partial';

      allocationUpdates.push({
        row,
        amountPaid: fromCents(paymentCents),
        newPaidAmount,
        newStatus,
        components,
        interestShare,
        principalShare,
      });
    }

    // Anything above every outstanding instalment is held on the loan account
    // (spec §12.5.4) and only released once the loan is completed.
    let heldThisPayment: string | null = null;
    if (remaining > 0n) {
      heldThisPayment = fromCents(remaining);
      await client.query(
        `INSERT INTO loan_surplus (loan_id, entry_type, amount, source_collection_id)
         VALUES ($1, 'held', $2::numeric, $3)`,
        [loanId, heldThisPayment, collectionEntryId],
      );
    }

    const appliedIds: string[] = [];
    for (const update of allocationUpdates) {
      const { row } = update;
      const prior = Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : [];
      const eventRecord: AllocationEvent = {
        paidOn,
        amount: update.amountPaid,
        paymentMethod,
        components: update.components,
      };
      if (referenceNumber) eventRecord.referenceNumber = referenceNumber;
      if (collectionEntryId) eventRecord.sourceCollectionId = collectionEntryId;

      // Backfill the scheduled interest/principal split of the instalment so the
      // detail and schedule views carry meaningful component figures once paid.
      await client.query(
        `UPDATE loan_instalment
            SET paid_amount = $1::numeric,
                status = $2,
                paid_on = $3,
                interest_component = $4::numeric,
                principal_component = $5::numeric,
                allocation = $6::jsonb,
                updated_at = now()
          WHERE id = $7`,
        [
          update.newPaidAmount,
          update.newStatus,
          paidOn,
          update.interestShare,
          update.principalShare,
          JSON.stringify([...prior, eventRecord]),
          row.id,
        ],
      );
      appliedIds.push(row.id);
    }

    // Recompose loan totals + status from the instalment ledger.
    const totals = await recomputeLoanTotals(client, loanId);
    const refreshed = await selectLoanById(client, loanId);
    if (!refreshed) throw new NotFoundError('Loan');

    // Current net surplus held on the account (releases/applications reduce it).
    const balance = await client.query<SurplusBalanceRow>(
      `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type = 'held'), 0)::numeric::text AS held,
              COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('released','applied')), 0)::numeric::text
                AS released
         FROM loan_surplus
        WHERE loan_id = $1`,
      [loanId],
    );
    const balanceRow = balance.rows[0] ?? null;
    let surplusHeld: string | null = null;
    if (balanceRow) {
      const net = subMoney(balanceRow.held, balanceRow.released);
      surplusHeld = compareMoney(net, '0.00') > 0 ? net : null;
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_REPAYMENT_RECORDED,
      entityType: 'loan',
      entityId: loanId,
      metadata: {
        loanNumber: loan.loan_number,
        amount: input.amount,
        paidOn,
        paymentMethod,
        referenceNumber,
        collectionEntryId,
        instalmentsCovered: allocationUpdates.length,
        allocations: allocationUpdates.map((update) => ({
          instalmentId: update.row.id,
          instalmentNumber: update.row.instalment_number,
          amountPaid: update.amountPaid,
          statusAfter: update.newStatus,
          components: update.components,
        })),
        surplusHeld: surplusHeld ?? null,
        surplusHeldThisPayment: heldThisPayment ?? null,
        totalPaid: totals.total_paid,
        outstandingAmount: totals.outstanding,
        loanStatus: refreshed.status,
        recordedBy: actor.staffId,
      },
    });

    const appliedRows = await selectInstalmentsByIds(client, loanId, appliedIds);
    const instalments = appliedRows.map((row): AllocationEventView => {
      const events = Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : [];
      const latest = events[events.length - 1] ?? null;
      return {
        instalmentId: row.id,
        instalmentNumber: row.instalment_number,
        amount: latest?.amount ?? row.paid_amount,
        status: row.status as LoanInstalmentStatus,
        components:
          latest?.components ?? { interest: '0.00', penalty: '0.00', fees: '0.00', principal: '0.00' },
      };
    });

    return {
      loan: await loadLoanRef(client, loanId),
      instalments,
      surplusHeld,
      outstandingAmount: totals.outstanding,
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Repayment correction (M.D., spec §12.3; §19.2 universal correction pattern)
// ---------------------------------------------------------------------------

/**
 * M.D. correction of a wrongly-recorded repayment on one instalment.
 *
 * `repaymentId` addresses the instalment that received the erroneous payment —
 * repayments are stored as allocation events on the instalment. The most recent
 * allocation event on that instalment is re-stated to `correctedAmount` with an
 * interest-first split, the instalment's paid amount / status / dates are
 * recomputed from the corrected ledger, and the loan totals are refreshed. The
 * original amount is never destroyed — the pre-correction figures are kept in
 * the correction audit event and the re-stated allocation event is flagged
 * `corrected`, so statements show both sides of the change (spec §19.2.3).
 */
export async function correctRepayment(
  actor: AuthContext,
  loanId: string,
  repaymentId: string,
  input: CorrectRepaymentInput,
  meta: RequestMeta = {},
): Promise<CorrectRepaymentResult> {
  const result = await transaction<CorrectRepaymentResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `A repayment can only be corrected on an open loan (current status: ${loan.status})`,
        'LOAN_NOT_PAYABLE',
      );
    }

    // State is kept honest before any money movement is re-stated.
    await sweepMissedInstalments(client);

    const instalmentResult = await client.query<InstalmentDueRow>(
      `SELECT id, instalment_number, due_date::text AS due_date,
              expected_amount::text AS expected_amount,
              principal_component::text AS principal_component,
              interest_component::text AS interest_component,
              penalty_component::text AS penalty_component,
              fees_component::text AS fees_component,
              paid_amount::text AS paid_amount,
              status, allocation
         FROM loan_instalment
        WHERE loan_id = $1 AND id = $2
        FOR UPDATE`,
      [loanId, repaymentId],
    );
    const row = instalmentResult.rows[0] ?? null;
    if (!row) throw new NotFoundError('Loan instalment');

    const events = Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : [];
    const lastEvent = events[events.length - 1] ?? null;
    if (!lastEvent) {
      throw new BusinessRuleError(
        `No repayment is recorded on instalment ${row.instalment_number}; there is nothing to correct`,
        'NO_REPAYMENT_TO_CORRECT',
      );
    }
    const eventsBefore = events.slice(0, -1);

    // What the instalment had collected before the erroneous event.
    let paidBeforeCents = toCents(subMoney(row.paid_amount, lastEvent.amount));
    if (paidBeforeCents < 0n) paidBeforeCents = 0n;
    const paidBefore = fromCents(paidBeforeCents);

    // The corrected amount cannot exceed what was outstanding on the
    // instalment before the erroneous event was recorded.
    const outstandingBefore = subMoney(row.expected_amount, paidBefore);
    if (compareMoney(input.correctedAmount, outstandingBefore) > 0) {
      throw new BusinessRuleError(
        `Corrected amount ${input.correctedAmount} exceeds the ${outstandingBefore} outstanding on instalment ${row.instalment_number} before the correction`,
        'CORRECTED_AMOUNT_EXCEEDS_OUTSTANDING',
      );
    }

    // Per-instalment scheduled interest (flat interest spread over the schedule).
    const countResult = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total FROM loan_instalment WHERE loan_id = $1`,
      [loanId],
    );
    const instalmentCount = countResult.rows[0]?.total ?? 0;
    const interestSplit = allocateByWeights(
      loan.flat_interest_total,
      Array<bigint>(instalmentCount).fill(1n),
    );
    const scheduledInterest = interestSplit[row.instalment_number - 1] ?? '0.00';
    const scheduledPrincipal = subMoney(row.expected_amount, scheduledInterest);

    // Interest-first re-split of the corrected amount (spec §12.5.3). Only the
    // scheduled interest still unpaid before the erroneous event is eligible.
    const interestPaidBefore = eventsBefore.reduce(
      (sum, event) => addMoney(sum, event.components.interest),
      '0.00',
    );
    let interestRemainingCents = toCents(subMoney(scheduledInterest, interestPaidBefore));
    if (interestRemainingCents < 0n) interestRemainingCents = 0n;
    const correctedCents = toCents(input.correctedAmount);
    const interestCents =
      correctedCents < interestRemainingCents ? correctedCents : interestRemainingCents;
    const components = {
      interest: fromCents(interestCents),
      penalty: '0.00',
      fees: '0.00',
      principal: fromCents(correctedCents - interestCents),
    };

    const newPaidAmount = addMoney(paidBefore, input.correctedAmount);
    const today = istBusinessDate();
    const newStatus: LoanInstalmentStatus =
      compareMoney(newPaidAmount, row.expected_amount) >= 0
        ? 'paid'
        : row.due_date < today
          ? compareMoney(newPaidAmount, '0.00') > 0
            ? 'overdue'
            : 'missed'
          : compareMoney(newPaidAmount, '0.00') > 0
            ? 'partial'
            : 'due';

    const hasPaid = compareMoney(newPaidAmount, '0.00') > 0;
    const paidOn = hasPaid ? (lastEvent.paidOn ?? today) : null;

    // Re-state the erroneous event in place of the original one, flagged as a
    // correction so the schedule/story shows it was re-stated. The original
    // amount and split are preserved in the correction audit event below.
    const replacement: AllocationEvent = {
      paidOn: lastEvent.paidOn,
      amount: input.correctedAmount,
      corrected: true,
      components,
    };
    if (lastEvent.paymentMethod !== undefined) replacement.paymentMethod = lastEvent.paymentMethod;
    if (lastEvent.referenceNumber !== undefined) replacement.referenceNumber = lastEvent.referenceNumber;
    if (lastEvent.sourceCollectionId !== undefined) replacement.sourceCollectionId = lastEvent.sourceCollectionId;

    await client.query(
      `UPDATE loan_instalment
          SET paid_amount = $1::numeric,
              status = $2,
              paid_on = $3,
              interest_component = $4::numeric,
              principal_component = $5::numeric,
              allocation = $6::jsonb,
              updated_at = now()
        WHERE id = $7`,
      [
        newPaidAmount,
        newStatus,
        paidOn,
        hasPaid ? scheduledInterest : '0.00',
        hasPaid ? scheduledPrincipal : '0.00',
        JSON.stringify([...eventsBefore, replacement]),
        row.id,
      ],
    );

    // Recompose loan totals + status from the instalment ledger.
    const totals = await recomputeLoanTotals(client, loanId);

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_REPAYMENT_CORRECTED,
      entityType: 'loan',
      entityId: loanId,
      metadata: {
        loanNumber: loan.loan_number,
        instalmentId: row.id,
        instalmentNumber: row.instalment_number,
        originalAmount: lastEvent.amount,
        correctedAmount: input.correctedAmount,
        previousPaidAmount: row.paid_amount,
        newPaidAmount,
        statusAfter: newStatus,
        components,
        reason: input.reason,
        correctedBy: actor.staffId,
        totalPaid: totals.total_paid,
        outstandingAmount: totals.outstanding,
      },
    });

    const reloaded = await selectInstalmentsByIds(client, loanId, [row.id]);
    const instalmentRow = reloaded[0];
    if (!instalmentRow) throw new NotFoundError('Loan instalment');
    return {
      loan: await loadLoanRef(client, loanId),
      instalment: toInstalmentView(instalmentRow),
    };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Loan lifecycle completion (spec §12.3; President / M.D. authorities)
// ---------------------------------------------------------------------------

/** Net surplus still held on a loan (releases and applications reduce it). */
async function selectNetSurplus(client: PoolClient, loanId: string): Promise<string | null> {
  const balance = await client.query<SurplusBalanceRow>(
    `SELECT COALESCE(SUM(amount) FILTER (WHERE entry_type = 'held'), 0)::numeric::text AS held,
            COALESCE(SUM(amount) FILTER (WHERE entry_type IN ('released','applied')), 0)::numeric::text
              AS released
       FROM loan_surplus
      WHERE loan_id = $1`,
    [loanId],
  );
  const row = balance.rows[0] ?? null;
  if (!row) return null;
  const net = subMoney(row.held, row.released);
  return compareMoney(net, '0.00') > 0 ? net : null;
}

/**
 * Principal actually recovered on a loan — the sum of the principal component
 * of every allocation event recorded across the instalment ledger. This is the
 * authoritative measure of how much of the disbursed principal the customer has
 * repaid (interest is booked first on each payment, so the remainder of every
 * allocation is principal).
 */
async function selectPrincipalRecovered(client: PoolClient, loanId: string): Promise<string> {
  const rows = await selectInstalmentsForLoan(client, loanId);
  let recovered = '0.00';
  for (const row of rows) {
    const events = Array.isArray(row.allocation) ? (row.allocation as AllocationEvent[]) : [];
    for (const event of events) {
      recovered = addMoney(recovered, event.components.principal);
    }
  }
  return recovered;
}

/**
 * Reschedule (President, spec §12.3). The remaining principal — the approved
 * amount less every principal component already recovered — is re-amortised
 * flat at the (possibly updated) rate over the (possibly updated) tenure from
 * the requested effective date. Paid instalments stay as history; the still
 * unearned future schedule is discarded and re-issued as one equal instalment
 * per period. A reschedule requires a clean ledger: any instalment carrying a
 * partial payment or a prior waiver must be resolved first, because the data
 * model records only whole-instalment waivers and a fresh flat schedule.
 */
export async function rescheduleLoan(
  actor: AuthContext,
  loanId: string,
  input: RescheduleInput,
  meta: RequestMeta = {},
): Promise<RescheduleResult> {
  const result = await transaction<RescheduleResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Only an open loan can be rescheduled (current status: ${loan.status})`,
        'LOAN_NOT_RESCHEDULABLE',
      );
    }

    // State is kept honest before the schedule is re-planned.
    await sweepMissedInstalments(client);
    const refreshed = await selectLoanById(client, loanId);
    if (!refreshed) throw new NotFoundError('Loan');

    const effectiveFrom = input.effectiveFrom;
    const frequency = refreshed.repayment_frequency as LoanRepaymentFrequency;
    const newRate = input.newInterestRate ?? refreshed.interest_rate;
    const newTenureMonths = input.newTenureMonths ?? refreshed.tenure_months;

    const principalRecovered = await selectPrincipalRecovered(client, loanId);
    const principalOutstanding = subMoney(refreshed.approved_amount, principalRecovered);
    if (compareMoney(principalOutstanding, '0.00') <= 0) {
      throw new BusinessRuleError(
        'This loan has no outstanding principal to reschedule',
        'LOAN_FULLY_PAID',
      );
    }

    // A clean re-plan is only possible when nothing but the unearned schedule
    // is still open — reject partial payments and prior waivers.
    const obstacles = await client.query<{
      instalment_number: number;
      status: string;
      paid_amount: string;
    }>(
      `SELECT instalment_number, status, paid_amount::text AS paid_amount
         FROM loan_instalment
        WHERE loan_id = $1 AND status <> 'paid'`,
      [loanId],
    );
    for (const row of obstacles.rows) {
      if (row.status === 'waived') {
        throw new BusinessRuleError(
          `Instalment ${row.instalment_number} was previously waived; a reschedule cannot follow a waiver`,
          'LOAN_HAS_WAIVED_INSTALMENT',
        );
      }
      if (row.status === 'partial' || row.status === 'overdue' || compareMoney(row.paid_amount, '0.00') > 0) {
        throw new BusinessRuleError(
          `Instalment ${row.instalment_number} carries a partial payment; settle outstanding dues before rescheduling`,
          'LOAN_HAS_PARTIAL_PAYMENT',
        );
      }
    }

    // --- new schedule (flat interest on the remaining principal) ------------
    const interest = simpleInterest(principalOutstanding, newRate, newTenureMonths);
    const newTotalPayable = addMoney(principalOutstanding, interest);

    const maturity = addMonths(effectiveFrom, newTenureMonths);
    const dueDates: string[] = [];
    let cursor = effectiveFrom;
    while (dueDates.length < MAX_SCHEDULE_INSTALMENTS) {
      const next = nextStep(cursor, frequency);
      if (next > maturity) break;
      dueDates.push(toWorkingDay(next));
      cursor = next;
    }
    if (dueDates.length === 0) {
      throw new BusinessRuleError('No instalments can be scheduled for this loan term', 'SCHEDULE_EMPTY');
    }
    const equalWeights = Array<bigint>(dueDates.length).fill(1n);
    const instalmentAmounts = allocateByWeights(newTotalPayable, equalWeights);

    const oldTerms = {
      branchId: refreshed.branch_id,
      loanNumber: refreshed.loan_number,
      approvedAmount: refreshed.approved_amount,
      tenureMonths: refreshed.tenure_months,
      interestRate: refreshed.interest_rate,
      repaymentFrequency: refreshed.repayment_frequency,
      totalPayable: refreshed.total_payable,
      flatInterestTotal: refreshed.flat_interest_total,
      outstandingAmount: refreshed.outstanding_amount,
      nextDueDate: refreshed.next_due_date,
      instalmentCount: refreshed.tenure_months,
    };

    // Discard the unearned schedule (only whole, untouched instalments remain
    // open at this point — enforced by the obstacles check above).
    await client.query(
      `DELETE FROM loan_instalment
        WHERE loan_id = $1 AND status NOT IN ('paid','waived')`,
      [loanId],
    );

    const maxResult = await client.query<{ max: number | null }>(
      `SELECT MAX(instalment_number) AS max FROM loan_instalment WHERE loan_id = $1`,
      [loanId],
    );
    const startAt = (maxResult.rows[0]?.max ?? 0) + 1;
    const instalmentNumbers = dueDates.map((_date, index) => startAt + index);

    await client.query(
      `INSERT INTO loan_instalment
         (loan_id, instalment_number, due_date, expected_amount)
       SELECT $1, num, due, amt::numeric
         FROM unnest($2::int[], $3::date[], $4::text[]) AS t(num, due, amt)`,
      [loanId, instalmentNumbers, dueDates, instalmentAmounts],
    );

    // Re-issue the loan terms and recompose totals from the fresh ledger.
    await client.query(
      `UPDATE loan
          SET tenure_months = $1,
              interest_rate = $2::numeric,
              flat_interest_total = $3::numeric,
              updated_at = now()
        WHERE id = $4`,
      [newTenureMonths, newRate, interest, loanId],
    );
    const totals = await recomputeLoanTotals(client, loanId);
    await client.query(
      `UPDATE loan
          SET total_payable = $1::numeric,
              status = 'rescheduled',
              updated_at = now()
        WHERE id = $2`,
      [addMoney(totals.total_paid, newTotalPayable), loanId],
    );

    const newTerms = {
      branchId: refreshed.branch_id,
      principalRescheduled: principalOutstanding,
      principalRecoveredBefore: principalRecovered,
      tenureMonths: newTenureMonths,
      interestRate: newRate,
      repaymentFrequency: frequency,
      totalPayable: newTotalPayable,
      interestTotal: interest,
      instalmentCount: dueDates.length,
      firstDueDate: dueDates[0] ?? null,
      effectiveFrom,
    };

    const changeResult = await client.query<IdRow>(
      `INSERT INTO loan_restructure
         (loan_id, change_type, old_terms, new_terms, reason, approved_by, effective_from)
       VALUES ($1, 'reschedule', $2::jsonb, $3::jsonb, $4, $5, $6)
       RETURNING id`,
      [loanId, JSON.stringify(oldTerms), JSON.stringify(newTerms), input.reason, actor.staffId, effectiveFrom],
    );
    const changeId = changeResult.rows[0]?.id;
    if (!changeId) throw new Error('failed to record loan restructure');

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_RESCHEDULED,
      entityType: 'loan',
      entityId: loanId,
      businessDate: effectiveFrom,
      metadata: {
        loanNumber: refreshed.loan_number,
        principalRecovered,
        principalRescheduled: principalOutstanding,
        oldTenureMonths: refreshed.tenure_months,
        newTenureMonths,
        oldInterestRate: refreshed.interest_rate,
        newInterestRate: newRate,
        oldTotalPayable: refreshed.total_payable,
        newTotalPayable,
        interestTotal: interest,
        instalmentCount: dueDates.length,
        effectiveFrom,
        reason: input.reason,
        restructureId: changeId,
        rescheduledBy: actor.staffId,
      },
    });

    const changeRow = await selectScheduleChangeById(client, changeId);
    if (!changeRow) throw new NotFoundError('Loan restructure');
    return {
      loan: await loadLoanRef(client, loanId),
      scheduleChange: toScheduleChangeView(changeRow),
    };
  });
  return result;
}

/**
 * Settle (President, spec §12.3). A loan settles only when nothing remains
 * outstanding on the instalment ledger — every instalment is paid or waived.
 * Surplus held on the account is unaffected here; it is released by the
 * separate surplus-release action once the loan has reached a terminal state.
 */
export async function settleLoan(
  actor: AuthContext,
  loanId: string,
  input: SettleInput,
  meta: RequestMeta = {},
): Promise<SettleResult> {
  const result = await transaction<SettleResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Only an open loan can be settled (current status: ${loan.status})`,
        'LOAN_NOT_SETTLABLE',
      );
    }

    // State is kept honest before the completion check.
    await sweepMissedInstalments(client);
    const totals = await recomputeLoanTotals(client, loanId);
    if (compareMoney(totals.outstanding, '0.00') > 0) {
      throw new BusinessRuleError(
        `Loan cannot be settled while ${totals.outstanding} is still outstanding`,
        'LOAN_OUTSTANDING_REMAINS',
      );
    }

    const settledOn = input.settledOn ?? istBusinessDate();
    await client.query(
      `UPDATE loan
          SET status = 'settled',
              total_paid = $1::numeric,
              outstanding_amount = '0.00',
              next_due_date = NULL,
              closed_on = $2,
              closure_type = 'settled',
              updated_at = now()
        WHERE id = $3`,
      [totals.total_paid, settledOn, loanId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_SETTLED,
      entityType: 'loan',
      entityId: loanId,
      businessDate: settledOn,
      metadata: {
        loanNumber: loan.loan_number,
        totalPaid: totals.total_paid,
        settledOn,
        reason: input.reason ?? null,
        settledBy: actor.staffId,
      },
    });

    return { loan: await loadLoanRef(client, loanId) };
  });
  return result;
}

/**
 * Write-off (President, spec §12.3). The full outstanding balance is written
 * off: every unpaid instalment is marked waived (so the ledger no longer
 * contributes to the outstanding amount) and the write-off is recorded with its
 * amount and approval trail. Terminal afterwards.
 */
export async function writeOffLoan(
  actor: AuthContext,
  loanId: string,
  input: WriteOffInput,
  meta: RequestMeta = {},
): Promise<WriteOffResult> {
  const result = await transaction<WriteOffResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Only an open loan can be written off (current status: ${loan.status})`,
        'LOAN_NOT_WRITABLE',
      );
    }

    // State is kept honest before the balance is measured.
    await sweepMissedInstalments(client);
    const totals = await recomputeLoanTotals(client, loanId);
    if (compareMoney(totals.outstanding, '0.00') <= 0) {
      throw new BusinessRuleError(
        'This loan has no outstanding balance to write off',
        'NOTHING_TO_WRITE_OFF',
      );
    }
    const writeOffAmount = totals.outstanding;

    await client.query(
      `UPDATE loan_instalment
          SET status = 'waived',
              updated_at = now()
        WHERE loan_id = $1 AND status IN ('due','partial','missed','overdue')`,
      [loanId],
    );
    await recomputeLoanTotals(client, loanId);

    const writeOffResult = await client.query<IdRow>(
      `INSERT INTO loan_writeoff (loan_id, amount, reason, approved_by)
       VALUES ($1, $2::numeric, $3, $4)
       RETURNING id`,
      [loanId, writeOffAmount, input.reason, actor.staffId],
    );
    const writeOffId = writeOffResult.rows[0]?.id;
    if (!writeOffId) throw new Error('failed to record loan write-off');

    await client.query(
      `UPDATE loan
          SET status = 'written_off',
              updated_at = now()
        WHERE id = $1`,
      [loanId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_WRITTEN_OFF,
      entityType: 'loan',
      entityId: loanId,
      metadata: {
        loanNumber: loan.loan_number,
        amount: writeOffAmount,
        reason: input.reason,
        writeOffId,
        writtenOffBy: actor.staffId,
      },
    });

    return {
      loan: await loadLoanRef(client, loanId),
      writeOffId,
      amount: writeOffAmount,
    };
  });
  return result;
}

/**
 * Transfer (spec §12.3). The loan moves to another branch and the move is
 * recorded as a 'refinance' restructure so the full history is preserved.
 * No money moves and the loan status is unchanged.
 */
export async function transferLoan(
  actor: AuthContext,
  loanId: string,
  input: TransferInput,
  meta: RequestMeta = {},
): Promise<TransferResult> {
  const result = await transaction<TransferResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Only an open loan can be transferred (current status: ${loan.status})`,
        'LOAN_NOT_TRANSFERABLE',
      );
    }
    if (loan.branch_id === input.toBranchId) {
      throw new BadRequestError(`Loan already belongs to branch ${loan.branch_name}`);
    }
    await assertBranchExists(client, input.toBranchId);

    const effectiveFrom = istBusinessDate();
    const oldTerms = {
      branchId: loan.branch_id,
      branchName: loan.branch_name,
      loanNumber: loan.loan_number,
    };
    const newTerms = {
      branchId: input.toBranchId,
      effectiveFrom,
    };

    const restructureResult = await client.query<IdRow>(
      `INSERT INTO loan_restructure
         (loan_id, change_type, old_terms, new_terms, reason, approved_by, effective_from)
       VALUES ($1, 'refinance', $2::jsonb, $3::jsonb, $4, $5, $6)
       RETURNING id`,
      [loanId, JSON.stringify(oldTerms), JSON.stringify(newTerms), input.reason, actor.staffId, effectiveFrom],
    );
    const restructureId = restructureResult.rows[0]?.id;
    if (!restructureId) throw new Error('failed to record loan transfer');

    await client.query(
      `UPDATE loan
          SET branch_id = $1,
              updated_at = now()
        WHERE id = $2`,
      [input.toBranchId, loanId],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_LOAN_TRANSFERRED,
      entityType: 'loan',
      entityId: loanId,
      businessDate: effectiveFrom,
      metadata: {
        loanNumber: loan.loan_number,
        fromBranchId: loan.branch_id,
        fromBranchName: loan.branch_name,
        toBranchId: input.toBranchId,
        reason: input.reason,
        restructureId,
        effectiveFrom,
        transferredBy: actor.staffId,
      },
    });

    return { loan: await loadLoanRef(client, loanId) };
  });
  return result;
}

/**
 * Waiver (President, spec §12.3). Either a specific unpaid instalment or a
 * capped amount of the outstanding balance is waived. Instalments are marked
 * 'waived' whole — the model stores no partial waiver — so an amount-mode
 * waiver must land exactly on the outstanding of one or more whole
 * instalments (earliest first).
 */
export async function grantWaiver(
  actor: AuthContext,
  loanId: string,
  input: WaiverInput,
  meta: RequestMeta = {},
): Promise<WaiverResult> {
  const result = await transaction<WaiverResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!OPEN_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `A waiver can only be granted on an open loan (current status: ${loan.status})`,
        'LOAN_NOT_WAIVABLE',
      );
    }

    // State is kept honest before the outstanding balance is measured.
    await sweepMissedInstalments(client);

    const waivedIds: string[] = [];
    let waivedAmount = '0.00';

    if (input.instalmentId) {
      const single = await client.query<InstalmentDueRow>(
        `SELECT id, instalment_number, due_date::text AS due_date,
                expected_amount::text AS expected_amount,
                principal_component::text AS principal_component,
                interest_component::text AS interest_component,
                penalty_component::text AS penalty_component,
                fees_component::text AS fees_component,
                paid_amount::text AS paid_amount,
                status, allocation
           FROM loan_instalment
          WHERE loan_id = $1 AND id = $2
          FOR UPDATE`,
        [loanId, input.instalmentId],
      );
      const row = single.rows[0] ?? null;
      if (!row) throw new NotFoundError('Loan instalment');

      const remaining = subMoney(row.expected_amount, row.paid_amount);
      if (compareMoney(remaining, '0.00') <= 0) {
        throw new BusinessRuleError(
          `Instalment ${row.instalment_number} is already fully paid; there is nothing to waive`,
          'INSTALMENT_ALREADY_PAID',
        );
      }
      waivedAmount = remaining;
      waivedIds.push(row.id);
      await client.query(
        `UPDATE loan_instalment
            SET status = 'waived',
                updated_at = now()
          WHERE id = $1`,
        [row.id],
      );
    } else if (input.amount) {
      const targetCents = toCents(input.amount);
      const due = await client.query<InstalmentDueRow>(
        `SELECT id, instalment_number, due_date::text AS due_date,
                expected_amount::text AS expected_amount,
                principal_component::text AS principal_component,
                interest_component::text AS interest_component,
                penalty_component::text AS penalty_component,
                fees_component::text AS fees_component,
                paid_amount::text AS paid_amount,
                status, allocation
           FROM loan_instalment
          WHERE loan_id = $1 AND status IN ('due','partial','missed','overdue')
          ORDER BY due_date ASC, instalment_number ASC
          FOR UPDATE`,
        [loanId],
      );

      let remainingCents = targetCents;
      const toWaive: Array<{ id: string; number: number }> = [];
      for (const row of due.rows) {
        if (remainingCents <= 0n) break;
        const outstandingCents = toCents(subMoney(row.expected_amount, row.paid_amount));
        if (outstandingCents <= 0n) continue;
        if (outstandingCents > remainingCents) {
          throw new BusinessRuleError(
            `A waiver of ${input.amount} falls inside instalment ${row.instalment_number} (${fromCents(outstandingCents)} outstanding); waive whole instalments only`,
            'WAIVER_AMOUNT_MISMATCH',
          );
        }
        remainingCents -= outstandingCents;
        toWaive.push({ id: row.id, number: row.instalment_number });
      }
      if (remainingCents > 0n) {
        throw new BusinessRuleError(
          `A waiver of ${input.amount} exceeds the outstanding balance of the loan`,
          'WAIVER_EXCEEDS_OUTSTANDING',
        );
      }
      for (const entry of toWaive) {
        await client.query(
          `UPDATE loan_instalment
              SET status = 'waived',
                  updated_at = now()
            WHERE id = $1`,
          [entry.id],
        );
        waivedIds.push(entry.id);
      }
      waivedAmount = input.amount;
    } else {
      throw new BusinessRuleError('Provide either an instalmentId or an amount to waive', 'WAIVER_INVALID');
    }

    await recomputeLoanTotals(client, loanId);

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_WAIVED,
      entityType: 'loan',
      entityId: loanId,
      metadata: {
        loanNumber: loan.loan_number,
        mode: input.instalmentId ? 'instalment' : 'amount',
        instalmentId: input.instalmentId ?? null,
        instalmentIds: waivedIds,
        amount: waivedAmount,
        reason: input.reason,
        waivedBy: actor.staffId,
      },
    });

    let instalmentView: InstalmentView | null = null;
    if (input.instalmentId) {
      const reloaded = await selectInstalmentsByIds(client, loanId, waivedIds);
      const row = reloaded[0] ?? null;
      if (!row) throw new NotFoundError('Loan instalment');
      instalmentView = toInstalmentView(row);
    }

    return {
      loan: await loadLoanRef(client, loanId),
      instalment: instalmentView,
      waivedAmount,
    };
  });
  return result;
}

/**
 * Release surplus (spec §12.3, §12.5.4). A surplus is held on the loan account
 * during the loan's life and is released only once the loan is completed — the
 * loan must already be in a terminal state (settled / written off / closed).
 * An amount may cap the release; without one the entire held balance is
 * released. Releases and applications reduce the balance, so the net held
 * figure is always re-derived.
 */
export async function releaseSurplus(
  actor: AuthContext,
  loanId: string,
  input: SurplusReleaseInput,
  meta: RequestMeta = {},
): Promise<SurplusReleaseResult> {
  const result = await transaction<SurplusReleaseResult>(async (client) => {
    const loan = await selectLoanById(client, loanId);
    if (!loan) throw new NotFoundError('Loan');
    if (!TERMINAL_LOAN_STATUSES.includes(loan.status as LoanStatus)) {
      throw new BusinessRuleError(
        `Surplus is released only once the loan is completed (current status: ${loan.status})`,
        'LOAN_NOT_COMPLETED',
      );
    }

    const held = await selectNetSurplus(client, loanId);
    if (!held) {
      throw new BusinessRuleError('This loan holds no surplus to release', 'NO_SURPLUS_HELD');
    }
    if (input.amount && compareMoney(input.amount, held) > 0) {
      throw new BusinessRuleError(
        `A release of ${input.amount} exceeds the ${held} surplus held on this loan`,
        'SURPLUS_RELEASE_EXCEEDS_HELD',
      );
    }

    const releasedAmount = input.amount ?? held;
    const releasedOn = istBusinessDate();
    await client.query(
      `INSERT INTO loan_surplus (loan_id, entry_type, amount, released_on, released_by)
       VALUES ($1, 'released', $2::numeric, $3, $4)`,
      [loanId, releasedAmount, releasedOn, actor.staffId],
    );

    const heldAfter = (await selectNetSurplus(client, loanId)) ?? '0.00';

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.LOAN_SURPLUS_RELEASED,
      entityType: 'loan',
      entityId: loanId,
      businessDate: releasedOn,
      metadata: {
        loanNumber: loan.loan_number,
        amount: releasedAmount,
        heldBefore: held,
        heldAfter,
        releasedOn,
        reason: input.reason ?? null,
        releasedBy: actor.staffId,
      },
    });

    return { releasedAmount, heldBalance: heldAfter };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Loan statements (spec §12.3 — on customer request only)
// ---------------------------------------------------------------------------

/**
 * Statement of a loan — the audit trail of everything that happened on it,
 * newest first. Views of a loan are read transactions; the audit event itself
 * is written outside the transaction through the pool adapter, exactly like
 * the loan detail and schedule reads.
 */
export async function getStatements(
  actor: AuthContext,
  loanId: string,
  queryInput: StatementsQuery,
  meta: RequestMeta = {},
): Promise<StatementView> {
  const statement = await transaction<StatementView>(async (client) => {
    const loan = await loadLoanRef(client, loanId);
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const entries = await selectAuditEntries(client, loanId, limit, offset);
    const countResult = await client.query<{ total: number }>(
      `SELECT COUNT(*)::int AS total
         FROM audit_event
        WHERE entity_type = 'loan' AND entity_id = $1`,
      [loanId],
    );
    const total = countResult.rows[0]?.total ?? 0;
    return {
      loan,
      items: entries.map((row): StatementEntryView => toAuditEntryView(row)),
      total,
    };
  });

  await audit(poolForEvent(), {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: ACTION_STATEMENTS_VIEWED,
    entityType: 'loan',
    entityId: loanId,
    metadata: {
      viewedBy: actor.staffId,
      limit: queryInput.limit,
      offset: queryInput.offset,
    },
  });
  return statement;
}