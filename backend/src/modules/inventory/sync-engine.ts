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
    headerRow: number;
  }
> = {
  RM: {
    spreadsheetId: '1smKiS3li81F7aH2pQ0JGgDLp7302d48FJkvWefRf8R4',
    stockTab: 'RM Stock Live',
    stockRange: "'RM Stock Live'!A9:Z",
    codeCol: 1, // Item Code
    descCol: 2, // Item Name
    qtyCol: 6, // Live Stock KG
    weightCol: 6, // KG
    uomCol: -1, // default KG
    rackCol: 5,
    rateCol: -1,
    headerRow: 1,
  },
  FG: {
    spreadsheetId: '1mA5il8Jqjgal9g20o-UzqQGv3y-mgPHpjl9KU-XomyQ',
    stockTab: 'FG  Stock Live',
    stockRange: "'FG  Stock Live'!A11:Z",
    codeCol: 1, // Item Code
    descCol: 5, // Description
    qtyCol: 7, // Store Live Stock in Nos
    weightCol: 8, // Store Live Stock in Kgs
    uomCol: -1, // default Nos
    rackCol: 6,
    rateCol: -1,
    headerRow: 1,
  },
  TRADING: {
    spreadsheetId: '14AHr2aSmpcCxfNhcWnjGU1DVE-BfJpLOWrnFn3bkilk',
    stockTab: 'Trading Live Stock',
    stockRange: "'Trading Live Stock'!A9:Z",
    codeCol: 1, // Item Code
    descCol: 2, // Item Name
    qtyCol: 7, // Live Stock (Qty)
    uomCol: 4, // Unit
    rackCol: 5,
    rateCol: 6,
    headerRow: 1,
  },
  WIP: {
    spreadsheetId: '1BirIwXOG4F604q5n1UY0r6kjet4mTdmbhC9FDbTrUXs',
    stockTab: 'WIP  Stock Live',
    stockRange: "'WIP  Stock Live'!A10:Z",
    codeCol: 0, // Item Code
    descCol: 8, // Description
    qtyCol: 10, // Store Live Stock in Nos
    weightCol: 11, // Store Live Stock in Kgs
    uomCol: -1, // default Nos
    rackCol: 9,
    rateCol: -1,
    headerRow: 1,
  },
  GENERAL: {
    spreadsheetId: '1VnpDk6kBK2xUGJTVB1CCqlG105UX0_Gs0aAv-bnMpKY',
    stockTab: 'General Item Live Stock',
    stockRange: "'General Item Live Stock'!A7:Z",
    codeCol: 1, // Item Code
    descCol: 2, // Item Name
    qtyCol: 7, // Live Stock Qty
    uomCol: 4, // Unit
    rackCol: 6,
    rateCol: -1,
    headerRow: 3, // row 9 is header, data starts at index 3
  },
};

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
            // Quarantine invalid or negative quantities to prevent constraint violation
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
               rack_id, source_spreadsheet_id, source_tab, source_row_index, last_sync_at
             ) VALUES (
               $1, $2, $3, $4, $5,
               $6, $7, $8, $9,
               $10, $11, $12, $13, now()
             )
             ON CONFLICT (item_code, category)
             DO UPDATE SET
               live_stock_qty = EXCLUDED.live_stock_qty,
               live_weight_kg = COALESCE(EXCLUDED.live_weight_kg, inventory_items.live_weight_kg),
               available_qty = GREATEST(EXCLUDED.live_stock_qty - inventory_items.allocated_qty, 0),
               rack_id = COALESCE(EXCLUDED.rack_id, inventory_items.rack_id),
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

      // Record sync checkpoint
      result.durationMs = Date.now() - started;
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
          result.durationMs,
        ],
      );
    });

    logger.info(`Inventory Sync Complete: ${category} synced ${result.itemsUpserted} items in ${result.durationMs}ms`);
  } catch (err) {
    result.status = 'FAILED';
    result.errorMessage = err instanceof Error ? err.message : String(err);
    logger.error(`Inventory Sync Failed for ${category}: ${result.errorMessage}`);
  }

  result.durationMs = Date.now() - started;
  return result;
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
