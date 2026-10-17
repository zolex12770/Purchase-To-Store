import { describe, it, expect } from 'vitest';
import { drilldownLink, type FilterState } from './useFilters';

// 2026-10-16: a target with its own query got a second '?', so with any dashboard filter
// set the drilled list read a garbled parameter and showed 0 rows instead of 1,786.
describe('drilldownLink', () => {
  const ctx = { fromDate: '2026-04-01', departmentId: [3, 4] } as unknown as FilterState;

  it('keeps the target query and adds the dashboard context with one separator', () => {
    const link = drilldownLink('/purchase-orders?view=pending', {}, ctx);
    expect(link.split('?')).toHaveLength(2);
    const sp = new URLSearchParams(link.split('?')[1]);
    expect(sp.get('view')).toBe('pending');
    expect(sp.get('fromDate')).toBe('2026-04-01');
    expect(sp.get('departmentId')).toBe('3,4');
  });

  it('never lets the dashboard context override what the target counts; explicit extras do', () => {
    const own = new URLSearchParams(drilldownLink('/indents?status=APPROVED', {}, { status: 'DRAFT' } as unknown as FilterState).split('?')[1]);
    expect(own.get('status')).toBe('APPROVED');
    const extra = new URLSearchParams(drilldownLink('/indents?status=APPROVED', { status: 'CLOSED' }).split('?')[1]);
    expect(extra.get('status')).toBe('CLOSED');
  });

  it('leaves a bare path bare', () => {
    expect(drilldownLink('/grn')).toBe('/grn');
  });
});
