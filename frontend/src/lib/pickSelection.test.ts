import { describe, it, expect } from 'vitest';
import {
  groupRows, groupState, toggleOne, toggleGroup, documentCount, lockedSupplier,
} from './pickSelection';
import { consolidateEligibleLines, type EligibleIndentLine } from './consolidateIndentLines';

interface Line { id: number; doc: number; supplier: number }

const L = (id: number, doc: number, supplier = 1): Line => ({ id, doc, supplier });
const idOf = (l: Line) => l.id;
const docOf = (l: Line) => l.doc;

// Two documents: doc 10 has lines 1,2,3 — doc 20 has lines 4,5.
const rows = [L(1, 10), L(2, 10), L(3, 10), L(4, 20), L(5, 20)];
const doc10 = rows.filter((r) => r.doc === 10);
const doc20 = rows.filter((r) => r.doc === 20);

describe('groupRows', () => {
  it('groups by document and keeps the order rows arrived in', () => {
    const groups = groupRows(rows, docOf);
    expect(groups.map((g) => g.key)).toEqual([10, 20]);
    expect(groups[0]!.rows.map(idOf)).toEqual([1, 2, 3]);
    expect(groups[1]!.rows.map(idOf)).toEqual([4, 5]);
  });
});

describe('the three selection cases', () => {
  it('case 1 — one document, all of its lines', () => {
    const picked = toggleGroup(new Map<number, Line>(), doc10, idOf);
    expect([...picked.keys()]).toEqual([1, 2, 3]);
    expect(groupState(picked, doc10, idOf)).toBe('all');
    expect(groupState(picked, doc20, idOf)).toBe('none');
    expect(documentCount(picked, docOf)).toBe(1);
  });

  it('case 2 — several documents, all of their lines, onto one selection', () => {
    let picked = toggleGroup(new Map<number, Line>(), doc10, idOf);
    picked = toggleGroup(picked, doc20, idOf);
    expect([...picked.keys()].sort()).toEqual([1, 2, 3, 4, 5]);
    expect(documentCount(picked, docOf)).toBe(2);
  });

  it('case 3 — only some lines of several documents', () => {
    let picked = toggleOne(new Map<number, Line>(), rows[1]!, idOf);   // line 2 of doc 10
    picked = toggleOne(picked, rows[4]!, idOf);                         // line 5 of doc 20
    expect([...picked.keys()].sort()).toEqual([2, 5]);
    expect(groupState(picked, doc10, idOf)).toBe('some');
    expect(groupState(picked, doc20, idOf)).toBe('some');
    expect(documentCount(picked, docOf)).toBe(2);
  });
});

describe('toggling', () => {
  it('unticking one line leaves every other ticked line alone', () => {
    let picked = toggleGroup(new Map<number, Line>(), rows, idOf);
    picked = toggleOne(picked, rows[2]!, idOf);
    expect([...picked.keys()].sort()).toEqual([1, 2, 4, 5]);
  });

  it('ticking a document that is partly ticked completes it rather than clearing it', () => {
    const partly = toggleOne(new Map<number, Line>(), rows[0]!, idOf);
    const picked = toggleGroup(partly, doc10, idOf);
    expect(groupState(picked, doc10, idOf)).toBe('all');
  });

  it('ticking a fully ticked document clears only that document', () => {
    let picked = toggleGroup(new Map<number, Line>(), doc10, idOf);
    picked = toggleGroup(picked, doc20, idOf);
    picked = toggleGroup(picked, doc10, idOf);
    expect([...picked.keys()].sort()).toEqual([4, 5]);
  });

  it('never mutates the map it was given', () => {
    const before = new Map<number, Line>();
    toggleOne(before, rows[0]!, idOf);
    toggleGroup(before, doc10, idOf);
    expect(before.size).toBe(0);
  });
});

describe('lines that cannot be picked', () => {
  const other = [L(6, 30, 2), L(7, 30, 2)];           // a different supplier's PO
  const onlySupplier1 = (l: Line) => l.supplier === 1;

  it('a document select-all skips blocked lines', () => {
    const mixed = [L(8, 40, 1), L(9, 40, 2)];
    const picked = toggleGroup(new Map<number, Line>(), mixed, idOf, onlySupplier1);
    expect([...picked.keys()]).toEqual([8]);
    expect(groupState(picked, mixed, idOf, onlySupplier1)).toBe('all');
  });

  it('a wholly blocked document cannot be ticked and reads as not selected', () => {
    const picked = toggleGroup(new Map<number, Line>(), other, idOf, onlySupplier1);
    expect(picked.size).toBe(0);
    expect(groupState(picked, other, idOf, onlySupplier1)).toBe('none');
  });
});

describe('lockedSupplier', () => {
  it('is null until something is ticked, then the supplier of what was ticked', () => {
    const none = new Map<number, Line>();
    expect(lockedSupplier(none, (l) => l.supplier)).toBeNull();
    const picked = toggleOne(none, L(1, 10, 7), idOf);
    expect(lockedSupplier(picked, (l) => l.supplier)).toBe(7);
  });

  it('releases the lock again when the last line is unticked', () => {
    const line = L(1, 10, 7);
    let picked = toggleOne(new Map<number, Line>(), line, idOf);
    picked = toggleOne(picked, line, idOf);
    expect(lockedSupplier(picked, (l) => l.supplier)).toBeNull();
  });
});

describe('selection feeds PO consolidation', () => {
  const E = (lineId: number, indentId: number, itemId: number, pending: string): EligibleIndentLine => ({
    indent_line_id: lineId, indent_id: indentId, indent_no: `IND-${indentId}`, line_no: lineId,
    item_id: itemId, item_code: `ITEM-${itemId}`, item_description: `Item ${itemId}`, item_specification: '',
    indent_qty: pending, pending_qty: pending, estimated_rate: null, uom_id: null,
  });
  // Indent 1: items A(100) and B(50). Indent 2: items A(30) and C(20).
  const all = [E(1, 1, 100, '100'), E(2, 1, 200, '50'), E(3, 2, 100, '30'), E(4, 2, 300, '20')];
  const lineId = (e: EligibleIndentLine) => e.indent_line_id;

  it('some items of two indents become one PO, each line traceable to its indent', () => {
    // Item A from BOTH indents, and item C from indent 2 — item B is left for later.
    let picked = toggleOne(new Map<number, EligibleIndentLine>(), all[0]!, lineId);
    picked = toggleOne(picked, all[2]!, lineId);
    picked = toggleOne(picked, all[3]!, lineId);

    const lines = consolidateEligibleLines([...picked.values()]);
    expect(lines.map((l) => l.itemId)).toEqual([100, 300]);

    const a = lines.find((l) => l.itemId === 100)!;
    expect(a.poQty).toBe('130');
    expect(a.sources.map((s) => [s.indentId, s.consumedQty])).toEqual([[1, '100'], [2, '30']]);

    const c = lines.find((l) => l.itemId === 300)!;
    expect(c.poQty).toBe('20');
    expect(c.sources.map((s) => s.indentId)).toEqual([2]);
  });
});
