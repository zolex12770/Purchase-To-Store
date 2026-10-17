/**
 * DataTable — the standard every important list obeys (SRS §14, §33;
 * redesign spec §3.7).
 *
 * Search · sort · server-side pagination · column visibility · column resize ·
 * row click · selection · density · export · print · loading / empty / error
 * states · totals footer · frozen identifier and status/actions columns.
 *
 * Sorting and paging are SERVER-side by design: the browser must never be asked
 * to hold or filter an enterprise-sized dataset (SRS §30). A list that already
 * holds every row client-side can still page it (`clientPageSize`) instead of
 * rendering thousands of rows (audit UI-008: 2,327 rows in one table).
 */
import {
  Children, cloneElement, isValidElement, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState,
  type ReactElement, type ReactNode,
} from 'react';
import {
  ChevronUp, ChevronDown, ChevronsUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight,
  Search, Settings2, Download, Printer, X, Inbox, Rows3, Rows2,
} from 'lucide-react';
import { Banner, Button, EmptyState, ErrorState, IconButton, OverflowMenu, Popover, SkeletonTable } from './ui';
import { autoFrozenRight, columnKind, planLegacyFooter, sentenceCaseHeader } from './dataTableModel';
import type { PageMeta } from '../lib/api';

export { sentenceCaseHeader } from './dataTableModel';

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
  /** Freeze the column while the table scrolls sideways. */
  sticky?: 'left' | 'right';
  /**
   * Totals cell for this column. The footer is built from the VISIBLE
   * columns, so it can never drift from the header (v2 PoList hard-coded
   * colSpan 7 and rendered 12 cells under 10 columns, audit UI-006).
   */
  footer?: ReactNode | ((rows: T[]) => ReactNode);
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
  /** Page rows held client-side instead of rendering them all (no `meta`). */
  clientPageSize?: number;

  onRowClick?: (row: T) => void;
  selectedKey?: string | number | null;

  toolbar?: ReactNode;
  onExport?: (format: 'xlsx' | 'csv') => void;
  onPrint?: () => void;

  emptyTitle?: string;
  emptyMessage?: ReactNode;
  emptyAction?: ReactNode;

  /**
   * Totals row. Prefer per-column `footer` renderers (plus `footerLabel`).
   * A function receives the visible columns. A legacy `<tr>`, written for the
   * default columns, has each cell placed under its own column whatever the
   * user shows or hides (planLegacyFooter).
   */
  footer?: ReactNode | ((visible: Column<T>[]) => ReactNode);
  /** Label in the leading footer cell when columns define `footer`. */
  footerLabel?: ReactNode;
  /** Tighter rows still (modals, detail panels). */
  compact?: boolean;
  /** Persist column visibility, widths and density under this key. */
  storageKey?: string;
  /** Freeze the first visible column (the identifier). Default on. */
  freezeFirstColumn?: boolean;
  /**
   * Freeze the last visible column. 'auto' (default) freezes a trailing
   * status column and a narrow trailing actions column (with the status column
   * before it), so status and row actions stay in view on a table wider than
   * the screen (audit UI-007: PO status 296 px off-screen) — but never a wide
   * column over the status (dataTableModel.autoFrozenRight).
   */
  freezeLastColumn?: boolean | 'auto';
}

const PAGE_SIZES = [10, 25, 50, 100, 200];

const read = (key: string): string | null => {
  try { return localStorage.getItem(key); } catch { return null; }
};
const write = (key: string, value: string) => {
  try { localStorage.setItem(key, value); } catch { /* quota or blocked storage */ }
};

type CellProps = { colSpan?: number; className?: string; style?: React.CSSProperties };

/**
 * Lays a hand-built `<tr>` totals row under the visible columns: each cell
 * goes under the column it was written for (planLegacyFooter), and cells under
 * frozen columns freeze too, blanks included, so a frozen column never shows
 * another column's total sliding underneath it. A row that cannot be matched
 * to the columns is left out rather than shown under the wrong headers.
 */
