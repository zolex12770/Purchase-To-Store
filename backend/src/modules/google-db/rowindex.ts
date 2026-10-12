/**
 * Where every business row lives inside its Google tab.
 *
 * This is the single change that takes the replica from expensive to cheap.
 *
 * Previously, pushing one changed row meant downloading the ENTIRE tab
 * (`values.get` over `A1:ZZ`) just to discover which sheet row held that
 * record — several megabytes for Item Master, on every drain. Because PGlite
 * runs in-process, parsing that response stalled the ERP's own event loop, and
 * the download itself was pure waste: the position had been known at the moment
 * the row was written and was simply thrown away.
 *
 * So it is kept. `google_db_rows` maps (sheet, business key) -> physical row
 * number plus a digest of the rendered cells. A drain then needs no reads at
 * all: it looks the position up in SQL, skips rows whose digest is unchanged,
 * and writes the rest in one batched call.
 *
 * The index is a cache of a remote resource, so it is allowed to be wrong — a
 * person can always insert a row by hand. `index_dirty` marks that case and the
 * index is rebuilt from the sheet's KEY COLUMNS ONLY (one or two columns, not
 * all sixty) before the next targeted write.
 */
import { createHash } from 'node:crypto';
import { query, execute } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { KEY_SEPARATOR } from './schema.js';
import { readColumns } from './client.js';
import type { BusinessView } from './views/types.js';

/** The sheet row the first data record occupies (row 1 is the header). */
export const FIRST_DATA_ROW = 2;

export interface RowPosition { rowNo: number; digest: string }

/**
 * Digest of a rendered row. sha1 is a native call and comfortably fast enough
 * for 100k rows; the point is only to detect "nothing about this row changed",
 * so an unchanged record costs zero API payload.
 */
export function digestOf(cells: string[]): string {
  return createHash('sha1').update(cells.join('')).digest('hex').slice(0, 16);
}

/** The business key of a row, as stored in the index. */
export function rowKeyOf(view: BusinessView, row: Record<string, unknown>, render: (v: unknown) => string): string {
  return view.primaryKey.map((p) => render(row[p])).join(KEY_SEPARATOR);
}

/** Positions of specific keys. Targeted drains ask for a handful, not the tab. */
export async function positionsFor(sheet: string, keys: string[]): Promise<Map<string, RowPosition>> {
  const out = new Map<string, RowPosition>();
  if (keys.length === 0) return out;
  // Chunked so a large coalesced drain cannot build a parameter list the driver
  // refuses, and so each statement stays small enough not to hold the loop.
  for (let i = 0; i < keys.length; i += 1000) {
    const slice = keys.slice(i, i + 1000);
    const rows = await query<{ row_key: string; row_no: number; digest: string }>(
      `SELECT row_key, row_no, digest FROM google_db_rows
        WHERE sheet_name = $1 AND row_key = ANY($2)`,
      [sheet, slice],
    );
    for (const r of rows) out.set(r.row_key, { rowNo: Number(r.row_no), digest: r.digest });
  }
  return out;
}

/**
 * When each of these rows was last written to the sheet, as epoch millis.
 *
 * This is what lets the importer keep its stale-edit guard after the
 * `_synced_at` COLUMN was removed from the business tabs: "the sheet row a
 * person edited was exported at T, and SQL has changed since T" is answerable
 * from here, without spending a column of every tab on sync bookkeeping.
 */
export async function syncedAtFor(sheet: string, keys: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const wanted = [...new Set(keys.filter((k) => k.split(KEY_SEPARATOR).some((p) => p !== '')))];
  for (let i = 0; i < wanted.length; i += 1000) {
    const rows = await query<{ row_key: string; synced_at: string | Date }>(
      `SELECT row_key, synced_at FROM google_db_rows WHERE sheet_name = $1 AND row_key = ANY($2)`,
      [sheet, wanted.slice(i, i + 1000)],
    );
    for (const r of rows) {
      const t = r.synced_at instanceof Date ? r.synced_at.getTime() : Date.parse(String(r.synced_at));
      if (!Number.isNaN(t)) out.set(r.row_key, t);
    }
  }
  return out;
}

/** First unused row of a tab — where an append lands. */
export async function nextRowNo(sheet: string): Promise<number> {
  const [row] = await query<{ n: number | null }>(
    'SELECT MAX(row_no) AS n FROM google_db_rows WHERE sheet_name = $1',
    [sheet],
  );
  const max = row?.n == null ? null : Number(row.n);
  return max == null ? FIRST_DATA_ROW : max + 1;
}

