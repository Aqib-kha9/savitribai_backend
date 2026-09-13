import { query, transaction } from '../../database/client.js';
import { appendAuditEvent, AUDIT_ACTIONS } from '../../audit/audit-writer.js';
import { istBusinessDate } from '../../core/time.js';
import { BadRequestError, BusinessRuleError, ConflictError, InternalError, NotFoundError, } from '../../core/errors.js';
import { allocateSequence, customerNumberFrom } from '../../database/numbering.js';
/**
 * Customers & nominees service (docs/backend-master-spec.md §8).
 *
 * Authority (spec §8.1):
 *  - status change / duplicate merge / death notification → Managing Director
 *  - KYC approval & branch transfer → Manager
 *  - profile create / update / nominee / consents / complaints → customers.write
 *
 * Every mutation runs inside one DB transaction and writes its audit event in
 * the same transaction (spec §6.3). Customer data-access reads append an
 * autocommit audit event (CUSTOMER_DATA_ACCESSED / CUSTOMER_DOCUMENTS_ACCESSED).
 *
 * Nominees are superseded — never hard-deleted — so `nominee_history` retains
 * the full replacement trail (spec §8.1). There is no hard delete for a
 * customer; a duplicate is closed and linked via `merged_into_customer_id`.
 */
// Complaint & consent actions are module-local vocabulary (audit-writer keeps
// the shared constants; these events are recorded with plain string actions).
const ACTION_COMPLAINT_RECORDED = 'customers.complaint.recorded';
const ACTION_CONSENT_RECORDED = 'customers.consent.recorded';
const ACTION_DATA_SUBJECT_REQUESTED = 'customers.data_subject.requested';
const ACTION_DATA_SUBJECT_DECIDED = 'customers.data_subject.decided';
// Statuses that terminate a customer record. Once terminal, no further
// status transition, nominee or consent change is permitted (audit safety).
// 'deleted' (spec §24.2 soft delete) is terminal: the profile is closed to
// further use while balance, loan and repayment-schedule records stay intact.
const TERMINAL_STATUSES = ['deceased', 'closed', 'deleted'];
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
/** Extracts the violated constraint name from a Postgres unique violation. */
function violatedConstraint(error) {
    if (typeof error === 'object' && error !== null && 'constraint' in error) {
        const constraint = error.constraint;
        return typeof constraint === 'string' ? constraint : undefined;
    }
    return undefined;
}
/**
 * Normalises an identity-document number for comparison and storage.
 *
 * The same Aadhaar typed as `1234 5678 9012` and `123456789012` identifies one
 * person, and PAN case is not significant, so every separator is stripped and
 * the result is upper-cased. Migration 005 applies the identical normalisation
 * inside the database trigger, so API and DB agree on what "same number" means.
 */
function normalizeDocumentNumber(value) {
    return value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}
/**
 * Find another *active* customer already registered against `mobile`
 * (spec §8.1 uniqueness policy). Terminal profiles (deceased / closed /
 * deleted) are excluded so historical and merged records never block a
 * legitimate new registration.
 */
async function findActiveCustomerByMobile(client, mobile, excludeCustomerId) {
    const result = await client.query(`SELECT id, customer_number, full_name
       FROM customer
      WHERE mobile = $1
        AND status NOT IN ('deceased', 'closed', 'deleted')
        AND ($2::uuid IS NULL OR id <> $2::uuid)
      ORDER BY created_at ASC, id ASC
      LIMIT 1`, [mobile, excludeCustomerId ?? null]);
    return result.rows[0] ?? null;
}
/**
 * Find another *active* customer already holding the same Aadhaar / PAN number.
 * Returns null for proof-of-address documents (electricity bill), which do not
 * identify a person and are intentionally allowed to repeat.
 */
async function findActiveCustomerByIdentityDocument(client, documentType, documentNumber, excludeCustomerId) {
    if (documentType !== 'aadhaar' && documentType !== 'pan')
        return null;
    const normalized = normalizeDocumentNumber(documentNumber);
    if (!normalized)
        return null;
    const result = await client.query(`SELECT c.id, c.customer_number, c.full_name
       FROM customer_identity_document d
       JOIN customer c ON c.id = d.customer_id
      WHERE d.document_type = $1
        AND upper(regexp_replace(d.document_number, '[^A-Za-z0-9]', '', 'g')) = $2
        AND c.status NOT IN ('deceased', 'closed', 'deleted')
        AND ($3::uuid IS NULL OR c.id <> $3::uuid)
      ORDER BY d.created_at ASC, d.id ASC
      LIMIT 1`, [documentType, normalized, excludeCustomerId ?? null]);
    return result.rows[0] ?? null;
}
/**
 * Build the friendly 409 surfaced in the Add / Edit customer modal, naming the
 * existing customer so an operator knows exactly which profile to open.
 */
function duplicateConflictError(owner, field) {
    const label = owner.customer_number ?? owner.id;
    const message = field === 'mobile'
        ? `Mobile number is already registered to ${owner.full_name} (${label}). Use a different number or open that customer's profile.`
        : `This identity document is already registered to ${owner.full_name} (${label}). Use a different document or open that customer's profile.`;
    return new ConflictError(message, field === 'mobile' ? 'CUSTOMER_MOBILE_EXISTS' : 'CUSTOMER_IDENTITY_EXISTS', {
        field,
        customerId: owner.id,
        customerNumber: owner.customer_number,
        customerName: owner.full_name,
    });
}
/**
 * Insert one identity document, storing the normalised number and translating
 * the migration-005 uniqueness trigger into the same friendly 409 the mobile
 * rule produces (a bare 23505 would otherwise surface as a generic conflict).
 */
