import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Plus, Minus, ArrowUpRight, ArrowDownLeft, Scale,
  Database, FileSpreadsheet, Download
} from 'lucide-react';
import { api, downloadFile, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, Badge,
  Modal, Field, Textarea, Select, Input, SearchSelect, type Option,
} from '../../components/ui';
import { useDebounced } from '../../components/simple';
import { qty, formatDate, formatDateTime, count, money, moneyCompact, toShortUom } from '../../lib/format';
import { describeSync, type SyncResult } from '../../lib/describeSync';

export type InventoryCategoryKey = 'RM' | 'FG' | 'WIP' | 'TRADING' | 'GENERAL';

type ReconStatus = 'MATCHED' | 'MISMATCH' | 'NOT_IN_SHEET' | 'ERP_ONLY';

interface CategoryItemRow {
  id: number;
  /** The Purchase item this stock row is linked to; null for codes only the sheet knows. */
  item_id: number | null;
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
  computed_stock_qty: string | null;
  recon_status: ReconStatus | null;
  recon_note: string | null;
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
  source_tab: string | null;
  source_row_index: number | null;
  origin: 'SHEET' | 'ERP';
  status: string;
  reversal_reason: string | null;
  notes: string | null;
  created_by_name: string;
  txn_date: string;
  created_at: string;
}

interface QuarantineRow {
  id: number;
  category: string;
  source_tab: string;
  source_row_index: number;
  raw_data: string[] | null;
  quarantine_reason: string;
  reason_code: string | null;
  resolution_status: string;
  created_at: string;
  last_seen_at: string | null;
}

/** One-line, plain-language result of a sync for a toast (lib/describeSync.ts). */
export { describeSync };

interface CategorySummary {
  category: string;
  stats: {
    totalItems: number;
    sheetItemsCount: number;
    unsyncedItemsCount: number;
    totalStockQty: number;
    sheetStockQty: number;
    totalWeightKg: number;
    totalWeightTon: number;
    totalValuation: number;
    valuationLakhs: number;
    valuationCr: number;
    zeroStockCount: number;
    positiveStockCount: number;
    criticalCount: number;
    belowReorderCount: number;
    reservedItemsCount: number;
    totalAllocatedQty: number;
    quarantinedCount: number;
    inwardTxnCount: number;
    inwardTxnQty: number;
    outwardTxnCount: number;
    outwardTxnQty: number;
    sheetInwardTxnCount: number;
    sheetOutwardTxnCount: number;
    erpInwardTxnCount: number;
    erpOutwardTxnCount: number;
    adjustmentTxnCount: number;
    reversedTxnCount: number;
    prodInwardTxnCount: number;
    prodInwardTxnQty: number;
    reconMatchedCount: number;
    reconMismatchCount: number;
    notInSheetCount: number;
    erpOnlyItemsCount: number;
    lastSyncAt: string | null;
  };
  mainGroups?: Array<{ name: string; count: number; totalQty: number }>;
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
    /** The Purchase item (items.id) the count is posted against. */
    id: number;
    code: string;
    description: string;
    category: string;
    /** This workspace's own (sheet) figure, shown beside the book stock, never as it (E2E S5-18). */
    sheetStock: number;
    uom: string;
  }) => void;
}

/** The item a movement is recorded against: a workspace row linked to a Purchase item. */
interface MoveItem { id: number; code: string; desc: string; stock: number; uom: string; rate?: number; rowId?: number }

/** A workspace row as the movement form needs it (the Receive / Issue row actions pass the same). */
const moveItemOf = (r: CategoryItemRow & { item_id: number }): MoveItem => ({
  id: r.item_id, code: r.item_code, desc: r.item_description, stock: Number(r.live_stock_qty || 0),
  uom: r.primary_uom, rate: Number(r.unit_price || 0), rowId: r.id,
});

/**
 * The item picker of a movement opened from a header button: this category's rows that are
 * in the Purchase item master, the rows the Receive / Issue row actions offer. The header
 * buttons opened the form with no item and no way to choose one, and Record did nothing at
 * all (E2E S5-03, F19).
 */
