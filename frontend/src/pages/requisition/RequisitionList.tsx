/**
 * Requisition — Data / My Requisitions / Pending HOD Approval / Store Issue Queue.
 *
 * One component drives all four sections (Purchase Module tab 4) — the `scope`
 * prop maps straight onto the backend's `view` query param (requisition/routes.ts),
 * so each nav entry is a real, bookmarkable page rather than an in-page tab, while
 * still sharing one implementation instead of four near-duplicates.
 *
 * HOD Status and Store Status are TWO INDEPENDENT columns, never merged into one
 * generic status — both are derived server-side (v_requisition_header_balance,
 * migration 015) so this screen, the detail screen and the printed document can
 * never disagree about what they mean.
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, CheckCircle2, XCircle, RotateCcw, PackageCheck, Printer, Download } from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useFilters, type FilterState } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { Button, Tabs, StatusBadge, ConfirmDialog, Select } from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { qty, formatDate, count, text } from '../../lib/format';

interface RequisitionRow {
  id: number;
  requisition_no: string;
  requisition_date: string;
  status: string;
  hod_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  store_status: 'PENDING' | 'ISSUED';
  employee_name: string;
  employee_code: string;
  department_name: string | null;
  hod_name: string | null;
  machine_name: string | null;
  cost_centre_name: string | null;
  line_count: number;
  item_codes: string | null;
  first_item_description: string | null;
  first_item_available_stock: string | null;
  last_issue_slip_no: string | null;
  last_issue_date: string | null;
  total_requested_qty: string;
  total_issued_qty: string;
  total_pending_qty: string;
  total_excess_qty: string;
  age_days: number;
}

interface DashboardSummary {
  myRequisitions: number;
  pendingHodApproval: number;
  hodApproved: number;
  hodRejected: number;
  returned: number;
  awaitingStoreIssue: number;
  partiallyIssued: number;
  fullyIssued: number;
  totalRequestedQty: string;
  totalIssuedQty: string;
  totalPendingQty: string;
  totalExcessQty: string;
}

const STATUS_TABS = [
  { key: '', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'PENDING_APPROVAL', label: 'Pending Approval' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'RETURNED', label: 'Returned' },
  { key: 'PARTIALLY_ISSUED', label: 'Partially Issued' },
  { key: 'FULLY_ISSUED', label: 'Fully Issued' },
  { key: 'REJECTED', label: 'Rejected' },
  { key: 'CANCELLED', label: 'Cancelled' },
];

const HOD_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'HOD: Pending' },
  { value: 'APPROVED', label: 'HOD: Approved' },
  { value: 'REJECTED', label: 'HOD: Rejected' },
];
const STORE_STATUS_OPTIONS = [
  { value: 'PENDING', label: 'Store: Pending' },
  { value: 'ISSUED', label: 'Store: Issued' },
];

export type RequisitionScope = 'mine' | 'hod-pending' | 'store-queue' | undefined;

const SCOPE_META: Record<string, { title: string; subtitle: string; empty: string }> = {
  '': { title: 'Requisition', subtitle: 'Material requests, their HOD approval status and store issue progress', empty: 'No requisitions match the current filters.' },
  mine: { title: 'My Requisitions', subtitle: 'Requisitions you have raised, and their approval / issue status', empty: 'You have not raised any requisitions yet.' },
  'hod-pending': { title: 'Requisitions Waiting for Approval', subtitle: 'Requisitions from your department awaiting your decision', empty: 'Nothing is waiting on your approval right now.' },
  'store-queue': { title: 'Material to Issue', subtitle: 'HOD-approved requisitions ready for material issue', empty: 'No approved requisitions are awaiting issue right now.' },
};

export default function RequisitionList({ scope }: { scope?: RequisitionScope }) {
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const download = useDownload();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const [action, setAction] = useState<{ row: RequisitionRow; kind: 'approve' | 'reject' | 'return' } | null>(null);
  const [reason, setReason] = useState('');

  const meta = SCOPE_META[scope ?? ''] ?? SCOPE_META[''];
  const showStatusTabs = scope === undefined || scope === 'mine';
  const showDashboard = scope === undefined;
  const activeStatus = (filters.status as string[] | undefined)?.[0] ?? '';
  const activeHodStatus = (filters.hodStatus as string[] | undefined)?.[0] ?? '';
  const activeStoreStatus = (filters.storeStatus as string[] | undefined)?.[0] ?? '';

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir,
    status: filters.status, hodStatus: filters.hodStatus, storeStatus: filters.storeStatus,
    dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId, machineId: filters.machineId,
    itemId: filters.itemId,
    userId: filters.userId,
    requesterId: filters.userId || filters.requesterId,
    hodId: filters.hodId,
    view: scope,
    // A KPI card's scope (Total Requisitions, the quantity totals): every one but cancelled.
    excludeCancelled: filters.excludeCancelled,
  });

  const summaryQuery = qs({
    dateFrom: filters.dateFrom, dateTo: filters.dateTo,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId, machineId: filters.machineId,
    itemId: filters.itemId,
    userId: filters.userId,
    requesterId: filters.userId || filters.requesterId,
    hodId: filters.hodId,
  });

  const list = useQuery({
    queryKey: ['requisitions', scope, query],
    queryFn: () => api.getWithMeta<RequisitionRow[], PageMeta & {
      statusCounts: Record<string, number>; hodStatusCounts: Record<string, number>; storeStatusCounts: Record<string, number>;
      totals?: {
        requisitionCount: number;
        lineCount: number;
        totalRequestedQty: number;
        totalIssuedQty: number;
        totalPendingQty: number;
        totalExcessQty: number;
      };
    }>(`/requisitions${query}`),
  });

  const dashboard = useQuery({
    queryKey: ['requisitions', 'analysis', 'summary', summaryQuery],
    queryFn: () => api.get<DashboardSummary>(`/requisitions/analysis/summary${summaryQuery}`),
    enabled: showDashboard && can('requisition.analyze'),
  });

  const decide = useMutation({
    mutationFn: ({ row, kind }: { row: RequisitionRow; kind: 'approve' | 'reject' | 'return' }) =>
      api.post<{ message: string }>(`/requisitions/${row.id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res) => {
      toast.success('Requisition updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['requisitions'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const counts = list.data?.meta.statusCounts ?? {};
  const totalAll = Object.values(counts).reduce((a, b) => a + b, 0);

  const goFiltered = (patch: Partial<FilterState>) => {
    navigate('/requisitions');
    setFilters(patch);
  };

  const columns: Column<RequisitionRow>[] = [
    { key: 'no', header: 'Requisition No', sortKey: 'requisitionNo', width: '170px', render: (r) => <span className="cell-code">{r.requisition_no}</span> },
    {
      key: 'date', header: 'Date', sortKey: 'requisitionDate', width: '110px',
      render: (r) => (
        <div>
          <div>{formatDate(r.requisition_date)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{r.age_days}d ago</div>
        </div>
      ),
    },
    {
      key: 'requester', header: 'Requester',
      render: (r) => (
        <div>
          <div>{text(r.employee_name)}</div>
          {r.employee_code && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{r.employee_code}</div>}
        </div>
      ),
    },
    { key: 'dept', header: 'Department', render: (r) => text(r.department_name) },
    { key: 'hod', header: 'HOD', optional: true, render: (r) => text(r.hod_name) },
    { key: 'machine', header: 'Machine', optional: true, render: (r) => text(r.machine_name) },
    { key: 'cc', header: 'Cost Centre', optional: true, render: (r) => text(r.cost_centre_name) },
    {
      key: 'items', header: 'Item(s)', optional: true, width: '180px',
      render: (r) => r.line_count === 1
        ? <div className="truncate cell-strong" style={{ maxWidth: 170 }} title={r.first_item_description ?? ''}>{text(r.item_codes)}</div>
        : <span className="cell-muted">{count(r.line_count)} items</span>,
    },
    { key: 'req', header: 'Requested Qty', align: 'right', render: (r) => <span className="num">{qty(r.total_requested_qty)}</span> },
    { key: 'issued', header: 'Issued Qty', align: 'right', render: (r) => <span className="num">{qty(r.total_issued_qty)}</span> },
    {
      key: 'pending', header: 'Pending Qty', align: 'right',
      render: (r) => (
        <span className="num" style={{ color: Number(r.total_pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
          {qty(r.total_pending_qty)}
        </span>
      ),
    },
    {
      key: 'stock', header: 'Available Stock', align: 'right', optional: true,
      render: (r) => r.line_count === 1 && r.first_item_available_stock != null
        ? <span className="num cell-muted">{qty(r.first_item_available_stock)}</span>
        : <span className="cell-faint">—</span>,
    },
    { key: 'hodStatus', header: 'HOD Status', align: 'center', render: (r) => <StatusBadge status={r.hod_status} /> },
    { key: 'storeStatus', header: 'Store Status', align: 'center', render: (r) => <StatusBadge status={r.store_status} /> },
    {
      key: 'issueSlip', header: 'Issue Slip No', optional: true,
      render: (r) => (
        <div>
          <div className="cell-code">{text(r.last_issue_slip_no)}</div>
          {r.last_issue_date && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{formatDate(r.last_issue_date)}</div>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '120px',
      render: (r) => (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {r.status === 'PENDING_APPROVAL' && can('requisition.approve') && (
            <>
              <Button variant="ghost" size="sm" title="Approve" onClick={() => { setAction({ row: r, kind: 'approve' }); setReason(''); }}>
                <CheckCircle2 size={14} style={{ color: 'var(--success-600)' }} />
              </Button>
              <Button variant="ghost" size="sm" title="Return for correction" onClick={() => { setAction({ row: r, kind: 'return' }); setReason(''); }}>
                <RotateCcw size={14} style={{ color: 'var(--warning-600)' }} />
              </Button>
              <Button variant="ghost" size="sm" title="Reject" onClick={() => { setAction({ row: r, kind: 'reject' }); setReason(''); }}>
                <XCircle size={14} style={{ color: 'var(--danger-600)' }} />
              </Button>
            </>
          )}
          {(scope === 'store-queue' || r.status === 'APPROVED' || r.status === 'PARTIALLY_ISSUED') && can('requisition.issue') && (
            <Button variant="ghost" size="sm" title="Issue material" onClick={() => navigate(`/requisitions/${r.id}?issue=1`)}>
              <PackageCheck size={14} style={{ color: 'var(--success-600)' }} />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title={meta.title}
        subtitle={meta.subtitle}
        breadcrumbs={[{ label: 'Requisition', to: '/requisitions' }, { label: meta.title === 'Requisition' ? 'Data' : meta.title }]}
        actions={
          <>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
            {can('requisition.export') && (
              <Button
                variant="secondary" size="sm" icon={<Download size={13} />}
                onClick={() => void download(`/io/export/requisition-lines?format=xlsx${query.replace('?', '&')}`, 'requisition-lines.xlsx')}
              >
                Export
              </Button>
            )}
            {can('requisition.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => navigate('/requisitions/new')}>
                Create Requisition
              </Button>
            )}
          </>
        }
      />

      {showDashboard && dashboard.data ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="My Requisitions" value={String(dashboard.data.myRequisitions)} onClick={() => navigate('/requisitions/mine')} />
          <StatTile label="Waiting for Approval" value={String(dashboard.data.pendingHodApproval)} tone="warning" onClick={() => goFiltered({ status: ['PENDING_APPROVAL'] })} />
          <StatTile label="HOD Approved" value={String(dashboard.data.hodApproved)} tone="success" onClick={() => goFiltered({ hodStatus: ['APPROVED'] })} />
          <StatTile label="HOD Rejected" value={String(dashboard.data.hodRejected)} tone="danger" onClick={() => goFiltered({ hodStatus: ['REJECTED'] })} />
          <StatTile label="Returned" value={String(dashboard.data.returned)} tone="warning" onClick={() => goFiltered({ status: ['RETURNED'] })} />
          <StatTile label="Awaiting Store Issue" value={String(dashboard.data.awaitingStoreIssue)} tone="info" onClick={() => navigate('/requisitions/store-queue')} />
          <StatTile label="Partially Issued" value={String(dashboard.data.partiallyIssued)} tone="warning" onClick={() => goFiltered({ status: ['PARTIALLY_ISSUED'] })} />
          <StatTile label="Fully Issued" value={String(dashboard.data.fullyIssued)} tone="success" onClick={() => goFiltered({ status: ['FULLY_ISSUED'] })} />
          <StatTile label="Total Requested Qty" value={qty(dashboard.data.totalRequestedQty)} />
          <StatTile label="Total Issued Qty" value={qty(dashboard.data.totalIssuedQty)} tone="success" />
          <StatTile label="Current Pending Qty" value={qty(dashboard.data.totalPendingQty)} tone={Number(dashboard.data.totalPendingQty) > 0 ? 'warning' : 'default'} />
          <StatTile label="Over-Issued Qty" value={qty(dashboard.data.totalExcessQty)} tone={Number(dashboard.data.totalExcessQty) > 0 ? 'warning' : 'default'} />
        </div>
      ) : list.data?.meta.totals ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Requisitions" value={count(list.data.meta.totals.requisitionCount)} />
          <StatTile label="Line Items" value={count(list.data.meta.totals.lineCount)} />
          <StatTile label="Requested Qty" value={qty(list.data.meta.totals.totalRequestedQty)} />
          <StatTile label="Issued Qty" value={qty(list.data.meta.totals.totalIssuedQty)} tone="success" />
          <StatTile label="Pending Qty" value={qty(list.data.meta.totals.totalPendingQty)} tone={list.data.meta.totals.totalPendingQty > 0 ? 'warning' : 'default'} />
          <StatTile label="Over-Issued Qty" value={qty(list.data.meta.totals.totalExcessQty)} tone={list.data.meta.totals.totalExcessQty > 0 ? 'warning' : 'default'} />
        </div>
      ) : null}

      {showStatusTabs && (
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
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'machine', 'item']}
      >
        <Select
          className="input-sm" style={{ width: 150, height: 30 }}
          value={activeHodStatus}
          onChange={(e) => setFilters({ hodStatus: e.target.value ? [e.target.value] : undefined })}
          aria-label="HOD Status"
        >
          <option value="">HOD Status: All</option>
          {HOD_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
        <Select
          className="input-sm" style={{ width: 160, height: 30 }}
          value={activeStoreStatus}
          onChange={(e) => setFilters({ storeStatus: e.target.value ? [e.target.value] : undefined })}
          aria-label="Store Status"
        >
          <option value="">Store Status: All</option>
          {STORE_STATUS_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </Select>
      </FilterBar>

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey={`requisitions-${scope ?? 'all'}`}
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search requisition no., item, requester, employee code…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(page) => setFilters({ page }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(r) => navigate(`/requisitions/${r.id}`)}
        onExport={can('requisition.export') ? (format) => void download(`/io/export/requisition-lines?format=${format}${query.replace('?', '&')}`, `requisition-lines.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle="No requisitions found"
        emptyMessage={activeCount > 0 ? 'No requisitions match the current filters.' : meta.empty}
        emptyAction={can('requisition.create') ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => navigate('/requisitions/new')}>Create Requisition</Button> : undefined}
      />

      <ConfirmDialog
        open={action !== null}
        onClose={() => { setAction(null); setReason(''); }}
        onConfirm={() => action && decide.mutate(action)}
        title={action?.kind === 'approve' ? 'Approve this requisition?' : action?.kind === 'return' ? 'Return for correction?' : 'Reject this requisition?'}
        confirmLabel={action?.kind === 'approve' ? 'Approve' : action?.kind === 'return' ? 'Return' : 'Reject'}
        variant={action?.kind === 'approve' ? 'success' : action?.kind === 'return' ? 'primary' : 'danger'}
        loading={decide.isPending}
        requireReason={action?.kind === 'reject' || action?.kind === 'return'}
        reasonLabel={action?.kind === 'return' ? 'What needs correcting' : 'Rejection reason'}
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action?.kind === 'approve' ? (
            <>
              <strong>{action.row.requisition_no}</strong> will be approved and move to the Store Issue Queue.
              <br /><br />
              You cannot approve a requisition you raised yourself.
            </>
          ) : action?.kind === 'return' ? (
            <>
              <strong>{action?.row.requisition_no}</strong> returns to the requester for correction. They can edit and
              resubmit it — the reason is recorded in the audit trail.
            </>
          ) : (
            <>
              <strong>{action?.row.requisition_no}</strong> will be rejected. The reason is recorded on the document
              and in the audit trail.
            </>
          )
        }
      />
    </>
  );
}
