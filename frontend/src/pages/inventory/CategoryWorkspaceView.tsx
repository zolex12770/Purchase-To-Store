import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Plus, Minus, ArrowUpRight, ArrowDownLeft, Scale,
  Database, FileSpreadsheet
} from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Card, CardBody, Badge,
  Modal, Field, Textarea, Select, Input
} from '../../components/ui';
import { qty, formatDate, formatDateTime, count, money, toShortUom } from '../../lib/format';

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

interface CategoryTxnRow {
  id: number;
  txn_no: string;
  category: InventoryCategoryKey;
  item_id: number;
  item_code: string;
  txn_type: string;
  direction: 'IN' | 'OUT' | 'ADJUST';
  quantity: string;
  weight_kg: string | null;
  uom: string;
  rate: string | null;
  amount: string | null;
  balance_qty_after: string;
  balance_weight_after: string | null;
  reference_doc_type: string | null;
  reference_doc_no: string | null;
  from_location: string | null;
  to_location: string | null;
  department: string | null;
  status: string;
  notes: string | null;
  created_by_name: string;
  txn_date: string;
  created_at: string;
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

interface SourceSubTab {
  key: string;
  label: string;
  type: 'stock' | 'inward' | 'outward' | 'prod_inward';
  sheetTabName: string;
}

const CATEGORY_CONFIG: Record<
  InventoryCategoryKey,
  {
    title: string;
    subTabs: SourceSubTab[];
  }
> = {
  RM: {
    title: 'Raw Material (RM)',
    subTabs: [
      { key: 'live_stock', label: 'RM Stock Live', type: 'stock', sheetTabName: 'RM Stock Live' },
      { key: 'grn_inward', label: 'GRN Inward', type: 'inward', sheetTabName: 'GRN Inward' },
      { key: 'rm_outward', label: 'RM Outward', type: 'outward', sheetTabName: 'RM Outward' },
      { key: 'prod_inward', label: 'Production Inward', type: 'prod_inward', sheetTabName: 'Production Inward' },
    ],
  },
  FG: {
    title: 'Finished Goods (FG)',
    subTabs: [
      { key: 'live_stock', label: 'FG Stock Live', type: 'stock', sheetTabName: 'FG  Stock Live' },
      { key: 'inward_fg', label: 'Inward FG', type: 'inward', sheetTabName: 'Inward FG ' },
      { key: 'outward_fg', label: 'Outward FG', type: 'outward', sheetTabName: 'Outward FG' },
    ],
  },
  WIP: {
    title: 'Work in Progress (WIP)',
    subTabs: [
      { key: 'live_stock', label: 'WIP Stock Live', type: 'stock', sheetTabName: 'WIP  Stock Live' },
      { key: 'inward_wip', label: 'Inward WIP', type: 'inward', sheetTabName: 'Inward WIP' },
      { key: 'outward_wip', label: 'Outward WIP', type: 'outward', sheetTabName: 'Outward WIP' },
    ],
  },
  TRADING: {
    title: 'Trading Materials',
    subTabs: [
      { key: 'live_stock', label: 'Trading Live Stock', type: 'stock', sheetTabName: 'Trading Live Stock' },
      { key: 'inward_trading', label: 'Inward Trading', type: 'inward', sheetTabName: 'Inward Trading' },
      { key: 'outward_trading', label: 'Outward Trading', type: 'outward', sheetTabName: 'Outward Trading ' },
    ],
  },
  GENERAL: {
    title: 'General Stores & Spares',
    subTabs: [
      { key: 'live_stock', label: 'General Item Live Stock', type: 'stock', sheetTabName: 'General Item Live Stock' },
      { key: 'grn_register', label: 'GRN Register (Store Inward Entry)', type: 'inward', sheetTabName: 'GRN Register (Store Inward Entry)' },
      { key: 'issue_register', label: 'Issue Register (Store Outward Entry)', type: 'outward', sheetTabName: 'Issue Register (Store Outward Entry)' },
    ],
  },
};

export function CategoryWorkspaceView({ category, onOpenAdjustment }: Props) {
  const qc = useQueryClient();
  const toast = useToast();
  const { can } = useAuth();
  const config = CATEGORY_CONFIG[category];

  // Active Sub-Tab (Defaults to first sub-tab, which is always live stock)
  const [activeSubTab, setActiveSubTab] = useState<string>(config.subTabs[0].key);

  // Filters for Live Stock
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = useState(25);
  const [stockSearch, setStockSearch] = useState('');
  const [stockStatus, setStockStatus] = useState('ALL');

  // Filters for Transactions
  const [txnPage, setTxnPage] = useState(1);
  const [txnPageSize, setTxnPageSize] = useState(25);
  const [txnSearch, setTxnSearch] = useState('');

  // Movement Modal State
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [moveItem, setMoveItem] = useState<{ id: number; code: string; desc: string; stock: number; uom: string; rate?: number } | null>(null);
  const [moveDirection, setMoveDirection] = useState<'IN' | 'OUT'>('IN');
  const [moveTxnType, setMoveTxnType] = useState('GRN_INWARD');
  const [moveQty, setMoveQty] = useState('');
  const [moveWeightKg, setMoveWeightKg] = useState('');
  const [moveRate, setMoveRate] = useState('');
  const [moveLocation, setMoveLocation] = useState('');
  const [moveDepartment, setMoveDepartment] = useState('');
  const [moveRefDoc, setMoveRefDoc] = useState('');
  const [moveNotes, setMoveNotes] = useState('');

  // Determine current active subtab definition
  const currentSubTabDef = useMemo(
    () => config.subTabs.find((t) => t.key === activeSubTab) || config.subTabs[0],
    [config.subTabs, activeSubTab]
  );

  // 1. Fetch Summary
  const { data: summaryData } = useQuery({
    queryKey: ['inventory-category-summary', category],
    queryFn: () => api.get<CategorySummary>(`/inventory/categories/${category}/summary`),
  });

  // 2. Fetch Live Stock (when type === 'stock')
  const stockParams = {
    page: stockPage,
    pageSize: stockPageSize,
    search: stockSearch || undefined,
    status: stockStatus !== 'ALL' ? stockStatus : undefined,
  };

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['inventory-category-items', category, stockParams],
    queryFn: () => api.getWithMeta<CategoryItemRow[], PageMeta>(`/inventory/categories/${category}${qs(stockParams)}`),
    enabled: currentSubTabDef.type === 'stock',
  });

  // 3. Fetch Transactions (when type !== 'stock')
  const txnParams = {
    page: txnPage,
    pageSize: txnPageSize,
    search: txnSearch || undefined,
    direction: currentSubTabDef.type === 'inward' || currentSubTabDef.type === 'prod_inward' ? 'IN' : 'OUT',
    txnType: currentSubTabDef.type === 'prod_inward' ? 'PRODUCTION_INWARD' : undefined,
  };

  const { data: txnsData, isLoading: txnsLoading } = useQuery({
    queryKey: ['inventory-category-txns', category, currentSubTabDef.key, txnParams],
    queryFn: () => api.getWithMeta<CategoryTxnRow[], PageMeta>(`/inventory/categories/${category}/transactions${qs(txnParams)}`),
    enabled: currentSubTabDef.type !== 'stock',
  });

  // 4. Live Google Sheet Sync Mutation
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
        `Synced with "${currentSubTabDef.sheetTabName}": ${count(res.validRecordsImported)} valid items updated (${(res.durationMs / 1000).toFixed(1)}s)`
      );
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-txns', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => toast.fromError(err, `Failed to sync ${category} from Google Sheet`),
  });

  // 5. Movement Mutation
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
      referenceDocNo?: string;
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
      setMoveRefDoc('');
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-txns', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to record stock movement'),
  });

  const openMoveModal = (
    item: { id: number; code: string; desc: string; stock: number; uom: string; rate?: number } | null,
    direction: 'IN' | 'OUT'
  ) => {
    setMoveItem(item);
    setMoveDirection(direction);
    setMoveTxnType(
      direction === 'IN'
        ? currentSubTabDef.type === 'prod_inward' ? 'PRODUCTION_INWARD' : 'GRN_INWARD'
        : 'DIRECT_ISSUE'
    );
    setMoveQty('');
    setMoveWeightKg('');
    setMoveRate(item?.rate ? String(item.rate) : '');
    setMoveLocation('');
    setMoveDepartment('');
    setMoveRefDoc('');
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

    if (moveDirection === 'OUT' && qNum > moveItem.stock) {
      toast.error(`Cannot issue ${qNum} ${moveItem.uom}. Available stock is only ${moveItem.stock} ${moveItem.uom}`);
      return;
    }

    const wNum = moveWeightKg ? Number(moveWeightKg) : undefined;
    const rNum = moveRate ? Number(moveRate) : undefined;
    const amount = rNum !== undefined ? qNum * rNum : undefined;

    movementMutation.mutate({
      itemId: moveItem.id,
      txnType: moveTxnType,
      direction: moveDirection,
      quantity: qNum,
      weightKg: wNum,
      uom: moveItem.uom,
      rate: rNum,
      amount,
      referenceDocNo: moveRefDoc || undefined,
      toLocation: moveDirection === 'IN' ? moveLocation : undefined,
      fromLocation: moveDirection === 'OUT' ? moveLocation : undefined,
      department: moveDepartment || undefined,
      notes: moveNotes || undefined,
    });
  };

  // Stock Columns tailored to Category Google Sheet
  const stockColumns = useMemo<Column<CategoryItemRow>[]>(() => {
    const cols: Column<CategoryItemRow>[] = [
      {
        key: 'item_code',
        header: 'Item Code',
        width: '130px',
        render: (r) => <span className="cell-code font-medium">{r.item_code}</span>,
      },
      {
        key: 'item_description',
        header: 'Item Description',
        render: (r) => (
          <div>
            <div className="cell-strong">{r.item_description}</div>
            <div className="row" style={{ gap: 6, marginTop: 2, alignItems: 'center' }}>
              {r.main_group && <Badge tone="neutral" plain>{r.main_group}</Badge>}
              {r.rack_id && (
                <span style={{ fontSize: '11px', color: 'var(--text-muted)' }}>
                  Rack: <strong>{r.rack_id}</strong>
                </span>
              )}
            </div>
          </div>
        ),
      },
      {
        key: 'primary_uom',
        header: 'UOM',
        align: 'center',
        width: '70px',
        render: (r) => <Badge tone="neutral" plain>{toShortUom(r.primary_uom)}</Badge>,
      },
    ];

    if (category === 'RM' || category === 'FG' || category === 'WIP') {
      cols.push({
        key: 'weight',
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
        key: 'live_stock_qty',
        header: 'Live Stock',
        align: 'right',
        render: (r) => {
          const q = Number(r.live_stock_qty || 0);
          return (
            <div className="num cell-strong" style={{ color: q <= 0 ? 'var(--danger-600)' : 'inherit' }}>
              {qty(q)}
            </div>
          );
        },
      },
      {
        key: 'available_qty',
        header: 'Available',
        align: 'right',
        render: (r) => {
          const avail = Number(r.available_qty || 0);
          return (
            <div className="num cell-strong" style={{ color: avail <= 0 ? 'var(--danger-600)' : 'var(--success-700)' }}>
              {qty(avail)}
            </div>
          );
        },
      },
      {
        key: 'rate_value',
        header: 'Rate & Value',
        align: 'right',
        render: (r) => {
          const rate = Number(r.unit_price || 0);
          const val = Number(r.stock_valuation || 0);
          return (
            <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
              <div>{money(val)}</div>
              {rate > 0 && <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>@{money(rate)}</div>}
            </div>
          );
        },
      },
      {
        key: 'status',
        header: 'Status',
        align: 'center',
        width: '110px',
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
                  onClick={() =>
                    openMoveModal(
                      { id: r.item_id, code: r.item_code, desc: r.item_description, stock: Number(r.live_stock_qty || 0), uom: r.primary_uom, rate: Number(r.unit_price || 0) },
                      'IN'
                    )
                  }
                >
                  Receive
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  icon={<ArrowDownLeft size={12} />}
                  title="Issue Stock"
                  onClick={() =>
                    openMoveModal(
                      { id: r.item_id, code: r.item_code, desc: r.item_description, stock: Number(r.live_stock_qty || 0), uom: r.primary_uom, rate: Number(r.unit_price || 0) },
                      'OUT'
                    )
                  }
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
                title="Physical Stock Adjustment"
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

  // Transaction Columns (Inward / Outward tabs)
  const txnColumns = useMemo<Column<CategoryTxnRow>[]>(() => {
    return [
      {
        key: 'txn_date',
        header: 'Date',
        width: '100px',
        render: (r) => <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>{formatDate(r.txn_date)}</span>,
      },
      {
        key: 'txn_no',
        header: 'Document / Txn No',
        width: '150px',
        render: (r) => (
          <div>
            <span className="cell-code font-medium">{r.txn_no}</span>
            {r.reference_doc_no && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                Ref: {r.reference_doc_no}
              </div>
            )}
          </div>
        ),
      },
      {
        key: 'item_code',
        header: 'Item Code',
        width: '120px',
        render: (r) => <span className="cell-code">{r.item_code}</span>,
      },
      {
        key: 'txn_type',
        header: 'Transaction Type',
        render: (r) => (
          <div>
            <Badge tone={r.direction === 'IN' ? 'success' : 'neutral'} plain>
              {r.txn_type.replace('_', ' ')}
            </Badge>
            {r.department && (
              <span style={{ fontSize: '11px', color: 'var(--text-muted)', marginLeft: 6 }}>
                Dept: {r.department}
              </span>
            )}
          </div>
        ),
      },
      {
        key: 'quantity',
        header: 'Quantity',
        align: 'right',
        render: (r) => (
          <div className="num cell-strong" style={{ color: r.direction === 'IN' ? 'var(--success-700)' : 'var(--danger-700)' }}>
            {r.direction === 'IN' ? '+' : '-'}{qty(r.quantity)} {toShortUom(r.uom)}
          </div>
        ),
      },
      {
        key: 'weight_kg',
        header: 'Weight (Kg)',
        align: 'right',
        render: (r) => (r.weight_kg ? <span className="num">{qty(r.weight_kg)} Kg</span> : <span className="cell-muted">—</span>),
      },
      {
        key: 'balance_qty_after',
        header: 'Balance After',
        align: 'right',
        render: (r) => <span className="num">{qty(r.balance_qty_after)}</span>,
      },
      {
        key: 'created_by_name',
        header: 'Operator',
        render: (r) => (
          <div style={{ fontSize: '11px' }}>
            <div>{r.created_by_name || 'System'}</div>
            <div style={{ color: 'var(--text-faint)' }}>{formatDateTime(r.created_at)}</div>
          </div>
        ),
      },
    ];
  }, []);

  const stats = summaryData?.stats;
  const lastSync = summaryData?.lastSync;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      {/* ── 1. Minimal Category Overview Header ────────────────────────── */}
      <Card>
        <CardBody style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Badge tone="info">{category}</Badge>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                <strong>{count(stats?.totalItems ?? itemsData?.meta?.total ?? 0)}</strong> active items
              </span>
              {(category === 'RM' || category === 'FG' || category === 'WIP') && stats?.totalWeightTon !== undefined && (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  • Total Weight: <strong style={{ color: 'var(--text)' }}>{qty(stats.totalWeightTon)} Ton</strong> ({qty(stats.totalStockQty)} Kg)
                </span>
              )}
              {stats?.totalValuation !== undefined && (
                <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  • Valuation: <strong style={{ color: 'var(--text)' }}>{money(stats.totalValuation)}</strong>
                </span>
              )}
              {lastSync && (
                <span style={{ fontSize: '11px', color: 'var(--text-faint)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Database size={12} /> Synced: {formatDate(lastSync.created_at)} ({lastSync.tab_name})
                </span>
              )}
            </div>

            <div className="row" style={{ gap: 'var(--sp-2)' }}>
              {can('inventory.adjust') && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<RefreshCw size={13} className={syncMutation.isPending ? 'spin' : ''} />}
                    loading={syncMutation.isPending}
                    onClick={() => syncMutation.mutate()}
                  >
                    Sync with Sheet
                  </Button>

                  {currentSubTabDef.type === 'stock' && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Plus size={13} />}
                      onClick={() => openMoveModal(null, 'IN')}
                    >
                      Receive Material
                    </Button>
                  )}

                  {(currentSubTabDef.type === 'inward' || currentSubTabDef.type === 'prod_inward') && (
                    <Button
                      variant="success"
                      size="sm"
                      icon={<Plus size={13} />}
                      onClick={() => openMoveModal(null, 'IN')}
                    >
                      Record Inward Receipt
                    </Button>
                  )}

                  {currentSubTabDef.type === 'outward' && (
                    <Button
                      variant="danger"
                      size="sm"
                      icon={<Minus size={13} />}
                      onClick={() => openMoveModal(null, 'OUT')}
                    >
                      Record Outward Issue
                    </Button>
                  )}
                </>
              )}
            </div>
          </div>
        </CardBody>
      </Card>

      {/* ── 2. Source-Sheet Sub-Tabs (Clean Spreadsheet Style) ──────────── */}
      <div
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '2px solid var(--border-subtle)',
          paddingLeft: 4,
          overflowX: 'auto',
        }}
      >
        {config.subTabs.map((tab) => {
          const isActive = activeSubTab === tab.key;
          return (
            <button
              key={tab.key}
              type="button"
              onClick={() => setActiveSubTab(tab.key)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 14px',
                border: 'none',
                borderBottom: isActive ? '3px solid var(--brand-600)' : '3px solid transparent',
                backgroundColor: isActive ? 'var(--surface-muted)' : 'transparent',
                color: isActive ? 'var(--brand-700)' : 'var(--text-muted)',
                fontWeight: isActive ? 600 : 500,
                fontSize: 'var(--text-xs)',
                cursor: 'pointer',
                marginBottom: -2,
                borderRadius: '4px 4px 0 0',
                transition: 'all 0.15s ease',
              }}
            >
              <FileSpreadsheet size={14} color={isActive ? 'var(--brand-600)' : 'var(--text-faint)'} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* ── 3. Sub-Tab Content ─────────────────────────────────────────── */}
      {currentSubTabDef.type === 'stock' ? (
        /* LIVE STOCK TAB */
        <Card>
          <CardBody flush>
            {/* Minimal Filter Bar */}
            <div style={{ padding: 'var(--sp-2) var(--sp-3)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px' }}>
                <Input
                  placeholder={`Search ${currentSubTabDef.label} (code, description, rack)...`}
                  value={stockSearch}
                  onChange={(e) => {
                    setStockSearch(e.target.value);
                    setStockPage(1);
                  }}
                />
              </div>

              <div style={{ width: '160px' }}>
                <Select
                  value={stockStatus}
                  onChange={(e) => {
                    setStockStatus(e.target.value);
                    setStockPage(1);
                  }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="NORMAL">Normal</option>
                  <option value="BELOW_REORDER">Below Reorder</option>
                  <option value="CRITICAL">Critical / Zero</option>
                  <option value="EXCESS">Excess</option>
                </Select>
              </div>

              {(stockSearch || stockStatus !== 'ALL') && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStockSearch('');
                    setStockStatus('ALL');
                    setStockPage(1);
                  }}
                >
                  Clear
                </Button>
              )}

              <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                <strong>{count(itemsData?.meta?.total ?? 0)}</strong> items in {currentSubTabDef.label}
              </span>
            </div>

            <DataTable
              columns={stockColumns}
              rows={itemsData?.data || []}
              rowKey={(r) => r.id}
              loading={itemsLoading}
              meta={itemsData?.meta}
              onPageChange={setStockPage}
              onPageSizeChange={setStockPageSize}
              emptyTitle={`No items in ${currentSubTabDef.label}`}
              emptyMessage="Items will appear here once live stock data is synchronized."
            />
          </CardBody>
        </Card>
      ) : (
        /* TRANSACTIONS / INWARD / OUTWARD TAB */
        <Card>
          <CardBody flush>
            {/* Minimal Filter Bar */}
            <div style={{ padding: 'var(--sp-2) var(--sp-3)', borderBottom: '1px solid var(--border-subtle)', display: 'flex', gap: 'var(--sp-2)', alignItems: 'center', flexWrap: 'wrap' }}>
              <div style={{ flex: '1 1 200px' }}>
                <Input
                  placeholder={`Search ${currentSubTabDef.label} (item, document no, supplier, notes)...`}
                  value={txnSearch}
                  onChange={(e) => {
                    setTxnSearch(e.target.value);
                    setTxnPage(1);
                  }}
                />
              </div>

              {txnSearch && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setTxnSearch('');
                    setTxnPage(1);
                  }}
                >
                  Clear
                </Button>
              )}

              <span style={{ marginLeft: 'auto', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                <strong>{count(txnsData?.meta?.total ?? 0)}</strong> transactions recorded
              </span>
            </div>

            <DataTable
              columns={txnColumns}
              rows={txnsData?.data || []}
              rowKey={(r) => r.id}
              loading={txnsLoading}
              meta={txnsData?.meta}
              onPageChange={setTxnPage}
              onPageSizeChange={setTxnPageSize}
              emptyTitle={`No movements in ${currentSubTabDef.label}`}
              emptyMessage="Store movements will be recorded here chronologically as transactions are posted."
            />
          </CardBody>
        </Card>
      )}

      {/* ── 4. Quick Movement Modal ────────────────────────────────────── */}
      {isMoveModalOpen && (
        <Modal
          title={
            moveDirection === 'IN'
              ? currentSubTabDef.type === 'prod_inward'
                ? 'Record Production Inward'
                : 'Record Inward Receipt'
              : 'Record Outward Store Issue'
          }
          subtitle={moveItem ? `${moveItem.code} — ${moveItem.desc}` : `${category} Store Movement`}
          open={isMoveModalOpen}
          onClose={() => setIsMoveModalOpen(false)}
        >
          <form onSubmit={handlePostMovement} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label="Transaction Type" required>
                <Select value={moveTxnType} onChange={(e) => setMoveTxnType(e.target.value)}>
                  {moveDirection === 'IN' ? (
                    <>
                      <option value="GRN_INWARD">GRN Inward Receipt</option>
                      <option value="PRODUCTION_INWARD">Production / Job Work Inward</option>
                      <option value="STOCK_ADJUSTMENT">Stock Return / Found</option>
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

              <Field label="Reference Document / Bill No">
                <Input
                  placeholder="e.g. GRN-0012, SOE/0524, JC-1002"
                  value={moveRefDoc}
                  onChange={(e) => setMoveRefDoc(e.target.value)}
                />
              </Field>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label={`Quantity (${moveItem?.uom || 'Nos'})`} required>
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
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label="Rate (₹ per unit)">
                <Input
                  type="number"
                  step="0.01"
                  placeholder="e.g. 450"
                  value={moveRate}
                  onChange={(e) => setMoveRate(e.target.value)}
                />
              </Field>

              <Field label={moveDirection === 'IN' ? 'Storage Rack / Bin' : 'Department Issued To'}>
                <Input
                  placeholder={moveDirection === 'IN' ? 'e.g. RACK-A-04' : 'e.g. Cutting / Assembly / Plating'}
                  value={moveDirection === 'IN' ? moveLocation : moveDepartment}
                  onChange={(e) =>
                    moveDirection === 'IN' ? setMoveLocation(e.target.value) : setMoveDepartment(e.target.value)
                  }
                />
              </Field>
            </div>

            <Field label="Notes / Remarks">
              <Textarea
                placeholder="Reason, operator remarks or job reference..."
                value={moveNotes}
                onChange={(e) => setMoveNotes(e.target.value)}
                rows={2}
              />
            </Field>

            {moveItem && (
              <div
                style={{
                  padding: 'var(--sp-2) var(--sp-3)',
                  borderRadius: 'var(--radius-sm)',
                  backgroundColor: 'var(--surface-muted)',
                  fontSize: 'var(--text-xs)',
                }}
              >
                Current live stock: <strong>{qty(moveItem.stock)} {moveItem.uom}</strong>.
                {moveDirection === 'OUT' && (
                  <span style={{ color: 'var(--danger-700)', marginLeft: 6 }}>
                    Strict constraint: Stock cannot become negative.
                  </span>
                )}
              </div>
            )}

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
