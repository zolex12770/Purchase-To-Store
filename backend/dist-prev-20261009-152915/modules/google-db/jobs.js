/**
 * Background work for the Google replica: full export, index rebuild, reconcile.
 *
 * The rule this module exists to enforce is that NO long Google operation ever
 * runs inside an HTTP request, a login, a page load, or server startup. An
 * export of 16,000 rows — or 100,000 — is a queued job with a resumable cursor,
 * advanced a slice at a time by the scheduler.
 *
 * Two properties make that safe on this stack:
 *
 *  • A slice is bounded by wall-clock budget AND page size, so the ERP's own
 *    requests are never behind a long database read. PGlite runs in-process, so
 *    "one big query" is not a neutral choice — it is a stall for every user.
 *
 *  • The cursor lives in the database, so a restart, a crash or a Google outage
 *    resumes where it stopped instead of starting the export again.
 *
 * A full export writes CONTIGUOUS blocks of rows, so a page of 1,000 records is
 * one API call rather than a thousand.
 */
import { query, queryOne, execute } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BUSINESS_VIEWS, viewBySheet } from './views/index.js';
import { buildPagedSql, buildCountSql } from './views/types.js';
import { KEY_SEPARATOR } from './schema.js';
import { cellsOf, headerOf } from './render.js';
import { digestOf, setRows, resetSheet, markClean, FIRST_DATA_ROW } from './rowindex.js';
import { googleDbConfig, ensureTabs, ensureGrid, batchWrite, clearTab, sheetRange, columnLetter, apiCallCount, } from './client.js';
/** Rows fetched, rendered and written per API call during a full export. */
const PAGE = 1000;
/** Wall-clock budget for one slice. Keeps the ERP's own latency unaffected. */
const SLICE_MS = 8_000;
const yieldLoop = () => new Promise((r) => setImmediate(r));
/**
 * Queues a job, or returns the one already in flight.
 *
 * Only one job may be active at a time — enforced by a partial unique index, so
 * two concurrent requests cannot both start a 100,000-row export.
 */
export async function queueJob(kind, sheets = [], actorUserId, message) {
    const existing = await activeJob();
    if (existing) {
        // Fold the newly requested tabs into the running job rather than refusing:
        // a drain that defers two tabs while an export is running should still get
        // those tabs exported.
        const merged = [...new Set([...existing.sheets, ...sheets])];
        if (merged.length !== existing.sheets.length) {
            await execute('UPDATE google_db_jobs SET sheets = $2 WHERE id = $1', [existing.id, merged]);
            existing.sheets = merged;
        }
        return existing;
    }
    const row = await queryOne(`INSERT INTO google_db_jobs (kind, sheets, actor_user_id, message)
     VALUES ($1, $2, $3, $4) RETURNING *`, [kind, sheets, actorUserId ?? null, message ?? null]);
    logger.info(`Google replica: queued ${kind}${sheets.length ? ` for ${sheets.join(', ')}` : ' (all tabs)'}.`);
    return row;
}
export async function activeJob() {
    return queryOne(`SELECT * FROM google_db_jobs WHERE status IN ('QUEUED','RUNNING') ORDER BY id LIMIT 1`);
}
export async function recentJobs(limit = 20) {
    return query('SELECT * FROM google_db_jobs ORDER BY id DESC LIMIT $1', [limit]);
}
export async function cancelActiveJob() {
    const n = await execute(`UPDATE google_db_jobs SET status = 'CANCELLED', finished_at = now(),
            message = COALESCE(message, '') || ' (cancelled)'
      WHERE status IN ('QUEUED','RUNNING')`);
    return n > 0;
}
/**
 * Advances the active job by at most one slice.
 *
 * Returns promptly in every case, including "there is nothing to do" and
 * "Google is unreachable" — the scheduler decides when to call again, so a
 * failure here costs one tick, not a parked worker.
 */
