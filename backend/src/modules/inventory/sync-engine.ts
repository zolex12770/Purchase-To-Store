/**
 * Inventory Google Sheets Synchronisation Engine
 *
 * Imports and reconciles live inventory data across all 5 authoritative Google Sheets:
 *  - Raw Material (RM)
 *  - Finished Goods (FG)
 *  - Trading Material
 *  - Work-in-Progress (WIP)
 *  - General Store Items
 */
import { withTransaction, txQuery, txQueryOne } from '../../db/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { type InventoryCategory } from '../../domain/inventory.js';

export interface CategorySyncResult {
  category: InventoryCategory;
  spreadsheetId: string;
  tabsProcessed: string[];
  totalRowsRead: number;
  itemsUpserted: number;
  transactionsImported: number;
  quarantinedRows: number;
  durationMs: number;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  errorMessage?: string;
}

export const SHEET_SOURCES: Record<
  InventoryCategory,
  {
    spreadsheetId: string;
    stockTab: string;
    stockRange: string;
    codeCol: number;
    descCol: number;
    qtyCol: number;
    weightCol?: number;
    uomCol?: number;
    rackCol?: number;
    rateCol?: number;
    amountCol?: number;
    mainGroupCol?: number;
    weight1000pcCol?: number;
    markingCol?: number;
    seriesCol?: number;
    headerRow: number;
  }
> = {
  RM: {
    spreadsheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4',
    stockTab: 'RM Stock Live',
    stockRange: "'RM Stock Live'!A9:Z",
    codeCol: 1, // Item Code (Col B)
    descCol: 2, // Item Name (Col C)
    mainGroupCol: 4, // Main Group (Col E)
    rackCol: 5, // Rack ID (Col F)
    qtyCol: 6, // Live Stock KG (Col G)
    weightCol: 6, // KG
    amountCol: 7, // Amount (Col H)
    uomCol: -1, // default KG
    rateCol: -1,
    headerRow: 1,
  },
  FG: {
    spreadsheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ',
    stockTab: 'FG  Stock Live',
    stockRange: "'FG  Stock Live'!A11:Z",
    codeCol: 1, // Item Code (Col B)
    markingCol: 2, // Marking (Col C)
    weight1000pcCol: 3, // 1000pc Weight (Col D)
    seriesCol: 4, // Customer / Series Name (Col E)
    descCol: 5, // Description (Col F)
    rackCol: 6, // Rack Id (Col G)
    qtyCol: 7, // Store Live Stock in Nos (Col H)
    weightCol: 8, // Store Live Stock in Kgs (Col I)
    uomCol: -1, // default Nos
    rateCol: -1,
    headerRow: 1,
  },
  TRADING: {
    spreadsheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk',
    stockTab: 'Trading Live Stock',
    stockRange: "'Trading Live Stock'!A9:Z",
    codeCol: 1, // Item Code (Col B)
    descCol: 2, // Item Name (Col C)
    mainGroupCol: 3, // Group (Col D)
    uomCol: 4, // Unit (Col E)
    rackCol: 5, // Rack ID (Col F)
    rateCol: 6, // Rate(Rs) (Col G)
    qtyCol: 7, // Live Stock (Qty) (Col H)
    amountCol: 8, // Live Stock Amount (Rs) (Col I)
    headerRow: 1,
  },
  WIP: {
    spreadsheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs',
    stockTab: 'WIP  Stock Live',
    stockRange: "'WIP  Stock Live'!A10:Z",
    codeCol: 0, // Item Code (Col A)
    markingCol: 5, // Marking (Col F)
    weight1000pcCol: 6, // 1000pc Weight (Col G)
    seriesCol: 7, // Series (Col H)
    descCol: 8, // Description (Col I)
    rackCol: 9, // Rack Id (Col J)
    qtyCol: 10, // Store Live Stock in Nos (Col K)
    weightCol: 11, // Store Live Stock in Kgs (Col L)
    uomCol: -1, // default Nos
    rateCol: -1,
    headerRow: 1,
  },
  GENERAL: {
    spreadsheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY',
    stockTab: 'General Item Live Stock',
    stockRange: "'General Item Live Stock'!A7:Z",
    codeCol: 1, // Item Code (Col B)
    descCol: 2, // Item Name (Col C)
    mainGroupCol: 3, // Main Group (Col D)
    uomCol: 4, // Unit (Col E)
    rackCol: 6, // Rack ID (Col G)
    qtyCol: 7, // Live Stock Qty (Col H)
    amountCol: 8, // Live Stock Amount (Rs) (Col I)
    rateCol: -1,
    headerRow: 1, // row 7 is header, data starts at index 1 (row 8)
  },
};

