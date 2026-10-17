/**
 * Google Sheets business-replica API.
 *
 * Every route here is an explicit administrator action — nothing on this
 * surface is called by a business transaction, which is what keeps the ERP
 * fully functional with the replica off, unconfigured or unreachable.
 *
 * Two rules shape this file:
 *
 *  • NO route does long Google work inline. Export, index rebuild and
 *    reconciliation are QUEUED and the handler returns immediately; the
 *    scheduler advances them in slices. Previously `POST /export` awaited a
 *    16,000-row export inside the request, holding the connection open and — on
 *    in-process PGlite — stalling every other user for the duration.
 *
 *  • NO route returns sheet data. Status is counts, timestamps and per-tab
 *    state. The browser must never receive the replica's contents.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { asyncHandler, sendOk, validateBody } from '../../core/http.js';
import { requirePermission } from '../../auth/middleware.js';
import { actorFrom } from '../../core/audit.js';
import {
  replicaStatus, requestFullExport, jobHistory, writeControlSheets, writeErrorSheet,
} from './replica.js';
import { drainOutbox } from './drain.js';
import { queueJob, cancelActiveJob } from './jobs.js';
import { planImport, commitImport } from './import.js';

const router = Router();

const sheetsBody = z.object({ sheets: z.array(z.string().trim().min(1)).optional() });

/* ── GET /google-db/status — small, and answers with Google unreachable ─────── */

router.get(
  '/status',
  requirePermission('sync.view'),
  asyncHandler(async (_req, res) => sendOk(res, await replicaStatus())),
);

/* ── GET /google-db/jobs — background job history ───────────────────────────── */

router.get(
  '/jobs',
  requirePermission('sync.view'),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 20) || 20, 100);
    sendOk(res, await jobHistory(limit));
  }),
);

/* ── GET /google-db/errors — the dead-letter queue, paginated ───────────────── */

