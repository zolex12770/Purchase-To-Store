/**
 * Integration tests — one-time stock-ledger alignment (2026-10-16 audit, SLR-4 / SLR-8).
 *
 * Until 2026-10-16 the inventory sync overwrote items.live_stock_qty with the sheet
 * figure and wrote no ledger row, so 2,769 items' ledgers stopped explaining their
 * stock. POST /admin/data-management/repair/stock-alignment posts evidence entries
 * (sheet opening cell, sheet rows, existing ledger rows) as ledger rows. Pinned here:
 *
 *   1. Only a Super Admin can run it; the route reads ~7,000 entries (> 2 MB) while
 *      every other route keeps the 2 MB limit.
 *   2. An item is aligned only when its ledger plus its entries equals its live stock
 *      to within 0.0001; anything else is refused with its figures, never plugged.
 *   3. Applying needs the typed confirmation and the dry run's selectionHash; when the
 *      figures moved in between, 409 and nothing is written.
 *   4. One ledger row per entry, running balance, remarks naming the evidence; live
 *      stock never changes; the reconciliation mismatch count falls by exactly the
 *      aligned items (active and inactive counted apart).
 *   5. Running the same file again aligns nothing; undo appends the opposite rows.
 *   6. The Purchase stock adds only the sheets that count the Item Master's unit
 *      (PTC4/0: 1,472 WIP Nos were added to 264.75 RM Kg).
 *
 * Real PGlite database, migrated and seeded from scratch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { CategorySheetConfig, Row } from '../modules/inventory/sheet-model.js';
import type { CategoryRead } from '../modules/inventory/sync-engine.js';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let adminId = 0;
let stewardToken = '';
let syncCategory: typeof import('../modules/inventory/sync-engine.js')['syncCategoryFromSheet'];
let rangesFor: typeof import('../modules/inventory/sync-engine.js')['rangesFor'];
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (path: string) => `/api/v1${path}`;
const ALIGN = api('/admin/data-management/repair/stock-alignment');
const UNDO = `${ALIGN}/undo`;
const ids: Record<string, number> = {};

interface Entry { itemId: number; component: string; qty: number | string; reference: string; evidence: string }
let entries: Entry[] = [];

const uomId = async (code: string) =>
  Number((await query<{ id: string }>(`SELECT id FROM lookups WHERE category = 'UOM' AND code = $1`, [code]))[0].id);
const liveOf = async (code: string) =>
  (await query<{ q: string }>(`SELECT live_stock_qty::text AS q FROM items WHERE item_code = $1`, [code]))[0].q;
const ledgerOf = async (code: string) =>
  (await query<{ q: string }>(
    `SELECT COALESCE(SUM(l.inward_qty - l.outward_qty), 0)::text AS q FROM items i LEFT JOIN stock_ledger l ON l.item_id = i.id WHERE i.item_code = $1`,
    [code],
  ))[0].q;
const count = async (sql: string, params: unknown[] = []) => (await query<{ n: number }>(sql, params))[0].n;
const alignmentRows = () => count(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE txn_type = 'STOCK_ALIGNMENT'`);
const alignmentAudits = () => count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'stock_alignment'`);
const recon = async () => (await request(app).get(api('/items/analysis/stock-reconciliation')).query({ pageSize: 200 }).set(auth(adminToken))).body;
const allLive = async () =>
  Object.fromEntries((await query<{ item_code: string; q: string }>(
    `SELECT item_code, live_stock_qty::text AS q FROM items WHERE item_code LIKE 'ALN-%' ORDER BY item_code`,
  )).map((r) => [r.item_code, r.q]));

/** An item whose live stock the old sync wrote with no ledger row behind it, plus the ledger rows it does have. */
async function legacyItem(code: string, uom: string, live: string, active: boolean, ledger: Array<[string, string, number]> = []): Promise<number> {
  const id = Number((await query<{ id: string }>(
    `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
     VALUES ($1, $2, 'GENERAL', $3, $4, $5) RETURNING id`,
    [code, `${code} purchase item`, live, active, await uomId(uom)],
  ))[0].id);
  let balance = 0;
  for (const [type, ref, qty] of ledger) {
    balance += qty;
    await query(
      `INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_no, inward_qty, outward_qty, balance_qty, txn_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, '2026-10-14')`,
      [id, type, type === 'SHEET_SYNC' ? 'INVENTORY_SYNC' : 'GRN', ref, Math.max(qty, 0), Math.max(-qty, 0), balance],
    );
  }
  ids[code] = id;
  return id;
}