export interface TxnTabConfig {
  category: InventoryCategory;
  tabName: string;
  range: string;
  slug: string;
  direction: 'IN' | 'OUT';
  txnType: string;
  codeCol: number;
  qtyCol: number;
  altQtyCol?: number;
  dateCol?: number;
  weightCol?: number;
  docNoCol?: number;
  refDocCol?: number;
  supplierCol?: number;
  poCol?: number;
  descCol?: number;
  nameCol?: number;
  uomCol?: number;
  rateCol?: number;
  amountCol?: number;
  deptCol?: number;
  notesCol?: number;
  fromLocationCol?: number;
  toLocationCol?: number;
  fallbackUom: string;
}

export const CATEGORY_TXN_CONFIG: Record<InventoryCategory, TxnTabConfig[]> = {
  RM: [
    {
      category: 'RM',
      tabName: 'GRN Inward',
      range: "'GRN Inward'!A8:Z",
      slug: 'GRN',
      direction: 'IN',
      txnType: 'GRN_INWARD',
      codeCol: 9,
      descCol: 10,
      qtyCol: 18,
      weightCol: 18,
      dateCol: 5,
      docNoCol: 4,
      supplierCol: 6,
      refDocCol: 7,
      poCol: 11,
      uomCol: 15,
      rateCol: 17,
      amountCol: 20,
      fallbackUom: 'Kg',
    },
    {
      category: 'RM',
      tabName: 'RM Outward',
      range: "'RM Outward'!A8:Z",
      slug: 'OUT',
      direction: 'OUT',
      txnType: 'RM_OUTWARD',
      codeCol: 6,
      descCol: 7,
      nameCol: 7,
      qtyCol: 8,
      weightCol: 8,
      dateCol: 4,
      docNoCol: 10,
      refDocCol: 9,
      rateCol: 14,
      amountCol: 15,
      fallbackUom: 'Kg',
    },
    {
      category: 'RM',
      tabName: 'Production Inward',
      range: "'Production Inward'!A8:Z",
      slug: 'PROD',
      direction: 'IN',
      txnType: 'PRODUCTION_INWARD',
      codeCol: 6,
      descCol: 7,
      nameCol: 7,
      qtyCol: 8,
      weightCol: 8,
      dateCol: 4,
      refDocCol: 9,
      rateCol: 14,
      amountCol: 15,
      fallbackUom: 'Kg',
    },
  ],
  FG: [
    {
      category: 'FG',
      tabName: 'Inward FG ',
      range: "'Inward FG '!A7:Z",
      slug: 'IN',
      direction: 'IN',
      txnType: 'PACKING_INWARD',
      codeCol: 4,
      dateCol: 2,
      docNoCol: 3,
      refDocCol: 7,
      qtyCol: 11,
      altQtyCol: 6,
      weightCol: 14,
      fallbackUom: 'Nos',
    },
    {
      category: 'FG',
      tabName: 'Outward FG',
      range: "'Outward FG'!A7:Z",
      slug: 'OUT',
      direction: 'OUT',
      txnType: 'DISPATCH_OUTWARD',
      codeCol: 4,
      dateCol: 2,
      notesCol: 3,
      qtyCol: 6,
      refDocCol: 7,
      weightCol: 10,
      fallbackUom: 'Nos',
    },
  ],
  TRADING: [
    {
      category: 'TRADING',
      tabName: 'Inward Trading',
      range: "'Inward Trading'!A8:Z",
      slug: 'IN',
      direction: 'IN',
      txnType: 'PURCHASE_INWARD',
      dateCol: 2,
      descCol: 3,
      codeCol: 4,
      nameCol: 5,
      uomCol: 7,
      qtyCol: 9,
      altQtyCol: 8,
      rateCol: 11,
      fallbackUom: 'Nos',
    },
    {
      category: 'TRADING',
      tabName: 'Outward Trading ',
      range: "'Outward Trading '!A7:Z",
      slug: 'OUT',
      direction: 'OUT',
      txnType: 'TRADING_ISSUE',
      dateCol: 2,
      notesCol: 3,
      codeCol: 4,
      nameCol: 5,
      uomCol: 7,
      qtyCol: 8,
      refDocCol: 9,
      rateCol: 12,
      amountCol: 13,
      fallbackUom: 'Nos',
    },
  ],
  WIP: [
    {
      category: 'WIP',
      tabName: 'Inward WIP',
      range: "'Inward WIP'!A8:Z",
      slug: 'IN',
      direction: 'IN',
      txnType: 'WIP_STAGE_INWARD',
      dateCol: 2,
      deptCol: 3,
      docNoCol: 4,
      codeCol: 5,
      qtyCol: 9,
      altQtyCol: 7,
      weightCol: 12,
      fallbackUom: 'Nos',
    },
    {
      category: 'WIP',
      tabName: 'Outward WIP',
      range: "'Outward WIP'!A8:Z",
      slug: 'OUT',
      direction: 'OUT',
      txnType: 'WIP_STAGE_OUTWARD',
      dateCol: 2,
      notesCol: 3,
      codeCol: 4,
      qtyCol: 6,
      refDocCol: 7,
      weightCol: 10,
      fallbackUom: 'Nos',
    },
  ],
  GENERAL: [
    {
      category: 'GENERAL',
      tabName: 'GRN Register (Store Inward Entry)',
      range: "'GRN Register (Store Inward Entry)'!A8:Z",
      slug: 'GRN',
      direction: 'IN',
      txnType: 'GRN_INWARD',
      docNoCol: 4,
      dateCol: 5,
      supplierCol: 6,
      refDocCol: 7,
      codeCol: 9,
      descCol: 10,
      poCol: 11,
      rateCol: 17,
      qtyCol: 18,
      altQtyCol: 14,
      amountCol: 20,
      fallbackUom: 'Nos',
    },
    {
      category: 'GENERAL',
      tabName: 'Issue Register (Store Outward Entry)',
      range: "'Issue Register (Store Outward Entry)'!A7:Z",
      slug: 'ISS',
      direction: 'OUT',
      txnType: 'STORE_ISSUE',
      docNoCol: 1,
      dateCol: 3,
      notesCol: 4,
      codeCol: 6,
      descCol: 7,
      fromLocationCol: 9,
      toLocationCol: 11,
      qtyCol: 13,
      uomCol: 14,
      rateCol: 15,
      amountCol: 16,
      fallbackUom: 'Nos',
    },
  ],
};

