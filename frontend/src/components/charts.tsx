/**
 * Chart components (SRS §13, §14).
 *
 * Charts here are decision tools, not decoration: every segment, bar and row is
 * CLICKABLE and drills into the transactions behind it. The palette is fixed and
 * ordered so the same series keeps the same colour across every screen.
 */
import type { ReactNode } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, Line, AreaChart, Area,
  PieChart, Pie, Cell, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ComposedChart,
} from 'recharts';
import { moneyCompact, numberCompact, money, qty as fmtQty, percent } from '../lib/format';
import { EmptyState, LoadingBlock, ErrorState } from './ui';
import { BarChart3 } from 'lucide-react';

/** Ordered categorical palette — distinguishable and brand-coherent. */
export const SERIES_COLORS = [
  '#1a4d80', // brand
  '#d97a28', // accent copper
  '#1f9d5f', // success green
  '#8f5fd1', // violet
  '#2f83c8', // sky
  '#e0940f', // amber
  '#db3434', // red
  '#0f8f8f', // teal
  '#7443b5', // deep violet
  '#b4621d', // deep copper
  '#5f6f82', // slate
  '#74a8da', // light blue
];

export const colorAt = (i: number): string => SERIES_COLORS[i % SERIES_COLORS.length]!;

const axisStyle = { fontSize: 11, fill: '#5f6f82' } as const;
const gridStroke = '#e8edf2';

/* ── Shared tooltip ──────────────────────────────────────────────────────── */

