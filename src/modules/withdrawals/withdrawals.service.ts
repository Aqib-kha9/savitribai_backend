/**
 * Withdrawals domain service (docs/backend-master-spec.md §13).
 *
 * Lifecycle:
 *   requestWithdrawal  (withdrawals.withdrawal.requested)  creates the request,
 *                      validates the account belongs to an active customer,
 *                      snapshots the available balance and marks the request
 *                      high-value when the amount is above ₹2,00,000
 *     -> approveWithdrawal (withdrawals.withdrawal.approved)  high-value requests
 *                           can only be approved by the President
 *     -> rejectWithdrawal   (withdrawals.withdrawal.rejected)
 *     -> payWithdrawal      (withdrawals.withdrawal.paid)  records identity
 *                           verification + payout reference, debits the linked
 *                           savings account ledger
 *     -> confirmWithdrawal  (withdrawals.withdrawal.confirmed) terminal
 *     -> changeWithdrawal   (withdrawals.withdrawal.changed) President only;
 *                           the original decision is preserved in the event
 *                           history and the request re-enters the pending queue
 *     -> getWithdrawalHistory reads the withdrawal_event trail
 *
 * Business rules enforced here (§13.1 / §13.4):
 *  - minimum balance after withdrawal is ₹100 (full-to-zero always allowed);
 *  - requests above ₹2,00,000 are flagged high-value and only the President may
 *    approve them (matches canApproveWithdrawal in core/permissions.ts);
 *  - identity checks (passbook, signature, Aadhaar) must be recorded before pay;
 *  - a payout reference is mandatory for every non-cash payment method;
 *  - payouts are made to the account holder only — no third-party collection
 *    field exists on the request;
 *  - every state change appends a withdrawal_event row and an audit_event row
 *    in the same transaction; approval decisions are never overwritten — a
 *    Presidential change keeps the original decision in the event trail.
 *
 * Ledger posting: account_transaction requires a non-null savings_account_id so
 * the immutable ledger is only debited for account_kind = 'savings'. RD, FD and
 * loan-surplus requests are tracked end-to-end on withdrawal_request plus their
 * event history; the underlying instrument encashment stays in its own module.
 */

import type { PoolClient } from 'pg';
import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS, type AuditEventInput } from '../../audit/audit-writer.js';
import { istBusinessDate } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors.js';
import type { AuthContext } from '../../types/auth-context.js';
import { allocateSequence } from '../../database/numbering.js';
import { BUSINESS_RULES, compareMoney, isZero, maxMoney, subMoney } from '../../core/money.js';
import { canApproveWithdrawal } from '../../core/permissions.js';
import type {
  AccountKind,
  ApproveWithdrawalInput,
  ChangeWithdrawalInput,
  ConfirmWithdrawalInput,
  ListWithdrawalsQuery,
  PayWithdrawalInput,
  PaymentMethod,
  RejectWithdrawalInput,
  RequestWithdrawalInput,
  WithdrawalEventType,
  WithdrawalStatus,
} from './withdrawals.schemas.js';

// ---------------------------------------------------------------------------
// Module constants
// ---------------------------------------------------------------------------

/** Per-request audit record appended atomically with every mutation. */
type MutationAuditKey =
  | typeof AUDIT_ACTIONS.WITHDRAWAL_REQUESTED
  | typeof AUDIT_ACTIONS.WITHDRAWAL_APPROVED
  | typeof AUDIT_ACTIONS.WITHDRAWAL_REJECTED
  | typeof AUDIT_ACTIONS.WITHDRAWAL_PAID
  | typeof AUDIT_ACTIONS.WITHDRAWAL_CONFIRMED
  | typeof AUDIT_ACTIONS.WITHDRAWAL_CHANGED;

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export interface RequestMeta {
  ipAddress?: string;
  userAgent?: string;
  requestId?: string;
}

