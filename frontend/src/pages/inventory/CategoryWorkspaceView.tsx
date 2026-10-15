import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, ArrowUpRight, ArrowDownLeft, Scale, Database
} from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, Badge,
  Modal, Field, Textarea, Select, Input
} from '../../components/ui';
import { qty, formatDate, count, money, moneyCompact, toShortUom } from '../../lib/format';

export type InventoryCategoryKey = 'RM' | 'FG' | 'WIP' | 'TRADING' | 'GENERAL';

interface CategoryItemRow {
  id: number;
  item_id: number;
  item_code: string;
  item_description: string;
  category: InventoryCategoryKey;
  primary_uom: string;
  secondary_uom: string | null;
  conversion_factor: string;
  weight_per_1000pc_kg: string;
  opening_stock_qty: string;
  opening_weight_kg: string;
  live_stock_qty: string;
  live_weight_kg: string;
  allocated_qty: string;
  available_qty: string;
  qc_hold_qty: string;
  min_stock_level: string;
  reorder_point: string;
  rack_id: string | null;
  main_group: string | null;
  unit_price: string;
  stock_valuation: string;
  source_spreadsheet_id: string | null;
  source_tab: string | null;
  source_row_index: number | null;
  last_sync_at: string | null;
  stock_status: 'NORMAL' | 'BELOW_REORDER' | 'CRITICAL' | 'EXCESS';
}

interface CategorySummary {
  category: string;
  stats: {
    totalItems: number;
    totalStockQty: number;
    totalWeightKg: number;
    totalWeightTon: number;
    totalValuation: number;
    valuationLakhs: number;
    valuationCr: number;
    criticalCount: number;
    belowReorderCount: number;
    reservedItemsCount: number;
    totalAllocatedQty: number;
    lastSyncAt: string | null;
  };
  lastSync: {
    id: number;
    category: string;
    spreadsheet_id: string;
    tab_name: string;
    total_rows_read: number;
    valid_records_imported: number;
    quarantined_records: number;
    status: string;
    error_message: string | null;
    sync_duration_ms: number;
    created_at: string;
  } | null;
}

interface Props {
  category: InventoryCategoryKey;
  onOpenAdjustment?: (item: {
    id: number;
    code: string;
    description: string;
    category: string;
    currentStock: number;
    uom: string;
  }) => void;
}

const CATEGORY_META: Record<InventoryCategoryKey, {
  title: string;
  subtitle: string;
  tone: 'info' | 'success' | 'warning' | 'neutral';
  accentColor: string;
}> = {
  RM: {
    title: 'Raw Material Workspace (RM)',
    subtitle: 'Dual-unit tracking (Ton & Kg), Copper/Aluminium breakdown, and authoritative live sync from Raw Material Google Sheet',
    tone: 'info',
    accentColor: 'var(--brand-700)',
  },
  FG: {
    title: 'Finished Goods Workspace (FG)',
    subtitle: 'Customer & series inventory, dual-unit tracking (Nos & Weight), allocation balances, and authoritative live sync from FG Google Sheet',
    tone: 'success',
    accentColor: 'var(--success-700)',
  },
  WIP: {
    title: 'Work in Progress Workspace (WIP)',
    subtitle: 'Shop-floor processing stages (Sheet Metal, Plating, Assembly), intermediate weights, and authoritative live sync from WIP Google Sheet',
    tone: 'neutral',
    accentColor: 'var(--neutral-700)',
  },
  TRADING: {
    title: 'Trading Materials Workspace',
    subtitle: 'Resale goods, pack types, purchase rate valuation, and authoritative live sync from Trading Google Sheet',
    tone: 'warning',
    accentColor: 'var(--warning-700)',
  },
  GENERAL: {
    title: 'General Stores & Spares Workspace',
    subtitle: 'Packaging (Bag, Box), Hardware, Safety, Electrical & Consumables inventory with bin locations and authoritative live sync from General Google Sheet',
    tone: 'neutral',
    accentColor: 'var(--neutral-800)',
  },
};

