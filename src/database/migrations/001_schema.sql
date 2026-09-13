-- =============================================================================
-- Migration 001 — Complete schema
-- Cooperative Finance Management System (docs/backend-master-spec.md §26)
--
-- Conventions:
--   * Money:        NUMERIC(14,2) fixed precision — never floating point.
--   * Rates:        NUMERIC(7,4).
--   * Timestamps:   TIMESTAMPTZ stored in UTC; business dates are DATE values
--                   computed in Asia/Kolkata by the application layer.
--   * Soft deactivation over deletion for business records (spec §28.7).
--   * Financial ledgers and audit events are append-only (DB-level triggers).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Organisation (spec §3, §26)
-- ---------------------------------------------------------------------------
CREATE TABLE organisation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  registration_number TEXT NOT NULL,
  legal_address TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  timezone TEXT NOT NULL DEFAULT 'Asia/Kolkata',
  currency TEXT NOT NULL DEFAULT 'INR',
  locale TEXT NOT NULL DEFAULT 'en-IN',
  financial_year_start_month SMALLINT NOT NULL DEFAULT 4,
  working_days TEXT[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri','Sat'],
  operating_hours TEXT NOT NULL DEFAULT '10:30-17:30',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE branch (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organisation_id UUID NOT NULL REFERENCES organisation(id),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  phone TEXT,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE holiday_calendar (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  holiday_date DATE NOT NULL UNIQUE,
  occasion TEXT NOT NULL,
  calendar_year SMALLINT NOT NULL,
  is_government BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Identity (spec §7)
-- ---------------------------------------------------------------------------
CREATE TABLE role (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  description TEXT,
  is_system BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE permission (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE role_permission (
  role_id UUID NOT NULL REFERENCES role(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permission(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_code TEXT NOT NULL UNIQUE,
  full_name TEXT NOT NULL,
  role_id UUID NOT NULL REFERENCES role(id),
  branch_id UUID REFERENCES branch(id),
  email TEXT,
  phone TEXT,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','locked','disabled')),
  failed_login_attempts SMALLINT NOT NULL DEFAULT 0,
  locked_until TIMESTAMPTZ,
  mfa_enabled BOOLEAN NOT NULL DEFAULT false,
  mfa_secret TEXT,
  nda_signed BOOLEAN NOT NULL DEFAULT false,
  exit_date DATE,
  last_login_at TIMESTAMPTZ,
  created_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_staff_role ON staff(role_id);

CREATE TABLE device (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id),
  device_type TEXT NOT NULL DEFAULT 'agent_mobile' CHECK (device_type IN ('admin_web','agent_mobile')),
  device_name TEXT,
  device_fingerprint TEXT NOT NULL,
  app_version TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','confirmed','disabled')),
  confirmed_at TIMESTAMPTZ,
  confirmed_by UUID REFERENCES staff(id),
  disabled_at TIMESTAMPTZ,
  disabled_by UUID REFERENCES staff(id),
  disabled_reason TEXT,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (staff_id, device_fingerprint)
);

CREATE TABLE staff_session (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL REFERENCES staff(id),
  device_id UUID REFERENCES device(id),
  source TEXT NOT NULL CHECK (source IN ('admin_web','agent_mobile')),
  ip_address TEXT,
  user_agent TEXT,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_session_staff ON staff_session(staff_id);

CREATE TABLE refresh_token (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES staff_session(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES staff(id),
  token_hash TEXT NOT NULL UNIQUE,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  used_at TIMESTAMPTZ,
  successor_id UUID REFERENCES refresh_token(id),
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT
);
CREATE INDEX idx_refresh_session ON refresh_token(session_id);

CREATE TABLE login_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID REFERENCES staff(id),
  staff_code TEXT NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  outcome TEXT NOT NULL CHECK (outcome IN ('success','failure','locked_out','device_pending')),
  failure_reason TEXT,
  ip_address TEXT,
  user_agent TEXT,
  device_id UUID REFERENCES device(id)
);
CREATE INDEX idx_login_event_staff ON login_event(staff_id, occurred_at);

-- ---------------------------------------------------------------------------
-- Numbering and settings (spec §4, §22)
-- ---------------------------------------------------------------------------
CREATE TABLE number_sequence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL UNIQUE,
  prefix TEXT NOT NULL DEFAULT '',
  next_value BIGINT NOT NULL DEFAULT 1,
  padding SMALLINT NOT NULL DEFAULT 4,
  reset_period TEXT NOT NULL DEFAULT 'never' CHECK (reset_period IN ('never','daily','monthly','yearly')),
  current_period TEXT,
  allow_cancelled_reuse BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_setting (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  category TEXT NOT NULL DEFAULT 'operational',
  description TEXT,
  updated_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE setting_change_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  setting_key TEXT NOT NULL,
  old_value JSONB,
  new_value JSONB NOT NULL,
  changed_by UUID REFERENCES staff(id),
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Agents (spec §15) — agent is a staff member with the collection_agent role
-- ---------------------------------------------------------------------------
CREATE TABLE agent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  staff_id UUID NOT NULL UNIQUE REFERENCES staff(id),
  agent_code TEXT NOT NULL UNIQUE,
  branch_id UUID REFERENCES branch(id),
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','suspended','deactivated','locked')),
  resume_reference TEXT,
  verification_reference TEXT,
  id_proof_type TEXT,
  id_proof_reference TEXT,
  address_proof_type TEXT,
  address_proof_reference TEXT,
  emergency_contact_name TEXT,
  emergency_contact_phone TEXT,
  training_status TEXT,
  start_date DATE,
  end_date DATE,
  daily_cash_limit NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_route (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  route_code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  area TEXT,
  branch_id UUID REFERENCES branch(id),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Customers and nominees (spec §8)
-- ---------------------------------------------------------------------------
CREATE TABLE customer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_number TEXT UNIQUE,
  customer_type TEXT NOT NULL DEFAULT 'Individual'
    CHECK (customer_type IN ('Individual','Cooperation','Group','SHG','Organisation','Minor','Joint')),
  full_name TEXT NOT NULL,
  date_of_birth DATE,
  gender TEXT,
  occupation TEXT,
  business_type TEXT,
  mobile TEXT NOT NULL,
  alternate_phone TEXT,
  email TEXT,
  branch_id UUID NOT NULL REFERENCES branch(id),
  membership_category TEXT NOT NULL DEFAULT 'Savings'
    CHECK (membership_category IN ('Loan','Savings','Daily','RD','Current')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','inactive','blocked','deceased','transferred','closed')),
  risk_category TEXT,
  aml_risk TEXT,
  source_of_funds TEXT,
  guardian_name TEXT,
  guardian_phone TEXT,
  kyc_method TEXT,
  registration_date DATE NOT NULL DEFAULT CURRENT_DATE,
  merged_into_customer_id UUID REFERENCES customer(id),
  created_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_customer_mobile ON customer(mobile);
CREATE INDEX idx_customer_status ON customer(status);
CREATE INDEX idx_customer_branch ON customer(branch_id);

CREATE TABLE customer_address (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  address_type TEXT NOT NULL CHECK (address_type IN ('permanent','current','work','collection')),
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT,
  district TEXT,
  state TEXT,
  pincode TEXT,
  landmark TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, address_type)
);

CREATE TABLE customer_identity_document (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  document_type TEXT NOT NULL CHECK (document_type IN ('aadhaar','pan','electricity_bill')),
  document_number TEXT NOT NULL,
  issue_date DATE,
  expiry_date DATE,
  issuing_authority TEXT,
  copy_reference TEXT,
  is_verified BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE customer_kyc (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL UNIQUE REFERENCES customer(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','expired')),
  method TEXT,
  verified_by UUID REFERENCES staff(id),
  verified_on TIMESTAMPTZ,
  rejection_reason TEXT,
  expires_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Nominees are superseded, never hard-deleted (spec §8.1: history retention).
CREATE TABLE nominee (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  relationship TEXT NOT NULL,
  date_of_birth DATE,
  identity_document_type TEXT,
  identity_document_number TEXT,
  address TEXT,
  phone TEXT,
  share_percentage NUMERIC(5,2) NOT NULL DEFAULT 100 CHECK (share_percentage > 0 AND share_percentage <= 100),
  guardian_name TEXT,
  guardian_phone TEXT,
  is_current BOOLEAN NOT NULL DEFAULT true,
  superseded_at TIMESTAMPTZ,
  superseded_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uq_nominee_current_per_customer ON nominee(customer_id) WHERE is_current;
CREATE INDEX idx_nominee_customer ON nominee(customer_id);

-- Superseded nominees = nominee history (single source of truth, audit-safe).
CREATE VIEW nominee_history AS
  SELECT * FROM nominee WHERE NOT is_current;

CREATE TABLE customer_consent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
  channel TEXT NOT NULL
    CHECK (channel IN ('sms','whatsapp','email','call','location_visit','promotional','printed_receipt','app_notification','voice_call')),
  granted BOOLEAN NOT NULL,
  granted_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  recorded_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (customer_id, channel)
);

CREATE TABLE customer_complaint (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id),
  category TEXT,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','in_progress','resolved','closed')),
  raised_by UUID REFERENCES staff(id),
  resolution_note TEXT,
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_complaint_customer ON customer_complaint(customer_id);

CREATE TABLE customer_status_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id),
  from_status TEXT NOT NULL,
  to_status TEXT NOT NULL,
  reason TEXT,
  changed_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE field_verification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id UUID NOT NULL REFERENCES customer(id),
  agent_id UUID NOT NULL REFERENCES agent(id),
  verification_date DATE NOT NULL,
  address_verified BOOLEAN NOT NULL DEFAULT false,
  outcome TEXT,
  remarks TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Agent assignments / routes (spec §15.4)
-- ---------------------------------------------------------------------------
CREATE TABLE agent_customer_assignment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agent(id),
  customer_id UUID NOT NULL REFERENCES customer(id),
  assigned_by UUID REFERENCES staff(id),
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  effective_to DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, customer_id, effective_from)
);
CREATE INDEX idx_assignment_agent ON agent_customer_assignment(agent_id) WHERE is_active;
CREATE INDEX idx_assignment_customer ON agent_customer_assignment(customer_id) WHERE is_active;

CREATE TABLE route_exchange (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_agent_id UUID NOT NULL REFERENCES agent(id),
  to_agent_id UUID NOT NULL REFERENCES agent(id),
  route_id UUID REFERENCES agent_route(id),
  customer_ids UUID[],
  start_date DATE NOT NULL,
  end_date DATE,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','completed','cancelled')),
  approved_by UUID REFERENCES staff(id),
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_transfer_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agent(id),
  customer_id UUID REFERENCES customer(id),
  from_agent_id UUID REFERENCES agent(id),
  action TEXT NOT NULL CHECK (action IN ('assigned','reassigned','transferred_out','transferred_in','released')),
  reason TEXT,
  performed_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- agent_device: agent-facing view over the unified device registry.
CREATE VIEW agent_device AS
  SELECT d.id,
         d.staff_id,
         a.id AS agent_id,
         a.agent_code,
         d.device_type,
         d.device_name,
         d.device_fingerprint,
         d.app_version,
         d.status,
         d.confirmed_at,
         d.confirmed_by,
         d.disabled_at,
         d.disabled_by,
         d.disabled_reason,
         d.last_used_at,
         d.created_at
  FROM device d
  JOIN agent a ON a.staff_id = d.staff_id;

-- ---------------------------------------------------------------------------
-- Deposits and savings accounts (spec §9)
-- ---------------------------------------------------------------------------
CREATE TABLE deposit_product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  min_opening_amount NUMERIC(14,2) NOT NULL DEFAULT 100.00,
  min_balance NUMERIC(14,2) NOT NULL DEFAULT 100.00,
  max_balance NUMERIC(14,2),
  interest_method TEXT NOT NULL DEFAULT 'flat' CHECK (interest_method IN ('flat','reducing','tiered')),
  interest_frequency TEXT NOT NULL DEFAULT 'quarterly' CHECK (interest_frequency IN ('daily','monthly','quarterly','yearly')),
  interest_rate NUMERIC(7,4) NOT NULL DEFAULT 4.0000,
  rate_policy TEXT NOT NULL DEFAULT 'variable' CHECK (rate_policy IN ('fixed','variable')),
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE savings_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customer(id),
  product_id UUID NOT NULL REFERENCES deposit_product(id),
  branch_id UUID NOT NULL REFERENCES branch(id),
  status TEXT NOT NULL DEFAULT 'pending_approval'
    CHECK (status IN ('pending_approval','active','frozen','closed')),
  current_balance NUMERIC(14,2) NOT NULL DEFAULT 0.00 CHECK (current_balance >= 0),
  interest_rate NUMERIC(7,4),
  opened_by UUID REFERENCES staff(id),
  opened_on DATE,
  approved_by UUID REFERENCES staff(id),
  approved_on DATE,
  freeze_reason TEXT,
  closed_on DATE,
  closure_reason TEXT,
  reopened_on DATE,
  last_interest_posted_on DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_savings_customer ON savings_account(customer_id);
CREATE INDEX idx_savings_status ON savings_account(status);

-- Immutable ledger: every deposit/withdrawal/interest/adjustment/reversal.
CREATE TABLE account_transaction (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_account_id UUID NOT NULL REFERENCES savings_account(id),
  transaction_type TEXT NOT NULL CHECK (transaction_type IN ('deposit','withdrawal','interest','adjustment','reversal')),
  direction TEXT NOT NULL CHECK (direction IN ('credit','debit')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_after NUMERIC(14,2) NOT NULL,
  value_date DATE NOT NULL,
  payment_method TEXT
    CHECK (payment_method IN ('cash','bank_transfer','cheque','mobile_money','upi','neft','rtgs')),
  reference_number TEXT,
  description TEXT,
  performed_by UUID REFERENCES staff(id),
  performed_source TEXT NOT NULL DEFAULT 'admin_web' CHECK (performed_source IN ('admin_web','agent_mobile','system')),
  reversal_of UUID REFERENCES account_transaction(id),
  adjustment_id UUID,
  withdrawal_request_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_account_txn_account_date ON account_transaction(savings_account_id, value_date);

CREATE TABLE interest_posting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_account_id UUID NOT NULL REFERENCES savings_account(id),
  posting_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  rate_applied NUMERIC(7,4) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  transaction_id UUID NOT NULL REFERENCES account_transaction(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE account_adjustment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  savings_account_id UUID NOT NULL REFERENCES savings_account(id),
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('reversal','correction','replacement')),
  original_transaction_id UUID NOT NULL REFERENCES account_transaction(id),
  adjustment_transaction_id UUID NOT NULL REFERENCES account_transaction(id),
  reason TEXT NOT NULL,
  evidence_references JSONB,
  customer_confirmed BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE account_transaction
  ADD CONSTRAINT fk_account_transaction_adjustment FOREIGN KEY (adjustment_id) REFERENCES account_adjustment(id);

-- ---------------------------------------------------------------------------
-- Recurring deposits (spec §10)
-- ---------------------------------------------------------------------------
CREATE TABLE rd_scheme (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly')),
  min_instalment_amount NUMERIC(14,2) NOT NULL DEFAULT 100.00,
  max_instalment_amount NUMERIC(14,2),
  min_duration_months SMALLINT NOT NULL DEFAULT 6,
  max_duration_months SMALLINT NOT NULL DEFAULT 120,
  grace_period_months SMALLINT NOT NULL DEFAULT 1,
  interest_rate NUMERIC(7,4) NOT NULL DEFAULT 6.0000,
  interest_credit_frequency TEXT NOT NULL DEFAULT 'yearly' CHECK (interest_credit_frequency IN ('yearly','half_yearly')),
  early_closure_fee_percent NUMERIC(5,2) NOT NULL DEFAULT 4.00,
  penalty_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rd_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customer(id),
  scheme_id UUID NOT NULL REFERENCES rd_scheme(id),
  branch_id UUID NOT NULL REFERENCES branch(id),
  instalment_amount NUMERIC(14,2) NOT NULL CHECK (instalment_amount > 0),
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','weekly','monthly','quarterly')),
  start_date DATE NOT NULL,
  first_due_date DATE NOT NULL,
  maturity_date DATE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','overdue','completed','matured','closed_early','suspended','cancelled')),
  total_expected NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  total_paid NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  pending_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  grace_period_months SMALLINT NOT NULL DEFAULT 1,
  opened_by UUID REFERENCES staff(id),
  approved_by UUID REFERENCES staff(id),
  closed_on DATE,
  closure_fee NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rd_customer ON rd_account(customer_id);

CREATE TABLE rd_instalment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rd_account_id UUID NOT NULL REFERENCES rd_account(id),
  instalment_number SMALLINT NOT NULL,
  due_date DATE NOT NULL,
  expected_amount NUMERIC(14,2) NOT NULL,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','partial','missed','overdue','waived')),
  paid_on DATE,
  payment_method TEXT,
  reference_number TEXT,
  collection_entry_id UUID,
  allocation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rd_account_id, instalment_number)
);
CREATE INDEX idx_rd_instalment_due ON rd_instalment(rd_account_id, due_date);

CREATE TABLE rd_penalty (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rd_account_id UUID NOT NULL REFERENCES rd_account(id),
  instalment_id UUID REFERENCES rd_instalment(id),
  penalty_amount NUMERIC(14,2) NOT NULL CHECK (penalty_amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','waived')),
  waived_by UUID REFERENCES staff(id),
  waived_on TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rd_waiver (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rd_account_id UUID NOT NULL REFERENCES rd_account(id),
  penalty_id UUID REFERENCES rd_penalty(id),
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rd_schedule_change (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rd_account_id UUID NOT NULL REFERENCES rd_account(id),
  change_type TEXT NOT NULL,
  old_value JSONB NOT NULL,
  new_value JSONB NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES staff(id),
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE rd_interest_posting (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rd_account_id UUID NOT NULL REFERENCES rd_account(id),
  posting_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  rate_applied NUMERIC(7,4) NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Fixed deposits (spec §11)
-- ---------------------------------------------------------------------------
CREATE TABLE fd_rate_card (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  min_amount NUMERIC(14,2) NOT NULL,
  max_amount NUMERIC(14,2) NOT NULL,
  tenure_months SMALLINT NOT NULL CHECK (tenure_months > 0),
  interest_rate NUMERIC(7,4) NOT NULL,
  early_closure_penalty_percent NUMERIC(5,2) NOT NULL DEFAULT 1.00,
  min_holding_months SMALLINT NOT NULL DEFAULT 0,
  effective_from DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (min_amount <= max_amount)
);

CREATE TABLE fd_account (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customer(id),
  rate_card_id UUID NOT NULL REFERENCES fd_rate_card(id),
  branch_id UUID NOT NULL REFERENCES branch(id),
  deposit_amount NUMERIC(14,2) NOT NULL CHECK (deposit_amount >= 1000.00 AND deposit_amount <= 100000.00),
  tenure_months SMALLINT NOT NULL CHECK (tenure_months > 0),
  interest_rate NUMERIC(7,4) NOT NULL,
  rate_is_fixed BOOLEAN NOT NULL DEFAULT true,
  start_date DATE NOT NULL,
  maturity_date DATE NOT NULL,
  payout_frequency TEXT NOT NULL CHECK (payout_frequency IN ('monthly','quarterly','yearly','at_maturity')),
  payout_mode TEXT NOT NULL DEFAULT 'reinvest' CHECK (payout_mode IN ('payout','reinvest')),
  maturity_action TEXT NOT NULL DEFAULT 'pending'
    CHECK (maturity_action IN ('pending','renew_principal_interest','renew_principal','transfer_to_savings','pay_cash','pay_bank')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','matured','closed_early','under_lien','closed','renewed')),
  lien_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  closed_on DATE,
  closure_penalty NUMERIC(14,2),
  opened_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_fd_customer ON fd_account(customer_id);

CREATE TABLE fd_lien (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fd_account_id UUID NOT NULL REFERENCES fd_account(id),
  lien_amount NUMERIC(14,2) NOT NULL CHECK (lien_amount > 0),
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','released')),
  requested_by UUID NOT NULL REFERENCES staff(id),
  requested_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  released_on TIMESTAMPTZ,
  released_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fd_maturity_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fd_account_id UUID NOT NULL REFERENCES fd_account(id),
  event_type TEXT NOT NULL
    CHECK (event_type IN ('pre_maturity_notice','matured','action_taken','renewed','transferred','closed_early')),
  event_date DATE NOT NULL,
  details JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE fd_interest_payout (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fd_account_id UUID NOT NULL REFERENCES fd_account(id),
  payout_date DATE NOT NULL,
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  payout_mode TEXT NOT NULL CHECK (payout_mode IN ('payout','reinvest')),
  reference_number TEXT,
  savings_transaction_id UUID REFERENCES account_transaction(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Loans (spec §12)
-- ---------------------------------------------------------------------------
CREATE TABLE loan_product (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL CHECK (category IN ('business','shg','personal','mortgage','gold','other')),
  min_amount NUMERIC(14,2) NOT NULL DEFAULT 5000.00,
  max_amount NUMERIC(14,2) NOT NULL DEFAULT 500000.00,
  min_tenure_months SMALLINT NOT NULL DEFAULT 3,
  max_tenure_months SMALLINT NOT NULL DEFAULT 120,
  interest_method TEXT NOT NULL DEFAULT 'flat' CHECK (interest_method IN ('flat','reducing')),
  interest_rate NUMERIC(7,4) NOT NULL DEFAULT 12.0000 CHECK (interest_rate >= 4.0000 AND interest_rate <= 25.0000),
  rate_policy TEXT NOT NULL DEFAULT 'variable' CHECK (rate_policy IN ('fixed','variable')),
  repayment_frequency TEXT NOT NULL DEFAULT 'monthly' CHECK (repayment_frequency IN ('daily','weekly','monthly','quarterly')),
  penalty_config JSONB NOT NULL DEFAULT '{}'::jsonb,
  allocation_order TEXT[] NOT NULL DEFAULT ARRAY['interest','penalty','fees','principal'],
  guarantor_limit SMALLINT NOT NULL DEFAULT 2,
  collateral_required BOOLEAN NOT NULL DEFAULT false,
  max_ltv_percent NUMERIC(5,2) NOT NULL DEFAULT 60.00,
  allowed_purposes TEXT[],
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loan_application (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customer(id),
  product_id UUID NOT NULL REFERENCES loan_product(id),
  purpose TEXT NOT NULL,
  requested_amount NUMERIC(14,2) NOT NULL CHECK (requested_amount > 0),
  approved_amount NUMERIC(14,2),
  tenure_months SMALLINT NOT NULL CHECK (tenure_months > 0),
  repayment_frequency TEXT NOT NULL CHECK (repayment_frequency IN ('daily','weekly','monthly','quarterly')),
  proposed_interest_rate NUMERIC(7,4),
  status TEXT NOT NULL DEFAULT 'applied'
    CHECK (status IN ('applied','recommended','approved','rejected','disbursed','cancelled')),
  applied_on DATE NOT NULL DEFAULT CURRENT_DATE,
  applied_by UUID REFERENCES staff(id),
  recommended_by UUID REFERENCES staff(id),
  recommended_on TIMESTAMPTZ,
  approved_by UUID REFERENCES staff(id),
  approved_on TIMESTAMPTZ,
  rejection_reason TEXT,
  documents JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_loan_application_customer ON loan_application(customer_id);

CREATE TABLE loan (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_number TEXT NOT NULL UNIQUE,
  application_id UUID NOT NULL REFERENCES loan_application(id),
  customer_id UUID NOT NULL REFERENCES customer(id),
  product_id UUID NOT NULL REFERENCES loan_product(id),
  branch_id UUID NOT NULL REFERENCES branch(id),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','overdue','rescheduled','settled','written_off','closed')),
  approved_amount NUMERIC(14,2) NOT NULL,
  disbursed_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  disbursed_on DATE,
  disbursed_by UUID REFERENCES staff(id),
  tenure_months SMALLINT NOT NULL,
  repayment_frequency TEXT NOT NULL CHECK (repayment_frequency IN ('daily','weekly','monthly','quarterly')),
  interest_method TEXT NOT NULL DEFAULT 'flat',
  interest_rate NUMERIC(7,4) NOT NULL,
  flat_interest_total NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  total_payable NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  total_paid NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  outstanding_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  next_due_date DATE,
  against_fd_account_id UUID REFERENCES fd_account(id),
  closed_on DATE,
  closure_type TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_loan_customer ON loan(customer_id);
CREATE INDEX idx_loan_status ON loan(status);

-- RD surplus is held in the linked loan account until loan completion (spec §10.1).
ALTER TABLE rd_account ADD COLUMN linked_loan_id UUID REFERENCES loan(id);

CREATE TABLE loan_guarantor (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  guarantor_customer_id UUID REFERENCES customer(id),
  name TEXT NOT NULL,
  relationship TEXT,
  identity_document_type TEXT,
  identity_document_number TEXT,
  phone TEXT,
  address TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_guarantor_customer ON loan_guarantor(guarantor_customer_id);

CREATE TABLE loan_collateral (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  collateral_type TEXT NOT NULL,
  description TEXT,
  valuation_amount NUMERIC(14,2) NOT NULL CHECK (valuation_amount > 0),
  valuation_date DATE,
  valuation_by UUID REFERENCES staff(id),
  document_reference TEXT,
  status TEXT NOT NULL DEFAULT 'held' CHECK (status IN ('held','released')),
  released_on DATE,
  released_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loan_instalment (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id) ON DELETE CASCADE,
  instalment_number SMALLINT NOT NULL,
  due_date DATE NOT NULL,
  expected_amount NUMERIC(14,2) NOT NULL,
  principal_component NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  interest_component NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  penalty_component NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  fees_component NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  paid_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  status TEXT NOT NULL DEFAULT 'due' CHECK (status IN ('due','paid','partial','missed','overdue','waived')),
  paid_on DATE,
  allocation JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (loan_id, instalment_number)
);
CREATE INDEX idx_loan_instalment_due ON loan_instalment(loan_id, due_date);

CREATE TABLE loan_surplus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id),
  entry_type TEXT NOT NULL CHECK (entry_type IN ('held','released','applied')),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  source_collection_id UUID,
  released_on DATE,
  released_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loan_restructure (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id),
  change_type TEXT NOT NULL CHECK (change_type IN ('reschedule','refinance','extend')),
  old_terms JSONB NOT NULL,
  new_terms JSONB NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES staff(id),
  approved_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_from DATE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE loan_writeoff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  loan_id UUID NOT NULL REFERENCES loan(id),
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT NOT NULL,
  approved_by UUID NOT NULL REFERENCES staff(id),
  approved_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Withdrawals (spec §13)
-- ---------------------------------------------------------------------------
CREATE TABLE withdrawal_request (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  request_number TEXT NOT NULL UNIQUE,
  customer_id UUID NOT NULL REFERENCES customer(id),
  account_kind TEXT NOT NULL CHECK (account_kind IN ('savings','rd','fd','loan_surplus')),
  savings_account_id UUID REFERENCES savings_account(id),
  rd_account_id UUID REFERENCES rd_account(id),
  fd_account_id UUID REFERENCES fd_account(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  balance_before NUMERIC(14,2),
  reason TEXT NOT NULL,
  free_text_reason TEXT,
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash','bank_transfer','cheque','mobile_money')),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','approved','rejected','paid','confirmed','cancelled')),
  is_high_value BOOLEAN NOT NULL DEFAULT false,
  identity_verified_passbook BOOLEAN NOT NULL DEFAULT false,
  identity_verified_signature BOOLEAN NOT NULL DEFAULT false,
  identity_verified_aadhaar BOOLEAN NOT NULL DEFAULT false,
  requested_by UUID NOT NULL REFERENCES staff(id),
  requested_on DATE NOT NULL DEFAULT CURRENT_DATE,
  approved_by UUID REFERENCES staff(id),
  approved_on TIMESTAMPTZ,
  rejection_reason TEXT,
  paid_by UUID REFERENCES staff(id),
  paid_on TIMESTAMPTZ,
  payout_reference TEXT,
  confirmed_by UUID REFERENCES staff(id),
  confirmed_on TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_withdrawal_customer ON withdrawal_request(customer_id);
CREATE INDEX idx_withdrawal_status ON withdrawal_request(status);

CREATE TABLE withdrawal_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withdrawal_id UUID NOT NULL REFERENCES withdrawal_request(id),
  event_type TEXT NOT NULL CHECK (event_type IN ('requested','approved','rejected','paid','confirmed','changed','cancelled')),
  event_data JSONB,
  performed_by UUID REFERENCES staff(id),
  performed_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_withdrawal_event ON withdrawal_event(withdrawal_id);

ALTER TABLE account_transaction
  ADD CONSTRAINT fk_account_transaction_withdrawal FOREIGN KEY (withdrawal_request_id) REFERENCES withdrawal_request(id);

-- ---------------------------------------------------------------------------
-- Doorstep collections (spec §14)
-- ---------------------------------------------------------------------------
CREATE TABLE collection_entry (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  agent_id UUID NOT NULL REFERENCES agent(id),
  customer_id UUID NOT NULL REFERENCES customer(id),
  product_type TEXT NOT NULL CHECK (product_type IN ('savingsDeposit','recurringDeposit','loan','penalty')),
  savings_account_id UUID REFERENCES savings_account(id),
  rd_account_id UUID REFERENCES rd_account(id),
  loan_id UUID REFERENCES loan(id),
  amount NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  mode TEXT NOT NULL CHECK (mode IN ('cash','UPI','NEFT','RTGS','cheque')),
  status TEXT NOT NULL DEFAULT 'waiting' CHECK (status IN ('waiting','accepted','rejected','requiresReview')),
  is_partial BOOLEAN NOT NULL DEFAULT false,
  is_advance BOOLEAN NOT NULL DEFAULT false,
  instrument_ref TEXT,
  instrument_date DATE,
  business_date DATE NOT NULL,
  collected_at TIMESTAMPTZ,
  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  submitted_from_offline BOOLEAN NOT NULL DEFAULT false,
  offline_late BOOLEAN NOT NULL DEFAULT false,
  device_id UUID REFERENCES device(id),
  visit_log_id UUID,
  allocation JSONB,
  is_deleted BOOLEAN NOT NULL DEFAULT false,
  deleted_by UUID REFERENCES staff(id),
  deleted_at TIMESTAMPTZ,
  deletion_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_collection_agent_date ON collection_entry(agent_id, business_date);
CREATE INDEX idx_collection_customer ON collection_entry(customer_id);
CREATE INDEX idx_collection_status ON collection_entry(status) WHERE NOT is_deleted;
CREATE INDEX idx_collection_savings_account ON collection_entry(savings_account_id);

CREATE TABLE collection_receipt (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL UNIQUE REFERENCES collection_entry(id),
  receipt_number TEXT NOT NULL UNIQUE,
  receipt_kind TEXT NOT NULL CHECK (receipt_kind IN ('daily','monthly')),
  agent_code TEXT NOT NULL,
  customer_name TEXT NOT NULL,
  account_number TEXT NOT NULL,
  product_label TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  mode TEXT NOT NULL,
  instrument_ref TEXT,
  acknowledged BOOLEAN NOT NULL DEFAULT false,
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE visit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key TEXT NOT NULL UNIQUE,
  agent_id UUID NOT NULL REFERENCES agent(id),
  customer_id UUID NOT NULL REFERENCES customer(id),
  visit_date DATE NOT NULL,
  visited_at TIMESTAMPTZ,
  outcome TEXT NOT NULL CHECK (outcome IN ('collected','notAvailable','promised','refused')),
  remark TEXT,
  photos JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_visit_agent_date ON visit_log(agent_id, visit_date);

ALTER TABLE collection_entry
  ADD CONSTRAINT fk_collection_visit FOREIGN KEY (visit_log_id) REFERENCES visit_log(id);

CREATE TABLE collection_review (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL UNIQUE REFERENCES collection_entry(id),
  reviewed_by UUID NOT NULL REFERENCES staff(id),
  reviewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  decision TEXT NOT NULL CHECK (decision IN ('accepted','rejected','requiresReview')),
  remarks TEXT
);

CREATE TABLE collection_reversal (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  original_collection_id UUID NOT NULL REFERENCES collection_entry(id),
  replacement_collection_id UUID REFERENCES collection_entry(id),
  reason TEXT NOT NULL,
  proof_of_record JSONB,
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID NOT NULL REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE short_payment_allocation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id UUID NOT NULL REFERENCES collection_entry(id),
  allocation JSONB NOT NULL,
  decided_by UUID NOT NULL REFERENCES staff(id),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Daily handover and reconciliation (spec §16)
-- ---------------------------------------------------------------------------
CREATE TABLE day_close (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL REFERENCES agent(id),
  business_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','submitted','closed','reopened','locked')),
  total_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  entry_count INTEGER NOT NULL DEFAULT 0,
  cash_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  digital_amount NUMERIC(14,2) NOT NULL DEFAULT 0.00,
  queued_count INTEGER NOT NULL DEFAULT 0,
  waiting_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  submitted_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  locked_at TIMESTAMPTZ,
  locked_by UUID REFERENCES staff(id),
  reopened_at TIMESTAMPTZ,
  reopened_by UUID REFERENCES staff(id),
  reopen_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (agent_id, business_date)
);

CREATE TABLE cash_handover (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_close_id UUID NOT NULL REFERENCES day_close(id),
  agent_id UUID NOT NULL REFERENCES agent(id),
  handed_over_at TIMESTAMPTZ,
  amount NUMERIC(14,2) NOT NULL,
  section_report JSONB,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','counted','confirmed','difference')),
  counted_by UUID REFERENCES staff(id),
  counted_at TIMESTAMPTZ,
  confirmed_amount NUMERIC(14,2),
  difference_amount NUMERIC(14,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE denomination_breakup (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cash_handover_id UUID NOT NULL REFERENCES cash_handover(id) ON DELETE CASCADE,
  denomination SMALLINT NOT NULL CHECK (denomination > 0),
  note_count INTEGER NOT NULL CHECK (note_count >= 0),
  amount NUMERIC(14,2) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (cash_handover_id, denomination)
);

CREATE TABLE digital_settlement (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_close_id UUID NOT NULL REFERENCES day_close(id),
  settlement_reference TEXT NOT NULL,
  bank_name TEXT,
  settlement_date DATE NOT NULL,
  method TEXT NOT NULL CHECK (method IN ('bank_transfer','cheque','UPI','NEFT','RTGS')),
  amount NUMERIC(14,2) NOT NULL,
  name_wise_details JSONB,
  receipt_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_difference (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_close_id UUID NOT NULL REFERENCES day_close(id),
  difference_type TEXT NOT NULL,
  amount NUMERIC(14,2) NOT NULL,
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'unresolved'
    CHECK (status IN ('unresolved','explained','accepted','recovered','waived')),
  marked_by UUID REFERENCES staff(id),
  marked_at TIMESTAMPTZ,
  resolution_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE reconciliation_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  day_close_id UUID NOT NULL REFERENCES day_close(id),
  event_type TEXT NOT NULL,
  event_data JSONB,
  performed_by UUID REFERENCES staff(id),
  performed_source TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Reports (spec §17)
-- ---------------------------------------------------------------------------
CREATE TABLE report_definition (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT,
  required_permissions TEXT[] NOT NULL,
  available_filters TEXT[] NOT NULL DEFAULT '{}',
  date_basis TEXT[] NOT NULL DEFAULT '{transaction_date}',
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE generated_report (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  report_type TEXT NOT NULL,
  definition_id UUID NOT NULL REFERENCES report_definition(id),
  generated_by UUID NOT NULL REFERENCES staff(id),
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  parameters JSONB NOT NULL,
  period_start DATE,
  period_end DATE,
  content BYTEA,
  filename TEXT NOT NULL,
  file_size_bytes INTEGER,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('generating','ready','failed')),
  failure_reason TEXT,
  shared_with JSONB,
  share_consent_by UUID REFERENCES staff(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_generated_report_type ON generated_report(report_type);

-- ---------------------------------------------------------------------------
-- Notifications (spec §18)
-- ---------------------------------------------------------------------------
CREATE TABLE notification_template (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL
    CHECK (channel IN ('sms','whatsapp','email','app_notification','voice_call','printed_receipt')),
  language TEXT NOT NULL DEFAULT 'en',
  template_body TEXT NOT NULL,
  is_mandatory BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (event_type, channel, language)
);

CREATE TABLE notification_outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  template_id UUID REFERENCES notification_template(id),
  event_type TEXT NOT NULL,
  channel TEXT NOT NULL,
  customer_id UUID REFERENCES customer(id),
  staff_id UUID REFERENCES staff(id),
  recipient TEXT NOT NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  consent_required BOOLEAN NOT NULL DEFAULT false,
  consent_verified BOOLEAN NOT NULL DEFAULT false,
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sending','sent','failed','skipped')),
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ,
  retry_count SMALLINT NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_outbox_status ON notification_outbox(status);

-- Delivery history is visible for 30 days (spec §18.1).
CREATE TABLE notification_delivery_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_id UUID NOT NULL REFERENCES notification_outbox(id),
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status TEXT NOT NULL CHECK (status IN ('delivered','failed','bounced')),
  gateway_response TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_delivery_log_outbox ON notification_delivery_log(outbox_id);

-- ---------------------------------------------------------------------------
-- Corrections, reversals, and disputes (spec §19)
-- ---------------------------------------------------------------------------
CREATE TABLE adjustment_record (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type TEXT NOT NULL,
  original_entity_id UUID NOT NULL,
  adjustment_entity_id UUID,
  adjustment_type TEXT NOT NULL CHECK (adjustment_type IN ('reversal','correction','replacement','deletion')),
  reason TEXT NOT NULL,
  evidence JSONB,
  customer_confirmed BOOLEAN NOT NULL DEFAULT false,
  customer_notified BOOLEAN NOT NULL DEFAULT false,
  approved_by UUID NOT NULL REFERENCES staff(id),
  approved_on TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE dispute_case (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dispute_number TEXT NOT NULL UNIQUE,
  customer_id UUID REFERENCES customer(id),
  disputed_entity_type TEXT NOT NULL,
  disputed_entity_id UUID NOT NULL,
  description TEXT NOT NULL,
  raised_on DATE NOT NULL DEFAULT CURRENT_DATE,
  raised_by UUID REFERENCES staff(id),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','investigating','resolved','rejected','closed')),
  resolution TEXT,
  resolved_by UUID REFERENCES staff(id),
  resolved_on TIMESTAMPTZ,
  proof_of_record JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_dispute_customer ON dispute_case(customer_id);

CREATE TABLE claim (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  claim_number TEXT NOT NULL UNIQUE,
  customer_id UUID REFERENCES customer(id),
  claim_type TEXT NOT NULL CHECK (claim_type IN ('refund','recovery','waiver','outstanding_difference')),
  amount NUMERIC(14,2) NOT NULL,
  related_entity_type TEXT,
  related_entity_id UUID,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected','settled')),
  decided_by UUID REFERENCES staff(id),
  decided_on TIMESTAMPTZ,
  settlement_reference TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_claim_customer ON claim(customer_id);

-- ---------------------------------------------------------------------------
-- Audit (spec §21) — append-only
-- ---------------------------------------------------------------------------
CREATE TABLE audit_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor_staff_id UUID REFERENCES staff(id),
  actor_role TEXT,
  actor_staff_code TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('admin_web','agent_mobile','system')),
  request_id TEXT,
  business_date DATE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX idx_audit_action ON audit_event(action);
CREATE INDEX idx_audit_entity ON audit_event(entity_type, entity_id);
CREATE INDEX idx_audit_actor ON audit_event(actor_staff_id);
CREATE INDEX idx_audit_time ON audit_event(occurred_at);

-- ---------------------------------------------------------------------------
-- Append-only enforcement (spec §21.2: no update/delete paths, DB-level)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reject_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only', TG_TABLE_NAME
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_event_append_only
  BEFORE UPDATE OR DELETE ON audit_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_account_transaction_append_only
  BEFORE UPDATE OR DELETE ON account_transaction
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_login_event_append_only
  BEFORE UPDATE OR DELETE ON login_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_interest_posting_append_only
  BEFORE UPDATE OR DELETE ON interest_posting
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_rd_interest_posting_append_only
  BEFORE UPDATE OR DELETE ON rd_interest_posting
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_fd_interest_payout_append_only
  BEFORE UPDATE OR DELETE ON fd_interest_payout
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_rd_waiver_append_only
  BEFORE UPDATE OR DELETE ON rd_waiver
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_loan_writeoff_append_only
  BEFORE UPDATE OR DELETE ON loan_writeoff
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_collection_receipt_append_only
  BEFORE UPDATE OR DELETE ON collection_receipt
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_setting_change_history_append_only
  BEFORE UPDATE OR DELETE ON setting_change_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_customer_status_history_append_only
  BEFORE UPDATE OR DELETE ON customer_status_history
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_agent_transfer_log_append_only
  BEFORE UPDATE OR DELETE ON agent_transfer_log
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_withdrawal_event_append_only
  BEFORE UPDATE OR DELETE ON withdrawal_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_reconciliation_event_append_only
  BEFORE UPDATE OR DELETE ON reconciliation_event
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

CREATE TRIGGER trg_adjustment_record_append_only
  BEFORE UPDATE OR DELETE ON adjustment_record
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();

-- Belt-and-braces: audit_event has no UPDATE/DELETE grant for non-owners.
REVOKE UPDATE, DELETE ON audit_event FROM PUBLIC;

-- ---------------------------------------------------------------------------
-- Auto-attach updated_at triggers to every table that has the column
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t RECORD;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
    FROM pg_class c
    JOIN pg_attribute a ON a.attrelid = c.oid
    WHERE c.relkind = 'r'
      AND c.relnamespace = 'public'::regnamespace
      AND a.attname = 'updated_at'
      AND NOT EXISTS (
        SELECT 1 FROM pg_trigger tg
        WHERE tg.tgrelid = c.oid AND tg.tgname LIKE 'trg_%_updated_at'
      )
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_%s_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
      t.table_name, t.table_name
    );
  END LOOP;
END $$;
