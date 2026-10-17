/**
 * Inventory sheet model — the pure half of the inventory sync (no database, no network).
 *
 * The five inventory spreadsheets compute their own live stock per item code as
 *
 *   live stock = opening (from the Item Master tab)
 *              + Σ inward  for the months Apr-26 … Mar-27   (SUMIFS on the Month column)
 *              − Σ outward for the same months
 *              + Σ 'Stock Adjustment'!H for the code          (no month filter)
 *
 * and every inward SUMIFS reads only the store-VERIFIED quantity column. (Formulas read
 * from the sheets on 2026-10-16; see docs/INVENTORY_SHEETS.md.) This module reproduces
 * exactly that rule, so that the ERP's figure for every item can be proven equal to the
 * sheet's — and every row the sheet itself does not count is reported with the reason,
 * never silently dropped.
 */
import crypto from 'node:crypto';
import type { InventoryCategory } from '../../domain/inventory.js';

export type Cell = string | number | boolean | null | undefined;
export type Row = Cell[];

/* ── Configuration ──────────────────────────────────────────────────────────── */

export interface StockTabConfig {
  /** Exact tab name — several have double or trailing spaces. */
  tab: string;
  /** Sheet row number of the header row; data starts on the next row. */
  headerRow: number;
  /** Last column read for the item attributes (A … this). */
  lastCol: string;
  codeCol: number;
  descCol: number;
  qtyCol: number;
  /** Opening-balance column the live-stock formula adds (beyond column Z). */
  openingCol: string;
  /** Stock-adjustment column the live-stock formula adds (beyond column Z). */
  adjustmentCol: string;
  weightCol?: number;
  uomCol?: number;
  rackCol?: number;
  rateCol?: number;
  amountCol?: number;
  mainGroupCol?: number;
  weight1000pcCol?: number;
  defaultUom: string;
}

export interface MovementTabConfig {
  tab: string;
  slug: string;
  /** Sheet row number of the first data row. */
  firstRow: number;
  direction: 'IN' | 'OUT';
  txnType: string;
  codeCol: number;
  /** The quantity the sheet's live-stock formula sums. */
  qtyCol: number;
  /** The Month column the formula filters on ("Apr-26" …). */
  monthCol: number;
  dateCol: number;
  /**
   * The quantity a row carries before the store verifies it (e.g. "Qty enter by
   * Packing"). The sheet does NOT count it; it is used only to say why a row
   * with a blank verified quantity is not counted yet.
   */
  pendingQtyCol?: number;
  weightCol?: number;
  docNoCol?: number;
  refDocCol?: number;
  supplierCol?: number;
  poCol?: number;
  descCol?: number;
  uomCol?: number;
  rateCol?: number;
  amountCol?: number;
  deptCol?: number;
  typeCol?: number;
  fromLocationCol?: number;
  toLocationCol?: number;
  fallbackUom: string;
}

export interface CategorySheetConfig {
  category: InventoryCategory;
  spreadsheetId: string;
  stock: StockTabConfig;
  movements: MovementTabConfig[];
}

/** The 'Stock Adjustment' tab has the same layout in all five spreadsheets. */
export const ADJUSTMENT_TAB = {
  tab: 'Stock Adjustment',
  slug: 'ADJ',
  firstRow: 2,
  txnType: 'SHEET_ADJUSTMENT',
  dateCol: 1, findingsCol: 2, codeCol: 3, nameCol: 4, liveCol: 5, actualCol: 6,
  qtyCol: 7, approvalCol: 8, reasonCol: 9, remarksCol: 10,
} as const;

/** The financial year every stock tab is built around (twelve monthly columns). */
export const FY_START = { year: 2026, month: 4 };

export function financialYearMonths(start = FY_START): string[] {
  const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const out: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    const m = (start.month - 1 + i) % 12;
    const y = start.year + Math.floor((start.month - 1 + i) / 12);
    out.push(`${names[m]}-${String(y % 100).padStart(2, '0')}`);
  }
  return out;
}

const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

/**
 * The ranges one category is read with, in the order the parsers expect: stock tab,
 * its opening and adjustment columns, each movement tab, then 'Stock Adjustment'.
 * Shared by the sync and scripts/compute-stock-alignment.mjs, so both read the same cells.
 */
