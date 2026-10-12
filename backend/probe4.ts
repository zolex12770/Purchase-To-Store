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
    const r = await db.query(s, p); console.log(`\n### ${l}`); console.dir(r.rows, { depth: 4 });
  };
  // Pick an indent line already consumed by one PO, then attach a SECOND PO line to it.
  const [row] = (await db.query(`SELECT pis.indent_line_id, pis.indent_id FROM po_indent_sources pis LIMIT 1`)).rows as any[];
  const [otherLine] = (await db.query(
    `SELECT pol.id FROM purchase_order_lines pol
      JOIN purchase_order_headers poh ON poh.id = pol.po_id
      WHERE poh.status <> 'CANCELLED'
        AND pol.id NOT IN (SELECT po_line_id FROM po_indent_sources WHERE indent_line_id = $1)
      ORDER BY poh.po_no DESC LIMIT 1`, [row.indent_line_id])).rows as any[];
  await db.query('BEGIN');
  await db.query(`INSERT INTO po_indent_sources (po_line_id, indent_line_id, indent_id, consumed_qty) VALUES ($1,$2,$3,1)`,
    [otherLine.id, row.indent_line_id, row.indent_id]);
  await q('multi-PO line: still exactly one view row?', `SELECT COUNT(*) AS view_rows_for_line, MAX("PO No(s)") AS po_nos, MAX("PO Qty"::text) AS po_qty, MAX("Ordered Qty"::text) AS ordered
     FROM (${sql}) v WHERE "Indent Line ID" = $1`, [row.indent_line_id]);
  await q('total fanout under multi-PO', `SELECT (SELECT COUNT(*) FROM (${sql}) v) AS view_rows, (SELECT COUNT(*) FROM purchase_indent_lines) AS lines`);
  await db.query('ROLLBACK');
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
