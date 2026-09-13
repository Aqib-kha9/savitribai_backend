import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS } from '../../audit/audit-writer.js';
import { istBusinessDate } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, NotFoundError } from '../../core/errors.js';
import { allocateSequence } from '../../database/numbering.js';
import { addMoney, subMoney, compareMoney, isZero, maxMoney, BUSINESS_RULES } from '../../core/money.js';
/**
 * Deposits & savings accounts service (docs/backend-master-spec.md §9).
 *
 * Authority (spec §9.1):
 *  - account open / edit / freeze / close / reopen → Managing Director
 *  - account opening & closure approval → designated person assigned by the
 *    bank. The schema carries a single pending_approval → active gate and an
 *    approved_by / approved_on pair on savings_account; the /approve path
 *    implements the designated-person approval (President / Managing Director)
 *    for that gate. Closure additionally enforces the zero-balance rule
 *    (spec §9.1: "balance must be zero first") and the closure action itself is
 *    restricted to the Managing Director. Two-person control for financial
 *    account actions is preserved by requiring role president|managing_director
 *    on approve (spec §9.1 second-reviewer note). A true two-step closure
 *    approval (initiate → approve) would need a closure-approval entity, which
 *    the master schema does not define; the ambiguity is documented here.
 *  - product create → Managing Director; product listing → deposits.read
 *  - ledger read / statement → deposits.read; posting → deposits.write
 *  - corrections / adjustments → Managing Director only (spec §9.1), recorded
 *    as a separate adjustment that links the original (never modified) to a
 *    compensating ledger entry.
 *
 * Every mutation runs inside one DB transaction and appends its audit event in
 * the same transaction (spec §6.3). The ledger (account_transaction) is
 * immutable — deposits/withdrawals are never edited or deleted; the balance of
 * the account always equals the balance_after of its newest ledger row.
 *
 * Adjustments in this module reverse an original entry in full (the original is
 * left untouched). Net/delta corrections that re-state a value are handled by
 * the corrections module (spec §19) which posts its own delta ledger entries.
 */
