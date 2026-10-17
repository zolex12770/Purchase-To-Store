import { describe, it, expect } from 'vitest';
import {
  autoFrozenRight, columnKind, planLegacyFooter, sentenceCaseHeader, type FooterSlot, type MeasuredColumn,
} from './dataTableModel';

describe('sentenceCaseHeader', () => {
  it('lower-cases every word after the first', () => {
    expect(sentenceCaseHeader('Pending Value')).toBe('Pending value');
    expect(sentenceCaseHeader('Item Description')).toBe('Item description');
  });

  it('keeps acronyms and words with digits', () => {
    expect(sentenceCaseHeader('Pending GRN Qty')).toBe('Pending GRN qty');
    expect(sentenceCaseHeader('PO No')).toBe('PO no');
    expect(sentenceCaseHeader('1000pc Wt (Kg)')).toBe('1000pc wt (kg)');
    expect(sentenceCaseHeader('Live Weight (Kg / Ton)')).toBe('Live weight (kg / ton)');
    expect(sentenceCaseHeader('GRNs')).toBe('GRNs');
  });

  it('leaves blanks alone', () => {
    expect(sentenceCaseHeader('')).toBe('');
  });
});

describe('columnKind', () => {
  it('recognises status columns by key or header', () => {
    expect(columnKind({ key: 'status', header: 'Status' })).toBe('status');
    expect(columnKind({ key: 'stock_status', header: 'Stock Status' })).toBe('status');
    expect(columnKind({ key: 'state', header: 'Stock status' })).toBe('status');
  });

  it('recognises row-action columns', () => {
    expect(columnKind({ key: 'actions', header: 'Actions', locked: true })).toBe('actions');
    expect(columnKind({ key: 'view', header: '' })).toBe('actions');
    expect(columnKind({ key: 'x', header: ' ' })).toBe('actions');
  });

  it('treats everything else as data', () => {
    expect(columnKind({ key: 'amount', header: 'Amount' })).toBe('data');
    expect(columnKind({ key: 'origin', header: 'Sheet check' })).toBe('data');
  });
});

describe('autoFrozenRight', () => {
  const col = (key: string, kind: MeasuredColumn['kind'], width: number): MeasuredColumn => ({ key, kind, width });
  const data = [col('code', 'data', 130), col('desc', 'data', 320), col('qty', 'data', 110)];

  it('freezes a trailing status column (the PO list: Status off-screen at 1366, audit UI-007)', () => {
    expect(autoFrozenRight([...data, col('status', 'status', 155)], 1080)).toEqual(['status']);
  });

  it('freezes a narrow actions column together with the status column before it', () => {
    expect(autoFrozenRight([...data, col('status', 'status', 130), col('actions', 'actions', 82)], 1080))
      .toEqual(['status', 'actions']);
    expect(autoFrozenRight([...data, col('actions', 'actions', 96)], 1080)).toEqual(['actions']);
  });

  // RM workspace, review 2026-10-16: a 263 px Receive/Issue/Adjust column was
  // pinned over the Status column at 1366 and 1440.
  it('never pins a wide actions column; the status column before it freezes alone', () => {
    expect(autoFrozenRight([...data, col('status', 'status', 110), col('actions', 'actions', 263)], 1080))
      .toEqual(['status']);
    expect(autoFrozenRight([...data, col('actions', 'actions', 263)], 1080)).toEqual([]);
  });

  it('never pins actions alone over a status column too wide to pin with them', () => {
    expect(autoFrozenRight([...data, col('status', 'status', 240), col('actions', 'actions', 96)], 1080)).toEqual([]);
  });

  it('does not freeze a trailing data column, or a status column that is not near the end', () => {
    expect(autoFrozenRight([col('status', 'status', 120), ...data], 1080)).toEqual([]);
    expect(autoFrozenRight([...data, col('status', 'status', 120), col('grns', 'data', 80)], 1080)).toEqual([]);
  });

  it('keeps the frozen group within its share of a narrow table', () => {
    // 130 + 82 = 212 px is more than 35 % of a 500 px table; status alone (130) fits.
    expect(autoFrozenRight([...data, col('status', 'status', 130), col('actions', 'actions', 82)], 500)).toEqual(['status']);
    expect(autoFrozenRight([...data, col('status', 'status', 190)], 400)).toEqual([]);
  });

  it('freezes nothing until the columns are measured', () => {
    expect(autoFrozenRight([...data, col('status', 'status', 0)], 0)).toEqual([]);
    expect(autoFrozenRight([], 1000)).toEqual([]);
  });
});

