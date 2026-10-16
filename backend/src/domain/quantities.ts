/**
 * Quantity control (ADR-005; SRS §11.3, §12, §20, §34).
 *
 * The ONLY place in the codebase that decides whether a requested quantity is
 * allowed. The PO service, the GRN service, the import pipeline and the sync
 * engine all call through here, so there is exactly one definition of "eligible"
 * and "outstanding" (SRS §54: no duplicate business logic).
 *
 * Every function takes a transaction handle and locks its source row before
 * reading the balance, so the check and the write cannot be separated by a
 * competing request.
 */
import { txQueryOne, type Queryable } from '../db/index.js';
import { BusinessRuleError, NotFoundError } from '../core/errors.js';
import { dec, toQty } from './money.js';

/* ── Indent line → PO ───────────────────────────────────────────────────────── */

export interface IndentLineBalance {
  indent_line_id: number;
  indent_id: number;
  indent_no: string;
  indent_status: string;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  uom_id: number | null;
  item_specification: string;
  department_id: number | null;
  cost_centre_id: number | null;
  estimated_rate: string | null;
  indent_qty: string;
  ordered_qty: string;
  pending_qty: string;
  is_closed: boolean;
  is_eligible_for_po: boolean;
  line_status: string;
}

/**
 * Locks an indent line and returns its authoritative balance.
 *
 * The FOR UPDATE is taken on `purchase_indent_lines` (the base table) because a
 * view cannot be locked; holding that row serialises every PO that would consume
 * from this line for the remainder of the caller's transaction.
 */
export async function lockIndentLineBalance(
  tx: Queryable,
  indentLineId: number,
): Promise<IndentLineBalance> {
  const locked = await txQueryOne<{ id: number }>(
    tx,
    'SELECT id FROM purchase_indent_lines WHERE id = $1 FOR UPDATE',
    [indentLineId],
  );
  if (!locked) throw NotFoundError(`Indent line ${indentLineId}`);

  const balance = await txQueryOne<IndentLineBalance>(
    tx,
    'SELECT * FROM v_indent_line_balance WHERE indent_line_id = $1',
    [indentLineId],
  );
  if (!balance) throw NotFoundError(`Indent line ${indentLineId}`);
  return balance;
}

/**
 * Asserts that `requestedQty` may be drawn from an indent line.
 *
 *   eligible = indent_qty − already-ordered qty  (SRS §11.3)
 */
export function assertIndentDrawAllowed(balance: IndentLineBalance, requestedQty: string): void {
  if (balance.indent_status !== 'APPROVED') {
    throw BusinessRuleError(
      `Indent ${balance.indent_no} is not approved (currently ${balance.indent_status}); ` +
        `only approved indents can be converted into a purchase order.`,
      { indentNo: balance.indent_no, status: balance.indent_status },
    );
  }
  if (balance.is_closed) {
    throw BusinessRuleError(
      `Line ${balance.line_no} of indent ${balance.indent_no} (${balance.item_code}) has been closed ` +
        `and cannot be ordered against.`,
    );
  }

  const requested = dec(requestedQty);
  if (requested.lessThanOrEqualTo(0)) {
    throw BusinessRuleError('Quantity must be greater than zero.');
  }

  const pending = dec(balance.pending_qty);
  if (requested.greaterThan(pending)) {
    throw BusinessRuleError(
      `Cannot order ${toQty(requested)} of ${balance.item_code} against indent ${balance.indent_no} ` +
        `line ${balance.line_no}: only ${toQty(pending)} remains eligible ` +
        `(indent ${toQty(balance.indent_qty)} − already ordered ${toQty(balance.ordered_qty)}).`,
      {
        itemCode: balance.item_code,
        indentNo: balance.indent_no,
        lineNo: balance.line_no,
        requested: toQty(requested),
        available: toQty(pending),
        indentQty: toQty(balance.indent_qty),
        orderedQty: toQty(balance.ordered_qty),
      },
    );
  }
}

