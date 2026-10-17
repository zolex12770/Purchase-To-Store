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
 *
 * Every set is built once per statement (an ARRAY, an InitPlan, or a MATERIALIZED CTE)
 * and each PO is looked up in it. A correlated count per PO let a database without
 * planner statistics hash every GRN line again for each of 2,003 POs: 32.4 s for one
 * PO export on a copy restored from the 2026-10-17 backup (db/statistics.ts).
 */
import { query, txQuery, type Queryable } from '../../db/index.js';
import { dec, toQty } from '../../domain/money.js';
import { PO_AFTER_RECEIPT_DAYS, STORE_GRN_TAB, type HoldReason } from '../admin/store-grn-links.js';

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

/**
 * SQL: the latest finished sync of the business sheet that read the GRN tab through.
 * Its outcome for the tab (google_sync_jobs.detail) carries issuesResolved, which the
 * engine sets only once resolveVanishedIssues has checked the tab's open issues against
 * every row of it (runSyncLocked). A run that did not get that far (a heading renamed,
 * MISSING_COLUMN; the read failing, SHEET_FAILED; the tab switched off in the mappings;
 * a run of other tabs only) left those issues unchecked, so it is not what they are as
 * of, even though such a run still ends PARTIAL. On the 2026-10-17 backup every run from
 * 2774 to 2780 read the tab through (6,953 rows).
 */
export const LATEST_GRN_READ_JOB_ID = `(SELECT max(j.id) FROM google_sync_jobs j
  WHERE j.status IN ('SUCCESS', 'PARTIAL')
    AND jsonb_path_exists(j.detail, '$[*] ? (@.sheet == "${STORE_GRN_TAB}" && @.issuesResolved.type() == "number")'))`;

/**
 * THE definition of the receipts on the store sheet only, written once: one row per
 * GRN tab line the ERP lacks, still open as of the latest complete read of the tab.
 * The engine records such a line once, under the run that first reports it, keeps it
 * open while every later read still reports it, and closes it once a read no longer
 * does (onlyNewIssues, resolveVanishedIssues). So the open rows recorded up to that read
 * are what it reported; rows of a run still in progress wait for it to finish.
 *
 * posted_since: an ERP receipt for the same PO and item, posted after the sync first
 * reported the line, covers its quantity. Posting the receipt in the ERP does not close
 * the line: the sync looks for an ERP GRN under the sheet's own GRN number (engine.ts),
 * and a GRN posted in the ERP takes the ERP's number (GRN-YYYYMMDD-NNNN). On the
 * 2026-10-17 review copy Z/SM/00043's sheet line ZG/SM/0084 (365.8) was posted as
 * GRN-20261017-0001 and the next sync still reported it, so the PO kept asking for the
 * receipt to be posted, inviting a second posting. Such a line no longer counts and
 * the PO screen lists it as posted under another number. The quantity posted since is
 * matched to the PO's lines for the item in sheet row order, so a smaller delivery
 * posted meanwhile clears no line it does not cover.
 *
 * Columns: issue_id, po_key (the PO number named, upper case, trimmed; never NULL),
 * grn_no, item_code, grn_qty, sheet_row, reported_at, posted_since, posted_grn_nos.
 */
