import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { pool, transaction } from '../database/client.js';

function parseDate(dStr: string) {
  const parts = dStr.split('-');
  if (parts.length === 3) {
     return parts[2] + '-' + parts[1] + '-' + parts[0];
  }
  return null;
}

async function run() {
  const tsvData = fs.readFileSync('C:\\\\Users\\\\Aqib\\\\.gemini\\\\antigravity-ide\\\\brain\\\\42695d6f-6161-4967-8807-d3e71649d762\\\\scratch\\\\loan_data.tsv', 'utf8');

  await transaction(async (client) => {
    console.log('Truncating customer table and all dependent tables (CASCADE)...');
    await client.query('TRUNCATE TABLE customer CASCADE');
    console.log('Dummy data deleted.');

    const branchRes = await client.query('SELECT id FROM branch LIMIT 1');
    const branchId = branchRes.rows[0].id;

    let productRes = await client.query("SELECT id FROM loan_product LIMIT 1");
    let productId = productRes.rows[0]?.id;

    if (!productId) {
       const res = await client.query(
         "INSERT INTO loan_product (name, is_active, minimum_amount, maximum_amount, default_tenure_months, default_interest_rate, repayment_frequency, interest_method, created_by) VALUES ('Daily Loan', true, 1000, 100000, 12, 10.00, 'daily', 'flat', NULL) RETURNING id"
       );
       productId = res.rows[0].id;
    }

    const lines = tsvData.trim().split('\n');
    
    for (let i = 1; i < lines.length; i++) {
       const line = lines[i];
       if (!line) continue;
       const row = line.split('\t');
       const customerName = row[1];
       const acNo = row[2];
       const loanAmount = row[3];
       const disbursementDate = row[4] ?? '';

       if (!customerName || !acNo || !loanAmount) continue;

       // 1. Insert customer
       const mobileNo = '99999999' + i.toString().padStart(2, '0');
       const custRes = await client.query(
         "INSERT INTO customer (branch_id, customer_number, full_name, mobile, status, registration_date) VALUES ($1, $2, $3, $4, 'active', $5) RETURNING id",
         [branchId, 'CUST-' + acNo, customerName, mobileNo, parseDate(disbursementDate) || '2026-09-01']
       );
       
       const customerId = custRes.rows[0].id;

       // 2. Insert loan application
       const appRes = await client.query(
         "INSERT INTO loan_application (application_number, customer_id, product_id, purpose, requested_amount, approved_amount, tenure_months, repayment_frequency, proposed_interest_rate, status) VALUES ($1, $2, $3, 'Business', $4, $4, 12, 'daily', 10.00, 'disbursed') RETURNING id",
         ['APP-' + acNo, customerId, productId, loanAmount]
       );
       const appId = appRes.rows[0].id;

       // 3. Insert loan
       const loanRes = await client.query(
         "INSERT INTO loan (loan_number, application_id, customer_id, product_id, branch_id, status, approved_amount, disbursed_amount, disbursed_on, tenure_months, repayment_frequency, interest_method, interest_rate, flat_interest_total, total_payable, total_paid, outstanding_amount) VALUES ($1, $2, $3, $4, $5, 'active', $6, $6, $7, 12, 'daily', 'flat', 10.00, 0, $6, 0, $6) RETURNING id",
         ['LN-' + acNo, appId, customerId, productId, branchId, loanAmount, parseDate(disbursementDate) || '2026-09-01']
       );

       console.log('Created Customer: ' + customerName + ' with Loan: ' + loanAmount);
    }

    console.log('Finished seeding real loan data.');
  });
}

run().catch(console.error).finally(() => pool.end());
