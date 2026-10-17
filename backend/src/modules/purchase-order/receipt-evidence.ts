/**
 * Receipt evidence of pending purchase orders (2026-10-17).
 *
 * The store's GRNs were imported on 2026-10-14 before their POs existed. The link
 * repair (admin/store-grn-links.ts) links a store receipt to a PO line only on
 * unambiguous GRN-tab evidence and records every receipt it holds back, with the PO
 * the tab names, in store_grn_link_holds (migration 030). On the 2026-10-17 copy it
 * held 2,642 receipt lines; without the record their POs looked exactly like POs
 * nothing was received against.
 *
 * The store also records some receipts ONLY on the business sheet's GRN tab. The
 * sync never creates a GRN: it keeps each such tab line open as a conflict
 * (google_sync_errors: sheet 'GRN', MISSING_IN_ERP, incoming_value { poNo, grnNo,
 * grnQty, itemCode }; google-sync/engine.ts). On 2026-10-17 that was 148 lines on 52
 * GRNs, each naming one of 52 POs that looked "pending, nothing received".
 *
 * The owner asked to "distinguish genuinely pending orders from imported orders whose
 * receipts aren't yet reliably linked" and to link only on reliable source references.
 * Each PO falls in one evidence class, in this order of precedence:
 *   awaiting_link  a store receipt the link repair held back names it;
 *   sheet_only     otherwise, a receipt on the store's GRN sheet that the ERP does not
 *                  hold names it;
 *   none_recorded  otherwise: genuinely pending.
 * This module only reads. It never links or creates anything, and a PO keeps its
 * pending quantity and value until a receipt is posted or linked.
 */
import { query, txQuery, type Queryable } from '../../db/index.js';
import { toQty } from '../../domain/money.js';
import { PO_AFTER_RECEIPT_DAYS, type HoldReason } from '../admin/store-grn-links.js';

/** What the PO list filter `receiptEvidence` selects among the POs, in order of precedence. */
export const RECEIPT_EVIDENCE = ['awaiting_link', 'sheet_only', 'none_recorded'] as const;
export type ReceiptEvidence = (typeof RECEIPT_EVIDENCE)[number];

/** Each option in the words the PO list shows, which an export's header repeats. */
export const RECEIPT_EVIDENCE_LABEL: Record<ReceiptEvidence, string> = {
  awaiting_link: 'Store receipt awaiting link',
  sheet_only: 'Receipt on store sheet only',
  none_recorded: 'No receipt recorded',
};

/** A hold row's reason: the link run's HOLD_REASONS, or a link an undo took back. */
export type HoldRowReason = HoldReason | 'UNDONE';

/**
 * THE definition of a store receipt awaiting link, written once (aliases k, gl, gh):
 * the hold rows that still stand. A row stands while its GRN line has no PO line and
 * its GRN is POSTED; `k.po_id` is the ERP PO the row names. A receipt linked since (by
 * a later run or from the GRN screen), cancelled or deleted no longer counts, without
 * anyone editing the record.
 */
export const AWAITING_LINK_FROM = `store_grn_link_holds k
  JOIN grn_lines gl ON gl.id = k.grn_line_id AND gl.po_line_id IS NULL
  JOIN grn_headers gh ON gh.id = gl.grn_id AND gh.status = 'POSTED'`;

/** SQL: the latest finished sync of the business sheet (google_sync_jobs; NULL before the first). */
const LATEST_SYNC_JOB_ID = `(SELECT max(j.id) FROM google_sync_jobs j WHERE j.status IN ('SUCCESS', 'PARTIAL'))`;

/**
 * THE definition of a receipt on the store sheet only, written once (alias e): a GRN
 * tab line the ERP does not hold, still open as of the latest finished sync. The
 * engine records such a line once, under the run that first reports it, keeps it open
 * while every later run still reports it, and closes it once a complete run of the tab
 * no longer does: the GRN was posted in the ERP, or the row changed (onlyNewIssues,
 * resolveVanishedIssues). So the open rows are what the latest run reports. Taking
 * only the rows the latest run inserted would find nothing: on the 2026-10-17 backup
 * all 148 open lines were recorded by run 2774, and the latest, 2780, still reported
 * them without recording them again. Rows of a run still in progress wait for it to
 * finish.
 */
export const SHEET_ONLY_WHERE = `e.sheet_name = 'GRN' AND e.error_code = 'MISSING_IN_ERP' AND e.resolved_at IS NULL
  AND e.job_id <= ${LATEST_SYNC_JOB_ID}`;

/** The PO a sheet line names, compared as the link repair compares PO numbers: trimmed, ignoring case. */
const sheetLineNames = (poNo: string) => `upper(trim(e.incoming_value->>'poNo')) = upper(trim(${poNo}))`;

/** SQL: how many standing hold rows name the PO whose id is the SQL expression `poId`. */
export const awaitingLinkCount = (poId: string): string =>
  `(SELECT COUNT(*)::int FROM ${AWAITING_LINK_FROM} WHERE k.po_id = ${poId})`;

