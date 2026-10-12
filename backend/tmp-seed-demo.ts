process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  ensureStorageDirs();
  const { getDatabase } = await import('./src/db/driver.js');
  const db = await getDatabase();
  const { seedDemoData } = await import('./src/db/seed.js');
  try { await seedDemoData(); } catch (e) { console.log('SEED_ERR', (e as Error).message); }
  const r = await db.query('SELECT (SELECT COUNT(*)::int FROM suppliers) s,(SELECT COUNT(*)::int FROM purchase_order_headers) po,(SELECT COUNT(*)::int FROM purchase_order_lines) pol');
  console.log('COUNTS', JSON.stringify((r.rows as any[])[0]));
  process.exit(0);
}
main().catch((e) => { console.log('FATAL', e); process.exit(1); });
