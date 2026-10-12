/**
 * Sync scheduler (SRS §8, ADR-007).
 *
 * The interval poll is armed only while the header toggle is ON and credentials
 * are configured. The toggle lives in `app_settings`, so it survives a restart and
 * is global rather than per-browser.
 */
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { isSyncEnabled, syncConfig, runSync, isSyncRunning } from './engine.js';

let timer: NodeJS.Timeout | null = null;

async function tick(): Promise<void> {
  try {
    if (!(await isSyncEnabled())) return;
    if (!syncConfig().configured) return;
    if (isSyncRunning()) return;

    await runSync({ trigger: 'SCHEDULED' });
  } catch (err) {
    // A scheduled sync failure must never take the server down.
    logger.warn('Scheduled Google sync failed', {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function startSyncScheduler(): Promise<void> {
  if (timer) return;

  const cfg = syncConfig();
  const enabled = await isSyncEnabled().catch(() => false);

  if (!cfg.configured) {
    logger.info('Google sync : not configured (the ERP runs normally from SQL).');
    return;
  }

  const minutes = Math.max(1, env.GOOGLE_SYNC_INTERVAL_MINUTES);
  timer = setInterval(() => void tick(), minutes * 60 * 1000);
  // Do not hold the event loop open on shutdown.
  timer.unref?.();

  logger.info(
    `Google sync : credentials present (${cfg.mode}); polling every ${minutes} min while the toggle is ON ` +
    `(currently ${enabled ? 'ON' : 'OFF'}).`,
  );
}

export function stopSyncScheduler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
