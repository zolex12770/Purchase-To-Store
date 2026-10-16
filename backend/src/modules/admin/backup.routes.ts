/**
 * Backup & Recovery (SRS §23; ADR-011).
 *
 * Backups are written to $ZOLEX_DATA_ROOT/backups — OUTSIDE the repository — as a
 * timestamped JSON dump with a SHA-256 checksum, so integrity can be verified
 * before a restore is ever attempted. Restore is transactional, permission-gated
 * and audited.
 */
import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { query, queryOne, withTransaction, txQuery } from '../../db/index.js';
import { asyncHandler, sendOk, sendCreated, validateBody, idParam } from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ConflictError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { auditIn, audit, actorFrom } from '../../core/audit.js';
import { paths } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { restoreFromPayload, type BackupPayload } from '../../db/restore.js';
import { createBackup, applyRetention, isBackupRunning, backupPath, sha256 } from './backup-service.js';
import { backupScheduleStatus } from './backup-scheduler.js';
import exportRoutes from './export.routes.js';
import dataAuditRoutes from './data-audit.routes.js';

const router = Router();

// Portable, read-only exports (MySQL / Excel / Google Sheets archive) into the
// project-local DATABASE/ folder — see export.routes.ts for why this is a
// separate mechanism from the operational JSON backup below.
router.use('/export', exportRoutes);

// Demo/test data classification + purge — runs in-process against the live
// database (no downtime), see data-audit.routes.ts.
router.use('/data-audit', dataAuditRoutes);

/* ── GET /backup ────────────────────────────────────────────────────────────── */