export const SHEET_LINES = `
  WITH sheet_open AS (
    SELECT e.id AS issue_id, e.row_number AS sheet_row, e.created_at AS reported_at,
           NULLIF(upper(trim(e.incoming_value->>'poNo')), '') AS po_key,
           NULLIF(trim(e.incoming_value->>'grnNo'), '') AS grn_no,
           trim(COALESCE(e.incoming_value->>'itemCode', '')) AS item_code,
           CASE WHEN (e.incoming_value->>'grnQty') ~ '^-?[0-9]+([.][0-9]+)?([eE][-+]?[0-9]+)?$'
                THEN (e.incoming_value->>'grnQty')::numeric ELSE 0 END AS grn_qty
      FROM google_sync_errors e
     WHERE e.sheet_name = '${STORE_GRN_TAB}' AND e.error_code = 'MISSING_IN_ERP' AND e.resolved_at IS NULL
       AND e.job_id <= ${LATEST_GRN_READ_JOB_ID}
  ), sheet_posted AS (
    SELECT g.po_key, g.item_key, SUM(pgl.grn_qty) AS qty, string_agg(DISTINCT pgh.grn_no, ', ' ORDER BY pgh.grn_no) AS grn_nos
      FROM (SELECT po_key, upper(item_code) AS item_key, min(reported_at) AS first_reported
              FROM sheet_open WHERE po_key IS NOT NULL GROUP BY po_key, upper(item_code)) g
      JOIN purchase_order_headers pph ON upper(trim(pph.po_no)) = g.po_key
      JOIN purchase_order_lines ppl ON ppl.po_id = pph.id
      JOIN grn_lines pgl ON pgl.po_line_id = ppl.id
      JOIN grn_headers pgh ON pgh.id = pgl.grn_id AND pgh.status = 'POSTED'
     WHERE g.item_key IN (upper(pgl.item_code), upper(ppl.item_code), upper(ppl.item_description))
       AND COALESCE(pgh.posted_at, pgh.created_at) > g.first_reported
     GROUP BY g.po_key, g.item_key
  )
  SELECT o.issue_id, o.po_key, o.grn_no, o.item_code, o.grn_qty, o.sheet_row, o.reported_at,
         COALESCE(SUM(o.grn_qty) OVER (PARTITION BY o.po_key, upper(o.item_code) ORDER BY o.sheet_row NULLS LAST, o.issue_id
                                       ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) <= p.qty, FALSE) AS posted_since,
         p.grn_nos AS posted_grn_nos
    FROM sheet_open o
    LEFT JOIN sheet_posted p ON p.po_key = o.po_key AND p.item_key = upper(o.item_code)
   WHERE o.po_key IS NOT NULL`;

/** SQL: the ERP POs a standing hold row names. */
const AWAITING_PO_IDS = `SELECT DISTINCT k.po_id FROM ${AWAITING_LINK_FROM} WHERE k.po_id IS NOT NULL`;
/** SQL: the PO numbers (upper case, trimmed) the receipts still on the store sheet only name. */
const SHEET_ONLY_PO_KEYS = `SELECT DISTINCT s.po_key FROM (${SHEET_LINES}) s WHERE NOT s.posted_since`;

/**
 * SQL condition: the PO header aliased `po` (any row with its id and po_no) falls in the
 * evidence class `evidence`. Each set of POs is read once per query, as an array (an
 * InitPlan), and every PO is looked up in it. Neither array holds a NULL, so
 * NOT ... = ANY is plainly true or false.
 */
export function receiptEvidenceCondition(evidence: ReceiptEvidence, po: string): string {
  const awaiting = `${po}.id = ANY (ARRAY(${AWAITING_PO_IDS}))`;
  const onSheet = `upper(trim(${po}.po_no)) = ANY (ARRAY(${SHEET_ONLY_PO_KEYS}))`;
  if (evidence === 'awaiting_link') return awaiting;
  if (evidence === 'sheet_only') return `(NOT ${awaiting} AND ${onSheet})`;
  return `(NOT ${awaiting} AND NOT ${onSheet})`;
}

/**
 * The per-PO counts a PO list row and its export carry (store_receipts_awaiting_link,
 * store_sheet_receipts): a WITH clause that counts each set once (MATERIALIZED), and
 * the two columns, each a lookup of the PO header aliased `po` in its set. Lookups, not
 * joins: joined, the two sets changed the plan of the list's own pending test on a
 * database without statistics, and the 'No receipt recorded' page took 40.6 s against
 * 1.3 s without them (2026-10-17 copy); looked up, it took 1.5 s.
 */
export const EVIDENCE_COUNTS_WITH = `ev_awaiting AS MATERIALIZED (
    SELECT k.po_id, COUNT(*)::int AS n FROM ${AWAITING_LINK_FROM} WHERE k.po_id IS NOT NULL GROUP BY k.po_id
  ), ev_sheet AS MATERIALIZED (
    SELECT s.po_key, COUNT(*)::int AS n FROM (${SHEET_LINES}) s WHERE NOT s.posted_since GROUP BY s.po_key
  )`;
