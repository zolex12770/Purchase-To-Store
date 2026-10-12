/**
 * Stock inward, MLN issuance and the stock ledger (GRN reconstruction, Part 2/6/9).
 *
 * The single place that moves `items.live_stock_qty` and appends to
 * `stock_ledger` — GRN post/cancel are the only two callers today, and every
 * future outward movement (issue, transfer, consumption, adjustment) is meant
 * to go through the same `moveStock()` shape, not invent its own update.
 *
 * MLN generation uses a native PostgreSQL SEQUENCE (`mln_number_seq`), which
 * is lock-free and safe under concurrent posting by construction — two
 * transactions calling `nextval()` at the same instant are always handed
 * different numbers, with no risk of the duplicate-under-concurrency failure
 * a hand-rolled counter row would need extra locking to avoid.
 */
import { txQueryOne } from '../db/index.js';
import { dec, toQty } from './money.js';
import { BusinessRuleError } from '../core/errors.js';
const MLN_PREFIX = 'P';
const MLN_PAD = 12;
/** Reserves and returns the next MLN. MUST be called inside a transaction. */
export async function nextMln(tx) {
    const row = await txQueryOne(tx, "SELECT nextval('mln_number_seq') AS n");
    return `${MLN_PREFIX}${String(row?.n ?? '0').padStart(MLN_PAD, '0')}`;
}
/**
 * True once a Requisition has issued ANY quantity of this item out of the
 * pooled balance (a real, already-existing `stock_ledger` row — not an
 * invented relationship). Stock is pooled per item, not lot-tracked to a
 * specific GRN (Part 12/14: `requisition_issue_lines` carries no GRN-specific
 * identifier), so this is genuinely the finest-grained signal available that
 * "this item's stock has been consumed downstream" — used by GRN's edit-lock
 * (grn/routes.ts) to protect exactly the fields that would corrupt a
 * Requisition that already relied on the pooled balance, without inventing a
 * fake per-GRN foreign key to Requisition.
 */
export async function hasRequisitionConsumption(tx, itemId) {
    const row = await txQueryOne(tx, `SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1 AND txn_type = 'REQUISITION_ISSUE'`, [itemId]);
    return Number(row?.n ?? 0) > 0;
}
/**
 * Applies a signed correction to a previously-posted GRN line's usable
 * quantity (a receiving mistake caught after posting) — the delta counterpart
 * to `inwardGrnLine`/`reverseGrnLine`. The line's own `grn_line_mlns` row is
 * updated in place (the lot NUMBER is immutable and never reissued — only its
 * recorded quantity is corrected to match reality) and the ledger gains one
 * more row (an extra GRN_INWARD for a positive correction, a GRN_REVERSAL for
 * a negative one) rather than rewriting history. Refuses to move the item
 * balance negative, exactly like every other stock movement.
 */
