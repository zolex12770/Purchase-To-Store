/**
 * Dedicated Inventory Domain Engine
 *
 * Implements authoritative multi-category stock calculations, atomic balance
 * updates, dual unit (Qty / Weight) tracking, and double-deduction prevention.
 */
import { type Queryable, txQuery, txQueryOne } from '../db/index.js';
import { nextDocumentNumber } from './numbering.js';
import { ValidationError, ConflictError } from '../core/errors.js';

export const INVENTORY_CATEGORIES = ['RM', 'FG', 'TRADING', 'WIP', 'GENERAL'] as const;
export type InventoryCategory = (typeof INVENTORY_CATEGORIES)[number];

export interface InventoryMovementInput {
  itemId: number;
  category: InventoryCategory;
  txnType: string;
  direction: 'IN' | 'OUT' | 'ADJUST';
  quantity: number;
  weightKg?: number | null;
  uom: string;
  rate?: number | null;
  amount?: number | null;
  referenceDocType?: string | null;
  referenceDocNo?: string | null;
  fromLocation?: string | null;
  toLocation?: string | null;
  department?: string | null;
  sourceSpreadsheetId?: string | null;
  sourceTab?: string | null;
  sourceRowIndex?: number | null;
  notes?: string | null;
  userId?: number | null;
  userName?: string | null;
  txnDate?: string | null;
  allowNegativeStock?: boolean;
}

export interface InventoryMovementResult {
  txnNo: string;
  itemId: number;
  itemCode: string;
  category: InventoryCategory;
  quantity: number;
  weightKg: number | null;
  balanceQtyAfter: number;
  balanceWeightAfter: number | null;
}

/**
 * Categorize item based on its code, main group, or description.
 */
export function classifyItemCategory(itemCode: string, mainGroup = '', description = ''): InventoryCategory {
  const code = (itemCode || '').trim().toUpperCase();
  const grp = (mainGroup || '').trim().toUpperCase();
  const desc = (description || '').trim().toUpperCase();

  // 1. Raw Material (RM)
  if (
    code.startsWith('RM') ||
    code.startsWith('FTCU') ||
    code.startsWith('RMCU') ||
    code.startsWith('FC') ||
    grp.includes('MOTHER TUBE') ||
    grp.includes('COPPER') ||
    grp.includes('ALUMINIUM') ||
    grp.includes('ROD') ||
    grp.includes('BAR') ||
    grp.includes('STRIP') ||
    desc.includes('RAW MATERIAL')
  ) {
    // Avoid classifying finished cable clips or trading parts that mention copper
    if (!code.startsWith('ZCCR') && !code.startsWith('ZSBC') && !code.startsWith('ZR') && !code.startsWith('ZF')) {
      return 'RM';
    }
  }

  // 2. Finished Goods (FG)
  if (
    code.startsWith('FG') ||
    code.startsWith('PTS') ||
    code.startsWith('ZAUS') ||
    code.startsWith('LEZAUS') ||
    desc.includes('FG MATERIAL') ||
    desc.includes('FINISHED GOODS')
  ) {
    return 'FG';
  }

  // 3. Work-in-Progress (WIP)
  if (
    code.startsWith('ZR') ||
    code.startsWith('ZRI') ||
    code.startsWith('ZRIM') ||
    code.startsWith('ZF') ||
    code.startsWith('ZFI') ||
    code.startsWith('ZFIM') ||
    code.startsWith('ZP') ||
    code.startsWith('ZPI') ||
    code.startsWith('ZPIM') ||
    grp.includes('SHEET METAL') ||
    grp.includes('WIP')
  ) {
    return 'WIP';
  }

  // 4. Trading Material
  if (
    code.startsWith('TR') ||
    code.startsWith('ZCCR') ||
    code.startsWith('ZSBC') ||
    code.startsWith('DCTAPE') ||
    code.startsWith('ZUBR') ||
    code.startsWith('ZBT') ||
    desc.includes('TRADING')
  ) {
    return 'TRADING';
  }

  // 5. General Store & Spares default
  return 'GENERAL';
}

/**
 * Reverses a movement that was entered in the ERP (never a Google Sheet row — those
 * follow the sheet). The original row is kept and marked REVERSED with who/when/why;
 * the Purchase item's stock and the category figure move back by the same amount,
 * and the change is ledgered as INVENTORY_REVERSAL referencing the movement number.
 */