export const evidenceCountColumns = (po: string): string =>
  `COALESCE((SELECT a.n FROM ev_awaiting a WHERE a.po_id = ${po}.id), 0) AS store_receipts_awaiting_link,
   COALESCE((SELECT x.n FROM ev_sheet x WHERE x.po_key = upper(trim(${po}.po_no))), 0) AS store_sheet_receipts`;

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
  /** The hold row (store_grn_link_holds.id): unique, unlike a GRN and item, which may repeat on one GRN. */
  holdId: number;
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
    id: number; grn_id: number; grn_no: string; grn_date: string; item_code: string; grn_qty: string;
    po_line_no: number | null; reason: HoldRowReason; detail: string; recorded_at: Date | string;
  }>(
    // The date as text whatever the DateStyle, as the link run reads it.
    `SELECT k.id, gh.id AS grn_id, gh.grn_no, to_char(gh.grn_date, 'YYYY-MM-DD') AS grn_date, k.item_code,
            k.grn_qty::text AS grn_qty, pol.line_no AS po_line_no, k.reason, k.detail, k.recorded_at
       FROM ${AWAITING_LINK_FROM}
       LEFT JOIN purchase_order_lines pol ON pol.id = k.po_line_id
      WHERE k.po_id = $1
      ORDER BY gh.grn_date, gh.grn_no, k.grn_line_id, k.id`,
    [poId],
  );
  return rows.map((r) => ({
    holdId: Number(r.id), grnId: Number(r.grn_id), grnNo: r.grn_no, grnDate: r.grn_date, itemCode: r.item_code,
    grnQty: toQty(r.grn_qty), poLineNo: r.po_line_no == null ? null : Number(r.po_line_no),
    reason: r.reason, reasonText: REASON_TEXT[r.reason] ?? r.reason, detail: r.detail, recordedAt: isoOf(r.recorded_at),
  }));
}

export interface StoreSheetReceipt {
  /** The sync issue (google_sync_errors.id) that records the line: unique per line. */
  issueId: number;
  /** Null for a tab row without a GRN number, which the sync compares by PO and item. */
  grnNo: string | null;
  itemCode: string;
  grnQty: string;
  /** The GRN tab's row number (the header is row 1). */
  sheetRow: number | null;
  /** When the sync first reported the line. */
  reportedAt: string;
  /** What the ERP has received so far on this PO's lines for the item. */
  erpReceivedOnPoLine: string;
  /** That already covers the line's quantity: posting it again would likely receive it twice. */
  erpReceiptCoversIt: boolean;
  /** Posted in the ERP since the sync first reported the line, under these GRN numbers. */
  postedAs: string | null;
}

/**
 * The GRN tab lines naming one PO that the ERP lacks under their own GRN number
 * (GET /purchase-orders/:id): those still on the sheet only, and those an ERP receipt
 * posted since covers (posted under another number; their sync issue stays open until
 * it is resolved or the sheet's GRN number is corrected).
 */
export async function storeSheetReceipts(poId: number, poNo: string): Promise<{ onSheetOnly: StoreSheetReceipt[]; postedInErp: StoreSheetReceipt[] }> {
  const rows = await query<{
    issue_id: number; grn_no: string | null; item_code: string; grn_qty: string; sheet_row: number | null;
    reported_at: Date | string; posted_since: boolean; posted_grn_nos: string | null; received_qty: string;
  }>(
    `WITH bal AS MATERIALIZED (
       SELECT upper(b.item_code) AS code, upper(b.item_description) AS text, b.received_qty FROM v_po_line_balance b WHERE b.po_id = $1
     )
     SELECT s.issue_id, s.grn_no, s.item_code, s.grn_qty::text AS grn_qty, s.sheet_row, s.reported_at, s.posted_since, s.posted_grn_nos,
            (SELECT COALESCE(SUM(b.received_qty), 0) FROM bal b WHERE upper(s.item_code) IN (b.code, b.text))::text AS received_qty
       FROM (${SHEET_LINES}) s
      WHERE s.po_key = upper(trim($2))
      ORDER BY s.sheet_row NULLS LAST, s.issue_id`,
    [poId, poNo],
  );
  const lines = rows.map((r): StoreSheetReceipt & { postedSince: boolean } => ({
    issueId: Number(r.issue_id), grnNo: r.grn_no?.trim() || null, itemCode: r.item_code, grnQty: toQty(r.grn_qty),
    sheetRow: r.sheet_row == null ? null : Number(r.sheet_row), reportedAt: isoOf(r.reported_at),
    erpReceivedOnPoLine: toQty(r.received_qty),
    erpReceiptCoversIt: dec(r.received_qty).greaterThan(0) && dec(r.received_qty).greaterThanOrEqualTo(dec(r.grn_qty)),
    postedAs: r.posted_since ? r.posted_grn_nos : null,
    postedSince: Boolean(r.posted_since),
  }));
  const strip = ({ postedSince: _s, ...line }: StoreSheetReceipt & { postedSince: boolean }): StoreSheetReceipt => line;
  return {
    onSheetOnly: lines.filter((l) => !l.postedSince).map(strip),
    postedInErp: lines.filter((l) => l.postedSince).map(strip),
  };
}

