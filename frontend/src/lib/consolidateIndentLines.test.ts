import { describe, expect, it } from 'vitest';
import {
  consolidateEligibleLines, reallocateSources, indentQtyOfSources, type ConsolidatedSource, type EligibleIndentLine,
} from './consolidateIndentLines';

let seq = 0;
const row = (overrides: Partial<EligibleIndentLine> & { item_id: number }): EligibleIndentLine => {
  seq += 1;
  return {
    indent_line_id: seq,
    indent_id: seq,
    indent_no: `IND-${String(seq).padStart(3, '0')}`,
    line_no: 1,
    item_code: `ITM-${overrides.item_id}`,
    item_description: `Item ${overrides.item_id}`,
    item_specification: '',
    indent_qty: overrides.pending_qty ?? '1',
    pending_qty: overrides.pending_qty ?? '1',
    estimated_rate: null,
    uom_id: null,
    ...overrides,
  };
};

describe('consolidateEligibleLines', () => {
  it('1. Pen on three indents (2 + 3 + 1) consolidates to one line of 6', () => {
    const rows = [
      row({ item_id: 1, indent_no: 'IND-001', pending_qty: '2' }),
      row({ item_id: 1, indent_no: 'IND-002', pending_qty: '3' }),
      row({ item_id: 1, indent_no: 'IND-004', pending_qty: '1' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(1);
    expect(result[0].poQty).toBe('6');
    expect(result[0].sources).toHaveLength(3);
    expect(result[0].sources.map((s) => `${s.indentNo}->${s.consumedQty}`)).toEqual([
      'IND-001->2', 'IND-002->3', 'IND-004->1',
    ]);
  });

  it('2. the five-indent worked example: Pen=6, Pencil=5, Notebook=4, as three separate lines', () => {
    const rows = [
      row({ item_id: 1, indent_no: 'IND-001', pending_qty: '2' }), // Pen
      row({ item_id: 1, indent_no: 'IND-002', pending_qty: '3' }), // Pen
      row({ item_id: 2, indent_no: 'IND-003', pending_qty: '5' }), // Pencil
      row({ item_id: 1, indent_no: 'IND-004', pending_qty: '1' }), // Pen
      row({ item_id: 3, indent_no: 'IND-005', pending_qty: '4' }), // Notebook
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(3);
    const byItem = new Map(result.map((r) => [r.itemId, r]));
    expect(byItem.get(1)?.poQty).toBe('6');
    expect(byItem.get(1)?.sources).toHaveLength(3);
    expect(byItem.get(2)?.poQty).toBe('5');
    expect(byItem.get(3)?.poQty).toBe('4');
  });

  it('3. previously-ordered quantity is respected globally (pending_qty already nets it out)', () => {
    // IND-001 Pen: indent 10, already ordered 4, pending 6
    // IND-002 Pen: indent 5,  already ordered 2, pending 3
    // IND-004 Pen: indent 1,  already ordered 0, pending 1
    const rows = [
      row({ item_id: 1, indent_no: 'IND-001', indent_qty: '10', pending_qty: '6' }),
      row({ item_id: 1, indent_no: 'IND-002', indent_qty: '5', pending_qty: '3' }),
      row({ item_id: 1, indent_no: 'IND-004', indent_qty: '1', pending_qty: '1' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(1);
    expect(result[0].indentQty).toBe('16');
    expect(result[0].poQty).toBe('10');
  });

  it('4. partial PO — the default (full available) quantity can be reduced downstream without losing source traceability', () => {
    const rows = [
      row({ item_id: 1, indent_no: 'IND-001', pending_qty: '6' }),
      row({ item_id: 1, indent_no: 'IND-002', pending_qty: '3' }),
      row({ item_id: 1, indent_no: 'IND-004', pending_qty: '1' }),
    ];
    const [line] = consolidateEligibleLines(rows);
    expect(line.poQty).toBe('10'); // full available offered as the default PO qty
    // Ordering only 6 of the 10 is a downstream edit to poQty; it must not
    // touch the source list, which is what the remaining-4 figure is computed from.
    const ordered = { ...line, poQty: '6' };
    expect(ordered.sources.reduce((sum, s) => sum + Number(s.consumedQty), 0)).toBe(10);
    expect(Number(line.poQty) - Number(ordered.poQty)).toBe(4); // remaining, available for a future PO
  });

  it('5. different items never merge, even with an identical description', () => {
    const rows = [
      row({ item_id: 1, item_description: 'Stationery Item', pending_qty: '2' }),
      row({ item_id: 2, item_description: 'Stationery Item', pending_qty: '3' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(2);
  });

  it('6. same description, different item IDs — must NOT merge', () => {
    const rows = [
      row({ item_id: 1, item_code: 'PEN-A', item_description: 'Pen', pending_qty: '2' }),
      row({ item_id: 99, item_code: 'PEN-B', item_description: 'Pen', pending_qty: '5' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.itemId === 1)?.poQty).toBe('2');
    expect(result.find((r) => r.itemId === 99)?.poQty).toBe('5');
  });

  it('7. zero remaining quantity is preserved, not dropped or turned into NaN', () => {
    const rows = [row({ item_id: 1, pending_qty: '0' })];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(1);
    expect(result[0].poQty).toBe('0');
  });

  it('8. one selected item among many distinct items sums correctly', () => {
    const rows = [
      row({ item_id: 1, pending_qty: '2' }),
      row({ item_id: 2, pending_qty: '3' }),
      row({ item_id: 3, pending_qty: '4' }),
      row({ item_id: 1, pending_qty: '5' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result.find((r) => r.itemId === 1)?.poQty).toBe('7');
    expect(result.find((r) => r.itemId === 2)?.poQty).toBe('3');
    expect(result.find((r) => r.itemId === 3)?.poQty).toBe('4');
  });

  it('9. multiple selected items each with multiple sources (Pen + Pencil)', () => {
    const rows = [
      row({ item_id: 1, indent_no: 'IND-001', pending_qty: '2' }),
      row({ item_id: 1, indent_no: 'IND-002', pending_qty: '3' }),
      row({ item_id: 1, indent_no: 'IND-004', pending_qty: '1' }),
      row({ item_id: 2, indent_no: 'IND-003', pending_qty: '5' }),
      row({ item_id: 2, indent_no: 'IND-005', pending_qty: '2' }),
    ];
    const result = consolidateEligibleLines(rows);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.itemId === 1)?.poQty).toBe('6');
    expect(result.find((r) => r.itemId === 1)?.sources).toHaveLength(3);
    expect(result.find((r) => r.itemId === 2)?.poQty).toBe('7');
    expect(result.find((r) => r.itemId === 2)?.sources).toHaveLength(2);
  });

  it('10. no selected indents/items yields an empty result', () => {
    expect(consolidateEligibleLines([])).toEqual([]);
  });
});

describe('reallocateSources', () => {
  const full: ConsolidatedSource[] = [
    { indentLineId: 1, indentId: 1, indentNo: 'IND-001', indentLineNo: 1, consumedQty: '2' },
    { indentLineId: 2, indentId: 2, indentNo: 'IND-002', indentLineNo: 1, consumedQty: '3' },
    { indentLineId: 3, indentId: 3, indentNo: 'IND-004', indentLineNo: 1, consumedQty: '1' },
  ];

  it('ordering the full amount (6) keeps every source untouched', () => {
    const result = reallocateSources(full, 6);
    expect(result).toEqual(full);
  });

  it('ordering 4 of 6 takes fully from the first sources and partially from the next, dropping the rest', () => {
    const result = reallocateSources(full, 4);
    expect(result).toEqual([
      { indentLineId: 1, indentId: 1, indentNo: 'IND-001', indentLineNo: 1, consumedQty: '2' },
      { indentLineId: 2, indentId: 2, indentNo: 'IND-002', indentLineNo: 1, consumedQty: '2' },
    ]);
    expect(result.reduce((sum, s) => sum + Number(s.consumedQty), 0)).toBe(4);
  });

  it('ordering 1 of 6 takes only from the first source', () => {
    const result = reallocateSources(full, 1);
    expect(result).toEqual([{ indentLineId: 1, indentId: 1, indentNo: 'IND-001', indentLineNo: 1, consumedQty: '1' }]);
  });

  it('ordering 0 drops every source', () => {
    expect(reallocateSources(full, 0)).toEqual([]);
  });

  it('re-running against the ORIGINAL full sources after growing the quantity back up never compounds error', () => {
    const trimmedTo4 = reallocateSources(full, 4);
    // A real edit always re-derives from `full`, not from `trimmedTo4` — confirm
    // that going back up to 6 from the original list restores everything exactly.
    const restoredTo6 = reallocateSources(full, 6);
    expect(restoredTo6).toEqual(full);
    expect(trimmedTo4).not.toEqual(full);
  });
});

// 2026-10-17 E2E run, S2-D4: the PO edit form showed '—' for Indent Qty on every line,
// though GET /purchase-orders/:id returns each line's sources with their indent_qty.
describe('indentQtyOfSources', () => {
  it('adds up the indent quantity of each indent line a saved PO line draws from, as the create form does', () => {
    const made = consolidateEligibleLines([
      row({ item_id: 7, indent_line_id: 101, indent_qty: '10', pending_qty: '6' }),
      row({ item_id: 7, indent_line_id: 102, indent_qty: '4', pending_qty: '4' }),
    ]);
    expect(indentQtyOfSources([{ indent_line_id: 101, indent_qty: '10.0000' }, { indent_line_id: 102, indent_qty: '4.0000' }]))
      .toBe(made[0]!.indentQty);
  });

  it('counts an indent line once, sums as stored, and is null for a line no indent is behind', () => {
    expect(indentQtyOfSources([{ indent_line_id: 5, indent_qty: '3' }, { indent_line_id: 5, indent_qty: '3' }])).toBe('3');
    expect(indentQtyOfSources([{ indent_line_id: 1, indent_qty: '0.1' }, { indent_line_id: 2, indent_qty: '0.2' }])).toBe('0.3');
    expect(indentQtyOfSources([])).toBeNull();
  });
});
