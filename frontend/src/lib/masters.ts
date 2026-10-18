/**
 * Master-data hooks.
 *
 * Every dropdown in the product is fed from here, so no screen ever hard-codes a
 * business value (build brief §53). The catalogue is fetched once and cached for
 * the session; masters change rarely and this keeps forms instant.
 */
import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs, ApiError } from './api';

import { toShortUom } from './format';

export interface LookupOption {
  id: number;
  code: string;
  name: string;
  parentId: number | null;
  extra?: Record<string, unknown> | null;
}

// Indent Type, PO Type and GRN Type are three separate fields — each stored
// on its own document — but PO Type's and GRN Type's dropdown OPTIONS are
// deliberately sourced from the same INDENT_TYPE category (migration 013),
// so all three offer identical values without three lists to keep in sync.
export type LookupCategory =
  | 'DEPARTMENT' | 'COST_CENTRE' | 'ITEM_TYPE' | 'MAIN_GROUP' | 'SUB_MAIN_GROUP'
  | 'UOM' | 'INDENT_TYPE' | 'PO_TYPE' | 'CURRENCY' | 'PAYMENT_TERMS' | 'STATE' | 'CITY'
  | 'GRN_TYPE' | 'PACKING_TYPE' | 'LOCATION' | 'MACHINE';

export type LookupCatalogue = Record<LookupCategory, LookupOption[]>;

export const CATEGORY_LABEL: Record<LookupCategory, string> = {
  DEPARTMENT: 'Department',
  COST_CENTRE: 'Cost Centre',
  ITEM_TYPE: 'Item Type',
  MAIN_GROUP: 'Main Group',
  SUB_MAIN_GROUP: 'Sub Main Group',
  UOM: 'Unit of Measure',
  INDENT_TYPE: 'Indent Type',
  PO_TYPE: 'PO Type',
  CURRENCY: 'Currency',
  PAYMENT_TERMS: 'Payment Terms',
  STATE: 'State',
  CITY: 'City',
  GRN_TYPE: 'GRN Type',
  PACKING_TYPE: 'Packing Type',
  LOCATION: 'Location',
  MACHINE: 'Machine',
};

export function useLookups() {
  return useQuery({
    queryKey: ['lookups', 'options'],
    queryFn: () => api.get<LookupCatalogue>('/lookups/options'),
    staleTime: 5 * 60 * 1000,
  });
}

/** Nothing, with a STABLE identity — a fresh `[]` would defeat the memo below. */
const NO_OPTIONS: LookupOption[] = [];

/**
 * Options for one category, ready for a <Select>.
 *
 * Memoised on purpose. Without it every call allocated a new array and a new
 * wrapper object on every render of every consumer, so the two screens that
 * put these straight into a useEffect dependency list (IndentForm's and
 * RequisitionForm's cost-centre matching) re-ran their effect — and re-scored
 * every cost centre with four regexes per label — after each render rather than
 * when the data actually changed. React Query already hands back a stable
 * `data` reference, so keying on it is enough.
 */
export function useLookupOptions(category: LookupCategory) {
  const { data, isLoading } = useLookups();
  const raw = data?.[category] ?? NO_OPTIONS;
  const options = useMemo(
    () => raw.map((o) => ({ value: o.id, label: category === 'UOM' ? toShortUom(o.name || o.code) : o.name })),
    [raw, category],
  );
  return useMemo(() => ({ options, raw, isLoading }), [options, raw, isLoading]);
}

export interface UserOption {
  id: number;
  employeeId: string;
  employeeName: string;
  departmentId: number | null;
  departmentName: string | null;
  isHod: boolean;
}

export function useUserOptions() {
  return useQuery({
    queryKey: ['lookups', 'users'],
    queryFn: () => api.get<UserOption[]>('/lookups/users'),
    staleTime: 5 * 60 * 1000,
  });
}

/* ── Item & supplier typeahead ───────────────────────────────────────────── */

export interface ItemOption {
  id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  standard_rate: string | null;
  uom_id: number | null;
  uom_code: string | null;
  uom_name: string | null;
  hsn_code: string;
  live_stock_qty?: number | string | null;
  department_id?: number | null;
  cost_centre_id?: number | null;
  min_stock?: number | string | null;
  max_stock?: number | string | null;
}

/** `enabled` as for useSupplierSearch: a filter bar without an item filter, or a user without item.view, asks nothing. */
export function useItemSearch(term: string, enabled = true) {
  return useQuery({
    queryKey: ['items', 'search', term],
    queryFn: () => api.get<ItemOption[]>(`/items/search${qs({ q: term, limit: 50 })}`),
    staleTime: 60 * 1000,
    enabled,
  });
}

/** The most records one lookup by id names (the supplier search's own cap). */
const NAMED_MAX = 50;
const idSet = (ids: readonly string[]) => [...new Set(ids)].filter((id) => /^\d+$/.test(id)).sort().slice(0, NAMED_MAX);

/** The search endpoint asked for exactly these records, by id (backend masters routes, `ids`). */
export const byIdPath = (kind: MasterKind, ids: readonly string[]) => {
  const key = idSet(ids);
  return `/${kind === 'item' ? 'items' : 'suppliers'}/search${qs({ ids: key, limit: key.length })}`;
};