export interface WithdrawalView {
  id: string;
  requestNumber: string;
  customerId: string;
  customerNumber: string | null;
  customerMobile: string | null;
  customerName: string;
  customerStatus: string;
  branchId: string;
  branchName: string;
  accountKind: AccountKind;
  /** The linked account for savings/rd/fd; loan-surplus references live only in the event trail. */
  accountId: string | null;
  accountNumber: string | null;
  amount: string;
  balanceBefore: string | null;
  reason: string;
  freeTextReason: string | null;
  paymentMethod: PaymentMethod;
  status: WithdrawalStatus;
  isHighValue: boolean;
  identityVerified: {
    passbook: boolean;
    signature: boolean;
    aadhaar: boolean;
  };
  requestedBy: string | null;
  requestedByName: string | null;
  requestedOn: string | null;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedOn: string | null;
  rejectionReason: string | null;
  paidBy: string | null;
  paidByName: string | null;
  paidOn: string | null;
  payoutReference: string | null;
  confirmedBy: string | null;
  confirmedByName: string | null;
  confirmedOn: string | null;
  /** Free-form operator worksheet captured with the request (see migration 007). */
  documents: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface WithdrawalHistoryEventView {
  id: string;
  withdrawalId: string;
  eventType: WithdrawalEventType;
  eventData: Record<string, unknown> | null;
  performedBy: string | null;
  performedByName: string | null;
  performedSource: string | null;
  createdAt: string;
}

export interface WithdrawalHistoryResult {
  withdrawalId: string;
  requestNumber: string;
  items: WithdrawalHistoryEventView[];
}

// ---------------------------------------------------------------------------
// Row types
// ---------------------------------------------------------------------------

type IdRow = {
  id: string;
};

type WithdrawalCoreRow = {
  id: string;
  request_number: string;
  customer_id: string;
  customer_number: string | null;
  customer_mobile: string | null;
  customer_name: string;
  customer_status: string;
  branch_id: string;
  branch_name: string;
  account_kind: string;
  savings_account_id: string | null;
  rd_account_id: string | null;
  fd_account_id: string | null;
  account_number: string | null;
  amount: string;
  balance_before: string | null;
  reason: string;
  free_text_reason: string | null;
  payment_method: string;
  status: string;
  is_high_value: boolean;
  identity_verified_passbook: boolean;
  identity_verified_signature: boolean;
  identity_verified_aadhaar: boolean;
  requested_by: string | null;
  requested_by_name: string | null;
  requested_on: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_on: Date | null;
  rejection_reason: string | null;
  paid_by: string | null;
  paid_by_name: string | null;
  paid_on: Date | null;
  payout_reference: string | null;
  confirmed_by: string | null;
  confirmed_by_name: string | null;
  confirmed_on: Date | null;
  documents: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
};

type WithdrawalListRow = WithdrawalCoreRow & {
  total: number;
};

type WithdrawalEventRow = {
  id: string;
  withdrawal_id: string;
  event_type: string;
  event_data: Record<string, unknown> | null;
  performed_by: string | null;
  performed_by_name: string | null;
  performed_source: string | null;
  created_at: Date;
};

/** Account snapshots used while validating a request against its source. */
type SavingsSourceRow = {
  id: string;
  customer_id: string;
  branch_id: string;
  account_number: string;
  status: string;
  current_balance: string;
  min_balance: string | null;
};

type PlainSourceRow = {
  id: string;
  customer_id: string;
  branch_id: string;
  account_number: string;
  status: string;
};

type LoanSourceRow = {
  id: string;
  customer_id: string;
  branch_id: string;
  loan_number: string;
  status: string;
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

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === '23505'
  );
}

/** Writes one immutable withdrawal_event history row inside the mutation. */
async function appendWithdrawalEvent(
  client: PoolClient,
  withdrawalId: string,
  eventType: WithdrawalEventType,
  actor: AuthContext,
  eventData?: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO withdrawal_event
       (withdrawal_id, event_type, event_data, performed_by, performed_source)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      withdrawalId,
      eventType,
      eventData !== undefined ? JSON.stringify(eventData) : null,
      actor.staffId,
      actor.source,
    ],
  );
}

