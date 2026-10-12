process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const q = async (label: string, sql: string) => {
    try { const r = await db.query(sql); console.log(label + ' => ' + JSON.stringify(r.rows)); }
    catch (e:any) { console.log(label + ' => ERR ' + e.message); }
  };
  await q('counts', `SELECT
      (SELECT COUNT(*)::int FROM purchase_order_headers) AS poh,
      (SELECT COUNT(*)::int FROM purchase_order_lines) AS pol,
      (SELECT COUNT(*)::int FROM v_po_line_balance) AS vpolb,
      (SELECT COUNT(*)::int FROM po_indent_sources) AS pis,
      (SELECT COUNT(*)::int FROM grn_headers) AS grnh,
      (SELECT COUNT(*)::int FROM grn_lines) AS grnl`);
  await q('grn status mix', `SELECT status, COUNT(*)::int n FROM grn_headers GROUP BY status`);
  await q('multi-grn po lines', `SELECT po_line_id, COUNT(*)::int n FROM grn_lines WHERE po_line_id IS NOT NULL GROUP BY po_line_id HAVING COUNT(*)>1 LIMIT 5`);
  await q('multi-indent po lines', `SELECT po_line_id, COUNT(*)::int n FROM po_indent_sources GROUP BY po_line_id HAVING COUNT(*)>1 LIMIT 5`);
  await db.close();
}
main().catch(e=>{console.error(e);process.exit(1);});
