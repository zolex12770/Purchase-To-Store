/**
 * Integration tests — inventory and auto indent: the defects the browser E2E run 10171445
 * found (Stage C2 suites S3 and S5, 2026-10-17).
 *
 *   1. C05 (S5-13b): a re-run of the stock scan leaves an approved suggestion the only open
 *      one for its item, and while a second suggestion for the same shortage is open neither
 *      is approved further nor converts, so a shortage becomes one indent. The queue offers
 *      Reject on both rows of such a pair, also once approved (T2 review: both approved, the
 *      queue offered only a Convert that returned 409).
 *   2. C26 (S5-09b): each queue row's can_approve is the approve route's own rule: a store
 *      user approves a pending suggestion, not a store-approved one; a Purchase Head does both.
 *   3. C10 (S5-18): a physical count is refused, and posts nothing, when the book stock it was
 *      entered against is not the item's stock; one entered against it records that figure.
 *      The count reads that figure from the row it is posted against, also for an inactive
 *      item, which the stock register does not list (T2 review).
 *   4. C15 (S3-10d, S3-10f): a lot On Hold or under test stays QC-held in the register, whole.
 *   5. C19 (S5-19): reversing a receipt is refused while its category figure has been issued.
 *   6. C22 (S5-17b): the Overview's Total Stock Valuation is the register's own total.
 *   7. C30 (S5-07c): the stock, ledger and category exports need inventory.export.
 *   8. Review of the C06 follow-up (2026-10-18): the Overview's stock-status tiles count each
 *      item once, under the status the register gives it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let storeToken = '';
let headToken = '';
let buyerToken = '';
let uomId = 0;
let supplierId = 0;
let deptId = 0;
let ccId = 0;
const PASSWORD = 'Invent@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const get = (path: string, token = adminToken) => request(app).get(api(path)).set(auth(token));
const post = (path: string, body: object = {}, token = adminToken) => request(app).post(api(path)).set(auth(token)).send(body);

const stockOf = async (itemId: number) =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const categoryStockOf = async (code: string, category = 'GENERAL') =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM inventory_items WHERE item_code = $1 AND category = $2', [code, category]))[0]!.q);
const registerRow = async (itemId: number) =>
  (await get(`/inventory/stock?itemId=${itemId}`)).body.data[0] as Record<string, string>;
const suggestionsOf = (itemId: number) =>
  query<{ id: number; status: string }>('SELECT id, status FROM auto_indents WHERE item_id = $1 ORDER BY id', [itemId]);
const OPEN = ['SUGGESTED', 'PENDING_APPROVAL', 'STORE_APPROVED', 'PURCHASE_APPROVED', 'APPROVED'];
/** A suggestion as a scan before the C05 fix could leave it (next to another open one). */
async function insertSuggestion(itemId: number, code: string, status: string): Promise<number> {
  const [row] = await query<{ id: number }>(
    `INSERT INTO auto_indents (item_id, item_code, item_name, eligible_stock, min_stock, reorder_level, suggested_qty,
                               department_id, cost_centre_id, status)
     VALUES ($1, $2, $3, 8, 0, 10, 2, $4, $5, $6) RETURNING id`,
    [itemId, code, `Inventory test ${code}`, deptId, ccId, status],
  );
  return Number(row!.id);
}
const indentLinesOf = async (itemId: number) =>
  Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_indent_lines WHERE item_id = $1', [itemId]))[0]!.n);

