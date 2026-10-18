/**
 * Enterprise Inventory & Stock Management Module (Zeeta / Zolex ERP).
 *
 * Comprehensive multi-workspace inventory system:
 * 1. Overview & Analytics: Stock valuation, KPIs, Category distributions, Recent ledger activity
 * 2. Category Stock Register: Finished Goods (FG), Raw Material (RM), Trading, General Stores, WIP
 * 3. Stock Movement Ledger: Inward, Outward, Adjustments, Requisitions, Direct issues audit trail
 * 4. Physical Count Adjustments: Cycle count reconciliation, delta calculation, reason auditing
 * 5. Requisition Issue Queue: Approved requisitions awaiting store issue with live stock check
 * 6. Auto Indent Replenishment: Min/Max/Reorder threshold analysis & 1-click PO Indent conversion
 */
import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Zap, Download, CheckCircle2, XCircle, FileText,
  ArrowRight, ClipboardCheck,
  PackageSearch, Plus, PackageMinus,
  RefreshCw,
} from 'lucide-react';
import { api, downloadFile, qs, ApiError, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, CardHeader, Badge, StatusBadge, MovementChip, Banner,
  Modal, Field, Textarea, Select, Input,
} from '../../components/ui';
import { qty, formatDate, formatDateTime, count, money, moneyCompact, toShortUom } from '../../lib/format';
import { LEDGER_TXN_TYPES, movementMeta, statusMeta } from '../../lib/status';
import { countAfterBookRead } from '../../lib/inventoryForms';
import { CategoryWorkspaceView, describeSync, type InventoryCategoryKey } from './CategoryWorkspaceView';

/* ── Type Interfaces ────────────────────────────────────────────────────────── */

interface StockRow {
  item_id: number;
  item_code: string;
  item_description: string;
  category: 'GENERAL' | 'RM' | 'FG' | 'TRADING' | 'WIP';
  opening_stock_qty: string;
  stock_valuation: string;
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
  qc_pending_stock_qty?: string;
  min_stock: string;
  max_stock: string | null;
  reorder_level: string;
  reorder_qty: string;
  pending_indent_qty: string;
  pending_po_qty: string;
  pending_grn_qty: string;
  standard_rate: string;
  qc_required: boolean;
  stock_status: 'NORMAL' | 'BELOW_REORDER' | 'CRITICAL' | 'EXCESS';
}

interface OverviewData {
  kpis: {
    totalItems: number;
    totalStockQty: number;
    totalValuation: number;
    zeroStockCount?: number;
    positiveStockCount?: number;
    normalStock: number;
    belowReorder: number;
    criticalStock: number;
    excessStock: number;
    pendingIndentsCount: number;
    pendingIndentsQty: number;
    pendingPosCount: number;
    pendingPosQty: number;
    pendingRequisitionsCount: number;
    pendingRequisitionsQty: number;
    todayInwardQty: number;
    todayOutwardQty: number;
    todayTxnsCount: number;
    quarantinedCount?: number;
    unsyncedCount?: number;
  };
  unitsSummary?: Array<{
    primary_uom: string;
    item_count: number;
    total_qty: string;
  }>;
  categoryBreakdown: Array<{
    category: string;
    item_count: number;
    sheet_items_count?: number;
    unsynced_items_count?: number;
    stock_qty: string;
    sheet_stock_qty?: string;
    total_weight_kg?: string;
    weight_ton?: string;
    valuation: string;
    zero_stock_count?: number;
    positive_stock_count?: number;
    critical_count: number;
    below_reorder_count: number;
    quarantined_count?: number;
  }>;
  recentMovements: Array<{
    id: number;
    item_id: number;
    item_code: string;
    item_description: string;
    category: string;
    uom_code: string;
    txn_type: string;
    reference_type: string;
    reference_id: number;
    reference_no: string;
    inward_qty: string;
    outward_qty: string;
    balance_qty: string;
    txn_date: string;
    created_at: string;
    created_by_name: string;
  }>;
}

interface LedgerRow {
  id: number;
  item_id: number;
  item_code: string;
  item_description: string;
  category: string;
  uom_code: string;
  txn_type: string;
  reference_type: string;
  reference_id: number;
  reference_no: string;
  inward_qty: string;
  outward_qty: string;
  balance_qty: string;
  txn_date: string;
  created_at: string;
  created_by_name: string;
}

interface AdjustmentRow {
  id: number;
  adjustment_no: string;
  adjustment_date: string;
  item_id: number;
  item_code: string;
  item_description: string;
  category: string;
  system_stock_qty: string;
  actual_stock_qty: string;
  adjustment_qty: string;
  reason: string;
  findings: string;
  remarks: string;
  approver_name: string;
  created_by_name: string;
  created_at: string;
  reversed_at?: string | null;
  reversal_reason?: string | null;
}

interface RequisitionQueueRow {
  requisition_id: number;
  requisition_no: string;
  requisition_date: string;
  department_name: string;
  cost_centre_name: string;
  requester_name: string;
  status: string;
  hod_status: string;
  requisition_line_id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  requested_qty: string;
  issued_qty: string;
  balance_to_issue: string;
  uom_code: string;
  category: string;
  live_stock_qty: string;
  available_stock_qty: string;
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
  /** The indent a converted suggestion became (auto_indents.indent_id; null once that indent is deleted). */
  indent_id: number | null;
  indent_no: string;
  /** The server's own approve, reject and convert rules for this user and row (backend inventory/routes.ts). */
  can_approve: boolean;
  can_reject: boolean;
  can_convert: boolean;
  /** Another open suggestion for the same item: approve and convert wait until one of the two is rejected. */
  open_duplicate_id: number | null;
  open_duplicate_status: string | null;
  created_at: string;
}

/** GET /inventory/adjustments/book-stock/:id — the items row a physical count is posted against. */
interface BookStock {
  item_id: number;
  item_code: string;
  is_active: boolean;
  live_stock_qty: string;
}

interface AutoIndentStats {
  pending: number;
  storeApproved: number;
  approved: number;
  converted: number;
  rejected: number;
  total: number;
}

const CATEGORY_NAMES: Record<string, string> = {
  ALL: 'All Categories',
  GENERAL: 'General Store & Spares',
  RM: 'Raw Materials (RM)',
  FG: 'Finished Goods (FG)',
  TRADING: 'Trading Materials',
  WIP: 'Work in Progress (WIP)',
};

const CATEGORY_TONES: Record<string, 'neutral' | 'success' | 'warning' | 'info'> = {
  GENERAL: 'neutral',
  RM: 'info',
  FG: 'success',
  TRADING: 'warning',
  WIP: 'neutral',
};

const PAGE_INFO: Record<string, { title: string; subtitle: string }> = {
  overview: {
    title: 'Inventory Overview & Analytics',
    subtitle: 'Live stock valuation, operational KPIs, pipeline tracking and sync checkpoints',
  },
  rm: {
    title: 'Raw Material (RM)',
    subtitle: 'RM live stock, GRN inward, RM outward and production inward movements',
  },
  fg: {
    title: 'Finished Goods (FG)',
    subtitle: 'FG live stock, packing inward and sales/dispatch outward movements',
  },
  wip: {
    title: 'Work in Progress (WIP)',
    subtitle: 'WIP live stage stock, stage inward and stage outward movements',
  },
  trading: {
    title: 'Trading Materials',
    subtitle: 'Trading live stock, purchase inward and trading outward issues',
  },
  general: {
    title: 'General Stores & Spares',
    subtitle: 'General consumables live stock, GRN inward register and issue outward register',
  },
  stock: {
    title: 'Unified Stock Register',
    subtitle: 'Authoritative stock balances across all materials and finished goods',
  },
  ledger: {
    title: 'Stock Movement Ledger',
    subtitle: 'Complete chronological audit trail of inward receipts, store issues and adjustments',
  },
  adjustments: {
    title: 'Physical Count Adjustments',
    subtitle: 'Cycle count physical reconciliation, variance tracking and findings audit',
  },
  'requisition-queue': {
    title: 'Store Requisition Queue',
    subtitle: 'Approved material requisitions awaiting issue from stores with real-time stock availability',
  },
  'auto-indent': {
    title: 'Auto Indent Replenishment',
    subtitle: 'Automated replenishment recommendations based on min/max and reorder thresholds',
  },
};

