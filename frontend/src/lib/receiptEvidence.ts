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
import { ApiError } from './api';
import { formatDateTime, count } from './format';

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
  sheetOnly: {
    pos: number; value: string; receiptLines: number;
    /** The latest sheet sync that read the GRN tab through, and when it finished. */
    jobId: number | null; asOf: string | null;
    /** Sync runs finished since that did not read the GRN tab (a heading renamed, a failed read, other tabs only). */
    laterRuns: number;
  };
  noneRecorded: { pos: number; value: string };
  notInErp: { receiptLines: number; poNos: number };
}

/** A store receipt awaiting link that names one PO (GET /purchase-orders/:id). */
export interface StoreReceiptAwaitingLink {
  /** The hold row: the only unique key (one GRN may hold the same item twice, same reason and detail). */
  holdId: number;
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

/** A GRN tab line naming one PO that no ERP GRN holds under its own number (GET /purchase-orders/:id). */
export interface StoreSheetReceipt {
  /** The sync issue that records the line: its unique key. */
  issueId: number;
  /** Null for a sheet row without a GRN number. */
  grnNo: string | null;
  itemCode: string;
  grnQty: string;
  sheetRow: number | null;
  reportedAt: string;
  /** What the ERP has received so far on this PO's lines for the item. */
  erpReceivedOnPoLine: string;
  /** That already covers the line's quantity. */
  erpReceiptCoversIt: boolean;
  /** Posted in the ERP since the sync reported it, under these GRN numbers (else null). */
  postedAs: string | null;
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

/** A line a Super Admin took back that the dry run would link again (wouldLink) or keeps out. */
export interface UndoneLine {
  grnLineId: number;
  grnId: number;
  grnNo: string;
  itemCode: string;
  grnQty: string;
  poNo: string | null;
  wouldLink: boolean;
  undoAuditId: number;
  undoneAt: string;
  undoReason: string;
}

/** An order that still expects goods: the only kind a receipt can still be counted against. */
export const isPendingOrder = (status: string | null | undefined) => status === 'OPEN' || status === 'PARTIALLY_RECEIVED';

const STATUS_WORDS: Record<string, string> = {
  COMPLETED: 'fully received', SHORT_CLOSED: 'short-closed', CANCELLED: 'cancelled', DRAFT: 'a draft',
};
/** How the PO screen names an order that expects no more goods, e.g. "fully received". */
export const closedOrderWords = (status: string) => STATUS_WORDS[status] ?? status.toLowerCase().replace(/_/g, ' ');

/** The next actions, word for word as the owner's brief gives them, with what follows from the 2026-10-17 review. */
export const NEXT_ACTION_AWAITING_LINK = 'Purchase confirms which PO line each receipt belongs to (or corrects the GRN tab or the PO register); '
  + 'a Super Admin then re-runs Link store GRNs in Admin > Data Management.';
export const NEXT_ACTION_AWAITING_CLOSED = 'Purchase checks which order each receipt belongs to and corrects the GRN tab or the PO register. '
  + 'This order expects no more goods, so Link store GRNs will not link these receipts to it.';
export const NEXT_ACTION_SHEET_ONLY = 'The store has recorded this receipt on the GRN sheet but not in the ERP. '
  + 'Post it through Goods Receipt (GRN) in the ERP; the sheet sync never creates receipts. '
  + 'Once it is posted, or if it already is under another GRN number, resolve its sync issue in Admin > Google Sheets sync '
  + '(Conflicts & errors) or correct the GRN number on the sheet, so the sync stops reporting it.';
export const NEXT_ACTION_POSTED_IN_ERP = 'Nothing is left to receive for these lines. Resolve their sync issues in Admin > Google Sheets sync '
  + '(Conflicts & errors), or correct the GRN number on the sheet to the ERP\'s, so the sync stops reporting them.';

/** The PO screen's words for its store receipts awaiting link, by the order's status. */
export function awaitingBannerCopy(status: string, n: number): { title: string; text: string; next: string } {
  const receipts = n === 1 ? 'A store receipt names' : `${count(n)} store receipts name`;
  if (isPendingOrder(status)) {
    return {
      title: `${receipts} this purchase order but ${n === 1 ? 'is' : 'are'} not linked to it yet`,
      text: 'The goods may already have come: until a receipt is linked, this order counts its quantity as still to be received.',
      next: NEXT_ACTION_AWAITING_LINK,
    };
  }
  return {
    title: `${receipts} this purchase order, which is ${closedOrderWords(status)}`,
    text: `Link store GRNs held ${n === 1 ? 'it' : 'them'} back. The order expects no more goods, so nothing on it is counted as still to come; `
      + `${n === 1 ? 'the receipt is' : 'the receipts are'} listed so purchase can see which order ${n === 1 ? 'it belongs' : 'they belong'} to.`,
    next: NEXT_ACTION_AWAITING_CLOSED,
  };
}

/** The tooltip of a list row's "Receipt awaiting link" badge, by the order's status. */
export function awaitingBadgeTip(status: string, n: number): string {
  const lines = n === 1 ? '1 store receipt line names' : `${count(n)} store receipt lines name`;
  return isPendingOrder(status)
    ? `${lines} this PO but ${n === 1 ? 'is' : 'are'} not linked to it yet, so its goods may have come. Open the PO to see why.`
    : `${lines} this PO, held back by Link store GRNs; the order is ${closedOrderWords(status)}, so nothing on it is counted as still to come.`;
}

/**
 * Whether the sheet banner offers Receive material: only while some line on the sheet only
 * is not already covered by what the ERP has received on the PO line. A line the ERP
 * covers may have been posted under another number before the sync reported it.
 */
export const sheetReceiptNeedsPosting = (lines: StoreSheetReceipt[]) => lines.some((l) => !l.erpReceiptCoversIt);

/** "as of" wording of the Pending PO list's receipt evidence tiles. */
export function evidenceAsOf(summary: ReceiptEvidenceSummary | undefined): string[] {
  if (!summary) return [];
  const parts: string[] = [];
  if (summary.asOf) parts.push(`receipts awaiting link as the last Link store GRNs run recorded them (${formatDateTime(summary.asOf)})`);
  const s = summary.sheetOnly;
  if (s.jobId) {
    parts.push(`the store's GRN sheet as sheet sync #${s.jobId} last read it through (${formatDateTime(s.asOf)})`
      + (s.laterRuns > 0 ? `; ${count(s.laterRuns)} later sync run${s.laterRuns === 1 ? '' : 's'} did not read it, so receipts posted since may still be listed` : ''));
  } else if (s.laterRuns > 0) {
    parts.push('no sheet sync has read the GRN tab through yet, so no receipt is counted as on the store sheet only');
  }
  return parts;
}

/**
 * What became of an Apply that failed: refused by the server as stale (409, nothing
 * written), refused for another reason (nothing written), or unknown: the request
 * timed out or never got an answer (status 0), and the server may still have committed.
 */
export function applyFailure(error: unknown): 'changed' | 'unknown' | 'refused' {
  if (error instanceof ApiError && error.status === 409) return 'changed';
  if (error instanceof ApiError && error.status === 0) return 'unknown';
  if (!(error instanceof ApiError)) return 'unknown';
  return 'refused';
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
