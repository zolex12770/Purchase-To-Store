/**
 * Universal filter bar (SRS §14; redesign spec §3.11).
 *
 * One engine drives filtering on every list and analytical view. It writes to
 * the URL (see `useFilters`), so applied filters travel with a drill-down,
 * survive a refresh, and are shareable as a link.
 *
 * One compact row: the date range, two dimension pills, then "+ Filter" for
 * the rest. A pill with a value shows it ("Supplier: Raj Pack Plast +2") and
 * clears with its own ×, so no second row of chips is needed. v2 showed 8–10
 * pills in a separate glass card (about 80 px for one row) and a chip row
 * under it.
 *
 * Dimensions: date range (presets, single date, custom range with
 * validation), employee, HOD, supplier, item, QC status, document status and
 * the lookup masters (department, cost centre, indent/PO type, main group,
 * item type, machine).
 */
import { useState, useRef, useEffect, useId, type ReactNode } from 'react';
import { ChevronDown, X, CalendarDays, AlertCircle, Check, Plus, Search } from 'lucide-react';
import { Button, MenuList, Popover, menuKeyNav, useMenuAutofocus } from './ui';
import {
  useLookups, useSupplierSearch, useItemSearch, useUserOptions,
  CATEGORY_LABEL, type LookupCategory,
} from '../lib/masters';
import { useAuth } from '../lib/auth';
import { useDebounced } from './simple';
import { today, daysAgo, startOfMonth, formatDate } from '../lib/format';
import { statusMeta } from '../lib/status';
import type { FilterState } from '../lib/useFilters';

export type FilterKey =
  | 'dateRange' | 'supplier' | 'department' | 'costCentre'
  | 'indentType' | 'poType' | 'mainGroup' | 'itemType' | 'status' | 'machine'
  | 'user' | 'hod' | 'item' | 'qcStatus';

export const DATE_PRESETS = [
  { key: 'today', label: 'Today', from: today, to: today },
  { key: '7d', label: 'Last 7 days', from: () => daysAgo(7), to: today },
  { key: '30d', label: 'Last 30 days', from: () => daysAgo(30), to: today },
  { key: 'mtd', label: 'This month', from: () => startOfMonth(0), to: today },
  { key: '3m', label: 'Last 3 months', from: () => startOfMonth(2), to: today },
  { key: '6m', label: 'Last 6 months', from: () => startOfMonth(5), to: today },
  { key: '12m', label: 'Last 12 months', from: () => startOfMonth(11), to: today },
];

const CATEGORY_FOR: Partial<Record<FilterKey, LookupCategory>> = {
  department: 'DEPARTMENT',
  costCentre: 'COST_CENTRE',
  indentType: 'INDENT_TYPE',
  poType: 'INDENT_TYPE', // shared master (migration 013) — separate field, same value list
  mainGroup: 'MAIN_GROUP',
  itemType: 'ITEM_TYPE',
  machine: 'MACHINE',
};

const PARAM_FOR: Record<FilterKey, string> = {
  dateRange: 'dateFrom',
  supplier: 'supplierId',
  department: 'departmentId',
  costCentre: 'costCentreId',
  indentType: 'indentTypeId',
  poType: 'poTypeId',
  mainGroup: 'mainGroupId',
  itemType: 'itemTypeId',
  status: 'status',
  machine: 'machineId',
  user: 'userId',
  hod: 'hodId',
  item: 'itemId',
  qcStatus: 'qcStatus',
};

const QC_STATUS_OPTIONS = [
  'PENDING_QC', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD', 'NOT_APPLICABLE',
].map((value) => ({ value, label: statusMeta(value).label }));

/** Which dimensions get a pill of their own when a page does not say. */
const PILL_PRIORITY: FilterKey[] = [
  'supplier', 'status', 'qcStatus', 'department', 'item', 'machine', 'indentType', 'poType',
  'mainGroup', 'itemType', 'costCentre', 'user', 'hod',
];

