/**
 * URL-backed filter state (SRS §14).
 *
 * Filters live in the URL, not in component state. That is what makes
 * "drill-down must preserve applied filters and source context" work: a KPI card
 * navigates to a list with its filters in the query string, the back button
 * behaves, and any analytical view can be shared as a link.
 */
import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';

export interface FilterState {
  dateFrom?: string;
  dateTo?: string;
  supplierId?: string[];
  itemId?: string[];
  departmentId?: string[];
  costCentreId?: string[];
  indentTypeId?: string[];
  poTypeId?: string[];
  mainGroupId?: string[];
  subMainGroupId?: string[];
  itemTypeId?: string[];
  userId?: string[];
  status?: string[];
  qcStatus?: string[];
  hodStatus?: string[];
  storeStatus?: string[];
  machineId?: string[];
  requesterId?: string[];
  hodId?: string[];
  search?: string;
  page?: number;
  pageSize?: number;
  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  view?: string;
  overdue?: string;
  [key: string]: string | string[] | number | undefined;
}

const ARRAY_KEYS = new Set([
  'supplierId', 'itemId', 'departmentId', 'costCentreId', 'indentTypeId',
  'poTypeId', 'mainGroupId', 'subMainGroupId', 'itemTypeId', 'userId', 'status',
  'qcStatus', 'hodStatus', 'storeStatus', 'machineId', 'requesterId', 'hodId',
]);

const NUMBER_KEYS = new Set(['page', 'pageSize']);

/** Keys that are pagination/sorting rather than business filters. */
const NON_FILTER_KEYS = new Set(['page', 'pageSize', 'sortBy', 'sortDir', 'view', 'tab']);

export function useFilters(defaults: FilterState = {}) {
  const [params, setParams] = useSearchParams();

  const filters = useMemo<FilterState>(() => {
    const out: FilterState = { ...defaults };
    for (const [key, value] of params.entries()) {
      if (value === '') continue;
      if (ARRAY_KEYS.has(key)) out[key] = value.split(',').filter(Boolean);
      else if (NUMBER_KEYS.has(key)) out[key] = Number(value);
      else out[key] = value;
    }
    out.page = out.page ?? 1;
    out.pageSize = out.pageSize ?? 25;
    return out;
    // `defaults` is a literal at every call site; re-deriving on each params change is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  /** Merges `patch` into the URL. Any filter change resets to page 1. */
  const setFilters = useCallback((patch: Partial<FilterState>, options: { resetPage?: boolean } = {}) => {
    const resetPage = options.resetPage ?? !('page' in patch);
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(patch)) {
        if (value === undefined || value === null || value === '' ||
            (Array.isArray(value) && value.length === 0)) {
          next.delete(key);
        } else if (Array.isArray(value)) {
          next.set(key, value.join(','));
        } else {
          next.set(key, String(value));
        }
      }
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  }, [setParams]);

  const clearFilters = useCallback((keep: string[] = []) => {
    setParams((prev) => {
      const next = new URLSearchParams();
      for (const key of keep) {
        const v = prev.get(key);
        if (v) next.set(key, v);
      }
      return next;
    }, { replace: true });
  }, [setParams]);

  /** Number of business filters currently applied (drives the "Clear" affordance). */
  const activeCount = useMemo(() => {
    let n = 0;
    for (const [key, value] of params.entries()) {
      if (NON_FILTER_KEYS.has(key) || value === '') continue;
      n += ARRAY_KEYS.has(key) ? value.split(',').filter(Boolean).length : 1;
    }
    return n;
  }, [params]);

  /** Params object for the API layer. */
  const queryParams = useMemo(() => {
    const { ...rest } = filters;
    return rest as Record<string, unknown>;
  }, [filters]);

  return { filters, setFilters, clearFilters, activeCount, queryParams };
}

/** Builds a link that carries the current filter context into a drill-down. */
export function drilldownLink(base: string, extra: Record<string, unknown> = {}, current?: FilterState): string {
  // A drill target may carry its own query ('/purchase-orders?view=pending'). Appending a
  // second '?' garbled it, and with any dashboard filter set the list showed 0 rows
  // (2026-10-16 audit). The target's own parameters define what the number counts, so the
  // dashboard context never overrides them; explicit extras do.
  const [path, own = ''] = base.split('?', 2) as [string, string?];
  const sp = new URLSearchParams(own);
  const ownKeys = new Set(sp.keys());
  const put = (key: string, value: unknown) => {
    if (value === undefined || value === null || value === '') return;
    if (NON_FILTER_KEYS.has(key)) return;
    if (Array.isArray(value)) {
      if (value.length === 0) return;
      sp.set(key, value.join(','));
    } else {
      sp.set(key, String(value));
    }
  };
  for (const [key, value] of Object.entries(current ?? {})) if (!ownKeys.has(key)) put(key, value);
  for (const [key, value] of Object.entries(extra)) put(key, value);
  const q = sp.toString();
  return q ? `${path}?${q}` : path;
}
