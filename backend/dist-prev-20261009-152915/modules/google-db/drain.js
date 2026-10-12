/**
 * Pushing queued SQL changes to the Google tabs — incrementally.
 *
 * What this replaces: previously, any changed table without an explicit row
 * mapping for a tab fell back to re-exporting that ENTIRE tab. Because `items`,
 * `users` and `lookups` are joined into almost every business tab and had no
 * such mapping, editing a single unit-of-measure rewrote roughly ten tabs
 * including all 12,461 rows of Item Master — a burst of API calls, a burst of
 * in-process query and string work, and (PGlite being in-process) a stalled ERP.
 *
 * What happens instead:
 *
 *   1. Coalesce the outbox into one set of changed keys per SQL table.
 *   2. For each affected tab, ask the database ONLY for the rows those keys
 *      touch, restricting the base tables through their indexes.
 *   3. Look each row's sheet position up in `google_db_rows` — no download.
 *   4. Skip rows whose rendered digest is unchanged.
 *   5. Send everything left, for every tab, as ONE `values.batchUpdate`.
 *
 * So 100 changes cost one API call, not 100 exports. A change whose fan-out is
 * genuinely large (renaming a UOM used by 9,000 items) is not forced through
 * this path at all: the tab is handed to the paced background job instead.
 *
 * Nothing here runs inside a business transaction, and every failure leaves the
 * outbox rows pending, so the worst case is a stale replica — never a blocked ERP.
 */
import { query, execute } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BUSINESS_VIEWS, viewBySheet } from './views/index.js';
import { buildRestrictedSql } from './views/types.js';
import { KEY_SEPARATOR } from './schema.js';
import { cellsOf, headerOf } from './render.js';
import { digestOf, positionsFor, nextRowNo, setRows, isDirty, rebuildFromSheet, FIRST_DATA_ROW, } from './rowindex.js';
import { googleDbConfig, batchWrite, ensureGrid, listTabs, rowRange, apiCallCount, isTransient, } from './client.js';
import { queueJob } from './jobs.js';
/** Outbox rows examined per tick. Bounded so one tick is always short. */
const DEFAULT_LIMIT = 2000;
/**
 * Sheet rows one change may rewrite inline before the tab is handed to the
 * background job instead. A document edit touches a handful of rows; anything
 * in the thousands is a master-data rename, which is a bulk operation.
 */
