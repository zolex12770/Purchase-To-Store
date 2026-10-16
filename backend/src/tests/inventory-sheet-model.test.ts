/**
 * Unit tests — the pure sheet rules (sheet-model.ts). No database, no network.
 */
import { describe, it, expect } from 'vitest';
import {
  sheetDate, num, financialYearMonths, colIndex, parseMovementTab, parseStockTab, parseAdjustmentTab,
  countedMonthOf, INVENTORY_SHEETS, type Row,
} from '../modules/inventory/sheet-model.js';

describe('sheetDate', () => {
  it('reads the formats the sheets show, as calendar dates (no time zone shift)', () => {
    expect(sheetDate('01-06-26')).toBe('2026-06-01');
    expect(sheetDate('31/08/2026')).toBe('2026-08-31');
    expect(sheetDate('03-Jul-26')).toBe('2026-07-03');
    expect(sheetDate('2026-10-02')).toBe('2026-10-02');
    expect(sheetDate(46204)).toBe('2026-07-01'); // serial day number
  });
  it('never invents a date', () => {
    for (const v of ['', ' ', '-', 'N/A', 'Pending', '31-02-26', '00-01-26', '01-13-26', undefined, null, 12]) {
      expect(sheetDate(v as never)).toBeNull();
    }
  });
});

describe('num', () => {
  it('distinguishes blank, numbers and non-numbers', () => {
    expect(num('')).toBeNull();
    expect(num(undefined)).toBeNull();
    expect(num('1,234.50')).toBe(1234.5);
    expect(num(-3)).toBe(-3);
    expect(Number.isNaN(num('#REF!') as number)).toBe(true);
    expect(Number.isNaN(num('12 kg') as number)).toBe(true);
  });
});

describe('financial-year months and column letters', () => {
  it('lists the twelve months the stock tabs count', () => {
    expect(financialYearMonths()).toEqual(['Apr-26', 'May-26', 'Jun-26', 'Jul-26', 'Aug-26', 'Sep-26', 'Oct-26', 'Nov-26', 'Dec-26', 'Jan-27', 'Feb-27', 'Mar-27']);
  });
  it('maps the opening/adjustment columns used by the live-stock formulas', () => {
    expect(colIndex('A')).toBe(0);
    expect(colIndex('Z')).toBe(25);
    expect(colIndex('BG')).toBe(58);
    expect(colIndex('CD')).toBe(81);
  });
});

describe('parseMovementTab — FG Inward counts the store-verified quantity only', () => {
  const cfg = INVENTORY_SHEETS.FG.movements[0];
  const ctx = { countedMonths: new Set(financialYearMonths()), stockCodes: new Set(['RB168', 'ZKR106']) };
  const row = (month: string, date: string, code: string, packingQty: number | string, verifiedQty: number | string): Row => {
    const r: Row = new Array(22).fill('');
    r[1] = month; r[2] = date; r[3] = 'CT1'; r[4] = code; r[6] = packingQty; r[11] = verifiedQty;
    return r;
  };
  it('uses Verified Qty; a row with only the packing quantity waits for verification', () => {
    const p = parseMovementTab(cfg, [
      row('May-26', '21-05-26', 'RB168', 10000, 9800),
      row('May-26', '22-05-26', 'RB168', 500, ''),
      row('', '23-05-26', 'RB168', 0, 100),
      row('Jun-26', '01-06-26', 'NOT-LISTED', 0, 5),
      row('Jun-26', '', 'ZKR106', 0, 5),
      row('Jun-26', '02-06-26', 'ZKR106', 0, '#REF!'),
    ], ctx);
    expect(p.records.map((r) => [r.rowNumber, r.qty])).toEqual([[7, 9800]]);
    expect(p.excluded).toEqual({ PENDING_VERIFICATION: 1, MONTH_NOT_COUNTED: 1, ITEM_NOT_IN_STOCK_SHEET: 1, INVALID_DATE: 1, INVALID_QTY: 1 });
    expect(p.quarantine.find((q) => q.code === 'PENDING_VERIFICATION')!.reason).toMatch(/Unverified quantity: 500/);
  });
  it('gives identical rows distinct, stable identities that survive a row inserted above', () => {
    const a = row('Jun-26', '01-06-26', 'ZKR106', 0, 5);
    const first = parseMovementTab(cfg, [a, a], ctx).records.map((r) => r.key);
    expect(new Set(first).size).toBe(2);
    const shifted = parseMovementTab(cfg, [row('Jul-26', '01-07-26', 'RB168', 0, 1), a, a], ctx).records.map((r) => r.key);
    expect(shifted.slice(1)).toEqual(first);
  });
});