async function insertIdentityDocument(client, customerId, doc) {
    try {
        await client.query(`INSERT INTO customer_identity_document
         (customer_id, document_type, document_number, issue_date, expiry_date,
          issuing_authority, copy_reference, is_verified)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`, [
            customerId,
            doc.documentType,
            normalizeDocumentNumber(doc.documentNumber),
            doc.issueDate ?? null,
            doc.expiryDate ?? null,
            doc.issuingAuthority ?? null,
            doc.copyReference ?? null,
            doc.isVerified ?? false,
        ]);
    }
    catch (error) {
        if (isUniqueViolation(error) && violatedConstraint(error) === 'uq_customer_identity_document_number') {
            throw new ConflictError(`This identity document is already registered to another active customer. Use a different document or open that customer's profile.`, 'CUSTOMER_IDENTITY_EXISTS', { field: 'identity' });
        }
        throw error;
    }
}
async function assertBranchExists(client, branchId) {
    const result = await client.query(`SELECT 1 FROM branch WHERE id = $1`, [branchId]);
    if (result.rows.length === 0) {
        throw new BadRequestError('Branch does not exist');
    }
}
async function selectCustomerById(client, customerId) {
    const result = await client.query(`SELECT c.id, c.customer_number, c.customer_type, c.full_name,
            c.date_of_birth::text AS date_of_birth, c.gender, c.occupation, c.business_type,
            c.mobile, c.alternate_phone, c.email, c.branch_id, b.name AS branch_name,
            c.membership_category, c.status, c.risk_category, c.aml_risk, c.source_of_funds,
            c.guardian_name, c.guardian_phone, c.kyc_method,
            c.registration_date::text AS registration_date,
            c.merged_into_customer_id, c.created_at, c.updated_at
       FROM customer c
       LEFT JOIN branch b ON b.id = c.branch_id
      WHERE c.id = $1
      LIMIT 1`, [customerId]);
    return result.rows[0] ?? null;
}
function toCustomerView(row) {
    return {
        id: row.id,
        customerNumber: row.customer_number,
        customerType: row.customer_type,
        fullName: row.full_name,
        dateOfBirth: row.date_of_birth,
        gender: row.gender,
        occupation: row.occupation,
        businessType: row.business_type,
        mobile: row.mobile,
        alternatePhone: row.alternate_phone,
        email: row.email,
        branchId: row.branch_id,
        branchName: row.branch_name,
        membershipCategory: row.membership_category,
        status: row.status,
        riskCategory: row.risk_category,
        amlRisk: row.aml_risk,
        sourceOfFunds: row.source_of_funds,
        guardianName: row.guardian_name,
        guardianPhone: row.guardian_phone,
        kycMethod: row.kyc_method,
        registrationDate: row.registration_date,
        mergedIntoCustomerId: row.merged_into_customer_id,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
async function selectAddresses(client, customerId) {
    const result = await client.query(`SELECT address_type, line1, line2, city, district, state, pincode, landmark
       FROM customer_address
      WHERE customer_id = $1
      ORDER BY address_type`, [customerId]);
    return result.rows.map((row) => ({
        addressType: row.address_type,
        line1: row.line1,
        line2: row.line2,
        city: row.city,
        district: row.district,
        state: row.state,
        pincode: row.pincode,
        landmark: row.landmark,
    }));
}
async function selectIdentityDocuments(client, customerId) {
    const result = await client.query(`SELECT id, document_type, document_number,
            issue_date::text AS issue_date, expiry_date::text AS expiry_date,
            issuing_authority, copy_reference, is_verified
       FROM customer_identity_document
      WHERE customer_id = $1
      ORDER BY document_type`, [customerId]);
    return result.rows.map((row) => ({
        id: row.id,
        documentType: row.document_type,
        documentNumber: row.document_number,
        issueDate: row.issue_date,
        expiryDate: row.expiry_date,
        issuingAuthority: row.issuing_authority,
        copyReference: row.copy_reference,
        isVerified: row.is_verified,
    }));
}
async function selectKyc(client, customerId) {
    const result = await client.query(`SELECT k.status, k.method, k.verified_by, st.full_name AS verified_staff_name,
            k.verified_on, k.rejection_reason, k.expires_on::text AS expires_on
       FROM customer_kyc k
       LEFT JOIN staff st ON st.id = k.verified_by
      WHERE k.customer_id = $1
      LIMIT 1`, [customerId]);
    const row = result.rows[0];
    if (!row)
        return null;
    return {
        status: row.status,
        method: row.method,
        verifiedByStaffId: row.verified_by,
        verifiedBy: row.verified_staff_name,
        verifiedOn: iso(row.verified_on),
        rejectionReason: row.rejection_reason,
        expiresOn: row.expires_on,
    };
}
async function selectCurrentNominee(client, customerId) {
    const result = await client.query(`SELECT id, name, relationship, date_of_birth::text AS date_of_birth,
            identity_document_type, identity_document_number, address, phone,
            share_percentage::text AS share_percentage, guardian_name, guardian_phone, is_current
       FROM nominee
      WHERE customer_id = $1 AND is_current
      LIMIT 1`, [customerId]);
    const row = result.rows[0];
    if (!row)
        return null;
    return {
        id: row.id,
        name: row.name,
        relationship: row.relationship,
        dateOfBirth: row.date_of_birth,
        identityDocumentType: row.identity_document_type,
        identityDocumentNumber: row.identity_document_number,
        address: row.address,
        phone: row.phone,
        sharePercentage: row.share_percentage,
        guardianName: row.guardian_name,
        guardianPhone: row.guardian_phone,
        isCurrent: row.is_current,
    };
}
async function selectConsents(client, customerId) {
    const result = await client.query(`SELECT channel, granted, granted_at, revoked_at
       FROM customer_consent
      WHERE customer_id = $1
      ORDER BY channel`, [customerId]);
    return result.rows.map((row) => ({
        channel: row.channel,
        granted: row.granted,
        grantedAt: iso(row.granted_at),
        revokedAt: iso(row.revoked_at),
    }));
}
async function selectComplaints(client, customerId) {
    const result = await client.query(`SELECT id, category, description, status, created_at
       FROM customer_complaint
      WHERE customer_id = $1
      ORDER BY created_at DESC
      LIMIT 20`, [customerId]);
    return result.rows.map((row) => ({
        id: row.id,
        category: row.category,
        description: row.description,
        status: row.status,
        createdAt: row.created_at.toISOString(),
    }));
}
/** Resolves the currently assigned collection agent (staff or agent code). */
async function selectAssignedAgent(client, customerId) {
    const result = await client.query(`SELECT st.full_name AS staff_name, a.agent_code
       FROM agent_customer_assignment aca
       JOIN agent a ON a.id = aca.agent_id
       JOIN staff st ON st.id = a.staff_id
      WHERE aca.customer_id = $1 AND aca.is_active
      ORDER BY aca.effective_from DESC
      LIMIT 1`, [customerId]);
    const row = result.rows[0];
    if (!row)
        return null;
    return row.staff_name ?? row.agent_code ?? null;
}
/** Human-readable label for an account lifecycle status. */
const SERVICE_STATUS_LABEL = {
    pending_approval: 'Pending',
    active: 'Active',
    frozen: 'Frozen',
    closed: 'Closed',
    overdue: 'Overdue',
    completed: 'Completed',
    matured: 'Matured',
    closed_early: 'Closed early',
    suspended: 'Suspended',
    cancelled: 'Cancelled',
    under_lien: 'Under lien',
    renewed: 'Renewed',
    rescheduled: 'Rescheduled',
    settled: 'Settled',
    written_off: 'Written off',
};
function serviceStatusLabel(status) {
    return SERVICE_STATUS_LABEL[status] ?? status.replace(/_/g, ' ');
}
/** Every real account (savings, RD, FD, loan) the customer holds. */
async function selectServices(client, customerId) {
    const result = await client.query(`SELECT id, service_type, account_number, status, amount, opened_on
       FROM (
         SELECT id, 'Savings'::text AS service_type, account_number, status,
                current_balance::text AS amount, opened_on::text AS opened_on
           FROM savings_account WHERE customer_id = $1
         UNION ALL
         SELECT id, 'Recurring deposit'::text, account_number, status,
                total_paid::text, start_date::text
           FROM rd_account WHERE customer_id = $1
         UNION ALL
         SELECT id, 'Fixed deposit'::text, account_number, status,
                deposit_amount::text, start_date::text
           FROM fd_account WHERE customer_id = $1
         UNION ALL
         SELECT id, 'Loan'::text, loan_number, status,
                outstanding_amount::text, disbursed_on::text
           FROM loan WHERE customer_id = $1
       ) AS accounts
      ORDER BY service_type, account_number`, [customerId]);
    return result.rows.map((row) => ({
        id: row.id,
        type: row.service_type,
        accountNumber: row.account_number,
        label: `${row.service_type} account`,
        amount: row.amount,
        detail: row.opened_on ? `Opened ${row.opened_on}` : 'Opening date not recorded',
        status: serviceStatusLabel(row.status),
    }));
}
/** Recent financial activity across the customer's accounts and collections. */
async function selectTransactions(client, customerId) {
    const result = await client.query(`SELECT id, transaction_type, amount, performed_on, agent_name, reference, status
       FROM (
         SELECT t.id, 'Deposit collection'::text AS transaction_type,
                t.amount::text AS amount, t.value_date::text AS performed_on,
                COALESCE(st.full_name, 'System') AS agent_name,
                t.reference_number AS reference,
                (CASE WHEN t.direction = 'credit' THEN 'Completed' ELSE 'Withdrawal' END)::text AS status
           FROM savings_account sa
           JOIN account_transaction t ON t.savings_account_id = sa.id
           LEFT JOIN staff st ON st.id = t.performed_by
          WHERE sa.customer_id = $1
         UNION ALL
         SELECT t.id, 'Deposit collection'::text, t.amount::text,
                t.business_date::text,
                COALESCE(st.full_name, 'Field agent'),
                COALESCE(t.instrument_ref, t.idempotency_key),
                (CASE t.status
                   WHEN 'accepted' THEN 'Completed'
                   WHEN 'rejected' THEN 'Rejected'
                   WHEN 'requiresReview' THEN 'Review'
                   ELSE 'Pending'
                 END)::text
           FROM collection_entry t
           JOIN agent a ON a.id = t.agent_id
           LEFT JOIN staff st ON st.id = a.staff_id
          WHERE t.customer_id = $1 AND NOT t.is_deleted
         UNION ALL
         SELECT i.id, 'RD installment'::text, i.paid_amount::text,
                i.paid_on::text,
                COALESCE(st.full_name, 'Field agent'),
                i.reference_number,
                (CASE WHEN i.status = 'paid' THEN 'Completed' ELSE 'Review' END)::text
           FROM rd_account ra
           JOIN rd_instalment i ON i.rd_account_id = ra.id
           LEFT JOIN collection_entry ce ON ce.id = i.collection_entry_id
           LEFT JOIN agent a ON a.id = ce.agent_id
           LEFT JOIN staff st ON st.id = a.staff_id
          WHERE ra.customer_id = $1 AND i.paid_amount > 0 AND i.paid_on IS NOT NULL
         UNION ALL
         SELECT i.id, 'Loan repayment'::text, i.paid_amount::text,
                i.paid_on::text,
                'System',
                NULL::text,
                (CASE WHEN i.status = 'paid' THEN 'Completed' ELSE 'Review' END)::text
           FROM loan l
           JOIN loan_instalment i ON i.loan_id = l.id
          WHERE l.customer_id = $1 AND i.paid_amount > 0 AND i.paid_on IS NOT NULL
       ) AS activity
      ORDER BY performed_on DESC NULLS LAST
      LIMIT 25`, [customerId]);
    return result.rows.map((row) => ({
        id: row.id,
        type: row.transaction_type,
        amount: row.amount,
        date: row.performed_on ?? '',
        agent: row.agent_name ?? 'System',
        reference: row.reference ?? '',
        status: row.status,
    }));
}
async function loadCustomerDetail(client, customerId) {
    const core = await selectCustomerById(client, customerId);
    if (!core)
        throw new NotFoundError('Customer');
    const [addresses, identityDocuments, kyc, nominee, consents, complaints, assignedAgent, services, transactions] = await Promise.all([
        selectAddresses(client, customerId),
        selectIdentityDocuments(client, customerId),
        selectKyc(client, customerId),
        selectCurrentNominee(client, customerId),
        selectConsents(client, customerId),
        selectComplaints(client, customerId),
        selectAssignedAgent(client, customerId),
        selectServices(client, customerId),
        selectTransactions(client, customerId),
    ]);
    const totalValue = services.reduce((sum, service) => sum + (Number.parseFloat(service.amount) || 0), 0);
    return {
        ...toCustomerView(core),
        addresses,
        identityDocuments,
        kyc,
        nominee,
        consents,
        complaints,
        assignedAgent,
        accountSummary: services.length
            ? `${services.length} linked ${services.length === 1 ? 'service' : 'services'}`
            : 'No linked accounts',
        totalValue: totalValue.toFixed(2),
        services,
        transactions,
    };
}
function assertMutable(row) {
    if (row.merged_into_customer_id) {
        throw new BusinessRuleError('This customer has been merged into another profile and cannot be modified', 'CUSTOMER_MERGED');
    }
    if (TERMINAL_STATUSES.includes(row.status)) {
        throw new BusinessRuleError(`Customer is ${row.status}; this record is closed for further changes`, 'CUSTOMER_TERMINAL_STATE');
    }
}
async function ensureKycRow(client, customerId) {
    await client.query(`INSERT INTO customer_kyc (customer_id)
     VALUES ($1)
     ON CONFLICT (customer_id) DO NOTHING`, [customerId]);
}
// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------
export async function createCustomer(actor, input, meta = {}) {
    const created = await transaction(async (client) => {
        await assertBranchExists(client, input.branchId);
        // Production uniqueness: reject a profile whose mobile (or Aadhaar / PAN)
        // already belongs to an active customer, naming the existing record so the
        // operator can open it instead of creating a duplicate (spec §8.1).
        const mobileClash = await findActiveCustomerByMobile(client, input.mobile);
        if (mobileClash)
            throw duplicateConflictError(mobileClash, 'mobile');
        for (const doc of input.identityDocuments ?? []) {
            const identityClash = await findActiveCustomerByIdentityDocument(client, doc.documentType, doc.documentNumber);
            if (identityClash)
                throw duplicateConflictError(identityClash, 'identity');
        }
        const sequence = await allocateSequence(client, 'customer');
        const customerNumber = customerNumberFrom(input.fullName, sequence);
        let customerId;
        try {
            const insert = await client.query(`INSERT INTO customer
           (customer_number, customer_type, full_name, date_of_birth, gender, occupation,
            business_type, mobile, alternate_phone, email, branch_id, membership_category,
            status, risk_category, aml_risk, source_of_funds, guardian_name, guardian_phone,
            kyc_method, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'active',
                 $13, $14, $15, $16, $17, $18, $19)
         RETURNING id`, [
                customerNumber,
                input.customerType,
                input.fullName,
                input.dateOfBirth ?? null,
                input.gender ?? null,
                input.occupation ?? null,
                input.businessType ?? null,
                input.mobile,
                input.alternatePhone ?? null,
                input.email ?? null,
                input.branchId,
                input.membershipCategory,
                input.riskCategory ?? null,
                input.amlRisk ?? null,
                input.sourceOfFunds ?? null,
                input.guardianName ?? null,
                input.guardianPhone ?? null,
                input.kycMethod ?? null,
                actor.staffId,
            ]);
            const inserted = insert.rows[0];
            if (!inserted)
                throw new Error('failed to create customer');
            customerId = inserted.id;
        }
        catch (error) {
            if (isUniqueViolation(error)) {
                const constraint = violatedConstraint(error);
                if (constraint === 'uq_customer_active_mobile') {
                    throw new ConflictError(`Mobile number is already registered to another active customer. Use a different number or open that customer's profile.`, 'CUSTOMER_MOBILE_EXISTS', { field: 'mobile' });
                }
                throw new ConflictError('Customer number collision — please retry', 'CUSTOMER_NUMBER_COLLISION');
            }
            throw error;
        }
        // Addresses (mandatory per spec §8.1).
        for (const address of input.addresses) {
            await client.query(`INSERT INTO customer_address
           (customer_id, address_type, line1, line2, city, district, state, pincode, landmark)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
                customerId,
                address.addressType,
                address.line1,
                address.line2 ?? null,
                address.city ?? null,
                address.district ?? null,
                address.state ?? null,
                address.pincode ?? null,
                address.landmark ?? null,
            ]);
        }
        // Identity documents (optional at registration). Stored normalised, with no
        // duplicate of another active customer's Aadhaar / PAN permitted.
        for (const doc of input.identityDocuments ?? []) {
            await insertIdentityDocument(client, customerId, doc);
        }
        // KYC lifecycle row — starts pending; Manager approval flips it later.
        await ensureKycRow(client, customerId);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_CREATED,
            entityType: 'customer',
            entityId: customerId,
            metadata: {
                customerNumber,
                customerType: input.customerType,
                branchId: input.branchId,
                mobile: input.mobile,
                createdBy: actor.staffId,
            },
        });
        return loadCustomerDetail(client, customerId);
    });
    return created;
}
/**
 * Build the shared WHERE clause for customer list / export queries.
 *
 * Every value is bound as a query parameter, so user-supplied search text and
 * ids can never break out of the SQL (spec §2.4). The search term escapes the
 * LIKE wildcards `\ % _` and uses `ESCAPE '\'` so a literal `%` in a customer
 * name is matched literally instead of acting as a wildcard.
 */
function buildCustomerFilters(queryInput) {
    const where = [];
    const params = [];
    const addParam = (value) => {
        params.push(value);
        return `$${params.length}`;
    };
    if (queryInput.search) {
        const escaped = queryInput.search.replace(/[\\%_]/g, (ch) => `\\${ch}`);
        const pattern = `%${escaped}%`;
        where.push(`(c.customer_number ILIKE ${addParam(pattern)} ESCAPE '\\' OR c.full_name ILIKE ${addParam(pattern)} ESCAPE '\\' OR c.mobile ILIKE ${addParam(pattern)} ESCAPE '\\' OR c.email ILIKE ${addParam(pattern)} ESCAPE '\\' OR EXISTS (SELECT 1 FROM agent_customer_assignment saca JOIN agent sa ON sa.id = saca.agent_id JOIN staff sst ON sst.id = sa.staff_id WHERE saca.customer_id = c.id AND saca.is_active AND (sst.full_name ILIKE ${addParam(pattern)} ESCAPE '\\' OR sa.agent_code ILIKE ${addParam(pattern)} ESCAPE '\\')))`);
    }
    if (queryInput.type) {
        where.push(`c.customer_type = ${addParam(queryInput.type)}`);
    }
    if (queryInput.status) {
        where.push(`c.status = ${addParam(queryInput.status)}`);
    }
    if (queryInput.membershipCategory) {
        where.push(`c.membership_category = ${addParam(queryInput.membershipCategory)}`);
    }
    if (queryInput.customerId) {
        where.push(`c.id = ${addParam(queryInput.customerId)}`);
    }
    if (queryInput.branchId) {
        where.push(`c.branch_id = ${addParam(queryInput.branchId)}`);
    }
    if (queryInput.agentId) {
        where.push(`EXISTS (SELECT 1 FROM agent_customer_assignment aca
                WHERE aca.customer_id = c.id
                  AND aca.agent_id = ${addParam(queryInput.agentId)}
                  AND aca.is_active)`);
    }
    if (queryInput.registeredFrom) {
        where.push(`c.registration_date >= ${addParam(queryInput.registeredFrom)}::date`);
    }
    if (queryInput.registeredTo) {
        where.push(`c.registration_date <= ${addParam(queryInput.registeredTo)}::date`);
    }
    return {
        whereSql: where.length > 0 ? `WHERE ${where.join(' AND ')}` : '',
        params,
    };
}
export async function listCustomers(actor, queryInput, meta = {}) {
    void actor;
    void meta;
    const { whereSql, params } = buildCustomerFilters(queryInput);
    const limit = queryInput.limit;
    const offset = queryInput.offset;
    const result = await query(`SELECT c.id, c.customer_number, c.customer_type, c.full_name,
            c.date_of_birth::text AS date_of_birth, c.gender, c.occupation, c.business_type,
            c.mobile, c.alternate_phone, c.email, c.branch_id, b.name AS branch_name,
            c.membership_category, c.status, c.risk_category, c.aml_risk, c.source_of_funds,
            c.guardian_name, c.guardian_phone, c.kyc_method,
            c.registration_date::text AS registration_date,
            c.merged_into_customer_id, c.created_at, c.updated_at,
            count(*) OVER()::int AS total
       FROM customer c
       LEFT JOIN branch b ON b.id = c.branch_id
       ${whereSql}
      ORDER BY c.created_at DESC
      LIMIT ${limit} OFFSET ${offset}`, params);
    const total = result.rows[0]?.total ?? 0;
    const items = result.rows.map((row) => toCustomerView(row));
    return { total, items };
}
/**
 * Export the filtered customer list (spec §8 — reporting). Bounded to 5000 rows
 * so a broad filter cannot exhaust memory; the caller streams it as CSV.
 * Access is audited because it discloses personal data in bulk (spec §6.3).
 */
export async function exportCustomers(actor, queryInput, meta = {}) {
    const { whereSql, params } = buildCustomerFilters(queryInput);
    const result = await query(`SELECT c.id, c.customer_number, c.customer_type, c.full_name,
            c.date_of_birth::text AS date_of_birth, c.gender, c.occupation, c.business_type,
            c.mobile, c.alternate_phone, c.email, c.branch_id, b.name AS branch_name,
            c.membership_category, c.status, c.risk_category, c.aml_risk, c.source_of_funds,
            c.guardian_name, c.guardian_phone, c.kyc_method,
            c.registration_date::text AS registration_date,
            c.merged_into_customer_id, c.created_at, c.updated_at
       FROM customer c
       LEFT JOIN branch b ON b.id = c.branch_id
       ${whereSql}
      ORDER BY c.created_at DESC
      LIMIT 5000`, params);
    const items = result.rows.map((row) => toCustomerView(row));
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_DATA_ACCESSED,
        entityType: 'customer',
        entityId: null,
        metadata: { exportedBy: actor.staffId, rowCount: items.length, format: 'csv' },
    });
    return items;
}
export async function getCustomer(actor, customerId, meta = {}) {
    const detail = await transaction(async (client) => {
        return loadCustomerDetail(client, customerId);
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_DATA_ACCESSED,
        entityType: 'customer',
        entityId: customerId,
        metadata: { viewedBy: actor.staffId },
    });
    return detail;
}
export async function listCustomerDocuments(actor, customerId, meta = {}) {
    const documents = await transaction(async (client) => {
        const core = await selectCustomerById(client, customerId);
        if (!core)
            throw new NotFoundError('Customer');
        return selectIdentityDocuments(client, customerId);
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_DOCUMENTS_ACCESSED,
        entityType: 'customer',
        entityId: customerId,
        metadata: { viewedBy: actor.staffId, documentCount: documents.length },
    });
    return documents;
}
// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------
export async function updateCustomer(actor, customerId, input, meta = {}) {
    const updated = await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        // Same production uniqueness as create, excluding this customer's own row so
        // an unrelated field edit is never rejected as a self-conflict.
        if (input.mobile !== undefined) {
            const mobileClash = await findActiveCustomerByMobile(client, input.mobile, customerId);
            if (mobileClash)
                throw duplicateConflictError(mobileClash, 'mobile');
        }
        if (input.identityDocuments !== undefined) {
            for (const doc of input.identityDocuments) {
                const identityClash = await findActiveCustomerByIdentityDocument(client, doc.documentType, doc.documentNumber, customerId);
                if (identityClash)
                    throw duplicateConflictError(identityClash, 'identity');
            }
        }
        const sets = [];
        const values = [];
        const push = (column, value) => {
            values.push(value);
            sets.push(`${column} = $${values.length}`);
        };
        if (input.fullName !== undefined)
            push('full_name', input.fullName);
        if (input.mobile !== undefined)
            push('mobile', input.mobile);
        if (input.alternatePhone !== undefined)
            push('alternate_phone', input.alternatePhone);
        if (input.email !== undefined)
            push('email', input.email);
        if (input.dateOfBirth !== undefined)
            push('date_of_birth', input.dateOfBirth);
        if (input.gender !== undefined)
            push('gender', input.gender);
        if (input.occupation !== undefined)
            push('occupation', input.occupation);
        if (input.businessType !== undefined)
            push('business_type', input.businessType);
        if (input.riskCategory !== undefined)
            push('risk_category', input.riskCategory);
        if (input.amlRisk !== undefined)
            push('aml_risk', input.amlRisk);
        if (input.sourceOfFunds !== undefined)
            push('source_of_funds', input.sourceOfFunds);
        if (input.guardianName !== undefined)
            push('guardian_name', input.guardianName);
        if (input.guardianPhone !== undefined)
            push('guardian_phone', input.guardianPhone);
        if (input.kycMethod !== undefined)
            push('kyc_method', input.kycMethod);
        if (sets.length > 0) {
            await client.query(`UPDATE customer SET ${sets.join(', ')}, updated_at = now() WHERE id = $${values.length + 1}`, [
                ...values,
                customerId,
            ]);
        }
        let kycReset = false;
        if (input.addresses !== undefined) {
            await client.query(`DELETE FROM customer_address WHERE customer_id = $1`, [customerId]);
            for (const address of input.addresses) {
                await client.query(`INSERT INTO customer_address
             (customer_id, address_type, line1, line2, city, district, state, pincode, landmark)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`, [
                    customerId,
                    address.addressType,
                    address.line1,
                    address.line2 ?? null,
                    address.city ?? null,
                    address.district ?? null,
                    address.state ?? null,
                    address.pincode ?? null,
                    address.landmark ?? null,
                ]);
            }
        }
        if (input.identityDocuments !== undefined) {
            await client.query(`DELETE FROM customer_identity_document WHERE customer_id = $1`, [customerId]);
            for (const doc of input.identityDocuments) {
                await insertIdentityDocument(client, customerId, doc);
            }
            // A fresh document set invalidates the previous approval until a Manager
            // re-approves it (spec §8.1: KYC required & approved for services).
            kycReset = true;
        }
        if (kycReset) {
            await ensureKycRow(client, customerId);
            await client.query(`UPDATE customer_kyc
            SET status = 'pending', method = NULL, verified_by = NULL,
                verified_on = NULL, rejection_reason = NULL, expires_on = NULL,
                updated_at = now()
          WHERE customer_id = $1`, [customerId]);
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
            entityType: 'customer',
            entityId: customerId,
            metadata: {
                fields: Object.keys(input).filter((k) => input[k] !== undefined),
                kycReset,
                updatedBy: actor.staffId,
            },
        });
        return loadCustomerDetail(client, customerId);
    });
    return updated;
}
// ---------------------------------------------------------------------------
// Status changes (Managing Director)
// ---------------------------------------------------------------------------
async function applyStatusChange(client, actor, customerId, toStatus, reason, meta, metadata) {
    const existing = await selectCustomerById(client, customerId);
    if (!existing)
        throw new NotFoundError('Customer');
    assertMutable(existing);
    const fromStatus = existing.status;
    if (fromStatus === toStatus)
        return; // idempotent no-op
    await client.query(`UPDATE customer SET status = $1, updated_at = now() WHERE id = $2`, [toStatus, customerId]);
    await client.query(`INSERT INTO customer_status_history
       (customer_id, from_status, to_status, reason, changed_by)
     VALUES ($1, $2, $3, $4, $5)`, [customerId, fromStatus, toStatus, reason, actor.staffId]);
    await audit(client, {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_STATUS_CHANGED,
        entityType: 'customer',
        entityId: customerId,
        metadata: {
            fromStatus,
            toStatus,
            reason,
            changedBy: actor.staffId,
            ...metadata,
        },
    });
}
export async function changeCustomerStatus(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        await applyStatusChange(client, actor, customerId, input.status, input.reason, meta, {});
    });
    return getCustomer(actor, customerId, meta);
}
export async function deathNotification(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        await applyStatusChange(client, actor, customerId, 'deceased', input.note ? `Death reported: ${input.note}` : 'Death reported', meta, { dateOfDeath: input.dateOfDeath ?? null });
    });
    return getCustomer(actor, customerId, meta);
}
// ---------------------------------------------------------------------------
// Branch transfer (Manager approval per spec §8.3)
// ---------------------------------------------------------------------------
export async function transferCustomer(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        if (existing.branch_id === input.toBranchId) {
            throw new BusinessRuleError('Customer already belongs to the destination branch', 'SAME_BRANCH_TRANSFER');
        }
        await assertBranchExists(client, input.toBranchId);
        const fromBranchId = existing.branch_id;
        await client.query(`UPDATE customer SET branch_id = $1, updated_at = now() WHERE id = $2`, [
            input.toBranchId,
            customerId,
        ]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
            entityType: 'customer',
            entityId: customerId,
            metadata: {
                transfer: true,
                fromBranchId,
                toBranchId: input.toBranchId,
                reason: input.reason,
                approvedBy: actor.staffId,
            },
        });
    });
    return getCustomer(actor, customerId, meta);
}
// ---------------------------------------------------------------------------
// KYC approval (Manager)
// ---------------------------------------------------------------------------
export async function approveKyc(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        await ensureKycRow(client, customerId);
        const approved = input.status === 'approved';
        await client.query(`UPDATE customer_kyc
          SET status = $1,
              method = $2,
              verified_by = $3,
              verified_on = now(),
              rejection_reason = $4,
              expires_on = NULL,
              updated_at = now()
        WHERE customer_id = $5`, [
            input.status,
            input.method ?? null,
            approved ? actor.staffId : null,
            approved ? null : (input.rejectionReason ?? null),
            customerId,
        ]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_KYC_APPROVED,
            entityType: 'customer',
            entityId: customerId,
            metadata: {
                status: input.status,
                method: input.method ?? null,
                rejectionReason: approved ? null : (input.rejectionReason ?? null),
                verifiedBy: actor.staffId,
            },
        });
    });
    return getCustomer(actor, customerId, meta);
}
// ---------------------------------------------------------------------------
// Nominee (single current nominee — supersede, never delete; spec §8.1)
// ---------------------------------------------------------------------------
export async function setNominee(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        // Supersede the previous current nominee (retained in nominee_history).
        await client.query(`UPDATE nominee
          SET is_current = false, superseded_at = now(), superseded_by = $2
        WHERE customer_id = $1 AND is_current`, [customerId, actor.staffId]);
        await client.query(`INSERT INTO nominee
         (customer_id, name, relationship, date_of_birth, identity_document_type,
          identity_document_number, address, phone, share_percentage,
          guardian_name, guardian_phone)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`, [
            customerId,
            input.name,
            input.relationship,
            input.dateOfBirth ?? null,
            input.identityDocumentType ?? null,
            input.identityDocumentNumber ?? null,
            input.address ?? null,
            input.phone ?? null,
            String(input.sharePercentage),
            input.guardianName ?? null,
            input.guardianPhone ?? null,
        ]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_UPDATED,
            entityType: 'nominee',
            entityId: customerId,
            metadata: {
                nomineeSet: true,
                nomineeName: input.name,
                relationship: input.relationship,
                sharePercentage: input.sharePercentage,
                setBy: actor.staffId,
            },
        });
    });
    return getCustomer(actor, customerId, meta);
}
// ---------------------------------------------------------------------------
// Consents (per channel; spec §8.1 — all channels captured)
// ---------------------------------------------------------------------------
export async function recordConsents(actor, customerId, input, meta = {}) {
    await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        assertMutable(existing);
        for (const consent of input.consents) {
            await client.query(`INSERT INTO customer_consent (customer_id, channel, granted, granted_at, revoked_at, recorded_by)
         VALUES ($1, $2, $3,
                 CASE WHEN $3 THEN now() ELSE NULL END,
                 CASE WHEN $3 THEN NULL ELSE now() END,
                 $4)
         ON CONFLICT (customer_id, channel)
         DO UPDATE SET
           granted = EXCLUDED.granted,
           granted_at = CASE WHEN EXCLUDED.granted THEN now() ELSE customer_consent.granted_at END,
           revoked_at = CASE WHEN EXCLUDED.granted THEN NULL ELSE now() END,
           recorded_by = EXCLUDED.recorded_by`, [customerId, consent.channel, consent.granted, actor.staffId]);
        }
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_CONSENT_RECORDED,
            entityType: 'customer_consent',
            entityId: customerId,
            metadata: {
                consents: input.consents.map((c) => ({ channel: c.channel, granted: c.granted })),
                recordedBy: actor.staffId,
            },
        });
    });
    return getCustomer(actor, customerId, meta);
}
// ---------------------------------------------------------------------------
// Complaints / service requests
// ---------------------------------------------------------------------------
export async function recordComplaint(actor, customerId, input, meta = {}) {
    const created = await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        const insert = await client.query(`INSERT INTO customer_complaint (customer_id, category, description, raised_by)
       VALUES ($1, $2, $3, $4)
       RETURNING id`, [customerId, input.category ?? null, input.description, actor.staffId]);
        const row = insert.rows[0];
        if (!row)
            throw new InternalError('Failed to record complaint');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_COMPLAINT_RECORDED,
            entityType: 'customer_complaint',
            entityId: row.id,
            metadata: {
                customerId,
                category: input.category ?? null,
                raisedBy: actor.staffId,
            },
        });
        return { id: row.id, status: 'open' };
    });
    return created;
}
// ---------------------------------------------------------------------------
// Duplicate merge (Managing Director) — spec §8.1
// ---------------------------------------------------------------------------
export async function mergeCustomers(actor, sourceCustomerId, input, meta = {}) {
    const targetId = input.mergeIntoCustomerId;
    if (sourceCustomerId === targetId) {
        throw new BadRequestError('Cannot merge a customer into itself');
    }
    await transaction(async (client) => {
        const source = await selectCustomerById(client, sourceCustomerId);
        if (!source)
            throw new NotFoundError('Customer');
        const target = await selectCustomerById(client, targetId);
        if (!target)
            throw new NotFoundError('Target customer');
        if (source.merged_into_customer_id) {
            throw new BusinessRuleError('Source customer is already merged', 'CUSTOMER_MERGED');
        }
        if (target.merged_into_customer_id) {
            throw new BusinessRuleError('Target customer is already merged', 'CUSTOMER_MERGED');
        }
        // Preserve nominee protection: if the surviving profile has no current
        // nominee, adopt the duplicate's current nominee; otherwise supersede it.
        const targetHasNominee = await selectCurrentNominee(client, targetId);
        if (!targetHasNominee) {
            await client.query(`UPDATE nominee
            SET customer_id = $2
          WHERE customer_id = $1 AND is_current`, [sourceCustomerId, targetId]);
        }
        else {
            await client.query(`UPDATE nominee
            SET is_current = false, superseded_at = now(), superseded_by = $2
          WHERE customer_id = $1 AND is_current`, [sourceCustomerId, actor.staffId]);
        }
        const fromStatus = source.status;
        await client.query(`UPDATE customer
          SET status = 'closed', merged_into_customer_id = $2, updated_at = now()
        WHERE id = $1`, [sourceCustomerId, targetId]);
        await client.query(`INSERT INTO customer_status_history
         (customer_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, 'closed', $3, $4)`, [sourceCustomerId, fromStatus, input.reason, actor.staffId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: AUDIT_ACTIONS.CUSTOMER_MERGED,
            entityType: 'customer',
            entityId: targetId,
            metadata: {
                sourceCustomerId,
                sourceCustomerNumber: source.customer_number,
                targetCustomerNumber: target.customer_number,
                reason: input.reason,
                mergedBy: actor.staffId,
            },
        });
    });
    return getCustomer(actor, targetId, meta);
}
const FIELD_VERIFICATION_LIST_COLUMNS = `
  SELECT fv.id,
         fv.customer_id,
         fv.agent_id,
         a.agent_code,
         st.full_name AS agent_name,
         fv.verification_date::text AS verification_date,
         fv.address_verified,
         fv.outcome,
         fv.remarks,
         fv.created_at
    FROM field_verification fv
    LEFT JOIN agent a  ON a.id  = fv.agent_id
    LEFT JOIN staff st ON st.id = a.staff_id`;
