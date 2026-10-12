/**
 * Which SQL tables/columns the Google Sheets replica mirrors, and under what
 * tab name.
 *
 * The table list is READ FROM `information_schema`, never hard-coded, so a
 * table added by a future migration joins the replica automatically (that was
 * an explicit requirement). Two things are subtracted from it:
 *
 *   • EXCLUDED_TABLES — infrastructure/auth rows that are not business data.
 *   • REDACTED_COLUMNS — secrets that must never leave the database, exported
 *     as a literal '[redacted]' so the column still lines up but the value
 *     never appears in a spreadsheet.
 *
 * Ordering matters for the Google -> SQL direction: a parent row has to exist
 * before the child that references it. `DEPENDENCY_ORDER` reuses the ordering
 * already proven by the backup/restore path (db/restore.ts BACKUP_TABLES);
 * any table not named there is appended alphabetically after the known ones.
 */
import { query } from '../../db/index.js';
import { txQuery } from '../../db/index.js';
import { BACKUP_TABLES } from '../../db/restore.js';
/** Never mirrored: session/auth plumbing and migration bookkeeping. */
export const EXCLUDED_TABLES = new Set([
    'user_sessions', // refresh-token hashes; ephemeral auth state, not business data
    'schema_migrations', // migration bookkeeping
]);
/** Columns replaced with '[redacted]' on export and ignored on import. */
export const REDACTED_COLUMNS = {
    users: new Set(['password_hash']),
};
export const REDACTED_PLACEHOLDER = '[redacted]';
/** Prefix marking a system/control sheet rather than a mirrored table. */
export const SYSTEM_SHEET_PREFIX = '__';
/**
 * Stable identity for one row, from its primary-key values. ASCII 31 (unit
 * separator) is the joiner because it cannot occur in an id, a document number
 * or a settings key, and it is trivially producible on both sides — the SQL
 * trigger builds the identical string with chr(31).
 */
export const KEY_SEPARATOR = '\u001F';
export function rowKeyOf(pk, row) {
    return pk.map((c) => String(row[c] ?? '')).join(KEY_SEPARATOR);
}
/**
 * A Google tab name must be <=100 chars and free of []*?:/\ — every current
 * table name already satisfies that, but a future one might not, so the
 * transform is deterministic rather than assumed. Callers persist the result
 * in __sheet_registry so a rename can never silently orphan a tab.
 */
export function toSheetName(table) {
    const safe = table.replace(/[[\]*?:/\\]/g, '_');
    return safe.length <= 100 ? safe : `${safe.slice(0, 90)}_${hash8(safe)}`;
}
function hash8(s) {
    let h = 0;
    for (let i = 0; i < s.length; i += 1) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(36).padStart(8, '0').slice(0, 8);
}
/** Known-good dependency order (parents first), reused from the restore path. */
const DEPENDENCY_ORDER = [...BACKUP_TABLES];
function orderTables(tables) {
    const known = DEPENDENCY_ORDER.filter((t) => tables.includes(t));
    const unknown = tables.filter((t) => !DEPENDENCY_ORDER.includes(t)).sort();
    return [...known, ...unknown];
}
/**
 * Every mirrored table with its column list and real primary key, straight
 * from the catalogue. A table with no primary key at all is skipped — without
 * a stable key neither an idempotent export upsert nor a safe import match is
 * possible, and guessing one is exactly what the brief forbids.
 */
export async function loadReplicaSchema(tx) {
    const run = (sql, params = []) => (tx ? txQuery(tx, sql, params) : query(sql, params));
    const rows = await run(`SELECT c.table_name, c.column_name, c.data_type, c.is_generated
       FROM information_schema.columns c
       JOIN information_schema.tables t
         ON t.table_schema = c.table_schema AND t.table_name = c.table_name
      WHERE c.table_schema = 'public' AND t.table_type = 'BASE TABLE'
      ORDER BY c.table_name, c.ordinal_position`);
    const pkRows = await run(`SELECT tc.table_name, kcu.column_name, kcu.ordinal_position AS ordinal
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'PRIMARY KEY'
      ORDER BY tc.table_name, kcu.ordinal_position`);
    const pkByTable = new Map();
    for (const r of pkRows) {
        pkByTable.set(r.table_name, [...(pkByTable.get(r.table_name) ?? []), r.column_name]);
    }
    const byTable = new Map();
    for (const r of rows) {
        if (EXCLUDED_TABLES.has(r.table_name))
            continue;
        const list = byTable.get(r.table_name) ?? [];
        list.push({
            name: r.column_name,
            dataType: r.data_type,
            isGenerated: r.is_generated === 'ALWAYS',
            redacted: REDACTED_COLUMNS[r.table_name]?.has(r.column_name) ?? false,
        });
        byTable.set(r.table_name, list);
    }
    const result = [];
    for (const table of orderTables([...byTable.keys()])) {
        const primaryKey = pkByTable.get(table);
        if (!primaryKey || primaryKey.length === 0)
            continue; // unkeyed -> not mirrorable
        result.push({ table, sheet: toSheetName(table), primaryKey, columns: byTable.get(table) });
    }
    return result;
}
//# sourceMappingURL=schema.js.map