/**
 * The replica worker.
 *
 * Three properties, each of which was missing before and each of which was
 * measured to matter on the live system:
 *
 *  1. RE-ENTRANCY. The previous tick guarded only against a full export, never
 *     against another drain. A drain that ran longer than 60 seconds was joined
 *     by the next one, and the next — all reading the same un-processed outbox
 *     rows and redoing the same work. Backend latency was measured stalling
 *     5-20 s every 60 s until the process died. One tick runs at a time, full
 *     stop.
 *
 *  2. BACKOFF AT THE SCHEDULER, NOT INSIDE THE CALL. Retrying a per-minute
 *     quota by sleeping inside the request parked the worker for minutes. Now a
 *     failure just ends the tick and pushes `next_attempt_at` out
 *     exponentially — 1, 2, 4 ... up to 30 minutes — so a Google outage costs
 *     nothing and recovers on its own.
 *
 *  3. WORK IS SLICED. A tick drains a bounded batch of changes and advances any
 *     background job by one time-boxed slice. It never holds the event loop for
 *     long, which matters because PGlite runs IN-PROCESS: a long query here is
 *     a stalled HTTP request for every user.
 *
 * If Google is unreachable the ERP is entirely unaffected — changes accumulate
 * in the outbox and drain when it returns.
 */
import { query, execute } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { googleDbConfig, isTransient } from './client.js';
import { drainOutbox } from './drain.js';
import { runJobSlice, activeJob, failActiveJob } from './jobs.js';
let timer = null;
/** How often the worker wakes. Actual work is gated by `next_attempt_at`. */
const TICK_MS = 60_000;
const BACKOFF_BASE_MS = 60_000;
const BACKOFF_MAX_MS = 30 * 60_000;
/** After this many consecutive failures a job is retired instead of resumed. */
const JOB_GIVE_UP_AFTER = 10;
/** The re-entrancy guard. */
let ticking = false;
async function due() {
    const [row] = await query('SELECT (next_attempt_at <= now()) AS due FROM google_db_health WHERE id = 1');
    return row?.due ?? true;
}
async function recordSuccess() {
    await execute(`UPDATE google_db_health
        SET consecutive_failures = 0, next_attempt_at = now(), last_attempt_at = now(),
            last_success_at = now(), reachable = TRUE, last_error = NULL, updated_at = now()
      WHERE id = 1`);
}
async function recordFailure(err) {
    const message = err instanceof Error ? err.message : String(err);
    const [row] = await query(`UPDATE google_db_health
        SET consecutive_failures = consecutive_failures + 1,
            last_attempt_at = now(),
            reachable = FALSE,
            last_error = $1,
            next_attempt_at = now() + (LEAST($2 * POWER(2, LEAST(consecutive_failures, 5)), $3)
                                       * INTERVAL '1 millisecond'),
            updated_at = now()
      WHERE id = 1
      RETURNING consecutive_failures`, [message.slice(0, 2000), BACKOFF_BASE_MS, BACKOFF_MAX_MS]);
    const failures = Number(row?.consecutive_failures ?? 1);
    const waitMin = Math.round(Math.min(BACKOFF_BASE_MS * 2 ** Math.min(failures - 1, 5), BACKOFF_MAX_MS) / 60_000);
    logger.warn(`Google replica: ${isTransient(err) ? 'unreachable' : 'failed'} (attempt ${failures}) — `
        + `next attempt in about ${waitMin} minute(s). The ERP is unaffected; changes stay queued. ${message}`);
    return failures;
}
async function tick() {
    if (ticking) {
        logger.debug('Google replica: previous tick still running — skipping this one.');
        return;
    }
    ticking = true;
    try {
        const cfg = googleDbConfig();
        if (!cfg.configured || !cfg.enabled)
            return;
        if (!(await due()))
            return;
        // A background job (full export, index rebuild, reconcile) takes priority:
        // until the tabs exist there is nothing for a row-level drain to update.
        if (await activeJob()) {
            const slice = await runJobSlice();
            if (slice.ran)
                logger.debug(`Google replica: ${slice.message}`);
            await recordSuccess();
            return;
        }
        const result = await drainOutbox();
        if (result.status === 'FAILED') {
            await recordFailure(new Error(result.message));
            return;
        }
        if (result.rowsWritten > 0 || result.deferred.length > 0) {
            logger.info(`Google replica: ${result.message}`);
        }
        await recordSuccess();
    }
    catch (err) {
        const failures = await recordFailure(err).catch(() => 0);
        // A job that cannot make progress after many attempts is retired rather
        // than retried forever; the outbox is untouched, so nothing is lost and an
        // administrator can queue a fresh export.
        if (failures >= JOB_GIVE_UP_AFTER && (await activeJob())) {
            await failActiveJob(`gave up after ${failures} consecutive failures`).catch(() => { });
            logger.warn('Google replica: retired the background job after repeated failures.');
        }
    }
    finally {
        ticking = false;
    }
}
export function startReplicaScheduler() {
    if (timer)
        return;
    const cfg = googleDbConfig();
    if (!cfg.configured) {
        logger.info(`Google replica: inactive — ${cfg.reason}`);
        return;
    }
    if (!cfg.enabled) {
        logger.info('Google replica: configured but GOOGLE_SHEETS_SYNC_ENABLED=false — nothing will be pushed.');
        return;
    }
    timer = setInterval(() => void tick(), TICK_MS);
    timer.unref?.();
    logger.info(`Google replica: mirroring to spreadsheet ${cfg.spreadsheetId}; `
        + `checking every ${TICK_MS / 1000}s. Startup is not blocked and no export runs on this thread.`);
}
export function stopReplicaScheduler() {
    if (timer) {
        clearInterval(timer);
        timer = null;
    }
}
/** Exposed so tests can drive one tick deterministically. */
export async function runOneTick() { await tick(); }
//# sourceMappingURL=scheduler.js.map