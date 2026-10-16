/**
 * Ledger-only void of TEST stock documents (admin repair, 2026-10-16).
 *
 * Only for documents whose stock effect the sheet-driven live stock ALREADY
 * excludes. The production case (audit A3, TR-3): an automated E2E run on
 * 2026-10-14 posted GRN-20261014-0001 (+20), ISS-20261014-0001 (-5) and
 * DIR-20261014-0002 (-1) on item 1161480001. Before commit 8ccfd40 the inventory
 * sync then set the item to its sheet figure (3) without writing a ledger row, so
 * live stock no longer holds the chain's +14 but the ledger still does (17). The
 * normal cancel / reversal routes would take the +14 out a second time (3 - 14).
 *
 * The void therefore, for each document:
 *   · marks it CANCELLED (GRN, direct issue) or REVERSED (issue slip) with the
 *     reason — nothing is deleted, and the GRN's MLN stays;
 *   · appends its reversal rows (GRN_REVERSAL / REQUISITION_REVERSAL /
 *     DIRECT_ISSUE_REVERSAL) carrying the running LEDGER balance;
 *   · never changes items.live_stock_qty.
 * It is refused unless, for every affected item, ledger sum + the void's net
 * equals live stock within 0.0001 — the proof that it removes only what the sheet
 * reset already removed and never forces a balance. Documents are reversed newest
 * first, so the production ledger reads 17 -> 18 -> 23 -> 3.
 *
 * The plan is pure arithmetic over current rows, so a dry run and the apply
 * compute the same thing; its sha256 (selectionHash) pins the apply to exactly
 * what the dry run showed.
 */
import { createHash } from 'node:crypto';
import type Decimal from 'decimal.js';
import { txQuery, txQueryOne, type Queryable } from '../../db/index.js';
import { dec, toQty } from '../../domain/money.js';
import { usableQtyOf, appendLedgerOnlyReversal } from '../../domain/stock.js';
import { recomputeRequisitionStatus } from '../../domain/quantities.js';
import { auditIn, type AuditActor } from '../../core/audit.js';

export const VOID_DOCUMENT_TYPES = ['GRN', 'REQUISITION_ISSUE', 'DIRECT_ISSUE'] as const;
export type VoidDocumentType = (typeof VOID_DOCUMENT_TYPES)[number];
export interface VoidDocumentRef { type: VoidDocumentType; number: string }

/** Ledger sum + void must land on live stock this closely (NUMERIC(18,4)). */
const TOLERANCE = dec('0.0001');

const REVERSAL_TYPE = {
  GRN: 'GRN_REVERSAL', REQUISITION_ISSUE: 'REQUISITION_REVERSAL', DIRECT_ISSUE: 'DIRECT_ISSUE_REVERSAL',
} as const;
const REFERENCE_TYPE = { GRN: 'GRN', REQUISITION_ISSUE: 'REQUISITION', DIRECT_ISSUE: 'DIRECT_ISSUE' } as const;
/** The only state a document can be voided from — the one in which its stock effect is live. */
const VOIDABLE_STATUS = { GRN: 'POSTED', REQUISITION_ISSUE: 'POSTED', DIRECT_ISSUE: 'ISSUED' } as const;
const VOIDED_STATUS = { GRN: 'CANCELLED', REQUISITION_ISSUE: 'REVERSED', DIRECT_ISSUE: 'CANCELLED' } as const;
const AUDIT_ENTITY = { GRN: 'grn', REQUISITION_ISSUE: 'requisition_issue', DIRECT_ISSUE: 'direct_issue' } as const;

export interface VoidLine {
  itemId: number;
  itemCode: string;
  uomId: number | null;
  /** The document line's quantity (a GRN line's usable quantity). */
  qty: string;
  txnType: (typeof REVERSAL_TYPE)[VoidDocumentType];
  inwardQty: string;
  outwardQty: string;
  /** Running ledger balance after this line's reversal row; set once the plan is ordered. */
  balanceQty: string | null;
  // Copied onto a GRN_REVERSAL row exactly as reverseGrnLine does.
  grnLineId: number | null;
  mlnNo: string;
  poLineId: number | null;
  batchNo: string;
}

export interface VoidDocument {
  type: VoidDocumentType;
  number: string;
  id: number | null;
  status: string | null;
  becomes: string;
  /** stock_ledger.reference_id of the reversal rows: the GRN, the slip's requisition, the direct issue. */
  referenceId: number | null;
  requisitionId: number | null;
  requisitionNo: string | null;
  supplierId: number | null;
  poIds: number[];
  lines: VoidLine[];
  /** Per item: what the document says it moved, and what its ledger rows actually net to. */
  ledger: { itemId: number; documentNet: string; ledgerNet: string }[];
  lastLedgerId: number;
  blockers: string[];
}

