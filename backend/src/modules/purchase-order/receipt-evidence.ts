/**
 * Store receipts awaiting their PO link (2026-10-17).
 *
 * The store's GRNs were imported on 2026-10-14 before their POs existed. The link
 * repair (admin/store-grn-links.ts) links a store receipt to a PO line only on
 * unambiguous GRN-tab evidence and records every receipt it holds back, with the PO
 * the tab names, in store_grn_link_holds (migration 030). On the 2026-10-17 copy it
 * held 2,642 receipt lines; without the record their POs looked exactly like POs
 * nothing was received against.
 *
 * The owner asked to "distinguish genuinely pending orders from imported orders whose
 * receipts aren't yet reliably linked" and to link only on reliable source references.
 * This module only reads the record. It never links anything, and a PO keeps its
 * pending quantity and value until a receipt is linked.
 */
import { query } from '../../db/index.js';
import { toQty } from '../../domain/money.js';
import { PO_AFTER_RECEIPT_DAYS, type HoldReason } from '../admin/store-grn-links.js';

/** What the PO list filter `receiptEvidence` selects among the POs. */
export const RECEIPT_EVIDENCE = ['awaiting_link', 'none_recorded'] as const;
export type ReceiptEvidence = (typeof RECEIPT_EVIDENCE)[number];

/** Each option in the words the PO list shows, which an export's header repeats. */
export const RECEIPT_EVIDENCE_LABEL: Record<ReceiptEvidence, string> = {
  awaiting_link: 'Store receipt awaiting link',
  none_recorded: 'No receipt recorded',
};

/** A hold row's reason: the link run's HOLD_REASONS, or a link an undo took back. */
export type HoldRowReason = HoldReason | 'UNDONE';

/**
 * THE definition, written once (aliases k, gl, gh): the hold rows that still stand.
 * A row stands while its GRN line has no PO line and its GRN is POSTED; `k.po_id` is
 * the ERP PO the row names. A receipt linked since (by a later run or from the GRN
 * screen), cancelled or deleted no longer counts, without anyone editing the record.
 */
export const AWAITING_LINK_FROM = `store_grn_link_holds k
  JOIN grn_lines gl ON gl.id = k.grn_line_id AND gl.po_line_id IS NULL
  JOIN grn_headers gh ON gh.id = gl.grn_id AND gh.status = 'POSTED'`;

/** SQL: how many standing hold rows name the PO whose id is the SQL expression `poId`. */
export const awaitingLinkCount = (poId: string): string =>
  `(SELECT COUNT(*)::int FROM ${AWAITING_LINK_FROM} WHERE k.po_id = ${poId})`;

/** SQL condition: the PO `poId` has a store receipt awaiting link (awaiting_link), or none recorded. */
export const receiptEvidenceCondition = (evidence: ReceiptEvidence, poId: string): string =>
  `${evidence === 'none_recorded' ? 'NOT ' : ''}EXISTS (SELECT 1 FROM ${AWAITING_LINK_FROM} WHERE k.po_id = ${poId})`;

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

/**
 * The receipt lines awaiting link on the POs the subquery `poIds` selects (its
 * parameters in `params`), in all and by reason. A line naming two of those POs
 * counts once.
 */
export async function awaitingLinkLines(
  poIds: string, params: unknown[],
): Promise<{ receiptLines: number; byReason: Record<HoldRowReason, number> }> {
  const rows = await query<{ reason: HoldRowReason; lines: number }>(
    `SELECT k.reason, COUNT(DISTINCT k.grn_line_id)::int AS lines
       FROM ${AWAITING_LINK_FROM}
      WHERE k.po_id IN (${poIds})
      GROUP BY k.reason`,
    params,
  );
  const [all] = await query<{ lines: number }>(
    `SELECT COUNT(DISTINCT k.grn_line_id)::int AS lines FROM ${AWAITING_LINK_FROM} WHERE k.po_id IN (${poIds})`,
    params,
  );
  const byReason = Object.fromEntries(HOLD_ROW_REASONS.map((r) => [r, 0])) as Record<HoldRowReason, number>;
  for (const r of rows) byReason[r.reason] = Number(r.lines);
  return { receiptLines: Number(all?.lines ?? 0), byReason };
}

/**
 * Receipt lines awaiting link whose GRN tab row names a PO number the ERP does not
 * hold, and how many such numbers: POs the PO register has not brought in.
 */
export async function receiptsNamingPosNotInErp(): Promise<{ receiptLines: number; poNos: number }> {
  const [r] = await query<{ lines: number; po_nos: number }>(
    `SELECT COUNT(DISTINCT k.grn_line_id)::int AS lines, COUNT(DISTINCT upper(trim(k.po_no)))::int AS po_nos
       FROM ${AWAITING_LINK_FROM}
      WHERE k.po_id IS NULL AND k.po_no IS NOT NULL`,
  );
  return { receiptLines: Number(r?.lines ?? 0), poNos: Number(r?.po_nos ?? 0) };
}

/** When the record was last written, and the link run its latest row belongs to. */
export async function latestHoldRecord(): Promise<{ asOf: string | null; runId: string | null }> {
  const [r] = await query<{ recorded_at: Date | string; run_id: string }>(
    'SELECT recorded_at, run_id FROM store_grn_link_holds ORDER BY recorded_at DESC, id DESC LIMIT 1',
  );
  return { asOf: r ? isoOf(r.recorded_at) : null, runId: r?.run_id ?? null };
}