function CategoryItemSelect({ category, value, onChange, invalid }: {
  category: InventoryCategoryKey;
  value: MoveItem | null;
  onChange: (item: MoveItem) => void;
  invalid?: boolean;
}) {
  const [term, setTerm] = useState('');
  const settled = useDebounced(term.trim(), 250);
  const { data, isFetching } = useQuery({
    queryKey: ['inventory-category-item-pick', category, settled],
    queryFn: () => api.getWithMeta<CategoryItemRow[], PageMeta>(
      `/inventory/categories/${category}${qs({ search: settled || undefined, pageSize: 50, sortBy: 'item_code', sortDir: 'asc' })}`,
    ),
    staleTime: 30_000,
  });
  const rows = data?.data ?? [];
  const linked = rows.filter((r): r is CategoryItemRow & { item_id: number } => r.item_id !== null);
  const options: Option[] = linked.map((r) => ({
    value: r.id,
    label: r.item_code,
    sublabel: r.item_description,
    meta: `Stock: ${qty(r.live_stock_qty)} ${toShortUom(r.primary_uom)}`,
  }));
  const sheetOnly = rows.length - linked.length;
  return (
    <SearchSelect
      value={value?.rowId ?? null}
      options={options}
      onSearch={setTerm}
      searching={isFetching || term.trim() !== settled}
      selectedOption={value?.rowId !== undefined ? { value: value.rowId, label: value.code, sublabel: value.desc } : null}
      placeholder="Type the item code or name…"
      invalid={invalid}
      emptyText={
        sheetOnly > 0
          ? `${sheetOnly} match${sheetOnly === 1 ? '' : 'es'} only in the Google Sheet: record ${sheetOnly === 1 ? 'its' : 'their'} movements in the sheet.`
          : term.trim() ? `No ${category} item matches. Check the item code or name.` : `Type the ${category} item code or name.`
      }
      onChange={(v) => {
        const row = linked.find((r) => r.id === Number(v));
        if (row) onChange(moveItemOf(row));
      }}
    />
  );
}

interface SourceSubTab {
  key: string;
  label: string;
  type: 'stock' | 'inward' | 'outward' | 'prod_inward' | 'adjustment' | 'erp';
  sheetTabName: string;
}

