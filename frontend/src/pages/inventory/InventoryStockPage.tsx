/**
 * Inventory & Auto Indent Module (Purchase Module Tab / Requirement 9).
 *
 * Subtab A: Stock & Reorder Status
 * - Live usable stock, allocated stock, minimum stock, reorder level, maximum stock.
 * - In-pipeline tracking (Pending Indents, Pending POs).
 * - Real-time stock status (Normal, Below Reorder, Critical/Zero Stock, Excess).
 * - Direct CSV export & Stock Reorder audit trigger.
 *
 * Subtab B: Auto Indent Queue & Multi-Stage Approval
 * - Automated suggestions: shortfall to target stock factoring live stock and pipeline.
 * - Multi-stage approval: Store Incharge verification -> Purchase Head approval.
 * - 1-click conversion to live Purchase Indent.
 */
import { useState } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap, Download, CheckCircle2, XCircle, FileText,
  Boxes, ArrowRight, ShieldCheck,
} from 'lucide-react';
import { api, downloadFile, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, CardHeader, Badge, StatusBadge, Tabs,
  Modal, Field, Textarea, Select,
} from '../../components/ui';
import { qty, formatDateTime, count, toShortUom } from '../../lib/format';

interface StockRow {
  item_id: number;
  item_code: string;
  item_description: string;
  uom_id: number | null;
  uom_code: string;
  department_id: number | null;
  department_name: string;
  cost_centre_id: number | null;
  cost_centre_name: string;
  item_type_name: string;
  main_group_name: string;
  live_stock_qty: string;
  allocated_stock_qty: string;
  available_stock_qty: string;
  min_stock: string;
  max_stock: string | null;
  reorder_level: string;
  reorder_qty: string;
  pending_indent_qty: string;
  pending_po_qty: string;
  qc_required: boolean;
  stock_status: 'NORMAL' | 'BELOW_REORDER' | 'CRITICAL' | 'EXCESS';
}

interface AutoIndentRow {
  id: number;
  item_id: number;
  item_code: string;
  item_name: string;
  eligible_stock: string;
  min_stock: string;
  max_stock: string | null;
  reorder_level: string;
  suggested_qty: string;
  uom_id: number | null;
  uom_code: string;
  department_id: number | null;
  department_name: string;
  cost_centre_id: number | null;
  cost_centre_name: string;
  reason: string;
  status: 'PENDING_APPROVAL' | 'STORE_APPROVED' | 'PURCHASE_APPROVED' | 'APPROVED' | 'CONVERTED' | 'REJECTED';
  approver_id: number | null;
  approver_name: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  generated_indent_id: number | null;
  created_at: string;
}

interface AutoIndentStats {
  pending: number;
  storeApproved: number;
  approved: number;
  converted: number;
  rejected: number;
  total: number;
}

