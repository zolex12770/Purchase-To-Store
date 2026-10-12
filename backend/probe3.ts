process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL = 'silent';
process.env.SEED_DEMO_DATA = 'false';
import fs from 'node:fs';
async function main() {
  const { ensureStorageDirs } = await import('./src/config/env.js');
  const { getDatabase } = await import('./src/db/driver.js');
  ensureStorageDirs();
  const db = await getDatabase();
  const cols = await db.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='public'`);
  const byTable = new Map<string, Set<string>>();
  for (const r of cols.rows as any[]) {
    if (!byTable.has(r.table_name)) byTable.set(r.table_name, new Set());
    byTable.get(r.table_name)!.add(r.column_name);
  }
  const src = fs.readFileSync('src/modules/google-db/views/purchase-indent.ts', 'utf8');
  // alias -> table from the FROM clause
  const aliasTable: Record<string, string> = {
    b: 'v_indent_line_balance', ih: 'purchase_indent_headers', il: 'purchase_indent_lines',
    it: 'items', lk_type: 'lookups', lk_uom: 'lookups', lk_dept: 'lookups', lk_cc: 'lookups',
    lk_mg: 'lookups', lk_smg: 'lookups', u_req: 'users', u_app: 'users', u_rej: 'users',
    sup: 'suppliers', src: 'v_po_line_sources',
  };
  const bad: string[] = [];
  const seen = new Set<string>();
  for (const m of src.matchAll(/\b([a-z_]+)\.([a-z_]+)\b/g)) {
    const [, a, c] = m;
    const t = aliasTable[a!];
    if (!t) continue;
    const key = `${a}.${c}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (!byTable.get(t)?.has(c!)) bad.push(`${key}  -> ${t}.${c} DOES NOT EXIST`);
  }
  console.log('### referenced columns checked:', seen.size);
  console.log(bad.length ? bad.join('\n') : 'all referenced columns exist');

  // import target field validation
  const { viewBySheet } = await import('./src/modules/google-db/views/index.js');
  const v = viewBySheet('Purchase Indent')!;
  const gen = await db.query<{ table_name: string; column_name: string; is_generated: string; is_nullable: string; column_default: string | null }>(
    `SELECT table_name, column_name, is_generated, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public'`);
  const headers = new Set(v.columns.map((c) => c.header));
  for (const t of v.importTargets ?? []) {
    const tcols = (gen.rows as any[]).filter((r) => r.table_name === t.table);
    const req = tcols.filter((r) => r.is_nullable === 'NO' && r.column_default === null && r.is_generated !== 'ALWAYS').map((r) => r.column_name);
    const mapped = new Set(Object.values(t.fields));
    console.log(`\n### ${t.table}`);
    console.log('  required-but-unmapped:', req.filter((c) => !mapped.has(c)));
    console.log('  mapped-but-nonexistent:', Object.entries(t.fields).filter(([, c]) => !tcols.some((r) => r.column_name === c)));
    console.log('  mapped-but-GENERATED:', Object.entries(t.fields).filter(([, c]) => tcols.some((r) => r.column_name === c && r.is_generated === 'ALWAYS')));
    console.log('  header-not-in-view:', Object.keys(t.fields).filter((h) => !headers.has(h)));
    console.log('  writable columns NOT exported at all:', tcols.map((r)=>r.column_name).filter((c)=>!mapped.has(c)));
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
