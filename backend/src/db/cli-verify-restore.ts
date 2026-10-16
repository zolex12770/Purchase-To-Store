/**
 * Proves a backup can be restored — without touching the live database.
 *
 *   node dist/db/cli-verify-restore.js <backup file name or path> [--keep]
 *
 * Restores the file into a brand-new temporary database (its own folder under the
 * system temp directory), runs every migration first exactly as a real restore
 * would, then compares each table's row count with the file. The temporary
 * database is deleted afterwards unless --keep is given. Exit code 0 = restorable.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

async function main(): Promise<void> {
  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const keep = process.argv.includes('--keep');
  if (!arg) {
    // eslint-disable-next-line no-console
    console.error('Usage: node dist/db/cli-verify-restore.js <backup file> [--keep]');
    process.exit(1);
  }
  // Resolve the file BEFORE pointing the data root elsewhere: a bare name means the live backups folder.
  const liveBackups = path.join(process.env.ZOLEX_DATA_ROOT?.trim() || path.join(os.homedir(), 'ZolexERP'), 'backups');
  const file = fs.existsSync(arg) ? path.resolve(arg) : path.join(liveBackups, path.basename(arg));
  if (!fs.existsSync(file)) {
    // eslint-disable-next-line no-console
    console.error(`Backup not found: ${file}`);
    process.exit(1);
  }

  // A throwaway data root: the live data folder is never opened.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'zolex-verify-restore-'));
  process.env.ZOLEX_DATA_ROOT = root;
  process.env.NODE_ENV = process.env.NODE_ENV === 'test' ? 'test' : 'development';
  process.env.GOOGLE_SHEETS_SYNC_ENABLED = 'false';

  const { getDatabase, closeDatabase, databaseLabel } = await import('./driver.js');
  const { runMigrations } = await import('./migrate.js');
  const { withTransaction, query } = await import('./index.js');
  const { restoreFromPayload, BACKUP_TABLES } = await import('./restore.js');
  type Payload = import('./restore.js').BackupPayload;

  const started = Date.now();
  let ok = false;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const payload = JSON.parse(raw) as Payload;
    await getDatabase();
    // eslint-disable-next-line no-console
    console.log(`Verifying ${path.basename(file)} (${(raw.length / 1048576).toFixed(1)} MB, taken ${payload.meta?.createdAt ?? '?'}, schema ${payload.meta?.schemaVersion ?? '?'}) in ${databaseLabel()}`);
    await runMigrations({ silent: true });
    const result = await withTransaction((tx) => restoreFromPayload(tx, payload));
    const problems: string[] = [];
    for (const table of BACKUP_TABLES) {
      const expected = Array.isArray(payload.data[table]) ? payload.data[table]!.length : 0;
      const [row] = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`);
      if (Number(row?.n) !== expected) problems.push(`${table}: file ${expected}, restored ${row?.n}`);
    }
    ok = problems.length === 0;
    // eslint-disable-next-line no-console
    console.log(ok
      ? `RESTORABLE — ${result.totalRows} rows across ${BACKUP_TABLES.length} tables restored and counted in ${((Date.now() - started) / 1000).toFixed(1)} s.` +
        (result.notInBackup.length ? ` (File predates: ${result.notInBackup.join(', ')}.)` : '')
      : `NOT RESTORABLE — ${problems.join('; ')}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`NOT RESTORABLE — ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await closeDatabase().catch(() => undefined);
    if (!keep) fs.rmSync(root, { recursive: true, force: true });
  }
  process.exit(ok ? 0 : 2);
}

void main();
