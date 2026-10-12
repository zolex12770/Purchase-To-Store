/**
 * KPI card (SRS §13, §14, §38).
 *
 * Three obligations the specification places on every KPI, all satisfied here:
 *   • it is CLICKABLE and drills into the transactions behind it (§14);
 *   • it exposes its authoritative DEFINITION and formula on hover (§38);
 *   • rising is not assumed to be good — `inverse` metrics invert the trend tone.
 *
 * Visually the card is built from a gradient icon medallion, a count-up figure
 * and a tinted trend pill. Each metric family owns a colour, so a wall of KPIs
 * is scannable by hue rather than by reading every label.
 */
import { TrendingUp, TrendingDown, Minus, Info, ArrowRight,
         IndianRupee, Package, Hash, Clock, Percent } from 'lucide-react';
import type { ReactNode } from 'react';
import { moneyCompact, numberCompact, percent, count } from '../lib/format';
import { useCountUp } from '../lib/useCountUp';

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

/** Colour + gradient + icon per metric family. */
const FAMILY: Record<MetricValue['unit'], { solid: string; grad: string; icon: ReactNode }> = {
  currency: { solid: 'var(--accent-500)',   grad: 'var(--grad-accent)', icon: <IndianRupee size={15} /> },
  quantity: { solid: 'var(--info-500)',     grad: 'var(--grad-sky)',    icon: <Package size={15} /> },
  count:    { solid: 'var(--brand-500)',    grad: 'var(--grad-brand)',  icon: <Hash size={15} /> },
  days:     { solid: 'var(--progress-500)', grad: 'var(--grad-violet)', icon: <Clock size={15} /> },
  percent:  { solid: 'var(--success-500)',  grad: 'var(--grad-emerald)',icon: <Percent size={15} /> },
};

export function KpiCard({
  metric, onClick, accent, compact,
}: {
  metric: MetricValue;
  onClick?: () => void;
  accent?: string;
  compact?: boolean;
}) {
  const change = metric.changePct;
  const hasTrend = change !== null && change !== undefined && Number.isFinite(change);

  // For an inverse metric (pending value, overdue count, rejection rate) a rise is bad.
  const good = hasTrend ? (metric.inverse ? change < 0 : change > 0) : false;
  const flat = hasTrend && Math.abs(change) < 0.05;

  const trend = !hasTrend || flat
    ? { fg: 'var(--text-muted)', bg: 'var(--ink-100)' }
    : good
      ? { fg: 'var(--success-700)', bg: 'var(--success-50)' }
      : { fg: 'var(--danger-700)', bg: 'var(--danger-50)' };

  const family = FAMILY[metric.unit] ?? FAMILY.count;
  const stripe = accent ?? family.solid;

  // Animate the figure itself, then re-format so units/compaction stay correct.
  const numeric = Number(metric.value);
  const animated = useCountUp(numeric, Number.isFinite(numeric));
  const shown = Number.isFinite(numeric)
    ? formatValue(animated, metric.unit)
    : formatValue(metric.value, metric.unit);

  return (
    <div
      className={`card ${onClick ? 'card-clickable' : ''}`}
      onClick={onClick}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      data-accent
      style={{
        position: 'relative',
        overflow: 'hidden',
        // Drives the shared `.card::before` top hairline from base.css.
        ['--card-accent' as string]: accent ?? family.grad,
      }}
      title={`${metric.description}\n\nFormula: ${metric.formula}\nSource: ${metric.source}`}
    >
      {/* A soft wash of the family colour, so the card is tinted rather than flat. */}
      <div
        aria-hidden
        style={{
          position: 'absolute', top: -34, right: -34, width: 118, height: 118,
          borderRadius: '50%', background: stripe, opacity: 0.07, pointerEvents: 'none',
        }}
      />

      <div style={{ padding: compact ? 'var(--sp-3) var(--sp-4)' : 'var(--sp-4)', position: 'relative' }}>
        {/* Label leads and is allowed two lines. A KPI whose name is cut off
            ("TOTAL PO V…") is worse than no decoration at all, so the icon sits
            to the right where it costs the label the least width. */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: compact ? 6 : 9 }}>
          <span
            style={{
              flex: '1 1 auto', minWidth: 0,
              fontSize: 'var(--text-2xs)', fontWeight: 700, letterSpacing: '0.045em',
              textTransform: 'uppercase', color: 'var(--text-muted)',
              lineHeight: 1.3,
              display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
              // Reserve both lines so cards in a row align on the value.
              minHeight: 'calc(2 * 1.3em)',
            }}
          >
            {metric.label}
          </span>
          <span
            aria-hidden
            style={{
              width: compact ? 24 : 28, height: compact ? 24 : 28, flexShrink: 0,
              borderRadius: 'var(--radius-sm)', background: family.grad, color: '#fff',
              display: 'grid', placeItems: 'center',
              boxShadow: `0 3px 10px color-mix(in srgb, ${stripe} 40%, transparent)`,
            }}
          >
            {family.icon}
          </span>
        </div>

        <div
          className="num truncate"
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: compact ? 'var(--text-xl)' : 'var(--text-2xl)',
            fontWeight: 800, color: 'var(--ink-900)', lineHeight: 1.1, letterSpacing: '-0.03em',
          }}
        >
          {shown}
        </div>

        <div className="row" style={{ gap: 5, marginTop: 8, minHeight: 20 }}>
          {hasTrend && (
            <span
              className="row num"
              style={{
                gap: 3, padding: '2px 6px', borderRadius: 'var(--radius-full)',
                background: trend.bg, color: trend.fg,
                fontSize: 'var(--text-2xs)', fontWeight: 700, flexShrink: 0,
              }}
              title="Change against the previous period of the same length"
            >
              {flat ? <Minus size={10} /> : good ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {change > 0 ? '+' : ''}{change.toFixed(1)}%
            </span>
          )}
          <span className="spacer" />
          <Info size={11} style={{ color: 'var(--ink-400)', flexShrink: 0 }} aria-hidden />
          {onClick && <ArrowRight size={12} style={{ color: 'var(--ink-400)', flexShrink: 0 }} aria-hidden />}
        </div>
      </div>
    </div>
  );
}

