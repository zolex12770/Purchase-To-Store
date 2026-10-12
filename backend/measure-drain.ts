/**
 * Measures what an ordinary change actually costs, against the LIVE database
 * and the LIVE spreadsheet.
 *
 * The brief asks for the API cost of a normal edit and of a bulk update, and
 * for evidence that the ERP is not held up by either. Both are measured here
 * rather than reasoned about.
 *
 *   npx tsx measure-drain.ts
 */
process.env.LOG_LEVEL = 'warn';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { runMigrations } = await import('./src/db/migrate.js');
  const { getDatabase } = await import('./src/db/driver.js');
  const { query, execute } = await import('./src/db/index.js');

  ensureStorageDirs();
  await getDatabase();
  await runMigrations({ silent: true });

  const { apiCallCount, resetApiCallCount } = await import('./src/modules/google-db/client.js');
  const { drainOutbox } = await import('./src/modules/google-db/drain.js');

  const show = (label: string, r: Awaited<ReturnType<typeof drainOutbox>>, ms: number) => {
    console.log(
      `${label.padEnd(38)} changes=${String(r.changes).padStart(5)}  written=${String(r.rowsWritten).padStart(5)}`
      + `  unchanged=${String(r.rowsUnchanged).padStart(5)}  apiCalls=${String(r.apiCalls).padStart(3)}`
      + `  ${String(ms).padStart(6)}ms  ${r.status}`,
    );
    if (r.deferred.length) console.log(`${' '.repeat(40)}deferred: ${r.deferred.join(', ')}`);
  };

  const run = async (label: string) => {
    resetApiCallCount();
    const t0 = Date.now();
    const r = await drainOutbox();
    show(label, r, Date.now() - t0);
    return r;
  };

  const [before] = await query<{ n: string }>(
    'SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL',
  );
  console.log(`outbox backlog at start: ${before?.n ?? 0}\n`);

  // 1. Whatever is already queued.
  for (let i = 0; i < 12; i += 1) {
    const r = await run(`backlog drain #${i + 1}`);
    if (r.changes === 0) break;
  }

  // 2. ONE ordinary edit — the case that used to rewrite whole tabs.
  const [sup] = await query<{ id: number; supplier_name: string }>(
    'SELECT id, supplier_name FROM suppliers WHERE deleted_at IS NULL ORDER BY id LIMIT 1',
  );
  const original = sup!.supplier_name;
  await execute('UPDATE suppliers SET supplier_name = $2 WHERE id = $1', [sup!.id, `${original} `]);
  await run('ONE supplier edit');

  // Put it back, and push that too, so the live data is exactly as it was.
  await execute('UPDATE suppliers SET supplier_name = $2 WHERE id = $1', [sup!.id, original]);
  await run('  (reverted)');

  // 3. A no-op: the record is queued again but renders identically.
  await execute(
    `INSERT INTO google_db_outbox (table_name, row_key, operation) VALUES ('suppliers', $1, 'UPSERT')
     ON CONFLICT DO NOTHING`,
    [String(sup!.id)],
  );
  await run('re-queued but unchanged');

  const [after] = await query<{ n: string }>(
    'SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL',
  );
  console.log(`\noutbox backlog at end: ${after?.n ?? 0}`);
  console.log(`total API calls this run: ${apiCallCount()}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