/* ── PO line → GRN ──────────────────────────────────────────────────────────── */

export interface PoLineBalance {
  po_line_id: number;
  po_id: number;
  po_no: string;
  po_status: string;
  supplier_id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  uom_id: number | null;
  rate: string;
  discount_pct: string;
  final_rate: string;
  amount: string;
  po_qty: string;
  received_qty: string;
  pending_grn_qty: string;
  is_closed: boolean;
  is_receivable: boolean;
  line_status: string;
}

/** Locks a PO line and returns its authoritative balance. */
export async function lockPoLineBalance(tx: Queryable, poLineId: number): Promise<PoLineBalance> {
  const locked = await txQueryOne<{ id: number }>(
    tx,
    'SELECT id FROM purchase_order_lines WHERE id = $1 FOR UPDATE',
    [poLineId],
  );
  if (!locked) throw NotFoundError(`Purchase order line ${poLineId}`);

  const balance = await txQueryOne<PoLineBalance>(
    tx,
    'SELECT * FROM v_po_line_balance WHERE po_line_id = $1',
    [poLineId],
  );
  if (!balance) throw NotFoundError(`Purchase order line ${poLineId}`);
  return balance;
}

/**
 * Asserts that `requestedQty` may be received against a PO line.
 *
 *   outstanding = po_qty − already-received qty  (SRS §12)
 *
 * `excludeGrnId` lets an existing draft GRN be re-validated on edit without its
 * own quantity counting against itself.
 */
export function assertGrnReceiptAllowed(
  balance: PoLineBalance,
  requestedQty: string,
  alreadyOnThisGrn: string = '0',
): void {
  if (balance.po_status === 'DRAFT') {
    throw BusinessRuleError(
      `Purchase order ${balance.po_no} has not been issued yet. Issue the PO before receiving goods.`,
      { poNo: balance.po_no, status: balance.po_status },
    );
  }
  if (balance.po_status === 'CANCELLED') {
    throw BusinessRuleError(`Purchase order ${balance.po_no} has been cancelled.`);
  }
  if (balance.po_status === 'SHORT_CLOSED') {
    throw BusinessRuleError(
      `Purchase order ${balance.po_no} has been short-closed and accepts no further receipts.`,
    );
  }
  if (balance.is_closed) {
    throw BusinessRuleError(
      `Line ${balance.line_no} of PO ${balance.po_no} (${balance.item_code}) is closed.`,
    );
  }

  const requested = dec(requestedQty);
  if (requested.lessThanOrEqualTo(0)) {
    throw BusinessRuleError('GRN quantity must be greater than zero.');
  }

  // Outstanding is measured against POSTED receipts; a draft GRN being edited adds
  // back its own previously-entered quantity so the user is not blocked by themselves.
  const outstanding = dec(balance.pending_grn_qty).plus(dec(alreadyOnThisGrn));

  if (requested.greaterThan(outstanding)) {
    throw BusinessRuleError(
      `Cannot receive ${toQty(requested)} of ${balance.item_code} against PO ${balance.po_no} ` +
        `line ${balance.line_no}: only ${toQty(outstanding)} is outstanding ` +
        `(ordered ${toQty(balance.po_qty)} − received ${toQty(balance.received_qty)}).`,
      {
        itemCode: balance.item_code,
        poNo: balance.po_no,
        lineNo: balance.line_no,
        requested: toQty(requested),
        outstanding: toQty(outstanding),
        poQty: toQty(balance.po_qty),
        receivedQty: toQty(balance.received_qty),
      },
    );
  }
}

/* ── Derived status recomputation (ADR-003) ─────────────────────────────────── */

/**
 * Recomputes a purchase order's status from its receipts and persists it.
 * Called inside the transaction of every operation that changes receipts, so
 * `purchase_order_headers.status` can never drift from `derived_status`.
 */