export async function countRows(sheet: string): Promise<number> {
  const [row] = await query<{ n: string }>(
    'SELECT COUNT(*)::int AS n FROM google_db_rows WHERE sheet_name = $1',
    [sheet],
  );
  return Number(row?.n ?? 0);
}

/** Bulk upsert of positions. Written in chunks so no single statement is huge. */
export async function setRows(
  sheet: string,
  entries: { key: string; rowNo: number; digest: string }[],
): Promise<void> {
  if (entries.length === 0) return;
  for (let i = 0; i < entries.length; i += 500) {
    const slice = entries.slice(i, i + 500);
    const params: unknown[] = [sheet];
    const tuples = slice.map((e) => {
      params.push(e.key, e.rowNo, e.digest);
      return `($1, $${params.length - 2}, $${params.length - 1}, $${params.length})`;
    });
    await execute(
      `INSERT INTO google_db_rows (sheet_name, row_key, row_no, digest)
       VALUES ${tuples.join(', ')}
       ON CONFLICT (sheet_name, row_key)
       DO UPDATE SET row_no = EXCLUDED.row_no, digest = EXCLUDED.digest, synced_at = now()`,
      params,
    );
  }
}

export async function resetSheet(sheet: string): Promise<void> {
  await execute('DELETE FROM google_db_rows WHERE sheet_name = $1', [sheet]);
}

export async function forgetKeys(sheet: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await execute('DELETE FROM google_db_rows WHERE sheet_name = $1 AND row_key = ANY($2)', [sheet, keys]);
}

/* ── Trust ─────────────────────────────────────────────────────────────────── */

export async function markDirty(sheet: string, why: string): Promise<void> {
  await execute(
    `UPDATE google_db_state SET index_dirty = TRUE, updated_at = now() WHERE sheet_name = $1`,
    [sheet],
  );
  logger.debug(`Google replica: row index for ${sheet} marked stale — ${why}`);
}

export async function markClean(sheet: string): Promise<void> {
  await execute(
    `UPDATE google_db_state SET index_dirty = FALSE, updated_at = now() WHERE sheet_name = $1`,
    [sheet],
  );
}

export async function isDirty(sheet: string): Promise<boolean> {
  const [row] = await query<{ index_dirty: boolean }>(
    'SELECT index_dirty FROM google_db_state WHERE sheet_name = $1',
    [sheet],
  );
  // No state row yet means nothing has been exported, which counts as untrusted.
  return row?.index_dirty ?? true;
}

/**
 * Rebuilds a tab's index from the sheet itself, reading ONLY the primary-key
 * columns.
 *
 * This is the expensive path, and the reason it stays cheap in practice is that
 * it reads 1-2 columns rather than 30-60: rebuilding a 100,000-row Item Master
 * index downloads one column of item ids, not the whole master. It runs only
 * when the index is marked stale — after a historical import, or after someone
 * edits the tab by hand.
 */
export async function rebuildFromSheet(view: BusinessView): Promise<number> {
  const header = view.columns.map((c) => c.header);
  const keyIdx = view.primaryKey.map((p) => header.indexOf(p));
  if (keyIdx.some((i) => i < 0)) {
    throw new Error(`${view.sheet}: primary key column missing from the declared header`);
  }

  const columns = await readColumns(view.sheet, keyIdx);
  await resetSheet(view.sheet);

  const entries: { key: string; rowNo: number; digest: string }[] = [];
  const seen = new Set<string>();                  // a Set, not entries.some():
  const rowCount = Math.max(0, ...columns.map((c) => c.length));
  for (let r = 1; r < rowCount; r += 1) {          // r = 0 is the header
    const key = keyIdx.map((_, k) => columns[k]?.[r] ?? '').join(KEY_SEPARATOR);
    // A blank key is a spacer or a half-typed row; it addresses no record.
    if (key.split(KEY_SEPARATOR).every((p) => p === '')) continue;
    // A duplicate key in the sheet keeps its FIRST position: rewriting the
    // first occurrence is what the importer's conflict rules already assume.
    // Scanning `entries` here instead would be quadratic — 100k rows is exactly
    // the size this module exists to survive.
    if (seen.has(key)) continue;
    seen.add(key);
    // The digest is left empty, which reads as "unknown" and forces the next
    // drain to rewrite the row rather than assume the sheet matches SQL.
    entries.push({ key, rowNo: r + 1, digest: '' });
  }

  await setRows(view.sheet, entries);
  await markClean(view.sheet);
  logger.info(`Google replica: rebuilt row index for ${view.sheet} from ${entries.length} sheet row(s).`);
  return entries.length;
}