/** SQL: how many receipts on the store sheet only name the PO numbered by the SQL expression `poNo`. */
export const storeSheetReceiptCount = (poNo: string): string =>
  `(SELECT COUNT(*)::int FROM google_sync_errors e WHERE ${SHEET_ONLY_WHERE} AND ${sheetLineNames(poNo)})`;

/**
 * SQL condition: the PO header aliased `po` falls in the evidence class `evidence`.
 * Each set of POs is read once per query, as an array (an InitPlan), and every PO is
 * looked up in it: on the analysed 2026-10-17 copy the receipt evidence summary took
 * 0.12 s so, against 0.2 s with a correlated subquery per PO (migrate.ts analyses the
 * tables for 030). Neither array holds a NULL, so NOT ... = ANY is plainly true or false.
 */
export function receiptEvidenceCondition(evidence: ReceiptEvidence, po: string): string {
  const awaiting = `${po}.id = ANY (ARRAY(SELECT DISTINCT k.po_id FROM ${AWAITING_LINK_FROM} WHERE k.po_id IS NOT NULL))`;
  const onSheet = `upper(trim(${po}.po_no)) = ANY (ARRAY(SELECT DISTINCT upper(trim(e.incoming_value->>'poNo')) FROM google_sync_errors e
      WHERE ${SHEET_ONLY_WHERE} AND e.incoming_value->>'poNo' IS NOT NULL))`;
  if (evidence === 'awaiting_link') return awaiting;
  if (evidence === 'sheet_only') return `(NOT ${awaiting} AND ${onSheet})`;
  return `(NOT ${awaiting} AND NOT ${onSheet})`;
}

/** Each reason in plain words for a purchase user; the row's `detail` carries the figures. */
export const REASON_TEXT: Record<HoldRowReason, string> = {
  EXCLUDED: 'A Super Admin kept this receipt out of the last link run.',
  NOT_ON_TAB: 'The GRN tab has no row for this receipt.',
  NO_PO_NAMED: 'The GRN tab names no PO for this receipt.',
  SEVERAL_POS: 'The GRN tab names more than one PO for this receipt.',
  PO_NOT_IN_ERP: 'The PO named on the GRN tab is not in the ERP.',
  PO_NOT_RECEIVABLE: 'The PO named on the GRN tab is a draft or cancelled in the ERP, so it cannot take a receipt.',
  ITEM_NOT_ON_PO: 'The PO named on the GRN tab has no line for this item.',
  SEVERAL_PO_LINES: 'The PO has more than one line for this item and the GRN tab does not say which.',
  SUPPLIER_MISMATCH: 'The PO named on the GRN tab belongs to another supplier.',
  PO_AFTER_RECEIPT: `The PO named is dated more than ${PO_AFTER_RECEIPT_DAYS} days after the receipt.`,
  OVER_RECEIPT: 'The store received more than this PO line ordered, counting every receipt the GRN tab assigns to it.',
  GRN_PARTLY_HELD: 'Another line of the same GRN is held, and a GRN is linked whole.',
  UNDONE: 'A Super Admin took this link back.',
};
export const HOLD_ROW_REASONS = Object.keys(REASON_TEXT) as HoldRowReason[];

const isoOf = (v: Date | string): string => (v instanceof Date ? v.toISOString() : new Date(v).toISOString());

export interface StoreReceiptAwaitingLink {
  grnId: number;
  grnNo: string;
  grnDate: string;
  itemCode: string;
  grnQty: string;
  /** The PO line, when the link run settled on one (OVER_RECEIPT, GRN_PARTLY_HELD, UNDONE). */
  poLineNo: number | null;
  reason: HoldRowReason;
  reasonText: string;
  detail: string;
  recordedAt: string;
}

/** The store receipts awaiting link that name one PO (GET /purchase-orders/:id). */
export async function storeReceiptsAwaitingLink(poId: number): Promise<StoreReceiptAwaitingLink[]> {
  const rows = await query<{
    grn_id: number; grn_no: string; grn_date: string; item_code: string; grn_qty: string;
    po_line_no: number | null; reason: HoldRowReason; detail: string; recorded_at: Date | string;
  }>(
    // The date as text whatever the DateStyle, as the link run reads it.
    `SELECT gh.id AS grn_id, gh.grn_no, to_char(gh.grn_date, 'YYYY-MM-DD') AS grn_date, k.item_code,
            k.grn_qty::text AS grn_qty, pol.line_no AS po_line_no, k.reason, k.detail, k.recorded_at
       FROM ${AWAITING_LINK_FROM}
       LEFT JOIN purchase_order_lines pol ON pol.id = k.po_line_id
      WHERE k.po_id = $1
      ORDER BY gh.grn_date, gh.grn_no, k.grn_line_id, k.id`,
    [poId],
  );
  return rows.map((r) => ({
    grnId: Number(r.grn_id), grnNo: r.grn_no, grnDate: r.grn_date, itemCode: r.item_code, grnQty: toQty(r.grn_qty),
    poLineNo: r.po_line_no == null ? null : Number(r.po_line_no),
    reason: r.reason, reasonText: REASON_TEXT[r.reason] ?? r.reason, detail: r.detail, recordedAt: isoOf(r.recorded_at),
  }));
}

