import 'dotenv/config';
import { hash } from '@node-rs/argon2';
import { pool, transaction } from './client.js';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import {
  ALL_PERMISSIONS,
  ROLE_PERMISSIONS,
  ROLE_LABELS,
  STAFF_ROLES,
  SUPER_ADMIN_ROLE,
  type Permission,
  type StaffRole,
} from '../core/permissions.js';
import { istBusinessDate } from '../core/time.js';
import { AUDIT_ACTIONS, appendAuditEvent } from '../audit/audit-writer.js';

/**
 * Seed script (spec §3, §4, §5, §9–§12, §22).
 *
 * Everything runs in ONE transaction: either the reference data + bootstrap
 * admin land atomically, or nothing does. All inserts are idempotent
 * (ON CONFLICT DO NOTHING / DO UPDATE), so re-running the seed never fails
 * and never double-allocates sequences.
 *
 * Bootstrap admin credentials come from env (BOOTSTRAP_ADMIN_STAFF_CODE /
 * BOOTSTRAP_ADMIN_PASSWORD) — never hard-coded.
 */

type IdRow = { id: string };

const ORG = {
  legalName: 'Savitribai Fule Mahila Nagari Sahakari Patsanstha Maryadit Yavatmal',
  displayName: 'Savitribai Fule Mahila Nagari Patsanstha',
  registrationNumber: 'Yavatmal / RSR/CR/2026/0659',
  legalAddress: 'Rajgruha Apartment, Devangana Society, Waghapur Lohara Bypass, Yavatmal - 445001',
  phone: '7776961661',
  email: 'savitribaifulepatsanstha@gmail.com',
} as const;

/**
 * The immutable root account. Its staff code is fixed; the password comes from
 * the bootstrap-admin secret and is NEVER reset by re-seeding (so a rotation
 * survives). The account is flagged `is_protected` and can never be edited,
 * demoted or deactivated through any API or UI path.
 */
const SUPER_ADMIN = { staffCode: 'ROOT-001', fullName: 'Super Administrator' } as const;

const BRANCH = {
  code: 'YTM-MAIN',
  name: 'Main Branch, Yavatmal',
  address: 'Rajgruha Apartment, Devangana Society, Waghapur Lohara Bypass, Yavatmal - 445001',
  phone: '8483805830',
} as const;

/** Permission descriptions for the permission table (spec §5). */
const PERMISSION_DESCRIPTIONS: Record<Permission, string> = {
  'customers.read': 'View customer master data, accounts, and KYC',
  'customers.write': 'Create and update customers, accounts, KYC, nominees',
  'customers.export': 'Export customer data to files',
  'deposits.read': 'View savings, RD, and FD accounts and transactions',
  'deposits.write': 'Open accounts, post deposits, process withdrawals',
  'loans.read': 'View loan applications, loans, schedules, and repayments',
  'loans.write': 'Create loan applications, record repayments',
  'loans.approve': 'Recommend and approve loans within limits',
  'withdrawals.read': 'View withdrawal requests and history',
  'withdrawals.create': 'Create withdrawal requests',
  'withdrawals.approve': 'Approve regular withdrawal requests (up to ₹2,00,000)',
  'withdrawals.approve_high_value': 'Approve high-value withdrawals above ₹2,00,000 (President only)',
  'collections.read': 'View collections and agent submissions',
  'collections.write': 'Submit and review collections',
  'reconciliation.read': 'View day close and handover status',
  'reconciliation.write': 'Close days, count handovers, record settlements',
  'reports.read': 'View reports',
  'reports.export': 'Export and download reports (PDF)',
  'agents.read': 'View agents, routes, and assignments',
  'agents.write': 'Onboard agents, manage routes and assignments',
  'security.read': 'View security dashboard, devices, login events',
  'security.unlock_accounts': 'Unlock locked staff accounts (M.D. only)',
  'security.audit.read': 'Query the append-only audit trail (M.D. only)',
  'settings.read': 'View organisation and operational settings',
  'settings.write': 'Change organisation and operational settings',
};

/** Number sequence rows (spec §4) — organisation-wide, never reset, no reuse. */
const NUMBER_SEQUENCES: Array<{
  entityType: string;
  prefix: string;
  padding: number;
  resetPeriod: 'never' | 'daily' | 'monthly' | 'yearly';
}> = [
  { entityType: 'savings_account', prefix: 'S.A.L.A', padding: 4, resetPeriod: 'never' },
  { entityType: 'rd_account', prefix: 'R.D.A', padding: 4, resetPeriod: 'never' },
  { entityType: 'fd_account', prefix: 'D.A', padding: 4, resetPeriod: 'never' },
  { entityType: 'loan', prefix: 'L.A.', padding: 4, resetPeriod: 'never' },
  { entityType: 'loan_application', prefix: 'APP', padding: 4, resetPeriod: 'never' },
  { entityType: 'customer', prefix: '', padding: 4, resetPeriod: 'never' },
  { entityType: 'withdrawal', prefix: 'WDL', padding: 5, resetPeriod: 'never' },
  { entityType: 'receipt_daily', prefix: 'RCPT-D', padding: 5, resetPeriod: 'daily' },
  { entityType: 'receipt_monthly', prefix: 'RCPT-M', padding: 5, resetPeriod: 'monthly' },
  { entityType: 'dispute', prefix: 'DSP', padding: 5, resetPeriod: 'never' },
  { entityType: 'claim', prefix: 'CLM', padding: 5, resetPeriod: 'never' },
];

