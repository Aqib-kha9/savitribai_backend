import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import xlsx from 'xlsx';

import {
  SHEETS,
  RE_MONEY,
  RE_RATE,
  RE_DATE,
  RE_DATETIME,
  RE_INT,
  RE_EMAIL,
  type Col,
  type Sheet,
} from './import_template_spec.js';

/**
 * Pre-import gate for the Excel templates.
 *
 * Runs the SAME rules the backend Zod schemas enforce, directly on the .xlsx
 * the client returns, so a mismatch is caught BEFORE the DB is touched.
 *
 * Checks:
 *   1. Every expected sheet is present.
 *   2. Header row matches the contract EXACTLY (names + order).
 *   3. Required cells are filled; enums/money/rate/date/boolean/integer/email
 *      match the exact regex/enum from the Zod schemas.
 *   4. Join keys resolve: every customerRef in sheets 2–12 exists in sheet 1;
 *      every agentCode in sheet 12 exists in sheet 13.
 *   5. Collection productType matches the accountRef number prefix.
 *
 * Run:
 *   npx tsx src/scripts/validate_import_templates.ts <path-to-workbook.xlsx>
 *   npx tsx src/scripts/validate_import_templates.ts            (validates the MASTER)
 *
 * Exit code 0 = all good; 1 = errors found (fix the sheet and re-run).
 */

const DEFAULT_FILE = path.resolve(
  path.dirname(path.resolve(process.cwd(), 'backend/src/scripts/validate_import_templates.ts')),
  '../../../docs/deliverables/import-templates/import-templates-MASTER-all-sheets.xlsx',
);

const MASTER_REL = 'docs/deliverables/import-templates/import-templates-MASTER-all-sheets.xlsx';

function resolveInput(): string {
  const arg = process.argv[2];
  if (arg) return path.resolve(arg);
  // Prefer the MASTER relative to the repo root, else cwd.
  const fromRoot = path.resolve(process.cwd(), MASTER_REL);
  if (fs.existsSync(fromRoot)) return fromRoot;
  const fromBackend = path.resolve(process.cwd(), '../', MASTER_REL);
  if (fs.existsSync(fromBackend)) return fromBackend;
  return DEFAULT_FILE;
}

type Issue = { sheet: string; row: number; column: string; message: string };

const issues: Issue[] = [];

function add(sheet: string, row: number, column: string, message: string): void {
  issues.push({ sheet, row, column, message });
}

