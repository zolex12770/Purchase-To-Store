import { ensureStorageDirs, env } from '../config/env.js';
import { runMigrations } from './migrate.js';
import { seedSystem, seedDemoData } from './seed.js';
import { getDatabase, closeDatabase, databaseLabel } from './driver.js';
import { probeDatabase, removeDataDirectory } from './probe.js';
import { logger } from '../core/logger.js';
async function main() {
    if (env.isProd) {
        // eslint-disable-next-line no-console
        console.error('\n[zolex] db:reset is disabled in production.\n');
        process.exit(1);
    }
    ensureStorageDirs();
    logger.warn(`Resetting database: ${databaseLabel()}`);
    let recreatedDirectory = false;
    // Probe OUT OF PROCESS first: a failed open in this process would leave file
    // handles that stop us replacing the directory (see db/probe.ts).
    if (env.DB_DRIVER === 'pglite') {
        const probe = probeDatabase();
        if (probe.exists && !probe.opens) {
            logger.warn('  · existing database cannot be opened; recreating the data directory');
            logger.warn(`    (${probe.error ?? 'unknown error'})`);
            removeDataDirectory();
            recreatedDirectory = true;
            logger.info('  · fresh data directory created');
        }
    }
    const db = await getDatabase();
    if (!recreatedDirectory) {
        // Drop everything in the public schema, including views, in dependency order.
        await db.query('DROP SCHEMA public CASCADE');
        await db.query('CREATE SCHEMA public');
        logger.info('  · schema dropped and recreated');
    }
    await runMigrations();
    await seedSystem();
    // `--clean` is accepted as a synonym for `--no-demo`: it reads better for the
    // thing people actually want, which is "give me an empty production database".
    const wantsCleanDatabase = process.argv.includes('--no-demo') || process.argv.includes('--clean');
    if (wantsCleanDatabase) {
        // Without this marker the very next `npm run dev` would seed demo data
        // straight back in, because SEED_DEMO_DATA defaults to true outside
        // production. Setting it makes "clean" actually stay clean.
        await db.query(`INSERT INTO app_settings (key, value, description)
       VALUES ('data.purified_at', to_jsonb(now()::text),
               'Database created clean for production. While present, demo seeding is refused.')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
        logger.info('  · marked as a clean production database (demo seeding disabled)');
    }
    else {
        await seedDemoData();
    }
    logger.info(recreatedDirectory
        ? 'Reset complete — the damaged data directory was rebuilt from scratch.'
        : 'Reset complete.');
    await closeDatabase();
}
main().catch(async (err) => {
    logger.error('Reset failed', { error: err instanceof Error ? err.message : String(err) });
    // eslint-disable-next-line no-console
    console.error(err);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cli-reset.js.map