describe('countedMonthOf — the Month column, as SUMIFS reads it', () => {
  const counted = new Set(financialYearMonths());
  it('counts the text label in any letter case', () => {
    expect(countedMonthOf('Oct-26', counted, 2026)).toEqual({ label: 'Oct-26', viaDate: false });
    expect(countedMonthOf('MAY-26', counted, 2026)).toEqual({ label: 'May-26', viaDate: false });
  });
  it('counts a Month cell that Sheets turned into the date 26 Oct (typed "Oct-26"), and nothing else', () => {
    expect(countedMonthOf('26-10-26', counted, 2026)).toEqual({ label: 'Oct-26', viaDate: true });
    expect(countedMonthOf('27-01-26', counted, 2026)).toEqual({ label: 'Jan-27', viaDate: true });
    expect(countedMonthOf('10-10-26', counted, 2026)).toBeNull();
    expect(countedMonthOf('Mar-26', counted, 2026)).toBeNull();
    expect(countedMonthOf('Feb-01', counted, 2026)).toBeNull();
    expect(countedMonthOf('', counted, 2026)).toBeNull();
  });
});

describe('parseStockTab and parseAdjustmentTab', () => {
  it('reports duplicate codes and negative stock; blank template rows are only counted', () => {
    const cfg = INVENTORY_SHEETS.GENERAL.stock;
    const main: Row[] = [
      ['Sr', 'Code'],
      [1, 'A1', 'Item', '', 'Nos', '', 'R', 10],
      [2, 'A1', 'Item', '', 'Nos', '', 'R', 10],
      [3, 'B1', 'Item', '', 'Nos', '', 'R', -2],
      [4, '', '', '', '', '', '', 0],
    ];
    const p = parseStockTab(cfg, main, [['Opening'], [4], [4], [0], ['']], [['Adj'], [0], [0], [0], ['']]);
    expect(p.records.map((r) => [r.code, r.liveQty, r.opening, r.rowCount])).toEqual([['A1', 10, 4, 2], ['B1', -2, 0, 1]]);
    expect(p.duplicateCodes).toEqual(['A1']);
    expect(p.blankRows).toBe(1);
    expect(p.quarantine.map((q) => q.code)).toEqual(['NEGATIVE_STOCK']);
  });
  it('signs adjustments as the sheet adds them, and flags a counted row that is not approved', () => {
    const p = parseAdjustmentTab([
      [1, '31-Aug-26', 'Physical Stock Gap', 'A1', 'Item', 96.6, 36.5, -60.1, 'Approved'],
      [2, '31-Aug-26', 'Physical Stock Gap', 'A1', 'Item', 50.8, 55.1, 4.3, 'Not Approved'],
      [3, '31-Aug-26', 'Physical Stock Gap', 'A1', 'Item', '', '', '', 'Not Approved'],
      ['', '', '', '', '', '', '', '', '', '', '', '', '', '', 'ZR7000'],
    ], { stockCodes: new Set(['A1']) });
    expect(p.records.map((r) => [r.direction, r.qty])).toEqual([['OUT', 60.1], ['IN', 4.3]]);
    expect(p.records[1].note).toMatch(/not approved/i);
    expect(p.excluded).toEqual({ ZERO_QTY: 1 });
    expect(p.blankRows).toBe(1);
  });
});