function cellToString(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (value instanceof Date) {
    const y = value.getUTCFullYear();
    const m = String(value.getUTCMonth() + 1).padStart(2, '0');
    const d = String(value.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).trim();
}

function isBlank(value: string): boolean {
  return value === '';
}

function validateCell(sheet: string, row: number, col: Col, raw: string): void {
  const value = raw;
  if (isBlank(value)) {
    if (col.required) add(sheet, row, col.header, 'Required but empty.');
    return;
  }
  switch (col.kind) {
    case 'money': {
      if (!RE_MONEY.test(value)) add(sheet, row, col.header, `Invalid money "${value}". Expected /^\\d{1,12}(\\.\\d{1,2})?$/.`);
      else if (Number(value) <= 0) add(sheet, row, col.header, 'Money must be greater than 0.');
      break;
    }
    case 'rate': {
      if (!RE_RATE.test(value)) add(sheet, row, col.header, `Invalid rate "${value}". Expected /^\\d{1,3}(\\.\\d{1,4})?$/.`);
      else {
        const n = Number(value);
        if (n <= 0 || n > 25) add(sheet, row, col.header, `Rate must be > 0 and <= 25 (got ${n}).`);
      }
      break;
    }
    case 'date': {
      if (!RE_DATE.test(value)) add(sheet, row, col.header, `Invalid date "${value}". Expected YYYY-MM-DD.`);
      else if (Number.isNaN(Date.parse(value))) add(sheet, row, col.header, `Impossible date "${value}".`);
      break;
    }
    case 'datetime': {
      if (!RE_DATETIME.test(value)) add(sheet, row, col.header, `Invalid instant "${value}". Expected ISO-8601 (YYYY-MM-DDThh:mm:ss[Z|±hh:mm]).`);
      break;
    }
    case 'boolean': {
      const up = value.toUpperCase();
      if (up !== 'TRUE' && up !== 'FALSE') add(sheet, row, col.header, `Invalid boolean "${value}". Use TRUE or FALSE.`);
      break;
    }
    case 'integer': {
      if (!RE_INT.test(value)) add(sheet, row, col.header, `Invalid integer "${value}".`);
      break;
    }
    case 'enum': {
      const values = col.values ?? [];
      if (!values.includes(value)) add(sheet, row, col.header, `Invalid value "${value}". Allowed: ${values.join(' | ')}.`);
      break;
    }
    case 'ref':
    case 'text':
    default: {
      if (col.header.toLowerCase().includes('email') && !RE_EMAIL.test(value)) {
        add(sheet, row, col.header, `Invalid email "${value}".`);
      }
      if (col.maxLen && value.length > col.maxLen) add(sheet, row, col.header, `Too long (${value.length} > ${col.maxLen}).`);
      break;
    }
  }
}

function readSheetRows(wb: xlsx.WorkBook, sheetName: string): string[][] | null {
  const ws = wb.Sheets[sheetName];
  if (!ws) return null;
  return (xlsx.utils.sheet_to_json(ws, { header: 1, blankrows: false, defval: '' }) as unknown[][]).map((row) =>
    row.map((v) => cellToString(v)),
  );
}

function validateSheet(wb: xlsx.WorkBook, sheet: Sheet, presentSheets: Set<string>): void {
  if (!presentSheets.has(sheet.name)) {
    add(sheet.name, 0, '—', 'Sheet is missing from the workbook.');
    return;
  }
  const rows = readSheetRows(wb, sheet.name);
  if (!rows || rows.length === 0) {
    add(sheet.name, 1, '—', 'Sheet is empty (no header row).');
    return;
  }
  const expected = sheet.cols.map((c) => c.header);
  const actual = rows[0] ?? [];
  const headerOk = actual.length === expected.length && expected.every((h, i) => actual[i] === h);
  if (!headerOk) {
    add(sheet.name, 1, '—', `Header mismatch. Expected [${expected.join(', ')}] but found [${actual.join(', ')}]. Do not rename/reorder headers.`);
    return; // Row-level validation is meaningless if headers are wrong.
  }
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r];
    if (!row) continue;
    // Skip a fully-blank row.
    if (row.every((v) => isBlank(v))) continue;
    const excelRow = r + 1;
    for (let c = 0; c < sheet.cols.length; c += 1) {
      const col = sheet.cols[c];
      if (!col) continue;
      validateCell(sheet.name, excelRow, col, row[c] ?? '');
    }
  }
}