const WITHDRAWAL_SELECT = `
  SELECT wr.id, wr.request_number, wr.customer_id,
         c.customer_number, c.mobile AS customer_mobile,
         c.full_name AS customer_name, c.status AS customer_status,
         c.branch_id, b.name AS branch_name,
         wr.account_kind, wr.savings_account_id, wr.rd_account_id, wr.fd_account_id,
         COALESCE(sa.account_number, ra.account_number, fa.account_number) AS account_number,
         wr.amount::text AS amount,
         wr.balance_before::text AS balance_before,
         wr.reason, wr.free_text_reason, wr.payment_method, wr.status,
         wr.is_high_value,
         wr.identity_verified_passbook, wr.identity_verified_signature,
         wr.identity_verified_aadhaar,
         wr.requested_by, rq.full_name AS requested_by_name,
         wr.requested_on::text AS requested_on,
         wr.approved_by, ap.full_name AS approved_by_name, wr.approved_on,
         wr.rejection_reason,
         wr.paid_by, pb.full_name AS paid_by_name, wr.paid_on,
         wr.payout_reference,
         wr.confirmed_by, cb.full_name AS confirmed_by_name, wr.confirmed_on,
         wr.documents,
         wr.created_at, wr.updated_at
    FROM withdrawal_request wr
    JOIN customer c ON c.id = wr.customer_id
    JOIN branch b ON b.id = c.branch_id
    LEFT JOIN staff rq ON rq.id = wr.requested_by
    LEFT JOIN staff ap ON ap.id = wr.approved_by
    LEFT JOIN staff pb ON pb.id = wr.paid_by
    LEFT JOIN staff cb ON cb.id = wr.confirmed_by
    LEFT JOIN savings_account sa ON sa.id = wr.savings_account_id
    LEFT JOIN rd_account ra ON ra.id = wr.rd_account_id
    LEFT JOIN fd_account fa ON fa.id = wr.fd_account_id
`;

async function selectWithdrawalById(client: PoolClient, withdrawalId: string): Promise<WithdrawalCoreRow | null> {
  const result = await client.query<WithdrawalCoreRow>(
    `${WITHDRAWAL_SELECT} WHERE wr.id = $1 LIMIT 1`,
    [withdrawalId],
  );
  return result.rows[0] ?? null;
}

