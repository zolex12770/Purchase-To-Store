/**
 * Universal filter bar (SRS §14).
 *
 * One reusable engine drives filtering on every list and analytical view. It
 * writes to the URL (see `useFilters`), so the applied filters travel with a
 * drill-down, survive a refresh, and are shareable as a link.
 *
 * Each dimension is its OWN compact toolbar button — [Department ▾] — that
 * opens a small popover on click (Google Sheets / Power BI style), rather
 * than one "Filters (N)" button expanding every configured dimension into a
 * single full-width panel at once. The toolbar row never grows vertically:
 * if there are more pills than fit, the row scrolls horizontally instead.
 *
 * Supports:
 * - Direct From Date and To Date calendar inputs + presets with validation
 * - Employee / User filtering
 * - HOD filtering
 * - QC Status filtering
 * - Item searching and filtering
 * - Department, Cost Centre, Supplier, PO Type, Indent Type, Machine, Status
 */
import { useState, useRef, useEffect, useLayoutEffect, useCallback, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X, CalendarDays, AlertCircle } from 'lucide-react';
import { Button, Chip } from './ui';
import {
  useLookups, useSupplierSearch, useItemSearch, useUserOptions,
  CATEGORY_LABEL, type LookupCategory,
} from '../lib/masters';
import { useAuth } from '../lib/auth';
import { useDebounced } from './simple';
import { today, daysAgo, startOfMonth } from '../lib/format';
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
  { value: 'PENDING_QC', label: 'Pending QC' },
  { value: 'QC_IN_PROGRESS', label: 'QC In Progress' },
  { value: 'QC_PASSED', label: 'QC Passed' },
  { value: 'QC_FAILED', label: 'QC Failed' },
  { value: 'ACCEPTED_WITH_DEVIATION', label: 'Accepted with Deviation' },
  { value: 'ON_HOLD', label: 'On Hold' },
  { value: 'NOT_APPLICABLE', label: 'Not Applicable' },
];

