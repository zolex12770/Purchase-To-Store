/**
 * Chart components (SRS §13, §14; redesign spec §3.13).
 *
 * Charts are decision tools: every bar, slice and point drills into the
 * transactions behind it. Colour follows the job it does:
 *   • categorical  — the validated eight-slot palette (tokens.css --chart-1…8,
 *                    dataviz six checks, light and dark), fixed order;
 *   • semantic     — seriesColor('ordered' | 'received' | 'pending' | …), so the
 *                    same measure has the same colour on every screen;
 *   • ranking      — one series, one hue (v2 coloured each bar by its rank);
 *   • ageing       — an ordinal one-hue ramp, young → old (v2 used a
 *                    green → red rainbow for ordered buckets).
 * All colours come from CSS variables, resolved at runtime, so dark mode works;
 * v2 fixed the grid and axis greys in code.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart,
} from 'recharts';
import { moneyCompact, numberCompact, money, qty as fmtQty, percent } from '../lib/format';
import { EmptyState, LoadingBlock, ErrorState } from './ui';
import { BarChart3 } from 'lucide-react';

/* ── Colour plumbing ─────────────────────────────────────────────────────── */

const CHART_VARS = [
  '--chart-1', '--chart-2', '--chart-3', '--chart-4', '--chart-5', '--chart-6', '--chart-7', '--chart-8',
  '--chart-age-1', '--chart-age-2', '--chart-age-3', '--chart-age-4', '--chart-age-5',
  '--chart-grid', '--chart-baseline', '--chart-axis', '--chart-cursor', '--surface-1', '--text-1', '--text-2', '--text-3',
] as const;
type ChartVar = (typeof CHART_VARS)[number];
type ChartTheme = Record<ChartVar, string>;

let cache: ChartTheme | null = null;
const listeners = new Set<() => void>();
let stop: (() => void) | null = null;

/** Resolves each token to the colour it computes to right now (light-dark() included). */
function readTheme(): ChartTheme {
  const probe = document.createElement('span');
  probe.style.display = 'none';
  document.body.appendChild(probe);
  const out = {} as ChartTheme;
  for (const v of CHART_VARS) {
    probe.style.color = `var(${v})`;
    out[v] = getComputedStyle(probe).color;
  }
  probe.remove();
  return out;
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  if (listeners.size === 1) {
    // Nothing watched the theme while no chart was mounted: re-read it. React
    // compares the snapshot again after subscribing and re-renders if it moved.
    cache = null;
    // The theme changes through <html data-theme> (lib/theme.tsx) or the OS.
    const refresh = () => { cache = null; listeners.forEach((l) => l()); };
    const mo = new MutationObserver(refresh);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', refresh);
    stop = () => { mo.disconnect(); mq.removeEventListener('change', refresh); };
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0) { stop?.(); stop = null; }
  };
}

const snapshot = (): ChartTheme => (cache ??= readTheme());

/** The resolved chart palette and chrome for the current theme; re-renders on a theme switch. */
export function useChartTheme(): ChartTheme {
  return useSyncExternalStore(subscribe, snapshot, snapshot);
}

/** Categorical slot i (0-based), as a CSS colour usable anywhere. Fixed order, never cycled past 8. */
export const colorAt = (i: number): string => `var(--chart-${(i % 8) + 1})`;

/** The validated light palette, for code that needs literal hex (exports, print). */
export const SERIES_COLORS = ['#6250d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#2a78d6', '#e34948'];

export type SeriesRole = 'ordered' | 'pending' | 'received' | 'rejected' | 'approved' | 'count' | 'rate';

const ROLE_VAR: Record<SeriesRole, string> = {
  ordered: 'var(--chart-1)',    // iris
  pending: 'var(--chart-2)',    // orange
  received: 'var(--chart-3)',   // aqua
  approved: 'var(--chart-3)',
  rejected: 'var(--chart-8)',   // red
  count: 'var(--chart-7)',      // blue
  rate: 'var(--chart-2)',
};

