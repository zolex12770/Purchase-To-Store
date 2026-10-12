/**
 * Google Sheets Live Sync API (SRS §8).
 *
 * Backs the header toggle, the manual "Sync now" action, sync history, and the
 * conflict log an administrator resolves.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam,
} from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { actorFrom, audit } from '../../core/audit.js';
import {
  isSyncEnabled, setSyncEnabled, syncConfig, runSync, isSyncRunning,
} from './engine.js';

const router = Router();

/* ── GET /google-sync/status — drives the header toggle ─────────────────────── */

router.get(
  '/status',
  requirePermission('sync.view'),
  asyncHandler(async (_req, res) => {
    const cfg = syncConfig();
    const enabled = await isSyncEnabled();

    const lastJob = await queryOne<Record<string, unknown>>(
      `SELECT j.id, j.status, j.trigger_source, j.started_at, j.finished_at, j.duration_ms,
              j.sheets_processed, j.rows_read, j.rows_inserted, j.rows_updated,
              j.rows_skipped, j.rows_rejected, j.conflicts, j.message, j.detail,
              u.employee_name AS actor_name
         FROM google_sync_jobs j
         LEFT JOIN users u ON u.id = j.actor_user_id
        ORDER BY j.started_at DESC LIMIT 1`,
    );

    const unresolved = await queryOne<{ n: string; conflicts: string }>(
      `SELECT COUNT(*) AS n,
              COUNT(*) FILTER (WHERE severity = 'CONFLICT') AS conflicts
         FROM google_sync_errors WHERE resolved_at IS NULL`,
    );

    const mappings = await query(
      `SELECT sheet_name, target_entity, is_enabled, sync_order, notes
         FROM google_sheet_mappings ORDER BY sync_order, sheet_name`,
    );

    sendOk(res, {
      enabled,
      running: isSyncRunning(),
      configured: cfg.configured,
      mode: cfg.mode,
      sheetId: cfg.sheetId,
      // Shown verbatim in the UI when credentials are missing, so the state is
      // explained rather than mysterious.
      notConfiguredReason: cfg.reason ?? null,
      lastJob,
      unresolvedIssues: Number(unresolved?.n ?? 0),
      unresolvedConflicts: Number(unresolved?.conflicts ?? 0),
      mappings,
      systemOfRecord: 'SQL',
      note:
        'Google Sheets is a one-way source into SQL. Approved and posted documents are never ' +
        'overwritten by a sheet; divergences are recorded as conflicts for review.',
    });
  }),
);

/* ── POST /google-sync/toggle ───────────────────────────────────────────────── */

router.post(
  '/toggle',
  requirePermission('sync.admin'),
  validateBody(z.object({ enabled: z.boolean() })),
  asyncHandler(async (req, res) => {
    const { enabled } = req.body as { enabled: boolean };
    await setSyncEnabled(enabled, actorFrom(req));
    const cfg = syncConfig();

    sendOk(res, {
      enabled,
      configured: cfg.configured,
      message: enabled
        ? cfg.configured
          ? 'Live Sync is ON. Sheets will be synchronised on the configured interval and on demand.'
          : 'Live Sync is ON, but no Google credentials are configured yet, so no data will be pulled.'
        : 'Live Sync is OFF. The ERP continues to operate normally from its own database.',
    });
  }),
);

/* ── POST /google-sync/run ──────────────────────────────────────────────────── */

router.post(
  '/run',
  requirePermission('sync.admin'),
  validateBody(z.object({
    sheets: z.array(z.string()).optional(),
    dryRun: z.boolean().default(false),
  })),
  asyncHandler(async (req, res) => {
    const { sheets, dryRun } = req.body as { sheets?: string[]; dryRun: boolean };
    const result = await runSync({
      trigger: 'MANUAL', actor: actorFrom(req), sheets, dryRun,
    });
    sendOk(res, result);
  }),
);

/* ── GET /google-sync/jobs ──────────────────────────────────────────────────── */

