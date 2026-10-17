/**
 * Management Analysis (SRS §13, §14, §38).
 *
 * A decision-support layer, not a decorative landing screen. Every KPI card,
 * chart segment and table row drills through to the transactions behind it,
 * carrying the active filters along (SRS §14).
 */
import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingUp, Building2, Package, Layers, PieChart as PieIcon,
  Clock, AlertTriangle, ArrowRight, Download, Printer, Landmark, Activity,
  UserCheck, User,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useFilters, drilldownLink } from '../lib/useFilters';
import { PageHeader, PrintHeader } from '../layout/AppShell';
import { FilterBar } from '../components/FilterBar';
import { KpiCard, KpiGrid, type MetricValue } from '../components/KpiCard';
import { Card, CardHeader, CardBody, Button, Tabs, Badge, EmptyState, LoadingBlock } from '../components/ui';
import {
  ChartFrame, TrendChart, RankBarChart, DonutChart, AgeingChart,
  type BreakdownRow, type AgeingBucket, type TrendPoint,
} from '../components/charts';
import { money, moneyCompact, qty, percent, count, formatDate } from '../lib/format';

type Dimension = 'supplier' | 'item' | 'department' | 'costCentre' | 'mainGroup' | 'poType' | 'itemType' | 'user' | 'hod';

const DIMENSIONS: { key: Dimension; label: string; icon: React.ReactNode; param: string; route: string }[] = [
  { key: 'supplier',   label: 'Supplier',    icon: <Building2 size={14} />, param: 'supplierId',    route: '/purchase-orders' },
  { key: 'item',       label: 'Item',        icon: <Package size={14} />,   param: 'itemId',        route: '/purchase-orders' },
  { key: 'department', label: 'Department',  icon: <Layers size={14} />,    param: 'departmentId',  route: '/purchase-orders' },
  { key: 'costCentre', label: 'Cost Centre', icon: <Landmark size={14} />,  param: 'costCentreId',  route: '/purchase-orders' },
  { key: 'mainGroup',  label: 'Item Group',  icon: <Layers size={14} />,    param: 'mainGroupId',   route: '/purchase-orders' },
  { key: 'poType',     label: 'PO Type',     icon: <PieIcon size={14} />,   param: 'poTypeId',      route: '/purchase-orders' },
  { key: 'itemType',   label: 'Item Type',   icon: <Package size={14} />,   param: 'itemTypeId',    route: '/purchase-orders' },
  { key: 'user',       label: 'Created By / User', icon: <User size={14} />, param: 'userId',      route: '/purchase-orders' },
  { key: 'hod',        label: 'HOD',         icon: <UserCheck size={14} />, param: 'hodId',         route: '/purchase-orders' },
];

interface ExceptionRow {
  key: string; label: string; count: number; value: string | null;
  severity: string; description: string; drilldown: string;
}

interface SupplierPerf {
  key: string; label: string; city: string; state: string;
  poCount: number; totalValue: string; orderedQty: string; receivedQty: string;
  pendingValue: string; avgDiscount: number; fulfilmentRate: number;
  onTimeRate: number; overdueLines: number; lastPoDate: string | null;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { can, canAny } = useAuth();
  // The headline numbers need only the dashboard "view" right, but each chart
  // below is served by the analytics API to holders of an "analyze" right. A
  // panel the user's role cannot load is neither requested nor drawn — it used
  // to be drawn anyway and show "You do not have permission to view this
  // information" with a Try again button. These lists mirror
  // backend/src/modules/analytics/routes.ts.
  const canTrends = canAny('dashboard.analyze', 'po.analyze', 'indent.analyze', 'grn.analyze', 'requisition.analyze');
  const canBreakdown = canAny('dashboard.analyze', 'po.analyze', 'indent.analyze', 'grn.analyze');
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [dimension, setDimension] = useState<Dimension>('supplier');
  const [ageBasis, setAgeBasis] = useState<'po' | 'indent'>('po');
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('month');

