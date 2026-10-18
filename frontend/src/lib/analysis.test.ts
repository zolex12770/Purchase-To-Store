import { describe, it, expect } from 'vitest';
import { periodRange, isDrillable, kpiPanelState } from './analysis';
import { choicesKeeping } from './choices';

// A trend point opened only the first day of its period (2026-10-17 E2E run, S1-12).
describe('periodRange', () => {
  it('covers the whole day, week or month of a point', () => {
    expect(periodRange('2026-10-01', 'month')).toEqual({ dateFrom: '2026-10-01', dateTo: '2026-10-31' });
    expect(periodRange('2026-02-01', 'month')).toEqual({ dateFrom: '2026-02-01', dateTo: '2026-02-28' });
    expect(periodRange('2026-10-12', 'week')).toEqual({ dateFrom: '2026-10-12', dateTo: '2026-10-18' });
    expect(periodRange('2026-10-17', 'day')).toEqual({ dateFrom: '2026-10-17', dateTo: '2026-10-17' });
  });

  it("stays within the screen's own period", () => {
    expect(periodRange('2026-10-01', 'month', { dateFrom: '2026-10-05', dateTo: '2026-10-20' }))
      .toEqual({ dateFrom: '2026-10-05', dateTo: '2026-10-20' });
    expect(periodRange('2026-09-01', 'month', { dateFrom: '2026-08-15' })).toEqual({ dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  });
});

describe('isDrillable', () => {
  it("leaves the 'Unassigned' group without a list", () => {
    expect(isDrillable(null)).toBe(false);
    expect(isDrillable('')).toBe(false);
    expect(isDrillable('12')).toBe(true);
  });
});

// S1-D1: a KPI load that timed out read 'You may not have analytics permissions'.
describe('kpiPanelState', () => {
  it('a failed load is an error, never a missing permission', () => {
    expect(kpiPanelState({ isLoading: false, error: new Error('Timed out'), data: undefined }, 0)).toBe('error');
    expect(kpiPanelState({ isLoading: false, error: null, data: { kpis: [] } }, 0)).toBe('empty');
    expect(kpiPanelState({ isLoading: true, error: null, data: undefined }, 0)).toBe('loading');
    // A refresh that failed keeps the figures already on screen.
    expect(kpiPanelState({ isLoading: false, error: new Error('Timed out'), data: { kpis: [1] } }, 1)).toBe('ready');
  });
});

// S2-D3: a PO's '30 days' showed 'Select terms' while its save kept the value.
describe('choicesKeeping', () => {
  it('keeps a saved value the lookup lacks, first, and adds nothing otherwise', () => {
    expect(choicesKeeping(['Advance', 'NET30'], '30 days')).toEqual(['30 days', 'Advance', 'NET30']);
    expect(choicesKeeping(['Advance', 'NET30'], 'NET30')).toEqual(['Advance', 'NET30']);
    expect(choicesKeeping(['Advance'], '')).toEqual(['Advance']);
  });
});
