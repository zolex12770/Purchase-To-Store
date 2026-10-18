/**
 * Migration runner.
 *
 * Applies every `.sql` file in `migrations/` exactly once, in filename order, each inside
 * a single transaction. Applied migrations are recorded in `schema_migrations` together
 * with a checksum, so an already-applied migration that is later edited is reported as a
 * hard error rather than silently diverging from the live schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabase, type Queryable } from './driver.js';
import { logger } from '../core/logger.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');

/**
 * Splits a SQL script into individual statements.
 * Respects single-quoted strings, dollar-quoted blocks, line comments and block comments,
 * so a semicolon inside any of those does not split the statement.
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // line comment
    if (ch === '-' && next === '-') {
      const nl = sql.indexOf('\n', i);
      const end = nl === -1 ? sql.length : nl;
      buf += sql.slice(i, end);
      i = end;
      continue;
    }
    // block comment
    if (ch === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      const stop = end === -1 ? sql.length : end + 2;
      buf += sql.slice(i, stop);
      i = stop;
      continue;
    }
    // single-quoted string (with '' escape)
    if (ch === "'") {
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      buf += sql.slice(i, j);
      i = j;
      continue;
    }
    // double-quoted identifier
    if (ch === '"') {
      let j = i + 1;
      while (j < sql.length && sql[j] !== '"') j += 1;
      buf += sql.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    // dollar-quoted block: $tag$ ... $tag$
    if (ch === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        const stop = end === -1 ? sql.length : end + tag.length;
        buf += sql.slice(i, stop);
        i = stop;
        continue;
      }
    }
    if (ch === ';') {
      const stmt = buf.trim();
      if (stmt.length > 0) out.push(stmt);
      buf = '';
      i += 1;
      continue;
    }
    buf += ch;
    i += 1;
  }

  const tail = buf.trim();
  if (tail.length > 0) out.push(tail);

  // Drop statements that are only comments/whitespace.
  return out.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}

async function runScript(tx: Queryable, sql: string, label: string): Promise<void> {
  const statements = splitStatements(sql);
  for (const [idx, stmt] of statements.entries()) {
    try {
      await tx.query(stmt);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${label}: statement ${idx + 1}/${statements.length} failed: ${message}\n--- SQL ---\n${stmt.slice(0, 600)}`,
      );
    }
  }
}

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Maintenance to run once, AFTER a given migration has committed.
 *
 * A migration runs inside a transaction, and VACUUM cannot — so a migration
 * that deletes a large number of rows has no way to give the space back
 * itself. The embedded engine has no autovacuum either. Each statement here
 * runs on its own, outside any transaction, right after its migration is
 * recorded, and is strictly best-effort: a failure is logged and start-up
 * carries on, because the migration itself has already succeeded.
 */
const POST_MIGRATION: Record<string, string[]> = {
  // 213,502 duplicate log rows are deleted by 020; rewriting the table shrinks
  // it from about 86 MB to about 7 MB (measured on a copy of the live data).
  '020_simplify_redundant_indexes_and_sync_log': ['VACUUM (FULL, ANALYZE) google_sync_errors'],
  // PGlite runs no autovacuum. On a copy of production (2026-10-16) these tables
  // held 418 MB, mostly dead rows left by the old inventory sync rewriting every
  // row each run; VACUUM FULL brought them to 89 MB in 3.5 s.
  '026_reversals_and_maintenance': [
    'google_db_outbox', 'items', 'inventory_transactions', 'google_db_rows', 'google_sync_errors',
    'inventory_items', 'stock_ledger', 'grn_lines', 'grn_line_mlns', 'suppliers', 'requisition_lines',
    'grn_headers', 'purchase_indent_lines', 'inventory_quarantine', 'inventory_sync_checkpoints',
  ].map((t) => `VACUUM (FULL, ANALYZE) ${t}`),
  // Nor does it ever analyse a table. With no statistics for the PO register imported
  // on 2026-10-16, the planner took the Pending PO list narrowed by receipt evidence
  // for a handful of rows and summed every GRN line again for each PO: on a copy of
  // 2026-10-17 its totals took 2.9 s under 'Receipt on store sheet only' and the
  // receipt evidence summary 18 to 90 s, against 0.03 s and 0.1 to 0.3 s once analysed.
  // A database restored later is analysed by the restore itself (db/statistics.ts).
  // The whole database, not only the PO and GRN tables it first named: the indent and
  // requisition tables of production had never been analysed either (C01, 2026-10-18),
  // and the whole copy of 2026-10-17 takes about 1 s, before the server listens.
  '030_store_grn_link_holds': ['ANALYZE'],
};

/**
 * Reports which migrations would be applied, WITHOUT applying any of them.
 *
 * Deploy pipelines need to know whether a release carries a schema change
 * before they take traffic down; asking by running the migration is not an
 * acceptable way to find out.
 *
 * Uses the same checksum rule as `runMigrations`, so a file that was edited
 * after being applied is reported here rather than discovered mid-deploy.
 */
export async function pendingMigrations(): Promise<{ pending: string[]; applied: string[]; changed: string[] }> {
  const db = await getDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const existing = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const appliedMap = new Map(existing.rows.map((r) => [r.version, r.checksum]));

  const pending: string[] = [];
  const applied: string[] = [];
  const changed: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
    const prior = appliedMap.get(version);

    if (!prior) pending.push(version);
    else if (prior !== checksum) changed.push(version);
    else applied.push(version);
  }

  return { pending, applied, changed };
}

export async function runMigrations(options: { silent?: boolean } = {}): Promise<MigrationResult> {
  const db = await getDatabase();

  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);

  if (!fs.existsSync(MIGRATIONS_DIR)) {
    throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const existing = await db.query<{ version: string; checksum: string }>(
    'SELECT version, checksum FROM schema_migrations',
  );
  const appliedMap = new Map(existing.rows.map((r) => [r.version, r.checksum]));

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');

    const prior = appliedMap.get(version);
    if (prior) {
      if (prior !== checksum) {
        throw new Error(
          `Migration ${version} has already been applied but its file has changed ` +
            `(checksum ${prior.slice(0, 12)} → ${checksum.slice(0, 12)}). ` +
            `Add a new migration instead of editing an applied one, or run \`npm run db:reset\` in development.`,
        );
      }
      skipped.push(version);
      continue;
    }

    const started = Date.now();
    await db.transaction(async (tx) => {
      await runScript(tx, sql, `Migration ${version}`);
      await tx.query(
        'INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)',
        [version, checksum, Date.now() - started],
      );
    });
    applied.push(version);
    if (!options.silent) logger.info(`  ✓ migration ${version} (${Date.now() - started}ms)`);

    for (const statement of POST_MIGRATION[version] ?? []) {
      try {
        await db.query(statement);
      } catch (err) {
        logger.warn(`Post-migration maintenance did not run (${statement})`, {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  return { applied, skipped };
}
