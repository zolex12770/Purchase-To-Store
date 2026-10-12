/**
 * GRN — Data (SRS §12).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Download, Printer, Truck } from 'lucide-react';
import { api, qs, downloadFile, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { Button, Tabs, StatusBadge } from '../../components/ui';
import { DocumentQuickViewModal } from '../../components/DocumentQuickViewModal';
import { money, qty, formatDate, count, text } from '../../lib/format';

interface GrnRow {
  id: number;
  grn_no: string;
  grn_date: string;
  grn_time: string;
  status: string;
  invoice_no: string | null;
  challan_no: string;
  challan_date: string | null;
  vehicle_no: string;
  grn_type_name: string | null;
  po_id: number | null;
  po_no: string | null;
  po_date: string | null;
  po_status: string | null;
  po_numbers: string | null;
  is_po_based: boolean;
  supplier_id: number;
  supplier_name: string;
  supplier_code: string;
  received_by_name: string | null;
  line_count: number | null;
  total_qty: string | null;
  total_amount: string | null;
  remarks: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'POSTED', label: 'Posted' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

export default function GrnList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [quickViewId, setQuickViewId] = useState<number | null>(null);

  const activeStatus = (filters.status as string[] | undefined)?.[0] ?? '';

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir,
    status: filters.status, qcStatus: filters.qcStatus, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    supplierId: filters.supplierId, itemId: filters.itemId, poId: filters.poId,
    userId: filters.userId, departmentId: filters.departmentId, costCentreId: filters.costCentreId, hodId: filters.hodId,
  });

  const list = useQuery({
    queryKey: ['grn', query],
    queryFn: () => api.getWithMeta<GrnRow[], PageMeta & { statusCounts: Record<string, number> }>(`/grn${query}`),
  });

  const counts = list.data?.meta.statusCounts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  const columns: Column<GrnRow>[] = [
    {
      key: 'no', header: 'GRN No', sortKey: 'grnNo', width: '160px',
      render: (r) => (
        <span className="cell-code cell-link" onClick={(e) => { e.stopPropagation(); setQuickViewId(r.id); }}>
          {r.grn_no}
        </span>
      ),
    },
    {
      key: 'date', header: 'Date', sortKey: 'grnDate', width: '110px',
      render: (r) => (
        <div>
          <div>{formatDate(r.grn_date)}</div>
          <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{r.grn_time}</div>
        </div>
      ),
    },
    {
      key: 'po', header: 'PO No', sortKey: 'poNo',
      render: (r) => (
        <div>
          {r.is_po_based ? (
            <>
              <span className="cell-code">{r.po_numbers ?? r.po_no}</span>
              {r.po_date && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{formatDate(r.po_date)}</div>}
            </>
          ) : (
            <span className="cell-muted">Direct (no PO)</span>
          )}
        </div>
      ),
    },
    {
      key: 'supplier', header: 'Supplier', sortKey: 'supplier',
      render: (r) => (
        <div style={{ maxWidth: 220 }}>
          <div className="cell-strong truncate">{r.supplier_name}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{r.supplier_code}</div>
        </div>
      ),
    },
    { key: 'invoice', header: 'Invoice No', optional: true, render: (r) => <span className="cell-muted">{text(r.invoice_no)}</span> },
    { key: 'grntype', header: 'GRN Type', optional: true, render: (r) => <span className="cell-muted">{text(r.grn_type_name)}</span> },
    { key: 'receiver', header: 'Received By', optional: true, render: (r) => text(r.received_by_name) },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => <span className="num">{count(r.line_count ?? 0)}</span> },
    { key: 'qty', header: 'GRN Qty', align: 'right', render: (r) => <span className="num cell-strong">{qty(r.total_qty ?? 0)}</span> },
    { key: 'value', header: 'Value', align: 'right', render: (r) => <span className="num">{money(r.total_amount ?? 0)}</span> },
    { key: 'status', header: 'Status', sortKey: 'status', align: 'center', render: (r) => <StatusBadge status={r.status} /> },
    { key: 'postatus', header: 'PO Status', align: 'center', optional: true, render: (r) => (r.po_status ? <StatusBadge status={r.po_status} /> : <span className="cell-faint">—</span>) },
  ];

  return (
    <>
      <PageHeader
        title="Goods Receipt Note"
        subtitle="Receipts against purchase orders — partial or final"
        breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: 'Data' }]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
            {can('grn.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />}
                      onClick={() => void downloadFile(`/io/export/grn?format=xlsx${query.replace('?', '&')}`, 'grn.xlsx')}>
                Export
              </Button>
            )}
            {can('grn.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => navigate('/grn/new')}>
                Receive Material
              </Button>
            )}
          </>
        }
      />

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Tabs
          tabs={STATUS_TABS.map((t) => ({ key: t.key, label: t.label, count: t.key === '' ? totalAll : (counts[t.key] ?? 0) }))}
          active={activeStatus}
          onChange={(k) => setFilters({ status: k ? [k] : undefined })}
        />
      </div>

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'qcStatus', 'item']}
      />

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="grn"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search GRN, PO, supplier, challan…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(p) => setFilters({ page: p }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(r) => navigate(`/grn/${r.id}`)}
        onExport={can('grn.export') ? (format) => void downloadFile(`/io/export/grn?format=${format}${query.replace('?', '&')}`, `grn.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle="No goods receipts found"
        emptyMessage={activeCount > 0 ? 'No receipts match the current filters.' : 'Receive goods against an issued purchase order to create your first GRN.'}
        emptyAction={can('grn.create') ? <Button variant="primary" icon={<Truck size={14} />} onClick={() => navigate('/grn/new')}>Receive Material</Button> : undefined}
      />

      <DocumentQuickViewModal type="grn" id={quickViewId} onClose={() => setQuickViewId(null)} />
    </>
  );
}
