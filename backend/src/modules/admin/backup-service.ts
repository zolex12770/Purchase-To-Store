/**
 * Backup creation, verification and retention — shared by the Admin Backup
 * screen (manual backups) and the backup scheduler (automatic backups).
 *
 * A backup is a JSON dump of every BACKUP_TABLES table written to
 * $ZOLEX_DATA_ROOT/backups, OUTSIDE the repository. After writing, the file is
 * read back and checked — checksum, JSON structure, every table present with
 * the row count that was dumped — before it is recorded as VERIFIED.
 *
 * Retention only ever prunes backups this module created automatically (kind
 * SCHEDULED, file name zolex-auto-backup-*): manual backups, pre-restore /
 * pre-reconcile copies and older files are never touched. A scheduled backup is
 * pruned only when it is older than backup.retention_days AND outside the newest
 * backup.retention_count scheduled backups — and the newest one is always kept.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { query, queryOne, withTransaction, txQuery } from '../../db/index.js';
import { paths } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { audit, auditIn, SYSTEM_ACTOR, type AuditActor } from '../../core/audit.js';
import { BACKUP_TABLES, collectBackupData, type BackupPayload } from '../../db/restore.js';

export type BackupKind = 'MANUAL' | 'SCHEDULED';

export interface BackupResult {
  id: number | undefined;
  filename: string;
  sizeBytes: number;
  checksum: string;
  tableCounts: Record<string, number>;
  totalRows: number;
  status: 'VERIFIED' | 'CORRUPT';
  location: string;
}

export function backupPath(filename: string): string {
  // Defend against traversal: only a bare filename inside the backup directory.
  return path.join(paths.backups, path.basename(filename));
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Re-reads a written backup and proves it is restorable as far as a file can:
 * the checksum matches, it parses, and every backup table is present with the
 * row count recorded when it was taken. Returns the problems found (none = OK).
 */
export function verifyBackupFile(filename: string, expected: { checksum: string; counts: Record<string, number> }): string[] {
  const problems: string[] = [];
  const filePath = backupPath(filename);
  if (!fs.existsSync(filePath)) return [`${filename} is missing.`];
  const raw = fs.readFileSync(filePath, 'utf8');
  if (sha256(raw) !== expected.checksum) problems.push('checksum differs from the one recorded when it was written');
  let payload: BackupPayload | null = null;
  try {
    payload = JSON.parse(raw) as BackupPayload;
  } catch {
    problems.push('the file is not valid JSON');
  }
  if (payload) {
    for (const table of BACKUP_TABLES) {
      const rows = payload.data?.[table];
      if (!Array.isArray(rows)) problems.push(`table ${table} is missing`);
      else if (rows.length !== (expected.counts[table] ?? 0)) problems.push(`table ${table} has ${rows.length} rows, ${expected.counts[table]} were dumped`);
    }
  }
  return problems;
}

let running = false;

export function isBackupRunning(): boolean {
  return running;
}