export interface StoreSheetReceipt {
  /** Null for a tab row without a GRN number, which the sync compares by PO and item. */
  grnNo: string | null;
  itemCode: string;
  grnQty: string;
  /** The GRN tab's row number (the header is row 1). */
  sheetRow: number | null;
  /** When the sync first reported the line. */
  reportedAt: string;
}

/** The receipts on the store sheet only that name one PO, by its number (GET /purchase-orders/:id). */
export async function storeSheetReceipts(poNo: string): Promise<StoreSheetReceipt[]> {
  const rows = await query<{ grn_no: string | null; item_code: string | null; grn_qty: string | null; row_number: number | null; created_at: Date | string }>(
    `SELECT e.incoming_value->>'grnNo' AS grn_no, e.incoming_value->>'itemCode' AS item_code,
            e.incoming_value->>'grnQty' AS grn_qty, e.row_number, e.created_at
       FROM google_sync_errors e
      WHERE ${SHEET_ONLY_WHERE} AND ${sheetLineNames('$1')}
      ORDER BY e.row_number NULLS LAST, e.id`,
    [poNo],
  );
  return rows.map((r) => ({
    grnNo: r.grn_no?.trim() || null, itemCode: (r.item_code ?? '').trim(), grnQty: toQty(r.grn_qty),
    sheetRow: r.row_number == null ? null : Number(r.row_number), reportedAt: isoOf(r.created_at),
  }));
}

/**
 * The receipt lines awaiting link on the POs the subquery `poIds` selects (its
 * parameters in `params`), in all and by reason. A line naming two of those POs
 * counts once.
 */
export async function awaitingLinkLines(
  db: Queryable, poIds: string, params: unknown[],
): Promise<{ receiptLines: number; byReason: Record<HoldRowReason, number> }> {
  const rows = await txQuery<{ reason: HoldRowReason; lines: number }>(
    db,
    `SELECT k.reason, COUNT(DISTINCT k.grn_line_id)::int AS lines
       FROM ${AWAITING_LINK_FROM}
      WHERE k.po_id IN (${poIds})
      GROUP BY k.reason`,
    params,
  );
  const [all] = await txQuery<{ lines: number }>(
    db,
    `SELECT COUNT(DISTINCT k.grn_line_id)::int AS lines FROM ${AWAITING_LINK_FROM} WHERE k.po_id IN (${poIds})`,
    params,
  );
  const byReason = Object.fromEntries(HOLD_ROW_REASONS.map((r) => [r, 0])) as Record<HoldRowReason, number>;
  for (const r of rows) byReason[r.reason] = Number(r.lines);
  return { receiptLines: Number(all?.lines ?? 0), byReason };
}

/** The receipt lines on the store sheet only that name a PO the subquery `poNos` selects (its parameters in `params`). */
export async function storeSheetLines(db: Queryable, poNos: string, params: unknown[]): Promise<number> {
  const [r] = await txQuery<{ lines: number }>(
    db,
    `SELECT COUNT(*)::int AS lines FROM google_sync_errors e
      WHERE ${SHEET_ONLY_WHERE} AND upper(trim(e.incoming_value->>'poNo')) IN (SELECT upper(trim(x.po_no)) FROM (${poNos}) x)`,
    params,
  );
  return Number(r?.lines ?? 0);
}

/**
 * Receipt lines awaiting link whose GRN tab row names a PO number the ERP does not
 * hold, and how many such numbers: POs the PO register has not brought in.
 */
export async function receiptsNamingPosNotInErp(db: Queryable): Promise<{ receiptLines: number; poNos: number }> {
  const [r] = await txQuery<{ lines: number; po_nos: number }>(
    db,
    `SELECT COUNT(DISTINCT k.grn_line_id)::int AS lines, COUNT(DISTINCT upper(trim(k.po_no)))::int AS po_nos
       FROM ${AWAITING_LINK_FROM}
      WHERE k.po_id IS NULL AND k.po_no IS NOT NULL`,
  );
  return { receiptLines: Number(r?.lines ?? 0), poNos: Number(r?.po_nos ?? 0) };
}

/** When the record of held receipts was last written, and the link run its latest row belongs to. */
export async function latestHoldRecord(db: Queryable): Promise<{ asOf: string | null; runId: string | null }> {
  const [r] = await txQuery<{ recorded_at: Date | string; run_id: string }>(
    db, 'SELECT recorded_at, run_id FROM store_grn_link_holds ORDER BY recorded_at DESC, id DESC LIMIT 1',
  );
  return { asOf: r ? isoOf(r.recorded_at) : null, runId: r?.run_id ?? null };
}

/** The sync run the store-sheet evidence is as of: the latest finished one. */
export async function latestSheetSync(db: Queryable): Promise<{ jobId: number | null; asOf: string | null }> {
  const [r] = await txQuery<{ id: number; finished_at: Date | string | null }>(
    db, `SELECT id, finished_at FROM google_sync_jobs WHERE id = ${LATEST_SYNC_JOB_ID}`,
  );
  return { jobId: r ? Number(r.id) : null, asOf: r?.finished_at ? isoOf(r.finished_at) : null };
}