/** Every category also shows its sheet's Stock Adjustment tab and the movements entered in the ERP. */
const COMMON_SUB_TABS: SourceSubTab[] = [
  { key: 'stock_adjustment', label: 'Stock Adjustment', type: 'adjustment', sheetTabName: 'Stock Adjustment' },
  { key: 'erp_entries', label: 'Entered in ERP', type: 'erp', sheetTabName: '' },
];

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
      ...COMMON_SUB_TABS,
    ],
  },
  FG: {
    title: 'Finished Goods (FG)',
    subTabs: [
      { key: 'live_stock', label: 'FG Stock Live', type: 'stock', sheetTabName: 'FG  Stock Live' },
      { key: 'inward_fg', label: 'Inward FG', type: 'inward', sheetTabName: 'Inward FG ' },
      { key: 'outward_fg', label: 'Outward FG', type: 'outward', sheetTabName: 'Outward FG' },
      ...COMMON_SUB_TABS,
    ],
  },
  WIP: {
    title: 'Work in Progress (WIP)',
    subTabs: [
      { key: 'live_stock', label: 'WIP Stock Live', type: 'stock', sheetTabName: 'WIP  Stock Live' },
      { key: 'inward_wip', label: 'Inward WIP', type: 'inward', sheetTabName: 'Inward WIP' },
      { key: 'outward_wip', label: 'Outward WIP', type: 'outward', sheetTabName: 'Outward WIP' },
      ...COMMON_SUB_TABS,
    ],
  },
  TRADING: {
    title: 'Trading Materials',
    subTabs: [
      { key: 'live_stock', label: 'Trading Live Stock', type: 'stock', sheetTabName: 'Trading Live Stock' },
      { key: 'inward_trading', label: 'Inward Trading', type: 'inward', sheetTabName: 'Inward Trading' },
      { key: 'outward_trading', label: 'Outward Trading', type: 'outward', sheetTabName: 'Outward Trading ' },
      ...COMMON_SUB_TABS,
    ],
  },
  GENERAL: {
    title: 'General Stores & Spares',
    subTabs: [
      { key: 'live_stock', label: 'General Item Live Stock', type: 'stock', sheetTabName: 'General Item Live Stock' },
      { key: 'grn_register', label: 'GRN Register (Store Inward Entry)', type: 'inward', sheetTabName: 'GRN Register (Store Inward Entry)' },
      { key: 'issue_register', label: 'Issue Register (Store Outward Entry)', type: 'outward', sheetTabName: 'Issue Register (Store Outward Entry)' },
      ...COMMON_SUB_TABS,
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
  const [stockSource, setStockSource] = useState<'ALL' | 'LIVE_SHEET' | 'ERP_ONLY'>('ALL');
  const [stockMainGroup, setStockMainGroup] = useState<string>('');
  const [stockRecon, setStockRecon] = useState<'' | ReconStatus>('');
  const [isQuarantineModalOpen, setIsQuarantineModalOpen] = useState(false);
  const [quarantineReason, setQuarantineReason] = useState('');

  // Filters for Transactions
  const [txnPage, setTxnPage] = useState(1);
  const [txnPageSize, setTxnPageSize] = useState(25);
  const [txnSearch, setTxnSearch] = useState('');
  const [txnShowReversed, setTxnShowReversed] = useState(false);
  const [reversingTxn, setReversingTxn] = useState<CategoryTxnRow | null>(null);
  const [txnReverseReason, setTxnReverseReason] = useState('');

  // Movement Modal State
  const [isMoveModalOpen, setIsMoveModalOpen] = useState(false);
  const [moveItem, setMoveItem] = useState<MoveItem | null>(null);
  // Opened from a header button: the form asks for the item (CategoryItemSelect).
  const [movePicksItem, setMovePicksItem] = useState(false);
  const [moveItemError, setMoveItemError] = useState<string | null>(null);
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
    source: stockSource !== 'ALL' ? stockSource : undefined,
    mainGroup: stockMainGroup || undefined,
    recon: stockRecon || undefined,
  };

  const { data: itemsData, isLoading: itemsLoading } = useQuery({
    queryKey: ['inventory-category-items', category, stockParams],
    queryFn: () => api.getWithMeta<CategoryItemRow[], PageMeta>(`/inventory/categories/${category}${qs(stockParams)}`),
    enabled: currentSubTabDef.type === 'stock',
  });

  // 3. Fetch Transactions (when type !== 'stock')
  // Each sheet sub-tab lists exactly that sheet tab's counted rows; "Entered in ERP" lists the
  // movements recorded in this system — together they add up to the cards above.
  const txnParams = currentSubTabDef.type === 'erp'
    ? { page: txnPage, pageSize: txnPageSize, search: txnSearch || undefined, origin: 'ERP', status: txnShowReversed ? 'ALL' : undefined }
    : {
        page: txnPage,
        pageSize: txnPageSize,
        search: txnSearch || undefined,
        direction: currentSubTabDef.type === 'adjustment' ? undefined
          : currentSubTabDef.type === 'inward' || currentSubTabDef.type === 'prod_inward' ? 'IN' : 'OUT',
        txnType: currentSubTabDef.type === 'prod_inward' ? 'PRODUCTION_INWARD' : undefined,
        sourceTab: currentSubTabDef.sheetTabName,
        origin: 'SHEET',
      };

  const { data: txnsData, isLoading: txnsLoading } = useQuery({
    queryKey: ['inventory-category-txns', category, currentSubTabDef.key, txnParams],
    queryFn: () => api.getWithMeta<CategoryTxnRow[], PageMeta>(`/inventory/categories/${category}/transactions${qs(txnParams)}`),
    enabled: currentSubTabDef.type !== 'stock',
  });

  // 4. Fetch Quarantined Records
  const { data: quarantineData, isLoading: quarantineLoading } = useQuery({
    queryKey: ['inventory-quarantine', category, quarantineReason],
    queryFn: () => api.getWithMeta<QuarantineRow[], PageMeta & { byReason?: Array<{ reasonCode: string | null; label: string; count: number }> }>(
      `/inventory/quarantine${qs({ category, pageSize: 200, reasonCode: quarantineReason || undefined })}`,
    ),
    enabled: isQuarantineModalOpen,
  });

  // Export Category CSV Handler
  const exportCategoryCsv = async () => {
    try {
      // The list's own filters: the backend shares them since 2026-10-16, but the button sent none.
      const q = qs({ ...stockParams, page: undefined, pageSize: undefined });
      await downloadFile(`/inventory/categories/${category}/export${q}`, `inventory_${category.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv`);
      toast.success(`${category} stock register exported successfully.`);
    } catch (err) {
      toast.fromError(err, 'Failed to export CSV');
    }
  };

  // 4. Live Google Sheet Sync Mutation
  const syncMutation = useMutation({
    mutationFn: () => api.post<SyncResult>(`/inventory/sync/${category}`, {}),
    onSuccess: (res) => {
      if (res.status === 'SUCCESS') toast.success(describeSync(res));
      else toast.error(res.errorMessage || `${category} sync did not finish. Nothing was changed — please try again.`);
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

  // 6. Reverse a movement entered in the ERP (the sheet's own rows change only in the sheet)
  const reverseTxnMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api.post<{ message: string }>(`/inventory/transactions/${id}/reverse`, { reason }),
    onSuccess: (res) => {
      toast.success(res.message);
      setReversingTxn(null);
      setTxnReverseReason('');
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-txns', category] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to reverse the movement'),
  });

  const openMoveModal = (item: MoveItem | null, direction: 'IN' | 'OUT') => {
    setMoveItem(item);
    setMovePicksItem(item === null);
    setMoveItemError(null);
    setMoveDirection(direction);
    setMoveTxnType(
      direction === 'IN'
        ? currentSubTabDef.type === 'prod_inward' ? 'PRODUCTION_INWARD' : 'ERP_RECEIPT'
        : 'ERP_ISSUE'
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
    if (!moveItem) {
      setMoveItemError(moveDirection === 'IN' ? 'Choose the item received.' : 'Choose the item issued.');
      return;
    }
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

    if (category === 'FG' || category === 'WIP') {
      cols.push({
        key: 'weight_1000pc',
        header: '1000pc Wt (Kg)',
        align: 'right',
        render: (r) => (Number(r.weight_per_1000pc_kg) > 0 ? <span className="num">{qty(r.weight_per_1000pc_kg)} Kg</span> : <span className="cell-muted">—</span>),
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
        key: 'origin',
        header: 'Sheet check',
        align: 'center',
        width: '130px',
        render: (r) => {
          // Opening + inward − outward + adjustments, from the sheet's own rows, against its live stock.
          // A matching row can still carry a note: above all that its figure is not in the Purchase
          // stock because this sheet counts another unit (it showed a plain 'Matches sheet' before).
          if (r.recon_status === 'MATCHED') {
            if (r.recon_note?.includes('Not counted in the Purchase stock')) {
              return <span title={r.recon_note}><Badge tone="warning">Unit differs</Badge></span>;
            }
            return <span title={r.recon_note ?? undefined}><Badge tone="success" plain>Matches sheet</Badge></span>;
          }
          if (r.recon_status === 'MISMATCH') {
            const diff = Number(r.live_stock_qty || 0) - Number(r.computed_stock_qty || 0);
            return (
              <span title={r.recon_note ?? undefined}>
                <Badge tone="warning">Check: {diff > 0 ? '+' : ''}{qty(diff)}</Badge>
              </span>
            );
          }
          if (r.recon_status === 'NOT_IN_SHEET') return <span title={r.recon_note ?? undefined}><Badge tone="neutral" plain>Not in sheet now</Badge></span>;
          if (r.recon_status === 'ERP_ONLY' || !r.source_spreadsheet_id) return <Badge tone="neutral" plain>ERP only</Badge>;
          return <Badge tone="neutral" plain>Not checked yet</Badge>;
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
        render: (r) => {
          const itemId = r.item_id;
          // A code only the Google Sheet knows (not in the Purchase item master) is moved in the sheet.
          if (itemId === null) {
            return (
              <span className="cell-muted" style={{ fontSize: '11px' }} title="This item is not in the Purchase item master. Record its movements in the Google Sheet.">
                Use the sheet
              </span>
            );
          }
          return (
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
                      { id: itemId, code: r.item_code, desc: r.item_description, stock: Number(r.live_stock_qty || 0), uom: r.primary_uom, rate: Number(r.unit_price || 0) },
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
                      { id: itemId, code: r.item_code, desc: r.item_description, stock: Number(r.live_stock_qty || 0), uom: r.primary_uom, rate: Number(r.unit_price || 0) },
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
                    id: itemId,
                    code: r.item_code,
                    description: r.item_description,
                    category: r.category,
                    sheetStock: Number(r.live_stock_qty || 0),
                    uom: r.primary_uom,
                  })
                }
              >
                Adjust
              </Button>
            )}
          </div>
        );
        },
      }
    );

    return cols;
  }, [category, can, onOpenAdjustment]);

  // Transaction Columns (Inward / Outward tabs)
  const txnColumns = useMemo<Column<CategoryTxnRow>[]>(() => {
    const cols: Column<CategoryTxnRow>[] = [
      {
        key: 'txn_date',
        header: 'Date',
        width: '100px',
        render: (r) => <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>{formatDate(r.txn_date)}</span>,
      },
      {
        key: 'txn_no',
        header: 'Document / Txn No',
        width: '180px',
        render: (r) => (
          <div>
            <span className="cell-code font-medium">{r.reference_doc_no || r.txn_no}</span>
            {r.reference_doc_no && r.reference_doc_no !== r.txn_no && (
              <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                {r.txn_no}
              </div>
            )}
            {r.notes && (
              <div
                style={{
                  fontSize: '10px',
                  color: 'var(--text-faint)',
                  maxWidth: '180px',
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                }}
                title={r.notes}
              >
                {r.notes}
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
              {r.txn_type.replace(/_/g, ' ')}
            </Badge>
            <span style={{ marginLeft: 6 }} title={r.origin === 'SHEET' && r.source_row_index ? `Google Sheet row ${r.source_row_index}` : undefined}>
              <Badge tone={r.origin === 'SHEET' ? 'info' : 'warning'} plain>
                {r.origin === 'SHEET' ? `Sheet${r.source_row_index ? ` row ${r.source_row_index}` : ''}` : 'Entered in ERP'}
              </Badge>
            </span>
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
        key: 'rate_amount',
        header: 'Rate / Amount',
        align: 'right',
        render: (r) => {
          const rateVal = Number(r.rate || 0);
          const amtVal = Number(r.amount || 0);
          if (rateVal === 0 && amtVal === 0) return <span className="cell-muted">—</span>;
          return (
            <div>
              {amtVal > 0 && <div className="num font-medium">{money(amtVal)}</div>}
              {rateVal > 0 && <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>@{money(rateVal)}</div>}
            </div>
          );
        },
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
    if (currentSubTabDef.type !== 'erp') return cols;
    cols.push({
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.status === 'REVERSED' ? (
          <div style={{ fontSize: '11px' }}>
            <Badge tone="neutral">Reversed</Badge>
            {r.reversal_reason && <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>{r.reversal_reason}</div>}
          </div>
        ) : can('inventory.adjust') ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReversingTxn(r);
              setTxnReverseReason('');
            }}
          >
            Reverse
          </Button>
        ) : (
          <Badge tone="success">Posted</Badge>
        ),
    });
    return cols;
  }, [currentSubTabDef.type, can]);

  const stats = summaryData?.stats;
  const lastSync = summaryData?.lastSync;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
      {/* ── 1. Category Action & Sync Header Bar ────────────────────────── */}
      <Card>
        <CardBody style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Badge tone="info">{category}</Badge>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text)' }}>
                {config.title}
              </span>
              {lastSync && (
                <span style={{ fontSize: '11px', color: 'var(--text-faint)', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                  <Database size={12} /> Last synced: {formatDateTime(lastSync.created_at)}
                  {lastSync.status !== 'SUCCESS' && ` — ${lastSync.status === 'PARTIAL' ? 'partly applied' : 'failed'}`}
                  {lastSync.sync_duration_ms > 0 && ` (${(lastSync.sync_duration_ms / 1000).toFixed(1)}s)`}
                </span>
              )}
            </div>

            <div className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
              {/* Only with the export right, as the register's and the ledger's export buttons;
                  a Purchase User was offered it (E2E S5-07c), and the server now refuses it. */}
              {can('inventory.export') && (
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<Download size={13} />}
                  onClick={() => void exportCategoryCsv()}
                  title={`Export ${category} Stock Register to CSV`}
                >
                  Export CSV
                </Button>
              )}

              {can('inventory.adjust') && (
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<RefreshCw size={13} className={syncMutation.isPending ? 'spin' : ''} />}
                    loading={syncMutation.isPending}
                    onClick={() => syncMutation.mutate()}
                    title={`Fetch and reconcile live data from Google Sheet "${currentSubTabDef.sheetTabName}"`}
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

      {/* ── 2. Clickable Analytical Cards Strip (StatTiles) ─────────────── */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
          gap: 'var(--sp-2)',
        }}
      >
        <StatTile
          label="Total Items"
          value={count(stats?.totalItems ?? itemsData?.meta?.total ?? 0)}
          sub={`${count(stats?.sheetItemsCount ?? 0)} in the sheet • ${count(stats?.unsyncedItemsCount ?? 0)} ERP only`}
          tone="default"
          onClick={() => {
            setStockStatus('ALL');
            setStockSource('ALL');
            setStockMainGroup('');
            setStockRecon('');
            setStockSearch('');
            setStockPage(1);
            setActiveSubTab(config.subTabs[0].key);
          }}
        />

        <StatTile
          label="Matches Google Sheet"
          value={`${count(stats?.reconMatchedCount ?? 0)} / ${count(stats?.sheetItemsCount ?? 0)}`}
          sub={stats?.reconMismatchCount
            ? `${count(stats.reconMismatchCount)} item(s) to check — click`
            : 'Opening + in − out + adjustments = sheet'}
          tone={stats?.reconMismatchCount ? 'warning' : 'success'}
          onClick={() => {
            setStockRecon(stats?.reconMismatchCount ? 'MISMATCH' : 'MATCHED');
            setStockStatus('ALL');
            setStockSource('ALL');
            setStockPage(1);
            setActiveSubTab(config.subTabs[0].key);
          }}
        />

        <StatTile
          label={category === 'RM' || category === 'FG' || category === 'WIP' ? 'Live Weight' : 'Live Stock'}
          value={
            category === 'RM' || category === 'FG' || category === 'WIP'
              ? `${qty(stats?.totalWeightTon ?? 0)} Ton`
              : `${count(stats?.totalStockQty ?? 0)} Qty`
          }
          sub={
            category === 'RM'
              ? `${qty(stats?.totalStockQty ?? 0)} Kg live stock`
              : category === 'FG' || category === 'WIP'
                ? `${count(stats?.totalStockQty ?? 0)} Nos live stock`
                : 'Physical inventory units'
          }
          tone="default"
          onClick={() => setActiveSubTab(config.subTabs[0].key)}
        />

        <StatTile
          label="Total Valuation"
          value={moneyCompact(stats?.totalValuation ?? 0)}
          sub={`Exact: ${money(stats?.totalValuation ?? 0)}`}
          tone="default"
          onClick={() => {
            setStockStatus('POSITIVE_STOCK');
            setActiveSubTab(config.subTabs[0].key);
            setStockPage(1);
          }}
        />

        <StatTile
          label="Positive Stock"
          value={count(stats?.positiveStockCount ?? 0)}
          sub="Items currently in store"
          tone="success"
          onClick={() => {
            setStockStatus('POSITIVE_STOCK');
            setActiveSubTab(config.subTabs[0].key);
            setStockPage(1);
          }}
        />

        <StatTile
          label="Zero Stock"
          value={count(stats?.zeroStockCount ?? 0)}
          sub="No stock in store"
          tone="danger"
          onClick={() => {
            setStockStatus('ZERO_STOCK');
            setStockRecon('');
            setActiveSubTab(config.subTabs[0].key);
            setStockPage(1);
          }}
        />

        <StatTile
          label="Below Reorder"
          value={count(stats?.belowReorderCount ?? 0)}
          sub="Reorder threshold reached"
          tone="warning"
          onClick={() => {
            setStockStatus('BELOW_REORDER');
            setActiveSubTab(config.subTabs[0].key);
            setStockPage(1);
          }}
        />

        <StatTile
          label="Inward Entries"
          value={count(stats?.inwardTxnCount ?? 0)}
          sub={`${count(stats?.sheetInwardTxnCount ?? 0)} from sheet • ${count(stats?.erpInwardTxnCount ?? 0)} entered in ERP`}
          tone="success"
          onClick={() => {
            const inTab = config.subTabs.find((t) => t.type === 'inward');
            if (inTab) setActiveSubTab(inTab.key);
          }}
        />

        <StatTile
          label="Outward Entries"
          value={count(stats?.outwardTxnCount ?? 0)}
          sub={`${count(stats?.sheetOutwardTxnCount ?? 0)} from sheet • ${count(stats?.erpOutwardTxnCount ?? 0)} entered in ERP`}
          tone="warning"
          onClick={() => {
            const outTab = config.subTabs.find((t) => t.type === 'outward');
            if (outTab) setActiveSubTab(outTab.key);
          }}
        />

        <StatTile
          label="Rows Not Counted"
          value={count(stats?.quarantinedCount ?? 0)}
          sub={stats?.quarantinedCount ? 'Sheet rows to fix — click to see why' : 'Every sheet row is counted'}
          tone={stats?.quarantinedCount ? 'danger' : 'default'}
          onClick={() => {
            setQuarantineReason('');
            setIsQuarantineModalOpen(true);
          }}
        />
      </div>

      {/* ── 3. Source-Sheet Sub-Tabs (Clean Spreadsheet Style) ──────────── */}
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
              onClick={() => {
                setActiveSubTab(tab.key);
                setTxnPage(1);
                setTxnSearch('');
              }}
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

      {/* ── 4. Sub-Tab Content ─────────────────────────────────────────── */}
      {currentSubTabDef.type === 'stock' ? (
        /* LIVE STOCK TAB */
        <Card>
          <CardBody flush>
            {/* Enhanced Multi-Source Filter Bar */}
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

              <div style={{ width: '150px' }}>
                <Select
                  value={stockStatus}
                  onChange={(e) => {
                    setStockStatus(e.target.value);
                    setStockPage(1);
                  }}
                >
                  <option value="ALL">All Statuses</option>
                  <option value="POSITIVE_STOCK">Positive Stock (&gt; 0)</option>
                  <option value="NORMAL">Normal / Healthy</option>
                  <option value="BELOW_REORDER">Below Reorder</option>
                  <option value="CRITICAL">Critical / Zero</option>
                  <option value="EXCESS">Excess</option>
                </Select>
              </div>

              <div style={{ width: '150px' }}>
                <Select
                  value={stockSource}
                  onChange={(e) => {
                    setStockSource(e.target.value as any);
                    setStockPage(1);
                  }}
                >
                  <option value="ALL">All Sources</option>
                  <option value="LIVE_SHEET">Google Sheet Synced</option>
                  <option value="ERP_ONLY">ERP Catalog Only</option>
                </Select>
              </div>

              {summaryData?.mainGroups && summaryData.mainGroups.length > 0 && (
                <div style={{ width: '170px' }}>
                  <Select
                    value={stockMainGroup}
                    onChange={(e) => {
                      setStockMainGroup(e.target.value);
                      setStockPage(1);
                    }}
                  >
                    <option value="">All Main Groups</option>
                    {summaryData.mainGroups.map((mg) => (
                      <option key={mg.name} value={mg.name}>
                        {mg.name} ({mg.count})
                      </option>
                    ))}
                  </Select>
                </div>
              )}

              <div style={{ width: '170px' }}>
                <Select
                  value={stockRecon}
                  onChange={(e) => {
                    setStockRecon(e.target.value as '' | ReconStatus);
                    setStockPage(1);
                  }}
                >
                  <option value="">Any sheet check</option>
                  <option value="MATCHED">Matches the sheet</option>
                  <option value="MISMATCH">Differs from the sheet</option>
                  <option value="NOT_IN_SHEET">No longer in the sheet</option>
                  <option value="ERP_ONLY">ERP only</option>
                </Select>
              </div>

              {(stockSearch || stockStatus !== 'ALL' || stockSource !== 'ALL' || stockMainGroup || stockRecon) && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setStockSearch('');
                    setStockStatus('ALL');
                    setStockSource('ALL');
                    setStockMainGroup('');
                    setStockRecon('');
                    setStockPage(1);
                  }}
                >
                  Clear Filters
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

              {currentSubTabDef.type === 'erp' && (
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  <input
                    type="checkbox"
                    checked={txnShowReversed}
                    onChange={(e) => {
                      setTxnShowReversed(e.target.checked);
                      setTxnPage(1);
                    }}
                  />
                  Show reversed movements
                </label>
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

      {/* ── Reverse a movement entered in the ERP ───────────────────────── */}
      {reversingTxn && (
        <Modal
          open={Boolean(reversingTxn)}
          onClose={() => setReversingTxn(null)}
          title={`Reverse ${reversingTxn.txn_no}`}
          subtitle={`${reversingTxn.item_code}: ${reversingTxn.direction === 'IN' ? '+' : '-'}${qty(reversingTxn.quantity)} ${toShortUom(reversingTxn.uom)} is undone with a reversal entry. The movement stays on record, marked reversed.`}
          footer={
            <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end', width: '100%' }}>
              <Button variant="ghost" onClick={() => setReversingTxn(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                disabled={txnReverseReason.trim().length < 5}
                loading={reverseTxnMutation.isPending}
                onClick={() => reverseTxnMutation.mutate({ id: reversingTxn.id, reason: txnReverseReason.trim() })}
              >
                Reverse movement
              </Button>
            </div>
          }
        >
          <Field label="Why is it being reversed?" required hint="At least 5 characters. Saved in the audit log.">
            <Textarea
              placeholder="e.g. Receipt was entered twice"
              value={txnReverseReason}
              onChange={(e) => setTxnReverseReason(e.target.value)}
              rows={3}
              autoFocus
            />
          </Field>
        </Modal>
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
            {movePicksItem && (
              <Field
                label="Item"
                required
                error={moveItemError ?? undefined}
                hint={`An item of the ${category} stock that is in the Purchase item master.`}
              >
                <CategoryItemSelect
                  category={category}
                  value={moveItem}
                  invalid={Boolean(moveItemError)}
                  onChange={(it) => {
                    setMoveItem(it);
                    setMoveItemError(null);
                    if (!moveRate && it.rate) setMoveRate(String(it.rate));
                  }}
                />
              </Field>
            )}

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
              <Field label="Transaction Type" required>
                <Select value={moveTxnType} onChange={(e) => setMoveTxnType(e.target.value)}>
                  {/* Plain names, and no GRN / requisition / direct-issue types: those documents
                      have their own screens, and posting one here would only imitate them. */}
                  {moveDirection === 'IN' ? (
                    <>
                      <option value="ERP_RECEIPT">Material received</option>
                      <option value="PRODUCTION_INWARD">Production / job work inward</option>
                      <option value="RETURN_TO_STORE">Returned to store / found</option>
                    </>
                  ) : (
                    <>
                      <option value="ERP_ISSUE">Material issued</option>
                      <option value="SCRAP_OUTWARD">Scrap / breakage</option>
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
                  autoFocus={!movePicksItem}
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
                    Stock cannot go below zero.
                  </span>
                )}
              </div>
            )}

            <div
              style={{
                padding: 'var(--sp-2) var(--sp-3)',
                borderRadius: 'var(--radius-sm)',
                border: '1px solid var(--border-subtle)',
                fontSize: 'var(--text-xs)',
                color: 'var(--text-muted)',
              }}
            >
              The Google Sheet is the stock record. Write this movement in the sheet too — at the next sync the
              ERP stock follows the sheet again, and anything not in the sheet is shown under “Entered in ERP”.
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

      {/* ── 5. Quarantined Records Modal ───────────────────────────────── */}
      {isQuarantineModalOpen && (
        <Modal
          title={`${category}: sheet rows not counted`}
          subtitle="Rows the Google Sheet's own stock formula does not count, or that need fixing in the sheet. Fix the row in the sheet, then Sync."
          open={isQuarantineModalOpen}
          onClose={() => setIsQuarantineModalOpen(false)}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {(quarantineData?.meta?.byReason?.length ?? 0) > 0 && (
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                <Button size="sm" variant={quarantineReason === '' ? 'primary' : 'secondary'} onClick={() => setQuarantineReason('')}>
                  All ({count(quarantineData!.meta!.byReason!.reduce((a, r) => a + r.count, 0))})
                </Button>
                {quarantineData!.meta!.byReason!.map((r) => (
                  <Button
                    key={r.reasonCode ?? 'none'}
                    size="sm"
                    variant={quarantineReason === (r.reasonCode ?? '') ? 'primary' : 'secondary'}
                    onClick={() => setQuarantineReason(r.reasonCode ?? '')}
                    title={r.label}
                  >
                    {(r.reasonCode ?? 'OTHER').replace(/_/g, ' ').toLowerCase()} ({count(r.count)})
                  </Button>
                ))}
              </div>
            )}

            {quarantineLoading ? (
              <div style={{ textAlign: 'center', padding: 'var(--sp-4)', color: 'var(--text-muted)' }}>
                Loading…
              </div>
            ) : (!quarantineData?.data || quarantineData.data.length === 0) ? (
              <div style={{ textAlign: 'center', padding: 'var(--sp-4)', color: 'var(--success-700)' }}>
                ✓ Every {category} sheet row is counted. Nothing to fix.
              </div>
            ) : (
              <div style={{ maxHeight: '420px', overflowY: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--text-xs)' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left' }}>
                      <th style={{ padding: '6px 8px' }}>Sheet tab · row</th>
                      <th style={{ padding: '6px 8px' }}>Why it is not counted / what to fix</th>
                      <th style={{ padding: '6px 8px' }}>Row content</th>
                      <th style={{ padding: '6px 8px' }}>Last seen</th>
                    </tr>
                  </thead>
                  <tbody>
                    {quarantineData.data.map((q) => (
                      <tr key={q.id} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                        <td style={{ padding: '6px 8px', whiteSpace: 'nowrap' }}>
                          <div style={{ fontWeight: 500 }}>{q.source_tab.trim()}</div>
                          <Badge tone="neutral" plain>Row {q.source_row_index ?? '—'}</Badge>
                        </td>
                        <td style={{ padding: '6px 8px', color: 'var(--danger-700)' }}>{q.quarantine_reason}</td>
                        <td
                          style={{ padding: '6px 8px', color: 'var(--text-muted)', fontFamily: 'monospace', maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                          title={(q.raw_data ?? []).join(' | ')}
                        >
                          {(q.raw_data ?? []).filter(Boolean).slice(0, 8).join(' | ')}
                        </td>
                        <td style={{ padding: '6px 8px', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
                          {formatDate(q.last_seen_at ?? q.created_at)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {(quarantineData.meta?.total ?? 0) > quarantineData.data.length && (
                  <div style={{ padding: 'var(--sp-2)', color: 'var(--text-muted)' }}>
                    Showing {count(quarantineData.data.length)} of {count(quarantineData.meta!.total)} — pick a reason above to narrow the list.
                  </div>
                )}
              </div>
            )}

            <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'var(--sp-2)' }}>
              <Button variant="secondary" onClick={() => setIsQuarantineModalOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}