async function mkItem(code: string, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await post('/items', {
    itemCode: code, itemDescription: `Inventory test ${code}`, uomId, departmentId: deptId, costCentreId: ccId,
    standardRate: '10', ...extra,
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Number(r.body.data.id);
}

/** A posted Direct GRN: the item's ERP stock goes up (or its lot is held for QC). */
async function receive(itemId: number, qty: string): Promise<number> {
  const r = await post('/grn', { mode: 'DIRECT', supplierId, post: true, lines: [{ itemId, grnQty: qty, rate: '10' }] });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  return Number(r.body.data.id);
}

/** A movement entered in the ERP from a category workspace (the Receive / Issue row actions). */
async function move(itemId: number, direction: 'IN' | 'OUT', quantity: number): Promise<{ id: number; txnNo: string }> {
  const r = await post('/inventory/categories/GENERAL/transactions', {
    itemId, txnType: direction === 'IN' ? 'ERP_RECEIPT' : 'ERP_ISSUE', direction, quantity, uom: 'Nos',
  });
  expect(r.status, JSON.stringify(r.body)).toBe(201);
  const [t] = await query<{ id: number }>('SELECT id FROM inventory_transactions WHERE txn_no = $1', [r.body.data.txnNo]);
  return { id: Number(t!.id), txnNo: r.body.data.txnNo as string };
}

beforeAll(async () => {
  const { ensureStorageDirs } = await import('../config/env.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');
  const { getDatabase, closeDatabase } = await import('../db/driver.js');
  const db = await import('../db/index.js');
  const { createApp } = await import('../app.js');
  ensureStorageDirs();
  const conn = await getDatabase();
  closeDb = closeDatabase;
  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  query = db.query as Q;
  app = createApp();
  const login = async (id: string, pw: string) => (await request(app).post(api('/auth/login')).send({ employeeId: id, password: pw })).body.data.accessToken as string;
  adminToken = await login('10221', 'Admin@12345');
  const roles = (await get('/roles')).body.data as { id: number; code: string }[];
  const lookup = async (category: string, code: string, name: string) => {
    const r = await post(`/lookups/${category}`, { code, name });
    expect(r.status).toBe(201);
    return Number(r.body.data.id);
  };
  deptId = await lookup('DEPARTMENT', 'TINV2-D', 'Inventory 2 Dept');
  ccId = await lookup('COST_CENTRE', 'TINV2-CC', 'Inventory 2 Cost Centre');
  uomId = (await get('/lookups/options')).body.data.UOM[0].id;
  const supplier = await post('/suppliers', { supplierName: 'Inventory Two Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  expect(supplier.status).toBe(201);
  supplierId = Number(supplier.body.data.id);
  const mkUser = async (employeeId: string, role: string) => {
    const r = await post('/users', {
      employeeId, employeeName: `Inventory2 ${role}`, designation: 'test', departmentId: deptId,
      password: PASSWORD, mustChangePassword: false, roleIds: [roles.find((x) => x.code === role)!.id],
    });
    expect(r.status).toBe(201);
    return login(employeeId, PASSWORD);
  };
  storeToken = await mkUser('T-INV2-STORE', 'STORE_USER');
  headToken = await mkUser('T-INV2-HEAD', 'PURCHASE_HEAD');
  buyerToken = await mkUser('T-INV2-BUYER', 'PURCHASE_USER');
});

afterAll(async () => { await closeDb?.(); });

/* ── 1. C05: one shortage, one open suggestion, one indent ──────────────────── */

describe('the stock scan and an approved suggestion (C05, E2E S5-13b)', () => {
  let itemId = 0;
  let approvedId = 0;

  it('a re-run of the scan adds no suggestion next to an approved one', async () => {
    itemId = await mkItem('TINV2-SCAN', { reorderLevel: '10' });
    await receive(itemId, '8');
    expect((await post('/inventory/auto-indent/generate')).status).toBe(200);
    const [first] = await suggestionsOf(itemId);
    expect(first).toMatchObject({ status: 'PENDING_APPROVAL' });
    approvedId = Number(first!.id);
    expect((await post(`/inventory/auto-indents/${approvedId}/approve`, {}, headToken)).status).toBe(200);
    expect((await suggestionsOf(itemId)).map((s) => s.status)).toEqual(['APPROVED']);

    const rerun = await post('/inventory/auto-indent/generate');
    expect(rerun.status).toBe(200);
    // Production: each re-run added another PENDING_APPROVAL row for the item (ids 4, 6, 7 next to 2).
    expect((await suggestionsOf(itemId)).filter((s) => OPEN.includes(s.status)).map((s) => Number(s.id))).toEqual([approvedId]);
  });

  it('while a second suggestion for the item is open, neither is approved further nor converts; once one is rejected, one indent is made', async () => {
    // A duplicate the scan made before the fix.
    const dupId = await insertSuggestion(itemId, 'TINV2-SCAN', 'PENDING_APPROVAL');
    const indentsBefore = await indentLinesOf(itemId);

    const refused = await post(`/inventory/auto-indents/${approvedId}/convert`, {}, headToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain(`no. ${dupId}`);
    // Approving the duplicate as well left both approved, and then neither converted (T2 review).
    const approveDup = await post(`/inventory/auto-indents/${dupId}/approve`, {}, headToken);
    expect(approveDup.status).toBe(409);
    expect(approveDup.body.error.message).toContain(`no. ${approvedId}, approved`);
    expect((await post(`/inventory/auto-indents/${dupId}/approve`, {}, storeToken)).status).toBe(409);
    expect((await suggestionsOf(itemId)).map((s) => s.status)).toEqual(['APPROVED', 'PENDING_APPROVAL']);
    expect(await indentLinesOf(itemId)).toBe(indentsBefore);

    expect((await post(`/inventory/auto-indents/${dupId}/reject`, { reason: 'Duplicate of the approved suggestion' }, headToken)).status).toBe(200);
    const converted = await post(`/inventory/auto-indents/${approvedId}/convert`, {}, headToken);
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect((await suggestionsOf(itemId)).map((s) => s.status)).toEqual(['CONVERTED', 'REJECTED']);
    expect(await indentLinesOf(itemId)).toBe(indentsBefore + 1);
  });
});

/* ── 1b. C05 (T2 review): a duplicate pair can always be resolved on screen ──── */

describe('the queue offers the way out of a duplicate pair (C05, T2 review of E2E S5-13b)', () => {
  type QueueRow = {
    id: number; status: string; can_approve: boolean; can_reject: boolean; can_convert: boolean;
    open_duplicate_id: number | null; open_duplicate_status: string | null;
  };
  const queue = async (code: string, token: string) => {
    const r = await get(`/inventory/auto-indents?search=${code}`, token);
    expect(r.status).toBe(200);
    return Object.fromEntries((r.body.data as QueueRow[]).map((x) => [Number(x.id), x])) as Record<number, QueueRow>;
  };

  it('approved and pending: Reject on both, Approve and Convert on neither, each naming the other', async () => {
    const itemId = await mkItem('TINV2-PAIR');
    const a = await insertSuggestion(itemId, 'TINV2-PAIR', 'APPROVED');
    const b = await insertSuggestion(itemId, 'TINV2-PAIR', 'PENDING_APPROVAL');

    const head = await queue('TINV2-PAIR', headToken);
    expect(head[a]).toMatchObject({ can_approve: false, can_reject: true, can_convert: false, open_duplicate_id: b, open_duplicate_status: 'PENDING_APPROVAL' });
    expect(head[b]).toMatchObject({ can_approve: false, can_reject: true, can_convert: false, open_duplicate_id: a, open_duplicate_status: 'APPROVED' });
    // The store user may reject an approved suggestion too: the reject route allows it.
    const store = await queue('TINV2-PAIR', storeToken);
    expect(store[a]).toMatchObject({ can_reject: true, can_convert: false });
    expect(store[b]).toMatchObject({ can_approve: false, can_reject: true });
    const buyer = await queue('TINV2-PAIR', buyerToken);
    expect([buyer[a]!.can_reject, buyer[b]!.can_reject, buyer[a]!.can_convert]).toEqual([false, false, false]);

    expect((await post(`/inventory/auto-indents/${b}/reject`, { reason: 'Duplicate of the approved suggestion' }, storeToken)).status).toBe(200);
    const after = await queue('TINV2-PAIR', headToken);
    expect(after[a]).toMatchObject({ open_duplicate_id: null, can_convert: true, can_reject: true });
    expect(after[b]).toMatchObject({ status: 'REJECTED', open_duplicate_id: null, can_reject: false, can_approve: false, can_convert: false });
    // A Purchase User (indent.create) converts an approved suggestion as before.
    expect((await queue('TINV2-PAIR', buyerToken))[a]!.can_convert).toBe(true);
  });

  it('both approved, as a pre-fix duplicate can be at deploy time: Reject is offered on both and one converts after', async () => {
    const itemId = await mkItem('TINV2-BOTH');
    const a = await insertSuggestion(itemId, 'TINV2-BOTH', 'APPROVED');
    const b = await insertSuggestion(itemId, 'TINV2-BOTH', 'APPROVED');
    const rows = await queue('TINV2-BOTH', headToken);
    // The probe on the review copy: both rows offered only "Convert to Indent", which returned 409.
    expect([rows[a]!.can_convert, rows[b]!.can_convert]).toEqual([false, false]);
    expect([rows[a]!.can_reject, rows[b]!.can_reject]).toEqual([true, true]);
    expect((await post(`/inventory/auto-indents/${a}/convert`, {}, headToken)).status).toBe(409);

    expect((await post(`/inventory/auto-indents/${b}/reject`, { reason: 'Duplicate of the other approved suggestion' }, headToken)).status).toBe(200);
    const indentsBefore = await indentLinesOf(itemId);
    expect((await post(`/inventory/auto-indents/${a}/convert`, {}, headToken)).status).toBe(200);
    expect(await indentLinesOf(itemId)).toBe(indentsBefore + 1);
    const done = await queue('TINV2-BOTH', headToken);
    expect(done[a]).toMatchObject({ status: 'CONVERTED', can_reject: false, can_approve: false, can_convert: false });
  });

  it('a closed suggestion offers nothing the server refuses (ORDERED)', async () => {
    const itemId = await mkItem('TINV2-ORD');
    const o = await insertSuggestion(itemId, 'TINV2-ORD', 'ORDERED');
    const rows = await queue('TINV2-ORD', headToken);
    expect(rows[o]).toMatchObject({ can_approve: false, can_reject: false, can_convert: false, open_duplicate_id: null });
    expect((await post(`/inventory/auto-indents/${o}/reject`, { reason: 'probe' }, headToken)).status).toBe(422);
  });
});

/* ── 2. C26: the queue offers Approve where approving works ─────────────────── */

describe("each suggestion's can_approve is the approve route's rule (C26, E2E S5-09b)", () => {
  it('store user: pending yes, store-approved no; Purchase Head: store-approved yes; Purchase User: never', async () => {
    const itemId = await mkItem('TINV2-APPR', { reorderLevel: '5' });
    expect((await post('/inventory/auto-indent/generate')).status).toBe(200);
    const [s] = await suggestionsOf(itemId);
    const row = async (token: string) => {
      const r = await get('/inventory/auto-indents?search=TINV2-APPR', token);
      expect(r.status).toBe(200);
      return r.body.data.find((x: { id: number }) => Number(x.id) === Number(s!.id)) as { status: string; can_approve: boolean };
    };
    expect(await row(storeToken)).toMatchObject({ status: 'PENDING_APPROVAL', can_approve: true });
    expect((await row(buyerToken)).can_approve).toBe(false);

    expect((await post(`/inventory/auto-indents/${s!.id}/approve`, {}, storeToken)).status).toBe(200);
    expect(await row(storeToken)).toMatchObject({ status: 'STORE_APPROVED', can_approve: false });
    // What the store user was offered on production, and what it got.
    expect((await post(`/inventory/auto-indents/${s!.id}/approve`, {}, storeToken)).status).toBe(422);
    expect(await row(headToken)).toMatchObject({ status: 'STORE_APPROVED', can_approve: true });
    expect((await row(adminToken)).can_approve).toBe(true);
    expect((await row(buyerToken)).can_approve).toBe(false);

    expect((await post(`/inventory/auto-indents/${s!.id}/approve`, {}, headToken)).status).toBe(200);
    expect(await row(headToken)).toMatchObject({ status: 'APPROVED', can_approve: false });
  });
});

/* ── 3. C10: the count is posted against the book stock it was entered against ─ */

describe('a physical count and the book stock it was entered against (C10, E2E S5-18)', () => {
  it('refuses a count entered against another figure, posting nothing; records the figure it was entered against', async () => {
    const itemId = await mkItem('TINV2-COUNT');
    await receive(itemId, '25');
    await move(itemId, 'IN', 1); // the GENERAL workspace row now reads 1; the ERP stock is 26
    expect(await stockOf(itemId)).toBe(26);
    expect(await categoryStockOf('TINV2-COUNT')).toBe(1);
    const countAdjustments = async () => Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_adjustments WHERE item_id = $1', [itemId]))[0]!.n);
    const ledgerRows = async () => Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1', [itemId]))[0]!.n);
    const ledgerBefore = await ledgerRows();

    // The workspace showed its own figure as the book stock and pre-filled the count with it.
    const wrong = await post('/inventory/adjustments', { itemId, actualStockQty: 1, expectedSystemQty: 1, reason: 'Cycle Count Reconciliation' }, storeToken);
    expect(wrong.status).toBe(409);
    expect(wrong.body.error.message).toContain('book stock is 26, not 1');
    expect(await stockOf(itemId)).toBe(26);
    expect(await countAdjustments()).toBe(0);
    expect(await ledgerRows()).toBe(ledgerBefore);

    const right = await post('/inventory/adjustments', { itemId, actualStockQty: 24, expectedSystemQty: '26.0000', reason: 'Cycle Count Reconciliation' }, storeToken);
    expect(right.status, JSON.stringify(right.body)).toBe(201);
    expect(right.body.data).toMatchObject({ previousStock: '26.0000', newStock: '24.0000', deltaQty: '-2.0000' });
    const [adj] = await query<{ system_stock_qty: string; actual_stock_qty: string; adjustment_qty: string }>(
      'SELECT system_stock_qty, actual_stock_qty, adjustment_qty FROM stock_adjustments WHERE item_id = $1', [itemId],
    );
    expect([Number(adj!.system_stock_qty), Number(adj!.actual_stock_qty), Number(adj!.adjustment_qty)]).toEqual([26, 24, -2]);

    // A caller that sends no figure posts as before.
    expect((await post('/inventory/adjustments', { itemId, actualStockQty: 24, reason: 'Recount' }, storeToken)).status).toBe(201);
    expect((await post('/inventory/adjustments', { itemId, actualStockQty: 24, expectedSystemQty: 'abc', reason: 'Recount' }, storeToken)).status).toBe(422);
  });

  it("reads the book stock of the row the count is posted against, also for an item that is inactive (T2 review)", async () => {
    const itemId = await mkItem('TINV2-INACT');
    await receive(itemId, '7');
    // An item on a GRN line is deactivated, not deleted (DELETE /items/:id).
    expect((await request(app).delete(api(`/items/${itemId}`)).set(auth(adminToken))).status).toBe(200);
    expect((await query<{ a: boolean }>('SELECT is_active AS a FROM items WHERE id = $1', [itemId]))[0]!.a).toBe(false);
    // The modal read the stock register, which lists active items only: no row, so no book stock.
    expect((await get(`/inventory/stock?itemId=${itemId}`, storeToken)).body.data).toEqual([]);

    const book = await get(`/inventory/adjustments/book-stock/${itemId}`, storeToken);
    expect(book.status, JSON.stringify(book.body)).toBe(200);
    expect(book.body.data).toMatchObject({ item_code: 'TINV2-INACT', is_active: false });
    expect(Number(book.body.data.item_id)).toBe(itemId);
    expect(Number(book.body.data.live_stock_qty)).toBe(7);

    const counted = await post('/inventory/adjustments', {
      itemId, actualStockQty: 6, expectedSystemQty: book.body.data.live_stock_qty, reason: 'Cycle Count Reconciliation',
    }, storeToken);
    expect(counted.status, JSON.stringify(counted.body)).toBe(201);
    expect(counted.body.data).toMatchObject({ previousStock: '7.0000', newStock: '6.0000', deltaQty: '-1.0000' });
    expect(Number((await get(`/inventory/adjustments/book-stock/${itemId}`, storeToken)).body.data.live_stock_qty)).toBe(6);

    // The right to read it is the right to post the count.
    expect((await get(`/inventory/adjustments/book-stock/${itemId}`, buyerToken)).status).toBe(403);
    expect((await get(`/inventory/adjustments/book-stock/${itemId}`, headToken)).status).toBe(403);
    expect((await get('/inventory/adjustments/book-stock/987654321', storeToken)).status).toBe(404);
  });
});

/* ── 4. C15: a lot waiting for its decision is held whole ───────────────────── */

describe('the register holds a lot for QC until it passes (C15, E2E S3-10d/S3-10f)', () => {
  it('On Hold and under test keep the whole received quantity held; a pass releases it into stock', async () => {
    const itemId = await mkItem('TINV2-QC', { qcRequired: true });
    const grnId = await receive(itemId, '5');
    const [qi] = await query<{ id: number }>('SELECT id FROM qc_inspections WHERE grn_id = $1', [grnId]);
    const decide = (body: Record<string, unknown>) => post(`/qc/inspections/${qi!.id}/decide`, body);
    const held = async () => Number((await registerRow(itemId)).qc_pending_stock_qty);
    expect(await held()).toBe(5);

    expect((await decide({ status: 'ON_HOLD', acceptedQty: 0, rejectedQty: 0, remarks: 'Waiting for the test certificate' })).status).toBe(200);
    expect(await held()).toBe(5); // was 0: On Hold dropped out of the figure
    expect((await decide({ status: 'QC_IN_PROGRESS', acceptedQty: 2, rejectedQty: 1, remarks: 'Interim count' })).status).toBe(200);
    expect(await held()).toBe(5); // was 2: the interim figures moved no stock
    expect(await stockOf(itemId)).toBe(0);

    expect((await decide({ status: 'QC_PASSED', acceptedQty: 5, rejectedQty: 0 })).status).toBe(200);
    expect(await held()).toBe(0);
    expect(await stockOf(itemId)).toBe(5);
  });
});

/* ── 5. C19: a reversal gives back only what the category still holds ───────── */

describe('reversing a movement entered in the ERP (C19, E2E S5-19)', () => {
  it('refuses to reverse a receipt the category has since issued, and allows it once the issue is reversed', async () => {
    const itemId = await mkItem('TINV2-REV');
    await receive(itemId, '10');
    const receipt = await move(itemId, 'IN', 5);
    const issue = await move(itemId, 'OUT', 5);
    expect([await stockOf(itemId), await categoryStockOf('TINV2-REV')]).toEqual([10, 0]);
    const reversals = async () => Number((await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1 AND txn_type = 'INVENTORY_REVERSAL'`, [itemId],
    ))[0]!.n);

    const refused = await post(`/inventory/transactions/${receipt.id}/reverse`, { reason: 'Receipt was entered twice' }, storeToken);
    expect(refused.status).toBe(409);
    expect(refused.body.error.message).toContain('the category holds only 0 of the 5 it added');
    expect([await stockOf(itemId), await categoryStockOf('TINV2-REV')]).toEqual([10, 0]);
    expect(await reversals()).toBe(0);
    expect((await query<{ status: string }>('SELECT status FROM inventory_transactions WHERE id = $1', [receipt.id]))[0]!.status).toBe('POSTED');

    expect((await post(`/inventory/transactions/${issue.id}/reverse`, { reason: 'Issue was entered against the wrong job' }, storeToken)).status).toBe(200);
    expect([await stockOf(itemId), await categoryStockOf('TINV2-REV')]).toEqual([15, 5]);
    expect((await post(`/inventory/transactions/${receipt.id}/reverse`, { reason: 'Receipt was entered twice' }, storeToken)).status).toBe(200);
    expect([await stockOf(itemId), await categoryStockOf('TINV2-REV')]).toEqual([10, 0]);
    expect(await reversals()).toBe(2);
  });
});

/* ── 6. C22: the Overview card and the register it opens agree ──────────────── */

describe("the Overview's Total Stock Valuation (C22, E2E S5-17b)", () => {
  it('is the register total: ERP stock at the standard rate, else the sheet rate', async () => {
    // ERP stock 4, no standard rate; its RM sheet row reads 10 at Rs 5. The card counted the
    // sheet figure (Rs 50); the register values the ERP stock at the sheet rate (Rs 20).
    const itemId = await mkItem('TINV2-VAL', { standardRate: '0' });
    await receive(itemId, '4');
    await query(
      `INSERT INTO inventory_items (item_id, item_code, item_description, category, live_stock_qty, unit_price)
       VALUES ($1, 'TINV2-VAL', 'Inventory test TINV2-VAL', 'RM', 10, 5)`, [itemId],
    );
    const own = await get(`/inventory/stock?itemId=${itemId}`);
    expect(Number(own.body.data[0].stock_valuation)).toBe(20);

    const overview = await get('/inventory/overview');
    const register = await get('/inventory/stock');
    expect(overview.status).toBe(200);
    expect(register.status).toBe(200);
    expect(overview.body.data.kpis.totalValuation).toBeCloseTo(register.body.meta.summary.totalValuation, 2);
    expect(overview.body.data.kpis.totalItems).toBe(register.body.meta.summary.totalActive);
  });
});

/* ── 7. C30: exporting needs the export right ───────────────────────────────── */

describe('the inventory exports need inventory.export (C30, E2E S5-07c)', () => {
  const exports = ['/inventory/stock/export', '/inventory/ledger/export', '/inventory/categories/GENERAL/export'];

  it('a Purchase User (inventory.view, no export right) is refused all three; the lists still open', async () => {
    for (const path of exports) expect((await get(path, buyerToken)).status, path).toBe(403);
    expect((await get('/inventory/stock', buyerToken)).status).toBe(200);
    expect((await get('/inventory/ledger', buyerToken)).status).toBe(200);
    expect((await get('/inventory/categories/GENERAL', buyerToken)).status).toBe(200);
  });

  it('a store user (inventory.export) downloads all three', async () => {
    for (const path of exports) {
      const r = await get(path, storeToken);
      expect(r.status, path).toBe(200);
      expect(r.headers['content-type']).toContain('text/csv');
    }
  });
});

/* ── 8. The Overview's stock-status tiles split the items as the register does ── */

describe("the Overview's stock-status tiles (review of the C06 follow-up, 2026-10-18)", () => {
  it('count each item once, under the status the register gives it', async () => {
    // Reorder level 10 above max stock 5 (the item master checks only min <= max), stocked to
    // 7: the register reads BELOW_REORDER, which it puts before EXCESS. The Overview counted the
    // item under Below Reorder and again under Excess Stock, whose tile opens a register filtered
    // to EXCESS that does not list it, and the four tiles added up to more than the items.
    type Kpis = Record<string, number>;
    const before = (await get('/inventory/overview')).body.data.kpis as Kpis;
    const itemId = await mkItem('TINV2-TILES', { reorderLevel: '10', maxStock: '5' });
    await receive(itemId, '7');
    expect((await registerRow(itemId)).stock_status).toBe('BELOW_REORDER');

    const overview = await get('/inventory/overview');
    expect(overview.status).toBe(200);
    const after = overview.body.data.kpis as Kpis;
    const tiles = (k: Kpis) => [k.criticalStock, k.belowReorder, k.excessStock, k.normalStock];
    expect(tiles(after).map((n, i) => n - tiles(before)[i]!)).toEqual([0, 1, 0, 0]);
    expect(tiles(after).reduce((a, n) => a + n, 0)).toBe(after.totalItems);

    const register = await get('/inventory/stock');
    expect(register.status).toBe(200);
    const summary = register.body.meta.summary as Kpis;
    expect(tiles(after)).toEqual(tiles(summary));
    const excess = await get('/inventory/stock?stockStatus=EXCESS&pageSize=200');
    expect((excess.body.data as { item_id: number }[]).map((r) => Number(r.item_id))).not.toContain(itemId);
    expect(excess.body.meta.total).toBe(after.excessStock);
  });
});
