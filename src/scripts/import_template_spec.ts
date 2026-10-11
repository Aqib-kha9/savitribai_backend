/**
 * Single source of truth for the Excel import template contract.
 *
 * Every sheet column `header` below is EXACTLY the field the software expects
 * (backend Zod schema field name, or a human-readable *Code join key that the
 * importer resolves to a UUID). `allowed` lists the literal Zod enum values /
 * seed reference codes. This module is consumed by:
 *   - src/scripts/generate_import_templates.ts  (writes the .xlsx templates)
 *   - src/scripts/validate_import_templates.ts  (pre-import gate: fails on any
 *     header rename, wrong enum, bad money/rate/date/boolean, missing required)
 *
 * Source of truth (do not diverge):
 *   - src/modules/customers/customers.schemas.ts
 *   - src/modules/deposits/deposits.schemas.ts
 *   - src/modules/rd/rd.schemas.ts
 *   - src/modules/fd/fd.schemas.ts
 *   - src/modules/loans/loans.schemas.ts
 *   - src/modules/collections/collections.schemas.ts
 *   - src/modules/agents/agents.schemas.ts
 *   - src/modules/sync/sync.schemas.ts
 *   - src/database/seed.ts (reference codes)
 */

export type Col = {
  /** EXACT header the importer expects — must not be renamed. */
  header: string;
  required: boolean;
  /** Human-readable format hint for the Instructions sheet. */
  format: string;
  /** Allowed enum values / codes ('—' when free). */
  allowed: string;
  note: string;
  sample: string;
  /** Machine-checkable kind used by the validator. */
  kind: 'text' | 'money' | 'rate' | 'date' | 'datetime' | 'boolean' | 'integer' | 'enum' | 'ref';
  /** For kind='enum': the exact allowed values (case-sensitive). */
  values?: string[];
  /** Optional per-column max length (mirrors Zod .max()). */
  maxLen?: number;
};

export type Sheet = { name: string; cols: Col[] };

// ---------------------------------------------------------------------------
// Shared vocabulary (copied verbatim from the Zod schemas / seed)
// ---------------------------------------------------------------------------

export const ENUM_CUSTOMER_TYPE = 'Individual | Cooperation | Group | SHG | Organisation | Minor | Joint';
export const ENUM_CUSTOMER_STATUS = 'active | inactive | blocked | deceased | transferred | closed | restricted | deleted';
export const ENUM_MEMBERSHIP = 'Loan | Savings | Daily | RD | Current';
export const ENUM_ADDRESS_TYPE = 'permanent | current | work | collection';
export const ENUM_IDS_DOC = 'aadhaar | pan | electricity_bill';
export const ENUM_CONSENT_CHANNEL =
  'sms | whatsapp | email | call | location_visit | promotional | printed_receipt | app_notification | voice_call';
export const ENUM_PAYMENT_METHOD = 'cash | bank_transfer | cheque | mobile_money | upi | neft | rtgs';
export const ENUM_RD_FREQUENCY = 'daily | weekly | monthly | quarterly';
export const ENUM_FD_PAYOUT_FREQ = 'monthly | quarterly | yearly | at_maturity';
export const ENUM_FD_PAYOUT_MODE = 'payout | reinvest';
export const ENUM_FD_MATURITY_ACTION =
  'pending | renew_principal_interest | renew_principal | transfer_to_savings | pay_cash | pay_bank';
export const ENUM_LOAN_FREQUENCY = 'daily | weekly | monthly | quarterly';
export const ENUM_COLLECTION_PRODUCT = 'savingsDeposit | recurringDeposit | loan | penalty';
export const ENUM_COLLECTION_MODE = 'cash | UPI | NEFT | RTGS | cheque';
export const ENUM_VISIT_OUTCOME = 'collected | notAvailable | promised | refused';
export const ENUM_RECEIPT_KIND = 'daily | monthly';

export const ARR_CUSTOMER_TYPE = ['Individual', 'Cooperation', 'Group', 'SHG', 'Organisation', 'Minor', 'Joint'];
export const ARR_CUSTOMER_STATUS = ['active', 'inactive', 'blocked', 'deceased', 'transferred', 'closed', 'restricted', 'deleted'];
export const ARR_MEMBERSHIP = ['Loan', 'Savings', 'Daily', 'RD', 'Current'];
export const ARR_ADDRESS_TYPE = ['permanent', 'current', 'work', 'collection'];
export const ARR_IDS_DOC = ['aadhaar', 'pan', 'electricity_bill'];
export const ARR_CONSENT_CHANNEL = [
  'sms', 'whatsapp', 'email', 'call', 'location_visit', 'promotional', 'printed_receipt', 'app_notification', 'voice_call',
];
export const ARR_PAYMENT_METHOD = ['cash', 'bank_transfer', 'cheque', 'mobile_money', 'upi', 'neft', 'rtgs'];
export const ARR_RD_FREQUENCY = ['daily', 'weekly', 'monthly', 'quarterly'];
export const ARR_FD_PAYOUT_FREQ = ['monthly', 'quarterly', 'yearly', 'at_maturity'];
export const ARR_FD_PAYOUT_MODE = ['payout', 'reinvest'];
export const ARR_FD_MATURITY_ACTION =
  ['pending', 'renew_principal_interest', 'renew_principal', 'transfer_to_savings', 'pay_cash', 'pay_bank'];