export default function InventoryStockPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'stock';
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const setTab = (tab: string) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set('tab', tab);
      return next;
    });
  };

  /* ── Tab A State ───────────────────────────────────────────────────────── */
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = useState(25);
  const [stockSearch, setStockSearch] = useState('');
  const [stockStatusFilter, setStockStatusFilter] = useState('ALL');

  /* ── Tab B State ───────────────────────────────────────────────────────── */
  const [indentPage, setIndentPage] = useState(1);
  const [indentPageSize, setIndentPageSize] = useState(25);
  const [indentSearch, setIndentSearch] = useState('');
  const [indentStatusFilter, setIndentStatusFilter] = useState('');
  const [rejectingItem, setRejectingItem] = useState<AutoIndentRow | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  /* ── Queries ───────────────────────────────────────────────────────────── */
  const stockParams = {
    page: filters.page ?? stockPage,
    pageSize: filters.pageSize ?? stockPageSize,
    search: (filters.search as string) || stockSearch || undefined,
    stockStatus: stockStatusFilter !== 'ALL' ? stockStatusFilter : undefined,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    mainGroupId: filters.mainGroupId,
    itemTypeId: filters.itemTypeId,
    itemId: filters.itemId,
    hodId: filters.hodId,
  };

  const {
    data: stockData,
    isLoading: stockLoading,
  } = useQuery({
    queryKey: ['inventory-stock', stockParams],
    queryFn: () => api.getWithMeta<StockRow[], PageMeta>(`/inventory/stock${qs(stockParams)}`),
    enabled: currentTab === 'stock',
  });

  const indentParams = {
    page: filters.page ?? indentPage,
    pageSize: filters.pageSize ?? indentPageSize,
    search: (filters.search as string) || indentSearch || undefined,
    status: indentStatusFilter || undefined,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    itemId: filters.itemId,
    hodId: filters.hodId,
  };

  const {
    data: autoIndentData,
    isLoading: autoIndentLoading,
  } = useQuery({
    queryKey: ['auto-indents', indentParams],
    queryFn: () => api.getWithMeta<AutoIndentRow[], PageMeta>(`/inventory/auto-indents${qs(indentParams)}`),
    enabled: currentTab === 'auto-indent',
  });

  const { data: autoIndentStats } = useQuery({
    queryKey: ['auto-indents-stats'],
    queryFn: () => api.get<AutoIndentStats>('/inventory/auto-indents/stats'),
  });

  /* ── Mutations ─────────────────────────────────────────────────────────── */
  const generateMutation = useMutation({
    mutationFn: () => api.post<{ candidates: number; generated: number; message: string }>('/inventory/auto-indent/generate'),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
      setTab('auto-indent');
    },
    onError: (err) => toast.fromError(err, 'Failed to scan inventory for auto-indent'),
  });

  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/inventory/auto-indents/${id}/approve`, {}),
    onSuccess: () => {
      toast.success('Auto indent approved successfully.');
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to approve auto indent'),
  });

  const rejectMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api.post(`/inventory/auto-indents/${id}/reject`, { reason }),
    onSuccess: () => {
      toast.success('Auto indent suggestion rejected.');
      setRejectingItem(null);
      setRejectionReason('');
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to reject auto indent'),
  });

  const convertMutation = useMutation({
    mutationFn: (id: number) => api.post<{ indentId: number; indentNo: string; message: string }>(`/inventory/auto-indents/${id}/convert`),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
      navigate(`/indents/${res.indentId}`);
    },
    onError: (err) => toast.fromError(err, 'Failed to convert suggestion to indent'),
  });

  const exportStockCsv = async () => {
    try {
      const q = qs({
        search: stockSearch || undefined,
        stockStatus: stockStatusFilter !== 'ALL' ? stockStatusFilter : undefined,
      });
      await downloadFile(`/inventory/stock/export${q}`, 'stock_and_reorder.csv');
      toast.success('Stock & reorder CSV downloaded successfully.');
    } catch (err) {
      toast.fromError(err, 'Failed to export CSV');
    }
  };

  /* ── Tab A Columns: Stock & Reorder ────────────────────────────────────── */
  const stockColumns: Column<StockRow>[] = [
    {
      key: 'item_code',
      header: 'Item Code',
      width: '120px',
      render: (r) => <span className="cell-code font-medium">{r.item_code}</span>,
    },
    {
      key: 'item_description',
      header: 'Item Name & Category',
      render: (r) => (
        <div>
          <div className="cell-strong">{r.item_description}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
            {[r.main_group_name, r.item_type_name].filter(Boolean).join(' • ')}
          </div>
        </div>
      ),
    },
    {
      key: 'cost_centre',
      header: 'Cost Centre / Dept',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div>{r.cost_centre_name || '—'}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>{r.department_name}</div>
        </div>
      ),
    },
    {
      key: 'uom',
      header: 'UOM',
      align: 'center',
      width: '80px',
      render: (r) => <Badge tone="neutral" plain>{toShortUom(r.uom_code)}</Badge>,
    },
    {
      key: 'available_stock',
      header: 'Usable Stock',
      align: 'right',
      render: (r) => (
        <div>
          <div className="num cell-strong" style={{ color: Number(r.available_stock_qty) <= 0 ? 'var(--danger-600)' : 'inherit' }}>
            {qty(r.available_stock_qty)}
          </div>
          {Number(r.allocated_stock_qty) > 0 && (
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning-600)' }}>
              {qty(r.allocated_stock_qty)} alloc
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'reorder_level',
      header: 'Reorder Level',
      align: 'right',
      render: (r) => <span className="num">{qty(r.reorder_level)}</span>,
    },
    {
      key: 'min_stock',
      header: 'Min / Max',
      align: 'right',
      render: (r) => (
        <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
          <div>{qty(r.min_stock)} min</div>
          {r.max_stock && <div style={{ color: 'var(--text-faint)' }}>{qty(r.max_stock)} max</div>}
        </div>
      ),
    },
    {
      key: 'pipeline',
      header: 'In Pipeline',
      align: 'right',
      render: (r) => {
        const ind = Number(r.pending_indent_qty);
        const po = Number(r.pending_po_qty);
        if (ind === 0 && po === 0) return <span className="cell-muted">—</span>;
        return (
          <div className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--brand-600)' }}>
            {ind > 0 && <div>{qty(ind)} Indent</div>}
            {po > 0 && <div>{qty(po)} PO</div>}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'Stock Status',
      align: 'center',
      render: (r) => {
        if (r.stock_status === 'CRITICAL') {
          return <Badge tone="danger">Critical / Low</Badge>;
        }
        if (r.stock_status === 'BELOW_REORDER') {
          return <Badge tone="warning">Below Reorder</Badge>;
        }
        if (r.stock_status === 'EXCESS') {
          return <Badge tone="info">Excess Stock</Badge>;
        }
        return <Badge tone="success">Healthy</Badge>;
      },
    },
    {
      key: 'qc',
      header: 'QC Control',
      align: 'center',
      width: '100px',
      render: (r) =>
        r.qc_required ? (
          <Badge tone="info" plain>
            <ShieldCheck size={11} style={{ marginRight: 3, verticalAlign: 'middle' }} /> QC Req
          </Badge>
        ) : (
          <span style={{ color: 'var(--text-faint)', fontSize: 'var(--text-xs)' }}>Direct</span>
        ),
    },
  ];

  /* ── Tab B Columns: Auto Indents ───────────────────────────────────────── */
  const indentColumns: Column<AutoIndentRow>[] = [
    {
      key: 'item_code',
      header: 'Item',
      render: (r) => (
        <div>
          <span className="cell-code font-medium">{r.item_code}</span>
          <div className="cell-strong">{r.item_name}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
            {[r.department_name, r.cost_centre_name].filter(Boolean).join(' • ')}
          </div>
        </div>
      ),
    },
    {
      key: 'reason',
      header: 'Trigger Reason',
      render: (r) => <span className="cell-muted">{r.reason}</span>,
    },
    {
      key: 'eligible_stock',
      header: 'Live Stock',
      align: 'right',
      render: (r) => (
        <div className="num">
          <div style={{ color: Number(r.eligible_stock) <= 0 ? 'var(--danger-600)' : 'inherit', fontWeight: 600 }}>
            {qty(r.eligible_stock)} {toShortUom(r.uom_code)}
          </div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
            Reorder: {qty(r.reorder_level)}
          </div>
        </div>
      ),
    },
    {
      key: 'suggested_qty',
      header: 'Suggested Qty',
      align: 'right',
      render: (r) => (
        <span className="num cell-strong" style={{ fontSize: 'var(--text-md)', color: 'var(--brand-700)' }}>
          {qty(r.suggested_qty)} <span style={{ fontSize: 'var(--text-xs)' }}>{toShortUom(r.uom_code)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      header: 'Approval Stage',
      align: 'center',
      render: (r) => {
        if (r.status === 'CONVERTED') {
          return (
            <Link to={`/indents/${r.generated_indent_id}`} className="row" style={{ gap: 4, textDecoration: 'none' }}>
              <Badge tone="success">
                <CheckCircle2 size={11} style={{ marginRight: 3 }} /> Converted
              </Badge>
            </Link>
          );
        }
        return <StatusBadge status={r.status} />;
      },
    },
    {
      key: 'approver',
      header: 'Decision Info',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          {r.approver_name ? (
            <div>
              <span className="cell-strong">{r.approver_name}</span>
              {r.approved_at && <div className="cell-muted">{formatDateTime(r.approved_at)}</div>}
            </div>
          ) : (
            <span className="cell-muted">Awaiting review</span>
          )}
          {r.rejection_reason && (
            <div style={{ color: 'var(--danger-600)', marginTop: 2 }}>{r.rejection_reason}</div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      locked: true,
      render: (r) => {
        if (r.status === 'CONVERTED') {
          return (
            <Link to={`/indents/${r.generated_indent_id}`}>
              <Button variant="ghost" size="sm" icon={<FileText size={13} />}>
                View Indent
              </Button>
            </Link>
          );
        }

        if (r.status === 'REJECTED') {
          return <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>Closed</span>;
        }

        const canApprove = can('auto_indent.approve');
        const canConvert = can('indent.create');
        const isApproved = r.status === 'APPROVED' || r.status === 'PURCHASE_APPROVED';

        return (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {canApprove && !isApproved && (
              <Button
                variant="success"
                size="sm"
                icon={<CheckCircle2 size={13} />}
                loading={approveMutation.isPending}
                onClick={() => approveMutation.mutate(r.id)}
              >
                Approve
              </Button>
            )}

            {canApprove && (
              <Button
                variant="danger"
                size="sm"
                icon={<XCircle size={13} />}
                onClick={() => {
                  setRejectingItem(r);
                  setRejectionReason('');
                }}
              >
                Reject
              </Button>
            )}

            {canConvert && isApproved && (
              <Button
                variant="primary"
                size="sm"
                icon={<ArrowRight size={13} />}
                loading={convertMutation.isPending}
                onClick={() => convertMutation.mutate(r.id)}
              >
                Create Indent
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const stockRows = stockData?.data ?? [];
  const indentRows = autoIndentData?.data ?? [];

  return (
    <>
      <PageHeader
        title="Inventory & Stock Replenishment"
        subtitle="Live stock monitoring, reorder point alerts, and automated indent suggestions"
        breadcrumbs={[
          { label: 'Inventory', to: '/inventory' },
          { label: currentTab === 'stock' ? 'Stock & Reorder Status' : 'Auto Indent Queue' },
        ]}
        actions={
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            {currentTab === 'stock' && (
              <Button
                variant="secondary"
                size="sm"
                icon={<Download size={14} />}
                onClick={() => void exportStockCsv()}
              >
                Export CSV
              </Button>
            )}

            {can('auto_indent.config') && (
              <Button
                variant="primary"
                size="sm"
                icon={<Zap size={14} />}
                loading={generateMutation.isPending}
                onClick={() => generateMutation.mutate()}
              >
                Run Stock Scan
              </Button>
            )}
          </div>
        }
      />

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Tabs
          tabs={[
            { key: 'stock', label: 'Stock & Reorder Status', icon: <Boxes size={16} /> },
            {
              key: 'auto-indent',
              label: 'Auto Indent Suggestions',
              icon: <Zap size={16} />,
              count: autoIndentStats?.pending ?? undefined,
            },
          ]}
          active={currentTab}
          onChange={setTab}
        />
      </div>

      {currentTab === 'stock' && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            <StatTile label="Total Active Items" value={count(stockData?.meta?.total ?? 0)} />
            <StatTile
              label="Below Reorder / Low"
              value={count(
                stockRows.filter((r: StockRow) => r.stock_status === 'BELOW_REORDER' || r.stock_status === 'CRITICAL').length,
              )}
              tone="warning"
            />
            <StatTile
              label="Zero / Critical Stock"
              value={count(stockRows.filter((r: StockRow) => r.stock_status === 'CRITICAL').length)}
              tone="danger"
            />
            <StatTile
              label="Excess Stock Items"
              value={count(stockRows.filter((r: StockRow) => r.stock_status === 'EXCESS').length)}
              tone="info"
            />
          </div>

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              clearFilters={clearFilters}
              activeCount={activeCount}
              show={['department', 'costCentre', 'hod', 'item', 'mainGroup', 'itemType']}
            />
          </div>

          <Card>
            <CardHeader
              title="Stock Levels & Reorder Triggers"
              subtitle="Derived from live store receipts, issued requisitions, and active PO pipeline"
              actions={
                <div className="row" style={{ gap: 'var(--sp-2)' }}>
                  <Select
                    value={stockStatusFilter}
                    onChange={(e) => {
                      setStockStatusFilter(e.target.value);
                      setStockPage(1);
                    }}
                    style={{ width: 170 }}
                  >
                    <option value="ALL">All Stock Levels</option>
                    <option value="CRITICAL">Critical / Zero Stock</option>
                    <option value="BELOW_REORDER">Below Reorder Level</option>
                    <option value="NORMAL">Healthy Stock</option>
                    <option value="EXCESS">Excess Stock</option>
                  </Select>
                </div>
              }
            />
            <CardBody flush>
              <DataTable
                columns={stockColumns}
                rows={stockRows}
                rowKey={(r) => r.item_id}
                loading={stockLoading}
                search={stockSearch}
                onSearchChange={(s) => {
                  setStockSearch(s);
                  setStockPage(1);
                }}
                searchPlaceholder="Search item code, description, HSN…"
                meta={stockData?.meta}
                onPageChange={setStockPage}
                onPageSizeChange={setStockPageSize}
                emptyTitle="No items match your stock filter"
                emptyMessage="All items are currently within normal stock thresholds or no records match your search."
              />
            </CardBody>
          </Card>
        </>
      )}

      {currentTab === 'auto-indent' && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            <StatTile label="Total Generated" value={count(autoIndentStats?.total ?? 0)} />
            <StatTile label="Pending Review" value={count(autoIndentStats?.pending ?? 0)} tone="warning" />
            <StatTile label="Store Approved" value={count(autoIndentStats?.storeApproved ?? 0)} tone="info" />
            <StatTile label="Ready for Purchase" value={count(autoIndentStats?.approved ?? 0)} tone="success" />
            <StatTile label="Converted to Indent" value={count(autoIndentStats?.converted ?? 0)} tone="default" />
          </div>

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              clearFilters={clearFilters}
              activeCount={activeCount}
              show={['department', 'costCentre', 'hod', 'item']}
            />
          </div>

          <Card>
            <CardHeader
              title="Auto Indent Queue"
              subtitle="Automatically computed suggestions awaiting verification and conversion to Purchase Indents"
              actions={
                <Select
                  value={indentStatusFilter}
                  onChange={(e) => {
                    setIndentStatusFilter(e.target.value);
                    setIndentPage(1);
                  }}
                  style={{ width: 180 }}
                >
                  <option value="">All Statuses</option>
                  <option value="PENDING_APPROVAL">Pending Approval</option>
                  <option value="STORE_APPROVED">Store Approved</option>
                  <option value="PURCHASE_APPROVED,APPROVED">Purchase Approved</option>
                  <option value="CONVERTED">Converted to Indent</option>
                  <option value="REJECTED">Rejected</option>
                </Select>
              }
            />
            <CardBody flush>
              <DataTable
                columns={indentColumns}
                rows={indentRows}
                rowKey={(r) => r.id}
                loading={autoIndentLoading}
                search={indentSearch}
                onSearchChange={(s) => {
                  setIndentSearch(s);
                  setIndentPage(1);
                }}
                searchPlaceholder="Search suggested item code, name, department…"
                meta={autoIndentData?.meta}
                onPageChange={setIndentPage}
                onPageSizeChange={setIndentPageSize}
                emptyTitle="No auto indent suggestions in queue"
                emptyMessage="Click 'Run Stock Scan' to evaluate live inventory and generate indents for low items."
              />
            </CardBody>
          </Card>
        </>
      )}

      {/* ── Rejection Modal ──────────────────────────────────────────────── */}
      <Modal
        open={Boolean(rejectingItem)}
        onClose={() => setRejectingItem(null)}
        title="Reject Auto Indent Suggestion"
        subtitle={`Item: ${rejectingItem?.item_code} — ${rejectingItem?.item_name}`}
        size="sm"
        footer={
          <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setRejectingItem(null)}>
              Cancel
            </Button>
            <Button
              variant="danger"
              disabled={!rejectionReason.trim()}
              loading={rejectMutation.isPending}
              onClick={() => {
                if (rejectingItem) {
                  rejectMutation.mutate({ id: rejectingItem.id, reason: rejectionReason });
                }
              }}
            >
              Confirm Rejection
            </Button>
          </div>
        }
      >
        <Field label="Rejection Reason" required error={!rejectionReason.trim() ? 'Reason is required.' : undefined}>
          <Textarea
            value={rejectionReason}
            onChange={(e) => setRejectionReason(e.target.value)}
            placeholder="Explain why this replenishment suggestion is rejected (e.g. obsolete item, alternative available, phased out)…"
            rows={3}
            autoFocus
          />
        </Field>
      </Modal>
    </>
  );
}
