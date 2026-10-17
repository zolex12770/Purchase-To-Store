/**
 * Integration tests — inventory Google Sheet sync integrity (2026-10-16 audit).
 *
 * Pins the defects found by reading the five live spreadsheets and comparing them
 * with the database:
 *
 *   1. Movements were identified by row number: inserting or deleting a sheet row
 *      left stale or duplicated movements. Identity is now the row's content.
 *   2. Rows whose verified quantity was blank were imported from the UNVERIFIED
 *      column (FG/Trading/WIP) or even Order Qty (General) — the sheets count
 *      verified quantities only.
 *   3. Rows outside the sheet's counted months, for codes the stock tab does not
 *      list, or with no date were imported (with today's date invented); they are
 *      now reported, not counted.
 *   4. Opening stock was taken from the live stock at the first sync; the Stock
 *      Adjustment tabs were ignored — so no item could ever be proven.
 *   5. Quarantine grew by the same rows on every run.
 *   6. The sync overwrote items.live_stock_qty with no ledger entry, and a manual
 *      inventory movement overwrote it with the category figure and ledgered an
 *      inward as "GRN_INWARD".
 *   7. Backups left out every inventory table, and restoring onto a database that
 *      held inventory data failed on the items foreign key.
 *   8. The Purchase stock added a code's figures from every sheet whatever their
 *      unit (PTC4/0, a KG item: 1,472 WIP Nos + 264.75 RM Kg = 1,736.75); only the
 *      Item Master's unit counts now.
 *
 * Real PGlite database, migrated and seeded from scratch; the Google read is
 * replaced by in-memory sheet contents (the engine's `reader` option).
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
let syncGeneral: typeof import('../modules/inventory/sync-engine.js')['syncCategoryFromSheet'];
let rangesFor: typeof import('../modules/inventory/sync-engine.js')['rangesFor'];
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (path: string) => `/api/v1${path}`;

const GRN_TAB = 'GRN Register (Store Inward Entry)';
const ISS_TAB = 'Issue Register (Store Outward Entry)';

/* ── In-memory General Stores spreadsheet ───────────────────────────────────── */

interface StockLine { code: string; opening: number; live: number | string; adj?: number; uom?: string }
function grn(month: string, no: string, date: string, code: string, qty: number | string, rate = 2): Row {
  const r: Row = new Array(21).fill('');
  r[2] = month; r[4] = no; r[5] = date; r[6] = 'Test Supplier'; r[7] = `BILL-${no}`; r[9] = code;
  r[10] = `${code} description`; r[15] = 'Nos'; r[17] = rate; r[18] = qty;
  return r;
}
function iss(no: string, date: string, code: string, qty: number | string, month: string): Row {
  const r: Row = new Array(18).fill('');
  r[1] = no; r[3] = date; r[4] = 'Consumption - Issue'; r[6] = code; r[7] = `${code} description`;
  r[9] = 'General Store'; r[11] = 'Maintenance'; r[13] = qty; r[14] = 'Nos'; r[17] = month;
  return r;
}
function adj(date: string, code: string, qty: number, approval = 'Approved'): Row {
  return [1, date, 'Stock Audit Gap', code, `${code} name`, 0, 0, qty, approval, 'Monthly stock reco', ''];
}

class Sheet {
  stock: StockLine[] = [];
  grn: Row[] = [];
  issues: Row[] = [];
  adjustments: Row[] = [];
  reader = async (cfg: CategorySheetConfig): Promise<CategoryRead> => ({
    stockMain: [
      ['Sr.No', 'Item Code', 'Item Name', 'Main Group', 'Unit', 'Rack Line ID', 'Rack ID', 'Live Stock (Qty)', 'Amount'],
      ...this.stock.map((s, i) => [i + 1, s.code, `${s.code} name`, 'Test Group', s.uom ?? 'Nos', '', 'R-1', s.live, ''] as Row),
    ],
    stockOpening: [['Opening Stock(Qty)'], ...this.stock.map((s) => [s.opening] as Row)],
    stockAdjustment: [['Stock Adjustment'], ...this.stock.map((s) => [s.adj ?? 0] as Row)],
    movements: [this.grn, this.issues],
    adjustments: this.adjustments,
    ranges: rangesFor(cfg),
  });
}