/** Takes, writes, verifies and records one backup. */
export async function createBackup(opts: {
  kind: BackupKind;
  notes: string;
  userId: number | null;
  actor?: AuditActor;
}): Promise<BackupResult> {
  if (running) throw new Error('A backup is already being written. Please try again in a minute.');
  running = true;
  try {
    const schemaRow = await queryOne<{ version: string }>(
      'SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1',
    );
    const { data, counts } = await collectBackupData((sql) => query(sql));
    const payload: BackupPayload = {
      meta: {
        product: 'ZOLEX Purchase-to-Store ERP',
        version: '1.0.0',
        createdAt: new Date().toISOString(),
        schemaVersion: schemaRow?.version ?? 'unknown',
        tableCounts: counts,
      },
      data,
    };
    const json = JSON.stringify(payload, null, 0);
    const checksum = sha256(json);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${opts.kind === 'SCHEDULED' ? 'zolex-auto-backup' : 'zolex-backup'}-${stamp}.json`;
    const filePath = backupPath(filename);
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.writeFileSync(filePath, json, 'utf8');
    const size = fs.statSync(filePath).size;

    const problems = verifyBackupFile(filename, { checksum, counts });
    const status = problems.length === 0 ? 'VERIFIED' : 'CORRUPT';
    const totalRows = Object.values(counts).reduce((a, b) => a + b, 0);
    const actor = opts.actor ?? SYSTEM_ACTOR;

    const created = await withTransaction(async (tx) => {
      const row = await txQuery<{ id: number }>(
        tx,
        `INSERT INTO backup_metadata
           (filename, file_path, kind, status, size_bytes, checksum_sha256,
            table_counts, schema_version, notes, created_by, verified_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10, now())
         RETURNING id`,
        [filename, filePath, opts.kind, status, size, checksum, JSON.stringify(counts),
         schemaRow?.version ?? '', opts.notes, opts.userId],
      );
      await auditIn(tx, {
        actor, action: 'BACKUP', entity: 'backup', entityId: row[0]?.id, entityLabel: filename,
        after: { filename, kind: opts.kind, status, sizeBytes: size, checksum, totalRows, problems },
        message: status === 'VERIFIED'
          ? `${opts.kind === 'SCHEDULED' ? 'Automatic' : 'Manual'} backup ${filename} written and verified (${totalRows} rows, ${BACKUP_TABLES.length} tables).`
          : `Backup ${filename} FAILED verification: ${problems.join('; ')}`,
      });
      return row[0];
    });

    if (status === 'VERIFIED') logger.info(`Backup created: ${filename} (${(size / 1024 / 1024).toFixed(1)} MB, ${totalRows} rows)`);
    else logger.error(`Backup ${filename} failed verification`, { problems });
    return { id: created?.id, filename, sizeBytes: size, checksum, tableCounts: counts, totalRows, status, location: paths.backups };
  } finally {
    running = false;
  }
}

async function numberSetting(key: string, fallback: number): Promise<number> {
  const row = await queryOne<{ value: unknown }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  const n = Number(row?.value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface RetentionResult {
  policy: { retentionDays: number; retentionCount: number };
  scheduledBackups: number;
  pruned: string[];
}

/**
 * Prunes SCHEDULED backups older than backup.retention_days that are not among
 * the newest backup.retention_count scheduled backups. Never touches any other
 * backup. dryRun lists what would be pruned.
 */
export async function applyRetention(opts: { dryRun?: boolean; actor?: AuditActor } = {}): Promise<RetentionResult> {
  const retentionDays = await numberSetting('backup.retention_days', 30);
  const retentionCount = Math.max(1, await numberSetting('backup.retention_count', 50));
  const scheduled = await query<{ id: number; filename: string; created_at: string; age_days: number }>(
    `SELECT id, filename, created_at, EXTRACT(EPOCH FROM (now() - created_at)) / 86400 AS age_days
       FROM backup_metadata
      WHERE kind = 'SCHEDULED' AND status <> 'DELETED' AND filename LIKE 'zolex-auto-backup-%'
      ORDER BY created_at DESC, id DESC`,
  );
  const prunable = scheduled.filter((b, i) => i >= retentionCount && Number(b.age_days) > retentionDays);
  const result: RetentionResult = { policy: { retentionDays, retentionCount }, scheduledBackups: scheduled.length, pruned: [] };
  if (opts.dryRun) {
    result.pruned = prunable.map((b) => b.filename);
    return result;
  }
  for (const b of prunable) {
    const filePath = backupPath(b.filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    await query(`UPDATE backup_metadata SET status = 'DELETED' WHERE id = $1`, [b.id]);
    result.pruned.push(b.filename);
  }
  if (result.pruned.length > 0) {
    await audit({
      actor: opts.actor ?? SYSTEM_ACTOR, action: 'DELETE', entity: 'backup',
      entityLabel: `retention: ${result.pruned.length} automatic backup(s)`,
      after: { pruned: result.pruned, policy: result.policy },
      message: `Backup retention removed ${result.pruned.length} automatic backup(s) older than ${retentionDays} days beyond the newest ${retentionCount}.`,
    });
  }
  return result;
}