  const query = qs({
    dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    supplierId: filters.supplierId, itemId: filters.itemId,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId,
    poTypeId: filters.poTypeId, indentTypeId: filters.indentTypeId,
    mainGroupId: filters.mainGroupId, itemTypeId: filters.itemTypeId,
    userId: filters.userId, hodId: filters.hodId, qcStatus: filters.qcStatus,
  });

  const kpis = useQuery({
    queryKey: ['analytics', 'kpis', query],
    queryFn: () => api.getWithMeta<{ kpis: MetricValue[] }, { generatedAt: string }>(`/analytics/kpis${query}`),
  });

  const trends = useQuery({
    queryKey: ['analytics', 'trends', query, granularity],
    queryFn: () => api.get<TrendPoint[]>(`/analytics/trends${query}${query ? '&' : '?'}granularity=${granularity}`),
    enabled: canTrends,
  });

  const breakdown = useQuery({
    queryKey: ['analytics', 'breakdown', dimension, query],
    queryFn: () => api.getWithMeta<BreakdownRow[], { dimensionTitle: string; drilldownParam: string; grandTotalValue: string; groupCount: number; truncated: boolean }>(
      `/analytics/breakdown/${dimension}${query}${query ? '&' : '?'}limit=12`,
    ),
    enabled: canBreakdown,
  });

  const ageing = useQuery({
    queryKey: ['analytics', 'ageing', ageBasis, query],
    queryFn: () => api.get<AgeingBucket[]>(`/analytics/ageing${query}${query ? '&' : '?'}basis=${ageBasis}`),
    enabled: canTrends,
  });

  const exceptions = useQuery({
    queryKey: ['analytics', 'exceptions', query],
    queryFn: () => api.get<ExceptionRow[]>(`/analytics/exceptions${query}`),
    enabled: can('dashboard.analyze'),
  });

  const suppliers = useQuery({
    queryKey: ['analytics', 'supplier-performance', query],
    queryFn: () => api.get<SupplierPerf[]>(`/analytics/supplier-performance${query}${query ? '&' : '?'}limit=10`),
    enabled: can('po.analyze') || can('dashboard.analyze'),
  });

  const metrics = kpis.data?.data.kpis ?? [];
  const byKey = useMemo(() => Object.fromEntries(metrics.map((m) => [m.key, m])), [metrics]);

  /** Headline tiles — the numbers management looks at first. */
  const HEADLINE = ['po_value_total', 'po_pending_value', 'grn_value_total', 'indent_pending_approval', 'po_overdue_count', 'purchase_cycle_days'];
  const headline = HEADLINE.map((k) => byKey[k]).filter(Boolean) as MetricValue[];
  const secondary = metrics.filter((m) => !HEADLINE.includes(m.key));

  const activeDim = DIMENSIONS.find((d) => d.key === dimension)!;

  const drill = (extra: Record<string, unknown>, base = '/purchase-orders') =>
    navigate(drilldownLink(base, extra, filters));

  const filterSummary = [
    filters.dateFrom || filters.dateTo ? `${filters.dateFrom ?? 'start'} to ${filters.dateTo ?? 'today'}` : 'All time',
    activeCount > 0 ? `${activeCount} filter(s) applied` : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <PrintHeader title="Management Analysis" filterContext={filterSummary} />

      <PageHeader
        title="Management Analysis"
        subtitle="Procurement performance, exposure and exceptions across the purchase-to-store cycle"
        breadcrumbs={[{ label: 'Zolex', to: '/dashboard' }, { label: 'Management Analysis' }]}
        freshness={kpis.data?.meta.generatedAt}
        actions={
          <>
            {can('dashboard.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={() => navigate('/admin/import-export')}>
                Export
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>
              Print
            </Button>
          </>
        }
      />

      <FilterBar
        filters={filters}
        setFilters={setFilters}
        clearFilters={clearFilters}
        activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'poType', 'mainGroup', 'itemType', 'item']}
      />

      {/* ── Headline KPIs ─────────────────────────────────────────────────── */}
      {kpis.isLoading ? (
        <KpiGrid>
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card" style={{ padding: 'var(--sp-5)' }}>
              <div className="skeleton" style={{ height: 11, width: '55%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 26, width: '70%' }} />
            </div>
          ))}
        </KpiGrid>
      ) : metrics.length === 0 ? (
        <Card><CardBody><EmptyState title="No metrics available" message="You may not have analytics permissions for this data." /></CardBody></Card>
      ) : (
        <KpiGrid min={198}>
          {headline.map((m) => (
            <KpiCard key={m.key} metric={m} onClick={m.drilldown ? () => navigate(drilldownLink(m.drilldown, {}, filters)) : undefined} />
          ))}
        </KpiGrid>
      )}

