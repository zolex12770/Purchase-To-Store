/**
 * DataTable — the standard every important list obeys (SRS §14, §33).
 *
 * Search · sort · server-side pagination · column visibility · row click ·
 * export · print · loading / empty / error states · totals footer.
 *
 * Sorting and paging are SERVER-side by design: the browser must never be asked
 * to hold or filter an enterprise-sized dataset (SRS §30).
 */
import { useState, useMemo, type ReactNode } from 'react';
import {
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight,
  Search, Settings2, Download, Printer, X, Inbox,
} from 'lucide-react';
import { Button, EmptyState, ErrorState, SkeletonTable } from './ui';
import type { PageMeta } from '../lib/api';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. Receives the row and its index. */
  render: (row: T, index: number) => ReactNode;
  /** Server sort key; omit to make the column unsortable. */
  sortKey?: string;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Hidden by default but available in the column picker. */
  optional?: boolean;
  /** Never offered in the column picker (e.g. the actions column). */
  locked?: boolean;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  loading?: boolean;
  error?: unknown;
  onRetry?: () => void;

  /** Search box — omit `onSearchChange` to hide it. */
  search?: string;
  onSearchChange?: (value: string) => void;
  searchPlaceholder?: string;

  sortBy?: string;
  sortDir?: 'asc' | 'desc';
  onSortChange?: (sortBy: string, sortDir: 'asc' | 'desc') => void;

  meta?: PageMeta;
  onPageChange?: (page: number) => void;
  onPageSizeChange?: (size: number) => void;

  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;

  toolbar?: ReactNode;
  onExport?: (format: 'xlsx' | 'csv') => void;
  onPrint?: () => void;

  emptyTitle?: string;
  emptyMessage?: ReactNode;
  emptyAction?: ReactNode;

  /** Totals row rendered in <tfoot>. */
  footer?: ReactNode;
  compact?: boolean;
  /** Persist column visibility under this key. */
  storageKey?: string;
}

const PAGE_SIZES = [10, 25, 50, 100, 200];