const sheet = new Sheet();
const sync = (extra: Record<string, unknown> = {}) => syncGeneral('GENERAL', { reader: sheet.reader, userId: null, ...extra });
const tab = (r: Awaited<ReturnType<typeof sync>>, name: string) => r.tabs.find((t) => t.tab === name)!;
const itemStock = async (code: string) =>
  Number((await query<{ q: string }>(`SELECT live_stock_qty AS q FROM items WHERE item_code = $1 AND deleted_at IS NULL`, [code]))[0]?.q);
const uomId = async (code: string) =>
  Number((await query<{ id: string }>(`SELECT id FROM lookups WHERE category = 'UOM' AND code = $1`, [code]))[0].id);
const posted = async (tabName: string) =>
  (await query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM inventory_transactions WHERE category = 'GENERAL' AND source_tab = $1 AND status = 'POSTED'`,
    [tabName],
  ))[0].n;

function baseline(): void {
  // A: 100 opening + 50 in − 30 − 1 − 1 out − 5 adjustment = 113.
  sheet.stock = [
    { code: 'TSYNC-A', opening: 100, live: 113, adj: -5 },
    { code: 'TSYNC-B', opening: 0, live: 0 },
    { code: 'TSYNC-C', opening: 5, live: 5 },
    { code: 'TSYNC-D', opening: 0, live: -3 },
  ];
  sheet.grn = [
    grn('Apr-26', 'GRN-1', '01-04-26', 'TSYNC-A', 50),           // row 8
    grn('Mar-26', 'GRN-2', '15-03-26', 'TSYNC-B', 10),           // row 9 — month not counted by the sheet
    grn('Apr-26', 'GRN-3', '02-04-26', 'ZZZ-NOT-LISTED', 7),     // row 10 — code not in the stock tab
    [],                                                          // row 11 — blank
  ];
  sheet.issues = [
    iss('ISS-1', '05-05-26', 'TSYNC-A', 30, 'May-26'),           // row 7
    iss('ISS-2', '06-05-26', 'TSYNC-A', 1, 'May-26'),            // row 8
    iss('ISS-2', '06-05-26', 'TSYNC-A', 1, 'May-26'),            // row 9 — identical, a real second issue
    iss('ISS-3', '07-05-26', 'TSYNC-A', '', 'May-26'),           // row 10 — zero quantity
    iss('ISS-4', '08-04-26', 'TSYNC-D', 3, 'Apr-26'),            // row 11
  ];
  sheet.adjustments = [adj('03-Jul-26', 'TSYNC-A', -5)];
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
  syncGeneral = engine.syncCategoryFromSheet;
  rangesFor = engine.rangesFor;

  app = createApp();
  const login = await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' });
  adminToken = login.body.data.accessToken;

  // Purchase item master holds A, B and D — not C (a code only the inventory sheet knows).
  // The sheet counts them in Nos; B's Item Master unit PCS is the same counted unit.
  for (const [code, uom] of [['TSYNC-A', 'NOS'], ['TSYNC-B', 'PCS'], ['TSYNC-D', 'NOS']]) {
    await query(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ($1, $2, 'GENERAL', 0, TRUE, $3)`,
      [code, `${code} purchase item`, await uomId(uom)],
    );
  }
  baseline();
  // Two rows imported by the previous engine (row-number identity, no source key): one
  // still matches the sheet, one was imported although the sheet does not count it.
  for (const [no, code, qty, date, row] of [['R8', 'TSYNC-A', 50, '2026-04-01', 8], ['R9', 'TSYNC-B', 10, '2026-03-15', 9]] as const) {
    await query(
      `INSERT INTO inventory_transactions (txn_no, category, item_code, txn_type, direction, quantity, uom,
         balance_qty_after, source_tab, source_row_index, status, txn_date, origin, created_by_name)
       VALUES ($1, 'GENERAL', $2, 'GRN_INWARD', 'IN', $3, 'Nos', 0, $4, $5, 'POSTED', $6, 'SHEET', 'Google Sheet Sync')`,
      [`GS-GENERAL-GRN-${no}`, code, qty, GRN_TAB, row, date],
    );
  }
});

afterAll(async () => {
  await closeDb?.();
});