export function FilterBar({
  filters, setFilters, clearFilters, activeCount,
  show = ['dateRange', 'supplier', 'department', 'costCentre'],
  statusOptions,
  extra,
  children,
}: {
  filters: FilterState;
  setFilters: (patch: Partial<FilterState>) => void;
  clearFilters: (keep?: string[]) => void;
  activeCount: number;
  show?: FilterKey[];
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
  const itemFilter = show.includes('item');
  const [itemTerm, setItemTerm] = useState('');
  const { data: items } = useItemSearch(useDebounced(itemTerm.trim(), 250));
  const itemNames = useRef(new Map<string, string>());
  for (const i of items ?? []) itemNames.current.set(String(i.id), `${i.item_code} - ${i.item_description}`);

  const labelFor = (key: FilterKey, id: string): string => {
    if (key === 'supplier') return supplierNames.current.get(id) ?? `#${id}`;
    if (key === 'user') return userNames.current.get(id) ?? `#${id}`;
    if (key === 'hod') return userNames.current.get(id) ?? `#${id}`;
    if (key === 'item') return itemNames.current.get(id) ?? `#${id}`;
    if (key === 'status') return id.replace(/_/g, ' ');
    if (key === 'qcStatus') {
      const match = QC_STATUS_OPTIONS.find((o) => o.value === id);
      return match?.label ?? id.replace(/_/g, ' ');
    }
    const category = CATEGORY_FOR[key];
    if (!category || !lookups) return `#${id}`;
    return lookups[category]?.find((o) => String(o.id) === id)?.name ?? `#${id}`;
  };

  const toggleValue = (param: string, value: string) => {
    const current = (filters[param] as string[] | undefined) ?? [];
    const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
    setFilters({ [param]: next });
  };

  const activePreset = DATE_PRESETS.find(
    (p) => p.from() === filters.dateFrom && p.to() === filters.dateTo,
  );

  /* ── Chips for everything currently applied ────────────────────────────── */
  const chips: { label: string; onRemove: () => void }[] = [];

  if (filters.dateFrom || filters.dateTo) {
    chips.push({
      label: activePreset
        ? `Date: ${activePreset.label}`
        : `Date: ${filters.dateFrom ?? 'Start'} → ${filters.dateTo ?? 'End'}`,
      onRemove: () => setFilters({ dateFrom: undefined, dateTo: undefined }),
    });
  }

  for (const key of show) {
    if (key === 'dateRange') continue;
    const param = PARAM_FOR[key];
    for (const id of ((filters[param] as string[] | undefined) ?? [])) {
      let dimLabel = 'Filter';
      if (key === 'status') dimLabel = 'Status';
      else if (key === 'qcStatus') dimLabel = 'QC Status';
      else if (key === 'user') dimLabel = 'User';
      else if (key === 'hod') dimLabel = 'HOD';
      else if (key === 'item') dimLabel = 'Item';
      else if (key === 'supplier') dimLabel = 'Supplier';
      else if (CATEGORY_FOR[key]) dimLabel = CATEGORY_LABEL[CATEGORY_FOR[key]!];

      chips.push({
        label: `${dimLabel}: ${labelFor(key, id)}`,
        onRemove: () => toggleValue(param, id),
      });
    }
  }

  return (
    <div className="card filter-bar" style={{ marginBottom: 'var(--sp-4)' }}>
      <div
        className="row"
        style={{
          gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-4)',
          flexWrap: 'nowrap', overflowX: 'auto', overflowY: 'hidden',
          scrollbarWidth: 'thin', WebkitOverflowScrolling: 'touch',
          alignItems: 'center',
        }}
      >
        {/* ── Date range picker ────────────────────────────────────────────── */}
        {show.includes('dateRange') && (
          <DateRangeFilter
            dateFrom={filters.dateFrom as string | undefined}
            dateTo={filters.dateTo as string | undefined}
            onApply={(from, to) => setFilters({ dateFrom: from, dateTo: to })}
          />
        )}

        {/* ── Employee / User filter ───────────────────────────────────────── */}
        {show.includes('user') && (
          <FilterPill label="Employee" count={((filters.userId as string[]) ?? []).length}>
            <MultiPicker
              label="Employee"
              options={(users ?? []).map((u) => ({
                value: String(u.id),
                label: `${u.employeeName} (${u.employeeId})${u.departmentName ? ' · ' + u.departmentName : ''}`,
              }))}
              selected={(filters.userId as string[]) ?? []}
              onToggle={(v) => toggleValue('userId', v)}
            />
          </FilterPill>
        )}

        {/* ── HOD filter ───────────────────────────────────────────────────── */}
        {show.includes('hod') && (
          <FilterPill label="HOD" count={((filters.hodId as string[]) ?? []).length}>
            <MultiPicker
              label="HOD"
              options={(users ?? [])
                .filter((u) => u.isHod || true)
                .map((u) => ({
                  value: String(u.id),
                  label: `${u.employeeName} (${u.employeeId})${u.departmentName ? ' · ' + u.departmentName : ''}${u.isHod ? ' [HOD]' : ''}`,
                }))}
              selected={(filters.hodId as string[]) ?? []}
              onToggle={(v) => toggleValue('hodId', v)}
            />
          </FilterPill>
        )}

        {/* ── Supplier filter ──────────────────────────────────────────────── */}
        {supplierFilter && (
          <FilterPill label="Supplier" count={((filters.supplierId as string[]) ?? []).length}>
            <MultiPicker
              label="Supplier"
              options={(suppliers ?? []).map((s) => ({ value: String(s.id), label: s.supplier_name }))}
              selected={(filters.supplierId as string[]) ?? []}
              onToggle={(v) => toggleValue('supplierId', v)}
              onSearch={setSupplierTerm}
            />
          </FilterPill>
        )}

        {/* ── Item filter ──────────────────────────────────────────────────── */}
        {itemFilter && (
          <FilterPill label="Item" count={((filters.itemId as string[]) ?? []).length}>
            <MultiPicker
              label="Item"
              options={(items ?? []).map((i) => ({
                value: String(i.id),
                label: `${i.item_code} · ${i.item_description}`,
              }))}
              selected={(filters.itemId as string[]) ?? []}
              onToggle={(v) => toggleValue('itemId', v)}
              onSearch={setItemTerm}
            />
          </FilterPill>
        )}

        {/* ── QC Status filter ─────────────────────────────────────────────── */}
        {show.includes('qcStatus') && (
          <FilterPill label="QC Status" count={((filters.qcStatus as string[]) ?? []).length}>
            <MultiPicker
              label="QC Status"
              options={QC_STATUS_OPTIONS}
              selected={(filters.qcStatus as string[]) ?? []}
              onToggle={(v) => toggleValue('qcStatus', v)}
            />
          </FilterPill>
        )}

        {/* ── Lookup-driven category filters ───────────────────────────────── */}
        {show.filter((k) => CATEGORY_FOR[k]).map((key) => {
          const category = CATEGORY_FOR[key]!;
          const selected = (filters[PARAM_FOR[key]] as string[]) ?? [];
          return (
            <FilterPill key={key} label={CATEGORY_LABEL[category]} count={selected.length}>
              <MultiPicker
                label={CATEGORY_LABEL[category]}
                options={(lookups?.[category] ?? []).map((o) => ({ value: String(o.id), label: o.name }))}
                selected={selected}
                onToggle={(v) => toggleValue(PARAM_FOR[key], v)}
              />
            </FilterPill>
          );
        })}

        {/* ── Document Status filter ───────────────────────────────────────── */}
        {show.includes('status') && statusOptions && (
          <FilterPill label="Status" count={((filters.status as string[]) ?? []).length}>
            <MultiPicker
              label="Status"
              options={statusOptions}
              selected={(filters.status as string[]) ?? []}
              onToggle={(v) => toggleValue('status', v)}
            />
          </FilterPill>
        )}

        {children}

        <div className="spacer" style={{ flexShrink: 0 }} />

        {extra}

        {activeCount > 0 && (
          <Button
            variant="ghost" size="sm" icon={<X size={13} />}
            onClick={() => clearFilters(['view', 'tab'])}
            style={{ flexShrink: 0 }}
          >
            Clear{activeCount > 0 ? ` (${activeCount})` : ''}
          </Button>
        )}
      </div>

      {chips.length > 0 && (
        <div
          className="row"
          style={{ gap: 6, padding: '0 var(--sp-4) var(--sp-3)', flexWrap: 'wrap' }}
        >
          {chips.map((c, i) => <Chip key={i} onRemove={c.onRemove}>{c.label}</Chip>)}
        </div>
      )}
    </div>
  );
}

