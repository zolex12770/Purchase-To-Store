process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const r = await db.query(`SELECT (SELECT COUNT(*) FROM po_indent_sources) a, (SELECT COUNT(*) FROM purchase_indent_lines) b, (SELECT COUNT(*) FROM purchase_order_lines) c`);
  console.log(r.rows);
  const s = await db.query(`SELECT id, po_line_id, indent_line_id, indent_id, consumed_qty FROM po_indent_sources ORDER BY id LIMIT 3`);
  console.log(s.rows);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