beforeAll(async () => {
  const { ensureStorageDirs } = await import('../config/env.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');
  const { getDatabase, closeDatabase } = await import('../db/driver.js');
  const db = await import('../db/index.js');
  const { createApp } = await import('../app.js');
  const engine = await import('../modules/inventory/sync-engine.js');

  ensureStorageDirs();
  const conn = await getDatabase();
  closeDb = closeDatabase;
  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  query = db.query as Q;
  syncCategory = engine.syncCategoryFromSheet;
  rangesFor = engine.rangesFor;

  app = createApp();
  const login = await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' });
  adminToken = login.body.data.accessToken;
  adminId = Number((await query<{ id: string }>(`SELECT id FROM users WHERE employee_id = '10221'`))[0].id);

  // A data steward: reaches Data Management (system.admin) but is not a Super Admin.
  const permission = (await query<{ id: string }>(`SELECT id FROM permissions WHERE code = 'system.admin'`))[0].id;
  const role = await request(app).post(api('/roles')).set(auth(adminToken))
    .send({ code: 'DATA_STEWARD', name: 'Data Steward', permissionIds: [Number(permission)] });
  expect(role.status).toBe(201);
  const user = await request(app).post(api('/users')).set(auth(adminToken))
    .send({ employeeId: 'ALN-STEWARD', employeeName: 'Data Steward', password: 'Steward@2026x', roleIds: [role.body.data.id] });
  expect(user.status).toBe(201);
  stewardToken = (await request(app).post(api('/auth/login')).send({ employeeId: 'ALN-STEWARD', password: 'Steward@2026x' })).body.data.accessToken;

  // A: 100 opening + 50 received (in the ERP as a GRN) − 32 issued − 5 adjusted = 113.
  await legacyItem('ALN-A', 'NOS', '113', true, [['GRN_INWARD', 'ZG/GS/0001', 50]]);
  // B (inactive, KG): 45 opening − 5 issued = 40; the new sync ledgered +10 from the un-ledgered figure.
  await legacyItem('ALN-B', 'KG', '40', false, [['SHEET_SYNC', 'INV-20261016-052733-bdc4', 10]]);
  // C: the records give 19, the stock is 20 — refused, never plugged.
  await legacyItem('ALN-C', 'NOS', '20', true);
  // D: the records give 7.4999, the stock is 7.5 — within the report's 0.0001.
  await legacyItem('ALN-D', 'NOS', '7.5', true);
  // E: already explained by its ledger; not named in the entries.
  await legacyItem('ALN-E', 'NOS', '12', true, [['GRN_INWARD', 'ZG/GS/0002', 12]]);

  entries = [
    { itemId: ids['ALN-A'], component: 'OPENING', qty: 100, reference: '2026-04-01', evidence: 'General Item Live Stock!BI1088' },
    { itemId: ids['ALN-A'], component: 'SHEET_ISSUES', qty: -32, reference: 'May-26', evidence: 'Issue Register (Store Outward Entry) rows 7,8,9' },
    { itemId: ids['ALN-A'], component: 'SHEET_ADJUSTMENT', qty: '-5', reference: '2026-07-03', evidence: 'Stock Adjustment row 2 (GENERAL sheet)' },
    { itemId: ids['ALN-B'], component: 'OPENING', qty: 45, reference: '2026-04-01', evidence: 'RM Stock Live!BG655' },
    { itemId: ids['ALN-B'], component: 'SHEET_ISSUES', qty: -5, reference: 'Sep-26', evidence: 'RM Outward rows 3555,3893' },
    { itemId: ids['ALN-B'], component: 'SHEET_SYNC_REVERSAL', qty: -10, reference: 'run INV-20261016-052733-bdc4', evidence: 'stock_ledger id 27436' },
    { itemId: ids['ALN-C'], component: 'OPENING', qty: 19, reference: '2026-04-01', evidence: 'General Item Live Stock!BI1090' },
    { itemId: ids['ALN-D'], component: 'OPENING', qty: 7.4999, reference: '2026-04-01', evidence: 'General Item Live Stock!BI1091' },
    { itemId: 99999999, component: 'OPENING', qty: 1, reference: '2026-04-01', evidence: 'General Item Live Stock!BI9999' },
  ];
});

afterAll(async () => {
  await closeDb?.();
});

let reconBefore: { meta: { mismatchCount: number; activeMismatchCount: number; inactiveMismatchCount: number } };
let liveBefore: Record<string, string>;

