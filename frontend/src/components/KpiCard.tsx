/**
 * KPI and stat components (SRS §13, §14, §38; redesign spec §3.4).
 *
 * Obligations every KPI keeps:
 *   • it is CLICKABLE only when the click explains the number (§14);
 *   • it exposes its DEFINITION and formula (§38) — now in a real tooltip that
 *     keyboard users get on focus, instead of a multi-line native title;
 *   • rising is not assumed to be good — `inverse` metrics invert the trend tone;
 *   • it is HONEST while loading and on error: a skeleton, or "—" with the
 *     reason, never a fake 0 (audit UI-002: failed overviews rendered ₹0).
 *
 * StatStrip replaces the rows of StatTiles that wrapped into orphan rows
 * (PO list 8 → 7 + 1, requisitions 12 → 7 + 5); FilterTiles is the tile row
 * that filters the current view, with a visible selected state.
 */
import {
  ArrowUpRight, ArrowDownRight, Minus, ChevronRight, AlertTriangle,
  IndianRupee, Package, Hash, Clock, Percent,
} from 'lucide-react';
import { Children, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { moneyCompact, numberCompact, percent, count } from '../lib/format';
import { useCountUp } from '../lib/useCountUp';
import { Skeleton, Tooltip } from './ui';

export interface MetricValue {
  key: string;
  label: string;
  description: string;
  formula: string;
  unit: 'currency' | 'quantity' | 'count' | 'days' | 'percent';
  source: string;
  drilldown: string;
  inverse?: boolean;
  value: string | number;
  previous?: string | number | null;
  changePct?: number | null;
}

function formatValue(value: string | number, unit: MetricValue['unit']): string {
  switch (unit) {
    case 'currency': return moneyCompact(value);
    case 'quantity': return numberCompact(value);
    case 'percent':  return percent(value, 1);
    case 'days':     return `${Number(value).toFixed(1)} d`;
    default:         return count(value);
  }
}

/** Family rail + icon. An inverse metric (pending, overdue, rejection) takes the pending family. */
const FAMILY: Record<MetricValue['unit'], { rail: string; icon: ReactNode }> = {
  currency: { rail: 'var(--grad-neutral)', icon: <IndianRupee size={16} /> },
  quantity: { rail: 'var(--grad-info)', icon: <Package size={16} /> },
  count:    { rail: 'var(--grad-neutral)', icon: <Hash size={16} /> },
  days:     { rail: 'var(--grad-info)', icon: <Clock size={16} /> },
  percent:  { rail: 'var(--grad-positive)', icon: <Percent size={16} /> },
};

function MetricTooltip({ metric }: { metric: MetricValue }) {
  return (
    <span className="tooltip-lines">
      <span>{metric.description}</span>
      {metric.formula && <span><span className="tl-k">Formula · </span>{metric.formula}</span>}
      {metric.source && <span><span className="tl-k">Source · </span>{metric.source}</span>}
    </span>
  );
}

export function KpiCard({
  metric, onClick, accent, compact, loading, error,
}: {
  metric: MetricValue;
  onClick?: () => void;
  /** Override the family rail (a CSS colour or gradient). */
  accent?: string;
  compact?: boolean;
  /** Show a skeleton instead of the value. */
  loading?: boolean;
  /** The value could not be computed: show "—" and why. */
  error?: unknown;
}) {
  const change = metric.changePct;
  const hasTrend = !loading && !error && change !== null && change !== undefined && Number.isFinite(change);

  // For an inverse metric (pending value, overdue count, rejection rate) a rise is bad.
  const good = hasTrend ? (metric.inverse ? change < 0 : change > 0) : false;
  const flat = hasTrend && Math.abs(change) < 0.05;
  const trendTone = !hasTrend || flat ? 'neutral' : good ? 'success' : 'danger';

  const family = FAMILY[metric.unit] ?? FAMILY.count;
  const rail = accent ?? (metric.inverse ? 'var(--grad-pending)' : family.rail);

  // Animate the figure itself, then re-format so units/compaction stay correct.
  const numeric = Number(metric.value);
  const animated = useCountUp(numeric, Number.isFinite(numeric) && !loading && !error);
  const shown = Number.isFinite(numeric)
    ? formatValue(animated, metric.unit)
    : formatValue(metric.value, metric.unit);

  const card = (
    <div
      className={`card kpi-card ${onClick ? 'card-clickable' : ''} ${compact ? 'is-compact' : ''}`}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      data-accent
      style={{ ['--card-accent' as string]: rail } as CSSProperties}
      aria-busy={loading || undefined}
    >
      <div className="kpi-head">
        {/* The label leads and may take two lines; a KPI whose name is cut
            off is worse than no decoration at all. */}
        <span className="kpi-label">{metric.label}</span>
        <span className="kpi-icon" aria-hidden>{family.icon}</span>
      </div>

      <div className="kpi-value">
        {loading ? <Skeleton w="62%" h={compact ? 22 : 28} /> : error ? (
          <span className="row" style={{ gap: 6, color: 'var(--text-4)' }}>
            —<AlertTriangle size={16} style={{ color: 'var(--tone-danger-fg)' }} aria-label="Could not be computed" />
          </span>
        ) : shown}
      </div>

      <div className="kpi-foot">
        {hasTrend && (
          <span className={`kpi-delta tone-${trendTone}`} title="Change against the previous period of the same length">
            {flat ? <Minus size={12} aria-hidden /> : change > 0 ? <ArrowUpRight size={12} aria-hidden /> : <ArrowDownRight size={12} aria-hidden />}
            {change > 0 ? '+' : ''}{change.toFixed(1)}%
          </span>
        )}
        {error ? <span className="kpi-error">{error instanceof Error ? error.message : 'Could not load'}</span> : null}
        <span className="spacer" />
        {onClick && <ChevronRight size={16} className="kpi-chevron" aria-hidden />}
      </div>
    </div>
  );

  return <Tooltip content={<MetricTooltip metric={metric} />} block>{card}</Tooltip>;
}

/**
 * Responsive KPI grid that never leaves an orphan: with N cards it uses the
 * fewest rows that fit, then spreads the cards evenly across them — six cards
 * where five fit become 3 + 3, not 5 + 1 (audit UI-020).
 */
export const KpiGrid = ({ children, min = 210, gap = 12 }: { children: ReactNode; min?: number; gap?: number }) => {
  const ref = useRef<HTMLDivElement>(null);
  const n = Children.toArray(children).length;
  const [cols, setCols] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const width = el.clientWidth;
      const fit = Math.max(1, Math.floor((width + gap) / (min + gap)));
      const rows = Math.max(1, Math.ceil(n / fit));
      setCols(Math.max(1, Math.ceil(n / rows)));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [n, min, gap]);

  return (
    <div
      ref={ref}
      style={{
        display: 'grid',
        gridTemplateColumns: cols ? `repeat(${cols}, minmax(0, 1fr))` : `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
        gap,
      }}
    >
      {children}
    </div>
  );
};

type StatTone = 'default' | 'success' | 'warning' | 'danger' | 'info';

const RAIL: Record<StatTone, string> = {
  default: 'transparent',
  success: 'var(--tone-success-solid)',
  warning: 'var(--tone-pending-solid)',
  danger: 'var(--tone-danger-solid)',
  info: 'var(--tone-info-solid)',
};

/** The value, or a skeleton while loading, or "—" with the reason on error. */
function StatValue({ value, tone, loading, error }: { value: ReactNode; tone: StatTone; loading?: boolean; error?: unknown }) {
  if (loading) return <div className="stat-value"><Skeleton w={72} h={18} /></div>;
  if (error) {
    const why = error instanceof Error ? error.message : 'Could not load this figure';
    return (
      <div className="stat-value is-error">
        <Tooltip content={why}>
          <span className="row" style={{ gap: 5 }}>
            —<AlertTriangle size={14} style={{ color: 'var(--tone-danger-fg)' }} role="img" aria-label={`Not available: ${why}`} />
          </span>
        </Tooltip>
      </div>
    );
  }
  return <div className={`stat-value ${tone === 'default' ? '' : `tone-${tone}`}`}>{value}</div>;
}

/**
 * Small stat used in detail panels, drawers and list headers. Quiet by
 * default; a tile looks clickable only when it has an action, and a tile that
 * filters the view shows when it is the active filter (`selected`).
 */
export function StatTile({
  label, value, tone = 'default', sub, onClick, loading, error, selected,
}: {
  label: string;
  value: string;
  tone?: StatTone;
  sub?: string;
  onClick?: () => void;
  loading?: boolean;
  error?: unknown;
  /** This tile is the filter currently applied. */
  selected?: boolean;
}) {
  const body = (
    <>
      <div className="stat-label">{label}</div>
      <StatValue value={value} tone={tone} loading={loading} error={error} />
      {sub && <div className="stat-sub">{sub}</div>}
    </>
  );
  const style = { ['--tile-rail' as string]: RAIL[tone] } as CSSProperties;
  if (!onClick) return <div className="stat-tile" style={style}>{body}</div>;
  return (
    <button
      type="button"
      className={`stat-tile is-clickable ${selected ? 'is-selected' : ''}`}
      style={style}
      onClick={onClick}
      aria-pressed={selected === undefined ? undefined : selected}
    >
      {body}
    </button>
  );
}

export interface StatItem {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: StatTone;
  loading?: boolean;
  error?: unknown;
  /** Definition shown on hover/focus. */
  title?: string;
}

/**
 * One card of up to six figures divided by hairlines; it scrolls sideways
 * rather than wrapping into an orphan row. Not clickable — filtering belongs
 * to FilterTiles or the toolbar.
 */
export function StatStrip({ items, label }: { items: StatItem[]; label?: string }) {
  return (
    <div className="stat-strip" role="group" aria-label={label}>
      {items.map((s) => {
        const cell = (
          <div key={s.label} className="stat-cell">
            <div className="stat-label">{s.label}</div>
            <StatValue value={s.value} tone={s.tone ?? 'default'} loading={s.loading} error={s.error} />
            {s.sub && <div className="stat-sub">{s.sub}</div>}
          </div>
        );
        // The tooltip anchor, when there is one, becomes the strip's flex child.
        return s.title ? <Tooltip key={s.label} content={s.title} block>{cell}</Tooltip> : cell;
      })}
    </div>
  );
}

export interface FilterTileOption {
  value: string;
  label: string;
  count: ReactNode;
  sub?: string;
  tone?: StatTone;
  loading?: boolean;
  error?: unknown;
}

/**
 * Tiles that filter the current view, as a radiogroup with an explicit
 * selected state (iris tint + 2 px underline). v2 StatTiles had no selected
 * state, so a click applied a filter nobody could see (audit UI-016).
 * Clicking the selected tile again clears the filter when `allowClear` is set.
 */
export function FilterTiles({
  options, value, onChange, ariaLabel, allowClear = true,
}: {
  options: FilterTileOption[];
  value: string | null;
  onChange: (value: string | null) => void;
  ariaLabel: string;
  allowClear?: boolean;
}) {
  const focusValue = options.some((o) => o.value === value) ? value : options[0]?.value;
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    const tiles = Array.from(e.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]'));
    const i = tiles.indexOf(document.activeElement as HTMLElement);
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
    e.preventDefault();
    tiles[(i + step + tiles.length) % tiles.length]?.focus();
  };
  return (
    <div className="filter-tiles" role="radiogroup" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {options.map((o) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={o.value === focusValue ? 0 : -1}
            className={`stat-tile is-clickable ${on ? 'is-selected' : ''}`}
            style={{ ['--tile-rail' as string]: RAIL[o.tone ?? 'default'] } as CSSProperties}
            onClick={() => onChange(on && allowClear ? null : o.value)}
          >
            <div className="stat-label">{o.label}</div>
            <StatValue value={o.count} tone={o.tone ?? 'default'} loading={o.loading} error={o.error} />
            {o.sub && <div className="stat-sub">{o.sub}</div>}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Shown under a list's total tiles when an item-level filter (item, department, group…)
 * narrowed them to the filtered items' lines — the lines the dashboard card that opened
 * the list counts — while each row still shows its whole document (backend
 * domain/item-scope.ts).
 */
export function LineScopeNote({ document }: { document: string }) {
  return (
    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 'var(--sp-4)' }}>
      Quantities and values above add up only the lines of the filtered items; each row shows its whole {document}.
    </div>
  );
}