/**
 * The records a filter names by id only. A drill-down or a bookmark arrives as
 * ?supplierId=10039, and the filter bar named only what its current search had
 * returned, so the pill read "Supplier: #10039" (C41). One request per set of ids,
 * through the search endpoint and its right, kept for 10 minutes.
 */
export function useItemsById(ids: readonly string[], enabled = true) {
  const key = idSet(ids);
  return useQuery({
    queryKey: ['items', 'by-id', key],
    queryFn: () => api.get<ItemOption[]>(byIdPath('item', key)),
    enabled: enabled && key.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}

export function useSuppliersById(ids: readonly string[], enabled = true) {
  const key = idSet(ids);
  return useQuery({
    queryKey: ['suppliers', 'by-id', key],
    queryFn: () => api.get<SupplierOption[]>(byIdPath('supplier', key)),
    enabled: enabled && key.length > 0,
    staleTime: 10 * 60 * 1000,
  });
}

export type MasterKind = 'item' | 'supplier';
const MASTER_RIGHT: Record<MasterKind, string> = { item: 'item.view', supplier: 'supplier.view' };

/**
 * What an item or supplier picker says when it lists nothing. A refused or failed
 * search is said so: a 403 from /items/search read as "No item found" (C40, S1-D10:
 * a HOD-only account may raise a requisition, but its role holds no item.view).
 */
export function masterSearchEmptyText(kind: MasterKind, term: string, error: unknown): string {
  const plural = kind === 'item' ? 'items' : 'suppliers';
  if (error instanceof ApiError && error.status === 403) {
    return `You cannot search ${plural}: your role does not include ${MASTER_RIGHT[kind]}. Ask your administrator for it.`;
  }
  if (error) return `Could not search ${plural}. ${error instanceof Error ? error.message : ''}`.trim();
  if (!term) return kind === 'item' ? 'Type the item code or name to search.' : 'Type the supplier name to search.';
  return kind === 'item' ? 'No item found. Check the item code or name.' : 'No supplier found. Check the name.';
}

export interface SupplierOption {
  id: number;
  supplier_code: string;
  supplier_name: string;
  address: string;
  city: string;
  state: string;
  payment_terms: string;
  currency_code: string;
  gst_no: string;
  mobile_no: string;
  email: string;
}

/**
 * `enabled` lets a caller skip the request altogether — a filter bar that shows
 * no supplier filter, or a user without the supplier "view" right, must not
 * fire a lookup the server will only answer with 403.
 */
export function useSupplierSearch(term = '', enabled = true) {
  return useQuery({
    queryKey: ['suppliers', 'search', term],
    queryFn: () => api.get<SupplierOption[]>(`/suppliers/search${qs({ q: term, limit: 50 })}`),
    staleTime: 60 * 1000,
    enabled,
  });
}

/* ── Auto-population profiles (SRS §10, §29) ─────────────────────────────── */

export interface ItemProfile {
  id: number;
  itemCode: string;
  itemDescription: string;
  itemTypeId: number | null;
  itemTypeName: string | null;
  departmentId: number | null;
  departmentName: string | null;
  costCentreId: number | null;
  costCentreName: string | null;
  mainGroupId: number | null;
  mainGroupName: string | null;
  subMainGroupId: number | null;
  subMainGroupName: string | null;
  indentTypeId: number | null;
  indentTypeName: string | null;
  uomId: number | null;
  uomCode: string | null;
  uomName: string | null;
  hsnCode: string;
  itemSpecification: string;
  standardRate: string | null;
  reorderLevel: string | null;
  isActive: boolean;
  live: {
    openIndentQty: string;
    pendingGrnQty: string;
    totalReceivedQty: string;
    liveStockQty: string;
    lastPurchaseRate: string | null;
    lastPurchaseDate: string | null;
  };
}

/** Fetches everything the Item Master knows, for auto-fill on a line. */
export const fetchItemProfile = (id: number) => api.get<ItemProfile>(`/items/${id}/profile`);

export interface SupplierProfile {
  id: number;
  supplierCode: string;
  supplierName: string;
  address: string;
  state: string;
  city: string;
  country: string;
  mobileNo: string;
  email: string;
  gstNo: string;
  paymentTerms: string;
  currencyCode: string;
  contactPerson: string;
  isActive: boolean;
}

export const fetchSupplierProfile = (id: number) => api.get<SupplierProfile>(`/suppliers/${id}/profile`);

/* ── App settings (branding for the shell and print layouts) ─────────────── */

export interface AppSettings {
  'company.name'?: string;
  'company.brand'?: string;
  'company.address'?: string;
  'company.gst_no'?: string;
  'defaults.currency'?: string;
  'google_sync.enabled'?: boolean;
  'form_fields.indent.remarks_visible'?: boolean;
  [key: string]: unknown;
}

export function useSettings() {
  return useQuery({
    queryKey: ['settings'],
    queryFn: () => api.get<AppSettings>('/settings'),
    staleTime: 5 * 60 * 1000,
  });
}