describe('Inventory sheet sync — counted exactly as the sheet counts', () => {
  it('first run: adopts matching legacy rows, reverses uncounted ones, proves every item', async () => {
    const r = await sync();
    expect(r.status).toBe('SUCCESS');
    const g = tab(r, GRN_TAB);
    expect(g.validRows).toBe(1);
    expect(g.inserted).toBe(0);           // row 8 adopted, not duplicated
    expect(g.reversed).toBe(1);           // the Mar-26 row imported by the old engine
    expect(g.blankRows).toBe(1);
    expect(g.excluded).toMatchObject({ MONTH_NOT_COUNTED: 1, ITEM_NOT_IN_STOCK_SHEET: 1 });
    const i = tab(r, ISS_TAB);
    expect(i.inserted).toBe(4);           // identical rows 8 and 9 are two real issues
    expect(i.excluded).toMatchObject({ ZERO_QTY: 1 });
    expect(tab(r, 'Stock Adjustment').inserted).toBe(1);

    const reversed = await query<{ txn_no: string; reversal_reason: string }>(
      `SELECT txn_no, reversal_reason FROM inventory_transactions WHERE status = 'REVERSED'`,
    );
    expect(reversed.map((x) => x.txn_no)).toEqual(['GS-GENERAL-GRN-R9']);
    expect(reversed[0].reversal_reason).toMatch(/Not counted by the sheet: .*Month/);
    const adopted = await query<{ source_key: string | null }>(`SELECT source_key FROM inventory_transactions WHERE txn_no = 'GS-GENERAL-GRN-R8'`);
    expect(adopted[0].source_key).toBeTruthy();

    expect(r.reconciliation).toMatchObject({ checked: 4, matched: 4, mismatched: 0 });
    const items = await query<{ item_code: string; opening_stock_qty: string; live_stock_qty: string; computed_stock_qty: string; recon_status: string; item_id: string | null }>(
      `SELECT item_code, opening_stock_qty, live_stock_qty, computed_stock_qty, recon_status, item_id
         FROM inventory_items WHERE category = 'GENERAL' AND item_code LIKE 'TSYNC-%' ORDER BY item_code`,
    );
    expect(items.map((x) => [x.item_code, Number(x.opening_stock_qty), Number(x.live_stock_qty), x.recon_status])).toEqual([
      ['TSYNC-A', 100, 113, 'MATCHED'], ['TSYNC-B', 0, 0, 'MATCHED'], ['TSYNC-C', 5, 5, 'MATCHED'], ['TSYNC-D', 0, -3, 'MATCHED'],
    ]);
    // C is not a Purchase item: linked to nothing, and NOT inserted into the item master.
    expect(items.find((x) => x.item_code === 'TSYNC-C')!.item_id).toBeNull();
    expect((await query(`SELECT 1 FROM items WHERE item_code IN ('TSYNC-C', 'ZZZ-NOT-LISTED')`)).length).toBe(0);
  });

  it('Purchase stock follows the sheet and every change is ledgered (negative held at zero, reported)', async () => {
    expect(await itemStock('TSYNC-A')).toBe(113);
    expect(await itemStock('TSYNC-D')).toBe(0);
    const ledger = await query<{ item_code: string; txn_type: string; inward_qty: string; outward_qty: string; balance_qty: string }>(
      `SELECT i.item_code, l.txn_type, l.inward_qty, l.outward_qty, l.balance_qty
         FROM stock_ledger l JOIN items i ON i.id = l.item_id ORDER BY l.id`,
    );
    expect(ledger.map((l) => [l.item_code, l.txn_type, Number(l.inward_qty), Number(l.balance_qty)])).toEqual([
      ['TSYNC-A', 'SHEET_SYNC', 113, 113],
    ]);
    const recon = await request(app).get(api('/items/analysis/stock-reconciliation')).query({ search: 'TSYNC-A' }).set(auth(adminToken));
    expect(recon.status).toBe(200);
    expect(recon.body.data[0].mismatch).toBe(false);
  });

  it('quarantine holds one open entry per problem row; KPIs separate sheet rows from ERP entries', async () => {
    const open = await query<{ reason_code: string }>(
      `SELECT reason_code FROM inventory_quarantine WHERE category = 'GENERAL' AND resolution_status = 'PENDING' ORDER BY reason_code`,
    );
    expect(open.map((o) => o.reason_code)).toEqual(['ITEM_NOT_IN_STOCK_SHEET', 'MONTH_NOT_COUNTED', 'NEGATIVE_STOCK']);
    const summary = await request(app).get(api('/inventory/categories/GENERAL/summary')).set(auth(adminToken));
    expect(summary.status).toBe(200);
    expect(summary.body.data.stats).toMatchObject({
      inwardTxnCount: 1, sheetInwardTxnCount: 1, erpInwardTxnCount: 0,
      outwardTxnCount: 4, adjustmentTxnCount: 1, reversedTxnCount: 1,
      quarantinedCount: 3, reconMismatchCount: 0,
    });
    const q = await request(app).get(api('/inventory/quarantine')).query({ category: 'GENERAL' }).set(auth(adminToken));
    expect(q.body.meta.total).toBe(3);
  });

  it('a second run with the same sheet changes nothing', async () => {
    const before = await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stock_ledger`);
    const r = await sync();
    for (const t of r.tabs.filter((x) => x.kind !== 'STOCK')) {
      expect([t.tab, t.inserted, t.reversed]).toEqual([t.tab, 0, 0]);
    }
    expect((await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM stock_ledger`))[0].n).toBe(before[0].n);
    expect((await query(`SELECT 1 FROM inventory_quarantine WHERE resolution_status = 'PENDING'`)).length).toBe(3);
  });

  it('a row inserted at the top of a tab adds one movement and duplicates nothing', async () => {
    sheet.grn.unshift(grn('Jun-26', 'GRN-0', '10-06-26', 'TSYNC-A', 20));
    sheet.stock[0].live = 133;
    const r = await sync();
    expect(tab(r, GRN_TAB)).toMatchObject({ inserted: 1, reversed: 0 });
    expect(await posted(GRN_TAB)).toBe(2);
    expect(r.reconciliation.mismatched).toBe(0);
    expect(await itemStock('TSYNC-A')).toBe(133);
  });

  it('deleting one of two identical rows reverses exactly one movement, with a reason', async () => {
    sheet.issues.splice(2, 1);
    sheet.stock[0].live = 134;
    const r = await sync();
    expect(tab(r, ISS_TAB)).toMatchObject({ inserted: 0, reversed: 1 });
    expect(await posted(ISS_TAB)).toBe(3);
    expect(r.reconciliation.mismatched).toBe(0);
    const rev = await query<{ reversal_reason: string }>(
      `SELECT reversal_reason FROM inventory_transactions WHERE source_tab = $1 AND status = 'REVERSED'`, [ISS_TAB],
    );
    expect(rev[0].reversal_reason).toMatch(/No longer in the sheet/);
  });

  it('editing a quantity reverses the old movement and posts the corrected one', async () => {
    sheet.grn[1][18] = 40;  // GRN-1: 50 → 40
    sheet.stock[0].live = 124;
    const r = await sync();
    expect(tab(r, GRN_TAB)).toMatchObject({ inserted: 1, reversed: 1 });
    expect(r.reconciliation.mismatched).toBe(0);
    expect(await itemStock('TSYNC-A')).toBe(124);
  });

  it('a row awaiting verification is reported, and counted once the verified quantity is filled', async () => {
    // The General tab has no unverified column; a blank verified quantity is simply not counted.
    sheet.grn.push(grn('Jul-26', 'GRN-5', '01-07-26', 'TSYNC-B', ''));
    let r = await sync();
    expect(tab(r, GRN_TAB).excluded.ZERO_QTY).toBe(1);
    sheet.grn[sheet.grn.length - 1][18] = 4;
    sheet.stock[1].live = 4;
    r = await sync();
    expect(tab(r, GRN_TAB).inserted).toBe(1);
    expect(r.reconciliation.mismatched).toBe(0);
  });

  it('correcting the Month cell closes the quarantine entry and counts the row', async () => {
    sheet.grn[2][2] = 'Apr-26';  // GRN-2 for TSYNC-B, was Mar-26
    sheet.stock[1].live = 14;
    const r = await sync();
    expect(tab(r, GRN_TAB).inserted).toBe(1);
    const q = await query<{ resolution_status: string; resolution_note: string }>(
      `SELECT resolution_status, resolution_note FROM inventory_quarantine WHERE reason_code = 'MONTH_NOT_COUNTED' AND source_key IS NOT NULL`,
    );
    expect(q.map((x) => x.resolution_status)).toEqual(['RESOLVED']);
    expect(r.reconciliation.mismatched).toBe(0);
  });

  it('a sheet figure that the rows do not explain is reported item by item', async () => {
    sheet.stock[2].live = 9;  // C: opening 5, no movements — the sheet now says 9
    const r = await sync();
    expect(r.reconciliation.mismatched).toBe(1);
    expect(r.reconciliation.mismatches[0]).toMatchObject({ itemCode: 'TSYNC-C', sheetLive: 9, computed: 5, difference: 4 });
    const rec = await request(app).get(api('/inventory/reconciliation')).query({ category: 'GENERAL' }).set(auth(adminToken));
    expect(rec.status).toBe(200);
    expect(rec.body.data.map((x: { item_code: string }) => x.item_code)).toEqual(['TSYNC-C']);
    sheet.stock[2].live = 5;
    expect((await sync()).reconciliation.mismatched).toBe(0);
  });

  it('safety valve: a tab that suddenly loses most of its rows is left untouched until confirmed', async () => {
    // Enough movements that a mass disappearance trips the valve (> 50 and > 20 %).
    for (let k = 0; k < 60; k += 1) sheet.issues.push(iss(`ISS-B${k}`, '09-05-26', 'TSYNC-B', 1, 'May-26'));
    sheet.stock[1].live = 14 - 60;
    let r = await sync();
    expect(r.reconciliation.mismatched).toBe(0);
    const kept = sheet.issues;
    sheet.issues = kept.slice(0, 2);
    r = await sync();
    expect(r.status).toBe('PARTIAL');
    expect(tab(r, ISS_TAB)).toMatchObject({ status: 'BLOCKED', reversed: 0 });
    expect(await posted(ISS_TAB)).toBe(63);
    // Dry run of the confirmed apply changes nothing either.
    r = await sync({ dryRun: true, applyLargeChanges: true });
    expect(r.dryRun).toBe(true);
    expect(tab(r, ISS_TAB).reversed).toBe(61);
    expect(await posted(ISS_TAB)).toBe(63);
    sheet.issues = kept;
    expect((await sync()).status).toBe('SUCCESS');
  });

  it('a second sync while one is running is refused with 409', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const slow = syncGeneral('GENERAL', { reader: async (cfg) => { await gate; return sheet.reader(cfg); } });
    const res = await request(app).post(api('/inventory/sync/GENERAL')).set(auth(adminToken)).send({});
    expect(res.status).toBe(409);
    release();
    expect((await slow).status).toBe('SUCCESS');
  });
});

