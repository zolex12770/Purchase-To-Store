/**
 * Automatic backups. Every 10 minutes the scheduler checks whether the newest
 * VERIFIED scheduled backup is older than backup.auto_interval_hours; if so (or
 * if there is none) it takes one and then applies retention. Catch-up rather
 * than clock-time: this PC is not always on overnight, so a backup that fell due
 * while it was off is taken soon after the next start-up.
 */
import { query, queryOne } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { createBackup, applyRetention, isBackupRunning } from './backup-service.js';

const CHECK_MS = 10 * 60 * 1000;
const FIRST_CHECK_MS = 2 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let firstTimer: NodeJS.Timeout | null = null;

export interface BackupScheduleStatus {
  enabled: boolean;
  intervalHours: number;
  lastScheduledAt: string | null;
  nextDueAt: string | null;
  due: boolean;
}

export async function backupScheduleStatus(): Promise<BackupScheduleStatus> {
  const rows = await query<{ key: string; value: unknown }>(
    `SELECT key, value FROM app_settings WHERE key IN ('backup.auto_enabled', 'backup.auto_interval_hours')`,
  );
  const get = (k: string) => rows.find((r) => r.key === k)?.value;
  const enabled = get('backup.auto_enabled') !== false && get('backup.auto_enabled') !== 'false';
  const hours = Number(get('backup.auto_interval_hours'));
  const intervalHours = Number.isFinite(hours) && hours >= 1 ? hours : 12;
  const last = await queryOne<{ created_at: string }>(
    `SELECT created_at FROM backup_metadata WHERE kind = 'SCHEDULED' AND status = 'VERIFIED'
      ORDER BY created_at DESC LIMIT 1`,
  );
  const lastAt = last ? new Date(last.created_at) : null;
  const next = lastAt ? new Date(lastAt.getTime() + intervalHours * 3600_000) : null;
  return {
    enabled,
    intervalHours,
    lastScheduledAt: lastAt ? lastAt.toISOString() : null,
    nextDueAt: next ? next.toISOString() : null,
    due: enabled && (!next || next.getTime() <= Date.now()),
  };
}

export async function runScheduledBackupIfDue(): Promise<'TAKEN' | 'NOT_DUE' | 'SKIPPED'> {
  const status = await backupScheduleStatus();
  if (!status.due) return 'NOT_DUE';
  if (isBackupRunning()) return 'SKIPPED';
  const result = await createBackup({ kind: 'SCHEDULED', notes: `Automatic backup (every ${status.intervalHours} h)`, userId: null });
  if (result.status === 'VERIFIED') await applyRetention();
  return 'TAKEN';
}

async function tick(): Promise<void> {
  try {
    await runScheduledBackupIfDue();
  } catch (err) {
    // A failed automatic backup must never take the server down; it is retried next tick.
    logger.error('Automatic backup failed — will retry', { error: err instanceof Error ? err.message : String(err) });
  }
}

export function startBackupScheduler(): void {
  if (timer) return;
  firstTimer = setTimeout(() => void tick(), FIRST_CHECK_MS);
  firstTimer.unref?.();
  timer = setInterval(() => void tick(), CHECK_MS);
  timer.unref?.();
  logger.info('Backups     : automatic backups on (checks every 10 min; interval and retention in Settings).');
}

export function stopBackupScheduler(): void {
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  timer = null;
  firstTimer = null;
}
