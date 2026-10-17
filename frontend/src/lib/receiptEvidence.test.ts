import { describe, it, expect } from 'vitest';
import { heldListCsv, HELD_LIST_COLUMNS, RECEIPT_EVIDENCE_OPTIONS, isReceiptEvidence, type HeldLine } from './receiptEvidence';

const held: HeldLine[] = [
  {
    grnLineId: 11, grnId: 3, grnNo: 'ZG/RM/0011', itemCode: 'CRC245120', grnQty: '120.0000', tabRows: [14, 15],
    reason: 'SEVERAL_POS', detail: 'Tab row(s) 14, 15 name Z/RM/00012, Z/RM/00013.', poNos: ['Z/RM/00012', 'Z/RM/00013'],
  },
  {
    grnLineId: 12, grnId: 4, grnNo: 'ZG/RM/0012', itemCode: '-CRC', grnQty: '5.0000', tabRows: [],
    reason: 'NOT_ON_TAB', detail: 'No row of the GRN tab names GRN ZG/RM/0012 with item "-CRC".',
  },
];
const reasonText = { SEVERAL_POS: 'The GRN tab names more than one PO for this receipt.' };

// 2026-10-17: the link repair held 2,642 store receipt lines; purchase works through them
// from this file, so each line must say what came, why it was not linked and which POs.
describe('heldListCsv', () => {
  it('writes one row per held line with the reason in words and the POs the tab names', () => {
    const lines = heldListCsv(held, reasonText).replace(/^﻿/, '').split('\r\n');
    expect(lines[0]).toBe(HELD_LIST_COLUMNS.join(','));
    expect(lines[1]).toBe(
      'ZG/RM/0011,CRC245120,120.0000,SEVERAL_POS,The GRN tab names more than one PO for this receipt.,'
        + '"Tab row(s) 14, 15 name Z/RM/00012, Z/RM/00013.",Z/RM/00012; Z/RM/00013,14; 15',
    );
    expect(lines).toHaveLength(4);
    expect(lines[3]).toBe('');
  });

  it('quotes commas and quotes, neutralises a leading minus, and falls back to the reason code', () => {
    const row = heldListCsv(held, reasonText).split('\r\n')[2]!;
    expect(row).toBe('ZG/RM/0012,\'-CRC,5.0000,NOT_ON_TAB,NOT_ON_TAB,"No row of the GRN tab names GRN ZG/RM/0012 with item ""-CRC"".",,');
  });

  it('starts with a byte-order mark so a spreadsheet reads it as UTF-8', () => {
    expect(heldListCsv([], {}).startsWith('﻿')).toBe(true);
  });
});

describe('receipt evidence options', () => {
  it('are the backend filter values, in its order of precedence', () => {
    expect(RECEIPT_EVIDENCE_OPTIONS.map((o) => o.value)).toEqual(['awaiting_link', 'sheet_only', 'none_recorded']);
    expect(isReceiptEvidence('sheet_only')).toBe(true);
    expect(isReceiptEvidence('maybe')).toBe(false);
  });
});