export function rangesFor(cfg: CategorySheetConfig): string[] {
  const s = cfg.stock;
  return [
    `${quoteTab(s.tab)}!A${s.headerRow}:${s.lastCol}`,
    `${quoteTab(s.tab)}!${s.openingCol}${s.headerRow}:${s.openingCol}`,
    `${quoteTab(s.tab)}!${s.adjustmentCol}${s.headerRow}:${s.adjustmentCol}`,
    ...cfg.movements.map((m) => `${quoteTab(m.tab)}!A${m.firstRow}:Z`),
    `${quoteTab(ADJUSTMENT_TAB.tab)}!A${ADJUSTMENT_TAB.firstRow}:K`,
  ];
}

export const INVENTORY_SHEETS: Record<InventoryCategory, CategorySheetConfig> = {
  RM: {
    category: 'RM',
    spreadsheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4',
    // G = BG + Σ GRN Inward!S + Σ Production Inward!I − Σ RM Outward!I + BM
    stock: {
      tab: 'RM Stock Live', headerRow: 9, lastCol: 'H',
      codeCol: 1, descCol: 2, mainGroupCol: 4, rackCol: 5, qtyCol: 6, weightCol: 6, amountCol: 7,
      openingCol: 'BG', adjustmentCol: 'BM', defaultUom: 'Kg',
    },
    movements: [
      {
        tab: 'GRN Inward', slug: 'GRN', firstRow: 8, direction: 'IN', txnType: 'GRN_INWARD',
        monthCol: 2, docNoCol: 4, dateCol: 5, supplierCol: 6, refDocCol: 7, codeCol: 9, descCol: 10,
        poCol: 11, uomCol: 15, rateCol: 17, qtyCol: 18, weightCol: 18, amountCol: 20, fallbackUom: 'Kg',
      },
      {
        tab: 'RM Outward', slug: 'OUT', firstRow: 8, direction: 'OUT', txnType: 'RM_OUTWARD',
        monthCol: 2, dateCol: 4, typeCol: 5, codeCol: 6, descCol: 7, qtyCol: 8, weightCol: 8,
        refDocCol: 9, docNoCol: 10, rateCol: 14, amountCol: 15, fallbackUom: 'Kg',
      },
      {
        tab: 'Production Inward', slug: 'PROD', firstRow: 8, direction: 'IN', txnType: 'PRODUCTION_INWARD',
        monthCol: 2, dateCol: 4, typeCol: 5, codeCol: 6, descCol: 7, qtyCol: 8, weightCol: 8,
        refDocCol: 9, docNoCol: 10, rateCol: 14, amountCol: 15, fallbackUom: 'Kg',
      },
    ],
  },
  FG: {
    category: 'FG',
    spreadsheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ',
    // H = BF + Σ 'Inward FG '!L (Verified Qty from Store) − Σ 'Outward FG'!G + BH
    stock: {
      tab: 'FG  Stock Live', headerRow: 11, lastCol: 'I',
      codeCol: 1, weight1000pcCol: 3, descCol: 5, rackCol: 6, qtyCol: 7, weightCol: 8,
      openingCol: 'BF', adjustmentCol: 'BH', defaultUom: 'Nos',
    },
    movements: [
      {
        tab: 'Inward FG ', slug: 'IN', firstRow: 7, direction: 'IN', txnType: 'PACKING_INWARD',
        monthCol: 1, dateCol: 2, docNoCol: 3, codeCol: 4, pendingQtyCol: 6, refDocCol: 7,
        qtyCol: 11, weightCol: 14, fallbackUom: 'Nos',
      },
      {
        tab: 'Outward FG', slug: 'OUT', firstRow: 7, direction: 'OUT', txnType: 'DISPATCH_OUTWARD',
        monthCol: 1, dateCol: 2, typeCol: 3, codeCol: 4, qtyCol: 6, refDocCol: 7, weightCol: 10,
        fallbackUom: 'Nos',
      },
    ],
  },
  TRADING: {
    category: 'TRADING',
    // The owner's list reads "…WnjU1DVE…"; that ID does not open. This one does (verified 2026-10-16).
    spreadsheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk',
    // H = BG + Σ 'Inward Trading'!J (Verified Qty from Store) − Σ 'Outward Trading '!I + BI
    stock: {
      tab: 'Trading Live Stock', headerRow: 9, lastCol: 'I',
      codeCol: 1, descCol: 2, mainGroupCol: 3, uomCol: 4, rackCol: 5, rateCol: 6, qtyCol: 7, amountCol: 8,
      openingCol: 'BG', adjustmentCol: 'BI', defaultUom: 'Nos',
    },
    movements: [
      {
        tab: 'Inward Trading', slug: 'IN', firstRow: 8, direction: 'IN', txnType: 'PURCHASE_INWARD',
        monthCol: 1, dateCol: 2, typeCol: 3, codeCol: 4, descCol: 5, uomCol: 7, pendingQtyCol: 8,
        qtyCol: 9, rateCol: 11, fallbackUom: 'Nos',
      },
      {
        tab: 'Outward Trading ', slug: 'OUT', firstRow: 7, direction: 'OUT', txnType: 'TRADING_ISSUE',
        monthCol: 1, dateCol: 2, typeCol: 3, codeCol: 4, descCol: 5, uomCol: 7, qtyCol: 8, refDocCol: 9,
        rateCol: 12, amountCol: 13, fallbackUom: 'Nos',
      },
    ],
  },
  WIP: {
    category: 'WIP',
    spreadsheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs',
    // K = BZ + Σ 'Inward WIP'!J (Verified Qty from Store) − Σ 'Outward WIP'!G + CD
    stock: {
      tab: 'WIP  Stock Live', headerRow: 10, lastCol: 'L',
      codeCol: 0, weight1000pcCol: 6, descCol: 8, rackCol: 9, qtyCol: 10, weightCol: 11,
      openingCol: 'BZ', adjustmentCol: 'CD', defaultUom: 'Nos',
    },
    movements: [
      {
        tab: 'Inward WIP', slug: 'IN', firstRow: 8, direction: 'IN', txnType: 'WIP_STAGE_INWARD',
        monthCol: 1, dateCol: 2, deptCol: 3, docNoCol: 4, codeCol: 5, pendingQtyCol: 7, refDocCol: 8,
        qtyCol: 9, weightCol: 12, fallbackUom: 'Nos',
      },
      {
        tab: 'Outward WIP', slug: 'OUT', firstRow: 8, direction: 'OUT', txnType: 'WIP_STAGE_OUTWARD',
        monthCol: 1, dateCol: 2, typeCol: 3, codeCol: 4, qtyCol: 6, refDocCol: 7, weightCol: 10,
        fallbackUom: 'Nos',
      },
    ],
  },
  GENERAL: {
    category: 'GENERAL',
    spreadsheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY',
    // H = BI + Σ GRN Register!S (Rec. Qty) − Σ Issue Register!N + BK
    stock: {
      tab: 'General Item Live Stock', headerRow: 7, lastCol: 'I',
      codeCol: 1, descCol: 2, mainGroupCol: 3, uomCol: 4, rackCol: 6, qtyCol: 7, amountCol: 8,
      openingCol: 'BI', adjustmentCol: 'BK', defaultUom: 'Nos',
    },
    movements: [
      {
        tab: 'GRN Register (Store Inward Entry)', slug: 'GRN', firstRow: 8, direction: 'IN', txnType: 'GRN_INWARD',
        monthCol: 2, docNoCol: 4, dateCol: 5, supplierCol: 6, refDocCol: 7, codeCol: 9, descCol: 10,
        poCol: 11, uomCol: 15, rateCol: 17, qtyCol: 18, amountCol: 20, fallbackUom: 'Nos',
      },
      {
        tab: 'Issue Register (Store Outward Entry)', slug: 'ISS', firstRow: 7, direction: 'OUT', txnType: 'STORE_ISSUE',
        docNoCol: 1, dateCol: 3, typeCol: 4, codeCol: 6, descCol: 7, fromLocationCol: 9, toLocationCol: 11,
        qtyCol: 13, uomCol: 14, rateCol: 15, amountCol: 16, monthCol: 17, fallbackUom: 'Nos',
      },
    ],
  },
};