router.get(
  '/',
  requirePermission('backup.view'),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT b.id, b.filename, b.kind, b.status, b.size_bytes, b.checksum_sha256,
              b.table_counts, b.schema_version, b.notes, b.created_at,
              b.verified_at, b.restored_at,
              u.employee_name AS created_by_name
         FROM backup_metadata b
         LEFT JOIN users u ON u.id = b.created_by
        ORDER BY b.created_at DESC`,
    );
    // Report whether the file is actually still on disk — metadata alone is not proof.
    const withPresence = rows.map((r) => ({
      ...r,
      fileExists: fs.existsSync(backupPath(String(r.filename))),
    }));
    sendOk(res, withPresence, { location: paths.backups });
  }),
);

/* ── POST /backup ───────────────────────────────────────────────────────────── */

router.post(
  '/',
  requirePermission('backup.create'),
  validateBody(z.object({ notes: z.string().trim().max(500).default('') })),
  asyncHandler(async (req, res) => {
    const { notes } = req.body as { notes: string };
    let result;
    try {
      result = await createBackup({ kind: 'MANUAL', notes, userId: req.user!.id, actor: actorFrom(req) });
    } catch (err) {
      if (isBackupRunning()) throw ConflictError((err as Error).message);
      throw err;
    }
    if (result.status !== 'VERIFIED') {
      throw ConflictError(`The backup ${result.filename} was written but failed verification — do not rely on it. Try again.`);
    }
    sendCreated(res, {
      ...result,
      message: `Backup created and verified outside the project folder at ${paths.backups}.`,
    });
  }),
);

/* ── GET /backup/schedule — automatic backups and retention ─────────────────── */

router.get(
  '/schedule',
  requirePermission('backup.view'),
  asyncHandler(async (_req, res) => {
    const status = await backupScheduleStatus();
    const retention = await applyRetention({ dryRun: true });
    const kinds = await query<{ kind: string; status: string; n: number; bytes: string }>(
      `SELECT kind, status, COUNT(*)::int AS n, COALESCE(SUM(size_bytes), 0)::text AS bytes
         FROM backup_metadata GROUP BY kind, status ORDER BY kind, status`,
    );
    sendOk(res, { ...status, retention, byKind: kinds, running: isBackupRunning() });
  }),
);

/* ── POST /backup/retention — apply the retention policy now (or preview) ───── */

router.post(
  '/retention',
  requirePermission('backup.admin'),
  validateBody(z.object({ dryRun: z.boolean().default(true) })),
  asyncHandler(async (req, res) => {
    const { dryRun } = req.body as { dryRun: boolean };
    sendOk(res, await applyRetention({ dryRun, actor: actorFrom(req) }));
  }),
);

/* ── POST /backup/:id/verify ────────────────────────────────────────────────── */

router.post(
  '/:id/verify',
  requirePermission('backup.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const meta = await queryOne<{ filename: string; checksum_sha256: string }>(
      'SELECT filename, checksum_sha256 FROM backup_metadata WHERE id = $1', [id],
    );
    if (!meta) throw NotFoundError('Backup');

    const filePath = backupPath(meta.filename);
    if (!fs.existsSync(filePath)) {
      await query("UPDATE backup_metadata SET status = 'DELETED' WHERE id = $1", [id]);
      throw NotFoundError(`Backup file ${meta.filename}`);
    }

    const actual = sha256(fs.readFileSync(filePath, 'utf8'));
    const valid = actual === meta.checksum_sha256;

    await query(
      `UPDATE backup_metadata SET status = $2, verified_at = now() WHERE id = $1`,
      [id, valid ? 'VERIFIED' : 'CORRUPT'],
    );

    sendOk(res, {
      valid,
      expectedChecksum: meta.checksum_sha256,
      actualChecksum: actual,
      message: valid
        ? 'Backup integrity verified — the file matches its recorded checksum.'
        : 'INTEGRITY FAILURE — this backup file has changed since it was created and must not be restored.',
    });
  }),
);

/* ── GET /backup/:id/download ───────────────────────────────────────────────── */

router.get(
  '/:id/download',
  requirePermission('backup.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const meta = await queryOne<{ filename: string }>(
      'SELECT filename FROM backup_metadata WHERE id = $1', [id],
    );
    if (!meta) throw NotFoundError('Backup');

    const filePath = backupPath(meta.filename);
    if (!fs.existsSync(filePath)) throw NotFoundError(`Backup file ${meta.filename}`);

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: 'backup', entityId: id,
      entityLabel: meta.filename, message: 'Backup downloaded',
    });

    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', `attachment; filename="${meta.filename}"`);
    fs.createReadStream(filePath).pipe(res);
  }),
);

/* ── POST /backup/:id/restore ───────────────────────────────────────────────── */

router.post(
  '/:id/restore',
  requirePermission('backup.admin'),
  validateBody(z.object({
    // A destructive, irreversible operation deserves an explicit confirmation
    // rather than a single click (SRS §36).
    confirm: z.literal('RESTORE', {
      errorMap: () => ({ message: 'Type RESTORE to confirm this irreversible operation.' }),
    }),
  })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const meta = await queryOne<{ filename: string; checksum_sha256: string; status: string }>(
      'SELECT filename, checksum_sha256, status FROM backup_metadata WHERE id = $1', [id],
    );
    if (!meta) throw NotFoundError('Backup');

    const filePath = backupPath(meta.filename);
    if (!fs.existsSync(filePath)) throw NotFoundError(`Backup file ${meta.filename}`);

    const raw = fs.readFileSync(filePath, 'utf8');
    if (sha256(raw) !== meta.checksum_sha256) {
      await query("UPDATE backup_metadata SET status = 'CORRUPT' WHERE id = $1", [id]);
      throw ConflictError(
        'This backup file no longer matches its checksum and will not be restored. ' +
        'Restoring a modified backup risks corrupting the database.',
      );
    }

    let payload: BackupPayload;
    try {
      payload = JSON.parse(raw) as BackupPayload;
    } catch {
      throw ConflictError('The backup file is not valid JSON and cannot be restored.');
    }
    if (!payload.data || typeof payload.data !== 'object') {
      throw ConflictError('The backup file does not contain a recognisable data section.');
    }

    const actorSnapshot = actorFrom(req);

    // The whole restore is ONE transaction: either the database ends up exactly as
    // the backup described, or it is left completely untouched. The restore itself
    // lives in db/restore.ts and is shared with the `db:restore` CLI.
    const result = await withTransaction(async (tx) => {
      const r = await restoreFromPayload(tx, payload);

      await tx.query(
        `UPDATE backup_metadata SET restored_at = now(), restored_by = $2 WHERE id = $1`,
        [id, actorSnapshot.userId],
      );
      await auditIn(tx, {
        actor: actorSnapshot, action: 'RESTORE_BACKUP', entity: 'backup', entityId: id,
        entityLabel: meta.filename,
        after: { restored: r.restored, totalRows: r.totalRows },
        message: `Database restored from ${meta.filename}`,
      });
      return r;
    });

    logger.warn(`Database restored from backup ${meta.filename}`);

    sendOk(res, {
      restored: result.restored,
      totalRows: result.totalRows,
      notInBackup: result.notInBackup,
      message:
        `Database restored from ${meta.filename}. All users have been signed out — ` +
        `sign in again to continue.` +
        (result.notInBackup.length > 0
          ? ` This backup predates ${result.notInBackup.join(', ')}; those tables are now empty` +
            (result.notInBackup.some((t) => t.startsWith('inventory_'))
              ? ' — run the inventory sync to reload stock from the Google Sheets.'
              : '.')
          : ''),
    });
  }),
);

/* ── DELETE /backup/:id ─────────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('backup.admin'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const meta = await queryOne<{ filename: string }>(
      'SELECT filename FROM backup_metadata WHERE id = $1', [id],
    );
    if (!meta) throw NotFoundError('Backup');

    const filePath = backupPath(meta.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

    await withTransaction(async (tx) => {
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'backup', entityId: id,
        entityLabel: meta.filename, message: 'Backup deleted',
      });
      await tx.query('DELETE FROM backup_metadata WHERE id = $1', [id]);
    });

    sendOk(res, { deleted: true, message: `Backup ${meta.filename} has been deleted.` });
  }),
);

export default router;