/** The colour of a measure, the same on every chart (spec §3.13). */
export const seriesColor = (role: SeriesRole): string => ROLE_VAR[role];

/**
 * Pages still pass the v2 palette's hex values for their series (Dashboard,
 * the four analysis pages, Items). Until they switch to seriesColor(), the
 * known v2 hexes map onto the semantic slots; any other colour is used as is.
 */
const LEGACY_HEX: Record<string, string> = {
  '#1a4d80': ROLE_VAR.ordered,
  '#1f9d5f': ROLE_VAR.received,
  '#d97a28': ROLE_VAR.pending,
  '#e0940f': ROLE_VAR.pending,
  '#db3434': ROLE_VAR.rejected,
  '#8f5fd1': 'var(--chart-5)',
  '#2f83c8': 'var(--chart-7)',
  '#0f8f8f': 'var(--chart-3)',
};

/** Turns `var(--chart-n)`, a v2 hex or a literal into a concrete colour for SVG attributes. */
function resolve(color: string | undefined, theme: ChartTheme, fallbackIndex: number): string {
  const c = (color ? (LEGACY_HEX[color.toLowerCase()] ?? color) : colorAt(fallbackIndex)).trim();
  const m = /^var\((--[\w-]+)\)$/.exec(c);
  if (!m) return c;
  return theme[m[1] as ChartVar] ?? c;
}

const AGE_VARS: ChartVar[] = ['--chart-age-1', '--chart-age-2', '--chart-age-3', '--chart-age-4', '--chart-age-5'];

/* ── Shared tooltip ──────────────────────────────────────────────────────── */

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

const TIP_STYLE = {
  background: 'var(--glass-bg-strong)',
  backdropFilter: 'var(--glass-blur)',
  WebkitBackdropFilter: 'var(--glass-blur)',
  border: '1px solid var(--glass-border)',
  borderRadius: 'var(--radius-md)',
  boxShadow: 'var(--shadow-3), 0 0 0 1px var(--glass-stroke)',
  padding: '8px 10px',
  fontSize: 'var(--fs-12)',
  color: 'var(--text-1)',
} as const;