export async function reverseInventoryMovement(
  tx: Queryable,
  txnId: number,
  ctx: { reason: string; userId: number | null },
): Promise<{ txnNo: string; itemCode: string; reversedQty: number; itemStockAfter: number | null }> {
  const t = await txQueryOne<{
    id: number; txn_no: string; category: string; item_id: number | null; item_code: string;
    direction: 'IN' | 'OUT' | 'ADJUST'; quantity: string; status: string; origin: string; txn_date: string;
  }>(
    tx,
    `SELECT id, txn_no, category, item_id, item_code, direction, quantity, status, origin, txn_date::text AS txn_date
       FROM inventory_transactions WHERE id = $1 FOR UPDATE`,
    [txnId],
  );
  if (!t) throw ValidationError('Movement not found.');
  if (t.origin !== 'ERP') {
    throw ConflictError(`${t.txn_no} comes from the Google Sheet; correct the sheet row instead — the next sync follows it.`);
  }
  if (t.status !== 'POSTED') throw ConflictError(`${t.txn_no} is already ${t.status.toLowerCase()}.`);

  // The stock change the movement made: from its own ledger entry when there is one
  // (movements posted since 2026-10-16 reference their number); else its direction.
  const ledger = await txQueryOne<{ net: string | null }>(
    tx,
    `SELECT SUM(inward_qty - outward_qty)::text AS net FROM stock_ledger
      WHERE reference_type = 'INVENTORY' AND reference_no = $1 AND txn_type <> 'INVENTORY_REVERSAL'`,
    [t.txn_no],
  );
  let applied: number;
  if (ledger?.net !== null && ledger?.net !== undefined) applied = Number(ledger.net);
  else if (t.direction === 'IN') applied = Number(t.quantity);
  else if (t.direction === 'OUT') applied = -Number(t.quantity);
  else throw ConflictError(`${t.txn_no} set the stock to a counted figure and has no ledger entry to undo; adjust the stock with a physical count instead.`);

  let itemStockAfter: number | null = null;
  if (t.item_id !== null && applied !== 0) {
    const item = await txQueryOne<{ live_stock_qty: string; uom_id: number | null }>(
      tx, 'SELECT live_stock_qty, uom_id FROM items WHERE id = $1 FOR UPDATE', [t.item_id],
    );
    if (item) {
      const after = Math.round((Number(item.live_stock_qty) - applied) * 10000) / 10000;
      if (after < 0) {
        throw ConflictError(
          `Reversing ${t.txn_no} would take ${t.item_code}'s stock below zero (stock now ${Number(item.live_stock_qty)}). Reverse the later issue first.`,
        );
      }
      await tx.query('UPDATE items SET live_stock_qty = $2, updated_at = now() WHERE id = $1', [t.item_id, after]);
      await tx.query(
        `INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_no, inward_qty, outward_qty,
                                   balance_qty, uom_id, location, txn_date, created_by)
         VALUES ($1, 'INVENTORY_REVERSAL', 'INVENTORY', $2, $3, $4, $5, $6, $7, CURRENT_DATE, $8)`,
        [t.item_id, t.txn_no, Math.max(-applied, 0), Math.max(applied, 0), after, item.uom_id, `${t.category} (reversal)`, ctx.userId],
      );
      itemStockAfter = after;
    }
  }
  await tx.query(
    `UPDATE inventory_items SET live_stock_qty = live_stock_qty - $3,
            available_qty = GREATEST(live_stock_qty - $3 - allocated_qty, 0), updated_at = now()
      WHERE category = $1 AND upper(item_code) = upper($2)`,
    [t.category, t.item_code, applied],
  );
  await tx.query(
    `UPDATE inventory_transactions SET status = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = $3
      WHERE id = $1`,
    [t.id, ctx.userId, ctx.reason],
  );
  return { txnNo: t.txn_no, itemCode: t.item_code, reversedQty: applied, itemStockAfter };
}

/** Stock-ledger entry type for a movement recorded from the inventory screens. */
const LEDGER_TYPE: Record<InventoryMovementInput['direction'], string> = {
  IN: 'INVENTORY_IN',
  OUT: 'INVENTORY_OUT',
  ADJUST: 'INVENTORY_ADJUST',
};