/** Responsive KPI grid. */
export const KpiGrid = ({ children, min = 210 }: { children: React.ReactNode; min?: number }) => (
  <div
    style={{
      display: 'grid',
      // min() keeps a single card from overflowing a viewport narrower than `min`.
      gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
      gap: 'var(--sp-3)',
    }}
  >
    {children}
  </div>
);

/**
 * Small stat used inside detail panels and drawers.
 * Not a KPI — deliberately visually quieter so it never competes with the
 * dashboard tiles.
 */
export function StatTile({
  label, value, tone = 'default', sub, onClick,
}: {
  label: string;
  value: string;
  tone?: 'default' | 'success' | 'warning' | 'danger' | 'info';
  sub?: string;
  onClick?: () => void;
}) {
  const colors: Record<string, string> = {
    default: 'var(--ink-900)',
    success: 'var(--success-600)',
    warning: 'var(--warning-600)',
    danger: 'var(--danger-600)',
    info: 'var(--info-600)',
  };
  const rails: Record<string, string> = {
    default: 'var(--brand-400)',
    success: 'var(--success-500)',
    warning: 'var(--warning-500)',
    danger: 'var(--danger-500)',
    info: 'var(--info-500)',
  };
  return (
    <div
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter') onClick(); } : undefined}
      style={{
        position: 'relative',
        padding: 'var(--sp-3)',
        paddingLeft: 'calc(var(--sp-3) + 3px)',
        background: 'var(--bg-inset)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 'var(--radius-sm)',
        boxShadow: `inset 3px 0 0 ${rails[tone]}`,
        cursor: onClick ? 'pointer' : undefined,
        transition: 'border-color var(--dur-fast) var(--ease), background var(--dur-fast) var(--ease), transform var(--dur-fast) var(--ease)',
      }}
      onMouseEnter={onClick ? (e) => {
        e.currentTarget.style.borderColor = 'var(--brand-300)';
        e.currentTarget.style.transform = 'translateY(-1px)';
      } : undefined}
      onMouseLeave={onClick ? (e) => {
        e.currentTarget.style.borderColor = 'var(--border-subtle)';
        e.currentTarget.style.transform = 'none';
      } : undefined}
    >
      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {label}
      </div>
      <div
        className="num"
        style={{ fontFamily: 'var(--font-display)', fontSize: 'var(--text-lg)', fontWeight: 700, color: colors[tone], marginTop: 3, letterSpacing: '-0.02em' }}
      >
        {value}
      </div>
      {sub && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>{sub}</div>}
    </div>
  );
}