export function FilterBar({
  filters, setFilters, clearFilters, activeCount,
  show = ['dateRange', 'supplier', 'department', 'costCentre'],
  primary,
  statusOptions,
  extra,
  children,
}: {
  filters: FilterState;
  setFilters: (patch: Partial<FilterState>) => void;
  clearFilters: (keep?: string[]) => void;
  activeCount: number;
  show?: FilterKey[];
  /** The (up to two) dimensions that always get a pill; the rest go under "+ Filter". */
  primary?: FilterKey[];
  statusOptions?: { value: string; label: string }[];
  extra?: ReactNode;
  children?: ReactNode;
}) {
  const { data: lookups } = useLookups();
  const { can } = useAuth();

  /* ── User & HOD options ─────────────────────────────────────────────────── */
  const { data: users } = useUserOptions();
  const userNames = useRef(new Map<string, string>());
  for (const u of users ?? []) {
    userNames.current.set(String(u.id), `${u.employeeName} (${u.employeeId})`);
  }

  /* ── Supplier search ────────────────────────────────────────────────────── */
  const supplierFilter = show.includes('supplier') && can('supplier.view');
  const [supplierTerm, setSupplierTerm] = useState('');
  const { data: suppliers } = useSupplierSearch(useDebounced(supplierTerm.trim(), 250), supplierFilter);
  const supplierNames = useRef(new Map<string, string>());
  for (const s of suppliers ?? []) supplierNames.current.set(String(s.id), s.supplier_name);

  /* ── Item search ────────────────────────────────────────────────────────── */
  const [itemTerm, setItemTerm] = useState('');
  const { data: items } = useItemSearch(useDebounced(itemTerm.trim(), 250));
  const itemNames = useRef(new Map<string, string>());
  for (const i of items ?? []) itemNames.current.set(String(i.id), `${i.item_code} - ${i.item_description}`);

  const labelFor = (key: FilterKey, id: string): string => {
    if (key === 'supplier') return supplierNames.current.get(id) ?? `#${id}`;
    if (key === 'user' || key === 'hod') return userNames.current.get(id) ?? `#${id}`;
    if (key === 'item') return itemNames.current.get(id) ?? `#${id}`;
    if (key === 'status') return statusOptions?.find((o) => o.value === id)?.label ?? statusMeta(id).label;
    if (key === 'qcStatus') return statusMeta(id).label;
    const category = CATEGORY_FOR[key];
    if (!category || !lookups) return `#${id}`;
    return lookups[category]?.find((o) => String(o.id) === id)?.name ?? `#${id}`;
  };

  const dimLabel = (key: FilterKey): string => {
    if (key === 'status') return 'Status';
    if (key === 'qcStatus') return 'QC status';
    if (key === 'user') return 'Employee';
    if (key === 'hod') return 'HOD';
    if (key === 'item') return 'Item';
    if (key === 'supplier') return 'Supplier';
    const c = CATEGORY_FOR[key];
    return c ? CATEGORY_LABEL[c] : key;
  };

  const selectedOf = (key: FilterKey) => (filters[PARAM_FOR[key]] as string[] | undefined) ?? [];

  const toggleValue = (param: string, value: string) => {
    const current = (filters[param] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilters({ [param]: next });
  };

  /* ── Which dimensions show as pills ─────────────────────────────────────── */
  const dims: FilterKey[] = show.filter((k) => k !== 'dateRange')
    .filter((k) => (k === 'supplier' ? supplierFilter : k === 'status' ? Boolean(statusOptions) : true));
  const defaults = (primary ?? [...dims].sort((a, b) => PILL_PRIORITY.indexOf(a) - PILL_PRIORITY.indexOf(b))).filter((k) => dims.includes(k)).slice(0, 2);
  const [revealed, setRevealed] = useState<FilterKey[]>([]);
  const [autoOpen, setAutoOpen] = useState<FilterKey | null>(null);
  const pills = dims.filter((k) => defaults.includes(k) || revealed.includes(k) || selectedOf(k).length > 0);
  const more = dims.filter((k) => !pills.includes(k));

  const pickerFor = (key: FilterKey): ReactNode => {
    const param = PARAM_FOR[key];
    const selected = selectedOf(key);
    const onToggle = (v: string) => toggleValue(param, v);
    switch (key) {
      case 'user':
      case 'hod':
        return (
          <MultiPicker
            label={dimLabel(key)}
            options={(users ?? [])
              .filter((u) => {
                if (key === 'hod' && !u.isHod) return false;
                const deptIds = (filters.departmentId as string[]) ?? [];
                return deptIds.length === 0 || (u.departmentId != null && deptIds.includes(String(u.departmentId)));
              })
              .map((u) => ({
                value: String(u.id),
                label: `${u.employeeName} (${u.employeeId})${u.departmentName ? ' · ' + u.departmentName : ''}`,
              }))}
            selected={selected}
            onToggle={onToggle}
          />
        );
      case 'supplier':
        return (
          <MultiPicker
            label="Supplier"
            options={(suppliers ?? []).map((s) => ({ value: String(s.id), label: s.supplier_name }))}
            selected={selected}
            onToggle={onToggle}
            onSearch={setSupplierTerm}
          />
        );
      case 'item':
        return (
          <MultiPicker
            label="Item"
            options={(items ?? []).map((i) => ({ value: String(i.id), label: `${i.item_code} · ${i.item_description}` }))}
            selected={selected}
            onToggle={onToggle}
            onSearch={setItemTerm}
          />
        );
      case 'qcStatus':
        return <MultiPicker label="QC status" options={QC_STATUS_OPTIONS} selected={selected} onToggle={onToggle} />;
      case 'status':
        return <MultiPicker label="Status" options={statusOptions ?? []} selected={selected} onToggle={onToggle} />;
      default: {
        const category = CATEGORY_FOR[key]!;
        return (
          <MultiPicker
            label={CATEGORY_LABEL[category]}
            options={(lookups?.[category] ?? []).map((o) => ({ value: String(o.id), label: o.name }))}
            selected={selected}
            onToggle={onToggle}
          />
        );
      }
    }
  };

  return (
    <div className="filter-bar" style={{ marginBottom: 'var(--space-3)' }} role="group" aria-label="Filters">
      {show.includes('dateRange') && (
        <DateRangeFilter
          dateFrom={filters.dateFrom as string | undefined}
          dateTo={filters.dateTo as string | undefined}
          onApply={(from, to) => setFilters({ dateFrom: from, dateTo: to })}
        />
      )}

      {pills.map((key) => {
        const selected = selectedOf(key);
        const first = selected[0];
        return (
          <FilterPill
            key={key}
            label={dimLabel(key)}
            summary={first ? `${labelFor(key, first)}${selected.length > 1 ? ` +${selected.length - 1}` : ''}` : undefined}
            onClear={() => setFilters({ [PARAM_FOR[key]]: undefined })}
            defaultOpen={autoOpen === key}
          >
            {pickerFor(key)}
          </FilterPill>
        );
      })}

      {more.length > 0 && (
        <AddFilterMenu
          options={more.map((k) => ({ key: k, label: dimLabel(k) }))}
          onPick={(k) => { setRevealed((r) => [...r, k]); setAutoOpen(k); }}
        />
      )}

      {children}

      <div className="spacer" style={{ flexShrink: 0 }} />

      {extra}

      {activeCount > 0 && (
        <Button
          variant="ghost" size="sm" icon={<X size={14} />}
          onClick={() => { setRevealed([]); clearFilters(['view', 'tab']); }}
          style={{ flexShrink: 0 }}
        >
          Clear all ({activeCount})
        </Button>
      )}
    </div>
  );
}

/** "+ Filter": the dimensions that have no pill yet. */
function AddFilterMenu({ options, onPick }: { options: { key: FilterKey; label: string }[]; onPick: (k: FilterKey) => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLButtonElement>(null);
  const menuId = useId();
  useMenuAutofocus(open, menuId);
  return (
    <>
      <Button ref={ref} variant="ghost" size="sm" icon={<Plus size={14} />} onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open}>
        Filter
      </Button>
      <Popover anchorRef={ref} open={open} onClose={() => setOpen(false)}>
        <div id={menuId} role="menu" aria-label="Add a filter" className="menu-list" onKeyDown={menuKeyNav}>
          <MenuList
            items={options.map((o) => ({ key: o.key, label: o.label }))}
            onAction={(a) => { setOpen(false); onPick(a.key as FilterKey); }}
          />
        </div>
      </Popover>
    </>
  );
}

/**
 * Date range: presets marked with a check (not a primary-coloured button),
 * a single date, and a custom from/to with validation.
 */
function DateRangeFilter({
  dateFrom, dateTo, onApply,
}: {
  dateFrom?: string;
  dateTo?: string;
  onApply: (from?: string, to?: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [fromVal, setFromVal] = useState(dateFrom ?? '');
  const [toVal, setToVal] = useState(dateTo ?? '');
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setFromVal(dateFrom ?? '');
    setToVal(dateTo ?? '');
  }, [dateFrom, dateTo]);

  const activePreset = DATE_PRESETS.find((p) => p.from() === dateFrom && p.to() === dateTo);
  const isInvalid = Boolean(fromVal && toVal && fromVal > toVal);
  const applied = Boolean(dateFrom || dateTo);

  const displayLabel = activePreset
    ? activePreset.label
    : dateFrom && dateTo
      ? dateFrom === dateTo ? formatDate(dateFrom) : `${formatDate(dateFrom)} – ${formatDate(dateTo)}`
      : dateFrom
        ? `From ${formatDate(dateFrom)}`
        : dateTo
          ? `Up to ${formatDate(dateTo)}`
          : 'Date range';

  const apply = (f?: string, t?: string) => { onApply(f, t); setOpen(false); triggerRef.current?.focus(); };

  return (
    <>
      <span className={`filter-pill ${applied ? 'is-applied' : ''}`}>
        <button
          ref={triggerRef}
          type="button"
          className="filter-pill-main"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <CalendarDays size={14} aria-hidden />
          <span>{applied ? `Date: ${displayLabel}` : 'Date range'}</span>
          <ChevronDown size={13} aria-hidden style={{ opacity: 0.7 }} />
        </button>
        {applied && (
          <button type="button" className="filter-pill-clear" onClick={() => onApply(undefined, undefined)} aria-label="Clear date range">
            <X size={13} />
          </button>
        )}
      </span>

      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} role="dialog" label="Date range">
        <div style={{ width: 300, padding: 'var(--space-2)' }}>
          <div className="menu-label">Presets</div>
          <div role="listbox" aria-label="Date presets" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 2 }}>
            {DATE_PRESETS.map((p) => {
              const on = activePreset?.key === p.key;
              return (
                <button
                  key={p.key}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className="menu-item"
                  style={{ minHeight: 30, fontWeight: on ? 600 : 400 }}
                  onClick={() => { const f = p.from(); const t = p.to(); setFromVal(f); setToVal(t); apply(f, t); }}
                >
                  <span style={{ width: 16, display: 'grid', placeItems: 'center' }}>{on && <Check size={15} strokeWidth={2.5} style={{ color: 'var(--accent)' }} />}</span>
                  {p.label}
                </button>
              );
            })}
          </div>

          <div className="menu-sep" />
          <div className="menu-label">Single date</div>
          <div style={{ padding: '0 var(--space-2-5) var(--space-2)' }}>
            <input
              type="date"
              className="input input-sm"
              aria-label="Single date"
              value={fromVal && fromVal === toVal ? fromVal : ''}
              onChange={(e) => { const v = e.target.value; if (v) { setFromVal(v); setToVal(v); apply(v, v); } }}
            />
          </div>

          <div className="menu-sep" />
          <div className="menu-label">Custom range</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-2)', padding: '0 var(--space-2-5)' }}>
            <label className="field">
              <span className="field-label">From</span>
              <input type="date" className="input input-sm" value={fromVal} onChange={(e) => setFromVal(e.target.value)} />
            </label>
            <label className="field">
              <span className="field-label">To</span>
              <input type="date" className="input input-sm" value={toVal} onChange={(e) => setToVal(e.target.value)} aria-invalid={isInvalid || undefined} />
            </label>
          </div>
          {isInvalid && (
            <div className="field-error" style={{ padding: '6px var(--space-2-5) 0' }} role="alert">
              <AlertCircle size={12} aria-hidden /> From date cannot be later than To date.
            </div>
          )}

          <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--space-2)', padding: 'var(--space-3) var(--space-2-5) var(--space-1)' }}>
            <Button variant="ghost" size="sm" onClick={() => { setFromVal(''); setToVal(''); apply(undefined, undefined); }}>
              Reset
            </Button>
            <Button variant="primary" size="sm" disabled={isInvalid} onClick={() => { if (!isInvalid) apply(fromVal || undefined, toVal || undefined); }}>
              Apply
            </Button>
          </div>
        </div>
      </Popover>
    </>
  );
}