function normaliseFooterRow(
  node: ReactNode, defaultKeys: string[], visibleKeys: string[],
  sticky: (colIndex: number) => { className: string; style?: React.CSSProperties },
): ReactNode {
  if (!isValidElement(node) || node.type !== 'tr') return node;
  const tr = node as ReactElement<{ children?: ReactNode }>;
  const cells = Children.toArray(tr.props.children).filter(isValidElement) as ReactElement<CellProps>[];
  if (cells.length === 0) return node;
  const plan = planLegacyFooter(cells.map((c) => Number(c.props.colSpan) || 1), defaultKeys, visibleKeys);
  if (!plan) return null;
  return cloneElement(tr, {}, ...plan.map((slot) => {
    const sp = slot.span === 1 ? sticky(slot.start) : { className: '', style: undefined };
    if (slot.cell === null) {
      return <td key={`blank-${slot.start}`} className={sp.className || undefined} style={sp.style} />;
    }
    const c = cells[slot.cell]!;
    return cloneElement(c, {
      key: c.key ?? `f-${slot.cell}`,
      colSpan: slot.span > 1 ? slot.span : undefined,
      className: [c.props.className, sp.className].filter(Boolean).join(' ') || undefined,
      style: sp.style ? { ...c.props.style, ...sp.style } : c.props.style,
    });
  }));
}