describe('Stock-ledger alignment — access and request size', () => {
  it('refuses anyone but a Super Admin, even with Data Management access', async () => {
    const dry = await request(app).post(ALIGN).set(auth(stewardToken)).send({ entries });
    expect(dry.status).toBe(403);
    const undo = await request(app).post(UNDO).set(auth(stewardToken)).send({ itemIds: [ids['ALN-A']], reason: 'not allowed', confirm: 'UNDO STOCK ALIGNMENT' });
    expect(undo.status).toBe(403);
  });

  it('reads ~7,000 entries (over 2 MB) on this route only; other routes keep the 2 MB limit', async () => {
    const evidence = `Issue Register (Store Outward Entry) rows ${Array.from({ length: 70 }, (_, k) => 10000 + k).join(',')}`;
    const many = Array.from({ length: 7000 }, () => ({ itemId: ids['ALN-C'], component: 'SHEET_ISSUES', qty: -1, reference: 'Oct-26', evidence }));
    const body = JSON.stringify({ entries: many });
    expect(body.length).toBeGreaterThan(2 * 1024 * 1024);
    const res = await request(app).post(ALIGN).set(auth(adminToken)).set('Content-Type', 'application/json').send(body);
    expect(res.status).toBe(200);
    expect(res.body.data.refused).toEqual([expect.objectContaining({ itemCode: 'ALN-C', entries: 7000, entriesNet: '-7000.0000' })]);
    const other = await request(app).post(api('/admin/data-management/repair/duplicate-indent-lines')).set(auth(adminToken))
      .set('Content-Type', 'application/json').send(JSON.stringify({ dryRun: true, padding: 'x'.repeat(2 * 1024 * 1024 + 10) }));
    expect(other.status).toBe(413);
  });

  it('refuses entries that are not evidence-shaped', async () => {
    const bad = await request(app).post(ALIGN).set(auth(adminToken)).send({
      entries: [{ itemId: ids['ALN-C'], component: 'PLUG', qty: 0.00001, reference: '', evidence: 'x' }],
    });
    expect(bad.status).toBe(422);
    const fields = bad.body.error.issues.map((i: { field: string }) => i.field).sort();
    expect(fields).toEqual(['entries.0.component', 'entries.0.qty', 'entries.0.reference']);
  });
});