router.get(
  '/errors',
  requirePermission('sync.view'),
  asyncHandler(async (req, res) => {
    const pageSize = Math.min(Number(req.query.pageSize ?? 50) || 50, 200);
    const page = Math.max(Number(req.query.page ?? 1) || 1, 1);
    const [total] = await query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM google_db_outbox
        WHERE processed_at IS NULL AND last_error IS NOT NULL`,
    );
    const rows = await query(
      `SELECT id, table_name, row_key, operation, attempts, last_error, enqueued_at
         FROM google_db_outbox
        WHERE processed_at IS NULL AND last_error IS NOT NULL
        ORDER BY enqueued_at DESC
        LIMIT $1 OFFSET $2`,
      [pageSize, (page - 1) * pageSize],
    );
    sendOk(res, { rows, page, pageSize, total: Number(total?.n ?? 0) });
  }),
);

/* ── POST /google-db/export — QUEUE a full copy; returns at once ────────────── */

router.post(
  '/export',
  requirePermission('sync.admin'),
  validateBody(sheetsBody.extend({
    /** Remove tabs left behind by the previous 27-tab layout. */
    pruneLegacy: z.boolean().default(false),
  })),
  asyncHandler(async (req, res) => {
    const { sheets, pruneLegacy } = req.body as { sheets?: string[]; pruneLegacy: boolean };
    const result = await requestFullExport({
      actorUserId: actorFrom(req).userId ?? undefined, sheets, pruneLegacy,
    });
    sendOk(res, {
      ...result,
      message: result.queued
        ? 'Full export queued. It runs in the background in slices; the ERP is unaffected. '
          + 'Watch progress on GET /google-db/status.'
        : (result.reason ?? 'The Google replica is not configured.'),
    });
  }),
);

/* ── POST /google-db/rebuild-index / reconcile — also queued ────────────────── */

router.post(
  '/rebuild-index',
  requirePermission('sync.admin'),
  validateBody(sheetsBody),
  asyncHandler(async (req, res) => {
    const { sheets } = req.body as z.infer<typeof sheetsBody>;
    const job = await queueJob('REBUILD_INDEX', sheets ?? [], actorFrom(req).userId ?? undefined,
      'row index rebuilt on request');
    sendOk(res, { job, message: 'Row-index rebuild queued.' });
  }),
);

router.post(
  '/reconcile',
  // Queues a background job that reads the whole replica, like the export and
  // rebuild above — an administrator action, not something a viewer starts.
  requirePermission('sync.admin'),
  validateBody(sheetsBody),
  asyncHandler(async (req, res) => {
    const { sheets } = req.body as z.infer<typeof sheetsBody>;
    const job = await queueJob('RECONCILE', sheets ?? [], actorFrom(req).userId ?? undefined,
      'SQL vs Google comparison requested');
    sendOk(res, {
      job,
      message: 'Reconciliation queued. The result appears on the job record when it finishes.',
    });
  }),
);

router.post(
  '/cancel-job',
  requirePermission('sync.admin'),
  asyncHandler(async (_req, res) => {
    sendOk(res, { cancelled: await cancelActiveJob() });
  }),
);

/* ── POST /google-db/drain — push queued changes now ────────────────────────── */

router.post(
  '/drain',
  requirePermission('sync.admin'),
  validateBody(z.object({
    // Bounded so a manual drain cannot become the long inline operation this
    // redesign exists to remove.
    limit: z.coerce.number().int().min(1).max(2000).default(500),
  })),
  asyncHandler(async (req, res) => {
    const { limit } = req.body as { limit: number };
    sendOk(res, await drainOutbox(limit));
  }),
);

/* ── POST /google-db/control-sheets — refresh the __ tabs ───────────────────── */

router.post(
  '/control-sheets',
  requirePermission('sync.admin'),
  asyncHandler(async (_req, res) => {
    await writeControlSheets();
    await writeErrorSheet();
    sendOk(res, { message: 'Control tabs refreshed.' });
  }),
);

/* ── Google -> SQL import: preview, then commit ─────────────────────────────── */

router.post(
  '/import/preview',
  requirePermission('sync.admin'),
  validateBody(sheetsBody),
  asyncHandler(async (req, res) => {
    const { sheets } = req.body as z.infer<typeof sheetsBody>;
    const plan = await planImport(sheets);
    // The per-row plan can be very large; return counts plus only the rows a
    // human has to act on.
    sendOk(res, {
      totals: plan.totals,
      message: plan.message,
      sheets: plan.sheets.map((s) => ({
        sheet: s.sheet, rowsRead: s.rowsRead,
        insert: s.insert, update: s.update, unchanged: s.unchanged,
        conflict: s.conflict, invalid: s.invalid, error: s.error,
        needsAttention: s.rows
          .filter((r) => r.action === 'CONFLICT' || r.action === 'INVALID')
          .slice(0, 100)
          .map((r) => ({ sheetRow: r.sheetRow, table: r.table, rowKey: r.rowKey, action: r.action, reason: r.reason })),
      })),
    });
  }),
);

router.post(
  '/import/commit',
  requirePermission('sync.admin'),
  validateBody(sheetsBody.extend({
    // A historical import writes to the primary database — it asks for the same
    // deliberate confirmation the backup restore does.
    confirm: z.literal('IMPORT', {
      errorMap: () => ({ message: 'Type IMPORT to confirm writing sheet data into the database.' }),
    }),
  })),
  asyncHandler(async (req, res) => {
    const { sheets } = req.body as { sheets?: string[] };
    const plan = await planImport(sheets);
    const result = await commitImport(plan, actorFrom(req));
    sendOk(res, { ...result, totals: plan.totals });
  }),
);

router.get(
  '/imports',
  requirePermission('sync.view'),
  asyncHandler(async (_req, res) => {
    sendOk(res, await query(
      `SELECT i.*, u.employee_name AS actor_name
         FROM google_db_imports i
         LEFT JOIN users u ON u.id = i.actor_user_id
        ORDER BY i.started_at DESC LIMIT 50`,
    ));
  }),
);

export default router;
