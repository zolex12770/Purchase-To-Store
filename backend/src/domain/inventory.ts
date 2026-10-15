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
 * Execute atomic inventory movement with single source of truth balance updates.
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

  // 1. Lock inventory_items row
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
     WHERE item_id = $1 AND category = $2
     FOR UPDATE`,
    [input.itemId, input.category],
  );

  // If inventory_item does not exist yet for this item & category, initialize it from items
  if (!invItem) {
    const baseItem = await txQueryOne<{ id: number; item_code: string; item_description: string; uom_code: string }>(
      tx,
      `SELECT i.id, i.item_code, i.item_description, COALESCE(u.code, 'Nos') as uom_code
       FROM items i
       LEFT JOIN lookups u ON u.id = i.uom_id
       WHERE i.id = $1`,
      [input.itemId],
    );

    if (!baseItem) {
      throw ValidationError(`Item with ID ${input.itemId} does not exist in master records.`);
    }

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

  // 4. Update core items table for system consistency
  await tx.query(
    `UPDATE items
     SET live_stock_qty = $1,
         updated_at = now()
     WHERE id = $2`,
    [newLiveQty, input.itemId],
  );

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

  // 6. Record in stock_ledger for compatibility
  const inwardQty = input.direction === 'IN' ? qty : 0;
  const outwardQty = input.direction === 'OUT' ? qty : 0;
  const allowedLedgerTypes = [
    'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
    'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT',
  ];
  const ledgerTxnType = allowedLedgerTypes.includes(input.txnType)
    ? input.txnType
    : (input.direction === 'IN' ? 'GRN_INWARD' : (input.direction === 'OUT' ? 'DIRECT_ISSUE' : 'STOCK_ADJUSTMENT'));

  await tx.query(
    `INSERT INTO stock_ledger (
       item_id, txn_type, reference_type, reference_id, reference_no,
       inward_qty, outward_qty, balance_qty, txn_date, created_by
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::date, CURRENT_DATE), $10)`,
    [
      input.itemId,
      ledgerTxnType,
      input.referenceDocType ?? 'INVENTORY',
      null,
      input.referenceDocNo ?? txnNo,
      inwardQty,
      outwardQty,
      newLiveQty,
      input.txnDate ?? null,
      input.userId ?? null,
    ],
  );

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