/* ── Cell parsing ───────────────────────────────────────────────────────────── */

export function text(v: Cell): string {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\s+/g, ' ').trim();
}

/** A sheet formula error such as #REF! or #N/A. */
export function isSheetError(v: Cell): boolean {
  return typeof v === 'string' && /^#[A-Z0-9/!?]+/.test(v.trim());
}

/** Number from a cell; `null` when blank, NaN when present but not a number. */
export function num(v: Cell): number | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : Number.NaN;
  if (typeof v === 'boolean') return Number.NaN;
  const s = v.replace(/,/g, '').replace(/₹/g, '').trim();
  if (!s || s === '-') return null;
  if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(s)) return Number.NaN;
  return Number(s);
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Calendar date from a sheet cell as YYYY-MM-DD, or `null` when blank/unreadable.
 * Never falls back to "today" and never goes through `new Date(string)` (whose
 * result depends on the server's locale and time zone).
 */
export function sheetDate(v: Cell): string | null {
  if (v === undefined || v === null) return null;
  const valid = (y: number, m: number, d: number): string | null => {
    if (y < 2000 || y > 2100 || m < 1 || m > 12 || d < 1) return null;
    const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
    if (d > days) return null;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  };
  if (typeof v === 'number') {
    // Google Sheets serial day number (days since 1899-12-30).
    if (v < 36526 || v > 73051) return null;
    const ms = Math.round(v) * 86400000 + Date.UTC(1899, 11, 30);
    const d = new Date(ms);
    return valid(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
  }
  const s = String(v).trim();
  if (!s) return null;
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  if (m) return valid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return valid(y, Number(m[2]), Number(m[1]));
  }
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3,4})[-/ ,]+(\d{2}|\d{4})$/.exec(s);
  if (m) {
    const mon = MONTHS[m[2].toLowerCase()];
    const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mon ? valid(y, mon, Number(m[1])) : null;
  }
  return null;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