const DEFAULT_FANOUT = 200;
/** Cells per batched write request, so one request never becomes enormous. */
const MAX_RANGES_PER_CALL = 500;
/** Hands the event loop back so a long drain cannot stall in-process PGlite. */
const yieldLoop = () => new Promise((r) => setImmediate(r));
export async function drainOutbox(limit = DEFAULT_LIMIT) {
    const cfg = googleDbConfig();
    const idle = {
        status: 'SKIPPED', changes: 0, rowsWritten: 0, rowsUnchanged: 0,
        apiCalls: 0, sheets: [], deferred: [], message: '',
    };
    if (!cfg.configured || !cfg.enabled) {
        return { ...idle, message: cfg.reason ?? 'Google replica sync is disabled.' };
    }
    const apiBefore = apiCallCount();
    // A row that came FROM the sheet is already in the sheet; echoing it back is
    // the first half of a SQL -> Google -> SQL cycle.
    const echoed = await execute(`UPDATE google_db_outbox SET processed_at = now(), last_error = NULL
      WHERE processed_at IS NULL AND source = 'GOOGLE_IMPORT'`);
    if (echoed > 0)
        logger.debug(`Google replica: skipped ${echoed} import-originated change(s).`);
    const queued = await query(`SELECT id, table_name, row_key, operation FROM google_db_outbox
      WHERE processed_at IS NULL ORDER BY enqueued_at LIMIT $1`, [limit]);
    if (queued.length === 0)
        return { ...idle, status: 'SUCCESS', message: 'Nothing pending.' };
    // Coalesce: N edits to one record become one refresh of one sheet row.
    const changedKeys = new Map();
    for (const q of queued) {
        changedKeys.set(q.table_name, (changedKeys.get(q.table_name) ?? new Set()).add(q.row_key));
    }
    // Only tabs that have actually been exported can be updated row-wise; one
    // that has never been written has no header and no index, and belongs to the
    // background export instead.
    const exported = new Set((await query('SELECT sheet_name FROM google_db_state')).map((r) => r.sheet_name));
    const pending = new Map(); // sheet -> key -> row
    const deferred = new Set();
    const failedSheets = new Map();
    for (const view of BUSINESS_VIEWS) {
        const bindings = view.sources.filter((s) => changedKeys.has(s.table));
        if (bindings.length === 0)
            continue;
        if (!exported.has(view.sheet)) {
            deferred.add(view.sheet);
            continue;
        }
        // A stale index would write rows to the wrong place, so repair it first —
        // reading the key column only, not the tab.
        try {
            if (await isDirty(view.sheet))
                await rebuildFromSheet(view);
        }
        catch (err) {
            failedSheets.set(view.sheet, err instanceof Error ? err.message : String(err));
            continue;
        }
        const rows = pending.get(view.sheet) ?? new Map();
        let overflowed = false;
        for (const binding of bindings) {
            const keys = [...changedKeys.get(binding.table)];
            // The guard is against FAN-OUT — one change exploding into many sheet
            // rows — not against volume. A thousand suppliers each changing once
            // legitimately produces a thousand sheet rows, and batching handles that
            // fine; renaming ONE unit-of-measure that 9,000 items reference does not.
            // So the allowance is at least one row per changed record, and the outbox
            // batch size already bounds how many records a tick considers.
            const cap = Math.max(binding.fanoutLimit ?? DEFAULT_FANOUT, keys.length);
            try {
                // cap + 1 detects "too many" without a separate COUNT.
                const affected = await query(buildRestrictedSql(view, binding.restrict, cap + 1), [keys]);
                if (affected.length > cap) {
                    overflowed = true;
                    logger.info(`Google replica: ${keys.length} change(s) to ${binding.table} fan out past ${cap} rows of `
                        + `${view.sheet}; queuing a background resync instead of writing them inline.`);
                    break;
                }
                for (const row of affected) {
                    const key = view.primaryKey.map((p) => String(row[p] ?? '')).join(KEY_SEPARATOR);
                    rows.set(key, { key, cells: cellsOf(view, row) });
                }
            }
            catch (err) {
                failedSheets.set(view.sheet, err instanceof Error ? err.message : String(err));
                overflowed = true;
                break;
            }
            await yieldLoop();
        }
        if (overflowed) {
            rows.clear();
            if (!failedSheets.has(view.sheet))
                deferred.add(view.sheet);
            continue;
        }
        if (rows.size > 0)
            pending.set(view.sheet, rows);
    }
    // A tab whose refresh is too large is resynced by the paced background job.
    if (deferred.size > 0) {
        await queueJob('FULL_EXPORT', [...deferred], undefined, 'queued automatically: a change fanned out beyond the inline limit, or the tab is not exported yet');
    }
    /* ── Build ONE batch of ranges across every tab ───────────────────────── */
    const updates = [];
    const indexWrites = new Map();
    const growth = new Map(); // sheet -> highest row used
    let unchanged = 0;
    for (const [sheet, rows] of pending) {
        const view = viewBySheet(sheet);
        const width = headerOf(view).length;
        const keys = [...rows.keys()];
        const positions = await positionsFor(sheet, keys);
        let append = await nextRowNo(sheet);
        const writes = [];
        for (const row of rows.values()) {
            const digest = digestOf(row.cells);
            const at = positions.get(row.key);
            // Nothing about this record changed on the sheet — send no payload at all.
            if (at && at.digest === digest) {
                unchanged += 1;
                continue;
            }
            const rowNo = at ? at.rowNo : append++;
            updates.push({ range: rowRange(sheet, rowNo, width), values: [row.cells] });
            writes.push({ key: row.key, rowNo, digest });
        }
        if (writes.length > 0) {
            indexWrites.set(sheet, writes);
            growth.set(sheet, Math.max(...writes.map((w) => w.rowNo)));
        }
        await yieldLoop();
    }
    if (updates.length === 0) {
        await markProcessed(queued.map((q) => q.id), failedSheets.size === 0);
        return {
            status: failedSheets.size > 0 ? 'PARTIAL' : 'SUCCESS',
            changes: queued.length, rowsWritten: 0, rowsUnchanged: unchanged,
            apiCalls: apiCallCount() - apiBefore,
            sheets: [], deferred: [...deferred],
            message: unchanged > 0
                ? `${queued.length} change(s) examined; ${unchanged} row(s) were already identical in Google.`
                : `${queued.length} change(s) examined; nothing to write.`,
        };
    }
    /* ── Send it ──────────────────────────────────────────────────────────── */
    try {
        await growGrids(growth);
        // Split only if the batch is genuinely huge; the normal case is one call.
        for (let i = 0; i < updates.length; i += MAX_RANGES_PER_CALL) {
            await batchWrite(updates.slice(i, i + MAX_RANGES_PER_CALL));
        }
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Nothing is recorded as synced, and the outbox rows stay pending, so the
        // next attempt repeats exactly this work. That is what makes a Google
        // outage a delay rather than data loss.
        for (const sheet of pending.keys()) {
            await execute(`UPDATE google_db_state SET sync_status = 'FAILED', last_error = $2, updated_at = now()
          WHERE sheet_name = $1`, [sheet, message.slice(0, 2000)]);
        }
        await execute(`UPDATE google_db_outbox SET attempts = attempts + 1, last_error = $2 WHERE id = ANY($1)`, [queued.map((q) => q.id), message.slice(0, 500)]);
        logger.warn(`Google replica: drain failed (${isTransient(err) ? 'transient' : 'permanent'}) — ${message}`);
        return {
            status: 'FAILED', changes: queued.length, rowsWritten: 0, rowsUnchanged: unchanged,
            apiCalls: apiCallCount() - apiBefore, sheets: [], deferred: [...deferred],
            message,
        };
    }
    // Only now is the sheet known to hold these rows.
    let written = 0;
    for (const [sheet, writes] of indexWrites) {
        await setRows(sheet, writes);
        written += writes.length;
        await execute(`UPDATE google_db_state
          SET last_row_export = now(), last_success_at = now(), sync_status = 'OK',
              last_error = NULL, sheet_row_count = (SELECT COUNT(*)::int FROM google_db_rows WHERE sheet_name = $1),
              updated_at = now()
        WHERE sheet_name = $1`, [sheet]);
    }
    await markProcessed(queued.map((q) => q.id), failedSheets.size === 0);
    const apiCalls = apiCallCount() - apiBefore;
    return {
        status: failedSheets.size > 0 ? 'PARTIAL' : 'SUCCESS',
        changes: queued.length,
        rowsWritten: written,
        rowsUnchanged: unchanged,
        apiCalls,
        sheets: [...indexWrites.keys()],
        deferred: [...deferred],
        message: `${queued.length} change(s) -> ${written} sheet row(s) across ${indexWrites.size} tab(s) `
            + `in ${apiCalls} Google API call(s)`
            + (unchanged > 0 ? `; ${unchanged} row(s) were already identical.` : '.')
            + (deferred.size > 0 ? ` Queued a background resync for: ${[...deferred].join(', ')}.` : ''),
    };
}
/**
 * Grows tabs that an append would otherwise overflow.
 *
 * The grid height is remembered in `google_db_state`, so the usual case costs
 * nothing; Google is asked about tab geometry only when a tab actually needs to
 * get taller, roughly once per thousand appended rows.
 */
