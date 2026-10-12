/**
 * Purchase Order — Data / Pending PO / Complete PO (SRS §11.4).
 *
 * The same list serves all three sub-tabs; "pending" and "complete" are decided
 * by the authoritative balance on the server, not by a status string.
 */
import { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Download, Printer, AlertTriangle, GitMerge } from 'lucide-react';
import { api, qs, downloadFile, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { Button, Tabs, StatusBadge, Badge, Card, CardBody } from '../../components/ui';
import { DocumentQuickViewModal } from '../../components/DocumentQuickViewModal';
import { StatTile } from '../../components/KpiCard';
import { money, qty, formatDate, count, text } from '../../lib/format';

interface PoRow {
  id: number;
  po_no: string;
  po_date: string;
  status: string;
  source_mode: string;
  po_type_name: string | null;
  supplier_id: number;
  supplier_name: string;
  supplier_code: string;
  supplier_city: string;
  payment_terms: string;
  delivery_date: string | null;
  line_count: number;
  total_po_qty: string;
  total_received_qty: string;
  total_pending_qty: string;
  total_amount: string;
  received_amount: string;
  pending_amount: string;
  age_days: number;
  source_indent_count: number;
  grn_count: number;
  created_by_name: string | null;
  remarks: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'OPEN', label: 'Open' },
  { key: 'PARTIALLY_RECEIVED', label: 'Partially Received' },
  { key: 'COMPLETED', label: 'Completed' },
  { key: 'SHORT_CLOSED', label: 'Short Closed' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

export default function PoList() {
  const navigate = useNavigate();
  const location = useLocation();
  const { can } = useAuth();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [quickViewId, setQuickViewId] = useState<number | null>(null);

  const view = location.pathname.endsWith('/pending')
    ? 'pending'
    : location.pathname.endsWith('/complete')
      ? 'complete'
      : 'all';

  const activeStatus = (filters.status as string[] | undefined)?.[0] ?? '';

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir,
    status: filters.status, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    supplierId: filters.supplierId, poTypeId: filters.poTypeId, itemId: filters.itemId,
    userId: filters.userId, departmentId: filters.departmentId, costCentreId: filters.costCentreId,
    mainGroupId: filters.mainGroupId, hodId: filters.hodId,
    view, overdue: filters.overdue,
  });

  const list = useQuery({
    queryKey: ['purchase-orders', query],
    queryFn: () => api.getWithMeta<PoRow[], PageMeta & {
      statusCounts: Record<string, number>;
      totals: { value: string; pending: string; received: string; cancelledValue: string };
    }>(`/purchase-orders${query}`),
  });

  const counts = list.data?.meta.statusCounts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const totals = list.data?.meta.totals;

  const columns: Column<PoRow>[] = [
    {
      key: 'no', header: 'PO No', sortKey: 'poNo', width: '160px',
      render: (r) => (
        <div>
          <span className="cell-code cell-link" onClick={(e) => { e.stopPropagation(); setQuickViewId(r.id); }}>{r.po_no}</span>
          <div className="row" style={{ gap: 4, marginTop: 2 }}>
            <Badge tone={r.source_mode === 'INDENT' ? 'info' : 'neutral'} plain>
              {r.source_mode === 'INDENT' ? 'From indent' : 'Direct'}
            </Badge>
            {r.source_indent_count > 1 && (
              <span title={`Consolidated from ${r.source_indent_count} indents`}>
                <Badge tone="progress" plain>×{r.source_indent_count}</Badge>
              </span>
            )}
          </div>
        </div>
      ),
    },
    {
      key: 'date', header: 'Date', sortKey: 'poDate', width: '108px',
      render: (r) => (
        <div>
          <div>{formatDate(r.po_date)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{r.age_days}d ago</div>
        </div>
      ),
    },
    {
      key: 'supplier', header: 'Supplier', sortKey: 'supplier',
      render: (r) => (
        <div style={{ minWidth: 160, maxWidth: 240 }}>
          <div className="cell-strong cell-wrap">{r.supplier_name}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
            {[r.supplier_code, r.supplier_city].filter(Boolean).join(' · ')}
          </div>
        </div>
      ),
    },
    { key: 'type', header: 'PO Type', render: (r) => text(r.po_type_name) },
    { key: 'terms', header: 'Payment Terms', optional: true, render: (r) => text(r.payment_terms) },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => <span className="num">{count(r.line_count)}</span> },
    { key: 'poqty', header: 'PO Qty', align: 'right', render: (r) => <span className="num">{qty(r.total_po_qty)}</span> },
    { key: 'recvqty', header: 'Received Qty', align: 'right', optional: true, render: (r) => <span className="num">{qty(r.total_received_qty)}</span> },
    {
      key: 'pendqty', header: 'Pending GRN Qty', align: 'right',
      render: (r) => (
        <span className="num" style={{ color: Number(r.total_pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
          {qty(r.total_pending_qty)}
        </span>
      ),
    },
    { key: 'amount', header: 'Amount', sortKey: 'totalAmount', align: 'right', render: (r) => <span className="num cell-strong">{money(r.total_amount)}</span> },
    { key: 'received', header: 'Received Value', align: 'right', optional: true, render: (r) => <span className="num" style={{ color: 'var(--success-600)' }}>{money(r.received_amount)}</span> },
    {
      key: 'pending', header: 'Pending Value', sortKey: 'pendingAmount', align: 'right',
      render: (r) => <span className="num" style={{ color: Number(r.pending_amount) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>{money(r.pending_amount)}</span>,
    },
    { key: 'grns', header: 'GRNs', align: 'right', optional: true, render: (r) => <span className="num">{count(r.grn_count)}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', align: 'center', render: (r) => <StatusBadge status={r.status} /> },
  ];

  const titles: Record<string, { title: string; subtitle: string; crumb: string }> = {
    all: { title: 'Purchase Order', subtitle: 'Orders raised on suppliers, direct or from approved indents', crumb: 'Data' },
    pending: { title: 'Pending Purchase Orders', subtitle: 'Open commitments with quantity still to be received', crumb: 'Pending PO' },
    complete: { title: 'Complete Purchase Orders', subtitle: 'Fully received or short-closed orders', crumb: 'Complete PO' },
  };
  const page = titles[view]!;

  return (
    <>
      <PageHeader
        title={page.title}
        subtitle={page.subtitle}
        breadcrumbs={[{ label: 'Purchase Order', to: '/purchase-orders' }, { label: page.crumb }]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
            {can('po.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />}
                      onClick={() => void downloadFile(`/io/export/purchase-orders?format=xlsx${query.replace('?', '&')}`, 'purchase-orders.xlsx')}>
                Export
              </Button>
            )}
            {can('po.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => navigate('/purchase-orders/new')}>
                Create Purchase Order
              </Button>
            )}
          </>
        }
      />

      {totals && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Total PO value" value={money(totals.value)}
                    sub={`${list.data?.meta.total ?? 0} order(s) in view · excludes cancelled`} />
          <StatTile label="Received value" value={money(totals.received)} tone="success" />
          <StatTile label="Pending value" value={money(totals.pending)} tone={Number(totals.pending) > 0 ? 'warning' : 'default'}
                    sub="Committed but not yet received" />
          {Number(totals.cancelledValue) > 0 && (
            <StatTile label="Cancelled value" value={money(totals.cancelledValue)} tone="danger"
                      sub="Excluded from the totals above" />
          )}
        </div>
      )}

      {view === 'all' && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Tabs
            tabs={STATUS_TABS.map((t) => ({ key: t.key, label: t.label, count: t.key === '' ? totalAll : (counts[t.key] ?? 0) }))}
            active={activeStatus}
            onChange={(k) => setFilters({ status: k ? [k] : undefined })}
          />
        </div>
      )}

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'poType', 'mainGroup', 'item']}
        extra={
          view === 'pending' ? (
            <Button
              variant={filters.overdue === 'true' ? 'danger' : 'secondary'}
              size="sm" icon={<AlertTriangle size={13} />}
              onClick={() => setFilters({ overdue: filters.overdue === 'true' ? undefined : 'true' })}
            >
              Overdue only
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="purchase-orders"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search PO number, supplier, item…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(p) => setFilters({ page: p }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(r) => navigate(`/purchase-orders/${r.id}`)}
        onExport={can('po.export') ? (format) => void downloadFile(`/io/export/purchase-orders?format=${format}${query.replace('?', '&')}`, `purchase-orders.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle={view === 'pending' ? 'Nothing pending' : view === 'complete' ? 'No completed orders yet' : 'No purchase orders found'}
        emptyMessage={
          view === 'pending'
            ? 'Every issued purchase order has been fully received.'
            : activeCount > 0
              ? 'No purchase orders match the current filters.'
              : 'Raise a direct purchase order, or convert an approved indent.'
        }
        emptyAction={can('po.create') && view === 'all' ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate('/purchase-orders/new')}>Create Purchase Order</Button> : undefined}
        footer={
          totals && (list.data?.data.length ?? 0) > 0 ? (
            <tr>
              <td colSpan={7}>Page totals</td>
              <td className="right num">{qty((list.data?.data ?? []).reduce((s, r) => s + Number(r.total_po_qty), 0))}</td>
              <td className="right num">{qty((list.data?.data ?? []).reduce((s, r) => s + Number(r.total_pending_qty), 0))}</td>
              <td className="right num">{money((list.data?.data ?? []).reduce((s, r) => s + Number(r.total_amount), 0))}</td>
              <td className="right num">{money((list.data?.data ?? []).reduce((s, r) => s + Number(r.pending_amount), 0))}</td>
              <td />
            </tr>
          ) : undefined
        }
      />

      {view === 'all' && (
        <Card style={{ marginTop: 'var(--sp-4)' }}>
          <CardBody style={{ padding: 'var(--sp-4)' }}>
            <div className="row" style={{ gap: 10, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              <GitMerge size={15} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
              <span>
                A <strong>×N</strong> badge means the order consolidates several approved indents onto
                one document. Open the PO to see exactly which indent line each quantity came from.
              </span>
            </div>
          </CardBody>
        </Card>
      )}

      <DocumentQuickViewModal type="po" id={quickViewId} onClose={() => setQuickViewId(null)} />
    </>
  );
}
