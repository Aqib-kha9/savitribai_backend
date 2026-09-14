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
import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS } from '../../audit/audit-writer.js';
import { istBusinessDate } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, } from '../../core/errors.js';
import { allocateSequence } from '../../database/numbering.js';
import { BUSINESS_RULES, addMoney, compareMoney, isZero, maxMoney, subMoney } from '../../core/money.js';
import { hasPermission, isSuperAdmin } from '../../core/permissions.js';
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function audit(client, input) {
    const event = {
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
    if (input.metadata !== undefined)
        event.metadata = input.metadata;
    return appendAuditEvent(client, event);
}
function actorAuditBase(actor) {
    return {
        actorStaffId: actor.staffId,
        actorRole: actor.role,
        actorStaffCode: actor.staffCode,
        source: actor.source,
        requestId: null,
    };
}
const iso = (value) => (value ? value.toISOString() : null);
function isUniqueViolation(error) {
    return (typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        error.code === '23505');
}
/** Writes one immutable withdrawal_event history row inside the mutation. */
async function appendWithdrawalEvent(client, withdrawalId, eventType, actor, eventData) {
    await client.query(`INSERT INTO withdrawal_event
       (withdrawal_id, event_type, event_data, performed_by, performed_source)
     VALUES ($1, $2, $3, $4, $5)`, [
        withdrawalId,
        eventType,
        eventData !== undefined ? JSON.stringify(eventData) : null,
        actor.staffId,
        actor.source,
    ]);
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
         wr.cancelled_by, cc.full_name AS cancelled_by_name, wr.cancelled_on,
         wr.cancellation_reason,
         wr.reversed_by, rv.full_name AS reversed_by_name, wr.reversed_on,
         wr.reversal_reason, wr.reversal_transaction_id,
         wr.idempotency_key,
         wr.documents,
         wr.created_at, wr.updated_at
    FROM withdrawal_request wr
    JOIN customer c ON c.id = wr.customer_id
    JOIN branch b ON b.id = c.branch_id
    LEFT JOIN staff rq ON rq.id = wr.requested_by
    LEFT JOIN staff ap ON ap.id = wr.approved_by
    LEFT JOIN staff pb ON pb.id = wr.paid_by
    LEFT JOIN staff cb ON cb.id = wr.confirmed_by
    LEFT JOIN staff cc ON cc.id = wr.cancelled_by
    LEFT JOIN staff rv ON rv.id = wr.reversed_by
    LEFT JOIN savings_account sa ON sa.id = wr.savings_account_id
    LEFT JOIN rd_account ra ON ra.id = wr.rd_account_id
    LEFT JOIN fd_account fa ON fa.id = wr.fd_account_id
`;
/**
 * Loads one withdrawal request. When `forUpdate` is set the row (and only the
 * withdrawal_request row — the joined lookup tables stay unlocked) is locked
 * FOR UPDATE so two concurrent transitions cannot both read 'approved' and both
 * post a ledger debit (READ COMMITTED double-spend guard, CRITICAL-1).
 */
async function selectWithdrawalById(client, withdrawalId, forUpdate = false) {
    const lock = forUpdate ? ' FOR UPDATE OF wr' : '';
    const result = await client.query(`${WITHDRAWAL_SELECT} WHERE wr.id = $1${lock}`, [withdrawalId]);
    return result.rows[0] ?? null;
}
function toWithdrawalView(row) {
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
        accountKind: row.account_kind,
        accountId: row.savings_account_id ?? row.rd_account_id ?? row.fd_account_id,
        accountNumber: row.account_number,
        amount: row.amount,
        balanceBefore: row.balance_before,
        reason: row.reason,
        freeTextReason: row.free_text_reason,
        paymentMethod: row.payment_method,
        status: row.status,
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
        cancelledBy: row.cancelled_by,
        cancelledByName: row.cancelled_by_name,
        cancelledOn: iso(row.cancelled_on),
        cancellationReason: row.cancellation_reason,
        reversedBy: row.reversed_by,
        reversedByName: row.reversed_by_name,
        reversedOn: iso(row.reversed_on),
        reversalReason: row.reversal_reason,
        reversalTransactionId: row.reversal_transaction_id,
        idempotencyKey: row.idempotency_key,
        documents: row.documents,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function loadWithdrawal(client, withdrawalId, forUpdate = false) {
    const row = await selectWithdrawalById(client, withdrawalId, forUpdate);
    if (!row)
        throw new NotFoundError('Withdrawal request');
    return toWithdrawalView(row);
}
function assertCustomerWithdrawable(customerStatus) {
    if (customerStatus !== 'active') {
        throw new BusinessRuleError(`Customer status '${customerStatus}' does not permit withdrawals`, 'CUSTOMER_NOT_ELIGIBLE');
    }
}
async function selectCustomerStatus(client, customerId) {
    const result = await client.query(`SELECT status FROM customer WHERE id = $1 LIMIT 1`, [customerId]);
    return result.rows[0]?.status ?? null;
}
async function selectSavingsSource(client, accountId) {
    const result = await client.query(`SELECT sa.id, sa.customer_id, sa.branch_id, sa.account_number, sa.status,
            sa.current_balance::text AS current_balance,
            p.min_balance::text AS min_balance
       FROM savings_account sa
       JOIN deposit_product p ON p.id = sa.product_id
      WHERE sa.id = $1
      LIMIT 1`, [accountId]);
    return result.rows[0] ?? null;
}
async function selectRdSource(client, accountId) {
    const result = await client.query(`SELECT id, customer_id, branch_id, account_number, status
       FROM rd_account
      WHERE id = $1
      LIMIT 1`, [accountId]);
    return result.rows[0] ?? null;
}
async function selectFdSource(client, accountId) {
    const result = await client.query(`SELECT id, customer_id, branch_id, account_number, status
       FROM fd_account
      WHERE id = $1
      LIMIT 1`, [accountId]);
    return result.rows[0] ?? null;
}
async function selectLoanSource(client, loanId) {
    const result = await client.query(`SELECT id, customer_id, branch_id, loan_number, status
       FROM loan
      WHERE id = $1
      LIMIT 1`, [loanId]);
    return result.rows[0] ?? null;
}
async function selectHeldSurplusExists(client, loanId) {
    const result = await client.query(`SELECT id FROM loan_surplus
      WHERE loan_id = $1 AND entry_type = 'held'
      LIMIT 1`, [loanId]);
    return result.rows[0] !== undefined;
}
/**
 * Validates that the withdrawal can be drawn against the live savings balance
 * and returns the resulting balance. The minimum-balance floor is the greater
 * of the product minimum and the global ₹100 savings minimum; a withdrawal
 * that closes the account to zero is always permitted.
 */
async function assertSavingsWithdrawable(client, savingsAccountId, amount) {
    const account = await selectSavingsSource(client, savingsAccountId);
    if (!account)
        throw new NotFoundError('Savings account');
    if (account.status !== 'active') {
        throw new BusinessRuleError('Savings account is not active', 'ACCOUNT_NOT_ACTIVE');
    }
    if (compareMoney(amount, account.current_balance) > 0) {
        throw new BusinessRuleError('Withdrawal amount exceeds the available balance', 'INSUFFICIENT_BALANCE');
    }
    const balanceAfter = subMoney(account.current_balance, amount);
    if (!isZero(balanceAfter)) {
        const floor = account.min_balance !== null && account.min_balance !== ''
            ? maxMoney(account.min_balance, BUSINESS_RULES.SAVINGS_MIN_BALANCE)
            : BUSINESS_RULES.SAVINGS_MIN_BALANCE;
        if (compareMoney(balanceAfter, floor) < 0) {
            throw new BusinessRuleError(`Withdrawal would leave the balance below the minimum of ${floor}`, 'MIN_BALANCE_VIOLATION');
        }
    }
    return balanceAfter;
}
/**
 * Posts the immutable savings ledger debit for a paid withdrawal and updates
 * the account balance atomically. transaction_type = withdrawal, direction =
 * debit; withdrawal_request_id links the entry back to the request (§13.2).
 */
async function insertWithdrawalLedgerEntry(client, entry) {
    const insert = await client.query(`INSERT INTO account_transaction
       (savings_account_id, transaction_type, direction, amount, balance_after,
        value_date, payment_method, reference_number, description,
        performed_by, performed_source, withdrawal_request_id)
     VALUES ($1, 'withdrawal', 'debit', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`, [
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
    ]);
    const row = insert.rows[0];
    if (!row)
        throw new Error('failed to insert withdrawal ledger entry');
    await client.query(`UPDATE savings_account
        SET current_balance = $1, updated_at = now()
      WHERE id = $2`, [entry.balanceAfter, entry.savingsAccountId]);
    return row.id;
}
/**
 * Posts the immutable compensating credit that reverses a paid withdrawal.
 * The original debit row is never modified (§9.1): a NEW ledger entry with
 * transaction_type = 'reversal', direction = 'credit' is appended and its
 * reversal_of column links back to the original debit so the ledger can always
 * explain the net movement. The account balance is restored atomically.
 */
async function insertWithdrawalReversalLedgerEntry(client, entry) {
    const insert = await client.query(`INSERT INTO account_transaction
       (savings_account_id, transaction_type, direction, amount, balance_after,
        value_date, payment_method, description,
        performed_by, performed_source, reversal_of, withdrawal_request_id)
     VALUES ($1, 'reversal', 'credit', $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`, [
        entry.savingsAccountId,
        entry.amount,
        entry.balanceAfter,
        entry.valueDate,
        entry.paymentMethod,
        entry.description ?? null,
        entry.actor.staffId,
        entry.actor.source,
        entry.originalTransactionId,
        entry.withdrawalRequestId,
    ]);
    const row = insert.rows[0];
    if (!row)
        throw new Error('failed to insert withdrawal reversal ledger entry');
    await client.query(`UPDATE savings_account
        SET current_balance = $1, updated_at = now()
      WHERE id = $2`, [entry.balanceAfter, entry.savingsAccountId]);
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
async function resolveWithdrawalSource(client, accountKind, accountId, amount) {
    switch (accountKind) {
        case 'savings': {
            const account = await selectSavingsSource(client, accountId);
            if (!account)
                throw new NotFoundError('Savings account');
            const customerStatus = await selectCustomerStatus(client, account.customer_id);
            if (customerStatus === null)
                throw new NotFoundError('Customer');
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
            if (!account)
                throw new NotFoundError('RD account');
            const customerStatus = await selectCustomerStatus(client, account.customer_id);
            if (customerStatus === null)
                throw new NotFoundError('Customer');
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
            if (!account)
                throw new NotFoundError('FD account');
            const customerStatus = await selectCustomerStatus(client, account.customer_id);
            if (customerStatus === null)
                throw new NotFoundError('Customer');
            assertCustomerWithdrawable(customerStatus);
            if (account.status !== 'active' && account.status !== 'matured') {
                throw new BusinessRuleError(`FD account is not encashable (${account.status})`, 'ACCOUNT_NOT_ACTIVE');
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
            if (!loan)
                throw new NotFoundError('Loan');
            const customerStatus = await selectCustomerStatus(client, loan.customer_id);
            if (customerStatus === null)
                throw new NotFoundError('Customer');
            assertCustomerWithdrawable(customerStatus);
            const hasSurplus = await selectHeldSurplusExists(client, loan.id);
            if (!hasSurplus) {
                throw new BusinessRuleError('No surplus is currently held on this loan', 'NO_SURPLUS_AVAILABLE');
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
/**
 * true when the actor carries global (cross-branch) authority. Super admin and
 * the M.D. hold the full permission catalogue; settings.write is reserved to
 * them in the matrix, so it doubles as the global-authority signal.
 */
function isGlobalAuthority(actor) {
    return isSuperAdmin(actor.role) || hasPermission(actor.permissions, 'settings.write');
}
/** true when the actor may approve a request above the high-value threshold. */
function canApproveHighValue(actor) {
    return isSuperAdmin(actor.role) || hasPermission(actor.permissions, 'withdrawals.approve_high_value');
}
/**
 * LOW-8: non-global actors may only touch requests that belong to their own
 * branch. A cross-branch id is reported as NOT_FOUND (never FORBIDDEN) so ids
 * cannot be probed. An actor with a null branch but no global authority is
 * denied everything.
 */
function assertBranchScope(actor, row) {
    if (isGlobalAuthority(actor))
        return;
    if (actor.branchId !== null && actor.branchId === row.branch_id)
        return;
    throw new NotFoundError('Withdrawal request');
}
/** LIVE statuses that count towards the per-customer daily cap. */
const LIVE_WITHDRAWAL_STATUSES = "('pending', 'approved', 'paid')";
/**
 * MED-6 guard rails. Rejects a single request above the absolute cap and any
 * request that would push the customer's live (pending/approved/paid) total for
 * the current business date past the per-customer daily limit. Runs inside the
 * create/change transaction so a concurrent duplicate is caught pre-insert.
 * `excludeWithdrawalId` drops the row being changed from the aggregate.
 */
async function assertWithdrawalLimits(client, customerId, amount, excludeWithdrawalId) {
    if (compareMoney(amount, BUSINESS_RULES.WITHDRAWAL_MAX_AMOUNT) > 0) {
        throw new BusinessRuleError(`A single withdrawal may not exceed ${BUSINESS_RULES.WITHDRAWAL_MAX_AMOUNT}`, 'WITHDRAWAL_AMOUNT_LIMIT_EXCEEDED', { amount, limit: BUSINESS_RULES.WITHDRAWAL_MAX_AMOUNT });
    }
    const params = [customerId, istBusinessDate()];
    let excludeSql = '';
    if (excludeWithdrawalId !== undefined) {
        params.push(excludeWithdrawalId);
        excludeSql = ` AND id <> $${params.length}`;
    }
    const result = await client.query(`SELECT COALESCE(sum(amount), 0)::text AS total
       FROM withdrawal_request
      WHERE customer_id = $1
        AND requested_on = $2
        AND status IN ${LIVE_WITHDRAWAL_STATUSES}${excludeSql}`, params);
    const existing = result.rows[0]?.total ?? '0';
    const projected = addMoney(existing, amount);
    if (compareMoney(projected, BUSINESS_RULES.WITHDRAWAL_DAILY_LIMIT_PER_CUSTOMER) > 0) {
        throw new BusinessRuleError(`The customer's live withdrawals for this business date would exceed the daily limit of ${BUSINESS_RULES.WITHDRAWAL_DAILY_LIMIT_PER_CUSTOMER}`, 'WITHDRAWAL_DAILY_LIMIT_EXCEEDED', { existing, amount, projected });
    }
}
/**
 * Resolves a prior request created with the same idempotency key (HIGH-2) using
 * a pooled connection, so it is callable both for the explicit replay check and
 * for the concurrent-duplicate race after a unique-violation rollback.
 */
async function loadWithdrawalReplayOrNull(idempotencyKey) {
    const result = await query(`${WITHDRAWAL_SELECT} WHERE wr.idempotency_key = $1 LIMIT 1`, [idempotencyKey]);
    const row = result.rows[0];
    return row ? toWithdrawalView(row) : null;
}
// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------
export async function listWithdrawals(actor, queryInput, meta = {}) {
    void meta;
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    // LOW-8: non-global actors only ever see their own branch's requests; a null
    // branch with no global authority matches nothing (empty result, not an error).
    if (!isGlobalAuthority(actor)) {
        where.push(`c.branch_id = ${addParam(actor.branchId)}`);
    }
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
    const result = await query(`WITH filtered AS (
       ${WITHDRAWAL_SELECT}
       ${whereSql}
     )
     SELECT f.*, count(*) OVER()::int AS total
       FROM filtered f
      ORDER BY f.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toWithdrawalView(row));
    return { total, items };
}
export async function getWithdrawal(actor, withdrawalId, meta = {}) {
    void meta;
    const row = await query(`${WITHDRAWAL_SELECT} WHERE wr.id = $1 LIMIT 1`, [withdrawalId]);
    const found = row.rows[0];
    if (!found)
        throw new NotFoundError('Withdrawal request');
    // LOW-8: a cross-branch id is reported as NOT_FOUND so ids cannot be probed.
    assertBranchScope(actor, found);
    return toWithdrawalView(found);
}
export async function requestWithdrawal(actor, input, meta = {}, idempotencyKey) {
    // HIGH-2: an explicit replay of a committed key returns the ORIGINAL request
    // (200) before any validation, so a retried submit never double-books money.
    if (idempotencyKey !== undefined) {
        const replay = await loadWithdrawalReplayOrNull(idempotencyKey);
        if (replay)
            return { created: false, withdrawal: replay };
    }
    const businessDate = istBusinessDate();
    try {
        return await transaction(async (client) => {
            const source = await resolveWithdrawalSource(client, input.accountKind, input.accountId, input.amount);
            if (source.customerId === null) {
                throw new BadRequestError('Withdrawal must reference an account that belongs to a customer');
            }
            // MED-6: absolute per-request cap + per-customer daily ceiling.
            await assertWithdrawalLimits(client, source.customerId, input.amount);
            const isHighValue = compareMoney(input.amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0;
            const identityVerified = input.identityVerified ?? { passbook: false, signature: false, aadhaar: false };
            // The withdrawal number sequence is seeded under the `withdrawal` entity
            // type (prefix `WDL`, 5-digit padding — see seed.ts / docs/testing-sequence.md).
            // It must match exactly or allocateSequence throws
            // "number sequence not configured for entity type".
            const sequence = await allocateSequence(client, 'withdrawal');
            const requestNumber = sequence.formatted;
            const insert = await client.query(`INSERT INTO withdrawal_request
           (request_number, customer_id, account_kind,
            savings_account_id, rd_account_id, fd_account_id,
            amount, balance_before, reason, free_text_reason, payment_method,
            status, is_high_value,
            identity_verified_passbook, identity_verified_signature,
            identity_verified_aadhaar,
            requested_by, requested_on, documents, idempotency_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11,
                 'pending', $12, $13, $14, $15, $16, $17, $18::jsonb, $19)
         RETURNING id`, [
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
                businessDate,
                input.documents ? JSON.stringify(input.documents) : null,
                idempotencyKey ?? null,
            ]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create withdrawal request');
            const withdrawalId = inserted.id;
            const eventData = {
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
            return { created: true, withdrawal: await loadWithdrawal(client, withdrawalId) };
        });
    }
    catch (error) {
        // A concurrent duplicate of the same idempotency key: the winning insert
        // committed and this unique violation rolled back. Re-read that request and
        // return it as a replay. A request_number collision (the other unique index
        // on the table) falls through to the legacy conflict error.
        if (idempotencyKey !== undefined && isUniqueViolation(error)) {
            const raced = await loadWithdrawalReplayOrNull(idempotencyKey);
            if (raced)
                return { created: false, withdrawal: raced };
            throw new ConflictError('Withdrawal request number collision — please retry', 'REQUEST_NUMBER_COLLISION');
        }
        throw error;
    }
}
export async function approveWithdrawal(actor, withdrawalId, input, meta = {}) {
    const approved = await transaction(async (client) => {
        // CRITICAL-1: lock the request row so two concurrent approvals cannot both
        // read 'pending' (READ COMMITTED double-decision guard).
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'pending') {
            throw new BusinessRuleError(`A ${row.status} withdrawal request cannot be approved`, 'WITHDRAWAL_NOT_APPROVABLE');
        }
        // HIGH-3 maker–checker: the requester may never approve their own request.
        // Global authority (super admin / M.D.) is exempt so a single-operator
        // branch can still clear its queue — the exemption is recorded in the event.
        const makerCheckerExempt = isGlobalAuthority(actor) && actor.staffId === row.requested_by;
        if (!makerCheckerExempt && row.requested_by !== null && row.requested_by === actor.staffId) {
            throw new ForbiddenError('A withdrawal request must be approved by a different staff member than the one who requested it', 'MAKER_CHECKER_VIOLATION');
        }
        // High-value requests (> ₹2,00,000) may only be approved by the President
        // (or a holder of the explicit withdrawals.approve_high_value grant).
        if (compareMoney(row.amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0 && !canApproveHighValue(actor)) {
            throw new BusinessRuleError('High-value withdrawals above ₹2,00,000 can only be approved by the President', 'HIGH_VALUE_APPROVAL_REQUIRED');
        }
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'approved', approved_by = $1, approved_on = now(), updated_at = now()
        WHERE id = $2 AND status = 'pending'`, [actor.staffId, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
            amount: row.amount,
            isHighValue: row.is_high_value,
            comment: input.comment ?? null,
            approvedBy: actor.staffId,
            requestedBy: row.requested_by,
            makerCheckerExempt,
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
export async function rejectWithdrawal(actor, withdrawalId, input, meta = {}) {
    const rejected = await transaction(async (client) => {
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'pending' && row.status !== 'approved') {
            throw new BusinessRuleError(`A ${row.status} withdrawal request cannot be rejected`, 'WITHDRAWAL_NOT_REJECTABLE');
        }
        // The original approval is preserved (never overwritten) — only the status
        // and rejection reason change on the request.
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'rejected', rejection_reason = $1, updated_at = now()
        WHERE id = $2 AND status IN ('pending','approved')`, [input.reason, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
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
export async function payWithdrawal(actor, withdrawalId, input, meta = {}) {
    const paid = await transaction(async (client) => {
        // CRITICAL-1: lock the request row so two concurrent payouts cannot both
        // read 'approved' and both post a ledger debit.
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'approved') {
            throw new BusinessRuleError(`Only an approved withdrawal can be paid (current status: ${row.status})`, 'WITHDRAWAL_NOT_PAYABLE');
        }
        // LOW-7: re-validate the customer and the drawn instrument at the moment of
        // payout — both may have changed since the request was approved.
        const customerStatus = await selectCustomerStatus(client, row.customer_id);
        if (customerStatus === null)
            throw new NotFoundError('Customer');
        assertCustomerWithdrawable(customerStatus);
        if (row.account_kind === 'rd' || row.account_kind === 'fd') {
            const sourceId = row.account_kind === 'rd' ? row.rd_account_id : row.fd_account_id;
            if (sourceId !== null) {
                await resolveWithdrawalSource(client, row.account_kind, sourceId, row.amount);
            }
        }
        const method = row.payment_method;
        const payoutReference = input.payoutReference ?? null;
        if (method !== 'cash' && (payoutReference === null || payoutReference === '')) {
            throw new BusinessRuleError('A payout reference is required for non-cash payment methods', 'PAYOUT_REFERENCE_REQUIRED');
        }
        // Identity checks (passbook + signature + Aadhaar) must all be recorded
        // before the payout (spec §13.1). They may be captured at the counter now.
        const identity = input.identityVerified ?? { passbook: false, signature: false, aadhaar: false };
        const passbook = row.identity_verified_passbook || identity.passbook;
        const signature = row.identity_verified_signature || identity.signature;
        const aadhaar = row.identity_verified_aadhaar || identity.aadhaar;
        if (!passbook || !signature || !aadhaar) {
            throw new BusinessRuleError('Identity verification (passbook, signature and Aadhaar) must be recorded before payout', 'IDENTITY_VERIFICATION_REQUIRED');
        }
        let ledgerTransactionId = null;
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
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'paid', paid_by = $1, paid_on = now(),
              payout_reference = $2,
              identity_verified_passbook = $3,
              identity_verified_signature = $4,
              identity_verified_aadhaar = $5,
              updated_at = now()
        WHERE id = $6 AND status = 'approved'`, [actor.staffId, payoutReference, passbook, signature, aadhaar, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
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
export async function confirmWithdrawal(actor, withdrawalId, _input, meta = {}) {
    const confirmed = await transaction(async (client) => {
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'paid') {
            throw new BusinessRuleError(`Only a paid withdrawal can be confirmed (current status: ${row.status})`, 'WITHDRAWAL_NOT_CONFIRMABLE');
        }
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'confirmed', confirmed_by = $1, confirmed_on = now(), updated_at = now()
        WHERE id = $2 AND status = 'paid'`, [actor.staffId, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
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
export async function changeWithdrawal(actor, withdrawalId, input, meta = {}) {
    const changed = await transaction(async (client) => {
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'approved') {
            throw new BusinessRuleError(`Only an approved withdrawal can be changed by the President (current status: ${row.status})`, 'WITHDRAWAL_NOT_CHANGEABLE');
        }
        if (actor.role !== 'president' && !isGlobalAuthority(actor)) {
            throw new BusinessRuleError('Only the President can change an approved withdrawal', 'PRESIDENT_APPROVAL_REQUIRED');
        }
        // MED-9: the new amount must clear the same rules as a fresh request for
        // EVERY account kind — not just savings. Savings carries the full balance
        // floor; rd/fd are re-resolved so a closed/inactive instrument is rejected.
        let balanceBefore = row.balance_before;
        if (row.account_kind === 'savings' && row.savings_account_id !== null) {
            const account = await selectSavingsSource(client, row.savings_account_id);
            if (!account)
                throw new NotFoundError('Savings account');
            await assertSavingsWithdrawable(client, row.savings_account_id, input.amount);
            balanceBefore = account.current_balance;
        }
        else if (row.account_kind === 'rd' || row.account_kind === 'fd') {
            const sourceId = row.account_kind === 'rd' ? row.rd_account_id : row.fd_account_id;
            if (sourceId !== null) {
                await resolveWithdrawalSource(client, row.account_kind, sourceId, input.amount);
            }
        }
        // MED-6: re-check the caps against the changed amount (excluding this row).
        await assertWithdrawalLimits(client, row.customer_id, input.amount, withdrawalId);
        const newIsHighValue = compareMoney(input.amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0;
        // The request re-enters the pending queue for a fresh approval. The original
        // decision (approver, timestamp, amount) is preserved in the changed event.
        const update = await client.query(`UPDATE withdrawal_request
          SET amount = $1, balance_before = $2, reason = $3, free_text_reason = $4,
              is_high_value = $5, status = 'pending',
              approved_by = NULL, approved_on = NULL, rejection_reason = NULL,
              updated_at = now()
        WHERE id = $6 AND status = 'approved'`, [
            input.amount,
            balanceBefore,
            input.reason,
            input.freeTextReason ?? null,
            newIsHighValue,
            withdrawalId,
        ]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
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
export async function getWithdrawalHistory(actor, withdrawalId, meta = {}) {
    void meta;
    return transaction(async (client) => {
        const row = await selectWithdrawalById(client, withdrawalId);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        const result = await client.query(`SELECT e.id, e.withdrawal_id, e.event_type, e.event_data,
              e.performed_by, s.full_name AS performed_by_name,
              e.performed_source, e.created_at
         FROM withdrawal_event e
         LEFT JOIN staff s ON s.id = e.performed_by
        WHERE e.withdrawal_id = $1
        ORDER BY e.created_at ASC, e.id ASC`, [withdrawalId]);
        const items = result.rows.map((event) => ({
            id: event.id,
            withdrawalId: event.withdrawal_id,
            eventType: event.event_type,
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
/**
 * Cancels a pending or approved withdrawal before payout (MED-4). A paid or
 * confirmed payout can never be cancelled — it must be reversed through the
 * immutable ledger instead. Records who cancelled, when and why, and appends an
 * immutable 'cancelled' event + audit row in the same transaction.
 */
export async function cancelWithdrawal(actor, withdrawalId, input, meta = {}) {
    const cancelled = await transaction(async (client) => {
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (row.status !== 'pending' && row.status !== 'approved') {
            throw new BusinessRuleError(`Only a pending or approved withdrawal can be cancelled (current status: ${row.status})`, 'WITHDRAWAL_NOT_CANCELLABLE');
        }
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'cancelled', cancelled_by = $1, cancelled_on = now(),
              cancellation_reason = $2, updated_at = now()
        WHERE id = $3 AND status IN ('pending','approved')`, [actor.staffId, input.reason, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
            amount: row.amount,
            previousStatus: row.status,
            cancellationReason: input.reason,
            cancelledBy: actor.staffId,
        };
        await appendWithdrawalEvent(client, withdrawalId, 'cancelled', actor, eventData);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.WITHDRAWAL_CANCELLED,
            entityType: 'withdrawal_request',
            entityId: withdrawalId,
            metadata: eventData,
        });
        return loadWithdrawal(client, withdrawalId);
    });
    return cancelled;
}
/**
 * Reverses a PAID or CONFIRMED payout (recalled cash/bank settlement, wrong
 * amount, dispute). Unlike cancel — which only works before payout — the money
 * has already left the bank, so the reversal:
 *   1. posts a compensating CREDIT into the source savings account (the
 *      original debit stays immutable and is linked via reversal_of),
 *   2. moves the request to the terminal 'reversed' status, and
 *   3. appends an immutable 'reversed' event + audit row.
 * Reserved to the Managing Director (or the protected super-admin) because it
 * re-credits settled funds.
 */
export async function reverseWithdrawal(actor, withdrawalId, input, meta = {}) {
    const reversed = await transaction(async (client) => {
        // Lock the request row so two concurrent recalls cannot both re-credit.
        const row = await selectWithdrawalById(client, withdrawalId, true);
        if (!row)
            throw new NotFoundError('Withdrawal request');
        assertBranchScope(actor, row);
        if (actor.role !== 'managing_director' && !isSuperAdmin(actor.role)) {
            throw new ForbiddenError('Only the Managing Director can reverse a paid withdrawal');
        }
        if (row.status !== 'paid' && row.status !== 'confirmed') {
            throw new BusinessRuleError(`Only a paid or confirmed withdrawal can be reversed (current status: ${row.status})`, 'WITHDRAWAL_NOT_REVERSIBLE');
        }
        // Compensating credit. Only savings carries an internal ledger; rd/fd/
        // loan_surplus encashment happens at the payout boundary (same boundary as
        // payWithdrawal), so for those kinds the reversal restores the request
        // record and audit trail only.
        let reversalTransactionId = null;
        if (row.account_kind === 'savings' && row.savings_account_id !== null) {
            const account = await selectSavingsSource(client, row.savings_account_id);
            if (!account)
                throw new NotFoundError('Savings account');
            if (account.status !== 'active') {
                throw new BusinessRuleError('The linked savings account is not active — reverse the payout through a manual adjustment', 'ACCOUNT_NOT_ACTIVE');
            }
            // Anchor the reversal to the original debit so the ledger is traceable
            // and the same payout can never be re-credited from a stale reference.
            const debit = await client.query(`SELECT id
           FROM account_transaction
          WHERE withdrawal_request_id = $1
            AND transaction_type = 'withdrawal'
            AND direction = 'debit'
          ORDER BY created_at ASC
          LIMIT 1`, [withdrawalId]);
            const originalDebitId = debit.rows[0]?.id ?? null;
            const balanceAfter = addMoney(account.current_balance, row.amount);
            reversalTransactionId = await insertWithdrawalReversalLedgerEntry(client, {
                savingsAccountId: row.savings_account_id,
                amount: row.amount,
                balanceAfter,
                valueDate: istBusinessDate(),
                paymentMethod: row.payment_method,
                description: `Reversal of withdrawal ${row.request_number}: ${input.reason}`,
                originalTransactionId: originalDebitId,
                withdrawalRequestId: withdrawalId,
                actor,
            });
        }
        const update = await client.query(`UPDATE withdrawal_request
          SET status = 'reversed', reversed_by = $1, reversed_on = now(),
              reversal_reason = $2, reversal_transaction_id = $3, updated_at = now()
        WHERE id = $4 AND status IN ('paid','confirmed')`, [actor.staffId, input.reason, reversalTransactionId, withdrawalId]);
        if (update.rowCount !== 1) {
            throw new ConflictError('The withdrawal request was modified concurrently — please reload and retry', 'WITHDRAWAL_STATE_RACE');
        }
        const eventData = {
            amount: row.amount,
            previousStatus: row.status,
            reversalReason: input.reason,
            reversalTransactionId,
            reversedBy: actor.staffId,
        };
        await appendWithdrawalEvent(client, withdrawalId, 'reversed', actor, eventData);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.WITHDRAWAL_REVERSED,
            entityType: 'withdrawal_request',
            entityId: withdrawalId,
            metadata: eventData,
        });
        return loadWithdrawal(client, withdrawalId);
    });
    return reversed;
}