/**
 * One pill per filter dimension. With a value it shows the value and an ×;
 * clicking opens a small searchable checklist under it.
 */
function FilterPill({
  label, summary, onClear, children, defaultOpen,
}: { label: string; summary?: string; onClear: () => void; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(Boolean(defaultOpen));
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (defaultOpen) setOpen(true); }, [defaultOpen]);

  return (
    <>
      <span className={`filter-pill ${summary ? 'is-applied' : ''}`}>
        <button
          ref={triggerRef}
          type="button"
          className="filter-pill-main"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
        >
          <span className="truncate" style={{ maxWidth: 240 }}>{summary ? `${label}: ${summary}` : label}</span>
          <ChevronDown size={13} aria-hidden style={{ opacity: 0.7, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform var(--dur-2) var(--ease-standard)' }} />
        </button>
        {summary && (
          <button type="button" className="filter-pill-clear" onClick={onClear} aria-label={`Clear ${label} filter`}>
            <X size={13} />
          </button>
        )}
      </span>

      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} minWidth={260} role="dialog" label={`${label} filter`}>
        <div style={{ padding: 'var(--space-2)', width: 300, maxWidth: 'calc(100vw - 32px)' }}>{children}</div>
      </Popover>
    </>
  );
}

/** Compact multi-select rendered as a scrollable checkbox list, used inside a FilterPill popover. */
function MultiPicker({
  label, options, selected, onToggle, onSearch,
}: {
  label: string;
  options: { value: string; label: string }[];
  selected: string[];
  onToggle: (value: string) => void;
  /** Search on the server instead of filtering `options` — for lists too long to preload. */
  onSearch?: (term: string) => void;
}) {
  const [term, setTerm] = useState('');
  const filtered = onSearch || !term
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(term.toLowerCase()));

  return (
    <div className="field" style={{ margin: 0, gap: 6 }}>
      {(onSearch || options.length > 6) && (
        <div style={{ position: 'relative' }}>
          <Search size={14} aria-hidden style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-4)' }} />
          <input
            className="input input-sm"
            placeholder={`Search ${label.toLowerCase()}…`}
            aria-label={`Search ${label.toLowerCase()}`}
            value={term}
            onChange={(e) => { setTerm(e.target.value); onSearch?.(e.target.value); }}
            style={{ paddingLeft: 28 }}
            autoFocus
          />
        </div>
      )}
      <div style={{ maxHeight: 260, overflowY: 'auto' }} role="group" aria-label={label}>
        {filtered.length === 0 && (
          <div style={{ padding: 8, fontSize: 'var(--fs-13)', color: 'var(--text-3)', textAlign: 'center' }}>
            {onSearch && !term ? `Type to search ${label.toLowerCase()}` : 'No options'}
          </div>
        )}
        {filtered.map((o) => (
          <label key={o.value} className="check-row" style={{ padding: '4px 6px', fontSize: 'var(--fs-13)' }}>
            <input
              type="checkbox" className="checkbox"
              checked={selected.includes(o.value)}
              onChange={() => onToggle(o.value)}
            />
            <span className="truncate">{o.label}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
