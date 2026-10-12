/**
 * Runs every business view against the LIVE database and checks the things a
 * type-checker cannot: that the SQL is valid, that the returned columns are
 * exactly the declared headers, that no view fans out into duplicate rows, that
 * every declared change-resolver predicate parses, and how long each costs.
 *
 *   npx tsx verify-views.ts
 */
process.env.LOG_LEVEL = process.env.LOG_LEVEL ?? 'error';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  const { runMigrations } = await import('./src/db/migrate.js');
  const { query } = await import('./src/db/index.js');

  ensureStorageDirs();
  await getDatabase();
  await runMigrations({ silent: true });

  const { BUSINESS_VIEWS } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql, buildCountSql, buildRestrictedSql, headersOf } =
    await import('./src/modules/google-db/views/types.js');

  let failures = 0;
  console.log('SHEET                     COLS   ROWS      ms  PK-UNIQUE  HEADERS');
  console.log('-'.repeat(78));

  for (const view of BUSINESS_VIEWS) {
    const headers = headersOf(view);
    try {
      const started = Date.now();
      const rows = await query<Record<string, unknown>>(buildViewSql(view));
      const ms = Date.now() - started;

      // Declared headers must be exactly the returned columns, in order.
      const got = rows.length > 0 ? Object.keys(rows[0]!) : headers;
      const headersOk = got.length === headers.length && got.every((c, i) => c === headers[i]);

      // No JOIN may duplicate a business row.
      const keys = new Set(rows.map((r) => view.primaryKey.map((p) => String(r[p] ?? '')).join('')));
      const pkUnique = keys.size === rows.length;

      // The row count must equal the base relation's own count: a fan-out shows
      // up here even when the primary key happens to stay unique.
      const [countRow] = await query<{ n: string }>(buildCountSql(view));
      const baseCount = Number(countRow?.n ?? 0);
      const countOk = baseCount === rows.length;

      const ok = headersOk && pkUnique && countOk;
      if (!ok) failures += 1;
      console.log(
        `${view.sheet.padEnd(24)} ${String(headers.length).padStart(4)} `
        + `${String(rows.length).padStart(6)} ${String(ms).padStart(7)}  `
        + `${pkUnique ? 'yes' : 'NO '}        ${headersOk ? 'ok' : 'MISMATCH'}`
        + (countOk ? '' : `  BASE=${baseCount} FANOUT!`),
      );
      if (!headersOk) {
        console.log(`    declared: ${headers.join(' | ')}`);
        console.log(`    returned: ${got.join(' | ')}`);
      }
    } catch (err) {
      failures += 1;
      console.log(`${view.sheet.padEnd(24)} FAILED: ${(err as Error).message.slice(0, 160)}`);
    }

    // Every change-resolver must be valid SQL, or a drain would fail at runtime.
    for (const src of view.sources) {
      try {
        await query(buildRestrictedSql(view, src.restrict, 1), [['0']]);
      } catch (err) {
        failures += 1;
        console.log(`    source ${src.table}: FAILED — ${(err as Error).message.slice(0, 150)}`);
      }
    }

    // An import target's `pk` is a SQL COLUMN name, while `primaryKey` above is
    // a sheet HEADER. Confusing the two is silent: every row plans as "not a row
    // for this table" and an import reports zero work with no error at all.
    for (const target of view.importTargets ?? []) {
      const cols = await query<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = $1`,
        [target.table],
      );
      const known = new Set(cols.map((c) => c.column_name));
      if (known.size === 0) {
        failures += 1;
        console.log(`    import ${target.table}: table does not exist`);
        continue;
      }
      for (const pk of target.pk) {
        if (!known.has(pk)) {
          failures += 1;
          console.log(`    import ${target.table}: pk "${pk}" is not a column (headers belong in primaryKey)`);
        }
      }
      const mapped = new Set(Object.values(target.fields)
        .map((f) => (typeof f === 'string' ? f : f.column)));
      for (const pk of target.pk) {
        if (!mapped.has(pk)) {
          failures += 1;
          console.log(`    import ${target.table}: pk "${pk}" is never supplied by any mapped column`);
        }
      }
      for (const [header, f] of Object.entries(target.fields)) {
        const column = typeof f === 'string' ? f : f.column;
        if (!known.has(column)) {
          failures += 1;
          console.log(`    import ${target.table}: "${header}" -> unknown column "${column}"`);
        }
        if (!headers.includes(header)) {
          failures += 1;
          console.log(`    import ${target.table}: "${header}" is not a column of this tab`);
        }
      }
    }
  }

  console.log('-'.repeat(78));
  console.log(failures === 0 ? 'ALL_VIEWS_OK' : `VIEW_FAILURES=${failures}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