export const ARR_COLLECTION_PRODUCT = ['savingsDeposit', 'recurringDeposit', 'loan', 'penalty'];
export const ARR_COLLECTION_MODE = ['cash', 'UPI', 'NEFT', 'RTGS', 'cheque'];
export const ARR_RECEIPT_KIND = ['daily', 'monthly'];

export const DEPOSIT_PRODUCT_CODES = ['SAV-STD', 'SAV-DLY', 'DAILY-180'];
export const RD_SCHEME_CODES = ['RD-DLY', 'RD-MTH'];
export const LOAN_PRODUCT_CODES = [
  'LN-PER', 'LN-BUS', 'LN-FD', 'LN-SHG', 'LN-VEH', 'LN-GLD', 'LN-MTG', 'LN-MIS', 'LN-DMP', 'LN-DLY', 'LN-WKLY',
];

export const NOTE_REF = 'Reference key used to join rows across sheets. Must be unique per customer (e.g. CUST-0001). Not stored on the customer row.';
export const NOTE_BRANCH = 'Must match an existing branch code in the system (office supplies the code). Resolved to branchId (UUID) on import.';
export const NOTE_MONEY = 'Amount as text/number with at most 2 decimals, greater than 0. Format matches /^\\d{1,12}(\\.\\d{1,2})?$/.';
export const NOTE_RATE = 'Interest rate, up to 4 decimals, greater than 0 and at most 25. Format matches /^\\d{1,3}(\\.\\d{1,4})?$/.';
export const NOTE_DATE = 'Date in YYYY-MM-DD format (e.g. 2026-09-15).';
export const NOTE_BOOL = 'TRUE or FALSE.';

// ---------------------------------------------------------------------------
// Sheet definitions — headers are the EXACT backend field names
// ---------------------------------------------------------------------------

