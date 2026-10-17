/**
 * The metric catalogue (ADR-009, SRS §13, §38).
 *
 * "Do not calculate a KPI differently on different screens" — SRS §38.
 *
 * Every KPI the product displays is declared exactly once, here, with its formula,
 * its source and where clicking it must lead. The dashboard may only render metrics
 * from this catalogue, and the catalogue is served to the frontend so a KPI card can
 * show its own authoritative definition on hover.
 */

export type MetricUnit = 'currency' | 'quantity' | 'count' | 'days' | 'percent';

export interface MetricDef {
  key: string;
  label: string;
  /** Plain-English meaning, shown to management in the KPI tooltip. */
  description: string;
  /** The arithmetic, stated against the authoritative views. */
  formula: string;
  unit: MetricUnit;
  /** Which balance view or table the number comes from. */
  source: string;
  /**
   * Route + filter the KPI card drills into (SRS §14): a list filtered to exactly what the
   * number counts, under the same dashboard filters. Empty when no list shows that (a
   * distinct-supplier count, an average across documents): the card is then not clickable.
   * Several targets opened a list that did not hold the figure (2026-10-16 audit, F09):
   * '/indents?eligibleOnly=true' was ignored by the list (50 vs 1,814 indents), and
   * 'Active Suppliers' 88 opened all 1,403 suppliers.
   *
   * The analytics route counts a card through this list's own filter and total tiles, so
   * the number is the list's row count or one of its tiles; under an item-level filter
   * both add up only that filter's lines (domain/item-scope.ts).
   */
  drilldown: string;
  /** `true` when a rising value is bad (pending, overdue, rejection). */
  inverse?: boolean;
  /** Permission required to see this metric. */
  permission: string;
}

