/**
 * Item Master (SRS §7.1).
 *
 * The detail drawer shows live balances and rate history — the "live quantity"
 * and "pending GRN quantity" the SRS asks for (§10), derived from the balance
 * views rather than stored on the item.
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Download, ExternalLink } from 'lucide-react';
import { api, qs, downloadFile, ApiError, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters, drilldownLink } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { useLookups, useLookupOptions } from '../../lib/masters';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Card, CardBody, Drawer, Modal, Field, Input, Select, Textarea, Checkbox, Badge, StatusBadge, ConfirmDialog, DetailItem, DetailGrid, SectionTitle, LoadingBlock,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { TrendChart } from '../../components/charts';
import { money, qty, count, formatDate, text, percent } from '../../lib/format';

interface Item {
  id: number;
  item_code: string;
  item_description: string;
  item_type_id: number | null; item_type_name: string | null;
  department_id: number | null; department_name: string | null;
  cost_centre_id: number | null; cost_centre_name: string | null;
  main_group_id: number | null; main_group_name: string | null;
  sub_main_group_id: number | null; sub_main_group_name: string | null;
  indent_type_id: number | null; indent_type_name: string | null;
  uom_id: number | null; uom_code: string | null; uom_name: string | null;
  hsn_code: string;
  item_specification: string;
  standard_rate: string | null;
  reorder_level: string | null;
  min_stock: string | null;
  max_stock: string | null;
  reorder_qty: string | null;
  live_stock_qty: string;
  gst_rate: string | null;
  is_active: boolean;
}

interface ItemDetail extends Item {
  summary: { po_count: number; total_ordered_qty: string; total_received_qty: string; pending_qty: string; total_value: string; avg_rate: string; min_rate: string | null; max_rate: string | null };
  rateHistory: { po_date: string; po_no: string; po_id: number; final_rate: string; rate: string; discount_pct: string; po_qty: string; supplier_name: string; supplier_id: number }[];
  suppliers: { supplier_id: number; supplier_name: string; po_count: number; total_qty: string; total_value: string; avg_rate: string }[];
  openIndents: { indent_line_id: number; indent_id: number; indent_no: string; indent_date: string; indent_qty: string; ordered_qty: string; pending_qty: string }[];
  requisitions: {
    requisition_line_id: number; requisition_id: number; requisition_no: string; requisition_date: string;
    requested_qty: string; issued_qty: string; pending_qty: string; line_status: string;
    employee_name: string; department_name: string | null; hod_name: string | null;
    hod_status: string; store_status: string;
  }[];
  issueHistory: {
    id: number; issue_slip_no: string; issue_date: string; requisition_id: number; requisition_no: string;
    issue_qty: string; previously_issued_qty: string; store_user_name: string | null;
  }[];
  stockLedger: {
    id: number; txn_type: string; reference_type: string; reference_no: string;
    inward_qty: string; outward_qty: string; balance_qty: string; txn_date: string;
    mln_no: string; created_by_name: string | null;
  }[];
}

const EMPTY: Partial<Item> = {
  item_code: '', item_description: '', hsn_code: '', item_specification: '', is_active: true,
};

export default function Items() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const [detailId, setDetailId] = useState<number | null>(routeId ? Number(routeId) : null);
  const [editing, setEditing] = useState<Partial<Item> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<Item | null>(null);

  useEffect(() => { if (routeId) setDetailId(Number(routeId)); }, [routeId]);

  const { data: lookups } = useLookups();
  const { options: itemTypes } = useLookupOptions('ITEM_TYPE');
  const { options: mainGroups } = useLookupOptions('MAIN_GROUP');
  const { options: indentTypes } = useLookupOptions('INDENT_TYPE');
  const { options: uoms } = useLookupOptions('UOM');

  // Sub Main Group cascades from the chosen Main Group (ADR-014).
  const subGroups = (lookups?.SUB_MAIN_GROUP ?? [])
    .filter((s) => !editing?.main_group_id || s.parentId === editing.main_group_id)
    .map((s) => ({ value: s.id, label: s.name }));

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir, isActive: filters.isActive,
    departmentId: filters.departmentId, costCentreId: filters.costCentreId,
    mainGroupId: filters.mainGroupId, itemTypeId: filters.itemTypeId,
    indentTypeId: filters.indentTypeId, hodId: filters.hodId,
  });

  const list = useQuery({
    queryKey: ['items', query],
    queryFn: () => api.getWithMeta<Item[], PageMeta & {
      totals?: {
        totalItems: number;
        activeItems: number;
        inactiveItems: number;
        qcRequiredItems: number;
      };
    }>(`/items${query}`),
  });

  const detail = useQuery({
    queryKey: ['item', detailId],
    queryFn: () => api.get<ItemDetail>(`/items/${detailId}`),
    enabled: detailId !== null,
  });

  const save = useMutation({
    mutationFn: (b: Partial<Item>) => {
      const payload = {
        itemCode: b.item_code, itemDescription: b.item_description,
        itemTypeId: b.item_type_id ?? null, departmentId: b.department_id ?? null,
        costCentreId: b.cost_centre_id ?? null, mainGroupId: b.main_group_id ?? null,
        subMainGroupId: b.sub_main_group_id ?? null, indentTypeId: b.indent_type_id ?? null,
        uomId: b.uom_id ?? null, hsnCode: b.hsn_code ?? '',
        itemSpecification: b.item_specification ?? '',
        standardRate: b.standard_rate ?? null, reorderLevel: b.reorder_level ?? null,
        minStock: b.min_stock ?? null, maxStock: b.max_stock ?? null,
        reorderQty: b.reorder_qty ?? null, gstRate: b.gst_rate ?? null,
        isActive: b.is_active ?? true,
      };
      return b.id ? api.put<Item>(`/items/${b.id}`, payload) : api.post<Item>('/items', payload);
    },
    onSuccess: (_, b) => {
      toast.success(b.id ? 'Item updated' : 'Item created', b.item_code);
      setEditing(null); setErrors({});
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['item'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  const remove = useMutation({
    mutationFn: (i: Item) => api.del<{ deleted: boolean; message: string }>(`/items/${i.id}`),
    onSuccess: (res) => {
      if (res.deleted) toast.success('Item deleted', res.message);
      else toast.warning('Item deactivated', res.message);
      setConfirmDelete(null); setDetailId(null);
      void qc.invalidateQueries({ queryKey: ['items'] });
    },
    onError: (err) => { toast.fromError(err); setConfirmDelete(null); },
  });

  const columns: Column<Item>[] = [
    { key: 'code', header: 'Item Code', sortKey: 'itemCode', width: '150px', render: (i) => <span className="cell-code">{i.item_code}</span> },
    {
      key: 'desc', header: 'Item Description', sortKey: 'itemDescription',
      render: (i) => (
        <div style={{ minWidth: 200, maxWidth: 380 }}>
          <div className="cell-strong cell-wrap">{i.item_description}</div>
          {i.item_specification && (
            <div className="cell-wrap" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{i.item_specification}</div>
          )}
        </div>
      ),
    },
    { key: 'type', header: 'Item Type', render: (i) => text(i.item_type_name) },
    { key: 'group', header: 'Main Group', sortKey: 'mainGroup', render: (i) => text(i.main_group_name) },
    { key: 'subgroup', header: 'Sub Main Group', optional: true, render: (i) => text(i.sub_main_group_name) },
    { key: 'hsn', header: 'HSN Code', optional: true, render: (i) => <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{text(i.hsn_code)}</span> },
    { key: 'indentType', header: 'Indent Type', optional: true, render: (i) => text(i.indent_type_name) },
    {
      key: 'liveStock', header: 'Live Stock', align: 'right',
      render: (i) => (
        <span className="num cell-strong" onClick={(e) => { e.stopPropagation(); navigate(`/masters/stock-reconciliation?search=${encodeURIComponent(i.item_code)}`); }}>
          {qty(i.live_stock_qty)}
        </span>
      ),
    },
    { key: 'uom', header: 'UOM', align: 'center', render: (i) => <Badge tone="neutral" plain>{i.uom_code ?? '—'}</Badge> },
    { key: 'status', header: 'Status', align: 'center', render: (i) => <Badge tone={i.is_active ? 'success' : 'neutral'}>{i.is_active ? 'Active' : 'Inactive'}</Badge> },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '90px',
      render: (i) => (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {can('item.edit') && <Button variant="ghost" size="sm" onClick={() => setEditing(i)} title="Edit"><Pencil size={13} /></Button>}
          {can('item.delete') && <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(i)} title="Delete"><Trash2 size={13} /></Button>}
        </div>
      ),
    },
  ];

  const rateTrend = (detail.data?.rateHistory ?? [])
    .slice()
    .reverse()
    .map((r) => ({ period: formatDate(r.po_date), rate: Number(r.final_rate) }));

  return (
    <>
      <PageHeader
        title="Item Master"
        subtitle="Items, classification, specification and purchase history"
        breadcrumbs={[{ label: 'Master', to: '/masters/items' }, { label: 'Item Master' }]}
        actions={
          <>
            {can('item.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />} onClick={() => void downloadFile('/io/export/items?format=xlsx', 'items.xlsx')}>
                Export
              </Button>
            )}
            {can('item.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => { setEditing({ ...EMPTY }); setErrors({}); }}>
                New Item
              </Button>
            )}
          </>
        }
      />

      {list.data?.meta && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Total Items" value={count(list.data.meta.totals?.totalItems ?? list.data.meta.total ?? 0)} />
          <StatTile label="Active Items" value={count(list.data.meta.totals?.activeItems ?? 0)} tone="success" />
          <StatTile label="Inactive Items" value={count(list.data.meta.totals?.inactiveItems ?? 0)} tone="default" />
          <StatTile label="QC Required Items" value={count(list.data.meta.totals?.qcRequiredItems ?? 0)} tone="info" />
        </div>
      )}

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <FilterBar
          filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
          show={['department', 'costCentre', 'hod', 'mainGroup', 'itemType', 'indentType']}
        />
      </div>

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(i) => i.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="items"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search item code, description, HSN…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(page) => setFilters({ page }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(i) => setDetailId(i.id)}
        selectedKey={detailId}
        onExport={can('item.export') ? (format) => void downloadFile(`/io/export/items?format=${format}`, `items.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle="No items yet"
        emptyMessage="Add your first item, or import the Item Master from Excel."
        emptyAction={can('item.create') ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ ...EMPTY })}>New Item</Button> : undefined}
        toolbar={
          <>
            <Select className="input-sm" style={{ width: 140, height: 30 }}
              value={(filters.mainGroupId as string[])?.[0] ?? ''}
              onChange={(e) => setFilters({ mainGroupId: e.target.value ? [e.target.value] : undefined })}
              aria-label="Main group filter"
            >
              <option value="">All groups</option>
              {mainGroups.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select className="input-sm" style={{ width: 130, height: 30 }}
              value={(filters.itemTypeId as string[])?.[0] ?? ''}
              onChange={(e) => setFilters({ itemTypeId: e.target.value ? [e.target.value] : undefined })}
              aria-label="Item type filter"
            >
              <option value="">All types</option>
              {itemTypes.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
            <Select className="input-sm" style={{ width: 120, height: 30 }}
              value={(filters.isActive as string) ?? ''}
              onChange={(e) => setFilters({ isActive: e.target.value || undefined })}
              aria-label="Status filter"
            >
              <option value="">All status</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </Select>
          </>
        }
      />

      {activeCount > 0 && (
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <Button variant="ghost" size="sm" onClick={() => clearFilters()}>Clear filters</Button>
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      <Drawer
        open={detailId !== null}
        onClose={() => { setDetailId(null); if (routeId) navigate('/masters/items'); }}
        wide
        title={detail.data?.item_code ?? 'Item'}
        subtitle={detail.data?.item_description}
        actions={detail.data && can('item.edit') ? (
          <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(detail.data!)}>Edit</Button>
        ) : undefined}
      >
        {detail.isLoading ? (
          <LoadingBlock />
        ) : detail.data ? (
          <div className="stack" style={{ gap: 'var(--sp-6)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(145px, 1fr))', gap: 'var(--sp-3)' }}>
              <StatTile label="Ordered qty" value={qty(detail.data.summary.total_ordered_qty)} />
              <StatTile label="Received qty" value={qty(detail.data.summary.total_received_qty)} tone="success" />
              <StatTile
                label="Pending GRN qty"
                value={qty(detail.data.summary.pending_qty)}
                tone={Number(detail.data.summary.pending_qty) > 0 ? 'warning' : 'default'}
              />
              <StatTile label="Purchase value" value={money(detail.data.summary.total_value)} />
            </div>

            <div>
              <SectionTitle>Master information</SectionTitle>
              <DetailGrid cols={3}>
                <DetailItem label="Item code" mono>{detail.data.item_code}</DetailItem>
                <DetailItem label="Item type">{text(detail.data.item_type_name)}</DetailItem>
                <DetailItem label="UOM">{text(detail.data.uom_name ?? detail.data.uom_code)}</DetailItem>
                <DetailItem label="Indent type">{text(detail.data.indent_type_name)}</DetailItem>
                <DetailItem label="Main group">{text(detail.data.main_group_name)}</DetailItem>
                <DetailItem label="Sub main group">{text(detail.data.sub_main_group_name)}</DetailItem>
                <DetailItem label="HSN code" mono>{text(detail.data.hsn_code)}</DetailItem>
                <DetailItem label="Average purchase rate">{money(detail.data.summary.avg_rate)}</DetailItem>
                <DetailItem label="Rate range">
                  {detail.data.summary.min_rate
                    ? `${money(detail.data.summary.min_rate)} – ${money(detail.data.summary.max_rate)}`
                    : '—'}
                </DetailItem>
                <div style={{ gridColumn: '1 / -1' }}>
                  <DetailItem label="Item specification">{text(detail.data.item_specification)}</DetailItem>
                </div>
              </DetailGrid>
            </div>

            {rateTrend.length > 1 && (
              <div>
                <SectionTitle>Purchase rate trend</SectionTitle>
                <Card>
                  <CardBody>
                    <div style={{ height: 180 }}>
                      <TrendChart
                        data={rateTrend}
                        valueKind="currency"
                        height={180}
                        series={[{ key: 'rate', name: 'Final rate/pc', type: 'line', color: '#d97a28' }]}
                      />
                    </div>
                  </CardBody>
                </Card>
              </div>
            )}

            {detail.data.openIndents.length > 0 && (
              <div>
                <SectionTitle>Approved demand awaiting a purchase order</SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead><tr><th>Indent No</th><th>Date</th><th className="right">Indent qty</th><th className="right">Ordered</th><th className="right">Pending</th></tr></thead>
                    <tbody>
                      {detail.data.openIndents.map((o) => (
                        <tr key={o.indent_line_id} className="clickable" onClick={() => navigate(`/indents/${o.indent_id}`)}>
                          <td className="cell-code">{o.indent_no}</td>
                          <td>{formatDate(o.indent_date)}</td>
                          <td className="right num">{qty(o.indent_qty)}</td>
                          <td className="right num">{qty(o.ordered_qty)}</td>
                          <td className="right num cell-strong" style={{ color: 'var(--warning-600)' }}>{qty(o.pending_qty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.data.suppliers.length > 0 && (
              <div>
                <SectionTitle>Suppliers for this item</SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead><tr><th>Supplier</th><th className="right">POs</th><th className="right">Quantity</th><th className="right">Avg rate</th><th className="right">Value</th></tr></thead>
                    <tbody>
                      {detail.data.suppliers.map((s) => (
                        <tr key={s.supplier_id} className="clickable" onClick={() => navigate(`/masters/suppliers/${s.supplier_id}`)}>
                          <td className="cell-strong">{s.supplier_name}</td>
                          <td className="right num">{count(s.po_count)}</td>
                          <td className="right num">{qty(s.total_qty)}</td>
                          <td className="right num">{money(s.avg_rate)}</td>
                          <td className="right num cell-strong">{money(s.total_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.data.rateHistory.length > 0 && (
              <div>
                <SectionTitle
                  action={
                    <Button variant="ghost" size="sm" iconRight={<ExternalLink size={12} />}
                            onClick={() => navigate(drilldownLink('/purchase-orders', { itemId: [String(detail.data!.id)] }))}>
                      All purchase orders
                    </Button>
                  }
                >
                  Recent purchase rates
                </SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 280 }}>
                  <table className="table table-compact">
                    <thead>
                      <tr><th>PO No</th><th>Date</th><th>Supplier</th><th className="right">Qty</th><th className="right">Rate</th><th className="right">Disc %</th><th className="right">Final rate</th></tr>
                    </thead>
                    <tbody>
                      {detail.data.rateHistory.map((r, i) => (
                        <tr key={`${r.po_id}-${i}`} className="clickable" onClick={() => navigate(`/purchase-orders/${r.po_id}`)}>
                          <td className="cell-code">{r.po_no}</td>
                          <td>{formatDate(r.po_date)}</td>
                          <td className="cell-wrap" style={{ minWidth: 130, maxWidth: 220 }}>{r.supplier_name}</td>
                          <td className="right num">{qty(r.po_qty)}</td>
                          <td className="right num cell-muted">{money(r.rate)}</td>
                          <td className="right num">{Number(r.discount_pct) > 0 ? percent(r.discount_pct) : '—'}</td>
                          <td className="right num cell-strong">{money(r.final_rate)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.data.requisitions.length > 0 && (
              <div>
                <SectionTitle
                  action={
                    <Button variant="ghost" size="sm" iconRight={<ExternalLink size={12} />}
                            onClick={() => navigate(drilldownLink('/requisitions', { itemId: [String(detail.data!.id)] }))}>
                      All requisitions
                    </Button>
                  }
                >
                  Requisitions (material requests, outward)
                </SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 280 }}>
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Requisition No</th><th>Date</th><th>Requester</th><th>Department</th>
                        <th className="right">Requested</th><th className="right">Issued</th><th className="right">Pending</th>
                        <th className="center">HOD</th><th className="center">Store</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.requisitions.map((r) => (
                        <tr key={r.requisition_line_id} className="clickable" onClick={() => navigate(`/requisitions/${r.requisition_id}`)}>
                          <td className="cell-code">{r.requisition_no}</td>
                          <td>{formatDate(r.requisition_date)}</td>
                          <td className="truncate" style={{ maxWidth: 150 }}>{text(r.employee_name)}</td>
                          <td className="truncate" style={{ maxWidth: 130 }}>{text(r.department_name)}</td>
                          <td className="right num cell-strong">{qty(r.requested_qty)}</td>
                          <td className="right num">{qty(r.issued_qty)}</td>
                          <td className="right num" style={{ color: Number(r.pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>{qty(r.pending_qty)}</td>
                          <td className="center"><StatusBadge status={r.hod_status} /></td>
                          <td className="center"><StatusBadge status={r.store_status} /></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.data.issueHistory.length > 0 && (
              <div>
                <SectionTitle>Issue transactions</SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 240 }}>
                  <table className="table table-compact">
                    <thead>
                      <tr><th>Issue Slip</th><th>Date</th><th>Requisition</th><th>Store User</th><th className="right">Issued Qty</th></tr>
                    </thead>
                    <tbody>
                      {detail.data.issueHistory.map((i) => (
                        <tr key={i.id} className="clickable" onClick={() => navigate(`/requisitions/${i.requisition_id}`)}>
                          <td className="cell-code">{i.issue_slip_no}</td>
                          <td>{formatDate(i.issue_date)}</td>
                          <td className="cell-code">{i.requisition_no}</td>
                          <td>{text(i.store_user_name)}</td>
                          <td className="right num cell-strong">{qty(i.issue_qty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {detail.data.stockLedger.length > 0 && (
              <div>
                <SectionTitle>Stock ledger — full inward/outward reconciliation</SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 280 }}>
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th>Date</th><th>Type</th><th>Reference</th>
                        <th className="right">Inward</th><th className="right">Outward</th><th className="right">Balance</th>
                      </tr>
                    </thead>
                    <tbody>
                      {detail.data.stockLedger.map((l) => (
                        <tr key={l.id}>
                          <td>{formatDate(l.txn_date)}</td>
                          <td><Badge tone={l.txn_type.includes('REVERSAL') ? 'warning' : l.txn_type.includes('ISSUE') ? 'info' : 'success'} plain>{l.txn_type.replace(/_/g, ' ')}</Badge></td>
                          <td className="cell-code">{text(l.reference_no)}{l.mln_no ? ` · ${l.mln_no}` : ''}</td>
                          <td className="right num" style={{ color: Number(l.inward_qty) > 0 ? 'var(--success-600)' : 'var(--text-faint)' }}>
                            {Number(l.inward_qty) > 0 ? `+${qty(l.inward_qty)}` : '—'}
                          </td>
                          <td className="right num" style={{ color: Number(l.outward_qty) > 0 ? 'var(--danger-600)' : 'var(--text-faint)' }}>
                            {Number(l.outward_qty) > 0 ? `−${qty(l.outward_qty)}` : '—'}
                          </td>
                          <td className="right num cell-strong">{qty(l.balance_qty)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        ) : null}
      </Drawer>

      {/* ── Create / edit ─────────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => { setEditing(null); setErrors({}); }}
        title={editing?.id ? 'Edit item' : 'New item'}
        subtitle={editing?.id ? editing.item_code : 'Classification here drives every dropdown downstream'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditing(null); setErrors({}); }}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              {editing?.id ? 'Save changes' : 'Create item'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="form-grid">
            <Field label="Item code" required error={errors.itemCode} hint="Unique and searchable">
              <Input
                value={editing.item_code ?? ''}
                onChange={(e) => setEditing({ ...editing, item_code: e.target.value.toUpperCase() })}
                invalid={Boolean(errors.itemCode)}
                style={{ fontFamily: 'var(--font-mono)' }}
                autoFocus
                placeholder="CBL-CU-3C25"
              />
            </Field>
            <Field label="Item description" required error={errors.itemDescription} span={2}>
              <Input
                value={editing.item_description ?? ''}
                onChange={(e) => setEditing({ ...editing, item_description: e.target.value })}
                invalid={Boolean(errors.itemDescription)}
                placeholder="Copper Cable 3C x 25 sq.mm Armoured"
              />
            </Field>
            <Field label="Item type" error={errors.itemTypeId}>
              <Select value={editing.item_type_id ?? ''} placeholder="Select type"
                      onChange={(e) => setEditing({ ...editing, item_type_id: e.target.value ? Number(e.target.value) : null })}
                      options={itemTypes} />
            </Field>
            <Field label="UOM" error={errors.uomId}>
              <Select value={editing.uom_id ?? ''} placeholder="Select unit"
                      onChange={(e) => setEditing({ ...editing, uom_id: e.target.value ? Number(e.target.value) : null })}
                      options={uoms} />
            </Field>
            <Field label="Main group" error={errors.mainGroupId}>
              <Select
                value={editing.main_group_id ?? ''} placeholder="Select group"
                onChange={(e) => setEditing({
                  ...editing,
                  main_group_id: e.target.value ? Number(e.target.value) : null,
                  // Changing the parent invalidates the child selection.
                  sub_main_group_id: null,
                })}
                options={mainGroups}
              />
            </Field>
            <Field
              label="Sub main group"
              error={errors.subMainGroupId}
              hint={editing.main_group_id ? undefined : 'Choose a main group first'}
            >
              <Select
                value={editing.sub_main_group_id ?? ''}
                placeholder={editing.main_group_id ? 'Select sub group' : '—'}
                disabled={!editing.main_group_id}
                onChange={(e) => setEditing({ ...editing, sub_main_group_id: e.target.value ? Number(e.target.value) : null })}
                options={subGroups}
              />
            </Field>
            <Field label="Indent type" error={errors.indentTypeId}>
              <Select value={editing.indent_type_id ?? ''} placeholder="Select indent type"
                      onChange={(e) => setEditing({ ...editing, indent_type_id: e.target.value ? Number(e.target.value) : null })}
                      options={indentTypes} />
            </Field>
            <Field label="HSN code" error={errors.hsnCode} hint="4 to 8 digits">
              <Input value={editing.hsn_code ?? ''}
                     onChange={(e) => setEditing({ ...editing, hsn_code: e.target.value })}
                     invalid={Boolean(errors.hsnCode)} style={{ fontFamily: 'var(--font-mono)' }} maxLength={8} />
            </Field>
            <Field label="Item specification" span="full" hint="Auto-fills onto indent and PO lines">
              <Textarea value={editing.item_specification ?? ''}
                        onChange={(e) => setEditing({ ...editing, item_specification: e.target.value })} rows={2} />
            </Field>
            <div className="field-span-full">
              <Checkbox label="Active — appears in item dropdowns"
                        checked={editing.is_active ?? true}
                        onChange={(v) => setEditing({ ...editing, is_active: v })} />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
        title="Delete item?"
        confirmLabel="Delete"
        loading={remove.isPending}
        message={
          <>
            <strong>{confirmDelete?.item_code}</strong> — {confirmDelete?.item_description}
            <br /><br />
            If the item appears on any indent, PO or GRN line it will be{' '}
            <strong>deactivated instead of deleted</strong> so transaction history stays intact.
          </>
        }
      />
    </>
  );
}
