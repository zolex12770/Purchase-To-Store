import { describe, it, expect } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import { refreshAfterGrnChange } from './grnRefresh';

// 2026-10-17 E2E run, S3-D8: after a GRN save or post the GRN screen (['grn-doc', id]) and
// the PO screen (['purchase-order', id]) kept their old copy for up to 30 s: ['grn'] and
// ['purchase-orders'], which the form invalidated, do not cover them.
describe('refreshAfterGrnChange', () => {
  it('marks the GRN screen, the PO screen and the lists of every id stale', async () => {
    const qc = new QueryClient();
    const keys = [['grn-doc', '5'], ['purchase-order', '7'], ['grn', '?page=1'], ['purchase-orders', '?view=pending'], ['qc-inspections', {}]];
    for (const k of keys) qc.setQueryData(k, { cached: true });
    const untouched = ['indents', '?page=1'];
    qc.setQueryData(untouched, { cached: true });

    await refreshAfterGrnChange(qc);

    for (const k of keys) expect(qc.getQueryState(k)?.isInvalidated, JSON.stringify(k)).toBe(true);
    expect(qc.getQueryState(untouched)?.isInvalidated).toBe(false);
  });
});
