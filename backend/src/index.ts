/**
 * Server entry point.
 *
 * Boot order matters: storage directories → database → migrations → system seed →
 * background jobs → listen. The server never starts serving traffic against an
 * un-migrated database.
 */
import { env, ensureStorageDirs, paths } from './config/env.js';
import { logger } from './core/logger.js';
import { createApp } from './app.js';
import { getDatabase, closeDatabase, databaseLabel } from './db/index.js';
import { runMigrations } from './db/migrate.js';
import { seedSystem, seedDemoData } from './db/seed.js';
import { startSyncScheduler, stopSyncScheduler } from './modules/google-sync/scheduler.js';
import { startReplicaScheduler, stopReplicaScheduler } from './modules/google-db/scheduler.js';

const BANNER = `
  ███████╗ ██████╗ ██╗     ███████╗██╗  ██╗
  ╚══███╔╝██╔═══██╗██║     ██╔════╝╚██╗██╔╝
    ███╔╝ ██║   ██║██║     █████╗   ╚███╔╝
   ███╔╝  ██║   ██║██║     ██╔══╝   ██╔██╗
  ███████╗╚██████╔╝███████╗███████╗██╔╝ ██╗
  ╚══════╝ ╚═════╝ ╚══════╝╚══════╝╚═╝  ╚═╝
  Purchase-to-Store Enterprise ERP · Zeeta Electrical Engineering Pvt. Ltd.
`;

async function bootstrap(): Promise<void> {
  // eslint-disable-next-line no-console
  console.log(BANNER);

  ensureStorageDirs();
  logger.info(`Storage root : ${paths.root}`);
  logger.info(`Database     : ${databaseLabel()}`);

  await getDatabase();

  const { applied } = await runMigrations({ silent: true });
  logger.info(
    applied.length > 0
      ? `Migrations   : applied ${applied.length} (${applied.join(', ')})`
      : 'Migrations   : up to date',
  );

  await seedSystem();
  if (env.SEED_DEMO_DATA && !env.isProd) {
    await seedDemoData();
  }

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info(`API ready    : http://localhost:${env.PORT}/api/v1`);
    logger.info(`Health       : http://localhost:${env.PORT}/api/v1/health`);
    logger.info(`Frontend     : ${env.FRONTEND_URL}`);
    if (!env.isProd) {
      logger.warn('Bootstrap credentials 10221 / 10422 with password Admin@12345 require rotation at first sign-in.');
    }
  });

  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      logger.error(`Port ${env.PORT} is already in use. Set PORT in backend/.env to a free port.`);
      process.exit(1);
    }
    throw err;
  });

  await startSyncScheduler();
  startReplicaScheduler();

  /* ── Graceful shutdown ─────────────────────────────────────────────────── */
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received — shutting down.`);
    stopSyncScheduler();
  stopReplicaScheduler();
    server.close(() => logger.info('HTTP server closed.'));
    // Let in-flight requests drain before the database goes away.
    setTimeout(() => {
      void closeDatabase()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    }, 400);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // Windows delivers no POSIX signals, so a process manager's stop is a hard
  // kill there — exactly the unclean exit the embedded database tolerates
  // worst. PM2 can instead ask politely over IPC (`shutdown_with_message: true`
  // in the ecosystem file); honouring that message makes a clean stop possible.
  process.on('message', (msg) => {
    if (msg === 'shutdown') void shutdown('shutdown message');
  });

  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
  process.on('uncaughtException', (err) => {
    logger.error('Uncaught exception — terminating', { error: err.message, stack: err.stack });
    process.exit(1);
  });
}

bootstrap().catch((err) => {
  logger.error('Fatal startup error', { error: err instanceof Error ? err.message : String(err) });
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