/**
 * Robust date parser supporting DD-MM-YYYY, DD-MM-YY, YYYY-MM-DD and Excel serial dates
 */
export function parseSheetDate(raw: unknown): string {
  if (raw === undefined || raw === null) return new Date().toISOString().slice(0, 10);
  const s = String(raw).trim();
  if (!s || s === '-' || s === '0' || s.toLowerCase() === 'n/a') {
    return new Date().toISOString().slice(0, 10);
  }

  // Serial date number (Excel/Google Sheets)
  if (/^\d{5}$/.test(s)) {
    const serial = parseInt(s, 10);
    const ms = (serial - 25569) * 86400 * 1000;
    const d = new Date(ms);
    if (!isNaN(d.getTime())) {
      return d.toISOString().slice(0, 10);
    }
  }

  // YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    return s;
  }

  // DD-MM-YYYY or DD/MM/YYYY
  const dmyMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (dmyMatch) {
    const day = dmyMatch[1].padStart(2, '0');
    const month = dmyMatch[2].padStart(2, '0');
    const year = dmyMatch[3];
    return `${year}-${month}-${day}`;
  }

  // DD-MM-YY or DD/MM/YY
  const dmyShortMatch = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2})$/);
  if (dmyShortMatch) {
    const day = dmyShortMatch[1].padStart(2, '0');
    const month = dmyShortMatch[2].padStart(2, '0');
    const yy = parseInt(dmyShortMatch[3], 10);
    const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
    return `${fullYear}-${month}-${day}`;
  }

  const parsed = new Date(s);
  if (!isNaN(parsed.getTime())) {
    return parsed.toISOString().slice(0, 10);
  }

  return new Date().toISOString().slice(0, 10);
}

/**
 * Robust numeric parser handling commas, currency symbols, and formula artifacts
 */
export function parseSheetNum(val: unknown, fallback = 0): number {
  if (val === undefined || val === null) return fallback;
  const s = String(val).replace(/,/g, '').trim();
  if (!s || s === '-' || s.startsWith('=')) return fallback;
  const n = parseFloat(s);
  return isNaN(n) ? fallback : n;
}