/**
 * GET /customers/:id/field-verifications — field (address) verification history
 * for a customer, newest first (spec §8.1). Recording happens on the agent
 * mobile (agents module); this is the office-side read, audited as a customer
 * data access. Returns [] for a customer with no verifications yet.
 */
export async function listFieldVerifications(actor, customerId, meta = {}) {
    const rows = await transaction(async (client) => {
        const core = await selectCustomerById(client, customerId);
        if (!core)
            throw new NotFoundError('Customer');
        const result = await client.query(`${FIELD_VERIFICATION_LIST_COLUMNS}
        WHERE fv.customer_id = $1
        ORDER BY fv.verification_date DESC, fv.created_at DESC`, [customerId]);
        return result.rows;
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_DATA_ACCESSED,
        entityType: 'customer',
        entityId: customerId,
        metadata: { viewedBy: actor.staffId, section: 'field_verification' },
    });
    return rows.map((row) => ({
        id: row.id,
        customerId: row.customer_id,
        agentId: row.agent_id,
        agentCode: row.agent_code,
        agentName: row.agent_name,
        verificationDate: row.verification_date,
        addressVerified: row.address_verified,
        outcome: row.outcome,
        remarks: row.remarks,
        createdAt: row.created_at.toISOString(),
    }));
}
// ---------------------------------------------------------------------------
// Data-subject rights (spec §24.2)
// ---------------------------------------------------------------------------
const DATA_SUBJECT_REQUEST_COLUMNS = `
       id, customer_id, request_type, status, details,
       requested_at, decided_by, decided_at, decision_notes,
       created_at, updated_at`;