// Module-local action vocabulary. The shared audit-writer keeps the constants
// for opened/frozen/closed/reopened/transaction/adjustment; approval, update,
// product creation and the read-path actions have no shared constant (they
// precede/parallel the shared set) and are recorded as plain strings here.
const ACTION_ACCOUNT_APPROVED = 'deposits.account.approved';
const ACTION_ACCOUNT_UPDATED = 'deposits.account.updated';
const ACTION_ACCOUNT_VIEWED = 'deposits.account.viewed';
const ACTION_PRODUCT_CREATED = 'deposits.product.created';
const ACTION_STATEMENT_GENERATED = 'deposits.statement.generated';
/** An account that has reached the closed state cannot accept further change. */
const CLOSED_STATUSES = ['closed'];
/** High-value withdrawals follow spec §13 authority, not a plain deposit txn. */
const HIGH_VALUE_ROLES = ['president', 'managing_director'];
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
const iso = (value) => value ? value.toISOString() : null;
/** Autocommit adapter for audit events written outside a mutation transaction (reads). */
function poolForEvent() {
    return { query: (text, params) => query(text, params) };
}
function isUniqueViolation(error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '23505';
}
async function assertBranchExists(client, branchId) {
    const result = await client.query(`SELECT 1 FROM branch WHERE id = $1`, [branchId]);
    if (result.rows.length === 0) {
        throw new BadRequestError('Branch does not exist');
    }
}
async function selectCustomerEligibility(client, customerId) {
    const result = await client.query(`SELECT id, status FROM customer WHERE id = $1 LIMIT 1`, [customerId]);
    return result.rows[0] ?? null;
}
/** A savings account can only be opened for a customer whose record is not terminal. */
async function assertCustomerEligible(client, customerId) {
    const customer = await selectCustomerEligibility(client, customerId);
    if (!customer)
        throw new NotFoundError('Customer');
    // 'restricted' (data-subject restriction) and 'deleted' (data-subject soft
    // delete, spec §24.2) also freeze new product openings.
    if (customer.status === 'deceased' ||
        customer.status === 'closed' ||
        customer.status === 'restricted' ||
        customer.status === 'deleted') {
        throw new BusinessRuleError(`Customer is ${customer.status}; no new savings account can be opened for this profile`, 'CUSTOMER_NOT_ELIGIBLE');
    }
}
async function selectProductById(client, productId) {
    const result = await client.query(`SELECT id, code, name, description,
            min_opening_amount::text AS min_opening_amount,
            min_balance::text AS min_balance,
            max_balance::text AS max_balance,
            interest_method, interest_frequency,
            interest_rate::text AS interest_rate, rate_policy, is_active,
            created_at, updated_at
       FROM deposit_product
      WHERE id = $1
      LIMIT 1`, [productId]);
    return result.rows[0] ?? null;
}
async function selectProductByCode(client, code) {
    const result = await client.query(`SELECT id, code, name, description,
            min_opening_amount::text AS min_opening_amount,
            min_balance::text AS min_balance,
            max_balance::text AS max_balance,
            interest_method, interest_frequency,
            interest_rate::text AS interest_rate, rate_policy, is_active,
            created_at, updated_at
       FROM deposit_product
      WHERE code = $1
      LIMIT 1`, [code]);
    return result.rows[0] ?? null;
}
function toProductView(row) {
    return {
        id: row.id,
        code: row.code,
        name: row.name,
        description: row.description,
        minOpeningAmount: row.min_opening_amount,
        minBalance: row.min_balance,
        maxBalance: row.max_balance,
        interestMethod: row.interest_method,
        interestFrequency: row.interest_frequency,
        interestRate: row.interest_rate,
        ratePolicy: row.rate_policy,
        isActive: row.is_active,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function loadProduct(client, productId) {
    const product = await selectProductById(client, productId);
    if (!product)
        throw new NotFoundError('Deposit product');
    return toProductView(product);
}
const ACCOUNT_SELECT = `
  SELECT sa.id, sa.account_number, sa.customer_id,
         c.customer_number, c.full_name AS customer_name,
         sa.product_id, p.code AS product_code, p.name AS product_name,
         p.min_balance::text AS product_min_balance,
         p.max_balance::text AS product_max_balance,
         sa.branch_id, b.name AS branch_name,
         sa.status,
         sa.current_balance::text AS current_balance,
         sa.interest_rate::text AS interest_rate,
         sa.opened_by, op.full_name AS opened_by_name,
         sa.opened_on::text AS opened_on,
         sa.approved_by, ap.full_name AS approved_by_name,
         sa.approved_on::text AS approved_on,
         sa.freeze_reason, sa.closed_on::text AS closed_on, sa.closure_reason,
         sa.reopened_on::text AS reopened_on,
         sa.last_interest_posted_on::text AS last_interest_posted_on,
         sa.created_at, sa.updated_at
    FROM savings_account sa
    JOIN customer c ON c.id = sa.customer_id
    JOIN deposit_product p ON p.id = sa.product_id
    JOIN branch b ON b.id = sa.branch_id
    LEFT JOIN staff op ON op.id = sa.opened_by
    LEFT JOIN staff ap ON ap.id = sa.approved_by
`;
async function selectAccountById(client, accountId) {
    const result = await client.query(`${ACCOUNT_SELECT} WHERE sa.id = $1 LIMIT 1`, [accountId]);
    return result.rows[0] ?? null;
}
function toAccountView(row) {
    return {
        id: row.id,
        accountNumber: row.account_number,
        customerId: row.customer_id,
        customerNumber: row.customer_number,
        customerName: row.customer_name,
        productId: row.product_id,
        productCode: row.product_code,
        productName: row.product_name,
        productMinBalance: row.product_min_balance,
        productMaxBalance: row.product_max_balance,
        branchId: row.branch_id,
        branchName: row.branch_name,
        status: row.status,
        currentBalance: row.current_balance,
        interestRate: row.interest_rate,
        openedBy: row.opened_by,
        openedByName: row.opened_by_name,
        openedOn: row.opened_on,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        approvedOn: row.approved_on,
        freezeReason: row.freeze_reason,
        closedOn: row.closed_on,
        closureReason: row.closure_reason,
        reopenedOn: row.reopened_on,
        lastInterestPostedOn: row.last_interest_posted_on,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function loadAccountDetail(client, accountId) {
    const account = await selectAccountById(client, accountId);
    if (!account)
        throw new NotFoundError('Savings account');
    return toAccountView(account);
}
function assertNotClosed(row) {
    if (CLOSED_STATUSES.includes(row.status)) {
        throw new BusinessRuleError('Savings account is closed and cannot be modified', 'ACCOUNT_CLOSED');
    }
}
async function selectOriginalTransaction(client, accountId, transactionId) {
    const result = await client.query(`SELECT id, savings_account_id, transaction_type, direction,
            amount::text AS amount, adjustment_id, reversal_of
       FROM account_transaction
      WHERE id = $1
      LIMIT 1`, [transactionId]);
    return result.rows[0] ?? null;
}
async function selectTransactionById(client, transactionId) {
    const result = await client.query(`SELECT t.id, t.savings_account_id, sa.account_number,
            t.transaction_type, t.direction,
            t.amount::text AS amount, t.balance_after::text AS balance_after,
            t.value_date::text AS value_date,
            t.payment_method, t.reference_number, t.description,
            t.performed_by, pb.full_name AS performed_by_name, t.performed_source,
            t.reversal_of, t.adjustment_id,
            t.withdrawal_request_id, t.created_at
       FROM account_transaction t
       JOIN savings_account sa ON sa.id = t.savings_account_id
       LEFT JOIN staff pb ON pb.id = t.performed_by
      WHERE t.id = $1
      LIMIT 1`, [transactionId]);
    return result.rows[0] ?? null;
}
function toTransactionView(row) {
    return {
        id: row.id,
        accountId: row.savings_account_id,
        accountNumber: row.account_number,
        transactionType: row.transaction_type,
        direction: row.direction,
        amount: row.amount,
        balanceAfter: row.balance_after,
        valueDate: row.value_date,
        paymentMethod: row.payment_method,
        referenceNumber: row.reference_number,
        description: row.description,
        performedBy: row.performed_by,
        performedSource: row.performed_source,
        performedByName: row.performed_by_name,
        reversalOf: row.reversal_of,
        adjustmentId: row.adjustment_id,
        createdAt: row.created_at.toISOString(),
    };
}
async function loadTransaction(client, transactionId) {
    const row = await selectTransactionById(client, transactionId);
    if (!row)
        throw new NotFoundError('Transaction');
    return toTransactionView(row);
}
async function selectAdjustmentById(client, adjustmentId) {
    const result = await client.query(`SELECT adj.id, adj.savings_account_id, adj.adjustment_type,
            adj.original_transaction_id, adj.adjustment_transaction_id,
            adj.reason, adj.evidence_references, adj.customer_confirmed,
            adj.approved_by, st.full_name AS approved_by_name, adj.created_at
       FROM account_adjustment adj
       LEFT JOIN staff st ON st.id = adj.approved_by
      WHERE adj.id = $1
      LIMIT 1`, [adjustmentId]);
    return result.rows[0] ?? null;
}
function toAdjustmentView(row) {
    return {
        id: row.id,
        accountId: row.savings_account_id,
        adjustmentType: row.adjustment_type,
        originalTransactionId: row.original_transaction_id,
        adjustmentTransactionId: row.adjustment_transaction_id,
        reason: row.reason,
        evidenceReferences: row.evidence_references ?? null,
        customerConfirmed: row.customer_confirmed,
        approvedBy: row.approved_by,
        approvedByName: row.approved_by_name,
        createdAt: row.created_at.toISOString(),
    };
}
async function loadAdjustment(client, adjustmentId) {
    const row = await selectAdjustmentById(client, adjustmentId);
    if (!row)
        throw new NotFoundError('Adjustment');
    return toAdjustmentView(row);
}
/** High-value withdrawals (> 2,00,000) require President/M.D. authority (§13). */
function assertHighValueWithdrawalAuthority(actor, amount) {
    if (compareMoney(amount, BUSINESS_RULES.HIGH_VALUE_WITHDRAWAL_LIMIT) > 0 && !HIGH_VALUE_ROLES.includes(actor.role)) {
        throw new BusinessRuleError('Withdrawal above the high-value threshold requires President/Managing Director approval through the withdrawals module', 'HIGH_VALUE_WITHDRAWAL_APPROVAL_REQUIRED');
    }
}
// ---------------------------------------------------------------------------
// Deposit products
// ---------------------------------------------------------------------------
export async function listProducts(actor, queryInput, meta = {}) {
    void actor;
    void meta;
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (queryInput.search) {
        const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        where.push(`(p.code ILIKE ${addParam(pattern)} ESCAPE '\\' OR p.name ILIKE ${addParam(pattern)} ESCAPE '\\')`);
    }
    if (queryInput.includeInactive !== 'true') {
        where.push('p.is_active = true');
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`SELECT p.id, p.code, p.name, p.description,
            p.min_opening_amount::text AS min_opening_amount,
            p.min_balance::text AS min_balance,
            p.max_balance::text AS max_balance,
            p.interest_method, p.interest_frequency,
            p.interest_rate::text AS interest_rate, p.rate_policy, p.is_active,
            p.created_at, p.updated_at,
            count(*) OVER()::int AS total
       FROM deposit_product p
       ${whereSql}
      ORDER BY p.name ASC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toProductView(row));
    return { total, items };
}
export async function createProduct(actor, input, meta = {}) {
    const created = await transaction(async (client) => {
        let productId;
        try {
            const insert = await client.query(`INSERT INTO deposit_product
           (code, name, description, min_opening_amount, min_balance, max_balance,
            interest_method, interest_frequency, interest_rate, rate_policy, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
         RETURNING id`, [
                input.code,
                input.name,
                input.description ?? null,
                input.minOpeningAmount,
                input.minBalance,
                input.maxBalance ?? null,
                input.interestMethod,
                input.interestFrequency,
                input.interestRate,
                input.ratePolicy,
            ]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create deposit product');
            productId = inserted.id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError('A deposit product with this code already exists', 'PRODUCT_CODE_EXISTS');
            }
            throw error;
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_PRODUCT_CREATED,
            entityType: 'deposit_product',
            entityId: productId,
            metadata: {
                code: input.code,
                name: input.name,
                interestMethod: input.interestMethod,
                interestFrequency: input.interestFrequency,
                interestRate: input.interestRate,
                ratePolicy: input.ratePolicy,
                createdBy: actor.staffId,
            },
        });
        return loadProduct(client, productId);
    });
    return created;
}
// ---------------------------------------------------------------------------
// Savings accounts — open, read, list
// ---------------------------------------------------------------------------
export async function createAccount(actor, input, meta = {}) {
    const created = await transaction(async (client) => {
        await assertCustomerEligible(client, input.customerId);
        await assertBranchExists(client, input.branchId);
        const product = await selectProductById(client, input.productId);
        if (!product)
            throw new NotFoundError('Deposit product');
        if (!product.is_active) {
            throw new BusinessRuleError('This deposit product is not active', 'PRODUCT_INACTIVE');
        }
        if (compareMoney(input.openingAmount, product.min_opening_amount) < 0) {
            throw new BusinessRuleError(`Opening amount is below the product minimum of ${product.min_opening_amount}`, 'OPENING_AMOUNT_BELOW_MIN');
        }
        if (product.max_balance && compareMoney(input.openingAmount, product.max_balance) > 0) {
            throw new BusinessRuleError(`Opening amount exceeds the product maximum of ${product.max_balance}`, 'OPENING_AMOUNT_ABOVE_MAX');
        }
        const sequence = await allocateSequence(client, 'savings_account');
        const accountNumber = sequence.formatted;
        const openedOn = input.openedOn ?? istBusinessDate();
        // The account snapshots the product's interest rate at opening so later
        // product changes never rewrite a live account's ledger terms (variable
        // rates are applied by editing the account — spec §9.1).
        const interestRate = input.interestRate ?? product.interest_rate;
        let accountId;
        try {
            const insert = await client.query(`INSERT INTO savings_account
           (account_number, customer_id, product_id, branch_id, status,
            current_balance, interest_rate, opened_by, opened_on)
         VALUES ($1, $2, $3, $4, 'pending_approval', $5, $6, $7, $8)
         RETURNING id`, [accountNumber, input.customerId, input.productId, input.branchId, input.openingAmount, interestRate, actor.staffId, openedOn]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create savings account');
            accountId = inserted.id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                throw new ConflictError('Savings account number collision — please retry', 'ACCOUNT_NUMBER_COLLISION');
            }
            throw error;
        }
        // The opening deposit is the first immutable ledger row: the account
        // balance equals this row's balance_after until the next posting.
        const openingTxn = await client.query(`INSERT INTO account_transaction
         (savings_account_id, transaction_type, direction, amount, balance_after,
          value_date, payment_method, reference_number, description,
          performed_by, performed_source)
       VALUES ($1, 'deposit', 'credit', $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`, [
            accountId,
            input.openingAmount,
            input.openingAmount,
            openedOn,
            input.paymentMethod,
            input.referenceNumber ?? null,
            input.description ?? 'Account opening deposit',
            actor.staffId,
            actor.source,
        ]);
        const openingTxnRow = openingTxn.rows[0];
        if (!openingTxnRow)
            throw new Error('failed to record opening deposit');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_ACCOUNT_OPENED,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                accountNumber,
                customerId: input.customerId,
                productId: input.productId,
                branchId: input.branchId,
                openingAmount: input.openingAmount,
                openedOn,
                status: 'pending_approval',
                openedBy: actor.staffId,
            },
        });
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_TRANSACTION_POSTED,
            entityType: 'account_transaction',
            entityId: openingTxnRow.id,
            metadata: {
                savingsAccountId: accountId,
                accountNumber,
                transactionType: 'deposit',
                direction: 'credit',
                amount: input.openingAmount,
                balanceAfter: input.openingAmount,
                valueDate: openedOn,
                paymentMethod: input.paymentMethod,
                openingDeposit: true,
            },
        });
        return loadAccountDetail(client, accountId);
    });
    return created;
}
export async function listAccounts(actor, queryInput, meta = {}) {
    void actor;
    void meta;
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (queryInput.search) {
        const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        where.push(`(sa.account_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\'
        OR c.mobile ILIKE ${addParam(pattern)} ESCAPE '\\')`);
    }
    if (queryInput.customerId) {
        where.push(`sa.customer_id = ${addParam(queryInput.customerId)}`);
    }
    if (queryInput.productId) {
        where.push(`sa.product_id = ${addParam(queryInput.productId)}`);
    }
    if (queryInput.branchId) {
        where.push(`sa.branch_id = ${addParam(queryInput.branchId)}`);
    }
    if (queryInput.status) {
        where.push(`sa.status = ${addParam(queryInput.status)}`);
    }
    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`${ACCOUNT_SELECT.replace('FROM savings_account sa', ', count(*) OVER()::int AS total FROM savings_account sa')}
       ${whereSql}
      ORDER BY sa.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toAccountView(row));
    return { total, items };
}
export async function getAccount(actor, accountId, meta = {}) {
    const detail = await transaction(async (client) => {
        return loadAccountDetail(client, accountId);
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: ACTION_ACCOUNT_VIEWED,
        entityType: 'savings_account',
        entityId: accountId,
        metadata: { viewedBy: actor.staffId },
    });
    return detail;
}
// ---------------------------------------------------------------------------
// Savings accounts — edit & lifecycle (Managing Director)
// ---------------------------------------------------------------------------
export async function updateAccount(actor, accountId, input, meta = {}) {
    const updated = await transaction(async (client) => {
        const existing = await selectAccountById(client, accountId);
        if (!existing)
            throw new NotFoundError('Savings account');
        assertNotClosed(existing);
        if (input.productId !== undefined) {
            const product = await selectProductById(client, input.productId);
            if (!product)
                throw new NotFoundError('Deposit product');
            if (!product.is_active) {
                throw new BusinessRuleError('Cannot move the account to an inactive product', 'PRODUCT_INACTIVE');
            }
        }
        const sets = [];
        const values = [];
        const push = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if (input.productId !== undefined)
            push('product_id', input.productId);
        if (input.interestRate !== undefined)
            push('interest_rate', input.interestRate);
        if (sets.length > 0) {
            await client.query(`UPDATE savings_account SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length + 1}`, [
                ...values,
                accountId,
            ]);
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_ACCOUNT_UPDATED,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                fields: Object.keys(input).filter((k) => input[k] !== undefined),
                updatedBy: actor.staffId,
            },
        });
        return loadAccountDetail(client, accountId);
    });
    return updated;
}
export async function freezeAccount(actor, accountId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectAccountById(client, accountId);
        if (!existing)
            throw new NotFoundError('Savings account');
        if (existing.status !== 'active') {
            throw new BusinessRuleError('Only an active savings account can be frozen', 'ACCOUNT_NOT_ACTIVE');
        }
        await client.query(`UPDATE savings_account
          SET status = 'frozen', freeze_reason = $1, updated_at = now()
        WHERE id = $2`, [input.reason, accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_ACCOUNT_FROZEN,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                fromStatus: 'active',
                toStatus: 'frozen',
                reason: input.reason,
                changedBy: actor.staffId,
            },
        });
    });
    return getAccount(actor, accountId, meta);
}
export async function closeAccount(actor, accountId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectAccountById(client, accountId);
        if (!existing)
            throw new NotFoundError('Savings account');
        const status = existing.status;
        if (status !== 'active' && status !== 'frozen') {
            throw new BusinessRuleError('Only an active or frozen savings account can be closed', 'ACCOUNT_CANNOT_CLOSE');
        }
        // Zero-balance rule (spec §9.1): the member must have withdrawn everything
        // before the account can be closed.
        if (!isZero(existing.current_balance)) {
            throw new BusinessRuleError('Account balance must be zero before it can be closed', 'ACCOUNT_BALANCE_NOT_ZERO');
        }
        await client.query(`UPDATE savings_account
          SET status = 'closed', closed_on = $1, closure_reason = $2, updated_at = now()
        WHERE id = $3`, [istBusinessDate(), input.reason, accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_ACCOUNT_CLOSED,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                fromStatus: status,
                toStatus: 'closed',
                reason: input.reason,
                closedBy: actor.staffId,
            },
        });
    });
    return getAccount(actor, accountId, meta);
}
export async function reopenAccount(actor, accountId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectAccountById(client, accountId);
        if (!existing)
            throw new NotFoundError('Savings account');
        const status = existing.status;
        if (status !== 'frozen' && status !== 'closed') {
            throw new BusinessRuleError('Only a frozen or closed savings account can be reopened', 'ACCOUNT_NOT_FROZEN_OR_CLOSED');
        }
        await client.query(`UPDATE savings_account
          SET status = 'active', reopened_on = $1, updated_at = now()
        WHERE id = $2`, [istBusinessDate(), accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_ACCOUNT_REOPENED,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                fromStatus: status,
                toStatus: 'active',
                note: input.note ?? null,
                reopenedBy: actor.staffId,
            },
        });
    });
    return getAccount(actor, accountId, meta);
}
/**
 * Designated-person approval (spec §9.1). Flips a pending_approval account to
 * active and stamps approved_by / approved_on. Guarded at the route layer by
 * role president|managing_director (the second reviewer for account actions).
 */