function sha(parts: Array<string | number | null>): string {
  return crypto.createHash('sha1').update(parts.map((p) => (p === null ? '' : String(p))).join('\u001f')).digest('hex').slice(0, 24);
}

/** Column letter(s) → zero-based index ("A" → 0, "BG" → 58). */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/* ── Exclusions ─────────────────────────────────────────────────────────────── */

export type ExclusionCode =
  | 'BLANK_ROW'
  | 'ZERO_QTY'
  | 'PENDING_VERIFICATION'
  | 'NO_ITEM_CODE'
  | 'NEGATIVE_QTY'
  | 'INVALID_QTY'
  | 'MONTH_NOT_COUNTED'
  | 'INVALID_DATE'
  | 'ITEM_NOT_IN_STOCK_SHEET'
  | 'NEGATIVE_STOCK'
  | 'DUPLICATE_CODE_CONFLICT';

/** Plain-language reason shown to store users. */
export const EXCLUSION_TEXT: Record<ExclusionCode, string> = {
  BLANK_ROW: 'Empty template row.',
  ZERO_QTY: 'Quantity is zero or blank — nothing to count.',
  PENDING_VERIFICATION: 'Waiting for store verification: the verified quantity is blank, so the sheet does not count this row yet.',
  NO_ITEM_CODE: 'Quantity entered without an item code — the sheet cannot count it. Fill the item code.',
  NEGATIVE_QTY: 'Negative quantity in a movement row. Check the entry.',
  INVALID_QTY: 'The quantity cell does not hold a number (for example #REF!). Fix the cell.',
  MONTH_NOT_COUNTED: 'The Month cell is blank or not a 2026-27 month, so the sheet\'s live stock does not count this row. Fix the Month cell.',
  INVALID_DATE: 'The date is missing or unreadable. The sheet still counts this row by its Month; fill the date so the ERP can record it.',
  ITEM_NOT_IN_STOCK_SHEET: 'This item code has no row in the live-stock tab, so the sheet never counts this movement. Add the item to the Item Master or correct the code.',
  NEGATIVE_STOCK: 'The sheet shows negative live stock for this item. Check its inward and outward entries.',
  DUPLICATE_CODE_CONFLICT: 'The same item code appears more than once in the live-stock tab with different figures.',
};

/** Exclusions that are only counted in the report (nothing to fix). */
export const REPORT_ONLY: ReadonlySet<ExclusionCode> = new Set(['BLANK_ROW', 'ZERO_QTY']);

export interface QuarantineCandidate {
  tab: string;
  rowNumber: number;
  code: ExclusionCode;
  reason: string;
  raw: Row;
  key: string;
  itemCode: string | null;
}

/* ── Stock tab ──────────────────────────────────────────────────────────────── */

export interface StockRecord {
  rowNumber: number;
  code: string;
  codeKey: string;
  description: string;
  liveQty: number;
  opening: number;
  adjustment: number;
  weightKg: number | null;
  uom: string;
  rack: string | null;
  mainGroup: string | null;
  rate: number;
  weight1000pc: number;
  rowCount: number;
}

export interface StockParse {
  sourceRows: number;
  blankRows: number;
  records: StockRecord[];
  duplicateRows: number;
  duplicateCodes: string[];
  quarantine: QuarantineCandidate[];
}

/**
 * `main` starts at the header row (main[0] is the header); `opening` and
 * `adjustment` are the single-column ranges read from the same header row.
 */
