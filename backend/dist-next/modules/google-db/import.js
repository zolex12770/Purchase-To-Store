/**
 * Google Sheets -> SQL controlled import (historical / financial-year data).
 *
 * The sheets are BUSINESS tabs, so one row can feed several SQL tables — a
 * "Purchase Order" row carries both its header and its line. Each view declares
 * `importTargets` (header table first, line table last), and a row is applied to
 * each target in turn inside one transaction.
 *
 * This is the ONLY path by which a spreadsheet edit reaches the primary
 * database, and it is deliberately two-step and explicitly invoked:
 * `planImport()` reads and validates without writing; `commitImport()` applies a
 * plan the caller has already seen. Nothing here runs on a schedule or on a
 * business request.
 *
 * Rules, and where each lives:
 *   • match on real database ids, never a sheet row number  -> target.pk
 *   • never guess — unmatchable rows are INVALID/CONFLICT   -> planTarget()
 *   • never overwrite a row SQL changed more recently       -> CONFLICT rule
 *   • never write generated or secret columns               -> writableColumns()
 *   • recalculate balances with the app's own logic         -> recalculate()
 *   • idempotent — a second run reports UNCHANGED           -> sameValue()
 *   • auditable                                             -> auditIn() per row
 */
import { query, queryOne, txQuery, txQueryOne, withTransaction, } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { auditIn, SYSTEM_ACTOR } from '../../core/audit.js';
import { recomputePoStatus, recomputeIndentClosure } from '../../domain/quantities.js';
import { BUSINESS_VIEWS } from './views/index.js';
import { fieldColumn, fieldLookup } from './views/types.js';
import { readTab, googleDbConfig } from './client.js';
import { writeConflictSheet } from './replica.js';
import { KEY_SEPARATOR } from './schema.js';
import { syncedAtFor } from './rowindex.js';
async function loadTableFacts() {
    const rows = await query(`SELECT table_name, column_name, is_generated, is_nullable, column_default
       FROM information_schema.columns WHERE table_schema = 'public'`);
    const map = new Map();
    for (const r of rows) {
        const f = map.get(r.table_name)
            ?? { generated: new Set(), columns: new Set(), notNull: new Set(), hasDefault: new Set(), hasUpdatedAt: false };
        f.columns.add(r.column_name);
        if (r.is_generated === 'ALWAYS')
            f.generated.add(r.column_name);
        if (r.is_nullable === 'NO')
            f.notNull.add(r.column_name);
        if (r.column_default !== null)
            f.hasDefault.add(r.column_name);
        if (r.column_name === 'updated_at')
            f.hasUpdatedAt = true;
        map.set(r.table_name, f);
    }
    return map;
}
/**
 * Columns a new row cannot be created without: NOT NULL, no database default,
 * and not generated. If a view's importTargets never maps one of these, an
 * INSERT from that sheet is impossible — better to say so in the preview than
 * to fail mid-transaction with a raw constraint error.
 */
function requiredForInsert(facts) {
    if (!facts)
        return [];
    return [...facts.notNull].filter((c) => !facts.hasDefault.has(c) && !facts.generated.has(c));
}
/**
 * Columns actually written for one row.
 *
 * A blank cell against a NOT NULL column is "not supplied", not "set to NULL":
 * writing NULL there would be rejected by the constraint, and the column
 * usually has a database default that should apply instead. Such columns are
 * dropped from the statement — on INSERT the default fills them, on UPDATE the
 * existing value is left alone.
 */