export const SHEETS: Sheet[] = [
  {
    name: '1. Customers',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: NOTE_REF, sample: 'CUST-0001', kind: 'ref' },
      { header: 'fullName', required: true, format: 'text (2–160 chars)', allowed: '—', note: 'Customer full name. Backend field is fullName (frontend label "Name").', sample: 'Ramesh Patil', kind: 'text', maxLen: 160 },
      { header: 'customerType', required: false, format: 'text', allowed: ENUM_CUSTOMER_TYPE, note: 'Defaults to Individual when blank.', sample: 'Individual', kind: 'enum', values: ARR_CUSTOMER_TYPE },
      { header: 'mobile', required: true, format: 'text (7–20 chars)', allowed: '—', note: 'Primary mobile. Mandatory (spec §8.1). Digits only preferred; do not leave "NA".', sample: '9876543210', kind: 'text', maxLen: 20 },
      { header: 'alternatePhone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 20 },
      { header: 'email', required: false, format: 'valid email (max 160)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 160 },
      { header: 'dateOfBirth', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '1985-04-12', kind: 'date' },
      { header: 'gender', required: false, format: 'text (max 20)', allowed: 'Male | Female | Other (free text)', note: '', sample: 'Male', kind: 'text', maxLen: 20 },
      { header: 'occupation', required: false, format: 'text (max 120)', allowed: '—', note: '', sample: 'Farmer', kind: 'text', maxLen: 120 },
      { header: 'businessType', required: false, format: 'text (max 120)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 120 },
      { header: 'branchCode', required: true, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'membershipCategory', required: false, format: 'text', allowed: ENUM_MEMBERSHIP, note: 'Defaults to Savings when blank.', sample: 'Savings', kind: 'enum', values: ARR_MEMBERSHIP },
      { header: 'riskCategory', required: false, format: 'text (max 80)', allowed: '—', note: '', sample: 'Low', kind: 'text', maxLen: 80 },
      { header: 'amlRisk', required: false, format: 'text (max 80)', allowed: 'Low | Medium | High (free text)', note: '', sample: 'Low', kind: 'text', maxLen: 80 },
      { header: 'sourceOfFunds', required: false, format: 'text (max 200)', allowed: '—', note: '', sample: 'Agriculture income', kind: 'text', maxLen: 200 },
      { header: 'guardianName', required: false, format: 'text (max 120)', allowed: '—', note: 'Required for Minor customers.', sample: '', kind: 'text', maxLen: 120 },
      { header: 'guardianPhone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 20 },
      { header: 'kycMethod', required: false, format: 'text (max 40)', allowed: '—', note: '', sample: 'Aadhaar', kind: 'text', maxLen: 40 },
      { header: 'assignedAgentCode', required: false, format: 'text', allowed: '—', note: 'Optional. Must match an agent agentCode if provided.', sample: '', kind: 'ref' },
      { header: 'registrationDate', required: false, format: 'date', allowed: '—', note: 'Defaults to the import date when blank.', sample: '2026-09-15', kind: 'date' },
      { header: 'status', required: false, format: 'text', allowed: ENUM_CUSTOMER_STATUS, note: 'Defaults to active when blank.', sample: 'active', kind: 'enum', values: ARR_CUSTOMER_STATUS },
    ],
  },
  {
    name: '2. Addresses',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'addressType', required: true, format: 'text', allowed: ENUM_ADDRESS_TYPE, note: 'At least one address per customer is mandatory (spec §8.1).', sample: 'permanent', kind: 'enum', values: ARR_ADDRESS_TYPE },
      { header: 'line1', required: true, format: 'text (max 255)', allowed: '—', note: '', sample: 'Rajgriha Apartment, Devangana Society', kind: 'text', maxLen: 255 },
      { header: 'line2', required: false, format: 'text (max 255)', allowed: '—', note: '', sample: 'Waghapur Lohara Bypass', kind: 'text', maxLen: 255 },
      { header: 'city', required: false, format: 'text (max 100)', allowed: '—', note: '', sample: 'Yavatmal', kind: 'text', maxLen: 100 },
      { header: 'district', required: false, format: 'text (max 100)', allowed: '—', note: '', sample: 'Yavatmal', kind: 'text', maxLen: 100 },
      { header: 'state', required: false, format: 'text (max 100)', allowed: '—', note: '', sample: 'Maharashtra', kind: 'text', maxLen: 100 },
      { header: 'pincode', required: false, format: 'text (max 10)', allowed: '—', note: 'Keep as text so leading zeros are preserved.', sample: '445001', kind: 'text', maxLen: 10 },
      { header: 'landmark', required: false, format: 'text (max 255)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 255 },
    ],
  },
  {
    name: '3. Nominees',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'name', required: true, format: 'text (max 160)', allowed: '—', note: '', sample: 'Sunita Patil', kind: 'text', maxLen: 160 },
      { header: 'relationship', required: true, format: 'text (max 120)', allowed: '—', note: '', sample: 'Spouse', kind: 'text', maxLen: 120 },
      { header: 'dateOfBirth', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '', kind: 'date' },
      { header: 'identityDocumentType', required: false, format: 'text', allowed: ENUM_IDS_DOC, note: '', sample: 'aadhaar', kind: 'enum', values: ARR_IDS_DOC },
      { header: 'identityDocumentNumber', required: false, format: 'text (max 100)', allowed: '—', note: '', sample: '123456789012', kind: 'text', maxLen: 100 },
      { header: 'address', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 300 },
      { header: 'phone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '9876500000', kind: 'text', maxLen: 20 },
      { header: 'sharePercentage', required: false, format: 'number (0.01–100)', allowed: '—', note: 'Defaults to 100.', sample: '100', kind: 'text' },
      { header: 'guardianName', required: false, format: 'text (max 120)', allowed: '—', note: 'Required when the nominee is a minor.', sample: '', kind: 'text', maxLen: 120 },
      { header: 'guardianPhone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 20 },
    ],
  },
  {
    name: '4. Customer KYC Documents',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'documentType', required: true, format: 'text', allowed: ENUM_IDS_DOC, note: '', sample: 'aadhaar', kind: 'enum', values: ARR_IDS_DOC },
      { header: 'documentNumber', required: true, format: 'text (max 100)', allowed: '—', note: '', sample: '123456789012', kind: 'text', maxLen: 100 },
      { header: 'issueDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '', kind: 'date' },
      { header: 'expiryDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '', kind: 'date' },
      { header: 'issuingAuthority', required: false, format: 'text (max 160)', allowed: '—', note: '', sample: 'UIDAI', kind: 'text', maxLen: 160 },
      { header: 'copyReference', required: false, format: 'text (max 200)', allowed: '—', note: 'Reference to the stored scan/photo.', sample: '', kind: 'text', maxLen: 200 },
      { header: 'isVerified', required: false, format: 'boolean', allowed: 'TRUE | FALSE', note: NOTE_BOOL, sample: 'TRUE', kind: 'boolean' },
    ],
  },
  {
    name: '5. Customer Consents',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'channel', required: true, format: 'text', allowed: ENUM_CONSENT_CHANNEL, note: 'At least one consent row per customer is required.', sample: 'sms', kind: 'enum', values: ARR_CONSENT_CHANNEL },
      { header: 'granted', required: true, format: 'boolean', allowed: 'TRUE | FALSE', note: NOTE_BOOL, sample: 'TRUE', kind: 'boolean' },
    ],
  },
  {
    name: '6. Savings Accounts',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'productCode', required: true, format: 'text', allowed: DEPOSIT_PRODUCT_CODES.join(' | '), note: 'Deposit product code (see Reference Data). Resolved to productId (UUID).', sample: 'SAV-STD', kind: 'enum', values: DEPOSIT_PRODUCT_CODES },
      { header: 'branchCode', required: true, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'openingAmount', required: true, format: 'money', allowed: '—', note: NOTE_MONEY, sample: '5000.00', kind: 'money' },
      { header: 'openedOn', required: false, format: 'date', allowed: '—', note: 'Defaults to the import date when blank.', sample: '2026-09-15', kind: 'date' },
      { header: 'interestRate', required: false, format: 'rate', allowed: '—', note: NOTE_RATE + ' Blank uses the product default.', sample: '', kind: 'rate' },
      { header: 'paymentMethod', required: false, format: 'text', allowed: ENUM_PAYMENT_METHOD, note: 'Defaults to cash.', sample: 'cash', kind: 'enum', values: ARR_PAYMENT_METHOD },
      { header: 'referenceNumber', required: false, format: 'text (max 60)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 60 },
      { header: 'description', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: 'Opening deposit', kind: 'text', maxLen: 300 },
    ],
  },
  {
    name: '7. RD Accounts',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'schemeCode', required: true, format: 'text', allowed: RD_SCHEME_CODES.join(' | '), note: 'RD scheme code (see Reference Data). Resolved to schemeId (UUID).', sample: 'RD-MTH', kind: 'enum', values: RD_SCHEME_CODES },
      { header: 'branchCode', required: true, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'instalmentAmount', required: true, format: 'money', allowed: '—', note: NOTE_MONEY + ' Must be within the scheme min/max instalment.', sample: '1000.00', kind: 'money' },
      { header: 'frequency', required: true, format: 'text', allowed: ENUM_RD_FREQUENCY, note: 'Should match the scheme frequency (RD-DLY=daily, RD-MTH=monthly).', sample: 'monthly', kind: 'enum', values: ARR_RD_FREQUENCY },
      { header: 'startDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '2026-09-15', kind: 'date' },
      { header: 'firstDueDate', required: true, format: 'date', allowed: '—', note: 'First instalment due date. Schedule is generated from this + frequency.', sample: '2026-10-15', kind: 'date' },
      { header: 'maturityDate', required: false, format: 'date', allowed: '—', note: 'Provide EITHER maturityDate OR durationMonths (exactly one required).', sample: '', kind: 'date' },
      { header: 'durationMonths', required: false, format: 'integer (1–120)', allowed: '—', note: 'Provide EITHER maturityDate OR durationMonths (exactly one required).', sample: '12', kind: 'integer' },
      { header: 'paymentMethod', required: false, format: 'text', allowed: ENUM_PAYMENT_METHOD, note: 'Defaults to cash.', sample: 'cash', kind: 'enum', values: ARR_PAYMENT_METHOD },
      { header: 'referenceNumber', required: false, format: 'text (max 60)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 60 },
      { header: 'description', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 300 },
    ],
  },
  {
    name: '8. FD Accounts',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'rateCardCode', required: false, format: 'text', allowed: '—', note: 'Optional. If blank, the importer matches depositAmount + tenureMonths to an FD rate-card band (see Reference Data).', sample: '', kind: 'ref' },
      { header: 'branchCode', required: true, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'depositAmount', required: true, format: 'money', allowed: '—', note: NOTE_MONEY + ' FD deposit must be between 1000.00 and 100000.00 (spec §11.1).', sample: '20000.00', kind: 'money' },
      { header: 'tenureMonths', required: true, format: 'integer (1–120)', allowed: '—', note: '', sample: '12', kind: 'integer' },
      { header: 'startDate', required: false, format: 'date', allowed: '—', note: 'Defaults to the import date when blank.', sample: '2026-09-15', kind: 'date' },
      { header: 'payoutFrequency', required: true, format: 'text', allowed: ENUM_FD_PAYOUT_FREQ, note: '', sample: 'at_maturity', kind: 'enum', values: ARR_FD_PAYOUT_FREQ },
      { header: 'payoutMode', required: false, format: 'text', allowed: ENUM_FD_PAYOUT_MODE, note: 'Defaults to reinvest.', sample: 'reinvest', kind: 'enum', values: ARR_FD_PAYOUT_MODE },
      { header: 'maturityAction', required: false, format: 'text', allowed: ENUM_FD_MATURITY_ACTION, note: 'Defaults to pending.', sample: 'pending', kind: 'enum', values: ARR_FD_MATURITY_ACTION },
      { header: 'rateIsFixed', required: false, format: 'boolean', allowed: 'TRUE | FALSE', note: NOTE_BOOL, sample: 'FALSE', kind: 'boolean' },
      { header: 'paymentMethod', required: false, format: 'text', allowed: ENUM_PAYMENT_METHOD, note: 'Defaults to cash.', sample: 'cash', kind: 'enum', values: ARR_PAYMENT_METHOD },
      { header: 'referenceNumber', required: false, format: 'text (max 60)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 60 },
      { header: 'description', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 300 },
    ],
  },
  {
    name: '9. Loan Applications',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'productCode', required: true, format: 'text', allowed: LOAN_PRODUCT_CODES.join(' | '), note: 'Loan product code (see Reference Data). Resolved to productId (UUID).', sample: 'LN-PER', kind: 'enum', values: LOAN_PRODUCT_CODES },
      { header: 'branchCode', required: true, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'purpose', required: true, format: 'text (3–300)', allowed: '—', note: 'Must NOT contain the phrase "home loan" (not offered, spec §12.1).', sample: 'Business expansion', kind: 'text', maxLen: 300 },
      { header: 'requestedAmount', required: true, format: 'money', allowed: '—', note: NOTE_MONEY + ' Must be within the product min/max.', sample: '50000.00', kind: 'money' },
      { header: 'tenureMonths', required: true, format: 'integer (1–240)', allowed: '—', note: 'Must be within the product min/max tenure.', sample: '24', kind: 'integer' },
      { header: 'repaymentFrequency', required: true, format: 'text', allowed: ENUM_LOAN_FREQUENCY, note: '', sample: 'monthly', kind: 'enum', values: ARR_RD_FREQUENCY },
      { header: 'proposedInterestRate', required: false, format: 'rate', allowed: '—', note: NOTE_RATE + ' Blank uses the product rate.', sample: '', kind: 'rate' },
      { header: 'documents', required: false, format: 'text', allowed: '—', note: 'Free-text reference to attached documents.', sample: '', kind: 'text' },
    ],
  },
  {
    name: '10. Loan Guarantors',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Borrower customerRef — must match sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'guarantorCustomerRef', required: false, format: 'text', allowed: '—', note: 'Optional. Set when the guarantor is already a customer.', sample: '', kind: 'ref' },
      { header: 'name', required: true, format: 'text (max 200)', allowed: '—', note: '', sample: 'Ganesh Deshmukh', kind: 'text', maxLen: 200 },
      { header: 'relationship', required: false, format: 'text (max 80)', allowed: '—', note: '', sample: 'Friend', kind: 'text', maxLen: 80 },
      { header: 'identityDocumentType', required: false, format: 'text (max 40)', allowed: 'free text (e.g. aadhaar, pan)', note: '', sample: 'aadhaar', kind: 'text', maxLen: 40 },
      { header: 'identityDocumentNumber', required: false, format: 'text (max 60)', allowed: '—', note: '', sample: '987654321098', kind: 'text', maxLen: 60 },
      { header: 'phone', required: false, format: 'text (max 30)', allowed: '—', note: '', sample: '9876511111', kind: 'text', maxLen: 30 },
      { header: 'address', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 300 },
    ],
  },
  {
    name: '11. Loan Collateral',
    cols: [
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Borrower customerRef — must match sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'collateralType', required: true, format: 'text (max 80)', allowed: '—', note: 'Must be unique per customer (no two rows with the same type).', sample: 'Gold ornaments', kind: 'text', maxLen: 80 },
      { header: 'description', required: false, format: 'text (max 300)', allowed: '—', note: '', sample: '22K gold chain, 25g', kind: 'text', maxLen: 300 },
      { header: 'valuationAmount', required: true, format: 'money', allowed: '—', note: NOTE_MONEY, sample: '150000.00', kind: 'money' },
      { header: 'valuationDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '2026-09-10', kind: 'date' },
      { header: 'documentReference', required: false, format: 'text (max 120)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 120 },
    ],
  },
  {
    name: '12. Agent Collections',
    cols: [
      { header: 'agentCode', required: true, format: 'text', allowed: '—', note: 'Collecting agent agentCode (see sheet "13. Agents").', sample: 'AG-YTM-001', kind: 'ref' },
      { header: 'customerRef', required: true, format: 'text', allowed: '—', note: 'Must match a customerRef on sheet "1. Customers".', sample: 'CUST-0001', kind: 'ref' },
      { header: 'productType', required: true, format: 'text', allowed: ENUM_COLLECTION_PRODUCT, note: 'Determines which account column accountRef points at.', sample: 'loan', kind: 'enum', values: ARR_COLLECTION_PRODUCT },
      { header: 'accountRef', required: true, format: 'text', allowed: '—', note: 'The product account/loan NUMBER (e.g. L.A.0001, S.A.L.A0001, R.D.A0001). Must match productType.', sample: 'L.A.0001', kind: 'ref' },
      { header: 'amount', required: true, format: 'money', allowed: '—', note: 'Collected amount. ' + NOTE_MONEY, sample: '2000.00', kind: 'money' },
      { header: 'mode', required: true, format: 'text', allowed: ENUM_COLLECTION_MODE, note: 'Collection payment mode.', sample: 'cash', kind: 'enum', values: ARR_COLLECTION_MODE },
      { header: 'isPartial', required: false, format: 'boolean', allowed: 'TRUE | FALSE', note: 'Defaults to FALSE.', sample: 'FALSE', kind: 'boolean' },
      { header: 'isAdvance', required: false, format: 'boolean', allowed: 'TRUE | FALSE', note: 'Defaults to FALSE.', sample: 'FALSE', kind: 'boolean' },
      { header: 'instrumentRef', required: false, format: 'text (max 200)', allowed: '—', note: 'Cheque number / bank UTR. Required when mode is cheque/NEFT/RTGS/UPI.', sample: '', kind: 'text', maxLen: 200 },
      { header: 'instrumentDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '', kind: 'date' },
      { header: 'businessDate', required: false, format: 'date', allowed: '—', note: 'Defaults to the IST business date of the import.', sample: '2026-09-15', kind: 'date' },
      { header: 'collectedAt', required: false, format: 'ISO-8601 instant', allowed: 'YYYY-MM-DDThh:mm:ss[Z|±hh:mm]', note: 'Capture instant. Defaults to the submission time when blank.', sample: '2026-09-15T10:30:00', kind: 'datetime' },
      { header: 'receiptKind', required: false, format: 'text', allowed: ENUM_RECEIPT_KIND, note: 'Defaults to daily.', sample: 'daily', kind: 'enum', values: ARR_RECEIPT_KIND },
      { header: 'acknowledged', required: true, format: 'boolean', allowed: 'TRUE only', note: 'Customer acknowledgement is mandatory — must be TRUE (receipt is the acknowledgement, spec §14.1).', sample: 'TRUE', kind: 'boolean' },
      { header: 'remark', required: false, format: 'text (max 1000)', allowed: '—', note: 'Optional note stored with the entry.', sample: '', kind: 'text', maxLen: 1000 },
    ],
  },
  {
    name: '13. Agents',
    cols: [
      { header: 'staffCode', required: true, format: 'text', allowed: '—', note: 'Staff login code the agent is linked to. Resolved to staffId (UUID).', sample: 'STF-0007', kind: 'ref' },
      { header: 'agentCode', required: true, format: 'text (max 50)', allowed: '—', note: 'Office-chosen agent code (not number-sequence allocated).', sample: 'AG-YTM-001', kind: 'text', maxLen: 50 },
      { header: 'branchCode', required: false, format: 'text', allowed: '—', note: NOTE_BRANCH, sample: 'YTL-MAIN', kind: 'ref' },
      { header: 'phone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '9876522222', kind: 'text', maxLen: 20 },
      { header: 'email', required: false, format: 'valid email (max 120)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 120 },
      { header: 'idProofType', required: true, format: 'text (max 50)', allowed: '—', note: 'ID proof is mandatory for onboarding (spec §15.1).', sample: 'aadhaar', kind: 'text', maxLen: 50 },
      { header: 'idProofReference', required: true, format: 'text (max 200)', allowed: '—', note: '', sample: 'AADHAAR-XXXX-1234', kind: 'text', maxLen: 200 },
      { header: 'addressProofType', required: true, format: 'text (max 50)', allowed: '—', note: 'Address proof is mandatory for onboarding (spec §15.1).', sample: 'electricity_bill', kind: 'text', maxLen: 50 },
      { header: 'addressProofReference', required: true, format: 'text (max 200)', allowed: '—', note: '', sample: 'EB-2026-8891', kind: 'text', maxLen: 200 },
      { header: 'emergencyContactName', required: false, format: 'text (max 100)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 100 },
      { header: 'emergencyContactPhone', required: false, format: 'text (max 20)', allowed: '—', note: '', sample: '', kind: 'text', maxLen: 20 },
      { header: 'trainingStatus', required: false, format: 'text (max 50)', allowed: '—', note: '', sample: 'trained', kind: 'text', maxLen: 50 },
      { header: 'startDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '2026-09-01', kind: 'date' },
      { header: 'endDate', required: false, format: 'date', allowed: '—', note: NOTE_DATE, sample: '', kind: 'date' },
      { header: 'dailyCashLimit', required: false, format: 'money', allowed: '—', note: NOTE_MONEY, sample: '50000.00', kind: 'money' },
    ],
  },
];

// ---------------------------------------------------------------------------
// READ ME content
// ---------------------------------------------------------------------------

export const README_ROWS: string[][] = [
  ['CFDCMS — PRODUCTION EXCEL IMPORT TEMPLATES (MASTER)'],
  [''],
  ['WHAT THIS FILE IS'],
  ['Fill each sheet and return it. Every column header below is EXACTLY the field the software'],
  ['expects (backend API / database). Do not rename, reorder or delete header rows.'],
  ['Add your data starting from ROW 3 (row 2 is a sample row you should overwrite or delete).'],
  [''],
  ['HOW TO FILL'],
  ['1. Start with sheet "1. Customers" — one row per member. Give each a unique customerRef (e.g. CUST-0001).'],
  ["2. Add every member's address on sheet \"2. Addresses\" (at least one address per member is mandatory)."],
  ['3. Add nominees ("3. Nominees"), KYC documents ("4. Customer KYC Documents") and consents ("5. Customer Consents").'],
  ['4. Link all account sheets (Savings / RD / FD / Loans / Guarantors / Collateral) to the member using customerRef.'],
  ['5. Record the agent doorstep collections on sheet "12. Agent Collections".'],
  ['6. Onboard the agents on sheet "13. Agents" (id/address proof are mandatory).'],
  [''],
  ['FORMAT RULES (STRICT)'],
  ['- Dates:            YYYY-MM-DD  (e.g. 2026-09-15)'],
  ['- Money amounts:    number or text, up to 2 decimals, greater than 0  (e.g. 5000.00)'],
  ['- Interest rates:   up to 4 decimals, greater than 0 and at most 25   (e.g. 12.0000)'],
  ['- Booleans:         TRUE or FALSE'],
  ['- Enumerations:     use ONLY the exact values listed on the sheet "Reference Data". Case-sensitive.'],
  ['- Timestamps:       ISO-8601 instant, e.g. 2026-09-15T10:30:00'],
  ['- Pincodes:         keep as TEXT so leading zeros are preserved.'],
  [''],
  ['REFERENCE CODES (not UUIDs)'],
  ['The software stores branch, deposit product, RD scheme, FD rate card, loan product, agent and staff'],
  ['as internal IDs (UUIDs). You cannot know these. So templates use human-readable CODES'],
  ['(branchCode, productCode, schemeCode, agentCode, staffCode). The importer resolves them to UUIDs.'],
  ['The codes must exactly match the lists on the "Reference Data" sheet / the codes the office supplies.'],
  [''],
  ['JOIN KEY'],
  ['customerRef is a temporary key that links rows across sheets. It is NOT stored on the customer.'],
  ['It must be unique per member. Account sheets reference it to attach RD/FD/Loan/Savings to the member.'],
  [''],
  ['AGENT COLLECTIONS — SPECIAL NOTES'],
  ['- acknowledged MUST be TRUE (the printed receipt is the customer acknowledgement).'],
  ['- productType decides which account accountRef points at:'],
  ['    savingsDeposit  -> a savings account number (S.A.L.A....)'],
  ['    recurringDeposit-> an RD account number (R.D.A....)'],
  ['    loan            -> a loan number (L.A....)'],
  ['    penalty         -> the underlying product account; exactly one account number applies.'],
  ['- The importer generates the 32-hex idempotency key automatically (HTTP header) — do not add a column for it.'],
  [''],
  ['WHAT IS NOT OFFERED'],
  ['- Home loans are NOT offered. A loan purpose containing "home loan" will be rejected.'],
  [''],
  ['SHEET INDEX'],
  ['1. Customers, 2. Addresses, 3. Nominees, 4. Customer KYC Documents, 5. Customer Consents,'],
  ['6. Savings Accounts, 7. RD Accounts, 8. FD Accounts, 9. Loan Applications, 10. Loan Guarantors,'],
  ['11. Loan Collateral, 12. Agent Collections, 13. Agents.'],
  ['See "Instructions" for per-column required/format/allowed values and "Reference Data" for all codes.'],
];

// ---------------------------------------------------------------------------
// Reference data (verbatim from src/database/seed.ts + Zod enums)
// ---------------------------------------------------------------------------

export type RefRow = [string, string, string, string];

export const REFERENCE_ROWS: RefRow[] = [
  ['Category', 'Code / Value', 'Name / Meaning', 'Details'],
  ['Deposit products (sheet 6)', 'SAV-STD', 'Sanchay Bachat Khata (Standard Savings)', 'min opening 100.00; min balance 100.00; max balance 500000.00; flat; quarterly; 4.0000%; variable'],
  ['Deposit products (sheet 6)', 'SAV-DLY', 'Daily Savings Khata (Doorstep)', 'min opening 100.00; min balance 100.00; no max; flat; yearly; 4.0000%; variable'],
  ['Deposit products (sheet 6)', 'DAILY-180', 'Daily 180-Day Account', 'min opening 50.00; min balance 50.00; no max; flat; yearly; 5.1500%; variable'],
  ['RD schemes (sheet 7)', 'RD-DLY', 'Daily RD', 'daily; min instalment 100.00; no max; 6–24 months; 6.0000%; interest yearly'],
  ['RD schemes (sheet 7)', 'RD-MTH', 'Monthly RD', 'monthly; min instalment 500.00; max 50000.00; 6–120 months; 6.5000%; interest yearly'],
  ['FD rate card (sheet 8)', '1000.00–25000.00 / 2 mo', 'FD band', 'rate 7.0000%; penalty 1.00%; min holding 6 months'],
  ['FD rate card (sheet 8)', '1000.00–25000.00 / 6 mo', 'FD band', 'rate 8.0000%; penalty 1.00%; min holding 6 months'],
  ['FD rate card (sheet 8)', '1000.00–25000.00 / 12 mo', 'FD band', 'rate 10.0000%; penalty 1.00%; min holding 6 months'],
  ['FD rate card (sheet 8)', '1000.00–25000.00 / 24 mo', 'FD band', 'rate 11.5000%; penalty 1.00%; min holding 6 months'],
  ['FD rate card (sheet 8)', '25000.01–50000.00 / 12 mo', 'FD band', 'rate 10.0000%; penalty 1.00%; min holding 6 months'],
  ['FD rate card (sheet 8)', '50000.01–100000.00 / 12 mo', 'FD band', 'rate 10.0000%; penalty 1.00%; min holding 6 months'],
  ['Loan products (sheet 9)', 'LN-PER', 'Personal Loan', 'personal; 5000–100000; 3–36 mo; 12.0000%; monthly; guarantors 2; no collateral; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-BUS', 'Business & Industry Loan', 'business; 10000–500000; 6–60 mo; 14.0000%; monthly; guarantors 2; collateral yes; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-FD', 'Loan Against FD (Lien)', 'personal; 1000–85000; 3–36 mo; 9.0000%; monthly; guarantors 0; no collateral; LTV 85%'],
  ['Loan products (sheet 9)', 'LN-SHG', 'Women SHG Loan', 'shg; 10000–500000; 12–60 mo; 10.5000%; weekly; guarantors 2; no collateral; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-VEH', 'Vehicle Loan', 'other; 25000–300000; 12–60 mo; 11.0000%; monthly; guarantors 2; collateral yes; LTV 80%'],
  ['Loan products (sheet 9)', 'LN-GLD', 'Gold Mortgage Loan', 'gold; 5000–200000; 3–24 mo; 10.0000%; monthly; guarantors 0; collateral yes; LTV 75%'],
  ['Loan products (sheet 9)', 'LN-MTG', 'Mortgage Loan', 'mortgage; 50000–1000000; 12–120 mo; 10.5000%; monthly; guarantors 1; collateral yes; LTV 70%'],
  ['Loan products (sheet 9)', 'LN-MIS', 'Monthly Income Scheme', 'other; 10000–500000; 12–60 mo; 9.5000%; monthly; guarantors 1; no collateral; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-DMP', 'Damdupat Scheme', 'other; 5000–500000; 72–72 mo; 12.5000%; monthly; guarantors 2; no collateral; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-DLY', 'Daily Loan', 'personal; 1000–50000; 3–12 mo; 15.0000%; daily; guarantors 1; no collateral; LTV 60%'],
  ['Loan products (sheet 9)', 'LN-WKLY', 'Weekly Loan', 'personal; 2000–75000; 3–24 mo; 14.0000%; weekly; guarantors 1; no collateral; LTV 60%'],
  ['Enum — customerType', ENUM_CUSTOMER_TYPE, '', 'Case-sensitive.'],
  ['Enum — customer status', ENUM_CUSTOMER_STATUS, '', 'Case-sensitive.'],
  ['Enum — membershipCategory', ENUM_MEMBERSHIP, '', 'Case-sensitive.'],
  ['Enum — addressType', ENUM_ADDRESS_TYPE, '', 'Case-sensitive.'],
  ['Enum — identityDocumentType', ENUM_IDS_DOC, '', 'Case-sensitive.'],
  ['Enum — consent channel', ENUM_CONSENT_CHANNEL, '', 'Case-sensitive.'],
  ['Enum — paymentMethod', ENUM_PAYMENT_METHOD, '', 'Case-sensitive.'],
  ['Enum — RD / loan frequency', ENUM_RD_FREQUENCY, '', 'Case-sensitive.'],
  ['Enum — FD payoutFrequency', ENUM_FD_PAYOUT_FREQ, '', 'Case-sensitive.'],
  ['Enum — FD payoutMode', ENUM_FD_PAYOUT_MODE, '', 'Case-sensitive.'],
  ['Enum — FD maturityAction', ENUM_FD_MATURITY_ACTION, '', 'Case-sensitive.'],
  ['Enum — collection productType', ENUM_COLLECTION_PRODUCT, '', 'Case-sensitive.'],
  ['Enum — collection mode', ENUM_COLLECTION_MODE, '', 'Case-sensitive.'],
  ['Enum — visit outcome', ENUM_VISIT_OUTCOME, '', 'Case-sensitive.'],
  ['Enum — receiptKind', ENUM_RECEIPT_KIND, '', 'Case-sensitive.'],
  ['Number formats (auto)', 'savings_account = S.A.L.A####', 'rd_account = R.D.A####', 'fd_account = D.A####; loan = L.A.####; loan_application = APP####; customer ####; withdrawal = WDL#####; receipt_daily = RCPT-D#####; receipt_monthly = RCPT-M#####'],
];

// ---------------------------------------------------------------------------
// Shared regex constants (mirror the Zod schemas exactly)
// ---------------------------------------------------------------------------

export const RE_MONEY = /^\d{1,12}(\.\d{1,2})?$/;
export const RE_RATE = /^\d{1,3}(\.\d{1,4})?$/;
export const RE_DATE = /^\d{4}-\d{2}-\d{2}$/;
export const RE_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})?$/;
export const RE_INT = /^-?\d+$/;
export const RE_EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Sheets grouped into the focused workbooks. */
export const CUSTOMER_SHEETS = ['1. Customers', '2. Addresses', '3. Nominees', '4. Customer KYC Documents', '5. Customer Consents'];
export const ACCOUNT_SHEETS = [
  '6. Savings Accounts',
  '7. RD Accounts',
  '8. FD Accounts',
  '9. Loan Applications',
  '10. Loan Guarantors',
  '11. Loan Collateral',
];
export const COLLECTION_SHEETS = ['12. Agent Collections', '13. Agents'];