export function parseStockTab(cfg: StockTabConfig, main: Row[], opening: Row[], adjustment: Row[]): StockParse {
  const out: StockParse = { sourceRows: Math.max(0, main.length - 1), blankRows: 0, records: [], duplicateRows: 0, duplicateCodes: [], quarantine: [] };
  const byCode = new Map<string, StockRecord>();
  const dupSeen = new Map<string, number>();
  for (let i = 1; i < main.length; i += 1) {
    const row = main[i] ?? [];
    const rowNumber = cfg.headerRow + i;
    const code = text(row[cfg.codeCol]);
    const live = num(row[cfg.qtyCol]);
    const open = num(opening[i]?.[0]);
    const adj = num(adjustment[i]?.[0]);
    if (!code) {
      const meaningful = [live, open, adj].some((x) => x !== null && x !== 0 && !Number.isNaN(x));
      if (meaningful) {
        out.quarantine.push(candidate(cfg.tab, rowNumber, 'NO_ITEM_CODE', row, null));
      } else {
        out.blankRows += 1;
      }
      continue;
    }
    const codeKey = code.toUpperCase();
    const liveQty = live === null || Number.isNaN(live) ? 0 : live;
    const rec: StockRecord = {
      rowNumber, code, codeKey,
      description: text(row[cfg.descCol]) || code,
      liveQty: round4(liveQty),
      opening: round4(open === null || Number.isNaN(open) ? 0 : open),
      adjustment: round4(adj === null || Number.isNaN(adj) ? 0 : adj),
      weightKg: optNum(row, cfg.weightCol),
      uom: (cfg.uomCol !== undefined && text(row[cfg.uomCol])) || cfg.defaultUom,
      rack: (cfg.rackCol !== undefined && text(row[cfg.rackCol])) || null,
      mainGroup: (cfg.mainGroupCol !== undefined && text(row[cfg.mainGroupCol])) || null,
      rate: positiveOr0(row, cfg.rateCol),
      weight1000pc: positiveOr0(row, cfg.weight1000pcCol),
      rowCount: 1,
    };
    if (rec.rate === 0 && cfg.amountCol !== undefined && rec.liveQty > 0) {
      const amount = num(row[cfg.amountCol]);
      if (amount !== null && !Number.isNaN(amount) && amount > 0) rec.rate = round4(amount / rec.liveQty);
    }
    const first = byCode.get(codeKey);
    if (first) {
      first.rowCount += 1;
      out.duplicateRows += 1;
      dupSeen.set(codeKey, (dupSeen.get(codeKey) ?? 1) + 1);
      if (Math.abs(first.liveQty - rec.liveQty) > 0.0001 || Math.abs(first.opening - rec.opening) > 0.0001) {
        out.quarantine.push(candidate(cfg.tab, rowNumber, 'DUPLICATE_CODE_CONFLICT', row, code,
          `${EXCLUSION_TEXT.DUPLICATE_CODE_CONFLICT} Row ${first.rowNumber} shows ${first.liveQty}, row ${rowNumber} shows ${rec.liveQty}; the ERP uses row ${first.rowNumber}.`));
      }
      continue;
    }
    if (rec.liveQty < 0) {
      out.quarantine.push(candidate(cfg.tab, rowNumber, 'NEGATIVE_STOCK', row, code,
        `${EXCLUSION_TEXT.NEGATIVE_STOCK} Live stock shown: ${rec.liveQty}.`));
    }
    byCode.set(codeKey, rec);
    out.records.push(rec);
  }
  out.duplicateCodes = [...dupSeen.keys()];
  return out;
}

/* ── Movement tabs ──────────────────────────────────────────────────────────── */

export interface MovementRecord {
  rowNumber: number;
  code: string;
  codeKey: string;
  direction: 'IN' | 'OUT';
  qty: number;
  month: string;
  dateIso: string;
  weightKg: number | null;
  uom: string;
  rate: number;
  amount: number;
  docNo: string;
  refDoc: string;
  po: string;
  supplier: string;
  type: string;
  dept: string;
  fromLocation: string | null;
  toLocation: string | null;
  description: string;
  /** Content identity + occurrence number — stable when rows are inserted or deleted elsewhere. */
  key: string;
  /** Hash of the attributes that may be corrected in place (rate, description …). */
  attrHash: string;
  note: string | null;
}

export interface MovementParse {
  tab: string;
  sourceRows: number;
  blankRows: number;
  records: MovementRecord[];
  excluded: Partial<Record<ExclusionCode, number>>;
  /** Sample of row numbers per report-only exclusion (for the reconciliation report). */
  excludedRows: Partial<Record<ExclusionCode, number[]>>;
  /** Rows the sheet counts, but that its owner should still correct. */
  warnings: Partial<Record<'MONTH_CELL_IS_DATE', number>>;
  quarantine: QuarantineCandidate[];
}

