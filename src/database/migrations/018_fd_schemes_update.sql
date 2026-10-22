-- =============================================================================
-- Migration 018 — Published FD Schemes Update (आकर्षक मुदत ठेव योजना)
-- =============================================================================

-- 1. Update 24-month (366+ days) rate from 11.5% to 12.0%
UPDATE fd_rate_card
   SET interest_rate = 12.0000,
       updated_at = now()
 WHERE tenure_months = 24 AND interest_rate = 11.5000;

-- 2. Ensure Tier 1: 30 to 45 Days (३० ते ४५ दिवस) -> 7.0000%
INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 1, 7.0000, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 1 AND is_active = true
);

-- 3. Ensure Tier 2: 46 to 180 Days (४६ ते १८० दिवस) -> 8.0000%
INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 6, 8.0000, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 6 AND min_amount <= 1000.00 AND max_amount >= 100000.00 AND is_active = true
);

-- 4. Ensure Tier 3: 181 to 365 Days (१८१ ते ३६५ दिवस) -> 10.0000%
INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 12, 10.0000, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 12 AND min_amount <= 1000.00 AND max_amount >= 100000.00 AND is_active = true
);

-- 5. Ensure Tier 4: 366 & above Days (३६६ व वरिल दिवसाकरिता) -> 12.0000%
INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 24, 12.0000, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 24 AND interest_rate = 12.0000 AND is_active = true
);

INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 36, 12.0000, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 36 AND is_active = true
);

-- 6. Ensure Tier 5: दामदुप्पट योजना (Damduppat Scheme - 72 Months / 6 Years Double Return) -> 16.6667%
INSERT INTO fd_rate_card (min_amount, max_amount, tenure_months, interest_rate, early_closure_penalty_percent, min_holding_months, is_active)
SELECT 1000.00, 100000.00, 72, 16.6667, 1.00, 0, true
WHERE NOT EXISTS (
  SELECT 1 FROM fd_rate_card WHERE tenure_months = 72 AND is_active = true
);

-- 7. Update published FD ladder in app_setting
UPDATE app_setting
   SET value = jsonb_build_object(
     'currency', 'INR',
     'basis', 'days',
     'source', 'Official Published FD rate card (आकर्षक मुदत ठेव योजना)',
     'tiers', jsonb_build_array(
       jsonb_build_object('label', '३० ते ४५ दिवस (30–45 days)', 'minDays', 30, 'maxDays', 45, 'ratePercent', 7.0, 'tenureMonths', 1),
       jsonb_build_object('label', '४६ ते १८० दिवस (46–180 days)', 'minDays', 46, 'maxDays', 180, 'ratePercent', 8.0, 'tenureMonths', 6),
       jsonb_build_object('label', '१८१ ते ३६५ दिवस (181–365 days)', 'minDays', 181, 'maxDays', 365, 'ratePercent', 10.0, 'tenureMonths', 12),
       jsonb_build_object('label', '३६६ व वरिल दिवस (366+ days)', 'minDays', 366, 'maxDays', null, 'ratePercent', 12.0, 'tenureMonths', 24),
       jsonb_build_object('label', 'दामदुप्पट योजना (Damduppat - 72 Months Double)', 'minDays', 2190, 'maxDays', 2190, 'ratePercent', 16.6667, 'tenureMonths', 72, 'isDamduppat', true)
     ),
     'note', 'Official Mahila Nagari Sahakari Patsanstha FD Rate Ladder'
   ),
   updated_at = now()
 WHERE key = 'rates.fd_tenure_tiers';