export async function adjustGrnLineStock(tx, line, deltaQty, ctx) {
    const delta = dec(deltaQty);
    if (delta.isZero()) {
        const current = await txQueryOne(tx, 'SELECT live_stock_qty FROM items WHERE id = $1', [line.item_id]);
        return { newBalance: toQty(current?.live_stock_qty ?? '0') };
    }
    const item = await txQueryOne(tx, 'SELECT id, item_code, live_stock_qty FROM items WHERE id = $1 FOR UPDATE', [line.item_id]);
    if (!item)
        throw new Error(`Item ${line.item_id} not found while correcting stock inward.`);
    const newBalance = dec(item.live_stock_qty).plus(delta);
    if (newBalance.isNegative()) {
        throw BusinessRuleError(`Reducing this line's quantity would take ${item.item_code}'s stock below zero (current balance: ${toQty(item.live_stock_qty)}).`, { itemCode: item.item_code, currentBalance: toQty(item.live_stock_qty) });
    }
    const finalBalance = toQty(newBalance);
    await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [line.item_id, finalBalance]);
    const mlnRow = await txQueryOne(tx, 'SELECT mln_no FROM grn_line_mlns WHERE grn_line_id = $1', [line.id]);
    await tx.query('UPDATE grn_line_mlns SET qty = qty + $2 WHERE grn_line_id = $1', [line.id, toQty(delta)]);
    const isInward = delta.isPositive();
    await tx.query(`INSERT INTO stock_ledger
       (item_id, txn_type, reference_type, reference_id, reference_no, grn_line_id, mln_no, po_line_id,
        supplier_id, inward_qty, outward_qty, balance_qty, uom_id, location, batch_no, txn_date, created_by)
     VALUES ($1,$2,'GRN',$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [
        line.item_id, isInward ? 'GRN_INWARD' : 'GRN_REVERSAL', ctx.grnId, ctx.grnNo, line.id, mlnRow?.mln_no ?? '',
        line.po_line_id, ctx.supplierId,
        isInward ? toQty(delta) : 0, isInward ? 0 : toQty(delta.abs()),
        finalBalance, line.uom_id, line.receipt_location, line.batch_no, ctx.grnDate, ctx.userId,
    ]);
    return { newBalance: finalBalance };
}
/** The quantity that actually becomes usable stock — rejected/damaged never counts (Part 15). */
export function usableQtyOf(line) {
    return line.accepted_qty == null || line.accepted_qty === '' ? line.grn_qty : line.accepted_qty;
}
/**
 * Posts one GRN line's stock inward: locks the item row, adds the usable
 * quantity, appends a stock_ledger row, and issues its MLN. Called once per
 * line when a GRN is posted — never for a draft (Part 2/6: "posting is what
 * assigns/finalises the MLN and moves stock").
 */
export async function inwardGrnLine(tx, line, ctx) {
    const item = await txQueryOne(tx, 'SELECT id, live_stock_qty FROM items WHERE id = $1 FOR UPDATE', [line.item_id]);
    if (!item)
        throw new Error(`Item ${line.item_id} not found while posting stock inward.`);
    const usable = usableQtyOf(line);
    const newBalance = toQty(dec(item.live_stock_qty).plus(dec(usable)));
    await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [line.item_id, newBalance]);
    const mlnNo = await nextMln(tx);
    await tx.query(`INSERT INTO grn_line_mlns (mln_no, grn_line_id, grn_id, item_id, sr_no, qty, uom_id, batch_no, location, issued_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [mlnNo, line.id, ctx.grnId, line.item_id, ctx.srNo, toQty(usable), line.uom_id, line.batch_no, line.receipt_location, ctx.userId]);
    await tx.query(`INSERT INTO stock_ledger
       (item_id, txn_type, reference_type, reference_id, reference_no, grn_line_id, mln_no, po_line_id,
        supplier_id, inward_qty, outward_qty, balance_qty, uom_id, location, batch_no, txn_date, created_by)
     VALUES ($1,'GRN_INWARD','GRN',$2,$3,$4,$5,$6,$7,$8,0,$9,$10,$11,$12,$13,$14)`, [
        line.item_id, ctx.grnId, ctx.grnNo, line.id, mlnNo, line.po_line_id,
        ctx.supplierId, toQty(usable), newBalance, line.uom_id, line.receipt_location, line.batch_no,
        ctx.grnDate, ctx.userId,
    ]);
    return { mlnNo, newBalance };
}
/**
 * Reverses a previously-posted GRN line's stock inward on cancellation
 * (Part 8) — subtracts exactly the same usable quantity that was added, so a
 * cancel-right-after-post always returns the item to its pre-receipt balance.
 * The MLN itself is NEVER deleted (Part 2: immutable once issued) — its
 * "still active" status is answered by joining to grn_headers.status, not by
 * any column on grn_line_mlns.
 */