export const METRICS: MetricDef[] = [
  /* ── Purchase value & quantity (SRS §13) ─────────────────────────────────── */
  {
    key: 'po_value_total',
    label: 'Total PO Value',
    description: 'Value of all purchase orders raised in the selected period, excluding cancelled orders.',
    formula: 'Σ purchase_order_lines.amount WHERE po.status <> CANCELLED',
    unit: 'currency',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.view',
  },
  {
    key: 'po_count',
    label: 'Purchase Orders',
    description: 'Number of purchase orders raised in the selected period, excluding cancelled orders.',
    formula: 'COUNT(DISTINCT purchase_order_headers.id) WHERE status <> CANCELLED',
    unit: 'count',
    source: 'purchase_order_headers',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.view',
  },
  {
    key: 'po_qty_total',
    label: 'Total PO Quantity',
    description: 'Total quantity ordered across all non-cancelled purchase order lines.',
    formula: 'Σ v_po_line_balance.po_qty',
    unit: 'quantity',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.view',
  },
  {
    key: 'po_avg_value',
    label: 'Average PO Value',
    description: 'Total PO value divided by the number of purchase orders.',
    formula: 'po_value_total ÷ po_count',
    unit: 'currency',
    source: 'v_po_header_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.view',
  },

  /* ── Pending exposure ────────────────────────────────────────────────────── */
  // "Pending" is a line still to be received on an issued, open order: the Pending PO
  // list's own rule (purchase-order/routes.ts pendingLineSql). A DRAFT was never sent.
  {
    key: 'po_pending_value',
    label: 'Pending PO Value',
    description:
      'Committed value not yet received — the outstanding financial exposure to suppliers.',
    formula: "Σ (v_po_line_balance.pending_grn_qty × final_rate) WHERE is_receivable AND po_status IN ('OPEN','PARTIALLY_RECEIVED')",
    unit: 'currency',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders/pending',
    inverse: true,
    permission: 'po.view',
  },
  {
    key: 'po_pending_count',
    label: 'Pending POs',
    description: 'Issued purchase orders with at least one line still awaiting receipt.',
    formula: "COUNT(DISTINCT po_id) WHERE v_po_line_balance.is_receivable AND po_status IN ('OPEN','PARTIALLY_RECEIVED')",
    unit: 'count',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders/pending',
    inverse: true,
    permission: 'po.view',
  },
  {
    key: 'po_completed_count',
    label: 'Completed POs',
    description: 'Purchase orders whose every line has been fully received.',
    // The status the list filters on; the Exceptions panel flags any order whose stored
    // status disagrees with its receipts (expected to be none).
    formula: "COUNT(*) FROM purchase_order_headers WHERE status = 'COMPLETED'",
    unit: 'count',
    source: 'purchase_order_headers',
    // The Complete tab also holds short-closed orders, which this does not count.
    drilldown: '/purchase-orders?status=COMPLETED',
    permission: 'po.view',
  },

  /* ── Indent (SRS §13) ────────────────────────────────────────────────────── */
  {
    key: 'indent_count',
    label: 'Total Indents',
    description: 'Purchase indents raised in the selected period, excluding cancelled indents.',
    formula: 'COUNT(*) FROM purchase_indent_headers WHERE status <> CANCELLED',
    unit: 'count',
    source: 'purchase_indent_headers',
    drilldown: '/indents?excludeCancelled=true',
    permission: 'indent.view',
  },
  {
    key: 'indent_pending_approval',
    label: 'Pending Approval',
    description: 'Indents submitted and awaiting a decision from the Purchase Head.',
    formula: "COUNT(*) WHERE status = 'PENDING_APPROVAL'",
    unit: 'count',
    source: 'purchase_indent_headers',
    drilldown: '/indents?status=PENDING_APPROVAL',
    inverse: true,
    permission: 'indent.view',
  },
  {
    key: 'indent_pending_value',
    label: 'Indent Value Awaiting Approval',
    description: 'Estimated value of indents that are still awaiting approval.',
    formula: "Σ (indent_qty × estimated_rate) WHERE status = 'PENDING_APPROVAL'",
    unit: 'currency',
    source: 'v_indent_line_balance',
    drilldown: '/indents?status=PENDING_APPROVAL',
    inverse: true,
    permission: 'indent.view',
  },
  {
    key: 'indent_approved_open_qty',
    label: 'Approved Qty Awaiting PO',
    description:
      'Approved indent quantity not yet converted into a purchase order — the forward order book.',
    // The list's Pending Qty tile: an approved indent's lines that are not eligible are
    // fully ordered, so they add nothing.
    formula: 'Σ v_indent_line_balance.pending_qty over the approved indents with a line eligible for a PO',
    unit: 'quantity',
    source: 'v_indent_line_balance',
    // The indents holding that quantity; the list has filtered on eligibleOnly since 2026-10-17.
    drilldown: '/indents?eligibleOnly=true',
    inverse: true,
    permission: 'indent.view',
  },
  {
    key: 'indent_rejection_rate',
    label: 'Rejection Rate',
    description: 'Share of decided indents that were rejected. A quality signal on requisitioning.',
    formula: 'rejected ÷ (approved + rejected) × 100',
    unit: 'percent',
    source: 'purchase_indent_headers',
    drilldown: '/indents?status=REJECTED',
    inverse: true,
    permission: 'indent.view',
  },
  {
    key: 'indent_avg_approval_days',
    label: 'Avg Approval Time',
    description: 'Mean days between indent submission and the approval decision.',
    formula: 'AVG(approved_at − submitted_at) in days',
    unit: 'days',
    source: 'purchase_indent_headers',
    drilldown: '/indents?status=APPROVED',
    inverse: true,
    permission: 'indent.analyze',
  },

  /* ── GRN (SRS §13) ───────────────────────────────────────────────────────── */
  // Posted receipts of every kind: 2,716 of the 2,718 GRNs are direct (store) receipts
  // with no purchase order, and the received figures used to count PO receipts only
  // (267 against the GRN list's 17,051,110.899; 2026-10-16 audit, F09). Counted through
  // the GRN list's own filter, so they open '/grn?status=POSTED' showing what they count.
  {
    key: 'grn_count',
    label: 'Goods Receipts',
    description: 'Posted GRNs in the selected period, purchase-order and direct receipts alike.',
    formula: "COUNT(*) FROM grn_headers WHERE status = 'POSTED'",
    unit: 'count',
    source: 'grn_headers',
    drilldown: '/grn?status=POSTED',
    permission: 'grn.view',
  },
  {
    key: 'grn_qty_total',
    label: 'Received Quantity',
    description: 'Total quantity received on posted GRNs, purchase-order and direct receipts alike.',
    formula: "Σ grn_lines.grn_qty WHERE grn.status = 'POSTED'",
    unit: 'quantity',
    source: 'grn_lines',
    drilldown: '/grn?status=POSTED',
    permission: 'grn.view',
  },
  {
    key: 'grn_value_total',
    label: 'Received Value',
    description: 'Value of goods received on posted GRNs: the purchase order rate for a PO receipt, the entered rate for a direct one.',
    formula: "Σ grn_lines.amount (grn_qty × rate) WHERE grn.status = 'POSTED'",
    unit: 'currency',
    source: 'grn_lines',
    drilldown: '/grn?status=POSTED',
    permission: 'grn.view',
  },
  {
    key: 'grn_pending_qty',
    label: 'Pending Receipt Qty',
    description: 'Ordered quantity still to be delivered by suppliers on issued purchase orders.',
    formula: "Σ v_po_line_balance.pending_grn_qty WHERE is_receivable AND po_status IN ('OPEN','PARTIALLY_RECEIVED')",
    unit: 'quantity',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders/pending',
    inverse: true,
    permission: 'grn.view',
  },
  {
    key: 'grn_fulfilment_rate',
    label: 'Fulfilment Rate',
    description: 'Share of ordered quantity that has actually been received.',
    formula: 'Σ received_qty ÷ Σ po_qty × 100',
    unit: 'percent',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'grn.analyze',
  },
  {
    key: 'po_overdue_count',
    label: 'Overdue Deliveries',
    description:
      'Issued purchase orders with a line past its delivery date and quantity still outstanding.',
    // Orders, not lines, so the number is the length of the list it opens.
    formula: "COUNT(DISTINCT po_id) WHERE is_receivable AND po_status IN ('OPEN','PARTIALLY_RECEIVED') AND delivery_date < CURRENT_DATE",
    unit: 'count',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders/pending?overdue=true',
    inverse: true,
    permission: 'po.view',
  },

  /* ── Cycle time & commercial (SRS §13) ───────────────────────────────────── */
  {
    key: 'purchase_cycle_days',
    label: 'Purchase Cycle Time',
    description:
      'Mean days from indent submission to first goods receipt — end-to-end procurement speed.',
    formula: 'AVG(first grn_date − indent submitted_at) over indent-sourced POs, in days',
    unit: 'days',
    source: 'v_po_line_sources + grn_headers',
    // An average over first receipts of indent-sourced orders, filtered by receipt date only:
    // no list holds that set, so the card is not clickable.
    drilldown: '',
    inverse: true,
    permission: 'dashboard.analyze',
  },
  {
    key: 'avg_discount_pct',
    label: 'Average Discount',
    description: 'Value-weighted average discount negotiated across purchase order lines.',
    formula: 'Σ (rate × qty − amount) ÷ Σ (rate × qty) × 100',
    unit: 'percent',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.analyze',
  },
  {
    key: 'discount_savings',
    label: 'Discount Savings',
    description: 'Absolute value saved through negotiated discounts in the period.',
    formula: 'Σ (po_qty × rate) − Σ amount',
    unit: 'currency',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    permission: 'po.analyze',
  },
  {
    key: 'supplier_count',
    label: 'Active Suppliers',
    description: 'Distinct suppliers with at least one purchase order in the period.',
    formula: 'COUNT(DISTINCT supplier_id)',
    unit: 'count',
    source: 'purchase_order_headers',
    // The Supplier Master lists every supplier (1,403 against 88 counted): not clickable.
    drilldown: '',
    permission: 'supplier.view',
  },
  {
    key: 'supplier_concentration',
    label: 'Top-5 Supplier Share',
    description:
      'Share of total purchase value held by the five largest suppliers — a dependency risk signal.',
    formula: 'Σ top-5 supplier value ÷ po_value_total × 100',
    unit: 'percent',
    source: 'v_po_line_balance',
    drilldown: '/purchase-orders?excludeCancelled=true',
    inverse: true,
    permission: 'dashboard.analyze',
  },
  {
    key: 'item_count',
    label: 'Items Purchased',
    description: 'Distinct items appearing on purchase orders in the period.',
    formula: 'COUNT(DISTINCT item_id) FROM v_po_line_balance',
    unit: 'count',
    source: 'v_po_line_balance',
    // The Item Master lists every item (4,748 against 531 counted): not clickable.
    drilldown: '',
    permission: 'item.view',
  },

  /* ── Requisition (Purchase Module tab 4 — material request, not a purchase) ── */
  {
    key: 'requisition_count',
    label: 'Total Requisitions',
    description: 'Material requisitions raised in the selected period, excluding cancelled ones.',
    formula: "COUNT(*) FROM requisition_headers WHERE status <> 'CANCELLED'",
    unit: 'count',
    source: 'requisition_headers',
    drilldown: '/requisitions?excludeCancelled=true',
    permission: 'requisition.view',
  },
  {
    key: 'requisition_pending_hod',
    label: 'Pending HOD Approval',
    description: 'Requisitions submitted and awaiting an HOD decision.',
    formula: "COUNT(*) WHERE status = 'PENDING_APPROVAL'",
    unit: 'count',
    source: 'requisition_headers',
    drilldown: '/requisitions?status=PENDING_APPROVAL',
    inverse: true,
    permission: 'requisition.view',
  },
  {
    key: 'requisition_hod_approved',
    label: 'HOD Approved',
    description: 'Requisitions whose HOD Status is Approved (includes those already issued in full or in part).',
    formula: "COUNT(*) WHERE v_requisition_header_balance.hod_status = 'APPROVED'",
    unit: 'count',
    source: 'v_requisition_header_balance',
    // A requisition cancelled after approval keeps HOD status Approved; the KPI leaves it out.
    drilldown: '/requisitions?hodStatus=APPROVED&excludeCancelled=true',
    permission: 'requisition.view',
  },
  {
    key: 'requisition_hod_rejected',
    label: 'HOD Rejected',
    description: 'Requisitions whose HOD Status is Rejected. A quality signal on requisitioning.',
    formula: "COUNT(*) WHERE v_requisition_header_balance.hod_status = 'REJECTED'",
    unit: 'count',
    source: 'v_requisition_header_balance',
    drilldown: '/requisitions?hodStatus=REJECTED&excludeCancelled=true',
    inverse: true,
    permission: 'requisition.view',
  },
  {
    key: 'requisition_awaiting_issue',
    label: 'Awaiting Store Issue',
    description: 'HOD-approved requisitions with Store Status still Pending — nothing issued yet.',
    formula: "COUNT(*) WHERE status = 'APPROVED'",
    unit: 'count',
    source: 'requisition_headers',
    // The Store queue also holds part-issued requisitions, which this does not count.
    drilldown: '/requisitions?status=APPROVED',
    inverse: true,
    permission: 'requisition.view',
  },
  // The quantity KPIs sum every requisition but cancelled ones; their drill-down lists exactly
  // those, and the list's own totals show the same figure. (Issued Qty opened only the fully
  // issued ones and Pending Qty only store-pending ones, which held part of each figure.)
  {
    key: 'requisition_requested_qty',
    label: 'Total Requested Qty',
    description: 'Sum of requested quantity across all requisition lines — never overwritten by what was actually issued.',
    formula: 'Σ v_requisition_header_balance.total_requested_qty',
    unit: 'quantity',
    source: 'v_requisition_header_balance',
    drilldown: '/requisitions?excludeCancelled=true',
    permission: 'requisition.view',
  },
  {
    key: 'requisition_issued_qty',
    label: 'Total Issued Qty',
    description: 'Sum of actual quantity issued by Stores across every issue transaction; a reversed slip returned its stock and no longer counts.',
    formula: 'Σ v_requisition_header_balance.total_issued_qty',
    unit: 'quantity',
    source: 'v_requisition_header_balance',
    drilldown: '/requisitions?excludeCancelled=true',
    permission: 'requisition.view',
  },
  {
    key: 'requisition_pending_qty',
    label: 'Current Pending Qty',
    description: 'Requested quantity not yet issued — GREATEST(requested - issued, 0) summed across lines.',
    formula: 'Σ v_requisition_header_balance.total_pending_qty',
    unit: 'quantity',
    source: 'v_requisition_header_balance',
    drilldown: '/requisitions?excludeCancelled=true',
    inverse: true,
    permission: 'requisition.view',
  },
  {
    key: 'requisition_excess_qty',
    label: 'Over-Issued Qty',
    description: 'Quantity issued beyond what was requested — a deliberately permitted business outcome, tracked for visibility.',
    formula: 'Σ v_requisition_header_balance.total_excess_qty',
    unit: 'quantity',
    source: 'v_requisition_header_balance',
    drilldown: '/requisitions?excludeCancelled=true',
    permission: 'requisition.analyze',
  },
  {
    key: 'requisition_avg_approval_days',
    label: 'Avg HOD Approval Time',
    description: 'Mean days between requisition submission and the HOD decision.',
    formula: 'AVG(hod_decided_at − submitted_at) in days',
    unit: 'days',
    source: 'requisition_headers',
    drilldown: '/requisitions?hodStatus=APPROVED',
    inverse: true,
    permission: 'requisition.analyze',
  },
  {
    key: 'requisition_issue_transaction_count',
    label: 'Issue Transactions',
    description: 'Number of distinct store-issue events (issue slips) still standing — a requisition may have several; reversed slips are not counted.',
    formula: "COUNT(*) FROM requisition_issues WHERE status = 'POSTED'",
    unit: 'count',
    source: 'requisition_issues',
    // Issue slips by issue date: the Store queue lists requisitions still to be issued,
    // and no screen lists slips, so the card is not clickable.
    drilldown: '',
    permission: 'requisition.analyze',
  },
];

export const METRIC_BY_KEY: Record<string, MetricDef> = Object.fromEntries(
  METRICS.map((m) => [m.key, m]),
);

/** Ageing buckets used by every pending/ageing analysis (SRS §13). */
export const AGEING_BUCKETS = [
  { key: '0-7', label: '0–7 days', min: 0, max: 7 },
  { key: '8-15', label: '8–15 days', min: 8, max: 15 },
  { key: '16-30', label: '16–30 days', min: 16, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '60+', label: 'Over 60 days', min: 61, max: 100000 },
] as const;

export type AgeingBucketKey = (typeof AGEING_BUCKETS)[number]['key'];

/** SQL CASE that maps an age in days onto the bucket keys above. */
export const AGEING_CASE_SQL = `
  CASE
    WHEN {age} <= 7  THEN '0-7'
    WHEN {age} <= 15 THEN '8-15'
    WHEN {age} <= 30 THEN '16-30'
    WHEN {age} <= 60 THEN '31-60'
    ELSE '60+'
  END`;

export function ageingCase(ageExpr: string): string {
  return AGEING_CASE_SQL.replace(/\{age\}/g, ageExpr);
}
