/**
 * Shared module analysis view (SRS §10, §11, §12 "Data and Analysis" sub-tabs).
 *
 * Indent, Purchase Order and GRN each require an Analysis view. They ask the same
 * questions of the same authoritative data, so they share ONE implementation
 * configured per module rather than three near-identical copies (build brief §54).
 *
 * Each module's breakdown groups its own records (`breakdown.path`): the Indent and
 * GRN screens drew the PO breakdown and opened the indent and GRN lists, so a bar
 * counted purchase orders and the list it opened showed something else (2026-10-17
 * E2E run, S1-D2). A bar opens the list the server names for it (meta.drilldown).
 */
import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Printer, Download } from 'lucide-react';
import { api, qs } from '../lib/api';
import { useDownload } from '../lib/useDownload';
import { useFilters, drilldownLink, type FilterState } from '../lib/useFilters';
import { periodRange, isDrillable, kpiPanelState } from '../lib/analysis';
import { PageHeader, PrintHeader } from '../layout/AppShell';
import { FilterBar, type FilterKey } from './FilterBar';
import { KpiCard, KpiGrid, type MetricValue } from './KpiCard';
import { Card, CardBody, Button, Tabs, EmptyState, ErrorState, LoadingBlock, Banner } from './ui';
import { ChartFrame, TrendChart, RankBarChart, DonutChart, AgeingChart, type BreakdownRow, type AgeingBucket, type TrendPoint } from './charts';
import { money, qty, count, percent, moneyCompact } from '../lib/format';

export interface AnalysisDimension {
  key: string;
  label: string;
  /** Query param used when drilling into the list. */
  param: string;
}

/** A column of the breakdown table after the group's label; `total` picks the footer figure. */
export interface BreakdownColumn {
  header: string;
  cell: (row: BreakdownRow) => ReactNode;
  total?: 'documents' | 'qty' | 'value';
}

interface BreakdownMeta {
  dimensionTitle: string;
  drilldownParam: string;
  /** The list each bar opens, its key under drilldownParam (backend analytics/routes.ts). */
  drilldown: string;
  grandTotalValue: string;
  grandTotalQty: string;
  documentCount: number;
  groupCount: number;
  truncated: boolean;
}

export interface ModuleAnalysisProps {
  title: string;
  subtitle: string;
  breadcrumbs: { label: string; to?: string }[];
  /** Metric keys from the catalogue to feature at the top. */
  metricKeys: string[];
  /** Which trend series to plot. */
  trendSeries: { key: string; name: string; type: 'bar' | 'line' | 'area'; color: string }[];
  trendValueKind: 'currency' | 'count' | 'quantity';
  dimensions: AnalysisDimension[];
  /**
   * The list a trend point opens, scoped as the trend counts: '/purchase-orders' listed
   * the cancelled orders the trend leaves out (2026-10-17 E2E run, S1-D3).
   */
  drilldownRoute: string;
  /** This module's own breakdown: its endpoint, what it counts, and its table's columns. */
  breakdown: { path: string; documents: string; columns: BreakdownColumn[] };
  filterKeys: FilterKey[];
  statusOptions?: { value: string; label: string }[];
  /** Ageing basis, or omit to hide the ageing panel. */
  ageingBasis?: 'po' | 'indent';
  ageingTitle?: string;
  exportDataset?: string;
}

/** The list an ageing bucket opens: what the ageing counts, still to be received or ordered. */
const AGEING_DRILL: Record<'po' | 'indent', string> = {
  po: '/purchase-orders/pending',
  indent: '/indents?eligibleOnly=true',
};

