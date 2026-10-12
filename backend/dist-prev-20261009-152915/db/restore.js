import { txQuery } from './index.js';
/**
 * Dump/restore order. Restoring walks it forwards and truncating walks it
 * backwards, so foreign keys hold at every step.
 */
export const BACKUP_TABLES = [
    'permissions', 'roles', 'role_permissions',
    'lookups', 'users', 'user_roles',
    'suppliers', 'items',
    'purchase_indent_headers', 'purchase_indent_lines', 'indent_approvals',
    'purchase_order_headers', 'purchase_order_lines', 'po_indent_sources',
    'grn_headers', 'grn_lines', 'grn_line_mlns', 'stock_ledger',
    'requisition_headers', 'requisition_lines', 'requisition_approvals',
    'requisition_issues', 'requisition_issue_lines',
    'document_sequences', 'app_settings', 'google_sheet_mappings',
    'google_sync_jobs', 'google_sync_errors',
    'import_jobs', 'import_rows',
    'audit_logs', 'backup_metadata',
];
/**
 * `lookups.created_by`/`updated_by` reference `users`, and `users.department_id`
 * references `lookups` — a genuine circular foreign key. `lookups` must still
 * insert before `users` (department_id needs the row to already exist), so both
 * user-referencing columns are left NULL on the way in and backfilled once
 * `users` exists. `lookups.parent_id` is self-referential (Sub Main Group ->
 * Main Group) and `SELECT *` gives no ordering guarantee a child won't be read
 * before its parent, so it is deferred the same way. Only surfaces once a
 * lookup row actually carries one of these — a fresh/system-only database
 * never hits it, which is why this shipped unnoticed.
 */
const DEFERRED_COLUMNS = {
    lookups: ['created_by', 'updated_by', 'parent_id'],
};
/** table -> set of columns whose type is json/jsonb, read from the live catalogue. */
async function loadJsonColumns(tx) {
    const rows = await txQuery(tx, `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type IN ('json', 'jsonb')`);
    const map = new Map();
    for (const r of rows) {
        const set = map.get(r.table_name) ?? new Set();
        set.add(r.column_name);
        map.set(r.table_name, set);
    }
    return map;
}
/**
 * table -> set of columns the database computes for itself (GENERATED ALWAYS
 * AS). Re-inserting one is an error, and omitting it is also how a restore
 * proves the stored figures were consistent: they are recomputed from the
 * inputs. Read from the live catalogue rather than hand-kept, so a later
 * migration that adds a generated column (as `gst_amount` once did) can never
 * silently break restore again the way a static list did.
 */
async function loadGeneratedColumns(tx) {
    const rows = await txQuery(tx, `SELECT table_name, column_name
       FROM information_schema.columns
      WHERE table_schema = 'public' AND is_generated = 'ALWAYS'`);
    const map = new Map();
    for (const r of rows) {
        const set = map.get(r.table_name) ?? new Set();
        set.add(r.column_name);
        map.set(r.table_name, set);
    }
    return map;
}
/**
 * Replaces the contents of every backup table with the payload.
 * MUST be called inside a transaction: either the database ends up exactly as the
 * backup described, or it is left completely untouched.
 */
export async function restoreFromPayload(tx, payload) {
    const jsonColumns = await loadJsonColumns(tx);
    const generatedColumns = await loadGeneratedColumns(tx);
    // Clear in reverse dependency order.
    for (const table of [...BACKUP_TABLES].reverse()) {
        await tx.query(`DELETE FROM ${table}`);
    }
    const restored = {};
    const deferred = [];
    for (const table of BACKUP_TABLES) {
        const rows = payload.data[table] ?? [];
        if (rows.length === 0) {
            restored[table] = 0;
            continue;
        }
        const generated = generatedColumns.get(table) ?? new Set();
        const deferredCols = new Set(DEFERRED_COLUMNS[table] ?? []);
        const jsonCols = jsonColumns.get(table) ?? new Set();
        const columns = Object.keys(rows[0]).filter((c) => !generated.has(c) && !deferredCols.has(c));
        const columnList = columns.map((c) => `"${c}"`).join(',');
        const placeholders = columns.map((_, i) => `$${i + 1}`).join(',');
        for (const row of rows) {
            const r = row;
            for (const col of deferredCols) {
                if (r[col] !== null && r[col] !== undefined) {
                    deferred.push({ table, id: r.id, column: col, value: r[col] });
                }
            }
            const values = columns.map((c) => {
                const v = r[c];
                if (v === null || v === undefined)
                    return null;
                // A json/jsonb column is ALWAYS re-serialised — including plain strings,
                // numbers and booleans, which must arrive as valid JSON literals.
                if (jsonCols.has(c))
                    return JSON.stringify(v);
                // A non-json column holding an object can only be an array/composite.
                if (typeof v === 'object')
                    return JSON.stringify(v);
                return v;
            });
            await tx.query(`INSERT INTO ${table} (${columnList}) VALUES (${placeholders})`, values);
        }
        restored[table] = rows.length;
        // Re-align identity sequences so new inserts cannot collide with restored ids.
        if (columns.includes('id')) {
            await tx.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`);
        }
    }
    // Every table now exists — safe to backfill the columns that were held back
    // to break the users <-> lookups circular reference.
    for (const d of deferred) {
        await tx.query(`UPDATE ${d.table} SET "${d.column}" = $1 WHERE id = $2`, [d.value, d.id]);
    }
    return {
        restored,
        totalRows: Object.values(restored).reduce((a, b) => a + b, 0),
    };
}
/** Reads every backup table for a dump. Shared so dump and restore stay in step. */
export async function collectBackupData(runQuery) {
    const data = {};
    const counts = {};
    for (const table of BACKUP_TABLES) {
        const rows = await runQuery(`SELECT * FROM ${table}`);
        data[table] = rows;
        counts[table] = rows.length;
    }
    return { data, counts };
}
//# sourceMappingURL=restore.js.map