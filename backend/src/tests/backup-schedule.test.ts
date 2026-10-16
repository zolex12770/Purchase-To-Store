/**
 * Integration tests — automatic backups, verification and retention (2026-10-16).
 *
 *   1. Every backup is read back and verified (checksum, JSON, every table and
 *      its row count) before it is recorded as VERIFIED; a tampered file fails.
 *   2. The scheduler takes a backup when none is newer than the interval, and
 *      not again until the interval has passed.
 *   3. Retention prunes ONLY automatic backups that are both older than
 *      backup.retention_days and outside the newest backup.retention_count —
 *      never manual backups, never files it did not create.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let query: Q;
let closeDb: () => Promise<void>;
let svc: typeof import('../modules/admin/backup-service.js');
let sched: typeof import('../modules/admin/backup-scheduler.js');
let backupsDir = '';

beforeAll(async () => {
  const { ensureStorageDirs, paths } = await import('../config/env.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');
  const { getDatabase, closeDatabase } = await import('../db/driver.js');
  const db = await import('../db/index.js');
  ensureStorageDirs();
  const conn = await getDatabase();
  closeDb = closeDatabase;
  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  query = db.query as Q;
  svc = await import('../modules/admin/backup-service.js');
  sched = await import('../modules/admin/backup-scheduler.js');
  backupsDir = paths.backups;
});

afterAll(async () => {
  await closeDb?.();
});

describe('backups are verified before they are trusted', () => {
  it('a manual backup holds every backup table and is recorded VERIFIED', async () => {
    const { BACKUP_TABLES } = await import('../db/restore.js');
    const r = await svc.createBackup({ kind: 'MANUAL', notes: 'test', userId: null });
    expect(r.status).toBe('VERIFIED');
    const payload = JSON.parse(fs.readFileSync(path.join(backupsDir, r.filename), 'utf8'));
    for (const t of BACKUP_TABLES) expect(Array.isArray(payload.data[t])).toBe(true);
    const meta = await query<{ kind: string; status: string }>('SELECT kind, status FROM backup_metadata WHERE id = $1', [r.id]);
    expect(meta[0]).toMatchObject({ kind: 'MANUAL', status: 'VERIFIED' });
  });

  it('verification catches a file changed after it was written', async () => {
    const r = await svc.createBackup({ kind: 'MANUAL', notes: 'tamper', userId: null });
    const file = path.join(backupsDir, r.filename);
    const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(payload.data.permissions.length).toBeGreaterThan(0);
    payload.data.permissions = [];
    fs.writeFileSync(file, JSON.stringify(payload));
    const problems = svc.verifyBackupFile(r.filename, { checksum: r.checksum, counts: r.tableCounts });
    expect(problems.some((p) => /checksum/.test(p))).toBe(true);
    expect(problems.some((p) => /permissions has 0 rows/.test(p))).toBe(true);
  });
});

describe('automatic backups', () => {
  it('takes a backup when none is recent, then waits for the interval', async () => {
    expect((await sched.backupScheduleStatus()).due).toBe(true);
    expect(await sched.runScheduledBackupIfDue()).toBe('TAKEN');
    const s = await sched.backupScheduleStatus();
    expect(s.due).toBe(false);
    expect(s.lastScheduledAt).not.toBeNull();
    expect(await sched.runScheduledBackupIfDue()).toBe('NOT_DUE');
    const rows = await query<{ filename: string; kind: string }>(`SELECT filename, kind FROM backup_metadata WHERE kind = 'SCHEDULED'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.filename).toMatch(/^zolex-auto-backup-/);
  });

  it('can be switched off in settings', async () => {
    await query(`UPDATE app_settings SET value = 'false'::jsonb WHERE key = 'backup.auto_enabled'`);
    await query(`UPDATE backup_metadata SET created_at = now() - interval '2 days' WHERE kind = 'SCHEDULED'`);
    expect((await sched.backupScheduleStatus()).due).toBe(false);
    await query(`UPDATE app_settings SET value = 'true'::jsonb WHERE key = 'backup.auto_enabled'`);
    expect((await sched.backupScheduleStatus()).due).toBe(true);
  });
});

describe('retention', () => {
  it('prunes only old automatic backups beyond the newest N — never manual ones', async () => {
    await query(`UPDATE app_settings SET value = '2'::jsonb WHERE key = 'backup.retention_count'`);
    await query(`UPDATE app_settings SET value = '30'::jsonb WHERE key = 'backup.retention_days'`);
    const make = async (kind: 'MANUAL' | 'SCHEDULED', ageDays: number, name: string) => {
      fs.writeFileSync(path.join(backupsDir, name), '{}');
      await query(
        `INSERT INTO backup_metadata (filename, file_path, kind, status, size_bytes, checksum_sha256, table_counts, schema_version, notes, created_at)
         VALUES ($1, $2, $3, 'VERIFIED', 2, 'x', '{}'::jsonb, '', 'fixture', now() - ($4 || ' days')::interval)`,
        [name, path.join(backupsDir, name), kind, String(ageDays)],
      );
    };
    await make('SCHEDULED', 1, 'zolex-auto-backup-r1.json');
    await make('SCHEDULED', 40, 'zolex-auto-backup-r40.json');
    await make('SCHEDULED', 50, 'zolex-auto-backup-r50.json');
    await make('SCHEDULED', 60, 'zolex-auto-backup-r60.json');
    await make('MANUAL', 90, 'zolex-backup-m90.json');
    const preview = await svc.applyRetention({ dryRun: true });
    // Newest 2 scheduled kept (the real one from the scheduler test + r1); r40 is 3rd newest but must also be > 30 days.
    expect(preview.pruned.sort()).toEqual(['zolex-auto-backup-r40.json', 'zolex-auto-backup-r50.json', 'zolex-auto-backup-r60.json']);
    expect(fs.existsSync(path.join(backupsDir, 'zolex-auto-backup-r60.json'))).toBe(true);
    const done = await svc.applyRetention();
    expect(done.pruned).toHaveLength(3);
    expect(fs.existsSync(path.join(backupsDir, 'zolex-auto-backup-r60.json'))).toBe(false);
    expect(fs.existsSync(path.join(backupsDir, 'zolex-backup-m90.json'))).toBe(true);
    expect(fs.existsSync(path.join(backupsDir, 'zolex-auto-backup-r1.json'))).toBe(true);
    const st = await query<{ filename: string; status: string }>(`SELECT filename, status FROM backup_metadata WHERE notes = 'fixture' ORDER BY filename`);
    expect(st.map((x) => [x.filename, x.status])).toEqual([
      ['zolex-auto-backup-r1.json', 'VERIFIED'], ['zolex-auto-backup-r40.json', 'DELETED'],
      ['zolex-auto-backup-r50.json', 'DELETED'], ['zolex-auto-backup-r60.json', 'DELETED'], ['zolex-backup-m90.json', 'VERIFIED'],
    ]);
    // Running it again changes nothing.
    expect((await svc.applyRetention()).pruned).toEqual([]);
  });
});
