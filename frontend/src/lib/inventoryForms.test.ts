import { describe, it, expect } from 'vitest';
import { sameId, rowById, countAfterBookRead, rateAfterItemChoice } from './inventoryForms';

describe('sameId and rowById: ids from PGlite (numbers) and from a PostgreSQL server (strings)', () => {
  // A workspace row as DB_DRIVER=pg sends it: bigint ids are strings.
  const pgRows = [{ id: '501', item_code: 'A' }, { id: '502', item_code: 'B' }];
  const pgliteRows = [{ id: 501, item_code: 'A' }, { id: 502, item_code: 'B' }];

  it('finds the row the picker returned, whichever form either side is in', () => {
    // The picker's lookup was rows.find((r) => r.id === Number(v)): nothing on pg.
    expect(pgRows.find((r) => (r.id as unknown) === Number('502'))).toBeUndefined();
    expect(rowById(pgRows, 502)?.item_code).toBe('B');
    expect(rowById(pgRows, '502')?.item_code).toBe('B');
    expect(rowById(pgliteRows, '501')?.item_code).toBe('A');
    expect(rowById(pgliteRows, 501)?.item_code).toBe('A');
  });

  it('never matches a missing id', () => {
    expect(sameId(null, null)).toBe(false);
    expect(sameId(undefined, undefined)).toBe(false);
    expect(sameId(0, null)).toBe(false);
    expect(sameId('', 0)).toBe(false);
    expect(rowById(pgRows, null)).toBeUndefined();
    expect(sameId(7, '7')).toBe(true);
    expect(sameId(7, 8)).toBe(false);
  });
});

describe('countAfterBookRead: the physical count pre-fill (T2 review of E2E S5-18)', () => {
  it('pre-fills an untouched count with the book stock once it is read', () => {
    expect(countAfterBookRead('', false, 26)).toBe('26');
    expect(countAfterBookRead('', false, null)).toBe('');
  });

  it('follows the book stock while untouched: a refused count re-reads 27 and the field shows 27, not the old 26', () => {
    // The pre-fill rule was (c) => (c === '' ? String(book) : c): 26 stayed, a shortfall of 1 nobody counted.
    expect(countAfterBookRead('26', false, 27)).toBe('27');
    expect(countAfterBookRead('0', false, 4.5)).toBe('4.5');
  });

  it('keeps a figure the counter typed, also when the book stock changes', () => {
    expect(countAfterBookRead('24', true, 27)).toBe('24');
    expect(countAfterBookRead('', true, 27)).toBe('');
  });
});

describe('rateAfterItemChoice: the movement form rate when an item is chosen (probe C28-RATE)', () => {
  it("shows the chosen item's own rate, also when a first choice had filled the field", () => {
    expect(rateAfterItemChoice('', false, 8)).toBe('8');
    // The rule was "fill only an empty field": choosing 1161110001 (21) after 1161070001 (8) kept 8.
    expect(rateAfterItemChoice('8', false, 21)).toBe('21');
    expect(rateAfterItemChoice('8', false, 0)).toBe('');
    expect(rateAfterItemChoice('8', false, undefined)).toBe('');
  });

  it('keeps a rate the user typed; an emptied field takes the item rate again', () => {
    expect(rateAfterItemChoice('19.5', true, 21)).toBe('19.5');
    expect(rateAfterItemChoice('', true, 21)).toBe('21');
    expect(rateAfterItemChoice('  ', true, 21)).toBe('21');
  });
});