describe('Stock-ledger alignment — dry run, apply, re-run, undo', () => {
  it('the dry run accepts exactly the items their entries close, refuses the rest with figures, writes nothing', async () => {
    reconBefore = await recon();
    liveBefore = await allLive();
    const ledgerRows = await count(`SELECT COUNT(*)::int AS n FROM stock_ledger`);
    const res = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.dryRun).toBe(true);
    expect(d.selectionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(d.accepted.map((a: { itemCode: string }) => a.itemCode)).toEqual(['ALN-A', 'ALN-B', 'ALN-D']);
    expect(d.accepted[0]).toMatchObject({ ledgerBalance: '50.0000', entriesNet: '63.0000', liveStock: '113.0000', difference: '0.0000', entries: 3, isActive: true });
    expect(d.accepted[2]).toMatchObject({ entriesNet: '7.4999', liveStock: '7.5000', difference: '0.0001' });
    expect(d.refused).toEqual([
      expect.objectContaining({ itemCode: 'ALN-C', ledgerBalance: '0.0000', entriesNet: '19.0000', liveStock: '20.0000', difference: '1.0000' }),
      expect.objectContaining({ itemId: 99999999, itemCode: null, reason: 'No item has this id.' }),
    ]);
    expect(d.refused[0].reason).toMatch(/a difference is never plugged/);
    expect(d.totals).toMatchObject({ items: 3, activeItems: 2, inactiveItems: 1, entries: 7, net: '100.4999', refused: 2 });
    expect(await count(`SELECT COUNT(*)::int AS n FROM stock_ledger`)).toBe(ledgerRows);
    expect(await alignmentAudits()).toBe(0);
  });

  it('applying needs the typed confirmation and the dry run hash', async () => {
    const noConfirm = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries, dryRun: false });
    expect(noConfirm.status).toBe(422);
    expect(noConfirm.body.error.message).toMatch(/ALIGN STOCK LEDGER/);
    const noHash = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries, dryRun: false, confirm: 'ALIGN STOCK LEDGER' });
    expect(noHash.status).toBe(422);
    expect(noHash.body.error.message).toMatch(/selectionHash/);
    expect(await alignmentRows()).toBe(0);
  });

  it('when the figures move after the dry run (a GRN posted), the apply is refused with 409 and nothing is written', async () => {
    const dry = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries });
    const hash = dry.body.data.selectionHash as string;
    // A receipt of 1 posted in between: stock and ledger both move, the entries still close A exactly.
    await query(
      `INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_no, inward_qty, outward_qty, balance_qty, txn_date)
       VALUES ($1, 'GRN_INWARD', 'GRN', 'ZG/GS/0003', 1, 0, 51, '2026-10-16')`, [ids['ALN-A']],
    );
    await query(`UPDATE items SET live_stock_qty = live_stock_qty + 1 WHERE id = $1`, [ids['ALN-A']]);
    liveBefore['ALN-A'] = '114.0000';
    const ledgerRows = await count(`SELECT COUNT(*)::int AS n FROM stock_ledger`);
    const res = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries, dryRun: false, confirm: 'ALIGN STOCK LEDGER', expectedHash: hash });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/no longer what the dry run showed/);
    expect(res.body.error.details.selectionHash).not.toBe(hash);
    expect(await count(`SELECT COUNT(*)::int AS n FROM stock_ledger`)).toBe(ledgerRows);
    expect(await alignmentRows()).toBe(0);
    expect(await alignmentAudits()).toBe(0);
  });

  it('applies one ledger row per entry with a running balance, never changes live stock, and audits', async () => {
    const dry = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries });
    expect(dry.body.data.accepted).toHaveLength(3);
    const res = await request(app).post(ALIGN).set(auth(adminToken))
      .send({ entries, dryRun: false, confirm: 'ALIGN STOCK LEDGER', expectedHash: dry.body.data.selectionHash });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ dryRun: false, rowsPosted: 7, totals: { items: 3, refused: 2 } });
    const today = (await query<{ d: string }>(`SELECT CURRENT_DATE::text AS d`))[0].d;
    const stamp = today.replace(/-/g, '');

    const rows = await query<{
      item_code: string; txn_type: string; reference_type: string; reference_no: string; inward_qty: string; outward_qty: string;
      balance_qty: string; remarks: string; txn_date: string; created_by: string; uom_id: string;
    }>(
      `SELECT i.item_code, l.txn_type, l.reference_type, l.reference_no, l.inward_qty::text, l.outward_qty::text, l.balance_qty::text,
              l.remarks, l.txn_date::text, l.created_by, l.uom_id
         FROM stock_ledger l JOIN items i ON i.id = l.item_id
        WHERE l.txn_type = 'STOCK_ALIGNMENT' ORDER BY l.id`,
    );
    const a = ids['ALN-A'];
    expect(rows.filter((r) => r.item_code === 'ALN-A').map((r) => [r.reference_no, r.inward_qty, r.outward_qty, r.balance_qty, r.remarks])).toEqual([
      [`ALN-${stamp}-${a}-001`, '100.0000', '0.0000', '151.0000', 'Opening 2026-04-01 - General Item Live Stock!BI1088'],
      [`ALN-${stamp}-${a}-002`, '0.0000', '32.0000', '119.0000', 'Issues May-26 - Issue Register (Store Outward Entry) rows 7,8,9'],
      [`ALN-${stamp}-${a}-003`, '0.0000', '5.0000', '114.0000', 'Adjustment 2026-07-03 - Stock Adjustment row 2 (GENERAL sheet)'],
    ]);
    expect(rows.filter((r) => r.item_code === 'ALN-B').map((r) => [r.balance_qty, r.remarks])).toEqual([
      ['55.0000', 'Opening 2026-04-01 - RM Stock Live!BG655'],
      ['50.0000', 'Issues Sep-26 - RM Outward rows 3555,3893'],
      ['40.0000', 'Reversal of sheet sync run INV-20261016-052733-bdc4 - stock_ledger id 27436'],
    ]);
    expect(new Set(rows.map((r) => [r.reference_type, r.txn_date, Number(r.created_by)].join('|')))).toEqual(new Set([`OPENING_ALIGNMENT|${today}|${adminId}`]));
    expect(Number(rows.find((r) => r.item_code === 'ALN-B')!.uom_id)).toBe(await uomId('KG'));

    // The ledger now explains the stock; the stock itself is exactly what it was.
    expect(await allLive()).toEqual(liveBefore);
    expect(await ledgerOf('ALN-A')).toBe('114.0000');
    expect(await ledgerOf('ALN-B')).toBe('40.0000');
    expect(await ledgerOf('ALN-D')).toBe('7.4999');
    expect(Number(await ledgerOf('ALN-C'))).toBe(0);

    const audits = await query<{ entity_label: string; after_data: { entries?: unknown[]; items?: number } }>(
      `SELECT entity_label, after_data FROM audit_logs WHERE entity = 'stock_alignment' ORDER BY id`,
    );
    expect(audits.map((x) => x.entity_label)).toEqual(['ALN-A', 'ALN-B', 'ALN-D', expect.stringMatching(/^alignment run [0-9a-f]{12}$/)]);
    expect(audits[0].after_data.entries).toHaveLength(3);
    expect(audits[3].after_data.items).toBe(3);

    // A book entry dated today, not stock that moved today: the dashboard's "today" leaves it out.
    const overview = await request(app).get(api('/inventory/overview')).set(auth(adminToken));
    expect(overview.status).toBe(200);
    expect(await count(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE txn_date = CURRENT_DATE AND reference_type = 'OPENING_ALIGNMENT'`)).toBe(7);
    expect(overview.body.data.kpis.todayTxnsCount).toBe(
      await count(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE txn_date = CURRENT_DATE AND reference_type <> 'OPENING_ALIGNMENT'`),
    );
  });

  it('the reconciliation mismatch count falls by exactly the aligned items, active and inactive apart', async () => {
    const after = await recon();
    expect(after.meta.mismatchCount).toBe(reconBefore.meta.mismatchCount - 3);
    expect(after.meta.activeMismatchCount).toBe(reconBefore.meta.activeMismatchCount - 2);
    expect(after.meta.inactiveMismatchCount).toBe(reconBefore.meta.inactiveMismatchCount - 1);
    const row = (code: string) => after.data.find((r: { item_code: string }) => r.item_code === code);
    expect(row('ALN-A')).toMatchObject({ mismatch: false, alignment_net: '63.0000', grn_inward: '51.0000' });
    expect(row('ALN-B')).toMatchObject({ mismatch: false, is_active: false, alignment_net: '30.0000', sheet_sync_net: '10.0000' });
    expect(row('ALN-D').mismatch).toBe(false);
    expect(row('ALN-C').mismatch).toBe(true);
    expect(row('ALN-E')).toMatchObject({ mismatch: false, alignment_net: '0' });
  });

  it('running the same file again aligns nothing', async () => {
    const dry = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries });
    expect(dry.body.data.accepted).toEqual([]);
    const reasons = Object.fromEntries(dry.body.data.refused.map((r: { itemCode: string; reason: string }) => [r.itemCode, r.reason]));
    for (const code of ['ALN-A', 'ALN-B', 'ALN-D']) {
      expect(reasons[code]).toMatch(/^Already aligned on \d{4}-\d{2}-\d{2} \(\d+ OPENING_ALIGNMENT ledger row\(s\) in place\); undo that alignment before aligning the item again\.$/);
    }
    const rowsBefore = await alignmentRows();
    const res = await request(app).post(ALIGN).set(auth(adminToken))
      .send({ entries, dryRun: false, confirm: 'ALIGN STOCK LEDGER', expectedHash: dry.body.data.selectionHash });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/None of these items can be aligned/);
    expect(await alignmentRows()).toBe(rowsBefore);
  });

  it('undo appends the opposite rows, deletes nothing, leaves live stock alone, and is not repeated', async () => {
    const noConfirm = await request(app).post(UNDO).set(auth(adminToken)).send({ itemIds: [ids['ALN-A']], reason: 'Opening figure disputed' });
    expect(noConfirm.status).toBe(422);
    const originals = await query<{ id: string; reference_no: string; inward_qty: string; outward_qty: string }>(
      `SELECT id, reference_no, inward_qty::text, outward_qty::text FROM stock_ledger WHERE item_id = $1 AND txn_type = 'STOCK_ALIGNMENT' ORDER BY id`,
      [ids['ALN-A']],
    );
    const res = await request(app).post(UNDO).set(auth(adminToken))
      .send({ itemIds: [ids['ALN-A'], ids['ALN-C']], reason: 'Opening figure disputed', confirm: 'UNDO STOCK ALIGNMENT' });
    expect(res.status).toBe(200);
    expect(res.body.data.undone).toEqual([{ itemId: ids['ALN-A'], itemCode: 'ALN-A', rowsReversed: 3, net: '-63.0000' }]);
    expect(res.body.data.skipped).toEqual([{ itemId: ids['ALN-C'], itemCode: 'ALN-C', reason: 'It has not been aligned.' }]);

    const rows = await query<{ id: string; reference_id: string | null; reference_no: string; inward_qty: string; outward_qty: string; balance_qty: string; remarks: string }>(
      `SELECT id, reference_id, reference_no, inward_qty::text, outward_qty::text, balance_qty::text, remarks
         FROM stock_ledger WHERE item_id = $1 AND txn_type = 'STOCK_ALIGNMENT' ORDER BY id`,
      [ids['ALN-A']],
    );
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 3).map((r) => r.id)).toEqual(originals.map((o) => o.id));
    expect(rows.slice(3).map((r) => [r.reference_id, r.reference_no, r.inward_qty, r.outward_qty, r.balance_qty])).toEqual([
      [originals[0].id, originals[0].reference_no, '0.0000', '100.0000', '14.0000'],
      [originals[1].id, originals[1].reference_no, '32.0000', '0.0000', '46.0000'],
      [originals[2].id, originals[2].reference_no, '5.0000', '0.0000', '51.0000'],
    ]);
    expect(rows[3].remarks).toBe(`Undo of ${originals[0].reference_no} - Opening figure disputed`);
    expect(await ledgerOf('ALN-A')).toBe('51.0000');
    expect(await allLive()).toEqual(liveBefore);
    const after = await recon();
    expect(after.data.find((r: { item_code: string }) => r.item_code === 'ALN-A')).toMatchObject({ mismatch: true, alignment_net: '0.0000' });

    const again = await request(app).post(UNDO).set(auth(adminToken))
      .send({ itemIds: [ids['ALN-A']], reason: 'Opening figure disputed', confirm: 'UNDO STOCK ALIGNMENT' });
    expect(again.status).toBe(422);
    expect(again.body.error.details.skipped[0].reason).toBe('Its alignment has already been undone.');
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'stock_alignment' AND action = 'CANCEL'`)).toBe(1);
  });

  // An undone alignment no longer blocks the item (2026-10-17 review): counting every
  // original row left a disputed, undone item unalignable for good.
  it('after an undo the item is aligned again from corrected evidence, once, and can be undone again', async () => {
    const corrected: Entry[] = [
      { itemId: ids['ALN-A'], component: 'OPENING', qty: 101, reference: '2026-04-01', evidence: 'General Item Live Stock!BI1088 (corrected)' },
      { itemId: ids['ALN-A'], component: 'SHEET_ISSUES', qty: -33, reference: 'May-26', evidence: 'Issue Register (Store Outward Entry) rows 7,8,9,10' },
      { itemId: ids['ALN-A'], component: 'SHEET_ADJUSTMENT', qty: -5, reference: '2026-07-03', evidence: 'Stock Adjustment row 2 (GENERAL sheet)' },
    ];
    const dry = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries: corrected });
    expect(dry.status).toBe(200);
    expect(dry.body.data.refused).toEqual([]);
    expect(dry.body.data.accepted).toEqual([
      expect.objectContaining({ itemCode: 'ALN-A', ledgerBalance: '51.0000', entriesNet: '63.0000', liveStock: '114.0000', difference: '0.0000', entries: 3 }),
    ]);
    const res = await request(app).post(ALIGN).set(auth(adminToken))
      .send({ entries: corrected, dryRun: false, confirm: 'ALIGN STOCK LEDGER', expectedHash: dry.body.data.selectionHash });
    expect(res.status).toBe(200);
    expect(res.body.data.rowsPosted).toBe(3);
    expect(await ledgerOf('ALN-A')).toBe('114.0000');
    expect(await allLive()).toEqual(liveBefore);
    const row = (await recon()).data.find((r: { item_code: string }) => r.item_code === 'ALN-A');
    expect(row).toMatchObject({ mismatch: false, alignment_net: '63.0000' });

    // In place again: refused until undone, naming only the rows still in place.
    const rerun = await request(app).post(ALIGN).set(auth(adminToken)).send({ entries: corrected });
    expect(rerun.body.data.accepted).toEqual([]);
    expect(rerun.body.data.refused[0].reason).toMatch(/^Already aligned on \d{4}-\d{2}-\d{2} \(3 OPENING_ALIGNMENT ledger row\(s\) in place\)/);
    // A second undo reverses the new rows only; the first three stay reversed once.
    const undo = await request(app).post(UNDO).set(auth(adminToken))
      .send({ itemIds: [ids['ALN-A']], reason: 'Checking the second alignment', confirm: 'UNDO STOCK ALIGNMENT' });
    expect(undo.status).toBe(200);
    expect(undo.body.data.undone).toEqual([{ itemId: ids['ALN-A'], itemCode: 'ALN-A', rowsReversed: 3, net: '-63.0000' }]);
    expect(await ledgerOf('ALN-A')).toBe('51.0000');
    expect(await count(`SELECT COUNT(*)::int AS n FROM stock_ledger WHERE item_id = $1 AND txn_type = 'STOCK_ALIGNMENT'`, [ids['ALN-A']])).toBe(12);
  });
});

/* ── The Purchase stock counts the Item Master's unit only ──────────────────── */

/** An RM spreadsheet with a stock tab and empty movement tabs ('RM Stock Live' counts in Kg). */
function rmReader(lines: Array<{ code: string; live: number }>) {
  return async (cfg: CategorySheetConfig): Promise<CategoryRead> => ({
    stockMain: [
      ['Sr.No', 'Item Code', 'Item Name', '', 'Main Group', 'Rack', 'Live Stock (Kg)', 'Amount'],
      ...lines.map((l, i) => [i + 1, l.code, `${l.code} name`, '', 'Copper', 'R-1', l.live, ''] as Row),
    ],
    stockOpening: [['Opening Stock'], ...lines.map((l) => [l.live] as Row)],
    stockAdjustment: [['Stock Adjustment'], ...lines.map(() => [0] as Row)],
    movements: cfg.movements.map(() => []),
    adjustments: [],
    ranges: rangesFor(cfg),
  });
}

describe('Purchase stock across sheets (SLR-4)', () => {
  it('adds only the sheets that count the Item Master unit: PTC4/0 is 264.75 Kg, not 1,736.75', async () => {
    const kg = await uomId('KG');
    const ptc = Number((await query<{ id: string }>(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ('PTC4/0-T', 'Copper strip', 'RM', 0, TRUE, $1) RETURNING id`, [kg],
    ))[0].id);
    await query(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ('CHM086-T', 'Chemical', 'RM', 3, TRUE, $1)`, [await uomId('LTR')],
    );
    // The WIP sheet lists the same code in pieces ('WIP  Stock Live'!K184 in production).
    await query(
      `INSERT INTO inventory_items (item_id, item_code, item_description, category, primary_uom, live_stock_qty,
                                    source_tab, source_row_index, source_spreadsheet_id)
       VALUES ($1, 'PTC4/0-T', 'Copper strip', 'WIP', 'Nos', 1472, 'WIP  Stock Live', 184, 'test')`, [ptc],
    );

    const r = await syncCategory('RM', { reader: rmReader([{ code: 'PTC4/0-T', live: 264.75 }, { code: 'CHM086-T', live: 80 }]), userId: null });
    expect(r.status).toBe('SUCCESS');
    expect(await liveOf('PTC4/0-T')).toBe('264.7500');
    expect(await liveOf('CHM086-T')).toBe('3.0000');
    expect(r.purchaseStock.unitMismatches).toEqual([
      { itemCode: 'PTC4/0-T', itemUom: 'KG', leftOut: 'WIP Nos 1472', aligned: true },
      { itemCode: 'CHM086-T', itemUom: 'LTR', leftOut: 'RM Kg 80', aligned: false },
    ]);
    const ledger = await query<{ item_code: string; txn_type: string; inward_qty: string }>(
      `SELECT i.item_code, l.txn_type, l.inward_qty::text FROM stock_ledger l JOIN items i ON i.id = l.item_id
        WHERE i.item_code IN ('PTC4/0-T', 'CHM086-T') ORDER BY l.id`,
    );
    expect(ledger).toEqual([{ item_code: 'PTC4/0-T', txn_type: 'SHEET_SYNC', inward_qty: '264.7500' }]);
    const notes = await query<{ item_code: string; recon_note: string | null }>(
      `SELECT item_code, recon_note FROM inventory_items WHERE category = 'RM' ORDER BY item_code`,
    );
    expect(notes).toEqual([
      { item_code: 'CHM086-T', recon_note: 'Not counted in the Purchase stock: this sheet counts Kg, the Item Master unit is LTR.' },
      { item_code: 'PTC4/0-T', recon_note: null },
    ]);
  });

  // 2026-10-17 review: sameUnit refused every item with no Item Master unit, so an item
  // created without one stopped following the only sheet that lists it.
  it('an item with no Item Master unit follows a sheet when nothing is mixed; different units count none', async () => {
    await query(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ('NOUNIT-1-T', 'No unit, one sheet', 'RM', 0, TRUE, NULL)`,
    );
    const mixed = Number((await query<{ id: string }>(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ('NOUNIT-2-T', 'No unit, two sheets', 'RM', 5, TRUE, NULL) RETURNING id`,
    ))[0].id);
    await query(
      `INSERT INTO inventory_items (item_id, item_code, item_description, category, primary_uom, live_stock_qty,
                                    source_tab, source_row_index, source_spreadsheet_id)
       VALUES ($1, 'NOUNIT-2-T', 'No unit, two sheets', 'WIP', 'Nos', 40, 'WIP  Stock Live', 185, 'test')`, [mixed],
    );

    const r = await syncCategory('RM', {
      reader: rmReader([
        { code: 'PTC4/0-T', live: 264.75 }, { code: 'CHM086-T', live: 80 },
        { code: 'NOUNIT-1-T', live: 25 }, { code: 'NOUNIT-2-T', live: 12 },
      ]),
      userId: null,
    });
    expect(r.status).toBe('SUCCESS');
    expect(await liveOf('NOUNIT-1-T')).toBe('25.0000');
    expect(await liveOf('NOUNIT-2-T')).toBe('5.0000');
    expect(r.purchaseStock.unitMismatches).toContainEqual({ itemCode: 'NOUNIT-2-T', itemUom: null, leftOut: 'RM Kg 12, WIP Nos 40', aligned: false });
    expect(r.purchaseStock.unitMismatches.map((m) => m.itemCode)).not.toContain('NOUNIT-1-T');
    const notes = Object.fromEntries((await query<{ item_code: string; recon_note: string | null }>(
      `SELECT item_code, recon_note FROM inventory_items WHERE category = 'RM' AND item_code LIKE 'NOUNIT-%'`,
    )).map((n) => [n.item_code, n.recon_note]));
    expect(notes).toEqual({
      'NOUNIT-1-T': null,
      'NOUNIT-2-T': 'Not counted in the Purchase stock: the Item Master has no unit and the sheets count this code in different units (Kg, Nos).',
    });
  });
});

/* ── The reconciliation report: every ledger entry type in exactly one column ── */

describe('Stock reconciliation columns', () => {
  it('each txn_type the stock_ledger CHECK allows lands in exactly one column', async () => {
    const { RECONCILIATION_COLUMNS } = await import('../modules/masters/item.routes.js');
    const def = (await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_stock_ledger_type'`,
    ))[0].def;
    const allowed = [...def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toHaveLength(14);
    // Equal as sorted lists: every allowed type is mapped, none twice, nothing unknown.
    expect(RECONCILIATION_COLUMNS.flatMap((c) => [...c.types]).sort()).toEqual(allowed);
  });

  it('nets each column over both quantity columns, so the columns add up to the computed balance', async () => {
    const { RECONCILIATION_COLUMNS } = await import('../modules/masters/item.routes.js');
    const id = Number((await query<{ id: string }>(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active)
       VALUES ('RECON-ALL-T', 'Every ledger type', 'GENERAL', 17, TRUE) RETURNING id`,
    ))[0].id);
    // One row of every type; some carry the "other" quantity column too.
    const rows: Array<[string, string, number, number]> = [
      ['GRN_INWARD', 'GRN', 10, 0], ['GRN_INWARD', 'GRN', 0, 1], ['GRN_REVERSAL', 'GRN', 0, 2],
      ['REQUISITION_ISSUE', 'REQUISITION', 0, 3], ['REQUISITION_REVERSAL', 'REQUISITION', 1, 0],
      ['DIRECT_ISSUE', 'DIRECT_ISSUE', 0, 4], ['DIRECT_ISSUE_REVERSAL', 'DIRECT_ISSUE', 2, 0],
      ['STOCK_ADJUSTMENT', 'STOCK_ADJUSTMENT', 5, 0], ['STOCK_ADJUSTMENT_REVERSAL', 'STOCK_ADJUSTMENT', 0, 5],
      ['INVENTORY_IN', 'INVENTORY', 7, 0], ['INVENTORY_OUT', 'INVENTORY', 0, 2], ['INVENTORY_ADJUST', 'INVENTORY', 0, 1],
      ['INVENTORY_REVERSAL', 'INVENTORY', 2, 0], ['SHEET_SYNC', 'INVENTORY_SYNC', 6, 0],
      ['STOCK_ALIGNMENT', 'OPENING_ALIGNMENT', 3, 0], ['STOCK_ALIGNMENT', 'OPENING_ALIGNMENT', 0, 1],
    ];
    let balance = 0;
    for (const [type, refType, inward, outward] of rows) {
      balance += inward - outward;
      await query(
        `INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_no, inward_qty, outward_qty, balance_qty, txn_date)
         VALUES ($1, $2, $3, 'RECON-ALL', $4, $5, $6, '2026-10-17')`,
        [id, type, refType, inward, outward, balance],
      );
    }
    const res = await request(app).get(api('/items/analysis/stock-reconciliation')).query({ search: 'RECON-ALL-T' }).set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = res.body.data[0];
    expect(row).toMatchObject({
      grn_inward: '9.0000', grn_reversal: '2.0000', requisition_issue: '3.0000', requisition_reversal: '1.0000',
      direct_issue_net: '-2.0000', adjustment_net: '0.0000', inventory_net: '6.0000', sheet_sync_net: '6.0000',
      alignment_net: '2.0000', computed_balance: '17.0000', current_stock: '17.0000', mismatch: false,
    });
    const signed = RECONCILIATION_COLUMNS.reduce((sum, c) => sum + (c.outward ? -1 : 1) * Number(row[c.key]), 0);
    expect(signed).toBeCloseTo(Number(row.computed_balance), 4);
  });
});