async function growGrids(highest) {
    const needing = [];
    for (const [sheet, top] of highest) {
        const [state] = await query('SELECT grid_rows FROM google_db_state WHERE sheet_name = $1', [sheet]);
        if (top > Number(state?.grid_rows ?? 0))
            needing.push(sheet);
    }
    if (needing.length === 0)
        return;
    const tabs = await listTabs();
    for (const sheet of needing) {
        const tab = tabs.find((t) => t.title === sheet);
        if (!tab)
            continue;
        // Grow in blocks, so a steady trickle of new records does not ask Google to
        // resize the grid on every drain.
        const wanted = Math.max(highest.get(sheet) + 500, tab.rowCount);
        await ensureGrid(tab.sheetId, wanted, tab.columnCount, tab);
        await execute('UPDATE google_db_state SET sheet_id = $2, grid_rows = $3, updated_at = now() WHERE sheet_name = $1', [sheet, tab.sheetId, tab.rowCount]);
    }
}
async function markProcessed(ids, all) {
    if (ids.length === 0)
        return;
    await execute('UPDATE google_db_outbox SET processed_at = now(), last_error = NULL WHERE id = ANY($1)', [ids]);
    if (!all)
        return;
    // Drained rows are kept briefly for diagnostics, then pruned; only rows that
    // have already been processed are ever removed.
    await execute(`DELETE FROM google_db_outbox WHERE processed_at IS NOT NULL AND processed_at < now() - interval '7 days'`);
}
/** Exposed for the status endpoint and the tests. */
export function bindingsOf(view) { return view.sources; }
export { FIRST_DATA_ROW };
//# sourceMappingURL=drain.js.map