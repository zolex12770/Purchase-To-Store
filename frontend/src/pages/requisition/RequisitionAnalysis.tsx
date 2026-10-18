/**
 * Requisition — Analysis (Purchase Module tab 4).
 *
 * Built on the SAME analytics infrastructure Indent/PO/GRN use — the shared
 * metric catalogue (`domain/metrics.ts`), `/analytics/kpis`, `/analytics/trends`
 * and the same chart primitives (ChartFrame, TrendChart, KpiGrid/KpiCard,
 * FilterBar) — rather than a bespoke page. It does NOT reuse the PO-shaped
 * `ModuleAnalysis`/`RankBarChart`/`DonutChart`/`AgeingChart` verbatim: those are
 * hard-coded to money (₹, "Received", "Pending value"), and a requisition has
 * no monetary value at all — it is a material request, quantity only. Forcing
 * qty data through a money-formatted chart would render a wrong, misleading
 * ₹ prefix on stock quantities, so the dimension breakdown and ageing panels
 * here are built from `/analytics/requisition-breakdown/:dimension` and
 * `/analytics/ageing?basis=requisition` with a quantity-only presentation.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, Download } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useFilters, drilldownLink, type FilterState } from '../../lib/useFilters';
import { PageHeader, PrintHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { KpiCard, KpiGrid, type MetricValue } from '../../components/KpiCard';
import { Card, CardBody, Button, Tabs, EmptyState, LoadingBlock, ErrorState } from '../../components/ui';
import { ChartFrame, TrendChart, type TrendPoint } from '../../components/charts';
import { qty, count } from '../../lib/format';

const METRIC_KEYS = [
  'requisition_count', 'requisition_pending_hod', 'requisition_hod_approved', 'requisition_hod_rejected',
  'requisition_awaiting_issue', 'requisition_requested_qty', 'requisition_issued_qty',
  'requisition_pending_qty', 'requisition_excess_qty', 'requisition_avg_approval_days',
  'requisition_issue_transaction_count',
];

interface RequisitionBreakdownRow {
  key: string;
  label: string;
  requisitionCount: number;
  totalRequestedQty: string;
  totalIssuedQty: string;
  totalPendingQty: string;
  totalExcessQty: string;
  sharePct: number;
}

interface AgeingBucketQty {
  bucket: string;
  label: string;
  lineCount: number;
  docCount: number;
  pendingQty: string;
}

const DIMENSIONS = [
  { key: 'item', label: 'Item', param: 'itemId' },
  { key: 'department', label: 'Department', param: 'departmentId' },
  { key: 'requester', label: 'Requester', param: 'requesterId' },
  { key: 'hod', label: 'HOD', param: 'hodId' },
  { key: 'machine', label: 'Machine', param: 'machineId' },
  { key: 'costCentre', label: 'Cost Centre', param: 'costCentreId' },
];

export default function RequisitionAnalysis() {
  const download = useDownload();
  const navigate = useNavigate();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [dimension, setDimension] = useState(DIMENSIONS[0]!.key);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('month');

  const query = qs({
    dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId,
    machineId: filters.machineId, itemId: filters.itemId, status: filters.status,
    userId: filters.userId, requesterId: filters.userId || filters.requesterId,
    hodId: filters.hodId,
  });
  const sep = query ? '&' : '?';

  const kpis = useQuery({
    queryKey: ['analytics', 'kpis', 'requisition', query],
    queryFn: () => api.getWithMeta<{ kpis: MetricValue[] }, { generatedAt: string }>(`/analytics/kpis${query}`),
  });

  const trends = useQuery({
    queryKey: ['analytics', 'trends', 'requisition', query, granularity],
    queryFn: () => api.get<TrendPoint[]>(`/analytics/trends${query}${sep}granularity=${granularity}`),
  });

  const ageing = useQuery({
    queryKey: ['analytics', 'ageing', 'requisition', query],
    queryFn: () => api.get<AgeingBucketQty[]>(`/analytics/ageing${query}${sep}basis=requisition`),
  });

  const breakdown = useQuery({
    queryKey: ['analytics', 'requisition-breakdown', dimension, query],
    queryFn: () => api.getWithMeta<RequisitionBreakdownRow[], { dimensionTitle: string; grandTotalRequestedQty: string; groupCount: number; truncated: boolean }>(
      `/analytics/requisition-breakdown/${dimension}${query}${sep}limit=15`,
    ),
  });

  const allMetrics = kpis.data?.data.kpis.filter((m) => m.key.startsWith('requisition_')) ?? [];
  const featured = METRIC_KEYS.map((k) => allMetrics.find((m) => m.key === k)).filter(Boolean) as MetricValue[];
  const activeDim = DIMENSIONS.find((d) => d.key === dimension)!;

  const drill = (extra: Record<string, unknown>) => navigate(drilldownLink('/requisitions', extra, filters as FilterState));

  const ageingPoints: TrendPoint[] = (ageing.data ?? []).map((b) => ({
    period: b.label, pendingQty: Number(b.pendingQty), documents: b.docCount,
  }));

  const filterSummary = [
    filters.dateFrom || filters.dateTo ? `${filters.dateFrom ?? 'start'} to ${filters.dateTo ?? 'today'}` : 'All time',
    activeCount > 0 ? `${activeCount} filter(s)` : null,
  ].filter(Boolean).join(' · ');

  const maxShare = Math.max(1, ...(breakdown.data?.data ?? []).map((r) => r.sharePct));

  return (
    <>
      <PrintHeader title="Requisition Analysis" filterContext={filterSummary} />

      <PageHeader
        title="Requisition Analysis"
        subtitle="Material request volume, HOD approval throughput and store-issue progress — quantity-based, not value-based"
        breadcrumbs={[{ label: 'Requisition', to: '/requisitions' }, { label: 'Analysis' }]}
        freshness={kpis.data?.meta.generatedAt}
        actions={
          <>
            <Button
              variant="secondary" size="sm" icon={<Download size={13} />}
              onClick={() => void download(`/io/export/requisition-lines?format=xlsx${query.replace('?', '&')}`, 'requisition-lines.xlsx')}
            >
              Export
            </Button>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
          </>
        }
      />

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'machine', 'item']}
      />

      {kpis.isLoading ? (
        <KpiGrid>
          {Array.from({ length: METRIC_KEYS.length }).map((_, i) => (
            <div key={i} className="card" style={{ padding: 'var(--sp-5)' }}>
              <div className="skeleton" style={{ height: 11, width: '55%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 24, width: '70%' }} />
            </div>
          ))}
        </KpiGrid>
      ) : featured.length > 0 ? (
        <KpiGrid min={200}>
          {featured.map((m) => (
            <KpiCard key={m.key} metric={m} onClick={m.drilldown ? () => navigate(drilldownLink(m.drilldown, {}, filters as FilterState)) : undefined} />
          ))}
        </KpiGrid>
      ) : (
        <Card><CardBody><EmptyState title="No metrics available" message="You may not have requisition analytics permission." /></CardBody></Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
        <ChartFrame
          title="Trend over time"
          subtitle="Requisitions raised, and quantity requested vs. issued"
          height={290}
          loading={trends.isLoading}
          error={trends.error}
          isEmpty={(trends.data ?? []).every((p) => Number(p.requisitionCount ?? 0) === 0)}
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
            series={[
              { key: 'requisitionCount', name: 'Requisitions raised', type: 'bar', color: '#1a4d80' },
              { key: 'requisitionRequestedQty', name: 'Requested Qty', type: 'line', color: '#d97a28' },
              { key: 'requisitionIssuedQty', name: 'Issued Qty', type: 'line', color: '#1f9d5f' },
            ]}
            valueKind="quantity"
            onPointClick={(p) => drill({ dateFrom: String(p.period), dateTo: String(p.period) })}
          />
        </ChartFrame>

        <ChartFrame
          title="Ageing — awaiting store issue"
          subtitle="HOD-approved requisitions (Store Status: Pending), grouped by age"
          height={290}
          loading={ageing.isLoading}
          error={ageing.error}
          isEmpty={ageingPoints.every((p) => Number(p.pendingQty ?? 0) === 0)}
          onRetry={() => void ageing.refetch()}
        >
          <TrendChart
            data={ageingPoints}
            series={[{ key: 'pendingQty', name: 'Pending Qty', type: 'bar', color: '#e0940f' }]}
            valueKind="quantity"
            onPointClick={() => navigate('/requisitions/store-queue')}
          />
        </ChartFrame>
      </div>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Card>
          <div className="card-header" style={{ flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="card-title">Analysis by {activeDim.label.toLowerCase()}</div>
              <div className="card-subtitle">
                Click any row to open the underlying requisitions
                {breakdown.data?.meta.truncated && ` · top 15 of ${breakdown.data.meta.groupCount}`}
              </div>
            </div>
            <Tabs tabs={DIMENSIONS.map((d) => ({ key: d.key, label: d.label }))} active={dimension} onChange={setDimension} />
          </div>

          <CardBody flush>
            {breakdown.isLoading ? (
              <LoadingBlock height={300} />
            ) : breakdown.error ? (
              <ErrorState error={breakdown.error} onRetry={() => void breakdown.refetch()} />
            ) : (breakdown.data?.data ?? []).length === 0 ? (
              <EmptyState title="No data for these filters" message="Widen the date range or clear some filters." />
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th style={{ minWidth: 260 }}>{activeDim.label}</th>
                      <th className="right">Requisitions</th>
                      <th className="right">Requested Qty</th>
                      <th className="right">Issued Qty</th>
                      <th className="right">Pending Qty</th>
                      <th className="right">Excess Qty</th>
                      <th style={{ width: 140 }}>Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.data!.data.map((row) => (
                      <tr key={row.key} className="clickable" onClick={() => drill({ [activeDim.param]: [row.key] })}>
                        <td className="cell-strong truncate" style={{ maxWidth: 320 }}>{row.label}</td>
                        <td className="right num">{count(row.requisitionCount)}</td>
                        <td className="right num cell-strong">{qty(row.totalRequestedQty)}</td>
                        <td className="right num" style={{ color: 'var(--success-600)' }}>{qty(row.totalIssuedQty)}</td>
                        <td className="right num" style={{ color: Number(row.totalPendingQty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>
                          {qty(row.totalPendingQty)}
                        </td>
                        <td className="right num" style={{ color: Number(row.totalExcessQty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>
                          {qty(row.totalExcessQty)}
                        </td>
                        <td>
                          <div className="row" style={{ gap: 6, alignItems: 'center' }}>
                            <div style={{ flex: 1, height: 6, borderRadius: 3, background: 'var(--bg-inset)', overflow: 'hidden' }}>
                              <div style={{ width: `${(row.sharePct / maxShare) * 100}%`, height: '100%', background: 'var(--brand-500)', borderRadius: 3 }} />
                            </div>
                            <span className="num" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', width: 34, textAlign: 'right' }}>
                              {row.sharePct.toFixed(0)}%
                            </span>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total ({breakdown.data!.meta.groupCount})</td>
                      <td />
                      <td className="right num">{qty(breakdown.data!.meta.grandTotalRequestedQty)}</td>
                      <td colSpan={4} />
                    </tr>
                  </tfoot>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </>
  );
}