describe('planLegacyFooter', () => {
  // PoList's default columns and its hand-built totals row: "Page totals"
  // over colSpan 7, then PO qty, pending qty, amount, pending value and a
  // blank under Status — 12 spans written for what are 10 columns.
  const ALL = ['no', 'date', 'supplier', 'type', 'terms', 'lines', 'poqty', 'recvqty', 'pendqty', 'amount', 'received', 'pending', 'grns', 'status'];
  const OPTIONAL = new Set(['terms', 'recvqty', 'received', 'grns']);
  const DEFAULTS = ALL.filter((k) => !OPTIONAL.has(k));
  const SPANS = [7, 1, 1, 1, 1, 1];
  const LABEL = 0, POQTY = 1, PENDQTY = 2, AMOUNT = 3, PENDING = 4, STATUS_BLANK = 5;

  /** Which original cell sits under each visible column (label repeated over its span). */
  const under = (plan: FooterSlot[] | null, visible: string[]): Record<string, number | null> => {
    expect(plan).not.toBeNull();
    const out: Record<string, number | null> = {};
    for (const slot of plan!) for (let i = 0; i < slot.span; i++) out[visible[slot.start + i]!] = slot.cell;
    expect(Object.keys(out)).toEqual(visible);
    return out;
  };

  it('lays the default columns as v2 showed them: label over five, totals under their columns', () => {
    const map = under(planLegacyFooter(SPANS, DEFAULTS, DEFAULTS), DEFAULTS);
    expect(map).toEqual({
      no: LABEL, date: LABEL, supplier: LABEL, type: LABEL, lines: LABEL,
      poqty: POQTY, pendqty: PENDQTY, amount: AMOUNT, pending: PENDING, status: STATUS_BLANK,
    });
  });

  // Review 2026-10-16: with "GRNs" shown, the amount appeared under "Pending value".
  it('keeps every total under its own header when an optional column is shown in the middle', () => {
    const visible = ALL.filter((k) => !OPTIONAL.has(k) || k === 'grns');
    const map = under(planLegacyFooter(SPANS, DEFAULTS, visible), visible);
    expect(map.amount).toBe(AMOUNT);
    expect(map.pending).toBe(PENDING);
    expect(map.grns).toBeNull();
    expect(map.status).toBe(STATUS_BLANK);
  });

  it('gives a shown optional column a blank cell rather than the next total', () => {
    const visible = ALL.filter((k) => !OPTIONAL.has(k) || k === 'recvqty');
    const map = under(planLegacyFooter(SPANS, DEFAULTS, visible), visible);
    expect(map.poqty).toBe(POQTY);
    expect(map.recvqty).toBeNull();
    expect(map.pendqty).toBe(PENDQTY);
  });

  it('widens the label over an optional column shown inside it', () => {
    const visible = ALL.filter((k) => !OPTIONAL.has(k) || k === 'terms');
    const plan = planLegacyFooter(SPANS, DEFAULTS, visible)!;
    expect(plan[0]).toEqual({ cell: LABEL, span: 6, start: 0 });
    expect(under(plan, visible).poqty).toBe(POQTY);
  });

  it('drops the total of a column the user hid, and shrinks the label with hidden leading columns', () => {
    const visible = DEFAULTS.filter((k) => k !== 'amount' && k !== 'type');
    const plan = planLegacyFooter(SPANS, DEFAULTS, visible)!;
    expect(plan.some((s) => s.cell === AMOUNT)).toBe(false);
    expect(plan[0]).toEqual({ cell: LABEL, span: 4, start: 0 });
    expect(under(plan, visible).pending).toBe(PENDING);
  });

  it('shows every optional column at once without moving a total', () => {
    const map = under(planLegacyFooter(SPANS, DEFAULTS, ALL), ALL);
    expect([map.poqty, map.pendqty, map.amount, map.pending]).toEqual([POQTY, PENDQTY, AMOUNT, PENDING]);
    expect([map.terms, map.recvqty, map.received, map.grns]).toEqual([LABEL, null, null, null]);
  });

  it('places a row of single cells one per column, left to right', () => {
    const cols = ['a', 'b', 'c'];
    expect(planLegacyFooter([1, 1, 1], cols, ['a', 'x', 'b', 'c'])).toEqual([
      { cell: 0, span: 1, start: 0 },
      { cell: null, span: 1, start: 1 },
      { cell: 1, span: 1, start: 2 },
      { cell: 2, span: 1, start: 3 },
    ]);
  });

  it('pads a short row with blanks under the columns it does not reach', () => {
    expect(planLegacyFooter([2, 1], ['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd'])).toEqual([
      { cell: 0, span: 2, start: 0 },
      { cell: 1, span: 1, start: 2 },
      { cell: null, span: 1, start: 3 },
    ]);
  });

  it('refuses a row it cannot match to the columns', () => {
    // Too many single cells: no label to absorb the excess.
    expect(planLegacyFooter([1, 1, 1, 1], ['a', 'b'], ['a', 'b'])).toBeNull();
    // A multi-column total split by a column shown between its columns.
    expect(planLegacyFooter([1, 2], ['a', 'b', 'c'], ['a', 'b', 'x', 'c'])).toBeNull();
    expect(planLegacyFooter([], ['a'], ['a'])).toBeNull();
    expect(planLegacyFooter([0, 1], ['a'], ['a'])).toBeNull();
  });
});