function ChartTooltip({
  active, payload, label, formatter,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string | number;
  formatter?: (value: number | string, key: string) => string;
}) {
  if (!active || !payload || payload.length === 0) return null;
  return (
    <div style={{ ...TIP_STYLE, minWidth: 160 }}>
      {label !== undefined && (
        <div style={{ fontWeight: 600, marginBottom: 5, paddingBottom: 4, borderBottom: '1px solid var(--border-subtle)' }}>
          {String(label)}
        </div>
      )}
      {payload.map((entry, i) => (
        <div key={i} className="row" style={{ gap: 6, marginTop: i > 0 ? 3 : 0 }}>
          {/* Identity rides the swatch; the text stays in ink. */}
          <span style={{ width: 8, height: 8, borderRadius: 2, background: entry.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-2)' }} className="grow truncate">{entry.name}</span>
          <span className="num" style={{ fontWeight: 600 }}>
            {formatter
              ? formatter(entry.value ?? 0, String(entry.dataKey ?? ''))
              : numberCompact(entry.value as number)}
          </span>
        </div>
      ))}
    </div>
  );
}

const Line2 = ({ label, value }: { label: string; value: string }) => (
  <div className="row" style={{ gap: 10, marginTop: 2 }}>
    <span className="grow" style={{ color: 'var(--text-3)' }}>{label}</span>
    <span className="num" style={{ fontWeight: 600 }}>{value}</span>
  </div>
);

/* ── Chart frame: loading / error / empty, consistently ─────────────────── */

export function ChartFrame({
  title, subtitle, actions, height = 300, loading, error, isEmpty, emptyMessage, children, onRetry,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  height?: number;
  loading?: boolean;
  error?: unknown;
  isEmpty?: boolean;
  emptyMessage?: string;
  children: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <div className="card">
      <div className="card-header">
        <div className="grow">
          <div className="card-title">{title}</div>
          {subtitle && <div className="card-subtitle">{subtitle}</div>}
        </div>
        {actions}
      </div>
      <div className="card-body" style={{ padding: 'var(--space-4)' }}>
        {loading ? (
          <LoadingBlock height={height} />
        ) : error ? (
          <div style={{ minHeight: height, display: 'grid', placeItems: 'center' }}>
            <ErrorState error={error} onRetry={onRetry} title="Could not load this chart" />
          </div>
        ) : isEmpty ? (
          <div style={{ minHeight: height, display: 'grid', placeItems: 'center' }}>
            <EmptyState
              icon={<BarChart3 />}
              title="No data for these filters"
              message={emptyMessage ?? 'Adjust the date range or filters to see results.'}
            />
          </div>
        ) : (
          <div style={{ height }}>{children}</div>
        )}
      </div>
    </div>
  );
}

/* Chrome shared by every cartesian chart: hairline horizontal grid, 11 px
   ticks in the muted ink, a quiet baseline. */
function useChrome() {
  const t = useChartTheme();
  return {
    t,
    tick: { fontSize: 11, fill: t['--chart-axis'] } as const,
    grid: t['--chart-grid'],
    baseline: t['--chart-baseline'],
    cursor: { fill: t['--chart-cursor'] },
    surface: t['--surface-1'],
    legend: { fontSize: 12, paddingTop: 6, color: t['--text-2'] },
  };
}

/* ── Trend chart ─────────────────────────────────────────────────────────── */

export interface TrendPoint {
  period: string;
  [key: string]: string | number;
}

export function TrendChart({
  data, series, height = 300, onPointClick, valueKind = 'currency',
}: {
  data: TrendPoint[];
  series: { key: string; name: string; color?: string; type?: 'bar' | 'line' | 'area' }[];
  height?: number;
  onPointClick?: (point: TrendPoint) => void;
  valueKind?: 'currency' | 'count' | 'quantity';
}) {
  const { t, tick, grid, baseline, cursor, surface, legend } = useChrome();
  const fmt = valueKind === 'currency' ? moneyCompact : numberCompact;
  const tipFmt = (v: number | string) => (valueKind === 'currency' ? money(v) : fmtQty(v));
  const colors = series.map((s, i) => resolve(s.color, t, i));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        margin={{ top: 6, right: 8, left: 4, bottom: 0 }}
        onClick={(state) => {
          const idx = state?.activeTooltipIndex;
          if (onPointClick && typeof idx === 'number' && data[idx]) onPointClick(data[idx]);
        }}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={colors[i]} stopOpacity={0.16} />
              <stop offset="100%" stopColor={colors[i]} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis dataKey="period" tick={tick} tickLine={false} axisLine={{ stroke: baseline }} />
        <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v as number)} width={62} />
        <Tooltip content={<ChartTooltip formatter={tipFmt} />} cursor={cursor} />
        {/* A single series needs no legend: the chart title already names it. */}
        {series.length > 1 && <Legend wrapperStyle={legend} iconType="circle" iconSize={8} />}
        {series.map((s, i) => {
          const color = colors[i]!;
          if (s.type === 'bar') {
            return <Bar key={s.key} dataKey={s.key} name={s.name} fill={color} radius={[4, 4, 0, 0]} maxBarSize={24} cursor={onPointClick ? 'pointer' : undefined} />;
          }
          if (s.type === 'area') {
            return (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={color}
                    strokeWidth={2} fill={`url(#grad-${s.key})`}
                    activeDot={{ r: 5, stroke: surface, strokeWidth: 2, fill: color, cursor: onPointClick ? 'pointer' : undefined }} />
            );
          }
          return (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={color}
                  strokeWidth={2} dot={{ r: 3, strokeWidth: 2, stroke: surface, fill: color }}
                  activeDot={{ r: 5, stroke: surface, strokeWidth: 2, fill: color, cursor: onPointClick ? 'pointer' : undefined }} />
          );
        })}
      </ComposedChart>
    </ResponsiveContainer>
  );
}

/* ── Horizontal ranking bars ─────────────────────────────────────────────── */

