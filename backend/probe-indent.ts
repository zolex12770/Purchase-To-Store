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
  const probe = await db.query("SELECT to_regclass('public.items') AS t");
  if (!(probe.rows as any[])[0]?.t) {
    await db.query('DROP SCHEMA IF EXISTS public CASCADE');
    await db.query('CREATE SCHEMA public');
    await runMigrations({ silent: true });
    await seedSystem();
  }
  const n = await db.query('SELECT COUNT(*)::int AS n FROM purchase_indent_lines');
  if ((n.rows as any[])[0].n === 0) {
    console.log('seeding demo data...');
    await seedDemoData();
  }

  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql } = await import('./src/modules/google-db/views/types.js');
  const view = viewBySheet('Purchase Indent')!;
  const sql = buildViewSql(view);

  const q = async (label: string, s: string) => {
    try {
      const r = await db.query(s);
      console.log(`\n### ${label}`);
      console.dir(r.rows, { depth: 4 });
    } catch (e) {
      console.log(`\n### ${label} -> ERROR: ${e instanceof Error ? e.message : e}`);
    }
  };

  await q('fanout', `SELECT
      (SELECT COUNT(*) FROM (${sql}) v)                    AS view_rows,
      (SELECT COUNT(DISTINCT "Indent Line ID") FROM (${sql}) v) AS distinct_line_ids,
      (SELECT COUNT(*) FROM purchase_indent_lines)          AS base_lines,
      (SELECT COUNT(*) FROM v_indent_line_balance)          AS balance_rows`);

  await q('null-name checks', `SELECT
      COUNT(*) FILTER (WHERE "Indent Type" IS NULL)      AS null_indent_type,
      COUNT(*) FILTER (WHERE "UOM" IS NULL)              AS null_uom,
      COUNT(*) FILTER (WHERE "Department" IS NULL)       AS null_dept,
      COUNT(*) FILTER (WHERE "Cost Centre" IS NULL)      AS null_cc,
      COUNT(*) FILTER (WHERE "Main Group" IS NULL)       AS null_mg,
      COUNT(*) FILTER (WHERE "Sub Main Group" IS NULL)   AS null_smg,
      COUNT(*) FILTER (WHERE "Requested By" IS NULL)     AS null_req,
      COUNT(*) FILTER (WHERE "Suggested Supplier" IS NULL) AS null_sup,
      COUNT(*) FILTER (WHERE "Item Code" IS NULL)        AS null_itemcode,
      COUNT(*) FILTER (WHERE "Line Remarks" IS NULL)     AS null_lineremarks,
      COUNT(*) FILTER (WHERE "Created At" IS NULL)       AS null_created,
      COUNT(*) FILTER (WHERE "Live Qty" IS NULL)         AS null_liveqty,
      COUNT(*) FILTER (WHERE "PO No(s)" IS NULL)         AS null_pono,
      COUNT(*)                                           AS total
    FROM (${sql}) v`);

  await q('sample rows', `SELECT * FROM (${sql}) v LIMIT 3`);

  await q('lookup category sanity', `SELECT
     (SELECT COUNT(DISTINCT l.category) FROM (${sql}) v JOIN lookups l ON l.id=v."Indent Type ID") AS type_cats,
     (SELECT COUNT(DISTINCT l.category) FROM (${sql}) v JOIN lookups l ON l.id=v."UOM ID") AS uom_cats,
     (SELECT COUNT(DISTINCT l.category) FROM (${sql}) v JOIN lookups l ON l.id=v."Department ID") AS dept_cats,
     (SELECT COUNT(DISTINCT l.category) FROM (${sql}) v JOIN lookups l ON l.id=v."Cost Centre ID") AS cc_cats`);

  await q('po linkage vs ordered', `SELECT "Indent No","Line No","Indent Qty","Ordered Qty","Pending Qty","PO No(s)","PO Qty"
     FROM (${sql}) v WHERE "PO Qty" > 0 LIMIT 10`);

  await q('lines missing from view', `SELECT COUNT(*) AS missing FROM purchase_indent_lines il
     WHERE NOT EXISTS (SELECT 1 FROM (${sql}) v WHERE v."Indent Line ID" = il.id)`);

  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