export async function recomputePoStatus(tx: Queryable, poId: number): Promise<string> {
  const row = await txQueryOne<{ status: string; derived_status: string }>(
    tx,
    'SELECT status, derived_status FROM v_po_header_balance WHERE po_id = $1',
    [poId],
  );
  if (!row) throw NotFoundError(`Purchase order ${poId}`);

  // DRAFT / CANCELLED / SHORT_CLOSED are administrative states the receipts must not override.
  if (['DRAFT', 'CANCELLED', 'SHORT_CLOSED'].includes(row.status)) return row.status;

  if (row.derived_status !== row.status) {
    await tx.query(
      `UPDATE purchase_order_headers
          SET status = $2, updated_at = now()
        WHERE id = $1`,
      [poId, row.derived_status],
    );
  }
  return row.derived_status;
}

/**
 * Closes an approved indent once every line is fully ordered, so it stops
 * appearing in the "awaiting PO" work list. Idempotent.
 */
export async function recomputeIndentClosure(tx: Queryable, indentId: number): Promise<void> {
  const row = await txQueryOne<{ status: string; total_pending_qty: string; line_count: number }>(
    tx,
    `SELECT h.status, b.total_pending_qty, b.line_count
       FROM purchase_indent_headers h
       JOIN v_indent_header_balance b ON b.indent_id = h.id
      WHERE h.id = $1`,
    [indentId],
  );
  if (!row) return;

  const fullyOrdered = Number(row.line_count) > 0 && dec(row.total_pending_qty).lessThanOrEqualTo(0);

  if (row.status === 'APPROVED' && fullyOrdered) {
    await tx.query(
      `UPDATE purchase_indent_headers
          SET status = 'CLOSED', closed_at = now(), close_reason = 'Fully ordered', updated_at = now()
        WHERE id = $1`,
      [indentId],
    );
  } else if (row.status === 'CLOSED' && !fullyOrdered) {
    // A cancelled PO released quantity back — reopen the indent.
    await tx.query(
      `UPDATE purchase_indent_headers
          SET status = 'APPROVED', closed_at = NULL, close_reason = NULL, updated_at = now()
        WHERE id = $1`,
      [indentId],
    );
  }
}

/**
 * Re-derives an approved requisition's store status from its POSTED issue slips
 * (v_requisition_header_balance ignores reversed ones): nothing issued ->
 * APPROVED, everything requested issued -> FULLY_ISSUED, otherwise
 * PARTIALLY_ISSUED. Called after every issue and every issue reversal, both of
 * which change what the requisition has received, so the header is always
 * stamped. Any other status (draft, pending, rejected, cancelled) is a decision
 * a person made and is left alone. The derived status is written without
 * assertRequisitionTransition on purpose: issued -> APPROVED is not in the
 * transition table, which keeps it out of reach of the approve action.
 */
export async function recomputeRequisitionStatus(
  tx: Queryable,
  requisitionId: number,
  userId: number | null,
): Promise<{ from: string; to: string; totalRequested: string; totalIssued: string }> {
  const row = await txQueryOne<{ status: string; total_requested_qty: string; total_issued_qty: string }>(
    tx,
    'SELECT status, total_requested_qty, total_issued_qty FROM v_requisition_header_balance WHERE requisition_id = $1',
    [requisitionId],
  );
  if (!row) throw NotFoundError('Requisition');
  const totals = { totalRequested: row.total_requested_qty, totalIssued: row.total_issued_qty };
  if (!['APPROVED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED'].includes(row.status)) {
    return { from: row.status, to: row.status, ...totals };
  }
  const issued = dec(row.total_issued_qty);
  const to = !issued.greaterThan(0) ? 'APPROVED'
    : issued.greaterThanOrEqualTo(dec(row.total_requested_qty)) ? 'FULLY_ISSUED'
      : 'PARTIALLY_ISSUED';
  await tx.query(
    'UPDATE requisition_headers SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
    [requisitionId, to, userId],
  );
  return { from: row.status, to, ...totals };
}
