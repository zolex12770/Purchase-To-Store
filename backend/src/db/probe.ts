/**
 * Out-of-process database openability probe.
 *
 * Repair tooling has to answer "can this data directory be opened?" WITHOUT
 * opening it itself: on Windows a failed embedded-engine open leaves file handles
 * behind, and the directory then cannot be deleted or replaced by that same
 * process. Probing in a disposable child keeps the repairing process clean.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { paths } from '../config/env.js';

export interface ProbeResult {
  exists: boolean;
  opens: boolean;
  error?: string;
}

const PROBE_SOURCE = `
  import('@electric-sql/pglite')
    .then(async ({ PGlite }) => {
      const db = new PGlite(process.argv[1]);
      await db.waitReady;
      await db.query('select 1');
      await db.close();
      process.exit(0);
    })
    .catch((e) => {
      process.stderr.write(String(e && e.message ? e.message : e));
      process.exit(3);
    });
`;

export function probeDatabase(dir: string = paths.database): ProbeResult {
  if (!fs.existsSync(dir) || fs.readdirSync(dir).length === 0) {
    return { exists: false, opens: false };
  }

  const res = spawnSync(process.execPath, ['--input-type=module', '-e', PROBE_SOURCE, dir], {
    encoding: 'utf8',
    timeout: 120_000,
    // The probe must not inherit stdio, or an engine PANIC floods the console.
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  if (res.status === 0) return { exists: true, opens: true };

  return {
    exists: true,
    opens: false,
    error: (res.stderr ?? '').trim().split('\n').slice(0, 3).join(' ') || `probe exited ${res.status}`,
  };
}

/**
 * Removes a data directory, retrying briefly because Windows may still be
 * releasing handles from a process that has only just exited.
 */
export function removeDataDirectory(dir: string = paths.database): void {
  const deadline = Date.now() + 15_000;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        return;
      }
    } catch (err) {
      lastError = err;
    }
    // Busy-wait briefly; this runs only in maintenance tooling.
    const until = Date.now() + 400;
    while (Date.now() < until) { /* wait for handles to drop */ }
  }

  throw new Error(
    `Could not remove the data directory ${dir}.\n` +
      `  Another process is still holding files inside it. Stop every Zolex backend and CLI\n` +
      `  command, then try again.\n` +
      `  Underlying error: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
  );
}