export interface VoidItem {
  itemId: number;
  itemCode: string;
  ledgerSum: string;
  liveStock: string;
  voidNet: string;
  resultingLedgerSum: string;
  closesExactly: boolean;
  rows: { document: string; txnType: string; inwardQty: string; outwardQty: string; balanceQty: string }[];
}

export interface VoidPlan {
  documents: VoidDocument[];
  items: VoidItem[];
  /** Why a listed document cannot be voided (not found, wrong state, ledger disagrees, listed twice). */
  blockers: string[];
  closesExactly: boolean;
  canApply: boolean;
  selectionHash: string;
}

type LedgerNetRow = { item_id: number; net: string; last_id: number };

function emptyDocument(ref: VoidDocumentRef): VoidDocument {
  return {
    type: ref.type, number: ref.number, id: null, status: null, becomes: VOIDED_STATUS[ref.type],
    referenceId: null, requisitionId: null, requisitionNo: null, supplierId: null, poIds: [],
    lines: [], ledger: [], lastLedgerId: 0, blockers: [],
  };
}

function reversalLine(
  type: VoidDocumentType,
  l: { item_id: number; item_code: string; uom_id: number | null },
  qty: string,
  grn?: { id: number; mln_no: string | null; po_line_id: number | null; batch_no: string },
): VoidLine {
  const inward = type !== 'GRN';
  return {
    itemId: Number(l.item_id), itemCode: l.item_code, uomId: l.uom_id == null ? null : Number(l.uom_id),
    qty: toQty(qty), txnType: REVERSAL_TYPE[type],
    inwardQty: inward ? toQty(qty) : toQty(0), outwardQty: inward ? toQty(0) : toQty(qty), balanceQty: null,
    grnLineId: grn ? Number(grn.id) : null, mlnNo: grn?.mln_no ?? '',
    poLineId: grn?.po_line_id == null ? null : Number(grn.po_line_id), batchNo: grn?.batch_no ?? '',
  };
}