export function ModuleAnalysis({
  title, subtitle, breadcrumbs, metricKeys, trendSeries, trendValueKind,
  dimensions, drilldownRoute, breakdown: config, filterKeys, statusOptions, ageingBasis, ageingTitle, exportDataset,
}: ModuleAnalysisProps) {
  const navigate = useNavigate();
  const download = useDownload();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [dimension, setDimension] = useState(dimensions[0]!.key);
  const [granularity, setGranularity] = useState<'day' | 'week' | 'month'>('month');

  const query = qs({
    dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    supplierId: filters.supplierId, itemId: filters.itemId,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId,
    poTypeId: filters.poTypeId, indentTypeId: filters.indentTypeId,
    mainGroupId: filters.mainGroupId, itemTypeId: filters.itemTypeId,
    userId: filters.userId, hodId: filters.hodId, qcStatus: filters.qcStatus,
    status: filters.status,
  });
  const sep = query ? '&' : '?';

  const kpis = useQuery({
    queryKey: ['analytics', 'kpis', query],
    queryFn: () => api.getWithMeta<{ kpis: MetricValue[] }, { generatedAt: string }>(`/analytics/kpis${query}`),
  });

  const trends = useQuery({
    queryKey: ['analytics', 'trends', query, granularity],
    queryFn: () => api.get<TrendPoint[]>(`/analytics/trends${query}${sep}granularity=${granularity}`),
  });

  const breakdown = useQuery({
    queryKey: ['analytics', config.path, dimension, query],
    queryFn: () => api.getWithMeta<BreakdownRow[], BreakdownMeta>(`${config.path}/${dimension}${query}${sep}limit=12`),
  });

  const ageing = useQuery({
    queryKey: ['analytics', 'ageing', ageingBasis, query],
    queryFn: () => api.get<AgeingBucket[]>(`/analytics/ageing${query}${sep}basis=${ageingBasis}`),
    enabled: Boolean(ageingBasis),
  });

  const allMetrics = kpis.data?.data.kpis ?? [];
  const featured = metricKeys
    .map((k) => allMetrics.find((m) => m.key === k))
    .filter(Boolean) as MetricValue[];
  const kpiState = kpiPanelState(kpis, featured.length);

  const activeDim = dimensions.find((d) => d.key === dimension)!;
  const drill = (extra: Record<string, unknown>, base = drilldownRoute) =>
    navigate(drilldownLink(base, extra, filters as FilterState));
  // A bar opens the list the server says it counts; a bar without a key opens nothing.
  const drillBar = (key: string | null) => {
    if (!isDrillable(key)) return;
    const meta = breakdown.data?.meta;
    drill({ [meta?.drilldownParam ?? activeDim.param]: [key] }, meta?.drilldown ?? drilldownRoute);
  };
  const footerTotal = (total: BreakdownColumn['total'], meta: BreakdownMeta) =>
    total === 'value' ? money(meta.grandTotalValue)
      : total === 'qty' ? qty(meta.grandTotalQty)
        : total === 'documents' ? count(meta.documentCount)
          : null;

  const filterSummary = [
    filters.dateFrom || filters.dateTo ? `${filters.dateFrom ?? 'start'} to ${filters.dateTo ?? 'today'}` : 'All time',
    activeCount > 0 ? `${activeCount} filter(s)` : null,
  ].filter(Boolean).join(' · ');

  return (
    <>
      <PrintHeader title={title} filterContext={filterSummary} />

      <PageHeader
        title={title}
        subtitle={subtitle}
        breadcrumbs={breadcrumbs}
        freshness={kpis.data?.meta.generatedAt}
        actions={
          <>
            {exportDataset && (
              <Button
                variant="secondary" size="sm" icon={<Download size={13} />}
                onClick={() => void download(`/io/export/${exportDataset}?format=xlsx${query.replace('?', '&')}`, `${exportDataset}.xlsx`, 'Could not export')}
              >
                Export
              </Button>
            )}
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
          </>
        }
      />

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={filterKeys} statusOptions={statusOptions}
      />

      {kpis.error && kpis.data && (
        <Banner tone="danger" action={<Button variant="secondary" size="sm" onClick={() => void kpis.refetch()}>Try again</Button>}>
          The indicators could not be refreshed; the figures below are from the last successful load.
        </Banner>
      )}
      {kpiState === 'loading' ? (
        <KpiGrid>
          {Array.from({ length: metricKeys.length }).map((_, i) => (
            <div key={i} className="card" style={{ padding: 'var(--sp-5)' }}>
              <div className="skeleton" style={{ height: 11, width: '55%', marginBottom: 10 }} />
              <div className="skeleton" style={{ height: 24, width: '70%' }} />
            </div>
          ))}
        </KpiGrid>
      ) : kpiState === 'error' ? (
        <Card><CardBody>
          <ErrorState error={kpis.error} onRetry={() => void kpis.refetch()} title="Could not load the indicators" />
        </CardBody></Card>
      ) : kpiState === 'ready' ? (
        <KpiGrid min={215}>
          {featured.map((m) => (
            <KpiCard key={m.key} metric={m} onClick={m.drilldown ? () => navigate(drilldownLink(m.drilldown, {}, filters as FilterState)) : undefined} />
          ))}
        </KpiGrid>
      ) : (
        <Card><CardBody><EmptyState title="No metrics available" message="You may not have analytics permission for this module." /></CardBody></Card>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: ageingBasis ? 'repeat(auto-fit, minmax(430px, 1fr))' : '1fr', gap: 'var(--sp-4)', marginTop: 'var(--sp-4)' }}>
        <ChartFrame
          title="Trend over time"
          subtitle="Click a period to open the matching records"
          height={290}
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
            series={trendSeries}
            valueKind={trendValueKind}
            // The whole period the point stands for: it opened only the period's first day.
            onPointClick={(p) => drill(periodRange(String(p.period), granularity, filters))}
          />
        </ChartFrame>

        {ageingBasis && (
          <ChartFrame
            title={ageingTitle ?? 'Ageing'}
            subtitle="Outstanding exposure grouped by age"
            height={290}
            loading={ageing.isLoading}
            error={ageing.error}
            isEmpty={(ageing.data ?? []).every((b) => b.lineCount === 0)}
            onRetry={() => void ageing.refetch()}
          >
            <AgeingChart data={ageing.data ?? []} onBucketClick={() => drill({}, AGEING_DRILL[ageingBasis])} />
          </ChartFrame>
        )}
      </div>

      <div style={{ marginTop: 'var(--sp-4)' }}>
        <Card>
          <div className="card-header" style={{ flexWrap: 'wrap' }}>
            <div className="grow" style={{ minWidth: 200 }}>
              <div className="card-title">{config.documents} by {activeDim.label.toLowerCase()}</div>
              <div className="card-subtitle">
                Click any bar, slice or row to open the {config.documents.toLowerCase()} it counts
                {breakdown.data?.meta.truncated && ` · top 12 of ${breakdown.data.meta.groupCount}`}
              </div>
            </div>
            <Tabs
              tabs={dimensions.map((d) => ({ key: d.key, label: d.label }))}
              active={dimension}
              onChange={setDimension}
            />
          </div>

          <CardBody>
            {breakdown.isLoading ? (
              <LoadingBlock height={300} />
            ) : breakdown.error ? (
              <ErrorState error={breakdown.error} onRetry={() => void breakdown.refetch()} />
            ) : (breakdown.data?.data ?? []).length === 0 ? (
              <EmptyState title="No data for these filters" message="Widen the date range or clear some filters." />
            ) : (
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(390px, 1fr))', gap: 'var(--sp-5)' }}>
                <RankBarChart
                  data={breakdown.data!.data}
                  height={Math.max(270, breakdown.data!.data.length * 26)}
                  documentsLabel={config.documents}
                  onBarClick={(row) => drillBar(row.key)}
                />
                <DonutChart
                  data={breakdown.data!.data.slice(0, 8).map((d) => ({ key: d.key ?? '', label: d.label, value: Number(d.totalValue) }))}
                  height={290}
                  centerLabel="Total"
                  centerValue={moneyCompact(breakdown.data!.meta.grandTotalValue)}
                  onSliceClick={(key) => drillBar(key)}
                />
              </div>
            )}
          </CardBody>

          {!breakdown.error && (breakdown.data?.data ?? []).length > 0 && (
            <CardBody flush>
              <div className="table-wrap" style={{ maxHeight: 400 }}>
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>{activeDim.label}</th>
                      {config.columns.map((c) => <th key={c.header} className="right">{c.header}</th>)}
                      <th className="right">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {breakdown.data!.data.map((row) => (
                      <tr
                        key={row.key ?? '∅'}
                        className={isDrillable(row.key) ? 'clickable' : undefined}
                        onClick={() => drillBar(row.key)}
                        title={isDrillable(row.key) ? undefined : 'No list filter selects this group'}
                      >
                        <td className="cell-strong truncate" style={{ maxWidth: 300 }}>{row.label}</td>
                        {config.columns.map((c) => <td key={c.header} className="right num">{c.cell(row)}</td>)}
                        <td className="right num">{percent(row.sharePct)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td>Total ({breakdown.data!.meta.groupCount})</td>
                      {config.columns.map((c) => (
                        <td key={c.header} className="right num">{footerTotal(c.total, breakdown.data!.meta)}</td>
                      ))}
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>
            </CardBody>
          )}
        </Card>
      </div>

      {allMetrics.length > featured.length && (
        <div style={{ marginTop: 'var(--sp-5)' }}>
          <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
            <h2 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--ink-600)' }}>
              Related indicators
            </h2>
            <div className="divider grow" />
          </div>
          <KpiGrid min={200}>
            {allMetrics.filter((m) => !metricKeys.includes(m.key)).map((m) => (
              <KpiCard key={m.key} metric={m} compact onClick={m.drilldown ? () => navigate(drilldownLink(m.drilldown, {}, filters as FilterState)) : undefined} />
            ))}
          </KpiGrid>
        </div>
      )}
    </>
  );
}