/**
 * Dedicated date range filter popover supporting quick presets and manual calendar inputs.
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
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setFromVal(dateFrom ?? '');
    setToVal(dateTo ?? '');
  }, [dateFrom, dateTo]);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: 310 });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const activePreset = DATE_PRESETS.find((p) => p.from() === dateFrom && p.to() === dateTo);
  const isInvalid = Boolean(fromVal && toVal && fromVal > toVal);

  const displayLabel = activePreset
    ? activePreset.label
    : dateFrom && dateTo
      ? `${dateFrom} → ${dateTo}`
      : dateFrom
        ? `From ${dateFrom}`
        : dateTo
          ? `Up to ${dateTo}`
          : 'Date Range';

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-sm ${dateFrom || dateTo ? 'btn-primary' : 'btn-secondary'}`}
        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <CalendarDays size={13} style={{ opacity: 0.8 }} />
        <span>{displayLabel}</span>
        <ChevronDown size={12} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : undefined }} />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed', top: rect.top, left: rect.left, width: rect.width,
            background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 12,
            zIndex: 'var(--z-dropdown)' as unknown as number,
            animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
          }}
        >
          <div style={{ marginBottom: 10, paddingBottom: 8, borderBottom: '1px solid var(--border)' }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-xs)', marginBottom: 6, color: 'var(--text-muted)' }}>
              EXACT SINGLE DATE
            </div>
            <input
              type="date"
              className="input input-sm"
              style={{ width: '100%', height: 28 }}
              value={fromVal === toVal ? fromVal : ''}
              onChange={(e) => {
                const val = e.target.value;
                if (val) {
                  setFromVal(val);
                  setToVal(val);
                  onApply(val, val);
                  setOpen(false);
                }
              }}
            />
          </div>

          <div style={{ fontWeight: 600, fontSize: 'var(--text-xs)', marginBottom: 8, color: 'var(--text-muted)' }}>
            QUICK PRESETS
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 4, marginBottom: 12 }}>
            {DATE_PRESETS.map((p) => (
              <button
                key={p.key}
                type="button"
                className={`btn btn-xs ${activePreset?.key === p.key ? 'btn-primary' : 'btn-ghost'}`}
                style={{ justifyContent: 'flex-start', fontSize: 'var(--text-2xs)' }}
                onClick={() => {
                  const f = p.from();
                  const t = p.to();
                  setFromVal(f);
                  setToVal(t);
                  onApply(f, t);
                  setOpen(false);
                }}
              >
                {p.label}
              </button>
            ))}
          </div>

          <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, marginBottom: 8 }}>
            <div style={{ fontWeight: 600, fontSize: 'var(--text-xs)', marginBottom: 8, color: 'var(--text-muted)' }}>
              MANUAL CALENDAR
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div>
                <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>
                  From Date
                </label>
                <input
                  type="date"
                  className="input input-sm"
                  style={{ width: '100%', height: 28 }}
                  value={fromVal}
                  onChange={(e) => setFromVal(e.target.value)}
                />
              </div>
              <div>
                <label style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', display: 'block', marginBottom: 2 }}>
                  To Date
                </label>
                <input
                  type="date"
                  className="input input-sm"
                  style={{ width: '100%', height: 28 }}
                  value={toVal}
                  onChange={(e) => setToVal(e.target.value)}
                />
              </div>
            </div>

            {isInvalid && (
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 5,
                  color: 'var(--danger-600)', fontSize: 'var(--text-2xs)',
                  marginTop: 6,
                }}
              >
                <AlertCircle size={12} />
                <span>From Date cannot be later than To Date.</span>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 6, marginTop: 10 }}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setFromVal('');
                setToVal('');
                onApply(undefined, undefined);
                setOpen(false);
              }}
            >
              Reset
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={isInvalid}
              onClick={() => {
                if (!isInvalid) {
                  onApply(fromVal || undefined, toVal || undefined);
                  setOpen(false);
                }
              }}
            >
              Apply Filter
            </Button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/**
 * One toolbar pill for a single filter dimension. Clicking it opens a small,
 * independently-positioned popover directly under the pill.
 */
