import { query } from '../db/index.js';

async function check() {
  console.log('--- INVENTORY ITEMS BY CATEGORY & SOURCE ---');
  const rows = await query<any>(`
    SELECT 
      category,
      CASE WHEN source_spreadsheet_id IS NOT NULL THEN 'FROM_GOOGLE_SHEET' ELSE 'PRE_MIGRATION_OR_MANUAL' END AS origin,
      COUNT(*)::int AS count,
      COALESCE(SUM(live_stock_qty), 0)::numeric(18, 4) AS total_qty,
      COALESCE(SUM(live_weight_kg), 0)::numeric(18, 4) AS total_weight
    FROM inventory_items
    WHERE deleted_at IS NULL
    GROUP BY category, (source_spreadsheet_id IS NOT NULL)
    ORDER BY category, origin;
  `);
  console.table(rows);
}

check().catch(console.error);
