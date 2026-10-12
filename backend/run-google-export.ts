/**
 * One-off runner: the full SQL -> Google BUSINESS export against the LIVE
 * spreadsheet, driven exactly the way the scheduler drives it — as a queued job
 * advanced in slices — with the API cost and wall-clock time measured rather
 * than estimated.
 *
 *   npx tsx run-google-export.ts             # export, then reconcile
 *   npx tsx run-google-export.ts --no-verify # export only
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'info';

async function main() {
  const { ensureStorageDirs, env } = await import('./src/config/env.js');
  const { runMigrations } = await import('./src/db/migrate.js');
  const { getDatabase } = await import('./src/db/driver.js');
  const { query } = await import('./src/db/index.js');

  ensureStorageDirs();
  await getDatabase();
  await runMigrations({ silent: false });

  const { googleDbConfig, apiCallCount, resetApiCallCount } = await import('./src/modules/google-db/client.js');
  const cfg = googleDbConfig();
  console.log(`\nspreadsheet : ${cfg.spreadsheetId}`);
  console.log(`configured  : ${cfg.configured}${cfg.reason ? ` (${cfg.reason})` : ''}`);
  console.log(`environment : ${env.NODE_ENV}\n`);
  if (!cfg.configured) process.exit(1);

  const { requestFullExport, writeControlSheets, writeErrorSheet } = await import('./src/modules/google-db/replica.js');
  const jobs = await import('./src/modules/google-db/jobs.js');
  const { BUSINESS_VIEWS } = await import('./src/modules/google-db/views/index.js');

  // Any job left over from the running server would be resumed rather than
  // restarted, which would leave half the tabs untouched.
  await query(`UPDATE google_db_jobs SET status = 'CANCELLED', finished_at = now()
                WHERE status IN ('QUEUED','RUNNING')`);

  resetApiCallCount();
  const started = Date.now();

  await requestFullExport({ sheets: [], pruneLegacy: true });

  let slices = 0;
  let longestSliceMs = 0;
  let waits = 0;
  for (; slices < 500; slices += 1) {
    const active = await jobs.activeJob();
    if (!active) break;
    const t0 = Date.now();
    try {
      const r = await jobs.runJobSlice(8_000);
      const ms = Date.now() - t0;
      longestSliceMs = Math.max(longestSliceMs, ms);
      if (r.ran) console.log(`  slice ${slices + 1}: ${ms}ms — ${r.message}`);
    } catch (err) {
      // Exactly what the scheduler does: the slice ends, the cursor stays put,
      // and the next attempt resumes from it. Google's write quota is per
      // MINUTE, so the wait is a minute rather than a few seconds.
      const message = err instanceof Error ? err.message : String(err);
      waits += 1;
      console.log(`  slice ${slices + 1}: paused — ${message.slice(0, 120)}`);
      console.log('    waiting 65s for the write quota window, then resuming from the cursor...');
      await new Promise((r) => setTimeout(r, 65_000));
    }
  }
  if (waits > 0) console.log(`\n(resumed after ${waits} quota pause(s) — the cursor made every restart free)`);

  const exportCalls = apiCallCount();
  const exportMs = Date.now() - started;

  // The control tabs are refreshed once, at the end.
  await writeControlSheets();
  await writeErrorSheet();

  console.log('\nSHEET                        SQL ROWS  SHEET ROWS  COLS  STATUS');
  let totalRows = 0;
  for (const v of BUSINESS_VIEWS) {
    const [s] = await query<Record<string, unknown>>(
      'SELECT * FROM google_db_state WHERE sheet_name = $1', [v.sheet],
    );
    const [c] = await query<{ n: string }>(
      `SELECT COUNT(*)::int AS n FROM google_db_rows WHERE sheet_name = $1`, [v.sheet],
    );
    totalRows += Number(c?.n ?? 0);
    console.log(
      `${v.sheet.padEnd(26)} ${String(s?.sql_row_count ?? 0).padStart(8)}  `
      + `${String(c?.n ?? 0).padStart(10)}  ${String(v.columns.length).padStart(4)}  ${s?.sync_status ?? 'NONE'}`
      + (s?.last_error ? ` — ${String(s.last_error).slice(0, 70)}` : ''),
    );
  }

  console.log(`\nTOTAL ROWS        : ${totalRows}`);
  console.log(`TOTAL API CALLS   : ${exportCalls}`);
  console.log(`DURATION          : ${(exportMs / 1000).toFixed(1)}s across ${slices} slice(s)`);
  console.log(`LONGEST SLICE     : ${longestSliceMs}ms  (the ERP is only ever behind ONE slice)`);

  const [pending] = await query<{ n: string }>(
    'SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL',
  );
  console.log(`OUTBOX PENDING    : ${pending?.n ?? 0}`);

  if (!process.argv.includes('--no-verify')) {
    console.log('\nReconciling SQL against Google, value by value...');
    resetApiCallCount();
    const { reconcileSheets } = await import('./src/modules/google-db/reconcile.js');
    const report = await reconcileSheets();
    console.log('\nSHEET                        SQL   GOOGLE   MATCH  MISMATCH  MISSING  EXTRA  DUP  HEADER');
    for (const s of report.sheets) {
      console.log(
        `${s.sheet.padEnd(26)} ${String(s.sqlRows).padStart(5)} ${String(s.googleRows).padStart(8)} `
        + `${String(s.match).padStart(7)} ${String(s.mismatch).padStart(9)} ${String(s.missingInGoogle).padStart(8)} `
        + `${String(s.extraInGoogle).padStart(6)} ${String(s.duplicateInGoogle).padStart(4)}  ${s.headerMatches ? 'ok' : 'DIFFERS'}`
        + (s.error ? ` — ${s.error.slice(0, 60)}` : ''),
      );
      for (const d of s.samples.slice(0, 5)) {
        console.log(`     ${d.key} · ${d.column}: SQL="${d.sql}" GOOGLE="${d.google}"`);
      }
    }
    console.log(`\nRECONCILE API CALLS: ${apiCallCount()}`);
    console.log(report.clean ? '\nRECONCILE_CLEAN' : `\nRECONCILE_DIFFERENCES: ${report.message}`);
    process.exit(report.clean ? 0 : 2);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