export async function runJobSlice(budgetMs = SLICE_MS) {
    const idle = { ran: false, rowsWritten: 0, apiCalls: 0, message: 'No job queued.' };
    const cfg = googleDbConfig();
    if (!cfg.configured || !cfg.enabled)
        return { ...idle, message: cfg.reason ?? 'Replica disabled.' };
    const job = await activeJob();
    if (!job)
        return idle;
    const apiBefore = apiCallCount();
    if (job.status === 'QUEUED') {
        await execute(`UPDATE google_db_jobs SET status = 'RUNNING', started_at = COALESCE(started_at, now()) WHERE id = $1`, [job.id]);
        job.status = 'RUNNING';
    }
    try {
        const result = job.kind === 'FULL_EXPORT'
            ? await exportSlice(job, budgetMs)
            : job.kind === 'REBUILD_INDEX'
                ? await rebuildSlice(job)
                : await reconcileSlice(job);
        const apiCalls = apiCallCount() - apiBefore;
        await execute('UPDATE google_db_jobs SET api_calls = api_calls + $2 WHERE id = $1', [job.id, apiCalls]);
        return { ...result, jobId: job.id, kind: job.kind, apiCalls };
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // The job stays RUNNING with its cursor intact so the next tick resumes it;
        // only a repeated failure retires it, which the scheduler's backoff paces.
        await execute(`UPDATE google_db_jobs SET message = $2 WHERE id = $1`, [job.id, message.slice(0, 2000)]);
        logger.warn(`Google replica: ${job.kind} slice failed — ${message}`);
        throw err;
    }
}
/** Retires a job that has failed too many times to be worth resuming. */
export async function failActiveJob(reason) {
    await execute(`UPDATE google_db_jobs SET status = 'FAILED', finished_at = now(), message = $1
      WHERE status IN ('QUEUED','RUNNING')`, [reason.slice(0, 2000)]);
}
/* ── FULL_EXPORT ────────────────────────────────────────────────────────────── */
function sheetsOf(job) {
    return job.sheets.length > 0
        ? BUSINESS_VIEWS.filter((v) => job.sheets.includes(v.sheet))
        : BUSINESS_VIEWS;
}
async function exportSlice(job, budgetMs) {
    const views = sheetsOf(job);
    if (views.length === 0) {
        await finish(job.id, 'Nothing to export — no matching tab.');
        return { ran: true, status: 'DONE', rowsWritten: 0, apiCalls: 0, message: 'No matching tab.' };
    }
    // Tabs are created once, up front, in a single batch.
    const widest = Math.max(...views.map((v) => v.columns.length));
    const tabs = await ensureTabs(views.map((v) => v.sheet), widest + 2);
    const startedAt = Date.now();
    // A cursor that names a tab no longer in the job restarts from the beginning
    // rather than carrying its offset onto an unrelated tab.
    const resumeAt = job.cursor_sheet ? views.findIndex((v) => v.sheet === job.cursor_sheet) : -1;
    let index = resumeAt < 0 ? 0 : resumeAt;
    let offset = resumeAt < 0 ? 0 : job.cursor_offset;
    let written = 0;
    while (index < views.length) {
        const view = views[index];
        const header = headerOf(view);
        const tab = tabs.find((t) => t.title === view.sheet);
        if (!tab) {
            index += 1;
            offset = 0;
            continue;
        }
        if (offset === 0) {
            await startSheet(view.sheet, header, tab, view.primaryKey.join(','));
        }
        const rows = await query(buildPagedSql(view, PAGE, offset));
        await yieldLoop();
        if (rows.length > 0) {
            const first = FIRST_DATA_ROW + offset;
            const last = first + rows.length - 1;
            await ensureGrid(tab.sheetId, last + 1, header.length, tab);
            // A contiguous block is ONE range, so a 1,000-row page is one API call.
            const values = rows.map((r) => cellsOf(view, r));
            await batchWrite([{
                    range: sheetRange(view.sheet, `A${first}:${columnLetter(header.length - 1)}${last}`),
                    values,
                }]);
            await setRows(view.sheet, rows.map((r, i) => ({
                key: view.primaryKey.map((p) => String(r[p] ?? '')).join(KEY_SEPARATOR),
                rowNo: first + i,
                digest: digestOf(values[i]),
            })));
            written += rows.length;
            offset += rows.length;
        }
        if (rows.length < PAGE) {
            await completeSheet(view.sheet, offset, tab);
            index += 1;
            offset = 0;
        }
        await execute(`UPDATE google_db_jobs SET cursor_sheet = $2, cursor_offset = $3, done_rows = done_rows + $4
        WHERE id = $1`, [job.id, views[index]?.sheet ?? null, offset, rows.length]);
        await yieldLoop();
        if (Date.now() - startedAt >= budgetMs) {
            return {
                ran: true, status: 'RUNNING', sheet: view.sheet, rowsWritten: written, apiCalls: 0,
                message: `Exported ${written} row(s) this slice; resuming at ${views[index]?.sheet ?? 'end'}+${offset}.`,
            };
        }
    }
    // An export covering EVERY tab has just written the current state of all of
    // them, so a change queued before it started is already reflected. Leaving
    // those queued makes the next drain grind through a backlog that can only
    // conclude "identical" — 6,482 such rows survived the previous rebuild.
    //
    // Only a full-coverage export may do this. After a PARTIAL export, a queued
    // `items` change still legitimately owes a refresh to the Purchase Indent and
    // GRN tabs that were not written, so its queue entry has to stand. Changes
    // queued DURING the export are also left alone: one may have landed after its
    // own tab was already written.
    if (views.length === BUSINESS_VIEWS.length) {
        const superseded = await execute(`UPDATE google_db_outbox
          SET processed_at = now(), last_error = NULL
        WHERE processed_at IS NULL
          AND enqueued_at <= COALESCE($1::timestamptz, now())`, [job.started_at]);
        if (superseded > 0) {
            logger.info(`Google replica: ${superseded} queued change(s) superseded by the full export.`);
        }
    }
    await finish(job.id, `Exported ${job.done_rows + written} row(s) across ${views.length} tab(s).`);
    return {
        ran: true, status: 'DONE', rowsWritten: written, apiCalls: 0,
        message: `Full export complete: ${views.length} tab(s).`,
    };
}
/** Clears a tab and writes its header — the only place a tab is ever emptied. */
async function startSheet(sheet, header, tab, pk) {
    await clearTab(sheet);
    await batchWrite([{ range: sheetRange(sheet, `A1:${columnLetter(header.length - 1)}1`), values: [header] }]);
    await resetSheet(sheet);
    await execute(`INSERT INTO google_db_state (table_name, sheet_name, primary_key, sync_status, index_dirty,
                                  sheet_id, grid_rows, updated_at)
     VALUES ($1, $1, $2, 'RUNNING', FALSE, $3, $4, now())
     ON CONFLICT (table_name) DO UPDATE
       SET primary_key = EXCLUDED.primary_key, sync_status = 'RUNNING', index_dirty = FALSE,
           sheet_id = EXCLUDED.sheet_id, grid_rows = EXCLUDED.grid_rows, updated_at = now()`, [sheet, pk, tab.sheetId, tab.rowCount]);
}
async function completeSheet(sheet, rows, tab) {
    await markClean(sheet);
    await execute(`UPDATE google_db_state
        SET last_full_export = now(), last_success_at = now(), sync_status = 'OK', last_error = NULL,
            sql_row_count = $2, sheet_row_count = $2, grid_rows = $3, sheet_id = $4, updated_at = now()
      WHERE sheet_name = $1`, [sheet, rows, tab.rowCount, tab.sheetId]);
    logger.info(`Google replica: ${sheet} exported (${rows} row(s)).`);
}
async function finish(id, message) {
    await execute(`UPDATE google_db_jobs SET status = 'DONE', finished_at = now(), cursor_sheet = NULL,
            cursor_offset = 0, message = $2 WHERE id = $1`, [id, message]);
    logger.info(`Google replica: ${message}`);
}
/* ── REBUILD_INDEX ──────────────────────────────────────────────────────────── */
async function rebuildSlice(job) {
    const { rebuildFromSheet } = await import('./rowindex.js');
    const views = sheetsOf(job);
    for (const view of views) {
        await rebuildFromSheet(view);
        await yieldLoop();
    }
    await finish(job.id, `Rebuilt the row index for ${views.length} tab(s).`);
    return { ran: true, status: 'DONE', rowsWritten: 0, apiCalls: 0, message: 'Index rebuilt.' };
}
/* ── RECONCILE ──────────────────────────────────────────────────────────────── */
async function reconcileSlice(job) {
    const { reconcileSheets } = await import('./reconcile.js');
    const views = sheetsOf(job);
    const report = await reconcileSheets(views.map((v) => v.sheet));
    await execute('UPDATE google_db_jobs SET detail = $2 WHERE id = $1', [job.id, JSON.stringify(report)]);
    await finish(job.id, `Reconciled ${report.sheets.length} tab(s): ${report.totals.match} matching, `
        + `${report.totals.mismatch} mismatched, ${report.totals.missingInGoogle} missing, `
        + `${report.totals.extraInGoogle} extra.`);
    return { ran: true, status: 'DONE', rowsWritten: 0, apiCalls: 0, message: 'Reconciliation complete.' };
}
/** Row counts the ERP expects each tab to hold — used for progress reporting. */
export async function expectedRowCounts(sheets) {
    const out = {};
    for (const view of BUSINESS_VIEWS) {
        if (sheets && !sheets.includes(view.sheet))
            continue;
        const [row] = await query(buildCountSql(view));
        out[view.sheet] = Number(row?.n ?? 0);
    }
    return out;
}
export { viewBySheet };
//# sourceMappingURL=jobs.js.map