export async function approveAccount(actor, accountId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectAccountById(client, accountId);
        if (!existing)
            throw new NotFoundError('Savings account');
        if (existing.status !== 'pending_approval') {
            throw new BusinessRuleError('Only a pending savings account can be approved', 'ACCOUNT_NOT_PENDING_APPROVAL');
        }
        await client.query(`UPDATE savings_account
          SET status = 'active', approved_by = $1, approved_on = $2, updated_at = now()
        WHERE id = $3`, [actor.staffId, istBusinessDate(), accountId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_ACCOUNT_APPROVED,
            entityType: 'savings_account',
            entityId: accountId,
            metadata: {
                fromStatus: 'pending_approval',
                toStatus: 'active',
                note: input.note ?? null,
                approvedBy: actor.staffId,
                accountNumber: existing.account_number,
            },
        });
    });
    return getAccount(actor, accountId, meta);
}
// ---------------------------------------------------------------------------
// Ledger — deposit / withdrawal posting
// ---------------------------------------------------------------------------
export async function postTransaction(actor, accountId, input, meta = {}) {
    const posted = await transaction(async (client) => {
        const account = await selectAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('Savings account');
        if (account.status !== 'active') {
            throw new BusinessRuleError('Transactions can only be posted to an active savings account', 'ACCOUNT_NOT_ACTIVE');
        }
        const isDeposit = input.transactionType === 'deposit';
        const direction = isDeposit ? 'credit' : 'debit';
        const valueDate = input.valueDate ?? istBusinessDate();
        if (isDeposit) {
            const balanceAfter = addMoney(account.current_balance, input.amount);
            if (account.product_max_balance && compareMoney(balanceAfter, account.product_max_balance) > 0) {
                throw new BusinessRuleError(`Balance after deposit would exceed the product maximum of ${account.product_max_balance}`, 'MAX_BALANCE_EXCEEDED');
            }
            const transactionId = await insertLedgerEntry(client, {
                accountId,
                accountNumber: account.account_number,
                transactionType: 'deposit',
                direction,
                amount: input.amount,
                balanceAfter,
                valueDate,
                paymentMethod: input.paymentMethod,
                referenceNumber: input.referenceNumber,
                description: input.description,
                actor,
            });
            await audit(client, {
                ...actorAuditBase(actor),
                requestId: meta.requestId ?? null,
                action: AUDIT_ACTIONS.SAVINGS_TRANSACTION_POSTED,
                entityType: 'account_transaction',
                entityId: transactionId,
                metadata: {
                    savingsAccountId: accountId,
                    accountNumber: account.account_number,
                    transactionType: 'deposit',
                    direction,
                    amount: input.amount,
                    balanceAfter,
                    valueDate,
                    paymentMethod: input.paymentMethod,
                    postedBy: actor.staffId,
                },
            });
            return loadTransaction(client, transactionId);
        }
        // Withdrawal path.
        if (compareMoney(input.amount, account.current_balance) > 0) {
            throw new BusinessRuleError('Withdrawal amount exceeds the available balance', 'INSUFFICIENT_BALANCE');
        }
        assertHighValueWithdrawalAuthority(actor, input.amount);
        const balanceAfter = subMoney(account.current_balance, input.amount);
        // A full withdrawal that brings the balance to zero is the final step before
        // closure and is always allowed; any remaining balance must respect the
        // minimum balance rule (product min_balance ∪ global savings minimum).
        if (!isZero(balanceAfter)) {
            const floor = maxMoney(account.product_min_balance, BUSINESS_RULES.SAVINGS_MIN_BALANCE);
            if (compareMoney(balanceAfter, floor) < 0) {
                throw new BusinessRuleError(`Withdrawal would leave the balance below the minimum of ${floor}`, 'MIN_BALANCE_VIOLATION');
            }
        }
        const transactionId = await insertLedgerEntry(client, {
            accountId,
            accountNumber: account.account_number,
            transactionType: 'withdrawal',
            direction,
            amount: input.amount,
            balanceAfter,
            valueDate,
            paymentMethod: input.paymentMethod,
            referenceNumber: input.referenceNumber,
            description: input.description,
            actor,
        });
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_TRANSACTION_POSTED,
            entityType: 'account_transaction',
            entityId: transactionId,
            metadata: {
                savingsAccountId: accountId,
                accountNumber: account.account_number,
                transactionType: 'withdrawal',
                direction,
                amount: input.amount,
                balanceAfter,
                valueDate,
                paymentMethod: input.paymentMethod,
                postedBy: actor.staffId,
            },
        });
        return loadTransaction(client, transactionId);
    });
    return posted;
}
async function insertLedgerEntry(client, entry) {
    void entry.accountNumber;
    const insert = await client.query(`INSERT INTO account_transaction
       (savings_account_id, transaction_type, direction, amount, balance_after,
        value_date, payment_method, reference_number, description,
        performed_by, performed_source)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`, [
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
    ]);
    const row = insert.rows[0];
    if (!row)
        throw new Error('failed to insert ledger transaction');
    await client.query(`UPDATE savings_account
        SET current_balance = $1, updated_at = now()
      WHERE id = $2`, [entry.balanceAfter, entry.accountId]);
    return row.id;
}
export async function listTransactions(actor, accountId, queryInput, meta = {}) {
    void actor;
    void meta;
    const where = ['t.savings_account_id = $1'];
    const params = [accountId];
    if (queryInput.type) {
        params.push(queryInput.type);
        where.push(`t.transaction_type = $${params.length}`);
    }
    if (queryInput.direction) {
        params.push(queryInput.direction);
        where.push(`t.direction = $${params.length}`);
    }
    if (queryInput.from) {
        params.push(queryInput.from);
        where.push(`t.value_date >= $${params.length}`);
    }
    if (queryInput.to) {
        params.push(queryInput.to);
        where.push(`t.value_date <= $${params.length}`);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    // Guard: the account must exist before the ledger is read (a closed account
    // keeps full history visible — spec §9.1 "history visible after closure").
    await transaction(async (client) => {
        const account = await selectAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('Savings account');
    });
    const result = await query(`SELECT t.id, t.savings_account_id, sa.account_number,
            t.transaction_type, t.direction,
            t.amount::text AS amount, t.balance_after::text AS balance_after,
            t.value_date::text AS value_date,
            t.payment_method, t.reference_number, t.description,
            t.performed_by, pb.full_name AS performed_by_name, t.performed_source,
            t.reversal_of, t.adjustment_id,
            t.withdrawal_request_id, t.created_at,
            count(*) OVER()::int AS total
       FROM account_transaction t
       JOIN savings_account sa ON sa.id = t.savings_account_id
       LEFT JOIN staff pb ON pb.id = t.performed_by
       ${whereSql}
      ORDER BY t.value_date DESC, t.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toTransactionView(row));
    return { total, items };
}
// ---------------------------------------------------------------------------
// Adjustments / corrections (Managing Director) — original never modified
// ---------------------------------------------------------------------------
export async function createAdjustment(actor, accountId, input, meta = {}) {
    const created = await transaction(async (client) => {
        const account = await selectAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('Savings account');
        assertNotClosed(account);
        const original = await selectOriginalTransaction(client, accountId, input.originalTransactionId);
        if (!original || original.savings_account_id !== accountId) {
            throw new NotFoundError('Transaction');
        }
        if (original.reversal_of || original.adjustment_id) {
            throw new BusinessRuleError('The original transaction is itself an adjustment or reversal entry', 'ORIGINAL_TRANSACTION_NOT_PRIMARY');
        }
        const alreadyAdjusted = await client.query(`SELECT 1 FROM account_adjustment WHERE original_transaction_id = $1 LIMIT 1`, [input.originalTransactionId]);
        if (alreadyAdjusted.rows.length > 0) {
            throw new BusinessRuleError('The original transaction has already been adjusted', 'ORIGINAL_TRANSACTION_ALREADY_ADJUSTED');
        }
        // Compensating entry flips the original direction for the same amount so
        // the original ledger row stays untouched (spec §9.1 "original never
        // modified"). The ledger entry carries the adjustment semantic: 'reversal'
        // for reversal adjustments and 'adjustment' for correction/replacement.
        const compensationType = input.adjustmentType === 'reversal' ? 'reversal' : 'adjustment';
        const compensationDirection = original.direction === 'credit' ? 'debit' : 'credit';
        const balanceAfter = compensationDirection === 'debit'
            ? subMoney(account.current_balance, original.amount)
            : addMoney(account.current_balance, original.amount);
        if (compensationDirection === 'debit' && isNegativeBalance(balanceAfter)) {
            throw new BusinessRuleError('Adjustment would make the account balance negative', 'INSUFFICIENT_BALANCE');
        }
        const compensationId = await insertLedgerEntry(client, {
            accountId,
            accountNumber: account.account_number,
            transactionType: compensationType,
            direction: compensationDirection,
            amount: original.amount,
            balanceAfter,
            valueDate: istBusinessDate(),
            paymentMethod: 'cash',
            description: `${input.adjustmentType} of transaction ${original.id}`,
            actor,
        });
        const adjustmentInsert = await client.query(`INSERT INTO account_adjustment
         (savings_account_id, adjustment_type, original_transaction_id,
          adjustment_transaction_id, reason, evidence_references,
          customer_confirmed, approved_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id`, [
            accountId,
            input.adjustmentType,
            input.originalTransactionId,
            compensationId,
            input.reason,
            JSON.stringify(input.evidenceReferences ?? []),
            input.customerConfirmed,
            actor.staffId,
        ]);
        const adjustmentRow = adjustmentInsert.rows[0];
        if (!adjustmentRow)
            throw new Error('failed to create account adjustment');
        // Close the circular FK: point the compensating ledger entry back at the
        // adjustment record that produced it.
        await client.query(`UPDATE account_transaction SET adjustment_id = $1 WHERE id = $2`, [adjustmentRow.id, compensationId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.SAVINGS_ADJUSTMENT_CREATED,
            entityType: 'account_adjustment',
            entityId: adjustmentRow.id,
            metadata: {
                savingsAccountId: accountId,
                accountNumber: account.account_number,
                adjustmentType: input.adjustmentType,
                originalTransactionId: input.originalTransactionId,
                adjustmentTransactionId: compensationId,
                amount: original.amount,
                compensationDirection,
                reason: input.reason,
                customerConfirmed: input.customerConfirmed,
                approvedBy: actor.staffId,
            },
        });
        return loadAdjustment(client, adjustmentRow.id);
    });
    return created;
}
function isNegativeBalance(value) {
    return value.startsWith('-');
}
// ---------------------------------------------------------------------------
// Statement (on demand / monthly / yearly / at closure)
// ---------------------------------------------------------------------------
export async function getStatement(actor, accountId, queryInput, meta = {}) {
    const statement = await transaction(async (client) => {
        const account = await selectAccountById(client, accountId);
        if (!account)
            throw new NotFoundError('Savings account');
        const from = queryInput.from ?? '0001-01-01';
        const to = queryInput.to ?? istBusinessDate();
        const limit = queryInput.limit;
        const offset = queryInput.offset;
        // Opening balance = balance_after of the newest ledger row strictly before
        // the window; closing balance = the newest row at or before the window end.
        const openingResult = await client.query(`SELECT balance_after::text AS balance_after
         FROM account_transaction
        WHERE savings_account_id = $1 AND value_date < $2
        ORDER BY value_date DESC, created_at DESC
        LIMIT 1`, [accountId, from]);
        const closingResult = await client.query(`SELECT balance_after::text AS balance_after
         FROM account_transaction
        WHERE savings_account_id = $1 AND value_date <= $2
        ORDER BY value_date DESC, created_at DESC
        LIMIT 1`, [accountId, to]);
        const openingBalance = openingResult.rows[0]?.balance_after ?? '0.00';
        const closingBalance = closingResult.rows[0]?.balance_after ?? openingBalance;
        const sumResult = await client.query(`SELECT COALESCE(SUM(amount) FILTER (WHERE direction = 'credit'), 0)::text AS credits,
              COALESCE(SUM(amount) FILTER (WHERE direction = 'debit'), 0)::text AS debits
         FROM account_transaction
        WHERE savings_account_id = $1 AND value_date BETWEEN $2 AND $3`, [accountId, from, to]);
        const sums = sumResult.rows[0];
        const totalCredits = sums?.credits ?? '0.00';
        const totalDebits = sums?.debits ?? '0.00';
        const rows = await client.query(`SELECT t.id, t.savings_account_id, sa.account_number,
              t.transaction_type, t.direction,
              t.amount::text AS amount, t.balance_after::text AS balance_after,
              t.value_date::text AS value_date,
              t.payment_method, t.reference_number, t.description,
              t.performed_by, pb.full_name AS performed_by_name, t.performed_source,
              t.reversal_of, t.adjustment_id,
              t.withdrawal_request_id, t.created_at,
              count(*) OVER()::int AS total
         FROM account_transaction t
         JOIN savings_account sa ON sa.id = t.savings_account_id
         LEFT JOIN staff pb ON pb.id = t.performed_by
        WHERE t.savings_account_id = $1 AND t.value_date BETWEEN $2 AND $3
        ORDER BY t.value_date DESC, t.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`, [accountId, from, to]);
        const total = rows.rows[0]?.total ?? 0;
        return {
            account: toAccountView(account),
            from,
            to,
            openingBalance,
            closingBalance,
            totalCredits,
            totalDebits,
            total,
            transactions: rows.rows.map((row) => toTransactionView(row)),
        };
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: ACTION_STATEMENT_GENERATED,
        entityType: 'savings_account',
        entityId: accountId,
        metadata: {
            accountNumber: statement.account.accountNumber,
            from: statement.from,
            to: statement.to,
            openingBalance: statement.openingBalance,
            closingBalance: statement.closingBalance,
            generatedBy: actor.staffId,
        },
    });
    return statement;
}