function FilterPill({ label, count, children }: { label: string; count: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    setRect({ top: r.bottom + 4, left: r.left, width: Math.max(r.width, 240) });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (triggerRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`btn btn-sm ${count > 0 ? 'btn-primary' : 'btn-secondary'}`}
        style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, whiteSpace: 'nowrap' }}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
      >
        <span>{label}</span>
        {count > 0 && (
          <span style={{ fontWeight: 700, fontSize: 'var(--text-2xs)' }}>({count})</span>
        )}
        <ChevronDown size={12} style={{ opacity: 0.6, transform: open ? 'rotate(180deg)' : undefined, transition: 'transform var(--dur-fast) var(--ease)' }} />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          style={{
            position: 'fixed', top: rect.top, left: rect.left, width: rect.width,
            background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)', padding: 8,
            zIndex: 'var(--z-dropdown)' as unknown as number,
            animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
          }}
        >
          {children}
        </div>,
        document.body,
      )}
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
    <div className="field" style={{ margin: 0 }}>
      {(onSearch || options.length > 6) && (
        <input
          className="input input-sm"
          placeholder={`Search ${label.toLowerCase()}…`}
          value={term}
          onChange={(e) => { setTerm(e.target.value); onSearch?.(e.target.value); }}
          style={{ marginBottom: 6 }}
          autoFocus
        />
      )}
      <div style={{ maxHeight: 260, overflowY: 'auto' }}>
        {filtered.length === 0 && (
          <div style={{ padding: 8, fontSize: 'var(--text-xs)', color: 'var(--text-faint)', textAlign: 'center' }}>
            No options
          </div>
        )}
        {filtered.map((o) => (
          <label
            key={o.value}
            className="check-row"
            style={{ padding: '4px 6px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-xs)', cursor: 'pointer' }}
          >
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
