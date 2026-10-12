/**
 * SQL vs Google: does the replica actually say what the database says?
 *
 * Row counts matching proves nothing — two tabs can have identical row counts
 * and disagree in every cell — so this compares VALUES, per record, per column,
 * and classifies each record as MATCH / MISMATCH / MISSING IN GOOGLE / EXTRA IN
 * GOOGLE, plus duplicate keys within the tab.
 *
 * Comparison is deliberately tolerant in exactly two ways, both of them
 * properties of Sheets rather than of the data:
 *
 *   • Numbers. A cell holding 6 and a cell holding "6.0000" are the same
 *     quantity; Sheets may hand either back depending on how it stored it.
 *   • Dates and timestamps. Compared as instants, not as characters.
 *
 * Anything else is a real difference and is reported as one, with the record
 * key, the column, and both values — so a mismatch can be investigated rather
 * than merely counted.
 *
 * This is the only code path besides the import that downloads whole tabs, and
 * it is explicitly invoked, never on a timer.
 */
import { query } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BUSINESS_VIEWS, viewBySheet } from './views/index.js';
import { buildPagedSql } from './views/types.js';
import { KEY_SEPARATOR } from './schema.js';
import { cellsOf, headerOf } from './render.js';
import { readTab } from './client.js';

const PAGE = 1000;
const MAX_SAMPLES = 25;
const yieldLoop = () => new Promise((r) => setImmediate(r));

export interface CellDifference {
  key: string;
  column: string;
  sql: string;
  google: string;
}

export interface SheetReconciliation {
  sheet: string;
  headerMatches: boolean;
  headerDetail?: string;
  sqlRows: number;
  googleRows: number;
  match: number;
  mismatch: number;
  missingInGoogle: number;
  extraInGoogle: number;
  duplicateInGoogle: number;
  samples: CellDifference[];
  missingKeys: string[];
  extraKeys: string[];
  error?: string;
}

export interface ReconcileReport {
  sheets: SheetReconciliation[];
  totals: {
    sqlRows: number; googleRows: number;
    match: number; mismatch: number;
    missingInGoogle: number; extraInGoogle: number; duplicateInGoogle: number;
  };
  clean: boolean;
  message: string;
}

/** Same value, allowing for how Sheets stores numbers and dates. */
export function sameCell(sql: string, google: string): boolean {
  if (sql === google) return true;
  const a = sql.trim();
  const b = google.trim();
  if (a === b) return true;
  if (a === '' || b === '') return false;

  const na = Number(a);
  const nb = Number(b);
  if (a !== '' && b !== '' && !Number.isNaN(na) && !Number.isNaN(nb)) {
    return Math.abs(na - nb) < 0.00005;
  }

  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta === tb;

  return false;
}

export async function reconcileSheets(sheets?: string[]): Promise<ReconcileReport> {
  const views = BUSINESS_VIEWS.filter((v) => !sheets?.length || sheets.includes(v.sheet));
  const results: SheetReconciliation[] = [];
  for (const view of views) {
    results.push(await reconcileOne(view.sheet));
    await yieldLoop();
  }

  const totals = results.reduce((acc, r) => ({
    sqlRows: acc.sqlRows + r.sqlRows,
    googleRows: acc.googleRows + r.googleRows,
    match: acc.match + r.match,
    mismatch: acc.mismatch + r.mismatch,
    missingInGoogle: acc.missingInGoogle + r.missingInGoogle,
    extraInGoogle: acc.extraInGoogle + r.extraInGoogle,
    duplicateInGoogle: acc.duplicateInGoogle + r.duplicateInGoogle,
  }), {
    sqlRows: 0, googleRows: 0, match: 0, mismatch: 0,
    missingInGoogle: 0, extraInGoogle: 0, duplicateInGoogle: 0,
  });

  const clean = totals.mismatch === 0 && totals.missingInGoogle === 0
    && totals.extraInGoogle === 0 && totals.duplicateInGoogle === 0
    && results.every((r) => !r.error && r.headerMatches);

  return {
    sheets: results,
    totals,
    clean,
    message: clean
      ? `All ${results.length} tab(s) reconcile exactly: ${totals.match} record(s) compared, zero differences.`
      : `${totals.match} matching, ${totals.mismatch} mismatched, ${totals.missingInGoogle} missing in Google, `
        + `${totals.extraInGoogle} extra in Google, ${totals.duplicateInGoogle} duplicate key(s).`,
  };
}