function columnsToWrite(values, facts) {
    return Object.keys(values).filter((c) => !(values[c] === '' && facts?.notNull.has(c)));
}
/** Never writable from a sheet, whatever a view might declare. */
const FORBIDDEN_COLUMNS = new Set(['password_hash', 'refresh_token_hash']);
function writableColumns(target, facts) {
    return Object.entries(target.fields)
        .map(([header, f]) => ({ header, column: fieldColumn(f), lookup: fieldLookup(f) }))
        .filter((w) => facts?.columns.has(w.column)
        && !facts.generated.has(w.column)
        && !FORBIDDEN_COLUMNS.has(w.column));
}
const lkKey = (category, kind, value) => `${category}~${kind}:${value.trim().toUpperCase()}`;
async function loadLookupIndex() {
    const rows = await query('SELECT id, category, code, name FROM lookups WHERE deleted_at IS NULL');
    const map = new Map();
    for (const r of rows) {
        map.set(lkKey(r.category, 'N', r.name), Number(r.id));
        map.set(lkKey(r.category, 'C', r.code), Number(r.id));
    }
    return map;
}
/** Resolved id, or null when the text matches nothing in that category. */
function resolveLookup(index, category, value) {
    return index.get(lkKey(category, 'N', value))
        ?? index.get(lkKey(category, 'C', value))
        ?? null;
}
async function loadForeignKeys() {
    const rows = await query(`SELECT tc.table_name, kcu.column_name,
            ccu.table_name AS ref_table, ccu.column_name AS ref_column
       FROM information_schema.table_constraints tc
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = tc.constraint_name AND kcu.table_schema = tc.table_schema
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = tc.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'`);
    const map = new Map();
    for (const r of rows) {
        map.set(r.table_name, [
            ...(map.get(r.table_name) ?? []),
            { column: r.column_name, refTable: r.ref_table, refColumn: r.ref_column },
        ]);
    }
    return map;
}
/* ── Value comparison ───────────────────────────────────────────────────────── */
function normalise(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === 'boolean')
        return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'object')
        return JSON.stringify(value);
    const text = String(value).trim();
    // Business tabs render booleans as Yes/No because that is what a person
    // reading a spreadsheet expects; comparison and writing both normalise them
    // back so a round trip does not look like a change.
    if (/^(yes|true|y)$/i.test(text))
        return 'TRUE';
    if (/^(no|false|n)$/i.test(text))
        return 'FALSE';
    return text;
}
/** Values are written back to SQL in their normalised form, not as typed. */
function toSqlValue(raw) {
    if (raw === '')
        return null;
    const n = normalise(raw);
    return n === 'TRUE' || n === 'FALSE' ? n : raw;
}
/**
 * Numbers and timestamps rarely round-trip character-identical (NUMERIC(18,4)
 * comes back "40.0000" but may sit in the sheet as "40"), so equality compares
 * numerically when both sides look numeric and by instant when both parse as
 * timestamps. Everything else compares as trimmed text.
 */