/**
 * Get authenticated Google Sheets API client
 */
async function getSheetsClient() {
  const { google } = await import('googleapis');
  const { GoogleAuth } = await import('google-auth-library');

  const keyFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || 'C:\\secure\\google-service-account.json';
  const auth = new GoogleAuth({
    keyFile,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return google.sheets({ version: 'v4', auth: auth as never });
}

/**
 * Synchronize a single inventory category from its live Google Sheet
 */
export async function syncCategoryFromSheet(category: InventoryCategory): Promise<CategorySyncResult> {
  const started = Date.now();
  const cfg = SHEET_SOURCES[category];
  const result: CategorySyncResult = {
    category,
    spreadsheetId: cfg.spreadsheetId,
    tabsProcessed: [cfg.stockTab],
    totalRowsRead: 0,
    itemsUpserted: 0,
    transactionsImported: 0,
    quarantinedRows: 0,
    durationMs: 0,
    status: 'SUCCESS',
  };

  try {
    const sheets = await getSheetsClient();
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: cfg.spreadsheetId,
      range: cfg.stockRange,
      valueRenderOption: 'FORMATTED_VALUE',
    });

    const rows = res.data.values || [];
    result.totalRowsRead = rows.length;

    if (rows.length === 0) {
      result.status = 'PARTIAL';
      result.errorMessage = `Sheet tab ${cfg.stockTab} returned 0 rows.`;
      return result;
    }

    const dataRows = rows.slice(cfg.headerRow);

    await withTransaction(async (tx) => {
      for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        if (!row || row.length === 0) continue;

        const rawCode = row[cfg.codeCol];
        if (!rawCode || String(rawCode).trim() === '' || String(rawCode).startsWith('=')) {
          continue;
        }

        const itemCode = String(rawCode).trim();
        const desc = cfg.descCol >= 0 && row[cfg.descCol] ? String(row[cfg.descCol]).trim() : itemCode;
        const rawQty = cfg.qtyCol >= 0 && row[cfg.qtyCol] ? String(row[cfg.qtyCol]).replace(/,/g, '').trim() : '0';
        const parsedQty = parseFloat(rawQty);

        await tx.query('SAVEPOINT row_sp');
        try {
          if (isNaN(parsedQty) || parsedQty < 0) {
            // Quarantine invalid or negative quantities to protect ledger integrity
            await tx.query(
              `INSERT INTO inventory_quarantine (category, source_tab, source_row_index, raw_data, quarantine_reason)
               VALUES ($1, $2, $3, $4::jsonb, $5)`,
              [
                category,
                cfg.stockTab,
                i + cfg.headerRow + 1,
                JSON.stringify(row),
                parsedQty < 0 ? `Negative physical stock (${parsedQty}) quarantined to protect ledger integrity.` : `Invalid numeric quantity: "${rawQty}"`,
              ],
            );
            result.quarantinedRows++;
            await tx.query('RELEASE SAVEPOINT row_sp');
            continue;
          }

          let parsedWeight: number | null = null;
          if (cfg.weightCol !== undefined && cfg.weightCol >= 0 && row[cfg.weightCol]) {
            const rawW = String(row[cfg.weightCol]).replace(/,/g, '').trim();
            const w = parseFloat(rawW);
            if (!isNaN(w)) parsedWeight = w;
          }

          let parsedWeight1000pc: number = 0;
          if (cfg.weight1000pcCol !== undefined && cfg.weight1000pcCol >= 0 && row[cfg.weight1000pcCol]) {
            const rawW1000 = String(row[cfg.weight1000pcCol]).replace(/,/g, '').trim();
            const w1000 = parseFloat(rawW1000);
            if (!isNaN(w1000) && w1000 > 0) parsedWeight1000pc = w1000;
          }

          let unitPrice: number = 0;
          if (cfg.rateCol !== undefined && cfg.rateCol >= 0 && row[cfg.rateCol]) {
            const rawR = String(row[cfg.rateCol]).replace(/,/g, '').trim();
            const r = parseFloat(rawR);
            if (!isNaN(r) && r > 0) unitPrice = r;
          } else if (cfg.amountCol !== undefined && cfg.amountCol >= 0 && row[cfg.amountCol]) {
            const rawA = String(row[cfg.amountCol]).replace(/,/g, '').trim();
            const a = parseFloat(rawA);
            if (!isNaN(a) && a > 0 && parsedQty > 0) {
              unitPrice = parseFloat((a / parsedQty).toFixed(4));
            }
          }

          const mainGroup = cfg.mainGroupCol !== undefined && cfg.mainGroupCol >= 0 && row[cfg.mainGroupCol] ? String(row[cfg.mainGroupCol]).trim() : null;
          const rackId = cfg.rackCol !== undefined && cfg.rackCol >= 0 && row[cfg.rackCol] ? String(row[cfg.rackCol]).trim() : null;
          const primaryUom = cfg.uomCol !== undefined && cfg.uomCol >= 0 && row[cfg.uomCol] ? String(row[cfg.uomCol]).trim() : (category === 'RM' ? 'Kg' : 'Nos');

          // Check if item exists in ERP items table
          let dbItem = await txQueryOne<{ id: number }>(
            tx,
            `SELECT id FROM items WHERE UPPER(item_code) = UPPER($1) AND deleted_at IS NULL`,
            [itemCode],
          );

          if (!dbItem) {
            // Create or update item in items master if not present
            const created = await tx.query(
              `INSERT INTO items (item_code, item_description, live_stock_qty, inventory_category, is_active)
               VALUES ($1, $2, $3, $4, true)
               ON CONFLICT (UPPER(item_code)) WHERE deleted_at IS NULL
               DO UPDATE SET live_stock_qty = EXCLUDED.live_stock_qty, inventory_category = EXCLUDED.inventory_category
               RETURNING id`,
              [itemCode, desc, parsedQty, category],
            );
            dbItem = created.rows[0] as unknown as { id: number };
          } else {
            // Update items inventory_category and live_stock_qty
            await tx.query(
              `UPDATE items
               SET inventory_category = $1,
                   live_stock_qty = $2,
                   updated_at = now()
               WHERE id = $3`,
              [category, parsedQty, dbItem.id],
            );
          }

          // Upsert into dedicated inventory_items
          await tx.query(
            `INSERT INTO inventory_items (
               item_id, item_code, item_description, category, primary_uom,
               opening_stock_qty, live_stock_qty, live_weight_kg, available_qty,
               rack_id, main_group, weight_per_1000pc_kg, unit_price,
               source_spreadsheet_id, source_tab, source_row_index, last_sync_at
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $12, $13,
               $14, $15, $16, now()
             )
             ON CONFLICT (item_code, category)
             DO UPDATE SET
               live_stock_qty = EXCLUDED.live_stock_qty,
               live_weight_kg = COALESCE(EXCLUDED.live_weight_kg, inventory_items.live_weight_kg),
               available_qty = GREATEST(EXCLUDED.live_stock_qty - inventory_items.allocated_qty, 0),
               rack_id = COALESCE(EXCLUDED.rack_id, inventory_items.rack_id),
               main_group = COALESCE(EXCLUDED.main_group, inventory_items.main_group),
               weight_per_1000pc_kg = CASE WHEN EXCLUDED.weight_per_1000pc_kg > 0 THEN EXCLUDED.weight_per_1000pc_kg ELSE inventory_items.weight_per_1000pc_kg END,
               unit_price = CASE WHEN EXCLUDED.unit_price > 0 THEN EXCLUDED.unit_price ELSE inventory_items.unit_price END,
               item_description = EXCLUDED.item_description,
               source_spreadsheet_id = EXCLUDED.source_spreadsheet_id,
               source_tab = EXCLUDED.source_tab,
               source_row_index = EXCLUDED.source_row_index,
               last_sync_at = now(),
               updated_at = now()`,
            [
              dbItem!.id,
              itemCode,
              desc,
              category,
              primaryUom,
              parsedQty, // initial opening
              parsedQty,
              parsedWeight,
              parsedQty,
              rackId,
              mainGroup,
              parsedWeight1000pc,
              unitPrice,
              cfg.spreadsheetId,
              cfg.stockTab,
              i + cfg.headerRow + 1,
            ],
          );

          await tx.query('RELEASE SAVEPOINT row_sp');
          result.itemsUpserted++;
        } catch (rowErr) {
          await tx.query('ROLLBACK TO SAVEPOINT row_sp');
          await tx.query(
            `INSERT INTO inventory_quarantine (category, source_tab, source_row_index, raw_data, quarantine_reason)
             VALUES ($1, $2, $3, $4::jsonb, $5)`,
            [
              category,
              cfg.stockTab,
              i + cfg.headerRow + 1,
              JSON.stringify(row),
              String(rowErr instanceof Error ? rowErr.message : rowErr),
            ],
          );
          result.quarantinedRows++;
        }
      }

      // Record live stock sync checkpoint
      await tx.query(
        `INSERT INTO inventory_sync_checkpoints (
           category, spreadsheet_id, tab_name, total_rows_read,
           valid_records_imported, quarantined_records, status, sync_duration_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          category,
          cfg.spreadsheetId,
          cfg.stockTab,
          result.totalRowsRead,
          result.itemsUpserted,
          result.quarantinedRows,
          'SUCCESS',
          Date.now() - started,
        ],
      );

      // Synchronize all transaction sub-tabs for this category
      await syncCategoryTransactions(tx, sheets, category, cfg.spreadsheetId, result);
    });

    result.durationMs = Date.now() - started;
    logger.info(
      `Inventory Sync Complete: ${category} synced ${result.itemsUpserted} items & ${result.transactionsImported} txns in ${result.durationMs}ms`,
    );
  } catch (err) {
    result.status = 'FAILED';
    result.errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Inventory Sync Failed for ${category}: ${result.errorMessage}`);
  }

  result.durationMs = Date.now() - started;
  return result;
}

/**
 * Synchronize all transaction tabs for a specific category
 */
async function syncCategoryTransactions(
  tx: any,
  sheets: any,
  category: InventoryCategory,
  spreadsheetId: string,
  result: CategorySyncResult,
): Promise<void> {
  const tabs = CATEGORY_TXN_CONFIG[category] || [];
  if (tabs.length === 0) return;

  // Pre-load items master for fast key resolution
  const existingItems = await tx.query(
    `SELECT id, item_code FROM items WHERE deleted_at IS NULL`,
  );
  const itemMap = new Map<string, number>();
  for (const itm of existingItems.rows) {
    itemMap.set(String(itm.item_code).trim().toUpperCase(), Number(itm.id));
  }

  for (const tabDef of tabs) {
    try {
      const tabStart = Date.now();
      const res = await sheets.spreadsheets.values.get({
        spreadsheetId,
        range: tabDef.range,
        valueRenderOption: 'FORMATTED_VALUE',
      });

      const rows = res.data.values || [];
      result.totalRowsRead += rows.length;
      result.tabsProcessed.push(tabDef.tabName);

      if (rows.length === 0) {
        continue;
      }

      const txnsToInsert: Array<{
        txn_no: string;
        category: InventoryCategory;
        item_id: number;
        item_code: string;
        txn_type: string;
        direction: 'IN' | 'OUT';
        quantity: number;
        weight_kg: number | null;
        uom: string;
        rate: number;
        amount: number;
        balance_qty_after: number;
        balance_weight_after: number | null;
        reference_doc_type: string | null;
        reference_doc_no: string | null;
        from_location: string | null;
        to_location: string | null;
        department: string | null;
        source_spreadsheet_id: string;
        source_tab: string;
        source_row_index: number;
        notes: string | null;
        txn_date: string;
      }> = [];

      const startRowIdx = parseInt(tabDef.range.match(/[A-Z]+(\d+)/)?.[1] || '1', 10);

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        if (!row || row.length === 0) continue;

        const rawCode = tabDef.codeCol < row.length ? row[tabDef.codeCol] : null;
        if (!rawCode || String(rawCode).trim() === '' || String(rawCode).startsWith('=')) {
          continue;
        }

        const itemCode = String(rawCode).trim();
        let qty = parseSheetNum(tabDef.qtyCol < row.length ? row[tabDef.qtyCol] : null, 0);
        if (qty === 0 && tabDef.altQtyCol !== undefined && tabDef.altQtyCol < row.length) {
          qty = parseSheetNum(row[tabDef.altQtyCol], 0);
        }

        if (qty <= 0) {
          continue;
        }

        const rowIndex = startRowIdx + i;
        const txnNo = `GS-${category}-${tabDef.slug}-R${rowIndex}`;

        // Ensure item exists in items table
        let itemId = itemMap.get(itemCode.toUpperCase());
        const desc =
          (tabDef.descCol !== undefined && tabDef.descCol < row.length && row[tabDef.descCol] ? String(row[tabDef.descCol]).trim() : '') ||
          (tabDef.nameCol !== undefined && tabDef.nameCol < row.length && row[tabDef.nameCol] ? String(row[tabDef.nameCol]).trim() : '') ||
          itemCode;

        if (!itemId) {
          const inserted = await tx.query(
            `INSERT INTO items (item_code, item_description, live_stock_qty, inventory_category, is_active)
             VALUES ($1, $2, 0, $3, true)
             ON CONFLICT (UPPER(item_code)) WHERE deleted_at IS NULL
             DO UPDATE SET inventory_category = EXCLUDED.inventory_category
             RETURNING id`,
            [itemCode, desc, category],
          );
          itemId = Number(inserted.rows[0].id);
          itemMap.set(itemCode.toUpperCase(), itemId);

          await tx.query(
            `INSERT INTO inventory_items (
               item_id, item_code, item_description, category, primary_uom,
               opening_stock_qty, live_stock_qty, available_qty
             ) VALUES ($1, $2, $3, $4, $5, 0, 0, 0)
             ON CONFLICT (item_code, category) DO NOTHING`,
            [itemId, itemCode, desc, category, tabDef.fallbackUom],
          );
        }

        // Date
        const rawDate = tabDef.dateCol !== undefined && tabDef.dateCol < row.length ? row[tabDef.dateCol] : null;
        const txnDate = parseSheetDate(rawDate);

        // Weight
        let weightKg: number | null = null;
        if (tabDef.weightCol !== undefined && tabDef.weightCol < row.length && row[tabDef.weightCol]) {
          const w = parseSheetNum(row[tabDef.weightCol], 0);
          if (w > 0) weightKg = w;
        } else if (category === 'RM') {
          weightKg = qty;
        }

        // Rate & Amount
        let rate = tabDef.rateCol !== undefined && tabDef.rateCol < row.length ? parseSheetNum(row[tabDef.rateCol], 0) : 0;
        let amount = tabDef.amountCol !== undefined && tabDef.amountCol < row.length ? parseSheetNum(row[tabDef.amountCol], 0) : 0;
        if (amount === 0 && rate > 0 && qty > 0) {
          amount = parseFloat((rate * qty).toFixed(4));
        } else if (rate === 0 && amount > 0 && qty > 0) {
          rate = parseFloat((amount / qty).toFixed(4));
        }

        // UOM
        let uom = tabDef.uomCol !== undefined && tabDef.uomCol < row.length && row[tabDef.uomCol]
          ? String(row[tabDef.uomCol]).trim()
          : tabDef.fallbackUom;
        if (!uom) uom = tabDef.fallbackUom;

        // References & Notes
        const docNo = tabDef.docNoCol !== undefined && tabDef.docNoCol < row.length && row[tabDef.docNoCol] ? String(row[tabDef.docNoCol]).trim() : '';
        const refDoc = tabDef.refDocCol !== undefined && tabDef.refDocCol < row.length && row[tabDef.refDocCol] ? String(row[tabDef.refDocCol]).trim() : '';
        const supplier = tabDef.supplierCol !== undefined && tabDef.supplierCol < row.length && row[tabDef.supplierCol] ? String(row[tabDef.supplierCol]).trim() : '';
        const po = tabDef.poCol !== undefined && tabDef.poCol < row.length && row[tabDef.poCol] ? String(row[tabDef.poCol]).trim() : '';
        const dept = tabDef.deptCol !== undefined && tabDef.deptCol < row.length && row[tabDef.deptCol] ? String(row[tabDef.deptCol]).trim() : '';
        const notesVal = tabDef.notesCol !== undefined && tabDef.notesCol < row.length && row[tabDef.notesCol] ? String(row[tabDef.notesCol]).trim() : '';
        const fromLoc = tabDef.fromLocationCol !== undefined && tabDef.fromLocationCol < row.length && row[tabDef.fromLocationCol] ? String(row[tabDef.fromLocationCol]).trim() : null;
        const toLoc = tabDef.toLocationCol !== undefined && tabDef.toLocationCol < row.length && row[tabDef.toLocationCol] ? String(row[tabDef.toLocationCol]).trim() : null;

        const refDocNo = docNo || refDoc || po || null;
        const noteParts = [
          supplier ? `Supplier: ${supplier}` : '',
          po ? `PO: ${po}` : '',
          refDoc && refDoc !== docNo ? `Ref: ${refDoc}` : '',
          notesVal ? `Type: ${notesVal}` : '',
          desc && desc !== itemCode ? desc : '',
        ].filter(Boolean);
        const notes = noteParts.length > 0 ? noteParts.join(' | ') : null;

        txnsToInsert.push({
          txn_no: txnNo,
          category,
          item_id: itemId,
          item_code: itemCode,
          txn_type: tabDef.txnType,
          direction: tabDef.direction,
          quantity: qty,
          weight_kg: weightKg,
          uom,
          rate,
          amount,
          balance_qty_after: 0,
          balance_weight_after: weightKg,
          reference_doc_type: tabDef.txnType,
          reference_doc_no: refDocNo,
          from_location: fromLoc,
          to_location: toLoc,
          department: dept || null,
          source_spreadsheet_id: spreadsheetId,
          source_tab: tabDef.tabName,
          source_row_index: rowIndex,
          notes,
          txn_date: txnDate,
        });
      }

      // Batch insert transactions (100 per chunk)
      const BATCH_SIZE = 100;
      for (let b = 0; b < txnsToInsert.length; b += BATCH_SIZE) {
        const chunk = txnsToInsert.slice(b, b + BATCH_SIZE);
        const valuesSql: string[] = [];
        const params: unknown[] = [];
        let pIdx = 1;

        for (const t of chunk) {
          valuesSql.push(`(
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++},
            $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}, $${pIdx++}
          )`);
          params.push(
            t.txn_no,
            t.category,
            t.item_id,
            t.item_code,
            t.txn_type,
            t.direction,
            t.quantity,
            t.weight_kg,
            t.uom,
            t.rate,
            t.amount,
            t.balance_qty_after,
            t.balance_weight_after,
            t.reference_doc_type,
            t.reference_doc_no,
            t.from_location,
            t.to_location,
            t.department,
            t.source_spreadsheet_id,
            t.source_tab,
            t.source_row_index,
            t.notes,
            t.txn_date,
            'Google Sheet Sync',
          );
        }

        await tx.query(
          `INSERT INTO inventory_transactions (
             txn_no, category, item_id, item_code, txn_type, direction,
             quantity, weight_kg, uom, rate, amount, balance_qty_after, balance_weight_after,
             reference_doc_type, reference_doc_no, from_location, to_location, department,
             source_spreadsheet_id, source_tab, source_row_index, notes, txn_date, created_by_name
           ) VALUES ${valuesSql.join(', ')}
           ON CONFLICT (txn_no) DO UPDATE SET
             item_id = EXCLUDED.item_id,
             item_code = EXCLUDED.item_code,
             quantity = EXCLUDED.quantity,
             weight_kg = EXCLUDED.weight_kg,
             uom = EXCLUDED.uom,
             rate = EXCLUDED.rate,
             amount = EXCLUDED.amount,
             reference_doc_no = EXCLUDED.reference_doc_no,
             notes = EXCLUDED.notes,
             from_location = EXCLUDED.from_location,
             to_location = EXCLUDED.to_location,
             department = EXCLUDED.department,
             txn_date = EXCLUDED.txn_date,
             source_tab = EXCLUDED.source_tab`,
          params,
        );
      }

      result.transactionsImported += txnsToInsert.length;

      // Sync checkpoint for transaction tab
      const tabDuration = Date.now() - tabStart;
      await tx.query(
        `INSERT INTO inventory_sync_checkpoints (
           category, spreadsheet_id, tab_name, total_rows_read,
           valid_records_imported, quarantined_records, status, sync_duration_ms
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          category,
          spreadsheetId,
          tabDef.tabName,
          rows.length,
          txnsToInsert.length,
          0,
          'SUCCESS',
          tabDuration,
        ],
      );

      logger.info(
        `Synced tab "${tabDef.tabName}" for ${category}: ${txnsToInsert.length} txns imported in ${tabDuration}ms`,
      );
    } catch (tabErr) {
      logger.error(`Error syncing tab "${tabDef.tabName}" for ${category}: ${String(tabErr)}`);
      result.quarantinedRows++;
    }
  }
}

/**
 * Synchronize all 5 categories sequentially
 */
export async function syncAllInventoryCategories(): Promise<Record<InventoryCategory, CategorySyncResult>> {
  const categories: InventoryCategory[] = ['RM', 'FG', 'TRADING', 'WIP', 'GENERAL'];
  const summary: Partial<Record<InventoryCategory, CategorySyncResult>> = {};

  for (const cat of categories) {
    summary[cat] = await syncCategoryFromSheet(cat);
  }

  return summary as Record<InventoryCategory, CategorySyncResult>;
}