export interface MovementContext {
  countedMonths: ReadonlySet<string>;
  /** Upper-cased item codes listed in the category's live-stock tab. */
  stockCodes: ReadonlySet<string>;
  /** Year Google Sheets resolves a "Mmm-YY" criterion in (defaults to this year). */
  criterionYear?: number;
}

const MONTH_LABEL = /^([A-Za-z]{3})-(\d{2})$/;

/**
 * The counted month a Month cell belongs to, exactly as SUMIFS(…, "Oct-26") decides:
 *  - a text cell equal to the label (any letter case) counts; and
 *  - Google Sheets also reads the criterion "Oct-26" as the DATE 26 Oct of the current
 *    year, so a Month cell holding that date counts too. That date is what Sheets
 *    stores when someone types "Oct-26" into a cell (verified on the WIP sheet,
 *    2026-10-16: three rows whose Month shows 26-10-26 are in its live stock).
 * Returns the label and whether it matched through the date reading.
 */
export function countedMonthOf(
  cell: Cell,
  counted: ReadonlySet<string>,
  criterionYear = new Date().getUTCFullYear(),
): { label: string; viaDate: boolean } | null {
  const t = text(cell);
  if (!t) return null;
  for (const label of counted) if (label.toLowerCase() === t.toLowerCase()) return { label, viaDate: false };
  const asDate = sheetDate(cell);
  if (!asDate) return null;
  for (const label of counted) {
    const m = MONTH_LABEL.exec(label);
    const mon = m ? MONTHS[m[1].toLowerCase()] : undefined;
    if (!m || !mon) continue;
    const day = Number(m[2]);
    if (asDate === `${criterionYear}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`) return { label, viaDate: true };
  }
  return null;
}

function optNum(row: Row, col: number | undefined): number | null {
  if (col === undefined) return null;
  const n = num(row[col]);
  return n === null || Number.isNaN(n) ? null : round4(n);
}

function positiveOr0(row: Row, col: number | undefined): number {
  const n = optNum(row, col);
  return n !== null && n > 0 ? n : 0;
}

function candidate(tab: string, rowNumber: number, code: ExclusionCode, raw: Row, itemCode: string | null, reason?: string): QuarantineCandidate {
  const cells = (raw ?? []).map((c) => text(c));
  while (cells.length && !cells[cells.length - 1]) cells.pop();
  return { tab, rowNumber, code, reason: reason ?? EXCLUSION_TEXT[code], raw: cells, key: sha([tab, code, ...cells]), itemCode };
}

function bump(p: MovementParse, code: ExclusionCode, rowNumber: number): void {
  p.excluded[code] = (p.excluded[code] ?? 0) + 1;
  const list = (p.excludedRows[code] ??= []);
  if (list.length < 50) list.push(rowNumber);
}

/** Gives identical problem rows distinct keys (row order), like identical movements. */
function numberDuplicateKeys(cands: QuarantineCandidate[]): void {
  const seen = new Map<string, number>();
  for (const c of cands) {
    const n = (seen.get(c.key) ?? 0) + 1;
    seen.set(c.key, n);
    c.key = `${c.key}:${n}`;
  }
}

