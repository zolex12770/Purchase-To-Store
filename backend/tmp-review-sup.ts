process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';

async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const q = async (s: string) => (await db.query(s)).rows as any[];

  // Make the run self-contained: ensure demo data exists in THIS process.
  const { seedDemoData } = await import('./src/db/seed.js');
  try { await seedDemoData(); } catch { /* already seeded */ }

  // Guarantee at least one CANCELLED PO so the exclusion filter is exercised.
  const anyCancelled = (await q(`SELECT COUNT(*)::int n FROM purchase_order_headers WHERE status='CANCELLED'`))[0].n;
  if (anyCancelled === 0) {
    const victim = (await q(`SELECT id, supplier_id FROM purchase_order_headers ORDER BY id DESC LIMIT 1`))[0];
    if (victim) {
      await db.query(`UPDATE purchase_order_headers SET status='CANCELLED', close_reason='review probe' WHERE id=${victim.id}`);
      console.log(`(cancelled PO ${victim.id} of supplier ${victim.supplier_id} to exercise the filter)`);
    }
  }

  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const { buildViewSql } = await import('./src/modules/google-db/views/types.js');
  const sql = buildViewSql(viewBySheet('Supplier Master')!);

  console.log('--- base counts ---');
  console.log(await q(`SELECT (SELECT COUNT(*)::int FROM suppliers) all_sup,
    (SELECT COUNT(*)::int FROM suppliers WHERE deleted_at IS NULL) live,
    (SELECT COUNT(*)::int FROM (${sql}) v) viewrows,
    (SELECT COUNT(DISTINCT v."Supplier ID")::int FROM (${sql}) v) distinct_ids,
    (SELECT COUNT(*)::int FROM purchase_order_headers) po_all`));

  console.log('--- PO status distribution ---');
  console.log(await q(`SELECT status, COUNT(*)::int n FROM purchase_order_headers GROUP BY status ORDER BY status`));

  console.log('--- view vs independent recompute ---');
  const cmp = await q(`
    WITH v AS (${sql}),
    truth AS (
      SELECT poh.supplier_id sid, COUNT(*)::int cnt,
             SUM(h.grand_total)::numeric(18,2) val, MAX(poh.po_date) last_dt
        FROM purchase_order_headers poh
        JOIN v_po_header_balance h ON h.po_id = poh.id
       WHERE poh.status <> 'CANCELLED'
       GROUP BY poh.supplier_id)
    SELECT v."Supplier ID" sid, v."Supplier Code" code,
           v."PO Count" vcnt, COALESCE(t.cnt,0) tcnt,
           v."Total PO Value" vval, COALESCE(t.val,0) tval,
           to_char(v."Last PO Date",'YYYY-MM-DD') vdt, to_char(t.last_dt,'YYYY-MM-DD') tdt
      FROM v LEFT JOIN truth t ON t.sid = v."Supplier ID"
     ORDER BY v."Supplier Code"`);
  for (const r of cmp) {
    const bad = Number(r.vcnt) !== Number(r.tcnt) || Number(r.vval) !== Number(r.tval)
      || String(r.vdt ?? '') !== String(r.tdt ?? '');
    console.log(`${bad ? 'MISMATCH' : 'ok      '} ${r.code} cnt=${r.vcnt}/${r.tcnt} val=${r.vval}/${r.tval} last=${r.vdt}/${r.tdt}`);
  }
  process.exit(0);
}
main().catch((e) => { console.log('FATAL', e); process.exit(1); });
