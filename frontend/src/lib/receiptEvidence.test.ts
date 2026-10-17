import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import {
  heldListCsv, HELD_LIST_COLUMNS, RECEIPT_EVIDENCE_OPTIONS, isReceiptEvidence, awaitingBannerCopy, awaitingBadgeTip,
  sheetReceiptNeedsPosting, evidenceAsOf, applyFailure, isPendingOrder, NEXT_ACTION_AWAITING_LINK, NEXT_ACTION_SHEET_ONLY,
  type HeldLine, type ReceiptEvidenceSummary, type StoreSheetReceipt,
} from './receiptEvidence';

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

// 2026-10-17 review: Z/SS/00986 (COMPLETED, 9 OVER_RECEIPT receipts) said "this order counts
// its quantity as still to be received" and asked for a re-run that can never link them.
describe('a held receipt on an order that expects no more goods', () => {
  it('claims pending quantity and the re-run only while the order is open or partly received', () => {
    for (const status of ['OPEN', 'PARTIALLY_RECEIVED']) {
      expect(isPendingOrder(status)).toBe(true);
      const copy = awaitingBannerCopy(status, 2);
      expect(copy.title).toBe('2 store receipts name this purchase order but are not linked to it yet');
      expect(copy.text).toMatch(/counts its quantity as still to be received/);
      expect(copy.next).toBe(NEXT_ACTION_AWAITING_LINK);
      expect(awaitingBadgeTip(status, 1)).toMatch(/^1 store receipt line names this PO but is not linked to it yet, so its goods may have come/);
    }
    for (const status of ['COMPLETED', 'SHORT_CLOSED', 'CANCELLED']) {
      expect(isPendingOrder(status)).toBe(false);
      const copy = awaitingBannerCopy(status, 1);
      expect(copy.text).not.toMatch(/still to be received/);
      expect(copy.text).toMatch(/nothing on it is counted as still to come/);
      expect(copy.next).not.toMatch(/re-runs Link store GRNs/);
      expect(awaitingBadgeTip(status, 9)).not.toMatch(/goods may have come/);
    }
    expect(awaitingBannerCopy('COMPLETED', 9).title).toBe('9 store receipts name this purchase order, which is fully received');
  });
});

// 2026-10-17 review: Z/SM/00043's sheet line was posted as GRN-20261017-0001 and the screen
// still offered Receive material for it; a second user would receive 365.8 again.
describe('the sheet banner\'s Receive material', () => {
  const line = (covers: boolean): StoreSheetReceipt => ({
    issueId: 1, grnNo: 'ZG/SM/0084', itemCode: 'FCETP64.0 X 1.75', grnQty: '365.8000', sheetRow: 6475,
    reportedAt: '2026-10-17T04:42:01.724Z', erpReceivedOnPoLine: covers ? '365.8000' : '0.0000', erpReceiptCoversIt: covers, postedAs: null,
  });
  it('is offered only while a line is not already covered by what the ERP received on the PO line', () => {
    expect(sheetReceiptNeedsPosting([line(false)])).toBe(true);
    expect(sheetReceiptNeedsPosting([line(true), line(false)])).toBe(true);
    expect(sheetReceiptNeedsPosting([line(true)])).toBe(false);
    expect(sheetReceiptNeedsPosting([])).toBe(false);
  });
  it('tells the user to resolve the sync issue or correct the sheet once the receipt is posted', () => {
    expect(NEXT_ACTION_SHEET_ONLY).toMatch(/^The store has recorded this receipt on the GRN sheet but not in the ERP\. Post it through Goods Receipt \(GRN\) in the ERP; the sheet sync never creates receipts\./);
    expect(NEXT_ACTION_SHEET_ONLY).toMatch(/resolve its sync issue .* or correct the GRN number on the sheet/);
  });
});

describe('the evidence tiles\' "as of"', () => {
  const summary = (sheetOnly: Partial<ReceiptEvidenceSummary['sheetOnly']>): ReceiptEvidenceSummary => ({
    asOf: null, runId: null, pending: { pos: 0, value: '0' },
    awaitingLink: { pos: 0, value: '0', receiptLines: 0, byReason: {} },
    sheetOnly: { pos: 0, value: '0', receiptLines: 0, jobId: null, asOf: null, laterRuns: 0, ...sheetOnly },
    noneRecorded: { pos: 0, value: '0' }, notInErp: { receiptLines: 0, poNos: 0 },
  });
  it('names the run that last read the GRN tab through, and the runs since that did not', () => {
    expect(evidenceAsOf(summary({ jobId: 2780, asOf: '2026-10-17T06:13:00.116Z' }))[0]).toMatch(/^the store's GRN sheet as sheet sync #2780 last read it through \(/);
    expect(evidenceAsOf(summary({ jobId: 2780, asOf: '2026-10-17T06:13:00.116Z', laterRuns: 3 }))[0])
      .toMatch(/; 3 later sync runs did not read it, so receipts posted since may still be listed$/);
    expect(evidenceAsOf(summary({ laterRuns: 2 }))).toEqual(['no sheet sync has read the GRN tab through yet, so no receipt is counted as on the store sheet only']);
    expect(evidenceAsOf(undefined)).toEqual([]);
  });
});

// 2026-10-17 review: a 90 s TIMEOUT was reported as "Nothing was linked" while the server
// went on to commit 3,752 links.
describe('what became of an Apply that failed', () => {
  it('is unknown when no answer came, stale on a 409, and refused otherwise', () => {
    expect(applyFailure(new ApiError(0, 'TIMEOUT', 'The server took too long to answer.'))).toBe('unknown');
    expect(applyFailure(new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.'))).toBe('unknown');
    expect(applyFailure(new TypeError('Failed to fetch'))).toBe('unknown');
    expect(applyFailure(new ApiError(409, 'CONFLICT', 'The GRN tab changed.'))).toBe('changed');
    expect(applyFailure(new ApiError(422, 'VALIDATION', 'Type "LINK STORE GRNS" to confirm.'))).toBe('refused');
    expect(applyFailure(new ApiError(500, 'SERVER_ERROR', 'Linking check failed.'))).toBe('refused');
  });
});
