-- Migration 014: Official RD Scheme Configuration and Rate Card Settings
-- Updates rd_scheme table for RD-MTH with 12 to 120 months window and client rate card.
-- Upserts schemes.rd_monthly_returns in app_setting for production DB persistence.

INSERT INTO rd_scheme
  (code, name, frequency, min_instalment_amount, max_instalment_amount,
   min_duration_months, max_duration_months, grace_period_months,
   interest_rate, interest_credit_frequency, early_closure_fee_percent, is_active)
VALUES
  ('RD-MTH', 'आकर्षक आवर्त ठेव (RD) योजना (12–120 Months)', 'monthly', 500.00, 50000.00,
   12, 120, 1, 12.0000, 'yearly', 4.00, true)
ON CONFLICT (code) DO UPDATE
  SET name = EXCLUDED.name,
      min_duration_months = EXCLUDED.min_duration_months,
      max_duration_months = EXCLUDED.max_duration_months,
      min_instalment_amount = EXCLUDED.min_instalment_amount,
      max_instalment_amount = EXCLUDED.max_instalment_amount,
      interest_rate = EXCLUDED.interest_rate,
      is_active = true,
      updated_at = now();

INSERT INTO app_setting (key, value, category, description)
VALUES (
  'schemes.rd_monthly_returns',
  '{
    "currency": "INR",
    "instalmentFrequency": "monthly",
    "tenureMonths": [12, 24, 36, 48, 60, 72, 84, 96, 108, 120],
    "note": "Official client RD rate card (आकर्षक आवर्त ठेव योजना तक्ता). Base maturity per ₹1000/mo: 12M: 12780, 24M: 27240, 36M: 43560, 48M: 62400, 60M: 83250, 72M: 106560, 84M: 133980, 96M: 163200, 108M: 195480, 120M: 234000.",
    "rows": [
      { "instalment": "500.00", "returns": { "12": 6390, "24": 13620, "36": 21780, "48": 31200, "60": 41625, "72": 53280, "84": 66990, "96": 81600, "108": 97740, "120": 117000 } },
      { "instalment": "1000.00", "returns": { "12": 12780, "24": 27240, "36": 43560, "48": 62400, "60": 83250, "72": 106560, "84": 133980, "96": 163200, "108": 195480, "120": 234000 } },
      { "instalment": "2000.00", "returns": { "12": 25560, "24": 54480, "36": 87120, "48": 124800, "60": 166500, "72": 213120, "84": 267960, "96": 326400, "108": 390960, "120": 468000 } },
      { "instalment": "3000.00", "returns": { "12": 38340, "24": 81720, "36": 130680, "48": 187200, "60": 249750, "72": 319680, "84": 401940, "96": 489600, "108": 586440, "120": 702000 } },
      { "instalment": "4000.00", "returns": { "12": 51120, "24": 108960, "36": 174240, "48": 249600, "60": 333000, "72": 426240, "84": 535920, "96": 652800, "108": 781920, "120": 936000 } },
      { "instalment": "5000.00", "returns": { "12": 63900, "24": 136200, "36": 217800, "48": 312000, "60": 416250, "72": 532800, "84": 669900, "96": 816000, "108": 977400, "120": 1170000 } }
    ]
  }'::jsonb,
  'schemes',
  'Official RD rate card (₹500–₹5000/month, 12–120 months)'
)
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description,
      updated_at = now();