function toWithdrawalView(row: WithdrawalCoreRow): WithdrawalView {
  return {
    id: row.id,
    requestNumber: row.request_number,
    customerId: row.customer_id,
    customerNumber: row.customer_number,
    customerMobile: row.customer_mobile,
    customerName: row.customer_name,
    customerStatus: row.customer_status,
    branchId: row.branch_id,
    branchName: row.branch_name,
    accountKind: row.account_kind as AccountKind,
    accountId: row.savings_account_id ?? row.rd_account_id ?? row.fd_account_id,
    accountNumber: row.account_number,
    amount: row.amount,
    balanceBefore: row.balance_before,
    reason: row.reason,
    freeTextReason: row.free_text_reason,
    paymentMethod: row.payment_method as PaymentMethod,
    status: row.status as WithdrawalStatus,
    isHighValue: row.is_high_value,
    identityVerified: {
      passbook: row.identity_verified_passbook,
      signature: row.identity_verified_signature,
      aadhaar: row.identity_verified_aadhaar,
    },
    requestedBy: row.requested_by,
    requestedByName: row.requested_by_name,
    requestedOn: row.requested_on,
    approvedBy: row.approved_by,
    approvedByName: row.approved_by_name,
    approvedOn: iso(row.approved_on),
    rejectionReason: row.rejection_reason,
    paidBy: row.paid_by,
    paidByName: row.paid_by_name,
    paidOn: iso(row.paid_on),
    payoutReference: row.payout_reference,
    confirmedBy: row.confirmed_by,
    confirmedByName: row.confirmed_by_name,
    confirmedOn: iso(row.confirmed_on),
    documents: row.documents,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

async function loadWithdrawal(client: PoolClient, withdrawalId: string): Promise<WithdrawalView> {
  const row = await selectWithdrawalById(client, withdrawalId);
  if (!row) throw new NotFoundError('Withdrawal request');
  return toWithdrawalView(row);
}

function assertCustomerWithdrawable(customerStatus: string): void {
  if (customerStatus !== 'active') {
    throw new BusinessRuleError(
      `Customer status '${customerStatus}' does not permit withdrawals`,
      'CUSTOMER_NOT_ELIGIBLE',
    );
  }
}

async function selectCustomerStatus(client: PoolClient, customerId: string): Promise<string | null> {
  const result = await client.query<{ status: string }>(
    `SELECT status FROM customer WHERE id = $1 LIMIT 1`,
    [customerId],
  );
  return result.rows[0]?.status ?? null;
}

async function selectSavingsSource(client: PoolClient, accountId: string): Promise<SavingsSourceRow | null> {
  const result = await client.query<SavingsSourceRow>(
    `SELECT sa.id, sa.customer_id, sa.branch_id, sa.account_number, sa.status,
            sa.current_balance::text AS current_balance,
            p.min_balance::text AS min_balance
       FROM savings_account sa
       JOIN deposit_product p ON p.id = sa.product_id
      WHERE sa.id = $1
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

async function selectRdSource(client: PoolClient, accountId: string): Promise<PlainSourceRow | null> {
  const result = await client.query<PlainSourceRow>(
    `SELECT id, customer_id, branch_id, account_number, status
       FROM rd_account
      WHERE id = $1
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

async function selectFdSource(client: PoolClient, accountId: string): Promise<PlainSourceRow | null> {
  const result = await client.query<PlainSourceRow>(
    `SELECT id, customer_id, branch_id, account_number, status
       FROM fd_account
      WHERE id = $1
      LIMIT 1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

async function selectLoanSource(client: PoolClient, loanId: string): Promise<LoanSourceRow | null> {
  const result = await client.query<LoanSourceRow>(
    `SELECT id, customer_id, branch_id, loan_number, status
       FROM loan
      WHERE id = $1
      LIMIT 1`,
    [loanId],
  );
  return result.rows[0] ?? null;
}

async function selectHeldSurplusExists(client: PoolClient, loanId: string): Promise<boolean> {
  const result = await client.query<{ id: string }>(
    `SELECT id FROM loan_surplus
      WHERE loan_id = $1 AND entry_type = 'held'
      LIMIT 1`,
    [loanId],
  );
  return result.rows[0] !== undefined;
}

/**
 * Validates that the withdrawal can be drawn against the live savings balance
 * and returns the resulting balance. The minimum-balance floor is the greater
 * of the product minimum and the global ₹100 savings minimum; a withdrawal
 * that closes the account to zero is always permitted.
 */
async function assertSavingsWithdrawable(
  client: PoolClient,
  savingsAccountId: string,
  amount: string,
): Promise<string> {
  const account = await selectSavingsSource(client, savingsAccountId);
  if (!account) throw new NotFoundError('Savings account');
  if (account.status !== 'active') {
    throw new BusinessRuleError('Savings account is not active', 'ACCOUNT_NOT_ACTIVE');
  }
  if (compareMoney(amount, account.current_balance) > 0) {
    throw new BusinessRuleError('Withdrawal amount exceeds the available balance', 'INSUFFICIENT_BALANCE');
  }
  const balanceAfter = subMoney(account.current_balance, amount);
  if (!isZero(balanceAfter)) {
    const floor =
      account.min_balance !== null && account.min_balance !== ''
        ? maxMoney(account.min_balance, BUSINESS_RULES.SAVINGS_MIN_BALANCE)
        : BUSINESS_RULES.SAVINGS_MIN_BALANCE;
    if (compareMoney(balanceAfter, floor) < 0) {
      throw new BusinessRuleError(
        `Withdrawal would leave the balance below the minimum of ${floor}`,
        'MIN_BALANCE_VIOLATION',
      );
    }
  }
  return balanceAfter;
}

/**
 * Posts the immutable savings ledger debit for a paid withdrawal and updates
 * the account balance atomically. transaction_type = withdrawal, direction =
 * debit; withdrawal_request_id links the entry back to the request (§13.2).
 */
async function insertWithdrawalLedgerEntry(
  client: PoolClient,
  entry: {
    savingsAccountId: string;
    amount: string;
    balanceAfter: string;
    valueDate: string;
    paymentMethod: PaymentMethod;
    referenceNumber?: string | null;
    description?: string | null;
    withdrawalRequestId: string;
    actor: AuthContext;
  },
): Promise<string> {
  const insert = await client.query<IdRow>(
    `INSERT INTO account_transaction
       (savings_account_id, transaction_type, direction, amount, balance_after,
        value_date, payment_method, reference_number, description,
        performed_by, performed_source, withdrawal_request_id)
     VALUES ($1, 'withdrawal', 'debit', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      entry.savingsAccountId,
      entry.amount,
      entry.balanceAfter,
      entry.valueDate,
      entry.paymentMethod,
      entry.referenceNumber ?? null,
      entry.description ?? null,
      entry.actor.staffId,
      entry.actor.source,
      entry.withdrawalRequestId,
    ],
  );
  const row = insert.rows[0];
  if (!row) throw new Error('failed to insert withdrawal ledger entry');
  await client.query(
    `UPDATE savings_account
        SET current_balance = $1, updated_at = now()
      WHERE id = $2`,
    [entry.balanceAfter, entry.savingsAccountId],
  );
  return row.id;
}

/**
 * Resolves and validates the account the withdrawal is drawn against, returning
 * the derived customer plus the FK columns to persist. savings carries full
 * balance validation; rd/fd must exist, be owned by the customer and be in an
 * encashable state; loan_surplus references a loan of the customer that still
 * holds surplus (the withdrawal_request has no loan FK column, so the reference
 * is preserved in the event trail instead).
 */
async function resolveWithdrawalSource(
  client: PoolClient,
  accountKind: AccountKind,
  accountId: string,
  amount: string,
): Promise<{
  customerId: string;
  savingsAccountId: string | null;
  rdAccountId: string | null;
  fdAccountId: string | null;
  balanceBefore: string | null;
}> {
  switch (accountKind) {
    case 'savings': {
      const account = await selectSavingsSource(client, accountId);
      if (!account) throw new NotFoundError('Savings account');
      const customerStatus = await selectCustomerStatus(client, account.customer_id);
      if (customerStatus === null) throw new NotFoundError('Customer');
      assertCustomerWithdrawable(customerStatus);
      const balanceAfter = await assertSavingsWithdrawable(client, account.id, amount);
      void balanceAfter;
      return {
        customerId: account.customer_id,
        savingsAccountId: account.id,
        rdAccountId: null,
        fdAccountId: null,
        balanceBefore: account.current_balance,
      };
    }
    case 'rd': {
      const account = await selectRdSource(client, accountId);
      if (!account) throw new NotFoundError('RD account');
      const customerStatus = await selectCustomerStatus(client, account.customer_id);
      if (customerStatus === null) throw new NotFoundError('Customer');
      assertCustomerWithdrawable(customerStatus);
      if (account.status !== 'active') {
        throw new BusinessRuleError(`RD account is not active (${account.status})`, 'ACCOUNT_NOT_ACTIVE');
      }
      return {
        customerId: account.customer_id,
        savingsAccountId: null,
        rdAccountId: account.id,
        fdAccountId: null,
        balanceBefore: null,
      };
    }
    case 'fd': {
      const account = await selectFdSource(client, accountId);
      if (!account) throw new NotFoundError('FD account');
      const customerStatus = await selectCustomerStatus(client, account.customer_id);
      if (customerStatus === null) throw new NotFoundError('Customer');
      assertCustomerWithdrawable(customerStatus);
      if (account.status !== 'active' && account.status !== 'matured') {
        throw new BusinessRuleError(
          `FD account is not encashable (${account.status})`,
          'ACCOUNT_NOT_ACTIVE',
        );
      }
      return {
        customerId: account.customer_id,
        savingsAccountId: null,
        rdAccountId: null,
        fdAccountId: account.id,
        balanceBefore: null,
      };
    }
    case 'loan_surplus': {
      const loan = await selectLoanSource(client, accountId);
      if (!loan) throw new NotFoundError('Loan');
      const customerStatus = await selectCustomerStatus(client, loan.customer_id);
      if (customerStatus === null) throw new NotFoundError('Customer');
      assertCustomerWithdrawable(customerStatus);
      const hasSurplus = await selectHeldSurplusExists(client, loan.id);
      if (!hasSurplus) {
        throw new BusinessRuleError(
          'No surplus is currently held on this loan',
          'NO_SURPLUS_AVAILABLE',
        );
      }
      return {
        customerId: loan.customer_id,
        savingsAccountId: null,
        rdAccountId: null,
        fdAccountId: null,
        balanceBefore: null,
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

export async function listWithdrawals(
  actor: AuthContext,
  queryInput: ListWithdrawalsQuery,
  meta: RequestMeta = {},
): Promise<{ total: number; items: WithdrawalView[] }> {
  void actor;
  void meta;
  const where: string[] = [];
  const params: unknown[] = [];
  const addParam = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };

  if (queryInput.status) {
    where.push(`wr.status = ${addParam(queryInput.status)}`);
  }
  if (queryInput.accountKind) {
    where.push(`wr.account_kind = ${addParam(queryInput.accountKind)}`);
  }
  if (queryInput.from) {
    where.push(`wr.requested_on >= ${addParam(queryInput.from)}`);
  }
  if (queryInput.to) {
    where.push(`wr.requested_on <= ${addParam(queryInput.to)}`);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = queryInput.limit;
  const offset = queryInput.offset;

  const result = await query<WithdrawalListRow>(
    `WITH filtered AS (
       ${WITHDRAWAL_SELECT}
       ${whereSql}
     )
     SELECT f.*, count(*) OVER()::int AS total
       FROM filtered f
      ORDER BY f.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  const total = result.rows[0]?.total ?? 0;
  const items = result.rows.map((row): WithdrawalView => toWithdrawalView(row));
  return { total, items };
}

export async function getWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  void actor;
  void meta;
  const row = await query<WithdrawalCoreRow>(
    `${WITHDRAWAL_SELECT} WHERE wr.id = $1 LIMIT 1`,
    [withdrawalId],
  );
  const found = row.rows[0];
  if (!found) throw new NotFoundError('Withdrawal request');
  return toWithdrawalView(found);
}

export async function requestWithdrawal(
  actor: AuthContext,
  input: RequestWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const created = await transaction<WithdrawalView>(async (client) => {
    const source = await resolveWithdrawalSource(client, input.accountKind, input.accountId, input.amount);
    if (source.customerId === null) {
      throw new BadRequestError('Withdrawal must reference an account that belongs to a customer');
    }

    const isHighValue = compareMoney(input.amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0;
    const identityVerified = input.identityVerified ?? { passbook: false, signature: false, aadhaar: false };

    // The withdrawal number sequence is seeded under the `withdrawal` entity
    // type (prefix `WDL`, 5-digit padding — see seed.ts / docs/testing-sequence.md).
    // It must match exactly or allocateSequence throws
    // "number sequence not configured for entity type".
    const sequence = await allocateSequence(client, 'withdrawal');
    const requestNumber = sequence.formatted;

    let withdrawalId: string;
    try {
      const insert = await client.query<IdRow>(
        `INSERT INTO withdrawal_request
           (request_number, customer_id, account_kind,
            savings_account_id, rd_account_id, fd_account_id,
            amount, balance_before, reason, free_text_reason, payment_method,
            status, is_high_value,
            identity_verified_passbook, identity_verified_signature,
            identity_verified_aadhaar,
            requested_by, requested_on, documents)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'pending', $12, $13, $14, $15, $16, $17, $18::jsonb)
         RETURNING id`,
        [
          requestNumber,
          source.customerId,
          input.accountKind,
          source.savingsAccountId,
          source.rdAccountId,
          source.fdAccountId,
          input.amount,
          source.balanceBefore,
          input.reason,
          input.freeTextReason ?? null,
          input.paymentMethod,
          isHighValue,
          identityVerified.passbook,
          identityVerified.signature,
          identityVerified.aadhaar,
          actor.staffId,
          istBusinessDate(),
          input.documents ? JSON.stringify(input.documents) : null,
        ],
      );
      const inserted = insert.rows[0];
      if (!inserted) throw new Error('failed to create withdrawal request');
      withdrawalId = inserted.id;
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new ConflictError('Withdrawal request number collision — please retry', 'REQUEST_NUMBER_COLLISION');
      }
      throw error;
    }

    const eventData: Record<string, unknown> = {
      requestNumber,
      accountKind: input.accountKind,
      accountId: input.accountId,
      amount: input.amount,
      paymentMethod: input.paymentMethod,
      isHighValue,
      balanceBefore: source.balanceBefore,
      reason: input.reason,
      freeTextReason: input.freeTextReason ?? null,
      identityVerified: { passbook: identityVerified.passbook, signature: identityVerified.signature, aadhaar: identityVerified.aadhaar },
      documents: input.documents ?? null,
      requestedBy: actor.staffId,
    };
    await appendWithdrawalEvent(client, withdrawalId, 'requested', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_REQUESTED,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return created;
}

export async function approveWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  input: ApproveWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const approved = await transaction<WithdrawalView>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');
    if (row.status !== 'pending') {
      throw new BusinessRuleError(
        `A ${row.status} withdrawal request cannot be approved`,
        'WITHDRAWAL_NOT_APPROVABLE',
      );
    }

    // High-value requests (> ₹2,00,000) may only be approved by the President.
    // Below the threshold any actor with the withdrawals.approve permission
    // qualifies (route already requires the permission).
    if (!canApproveWithdrawal(actor.role, actor.permissions, Number(row.amount))) {
      throw new BusinessRuleError(
        'High-value withdrawals above ₹2,00,000 can only be approved by the President',
        'HIGH_VALUE_APPROVAL_REQUIRED',
      );
    }

    await client.query(
      `UPDATE withdrawal_request
          SET status = 'approved', approved_by = $1, approved_on = now(), updated_at = now()
        WHERE id = $2`,
      [actor.staffId, withdrawalId],
    );

    const eventData: Record<string, unknown> = {
      amount: row.amount,
      isHighValue: row.is_high_value,
      comment: input.comment ?? null,
      approvedBy: actor.staffId,
    };
    await appendWithdrawalEvent(client, withdrawalId, 'approved', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_APPROVED,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return approved;
}

export async function rejectWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  input: RejectWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const rejected = await transaction<WithdrawalView>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');
    if (row.status !== 'pending' && row.status !== 'approved') {
      throw new BusinessRuleError(
        `A ${row.status} withdrawal request cannot be rejected`,
        'WITHDRAWAL_NOT_REJECTABLE',
      );
    }

    // The original approval is preserved (never overwritten) — only the status
    // and rejection reason change on the request.
    await client.query(
      `UPDATE withdrawal_request
          SET status = 'rejected', rejection_reason = $1, updated_at = now()
        WHERE id = $2`,
      [input.reason, withdrawalId],
    );

    const eventData: Record<string, unknown> = {
      amount: row.amount,
      previousStatus: row.status,
      rejectionReason: input.reason,
      rejectedBy: actor.staffId,
    };
    await appendWithdrawalEvent(client, withdrawalId, 'rejected', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_REJECTED,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return rejected;
}

export async function payWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  input: PayWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const paid = await transaction<WithdrawalView>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');
    if (row.status !== 'approved') {
      throw new BusinessRuleError(
        `Only an approved withdrawal can be paid (current status: ${row.status})`,
        'WITHDRAWAL_NOT_PAYABLE',
      );
    }

    const method = row.payment_method as PaymentMethod;
    const payoutReference = input.payoutReference ?? null;
    if (method !== 'cash' && (payoutReference === null || payoutReference === '')) {
      throw new BusinessRuleError(
        'A payout reference is required for non-cash payment methods',
        'PAYOUT_REFERENCE_REQUIRED',
      );
    }

    // Identity checks (passbook + signature + Aadhaar) must all be recorded
    // before the payout (spec §13.1). They may be captured at the counter now.
    const identity = input.identityVerified ?? { passbook: false, signature: false, aadhaar: false };
    const passbook = row.identity_verified_passbook || identity.passbook;
    const signature = row.identity_verified_signature || identity.signature;
    const aadhaar = row.identity_verified_aadhaar || identity.aadhaar;
    if (!passbook || !signature || !aadhaar) {
      throw new BusinessRuleError(
        'Identity verification (passbook, signature and Aadhaar) must be recorded before payout',
        'IDENTITY_VERIFICATION_REQUIRED',
      );
    }

    let ledgerTransactionId: string | null = null;
    if (row.account_kind === 'savings' && row.savings_account_id !== null) {
      const balanceAfter = await assertSavingsWithdrawable(client, row.savings_account_id, row.amount);
      ledgerTransactionId = await insertWithdrawalLedgerEntry(client, {
        savingsAccountId: row.savings_account_id,
        amount: row.amount,
        balanceAfter,
        valueDate: istBusinessDate(),
        paymentMethod: method,
        referenceNumber: payoutReference,
        description: `Withdrawal ${row.request_number}`,
        withdrawalRequestId: withdrawalId,
        actor,
      });
    }

    await client.query(
      `UPDATE withdrawal_request
          SET status = 'paid', paid_by = $1, paid_on = now(),
              payout_reference = $2,
              identity_verified_passbook = $3,
              identity_verified_signature = $4,
              identity_verified_aadhaar = $5,
              updated_at = now()
        WHERE id = $6`,
      [actor.staffId, payoutReference, passbook, signature, aadhaar, withdrawalId],
    );

    const eventData: Record<string, unknown> = {
      amount: row.amount,
      paymentMethod: method,
      payoutReference,
      ledgerTransactionId,
      accountKind: row.account_kind,
      paidBy: actor.staffId,
    };
    await appendWithdrawalEvent(client, withdrawalId, 'paid', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_PAID,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return paid;
}

export async function confirmWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  _input: ConfirmWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const confirmed = await transaction<WithdrawalView>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');
    if (row.status !== 'paid') {
      throw new BusinessRuleError(
        `Only a paid withdrawal can be confirmed (current status: ${row.status})`,
        'WITHDRAWAL_NOT_CONFIRMABLE',
      );
    }

    await client.query(
      `UPDATE withdrawal_request
          SET status = 'confirmed', confirmed_by = $1, confirmed_on = now(), updated_at = now()
        WHERE id = $2`,
      [actor.staffId, withdrawalId],
    );

    const eventData: Record<string, unknown> = {
      amount: row.amount,
      payoutReference: row.payout_reference,
      confirmedBy: actor.staffId,
    };
    await appendWithdrawalEvent(client, withdrawalId, 'confirmed', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_CONFIRMED,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return confirmed;
}

export async function changeWithdrawal(
  actor: AuthContext,
  withdrawalId: string,
  input: ChangeWithdrawalInput,
  meta: RequestMeta = {},
): Promise<WithdrawalView> {
  const changed = await transaction<WithdrawalView>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');
    if (row.status !== 'approved') {
      throw new BusinessRuleError(
        `Only an approved withdrawal can be changed by the President (current status: ${row.status})`,
        'WITHDRAWAL_NOT_CHANGEABLE',
      );
    }
    if (actor.role !== 'president') {
      throw new BusinessRuleError(
        'Only the President can change an approved withdrawal',
        'PRESIDENT_APPROVAL_REQUIRED',
      );
    }

    // The new amount must clear the same balance rules as a fresh request.
    let balanceBefore = row.balance_before;
    if (row.account_kind === 'savings' && row.savings_account_id !== null) {
      const account = await selectSavingsSource(client, row.savings_account_id);
      if (!account) throw new NotFoundError('Savings account');
      const newBalanceAfter = await assertSavingsWithdrawable(client, row.savings_account_id, input.amount);
      void newBalanceAfter;
      balanceBefore = account.current_balance;
    }

    const newIsHighValue = compareMoney(input.amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0;

    // The request re-enters the pending queue for a fresh approval. The original
    // decision (approver, timestamp, amount) is preserved in the changed event.
    await client.query(
      `UPDATE withdrawal_request
          SET amount = $1, balance_before = $2, reason = $3, free_text_reason = $4,
              is_high_value = $5, status = 'pending',
              approved_by = NULL, approved_on = NULL, rejection_reason = NULL,
              updated_at = now()
        WHERE id = $6`,
      [
        input.amount,
        balanceBefore,
        input.reason,
        input.freeTextReason ?? null,
        newIsHighValue,
        withdrawalId,
      ],
    );

    const eventData: Record<string, unknown> = {
      previous: {
        amount: row.amount,
        balanceBefore: row.balance_before,
        reason: row.reason,
        freeTextReason: row.free_text_reason,
        isHighValue: row.is_high_value,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        approvedOn: iso(row.approved_on),
      },
      change: {
        amount: input.amount,
        balanceBefore,
        reason: input.reason,
        freeTextReason: input.freeTextReason ?? null,
        isHighValue: newIsHighValue,
        changedBy: actor.staffId,
      },
    };
    await appendWithdrawalEvent(client, withdrawalId, 'changed', actor, eventData);
    await audit(client, {
      ...actorAuditBase(actor),
      requestId: meta.requestId ?? null,
      action: AUDIT_ACTIONS.WITHDRAWAL_CHANGED,
      entityType: 'withdrawal_request',
      entityId: withdrawalId,
      metadata: eventData,
    });

    return loadWithdrawal(client, withdrawalId);
  });
  return changed;
}

export async function getWithdrawalHistory(
  actor: AuthContext,
  withdrawalId: string,
  meta: RequestMeta = {},
): Promise<WithdrawalHistoryResult> {
  void actor;
  void meta;
  return transaction<WithdrawalHistoryResult>(async (client) => {
    const row = await selectWithdrawalById(client, withdrawalId);
    if (!row) throw new NotFoundError('Withdrawal request');

    const result = await client.query<WithdrawalEventRow>(
      `SELECT e.id, e.withdrawal_id, e.event_type, e.event_data,
              e.performed_by, s.full_name AS performed_by_name,
              e.performed_source, e.created_at
         FROM withdrawal_event e
         LEFT JOIN staff s ON s.id = e.performed_by
        WHERE e.withdrawal_id = $1
        ORDER BY e.created_at ASC, e.id ASC`,
      [withdrawalId],
    );

    const items = result.rows.map((event): WithdrawalHistoryEventView => ({
      id: event.id,
      withdrawalId: event.withdrawal_id,
      eventType: event.event_type as WithdrawalEventType,
      eventData: event.event_data,
      performedBy: event.performed_by,
      performedByName: event.performed_by_name,
      performedSource: event.performed_source,
      createdAt: event.created_at.toISOString(),
    }));

    return {
      withdrawalId: row.id,
      requestNumber: row.request_number,
      items,
    };
  });
}

// ---------------------------------------------------------------------------
// Re-exported audit key type (used by routes/tests to reason about mutations)
// ---------------------------------------------------------------------------

export type { MutationAuditKey };