/**
 * The receipt lines awaiting link on the POs of the pending list `listed` (SQL selecting
 * h.id and h.po_no, its parameters in `params`) that fall in 'awaiting link', in all and
 * by reason. A line naming two of those POs counts once. The list is read once
 * (MATERIALIZED), so its pending test is never run again for each hold row.
 */
export async function awaitingLinkLines(
  db: Queryable, listed: string, params: unknown[],
): Promise<{ receiptLines: number; byReason: Record<HoldRowReason, number> }> {
  const rows = await txQuery<{ reason: HoldRowReason | null; lines: number }>(
    db,
    `WITH listed AS MATERIALIZED (${listed})
     SELECT k.reason, COUNT(DISTINCT k.grn_line_id)::int AS lines
       FROM ${AWAITING_LINK_FROM}
      WHERE k.po_id IN (SELECT l.id FROM listed l WHERE ${receiptEvidenceCondition('awaiting_link', 'l')})
      GROUP BY GROUPING SETS ((k.reason), ())`,
    params,
  );
  const byReason = Object.fromEntries(HOLD_ROW_REASONS.map((r) => [r, 0])) as Record<HoldRowReason, number>;
  let receiptLines = 0;
  for (const r of rows) {
    // The grand total comes back with no reason (reason is NOT NULL in the table).
    if (r.reason === null) receiptLines = Number(r.lines);
    else byReason[r.reason] = Number(r.lines);
  }
  return { receiptLines, byReason };
}

/** The receipt lines still on the store sheet only that name a PO of the pending list `listed` falling in 'sheet only'. */
export async function storeSheetLines(db: Queryable, listed: string, params: unknown[]): Promise<number> {
  const [r] = await txQuery<{ lines: number }>(
    db,
    `WITH listed AS MATERIALIZED (${listed})
     SELECT COUNT(*)::int AS lines FROM (${SHEET_LINES}) s
      WHERE NOT s.posted_since
        AND s.po_key IN (SELECT upper(trim(l.po_no)) FROM listed l WHERE ${receiptEvidenceCondition('sheet_only', 'l')})`,
    params,
  );
  return Number(r?.lines ?? 0);
}

/**
 * Receipt lines awaiting link whose GRN tab row names a PO number the ERP does not
 * hold, and how many such numbers: POs the PO register has not brought in, or deleted
 * since (migration 030 then keeps the number and clears the PO).
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

/**
 * The sync run the store-sheet evidence is as of (the latest that read the GRN tab
 * through), and how many runs have finished since without reading it: while that is
 * above 0, receipts posted or corrected since may still be listed.
 */
export async function latestSheetRead(db: Queryable): Promise<{ jobId: number | null; asOf: string | null; laterRuns: number }> {
  const [r] = await txQuery<{ id: number | null; finished_at: Date | string | null; later_runs: number }>(
    db,
    `SELECT g.id, j.finished_at,
            (SELECT COUNT(*)::int FROM google_sync_jobs x WHERE x.status <> 'RUNNING' AND x.id > COALESCE(g.id, 0)) AS later_runs
       FROM (SELECT ${LATEST_GRN_READ_JOB_ID} AS id) g
       LEFT JOIN google_sync_jobs j ON j.id = g.id`,
  );
  return {
    jobId: r?.id == null ? null : Number(r.id),
    asOf: r?.finished_at ? isoOf(r.finished_at) : null,
    laterRuns: Number(r?.later_runs ?? 0),
  };
}

/** How many store receipts awaiting link name the PO (the Data Management inspector). */
export async function standingHoldsNaming(poId: number): Promise<number> {
  const [r] = await query<{ n: number }>(
    `SELECT COUNT(DISTINCT k.grn_line_id)::int AS n FROM ${AWAITING_LINK_FROM} WHERE k.po_id = $1`, [poId],
  );
  return Number(r?.n ?? 0);
}
