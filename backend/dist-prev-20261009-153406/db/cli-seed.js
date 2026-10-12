/**
 * CLI: seed the database. `npm run seed` / `npm run seed:demo`
 */
import { ensureStorageDirs } from '../config/env.js';
import { runMigrations } from './migrate.js';
import { seedSystem, seedDemoData } from './seed.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { logger } from '../core/logger.js';
async function main() {
    ensureStorageDirs();
    logger.info(`Database: ${databaseLabel()}`);
    await runMigrations();
    await seedSystem();
    if (process.argv.includes('--demo')) {
        await seedDemoData();
    }
    await closeDatabase();
}
main().catch(async (err) => {
    logger.error('Seed failed', { error: err instanceof Error ? err.message : String(err) });
    console.error(err);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cli-seed.js.map