export default function InventoryStockPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const currentTab = searchParams.get('tab') || 'overview';
  const initialCategory = searchParams.get('category') || 'ALL';
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

  /* ── Tab State ──────────────────────────────────────────────────────────── */
  // Stock Register
  const [stockPage, setStockPage] = useState(1);
  const [stockPageSize, setStockPageSize] = useState(25);
  const [stockSearch, setStockSearch] = useState('');
  const [stockCategory, setStockCategory] = useState<string>(initialCategory);
  const [stockStatusFilter, setStockStatusFilter] = useState('ALL');

  // Movement Ledger
  const [ledgerPage, setLedgerPage] = useState(1);
  const [ledgerPageSize, setLedgerPageSize] = useState(25);
  const [ledgerSearch, setLedgerSearch] = useState('');
  const [ledgerCategory, setLedgerCategory] = useState<string>('ALL');
  const [ledgerTxnType, setLedgerTxnType] = useState<string>('');

  // Adjustments
  const [adjPage, setAdjPage] = useState(1);
  const [adjPageSize, setAdjPageSize] = useState(25);
  const [adjSearch, setAdjSearch] = useState('');
  const [isAdjModalOpen, setIsAdjModalOpen] = useState(false);
  const [adjItemSearch, setAdjItemSearch] = useState('');
  // The item only: its book stock is loaded when the modal opens (adjBookStock below).
  const [selectedAdjItem, setSelectedAdjItem] = useState<{
    id: number;
    code: string;
    description: string;
    category: string;
    uom: string;
    /** The category workspace's own (sheet) figure, when the count was opened from a workspace row. */
    sheetStock?: number;
  } | null>(null);
  const [adjActualCount, setAdjActualCount] = useState<string>('');
  // Whether the counter typed the count; an untouched count follows the book stock (countAfterBookRead).
  const [adjCountTyped, setAdjCountTyped] = useState(false);
  // A count the server refused because the book stock moved while it was open (409).
  const [adjRefused, setAdjRefused] = useState<{ shown: number; bookStock: number } | null>(null);
  const [adjReason, setAdjReason] = useState<string>('Cycle Count Reconciliation');
  const [adjFindings, setAdjFindings] = useState<string>('');
  const [adjRemarks, setAdjRemarks] = useState<string>('');
  const [reversingAdj, setReversingAdj] = useState<AdjustmentRow | null>(null);
  const [reverseReason, setReverseReason] = useState('');

  // Requisition Queue
  const [reqQueueSearch, setReqQueueSearch] = useState('');
  const [reqStockFilter, setReqStockFilter] = useState<'ALL' | 'READY' | 'SHORTAGE'>('ALL');

  // Auto Indent
  const [indentPage, setIndentPage] = useState(1);
  const [indentPageSize, setIndentPageSize] = useState(25);
  const [indentSearch, setIndentSearch] = useState('');
  const [indentStatusFilter, setIndentStatusFilter] = useState('');
  const [rejectingItem, setRejectingItem] = useState<AutoIndentRow | null>(null);
  const [rejectionReason, setRejectionReason] = useState('');

  /* ── Queries ────────────────────────────────────────────────────────────── */

  // 1. Overview
  const { data: overviewData, isLoading: overviewLoading } = useQuery({
    queryKey: ['inventory-overview'],
    queryFn: () => api.get<OverviewData>('/inventory/overview'),
    enabled: currentTab === 'overview',
  });

  // 2. Stock Register
  const stockParams = {
    page: stockPage,
    pageSize: stockPageSize,
    search: (filters.search as string) || stockSearch || undefined,
    category: stockCategory !== 'ALL' ? stockCategory : undefined,
    stockStatus: stockStatusFilter !== 'ALL' ? stockStatusFilter : undefined,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    mainGroupId: filters.mainGroupId,
    itemTypeId: filters.itemTypeId,
    itemId: filters.itemId,
    hodId: filters.hodId,
  };

  const { data: stockData, isLoading: stockLoading } = useQuery({
    queryKey: ['inventory-stock', stockParams],
    queryFn: () =>
      api.getWithMeta<
        StockRow[],
        PageMeta & {
          summary?: {
            totalActive: number;
            normalStock: number;
            belowReorder: number;
            criticalStock: number;
            excessStock: number;
            totalValuation: number;
            categories?: Record<string, number>;
          };
        }
      >(`/inventory/stock${qs(stockParams)}`),
    enabled: currentTab === 'stock',
  });

  // 3. Movement Ledger
  const ledgerParams = {
    page: ledgerPage,
    pageSize: ledgerPageSize,
    search: ledgerSearch || undefined,
    category: ledgerCategory !== 'ALL' ? ledgerCategory : undefined,
    txnType: ledgerTxnType || undefined,
    fromDate: filters.dateFrom,
    toDate: filters.dateTo,
  };

  const { data: ledgerData, isLoading: ledgerLoading } = useQuery({
    queryKey: ['inventory-ledger', ledgerParams],
    queryFn: () =>
      api.getWithMeta<
        LedgerRow[],
        PageMeta & {
          summary?: {
            totalMovements: number;
            totalInward: number;
            totalOutward: number;
          };
        }
      >(`/inventory/ledger${qs(ledgerParams)}`),
    enabled: currentTab === 'ledger',
  });

  // 4. Adjustments History
  const adjParams = {
    page: adjPage,
    pageSize: adjPageSize,
    search: adjSearch || undefined,
    fromDate: filters.dateFrom,
    toDate: filters.dateTo,
  };

  const { data: adjData, isLoading: adjLoading } = useQuery({
    queryKey: ['inventory-adjustments', adjParams],
    queryFn: () => api.getWithMeta<AdjustmentRow[], PageMeta>(`/inventory/adjustments${qs(adjParams)}`),
    enabled: currentTab === 'adjustments',
  });

  // Items search for adjustment modal
  const { data: adjItemCandidates } = useQuery({
    queryKey: ['inventory-adj-candidates', adjItemSearch],
    queryFn: () => api.getWithMeta<StockRow[], PageMeta>(`/inventory/stock?search=${encodeURIComponent(adjItemSearch)}&pageSize=10`),
    enabled: isAdjModalOpen && adjItemSearch.length >= 2,
  });

  // The book stock the count is posted against: the item's ERP stock, read fresh whenever the
  // modal opens on an item, from whichever screen. A category workspace passed its own sheet
  // figure instead, so the modal showed 6 as the book stock while the server posted against 26,
  // and the pre-filled count took the stock from 26 to 6 (E2E S5-18). Read from the very row the
  // count is posted against, active or not: the stock register lists active items only, and a
  // workspace row of an inactive item could not be counted at all (T2 review).
  const adjItemId = isAdjModalOpen ? selectedAdjItem?.id : undefined;
  const adjBookQuery = useQuery({
    queryKey: ['inventory-adj-book-stock', adjItemId],
    queryFn: () => api.get<BookStock>(`/inventory/adjustments/book-stock/${adjItemId}`),
    enabled: adjItemId !== undefined,
    // Never an earlier read: a count reopened later must not be pre-filled with an old figure.
    staleTime: 0,
    gcTime: 0,
  });
  const adjBookStock = adjBookQuery.data ? Number(adjBookQuery.data.live_stock_qty || 0) : null;

  // Pre-fill the count with the book stock once it is known, and again whenever it is read anew
  // while the counter has typed nothing; a typed figure is never overwritten.
  useEffect(() => {
    if (adjItemId === undefined) return;
    setAdjActualCount((c) => countAfterBookRead(c, adjCountTyped, adjBookStock));
  }, [adjItemId, adjBookStock, adjCountTyped]);

  // 5. Requisition Queue
  const { data: reqQueueData, isLoading: reqQueueLoading } = useQuery({
    queryKey: ['inventory-requisition-queue'],
    queryFn: () => api.get<RequisitionQueueRow[]>('/inventory/requisition-queue'),
    enabled: currentTab === 'requisition-queue',
  });

  // 6. Auto Indent
  const indentParams = {
    page: filters.page ?? indentPage,
    pageSize: filters.pageSize ?? indentPageSize,
    search: (filters.search as string) || indentSearch || undefined,
    status: indentStatusFilter || undefined,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    userId: filters.userId,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    itemId: filters.itemId,
    hodId: filters.hodId,
  };

  const { data: autoIndentData, isLoading: autoIndentLoading } = useQuery({
    queryKey: ['auto-indents', indentParams],
    queryFn: () => api.getWithMeta<AutoIndentRow[], PageMeta & { totals?: { totalQty: number } }>(`/inventory/auto-indents${qs(indentParams)}`),
    enabled: currentTab === 'auto-indent',
  });

  const { data: autoIndentStats } = useQuery({
    queryKey: ['auto-indents-stats'],
    queryFn: () => api.get<AutoIndentStats>('/inventory/auto-indents/stats'),
  });

  /* ── Mutations ──────────────────────────────────────────────────────────── */

  // Stock Adjustment Submit
  const adjustmentMutation = useMutation({
    mutationFn: (payload: {
      itemId: number; actualStockQty: number; expectedSystemQty: number; reason: string; findings: string; remarks: string;
    }) =>
      api.post<{ adjustmentNo: string; deltaQty: string; message: string }>('/inventory/adjustments', payload),
    onSuccess: (res) => {
      toast.success(res.message);
      setIsAdjModalOpen(false);
      setSelectedAdjItem(null);
      setAdjActualCount('');
      setAdjFindings('');
      setAdjRemarks('');
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
      void qc.invalidateQueries({ queryKey: ['inventory-adjustments'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => {
      toast.fromError(err, 'Failed to post physical stock adjustment');
      // A count refused because the book stock moved since it was read: the modal says so and
      // reads the figure again, and an untouched count follows it (countAfterBookRead).
      if (err instanceof ApiError && err.status === 409 && err.details?.bookStock !== undefined) {
        setAdjRefused({ shown: Number(err.details.shown), bookStock: Number(err.details.bookStock) });
      }
      void qc.invalidateQueries({ queryKey: ['inventory-adj-book-stock'] });
    },
  });

  // Stock Adjustment Reverse — undoes the count through its own reversal ledger entry
  const reverseAdjMutation = useMutation({
    mutationFn: ({ id, reason }: { id: number; reason: string }) =>
      api.post<{ message: string }>(`/inventory/adjustments/${id}/reverse`, { reason }),
    onSuccess: (res) => {
      toast.success(res.message);
      setReversingAdj(null);
      setReverseReason('');
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-ledger'] });
      void qc.invalidateQueries({ queryKey: ['inventory-adjustments'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to reverse the adjustment'),
  });

  // Auto Indent Scan
  const generateMutation = useMutation({
    mutationFn: () => api.post<{ candidates: number; generated: number; message: string }>('/inventory/auto-indent/generate'),
    onSuccess: (res) => {
      toast.success(res.message);
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
      setTab('auto-indent');
    },
    onError: (err) => toast.fromError(err, 'Failed to scan inventory for auto-indent'),
  });

  // Auto Indent Approve
  const approveMutation = useMutation({
    mutationFn: (id: number) => api.post(`/inventory/auto-indents/${id}/approve`, {}),
    onSuccess: () => {
      toast.success('Auto indent approved successfully.');
      void qc.invalidateQueries({ queryKey: ['auto-indents'] });
      void qc.invalidateQueries({ queryKey: ['auto-indents-stats'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to approve auto indent'),
  });

  // Auto Indent Reject
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

  // Auto Indent Convert
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

  // Sync All 5 Google Sheets
  const syncAllMutation = useMutation({
    mutationFn: () => api.post<Array<Parameters<typeof describeSync>[0]>>('/inventory/sync-all', {}),
    onSuccess: (results) => {
      const notDone = results.filter((r) => r.status !== 'SUCCESS');
      if (notDone.length === 0) {
        toast.success(`All 5 Google Sheets synced. ${results.map(describeSync).join(' ')}`);
      } else {
        toast.error(
          `${notDone.map((r) => r.category).join(', ')} not fully synced: ` +
          notDone.map((r) => r.errorMessage ?? r.status).join(' ') +
          (results.length > notDone.length ? ` The others synced: ${results.filter((r) => r.status === 'SUCCESS').map(describeSync).join(' ')}` : ''),
        );
      }
      void qc.invalidateQueries({ queryKey: ['inventory-overview'] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-summary'] });
      void qc.invalidateQueries({ queryKey: ['inventory-category-items'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to synchronize all Google Sheets'),
  });

  /* ── Export Handlers ────────────────────────────────────────────────────── */

  const exportStockCsv = async () => {
    try {
      // The list's own parameters: the file dropped its department, group, item and HOD filters.
      const q = qs({ ...stockParams, page: undefined, pageSize: undefined });
      await downloadFile(`/inventory/stock/export${q}`, `inventory_stock_register_${stockCategory.toLowerCase()}.csv`);
      toast.success('Inventory stock register exported successfully.');
    } catch (err) {
      toast.fromError(err, 'Failed to export stock CSV');
    }
  };

  const exportLedgerCsv = async () => {
    try {
      // The list's own parameters: the file dropped the date range (2026-10-16 audit, F06).
      const q = qs({ ...ledgerParams, page: undefined, pageSize: undefined });
      await downloadFile(`/inventory/ledger/export${q}`, 'stock_movement_ledger.csv');
      toast.success('Movement ledger exported successfully.');
    } catch (err) {
      toast.fromError(err, 'Failed to export ledger CSV');
    }
  };

  /* ── Stock Adjustment Helper ────────────────────────────────────────────── */

  /** The item counted: its count starts untouched, pre-filled with its book stock once loaded. */
  const chooseAdjItem = (item: NonNullable<typeof selectedAdjItem>) => {
    setSelectedAdjItem(item);
    setAdjActualCount('');
    setAdjCountTyped(false);
    setAdjRefused(null);
  };

  const openAdjustment = (item: NonNullable<typeof selectedAdjItem>) => {
    chooseAdjItem(item);
    setAdjReason('Cycle Count Reconciliation');
    setAdjFindings('');
    setAdjRemarks('');
    setIsAdjModalOpen(true);
  };

  const openAdjustmentForItem = (r: StockRow) =>
    openAdjustment({ id: r.item_id, code: r.item_code, description: r.item_description, category: r.category, uom: r.uom_code });

  const computedDelta = useMemo(() => {
    if (adjBookStock === null || adjActualCount === '') return 0;
    const actual = Number(adjActualCount);
    if (isNaN(actual)) return 0;
    return actual - adjBookStock;
  }, [adjBookStock, adjActualCount]);

  /* ── Tab Columns ────────────────────────────────────────────────────────── */

  // 1. Stock Register Columns
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
          <div className="row" style={{ gap: 6, marginTop: 2, alignItems: 'center' }}>
            <Badge tone={CATEGORY_TONES[r.category] || 'neutral'} plain>
              {r.category || 'GENERAL'}
            </Badge>
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
              {[r.main_group_name, r.item_type_name].filter(Boolean).join(' • ')}
            </span>
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
      width: '70px',
      render: (r) => <Badge tone="neutral" plain>{toShortUom(r.uom_code)}</Badge>,
    },
    {
      key: 'available_stock',
      header: 'Usable / Physical Stock',
      align: 'right',
      render: (r) => {
        const physical = Number(r.live_stock_qty || 0);
        const usable = Number(r.available_stock_qty || 0);
        const allocated = Number(r.allocated_stock_qty || 0);
        const qcPending = Number(r.qc_pending_stock_qty || 0);
        return (
          <div>
            <div className="num cell-strong" style={{ color: usable <= 0 ? 'var(--danger-600)' : 'inherit' }}>
              {qty(r.available_stock_qty)}
            </div>
            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
              <span>{qty(physical)} phys</span>
              {allocated > 0 && <span style={{ color: 'var(--warning-600)', marginLeft: 4 }}>• {qty(allocated)} rsvd</span>}
              {qcPending > 0 && <span style={{ color: 'var(--brand-600)', marginLeft: 4 }}>• {qty(qcPending)} QC</span>}
            </div>
          </div>
        );
      },
    },
    {
      key: 'valuation',
      header: 'Valuation',
      align: 'right',
      render: (r) => (
        <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
          <div>{money(r.stock_valuation)}</div>
          <div style={{ color: 'var(--text-faint)', fontSize: 'var(--text-2xs)' }}>@{money(r.standard_rate)}</div>
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
        if (r.stock_status === 'CRITICAL') return <Badge tone="danger">Critical / Low</Badge>;
        if (r.stock_status === 'BELOW_REORDER') return <Badge tone="warning">Below Reorder</Badge>;
        if (r.stock_status === 'EXCESS') return <Badge tone="info">Excess Stock</Badge>;
        return <Badge tone="success">Healthy</Badge>;
      },
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      locked: true,
      render: (r) =>
        can('inventory.adjust') ? (
          <Button
            variant="ghost"
            size="sm"
            icon={<ClipboardCheck size={13} />}
            onClick={() => openAdjustmentForItem(r)}
            title="Perform physical count adjustment"
          >
            Adjust
          </Button>
        ) : null,
    },
  ];

  // 2. Movement Ledger Columns
  const ledgerColumns: Column<LedgerRow>[] = [
    {
      key: 'txn_date',
      header: 'Date & Time',
      width: '130px',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div className="cell-strong">{formatDate(r.txn_date)}</div>
          <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>
            {new Date(r.created_at).toLocaleTimeString('en-IN', { hour12: false })}
          </div>
        </div>
      ),
    },
    {
      key: 'item_code',
      header: 'Item',
      render: (r) => (
        <div>
          <span className="cell-code font-medium">{r.item_code}</span>
          <div className="cell-strong" style={{ fontSize: 'var(--text-xs)' }}>{r.item_description}</div>
          <Badge tone={CATEGORY_TONES[r.category] || 'neutral'} plain>
            {r.category || 'GENERAL'}
          </Badge>
        </div>
      ),
    },
    {
      key: 'txn_type',
      header: 'Movement Type',
      align: 'center',
      // Every ledger type in words (lib/status.ts): four were mapped and the rest showed raw codes (E2E S5-15b).
      render: (r) => <MovementChip type={r.txn_type} direction={Number(r.inward_qty || 0) > 0 ? 'IN' : 'OUT'} />,
    },
    {
      key: 'reference_no',
      header: 'Reference Doc',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <span className="cell-code">{r.reference_no || '—'}</span>
          <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>{r.reference_type}</div>
        </div>
      ),
    },
    {
      key: 'inward_qty',
      header: 'Inward',
      align: 'right',
      render: (r) => {
        const val = Number(r.inward_qty || 0);
        return val > 0 ? (
          <span className="num cell-strong" style={{ color: 'var(--success-600)' }}>
            +{qty(val)}
          </span>
        ) : (
          <span className="cell-muted">—</span>
        );
      },
    },
    {
      key: 'outward_qty',
      header: 'Outward',
      align: 'right',
      render: (r) => {
        const val = Number(r.outward_qty || 0);
        return val > 0 ? (
          <span className="num cell-strong" style={{ color: 'var(--danger-600)' }}>
            -{qty(val)}
          </span>
        ) : (
          <span className="cell-muted">—</span>
        );
      },
    },
    {
      key: 'balance_qty',
      header: 'Balance Stock',
      align: 'right',
      render: (r) => (
        <span className="num cell-strong" style={{ fontSize: 'var(--text-sm)' }}>
          {qty(r.balance_qty)} <span style={{ fontSize: '10px', color: 'var(--text-faint)' }}>{toShortUom(r.uom_code)}</span>
        </span>
      ),
    },
    {
      key: 'created_by_name',
      header: 'Recorded By',
      render: (r) => <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>{r.created_by_name || 'System'}</span>,
    },
  ];

  // 3. Stock Adjustments Columns
  const adjColumns: Column<AdjustmentRow>[] = [
    {
      key: 'adjustment_no',
      header: 'Adjustment No',
      render: (r) => (
        <div>
          <span className="cell-code font-medium">{r.adjustment_no}</span>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{formatDate(r.adjustment_date)}</div>
        </div>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      render: (r) => (
        <div>
          <div className="cell-strong">{r.item_code}</div>
          <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.item_description}</div>
          <Badge tone={CATEGORY_TONES[r.category] || 'neutral'} plain>
            {r.category}
          </Badge>
        </div>
      ),
    },
    {
      key: 'system_stock_qty',
      header: 'System Stock',
      align: 'right',
      render: (r) => <span className="num">{qty(r.system_stock_qty)}</span>,
    },
    {
      key: 'actual_stock_qty',
      header: 'Actual Count',
      align: 'right',
      render: (r) => <span className="num cell-strong">{qty(r.actual_stock_qty)}</span>,
    },
    {
      key: 'adjustment_qty',
      header: 'Variance (Delta)',
      align: 'right',
      render: (r) => {
        const delta = Number(r.adjustment_qty || 0);
        const isPositive = delta > 0;
        return (
          <span
            className="num cell-strong"
            style={{ color: isPositive ? 'var(--success-600)' : delta < 0 ? 'var(--danger-600)' : 'inherit' }}
          >
            {isPositive ? `+${qty(delta)}` : qty(delta)}
          </span>
        );
      },
    },
    {
      key: 'reason',
      header: 'Reason & Findings',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div className="cell-strong">{r.reason}</div>
          {r.findings && <div style={{ color: 'var(--text-faint)' }}>{r.findings}</div>}
        </div>
      ),
    },
    {
      key: 'approver_name',
      header: 'Auditor / Approver',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div>{r.approver_name || r.created_by_name}</div>
          <div style={{ color: 'var(--text-faint)', fontSize: '10px' }}>{formatDateTime(r.created_at)}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (r) =>
        r.reversed_at ? (
          <div style={{ fontSize: 'var(--text-xs)' }}>
            <Badge tone="neutral">Reversed</Badge>
            {r.reversal_reason && <div style={{ color: 'var(--text-faint)', marginTop: 2 }}>{r.reversal_reason}</div>}
          </div>
        ) : can('inventory.adjust') ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReversingAdj(r);
              setReverseReason('');
            }}
          >
            Reverse
          </Button>
        ) : (
          <Badge tone="success">Posted</Badge>
        ),
    },
  ];

  // 4. Requisition Queue Columns
  const reqQueueColumns: Column<RequisitionQueueRow>[] = [
    {
      key: 'requisition_no',
      header: 'Requisition',
      render: (r) => (
        <div>
          <Link to={`/requisitions/${r.requisition_id}`} className="cell-code font-medium hover:underline">
            {r.requisition_no}
          </Link>
          <div style={{ fontSize: '10px', color: 'var(--text-faint)' }}>{formatDate(r.requisition_date)}</div>
        </div>
      ),
    },
    {
      key: 'requester_name',
      header: 'Requester / Dept',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div className="cell-strong">{r.requester_name}</div>
          <div style={{ color: 'var(--text-faint)' }}>{[r.department_name, r.cost_centre_name].filter(Boolean).join(' • ')}</div>
        </div>
      ),
    },
    {
      key: 'item',
      header: 'Item',
      render: (r) => (
        <div>
          <span className="cell-code">{r.item_code}</span>
          <div className="cell-strong" style={{ fontSize: 'var(--text-xs)' }}>{r.item_description}</div>
          <Badge tone={CATEGORY_TONES[r.category] || 'neutral'} plain>
            {r.category}
          </Badge>
        </div>
      ),
    },
    {
      key: 'requested_qty',
      header: 'Requested',
      align: 'right',
      render: (r) => <span className="num">{qty(r.requested_qty)} {toShortUom(r.uom_code)}</span>,
    },
    {
      key: 'issued_qty',
      header: 'Issued',
      align: 'right',
      render: (r) => <span className="num">{qty(r.issued_qty)}</span>,
    },
    {
      key: 'balance_to_issue',
      header: 'Balance to Issue',
      align: 'right',
      render: (r) => (
        <span className="num cell-strong" style={{ color: 'var(--brand-700)', fontSize: 'var(--text-sm)' }}>
          {qty(r.balance_to_issue)} {toShortUom(r.uom_code)}
        </span>
      ),
    },
    {
      key: 'available_stock',
      header: 'Available Stock',
      align: 'right',
      render: (r) => {
        const avail = Number(r.available_stock_qty || 0);
        const bal = Number(r.balance_to_issue || 0);
        const hasEnough = avail >= bal;
        return (
          <div className="num">
            <div style={{ color: hasEnough ? 'var(--success-600)' : 'var(--danger-600)', fontWeight: 600 }}>
              {qty(r.available_stock_qty)}
            </div>
            <div style={{ fontSize: '10px', color: 'var(--text-faint)' }}>
              {hasEnough ? 'Sufficient' : 'Shortage'}
            </div>
          </div>
        );
      },
    },
    {
      key: 'actions',
      header: 'Action',
      align: 'right',
      locked: true,
      render: (r) => (
        <Link to={`/requisitions/${r.requisition_id}`}>
          <Button variant="primary" size="sm" icon={<PackageSearch size={13} />}>
            Issue
          </Button>
        </Link>
      ),
    },
  ];

  // 5. Auto Indents Columns
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
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>Reorder: {qty(r.reorder_level)}</div>
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
          // The indent it became, by its number. The link read generated_indent_id, a column the
          // API does not send, and opened /indents/undefined (E2E S5-11b).
          return (
            <div style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
              <StatusBadge status="CONVERTED" />
              {r.indent_id !== null ? (
                <Link to={`/indents/${r.indent_id}`} className="cell-code">{r.indent_no || `Indent ${r.indent_id}`}</Link>
              ) : (
                <span className="cell-muted" title="The indent it became has since been deleted">{r.indent_no || 'Indent deleted'}</span>
              )}
            </div>
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
          {r.rejection_reason && <div style={{ color: 'var(--danger-600)', marginTop: 2 }}>{r.rejection_reason}</div>}
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
          return r.indent_id !== null ? (
            <Link to={`/indents/${r.indent_id}`} className="btn btn-ghost btn-sm">
              <FileText size={13} aria-hidden /> View Indent
            </Link>
          ) : null;
        }

        if (r.status === 'REJECTED') {
          return <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>Closed</span>;
        }

        return (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
            {/* Two open suggestions for one shortage (left by scans before the fix of E2E S5-13b):
                neither is approved further nor converted until one is rejected, and Reject is
                offered on both, also once approved (T2 review). */}
            {r.open_duplicate_id !== null && (
              <span className="cell-muted" style={{ fontSize: 'var(--text-xs)', flexBasis: '100%', textAlign: 'right' }}>
                No. {r.id}: no. {r.open_duplicate_id} ({statusMeta(r.open_duplicate_status).label.toLowerCase()}) is open for
                the same item. Reject one of the two.
              </span>
            )}
            {/* The server's own rules for this user and row: a store user approves a pending
                suggestion, not one the store already approved, which the server refused (E2E S5-09b). */}
            {r.can_approve && (
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

            {r.can_reject && (
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

            {r.can_convert && (
              <Button
                variant="primary"
                size="sm"
                icon={<ArrowRight size={13} />}
                loading={convertMutation.isPending}
                onClick={() => convertMutation.mutate(r.id)}
              >
                Convert to Indent
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  /* ── Render ─────────────────────────────────────────────────────────────── */

  return (
    <div>
      <PageHeader
        title={PAGE_INFO[currentTab]?.title || 'Inventory Management'}
        subtitle={PAGE_INFO[currentTab]?.subtitle || 'Operational material management'}
        actions={
          <div className="row" style={{ gap: 'var(--sp-2)' }}>
            {currentTab === 'overview' && can('inventory.adjust') && (
              <Button
                variant="primary"
                size="sm"
                icon={<RefreshCw size={14} className={syncAllMutation.isPending ? 'spin' : ''} />}
                loading={syncAllMutation.isPending}
                onClick={() => syncAllMutation.mutate()}
              >
                Sync All 5 Google Sheets
              </Button>
            )}

            {currentTab === 'stock' && can('inventory.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={() => void exportStockCsv()}>
                Export Register CSV
              </Button>
            )}

            {currentTab === 'ledger' && can('inventory.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={14} />} onClick={() => void exportLedgerCsv()}>
                Export Ledger CSV
              </Button>
            )}

            {currentTab === 'adjustments' && can('inventory.adjust') && (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus size={14} />}
                onClick={() => {
                  setSelectedAdjItem(null);
                  setAdjItemSearch('');
                  setAdjActualCount('');
                  setIsAdjModalOpen(true);
                }}
              >
                Record Physical Count Adjustment
              </Button>
            )}

            {currentTab === 'auto-indent' && can('auto_indent.config') && (
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

      {/* ── 1. OVERVIEW & ANALYTICS TAB ────────────────────────────────────────── */}
      {currentTab === 'overview' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
          {/* Top KPI Cards (All Clickable) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--sp-3)',
            }}
          >
            <StatTile
              label="Total Stock Valuation"
              value={moneyCompact(overviewData?.kpis?.totalValuation ?? 0)}
              sub={`Exact: ${money(overviewData?.kpis?.totalValuation ?? 0)}`}
              tone="default"
              onClick={() => setTab('stock')}
            />
            <StatTile
              label="Total Active Items"
              value={count(overviewData?.kpis?.totalItems ?? 0)}
              sub={`${count(overviewData?.kpis?.totalStockQty ?? 0)} total units in view`}
              onClick={() => setTab('stock')}
            />
            <StatTile
              label="Critical / Zero Stock"
              value={count(overviewData?.kpis?.criticalStock ?? 0)}
              tone="danger"
              sub="Immediate replenishment required"
              onClick={() => {
                setStockStatusFilter('CRITICAL');
                setTab('stock');
              }}
            />
            <StatTile
              label="Below Reorder Level"
              value={count(overviewData?.kpis?.belowReorder ?? 0)}
              tone="warning"
              sub="Reorder threshold reached"
              onClick={() => {
                setStockStatusFilter('BELOW_REORDER');
                setTab('stock');
              }}
            />
            <StatTile
              label="Healthy Stock"
              value={count(overviewData?.kpis?.normalStock ?? 0)}
              tone="success"
              sub="Normal buffer maintained"
              onClick={() => {
                setStockStatusFilter('NORMAL');
                setTab('stock');
              }}
            />
            <StatTile
              label="Excess Stock Items"
              value={count(overviewData?.kpis?.excessStock ?? 0)}
              tone="info"
              sub="Above maximum inventory limit"
              onClick={() => {
                setStockStatusFilter('EXCESS');
                setTab('stock');
              }}
            />
          </div>

          {/* Operational Pipeline & Day Movements (Clickable Drilldown) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
              gap: 'var(--sp-3)',
            }}
          >
            <Card
              className="card-clickable"
              onClick={() => setTab('requisition-queue')}
              style={{ cursor: 'pointer' }}
              title="Click to view Store Requisition Queue"
            >
              <CardBody>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Material to Issue (Store Queue)</div>
                <div className="num cell-strong" style={{ fontSize: 'var(--text-xl)', marginTop: 4, color: 'var(--brand-700)' }}>
                  {count(overviewData?.kpis?.pendingRequisitionsCount ?? 0)} Requisitions
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                  {qty(overviewData?.kpis?.pendingRequisitionsQty ?? 0)} total units awaiting issue →
                </div>
              </CardBody>
            </Card>

            <Card
              className="card-clickable"
              onClick={() => navigate('/purchase-orders')}
              style={{ cursor: 'pointer' }}
              title="Click to view Purchase Orders pipeline"
            >
              <CardBody>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Pipeline POs (Awaiting GRN)</div>
                <div className="num cell-strong" style={{ fontSize: 'var(--text-xl)', marginTop: 4, color: 'var(--brand-600)' }}>
                  {count(overviewData?.kpis?.pendingPosCount ?? 0)} Purchase Orders
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                  {qty(overviewData?.kpis?.pendingPosQty ?? 0)} units expected from suppliers →
                </div>
              </CardBody>
            </Card>

            <Card
              className="card-clickable"
              onClick={() => {
                setLedgerTxnType('GRN_INWARD');
                setTab('ledger');
              }}
              style={{ cursor: 'pointer' }}
              title="Click to view today's inward receipts in ledger"
            >
              <CardBody>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Today's Inward Receipts</div>
                <div className="num cell-strong" style={{ fontSize: 'var(--text-xl)', marginTop: 4, color: 'var(--success-600)' }}>
                  +{qty(overviewData?.kpis?.todayInwardQty ?? 0)}
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                  Goods receipt receipts posted today →
                </div>
              </CardBody>
            </Card>

            <Card
              className="card-clickable"
              onClick={() => {
                setLedgerTxnType('REQUISITION_ISSUE');
                setTab('ledger');
              }}
              style={{ cursor: 'pointer' }}
              title="Click to view today's outward issues in ledger"
            >
              <CardBody>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Today's Outward Issues</div>
                <div className="num cell-strong" style={{ fontSize: 'var(--text-xl)', marginTop: 4, color: 'var(--danger-600)' }}>
                  -{qty(overviewData?.kpis?.todayOutwardQty ?? 0)}
                </div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                  Material issued against requisitions / direct issues →
                </div>
              </CardBody>
            </Card>
          </div>

          {/* Distinct Units of Measurement Summary (Never Mix Unrelated Units) */}
          {overviewData?.unitsSummary && overviewData.unitsSummary.length > 0 && (
            <Card>
              <CardBody style={{ padding: 'var(--sp-2) var(--sp-4)' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--sp-2)' }}>
                  <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                    Physical Stock Distribution by Measurement Unit (UOM)
                  </div>
                  <div style={{ display: 'flex', gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
                    {overviewData.unitsSummary.map((u) => (
                      <div
                        key={u.primary_uom}
                        style={{
                          fontSize: 'var(--text-xs)',
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 8px',
                          borderRadius: 'var(--radius-sm)',
                          backgroundColor: 'var(--surface-muted)',
                          border: '1px solid var(--border-subtle)',
                        }}
                      >
                        <Badge tone="neutral" plain>{toShortUom(u.primary_uom)}</Badge>
                        <strong className="num">{qty(u.total_qty)}</strong>
                        <span style={{ color: 'var(--text-faint)', fontSize: '10px' }}>({count(u.item_count)} items)</span>
                      </div>
                    ))}
                  </div>
                </div>
              </CardBody>
            </Card>
          )}

          {/* Category Breakdown Cards (Clickable Direct Access) */}
          <Card>
            <CardHeader
              title="Inventory Category Portfolios"
              subtitle="Click any category to open its full workspace with Google Sheet tabs, live stock, and transaction registers"
            />
            <CardBody>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))',
                  gap: 'var(--sp-3)',
                }}
              >
                {(overviewData?.categoryBreakdown || []).map((cat) => (
                  <div
                    key={cat.category}
                    onClick={() => setTab(cat.category.toLowerCase())}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') setTab(cat.category.toLowerCase());
                    }}
                    style={{
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      padding: 'var(--sp-3)',
                      backgroundColor: 'var(--surface-muted)',
                      display: 'flex',
                      flexDirection: 'column',
                      justifyContent: 'space-between',
                      cursor: 'pointer',
                      transition: 'all 0.15s ease',
                    }}
                    onMouseEnter={(e) => {
                      e.currentTarget.style.borderColor = 'var(--brand-500)';
                      e.currentTarget.style.transform = 'translateY(-2px)';
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.borderColor = 'var(--border-subtle)';
                      e.currentTarget.style.transform = 'none';
                    }}
                    title={`Click to open ${cat.category} workspace`}
                  >
                    <div>
                      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                        <Badge tone={CATEGORY_TONES[cat.category] || 'neutral'}>{cat.category}</Badge>
                        <span className="num cell-strong" style={{ fontSize: 'var(--text-xs)' }}>
                          {count(cat.item_count)} items
                        </span>
                      </div>
                      <div className="cell-strong" style={{ marginTop: 8, fontSize: 'var(--text-md)' }}>
                        {CATEGORY_NAMES[cat.category] || cat.category}
                      </div>
                      <div className="num" style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--brand-800)', marginTop: 4 }}>
                        {money(cat.valuation)}
                      </div>
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                        {cat.category === 'RM' || cat.category === 'FG' || cat.category === 'WIP' ? (
                          cat.weight_ton ? `${qty(cat.weight_ton)} Ton (${qty(cat.total_weight_kg || cat.stock_qty)} Kg)` : `${qty(cat.stock_qty)} Kg`
                        ) : (
                          `Stock: ${qty(cat.stock_qty)} units`
                        )}
                      </div>
                      <div className="row" style={{ gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
                        {cat.sheet_items_count !== undefined && (
                          <span style={{ fontSize: '10px', color: 'var(--text-muted)' }}>
                            ✓ {count(cat.sheet_items_count)} sheet
                          </span>
                        )}
                        {cat.critical_count > 0 && (
                          <span style={{ fontSize: '10px', color: 'var(--danger-700)', fontWeight: 600 }}>
                            ⚠ {count(cat.critical_count)} critical
                          </span>
                        )}
                        {cat.quarantined_count !== undefined && cat.quarantined_count > 0 && (
                          <span style={{ fontSize: '10px', color: 'var(--warning-700)', fontWeight: 600 }}>
                            🛡 {count(cat.quarantined_count)} quarantined
                          </span>
                        )}
                      </div>
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--brand-600)', marginTop: 10, fontWeight: 500 }}>
                      Open Workspace →
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          {/* Recent 10 Movements Table */}
          <Card>
            <CardHeader
              title="Recent Stock Activity"
              subtitle="Live stream of recent inward receipts, outward store issues, and physical count reconciliations"
              actions={
                <Button variant="ghost" size="sm" onClick={() => setTab('ledger')}>
                  View Full Movement Ledger →
                </Button>
              }
            />
            <CardBody flush>
              <DataTable
                columns={ledgerColumns}
                rows={overviewData?.recentMovements || []}
                rowKey={(r) => r.id}
                loading={overviewLoading}
                emptyTitle="No recent movements recorded"
              />
            </CardBody>
          </Card>
        </div>
      )}

      {/* ── CATEGORY WORKSPACES (RM, FG, WIP, TRADING, GENERAL) ───────────── */}
      {['rm', 'fg', 'wip', 'trading', 'general'].includes(currentTab) && (
        <CategoryWorkspaceView
          category={currentTab.toUpperCase() as InventoryCategoryKey}
          onOpenAdjustment={(item) => openAdjustment({
            id: item.id,
            code: item.code,
            description: item.description,
            category: item.category,
            uom: item.uom,
            sheetStock: item.sheetStock,
          })}
        />
      )}

      {/* ── 2. STOCK REGISTER TAB ──────────────────────────────────────────────── */}
      {currentTab === 'stock' && (
        <>
          {/* Category Switcher Pills */}
          <div className="row" style={{ gap: 'var(--sp-2)', marginBottom: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {['ALL', 'GENERAL', 'RM', 'FG', 'TRADING', 'WIP'].map((catKey) => {
              const isActive = stockCategory === catKey;
              const catCounts = stockData?.meta?.summary?.categories;
              const countVal = catKey === 'ALL' ? stockData?.meta?.summary?.totalActive : catCounts?.[catKey as keyof typeof catCounts];
              return (
                <button
                  key={catKey}
                  type="button"
                  onClick={() => {
                    setStockCategory(catKey);
                    setStockPage(1);
                  }}
                  style={{
                    padding: '6px 14px',
                    borderRadius: 'var(--radius-pill)',
                    border: isActive ? '1px solid var(--brand-600)' : '1px solid var(--border-subtle)',
                    backgroundColor: isActive ? 'var(--brand-600)' : 'var(--surface)',
                    color: isActive ? '#fff' : 'var(--text)',
                    fontWeight: isActive ? 600 : 500,
                    fontSize: 'var(--text-xs)',
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                  }}
                >
                  <span>{CATEGORY_NAMES[catKey] || catKey}</span>
                  {countVal !== undefined && (
                    <span
                      style={{
                        fontSize: '10px',
                        padding: '1px 5px',
                        borderRadius: 10,
                        backgroundColor: isActive ? 'rgba(255,255,255,0.25)' : 'var(--surface-muted)',
                      }}
                    >
                      {count(countVal)}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Stat Tiles (Clickable Filters) */}
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            <StatTile
              label="Active Items in View"
              value={count(stockData?.meta?.summary?.totalActive ?? stockData?.meta?.total ?? 0)}
              onClick={() => {
                setStockStatusFilter('ALL');
                setStockSearch('');
                setStockPage(1);
              }}
            />
            <StatTile
              label="Total Valuation (View)"
              value={moneyCompact(stockData?.meta?.summary?.totalValuation ?? 0)}
              sub={`Exact: ${money(stockData?.meta?.summary?.totalValuation ?? 0)}`}
              tone="default"
              onClick={() => {
                setStockStatusFilter('NORMAL');
                setStockPage(1);
              }}
            />
            <StatTile
              label="Critical / Zero Stock"
              value={count(stockData?.meta?.summary?.criticalStock ?? 0)}
              tone="danger"
              onClick={() => {
                setStockStatusFilter('CRITICAL');
                setStockPage(1);
              }}
            />
            <StatTile
              label="Below Reorder Level"
              value={count(stockData?.meta?.summary?.belowReorder ?? 0)}
              tone="warning"
              onClick={() => {
                setStockStatusFilter('BELOW_REORDER');
                setStockPage(1);
              }}
            />
            <StatTile
              label="Excess Stock Items"
              value={count(stockData?.meta?.summary?.excessStock ?? 0)}
              tone="info"
              onClick={() => {
                setStockStatusFilter('EXCESS');
                setStockPage(1);
              }}
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
              title={`${CATEGORY_NAMES[stockCategory] || stockCategory} Stock Register`}
              subtitle="Physical count, available stock, reservation buffers, pipeline replenishment, and standard valuations"
              actions={
                <div className="row" style={{ gap: 'var(--sp-2)' }}>
                  <Select
                    value={stockStatusFilter}
                    onChange={(e) => {
                      setStockStatusFilter(e.target.value);
                      setStockPage(1);
                    }}
                    style={{ width: 175 }}
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
                rows={stockData?.data || []}
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
                emptyTitle="No items match your criteria"
                emptyMessage="All items in this category match stock thresholds or no records correspond to search."
              />
            </CardBody>
          </Card>
        </>
      )}

      {/* ── 3. MOVEMENT LEDGER TAB ─────────────────────────────────────────────── */}
      {currentTab === 'ledger' && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            <StatTile
              label="Total Movement Entries"
              value={count(ledgerData?.meta?.summary?.totalMovements ?? 0)}
              onClick={() => {
                setLedgerTxnType('');
                setLedgerCategory('ALL');
                setLedgerPage(1);
              }}
            />
            <StatTile
              label="Total Inward Quantity"
              value={qty(ledgerData?.meta?.summary?.totalInward ?? 0)}
              tone="success"
              sub="GRN receipts & positive stock audits"
              onClick={() => {
                setLedgerTxnType('GRN_INWARD');
                setLedgerPage(1);
              }}
            />
            <StatTile
              label="Total Outward Quantity"
              value={qty(ledgerData?.meta?.summary?.totalOutward ?? 0)}
              tone="warning"
              sub="Requisition issues & store issues"
              onClick={() => {
                setLedgerTxnType('REQUISITION_ISSUE');
                setLedgerPage(1);
              }}
            />
          </div>

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              clearFilters={clearFilters}
              activeCount={activeCount}
              show={['dateRange']}
            />
          </div>

          <Card>
            <CardHeader
              title="Stock Movement Ledger"
              subtitle="Full chronological transaction history with reference documents and running balances"
              actions={
                <div className="row" style={{ gap: 'var(--sp-2)' }}>
                  <Select
                    value={ledgerCategory}
                    onChange={(e) => {
                      setLedgerCategory(e.target.value);
                      setLedgerPage(1);
                    }}
                    style={{ width: 160 }}
                  >
                    <option value="ALL">All Categories</option>
                    <option value="GENERAL">General Store</option>
                    <option value="RM">Raw Material</option>
                    <option value="FG">Finished Goods</option>
                    <option value="TRADING">Trading</option>
                    <option value="WIP">WIP</option>
                  </Select>

                  <Select
                    value={ledgerTxnType}
                    onChange={(e) => {
                      setLedgerTxnType(e.target.value);
                      setLedgerPage(1);
                    }}
                    style={{ width: 200 }}
                    aria-label="Movement type"
                  >
                    <option value="">All Movement Types</option>
                    {LEDGER_TXN_TYPES.map((t) => (
                      <option key={t} value={t}>{movementMeta(t).label}</option>
                    ))}
                  </Select>
                </div>
              }
            />
            <CardBody flush>
              <DataTable
                columns={ledgerColumns}
                rows={ledgerData?.data || []}
                rowKey={(r) => r.id}
                loading={ledgerLoading}
                search={ledgerSearch}
                onSearchChange={(s) => {
                  setLedgerSearch(s);
                  setLedgerPage(1);
                }}
                searchPlaceholder="Search item code, description, doc ref…"
                meta={ledgerData?.meta}
                onPageChange={setLedgerPage}
                onPageSizeChange={setLedgerPageSize}
                emptyTitle="No stock movements found"
                emptyMessage="No stock movements match the selected filters or date period."
              />
            </CardBody>
          </Card>
        </>
      )}

      {/* ── 4. PHYSICAL STOCK ADJUSTMENTS TAB ─────────────────────────────────── */}
      {currentTab === 'adjustments' && (
        <>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
              gap: 'var(--sp-3)',
              marginBottom: 'var(--sp-4)',
            }}
          >
            <StatTile label="Total Adjustments Posted" value={count(adjData?.meta?.total ?? 0)} />
            <StatTile
              label="Physical Count Cycle"
              value="Periodic Audit"
              tone="default"
              sub="Audited stock reconciliation"
            />
          </div>

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              clearFilters={clearFilters}
              activeCount={activeCount}
              show={['dateRange']}
            />
          </div>

          <Card>
            <CardHeader
              title="Physical Stock Count Adjustments"
              subtitle="Audit trail of physical cycle counts, variance deltas, and book stock updates"
              actions={
                can('inventory.adjust') && (
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<Plus size={14} />}
                    onClick={() => {
                      setSelectedAdjItem(null);
                      setAdjItemSearch('');
                      setAdjActualCount('');
                      setIsAdjModalOpen(true);
                    }}
                  >
                    New Stock Adjustment
                  </Button>
                )
              }
            />
            <CardBody flush>
              <DataTable
                columns={adjColumns}
                rows={adjData?.data || []}
                rowKey={(r) => r.id}
                loading={adjLoading}
                search={adjSearch}
                onSearchChange={(s) => {
                  setAdjSearch(s);
                  setAdjPage(1);
                }}
                searchPlaceholder="Search adjustment number, item code, reason…"
                meta={adjData?.meta}
                onPageChange={setAdjPage}
                onPageSizeChange={setAdjPageSize}
                emptyTitle="No stock adjustments found"
                emptyMessage="No physical stock audit adjustments have been posted yet."
              />
            </CardBody>
          </Card>
        </>
      )}

      {/* ── 5. STORE REQUISITION QUEUE TAB ───────────────────────────────────── */}
      {currentTab === 'requisition-queue' && (() => {
        const totalReq = reqQueueData?.length ?? 0;
        const readyReq = (reqQueueData || []).filter((r) => Number(r.available_stock_qty || 0) >= Number(r.balance_to_issue || 0)).length;
        const shortageReq = (reqQueueData || []).filter((r) => Number(r.available_stock_qty || 0) < Number(r.balance_to_issue || 0)).length;

        const filteredQueue = (reqQueueData || []).filter((r) => {
          const matchSearch =
            !reqQueueSearch ||
            r.requisition_no.toLowerCase().includes(reqQueueSearch.toLowerCase()) ||
            r.item_code.toLowerCase().includes(reqQueueSearch.toLowerCase()) ||
            r.item_description.toLowerCase().includes(reqQueueSearch.toLowerCase()) ||
            r.requester_name.toLowerCase().includes(reqQueueSearch.toLowerCase());

          if (!matchSearch) return false;

          const isReady = Number(r.available_stock_qty || 0) >= Number(r.balance_to_issue || 0);
          if (reqStockFilter === 'READY') return isReady;
          if (reqStockFilter === 'SHORTAGE') return !isReady;
          return true;
        });

        return (
          <>
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                gap: 'var(--sp-3)',
                marginBottom: 'var(--sp-4)',
              }}
            >
              <StatTile
                label="Requisition Lines in Queue"
                value={count(totalReq)}
                sub="Approved lines awaiting store issue"
                tone="default"
                onClick={() => setReqStockFilter('ALL')}
              />
              <StatTile
                label="Ready to Issue (Full Stock)"
                value={count(readyReq)}
                tone="success"
                sub="Available in physical store"
                onClick={() => setReqStockFilter('READY')}
              />
              <StatTile
                label="Stock Shortage / Blocked"
                value={count(shortageReq)}
                tone="danger"
                sub="Requires replenishment"
                onClick={() => setReqStockFilter('SHORTAGE')}
              />
            </div>

            <Card>
              <CardHeader
                title="Store Requisition Issue Queue"
                subtitle="Material requisitions approved by Department HODs ready for store issue with live stock check"
                actions={
                  <div className="row" style={{ gap: 'var(--sp-2)' }}>
                    <Select
                      value={reqStockFilter}
                      onChange={(e) => setReqStockFilter(e.target.value as any)}
                      style={{ width: 175 }}
                    >
                      <option value="ALL">All Items in Queue</option>
                      <option value="READY">Ready to Issue (Full Stock)</option>
                      <option value="SHORTAGE">Stock Shortage Only</option>
                    </Select>
                    <Link to="/inventory/direct-issue">
                      <Button variant="secondary" size="sm" icon={<PackageMinus size={14} />}>
                        Direct Issue from Store →
                      </Button>
                    </Link>
                  </div>
                }
              />
              <CardBody flush>
                <DataTable
                  columns={reqQueueColumns}
                  rows={filteredQueue}
                  rowKey={(r) => r.requisition_line_id}
                  loading={reqQueueLoading}
                  search={reqQueueSearch}
                  onSearchChange={setReqQueueSearch}
                  searchPlaceholder="Search requisition no, item, requester…"
                  emptyTitle="No pending requisitions in queue"
                  emptyMessage="All approved store requisitions have been fully issued or none match current filters."
                />
              </CardBody>
            </Card>
          </>
        );
      })()}

      {/* ── 6. AUTO INDENT REPLENISHMENT TAB ──────────────────────────────────── */}
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
            <StatTile
              label="Total Generated"
              value={count(autoIndentStats?.total ?? 0)}
              onClick={() => setIndentStatusFilter('')}
            />
            <StatTile
              label="Pending Review"
              value={count(autoIndentStats?.pending ?? 0)}
              tone="warning"
              onClick={() => setIndentStatusFilter('PENDING_APPROVAL')}
            />
            <StatTile
              label="Store Approved"
              value={count(autoIndentStats?.storeApproved ?? 0)}
              tone="info"
              onClick={() => setIndentStatusFilter('STORE_APPROVED')}
            />
            <StatTile
              label="Ready for Purchase"
              value={count(autoIndentStats?.approved ?? 0)}
              tone="success"
              onClick={() => setIndentStatusFilter('APPROVED')}
            />
            <StatTile
              label="Converted to Indent"
              value={count(autoIndentStats?.converted ?? 0)}
              tone="default"
              onClick={() => setIndentStatusFilter('CONVERTED')}
            />
          </div>

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <FilterBar
              filters={filters}
              setFilters={setFilters}
              clearFilters={clearFilters}
              activeCount={activeCount}
              show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'item']}
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
                rows={autoIndentData?.data || []}
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

      {/* ── MODAL: PHYSICAL STOCK ADJUSTMENT ───────────────────────────────────── */}
      {isAdjModalOpen && (
        <Modal
          open={isAdjModalOpen}
          onClose={() => setIsAdjModalOpen(false)}
          title="Physical Stock Count Adjustment"
          subtitle="Audit and reconcile physical store stock with book ledger balance"
          footer={
            <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end', width: '100%' }}>
              <Button variant="ghost" onClick={() => setIsAdjModalOpen(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={!selectedAdjItem || adjBookStock === null || adjActualCount === '' || Number(adjActualCount) < 0 || !adjReason.trim()}
                loading={adjustmentMutation.isPending}
                onClick={() => {
                  if (!selectedAdjItem || adjBookStock === null) return;
                  adjustmentMutation.mutate({
                    itemId: selectedAdjItem.id,
                    actualStockQty: Number(adjActualCount),
                    // The figure shown: the server refuses the count if the stock is no longer it.
                    expectedSystemQty: adjBookStock,
                    reason: adjReason,
                    findings: adjFindings,
                    remarks: adjRemarks,
                  });
                }}
              >
                Post Adjustment
              </Button>
            </div>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            {!selectedAdjItem ? (
              <div>
                <Field label="Search & Select Item for Audit">
                  <Input
                    placeholder="Type at least 2 characters of item code or description…"
                    value={adjItemSearch}
                    onChange={(e) => setAdjItemSearch(e.target.value)}
                    autoFocus
                  />
                </Field>

                {adjItemCandidates?.data && adjItemCandidates.data.length > 0 && (
                  <div
                    style={{
                      maxHeight: 200,
                      overflowY: 'auto',
                      border: '1px solid var(--border-subtle)',
                      borderRadius: 'var(--radius-md)',
                      marginTop: 6,
                    }}
                  >
                    {adjItemCandidates.data.map((item) => (
                      <div
                        key={item.item_id}
                        onClick={() => chooseAdjItem({
                          id: item.item_id,
                          code: item.item_code,
                          description: item.item_description,
                          category: item.category,
                          uom: item.uom_code,
                        })}
                        style={{
                          padding: '8px 12px',
                          cursor: 'pointer',
                          borderBottom: '1px solid var(--border-subtle)',
                          display: 'flex',
                          justifyContent: 'space-between',
                          alignItems: 'center',
                        }}
                        className="hover:bg-muted"
                      >
                        <div>
                          <span className="cell-code">{item.item_code}</span>
                          <span style={{ marginLeft: 8, fontWeight: 500 }}>{item.item_description}</span>
                        </div>
                        <div className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                          {qty(item.live_stock_qty)} {toShortUom(item.uom_code)}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div
                style={{
                  backgroundColor: 'var(--surface-muted)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius-md)',
                  border: '1px solid var(--border-subtle)',
                }}
              >
                <div className="row" style={{ justifyContent: 'space-between' }}>
                  <div>
                    <span className="cell-code font-medium">{selectedAdjItem.code}</span>
                    <span style={{ marginLeft: 8 }}>
                      <Badge tone={CATEGORY_TONES[selectedAdjItem.category] || 'neutral'} plain>
                        {selectedAdjItem.category}
                      </Badge>
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" onClick={() => setSelectedAdjItem(null)}>
                    Change Item
                  </Button>
                </div>
                <div className="cell-strong" style={{ marginTop: 4 }}>
                  {selectedAdjItem.description}
                </div>
                <div className="row" style={{ gap: 16, marginTop: 8, fontSize: 'var(--text-sm)', flexWrap: 'wrap' }}>
                  {adjBookStock !== null ? (
                    <div>
                      <span style={{ color: 'var(--text-muted)' }}>Current Book Stock: </span>
                      <span className="num cell-strong">
                        {qty(adjBookStock)} {toShortUom(selectedAdjItem.uom)}
                      </span>
                    </div>
                  ) : !adjBookQuery.isError && (
                    <div style={{ color: 'var(--text-muted)' }}>Loading the book stock…</div>
                  )}
                  {selectedAdjItem.sheetStock !== undefined && (
                    <div title="The category workspace's own figure. The count is posted against the book stock, not this figure.">
                      <span style={{ color: 'var(--text-muted)' }}>{selectedAdjItem.category} sheet figure: </span>
                      <span className="num">{qty(selectedAdjItem.sheetStock)} {toShortUom(selectedAdjItem.uom)}</span>
                    </div>
                  )}
                </div>
                {adjBookQuery.data?.is_active === false && (
                  <div className="cell-muted" style={{ marginTop: 6, fontSize: 'var(--text-xs)' }}>
                    Inactive in the item master: the stock register does not list it, but its stock can still be counted.
                  </div>
                )}
                {adjBookQuery.isError && (
                  <div style={{ marginTop: 8 }}>
                    <Banner tone="danger">
                      {adjBookQuery.error instanceof ApiError && adjBookQuery.error.status === 404
                        ? `${selectedAdjItem.code} is not in the item master, so its stock cannot be counted.`
                        : 'The book stock could not be loaded. Close the count and try again.'}
                    </Banner>
                  </div>
                )}
              </div>
            )}

            {selectedAdjItem && adjRefused && (
              <Banner tone="warning">
                Nothing was posted: the book stock moved from {qty(adjRefused.shown)} to {qty(adjRefused.bookStock)} while
                this count was open (a receipt or issue was posted meanwhile).{' '}
                {adjCountTyped
                  ? 'The variance below is against the new figure: check the count before posting it again.'
                  : 'The count now starts from the new book stock: enter the quantity actually counted.'}
              </Banner>
            )}

            {selectedAdjItem && (
              <>
                <Field label="Physical Count (Actual Stock)">
                  <Input
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="Enter verified physical count…"
                    value={adjActualCount}
                    onChange={(e) => {
                      setAdjActualCount(e.target.value);
                      setAdjCountTyped(true);
                    }}
                  />
                </Field>

                {adjActualCount !== '' && adjBookStock !== null && (
                  <div
                    style={{
                      padding: '8px 12px',
                      borderRadius: 'var(--radius-md)',
                      backgroundColor: computedDelta > 0 ? 'var(--success-50)' : computedDelta < 0 ? 'var(--danger-50)' : 'var(--surface-muted)',
                      border: `1px solid ${computedDelta > 0 ? 'var(--success-200)' : computedDelta < 0 ? 'var(--danger-200)' : 'var(--border-subtle)'}`,
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                    }}
                  >
                    <span style={{ fontSize: 'var(--text-xs)', fontWeight: 500 }}>
                      Adjustment Variance (Delta):
                    </span>
                    <span
                      className="num"
                      style={{
                        fontWeight: 700,
                        fontSize: 'var(--text-md)',
                        color: computedDelta > 0 ? 'var(--success-700)' : computedDelta < 0 ? 'var(--danger-700)' : 'inherit',
                      }}
                    >
                      {computedDelta > 0 ? `+${qty(computedDelta)} (Surplus)` : computedDelta < 0 ? `${qty(computedDelta)} (Shortfall)` : '0.00 (No change)'}
                    </span>
                  </div>
                )}

                <Field label="Adjustment Reason" required>
                  <Select value={adjReason} onChange={(e) => setAdjReason(e.target.value)}>
                    <option value="Cycle Count Reconciliation">Cycle Count Reconciliation</option>
                    <option value="Damaged in Store / Scrapped">Damaged in Store / Scrapped</option>
                    <option value="Found Unrecorded Physical Stock">Found Unrecorded Physical Stock</option>
                    <option value="Conversion / Packing Discrepancy">Conversion / Packing Discrepancy</option>
                    <option value="Store Receipt Correction">Store Receipt Correction</option>
                    <option value="Annual Physical Audit">Annual Physical Audit</option>
                  </Select>
                </Field>

                <Field label="Audit Findings / Investigation Notes">
                  <Input
                    placeholder="e.g. Found 2 damaged boxes in aisle 4 during weekly count"
                    value={adjFindings}
                    onChange={(e) => setAdjFindings(e.target.value)}
                  />
                </Field>

                <Field label="Approver Remarks">
                  <Textarea
                    placeholder="Verification remarks or authority note…"
                    value={adjRemarks}
                    onChange={(e) => setAdjRemarks(e.target.value)}
                    rows={2}
                  />
                </Field>
              </>
            )}
          </div>
        </Modal>
      )}

      {/* ── MODAL: REVERSE A STOCK ADJUSTMENT ─────────────────────────────────── */}
      {reversingAdj && (
        <Modal
          open={Boolean(reversingAdj)}
          onClose={() => setReversingAdj(null)}
          title={`Reverse adjustment ${reversingAdj.adjustment_no}`}
          subtitle={`${reversingAdj.item_code}: the variance of ${qty(reversingAdj.adjustment_qty)} is undone with a reversal entry. The adjustment stays on record, marked reversed.`}
          footer={
            <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end', width: '100%' }}>
              <Button variant="ghost" onClick={() => setReversingAdj(null)}>
                Keep it
              </Button>
              <Button
                variant="danger"
                disabled={reverseReason.trim().length < 5}
                loading={reverseAdjMutation.isPending}
                onClick={() => reverseAdjMutation.mutate({ id: reversingAdj.id, reason: reverseReason.trim() })}
              >
                Reverse adjustment
              </Button>
            </div>
          }
        >
          <Field label="Why is it being reversed?" required hint="At least 5 characters. Saved in the audit log.">
            <Textarea
              placeholder="e.g. Count was entered against the wrong item"
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              rows={3}
              autoFocus
            />
          </Field>
        </Modal>
      )}

      {/* ── MODAL: AUTO INDENT REJECT ─────────────────────────────────────────── */}
      {rejectingItem && (
        <Modal
          open={Boolean(rejectingItem)}
          onClose={() => setRejectingItem(null)}
          title="Reject Auto Indent Suggestion"
          subtitle={`Rejecting suggested replenishment of ${qty(rejectingItem.suggested_qty)} ${toShortUom(rejectingItem.uom_code)} for ${rejectingItem.item_code}`}
          footer={
            <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end', width: '100%' }}>
              <Button variant="ghost" onClick={() => setRejectingItem(null)}>
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={!rejectionReason.trim()}
                loading={rejectMutation.isPending}
                onClick={() => rejectMutation.mutate({ id: rejectingItem.id, reason: rejectionReason })}
              >
                Confirm Rejection
              </Button>
            </div>
          }
        >
          <Field label="Rejection Reason" required>
            <Textarea
              placeholder="State why this automated suggestion is not being ordered (e.g. production stopped, alternate item in stock)…"
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              rows={3}
              autoFocus
            />
          </Field>
        </Modal>
      )}
    </div>
  );
}
