/**
 * Planner statistics (2026-10-17).
 *
 * PostgreSQL plans every query from the statistics ANALYZE gathers, and the embedded
 * engine runs no autovacuum, so nothing ever gathers them on its own. A database whose
 * rows arrived without an ANALYZE afterwards (a backup restored into a fresh folder:
 * Admin > Backup restore, db:restore, db:verify-restore, a staging rebuild or a disaster
 * recovery) is planned as if its tables were nearly empty. On such a copy of the
 * 2026-10-17 backup the planner summed every GRN line again for each candidate PO: the
 * receipt evidence summary took 76.7 s and a CSV export of all POs 35.6 s, and since
 * PGlite runs a query on the Node main thread, every other request (/health included)
 * waited as long. The same calls took 0.35 s and 1.4 s once the tables were analysed.
 *
 * So a restore analyses what it restored once it has committed, and start-up analyses a
 * database whose PO and GRN lines hold rows but no statistics.
 */
import { getDatabase } from './driver.js';
import { logger } from '../core/logger.js';

/**
 * The tables the PO list, its receipt evidence, the GRN views and the store GRN link
 * repair read, which migration 030 analyses once it is applied (migrate.ts).
 */
export const PLANNER_TABLES = [
  'purchase_order_headers', 'purchase_order_lines', 'po_indent_sources', 'grn_headers', 'grn_lines',
  'suppliers', 'items', 'google_sync_jobs', 'google_sync_errors', 'store_grn_link_holds',
] as const;

/**
 * ANALYZE every table of the database: after a restore each one was just rewritten.
 * Runs outside any transaction, so it must be called once the restore has committed;
 * best effort, as the restore itself has already succeeded (about 1 to 2 s on the
 * 2026-10-17 copy).
 */
export async function analyseDatabase(reason: string): Promise<{ analysed: boolean; ms: number }> {
  const started = Date.now();
  try {
    const db = await getDatabase();
    await db.query('ANALYZE');
    const ms = Date.now() - started;
    logger.info(`Planner statistics gathered (${reason}) in ${ms} ms.`);
    return { analysed: true, ms };
  } catch (err) {
    logger.warn(`Planner statistics were not gathered (${reason}); run ANALYZE before heavy use.`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return { analysed: false, ms: Date.now() - started };
  }
}

/**
 * At start-up: analyses the database when the PO lines or the GRN lines hold rows but
 * have no statistics at all, which only a database never analysed since its rows came
 * in can show. A database analysed before (by migration 030, a restore or this check)
 * is left alone, so a normal start costs one catalogue query.
 */
export async function ensurePlannerStatistics(): Promise<{ analysed: boolean; tables: string[] }> {
  const db = await getDatabase();
  const { rows } = await db.query<{ table_name: string; has_rows: boolean; has_stats: boolean }>(
    `SELECT t.table_name,
            CASE t.table_name WHEN 'purchase_order_lines' THEN EXISTS (SELECT 1 FROM purchase_order_lines)
                              ELSE EXISTS (SELECT 1 FROM grn_lines) END AS has_rows,
            EXISTS (SELECT 1 FROM pg_stats s WHERE s.schemaname = 'public' AND s.tablename = t.table_name) AS has_stats
       FROM (VALUES ('purchase_order_lines'), ('grn_lines')) AS t(table_name)`,
  );
  const unanalysed = rows.filter((r) => r.has_rows && !r.has_stats).map((r) => r.table_name);
  if (unanalysed.length === 0) return { analysed: false, tables: [] };
  const { analysed } = await analyseDatabase(`${unanalysed.join(' and ')} had rows but no statistics`);
  return { analysed, tables: unanalysed };
}