describe('Inventory movements entered in the ERP', () => {
  it('moves the Purchase stock by the same difference and ledgers it under its own type, audited', async () => {
    const itemId = Number((await query<{ id: string }>(`SELECT id FROM items WHERE item_code = 'TSYNC-A'`))[0].id);
    const before = await itemStock('TSYNC-A');
    const res = await request(app).post(api('/inventory/categories/GENERAL/transactions')).set(auth(adminToken))
      .send({ itemId, txnType: 'PURCHASE_RECEIPT', direction: 'IN', quantity: 7, uom: 'Nos' });
    expect(res.status).toBe(201);
    expect(await itemStock('TSYNC-A')).toBe(before + 7);
    const last = await query<{ txn_type: string; inward_qty: string; reference_no: string }>(
      `SELECT txn_type, inward_qty, reference_no FROM stock_ledger ORDER BY id DESC LIMIT 1`,
    );
    expect(last[0]).toMatchObject({ txn_type: 'INVENTORY_IN', reference_no: res.body.data.txnNo });
    expect(Number(last[0].inward_qty)).toBe(7);
    const audit = await query(`SELECT 1 FROM audit_logs WHERE entity = 'inventory_movement' AND entity_label = $1`, [res.body.data.txnNo]);
    expect(audit.length).toBe(1);
    const summary = await request(app).get(api('/inventory/categories/GENERAL/summary')).set(auth(adminToken));
    expect(summary.body.data.stats.erpInwardTxnCount).toBe(1);
    // The next sync brings the Purchase stock back to the sheet figure — as a ledgered SHEET_SYNC entry.
    await sync();
    expect(await itemStock('TSYNC-A')).toBe(before);
    const recon = await request(app).get(api('/items/analysis/stock-reconciliation')).query({ search: 'TSYNC-A' }).set(auth(adminToken));
    expect(recon.body.data[0].mismatch).toBe(false);
  });

  it('refuses a movement for a code that is not in the Purchase item master', async () => {
    const res = await request(app).post(api('/inventory/categories/GENERAL/transactions')).set(auth(adminToken))
      .send({ itemId: 999999, txnType: 'X', direction: 'IN', quantity: 1, uom: 'Nos' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not in the Purchase item master/);
  });
});

describe('Purchase stock counts the Item Master unit only', () => {
  it('a sheet that counts the code in another unit is reported and leaves the Purchase stock as it is', async () => {
    await query(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active, uom_id)
       VALUES ('TSYNC-U', 'TSYNC-U purchase item', 'GENERAL', 2, TRUE, $1)`,
      [await uomId('KG')],
    );
    sheet.stock.push({ code: 'TSYNC-U', opening: 5, live: 5, uom: 'Nos' });
    const r = await sync();
    expect(r.reconciliation.mismatched).toBe(0);
    expect(await itemStock('TSYNC-U')).toBe(2);
    expect(r.purchaseStock.unitMismatches).toEqual([{ itemCode: 'TSYNC-U', itemUom: 'KG', leftOut: 'GENERAL Nos 5', aligned: false }]);
    const row = await query<{ recon_status: string; recon_note: string }>(
      `SELECT recon_status, recon_note FROM inventory_items WHERE category = 'GENERAL' AND item_code = 'TSYNC-U'`,
    );
    expect(row[0].recon_status).toBe('MATCHED');
    expect(row[0].recon_note).toBe('Not counted in the Purchase stock: this sheet counts Nos, the Item Master unit is KG.');
    const ledger = await query(`SELECT 1 FROM stock_ledger l JOIN items i ON i.id = l.item_id WHERE i.item_code = 'TSYNC-U'`);
    expect(ledger.length).toBe(0);
    const checkpoint = await query<{ report: { purchaseStock: { unitMismatches: unknown[] } } }>(
      `SELECT report FROM inventory_sync_checkpoints WHERE run_id = $1 AND tab_name = '(all tabs)'`, [r.runId],
    );
    expect(checkpoint[0].report.purchaseStock.unitMismatches).toHaveLength(1);
  });

  it('once the Item Master unit is corrected, the next run aligns the item, ledgered', async () => {
    await query(`UPDATE items SET uom_id = $1 WHERE item_code = 'TSYNC-U'`, [await uomId('NOS')]);
    const r = await sync();
    expect(r.purchaseStock.unitMismatches).toEqual([]);
    expect(await itemStock('TSYNC-U')).toBe(5);
    const ledger = await query<{ txn_type: string; inward_qty: string; balance_qty: string }>(
      `SELECT l.txn_type, l.inward_qty, l.balance_qty FROM stock_ledger l JOIN items i ON i.id = l.item_id WHERE i.item_code = 'TSYNC-U'`,
    );
    expect(ledger.map((l) => [l.txn_type, Number(l.inward_qty), Number(l.balance_qty)])).toEqual([['SHEET_SYNC', 3, 5]]);
    const note = await query<{ recon_note: string | null }>(
      `SELECT recon_note FROM inventory_items WHERE category = 'GENERAL' AND item_code = 'TSYNC-U'`,
    );
    expect(note[0].recon_note).toBeNull();
  });
});

describe('Backup and restore cover the inventory tables', () => {
  it('a backup taken now restores onto a database that holds inventory data', async () => {
    const { collectBackupData, restoreFromPayload, BACKUP_TABLES } = await import('../db/restore.js');
    const { withTransaction } = await import('../db/index.js');
    for (const t of ['inventory_items', 'inventory_transactions', 'inventory_sync_checkpoints', 'inventory_quarantine', 'stock_adjustments']) {
      expect(BACKUP_TABLES).toContain(t);
    }
    const { data, counts } = await collectBackupData((sql) => query(sql));
    expect(counts.inventory_transactions).toBeGreaterThan(0);
    const result = await withTransaction((tx) => restoreFromPayload(tx, { data }));
    expect(result.notInBackup).toEqual([]);
    for (const t of ['inventory_items', 'inventory_transactions', 'inventory_quarantine', 'stock_ledger', 'items']) {
      const n = (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${t}`))[0].n;
      expect([t, n]).toEqual([t, counts[t]]);
    }
  });

  it('an older backup without the inventory tables still restores, and says so', async () => {
    const { collectBackupData, restoreFromPayload } = await import('../db/restore.js');
    const { withTransaction } = await import('../db/index.js');
    const { data } = await collectBackupData((sql) => query(sql));
    const old = { ...data };
    for (const t of ['stock_adjustments', 'inventory_items', 'inventory_transactions', 'inventory_sync_checkpoints', 'inventory_quarantine']) delete old[t];
    const result = await withTransaction((tx) => restoreFromPayload(tx, { data: old }));
    expect(result.notInBackup).toEqual(['stock_adjustments', 'inventory_items', 'inventory_transactions', 'inventory_sync_checkpoints', 'inventory_quarantine']);
    expect((await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM inventory_transactions`))[0].n).toBe(0);
    // Put everything back for any later file in the run.
    await withTransaction((tx) => restoreFromPayload(tx, { data }));
  });
});