function sameValue(sqlValue, sheetValue) {
    const a = normalise(sqlValue);
    const b = normalise(sheetValue);
    if (a === b)
        return true;
    if (a === '' || b === '')
        return false;
    const na = Number(a);
    const nb = Number(b);
    if (!Number.isNaN(na) && !Number.isNaN(nb))
        return Math.abs(na - nb) < 0.00005;
    const ta = Date.parse(a);
    const tb = Date.parse(b);
    if (!Number.isNaN(ta) && !Number.isNaN(tb))
        return ta === tb;
    return false;
}
/* ── Plan ───────────────────────────────────────────────────────────────────── */
export async function planImport(sheets) {
    const cfg = googleDbConfig();
    if (!cfg.configured) {
        return {
            sheets: [], totals: { read: 0, insert: 0, update: 0, unchanged: 0, conflict: 0, invalid: 0 },
            message: cfg.reason ?? 'Google replica is not configured.',
        };
    }
    const views = BUSINESS_VIEWS
        .filter((v) => v.importTargets?.length)
        .filter((v) => !sheets?.length || sheets.includes(v.sheet));
    const facts = await loadTableFacts();
    const fks = await loadForeignKeys();
    const lookups = await loadLookupIndex();
    const plans = [];
    for (const v of views)
        plans.push(await planSheet(v, facts, fks, lookups));
    const totals = plans.reduce((acc, p) => ({
        read: acc.read + p.rowsRead,
        insert: acc.insert + p.insert,
        update: acc.update + p.update,
        unchanged: acc.unchanged + p.unchanged,
        conflict: acc.conflict + p.conflict,
        invalid: acc.invalid + p.invalid,
    }), { read: 0, insert: 0, update: 0, unchanged: 0, conflict: 0, invalid: 0 });
    return {
        sheets: plans,
        totals,
        message: `${totals.read} sheet row(s) examined — ${totals.insert} to insert, ${totals.update} to update, `
            + `${totals.unchanged} unchanged, ${totals.conflict} conflict(s), ${totals.invalid} invalid.`,
    };
}
async function planSheet(view, facts, fks, lookups) {
    const base = {
        sheet: view.sheet, rowsRead: 0, insert: 0, update: 0, unchanged: 0, conflict: 0, invalid: 0, rows: [],
    };
    let grid;
    try {
        grid = await readTab(view.sheet);
    }
    catch (err) {
        return { ...base, error: err instanceof Error ? err.message : String(err) };
    }
    if (grid.length < 2)
        return base;
    const header = grid[0];
    const rows = [];
    // When each sheet row was last written by the replica. This used to be a
    // `_synced_at` column ON the tab — sync bookkeeping sitting in the middle of
    // business data. The same fact is already recorded per row in
    // `google_db_rows`, so the guard against overwriting a newer SQL row survives
    // while the column does not.
    const keyIdx = view.primaryKey.map((p) => header.indexOf(p));
    const keyOf = (cells) => keyIdx.map((i) => (i >= 0 ? (cells[i] ?? '') : '')).join(KEY_SEPARATOR);
    const exportedAt = await syncedAtFor(view.sheet, grid.slice(1).map((cells) => keyOf(cells ?? [])));
    // Same header row written twice (once per line) must not be planned twice.
    const seenPerTable = new Map();
    for (let r = 1; r < grid.length; r += 1) {
        const cells = grid[r] ?? [];
        if (cells.every((c) => c === ''))
            continue;
        base.rowsRead += 1;
        const cell = (h) => cells[header.indexOf(h)] ?? '';
        const syncedAt = exportedAt.get(keyOf(cells)) ?? NaN;
        for (const target of view.importTargets ?? []) {
            const plan = await planTarget(view, target, r + 1, cell, syncedAt, facts.get(target.table), fks.get(target.table) ?? [], lookups);
            if (!plan)
                continue;
            if (plan.action !== 'INVALID') {
                const seen = seenPerTable.get(target.table) ?? new Set();
                if (seen.has(plan.rowKey))
                    continue; // header row already planned by a previous line
                seen.add(plan.rowKey);
                seenPerTable.set(target.table, seen);
            }
            rows.push(plan);
            if (plan.action === 'INSERT')
                base.insert += 1;
            else if (plan.action === 'UPDATE')
                base.update += 1;
            else if (plan.action === 'UNCHANGED')
                base.unchanged += 1;
            else if (plan.action === 'CONFLICT')
                base.conflict += 1;
            else
                base.invalid += 1;
        }
    }
    return { ...base, rows };
}
async function planTarget(view, target, sheetRow, cell, syncedAt, facts, fks, lookups) {
    const writable = writableColumns(target, facts);
    if (writable.length === 0)
        return null;
    const values = {};
    const unresolved = [];
    for (const w of writable) {
        const raw = cell(w.header);
        if (!w.lookup) {
            values[w.column] = raw;
            continue;
        }
        if (raw === '') {
            values[w.column] = '';
            continue;
        }
        const id = resolveLookup(lookups, w.lookup, raw);
        // Refusing beats guessing: silently dropping an unrecognised department
        // would import the row with no department and look like a success.
        if (id === null)
            unresolved.push(`${w.header}="${raw}" is not a known ${w.lookup}`);
        else
            values[w.column] = String(id);
    }
    // Identity comes from the target's real primary key.
    const pkValues = target.pk.map((c) => values[c] ?? '');
    const rowKey = pkValues.join('|');
    const mk = (action, reason) => ({ sheet: view.sheet, table: target.table, sheetRow, rowKey, action, reason, values });
    // A completely blank target (e.g. a Purchase Order row with no GRN yet) is
    // simply not a row for this table — skip rather than report it as invalid.
    if (pkValues.every((v) => v === ''))
        return null;
    const missingPk = target.pk.filter((c) => !values[c]);
    if (missingPk.length > 0)
        return mk('INVALID', `missing ${target.table} key value(s): ${missingPk.join(', ')}`);
    if (unresolved.length > 0)
        return mk('INVALID', unresolved.join('; '));
    for (const fk of fks) {
        const raw = values[fk.column];
        if (raw === undefined || raw === '')
            continue;
        const found = await queryOne(`SELECT 1 AS one FROM ${fk.refTable} WHERE ${fk.refColumn} = $1`, [raw]);
        if (!found)
            return mk('INVALID', `${fk.column}=${raw} does not exist in ${fk.refTable}`);
    }
    const where = target.pk.map((c, i) => `${c} = $${i + 1}`).join(' AND ');
    const current = await queryOne(`SELECT * FROM ${target.table} WHERE ${where}`, pkValues);
    if (!current) {
        // Creating this row needs every mandatory column to be present.
        const supplied = new Set(columnsToWrite(values, facts));
        const missing = requiredForInsert(facts).filter((c) => !supplied.has(c));
        if (missing.length > 0) {
            return mk('INVALID', `cannot create ${target.table}: required column(s) ${missing.join(', ')} are not supplied by this sheet`);
        }
        return mk('INSERT');
    }
    // Compare only the columns an import would actually write — a blank cell
    // against a NOT NULL column is "not supplied" and is never written, so
    // counting it as a difference would leave the row permanently UPDATE and
    // break idempotency.
    const writableNow = new Set(columnsToWrite(values, facts));
    const changed = writable
        .map((w) => w.column)
        .filter((col) => writableNow.has(col) && !target.pk.includes(col) && !sameValue(current[col], values[col] ?? ''));
    if (changed.length === 0)
        return mk('UNCHANGED');
    // The sheet row carries the moment it was exported. If SQL moved on since,
    // the editor was not looking at the current row, so the edit is held back.
    const sqlUpdated = facts?.hasUpdatedAt ? Date.parse(normalise(current.updated_at)) : NaN;
    if (!Number.isNaN(syncedAt) && !Number.isNaN(sqlUpdated) && sqlUpdated > syncedAt) {
        return mk('CONFLICT', `${target.table} changed in SQL at ${new Date(sqlUpdated).toISOString()}, after this row was exported at `
            + `${new Date(syncedAt).toISOString()} (would change: ${changed.join(', ')})`);
    }
    return mk('UPDATE', `changed: ${changed.join(', ')}`);
}
export function emptyTouched() {
    return { pos: new Set(), poLines: new Set(), indents: new Set(), items: new Set() };
}
function collectTouched(table, values, touched) {
    const add = (set, raw) => {
        const n = raw ? Number(raw) : NaN;
        if (Number.isFinite(n))
            set.add(n);
    };
    if (table === 'purchase_order_headers')
        add(touched.pos, values.id);
    if (table === 'purchase_order_lines')
        add(touched.pos, values.po_id);
    // A GRN line names a PO LINE, not a PO — resolved in recalculate().
    if (table === 'grn_lines')
        add(touched.poLines, values.po_line_id);
    if (table === 'purchase_indent_headers')
        add(touched.indents, values.id);
    if (table === 'purchase_indent_lines')
        add(touched.indents, values.indent_id);
    if (table === 'po_indent_sources')
        add(touched.indents, values.indent_id);
    if (table === 'stock_ledger' || table === 'grn_lines' || table === 'requisition_issue_lines') {
        add(touched.items, values.item_id);
    }
}
/**
 * Applies a plan's INSERT/UPDATE rows in ONE transaction. CONFLICT and INVALID
 * rows are never applied — they are written to the __sync_conflicts tab for a
 * human. Derived balances are recomputed afterwards with the application's own
 * functions, so an imported historical GRN affects PO pending quantity and
 * stock exactly as a live one does — no manual closing of old documents.
 */
