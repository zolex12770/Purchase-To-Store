process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql } = await import('./src/modules/google-db/views/types.js');
  const sql = buildViewSql(viewBySheet('Purchase Indent')!);
  const q = async (l: string, s: string, p: any[] = []) => {
    try { const r = await db.query(s, p); console.log(`\n### ${l}`); console.dir(r.rows, { depth: 4 }); }
    catch (e) { console.log(`\n### ${l} ERR ${e instanceof Error ? e.message : e}`); }
  };
  await q('po statuses', `SELECT status, COUNT(*) FROM purchase_order_headers GROUP BY status`);
  await q('cancelled po sources', `SELECT COUNT(*) AS n FROM po_indent_sources pis
    JOIN purchase_order_lines pol ON pol.id=pis.po_line_id
    JOIN purchase_order_headers poh ON poh.id=pol.po_id WHERE poh.status='CANCELLED'`);

  // Simulate: cancel one PO that consumes indent lines, compare, then roll back.
  const tgt = await db.query(`SELECT poh.id, poh.po_no FROM purchase_order_headers poh
      WHERE EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN po_indent_sources pis ON pis.po_line_id=pol.id WHERE pol.po_id=poh.id)
      AND poh.status <> 'CANCELLED' LIMIT 1`);
  const po = (tgt.rows as any[])[0];
  console.log('\n### will cancel PO', po);
  await db.query('BEGIN');
  await db.query(`UPDATE purchase_order_headers SET status='CANCELLED' WHERE id=$1`, [po.id]);
  await q('after cancel: rows where PO Qty <> Ordered Qty', `SELECT "Indent No","Line No","Indent Qty","Ordered Qty","Pending Qty","PO No(s)","PO Qty"
      FROM (${sql}) v WHERE "PO Qty"::numeric <> "Ordered Qty"::numeric LIMIT 8`);
  await db.query('ROLLBACK');
  await q('post-rollback sanity', `SELECT COUNT(*) FROM (${sql}) v WHERE "PO Qty"::numeric <> "Ordered Qty"::numeric`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