/** Deposit products (spec §9). */
const DEPOSIT_PRODUCTS = [
  {
    code: 'SAV-STD',
    name: 'Sanchay Bachat Khata (Standard Savings)',
    description: 'Everyday savings account with quarterly interest payout',
    minOpeningAmount: '100.00',
    minBalance: '100.00',
    maxBalance: '500000.00' as string | null,
    interestMethod: 'flat' as const,
    interestFrequency: 'quarterly' as const,
    interestRate: '4.0000',
    ratePolicy: 'variable' as const,
  },
  {
    code: 'SAV-DLY',
    name: 'Daily Savings Khata (Doorstep)',
    description: 'Doorstep daily-collection savings for daily-income customers',
    minOpeningAmount: '100.00',
    minBalance: '100.00',
    maxBalance: null as string | null,
    interestMethod: 'flat' as const,
    interestFrequency: 'yearly' as const,
    interestRate: '4.0000',
    ratePolicy: 'variable' as const,
  },
  {
    code: 'DAILY-180',
    name: 'Daily 180-Day Account (दैनिक 180 दिवस ठेव)',
    description: 'Daily doorstep collection for 180 days; maturity value per the published 180-day return table',
    minOpeningAmount: '50.00',
    minBalance: '50.00',
    maxBalance: null as string | null,
    interestMethod: 'flat' as const,
    interestFrequency: 'yearly' as const,
    interestRate: '5.1500',
    ratePolicy: 'variable' as const,
  },
];

/** RD schemes (spec §10). */
const RD_SCHEMES = [
  {
    code: 'RD-DLY',
    name: 'Daily RD (12 months)',
    frequency: 'daily' as const,
    minInstalment: '100.00',
    maxInstalment: null as string | null,
    minDurationMonths: 6,
    maxDurationMonths: 24,
    interestRate: '6.0000',
    interestCreditFrequency: 'yearly' as const,
  },
  {
    code: 'RD-MTH',
    name: 'Monthly RD (12–120 months)',
    frequency: 'monthly' as const,
    minInstalment: '500.00',
    maxInstalment: '50000.00' as string | null,
    minDurationMonths: 6,
    maxDurationMonths: 120,
    interestRate: '6.5000',
    interestCreditFrequency: 'yearly' as const,
  },
];

/**
 * FD rate card bands (spec §11): amounts ₹1,000–₹1,00,000.
 * Tenure tiers follow the bank's published card (client-approved image):
 *   30–45 days → 7%, 46–180 days → 8%, 181–365 days → 10%, 366+ days → 11.50%.
 * Because fd_rate_card.tenure_months is month-based only, the day-based tiers are
 * mapped to their month equivalents (1–2, 3–6, 7–12, 13–24) and the exact
 * day-based ladder is also stored in app_setting 'rates.fd_tenure_tiers'.
 */
const FD_RATE_CARD = [
  { minAmount: '1000.00', maxAmount: '25000.00', tenureMonths: 2, interestRate: '7.0000' },
  { minAmount: '1000.00', maxAmount: '25000.00', tenureMonths: 6, interestRate: '8.0000' },
  { minAmount: '1000.00', maxAmount: '25000.00', tenureMonths: 12, interestRate: '10.0000' },
  { minAmount: '1000.00', maxAmount: '25000.00', tenureMonths: 24, interestRate: '11.5000' },
  { minAmount: '25000.01', maxAmount: '50000.00', tenureMonths: 12, interestRate: '10.0000' },
  { minAmount: '50000.01', maxAmount: '100000.00', tenureMonths: 12, interestRate: '10.0000' },
];

/** Loan products (spec §12). */
const LOAN_PRODUCTS = [
  {
    code: 'LN-PER',
    name: 'Personal Loan',
    category: 'personal' as const,
    minAmount: '5000.00',
    maxAmount: '100000.00',
    minTenureMonths: 3,
    maxTenureMonths: 36,
    interestMethod: 'flat' as const,
    interestRate: '12.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 2,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['household', 'medical', 'education', 'family_event'] as string[],
  },
  {
    code: 'LN-BUS',
    name: 'व्यवसाय व उद्योग कर्ज (Business & Industry Loan)',
    category: 'business' as const,
    minAmount: '10000.00',
    maxAmount: '500000.00',
    minTenureMonths: 6,
    maxTenureMonths: 60,
    interestMethod: 'flat' as const,
    interestRate: '14.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 2,
    collateralRequired: true,
    maxLtvPercent: '60.00',
    allowedPurposes: ['shop_setup', 'inventory', 'working_capital', 'vehicle'] as string[],
  },
  {
    code: 'LN-FD',
    name: 'Loan Against FD (Lien)',
    category: 'personal' as const,
    minAmount: '1000.00',
    maxAmount: '85000.00',
    minTenureMonths: 3,
    maxTenureMonths: 36,
    interestMethod: 'flat' as const,
    interestRate: '9.0000',
    ratePolicy: 'fixed' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 0,
    collateralRequired: false,
    maxLtvPercent: '85.00',
    allowedPurposes: ['against_fd_lien'] as string[],
  },
  {
    code: 'LN-SHG',
    name: 'महिला स्वयंसहायता गट कर्ज (Women SHG Loan)',
    category: 'shg' as const,
    minAmount: '10000.00',
    maxAmount: '500000.00',
    minTenureMonths: 12,
    maxTenureMonths: 60,
    interestMethod: 'flat' as const,
    interestRate: '10.5000',
    ratePolicy: 'fixed' as const,
    repaymentFrequency: 'weekly' as const,
    guarantorLimit: 2,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['group_activity', 'income_generation'] as string[],
  },
  {
    code: 'LN-VEH',
    name: 'वाहन कर्ज (Vehicle Loan)',
    category: 'other' as const,
    minAmount: '25000.00',
    maxAmount: '300000.00',
    minTenureMonths: 12,
    maxTenureMonths: 60,
    interestMethod: 'flat' as const,
    interestRate: '11.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 2,
    collateralRequired: true,
    maxLtvPercent: '80.00',
    allowedPurposes: ['vehicle'] as string[],
  },
  {
    code: 'LN-GLD',
    name: 'सोने तारण कर्ज (Gold Mortgage Loan)',
    category: 'gold' as const,
    minAmount: '5000.00',
    maxAmount: '200000.00',
    minTenureMonths: 3,
    maxTenureMonths: 24,
    interestMethod: 'flat' as const,
    interestRate: '10.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 0,
    collateralRequired: true,
    maxLtvPercent: '75.00',
    allowedPurposes: ['gold_pledge'] as string[],
  },
  {
    code: 'LN-MTG',
    name: 'गहाण कर्ज (Mortgage Loan)',
    category: 'mortgage' as const,
    minAmount: '50000.00',
    maxAmount: '1000000.00',
    minTenureMonths: 12,
    maxTenureMonths: 120,
    interestMethod: 'flat' as const,
    interestRate: '10.5000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 1,
    collateralRequired: true,
    maxLtvPercent: '70.00',
    allowedPurposes: ['property_mortgage'] as string[],
  },
  {
    code: 'LN-MIS',
    name: 'मासिक उत्पन्न योजना (Monthly Income Scheme)',
    category: 'other' as const,
    minAmount: '10000.00',
    maxAmount: '500000.00',
    minTenureMonths: 12,
    maxTenureMonths: 60,
    interestMethod: 'flat' as const,
    interestRate: '9.5000',
    ratePolicy: 'fixed' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 1,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['monthly_income'] as string[],
  },
  {
    code: 'LN-DMP',
    name: 'दामदुप्पट योजना (Damdupat Scheme)',
    category: 'other' as const,
    minAmount: '5000.00',
    maxAmount: '500000.00',
    minTenureMonths: 72,
    maxTenureMonths: 72,
    interestMethod: 'flat' as const,
    interestRate: '12.5000',
    ratePolicy: 'fixed' as const,
    repaymentFrequency: 'monthly' as const,
    guarantorLimit: 2,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['damdupat'] as string[],
  },
  {
    code: 'LN-DLY',
    name: 'दैनिक कर्ज (Daily Loan)',
    category: 'personal' as const,
    minAmount: '1000.00',
    maxAmount: '50000.00',
    minTenureMonths: 3,
    maxTenureMonths: 12,
    interestMethod: 'flat' as const,
    interestRate: '15.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'daily' as const,
    guarantorLimit: 1,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['daily_income', 'household', 'petty_trade'] as string[],
  },
  {
    code: 'LN-WKLY',
    name: 'साप्ताहिक कर्ज (Weekly Loan)',
    category: 'personal' as const,
    minAmount: '2000.00',
    maxAmount: '75000.00',
    minTenureMonths: 3,
    maxTenureMonths: 24,
    interestMethod: 'flat' as const,
    interestRate: '14.0000',
    ratePolicy: 'variable' as const,
    repaymentFrequency: 'weekly' as const,
    guarantorLimit: 1,
    collateralRequired: false,
    maxLtvPercent: '60.00',
    allowedPurposes: ['weekly_income', 'household', 'petty_trade'] as string[],
  },
];

