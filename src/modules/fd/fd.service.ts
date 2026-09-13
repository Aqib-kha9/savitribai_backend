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
  percentOf,
  toCents,
  BUSINESS_RULES,
} from '../../core/money.js';
import type {
  CloseEarlyInput,
  CreateAccountInput,
  CreateRateCardInput,
  FdAccountStatus,
  FdMaturityAction,
  FdPayoutFrequency,
  FdPayoutMode,
  HistoryQuery,
  LienInput,
  ListAccountsQuery,
  ListRateCardsQuery,
  LoanAgainstFdInput,
  LoanRepaymentFrequency,
  MaturityActionInput,
  PaymentMethod,
  UpdateAccountInput,
} from './fd.schemas.js';

/**
 * Fixed deposits service (docs/backend-master-spec.md §11).
 *
 * Authority (spec §11.1 / §11.3, §5.2):
 *  - rate card management and every FD mutation (open, lien request/release,
 *    early closure, maturity action, loan against FD) -> Managing Director
 *  - rate-card / account / history reads -> deposits.read
 *
 * Money & time rules (spec §11.1):
 *  - Deposit amount is enforced to ₹1,000 – ₹1,00,000
 *    (BUSINESS_RULES.FD_MIN_AMOUNT / FD_MAX_AMOUNT) and must fall inside the
 *    chosen rate card's amount band with an exact tenure match.
 *  - Interest payout frequency: monthly / quarterly / yearly / at_maturity.
 *    Payout mode is 'payout' (interest settled to the customer) or 'reinvest'
 *    (interest added back into the FD).
 *  - The rate card carries per band/tenure: interest rate, early-closure
 *    penalty percent and a minimum holding period. Early closure before the
 *    minimum holding period charges the card's penalty on the deposit;
 *    closure after it is penalty-free.
 *  - A lien may be requested or released only by the Managing Director. A
 *    liened account is not settleable / closeable / renewable until released.
 *  - Loan against FD is limited to 85% of the deposit
 *    (BUSINESS_RULES.FD_LIEN_LOAN_PERCENT) and is disbursed immediately
 *    (the FD acts as the security).
 *  - At maturity every option is available: renew principal + interest,
 *    renew principal only, transfer to savings, pay cash, pay bank. Interest
 *    is simple interest over the term:
 *      interest = deposit × rate/100 × tenureMonths/12.
 *    Transfer to savings credits the principal ('deposit') and the interest
 *    ('interest') as two savings-ledger entries, the interest entry being
 *    referenced by fd_interest_payout.savings_transaction_id.
 *
 * Every mutation runs inside one DB transaction and appends its audit event in
 * the same transaction (spec §6.3). fd_lien, fd_maturity_event and
 * fd_interest_payout are append-only ledgers for the account history surface.
 */

// Module-local action vocabulary. The shared audit-writer keeps constants for
// opened / lien set / lien released / closed early / maturity action; the
// remaining FD actions have no shared constant and are plain strings here
// (mirroring the deposits / rd modules' approach for read and creation paths).
const ACTION_RATE_CARD_CREATED = 'fd.rate_card.created';
const ACTION_RATE_CARD_VIEWED = 'fd.rate_card.viewed';
const ACTION_ACCOUNT_VIEWED = 'fd.account.viewed';
const ACTION_ACCOUNT_UPDATED = 'fd.account.updated';
const ACTION_HISTORY_VIEWED = 'fd.history.viewed';
const ACTION_LOAN_CREATED = 'fd.loan.created';

/** FD accounts whose principal is still controlled by the bank. */
const LIVE_STATUSES: readonly string[] = ['active', 'matured'];

/** Statuses a lien can be requested on (matured/liened/closed are excluded). */
const LIENABLE_STATUSES: readonly string[] = ['active'];

/** Accounts eligible for an early closure (must not be liened or matured). */
const CLOSEABLE_STATUSES: readonly string[] = ['active'];

/** Loan statuses that hold a pledged FD (an FD can back only one live loan). */
const TERMINAL_LOAN_STATUSES: readonly string[] = ['settled', 'written_off', 'closed'];

