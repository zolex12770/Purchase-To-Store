/**
 * CLI: apply pending migrations. `npm run migrate`
 *
 * With `--check` it reports what WOULD be applied and changes nothing, so a
 * deploy pipeline can decide whether a release carries a schema change before
 * it takes traffic down. Exit code 1 means "there is work to do", which makes
 * it usable directly in a conditional.
 */
import { ensureStorageDirs } from '../config/env.js';
import { runMigrations, pendingMigrations } from './migrate.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { logger } from '../core/logger.js';

async function main(): Promise<void> {
  ensureStorageDirs();
  logger.info(`Database: ${databaseLabel()}`);

  if (process.argv.includes('--check')) {
    const { pending, applied, changed } = await pendingMigrations();

    if (changed.length > 0) {
      logger.error(
        `${changed.length} applied migration(s) have been EDITED since they ran: ${changed.join(', ')}. ` +
        'Add a new migration instead of editing an applied one.',
      );
      await closeDatabase();
      process.exit(2);
    }

    if (pending.length === 0) {
      logger.info(`Schema is up to date (${applied.length} migration(s) applied).`);
      await closeDatabase();
      process.exit(0);
    }

    logger.info(`${pending.length} migration(s) pending: ${pending.join(', ')}`);
    await closeDatabase();
    process.exit(1);
  }

  const { applied, skipped } = await runMigrations();
  if (applied.length === 0) {
    logger.info(`Schema is up to date (${skipped.length} migration(s) already applied).`);
  } else {
    logger.info(`Applied ${applied.length} migration(s): ${applied.join(', ')}`);
  }
  await closeDatabase();
}

main().catch(async (err) => {
  logger.error('Migration failed', { error: err instanceof Error ? err.message : String(err) });
  // eslint-disable-next-line no-console
  console.error(err);
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
