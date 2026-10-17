/**
 * Receipt evidence of pending purchase orders (backend purchase-order/receipt-evidence.ts).
 *
 * The store's GRNs were imported before their POs existed, and the store still records
 * some receipts only on its GRN sheet. A pending PO therefore falls in one of three
 * classes, in this order: a store receipt names it that the link repair held back
 * ("awaiting link"); otherwise a receipt on the store's GRN sheet that the ERP lacks
 * names it ("store sheet only"); otherwise nothing is recorded against it. The first
 * two may have had their goods; only the third is genuinely pending.
 */

export type ReceiptEvidence = 'awaiting_link' | 'sheet_only' | 'none_recorded';

/** The filter's options, in the backend's order of precedence, in the list's words. */
export const RECEIPT_EVIDENCE_OPTIONS: Array<{ value: ReceiptEvidence; label: string; hint: string }> = [
  {
    value: 'awaiting_link',
    label: 'Store receipt awaiting link',
    hint: 'A receipt the store recorded names the PO, but Link store GRNs held it back, so the PO does not count it yet.',
  },
  {
    value: 'sheet_only',
    label: 'Receipt on store sheet only',
    hint: 'The store recorded a receipt for the PO on its GRN sheet, but no GRN for it was posted in the ERP.',
  },
  {
    value: 'none_recorded',
    label: 'No receipt recorded',
    hint: 'Nothing the store recorded names the PO: it is genuinely pending.',
  },
];

export const isReceiptEvidence = (v: unknown): v is ReceiptEvidence =>
  RECEIPT_EVIDENCE_OPTIONS.some((o) => o.value === v);

/** GET /purchase-orders/receipt-evidence/summary: the three classes add up to `pending`. */
export interface ReceiptEvidenceSummary {
  /** When the link repair last recorded the held receipts (null: never). */
  asOf: string | null;
  runId: string | null;
  pending: { pos: number; value: string };
  awaitingLink: { pos: number; value: string; receiptLines: number; byReason: Record<string, number> };
  sheetOnly: { pos: number; value: string; receiptLines: number; asOf: string | null; jobId: number | null };
  noneRecorded: { pos: number; value: string };
  notInErp: { receiptLines: number; poNos: number };
}

/** A store receipt awaiting link that names one PO (GET /purchase-orders/:id). */
export interface StoreReceiptAwaitingLink {
  grnId: number;
  grnNo: string;
  grnDate: string;
  itemCode: string;
  grnQty: string;
  poLineNo: number | null;
  reason: string;
  reasonText: string;
  detail: string;
  recordedAt: string;
}

/** A receipt on the store's GRN sheet only that names one PO (GET /purchase-orders/:id). */
export interface StoreSheetReceipt {
  /** Null for a sheet row without a GRN number. */
  grnNo: string | null;
  itemCode: string;
  grnQty: string;
  sheetRow: number | null;
  reportedAt: string;
}

/** A line the link repair's dry run holds back (POST /admin/data-management/repair/link-store-grns). */
export interface HeldLine {
  grnLineId: number;
  grnId: number;
  grnNo: string;
  itemCode: string;
  grnQty: string;
  tabRows: number[];
  reason: string;
  detail: string;
  poNos?: string[];
}

/** One CSV cell: quoted when needed, and a leading = + - @ neutralised as the server's exports do. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

export const HELD_LIST_COLUMNS = ['GRN No', 'Item Code', 'Qty', 'Reason', 'Reason (in words)', 'Detail', 'PO Numbers', 'GRN Tab Rows'];

/**
 * The dry run's held lines as a CSV for purchase to work through, one row per line:
 * what the store received, why it was not linked, and the PO numbers the GRN tab names.
 * A byte-order mark first, so Excel reads it as UTF-8.
 */
export function heldListCsv(held: HeldLine[], reasonText: Record<string, string>): string {
  const rows = held.map((h) => [
    h.grnNo, h.itemCode, h.grnQty, h.reason, reasonText[h.reason] ?? h.reason, h.detail,
    (h.poNos ?? []).join('; '), h.tabRows.join('; '),
  ]);
  return `﻿${[HELD_LIST_COLUMNS, ...rows].map((r) => r.map(csvCell).join(',')).join('\r\n')}\r\n`;
}