/** Hard safety bound on generated loan instalments (max term 120 months). */
const MAX_SCHEDULE_INSTALMENTS = 10_000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface RateCardView {
  id: string;
  minAmount: string;
  maxAmount: string;
  tenureMonths: number;
  interestRate: string;
  earlyClosurePenaltyPercent: string;
  minHoldingMonths: number;
  effectiveFrom: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface FdAccountView {
  id: string;
  accountNumber: string;
  customerId: string;
  customerNumber: string | null;
  customerName: string;
  rateCardId: string;
  rateCardMinAmount: string;
  rateCardMaxAmount: string;
  rateCardTenureMonths: number;
  branchId: string;
  branchName: string | null;
  depositAmount: string;
  tenureMonths: number;
  interestRate: string;
  rateIsFixed: boolean;
  startDate: string;
  maturityDate: string;
  payoutFrequency: FdPayoutFrequency;
  payoutMode: FdPayoutMode;
  maturityAction: FdMaturityAction;
  status: FdAccountStatus;
  lienAmount: string;
  closedOn: string | null;
  closurePenalty: string | null;
  openedBy: string | null;
  openedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LienView {
  id: string;
  fdAccountId: string;
  lienAmount: string;
  reason: string;
  status: string;
  requestedBy: string;
  requestedByName: string | null;
  requestedOn: string;
  releasedOn: string | null;
  releasedBy: string | null;
  releasedByName: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface MaturityEventView {
  id: string;
  fdAccountId: string;
  eventType: string;
  eventDate: string;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface InterestPayoutView {
  id: string;
  fdAccountId: string;
  payoutDate: string;
  periodStart: string;
  periodEnd: string;
  amount: string;
  payoutMode: string;
  referenceNumber: string | null;
  savingsTransactionId: string | null;
  createdAt: string;
}

export interface HistoryEventView {
  kind: 'maturity_event' | 'lien' | 'interest_payout';
  entityId: string;
  eventDate: string;
  status: string | null;
  amount: string | null;
  referenceNumber: string | null;
  reason: string | null;
  details: Record<string, unknown> | null;
  createdAt: string;
}

export interface HistoryView {
  total: number;
  items: HistoryEventView[];
}

export interface CloseEarlyResult {
  account: FdAccountView;
  closurePenalty: string;
}

export interface MaturityActionResult {
  account: FdAccountView;
  action: FdMaturityAction;
  depositAmount: string;
  interestAmount: string;
}

export interface LoanRefView {
  id: string;
  loanNumber: string;
  applicationNumber: string;
  customerId: string;
  productId: string;
  amount: string;
  totalPayable: string;
  status: string;
  instalmentCount: number;
  nextDueDate: string | null;
  createdAt: string;
}

export interface LoanResult {
  loan: LoanRefView;
}

/** Row shapes: every query row must satisfy pg's QueryResultRow (type alias). */
type IdRow = {
  id: string;
};

type CustomerEligibilityRow = {
  id: string;
  status: string;
};

type RateCardRow = {
  id: string;
  min_amount: string;
  max_amount: string;
  tenure_months: number;
  interest_rate: string;
  early_closure_penalty_percent: string;
  min_holding_months: number;
  effective_from: string;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
};

type RateCardListRow = RateCardRow & {
  total: number;
};

type FdAccountCoreRow = {
  id: string;
  account_number: string;
  customer_id: string;
  customer_number: string | null;
  customer_name: string;
  rate_card_id: string;
  rate_card_min_amount: string;
  rate_card_max_amount: string;
  rate_card_tenure_months: number;
  branch_id: string;
  branch_name: string | null;
  deposit_amount: string;
  tenure_months: number;
  interest_rate: string;
  rate_is_fixed: boolean;
  start_date: string;
  maturity_date: string;
  payout_frequency: string;
  payout_mode: string;
  maturity_action: string;
  status: string;
  lien_amount: string;
  closed_on: string | null;
  closure_penalty: string | null;
  opened_by: string | null;
  opened_by_name: string | null;
  created_at: Date;
  updated_at: Date;
};

type FdAccountListRow = FdAccountCoreRow & {
  total: number;
};

type SavingsAccountRow = {
  id: string;
  account_number: string;
  customer_id: string;
  status: string;
  current_balance: string;
};

type LoanProductRow = {
  id: string;
  code: string;
  name: string;
  min_amount: string;
  max_amount: string;
  min_tenure_months: number;
  max_tenure_months: number;
  interest_method: string;
  interest_rate: string;
  repayment_frequency: string;
  is_active: boolean;
};

type ActiveLienRow = {
  id: string;
  lien_amount: string;
  reason: string;
};

type HistoryEventRow = {
  kind: string;
  entity_id: string;
  event_date: string;
  status: string | null;
  amount: string | null;
  reference_number: string | null;
  reason: string | null;
  details: unknown;
  created_at: Date;
  total: number;
};

type HistoryPageRow = {
  id: string;
  kind: string;
  entity_id: string;
  event_date: string;
  status: string | null;
  amount: string | null;
  reference_number: string | null;
  reason: string | null;
  details: unknown;
  created_at: Date;
  total: number;
};

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
    `SELECT id, status FROM customer WHERE id = $1 LIMIT 1`,
    [customerId],
  );
  return result.rows[0] ?? null;
}

/** An FD account can only be opened for a customer whose record is not terminal. */
async function assertCustomerEligible(client: PoolClient, customerId: string): Promise<void> {
  const customer = await selectCustomerEligibility(client, customerId);
  if (!customer) throw new NotFoundError('Customer');
  // 'restricted' (data-subject restriction) and 'deleted' (data-subject soft
  // delete, spec §24.2) also freeze new product openings.
  if (
    customer.status === 'deceased' ||
    customer.status === 'closed' ||
    customer.status === 'restricted' ||
    customer.status === 'deleted'
  ) {
    throw new BusinessRuleError(
      `Customer is ${customer.status}; no new FD account can be opened for this profile`,
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
 * Simple interest over a whole term (spec §11.1: interest = deposit × rate% ×
 * tenureMonths/12). The rate is NUMERIC(7,4), so the computation must avoid
 * the two-decimal `percentOf` helper and work on BigInt paise directly:
 *   interestPaise = depositPaise × rateE4 × tenureMonths / 12_000_000
 * where rateE4 = round(rate × 10_000).
 */
function simpleInterest(deposit: string, rate: string, tenureMonths: number): string {
  const rateE4 = BigInt(Math.round(Number(rate) * 10_000));
  const interestCents = (toCents(deposit) * rateE4 * BigInt(tenureMonths)) / 12_000_000n;
  return fromCents(interestCents);
}

/** Throws a lock error when an FD account cannot be pledged twice. */
async function assertFdNotPledged(client: PoolClient, fdAccountId: string): Promise<void> {
  const existing = await client.query<IdRow>(
    `SELECT l.id
       FROM loan l
      WHERE l.against_fd_account_id = $1
        AND l.status <> ALL($2::text[])
      LIMIT 1`,
    [fdAccountId, TERMINAL_LOAN_STATUSES],
  );
  if (existing.rows[0]) {
    throw new BusinessRuleError(
      'This FD account is already secured against an active loan; release it before pledging again',
      'FD_ALREADY_PLEDGED',
    );
  }
}

/** Selects the newest active rate card covering `deposit` at `tenure`. */
async function selectActiveRateCardFor(
  client: PoolClient,
  deposit: string,
  tenureMonths: number,
): Promise<RateCardRow | null> {
  const result = await client.query<RateCardRow>(
    `SELECT id, min_amount::text AS min_amount, max_amount::text AS max_amount,
            tenure_months, interest_rate::text AS interest_rate,
            early_closure_penalty_percent::text AS early_closure_penalty_percent,
            min_holding_months, effective_from::text AS effective_from,
            is_active, created_at, updated_at
       FROM fd_rate_card
      WHERE is_active = true
        AND tenure_months = $1
        AND min_amount <= $2::numeric
        AND max_amount >= $2::numeric
      ORDER BY effective_from DESC, created_at DESC
      LIMIT 1`,
    [tenureMonths, deposit],
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// FD rate card helpers
// ---------------------------------------------------------------------------

const FD_RATE_CARD_SELECT = `
  SELECT id, min_amount::text AS min_amount, max_amount::text AS max_amount,
         tenure_months, interest_rate::text AS interest_rate,
         early_closure_penalty_percent::text AS early_closure_penalty_percent,
         min_holding_months, effective_from::text AS effective_from,
         is_active, created_at, updated_at
    FROM fd_rate_card
`;

async function selectRateCardById(client: PoolClient, rateCardId: string): Promise<RateCardRow | null> {
  const result = await client.query<RateCardRow>(
    `${FD_RATE_CARD_SELECT} WHERE id = $1 LIMIT 1`,
    [rateCardId],
  );
  return result.rows[0] ?? null;
}

function toRateCardView(row: RateCardRow): RateCardView {
  return {
    id: row.id,
    minAmount: row.min_amount,
    maxAmount: row.max_amount,
    tenureMonths: row.tenure_months,
    interestRate: row.interest_rate,
    earlyClosurePenaltyPercent: row.early_closure_penalty_percent,
    minHoldingMonths: row.min_holding_months,
    effectiveFrom: row.effective_from,
    isActive: row.is_active,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// FD account helpers
// ---------------------------------------------------------------------------

const FD_ACCOUNT_SELECT = `
  SELECT fa.id, fa.account_number, fa.customer_id,
         c.customer_number, c.full_name AS customer_name,
         fa.rate_card_id,
         rc.min_amount::text AS rate_card_min_amount,
         rc.max_amount::text AS rate_card_max_amount,
         rc.tenure_months AS rate_card_tenure_months,
         fa.branch_id, b.name AS branch_name,
         fa.deposit_amount::text AS deposit_amount,
         fa.tenure_months, fa.interest_rate::text AS interest_rate,
         fa.rate_is_fixed,
         fa.start_date::text AS start_date,
         fa.maturity_date::text AS maturity_date,
         fa.payout_frequency, fa.payout_mode, fa.maturity_action,
         fa.status, fa.lien_amount::text AS lien_amount,
         fa.closed_on::text AS closed_on,
         fa.closure_penalty::text AS closure_penalty,
         fa.opened_by, op.full_name AS opened_by_name,
         fa.created_at, fa.updated_at
    FROM fd_account fa
    JOIN customer c ON c.id = fa.customer_id
    JOIN fd_rate_card rc ON rc.id = fa.rate_card_id
    JOIN branch b ON b.id = fa.branch_id
    LEFT JOIN staff op ON op.id = fa.opened_by
`;

async function selectFdAccountById(client: PoolClient, accountId: string): Promise<FdAccountCoreRow | null> {
  const result = await client.query<FdAccountCoreRow>(
    `${FD_ACCOUNT_SELECT} WHERE fa.id = $1 LIMIT 1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

function toFdAccountView(row: FdAccountCoreRow): FdAccountView {
  return {
    id: row.id,
    accountNumber: row.account_number,
    customerId: row.customer_id,
    customerNumber: row.customer_number,
    customerName: row.customer_name,
    rateCardId: row.rate_card_id,
    rateCardMinAmount: row.rate_card_min_amount,
    rateCardMaxAmount: row.rate_card_max_amount,
    rateCardTenureMonths: row.rate_card_tenure_months,
    branchId: row.branch_id,
    branchName: row.branch_name,
    depositAmount: row.deposit_amount,
    tenureMonths: row.tenure_months,
    interestRate: row.interest_rate,
    rateIsFixed: row.rate_is_fixed,
    startDate: row.start_date,
    maturityDate: row.maturity_date,
    payoutFrequency: row.payout_frequency as FdPayoutFrequency,
    payoutMode: row.payout_mode as FdPayoutMode,
    maturityAction: row.maturity_action as FdMaturityAction,
    status: row.status as FdAccountStatus,
    lienAmount: row.lien_amount,
    closedOn: row.closed_on,
    closurePenalty: row.closure_penalty,
    openedBy: row.opened_by,
    openedByName: row.opened_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadFdAccountDetail(client: PoolClient, accountId: string): Promise<FdAccountView> {
  const account = await selectFdAccountById(client, accountId);
  if (!account) throw new NotFoundError('FD account');
  return toFdAccountView(account);
}

/**
 * Local copy of the deposits module's ledger writer (it is module-private
 * there). Needed because fd_interest_payout.savings_transaction_id references
 * account_transaction(id) for transfer-to-savings settlements.
 */
async function insertLedgerEntry(
  client: PoolClient,
  entry: {
    accountId: string;
    transactionType: string;
    direction: 'credit' | 'debit';
    amount: string;
    balanceAfter: string;
    valueDate: string;
    paymentMethod: PaymentMethod;
    referenceNumber?: string | undefined;
    description?: string | undefined;
    actor: AuthContext;
  },
): Promise<string> {
  const insert = await client.query<IdRow>(
    `INSERT INTO account_transaction
       (savings_account_id, transaction_type, direction, amount, balance_after,
        value_date, payment_method, reference_number, description,
        performed_by, performed_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      entry.accountId,
      entry.transactionType,
      entry.direction,
      entry.amount,
      entry.balanceAfter,
      entry.valueDate,
      entry.paymentMethod,
      entry.referenceNumber ?? null,
      entry.description ?? null,
      entry.actor.staffId,
      entry.actor.source,
    ],
  );
  const row = insert.rows[0];
  if (!row) throw new Error('failed to insert ledger transaction');
  await client.query(
    `UPDATE savings_account
        SET current_balance = $1, updated_at = now()
      WHERE id = $2`,
    [entry.balanceAfter, entry.accountId],
  );
  return row.id;
}

// ---------------------------------------------------------------------------
// Rate cards — list, create
// ---------------------------------------------------------------------------

export async function listRateCards(
  actor: AuthContext,
  queryInput: ListRateCardsQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: RateCardView[] }> {
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
      `(min_amount::text ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR max_amount::text ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR interest_rate::text ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR tenure_months::text ILIKE ${addParam(pattern)} ESCAPE '\\')`,
    );
  }
  if (queryInput.tenureMonths !== undefined) {
    where.push(`tenure_months = ${addParam(queryInput.tenureMonths)}`);
  }
  if (queryInput.includeInactive !== 'true') {
    where.push('is_active = true');
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<RateCardListRow>(
    `SELECT id, min_amount::text AS min_amount, max_amount::text AS max_amount,
            tenure_months, interest_rate::text AS interest_rate,
            early_closure_penalty_percent::text AS early_closure_penalty_percent,
            min_holding_months, effective_from::text AS effective_from,
            is_active, created_at, updated_at,
            count(*) OVER()::int AS total
       FROM fd_rate_card
       ${whereSql}
      ORDER BY tenure_months ASC, min_amount ASC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): RateCardView => toRateCardView(row));
  return { total, items };
}

export async function createRateCard(
  actor: AuthContext,
  input: CreateRateCardInput,
  meta: RequestMeta = {},
): Promise<RateCardView> {
  const created = await transaction<RateCardView>(async (client) => {
    if (compareMoney(input.minAmount, input.maxAmount) > 0) {
      throw new BusinessRuleError('minAmount cannot exceed maxAmount', 'RATE_CARD_AMOUNT_RANGE_INVALID');
    }

    const effectiveFrom = input.effectiveFrom ?? istBusinessDate();

    // fd_rate_card carries no unique constraint (bands are continuous ranges),
    // so an active card for the same tenure whose amount band overlaps this
    // one on the same effective date is rejected with an explicit check.
    const overlapping = await client.query<IdRow>(
      `SELECT id
         FROM fd_rate_card
        WHERE is_active = true
          AND tenure_months = $1
          AND effective_from = $2
          AND min_amount <= $3::numeric
          AND max_amount >= $4::numeric
        LIMIT 1`,
      [input.tenureMonths, effectiveFrom, input.maxAmount, input.minAmount],
    );
    if (overlapping.rows[0]) {
      throw new ConflictError(
        `An active FD rate card already covers this amount band and tenure from ${effectiveFrom}`,
        'RATE_CARD_OVERLAP',
      );
    }

    const insert = await client.query<IdRow>(
      `INSERT INTO fd_rate_card
         (min_amount, max_amount, tenure_months, interest_rate,
          early_closure_penalty_percent, min_holding_months, effective_from, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`,
      [
        input.minAmount,
        input.maxAmount,
        input.tenureMonths,
        input.interestRate,
        input.earlyClosurePenaltyPercent,
        input.minHoldingMonths,
        effectiveFrom,
        input.isActive ?? true,
      ],
    );
    const inserted = insert.rows[0];
    if (!inserted) throw new Error('failed to create FD rate card');
    const rateCardId = inserted.id;

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_RATE_CARD_CREATED,
      entityType: 'fd_rate_card',
      entityId: rateCardId,
      metadata: {
        minAmount: input.minAmount,
        maxAmount: input.maxAmount,
        tenureMonths: input.tenureMonths,
        interestRate: input.interestRate,
        earlyClosurePenaltyPercent: input.earlyClosurePenaltyPercent,
        minHoldingMonths: input.minHoldingMonths,
        effectiveFrom,
        isActive: input.isActive ?? true,
        createdBy: actor.staffId,
      },
    });

    const card = await selectRateCardById(client, rateCardId);
    if (!card) throw new NotFoundError('FD rate card');
    return toRateCardView(card);
  });
  return created;
}

// ---------------------------------------------------------------------------
// FD accounts — open, read, list, history
// ---------------------------------------------------------------------------

export async function openAccount(
  actor: AuthContext,
  input: CreateAccountInput,
  meta: RequestMeta = {},
): Promise<FdAccountView> {
  const created = await transaction<FdAccountView>(async (client) => {
    await assertCustomerEligible(client, input.customerId);
    await assertBranchExists(client, input.branchId);

    const card = await selectRateCardById(client, input.rateCardId);
    if (!card) throw new NotFoundError('FD rate card');
    if (!card.is_active) {
      throw new BusinessRuleError('This FD rate card is not active', 'RATE_CARD_INACTIVE');
    }
    if (input.tenureMonths !== card.tenure_months) {
      throw new BusinessRuleError(
        `Tenure ${input.tenureMonths} months does not match the rate card tenure of ${card.tenure_months} months`,
        'TENURE_MISMATCH',
      );
    }
    if (compareMoney(input.depositAmount, card.min_amount) < 0) {
      throw new BusinessRuleError(
        `Deposit is below the rate card minimum of ${card.min_amount}`,
        'DEPOSIT_BELOW_BAND_MIN',
      );
    }
    if (compareMoney(input.depositAmount, card.max_amount) > 0) {
      throw new BusinessRuleError(
        `Deposit exceeds the rate card maximum of ${card.max_amount}`,
        'DEPOSIT_ABOVE_BAND_MAX',
      );
    }
    // Global deposit window (spec §11.1 — ₹1,000 to ₹1,00,000).
    if (compareMoney(input.depositAmount, BUSINESS_RULES.FD_MIN_AMOUNT) < 0) {
      throw new BusinessRuleError(
        `Minimum FD deposit is ${BUSINESS_RULES.FD_MIN_AMOUNT}`,
        'DEPOSIT_BELOW_MIN',
      );
    }
    if (compareMoney(input.depositAmount, BUSINESS_RULES.FD_MAX_AMOUNT) > 0) {
      throw new BusinessRuleError(
        `Maximum FD deposit is ${BUSINESS_RULES.FD_MAX_AMOUNT}`,
        'DEPOSIT_ABOVE_MAX',
      );
    }

    const startDate = input.startDate ?? istBusinessDate();
    const maturityDate = addMonths(startDate, input.tenureMonths);

    const sequence = await allocateSequence(client, 'fd_account');
    const accountNumber = sequence.formatted;

    let accountId: string;
    try {
      const insert = await client.query<IdRow>(
        `INSERT INTO fd_account
           (account_number, customer_id, rate_card_id, branch_id,
            deposit_amount, tenure_months, interest_rate, rate_is_fixed,
            start_date, maturity_date, payout_frequency, payout_mode,
            maturity_action, opened_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         RETURNING id`,
        [
          accountNumber,
          input.customerId,
          input.rateCardId,
          input.branchId,
          input.depositAmount,
          input.tenureMonths,
          card.interest_rate,
          input.rateIsFixed ?? true,
          startDate,
          maturityDate,
          input.payoutFrequency,
          input.payoutMode,
          input.maturityAction,
          actor.staffId,
        ],
      );
      const inserted = insert.rows[0];
      if (!inserted) throw new Error('failed to create FD account');
      accountId = inserted.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('FD account number collision — please retry', 'ACCOUNT_NUMBER_COLLISION');
      }
      throw error;
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.FD_ACCOUNT_OPENED,
      entityType: 'fd_account',
      entityId: accountId,
      metadata: {
        accountNumber,
        customerId: input.customerId,
        rateCardId: input.rateCardId,
        branchId: input.branchId,
        depositAmount: input.depositAmount,
        tenureMonths: input.tenureMonths,
        interestRate: card.interest_rate,
        rateIsFixed: input.rateIsFixed ?? true,
        startDate,
        maturityDate,
        payoutFrequency: input.payoutFrequency,
        payoutMode: input.payoutMode,
        maturityAction: input.maturityAction,
        status: 'active',
        openedBy: actor.staffId,
      },
    });

    return loadFdAccountDetail(client, accountId);
  });
  return created;
}

/**
 * Edits the live terms of an FD account (M.D. only).
 *
 * Only accounts the bank still controls (active / matured) and not under an
 * active lien may be edited. Editable fields: the rate card (re-validated for
 * amount band + tenure, carrying the new card's interest rate forward unless an
 * explicit rate is supplied), the interest rate, the fixed/floating flag and the
 * interest-disposition instructions (payout frequency / mode, maturity action).
 * Principal, tenure, customer, branch, start date and status are immutable here.
 */
export async function updateAccount(
  actor: AuthContext,
  accountId: string,
  input: UpdateAccountInput,
  meta: RequestMeta = {},
): Promise<FdAccountView> {
  const updated = await transaction<FdAccountView>(async (client) => {
    const existing = await selectFdAccountById(client, accountId);
    if (!existing) throw new NotFoundError('FD account');
    if (!LIVE_STATUSES.includes(existing.status)) {
      throw new BusinessRuleError(
        'Only an active or matured FD account can be edited',
        'FD_NOT_EDITABLE',
      );
    }

    const activeLien = await client.query<IdRow>(
      `SELECT id FROM fd_lien WHERE fd_account_id = $1 AND status = 'active' LIMIT 1`,
      [accountId],
    );
    if (activeLien.rows[0]) {
      throw new BusinessRuleError(
        'Release the lien before editing this FD account',
        'FD_UNDER_LIEN',
      );
    }

    const sets: string[] = [];
    const values: unknown[] = [];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };

    let carriedRate: string | undefined;
    if (input.rateCardId !== undefined) {
      const card = await selectRateCardById(client, input.rateCardId);
      if (!card) throw new NotFoundError('FD rate card');
      if (!card.is_active) {
        throw new BusinessRuleError('This FD rate card is not active', 'RATE_CARD_INACTIVE');
      }
      if (existing.tenure_months !== card.tenure_months) {
        throw new BusinessRuleError(
          `Account tenure ${existing.tenure_months} months does not match the rate card tenure of ${card.tenure_months} months`,
          'TENURE_MISMATCH',
        );
      }
      if (compareMoney(existing.deposit_amount, card.min_amount) < 0) {
        throw new BusinessRuleError(
          `Deposit is below the rate card minimum of ${card.min_amount}`,
          'DEPOSIT_BELOW_BAND_MIN',
        );
      }
      if (compareMoney(existing.deposit_amount, card.max_amount) > 0) {
        throw new BusinessRuleError(
          `Deposit exceeds the rate card maximum of ${card.max_amount}`,
          'DEPOSIT_ABOVE_BAND_MAX',
        );
      }
      push('rate_card_id', input.rateCardId);
      // Moving to a new card carries its rate forward unless one is supplied.
      if (input.interestRate === undefined) {
        carriedRate = card.interest_rate;
        push('interest_rate', card.interest_rate);
      }
    }

    if (input.interestRate !== undefined) push('interest_rate', input.interestRate);
    if (input.rateIsFixed !== undefined) push('rate_is_fixed', input.rateIsFixed);
    if (input.payoutFrequency !== undefined) push('payout_frequency', input.payoutFrequency);
    if (input.payoutMode !== undefined) push('payout_mode', input.payoutMode);
    if (input.maturityAction !== undefined) push('maturity_action', input.maturityAction);

    if (sets.length > 0) {
      await client.query(
        `UPDATE fd_account SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length + 1}`,
        [...values, accountId],
      );
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_ACCOUNT_UPDATED,
      entityType: 'fd_account',
      entityId: accountId,
      metadata: {
        accountNumber: existing.account_number,
        fields: Object.keys(input).filter((key) => input[key as keyof UpdateAccountInput] !== undefined),
        ...(carriedRate !== undefined ? { interestRate: carriedRate } : {}),
        updatedBy: actor.staffId,
      },
    });

    return loadFdAccountDetail(client, accountId);
  });
  return updated;
}

export async function listAccounts(
  actor: AuthContext,
  queryInput: ListAccountsQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: FdAccountView[] }> {
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
      `(fa.account_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.mobile ILIKE ${addParam(pattern)} ESCAPE '\\')`,
    );
  }
  if (queryInput.customerId) {
    where.push(`fa.customer_id = ${addParam(queryInput.customerId)}`);
  }
  if (queryInput.rateCardId) {
    where.push(`fa.rate_card_id = ${addParam(queryInput.rateCardId)}`);
  }
  if (queryInput.branchId) {
    where.push(`fa.branch_id = ${addParam(queryInput.branchId)}`);
  }
  if (queryInput.status) {
    where.push(`fa.status = ${addParam(queryInput.status)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<FdAccountListRow>(
    `${FD_ACCOUNT_SELECT.replace('FROM fd_account fa', ', count(*) OVER()::int AS total FROM fd_account fa')}
         ${whereSql}
        ORDER BY fa.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): FdAccountView => toFdAccountView(row));
  return { total, items };
}

export async function getAccount(
  actor: AuthContext,
  accountId: string,
  meta: RequestMeta = {},
): Promise<FdAccountView> {
  const detail = await transaction<FdAccountView>(async (client) => {
    return loadFdAccountDetail(client, accountId);
  });
  await audit(poolForEvent(), {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: ACTION_ACCOUNT_VIEWED,
    entityType: 'fd_account',
    entityId: accountId,
    metadata: { viewedBy: actor.staffId },
  });
  return detail;
}

export async function getHistory(
  actor: AuthContext,
  accountId: string,
  queryInput: HistoryQuery,
  meta: RequestMeta = {},
): Promise<HistoryView> {
  const history = await transaction<HistoryView>(async (client) => {
    const account = await selectFdAccountById(client, accountId);
    if (!account) throw new NotFoundError('FD account');

    const limit = queryInput.limit;
    const offset = queryInput.offset;

    // Append-only events (fd_maturity_event), liens (fd_lien) and interest
    // dispositions (fd_interest_payout) form one time-ordered feed. Numeric
    // columns leave PostgreSQL as text; jsonb `details` arrive as objects.
    const result = await client.query<HistoryPageRow>(
      `SELECT kind, entity_id, event_date, status, amount, reference_number,
              reason, details, created_at,
              count(*) OVER()::int AS total
         FROM (
           SELECT 'maturity_event' AS kind, id AS entity_id,
                  event_date::text AS event_date,
                  event_type AS status,
                  NULL::numeric AS amount, NULL::text AS reference_number,
                  NULL::text AS reason, details, created_at
             FROM fd_maturity_event
            WHERE fd_account_id = $1
           UNION ALL
           SELECT 'lien' AS kind, id AS entity_id,
                  requested_on::date::text AS event_date,
                  status,
                  lien_amount AS amount, NULL::text AS reference_number,
                  reason, NULL::jsonb AS details, created_at
             FROM fd_lien
            WHERE fd_account_id = $1
           UNION ALL
           SELECT 'interest_payout' AS kind, id AS entity_id,
                  payout_date::text AS event_date,
                  payout_mode AS status,
                  amount, reference_number,
                  NULL::text AS reason, NULL::jsonb AS details, created_at
             FROM fd_interest_payout
            WHERE fd_account_id = $1
         ) feed
        ORDER BY feed.created_at DESC
        LIMIT $2 OFFSET $3`,
      [accountId, limit, offset],
    );

    const items: HistoryEventView[] = result.rows.map((row): HistoryEventView => ({
      kind: row.kind as HistoryEventView['kind'],
      entityId: row.entity_id,
      eventDate: row.event_date,
      status: row.status,
      amount: row.amount,
      referenceNumber: row.reference_number,
      reason: row.reason,
      details: (row.details as Record<string, unknown> | null) ?? null,
      createdAt: row.created_at.toISOString(),
    }));
    const total = result.rows[0]?.total ?? 0;
    return { total, items };
  });

  await audit(poolForEvent(), {
    ...actorAuditBase(actor),
    requestId: meta.requestId ?? null,
    action: ACTION_HISTORY_VIEWED,
    entityType: 'fd_account',
    entityId: accountId,
    metadata: { viewedBy: actor.staffId },
  });
  return history;
}

// ---------------------------------------------------------------------------
// Lien — request / release (Managing Director)
// ---------------------------------------------------------------------------

export async function lien(
  actor: AuthContext,
  accountId: string,
  input: LienInput,
  meta: RequestMeta = {},
): Promise<FdAccountView> {
  const updated = await transaction<FdAccountView>(async (client) => {
    const account = await selectFdAccountById(client, accountId);
    if (!account) throw new NotFoundError('FD account');

    if (input.action === 'request') {
      if (!LIENABLE_STATUSES.includes(account.status)) {
        throw new BusinessRuleError(
          `Only an active FD account can be placed under lien (current status: ${account.status})`,
          'ACCOUNT_NOT_LIENABLE',
        );
      }
      if (input.lienAmount === undefined) throw new BadRequestError('lienAmount is required');
      if (compareMoney(input.lienAmount, account.deposit_amount) > 0) {
        throw new BusinessRuleError(
          `Lien amount cannot exceed the deposit of ${account.deposit_amount}`,
          'LIEN_EXCEEDS_DEPOSIT',
        );
      }

      const insert = await client.query<IdRow>(
        `INSERT INTO fd_lien
           (fd_account_id, lien_amount, reason, status, requested_by)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id`,
        [accountId, input.lienAmount, input.reason ?? null, actor.staffId],
      );
      const inserted = insert.rows[0];
      if (!inserted) throw new Error('failed to create FD lien');
      const lienId = inserted.id;

      await client.query(
        `UPDATE fd_account
            SET status = 'under_lien',
                lien_amount = $1::numeric,
                updated_at = now()
          WHERE id = $2`,
        [input.lienAmount, accountId],
      );

      await audit(client, {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.FD_LIEN_SET,
        entityType: 'fd_lien',
        entityId: lienId,
        metadata: {
          fdAccountId: accountId,
          accountNumber: account.account_number,
          lienAmount: input.lienAmount,
          reason: input.reason ?? null,
          status: 'active',
          requestedBy: actor.staffId,
        },
      });
    } else {
      if (account.status !== 'under_lien') {
        throw new BusinessRuleError(
          `Only an FD account under lien can be released (current status: ${account.status})`,
          'ACCOUNT_NOT_UNDER_LIEN',
        );
      }
      const activeLien = await client.query<ActiveLienRow>(
        `SELECT id, lien_amount::text AS lien_amount, reason
           FROM fd_lien
          WHERE fd_account_id = $1 AND status = 'active'
          ORDER BY requested_on DESC
          LIMIT 1`,
        [accountId],
      );
      const lienRow = activeLien.rows[0];
      if (!lienRow) {
        throw new BusinessRuleError('No active lien exists on this FD account', 'NO_ACTIVE_LIEN');
      }

      await client.query(
        `UPDATE fd_lien
            SET status = 'released',
                released_on = now(),
                released_by = $1,
                updated_at = now()
          WHERE id = $2`,
        [actor.staffId, lienRow.id],
      );
      await client.query(
        `UPDATE fd_account
            SET status = 'active',
                lien_amount = '0.00',
                updated_at = now()
          WHERE id = $1`,
        [accountId],
      );

      await audit(client, {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.FD_LIEN_RELEASED,
        entityType: 'fd_lien',
        entityId: lienRow.id,
        metadata: {
          fdAccountId: accountId,
          accountNumber: account.account_number,
          lienAmount: lienRow.lien_amount,
          reason: lienRow.reason,
          status: 'released',
          releasedBy: actor.staffId,
        },
      });
    }

    return loadFdAccountDetail(client, accountId);
  });
  return updated;
}

// ---------------------------------------------------------------------------
// Early closure (Managing Director)
// ---------------------------------------------------------------------------

export async function closeEarly(
  actor: AuthContext,
  accountId: string,
  input: CloseEarlyInput,
  meta: RequestMeta = {},
): Promise<CloseEarlyResult> {
  const result = await transaction<CloseEarlyResult>(async (client) => {
    const account = await selectFdAccountById(client, accountId);
    if (!account) throw new NotFoundError('FD account');
    if (!CLOSEABLE_STATUSES.includes(account.status)) {
      throw new BusinessRuleError(
        `Only an active FD account can be closed early (current status: ${account.status})`,
        'ACCOUNT_NOT_CLOSEABLE',
      );
    }

    const closedOn = istBusinessDate();
    const card = await selectRateCardById(client, account.rate_card_id);

    // Penalty applies only when the deposit is closed inside the rate card's
    // minimum holding window; after that early closure is penalty-free.
    let closurePenalty = '0.00';
    if (card && card.min_holding_months > 0) {
      const penaltyFreeOn = addMonths(account.start_date, card.min_holding_months);
      if (closedOn < penaltyFreeOn) {
        closurePenalty = percentOf(account.deposit_amount, card.early_closure_penalty_percent);
      }
    }

    await client.query(
      `UPDATE fd_account
          SET status = 'closed_early',
              closed_on = $1::date,
              closure_penalty = $2::numeric,
              updated_at = now()
        WHERE id = $3`,
      [closedOn, closurePenalty, accountId],
    );

    await client.query(
      `INSERT INTO fd_maturity_event (fd_account_id, event_type, event_date, details)
       VALUES ($1, 'closed_early', $2, $3)`,
      [
        accountId,
        closedOn,
        JSON.stringify({
          reason: input.reason,
          closurePenalty,
          earlyClosurePenaltyPercent: card?.early_closure_penalty_percent ?? null,
          minHoldingMonths: card?.min_holding_months ?? 0,
          paymentMethod: input.paymentMethod,
          referenceNumber: input.referenceNumber ?? null,
          closedBy: actor.staffId,
        }),
      ],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.FD_CLOSED_EARLY,
      entityType: 'fd_account',
      entityId: accountId,
      metadata: {
        accountNumber: account.account_number,
        reason: input.reason,
        closedOn,
        closurePenalty,
        closurePenaltyPercent: card?.early_closure_penalty_percent ?? null,
        minHoldingMonths: card?.min_holding_months ?? 0,
        depositAmount: account.deposit_amount,
        paymentMethod: input.paymentMethod,
        referenceNumber: input.referenceNumber ?? null,
        closedBy: actor.staffId,
      },
    });

    const accountView = await loadFdAccountDetail(client, accountId);
    return { account: accountView, closurePenalty };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Maturity action (Managing Director) — renew P+I | renew P | savings | cash | bank
// ---------------------------------------------------------------------------

export async function maturityAction(
  actor: AuthContext,
  accountId: string,
  input: MaturityActionInput,
  meta: RequestMeta = {},
): Promise<MaturityActionResult> {
  const result = await transaction<MaturityActionResult>(async (client) => {
    const account = await selectFdAccountById(client, accountId);
    if (!account) throw new NotFoundError('FD account');

    const businessDate = istBusinessDate();
    const maturedByDate = account.maturity_date <= businessDate;
    const settled = account.status !== 'active' && account.status !== 'matured';
    if (settled || (!maturedByDate && account.status !== 'matured')) {
      throw new BusinessRuleError(
        `Only a matured FD account can run a maturity action (current status: ${account.status}, maturity date: ${account.maturity_date})`,
        'ACCOUNT_NOT_MATURED',
      );
    }
    if (account.status === 'under_lien') {
      throw new BusinessRuleError(
        'Release the lien before settling this FD account',
        'ACCOUNT_UNDER_LIEN',
      );
    }

    const deposit = account.deposit_amount;
    const interest = simpleInterest(deposit, account.interest_rate, account.tenure_months);
    const action = input.action;
    const valueDate = businessDate;

    const recordInterestPayout = async (
      mode: 'payout' | 'reinvest',
      savingsTransactionId: string | null,
    ): Promise<void> => {
      await client.query(
        `INSERT INTO fd_interest_payout
           (fd_account_id, payout_date, period_start, period_end, amount,
            payout_mode, reference_number, savings_transaction_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          accountId,
          valueDate,
          account.start_date,
          account.maturity_date,
          interest,
          mode,
          input.referenceNumber ?? null,
          savingsTransactionId,
        ],
      );
    };

    let resultingAccountId = accountId;
    let depositAmount = deposit;

    if (action === 'renew_principal_interest' || action === 'renew_principal') {
      if (input.tenureMonths === undefined) {
        throw new BadRequestError('tenureMonths is required for a renewal action');
      }
      const reinvested = action === 'renew_principal_interest';
      depositAmount = reinvested ? addMoney(deposit, interest) : deposit;

      // The renewed FD must fit an active rate card covering the new deposit
      // and tenure (spec §11.1: automatic renewal — bank decides per case).
      const newCard = await selectActiveRateCardFor(client, depositAmount, input.tenureMonths);
      if (!newCard) {
        throw new BusinessRuleError(
          'No active FD rate card covers the renewal amount and tenure',
          'RATE_CARD_NOT_FOUND_FOR_RENEWAL',
        );
      }
      if (compareMoney(depositAmount, BUSINESS_RULES.FD_MIN_AMOUNT) < 0) {
        throw new BusinessRuleError(
          `Renewed deposit of ${depositAmount} is below the minimum FD amount of ${BUSINESS_RULES.FD_MIN_AMOUNT}`,
          'DEPOSIT_BELOW_MIN',
        );
      }
      if (compareMoney(depositAmount, BUSINESS_RULES.FD_MAX_AMOUNT) > 0) {
        throw new BusinessRuleError(
          `Renewed deposit of ${depositAmount} exceeds the maximum FD amount of ${BUSINESS_RULES.FD_MAX_AMOUNT}`,
          'DEPOSIT_ABOVE_MAX',
        );
      }

      const sequence = await allocateSequence(client, 'fd_account');
      const newNumber = sequence.formatted;
      const newStart = businessDate;
      const newMaturity = addMonths(newStart, input.tenureMonths);

      let newId: string;
      try {
        const insert = await client.query<IdRow>(
          `INSERT INTO fd_account
             (account_number, customer_id, rate_card_id, branch_id,
              deposit_amount, tenure_months, interest_rate, rate_is_fixed,
              start_date, maturity_date, payout_frequency, payout_mode,
              maturity_action, opened_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
           RETURNING id`,
          [
            newNumber,
            account.customer_id,
            newCard.id,
            account.branch_id,
            depositAmount,
            input.tenureMonths,
            newCard.interest_rate,
            account.rate_is_fixed,
            newStart,
            newMaturity,
            account.payout_frequency,
            account.payout_mode,
            'pending',
            actor.staffId,
          ],
        );
        const inserted = insert.rows[0];
        if (!inserted) throw new Error('failed to create renewed FD account');
        newId = inserted.id;
      } catch (error) {
        if (isUniqueViolation(error)) {
          throw new ConflictError('FD account number collision — please retry', 'ACCOUNT_NUMBER_COLLISION');
        }
        throw error;
      }

      // The old FD is closed out of its first term and re-opened under a new
      // number. Interest disposition is recorded so the history feed is whole.
      await recordInterestPayout(reinvested ? 'reinvest' : 'payout', null);

      await client.query(
        `UPDATE fd_account
            SET status = 'renewed',
                closed_on = $1::date,
                updated_at = now()
          WHERE id = $2`,
        [valueDate, accountId],
      );

      await client.query(
        `INSERT INTO fd_maturity_event (fd_account_id, event_type, event_date, details)
         VALUES ($1, 'renewed', $2, $3)`,
        [
          accountId,
          valueDate,
          JSON.stringify({
            action,
            renewedAccountId: newId,
            renewedAccountNumber: newNumber,
            depositAmount,
            interestAmount: interest,
            tenureMonths: input.tenureMonths,
            rateCardId: newCard.id,
            interestRate: newCard.interest_rate,
            renewedBy: actor.staffId,
          }),
        ],
      );

      resultingAccountId = newId;
    } else if (action === 'transfer_to_savings') {
      if (!input.savingsAccountId) {
        throw new BadRequestError('savingsAccountId is required to transfer to savings');
      }
      const savings = await client.query<SavingsAccountRow>(
        `SELECT id, account_number, customer_id, status,
                current_balance::text AS current_balance
           FROM savings_account
          WHERE id = $1
          LIMIT 1`,
        [input.savingsAccountId],
      );
      const savingsRow = savings.rows[0];
      if (!savingsRow) throw new NotFoundError('Savings account');
      if (savingsRow.customer_id !== account.customer_id) {
        throw new BusinessRuleError(
          'The savings account belongs to a different customer',
          'SAVINGS_ACCOUNT_MISMATCH',
        );
      }
      if (savingsRow.status !== 'active') {
        throw new BusinessRuleError(
          `The savings account is not active (status: ${savingsRow.status})`,
          'SAVINGS_ACCOUNT_NOT_ACTIVE',
        );
      }

      // Credit principal then interest; the interest entry is the reference
      // recorded on fd_interest_payout.savings_transaction_id.
      const paymentMethod: PaymentMethod = input.paymentMethod ?? 'bank_transfer';
      const description = `Matured FD ${account.account_number} principal settlement`;
      const principalBalanceAfter = addMoney(savingsRow.current_balance, deposit);
      await insertLedgerEntry(client, {
        accountId: savingsRow.id,
        transactionType: 'deposit',
        direction: 'credit',
        amount: deposit,
        balanceAfter: principalBalanceAfter,
        valueDate,
        paymentMethod,
        referenceNumber: input.referenceNumber ?? undefined,
        description,
        actor,
      });
      const interestBalanceAfter = addMoney(principalBalanceAfter, interest);
      const interestTransactionId = await insertLedgerEntry(client, {
        accountId: savingsRow.id,
        transactionType: 'interest',
        direction: 'credit',
        amount: interest,
        balanceAfter: interestBalanceAfter,
        valueDate,
        paymentMethod,
        referenceNumber: input.referenceNumber ?? undefined,
        description: `Matured FD ${account.account_number} interest settlement`,
        actor,
      });

      await recordInterestPayout('payout', interestTransactionId);

      await client.query(
        `UPDATE fd_account
            SET status = 'closed',
                closed_on = $1::date,
                updated_at = now()
          WHERE id = $2`,
        [valueDate, accountId],
      );

      await client.query(
        `INSERT INTO fd_maturity_event (fd_account_id, event_type, event_date, details)
         VALUES ($1, 'transferred', $2, $3)`,
        [
          accountId,
          valueDate,
          JSON.stringify({
            action,
            savingsAccountId: savingsRow.id,
            savingsAccountNumber: savingsRow.account_number,
            depositAmount: deposit,
            interestAmount: interest,
            principalTransactionType: 'deposit',
            interestTransactionId,
            paymentMethod,
            referenceNumber: input.referenceNumber ?? null,
            transferredBy: actor.staffId,
          }),
        ],
      );
    } else {
      // pay_cash / pay_bank — settlement outside the savings ledger. Interest
      // disposition is recorded; the principal is settled by the given method.
      const paymentMethod: PaymentMethod =
        input.paymentMethod ?? (action === 'pay_cash' ? 'cash' : 'bank_transfer');
      await recordInterestPayout('payout', null);

      await client.query(
        `UPDATE fd_account
            SET status = 'closed',
                closed_on = $1::date,
                updated_at = now()
          WHERE id = $2`,
        [valueDate, accountId],
      );

      await client.query(
        `INSERT INTO fd_maturity_event (fd_account_id, event_type, event_date, details)
         VALUES ($1, 'action_taken', $2, $3)`,
        [
          accountId,
          valueDate,
          JSON.stringify({
            action,
            depositAmount: deposit,
            interestAmount: interest,
            paymentMethod,
            referenceNumber: input.referenceNumber ?? null,
            settledBy: actor.staffId,
          }),
        ],
      );
    }

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.FD_MATURITY_ACTION,
      entityType: 'fd_account',
      entityId: accountId,
      metadata: {
        accountNumber: account.account_number,
        action,
        depositAmount: deposit,
        interestAmount: interest,
        resultingAccountId,
        savingsAccountId: input.savingsAccountId ?? null,
        paymentMethod: input.paymentMethod ?? null,
        referenceNumber: input.referenceNumber ?? null,
        actedBy: actor.staffId,
      },
    });

    const accountView = await loadFdAccountDetail(client, resultingAccountId);
    return { account: accountView, action, depositAmount, interestAmount: interest };
  });
  return result;
}

// ---------------------------------------------------------------------------
// Loan against FD (Managing Director) — ≤ 85% of the FD amount
// ---------------------------------------------------------------------------

export async function loanAgainstFd(
  actor: AuthContext,
  accountId: string,
  input: LoanAgainstFdInput,
  meta: RequestMeta = {},
): Promise<LoanResult> {
  const result = await transaction<LoanResult>(async (client) => {
    const account = await selectFdAccountById(client, accountId);
    if (!account) throw new NotFoundError('FD account');
    if (!LIVE_STATUSES.includes(account.status)) {
      throw new BusinessRuleError(
        `Only a live FD account can back a loan (current status: ${account.status})`,
        'ACCOUNT_NOT_PLEDGEABLE',
      );
    }
    if (account.status === 'under_lien') {
      throw new BusinessRuleError('Release the lien before pledging this FD for a loan', 'ACCOUNT_UNDER_LIEN');
    }
    await assertFdNotPledged(client, accountId);

    const product = await client.query<LoanProductRow>(
      `SELECT id, code, name,
              min_amount::text AS min_amount, max_amount::text AS max_amount,
              min_tenure_months, max_tenure_months,
              interest_method, interest_rate::text AS interest_rate,
              repayment_frequency, is_active
         FROM loan_product
        WHERE id = $1
        LIMIT 1`,
      [input.loanProductId],
    );
    const productRow = product.rows[0];
    if (!productRow) throw new NotFoundError('Loan product');
    if (!productRow.is_active) {
      throw new BusinessRuleError('This loan product is not active', 'LOAN_PRODUCT_INACTIVE');
    }
    if (input.repaymentFrequency !== productRow.repayment_frequency) {
      throw new BusinessRuleError(
        `Repayment frequency ${input.repaymentFrequency} does not match the loan product's ${productRow.repayment_frequency}`,
        'FREQUENCY_MISMATCH',
      );
    }
    if (input.tenureMonths < productRow.min_tenure_months || input.tenureMonths > productRow.max_tenure_months) {
      throw new BusinessRuleError(
        `Tenure ${input.tenureMonths} months falls outside the loan product's ${productRow.min_tenure_months}–${productRow.max_tenure_months} month range`,
        'TERM_OUTSIDE_PRODUCT',
      );
    }
    if (compareMoney(input.amount, productRow.min_amount) < 0) {
      throw new BusinessRuleError(
        `Loan amount is below the product minimum of ${productRow.min_amount}`,
        'AMOUNT_BELOW_PRODUCT_MIN',
      );
    }
    if (compareMoney(input.amount, productRow.max_amount) > 0) {
      throw new BusinessRuleError(
        `Loan amount exceeds the product maximum of ${productRow.max_amount}`,
        'AMOUNT_ABOVE_PRODUCT_MAX',
      );
    }
    if (Number(input.interestRate) < BUSINESS_RULES.MIN_INTEREST_RATE) {
      throw new BusinessRuleError(
        `Interest rate must be at least ${BUSINESS_RULES.MIN_INTEREST_RATE}%`,
        'INTEREST_RATE_BELOW_MIN',
      );
    }
    // Spec §11.1: loan against FD ≤ 85% of the FD amount.
    const maxLoan = percentOf(account.deposit_amount, String(BUSINESS_RULES.FD_LIEN_LOAN_PERCENT));
    if (compareMoney(input.amount, maxLoan) > 0) {
      throw new BusinessRuleError(
        `Loan against this FD is limited to ${BUSINESS_RULES.FD_LIEN_LOAN_PERCENT}% of the deposit (${maxLoan})`,
        'LOAN_EXCEEDS_FD_LIMIT',
      );
    }
    // Interest is flat on the original amount (spec §12.1). The schedule
    // engine here is flat-only; point reducing-balance products to the loans
    // module rather than silently computing the wrong charge.
    if (productRow.interest_method !== 'flat') {
      throw new BusinessRuleError(
        'Only flat-interest loan products can back an FD-secured loan; configure the product to flat',
        'REDUCING_NOT_SUPPORTED_FOR_FD_LOAN',
      );
    }

    const businessDate = istBusinessDate();
    const rate = input.interestRate;
    const frequency = input.repaymentFrequency;

    // --- loan_application --------------------------------------------------
    const applicationSequence = await allocateSequence(client, 'loan_application');
    const applicationNumber = applicationSequence.formatted;
    const applicationInsert = await client.query<IdRow>(
      `INSERT INTO loan_application
         (application_number, customer_id, product_id, purpose,
          requested_amount, approved_amount, tenure_months, repayment_frequency,
          proposed_interest_rate, status, applied_on, applied_by,
          recommended_by, recommended_on, approved_by, approved_on)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'disbursed', $10, $11,
               $11, $12, $11, $12)
       RETURNING id`,
      [
        applicationNumber,
        account.customer_id,
        productRow.id,
        input.purpose,
        input.amount,
        input.amount,
        input.tenureMonths,
        frequency,
        rate,
        businessDate,
        actor.staffId,
        new Date(),
      ],
    );
    const applicationRow = applicationInsert.rows[0];
    if (!applicationRow) throw new Error('failed to create loan application');

    // --- schedule ----------------------------------------------------------
    // Flat interest over the whole term; equal instalments (the last absorbs
    // the rounding remainder), due dates stepping by the repayment frequency
    // from the disbursal date, Sundays shifted to the next working day.
    const totalInterest = simpleInterest(input.amount, rate, input.tenureMonths);
    const totalPayable = addMoney(input.amount, totalInterest);

    const maturity = addMonths(businessDate, input.tenureMonths);
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

    // --- loan --------------------------------------------------------------
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
            next_due_date, against_fd_account_id)
         VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, $8,
                 $9, $10, $11, $12, $13, $14, '0.00', $14, $15, $16)
         RETURNING id`,
        [
          loanNumber,
          applicationRow.id,
          account.customer_id,
          productRow.id,
          account.branch_id,
          input.amount,
          businessDate,
          actor.staffId,
          input.tenureMonths,
          frequency,
          productRow.interest_method,
          rate,
          totalInterest,
          totalPayable,
          dueDates[0] ?? null,
          accountId,
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

    const instalmentNumbers = dueDates.map((_date, index) => index + 1);
    await client.query(
      `INSERT INTO loan_instalment
         (loan_id, instalment_number, due_date, expected_amount)
       SELECT $1, num, due, amt::numeric
         FROM unnest($2::int[], $3::date[], $4::text[]) AS t(num, due, amt)`,
      [loanId, instalmentNumbers, dueDates, instalmentAmounts],
    );

    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: ACTION_LOAN_CREATED,
      entityType: 'loan',
      entityId: loanId,
      metadata: {
        fdAccountId: accountId,
        fdAccountNumber: account.account_number,
        fdDepositAmount: account.deposit_amount,
        loanNumber,
        applicationNumber,
        applicationId: applicationRow.id,
        customerId: account.customer_id,
        productId: productRow.id,
        productCode: productRow.code,
        amount: input.amount,
        maxLoan,
        tenureMonths: input.tenureMonths,
        repaymentFrequency: frequency,
        interestRate: rate,
        interestMethod: productRow.interest_method,
        totalInterest,
        totalPayable,
        instalmentCount: dueDates.length,
        firstDueDate: dueDates[0] ?? null,
        disbursedOn: businessDate,
        disbursedBy: actor.staffId,
      },
    });

    const view: LoanRefView = {
      id: loanId,
      loanNumber,
      applicationNumber,
      customerId: account.customer_id,
      productId: productRow.id,
      amount: input.amount,
      totalPayable,
      status: 'active',
      instalmentCount: dueDates.length,
      nextDueDate: dueDates[0] ?? null,
      createdAt: new Date().toISOString(),
    };
    return { loan: view };
  });
  return result;
}