function toDataSubjectRequestView(row) {
    return {
        id: row.id,
        customerId: row.customer_id,
        requestType: row.request_type,
        status: row.status,
        details: row.details,
        requestedAt: row.requested_at.toISOString(),
        decidedBy: row.decided_by,
        decidedAt: iso(row.decided_at),
        decisionNotes: row.decision_notes,
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
    };
}
/**
 * POST /customers/:id/data-subject-requests — raise a copy / correction /
 * restriction / deletion request on a customer's behalf (office staff).
 * The request register is append-only; even a completed deletion keeps the
 * request row and the customer record (soft 'deleted' state — financial
 * records are mandatorily retained per spec §24.2).
 */
export async function createDataSubjectRequest(actor, customerId, input, meta = {}) {
    const created = await transaction(async (client) => {
        const existing = await selectCustomerById(client, customerId);
        if (!existing)
            throw new NotFoundError('Customer');
        const insert = await client.query(`INSERT INTO data_subject_request (customer_id, request_type, details)
       VALUES ($1, $2, $3)
       RETURNING${DATA_SUBJECT_REQUEST_COLUMNS}`, [customerId, input.requestType, input.details]);
        const row = insert.rows[0];
        if (!row)
            throw new InternalError('Failed to record data-subject request');
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_DATA_SUBJECT_REQUESTED,
            entityType: 'data_subject_request',
            entityId: row.id,
            metadata: {
                customerId,
                requestType: input.requestType,
                raisedBy: actor.staffId,
            },
        });
        return toDataSubjectRequestView(row);
    });
    return created;
}
/**
 * GET /customers/:id/data-subject-requests — the request register for a
 * customer, newest first. Audited as a customer data access.
 */