/**
 * Operational app settings (spec §22). These mirror env defaults but live in
 * the DB so the M.D. can change them at runtime; every change is captured in
 * setting_change_history (append-only).
 */
const APP_SETTINGS: Array<{ key: string; value: unknown; category: string; description: string }> = [
  { key: 'session.idle_minutes', value: 60, category: 'security', description: 'Idle timeout (30–60 min) for staff sessions' },
  { key: 'security.max_login_attempts', value: 5, category: 'security', description: 'Failed logins before account lockout' },
  { key: 'security.lockout_minutes', value: 15, category: 'security', description: 'Lockout duration after failed logins' },
  { key: 'withdrawals.high_value_limit', value: '200000.00', category: 'operational', description: 'Amount above which the President must approve' },
  { key: 'savings.min_balance', value: '100.00', category: 'operational', description: 'Minimum balance to keep after withdrawals' },
  { key: 'deadlines.cash_handover_hour', value: 16, category: 'operational', description: 'IST hour before which agents must hand over cash' },
  { key: 'deadlines.submission_hour', value: 17, category: 'operational', description: 'IST hour before which collections must be submitted' },
  { key: 'offline.limit_hours', value: 36, category: 'operational', description: 'How long agents may stay offline before entries flag late' },
  { key: 'numbering.allow_cancelled_reuse', value: false, category: 'operational', description: 'Cancelled numbers are never re-issued (audit-safe default)' },
  { key: 'notifications.enabled_channels', value: ['sms', 'whatsapp', 'email', 'printed_receipt', 'app_notification'], category: 'operational', description: 'Delivery channels for customer notifications' },
  { key: 'privacy.notice', value: { title: 'Privacy Notice', body: 'Your personal information is collected and processed solely for the purpose of providing savings, deposit, loan and related banking services. It is stored on our application server and access is limited to authorised staff, the President and the Managing Director. We do not share your data with third parties except as required by law or a regulatory authority. You may request a copy, correction, restriction or deletion of your data; balance, loan and repayment records are retained as required by law.' }, category: 'compliance', description: 'Bank-prescribed privacy notice shown to customers (spec §24.2)' },
  { key: 'privacy.consent', value: { title: 'Customer Consent', body: 'I hereby consent to the collection, storage and processing of my personal information and documents for opening and operating my account(s), availing loans, and receiving transaction notifications through the channels I select. I understand that transaction and balance messages are mandatory and cannot be disabled, and that my data will not be shared with third parties except as required by law or on my written request.' }, category: 'compliance', description: 'Bank-prescribed consent wording captured at registration (spec §24.2)' },
  {
    key: 'rates.fd_tenure_tiers',
    value: {
      currency: 'INR',
      basis: 'days',
      source: 'Published FD rate card (client scheme image)',
      tiers: [
        { label: '30–45 days', minDays: 30, maxDays: 45, ratePercent: 7.0 },
        { label: '46–180 days', minDays: 46, maxDays: 180, ratePercent: 8.0 },
        { label: '181–365 days', minDays: 181, maxDays: 365, ratePercent: 10.0 },
        { label: '366+ days', minDays: 366, maxDays: null, ratePercent: 11.5 },
      ],
      note: 'Authoritative day-based ladder for display. FD accounts are opened on tenure_months; the month-mapped fd_rate_card rows (2/6/12/24 → 7/8/10/11.5%) govern actual account interest.',
    },
    category: 'rates',
    description: 'Published FD interest ladder by tenure days (30–45 → 7%, 46–180 → 8%, 181–365 → 10%, 366+ → 11.5%)',
  },
  {
    key: 'schemes.daily_180_returns',
    value: {
      currency: 'INR',
      schemeCode: 'DAILY-180',
      days: 180,
      rateAnnualPercent: 5.15,
      note: 'Daily doorstep collection for 180 days. Maturity value = dailyAmount × 180 + flat interest (avg balance × 5.15% p.a. for 6 months).',
      rows: [
        { dailyAmount: '50.00', depositTotal: '9000.00', interestEarned: '115.00', maturityValue: '9115.00' },
        { dailyAmount: '100.00', depositTotal: '18000.00', interestEarned: '230.00', maturityValue: '18230.00' },
        { dailyAmount: '200.00', depositTotal: '36000.00', interestEarned: '460.00', maturityValue: '36460.00' },
        { dailyAmount: '300.00', depositTotal: '54000.00', interestEarned: '690.00', maturityValue: '54690.00' },
        { dailyAmount: '500.00', depositTotal: '90000.00', interestEarned: '1150.00', maturityValue: '91150.00' },
        { dailyAmount: '1000.00', depositTotal: '180000.00', interestEarned: '2300.00', maturityValue: '182300.00' },
      ],
    },
    category: 'schemes',
    description: 'Daily 180-day account maturity returns per the published scheme (₹50→9115 … ₹1000→182300)',
  },
  {
    key: 'schemes.rd_monthly_returns',
    value: {
      currency: 'INR',
      instalmentFrequency: 'monthly',
      tenureMonths: [12, 24, 36, 48, 60, 72, 84, 96, 108, 120],
      note: 'Published RD monthly-return table. Values scale linearly with the monthly instalment; anchor values (₹500 → 6400/13630/117000 at 12/24/120 months; ₹5000 → 1170000 at 120 months) match the client scheme image exactly.',
      rows: [
        { instalment: '500.00', returns: { '12': 6400, '24': 13630, '36': 21780, '48': 30990, '60': 41360, '72': 53060, '84': 66260, '96': 81140, '108': 97970, '120': 117000 } },
        { instalment: '1000.00', returns: { '12': 12800, '24': 27260, '36': 43560, '48': 61980, '60': 82720, '72': 106120, '84': 132520, '96': 162280, '108': 195940, '120': 234000 } },
        { instalment: '2000.00', returns: { '12': 25600, '24': 54520, '36': 87120, '48': 123960, '60': 165440, '72': 212240, '84': 265040, '96': 324560, '108': 391880, '120': 468000 } },
        { instalment: '3000.00', returns: { '12': 38400, '24': 81780, '36': 130680, '48': 185940, '60': 248160, '72': 318360, '84': 397560, '96': 486840, '108': 587820, '120': 702000 } },
        { instalment: '4000.00', returns: { '12': 51200, '24': 109040, '36': 174240, '48': 247920, '60': 330880, '72': 424480, '84': 530080, '96': 649120, '108': 783760, '120': 936000 } },
        { instalment: '5000.00', returns: { '12': 64000, '24': 136300, '36': 217800, '48': 309900, '60': 413600, '72': 530600, '84': 662600, '96': 811400, '108': 979700, '120': 1170000 } },
      ],
    },
    category: 'schemes',
    description: 'Published RD monthly-return table (₹500–₹5000/month, 12–120 months)',
  },
];