/** Reads one document, its lines and what its own ledger rows net to, per item. */
async function loadDocument(tx: Queryable, ref: VoidDocumentRef, lock: boolean): Promise<VoidDocument> {
  const doc = emptyDocument(ref);
  const forUpdate = lock ? ' FOR UPDATE' : '';
  let ledger: LedgerNetRow[] = [];

  if (ref.type === 'GRN') {
    const h = await txQueryOne<{ id: number; status: string; supplier_id: number | null }>(
      tx, `SELECT id, status, supplier_id FROM grn_headers WHERE grn_no = $1${forUpdate}`, [ref.number],
    );
    if (!h) { doc.blockers.push(`GRN ${ref.number} was not found.`); return doc; }
    Object.assign(doc, { id: Number(h.id), status: h.status, referenceId: Number(h.id), supplierId: h.supplier_id == null ? null : Number(h.supplier_id) });
    const lines = await txQuery<{
      id: number; item_id: number; item_code: string; uom_id: number | null; grn_qty: string; accepted_qty: string | null;
      po_line_id: number | null; batch_no: string; mln_no: string | null; po_id: number | null;
    }>(
      tx,
      `SELECT gl.id, gl.item_id, gl.item_code, gl.uom_id, gl.grn_qty, gl.accepted_qty, gl.po_line_id, gl.batch_no,
              m.mln_no, pol.po_id
         FROM grn_lines gl
         LEFT JOIN grn_line_mlns m ON m.grn_line_id = gl.id
         LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
        WHERE gl.grn_id = $1
        ORDER BY gl.line_no, gl.id`,
      [h.id],
    );
    doc.lines = lines.map((l) => reversalLine('GRN', l, usableQtyOf(l), l));
    doc.poIds = [...new Set(lines.filter((l) => l.po_id != null).map((l) => Number(l.po_id)))];
    ledger = await txQuery<LedgerNetRow>(
      tx,
      `SELECT item_id, SUM(inward_qty - outward_qty) AS net, MAX(id) AS last_id FROM stock_ledger
        WHERE reference_type = 'GRN' AND reference_id = $1 AND txn_type IN ('GRN_INWARD', 'GRN_REVERSAL')
        GROUP BY item_id`,
      [h.id],
    );
  } else if (ref.type === 'REQUISITION_ISSUE') {
    const h = await txQueryOne<{ id: number; status: string; requisition_id: number; requisition_no: string }>(
      tx,
      `SELECT ri.id, ri.status, ri.requisition_id, rh.requisition_no
         FROM requisition_issues ri JOIN requisition_headers rh ON rh.id = ri.requisition_id
        WHERE ri.issue_slip_no = $1${lock ? ' FOR UPDATE OF ri, rh' : ''}`,
      [ref.number],
    );
    if (!h) { doc.blockers.push(`Issue slip ${ref.number} was not found.`); return doc; }
    Object.assign(doc, {
      id: Number(h.id), status: h.status, referenceId: Number(h.requisition_id),
      requisitionId: Number(h.requisition_id), requisitionNo: h.requisition_no,
    });
    const lines = await txQuery<{ item_id: number; item_code: string; uom_id: number | null; issue_qty: string }>(
      tx,
      `SELECT ril.item_id, rl.item_code, ril.uom_id, ril.issue_qty
         FROM requisition_issue_lines ril JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
        WHERE ril.requisition_issue_id = $1
        ORDER BY ril.id`,
      [h.id],
    );
    doc.lines = lines.map((l) => reversalLine('REQUISITION_ISSUE', l, l.issue_qty));
    // By slip number, not reference_id: the API ledgers a slip against its
    // requisition, the 2026-10-14 import against the slip itself; both carry the
    // (unique) slip number.
    ledger = await txQuery<LedgerNetRow>(
      tx,
      `SELECT item_id, SUM(inward_qty - outward_qty) AS net, MAX(id) AS last_id FROM stock_ledger
        WHERE reference_no = $1 AND txn_type IN ('REQUISITION_ISSUE', 'REQUISITION_REVERSAL')
        GROUP BY item_id`,
      [ref.number],
    );
  } else {
    const h = await txQueryOne<{ id: number; status: string }>(
      tx, `SELECT id, status FROM direct_issue_headers WHERE issue_no = $1${forUpdate}`, [ref.number],
    );
    if (!h) { doc.blockers.push(`Direct issue ${ref.number} was not found.`); return doc; }
    Object.assign(doc, { id: Number(h.id), status: h.status, referenceId: Number(h.id) });
    const lines = await txQuery<{ item_id: number; item_code: string; uom_id: number | null; issue_qty: string }>(
      tx,
      'SELECT item_id, item_code, uom_id, issue_qty FROM direct_issue_lines WHERE direct_issue_id = $1 ORDER BY line_no, id',
      [h.id],
    );
    doc.lines = lines.map((l) => reversalLine('DIRECT_ISSUE', l, l.issue_qty));
    ledger = await txQuery<LedgerNetRow>(
      tx,
      `SELECT item_id, SUM(inward_qty - outward_qty) AS net, MAX(id) AS last_id FROM stock_ledger
        WHERE reference_type = 'DIRECT_ISSUE' AND reference_id = $1 AND txn_type IN ('DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL')
        GROUP BY item_id`,
      [h.id],
    );
  }

  doc.lastLedgerId = ledger.reduce((m, r) => Math.max(m, Number(r.last_id)), 0);
  if (doc.status !== VOIDABLE_STATUS[ref.type]) {
    doc.blockers.push(`${ref.number} is ${doc.status}, not ${VOIDABLE_STATUS[ref.type]}; it cannot be voided.`);
    return doc;
  }

  // The document must still hold exactly the stock effect its lines describe —
  // anything else (a partial correction, a missing entry) needs a person, not this repair.
  const documentNet = new Map<number, Decimal>();
  for (const l of doc.lines) {
    const signed = dec(l.inwardQty).minus(dec(l.outwardQty)).negated();
    documentNet.set(l.itemId, (documentNet.get(l.itemId) ?? dec(0)).plus(signed));
  }
  const ledgerNet = new Map(ledger.map((r) => [Number(r.item_id), dec(r.net)]));
  const codeOf = new Map(doc.lines.map((l) => [l.itemId, l.itemCode]));
  for (const itemId of [...new Set([...documentNet.keys(), ...ledgerNet.keys()])].sort((a, b) => a - b)) {
    const said = documentNet.get(itemId) ?? dec(0);
    const booked = ledgerNet.get(itemId) ?? dec(0);
    doc.ledger.push({ itemId, documentNet: toQty(said), ledgerNet: toQty(booked) });
    if (!said.equals(booked)) {
      doc.blockers.push(
        `${ref.number}: its ledger entries for ${codeOf.get(itemId) ?? `item #${itemId}`} net ${toQty(booked)}, ` +
        `but the document moved ${toQty(said)}; review it by hand.`,
      );
    }
  }
  return doc;
}