/** `rows[0]` is sheet row `cfg.firstRow`. */
export function parseMovementTab(cfg: MovementTabConfig, rows: Row[], ctx: MovementContext): MovementParse {
  const p: MovementParse = { tab: cfg.tab, sourceRows: rows.length, blankRows: 0, records: [], excluded: {}, excludedRows: {}, warnings: {}, quarantine: [] };
  const ordinals = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const rowNumber = cfg.firstRow + i;
    const code = text(row[cfg.codeCol]);
    const rawQty = row[cfg.qtyCol];
    const qty = num(rawQty);
    const pending = cfg.pendingQtyCol !== undefined ? num(row[cfg.pendingQtyCol]) : null;
    const hasQty = qty !== null && !Number.isNaN(qty) && qty !== 0;

    if (!code) {
      if (hasQty) {
        p.quarantine.push(candidate(cfg.tab, rowNumber, 'NO_ITEM_CODE', row, null));
        bump(p, 'NO_ITEM_CODE', rowNumber);
      } else {
        p.blankRows += 1;
      }
      continue;
    }
    if (isSheetError(rawQty) || (qty !== null && Number.isNaN(qty))) {
      p.quarantine.push(candidate(cfg.tab, rowNumber, 'INVALID_QTY', row, code));
      bump(p, 'INVALID_QTY', rowNumber);
      continue;
    }
    if (!hasQty) {
      if (pending !== null && !Number.isNaN(pending) && pending > 0) {
        p.quarantine.push(candidate(cfg.tab, rowNumber, 'PENDING_VERIFICATION', row, code,
          `${EXCLUSION_TEXT.PENDING_VERIFICATION} Unverified quantity: ${pending}.`));
        bump(p, 'PENDING_VERIFICATION', rowNumber);
      } else {
        bump(p, 'ZERO_QTY', rowNumber);
      }
      continue;
    }
    if ((qty as number) < 0) {
      p.quarantine.push(candidate(cfg.tab, rowNumber, 'NEGATIVE_QTY', row, code));
      bump(p, 'NEGATIVE_QTY', rowNumber);
      continue;
    }
    const monthCell = countedMonthOf(row[cfg.monthCol], ctx.countedMonths, ctx.criterionYear);
    if (!monthCell) {
      p.quarantine.push(candidate(cfg.tab, rowNumber, 'MONTH_NOT_COUNTED', row, code,
        `${EXCLUSION_TEXT.MONTH_NOT_COUNTED} Month cell: "${text(row[cfg.monthCol]) || 'blank'}".`));
      bump(p, 'MONTH_NOT_COUNTED', rowNumber);
      continue;
    }
    const month = monthCell.label;
    const codeKey = code.toUpperCase();
    if (!ctx.stockCodes.has(codeKey)) {
      p.quarantine.push(candidate(cfg.tab, rowNumber, 'ITEM_NOT_IN_STOCK_SHEET', row, code));
      bump(p, 'ITEM_NOT_IN_STOCK_SHEET', rowNumber);
      continue;
    }
    const dateIso = sheetDate(row[cfg.dateCol]);
    if (!dateIso) {
      p.quarantine.push(candidate(cfg.tab, rowNumber, 'INVALID_DATE', row, code,
        `${EXCLUSION_TEXT.INVALID_DATE} Date cell: "${text(row[cfg.dateCol]) || 'blank'}".`));
      bump(p, 'INVALID_DATE', rowNumber);
      continue;
    }
    const q = round4(qty as number);
    const field = (col: number | undefined) => (col === undefined ? '' : text(row[col]));
    const docNo = field(cfg.docNoCol);
    const refDoc = field(cfg.refDocCol);
    const po = field(cfg.poCol);
    const supplier = field(cfg.supplierCol);
    const type = field(cfg.typeCol);
    const dept = field(cfg.deptCol);
    const fromLocation = field(cfg.fromLocationCol) || null;
    const toLocation = field(cfg.toLocationCol) || null;
    const base = sha([month, dateIso, codeKey, q.toFixed(4), docNo, refDoc, po, supplier, type, dept, fromLocation, toLocation]);
    const n = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, n);
    const weightKg = cfg.weightCol !== undefined ? optNum(row, cfg.weightCol) : null;
    const uom = field(cfg.uomCol) || cfg.fallbackUom;
    let rate = positiveOr0(row, cfg.rateCol);
    let amount = positiveOr0(row, cfg.amountCol);
    if (amount === 0 && rate > 0) amount = round4(rate * q);
    else if (rate === 0 && amount > 0) rate = round4(amount / q);
    const description = field(cfg.descCol);
    if (monthCell.viaDate) p.warnings.MONTH_CELL_IS_DATE = (p.warnings.MONTH_CELL_IS_DATE ?? 0) + 1;
    p.records.push({
      rowNumber, code, codeKey, direction: cfg.direction, qty: q, month, dateIso,
      weightKg, uom, rate, amount, docNo, refDoc, po, supplier, type, dept, fromLocation, toLocation, description,
      key: `${base}:${n}`,
      attrHash: sha([description, uom, rate.toFixed(4), amount.toFixed(4), weightKg === null ? '' : weightKg.toFixed(4)]),
      note: monthCell.viaDate
        ? `Month cell holds the date ${text(row[cfg.monthCol])}; the sheet counts it as ${month} — please re-type the Month as text.`
        : null,
    });
  }
  numberDuplicateKeys(p.quarantine);
  return p;
}

/* ── Stock Adjustment tab ───────────────────────────────────────────────────── */

/**
 * The live-stock formulas add SUMIFS('Stock Adjustment'!H, 'Stock Adjustment'!D, code)
 * with no month and no approval filter, so every row with a code and a non-zero H counts.
 * A counted row marked "Not Approved" is imported (to match the sheet) and flagged.
 */
