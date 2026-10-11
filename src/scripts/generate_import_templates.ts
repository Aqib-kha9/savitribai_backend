import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import xlsx from 'xlsx';

import {
  SHEETS,
  README_ROWS,
  REFERENCE_ROWS,
  CUSTOMER_SHEETS,
  ACCOUNT_SHEETS,
  COLLECTION_SHEETS,
  type Sheet,
} from './import_template_spec.js';

/**
 * Production Excel-import template generator.
 *
 * WHY THIS EXISTS
 * ---------------
 * The earlier ad-hoc importer (src/scripts/master_import.ts) read free-form
 * column names from the client's sheets ('Customer Name', 'AC No',
 * 'Loan Amount', 'Disbursement Date', ...). Those headers do NOT match the
 * validated backend contract (Zod schemas in src/modules/<module>/*.schemas.ts)
 * nor the DB enum vocabulary (001_schema.sql CHECK constraints), so imports
 * mismatched and failed.
 *
 * This generator emits templates whose column headers are the EXACT backend
 * field names (and, for foreign keys the client cannot know, the human-readable
 * *Code fields that the importer resolves to UUIDs). Every allowed value is the
 * literal Zod enum value / seed reference code, so a correctly-filled sheet
 * imports with zero mapping errors.
 *
 * The column contract lives in one place: src/scripts/import_template_spec.ts
 * (also consumed by validate_import_templates.ts, the pre-import gate).
 *
 * Run:  npx tsx src/scripts/generate_import_templates.ts
 * Out:  docs/deliverables/import-templates/*.xlsx
 */

const OUT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/deliverables/import-templates');

function buildSheet(sheet: Sheet): xlsx.WorkSheet {
  const headers = sheet.cols.map((c) => c.header);
  const sample = sheet.cols.map((c) => c.sample);
  const ws = xlsx.utils.aoa_to_sheet([headers, sample]);
  ws['!cols'] = sheet.cols.map((c) => ({
    wch: Math.max(c.header.length + 2, Math.min(45, c.sample.length + 2), 12),
  }));
  return ws;
}

function buildInstructionsSheet(sheets: Sheet[]): xlsx.WorkSheet {
  const rows: string[][] = [['Sheet', 'Column (exact header)', 'Required', 'Format', 'Allowed values', 'Notes']];
  for (const sheet of sheets) {
    for (const col of sheet.cols) {
      rows.push([sheet.name, col.header, col.required ? 'YES' : 'optional', col.format, col.allowed, col.note]);
    }
  }
  const ws = xlsx.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 26 }, { wch: 26 }, { wch: 10 }, { wch: 24 }, { wch: 52 }, { wch: 64 }];
  return ws;
}

function buildReadmeSheet(): xlsx.WorkSheet {
  const ws = xlsx.utils.aoa_to_sheet(README_ROWS);
  ws['!cols'] = [{ wch: 110 }];
  return ws;
}

function buildReferenceSheet(): xlsx.WorkSheet {
  const ws = xlsx.utils.aoa_to_sheet(REFERENCE_ROWS);
  ws['!cols'] = [{ wch: 30 }, { wch: 34 }, { wch: 40 }, { wch: 90 }];
  return ws;
}

function writeWorkbook(fileName: string, sheetNames: string[]): void {
  const wb = xlsx.utils.book_new();
  const chosen = SHEETS.filter((s) => sheetNames.includes(s.name));
  xlsx.utils.book_append_sheet(wb, buildReadmeSheet(), 'READ ME');
  xlsx.utils.book_append_sheet(wb, buildInstructionsSheet(chosen), 'Instructions');
  for (const sheet of chosen) {
    xlsx.utils.book_append_sheet(wb, buildSheet(sheet), sheet.name);
  }
  xlsx.utils.book_append_sheet(wb, buildReferenceSheet(), 'Reference Data');
  const target = path.join(OUT_DIR, fileName);
  xlsx.writeFile(wb, target, { bookType: 'xlsx' });
  console.log(`  written: ${path.relative(process.cwd(), target)}`);
}

function main(): void {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const all = SHEETS.map((s) => s.name);

  console.log('Generating production import templates into docs/deliverables/import-templates ...');
  writeWorkbook('import-templates-MASTER-all-sheets.xlsx', all);
  writeWorkbook('01-customer-master-template.xlsx', CUSTOMER_SHEETS);
  writeWorkbook('02-accounts-master-template.xlsx', ACCOUNT_SHEETS);
  writeWorkbook('03-agent-collections-template.xlsx', COLLECTION_SHEETS);
  console.log('Done.');
}

main();