/**
 * Builds the void plan. Run it on the database for a dry run, and again inside the
 * apply transaction with `lock` (documents, then items, FOR UPDATE) so what is
 * written is exactly what was checked.
 */
export async function planTestDocumentVoid(
  tx: Queryable, refs: VoidDocumentRef[], opts: { lock: boolean },
): Promise<VoidPlan> {
  const blockers: string[] = [];
  const seen = new Set<string>();
  const documents: VoidDocument[] = [];
  for (const ref of refs) {
    const key = `${ref.type}|${ref.number}`;
    if (seen.has(key)) { blockers.push(`${ref.number} is listed more than once.`); continue; }
    seen.add(key);
    documents.push(await loadDocument(tx, ref, opts.lock));
  }
  for (const d of documents) blockers.push(...d.blockers);

  // Newest posting first: undo the issue before the receipt it drew on (LIFO by ledger entry).
  const voidable = documents.filter((d) => d.blockers.length === 0)
    .sort((a, b) => b.lastLedgerId - a.lastLedgerId || a.type.localeCompare(b.type) || a.number.localeCompare(b.number));
  const blocked = documents.filter((d) => d.blockers.length > 0)
    .sort((a, b) => a.type.localeCompare(b.type) || a.number.localeCompare(b.number));

  const itemIds = [...new Set(voidable.flatMap((d) => d.lines.filter((l) => dec(l.qty).greaterThan(0)).map((l) => l.itemId)))]
    .sort((a, b) => a - b);
  const itemRows = itemIds.length
    ? await txQuery<{ id: number; item_code: string; live_stock_qty: string }>(
      tx, `SELECT id, item_code, live_stock_qty FROM items WHERE id = ANY($1::bigint[]) ORDER BY id${opts.lock ? ' FOR UPDATE' : ''}`, [itemIds],
    )
    : [];
  const sums = itemIds.length
    ? await txQuery<{ item_id: number; ledger_sum: string }>(
      tx,
      `SELECT item_id, COALESCE(SUM(inward_qty - outward_qty), 0) AS ledger_sum FROM stock_ledger
        WHERE item_id = ANY($1::bigint[]) GROUP BY item_id`,
      [itemIds],
    )
    : [];
  const sumOf = new Map(sums.map((s) => [Number(s.item_id), dec(s.ledger_sum)]));

  const items = new Map<number, VoidItem>();
  const running = new Map<number, Decimal>();
  for (const it of itemRows) {
    const ledgerSum = sumOf.get(Number(it.id)) ?? dec(0);
    running.set(Number(it.id), ledgerSum);
    items.set(Number(it.id), {
      itemId: Number(it.id), itemCode: it.item_code, ledgerSum: toQty(ledgerSum), liveStock: toQty(it.live_stock_qty),
      voidNet: toQty(0), resultingLedgerSum: toQty(ledgerSum), closesExactly: false, rows: [],
    });
  }
  for (const d of voidable) {
    for (const l of d.lines) {
      const item = items.get(l.itemId);
      if (!item || !dec(l.qty).greaterThan(0)) continue;
      const next = running.get(l.itemId)!.plus(dec(l.inwardQty)).minus(dec(l.outwardQty));
      running.set(l.itemId, next);
      l.balanceQty = toQty(next);
      item.rows.push({ document: d.number, txnType: l.txnType, inwardQty: l.inwardQty, outwardQty: l.outwardQty, balanceQty: l.balanceQty });
    }
  }
  for (const item of items.values()) {
    const resulting = running.get(item.itemId)!;
    item.resultingLedgerSum = toQty(resulting);
    item.voidNet = toQty(resulting.minus(dec(item.ledgerSum)));
    item.closesExactly = resulting.minus(dec(item.liveStock)).abs().lessThanOrEqualTo(TOLERANCE);
  }

  const orderedDocs = [...voidable, ...blocked];
  const orderedItems = [...items.values()];
  const closesExactly = orderedItems.length > 0 && orderedItems.every((i) => i.closesExactly);
  const canonical = JSON.stringify({
    documents: orderedDocs.map((d) => [d.type, d.number, d.id, d.status, d.lines.map((l) => [l.itemId, l.txnType, l.inwardQty, l.outwardQty])]),
    items: orderedItems.map((i) => [i.itemId, i.ledgerSum, i.liveStock, i.rows.map((r) => [r.document, r.txnType, r.inwardQty, r.outwardQty, r.balanceQty])]),
    blockers,
  });
  return {
    documents: orderedDocs,
    items: orderedItems,
    blockers,
    closesExactly,
    canApply: blockers.length === 0 && closesExactly,
    selectionHash: createHash('sha256').update(canonical).digest('hex'),
  };
}

