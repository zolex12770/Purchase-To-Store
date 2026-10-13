/**
 * Purchase Indent — Data (SRS §10).
 *
 * Status tabs with live counts, universal filters, and one-click approve/reject
 * for users holding the approval permission.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Download, CheckCircle2, XCircle, RotateCcw, Printer } from 'lucide-react';
import { api, qs, downloadFile, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { Button, Tabs, StatusBadge, ConfirmDialog } from '../../components/ui';
import { DocumentQuickViewModal } from '../../components/DocumentQuickViewModal';
import { StatTile } from '../../components/KpiCard';
import { qty, formatDate, count, text, money } from '../../lib/format';

interface IndentRow {
  id: number;
  indent_no: string;
  indent_date: string;
  status: string;
  indent_type_name: string | null;
  department_name: string | null;
  cost_centre_name: string | null;
  suggested_supplier_name: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  rejection_reason: string | null;
  line_count: number;
  total_indent_qty: string;
  total_ordered_qty: string;
  total_pending_qty: string;
  total_estimated_value: string;
  eligible_line_count: number;
  age_days: number;
  remarks: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'PENDING_APPROVAL', label: 'Pending Approval' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CLOSED', label: 'Closed' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

export default function IndentList() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const [action, setAction] = useState<{ row: IndentRow; kind: 'approve' | 'reject' | 'unapprove' } | null>(null);
  const [reason, setReason] = useState('');
  const [quickViewId, setQuickViewId] = useState<number | null>(null);

  const activeStatus = (filters.status as string[] | undefined)?.[0] ?? '';

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir,
    status: filters.status, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    indentTypeId: filters.indentTypeId, departmentId: filters.departmentId,
    costCentreId: filters.costCentreId, supplierId: filters.supplierId,
    itemId: filters.itemId, userId: filters.userId, hodId: filters.hodId,
  });

  const list = useQuery({
    queryKey: ['indents', query],
    queryFn: () => api.getWithMeta<IndentRow[], PageMeta & {
      statusCounts: Record<string, number>;
      totals?: {
        indentCount: number;
        lineCount: number;
        totalIndentQty: number;
        totalOrderedQty: number;
        totalPendingQty: number;
        totalEstimatedValue: number;
      };
    }>(`/indents${query}`),
  });

  const decide = useMutation({
    mutationFn: ({ row, kind }: { row: IndentRow; kind: 'approve' | 'reject' | 'unapprove' }) =>
      api.post<{ message: string }>(`/indents/${row.id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res) => {
      toast.success('Indent updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['indents'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const counts = list.data?.meta.statusCounts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);
  const totals = list.data?.meta.totals;

  const columns: Column<IndentRow>[] = [
    {
      key: 'no', header: 'Indent No', sortKey: 'indentNo', width: '160px',
      render: (r) => (
        <span
          className="cell-code cell-link"
          onClick={(e) => { e.stopPropagation(); setQuickViewId(r.id); }}
        >
          {r.indent_no}
        </span>
      ),
    },
    {
      key: 'date', header: 'Date', sortKey: 'indentDate', width: '110px',
      render: (r) => (
        <div>
          <div>{formatDate(r.indent_date)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{r.age_days}d ago</div>
        </div>
      ),
    },
    { key: 'type', header: 'Indent Type', render: (r) => text(r.indent_type_name) },
    { key: 'dept', header: 'Department', render: (r) => text(r.department_name) },
    { key: 'cc', header: 'Cost Centre', optional: true, render: (r) => text(r.cost_centre_name) },
    { key: 'requester', header: 'Requested By', render: (r) => text(r.requested_by_name) },
    { key: 'lines', header: 'Lines', align: 'right', render: (r) => <span className="num">{count(r.line_count)}</span> },
    { key: 'qty', header: 'Indent Qty', align: 'right', render: (r) => <span className="num">{qty(r.total_indent_qty)}</span> },
    {
      key: 'ordered', header: 'Ordered Qty', align: 'right', optional: true,
      render: (r) => <span className="num">{qty(r.total_ordered_qty)}</span>,
    },
    {
      key: 'pending', header: 'Pending Qty', align: 'right',
      render: (r) => (
        <span className="num" style={{ color: Number(r.total_pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
          {qty(r.total_pending_qty)}
        </span>
      ),
    },
    {
      key: 'status', header: 'Status', sortKey: 'status', align: 'center',
      render: (r) => (
        <div title={r.status === 'REJECTED' && r.rejection_reason ? `Reason: ${r.rejection_reason}` : undefined}>
          <StatusBadge status={r.status} />
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '96px',
      render: (r) => (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {r.status === 'PENDING_APPROVAL' && can('indent.approve') && (
            <Button variant="ghost" size="sm" title="Approve"
                    onClick={() => { setAction({ row: r, kind: 'approve' }); setReason(''); }}>
              <CheckCircle2 size={14} style={{ color: 'var(--success-600)' }} />
            </Button>
          )}
          {r.status === 'PENDING_APPROVAL' && can('indent.reject') && (
            <Button variant="ghost" size="sm" title="Reject"
                    onClick={() => { setAction({ row: r, kind: 'reject' }); setReason(''); }}>
              <XCircle size={14} style={{ color: 'var(--danger-600)' }} />
            </Button>
          )}
          {r.status === 'APPROVED' && can('indent.approve') && (
            <Button
              variant="ghost" size="sm"
              title={Number(r.total_ordered_qty) > 0
                ? 'Already converted into a purchase order — cancel/short-close that PO first'
                : 'Unapprove'}
              disabled={Number(r.total_ordered_qty) > 0}
              onClick={() => { setAction({ row: r, kind: 'unapprove' }); setReason(''); }}
            >
              <RotateCcw size={14} style={{ color: 'var(--danger-600)' }} />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Purchase Indent"
        subtitle="Requisitions from departments, and their approval status"
        breadcrumbs={[{ label: 'Purchase Indent', to: '/indents' }, { label: 'Data' }]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
            {can('indent.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />}
                      onClick={() => void downloadFile(`/io/export/indents?format=xlsx${query.replace('?', '&')}`, 'indents.xlsx')}>
                Export
              </Button>
            )}
            {can('indent.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => navigate('/indents/new')}>
                Create Indent
              </Button>
            )}
          </>
        }
      />

      {totals && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Total Indents" value={count(totals.indentCount)} sub={`${count(totals.lineCount)} line item(s)`} />
          <StatTile label="Total Indent Qty" value={qty(totals.totalIndentQty)} />
          <StatTile label="Ordered Qty" value={qty(totals.totalOrderedQty)} tone="success" />
          <StatTile label="Pending Qty" value={qty(totals.totalPendingQty)} tone={totals.totalPendingQty > 0 ? 'warning' : 'default'} />
          <StatTile label="Estimated Value" value={money(totals.totalEstimatedValue)} />
        </div>
      )}

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Tabs
          tabs={STATUS_TABS.map((t) => ({
            key: t.key,
            label: t.label,
            count: t.key === '' ? totalAll : (counts[t.key] ?? 0),
          }))}
          active={activeStatus}
          onChange={(k) => setFilters({ status: k ? [k] : undefined })}
        />
      </div>

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'indentType', 'item']}
      />

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="indents"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search indent number, item, remarks…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(page) => setFilters({ page }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(r) => navigate(`/indents/${r.id}`)}
        onExport={can('indent.export') ? (format) => void downloadFile(`/io/export/indents?format=${format}${query.replace('?', '&')}`, `indents.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle="No indents found"
        emptyMessage={activeCount > 0 ? 'No indents match the current filters.' : 'Raise your first purchase indent to start the procurement cycle.'}
        emptyAction={can('indent.create') ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate('/indents/new')}>Create Indent</Button> : undefined}
      />

      <ConfirmDialog
        open={action !== null}
        onClose={() => { setAction(null); setReason(''); }}
        onConfirm={() => action && decide.mutate(action)}
        title={
          action?.kind === 'approve' ? 'Approve this indent?'
            : action?.kind === 'unapprove' ? 'Unapprove this indent?' : 'Reject this indent?'
        }
        confirmLabel={action?.kind === 'approve' ? 'Approve' : action?.kind === 'unapprove' ? 'Unapprove' : 'Reject'}
        variant={action?.kind === 'approve' ? 'success' : action?.kind === 'unapprove' ? 'primary' : 'danger'}
        loading={decide.isPending}
        // The API enforces this too; the dialog simply makes it obvious up front.
        requireReason={action?.kind === 'reject'}
        reasonLabel="Rejection reason"
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action?.kind === 'approve' ? (
            <>
              <strong>{action.row.indent_no}</strong> will be approved and its{' '}
              {count(action.row.line_count)} line(s) become available for purchase orders.
              <br /><br />
              You cannot approve an indent you raised yourself.
            </>
          ) : action?.kind === 'unapprove' ? (
            <>
              <strong>{action.row.indent_no}</strong> returns directly to <strong>Draft</strong> — fully
              editable, not rejected — so it can be corrected and resubmitted for approval.
            </>
          ) : (
            <>
              <strong>{action?.row.indent_no}</strong> will be rejected. The reason is recorded on the
              document and in the audit trail, and the requester can correct and resubmit it.
            </>
          )
        }
      />

      <DocumentQuickViewModal type="indent" id={quickViewId} onClose={() => setQuickViewId(null)} />
    </>
  );
}
