process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { runMigrations } = await import('./src/db/migrate.js');
  const { seedSystem, seedDemoData } = await import('./src/db/seed.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  await seedDemoData();
  const r = await db.query(`SELECT (SELECT COUNT(*) FROM po_indent_sources) a, (SELECT COUNT(*) FROM purchase_indent_lines) b`);
  console.log(r.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