router.get(
  '/jobs',
  requirePermission('sync.view'),
  validateQuery(listQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listQuerySchema>>(res);
    const total = await queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM google_sync_jobs');
    const rows = await query(
      `SELECT j.id, j.status, j.trigger_source, j.started_at, j.finished_at, j.duration_ms,
              j.sheets_processed, j.rows_read, j.rows_inserted, j.rows_updated,
              j.rows_skipped, j.rows_rejected, j.conflicts, j.message,
              u.employee_name AS actor_name
         FROM google_sync_jobs j
         LEFT JOIN users u ON u.id = j.actor_user_id
        ORDER BY j.started_at DESC
        LIMIT $1 OFFSET $2`,
      [q.pageSize, offsetOf(q)],
    );
    sendPage(res, rows, Number(total?.n ?? 0), q.page, q.pageSize);
  }),
);

router.get(
  '/jobs/:id',
  requirePermission('sync.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const job = await queryOne('SELECT * FROM google_sync_jobs WHERE id = $1', [id]);
    if (!job) throw NotFoundError('Sync job');
    const errors = await query(
      `SELECT id, sheet_name, row_number, column_name, business_key, severity,
              error_code, error_message, raw_value, existing_value, incoming_value,
              resolved_at, resolution, created_at
         FROM google_sync_errors WHERE job_id = $1
        ORDER BY severity, sheet_name, row_number`,
      [id],
    );
    sendOk(res, { ...job, errors });
  }),
);

/* ── GET /google-sync/issues — the conflict/validation log ──────────────────── */

const issueSchema = listQuerySchema.extend({
  severity: z.enum(['ERROR', 'WARNING', 'CONFLICT']).optional(),
  resolved: z.enum(['true', 'false']).default('false'),
  sheet: z.string().trim().max(80).optional(),
});

router.get(
  '/issues',
  requirePermission('sync.view'),
  validateQuery(issueSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof issueSchema>>(res);
    const params: unknown[] = [];
    const conditions: string[] = [];

    conditions.push(q.resolved === 'true' ? 'e.resolved_at IS NOT NULL' : 'e.resolved_at IS NULL');
    if (q.severity) { params.push(q.severity); conditions.push(`e.severity = $${params.length}`); }
    if (q.sheet) { params.push(q.sheet); conditions.push(`e.sheet_name = $${params.length}`); }
    if (q.search) {
      params.push(`%${q.search.toLowerCase()}%`);
      conditions.push(`(lower(e.error_message) LIKE $${params.length} OR lower(COALESCE(e.business_key,'')) LIKE $${params.length})`);
    }
    const where = `WHERE ${conditions.join(' AND ')}`;

    const total = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM google_sync_errors e ${where}`, params,
    );
    params.push(q.pageSize, offsetOf(q));

    const rows = await query(
      `SELECT e.*, u.employee_name AS resolved_by_name
         FROM google_sync_errors e
         LEFT JOIN users u ON u.id = e.resolved_by
         ${where}
        ORDER BY e.created_at DESC, e.id DESC
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );

    sendPage(res, rows, Number(total?.n ?? 0), q.page, q.pageSize);
  }),
);

/* ── POST /google-sync/issues/:id/resolve ───────────────────────────────────── */

router.post(
  '/issues/:id/resolve',
  requirePermission('sync.admin'),
  validateBody(z.object({ resolution: z.string().trim().min(1, 'Describe how this was resolved.').max(500) })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { resolution } = req.body as { resolution: string };

    const issue = await queryOne<{ business_key: string | null; error_message: string }>(
      'SELECT business_key, error_message FROM google_sync_errors WHERE id = $1', [id],
    );
    if (!issue) throw NotFoundError('Sync issue');

    await query(
      'UPDATE google_sync_errors SET resolved_at = now(), resolved_by = $2, resolution = $3 WHERE id = $1',
      [id, req.user!.id, resolution],
    );
    await audit({
      actor: actorFrom(req), action: 'SYNC', entity: 'google_sync_error', entityId: id,
      entityLabel: issue.business_key ?? `Issue #${id}`,
      message: `Sync issue marked resolved: ${resolution}`,
    });

    sendOk(res, { resolved: true, message: 'Issue marked as resolved.' });
  }),
);

export default router;