interface TooltipEntry {
  name?: string;
  value?: number | string;
  color?: string;
  dataKey?: string | number;
  payload?: Record<string, unknown>;
}

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
    <div
      style={{
        background: 'var(--bg-surface)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: 'var(--shadow-lg)',
        padding: '8px 10px',
        fontSize: 'var(--text-xs)',
        minWidth: 150,
      }}
    >
      {label !== undefined && (
        <div style={{ fontWeight: 700, color: 'var(--ink-800)', marginBottom: 5, paddingBottom: 4, borderBottom: '1px solid var(--border-subtle)' }}>
          {String(label)}
        </div>
      )}
      {payload.map((entry, i) => (
        <div key={i} className="row" style={{ gap: 6, marginTop: i > 0 ? 3 : 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: 2, background: entry.color, flexShrink: 0 }} />
          <span style={{ color: 'var(--text-secondary)' }} className="grow truncate">{entry.name}</span>
          <span className="num" style={{ fontWeight: 700, color: 'var(--ink-900)' }}>
            {formatter
              ? formatter(entry.value ?? 0, String(entry.dataKey ?? ''))
              : numberCompact(entry.value as number)}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ── Chart frame: handles loading / error / empty consistently ───────────── */

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
      <div className="card-body" style={{ padding: 'var(--sp-4)' }}>
        {loading ? (
          <LoadingBlock height={height} />
        ) : error ? (
          <ErrorState error={error} onRetry={onRetry} />
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
  const fmt = valueKind === 'currency' ? moneyCompact : numberCompact;
  const tipFmt = (v: number | string) => (valueKind === 'currency' ? money(v) : fmtQty(v));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ComposedChart
        data={data}
        margin={{ top: 6, right: 8, left: 4, bottom: 0 }}
        onClick={(state) => {
          const idx = state?.activeTooltipIndex;
          if (onPointClick && typeof idx === 'number' && data[idx]) onPointClick(data[idx]);
        }}
        style={onPointClick ? { cursor: 'pointer' } : undefined}
      >
        <defs>
          {series.map((s, i) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color ?? colorAt(i)} stopOpacity={0.28} />
              <stop offset="100%" stopColor={s.color ?? colorAt(i)} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
        <XAxis dataKey="period" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStroke }} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v) => fmt(v as number)} width={62} />
        <Tooltip content={<ChartTooltip formatter={tipFmt} />} cursor={{ fill: 'rgba(26,77,128,0.05)' }} />
        <Legend wrapperStyle={{ fontSize: 11, paddingTop: 6 }} iconType="circle" iconSize={7} />
        {series.map((s, i) => {
          const color = s.color ?? colorAt(i);
          if (s.type === 'bar') {
            return <Bar key={s.key} dataKey={s.key} name={s.name} fill={color} radius={[3, 3, 0, 0]} maxBarSize={38} />;
          }
          if (s.type === 'area') {
            return (
              <Area key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={color}
                    strokeWidth={2} fill={`url(#grad-${s.key})`} />
            );
          }
          return (
            <Line key={s.key} type="monotone" dataKey={s.key} name={s.name} stroke={color}
                  strokeWidth={2} dot={{ r: 2.5, strokeWidth: 0, fill: color }} activeDot={{ r: 5 }} />
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

export function RankBarChart({
  data, height = 320, onBarClick, valueKey = 'totalValue',
}: {
  data: BreakdownRow[];
  height?: number;
  onBarClick?: (row: BreakdownRow) => void;
  valueKey?: 'totalValue' | 'totalQty' | 'pendingValue';
}) {
  const rows = data.map((d) => ({
    ...d,
    numeric: Number(d[valueKey] ?? 0),
    short: d.label.length > 26 ? `${d.label.slice(0, 25)}…` : d.label,
  }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} layout="vertical" margin={{ top: 2, right: 42, left: 4, bottom: 2 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} horizontal={false} />
        <XAxis type="number" tick={axisStyle} tickLine={false} axisLine={false}
               tickFormatter={(v) => (valueKey === 'totalQty' ? numberCompact(v as number) : moneyCompact(v as number))} />
        <YAxis type="category" dataKey="short" tick={axisStyle} tickLine={false} axisLine={false} width={150} />
        <Tooltip
          cursor={{ fill: 'rgba(26,77,128,0.05)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as BreakdownRow & { numeric: number };
            return (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-lg)', padding: '8px 10px', fontSize: 'var(--text-xs)', maxWidth: 260 }}>
                <div style={{ fontWeight: 700, color: 'var(--ink-800)', marginBottom: 5 }}>{row.label}</div>
                <Line2 label="Value" value={money(row.totalValue)} />
                <Line2 label="Quantity" value={fmtQty(row.totalQty)} />
                <Line2 label="Purchase orders" value={String(row.poCount)} />
                <Line2 label="Pending value" value={money(row.pendingValue)} />
                <Line2 label="Share" value={percent(row.sharePct)} />
                {onBarClick && (
                  <div style={{ marginTop: 5, paddingTop: 4, borderTop: '1px solid var(--border-subtle)', color: 'var(--brand-600)', fontWeight: 600 }}>
                    Click to see the transactions →
                  </div>
                )}
              </div>
            );
          }}
        />
        <Bar
          dataKey="numeric"
          radius={[0, 4, 4, 0]}
          maxBarSize={26}
          cursor={onBarClick ? 'pointer' : undefined}
          onClick={(entry: unknown) => {
            const row = (entry as { payload?: BreakdownRow }).payload;
            if (onBarClick && row) onBarClick(row);
          }}
        >
          {rows.map((_, i) => <Cell key={i} fill={colorAt(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

const Line2 = ({ label, value }: { label: string; value: string }) => (
  <div className="row" style={{ gap: 8, marginTop: 2 }}>
    <span className="grow" style={{ color: 'var(--text-muted)' }}>{label}</span>
    <span className="num" style={{ fontWeight: 600, color: 'var(--ink-800)' }}>{value}</span>
  </div>
);

/* ── Donut ───────────────────────────────────────────────────────────────── */

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
  const total = data.reduce((sum, d) => sum + d.value, 0);

  return (
    <div style={{ position: 'relative', height }}>
      <ResponsiveContainer width="100%" height={height}>
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius="58%"
            outerRadius="82%"
            paddingAngle={2}
            cursor={onSliceClick ? 'pointer' : undefined}
            onClick={(entry: unknown) => {
              const p = (entry as { payload?: { key?: string; label?: string } }).payload;
              if (onSliceClick && p?.key) onSliceClick(p.key, p.label ?? '');
            }}
          >
            {data.map((_, i) => <Cell key={i} fill={colorAt(i)} stroke="var(--bg-surface)" strokeWidth={2} />)}
          </Pie>
          <Tooltip
            content={({ active, payload }) => {
              if (!active || !payload?.length) return null;
              const p = payload[0];
              const value = Number(p?.value ?? 0);
              return (
                <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-lg)', padding: '8px 10px', fontSize: 'var(--text-xs)' }}>
                  <div style={{ fontWeight: 700, color: 'var(--ink-800)' }}>{p?.name}</div>
                  <Line2 label="Value" value={valueKind === 'currency' ? money(value) : String(value)} />
                  <Line2 label="Share" value={percent(total > 0 ? (value / total) * 100 : 0)} />
                </div>
              );
            }}
          />
          <Legend
            wrapperStyle={{ fontSize: 11 }}
            iconType="circle"
            iconSize={7}
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
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 600 }}>
            {centerLabel}
          </div>
          <div className="num" style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--ink-900)' }}>
            {centerValue}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Ageing buckets ──────────────────────────────────────────────────────── */

const AGE_COLORS = ['#1f9d5f', '#8fbf3f', '#e0940f', '#e8722b', '#db3434'];

export interface AgeingBucket {
  bucket: string;
  label: string;
  lineCount: number;
  docCount: number;
  pendingQty: string;
  pendingValue: string;
}

export function AgeingChart({
  data, height = 260, onBucketClick,
}: {
  data: AgeingBucket[];
  height?: number;
  onBucketClick?: (bucket: AgeingBucket) => void;
}) {
  const rows = data.map((d) => ({ ...d, numeric: Number(d.pendingValue ?? 0) }));

  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={rows} margin={{ top: 6, right: 8, left: 4, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke={gridStroke} vertical={false} />
        <XAxis dataKey="label" tick={axisStyle} tickLine={false} axisLine={{ stroke: gridStroke }} />
        <YAxis tick={axisStyle} tickLine={false} axisLine={false} tickFormatter={(v) => moneyCompact(v as number)} width={62} />
        <Tooltip
          cursor={{ fill: 'rgba(26,77,128,0.05)' }}
          content={({ active, payload }) => {
            if (!active || !payload?.length) return null;
            const row = payload[0]?.payload as AgeingBucket;
            return (
              <div style={{ background: 'var(--bg-surface)', border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)', boxShadow: 'var(--shadow-lg)', padding: '8px 10px', fontSize: 'var(--text-xs)' }}>
                <div style={{ fontWeight: 700, color: 'var(--ink-800)', marginBottom: 4 }}>{row.label}</div>
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
          maxBarSize={64}
          cursor={onBucketClick ? 'pointer' : undefined}
          onClick={(entry: unknown) => {
            const row = (entry as { payload?: AgeingBucket }).payload;
            if (onBucketClick && row) onBucketClick(row);
          }}
        >
          {rows.map((_, i) => <Cell key={i} fill={AGE_COLORS[i] ?? colorAt(i)} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

/* ── Sparkline for inline trends ─────────────────────────────────────────── */

export function Sparkline({
  data, dataKey, color = '#1a4d80', height = 40,
}: {
  data: Record<string, number | string>[];
  dataKey: string;
  color?: string;
  height?: number;
}) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
        <defs>
          <linearGradient id={`spark-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity={0.3} />
            <stop offset="100%" stopColor={color} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey={dataKey} stroke={color} strokeWidth={1.5} fill={`url(#spark-${dataKey})`} />
      </AreaChart>
    </ResponsiveContainer>
  );
}
