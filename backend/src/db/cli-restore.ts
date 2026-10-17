/**
 * CLI: restore the database from a backup file. `npm run db:restore -- <filename>`
 *
 * This is the offline counterpart to the Backup & Restore admin screen, and the
 * recovery path the driver points to when the data directory is unopenable —
 * at that moment the API cannot help, because the API needs the database.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureStorageDirs, env, paths } from '../config/env.js';
import { runMigrations } from './migrate.js';
import { getDatabase, closeDatabase, databaseLabel } from './driver.js';
import { withTransaction } from './index.js';
import { probeDatabase, removeDataDirectory } from './probe.js';
import { restoreFromPayload, type BackupPayload } from './restore.js';
import { analyseDatabase } from './statistics.js';
import { logger } from '../core/logger.js';

function listBackups(): string[] {
  if (!fs.existsSync(paths.backups)) return [];
  return fs.readdirSync(paths.backups).filter((f) => f.endsWith('.json')).sort().reverse();
}

async function main(): Promise<void> {
  if (env.isProd && !process.argv.includes('--force')) {
    // eslint-disable-next-line no-console
    console.error('\n[zolex] Restoring in production requires --force.\n');
    process.exit(1);
  }

  ensureStorageDirs();

  const arg = process.argv.slice(2).find((a) => !a.startsWith('--'));
  const available = listBackups();

  if (!arg) {
    // eslint-disable-next-line no-console
    console.log(
      `\nUsage: npm run db:restore -- <filename>\n\n` +
        `Backups in ${paths.backups}:\n` +
        (available.length === 0 ? '  (none found)\n' : `${available.map((f) => `  ${f}`).join('\n')}\n`),
    );
    process.exit(available.length === 0 ? 1 : 0);
  }

  const filename = path.basename(arg);
  const filePath = path.join(paths.backups, filename);
  if (!fs.existsSync(filePath)) {
    // eslint-disable-next-line no-console
    console.error(`\n[zolex] Backup not found: ${filePath}\n`);
    process.exit(1);
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const checksum = crypto.createHash('sha256').update(raw).digest('hex');

  let payload: BackupPayload;
  try {
    payload = JSON.parse(raw) as BackupPayload;
  } catch {
    // eslint-disable-next-line no-console
    console.error('\n[zolex] That backup file is not valid JSON and cannot be restored.\n');
    process.exit(1);
    return;
  }
  if (!payload.data || typeof payload.data !== 'object') {
    // eslint-disable-next-line no-console
    console.error('\n[zolex] That file has no recognisable data section.\n');
    process.exit(1);
  }

  logger.info(`Database : ${databaseLabel()}`);
  logger.info(`Backup   : ${filename}`);
  logger.info(`Taken    : ${payload.meta?.createdAt ?? 'unknown'}`);
  logger.info(`Checksum : ${checksum.slice(0, 32)}…`);

  // Probe OUT OF PROCESS first: a failed open in this process would leave file
  // handles that stop us replacing the directory (see db/probe.ts).
  if (env.DB_DRIVER === 'pglite') {
    const probe = probeDatabase();
    if (probe.exists && !probe.opens) {
      logger.warn('Existing data directory is unopenable — rebuilding it before the restore.');
      logger.warn(`  (${probe.error ?? 'unknown error'})`);
      removeDataDirectory();
      logger.info('  · fresh data directory created');
    }
  }

  await getDatabase();
  await runMigrations({ silent: true });

  const result = await withTransaction(async (tx) => {
    const r = await restoreFromPayload(tx, payload);
    await tx.query(
      `INSERT INTO audit_logs (actor_employee_id, actor_name, action, entity, entity_label, source, message)
       VALUES ('SYSTEM','System','RESTORE_BACKUP','backup',$1,'SYSTEM',$2)`,
      [filename, `Database restored from ${filename} via the command line.`],
    );
    return r;
  });

  logger.info(
    `Restore complete — ${result.totalRows} row(s) across ${Object.keys(result.restored).length} table(s).`,
  );
  // The restored rows have no planner statistics until analysed (statistics.ts).
  await analyseDatabase(`restore of ${filename}`);
  if (result.notInBackup.length > 0) {
    logger.warn(`This backup predates ${result.notInBackup.join(', ')} — those tables are now empty.`);
  }
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error('Restore failed', { error: err instanceof Error ? err.message : String(err) });
  // eslint-disable-next-line no-console
  console.error(err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