async function reconcileOne(sheet: string): Promise<SheetReconciliation> {
  const view = viewBySheet(sheet)!;
  const base: SheetReconciliation = {
    sheet, headerMatches: false, sqlRows: 0, googleRows: 0,
    match: 0, mismatch: 0, missingInGoogle: 0, extraInGoogle: 0, duplicateInGoogle: 0,
    samples: [], missingKeys: [], extraKeys: [],
  };

  let grid: string[][];
  try {
    grid = await readTab(sheet);
  } catch (err) {
    return { ...base, error: err instanceof Error ? err.message : String(err) };
  }

  const wanted = headerOf(view);
  const actual = grid[0] ?? [];
  const headerMatches = wanted.length === actual.length && wanted.every((h, i) => h === actual[i]);
  const headerDetail = headerMatches
    ? undefined
    : `sheet header has ${actual.length} column(s), the view declares ${wanted.length}`
      + (actual.length ? `; first difference at column ${wanted.findIndex((h, i) => h !== actual[i]) + 1}` : '');

  // Index the sheet by the view's business key.
  const keyIdx = view.primaryKey.map((p) => actual.indexOf(p));
  const googleRows = new Map<string, string[]>();
  let duplicates = 0;
  for (let r = 1; r < grid.length; r += 1) {
    const cells = grid[r] ?? [];
    if (cells.every((c) => c === '')) continue;
    const key = keyIdx.map((i) => (i >= 0 ? (cells[i] ?? '') : '')).join(KEY_SEPARATOR);
    if (key.split(KEY_SEPARATOR).every((p) => p === '')) continue;
    if (googleRows.has(key)) { duplicates += 1; continue; }
    googleRows.set(key, cells);
  }

  const result: SheetReconciliation = {
    ...base, headerMatches, headerDetail, googleRows: googleRows.size, duplicateInGoogle: duplicates,
  };

  // Walk SQL in pages so a 100,000-row tab never materialises at once.
  const seen = new Set<string>();
  for (let offset = 0; ; offset += PAGE) {
    const rows = await query<Record<string, unknown>>(buildPagedSql(view, PAGE, offset));
    if (rows.length === 0) break;

    for (const row of rows) {
      result.sqlRows += 1;
      const key = view.primaryKey.map((p) => String(row[p] ?? '')).join(KEY_SEPARATOR);
      seen.add(key);

      const sqlCells = cellsOf(view, row);
      const sheetCells = googleRows.get(key);
      if (!sheetCells) {
        result.missingInGoogle += 1;
        if (result.missingKeys.length < MAX_SAMPLES) result.missingKeys.push(key);
        continue;
      }

      let rowDiffers = false;
      for (let c = 0; c < wanted.length; c += 1) {
        // Compare by HEADER NAME, not by position: a tab whose columns were
        // reordered by hand would otherwise report every cell as wrong.
        const at = actual.indexOf(wanted[c]!);
        const googleValue = at >= 0 ? (sheetCells[at] ?? '') : '';
        if (sameCell(sqlCells[c] ?? '', googleValue)) continue;
        rowDiffers = true;
        if (result.samples.length < MAX_SAMPLES) {
          result.samples.push({ key, column: wanted[c]!, sql: sqlCells[c] ?? '', google: googleValue });
        }
      }
      if (rowDiffers) result.mismatch += 1; else result.match += 1;
    }

    if (rows.length < PAGE) break;
    await yieldLoop();
  }

  for (const key of googleRows.keys()) {
    if (seen.has(key)) continue;
    result.extraInGoogle += 1;
    if (result.extraKeys.length < MAX_SAMPLES) result.extraKeys.push(key);
  }

  logger.debug(
    `Google replica reconcile ${sheet}: ${result.match} match, ${result.mismatch} mismatch, `
    + `${result.missingInGoogle} missing, ${result.extraInGoogle} extra.`,
  );
  return result;
}