export async function commitImport(plan, actor = SYSTEM_ACTOR) {
    let inserted = 0;
    let updated = 0;
    let skipped = 0;
    const touched = emptyTouched();
    const facts = await loadTableFacts();
    const importId = await withTransaction(async (tx) => {
        const created = await txQueryOne(tx, `INSERT INTO google_db_imports (status, dry_run, tables, rows_read, actor_user_id)
       VALUES ('PREVIEW', FALSE, $1, $2, $3) RETURNING id`, [plan.sheets.map((s) => s.sheet), plan.totals.read, actor.userId ?? null]);
        // Tag every write so the capture trigger records source = GOOGLE_IMPORT and
        // the replica drain does not echo these rows straight back to the sheet.
        await tx.query("SET LOCAL zolex.sync_source = 'GOOGLE_IMPORT'");
        // BUSINESS_VIEWS order is dependency order (masters, then transactions), and
        // within a row importTargets run header-first, so a parent always lands
        // before the child that references it.
        for (const view of BUSINESS_VIEWS) {
            const sheetPlan = plan.sheets.find((s) => s.sheet === view.sheet);
            if (!sheetPlan)
                continue;
            for (const target of view.importTargets ?? []) {
                for (const row of sheetPlan.rows.filter((r) => r.table === target.table)) {
                    if (row.action !== 'INSERT' && row.action !== 'UPDATE') {
                        skipped += 1;
                        continue;
                    }
                    const cols = columnsToWrite(row.values, facts.get(target.table));
                    if (cols.length === 0) {
                        skipped += 1;
                        continue;
                    }
                    const before = row.action === 'UPDATE'
                        ? await txQueryOne(tx, `SELECT * FROM ${target.table} WHERE ${target.pk.map((c, i) => `${c} = $${i + 1}`).join(' AND ')}`, target.pk.map((c) => row.values[c] ?? ''))
                        : null;
                    // An empty cell means NULL, so clearing a cell clears the column
                    // rather than storing an empty string.
                    const params = cols.map((c) => toSqlValue(row.values[c] ?? ''));
                    const updates = cols.filter((c) => !target.pk.includes(c)).map((c) => `${c} = EXCLUDED.${c}`);
                    await tx.query(`INSERT INTO ${target.table} (${cols.join(',')})
             VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
             ON CONFLICT (${target.pk.join(',')}) DO UPDATE SET ${updates.length > 0 ? updates.join(', ') : `${target.pk[0]} = EXCLUDED.${target.pk[0]}`}`, params);
                    if (row.action === 'INSERT')
                        inserted += 1;
                    else
                        updated += 1;
                    await auditIn(tx, {
                        actor,
                        action: row.action === 'INSERT' ? 'CREATE' : 'UPDATE',
                        entity: target.table,
                        entityLabel: `${target.table}#${row.rowKey}`,
                        before: before ?? undefined,
                        after: row.values,
                        message: `Imported from Google Sheets ("${view.sheet}" row ${row.sheetRow}).`,
                    });
                    collectTouched(target.table, row.values, touched);
                }
            }
            // An import may have inserted rows a person typed at the bottom of the
            // tab, so the recorded row positions can no longer be trusted. Marking the
            // index stale makes the next drain rebuild it from the sheet's key column
            // before it writes anything — otherwise a targeted update could land on
            // the wrong row.
            await tx.query(`UPDATE google_db_state SET last_import = now(), index_dirty = TRUE, updated_at = now()
          WHERE sheet_name = $1`, [view.sheet]);
        }
        // Sequences must not keep handing out ids a historical import already used.
        await realignSequences(tx);
        await recalculate(tx, touched);
        await tx.query(`UPDATE google_db_imports
          SET status = 'COMMITTED', rows_inserted = $2, rows_updated = $3,
              rows_unchanged = $4, rows_rejected = $5, conflicts = $6,
              finished_at = now(), message = $7
        WHERE id = $1`, [
            created.id, inserted, updated, plan.totals.unchanged,
            plan.totals.invalid, plan.totals.conflict,
            `${inserted} inserted, ${updated} updated, ${skipped} skipped.`,
        ]);
        return created.id;
    });
    // Surface what was NOT applied, on the control tab, for review.
    const held = plan.sheets.flatMap((s) => s.rows.filter((r) => r.action === 'CONFLICT' || r.action === 'INVALID')
        .map((r) => ({ sheet: s.sheet, sheetRow: r.sheetRow, rowKey: r.rowKey, reason: r.reason ?? r.action })));
    if (held.length > 0) {
        try {
            await writeConflictSheet(held);
        }
        catch (err) {
            logger.warn(`Google replica: could not write __sync_conflicts — ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    const message = `${inserted} record(s) inserted and ${updated} updated from Google Sheets; `
        + `${plan.totals.conflict} conflict(s) and ${plan.totals.invalid} invalid row(s) were NOT applied.`;
    logger.info(`Google replica import #${importId}: ${message}`);
    return { importId, status: 'COMMITTED', inserted, updated, skipped, message };
}
/**
 * A historical import writes explicit ids, which leaves each table's identity
 * sequence behind them — the next live INSERT would then collide. Push every
 * sequence past its table's current maximum.
 */
async function realignSequences(tx) {
    const rows = await txQuery(tx, `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_default LIKE 'nextval%'`);
    for (const r of rows) {
        await tx.query(`SELECT setval(pg_get_serial_sequence($1, $2),
                     GREATEST((SELECT COALESCE(MAX(${r.column_name}), 0) FROM ${r.table_name}), 1))`, [r.table_name, r.column_name]);
    }
}
/**
 * Recomputes everything imported rows can affect, using the application's own
 * authoritative logic rather than any value that came from a sheet: PO status
 * from its receipts, indent closure from its consumption, and live stock from
 * the ledger (the identical formula the Stock Reconciliation screen checks).
 */
async function recalculate(tx, touched) {
    if (touched.poLines.size > 0) {
        const pos = await txQuery(tx, 'SELECT DISTINCT po_id FROM purchase_order_lines WHERE id = ANY($1)', [[...touched.poLines]]);
        for (const r of pos)
            touched.pos.add(Number(r.po_id));
    }
    for (const poId of touched.pos) {
        if (Number.isFinite(poId))
            await recomputePoStatus(tx, poId);
    }
    for (const indentId of touched.indents) {
        if (Number.isFinite(indentId))
            await recomputeIndentClosure(tx, indentId);
    }
    const itemIds = [...touched.items].filter((n) => Number.isFinite(n));
    if (itemIds.length > 0) {
        await tx.query(`UPDATE items i
          SET live_stock_qty = COALESCE(l.balance, 0), updated_at = now()
         FROM (
           -- Each aggregate is COALESCEd individually: a FILTER matching no rows
           -- yields NULL, and one NULL term would turn the whole expression NULL,
           -- silently zeroing an item's stock instead of adding to it.
           SELECT item_id,
                  COALESCE(SUM(inward_qty)  FILTER (WHERE txn_type = 'GRN_INWARD'), 0)
                - COALESCE(SUM(outward_qty) FILTER (WHERE txn_type = 'GRN_REVERSAL'), 0)
                - COALESCE(SUM(outward_qty) FILTER (WHERE txn_type = 'REQUISITION_ISSUE'), 0)
                + COALESCE(SUM(inward_qty)  FILTER (WHERE txn_type = 'REQUISITION_REVERSAL'), 0) AS balance
             FROM stock_ledger
            WHERE item_id = ANY($1)
            GROUP BY item_id
         ) l
        WHERE i.id = l.item_id`, [itemIds]);
    }
}
//# sourceMappingURL=import.js.map