process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const q = async (s: string) => (await db.query(s)).rows as any[];

  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const v = viewBySheet('Supplier Master')!;

  const cols = await q(`SELECT column_name, is_nullable, column_default, is_generated
                          FROM information_schema.columns
                         WHERE table_schema='public' AND table_name='suppliers'
                         ORDER BY ordinal_position`);
  const real = new Set(cols.map((c) => c.column_name));
  console.log('suppliers columns:', [...real].join(', '));

  const requiredForInsert = cols
    .filter((c) => c.is_nullable === 'NO' && c.column_default === null && c.is_generated !== 'ALWAYS')
    .map((c) => c.column_name);
  console.log('requiredForInsert:', requiredForInsert);

  const headers = v.columns.map((c) => c.header);
  console.log('\nheader count:', headers.length);

  const t = v.importTargets![0]!;
  const fieldKeys = Object.keys(t.fields);
  console.log('\nfields keys not in headers:', fieldKeys.filter((k) => !headers.includes(k)));
  console.log('fields cols not real:', Object.values(t.fields).filter((c) => !real.has(c)));
  console.log('required-for-insert cols NOT mapped:',
    requiredForInsert.filter((c) => !Object.values(t.fields).includes(c)));
  console.log('pk cols not mapped in fields:', t.pk.filter((p) => !Object.values(t.fields).includes(p)));

  // Real supplier columns never surfaced anywhere on the tab.
  const mentioned = new Set<string>();
  for (const c of v.columns) for (const m of c.expr.matchAll(/\bs\.([a-z_]+)/g)) mentioned.add(m[1]!);
  console.log('\nsuppliers columns NOT on the sheet:', [...real].filter((c) => !mentioned.has(c)));

  console.log('\n--- stored state/city values ---');
  console.log(await q(`SELECT DISTINCT state, city FROM suppliers WHERE state<>'' OR city<>'' ORDER BY state LIMIT 15`));
  console.log('--- STATE/CITY lookups sample ---');
  console.log(await q(`SELECT category, code, name FROM lookups WHERE category IN ('STATE','CITY') ORDER BY category, sort_order LIMIT 6`));
  console.log('--- PAYMENT_TERMS / CURRENCY lookups ---');
  console.log(await q(`SELECT category, code, name FROM lookups WHERE category IN ('PAYMENT_TERMS','CURRENCY') ORDER BY category LIMIT 10`));
  console.log('--- stored supplier payment_terms/currency ---');
  console.log(await q(`SELECT DISTINCT payment_terms, currency_code FROM suppliers LIMIT 10`));
  process.exit(0);
}
main().catch((e) => { console.log('FATAL', e); process.exit(1); });
