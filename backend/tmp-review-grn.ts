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
  const v = viewBySheet('GRN')!;
  const sql = buildViewSql(v);

  const q = async (label: string, s: string) => {
    try { const r = await db.query(s); console.log(`--- ${label}`); console.dir(r.rows, { depth: 4 }); }
    catch (e) { console.log(`--- ${label} ERROR: ${e instanceof Error ? e.message : e}`); }
  };

  await q('row/base counts', `SELECT (SELECT COUNT(*) FROM (${sql}) a) AS view_rows,
      (SELECT COUNT(*) FROM grn_lines) AS base_rows,
      (SELECT COUNT(DISTINCT "GRN Line ID") FROM (${sql}) b) AS distinct_line_ids`);

  await q('grn header statuses', `SELECT status, COUNT(*) FROM grn_headers GROUP BY status`);

  await q('prev+recv vs total (posted, PO-backed)', `
    SELECT COUNT(*) AS n_checked,
           COUNT(*) FILTER (WHERE ABS(("Previously Received Qty" + "Received Qty") - "Total Received Qty") > 0.0001) AS mismatches
      FROM (${sql}) q WHERE "PO Line ID" IS NOT NULL AND "GRN Status" = 'POSTED'`);

  await q('null-ness of key cells', `
    SELECT COUNT(*) AS rows,
      COUNT(*) FILTER (WHERE "GRN Type" IS NULL) AS null_grn_type,
      COUNT(*) FILTER (WHERE "UOM" IS NULL) AS null_uom,
      COUNT(*) FILTER (WHERE "MLN No" IS NULL) AS null_mln,
      COUNT(*) FILTER (WHERE "Indent No" IS NULL) AS null_indent,
      COUNT(*) FILTER (WHERE "PO ID" IS NULL) AS null_po_id,
      COUNT(*) FILTER (WHERE "Supplier Name" IS NULL) AS null_supp,
      COUNT(*) FILTER (WHERE "Received By" IS NULL) AS null_recvby,
      COUNT(*) FILTER (WHERE "Posted By" IS NULL) AS null_postedby
    FROM (${sql}) q`);

  await q('mln + uom + grn_type raw data', `SELECT
      (SELECT COUNT(*) FROM grn_line_mlns) AS mlns,
      (SELECT COUNT(*) FROM lookups WHERE category='GRN_TYPE') AS grn_type_lookups,
      (SELECT COUNT(*) FROM grn_headers WHERE grn_type_id IS NOT NULL) AS gh_with_type,
      (SELECT COUNT(*) FROM grn_lines WHERE uom_id IS NOT NULL) AS lines_with_uom,
      (SELECT COUNT(*) FROM grn_lines WHERE po_line_id IS NULL) AS direct_lines,
      (SELECT COUNT(*) FROM grn_headers WHERE po_id IS NULL) AS headers_no_po`);

  await q('header po_id vs line po_id divergence', `
    SELECT COUNT(*) AS lines_where_header_po_differs
      FROM grn_lines gl JOIN grn_headers gh ON gh.id=gl.grn_id
      JOIN purchase_order_lines pol ON pol.id=gl.po_line_id
     WHERE gh.po_id IS DISTINCT FROM pol.po_id`);

  await q('sample row', `SELECT * FROM (${sql}) q LIMIT 1`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