/**
 * Records a movement entered in the ERP against one category's stock.
 *
 * The category figure (inventory_items) and the Purchase item's stock
 * (items.live_stock_qty) move by the SAME difference, and that difference is
 * written to stock_ledger under its own entry type — so the ledger always
 * explains the item's stock. (It used to overwrite the item's stock with the
 * category figure and ledger an inward as "GRN_INWARD".)
 */
export async function recordInventoryMovement(
  tx: Queryable,
  input: InventoryMovementInput,
): Promise<InventoryMovementResult> {
  const qty = Number(input.quantity);
  if (isNaN(qty) || qty <= 0) {
    throw ValidationError('Movement quantity must be a positive number.');
  }

  const weightKg = input.weightKg !== undefined && input.weightKg !== null ? Number(input.weightKg) : null;
  const rate = input.rate !== undefined && input.rate !== null ? Number(input.rate) : 0;
  const amount = input.amount !== undefined && input.amount !== null ? Number(input.amount) : qty * rate;

  // 1. Lock the Purchase item, then the category row.
  const baseItem = await txQueryOne<{
    id: number; item_code: string; item_description: string; uom_code: string; uom_id: number | null; live_stock_qty: string;
  }>(
    tx,
    `SELECT i.id, i.item_code, i.item_description, COALESCE(u.code, 'Nos') AS uom_code, i.uom_id, i.live_stock_qty
       FROM items i
       LEFT JOIN lookups u ON u.id = i.uom_id
      WHERE i.id = $1 AND i.deleted_at IS NULL
      FOR UPDATE OF i`,
    [input.itemId],
  );
  if (!baseItem) {
    throw ValidationError(
      'This item is not in the Purchase item master, so a movement cannot be recorded in the ERP. Record it in the Google Sheet.',
    );
  }

  let invItem = await txQueryOne<{
    id: number;
    item_id: number;
    item_code: string;
    live_stock_qty: string;
    live_weight_kg: string;
    allocated_qty: string;
    available_qty: string;
  }>(
    tx,
    `SELECT id, item_id, item_code, live_stock_qty, live_weight_kg, allocated_qty, available_qty
     FROM inventory_items
     WHERE category = $2 AND (item_id = $1 OR (item_id IS NULL AND upper(item_code) = upper($3)))
     ORDER BY (item_id = $1) DESC NULLS LAST
     LIMIT 1
     FOR UPDATE`,
    [input.itemId, input.category, baseItem.item_code],
  );
  if (invItem && invItem.item_id === null) {
    // A sheet row for the same code that was not yet linked to the Purchase item.
    await tx.query('UPDATE inventory_items SET item_id = $2, updated_at = now() WHERE id = $1', [invItem.id, input.itemId]);
  }

  // If inventory_item does not exist yet for this item & category, initialize it from items
  if (!invItem) {
    invItem = await txQueryOne<{
      id: number;
      item_id: number;
      item_code: string;
      live_stock_qty: string;
      live_weight_kg: string;
      allocated_qty: string;
      available_qty: string;
    }>(
      tx,
      `INSERT INTO inventory_items (
         item_id, item_code, item_description, category, primary_uom,
         opening_stock_qty, live_stock_qty, allocated_qty, available_qty
       ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0, 0)
       RETURNING id, item_id, item_code, live_stock_qty, live_weight_kg, allocated_qty, available_qty`,
      [baseItem.id, baseItem.item_code, baseItem.item_description, input.category, baseItem.uom_code],
    );
  }

  const currentLiveQty = Number(invItem!.live_stock_qty || 0);
  const currentLiveWeight = Number(invItem!.live_weight_kg || 0);
  const currentAllocated = Number(invItem!.allocated_qty || 0);

  let newLiveQty: number;
  let newLiveWeight: number | null = null;

  if (input.direction === 'IN') {
    newLiveQty = currentLiveQty + qty;
    if (weightKg !== null) {
      newLiveWeight = currentLiveWeight + weightKg;
    }
  } else if (input.direction === 'OUT') {
    if (!input.allowNegativeStock && currentLiveQty < qty) {
      throw ConflictError(
        `Insufficient stock for item ${invItem!.item_code}. Available: ${currentLiveQty}, requested outward: ${qty}.`,
      );
    }
    newLiveQty = currentLiveQty - qty;
    if (weightKg !== null) {
      newLiveWeight = Math.max(0, currentLiveWeight - weightKg);
    }
  } else {
    // ADJUST
    newLiveQty = qty;
    newLiveWeight = weightKg !== null ? weightKg : currentLiveWeight;
  }

  const newAvailableQty = Math.max(0, newLiveQty - currentAllocated);

  // The Purchase item's stock moves by the same difference as the category row.
  const delta = Math.round((newLiveQty - currentLiveQty) * 10000) / 10000;
  const itemStockBefore = Number(baseItem.live_stock_qty || 0);
  const itemStockAfter = Math.round((itemStockBefore + delta) * 10000) / 10000;
  if (itemStockAfter < 0) {
    throw ConflictError(
      `Not enough stock for ${baseItem.item_code}: the ERP stock is ${itemStockBefore} and this movement would take it to ${itemStockAfter}.`,
    );
  }

  // 2. Generate sequential document number
  const txnNo = await nextDocumentNumber(tx, 'INVENTORY_TXN');

  // 3. Update inventory_items
  await tx.query(
    `UPDATE inventory_items
     SET live_stock_qty = $1,
         live_weight_kg = COALESCE($2, live_weight_kg),
         available_qty = $3,
         updated_at = now()
     WHERE id = $4`,
    [newLiveQty, newLiveWeight, newAvailableQty, invItem!.id],
  );

  // 4. Purchase item stock: same difference, never an overwrite with the category figure.
  if (delta !== 0) {
    await tx.query(
      `UPDATE items
       SET live_stock_qty = $1,
           updated_at = now()
       WHERE id = $2`,
      [itemStockAfter, input.itemId],
    );
  }

  // 5. Insert into inventory_transactions ledger
  await tx.query(
    `INSERT INTO inventory_transactions (
       txn_no, category, item_id, item_code, txn_type, direction,
       quantity, weight_kg, uom, rate, amount,
       balance_qty_after, balance_weight_after,
       reference_doc_type, reference_doc_no,
       from_location, to_location, department,
       source_spreadsheet_id, source_tab, source_row_index,
       status, notes, created_by, created_by_name, txn_date
     ) VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13,
       $14, $15,
       $16, $17, $18,
       $19, $20, $21,
       'POSTED', $22, $23, $24, COALESCE($25::date, CURRENT_DATE)
     )`,
    [
      txnNo,
      input.category,
      input.itemId,
      invItem!.item_code,
      input.txnType,
      input.direction,
      qty,
      weightKg,
      input.uom,
      rate,
      amount,
      newLiveQty,
      newLiveWeight,
      input.referenceDocType ?? null,
      input.referenceDocNo ?? null,
      input.fromLocation ?? null,
      input.toLocation ?? null,
      input.department ?? null,
      input.sourceSpreadsheetId ?? null,
      input.sourceTab ?? null,
      input.sourceRowIndex ?? null,
      input.notes ?? null,
      input.userId ?? null,
      input.userName ?? null,
      input.txnDate ?? null,
    ],
  );

  // 6. Stock ledger: the change to the Purchase item's stock, under its real entry type
  //    (reference = this movement's own number, so the ledger links back to it).
  if (delta !== 0) {
    await tx.query(
      `INSERT INTO stock_ledger (
         item_id, txn_type, reference_type, reference_id, reference_no,
         inward_qty, outward_qty, balance_qty, uom_id, location, txn_date, created_by
       ) VALUES ($1, $2, 'INVENTORY', NULL, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10)`,
      [
        input.itemId,
        LEDGER_TYPE[input.direction],
        txnNo,
        Math.max(delta, 0),
        Math.max(-delta, 0),
        itemStockAfter,
        baseItem.uom_id,
        `${input.category} (${input.txnType})`,
        input.txnDate ?? null,
        input.userId ?? null,
      ],
    );
  }

  return {
    txnNo,
    itemId: input.itemId,
    itemCode: invItem!.item_code,
    category: input.category,
    quantity: qty,
    weightKg,
    balanceQtyAfter: newLiveQty,
    balanceWeightAfter: newLiveWeight,
  };
}