export async function reverseGrnLine(tx, line, ctx) {
    const item = await txQueryOne(tx, 'SELECT id, live_stock_qty FROM items WHERE id = $1 FOR UPDATE', [line.item_id]);
    if (!item)
        throw new Error(`Item ${line.item_id} not found while reversing stock inward.`);
    const usable = usableQtyOf(line);
    const newBalance = toQty(dec(item.live_stock_qty).minus(dec(usable)));
    await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [line.item_id, newBalance]);
    const mlnRow = await txQueryOne(tx, 'SELECT mln_no FROM grn_line_mlns WHERE grn_line_id = $1', [line.id]);
    await tx.query(`INSERT INTO stock_ledger
       (item_id, txn_type, reference_type, reference_id, reference_no, grn_line_id, mln_no, po_line_id,
        supplier_id, inward_qty, outward_qty, balance_qty, uom_id, location, batch_no, txn_date, created_by)
     VALUES ($1,'GRN_REVERSAL','GRN',$2,$3,$4,$5,$6,$7,0,$8,$9,$10,$11,$12,$13,$14)`, [
        line.item_id, ctx.grnId, ctx.grnNo, line.id, mlnRow?.mln_no ?? '', line.po_line_id,
        ctx.supplierId, toQty(usable), newBalance, line.uom_id, line.receipt_location, line.batch_no,
        ctx.grnDate, ctx.userId,
    ]);
    return { newBalance };
}
/**
 * Deducts one requisition issue line's quantity from live stock — the
 * OUTWARD counterpart to `inwardGrnLine`. Called once per issue line inside
 * the SAME transaction that creates its `requisition_issue_lines` row
 * (requisition/routes.ts), so a stock deduction and its issue record always
 * commit or roll back together (Rule 28).
 *
 * The item row is locked and re-read INSIDE this function, and the ONLY
 * ceiling checked is current available stock — NEVER the requisition's
 * requested quantity (Rules 1/7/8/9/23/24/26: over-issue against the
 * request is a deliberately supported business rule; only running out of
 * physical stock is refused). This is also what makes concurrent store
 * issues against the same item safe: two transactions racing to lock the
 * same item row serialise on that lock, so the second one always
 * re-validates against the balance the first one actually left behind —
 * final stock can never go negative.
 */
export async function issueRequisitionLine(tx, line, issueQty, ctx) {
    const item = await txQueryOne(tx, 'SELECT id, item_code, live_stock_qty FROM items WHERE id = $1 FOR UPDATE', [line.item_id]);
    if (!item)
        throw new Error(`Item ${line.item_id} not found while issuing stock.`);
    const qty = dec(issueQty);
    const available = dec(item.live_stock_qty);
    if (qty.greaterThan(available)) {
        throw BusinessRuleError(`Insufficient stock for ${item.item_code}. Available: ${toQty(available)}, requested issue: ${toQty(qty)}.`, { itemCode: item.item_code, availableQty: toQty(available), issueQty: toQty(qty) });
    }
    const newBalance = toQty(available.minus(qty));
    await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [line.item_id, newBalance]);
    await tx.query(`INSERT INTO stock_ledger
       (item_id, txn_type, reference_type, reference_id, reference_no,
        inward_qty, outward_qty, balance_qty, uom_id, txn_date, created_by)
     VALUES ($1,'REQUISITION_ISSUE','REQUISITION',$2,$3,0,$4,$5,$6,$7,$8)`, [line.item_id, ctx.requisitionId, ctx.issueSlipNo, toQty(qty), newBalance, line.uom_id, ctx.issueDate, ctx.userId]);
    return { newBalance };
}
/**
 * Reverses one previously-issued requisition-issue line (a controlled
 * correction, not a silent edit — the issue line/slip itself is never
 * deleted, exactly like a GRN reversal). Adds the quantity back to live
 * stock and records the reversal in the ledger.
 */
export async function reverseRequisitionIssueLine(tx, line, issueQty, ctx) {
    const item = await txQueryOne(tx, 'SELECT id, live_stock_qty FROM items WHERE id = $1 FOR UPDATE', [line.item_id]);
    if (!item)
        throw new Error(`Item ${line.item_id} not found while reversing a stock issue.`);
    const newBalance = toQty(dec(item.live_stock_qty).plus(dec(issueQty)));
    await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [line.item_id, newBalance]);
    await tx.query(`INSERT INTO stock_ledger
       (item_id, txn_type, reference_type, reference_id, reference_no,
        inward_qty, outward_qty, balance_qty, uom_id, txn_date, created_by)
     VALUES ($1,'REQUISITION_REVERSAL','REQUISITION',$2,$3,$4,0,$5,$6,$7,$8)`, [line.item_id, ctx.requisitionId, ctx.issueSlipNo, toQty(issueQty), newBalance, line.uom_id, ctx.issueDate, ctx.userId]);
    return { newBalance };
}
//# sourceMappingURL=stock.js.map