export function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry,
  search, onSearchChange, searchPlaceholder = 'Search…',
  sortBy, sortDir = 'desc', onSortChange,
  meta, onPageChange, onPageSizeChange,
  onRowClick, selectedKey,
  toolbar, onExport, onPrint,
  emptyTitle = 'Nothing to show', emptyMessage, emptyAction,
  footer, compact, storageKey,
}: DataTableProps<T>) {
  const [showColumns, setShowColumns] = useState(false);

  const [hidden, setHidden] = useState<Set<string>>(() => {
    // Optional columns start hidden; a saved preference wins.
    const stored = storageKey ? localStorage.getItem(`zx.cols.${storageKey}`) : null;
    if (stored) {
      try { return new Set(JSON.parse(stored) as string[]); } catch { /* fall through */ }
    }
    return new Set(columns.filter((c) => c.optional).map((c) => c.key));
  });

  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    if (!storageKey) return {};
    const stored = localStorage.getItem(`zx.widths.${storageKey}`);
    if (stored) {
      try { return JSON.parse(stored) as Record<string, number>; } catch { /* ignore */ }
    }
    return {};
  });

  const [isResizing, setIsResizing] = useState(false);

  const startResize = (e: React.MouseEvent, key: string, thEl: HTMLElement | null) => {
    e.stopPropagation();
    e.preventDefault();
    const currentWidth = thEl ? thEl.getBoundingClientRect().width : (colWidths[key] ?? 120);
    const startX = e.clientX;
    setIsResizing(true);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.max(60, Math.round(currentWidth + delta));
      setColWidths((prev) => {
        const next = { ...prev, [key]: nextWidth };
        if (storageKey) {
          try { localStorage.setItem(`zx.widths.${storageKey}`, JSON.stringify(next)); } catch { /* quota */ }
        }
        return next;
      });
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  };

  const toggleColumn = (key: string) => {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      if (storageKey) {
        try { localStorage.setItem(`zx.cols.${storageKey}`, JSON.stringify([...next])); } catch { /* quota */ }
      }
      return next;
    });
  };

  const visible = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);
  const configurable = columns.filter((c) => !c.locked);

  const handleSort = (col: Column<T>) => {
    if (!col.sortKey || !onSortChange) return;
    if (sortBy === col.sortKey) onSortChange(col.sortKey, sortDir === 'asc' ? 'desc' : 'asc');
    else onSortChange(col.sortKey, 'desc');
  };

  const showToolbar = Boolean(onSearchChange || toolbar || onExport || onPrint || configurable.length > 0);

  return (
    <div className="card" style={{ overflow: 'hidden' }}>
      {showToolbar && (
        <div
          className="row filter-bar"
          style={{
            gap: 'var(--sp-2)', padding: 'var(--sp-3) var(--sp-4)',
            borderBottom: '1px solid var(--border-subtle)', flexWrap: 'wrap',
          }}
        >
          {onSearchChange && (
            <div style={{ position: 'relative', minWidth: 240, flex: '0 1 320px' }}>
              <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', pointerEvents: 'none' }} />
              <input
                className="input input-sm"
                style={{ paddingLeft: 32, paddingRight: search ? 30 : 10 }}
                placeholder={searchPlaceholder}
                value={search ?? ''}
                onChange={(e) => onSearchChange(e.target.value)}
                aria-label="Search"
              />
              {search && (
                <button
                  onClick={() => onSearchChange('')}
                  aria-label="Clear search"
                  style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'grid', placeItems: 'center' }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {toolbar}
          <div className="spacer" />

          {meta && (
            <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', whiteSpace: 'nowrap' }}>
              {meta.total.toLocaleString('en-IN')} record{meta.total === 1 ? '' : 's'}
            </span>
          )}

          {configurable.length > 0 && (
            <div style={{ position: 'relative' }}>
              <Button variant="ghost" size="sm" icon={<Settings2 size={13} />} onClick={() => setShowColumns((v) => !v)}>
                Columns
              </Button>
              {showColumns && (
                <>
                  <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setShowColumns(false)} />
                  <div
                    style={{
                      position: 'absolute', right: 0, top: 'calc(100% + 4px)', zIndex: 100,
                      background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
                      padding: 'var(--sp-2)', minWidth: 210, maxHeight: 340, overflowY: 'auto',
                      animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
                    }}
                  >
                    <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '4px 8px 6px' }}>
                      Visible columns
                    </div>
                    {configurable.map((c) => (
                      <label
                        key={c.key}
                        className="check-row"
                        style={{ padding: '5px 8px', borderRadius: 'var(--radius-xs)', fontSize: 'var(--text-sm)' }}
                      >
                        <input
                          type="checkbox" className="checkbox"
                          checked={!hidden.has(c.key)}
                          onChange={() => toggleColumn(c.key)}
                        />
                        <span>{c.header}</span>
                      </label>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {onExport && (
            <div style={{ display: 'flex', gap: 2 }}>
              <Button variant="ghost" size="sm" icon={<Download size={13} />} onClick={() => onExport('xlsx')} title="Export to Excel">
                Excel
              </Button>
              <Button variant="ghost" size="sm" onClick={() => onExport('csv')} title="Export to CSV">CSV</Button>
            </div>
          )}
          {onPrint && (
            <Button variant="ghost" size="sm" icon={<Printer size={13} />} onClick={onPrint} title="Print">Print</Button>
          )}
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonTable rows={8} cols={Math.min(visible.length, 7)} />
      ) : error ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Inbox />} title={emptyTitle} message={emptyMessage} action={emptyAction} />
      ) : (
        <div className="table-wrap" style={{ maxHeight: '68vh' }}>
          <table className={`table ${compact ? 'table-compact' : ''}`}>
            <thead>
              <tr>
                {visible.map((c) => {
                  const isSorted = sortBy && c.sortKey === sortBy;
                  return (
                    <th
                      key={c.key}
                      className={`${c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''} ${c.sortKey && onSortChange ? 'sortable' : ''}`}
                      style={{
                        width: colWidths[c.key] ? `${colWidths[c.key]}px` : c.width,
                        minWidth: colWidths[c.key] ? `${colWidths[c.key]}px` : undefined,
                        position: 'relative',
                        userSelect: isResizing ? 'none' : undefined,
                      }}
                      onClick={() => handleSort(c)}
                      aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                    >
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, justifyContent: c.align === 'right' ? 'flex-end' : undefined, width: '100%' }}>
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.header}</span>
                        {c.sortKey && onSortChange && (
                          isSorted
                            ? (sortDir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />)
                            : <ChevronsUpDown size={11} style={{ opacity: 0.35, flexShrink: 0 }} />
                        )}
                      </span>
                      <div
                        className="col-resizer"
                        onClick={(e) => e.stopPropagation()}
                        onMouseDown={(e) => startResize(e, c.key, e.currentTarget.parentElement)}
                        title="Drag to resize column"
                        style={{
                          position: 'absolute',
                          right: 0,
                          top: 0,
                          bottom: 0,
                          width: '7px',
                          cursor: 'col-resize',
                          userSelect: 'none',
                          zIndex: 2,
                        }}
                      />
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => {
                const key = rowKey(row);
                return (
                  <tr
                    key={key}
                    className={`${onRowClick ? 'clickable' : ''} ${selectedKey === key ? 'selected' : ''}`}
                    onClick={onRowClick ? () => onRowClick(row) : undefined}
                    tabIndex={onRowClick ? 0 : undefined}
                    onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter') onRowClick(row); } : undefined}
                  >
                    {visible.map((c) => (
                      <td
                        key={c.key}
                        className={c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : ''}
                        style={colWidths[c.key] ? { maxWidth: `${colWidths[c.key]}px` } : undefined}
                      >
                        {c.render(row, i)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
            {footer && <tfoot>{footer}</tfoot>}
          </table>
        </div>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {meta && meta.total > 0 && !loading && !error && (
        <div
          className="row no-print"
          style={{ gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-inset)', flexWrap: 'wrap' }}
        >
          <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
            Showing{' '}
            <strong style={{ color: 'var(--ink-700)' }}>
              {((meta.page - 1) * meta.pageSize + 1).toLocaleString('en-IN')}–
              {Math.min(meta.page * meta.pageSize, meta.total).toLocaleString('en-IN')}
            </strong>{' '}
            of <strong style={{ color: 'var(--ink-700)' }}>{meta.total.toLocaleString('en-IN')}</strong>
          </span>

          {onPageSizeChange && (
            <>
              <div className="divider-v" style={{ height: 18 }} />
              <label className="row" style={{ gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Rows
                <select
                  className="select input-sm"
                  style={{ width: 72, height: 26 }}
                  value={meta.pageSize}
                  onChange={(e) => onPageSizeChange(Number(e.target.value))}
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </>
          )}

          <div className="spacer" />

          {onPageChange && meta.totalPages > 1 && (
            <div className="row" style={{ gap: 4 }}>
              <Button variant="ghost" size="sm" disabled={!meta.hasPrev} onClick={() => onPageChange(1)} title="First page">«</Button>
              <Button variant="ghost" size="sm" disabled={!meta.hasPrev} onClick={() => onPageChange(meta.page - 1)} title="Previous page">
                <ChevronLeft size={14} />
              </Button>
              {pageNumbers(meta.page, meta.totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`gap-${i}`} style={{ padding: '0 4px', color: 'var(--text-faint)', fontSize: 'var(--text-xs)' }}>…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === meta.page ? 'primary' : 'ghost'}
                    size="sm"
                    onClick={() => onPageChange(p as number)}
                    style={{ minWidth: 30, padding: '0 6px' }}
                    aria-current={p === meta.page ? 'page' : undefined}
                  >
                    {p}
                  </Button>
                ),
              )}
              <Button variant="ghost" size="sm" disabled={!meta.hasNext} onClick={() => onPageChange(meta.page + 1)} title="Next page">
                <ChevronRight size={14} />
              </Button>
              <Button variant="ghost" size="sm" disabled={!meta.hasNext} onClick={() => onPageChange(meta.totalPages)} title="Last page">»</Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Compact page list: 1 … 4 5 6 … 20 */
function pageNumbers(current: number, total: number): (number | '…')[] {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const out: (number | '…')[] = [1];
  const start = Math.max(2, current - 1);
  const end = Math.min(total - 1, current + 1);
  if (start > 2) out.push('…');
  for (let p = start; p <= end; p++) out.push(p);
  if (end < total - 1) out.push('…');
  out.push(total);
  return out;
}