      {/* ── Exceptions ────────────────────────────────────────────────────── */}
      {can('dashboard.analyze') && (exceptions.data ?? []).some((e) => e.count > 0) && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Card>
            <CardHeader
              icon={<AlertTriangle size={16} />}
              title="Exceptions requiring attention"
              subtitle="Each row opens the transactions behind it"
            />
            <CardBody flush>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(268px, 1fr))' }}>
                {(exceptions.data ?? []).filter((e) => e.count > 0).map((e) => (
                  <button
                    key={e.key}
                    onClick={() => navigate(drilldownLink(e.drilldown, {}, filters))}
                    style={{
                      textAlign: 'left', padding: 'var(--sp-4)',
                      borderRight: '1px solid var(--border-subtle)',
                      borderBottom: '1px solid var(--border-subtle)',
                      transition: 'background var(--dur-fast) var(--ease)',
                    }}
                    onMouseEnter={(ev) => { ev.currentTarget.style.background = 'var(--ink-50)'; }}
                    onMouseLeave={(ev) => { ev.currentTarget.style.background = 'transparent'; }}
                  >
                    <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                      <Badge tone={e.severity === 'high' ? 'danger' : e.severity === 'medium' ? 'warning' : 'info'}>
                        {e.severity}
                      </Badge>
                      <div className="spacer" />
                      <span className="num" style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--ink-900)' }}>
                        {count(e.count)}
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>{e.label}</div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.5 }}>
                      {e.description}
                    </div>
                    {e.value && (
                      <div className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--danger-600)', fontWeight: 600, marginTop: 5 }}>
                        {money(e.value)} exposed
                      </div>
                    )}
                  </button>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* ── Trend + ageing ────────────────────────────────────────────────── */}
      {canTrends && (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
        <ChartFrame
          title="Purchase trend"
          subtitle="Ordered value against value actually received"
          height={300}
          loading={trends.isLoading}
          error={trends.error}
          isEmpty={(trends.data ?? []).length === 0}
          onRetry={() => void trends.refetch()}
          actions={
            <Tabs
              tabs={[{ key: 'day', label: 'Day' }, { key: 'week', label: 'Week' }, { key: 'month', label: 'Month' }]}
              active={granularity}
              onChange={(k) => setGranularity(k as 'day' | 'week' | 'month')}
            />
          }
        >
          <TrendChart
            data={trends.data ?? []}
            valueKind="currency"
            series={[
              { key: 'poValue', name: 'PO value', type: 'bar', color: '#1a4d80' },
              { key: 'receivedValue', name: 'Received value', type: 'area', color: '#1f9d5f' },
              { key: 'pendingValue', name: 'Pending value', type: 'line', color: '#d97a28' },
            ]}
            onPointClick={(p) => drill({ dateFrom: String(p.period), dateTo: String(p.period) })}
          />
        </ChartFrame>

        <ChartFrame
          title={ageBasis === 'po' ? 'Pending receipt ageing' : 'Indent awaiting PO ageing'}
          subtitle={ageBasis === 'po' ? 'Ordered value not yet received, by age of the order' : 'Approved demand not yet ordered, by age of the indent'}
          height={300}
          loading={ageing.isLoading}
          error={ageing.error}
          isEmpty={(ageing.data ?? []).every((b) => Number(b.pendingValue) === 0 && b.lineCount === 0)}
          onRetry={() => void ageing.refetch()}
          actions={
            <Tabs
              tabs={[{ key: 'po', label: 'PO → GRN' }, { key: 'indent', label: 'Indent → PO' }]}
              active={ageBasis}
              onChange={(k) => setAgeBasis(k as 'po' | 'indent')}
            />
          }
        >
          <AgeingChart
            data={ageing.data ?? []}
            onBucketClick={() => drill({}, ageBasis === 'po' ? '/purchase-orders/pending' : '/indents')}
          />
        </ChartFrame>
      </div>
      )}

      {/* ── Dimensional breakdown ─────────────────────────────────────────── */}
      {canBreakdown && (
      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Card>
          <div className="card-header" style={{ flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="card-title">Purchase analysis by {activeDim.label.toLowerCase()}</div>
              <div className="card-subtitle">
                Click any bar or row to open the matching purchase orders
                {breakdown.data?.meta.truncated && ` · showing top 12 of ${breakdown.data.meta.groupCount}`}
              </div>
            </div>
            <Tabs
              tabs={DIMENSIONS.map((d) => ({ key: d.key, label: d.label, icon: d.icon }))}
              active={dimension}
              onChange={(k) => setDimension(k as Dimension)}
            />
          </div>

          <CardBody>
            {breakdown.isLoading ? (
              <LoadingBlock height={320} />
            ) : (breakdown.data?.data ?? []).length === 0 ? (
              <EmptyState title="No purchase data for these filters" message="Widen the date range or clear some filters." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-5)' }}>
                <div>
                  <RankBarChart
                    data={breakdown.data!.data}
                    height={Math.max(280, breakdown.data!.data.length * 27)}
                    onBarClick={(row) => drill({ [activeDim.param]: [row.key] }, activeDim.route)}
                  />
                </div>

                <div>
                  <DonutChart
                    data={breakdown.data!.data.slice(0, 8).map((d) => ({
                      key: d.key, label: d.label, value: Number(d.totalValue),
                    }))}
                    height={300}
                    centerLabel="Total"
                    centerValue={moneyCompact(breakdown.data!.meta.grandTotalValue)}
                    onSliceClick={(key) => drill({ [activeDim.param]: [key] }, activeDim.route)}
                  />
                </div>
              </div>
            )}
          </CardBody>

          {(breakdown.data?.data ?? []).length > 0 && (
            <CardBody flush>
              <div className="table-wrap" style={{ maxHeight: 380 }}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{activeDim.label}</th>
                      <th className="right">POs</th>
                      <th className="right">Quantity</th>
                      <th className="right">Value</th>
                      <th className="right">Received</th>
                      <th className="right">Pending</th>
                      <th className="right">Avg discount</th>
                      <th className="right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.data!.data.map((row) => (
                      <tr
                        key={row.key}
                        className="clickable"
                        onClick={() => drill({ [activeDim.param]: [row.key] }, activeDim.route)}
                      >
                        <td className="cell-strong truncate" style={{ maxWidth: 300 }}>{row.label}</td>
                        <td className="right num">{count(row.poCount)}</td>
                        <td className="right num">{qty(row.totalQty)}</td>
                        <td className="right num cell-strong">{money(row.totalValue)}</td>
                        <td className="right num" style={{ color: 'var(--success-600)' }}>{money(row.receivedValue)}</td>
                        <td className="right num" style={{ color: Number(row.pendingValue) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>
                          {money(row.pendingValue)}
                        </td>
                        <td className="right num">{percent(row.avgDiscount)}</td>
                        <td className="right num">
                          <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            <span style={{ minWidth: 42 }}>{percent(row.sharePct)}</span>
                            <span style={{ width: 46, height: 4, borderRadius: 2, background: 'var(--ink-100)', overflow: 'hidden' }}>
                              <span style={{ display: 'block', height: '100%', width: `${Math.min(100, row.sharePct)}%`, background: 'var(--brand-500)' }} />
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total ({breakdown.data!.meta.groupCount})</td>
                      <td colSpan={2} />
                      <td className="right num">{money(breakdown.data!.meta.grandTotalValue)}</td>
                      <td colSpan={4} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardBody>
          )}
        </Card>
      </div>
      )}

      {/* ── Supplier performance ──────────────────────────────────────────── */}
      {(suppliers.data ?? []).length > 0 && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Card>
            <CardHeader
              icon={<Activity size={16} />}
              title="Supplier performance"
              subtitle="Fulfilment measured as received ÷ ordered quantity; on-time measured against promised delivery dates"
              actions={
                <Button variant="ghost" size="sm" iconRight={<ArrowRight size={13} />} onClick={() => navigate('/masters/suppliers')}>
                  All suppliers
                </Button>
              }
            />
            <CardBody flush>
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Location</th>
                      <th className="right">POs</th>
                      <th className="right">Value</th>
                      <th className="right">Pending</th>
                      <th className="right">Fulfilment</th>
                      <th className="right">On time</th>
                      <th className="right">Avg discount</th>
                      <th className="right">Last PO</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(suppliers.data ?? []).map((s) => (
                      <tr key={s.key} className="clickable" onClick={() => drill({ supplierId: [s.key] })}>
                        <td className="cell-strong truncate" style={{ maxWidth: 240 }}>{s.label}</td>
                        <td className="cell-muted">{[s.city, s.state].filter(Boolean).join(', ') || '—'}</td>
                        <td className="right num">{count(s.poCount)}</td>
                        <td className="right num cell-strong">{money(s.totalValue)}</td>
                        <td className="right num" style={{ color: Number(s.pendingValue) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>
                          {money(s.pendingValue)}
                        </td>
                        <td className="right"><RateCell value={s.fulfilmentRate} /></td>
                        <td className="right"><RateCell value={s.onTimeRate} warnBelow={95} /></td>
                        <td className="right num">{percent(s.avgDiscount)}</td>
                        <td className="right cell-muted">{s.lastPoDate ? formatDate(s.lastPoDate) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {/* ── Remaining catalogue metrics ───────────────────────────────────── */}
      {secondary.length > 0 && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
            <TrendingUp size={15} style={{ color: 'var(--brand-500)' }} />
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-600)' }}>
              All indicators
            </h2>
            <div className="divider grow" />
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
              Hover any card for its formula and data source
            </span>
          </div>
          <KpiGrid min={200}>
            {secondary.map((m) => (
              <KpiCard key={m.key} metric={m} compact onClick={m.drilldown ? () => navigate(drilldownLink(m.drilldown, {}, filters)) : undefined} />
            ))}
          </KpiGrid>
        </div>
      )}

      <div className="row" style={{ gap: 8, marginTop: 'var(--sp-5)', justifyContent: 'center', color: 'var(--text-faint)', fontSize: 'var(--text-2xs)' }}>
        <Clock size={11} />
        Figures are computed from the same balance definitions used by the transaction screens,
        so this dashboard always reconciles with the underlying lists.
      </div>
    </>
  );
}

function RateCell({ value, warnBelow = 80 }: { value: number; warnBelow?: number }) {
  const tone = value >= warnBelow ? 'var(--success-600)' : value >= warnBelow - 20 ? 'var(--warning-600)' : 'var(--danger-600)';
  return (
    <span className="row num" style={{ gap: 6, justifyContent: 'flex-end', color: tone, fontWeight: 600 }}>
      {percent(value)}
      <span style={{ width: 34, height: 4, borderRadius: 2, background: 'var(--ink-100)', overflow: 'hidden' }}>
        <span style={{ display: 'block', height: '100%', width: `${Math.min(100, value)}%`, background: tone }} />
      </span>
    </span>
  );
}