export function CategoryWorkspaceView({ category, onOpenAdjustment }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const meta = CATEGORY_META[category];

  // Filters & Pagination
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('ALL');

  // Movement Modal
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [moveItem, setMoveItem] = useState<CategoryItemRow | null>(null);
  const [moveDirection, setMoveDirection] = useState<'IN' | 'OUT' | 'ADJUST'>('IN');
  const [moveTxnType, setMoveTxnType] = useState('GRN_INWARD');
  const [moveQty, setMoveQty] = useState('');
  const [moveWeightKg, setMoveWeightKg] = useState('');
  const [moveRate, setMoveRate] = useState('');
  const [moveLocation, setMoveLocation] = useState('');
  const [moveDepartment, setMoveDepartment] = useState('');
  const [moveNotes, setMoveNotes] = useState('');

  // 1. Fetch Summary
  const { data: summaryData } = useQuery({
    queryKey: ['inventory-category-summary', category],
    queryFn: () => api.get<CategorySummary>(`/inventory/categories/${category}/summary`),
    refetchInterval: 60000,
  });

  // 2. Fetch Category Items
  const queryParams = {
    page,
    pageSize,
    search: search || undefined,
    status: statusFilter !== 'ALL' ? statusFilter : undefined,
  };

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['inventory-category-items', category, queryParams],
    queryFn: () => api.getWithMeta<CategoryItemRow[], PageMeta>(`/inventory/categories/${category}${qs(queryParams)}`),
  });

  // 3. Live Google Sheet Sync Mutation
  const syncMutation = useMutation({
    mutationFn: () => api.post<{
      category: string;
      spreadsheetId: string;
      tabName: string;
      totalRowsRead: number;
      validRecordsImported: number;
      quarantinedRecords: number;
      status: string;
      durationMs: number;
    }>(`/inventory/sync/${category}`),
    onSuccess: (res) => {
      toast.success(
        `Sync completed for ${category}: ${count(res.validRecordsImported)} valid records imported, ${count(res.quarantinedRecords)} quarantined (${(res.durationMs / 1000).toFixed(1)}s)`
      );
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => toast.fromError(err, `Failed to sync ${category} from Google Sheet`),
  });

  // 4. Movement Mutation
  const movementMutation = useMutation({
    mutationFn: (payload: {
      itemId: number;
      txnType: string;
      direction: 'IN' | 'OUT' | 'ADJUST';
      quantity: number;
      weightKg?: number;
      uom: string;
      rate?: number;
      amount?: number;
      fromLocation?: string;
      toLocation?: string;
      department?: string;
      notes?: string;
    }) => api.post(`/inventory/categories/${category}/transactions`, payload),
    onSuccess: (res: any) => {
      toast.success(res.message || 'Movement recorded successfully');
      setIsMoveModalOpen(false);
      setMoveItem(null);
      setMoveQty('');
      setMoveWeightKg('');
      setMoveNotes('');
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
      void qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to record stock movement'),
  });

  const openMoveModal = (item: CategoryItemRow, defaultDirection: 'IN' | 'OUT' = 'IN') => {
    setMoveItem(item);
    setMoveDirection(defaultDirection);
    setMoveTxnType(defaultDirection === 'IN' ? 'GRN_INWARD' : 'DIRECT_ISSUE');
    setMoveQty('');
    setMoveWeightKg('');
    setMoveRate(item.unit_price || '');
    setMoveLocation(item.rack_id || '');
    setMoveDepartment('');
    setMoveNotes('');
    setIsMoveModalOpen(true);
  };

  const handlePostMovement = (e: React.FormEvent) => {
    e.preventDefault();
    if (!moveItem) return;
    const qNum = Number(moveQty);
    if (isNaN(qNum) || qNum <= 0) {
      toast.error('Please enter a valid positive quantity');
      return;
    }

    const currentLive = Number(moveItem.live_stock_qty || 0);
    if (moveDirection === 'OUT' && qNum > currentLive) {
      toast.error(`Insufficient stock! Cannot issue ${qNum} ${moveItem.primary_uom} (current stock: ${currentLive})`);
      return;
    }

    const wNum = moveWeightKg ? Number(moveWeightKg) : undefined;
    const rNum = moveRate ? Number(moveRate) : undefined;
    const amount = rNum !== undefined ? qNum * rNum : undefined;

    movementMutation.mutate({
      itemId: moveItem.item_id,
      txnType: moveTxnType,
      direction: moveDirection,
      quantity: qNum,
      weightKg: wNum,
      uom: moveItem.primary_uom || 'Nos',
      rate: rNum,
      amount,
      toLocation: moveDirection === 'IN' ? moveLocation : undefined,
      fromLocation: moveDirection === 'OUT' ? moveLocation : undefined,
      department: moveDepartment || undefined,
      notes: moveNotes || undefined,
    });
  };

  // Columns definition tailored to category
  const columns = useMemo<Column<CategoryItemRow>[]>(() => {
    const cols: Column<CategoryItemRow>[] = [
      {
        key: 'item_code',
        header: 'Item Code',
        width: '120px',
        render: (r) => <span className="cell-code font-medium">{r.item_code}</span>,
      },
      {
        key: 'item_description',
        header: 'Description & Main Group',
        render: (r) => (
          <div>
            <div className="cell-strong">{r.item_description}</div>
            <div className="row" style={{ gap: 6, marginTop: 2, alignItems: 'center' }}>
              {r.main_group && (
                <Badge tone="neutral" plain>
                  {r.main_group}
                </Badge>
              )}
              {r.rack_id && (
                <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
                  Rack/Bin: <strong>{r.rack_id}</strong>
                </span>
              )}
              {r.source_tab && (
                <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                  Sheet: {r.source_tab}
                </span>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'uom',
        header: 'UOM',
        align: 'center',
        width: '70px',
        render: (r) => <Badge tone="neutral" plain>{toShortUom(r.primary_uom)}</Badge>,
      },
    ];

    // If RM or FG or WIP, add weight column
    if (category === 'RM' || category === 'FG' || category === 'WIP') {
      cols.push({
        key: 'live_weight',
        header: category === 'RM' ? 'Live Weight (Kg / Ton)' : 'Weight (Kg)',
        align: 'right',
        render: (r) => {
          const kg = Number(r.live_weight_kg || 0);
          const ton = (kg / 1000).toFixed(3);
          return (
            <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
              <div>{qty(kg)} Kg</div>
              <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>{ton} Ton</div>
            </div>
          );
        },
      });
    }

    cols.push(
      {
        key: 'live_stock',
        header: 'Physical Stock',
        align: 'right',
        render: (r) => {
          const live = Number(r.live_stock_qty || 0);
          return (
            <div className="num cell-strong" style={{ color: live <= 0 ? 'var(--danger-600)' : 'inherit' }}>
              {qty(live)} {toShortUom(r.primary_uom)}
            </div>
          );
        },
      },
      {
        key: 'available_stock',
        header: 'Available Stock',
        align: 'right',
        render: (r) => {
          const avail = Number(r.available_qty || 0);
          const alloc = Number(r.allocated_qty || 0);
          return (
            <div>
              <div className="num cell-strong" style={{ color: avail <= 0 ? 'var(--danger-600)' : 'var(--success-700)' }}>
                {qty(avail)}
              </div>
              {alloc > 0 && (
                <div style={{ fontSize: '10px', color: 'var(--warning-600)' }}>
                  {qty(alloc)} rsvd
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: 'thresholds',
        header: 'Min / Reorder',
        align: 'right',
        render: (r) => {
          const min = Number(r.min_stock_level || 0);
          const reorder = Number(r.reorder_point || 0);
          if (min === 0 && reorder === 0) return <span className="cell-muted">—</span>;
          return (
            <div className="num" style={{ fontSize: '11px' }}>
              {min > 0 && <div>Min: {qty(min)}</div>}
              {reorder > 0 && <div style={{ color: 'var(--brand-600)' }}>ROP: {qty(reorder)}</div>}
            </div>
          );
        },
      },
      {
        key: 'valuation',
        header: 'Rate & Value',
        align: 'right',
        render: (r) => {
          const rate = Number(r.unit_price || 0);
          const val = Number(r.stock_valuation || 0);
          return (
            <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
              <div>{money(val)}</div>
              {rate > 0 && (
                <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>
                  @{money(rate)}
                </div>
              )}
            </div>
          );
        },
      },
      {
        key: 'status',
        header: 'Status',
        align: 'center',
        render: (r) => {
          const tone =
            r.stock_status === 'CRITICAL' ? 'danger'
            : r.stock_status === 'BELOW_REORDER' ? 'warning'
            : r.stock_status === 'EXCESS' ? 'info'
            : 'success';
          return <Badge tone={tone}>{r.stock_status.replace('_', ' ')}</Badge>;
        },
      },
      {
        key: 'actions',
        header: 'Actions',
        align: 'right',
        locked: true,
        render: (r) => (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {can('inventory.adjust') && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowUpRight size={12} />}
                  title="Receive Stock"
                  onClick={() => openMoveModal(r, 'IN')}
                >
                  Receive
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowDownLeft size={12} />}
                  title="Issue Stock"
                  onClick={() => openMoveModal(r, 'OUT')}
                >
                  Issue
                </Button>
              </>
            )}
            {onOpenAdjustment && can('inventory.adjust') && (
              <Button
                variant="ghost"
                size="sm"
                icon={<Scale size={12} />}
                title="Physical Count Adjustment"
                onClick={() =>
                  onOpenAdjustment({
                    id: r.item_id,
                    code: r.item_code,
                    description: r.item_description,
                    category: r.category,
                    currentStock: Number(r.live_stock_qty || 0),
                    uom: r.primary_uom,
                  })
                }
              >
                Adjust
              </Button>
            )}
          </div>
        ),
      }
    );

    return cols;
  }, [category, can, onOpenAdjustment]);

  const stats = summaryData?.stats;
  const lastSync = summaryData?.lastSync;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
      {/* Workspace Header Banner */}
      <Card>
        <CardBody style={{ padding: 'var(--sp-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sp-3)' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: meta.accentColor }}>
                  {meta.title}
                </span>
                <Badge tone={meta.tone}>{category}</Badge>
                {lastSync && (
                  <Badge tone={lastSync.status === 'SUCCESS' ? 'success' : 'danger'}>
                    <Database size={11} style={{ marginRight: 4 }} />
                    Sheet Synced: {formatDate(lastSync.created_at)}
                  </Badge>
                )}
              </div>
              <p style={{ margin: '4px 0 0', color: 'var(--text-muted)', fontSize: 'var(--text-xs)' }}>
                {meta.subtitle}
              </p>
            </div>

            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              {can('inventory.adjust') && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<RefreshCw size={14} className={syncMutation.isPending ? 'spin' : ''} />}
                  loading={syncMutation.isPending}
                  onClick={() => syncMutation.mutate()}
                >
                  Live Sync from Google Sheet
                </Button>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Category Metric Cards */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
          gap: 'var(--sp-3)',
        }}
      >
        <StatTile
          label="Total Items Mastered"
          value={count(stats?.totalItems ?? itemsData?.meta?.total ?? 0)}
          sub="Reconciled with dedicated DB"
        />

        {category === 'RM' && (
          <StatTile
            label="Total Raw Material Weight"
            value={`${qty(stats?.totalWeightTon ?? 0)} Ton`}
            sub={`${qty(stats?.totalStockQty ?? 0)} Kg physical stock`}
            tone="info"
          />
        )}

        {category === 'FG' && (
          <StatTile
            label="Total FG Finished Quantity"
            value={`${count(stats?.totalStockQty ?? 0)} Nos`}
            sub={`${qty(stats?.totalWeightTon ?? 0)} Ton aggregate weight`}
            tone="success"
          />
        )}

        {category === 'WIP' && (
          <StatTile
            label="Total WIP Stages Quantity"
            value={`${qty(stats?.totalStockQty ?? 0)} Units`}
            sub={`${qty(stats?.totalWeightTon ?? 0)} Ton in shop-floor processes`}
            tone="default"
          />
        )}

        {(category === 'TRADING' || category === 'GENERAL') && (
          <StatTile
            label="Total Stock Quantity"
            value={count(stats?.totalStockQty ?? 0)}
            sub="Physical on-hand units"
            tone="default"
          />
        )}

        <StatTile
          label="Inventory Valuation"
          value={moneyCompact(stats?.totalValuation ?? 0)}
          sub={`Exact: ${money(stats?.totalValuation ?? 0)} (₹${stats?.valuationLakhs ?? 0}L)`}
          tone="default"
        />

        <StatTile
          label="Critical / Zero Stock"
          value={count(stats?.criticalCount ?? 0)}
          tone={stats?.criticalCount ? 'danger' : 'success'}
          sub="Items requiring urgent action"
        />

        <StatTile
          label="Below Reorder Point"
          value={count(stats?.belowReorderCount ?? 0)}
          tone={stats?.belowReorderCount ? 'warning' : 'success'}
          sub="Reorder threshold reached"
        />
      </div>

      {/* Filter and Search Bar */}
      <Card>
        <CardBody style={{ padding: 'var(--sp-3)' }}>
          <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ flex: '1 1 250px', position: 'relative' }}>
              <Input
                placeholder={`Search ${category} by code, description, rack, main group...`}
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  setPage(1);
                }}
              />
            </div>

            <div style={{ width: '180px' }}>
              <Select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value);
                  setPage(1);
                }}
              >
                <option value="ALL">All Stock Statuses</option>
                <option value="NORMAL">Normal / Healthy</option>
                <option value="BELOW_REORDER">Below Reorder Level</option>
                <option value="CRITICAL">Critical / Zero Stock</option>
                <option value="EXCESS">Excess Inventory</option>
              </Select>
            </div>

            {(search || statusFilter !== 'ALL') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setSearch('');
                  setStatusFilter('ALL');
                  setPage(1);
                }}
              >
                Clear Filters
              </Button>
            )}

            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Showing <strong>{count(itemsData?.data?.length ?? 0)}</strong> of <strong>{count(itemsData?.meta?.total ?? 0)}</strong> items
              </span>
            </div>
          </div>
        </CardBody>
      </Card>

      {/* Main Category Register Table */}
      <Card>
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={itemsData?.data || []}
            rowKey={(r) => r.id}
            loading={itemsLoading}
            meta={itemsData?.meta}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            emptyTitle={`No items found in ${category} inventory workspace`}
            emptyMessage="Ensure Google Sheets have been synced and items are categorized correctly."
          />
        </CardBody>
      </Card>

      {/* Quick Post Movement Modal */}
      {isMoveModalOpen && moveItem && (
        <Modal
          title={`Record Stock Movement — ${moveItem.item_code}`}
          subtitle={`${moveItem.item_description} (${category})`}
          open={isMoveModalOpen}
          onClose={() => setIsMoveModalOpen(false)}
        >
          <form onSubmit={handlePostMovement} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label="Movement Direction" required>
                <Select
                  value={moveDirection}
                  onChange={(e) => {
                    const dir = e.target.value as 'IN' | 'OUT';
                    setMoveDirection(dir);
                    setMoveTxnType(dir === 'IN' ? 'GRN_INWARD' : 'DIRECT_ISSUE');
                  }}
                >
                  <option value="IN">Inward (Receipt into Store)</option>
                  <option value="OUT">Outward (Issue from Store)</option>
                </Select>
              </Field>

              <Field label="Transaction Type" required>
                <Select value={moveTxnType} onChange={(e) => setMoveTxnType(e.target.value)}>
                  {moveDirection === 'IN' ? (
                    <>
                      <option value="GRN_INWARD">GRN Inward Receipt</option>
                      <option value="STOCK_ADJUSTMENT">Stock Return / Found</option>
                      <option value="DIRECT_INWARD">Direct Supplier Inward</option>
                    </>
                  ) : (
                    <>
                      <option value="DIRECT_ISSUE">Direct Store Issue</option>
                      <option value="REQUISITION_ISSUE">Requisition Issue</option>
                      <option value="STOCK_ADJUSTMENT">Scrap / Breakage Outward</option>
                    </>
                  )}
                </Select>
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label={`Quantity (${moveItem.primary_uom})`} required>
                <Input
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  placeholder="e.g. 50"
                  value={moveQty}
                  onChange={(e) => setMoveQty(e.target.value)}
                  autoFocus
                />
              </Field>

              {(category === 'RM' || category === 'FG' || category === 'WIP') && (
                <Field label="Weight (Kg)">
                  <Input
                    type="number"
                    step="0.001"
                    placeholder="e.g. 125.5"
                    value={moveWeightKg}
                    onChange={(e) => setMoveWeightKg(e.target.value)}
                  />
                </Field>
              )}

              <Field label="Rate (₹ per UOM)">
                <Input
                  type="number"
                  step="0.01"
                  placeholder="e.g. 450"
                  value={moveRate}
                  onChange={(e) => setMoveRate(e.target.value)}
                />
              </Field>

              <Field label="Storage Location / Bin">
                <Input
                  placeholder="e.g. RACK-A-12"
                  value={moveLocation}
                  onChange={(e) => setMoveLocation(e.target.value)}
                />
              </Field>
            </div>

            {moveDirection === 'OUT' && (
              <Field label="Issued To Department">
                <Input
                  placeholder="e.g. Assembly / Sheet Metal / Tool Room"
                  value={moveDepartment}
                  onChange={(e) => setMoveDepartment(e.target.value)}
                />
              </Field>
            )}

            <Field label="Notes / Reference Document">
              <Textarea
                placeholder="Reason or reference order/job card..."
                value={moveNotes}
                onChange={(e) => setMoveNotes(e.target.value)}
                rows={2}
              />
            </Field>

            <div
              style={{
                padding: 'var(--sp-2) var(--sp-3)',
                borderRadius: 'var(--radius-sm)',
                backgroundColor: 'var(--surface-muted)',
                fontSize: 'var(--text-xs)',
              }}
            >
              Current live stock: <strong>{qty(moveItem.live_stock_qty)} {moveItem.primary_uom}</strong>.
              {moveDirection === 'OUT' && (
                <span style={{ color: 'var(--danger-700)', marginLeft: 6 }}>
                  Strict guard active: Insufficient stock will be rejected with 409 Conflict.
                </span>
              )}
            </div>

            <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
              <Button variant="secondary" onClick={() => setIsMoveModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant={moveDirection === 'IN' ? 'primary' : 'danger'}
                type="submit"
                loading={movementMutation.isPending}
              >
                Record {moveDirection === 'IN' ? 'Receipt' : 'Issue'}
              </Button>
            </div>
          </form>
        </Modal>
      )}
    </div>
  );
}