/** Notification templates (spec §18) — mandatory post-collection message on every channel. */
const NOTIFICATION_TEMPLATES: Array<{
  eventType: string;
  channel: string;
  templateBody: string;
  isMandatory: boolean;
}> = [
  { eventType: 'collection.recorded', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka ₹{{amount}} collection {{business_date}} ko received hua. Receipt {{receipt_number}}. - {{org_name}}', isMandatory: true },
  { eventType: 'collection.recorded', channel: 'whatsapp', templateBody: 'Namaste {{customer_name}}, aapka ₹{{amount}} collection {{business_date}} ko received hua. Receipt {{receipt_number}}. - {{org_name}}', isMandatory: true },
  { eventType: 'collection.recorded', channel: 'printed_receipt', templateBody: 'RECEIPT {{receipt_number}} | Date: {{business_date}} | Customer: {{customer_name}} | Amount: ₹{{amount}} | Mode: {{mode}} | {{org_name}} ({{registration_number}})', isMandatory: true },
  { eventType: 'withdrawal.paid', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka ₹{{amount}} withdrawal {{business_date}} ko paid hua (Ref {{payout_reference}}). - {{org_name}}', isMandatory: false },
  { eventType: 'withdrawal.paid', channel: 'whatsapp', templateBody: 'Namaste {{customer_name}}, aapka ₹{{amount}} withdrawal {{business_date}} ko paid hua (Ref {{payout_reference}}). - {{org_name}}', isMandatory: false },
  { eventType: 'loan.instalment_due', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka loan instalment ₹{{amount}} {{due_date}} ko due hai. Loan {{loan_number}}. - {{org_name}}', isMandatory: false },
  { eventType: 'rd.instalment_due', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka RD instalment ₹{{amount}} {{due_date}} ko due hai. Account {{account_number}}. - {{org_name}}', isMandatory: false },
  { eventType: 'fd.matured', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka FD {{account_number}} {{maturity_date}} ko mature hua. Kripya branch sampark karein. - {{org_name}}', isMandatory: false },
  { eventType: 'account.opened', channel: 'sms', templateBody: 'Namaste {{customer_name}}, aapka {{product_name}} {{account_number}} {{business_date}} ko open hua. - {{org_name}}', isMandatory: false },
  { eventType: 'account.opened', channel: 'whatsapp', templateBody: 'Namaste {{customer_name}}, aapka {{product_name}} {{account_number}} {{business_date}} ko open hua. - {{org_name}}', isMandatory: false },
];

/** Report definitions (spec §17) — official layout on every report. */
const REPORT_DEFINITIONS: Array<{
  reportType: string;
  name: string;
  description: string;
  requiredPermissions: string[];
  availableFilters: string[];
  dateBasis: string[];
}> = [
  { reportType: 'daily_collection_register', name: 'Daily Collection Register', description: 'Agent-wise and product-wise collections for a business date', requiredPermissions: ['collections.read'], availableFilters: ['agent_id', 'product_type', 'mode', 'business_date'], dateBasis: ['business_date'] },
  { reportType: 'savings_transaction_register', name: 'Savings Transaction Register', description: 'All savings deposits/withdrawals for a period', requiredPermissions: ['deposits.read'], availableFilters: ['branch_id', 'product_id', 'transaction_type', 'payment_method'], dateBasis: ['transaction_date'] },
  { reportType: 'customer_statement', name: 'Customer Statement', description: 'Opening balance, deposits, interest, withdrawals, loan instalments, penalties, fees, corrections, closing balance', requiredPermissions: ['customers.read', 'deposits.read'], availableFilters: ['customer_id', 'account_id'], dateBasis: ['transaction_date'] },
  { reportType: 'loan_outstanding_report', name: 'Loan Outstanding Report', description: 'Active loans with outstanding principal and interest', requiredPermissions: ['loans.read'], availableFilters: ['product_id', 'status', 'branch_id'], dateBasis: ['as_on_date'] },
  { reportType: 'overdue_loan_report', name: 'Overdue Loan Report', description: 'Loans with overdue instalments and ageing', requiredPermissions: ['loans.read'], availableFilters: ['product_id', 'ageing_bucket'], dateBasis: ['due_date'] },
  { reportType: 'day_close_summary', name: 'Day Close Summary', description: 'Per-agent day close, handover, and settlement summary', requiredPermissions: ['reconciliation.read'], availableFilters: ['agent_id', 'business_date'], dateBasis: ['business_date'] },
  { reportType: 'agent_performance_report', name: 'Agent Performance Report', description: 'Collections, visits, and productivity per agent', requiredPermissions: ['agents.read', 'collections.read'], availableFilters: ['agent_id', 'period'], dateBasis: ['business_date'] },
  { reportType: 'interest_posting_register', name: 'Interest Posting Register', description: 'Interest posted on savings/RD/FD for a period', requiredPermissions: ['deposits.read'], availableFilters: ['product_id', 'account_id'], dateBasis: ['posting_date'] },
  { reportType: 'dispute_register', name: 'Dispute Register', description: 'Disputes raised, status, and resolutions', requiredPermissions: ['security.audit.read'], availableFilters: ['status', 'customer_id'], dateBasis: ['raised_on'] },
  { reportType: 'audit_event_report', name: 'Audit Event Report', description: 'Query the append-only audit trail (M.D. only)', requiredPermissions: ['security.audit.read'], availableFilters: ['action', 'actor_staff_id', 'entity_type'], dateBasis: ['occurred_at'] },
  { reportType: 'yearly_authority_report', name: 'Yearly Authority Report', description: 'Yearly activity summary for the regulatory authority — registrations, savings accounts, deposits, withdrawals, interest, RD/FD openings, loan disbursements/collections, total collections, disputes', requiredPermissions: ['security.audit.read'], availableFilters: [], dateBasis: ['transaction_date', 'disbursed_on', 'registration_date'] },
  { reportType: 'weekly_loan_collection_register', name: 'Weekly Loan Collection Register', description: 'Weekly-basis loans (LN-WKLY) with the instalment schedule due in the period — customer, loan number, instalment, due date, expected and collected amounts, status. The official weekly collection format for weekly-distributed loans', requiredPermissions: ['loans.read'], availableFilters: ['product_id', 'branch_id', 'status'], dateBasis: ['due_date'] },
];

/** Demo staff (gated on env.seed.demoData). Password = 'Password#123'. */
const DEMO_STAFF: Array<{ staffCode: string; fullName: string; role: StaffRole; email: string; phone: string }> = [
  { staffCode: 'PRES-001', fullName: 'Sunita Deshmukh', role: 'president', email: 'president@example.com', phone: '+91-98765-00001' },
  { staffCode: 'VPR-001', fullName: 'Rekha Kadam', role: 'vice_president', email: 'vp@example.com', phone: '+91-98765-00002' },
  { staffCode: 'MGR-001', fullName: 'Pravin Joshi', role: 'manager', email: 'manager@example.com', phone: '+91-98765-00003' },
  { staffCode: 'CSH-001', fullName: 'Asha Pawar', role: 'cashier', email: 'cashier@example.com', phone: '+91-98765-00004' },
  { staffCode: 'CLK-001', fullName: 'Nilesh Chavan', role: 'clerk', email: 'clerk@example.com', phone: '+91-98765-00005' },
  { staffCode: 'AGT-001', fullName: 'Rahul Patil', role: 'collection_agent', email: 'agent1@example.com', phone: '+91-98765-00006' },
  { staffCode: 'AGT-002', fullName: 'Kavita More', role: 'collection_agent', email: 'agent2@example.com', phone: '+91-98765-00007' },
];

/** Agent profiles for the two demo collection agents. */
const DEMO_AGENTS: Array<{ staffCode: string; agentCode: string; dailyCashLimit: string }> = [
  { staffCode: 'AGT-001', agentCode: 'AG-YTM-001', dailyCashLimit: '50000.00' },
  { staffCode: 'AGT-002', agentCode: 'AG-YTM-002', dailyCashLimit: '50000.00' },
];

/** Agent route for demo. */
const DEMO_ROUTE = { routeCode: 'RT-WAGHAPUR', name: 'Waghapur daily route', area: 'Waghapur, Yavatmal' } as const;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Upsert the single organisation row (idempotent).
 */
async function upsertOrganisation(client: import('pg').PoolClient): Promise<string> {
  // The organisation table's only unique column is the auto-generated UUID pk,
  // so ON CONFLICT (id) could never match a fresh INSERT and re-runs would
  // duplicate the row. Treat it as a singleton: update the one existing row,
  // or insert when the table is empty.
  const existing = await client.query<IdRow>(
    `SELECT id FROM organisation ORDER BY created_at ASC LIMIT 1`,
  );
  const params = [
    ORG.legalName,
    ORG.displayName,
    ORG.registrationNumber,
    ORG.legalAddress,
    ORG.phone,
    ORG.email,
  ];
  const existingId = existing.rows[0]?.id;
  if (existingId) {
    await client.query(
      `UPDATE organisation
          SET legal_name = $1,
              display_name = $2,
              registration_number = $3,
              legal_address = $4,
              phone = $5,
              email = $6,
              updated_at = now()
        WHERE id = $7`,
      [...params, existingId],
    );
    return existingId;
  }
  const { rows } = await client.query<IdRow>(
    `INSERT INTO organisation
       (legal_name, display_name, registration_number, legal_address, phone, email,
        timezone, currency, locale, financial_year_start_month, working_days, operating_hours)
     VALUES ($1, $2, $3, $4, $5, $6, 'Asia/Kolkata', 'INR', 'en-IN', 4,
             ARRAY['Mon','Tue','Wed','Thu','Fri','Sat'], '10:30-17:30')
     RETURNING id`,
    params,
  );
  const insertedId = rows[0]?.id;
  if (!insertedId) throw new Error('failed to seed organisation');
  return insertedId;
}

/** Fixed single-branch setup (org has exactly one branch for now). */
async function upsertBranch(client: import('pg').PoolClient, organisationId: string): Promise<string> {
  const { rows } = await client.query<IdRow>(
    `INSERT INTO branch (organisation_id, code, name, address, phone, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     ON CONFLICT (code) DO UPDATE
       SET name = EXCLUDED.name,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone,
           organisation_id = EXCLUDED.organisation_id,
           updated_at = now()
     RETURNING id`,
    [organisationId, BRANCH.code, BRANCH.name, BRANCH.address, BRANCH.phone],
  );
  return rows[0]?.id ?? '';
}

async function seedRolesAndPermissions(client: import('pg').PoolClient): Promise<Map<StaffRole, string>> {
  // Permissions
  for (const code of ALL_PERMISSIONS) {
    await client.query(
      `INSERT INTO permission (code, description) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`,
      [code, PERMISSION_DESCRIPTIONS[code]],
    );
  }
  const permissionIds = new Map<Permission, string>();
  const permRows = await client.query<IdRow & { code: string }>(`SELECT id, code FROM permission`);
  for (const row of permRows.rows) {
    permissionIds.set(row.code as Permission, row.id);
  }

  // Roles
  const roleIds = new Map<StaffRole, string>();
  for (const code of STAFF_ROLES) {
    const { rows } = await client.query<IdRow>(
      `INSERT INTO role (code, label, is_system)
       VALUES ($1, $2, true)
       ON CONFLICT (code) DO UPDATE SET label = EXCLUDED.label, updated_at = now()
       RETURNING id`,
      [code, ROLE_LABELS[code]],
    );
    const roleId = rows[0]?.id;
    if (roleId) roleIds.set(code, roleId);
  }

  // Role ↔ permission links — replace the DB matrix with the code matrix.
  for (const role of STAFF_ROLES) {
    const roleId = roleIds.get(role);
    if (!roleId) continue;
    const perms = ROLE_PERMISSIONS[role];
    await client.query(`DELETE FROM role_permission WHERE role_id = $1`, [roleId]);
    for (const perm of perms) {
      const permId = permissionIds.get(perm);
      if (!permId) continue;
      await client.query(
        `INSERT INTO role_permission (role_id, permission_id) VALUES ($1, $2)
         ON CONFLICT DO NOTHING`,
        [roleId, permId],
      );
    }
  }
  return roleIds;
}

async function seedBootstrapAdmin(
  client: import('pg').PoolClient,
  roleIds: Map<StaffRole, string>,
  branchId: string,
): Promise<string> {
  const passwordHash = await hash(env.seed.bootstrapAdminPassword, {
    // OWASP-recommended Argon2id parameters.
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const { rows } = await client.query<IdRow>(
    `INSERT INTO staff (staff_code, full_name, role_id, branch_id, password_hash, status, nda_signed)
     VALUES ($1, $2, $3, $4, $5, 'active', true)
     ON CONFLICT (staff_code) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           status = 'active',
           role_id = EXCLUDED.role_id,
           branch_id = EXCLUDED.branch_id,
           updated_at = now()
     RETURNING id`,
    [
      env.seed.bootstrapAdminStaffCode,
      'Managing Director',
      roleIds.get('managing_director') ?? null,
      branchId,
      passwordHash,
    ],
  );
  const adminId = rows[0]?.id;
  if (!adminId) throw new Error('failed to seed bootstrap admin');
  await appendAuditEvent(client, {
    actorStaffId: adminId,
    actorRole: 'managing_director',
    actorStaffCode: env.seed.bootstrapAdminStaffCode,
    action: AUDIT_ACTIONS.STAFF_CREATED,
    entityType: 'staff',
    entityId: adminId,
    source: 'system',
    businessDate: istBusinessDate(),
    metadata: { bootstrap: true, role: 'managing_director' },
  });
  return adminId;
}

/**
 * Seed the immutable root super-administrator (spec §7.1 security baseline).
 * The password is only set on first insert — re-seeding preserves any rotation
 * and never clears the `is_protected` flag.
 */
async function seedSuperAdmin(
  client: import('pg').PoolClient,
  roleIds: Map<StaffRole, string>,
  branchId: string,
): Promise<string> {
  const passwordHash = await hash(env.seed.bootstrapAdminPassword, {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
  const superAdminRoleId = roleIds.get(SUPER_ADMIN_ROLE);
  if (!superAdminRoleId) throw new Error('failed to resolve super_admin role');
  const { rows } = await client.query<IdRow>(
    `INSERT INTO staff
       (staff_code, full_name, role_id, branch_id, password_hash, status, nda_signed, is_protected)
     VALUES ($1, $2, $3, $4, $5, 'active', true, true)
     ON CONFLICT (staff_code) DO UPDATE
       SET role_id = EXCLUDED.role_id,
           branch_id = EXCLUDED.branch_id,
           is_protected = true,
           status = 'active',
           updated_at = now()
     RETURNING id`,
    [SUPER_ADMIN.staffCode, SUPER_ADMIN.fullName, superAdminRoleId, branchId, passwordHash],
  );
  const superAdminId = rows[0]?.id;
  if (!superAdminId) throw new Error('failed to seed super admin');
  await appendAuditEvent(client, {
    actorStaffId: superAdminId,
    actorRole: SUPER_ADMIN_ROLE,
    actorStaffCode: SUPER_ADMIN.staffCode,
    action: AUDIT_ACTIONS.STAFF_CREATED,
    entityType: 'staff',
    entityId: superAdminId,
    source: 'system',
    businessDate: istBusinessDate(),
    metadata: { bootstrap: true, role: SUPER_ADMIN_ROLE, protected: true },
  });
  return superAdminId;
}

async function seedNumberSequences(client: import('pg').PoolClient): Promise<void> {
  for (const seq of NUMBER_SEQUENCES) {
    await client.query(
      `INSERT INTO number_sequence (entity_type, prefix, next_value, padding, reset_period, allow_cancelled_reuse)
       VALUES ($1, $2, 1, $3, $4, false)
       ON CONFLICT (entity_type) DO UPDATE
         SET prefix = EXCLUDED.prefix,
             padding = EXCLUDED.padding,
             reset_period = EXCLUDED.reset_period,
             updated_at = now()`,
      [seq.entityType, seq.prefix, seq.padding, seq.resetPeriod],
    );
  }
}

async function seedDepositProducts(client: import('pg').PoolClient): Promise<void> {
  for (const p of DEPOSIT_PRODUCTS) {
    await client.query(
      `INSERT INTO deposit_product
         (code, name, description, min_opening_amount, min_balance, max_balance,
          interest_method, interest_frequency, interest_rate, rate_policy, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             min_opening_amount = EXCLUDED.min_opening_amount,
             min_balance = EXCLUDED.min_balance,
             max_balance = EXCLUDED.max_balance,
             interest_method = EXCLUDED.interest_method,
             interest_frequency = EXCLUDED.interest_frequency,
             interest_rate = EXCLUDED.interest_rate,
             rate_policy = EXCLUDED.rate_policy,
             is_active = true,
             updated_at = now()`,
      [
        p.code, p.name, p.description, p.minOpeningAmount, p.minBalance, p.maxBalance,
        p.interestMethod, p.interestFrequency, p.interestRate, p.ratePolicy,
      ],
    );
  }
}

async function seedRdSchemes(client: import('pg').PoolClient): Promise<void> {
  for (const s of RD_SCHEMES) {
    await client.query(
      `INSERT INTO rd_scheme
         (code, name, frequency, min_instalment_amount, max_instalment_amount,
          min_duration_months, max_duration_months, grace_period_months,
          interest_rate, interest_credit_frequency, early_closure_fee_percent, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 1, $8, $9, 4.00, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             frequency = EXCLUDED.frequency,
             min_instalment_amount = EXCLUDED.min_instalment_amount,
             max_instalment_amount = EXCLUDED.max_instalment_amount,
             min_duration_months = EXCLUDED.min_duration_months,
             max_duration_months = EXCLUDED.max_duration_months,
             interest_rate = EXCLUDED.interest_rate,
             interest_credit_frequency = EXCLUDED.interest_credit_frequency,
             is_active = true,
             updated_at = now()`,
      [
        s.code, s.name, s.frequency, s.minInstalment, s.maxInstalment,
        s.minDurationMonths, s.maxDurationMonths, s.interestRate, s.interestCreditFrequency,
      ],
    );
  }
}

async function seedFdRateCard(client: import('pg').PoolClient): Promise<void> {
  // No natural unique key: only seed when the table is empty for this effective date.
  const { rowCount } = await client.query(`SELECT 1 FROM fd_rate_card LIMIT 1`);
  if ((rowCount ?? 0) > 0) return;
  for (const band of FD_RATE_CARD) {
    await client.query(
      `INSERT INTO fd_rate_card
         (min_amount, max_amount, tenure_months, interest_rate,
          early_closure_penalty_percent, min_holding_months, is_active)
       VALUES ($1, $2, $3, $4, 1.00, 6, true)`,
      [band.minAmount, band.maxAmount, band.tenureMonths, band.interestRate],
    );
  }
}

async function seedLoanProducts(client: import('pg').PoolClient): Promise<void> {
  for (const p of LOAN_PRODUCTS) {
    await client.query(
      `INSERT INTO loan_product
         (code, name, category, min_amount, max_amount, min_tenure_months, max_tenure_months,
          interest_method, interest_rate, rate_policy, repayment_frequency, penalty_config,
          allocation_order, guarantor_limit, collateral_required, max_ltv_percent,
          allowed_purposes, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, '{}'::jsonb,
               ARRAY['interest','penalty','fees','principal'], $12, $13, $14, $15, true)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name,
             category = EXCLUDED.category,
             min_amount = EXCLUDED.min_amount,
             max_amount = EXCLUDED.max_amount,
             min_tenure_months = EXCLUDED.min_tenure_months,
             max_tenure_months = EXCLUDED.max_tenure_months,
             interest_method = EXCLUDED.interest_method,
             interest_rate = EXCLUDED.interest_rate,
             rate_policy = EXCLUDED.rate_policy,
             repayment_frequency = EXCLUDED.repayment_frequency,
             guarantor_limit = EXCLUDED.guarantor_limit,
             collateral_required = EXCLUDED.collateral_required,
             max_ltv_percent = EXCLUDED.max_ltv_percent,
             allowed_purposes = EXCLUDED.allowed_purposes,
             is_active = true,
             updated_at = now()`,
      [
        p.code, p.name, p.category, p.minAmount, p.maxAmount,
        p.minTenureMonths, p.maxTenureMonths, p.interestMethod, p.interestRate,
        p.ratePolicy, p.repaymentFrequency, p.guarantorLimit, p.collateralRequired,
        p.maxLtvPercent, p.allowedPurposes,
      ],
    );
  }
}

async function seedHolidays(client: import('pg').PoolClient): Promise<void> {
  // Republic Day, Independence Day, Gandhi Jayanti, and 2 Oct are fixed; also
  // add Maharashtra Day (1 May). Sundays are excluded by the app, not the calendar.
  const year = new Date().getUTCFullYear();
  const fixedHolidays = [
    { date: `${year}-01-26`, occasion: 'Republic Day' },
    { date: `${year}-05-01`, occasion: 'Maharashtra Day' },
    { date: `${year}-08-15`, occasion: 'Independence Day' },
    { date: `${year}-10-02`, occasion: 'Gandhi Jayanti' },
    { date: `${year + 1}-01-26`, occasion: 'Republic Day' },
  ];
  for (const h of fixedHolidays) {
    await client.query(
      `INSERT INTO holiday_calendar (holiday_date, occasion, calendar_year, is_government)
       VALUES ($1, $2, $3, true)
       ON CONFLICT (holiday_date) DO NOTHING`,
      [h.date, h.occasion, Number(h.date.slice(0, 4))],
    );
  }
}

async function seedAppSettings(client: import('pg').PoolClient, adminId: string): Promise<void> {
  for (const setting of APP_SETTINGS) {
    await client.query(
      `INSERT INTO app_setting (key, value, category, description, updated_by)
       VALUES ($1, $2::jsonb, $3, $4, $5)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value,
             category = EXCLUDED.category,
             description = EXCLUDED.description,
             updated_by = EXCLUDED.updated_by,
             updated_at = now()`,
      [setting.key, JSON.stringify(setting.value), setting.category, setting.description, adminId],
    );
  }
}

async function seedNotificationTemplates(client: import('pg').PoolClient): Promise<void> {
  for (const t of NOTIFICATION_TEMPLATES) {
    await client.query(
      `INSERT INTO notification_template (event_type, channel, language, template_body, is_mandatory, is_active)
       VALUES ($1, $2, 'en', $3, $4, true)
       ON CONFLICT (event_type, channel, language) DO UPDATE
         SET template_body = EXCLUDED.template_body,
             is_mandatory = EXCLUDED.is_mandatory,
             is_active = true,
             updated_at = now()`,
      [t.eventType, t.channel, t.templateBody, t.isMandatory],
    );
  }
}

async function seedReportDefinitions(client: import('pg').PoolClient): Promise<void> {
  for (const r of REPORT_DEFINITIONS) {
    await client.query(
      `INSERT INTO report_definition
         (report_type, name, description, required_permissions, available_filters, date_basis, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, true)
       ON CONFLICT (report_type) DO UPDATE
         SET name = EXCLUDED.name,
             description = EXCLUDED.description,
             required_permissions = EXCLUDED.required_permissions,
             available_filters = EXCLUDED.available_filters,
             date_basis = EXCLUDED.date_basis,
             is_active = true,
             updated_at = now()`,
      [
        r.reportType, r.name, r.description,
        r.requiredPermissions,
        r.availableFilters,
        r.dateBasis,
      ],
    );
  }
}

// ---------------------------------------------------------------------------
// Demo data (env.seed.demoData)
// ---------------------------------------------------------------------------

async function seedDemoData(
  client: import('pg').PoolClient,
  adminId: string,
  branchId: string,
  roleIds: Map<StaffRole, string>,
): Promise<void> {
  const demoPasswordHash = await hash('Password#123', {
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });

  // Demo staff
  const staffIds = new Map<string, string>();
  for (const member of DEMO_STAFF) {
    const { rows } = await client.query<IdRow>(
      `INSERT INTO staff (staff_code, full_name, role_id, branch_id, email, phone, password_hash, status, nda_signed, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', true, $8)
       ON CONFLICT (staff_code) DO UPDATE
         SET full_name = EXCLUDED.full_name,
             email = EXCLUDED.email,
             phone = EXCLUDED.phone,
             updated_at = now()
       RETURNING id`,
      [member.staffCode, member.fullName, roleIds.get(member.role) ?? null, branchId, member.email, member.phone, demoPasswordHash, adminId],
    );
    const id = rows[0]?.id;
    if (id) staffIds.set(member.staffCode, id);
  }

  // Demo agents
  for (const agentProfile of DEMO_AGENTS) {
    const staffId = staffIds.get(agentProfile.staffCode);
    if (!staffId) continue;
    await client.query(
      `INSERT INTO agent (staff_id, agent_code, branch_id, phone, status, start_date, daily_cash_limit)
       VALUES ($1, $2, $3, (SELECT phone FROM staff WHERE id = $1), 'active', CURRENT_DATE, $4)
       ON CONFLICT (agent_code) DO UPDATE
         SET status = 'active',
             daily_cash_limit = EXCLUDED.daily_cash_limit,
             updated_at = now()`,
      [staffId, agentProfile.agentCode, branchId, agentProfile.dailyCashLimit],
    );
  }

  // Demo route
  await client.query(
    `INSERT INTO agent_route (route_code, name, area, branch_id, is_active)
     VALUES ($1, $2, $3, $4, true)
     ON CONFLICT (route_code) DO UPDATE
       SET name = EXCLUDED.name,
           area = EXCLUDED.area,
           branch_id = EXCLUDED.branch_id,
           updated_at = now()`,
    [DEMO_ROUTE.routeCode, DEMO_ROUTE.name, DEMO_ROUTE.area, branchId],
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const startedAt = Date.now();
  logger.info({ demoData: env.seed.demoData }, 'seed: starting');

  await transaction(async (client) => {
    const organisationId = await upsertOrganisation(client);
    const branchId = await upsertBranch(client, organisationId);
    const roleIds = await seedRolesAndPermissions(client);
    const adminId = await seedBootstrapAdmin(client, roleIds, branchId);
    await seedSuperAdmin(client, roleIds, branchId);
    await seedNumberSequences(client);
    await seedDepositProducts(client);
    await seedRdSchemes(client);
    await seedFdRateCard(client);
    await seedLoanProducts(client);
    await seedHolidays(client);
    await seedAppSettings(client, adminId);
    await seedNotificationTemplates(client);
    await seedReportDefinitions(client);
    if (env.seed.demoData) {
      await seedDemoData(client, adminId, branchId, roleIds);
    }
  });

  logger.info(
    { durationMs: Date.now() - startedAt, adminStaffCode: env.seed.bootstrapAdminStaffCode },
    'seed: completed',
  );
}

main()
  .then(() => pool.end())
  .catch(async (error: unknown) => {
    logger.error({ error }, 'seed: failed');
    await pool.end().catch(() => undefined);
    process.exitCode = 1;
  });