export interface BreakdownRow {
  key: string;
  label: string;
  poCount: number;
  lineCount: number;
  totalQty: string;
  totalValue: string;
  receivedQty: string;
  receivedValue: string;
  pendingQty: string;
  pendingValue: string;
  avgRate: string;
  avgDiscount: string;
  sharePct: number;
}

/** One measure, one colour: rank is position, not hue. */
export function RankBarChart({
  data, height = 320, onBarClick, valueKey = 'totalValue',
}: {
  data: BreakdownRow[];
  height?: number;
  onBarClick?: (row: BreakdownRow) => void;
  valueKey?: 'totalValue' | 'totalQty' | 'pendingValue';
}) {
  const { t, tick, grid, cursor } = useChrome();
  const fill = valueKey === 'pendingValue' ? t['--chart-2'] : t['--chart-1'];
  const rows = data.map((d) => ({
    ...d,
    numeric: Number(d[valueKey] ?? 0),
    short: d.label.length > 26 ? `${d.label.slice(0, 25)}…` : d.label,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 42, left: 4, bottom: 2 }}>
        <CartesianGrid stroke={grid} horizontal={false} />
        <XAxis type="number" tick={tick} tickLine={false} axisLine={false}
               tickFormatter={(v) => (valueKey === 'totalQty' ? numberCompact(v as number) : moneyCompact(v as number))} />
        <YAxis type="category" dataKey="short" tick={{ ...tick, fill: t['--text-2'] }} tickLine={false} axisLine={false} width={150} />
        <Tooltip
          cursor={cursor}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as BreakdownRow & { numeric: number };
            return (
              <div style={{ ...TIP_STYLE, maxWidth: 280 }}>
                <div style={{ fontWeight: 600, marginBottom: 5 }}>{row.label}</div>
                <Line2 label="Value" value={money(row.totalValue)} />
                <Line2 label="Quantity" value={fmtQty(row.totalQty)} />
                <Line2 label="Purchase orders" value={String(row.poCount)} />
                <Line2 label="Pending value" value={money(row.pendingValue)} />
                <Line2 label="Share" value={percent(row.sharePct)} />
                {onBarClick && (
                  <div style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid var(--border-subtle)', color: 'var(--text-link)', fontWeight: 600 }}>
                    Click to see the transactions →
                  </div>
                )}
              </div>
            );
          }}
        />
        <Bar
          dataKey="numeric"
          fill={fill}
          radius={[0, 4, 4, 0]}
          maxBarSize={22}
          cursor={onBarClick ? 'pointer' : undefined}
          onClick={(entry: unknown) => {
            const row = (entry as { payload?: BreakdownRow }).payload;
            if (onBarClick && row) onBarClick(row);
          }}
        />
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Donut ───────────────────────────────────────────────────────────────── */

const OTHER_KEY = '__other';

/**
 * Share of a whole. Past six slices the tail folds into "Other" (top five
 * plus Other), because a seventh categorical slot is not reliably told apart.
 */