export function DataTable<T>({
  columns, rows, rowKey, loading, error, onRetry,
  search, onSearchChange, searchPlaceholder = 'Search…',
  sortBy, sortDir = 'desc', onSortChange,
  meta, onPageChange, onPageSizeChange, clientPageSize,
  onRowClick, selectedKey,
  toolbar, onExport, onPrint,
  emptyTitle = 'Nothing to show', emptyMessage, emptyAction,
  footer, footerLabel, compact, storageKey,
  freezeFirstColumn = true, freezeLastColumn = 'auto',
}: DataTableProps<T>) {
  const [showColumns, setShowColumns] = useState(false);
  const columnsBtnRef = useRef<HTMLButtonElement>(null);

  const [hidden, setHidden] = useState<Set<string>>(() => {
    // Optional columns start hidden; a saved preference wins.
    const stored = storageKey ? read(`zx.cols.${storageKey}`) : null;
    if (stored) {
      try { return new Set(JSON.parse(stored) as string[]); } catch { /* fall through */ }
    }
    return new Set(columns.filter((c) => c.optional).map((c) => c.key));
  });

  const [colWidths, setColWidths] = useState<Record<string, number>>(() => {
    if (!storageKey) return {};
    const stored = read(`zx.widths.${storageKey}`);
    if (stored) {
      try { return JSON.parse(stored) as Record<string, number>; } catch { /* ignore */ }
    }
    return {};
  });

  const [density, setDensity] = useState<'compact' | 'comfortable'>(() =>
    (storageKey && read(`zx.density.${storageKey}`) === 'comfortable') ? 'comfortable' : 'compact');
  const toggleDensity = () => {
    setDensity((d) => {
      const next = d === 'compact' ? 'comfortable' : 'compact';
      if (storageKey) write(`zx.density.${storageKey}`, next);
      return next;
    });
  };

  const [resizingKey, setResizingKey] = useState<string | null>(null);

  const startResize = (e: React.MouseEvent<HTMLDivElement>, key: string) => {
    e.stopPropagation();
    e.preventDefault();
    const th = e.currentTarget.closest('th');
    const currentWidth = th ? th.getBoundingClientRect().width : (colWidths[key] ?? 120);
    const startX = e.clientX;
    setResizingKey(key);

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const delta = moveEvent.clientX - startX;
      const nextWidth = Math.max(60, Math.round(currentWidth + delta));
      setColWidths((prev) => {
        const next = { ...prev, [key]: nextWidth };
        if (storageKey) write(`zx.widths.${storageKey}`, JSON.stringify(next));
        return next;
      });
    };

    const handleMouseUp = () => {
      setResizingKey(null);
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
      if (storageKey) write(`zx.cols.${storageKey}`, JSON.stringify([...next]));
      return next;
    });
  };

  const visible = useMemo(() => columns.filter((c) => !hidden.has(c.key)), [columns, hidden]);
  const configurable = columns.filter((c) => !c.locked);

  /* Frozen columns: explicit `sticky`, the identifier on the left, and on the
     right the trailing columns autoFrozenRight() picks from their measured
     widths (set by measure() below), or the last column when asked. */
  const [autoRight, setAutoRight] = useState<string[]>([]);
  const stickySide = useMemo(() => {
    const side: Record<string, 'left' | 'right'> = {};
    visible.forEach((c) => { if (c.sticky) side[c.key] = c.sticky; });
    const first = visible[0];
    const last = visible[visible.length - 1];
    if (visible.length > 2) {
      if (freezeFirstColumn && first && !side[first.key]) side[first.key] = 'left';
      const right = freezeLastColumn === 'auto' ? autoRight : freezeLastColumn && last ? [last.key] : [];
      right.forEach((k) => { if (!side[k] && visible.some((c) => c.key === k)) side[k] = 'right'; });
    }
    return side;
  }, [visible, freezeFirstColumn, freezeLastColumn, autoRight]);

  /* Client-side paging for lists that arrive whole. */
  const [clientPage, setClientPage] = useState(1);
  const [clientSize, setClientSize] = useState(clientPageSize ?? 0);
  useEffect(() => { setClientPage(1); }, [rows.length, clientSize]);
  const clientMeta: PageMeta | undefined = !meta && clientPageSize && rows.length > clientPageSize
    ? (() => {
        const totalPages = Math.max(1, Math.ceil(rows.length / clientSize));
        const page = Math.min(clientPage, totalPages);
        return { page, pageSize: clientSize, total: rows.length, totalPages, hasNext: page < totalPages, hasPrev: page > 1 } as PageMeta;
      })()
    : undefined;
  const pageRows = clientMeta ? rows.slice((clientMeta.page - 1) * clientMeta.pageSize, clientMeta.page * clientMeta.pageSize) : rows;
  const pagerMeta = meta ?? clientMeta;
  const goPage = meta ? onPageChange : clientMeta ? setClientPage : undefined;
  const setSize = meta ? onPageSizeChange : clientMeta ? setClientSize : undefined;

  /* Measure sticky offsets and horizontal overflow (for the frozen-edge shadow). */
  const wrapRef = useRef<HTMLDivElement>(null);
  const headRowRef = useRef<HTMLTableRowElement>(null);
  const [offsets, setOffsets] = useState<Record<string, number>>({});
  const [overflow, setOverflow] = useState({ left: false, right: false });

  const measure = useCallback(() => {
    const wrap = wrapRef.current;
    const row = headRowRef.current;
    if (!wrap || !row) return;
    const cells = Array.from(row.children) as HTMLElement[];
    if (freezeLastColumn === 'auto') {
      // Freezing never changes a column's width, so this settles in one pass.
      const right = autoFrozenRight(
        visible.map((c, i) => ({ key: c.key, kind: columnKind(c), width: cells[i]?.offsetWidth ?? 0 })),
        wrap.clientWidth,
      );
      setAutoRight((prev) => (prev.join('\n') === right.join('\n') ? prev : right));
    }
    const next: Record<string, number> = {};
    let acc = 0;
    visible.forEach((c, i) => { if (stickySide[c.key] === 'left') { next[c.key] = acc; acc += cells[i]?.offsetWidth ?? 0; } });
    acc = 0;
    for (let i = visible.length - 1; i >= 0; i--) {
      const c = visible[i]!;
      if (stickySide[c.key] === 'right') { next[c.key] = acc; acc += cells[i]?.offsetWidth ?? 0; }
    }
    setOffsets((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
    const left = wrap.scrollLeft > 1;
    const right = wrap.scrollLeft + wrap.clientWidth < wrap.scrollWidth - 1;
    setOverflow((p) => (p.left === left && p.right === right ? p : { left, right }));
  }, [visible, stickySide, freezeLastColumn]);

  useLayoutEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(wrap);
    if (headRowRef.current) ro.observe(headRowRef.current);
    wrap.addEventListener('scroll', measure, { passive: true });
    return () => { ro.disconnect(); wrap.removeEventListener('scroll', measure); };
  }, [measure, pageRows.length, loading, error]);

  const lastLeftKey = [...visible].reverse().find((c) => stickySide[c.key] === 'left')?.key;
  const firstRightKey = visible.find((c) => stickySide[c.key] === 'right')?.key;

  const stickyProps = (c: Column<T>) => {
    const side = stickySide[c.key];
    if (!side) return { className: '', style: undefined as React.CSSProperties | undefined };
    const edge = (side === 'left' && c.key === lastLeftKey && overflow.left) || (side === 'right' && c.key === firstRightKey && overflow.right);
    return {
      className: `col-sticky-${side}${edge ? ' is-edge' : ''}`,
      style: { [side]: offsets[c.key] ?? 0 } as React.CSSProperties,
    };
  };

  const alignClass = (c: Column<T>) => (c.align === 'right' ? 'right' : c.align === 'center' ? 'center' : '');

  const handleSort = (col: Column<T>) => {
    if (!col.sortKey || !onSortChange) return;
    if (sortBy === col.sortKey) onSortChange(col.sortKey, sortDir === 'asc' ? 'desc' : 'asc');
    else onSortChange(col.sortKey, 'desc');
  };

  /* Footer: column model first, then a function, then a normalised legacy row. */
  const columnFooter = visible.some((c) => c.footer !== undefined);
  let footerNode: ReactNode = null;
  if (columnFooter) {
    const lead = visible.findIndex((c) => c.footer !== undefined);
    const leadSpan = lead > 0 ? lead : 0;
    // A label cell spanning several columns must not be frozen: pinned, it
    // would slide over the totals as the table scrolls sideways.
    const lead0 = leadSpan === 1 ? stickyProps(visible[0]!) : { className: '', style: undefined };
    footerNode = (
      <tr>
        {leadSpan > 0 && (
          <td colSpan={leadSpan > 1 ? leadSpan : undefined} className={lead0.className} style={lead0.style}>{footerLabel}</td>
        )}
        {visible.slice(leadSpan).map((c) => {
          const sp = stickyProps(c);
          const content = typeof c.footer === 'function' ? (c.footer as (r: T[]) => ReactNode)(pageRows) : c.footer;
          return <td key={c.key} className={`${alignClass(c)} ${sp.className}`} style={sp.style}>{content}</td>;
        })}
      </tr>
    );
  } else if (typeof footer === 'function') {
    footerNode = footer(visible);
  } else if (footer) {
    footerNode = normaliseFooterRow(
      footer,
      columns.filter((c) => !c.optional).map((c) => c.key),
      visible.map((c) => c.key),
      (i) => (visible[i] ? stickyProps(visible[i]!) : { className: '' }),
    );
  }

  const showToolbar = Boolean(onSearchChange || toolbar || onExport || onPrint || configurable.length > 0);
  const recordCount = pagerMeta?.total ?? (loading ? null : rows.length);

  return (
    <div className="card data-table">
      {showToolbar && (
        <div className="table-toolbar">
          {onSearchChange && (
            <div style={{ position: 'relative', minWidth: 220, flex: '0 1 320px' }}>
              <Search size={14} aria-hidden style={{ position: 'absolute', left: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-4)', pointerEvents: 'none' }} />
              <input
                className="input input-sm"
                style={{ paddingLeft: 30, paddingRight: search ? 30 : 10 }}
                placeholder={searchPlaceholder}
                value={search ?? ''}
                onChange={(e) => onSearchChange(e.target.value)}
                aria-label="Search this list"
              />
              {search && (
                <button
                  type="button"
                  onClick={() => onSearchChange('')}
                  aria-label="Clear search"
                  style={{ position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', display: 'grid', placeItems: 'center', width: 20, height: 20, borderRadius: 4 }}
                >
                  <X size={13} />
                </button>
              )}
            </div>
          )}

          {toolbar}
          <div className="spacer" />

          {recordCount !== null && recordCount !== undefined && (
            <span className="table-count">
              {recordCount.toLocaleString('en-IN')} record{recordCount === 1 ? '' : 's'}
            </span>
          )}

          <IconButton
            label={density === 'compact' ? 'Comfortable rows' : 'Compact rows'}
            icon={density === 'compact' ? <Rows2 size={16} /> : <Rows3 size={16} />}
            onClick={toggleDensity}
            aria-pressed={density === 'comfortable'}
          />

          {configurable.length > 0 && (
            <>
              <Button
                ref={columnsBtnRef}
                variant="ghost" size="sm" icon={<Settings2 size={14} />}
                onClick={() => setShowColumns((v) => !v)}
                aria-haspopup="true" aria-expanded={showColumns}
              >
                Columns
              </Button>
              <Popover anchorRef={columnsBtnRef} open={showColumns} onClose={() => setShowColumns(false)} align="end" minWidth={220}>
                <div style={{ padding: 'var(--space-2)' }} role="group" aria-label="Visible columns">
                  <div className="menu-label">Visible columns</div>
                  {configurable.map((c) => (
                    <label key={c.key} className="check-row" style={{ padding: '4px 8px' }}>
                      <input type="checkbox" className="checkbox" checked={!hidden.has(c.key)} onChange={() => toggleColumn(c.key)} />
                      <span>{sentenceCaseHeader(c.header) || c.key}</span>
                    </label>
                  ))}
                </div>
              </Popover>
            </>
          )}

          {onExport && (
            <OverflowMenu
              triggerLabel="Export"
              icon={<Download size={14} />}
              items={[
                { key: 'xlsx', label: 'Excel (.xlsx)', onClick: () => onExport('xlsx') },
                { key: 'csv', label: 'CSV (.csv)', onClick: () => onExport('csv') },
              ]}
            />
          )}
          {onPrint && (
            <Button variant="ghost" size="sm" icon={<Printer size={14} />} onClick={onPrint}>Print</Button>
          )}
        </div>
      )}

      {/* ── Body ─────────────────────────────────────────────────────────── */}
      {loading ? (
        <SkeletonTable rows={8} cols={Math.min(visible.length, 7)} />
      ) : error && rows.length === 0 ? (
        <ErrorState error={error} onRetry={onRetry} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Inbox />} title={emptyTitle} message={emptyMessage} action={emptyAction} />
      ) : (
        <>
          {Boolean(error) && (
            // A background refresh failed: keep the rows on screen and say so.
            <div style={{ padding: 'var(--space-2) var(--space-3) 0' }}>
              <Banner tone="danger" action={onRetry ? <Button size="sm" variant="secondary" onClick={onRetry}>Try again</Button> : undefined}>
                Could not refresh this list{error instanceof Error ? `: ${error.message}` : ''}. Showing the last loaded rows.
              </Banner>
            </div>
          )}
          <div
            ref={wrapRef}
            className="table-wrap"
            style={{ maxHeight: '68vh' }}
          >
            <table className={`table ${compact ? 'table-compact' : density === 'comfortable' ? 'table-comfortable' : ''} ${resizingKey ? 'is-resizing' : ''}`}>
              <thead>
                <tr ref={headRowRef}>
                  {visible.map((c) => {
                    const isSorted = Boolean(sortBy && c.sortKey === sortBy);
                    const sortable = Boolean(c.sortKey && onSortChange);
                    const sp = stickyProps(c);
                    const label = sentenceCaseHeader(c.header);
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        className={`${alignClass(c)} ${sortable ? 'sortable' : ''} ${sp.className}`}
                        style={{
                          ...sp.style,
                          width: colWidths[c.key] ? `${colWidths[c.key]}px` : c.width,
                          minWidth: colWidths[c.key] ? `${colWidths[c.key]}px` : undefined,
                        }}
                        onClick={sortable ? () => handleSort(c) : undefined}
                        aria-sort={isSorted ? (sortDir === 'asc' ? 'ascending' : 'descending') : undefined}
                      >
                        {/* The resizer's positioning context is this inner box, so the
                            <th> itself keeps position: sticky. */}
                        <div className="th-inner">
                          {sortable ? (
                            <button
                              type="button"
                              className="th-sort"
                              onClick={(e) => { e.stopPropagation(); handleSort(c); }}
                              aria-label={`Sort by ${label || c.key}`}
                            >
                              <span className="truncate">{label}</span>
                              {isSorted
                                ? (sortDir === 'asc' ? <ChevronUp size={13} aria-hidden /> : <ChevronDown size={13} aria-hidden />)
                                : <ChevronsUpDown size={12} aria-hidden style={{ opacity: 0.45 }} />}
                            </button>
                          ) : (
                            <span className="truncate">{label}</span>
                          )}
                          <div
                            className={`col-resizer ${resizingKey === c.key ? 'is-active' : ''}`}
                            onClick={(e) => e.stopPropagation()}
                            onMouseDown={(e) => startResize(e, c.key)}
                            title="Drag to resize column"
                            aria-hidden
                          />
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((row, i) => {
                  const key = rowKey(row);
                  return (
                    <tr
                      key={key}
                      className={`${onRowClick ? 'clickable' : ''} ${selectedKey === key ? 'selected' : ''}`}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                      tabIndex={onRowClick ? 0 : undefined}
                      onKeyDown={onRowClick ? (e) => { if (e.key === 'Enter' && e.target === e.currentTarget) onRowClick(row); } : undefined}
                    >
                      {visible.map((c) => {
                        const sp = stickyProps(c);
                        return (
                          <td
                            key={c.key}
                            className={`${alignClass(c)} ${sp.className}`}
                            style={colWidths[c.key] ? { ...sp.style, maxWidth: `${colWidths[c.key]}px` } : sp.style}
                          >
                            {c.render(row, i)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
              {footerNode && <tfoot>{footerNode}</tfoot>}
            </table>
          </div>
        </>
      )}

      {/* ── Pagination ───────────────────────────────────────────────────── */}
      {pagerMeta && pagerMeta.total > 0 && !loading && !(error && rows.length === 0) && (
        <div className="table-pager no-print">
          <span className="num">
            Showing{' '}
            <strong style={{ color: 'var(--text-1)', fontWeight: 600 }}>
              {((pagerMeta.page - 1) * pagerMeta.pageSize + 1).toLocaleString('en-IN')}–
              {Math.min(pagerMeta.page * pagerMeta.pageSize, pagerMeta.total).toLocaleString('en-IN')}
            </strong>{' '}
            of <strong style={{ color: 'var(--text-1)', fontWeight: 600 }}>{pagerMeta.total.toLocaleString('en-IN')}</strong>
          </span>

          {setSize && (
            <>
              <div className="divider-v" style={{ height: 18 }} />
              <label className="row" style={{ gap: 6 }}>
                Rows
                <select
                  className="select input-sm"
                  style={{ width: 76 }}
                  value={pagerMeta.pageSize}
                  onChange={(e) => setSize(Number(e.target.value))}
                  aria-label="Rows per page"
                >
                  {PAGE_SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
            </>
          )}

          <div className="spacer" />

          {goPage && pagerMeta.totalPages > 1 && (
            <nav className="row" style={{ gap: 2 }} aria-label="Pagination">
              <IconButton label="First page" icon={<ChevronsLeft size={15} />} disabled={!pagerMeta.hasPrev} onClick={() => goPage(1)} />
              <IconButton label="Previous page" icon={<ChevronLeft size={15} />} disabled={!pagerMeta.hasPrev} onClick={() => goPage(pagerMeta.page - 1)} />
              {pageNumbers(pagerMeta.page, pagerMeta.totalPages).map((p, i) =>
                p === '…' ? (
                  <span key={`gap-${i}`} style={{ padding: '0 4px', color: 'var(--text-4)' }}>…</span>
                ) : (
                  <Button
                    key={p}
                    variant={p === pagerMeta.page ? 'secondary' : 'ghost'}
                    size="sm"
                    onClick={() => goPage(p as number)}
                    style={{ minWidth: 28, padding: '0 6px', fontWeight: p === pagerMeta.page ? 600 : 500 }}
                    aria-current={p === pagerMeta.page ? 'page' : undefined}
                    aria-label={`Page ${p}`}
                  >
                    {p}
                  </Button>
                ),
              )}
              <IconButton label="Next page" icon={<ChevronRight size={15} />} disabled={!pagerMeta.hasNext} onClick={() => goPage(pagerMeta.page + 1)} />
              <IconButton label="Last page" icon={<ChevronsRight size={15} />} disabled={!pagerMeta.hasNext} onClick={() => goPage(pagerMeta.totalPages)} />
            </nav>
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
