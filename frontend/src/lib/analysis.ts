/**
 * What the analysis screens (Dashboard, ModuleAnalysis, Requisition Analysis) open and
 * show (SRS §14): every KPI card, bar and trend point opens the list holding exactly
 * what it counts, under the same filters (backend analytics/routes.ts names each
 * breakdown's list as meta.drilldown).
 */
import type { FilterState } from './useFilters';

export type Granularity = 'day' | 'week' | 'month';

const iso = (d: Date) => d.toISOString().slice(0, 10);

/**
 * The days a trend point covers (the date_trunc of its granularity), within the screen's
 * own period: a point opened only its first day, so a month's bar opened the orders of
 * the 1st of that month.
 */
export function periodRange(
  period: string, granularity: Granularity, current: Pick<FilterState, 'dateFrom' | 'dateTo'> = {},
): { dateFrom: string; dateTo: string } {
  const start = String(period).slice(0, 10);
  const end = new Date(`${start}T00:00:00Z`);
  if (granularity === 'week') end.setUTCDate(end.getUTCDate() + 6);
  if (granularity === 'month') end.setUTCMonth(end.getUTCMonth() + 1, 0);
  const dateFrom = current.dateFrom && current.dateFrom > start ? current.dateFrom : start;
  const dateTo = current.dateTo && current.dateTo < iso(end) ? current.dateTo : iso(end);
  return { dateFrom, dateTo };
}

/**
 * A bar without a key ('Unassigned', 'Unspecified') opens nothing: no list filter selects
 * it, and the bare list it opened held every group.
 */
export const isDrillable = (key: string | null | undefined): key is string => key != null && key !== '';

export type KpiPanelState = 'loading' | 'error' | 'empty' | 'ready';

/**
 * How the KPI grid shows /analytics/kpis. A failed load is an error with Retry: it was
 * shown as 'You may not have analytics permissions', which sent people to ask for rights
 * they had while a slow query timed out (2026-10-17 E2E run, S1-D1). The permission
 * message is for a load that succeeded with nothing this user may see. A refresh that
 * failed keeps the figures already shown (with a notice above them).
 */
export function kpiPanelState(q: { isLoading: boolean; error: unknown; data: unknown }, shown: number): KpiPanelState {
  if (q.isLoading) return 'loading';
  if (q.error && q.data === undefined) return 'error';
  return shown === 0 ? 'empty' : 'ready';
}