export async function listDataSubjectRequests(actor, customerId, meta = {}) {
    const rows = await transaction(async (client) => {
        const core = await selectCustomerById(client, customerId);
        if (!core)
            throw new NotFoundError('Customer');
        const result = await client.query(`SELECT${DATA_SUBJECT_REQUEST_COLUMNS}
         FROM data_subject_request
        WHERE customer_id = $1
        ORDER BY requested_at DESC, created_at DESC`, [customerId]);
        return result.rows;
    });
    await audit(poolForEvent(), {
        ...actorAuditBase(actor),
        requestId: meta.requestId ?? null,
        action: AUDIT_ACTIONS.CUSTOMER_DATA_ACCESSED,
        entityType: 'customer',
        entityId: customerId,
        metadata: { viewedBy: actor.staffId, section: 'data_subject_requests' },
    });
    return rows.map(toDataSubjectRequestView);
}
/**
 * PATCH /customers/:id/data-subject-requests/:requestId — M.D. decision
 * (spec §24.1 external reporting contact). Completing a 'deletion' request
 * moves the profile to the soft 'deleted' status (records retained); a
 * 'restriction' request moves it to 'restricted' (product activity frozen).
 * Requests are one-way: once completed/rejected they cannot be re-decided.
 */
export async function decideDataSubjectRequest(actor, customerId, requestId, input, meta = {}) {
    const decided = await transaction(async (client) => {
        const customer = await selectCustomerById(client, customerId);
        if (!customer)
            throw new NotFoundError('Customer');
        const found = await client.query(`SELECT${DATA_SUBJECT_REQUEST_COLUMNS}
         FROM data_subject_request
        WHERE id = $1 AND customer_id = $2
        LIMIT 1`, [requestId, customerId]);
        const row = found.rows[0];
        if (!row)
            throw new NotFoundError('Data-subject request');
        if (row.status === 'completed' || row.status === 'rejected') {
            throw new ConflictError(`Data-subject request is already ${row.status}`, 'DATA_SUBJECT_REQUEST_CLOSED');
        }
        const requestType = row.request_type;
        const currentStatus = customer.status;
        let statusEffect = null;
        if (input.status === 'completed') {
            if (requestType === 'deletion' && !TERMINAL_STATUSES.includes(currentStatus)) {
                // Soft delete: profile closes but balance / loan / repayment records
                // are retained (mandatory, spec §24.2). applyStatusChange guards
                // merged profiles and idempotently skips an identical status.
                await applyStatusChange(client, actor, customerId, 'deleted', `Data-subject deletion request ${row.id}`, meta, { requestId: row.id });
                statusEffect = 'deleted';
            }
            else if (requestType === 'restriction' && currentStatus !== 'restricted') {
                // 'restricted' freezes new product opening / withdrawal activity; the
                // M.D. can lift it later via the regular status-change endpoint.
                await applyStatusChange(client, actor, customerId, 'restricted', `Data-subject restriction request ${row.id}`, meta, { requestId: row.id });
                statusEffect = 'restricted';
            }
            else {
                statusEffect = currentStatus;
            }
        }
        await client.query(`UPDATE data_subject_request
          SET status = $1, decided_by = $2, decided_at = now(),
              decision_notes = $3, updated_at = now()
        WHERE id = $4`, [input.status, actor.staffId, input.decisionNotes, requestId]);
        await audit(client, {
            ...actorAuditBase(actor),
            requestId: meta.requestId ?? null,
            action: ACTION_DATA_SUBJECT_DECIDED,
            entityType: 'data_subject_request',
            entityId: row.id,
            metadata: {
                customerId,
                requestType,
                status: input.status,
                decisionNotes: input.decisionNotes,
                statusEffect,
                decidedBy: actor.staffId,
            },
        });
        const updated = await client.query(`SELECT${DATA_SUBJECT_REQUEST_COLUMNS}
         FROM data_subject_request
        WHERE id = $1`, [requestId]);
        const updatedRow = updated.rows[0];
        if (!updatedRow)
            throw new InternalError('Failed to read updated data-subject request');
        return toDataSubjectRequestView(updatedRow);
    });
    return decided;
}