export function DonutChart({
  data, height = 280, onSliceClick, valueKind = 'currency', centerLabel, centerValue,
}: {
  data: { key: string; label: string; value: number }[];
  height?: number;
  onSliceClick?: (key: string, label: string) => void;
  valueKind?: 'currency' | 'count';
  centerLabel?: string;
  centerValue?: string;
}) {
  const { t, surface, legend } = useChrome();
  const sorted = [...data].sort((a, b) => b.value - a.value);
  const slices = sorted.length > 6
    ? [...sorted.slice(0, 5), { key: OTHER_KEY, label: `Other (${sorted.length - 5})`, value: sorted.slice(5).reduce((s, d) => s + d.value, 0) }]
    : sorted;
  const total = slices.reduce((sum, d) => sum + d.value, 0);
  const fills = slices.map((s, i) => (s.key === OTHER_KEY ? t['--text-3'] : resolve(undefined, t, i)));

  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={slices}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={1}
            cursor={onSliceClick ? 'pointer' : undefined}
            onClick={(entry: unknown) => {
              const p = (entry as { payload?: { key?: string; label?: string } }).payload;
              if (onSliceClick && p?.key && p.key !== OTHER_KEY) onSliceClick(p.key, p.label ?? '');
            }}
          >
            {slices.map((_, i) => <Cell key={i} fill={fills[i]} stroke={surface} strokeWidth={2} />)}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0];
              const value = Number(p?.value ?? 0);
              return (
                <div style={TIP_STYLE}>
                  <div style={{ fontWeight: 600 }}>{p?.name}</div>
                  <Line2 label="Value" value={valueKind === 'currency' ? money(value) : String(value)} />
                  <Line2 label="Share" value={percent(total > 0 ? (value / total) * 100 : 0)} />
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={legend}
            iconType="circle"
            iconSize={8}
            formatter={(v: string) => (v.length > 22 ? `${v.slice(0, 21)}…` : v)}
          />
        </PieChart>
      </ResponsiveContainer>

      {centerValue && (
        <div
          style={{
            position: 'absolute', top: '42%', left: 0, right: 0,
            textAlign: 'center', pointerEvents: 'none', transform: 'translateY(-50%)',
          }}
        >
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', fontWeight: 500 }}>
            {centerLabel}
          </div>
          <div className="num" style={{ fontSize: 'var(--fs-18)', fontWeight: 700, color: 'var(--text-1)' }}>
            {centerValue}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Ageing buckets ──────────────────────────────────────────────────────── */

export interface AgeingBucket {
  bucket: string;
  label: string;
  lineCount: number;
  docCount: number;
  pendingQty: string;
  pendingValue: string;
}

/** Ordered buckets on a one-hue ramp: light = young, dark = old. */
export function AgeingChart({
  data, height = 260, onBucketClick,
}: {
  data: AgeingBucket[];
  height?: number;
  onBucketClick?: (bucket: AgeingBucket) => void;
}) {
  const { t, tick, grid, baseline, cursor } = useChrome();
  const rows = data.map((d) => ({ ...d, numeric: Number(d.pendingValue ?? 0) }));
  // Spread the ramp across however many buckets there are, oldest darkest.
  const rampAt = (i: number) => {
    const step = rows.length <= 1 ? 0 : Math.round((i * (AGE_VARS.length - 1)) / (rows.length - 1));
    return t[AGE_VARS[Math.min(step, AGE_VARS.length - 1)]!];
  };

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid stroke={grid} vertical={false} />
        <XAxis dataKey="label" tick={tick} tickLine={false} axisLine={{ stroke: baseline }} />
        <YAxis tick={tick} tickLine={false} axisLine={false} tickFormatter={(v) => moneyCompact(v as number)} width={62} />
        <Tooltip
          cursor={cursor}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as AgeingBucket;
            return (
              <div style={TIP_STYLE}>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>{row.label}</div>
                <Line2 label="Pending value" value={money(row.pendingValue)} />
                <Line2 label="Pending quantity" value={fmtQty(row.pendingQty)} />
                <Line2 label="Documents" value={String(row.docCount)} />
                <Line2 label="Lines" value={String(row.lineCount)} />
              </div>
            );
          }}
        />
        <Bar
          dataKey="numeric"
          radius={[4, 4, 0, 0]}
          maxBarSize={24}
          cursor={onBucketClick ? 'pointer' : undefined}
          onClick={(entry: unknown) => {
            const row = (entry as { payload?: AgeingBucket }).payload;
            if (onBucketClick && row) onBucketClick(row);
          }}
        >
          {rows.map((_, i) => <Cell key={i} fill={rampAt(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Sparkline for inline trends ─────────────────────────────────────────── */

export function Sparkline({
  data, dataKey, color, height = 32,
}: {
  data: Record<string, number | string>[];
  dataKey: string;
  color?: string;
  height?: number;
}) {
  const t = useChartTheme();
  const stroke = resolve(color, t, 0);
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={stroke} stopOpacity={0.18} />
            <stop offset="100%" stopColor={stroke} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={stroke} strokeWidth={1.5} fill={`url(#spark-${dataKey})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
