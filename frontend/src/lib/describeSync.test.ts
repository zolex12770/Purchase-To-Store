import { describe, it, expect } from 'vitest';
import { describeSync, type SyncResult } from './describeSync';

const base: SyncResult = {
  category: 'RM', status: 'SUCCESS', durationMs: 1, transactionsImported: 3, quarantinedRecords: 1,
  tabs: [{ tab: 'RM Outward', reversed: 2, status: 'SUCCESS' }],
  reconciliation: { checked: 10, matched: 9, mismatched: 1 },
};

// 2026-10-17 review: a code whose sheet counts another unit stopped following the sheet
// and the only trace was a hidden recon note on a row reading 'Matches sheet'.
describe('describeSync', () => {
  it('names the items left out of the Purchase stock for their unit', () => {
    const text = describeSync({
      ...base,
      purchaseStock: { unitMismatches: [{ itemCode: 'CHM086', itemUom: 'LTR', leftOut: 'GENERAL Kg 80', aligned: false }] },
    });
    expect(text).toContain('9 of 10 items match the sheet.');
    expect(text).toContain('1 item(s) not updated from a sheet that counts another unit than the Item Master: CHM086.');
  });

  it('says nothing about units when every listing is in the Item Master unit', () => {
    expect(describeSync({ ...base, purchaseStock: { unitMismatches: [] } })).not.toContain('unit');
    expect(describeSync(base)).toBe('RM: 3 new entries, 2 removed, 1 rows not counted. 9 of 10 items match the sheet.');
  });
});
