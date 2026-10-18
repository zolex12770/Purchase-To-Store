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
 *
 * That still analysed a table once at most (C01, 2026-10-18): rows a sync brings in later
 * stay unknown to the planner, and a date-filtered KPI on the copy of production ran for
 * 211 s, re-sent twice by the client, while the API answered nobody. So the server now
 * does what autovacuum would: every 10 minutes (backup-scheduler.ts) it analyses the
 * tables changed by more rows than autovacuum's own rule allows, after each business-sheet
 * sync that wrote rows the tables that sync changed, and after each automatic backup
 * every table. One table per statement, with the event loop handed back in between, so
 * a request waits for one table at most: on the copy of the 2026-10-17 backup the whole
 * database took 0.9 to 1.1 s as one ANALYZE and 0.8 s table by table, the slowest table
 * (inventory_transactions) 0.28 s, and the check itself 15 ms. With the PO, GRN, indent
 * and requisition tables' statistics gone, the 12-month Pending PO totals took 115 s; one
 * periodic check analysed those 9 tables in 0.23 s, and the same totals then took 59 ms.
 */
import { getDatabase, type Database } from './driver.js';
import { logger } from '../core/logger.js';

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
    await flushCounters(db);
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
 * is left alone, so a normal start costs one catalogue query. Other tables in that state
 * are picked up by the first periodic check (analyseStaleTables).
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

/* ── Re-analysis while the server runs ─────────────────────────────────────── */

/** autovacuum_analyze_threshold and autovacuum_analyze_scale_factor, PostgreSQL's defaults. */
export const ANALYSE_THRESHOLD_ROWS = 50;
export const ANALYSE_SCALE_FACTOR = 0.1;

export interface TableActivity {
  table: string;
  /** pg_class.reltuples: the rows the last ANALYZE (or VACUUM) counted; -1 when never. */
  rowsAtLastAnalyse: number;
  /** pg_stat_user_tables.n_mod_since_analyze: rows inserted, updated or deleted since. */
  changedSinceAnalyse: number;
  /** The table has column statistics (pg_statistic rows) at all. */
  hasStatistics: boolean;
  /** The table occupies pages, so it may hold rows (confirmed before it is analysed). */
  hasPages: boolean;
}

/**
 * The tables whose statistics no longer describe them, by autovacuum's rule: more rows
 * changed since the last ANALYZE than 50 + 10% of the rows it counted; and a table that
 * may hold rows but has no statistics at all (rows restored, imported or synced into a
 * table never analysed: the indent and requisition tables of production, 2026-10-17).
 */
export function tablesDueForAnalyse(tables: TableActivity[]): string[] {
  return tables
    .filter((t) => (t.hasStatistics
      ? t.changedSinceAnalyse > ANALYSE_THRESHOLD_ROWS + ANALYSE_SCALE_FACTOR * Math.max(t.rowsAtLastAnalyse, 0)
      : t.hasPages))
    .map((t) => t.table);
}

export interface AnalyseOutcome {
  /** The tables analysed, in the order they were. */
  tables: string[];
  ms: number;
  /** The longest single statement, i.e. the longest any request waited behind it. */
  slowest: { table: string; ms: number } | null;
  failed: string[];
}

const NOTHING: AnalyseOutcome = { tables: [], ms: 0, slowest: null, failed: [] };

/**
 * The counters of this (the only) backend reach pg_stat_user_tables lazily, about 10 s
 * after its last write; this makes the rows written so far count now. Needed before an
 * ANALYZE too: it sets a table's "changed since" to zero, and changes still pending
 * would land on top of that zero afterwards, so the next check analysed the table again.
 */
async function flushCounters(db: Database): Promise<void> {
  await db.query('SELECT pg_stat_force_next_flush()').catch(() => undefined);
}

async function readTableActivity(db: Database): Promise<TableActivity[]> {
  await flushCounters(db);
  const { rows } = await db.query<{ table_name: string; reltuples: number; changed: number; has_stats: boolean; has_pages: boolean }>(
    `SELECT c.relname AS table_name, c.reltuples::float8 AS reltuples,
            COALESCE(s.n_mod_since_analyze, 0)::float8 AS changed,
            EXISTS (SELECT 1 FROM pg_statistic st WHERE st.starelid = c.oid) AS has_stats,
            pg_relation_size(c.oid) > 0 AS has_pages
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
      WHERE n.nspname = 'public' AND c.relkind = 'r'
      ORDER BY c.relname`,
  );
  return rows.map((r) => ({
    table: r.table_name, rowsAtLastAnalyse: Number(r.reltuples), changedSinceAnalyse: Number(r.changed),
    hasStatistics: r.has_stats, hasPages: r.has_pages,
  }));
}