export function parseAdjustmentTab(rows: Row[], ctx: Pick<MovementContext, 'stockCodes'>): MovementParse {
  const A = ADJUSTMENT_TAB;
  const p: MovementParse = { tab: A.tab, sourceRows: rows.length, blankRows: 0, records: [], excluded: {}, excludedRows: {}, warnings: {}, quarantine: [] };
  const ordinals = new Map<string, number>();
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] ?? [];
    const rowNumber = A.firstRow + i;
    const code = text(row[A.codeCol]);
    const qty = num(row[A.qtyCol]);
    const hasQty = qty !== null && !Number.isNaN(qty) && qty !== 0;
    if (!code) {
      if (hasQty) {
        p.quarantine.push(candidate(A.tab, rowNumber, 'NO_ITEM_CODE', row, null));
        bump(p, 'NO_ITEM_CODE', rowNumber);
      } else {
        p.blankRows += 1;
      }
      continue;
    }
    if (isSheetError(row[A.qtyCol]) || (qty !== null && Number.isNaN(qty))) {
      p.quarantine.push(candidate(A.tab, rowNumber, 'INVALID_QTY', row, code));
      bump(p, 'INVALID_QTY', rowNumber);
      continue;
    }
    if (!hasQty) {
      bump(p, 'ZERO_QTY', rowNumber);
      continue;
    }
    const codeKey = code.toUpperCase();
    if (!ctx.stockCodes.has(codeKey)) {
      p.quarantine.push(candidate(A.tab, rowNumber, 'ITEM_NOT_IN_STOCK_SHEET', row, code));
      bump(p, 'ITEM_NOT_IN_STOCK_SHEET', rowNumber);
      continue;
    }
    const dateIso = sheetDate(row[A.dateCol]);
    if (!dateIso) {
      p.quarantine.push(candidate(A.tab, rowNumber, 'INVALID_DATE', row, code,
        `${EXCLUSION_TEXT.INVALID_DATE} Date cell: "${text(row[A.dateCol]) || 'blank'}".`));
      bump(p, 'INVALID_DATE', rowNumber);
      continue;
    }
    const signed = round4(qty as number);
    const findings = text(row[A.findingsCol]);
    const reason = text(row[A.reasonCol]);
    const approval = text(row[A.approvalCol]);
    const base = sha([dateIso, codeKey, signed.toFixed(4), findings, reason]);
    const n = (ordinals.get(base) ?? 0) + 1;
    ordinals.set(base, n);
    const notApproved = /not\s*approved|reject/i.test(approval);
    p.records.push({
      rowNumber, code, codeKey,
      direction: signed > 0 ? 'IN' : 'OUT',
      qty: Math.abs(signed), month: '', dateIso,
      weightKg: null, uom: '', rate: 0, amount: 0,
      docNo: '', refDoc: '', po: '', supplier: '', type: findings, dept: '',
      fromLocation: null, toLocation: null,
      description: text(row[A.nameCol]),
      key: `${base}:${n}`,
      attrHash: sha([approval, text(row[A.remarksCol]), text(row[A.liveCol]), text(row[A.actualCol])]),
      note: [
        findings && `Findings: ${findings}`,
        reason && `Reason: ${reason}`,
        approval ? `HOD approval: ${approval}` : 'HOD approval: blank',
        text(row[A.remarksCol]) && `Remarks: ${text(row[A.remarksCol])}`,
        notApproved ? 'Counted by the sheet although not approved' : '',
      ].filter(Boolean).join(' | '),
    });
  }
  numberDuplicateKeys(p.quarantine);
  return p;
}

/* ── Per-item proof ─────────────────────────────────────────────────────────── */

export interface ItemReconciliation {
  codeKey: string;
  sheetLive: number;
  opening: number;
  inward: number;
  outward: number;
  adjustment: number;
  computed: number;
  difference: number;
  matched: boolean;
}

/**
 * opening + inward − outward + adjustments, from the rows the ERP imported,
 * compared with the live stock the sheet itself shows.
 */
export function reconcileItems(
  stock: StockRecord[],
  totals: Map<string, { inward: number; outward: number; adjustment: number }>,
): ItemReconciliation[] {
  return stock.map((s) => {
    const t = totals.get(s.codeKey) ?? { inward: 0, outward: 0, adjustment: 0 };
    const computed = round4(s.opening + t.inward - t.outward + t.adjustment);
    const difference = round4(s.liveQty - computed);
    return {
      codeKey: s.codeKey, sheetLive: s.liveQty, opening: s.opening,
      inward: round4(t.inward), outward: round4(t.outward), adjustment: round4(t.adjustment),
      computed, difference,
      // The sheet's formulas add floating-point figures; anything under a
      // thousandth of a unit is display rounding, not a missing movement.
      matched: Math.abs(difference) < 0.001,
    };
  });
}