/**
 * Writes a plan that has passed every check: marks each document, appends its
 * ledger-only reversal rows, re-derives the affected PO and requisition statuses,
 * audits each document, and finally re-proves ledger = live for every item.
 */
export async function applyTestDocumentVoid(
  tx: Queryable,
  plan: VoidPlan,
  ctx: { reason: string; userId: number; actor: AuditActor; date: string },
): Promise<{ poStatusesRederived: number; requisitionStatuses: { requisitionNo: string; from: string; to: string }[] }> {
  const poIds = new Set<number>();
  const requisitions = new Map<number, string>();

  for (const d of plan.documents) {
    const id = d.id!;
    if (d.type === 'GRN') {
      await tx.query(
        `UPDATE grn_headers
            SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2, cancel_reason = $3,
                updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [id, ctx.userId, ctx.reason],
      );
      d.poIds.forEach((p) => poIds.add(p));
    } else if (d.type === 'REQUISITION_ISSUE') {
      await tx.query(
        `UPDATE requisition_issues SET status = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = $3
          WHERE id = $1`,
        [id, ctx.userId, ctx.reason],
      );
      requisitions.set(d.requisitionId!, d.requisitionNo!);
    } else {
      await tx.query(
        `UPDATE direct_issue_headers SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2,
                cancel_reason = $3, updated_at = now()
          WHERE id = $1`,
        [id, ctx.userId, ctx.reason],
      );
    }
    for (const l of d.lines) {
      if (l.balanceQty === null) continue; // a zero-quantity line moved nothing
      await appendLedgerOnlyReversal(tx, {
        itemId: l.itemId, txnType: l.txnType, referenceType: REFERENCE_TYPE[d.type], referenceId: d.referenceId!,
        referenceNo: d.number, inwardQty: l.inwardQty, outwardQty: l.outwardQty, balanceQty: l.balanceQty, uomId: l.uomId,
        grnLineId: l.grnLineId, mlnNo: l.mlnNo, poLineId: l.poLineId, supplierId: d.type === 'GRN' ? d.supplierId : null,
        batchNo: l.batchNo, txnDate: ctx.date, userId: ctx.userId,
      });
    }
    await auditIn(tx, {
      actor: ctx.actor, action: 'CANCEL', entity: AUDIT_ENTITY[d.type], entityId: id, entityLabel: d.number,
      before: { status: d.status, ledger: d.ledger },
      after: {
        status: d.becomes, reason: ctx.reason, ledgerOnly: true, liveStockChanged: false,
        reversalRows: d.lines.filter((l) => l.balanceQty !== null)
          .map((l) => ({ item: l.itemCode, txnType: l.txnType, inwardQty: l.inwardQty, outwardQty: l.outwardQty, ledgerBalance: l.balanceQty })),
        selectionHash: plan.selectionHash,
      },
      message: `${d.number} voided as a test document (ledger only; live stock unchanged, it already excluded this document). Reason: ${ctx.reason}`,
    });
  }

  // A cancelled GRN no longer counts as received (v_po_line_balance), so its POs fall back.
  const { recomputePoStatuses } = await import('../google-sync/engine.js');
  const poStatusesRederived = poIds.size > 0 ? await recomputePoStatuses(tx, [...poIds]) : 0;
  const requisitionStatuses: { requisitionNo: string; from: string; to: string }[] = [];
  for (const [requisitionId, requisitionNo] of requisitions) {
    const r = await recomputeRequisitionStatus(tx, requisitionId, ctx.userId);
    requisitionStatuses.push({ requisitionNo, from: r.from, to: r.to });
  }

  // Belt and braces: re-read what was written. Any drift rolls the whole void back.
  for (const item of plan.items) {
    const after = await txQueryOne<{ ledger_sum: string; live: string }>(
      tx,
      `SELECT (SELECT COALESCE(SUM(inward_qty - outward_qty), 0) FROM stock_ledger WHERE item_id = $1) AS ledger_sum,
              (SELECT live_stock_qty FROM items WHERE id = $1) AS live`,
      [item.itemId],
    );
    if (!after || dec(after.ledger_sum).minus(dec(after.live)).abs().greaterThan(TOLERANCE) || !dec(after.live).equals(dec(item.liveStock))) {
      throw new Error(`Void check failed for ${item.itemCode}: ledger ${after?.ledger_sum}, live ${after?.live}; nothing was written.`);
    }
  }
  return { poStatusesRederived, requisitionStatuses };
}