/** A table name from the catalogue, quoted for the ANALYZE statement. */
const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** One macrotask: the requests that arrived meanwhile issue their queries first. */
const handBack = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * ANALYZE the given tables one statement each, with the event loop handed back before
 * each, so PGlite (one query at a time, on the main thread) serves the requests that
 * queued up between tables instead of after the last one. Best effort: a table that
 * fails is reported and the rest are analysed.
 */
async function analyseTables(db: Database, tables: string[], reason: string, opts: { onlyIfRows?: Set<string> } = {}): Promise<AnalyseOutcome> {
  const started = Date.now();
  const out: AnalyseOutcome = { tables: [], ms: 0, slowest: null, failed: [] };
  for (const table of tables) {
    await handBack();
    try {
      // A table with pages but no statistics may simply have been emptied: analysing it
      // again would leave it in the same state and repeat at every check.
      if (opts.onlyIfRows?.has(table)) {
        const { rows } = await db.query<{ has_rows: boolean }>(`SELECT EXISTS (SELECT 1 FROM ${ident(table)}) AS has_rows`);
        if (!rows[0]?.has_rows) continue;
      }
      await flushCounters(db);
      const t0 = Date.now();
      await db.query(`ANALYZE ${ident(table)}`);
      const ms = Date.now() - t0;
      out.tables.push(table);
      if (!out.slowest || ms > out.slowest.ms) out.slowest = { table, ms };
    } catch (err) {
      out.failed.push(table);
      logger.warn(`Planner statistics: ANALYZE ${table} failed (${reason})`, { error: err instanceof Error ? err.message : String(err) });
    }
  }
  out.ms = Date.now() - started;
  if (out.tables.length > 0) {
    logger.info(
      `Planner statistics refreshed (${reason}): ${out.tables.length} table(s) in ${out.ms} ms` +
        `${out.slowest ? `, longest ${out.slowest.table} ${out.slowest.ms} ms` : ''}.`,
    );
  }
  return out;
}

/** One analysis at a time: a sync's and the periodic check's would otherwise interleave. */
let chain: Promise<unknown> = Promise.resolve();
function serialised(fn: () => Promise<AnalyseOutcome>): Promise<AnalyseOutcome> {
  const next = chain.then(fn, fn);
  chain = next.catch(() => undefined);
  return next;
}

/**
 * Analyses the tables tablesDueForAnalyse names; nothing when none is due (one flush and
 * one catalogue query). Only the embedded engine: a PostgreSQL server's own autovacuum
 * does this there. Never throws.
 */
export function analyseStaleTables(reason: string): Promise<AnalyseOutcome> {
  return serialised(async () => {
    try {
      const db = await getDatabase();
      if (db.driver !== 'pglite') return NOTHING;
      const activity = await readTableActivity(db);
      const due = tablesDueForAnalyse(activity);
      if (due.length === 0) return NOTHING;
      const unanalysed = new Set(activity.filter((t) => !t.hasStatistics).map((t) => t.table));
      return await analyseTables(db, due, reason, { onlyIfRows: unanalysed });
    } catch (err) {
      logger.warn(`Planner statistics were not checked (${reason})`, { error: err instanceof Error ? err.message : String(err) });
      return NOTHING;
    }
  });
}

/**
 * Analyses every table, one statement each (see analyseTables): the refresh after each
 * automatic backup, which also covers changes the counters lost (they restart from zero
 * when the process is killed, as a stop on Windows does). Never throws.
 */
export function analyseEveryTable(reason: string): Promise<AnalyseOutcome> {
  return serialised(async () => {
    try {
      const db = await getDatabase();
      if (db.driver !== 'pglite') return NOTHING;
      const activity = await readTableActivity(db);
      const unanalysed = new Set(activity.filter((t) => !t.hasStatistics).map((t) => t.table));
      return await analyseTables(db, activity.map((t) => t.table), reason, { onlyIfRows: unanalysed });
    } catch (err) {
      logger.warn(`Planner statistics were not refreshed (${reason})`, { error: err instanceof Error ? err.message : String(err) });
      return NOTHING;
    }
  });
}