function crossChecks(wb: xlsx.WorkBook, presentSheets: Set<string>): void {
  const hasCustomers = presentSheets.has('1. Customers');
  const customerRefs = new Set<string>();
  if (hasCustomers) {
    const rows = readSheetRows(wb, '1. Customers') ?? [];
    for (let r = 1; r < rows.length; r += 1) {
      const ref = (rows[r]?.[0] ?? '').trim();
      if (ref) {
        if (customerRefs.has(ref)) add('1. Customers', r + 1, 'customerRef', `Duplicate customerRef "${ref}".`);
        customerRefs.add(ref);
      }
    }
  }

  const agentCodes = new Set<string>();
  if (presentSheets.has('13. Agents')) {
    const rows = readSheetRows(wb, '13. Agents') ?? [];
    for (let r = 1; r < rows.length; r += 1) {
      const code = (rows[r]?.[1] ?? '').trim(); // agentCode
      if (code) agentCodes.add(code);
    }
  }

  if (hasCustomers) {
    const refSheets = [
      '2. Addresses',
      '3. Nominees',
      '4. Customer KYC Documents',
      '5. Customer Consents',
      '6. Savings Accounts',
      '7. RD Accounts',
      '8. FD Accounts',
      '9. Loan Applications',
      '10. Loan Guarantors',
      '11. Loan Collateral',
      '12. Agent Collections',
    ];
    for (const name of refSheets) {
      if (!presentSheets.has(name)) continue;
      const rows = readSheetRows(wb, name) ?? [];
      const header = rows[0] ?? [];
      const refIdx = header.indexOf('customerRef');
      if (refIdx < 0) continue;
      for (let r = 1; r < rows.length; r += 1) {
        const ref = (rows[r]?.[refIdx] ?? '').trim();
        if (ref && !customerRefs.has(ref)) {
          add(name, r + 1, 'customerRef', `Unknown customerRef "${ref}" (no row on "1. Customers").`);
        }
      }
    }
  }

  // Guarantor customer ref must also exist.
  if (hasCustomers && presentSheets.has('10. Loan Guarantors')) {
    const rows = readSheetRows(wb, '10. Loan Guarantors') ?? [];
    const header = rows[0] ?? [];
    const idx = header.indexOf('guarantorCustomerRef');
    if (idx >= 0) {
      for (let r = 1; r < rows.length; r += 1) {
        const ref = (rows[r]?.[idx] ?? '').trim();
        if (ref && !customerRefs.has(ref)) {
          add('10. Loan Guarantors', r + 1, 'guarantorCustomerRef', `Unknown guarantorCustomerRef "${ref}".`);
        }
      }
    }
  }

  // Agent collections: agentCode must exist in sheet 13 (when present) and the
  // accountRef prefix must match productType.
  if (presentSheets.has('12. Agent Collections')) {
    const rows = readSheetRows(wb, '12. Agent Collections') ?? [];
    const header = rows[0] ?? [];
    const aIdx = header.indexOf('agentCode');
    const pIdx = header.indexOf('productType');
    const accIdx = header.indexOf('accountRef');
    const prefixByType: Record<string, string[]> = {
      savingsDeposit: ['S.A.L.A'],
      recurringDeposit: ['R.D.A'],
      loan: ['L.A.'],
      penalty: ['S.A.L.A', 'R.D.A', 'L.A.'],
    };
    for (let r = 1; r < rows.length; r += 1) {
      if (aIdx >= 0) {
        const code = (rows[r]?.[aIdx] ?? '').trim();
        if (code && agentCodes.size > 0 && !agentCodes.has(code)) {
          add('12. Agent Collections', r + 1, 'agentCode', `Unknown agentCode "${code}" (not on "13. Agents").`);
        }
      }
      if (pIdx >= 0 && accIdx >= 0) {
        const type = (rows[r]?.[pIdx] ?? '').trim();
        const acc = (rows[r]?.[accIdx] ?? '').trim();
        const prefixes = prefixByType[type];
        if (acc && prefixes && !prefixes.some((p) => acc.startsWith(p))) {
          add('12. Agent Collections', r + 1, 'accountRef', `Account "${acc}" does not match productType "${type}" (expected prefix ${prefixes.join(' / ')}).`);
        }
      }
    }
  }
}

function main(): void {
  const file = resolveInput();
  if (!fs.existsSync(file)) {
    console.error(`File not found: ${file}`);
    process.exit(2);
  }
  const wb = xlsx.readFile(file);
  const present = new Set(wb.SheetNames);

  console.log(`Validating: ${path.relative(process.cwd(), file)}`);
  console.log(`Sheets found: ${wb.SheetNames.join(' | ')}\n`);

  for (const sheet of SHEETS) validateSheet(wb, sheet, present);
  crossChecks(wb, present);

  if (issues.length === 0) {
    console.log('OK — workbook fully matches the import contract. Safe to import.');
    process.exit(0);
  }

  console.log(`Found ${issues.length} issue(s):\n`);
  for (const it of issues) {
    console.log(`  [${it.sheet}] row ${it.row} · ${it.column}: ${it.message}`);
  }
  console.log('\nFix the workbook and re-run. Exit 1.');
  process.exit(1);
}

main();
