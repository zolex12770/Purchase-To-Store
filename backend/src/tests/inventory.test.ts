/**
 * Integration Tests — Enterprise Inventory Module:
 * 1. Overview KPIs, Category Breakdown, Recent movements
 * 2. Category Stock Register (FG, RM, TRADING, GENERAL) & Valuation
 * 3. Stock Register CSV export
 * 4. Movement Ledger tracking
 * 5. Physical Stock Adjustment (Validation, Delta calculation, Atomicity, Audit)
 * 6. Requisition Issue Queue
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

let app: Express;
let closeDb: () => Promise<void>;
let adminToken = '';
let testItemId = 0;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signIn(employeeId: string, passwords: string[]): Promise<string> {
  for (const password of passwords) {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId, password });
    if (res.status === 200) return res.body.data.accessToken as string;
  }
  throw new Error(`Could not sign in as ${employeeId}`);
}

async function signInAndRotate(employeeId: string, initial: string, next: string): Promise<string> {
  let token = await signIn(employeeId, [initial, next]);
  const me = await request(app).get('/api/v1/auth/me').set(auth(token));
  if (me.body.data?.mustChangePassword) {
    const rot = await request(app).post('/api/v1/auth/change-password').set(auth(token)).send({
      currentPassword: initial,
      newPassword: next,
    });
    token = rot.body.data.accessToken as string;
  }
  return token;
}

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { getDatabase, closeDatabase, query } = await import('../db/index.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');

  await getDatabase();
  await runMigrations({ silent: true });
  await seedSystem();

  app = createApp();
  closeDb = closeDatabase;

  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Admin@Testing2026!');

  // Ensure test item with category
  let existingItem = await query<{ id: number }>(
    `SELECT id FROM items WHERE upper(item_code) = 'TEST-INV-001' AND deleted_at IS NULL`,
  );
  if (existingItem.length === 0) {
    existingItem = await query<{ id: number }>(
      `INSERT INTO items
         (item_code, item_description, inventory_category, live_stock_qty, min_stock, reorder_level, standard_rate, is_active)
       VALUES ('TEST-INV-001', 'Test Inventory General Item', 'GENERAL', 50, 10, 20, 100, TRUE)
       RETURNING id`,
    );
  } else {
    await query(
      `UPDATE items SET live_stock_qty = 50, inventory_category = 'GENERAL' WHERE id = $1`,
      [existingItem[0].id],
    );
  }
  testItemId = existingItem[0].id;
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe('Enterprise Inventory Module API', () => {
  it('GET /api/v1/inventory/overview returns dashboard metrics, category breakdown and recent movements', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/overview')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.kpis).toBeDefined();
    expect(res.body.data.kpis.totalItems).toBeGreaterThan(0);
    expect(res.body.data.categoryBreakdown).toBeInstanceOf(Array);
    expect(res.body.data.recentMovements).toBeInstanceOf(Array);
  });

  it('GET /api/v1/inventory/stock supports category filtering and returns valuation and category', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/stock?category=GENERAL')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    if (res.body.data.length > 0) {
      const item = res.body.data.find((r: { item_id: number }) => r.item_id === testItemId);
      if (item) {
        expect(item.category).toBe('GENERAL');
        expect(Number(item.live_stock_qty)).toBe(50);
        expect(Number(item.stock_valuation)).toBe(5000);
      }
    }
    expect(res.body.meta.summary.categories).toBeDefined();
    expect(res.body.meta.summary.totalValuation).toBeDefined();
  });

  // Production, 2026-10-16: no Purchase item had a standard rate, so the register valued
  // 3,191 items at Rs 0 while the Overview valued the same stock at the sheets' rates.
  it('GET /api/v1/inventory/stock values stock at the sheet rate when the item has no standard rate, and says so', async () => {
    const { query } = await import('../db/index.js');
    const run = `TVAL${Date.now().toString(36).toUpperCase()}`;
    const mk = async (code: string, stock: number, rate: number) => (await query<{ id: number }>(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, standard_rate, is_active)
       VALUES ($1, $1, 'GENERAL', $2, $3, TRUE) RETURNING id`, [code, stock, rate],
    ))[0]!.id;
    const sheetRated = await mk(`${run}-SHEET`, 4, 0);
    await mk(`${run}-NONE`, 3, 0);
    await mk(`${run}-STD`, 2, 100);
    await query(
      `INSERT INTO inventory_items (item_id, item_code, item_description, category, live_stock_qty, unit_price)
       VALUES ($1, $2, $2, 'GENERAL', 4, 12.5)`, [sheetRated, `${run}-SHEET`],
    );
    const res = await request(app).get(`/api/v1/inventory/stock?category=GENERAL&search=${run}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = (code: string) => res.body.data.find((r: { item_code: string }) => r.item_code === code);
    expect(row(`${run}-SHEET`)).toMatchObject({ valuation_basis: 'SHEET' });
    expect(Number(row(`${run}-SHEET`).stock_valuation)).toBe(50);
    expect(row(`${run}-NONE`)).toMatchObject({ valuation_basis: 'NONE' });
    expect(row(`${run}-STD`)).toMatchObject({ valuation_basis: 'STANDARD' });
    expect(res.body.meta.summary.totalValuation).toBe(250);
    expect(res.body.meta.summary.unvaluedWithStock).toBe(1);
    expect(res.body.meta.summary.sheetRatedWithStock).toBe(1);
  });

  it('GET /api/v1/inventory/stock/export outputs CSV with Category, Opening Stock, and Valuation', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/stock/export?category=GENERAL')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/csv');
    expect(res.text).toContain('Item Code,Item Description,Category,Opening Stock');
    expect(res.text).toContain('TEST-INV-001');
  });

  it('GET /api/v1/inventory/ledger returns paginated stock ledger movements', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/ledger')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta.summary.totalMovements).toBeDefined();
  });

  it('POST /api/v1/inventory/adjustments performs physical count adjustment and updates live stock', async () => {
    const res = await request(app)
      .post('/api/v1/inventory/adjustments')
      .set(auth(adminToken))
      .send({
        itemId: testItemId,
        actualStockQty: 42,
        reason: 'Physical cycle count audit found 8 units damaged',
        findings: 'Damaged in transit inside aisle 3',
        remarks: 'Approved by store incharge',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.adjustmentNo).toMatch(/^ADJ-/);
    expect(Number(res.body.data.previousStock)).toBe(50);
    expect(Number(res.body.data.newStock)).toBe(42);
    expect(Number(res.body.data.deltaQty)).toBe(-8);

    // Verify stock ledger entry was created
    const ledgerRes = await request(app)
      .get(`/api/v1/inventory/ledger?itemId=${testItemId}`)
      .set(auth(adminToken));

    expect(ledgerRes.status).toBe(200);
    const adjTxn = ledgerRes.body.data.find((l: { txn_type: string }) => l.txn_type === 'STOCK_ADJUSTMENT');
    expect(adjTxn).toBeDefined();
    expect(Number(adjTxn.outward_qty)).toBe(8);
    expect(Number(adjTxn.balance_qty)).toBe(42);
  });

  it('POST /api/v1/inventory/adjustments refuses negative actual count', async () => {
    const res = await request(app)
      .post('/api/v1/inventory/adjustments')
      .set(auth(adminToken))
      .send({
        itemId: testItemId,
        actualStockQty: -5,
        reason: 'Invalid count',
      });

    expect(res.status).toBe(422);
  });

  it('GET /api/v1/inventory/adjustments returns adjustment audit history', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/adjustments')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('GET /api/v1/inventory/requisition-queue returns approved requisitions awaiting issue', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/requisition-queue')
      .set(auth(adminToken));

    if (res.status !== 200) {
      console.error('Requisition queue error:', res.body, res.text);
    }
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
  });

  it('GET /api/v1/inventory/categories/RM/summary returns category metrics and last sync checkpoint', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/categories/RM/summary')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.category).toBe('RM');
    expect(res.body.data.stats).toBeDefined();
    expect(res.body.data.stats.totalItems).toBeGreaterThanOrEqual(0);
  });

  it('GET /api/v1/inventory/categories/RM returns paginated inventory items', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/categories/RM?pageSize=10')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    expect(res.body.meta).toBeDefined();
  });

  it('POST /api/v1/inventory/categories/GENERAL/transactions posts atomic inward and outward with 409 guard', async () => {
    // 1. Post Inward
    const inRes = await request(app)
      .post('/api/v1/inventory/categories/GENERAL/transactions')
      .set(auth(adminToken))
      .send({
        itemId: testItemId,
        txnType: 'GRN_INWARD',
        direction: 'IN',
        quantity: 15,
        uom: 'Nos',
        notes: 'Test Inward Receipt',
      });

    expect(inRes.status).toBe(201);
    expect(inRes.body.success).toBe(true);
    expect(inRes.body.data.txnNo).toMatch(/^ITXN-/);
    const postInwardQty = Number(inRes.body.data.balanceQtyAfter);

    // 2. Attempt Excessive Outward (Must fail with 409 Conflict)
    const failRes = await request(app)
      .post('/api/v1/inventory/categories/GENERAL/transactions')
      .set(auth(adminToken))
      .send({
        itemId: testItemId,
        txnType: 'DIRECT_ISSUE',
        direction: 'OUT',
        quantity: postInwardQty + 999999,
        uom: 'Nos',
        notes: 'Excessive outward should fail',
      });

    expect(failRes.status).toBe(409);
    expect(failRes.body.error.message).toContain('Insufficient stock');

    // 3. Post Valid Outward
    const outRes = await request(app)
      .post('/api/v1/inventory/categories/GENERAL/transactions')
      .set(auth(adminToken))
      .send({
        itemId: testItemId,
        txnType: 'DIRECT_ISSUE',
        direction: 'OUT',
        quantity: 5,
        uom: 'Nos',
        notes: 'Test Outward Issue',
      });

    expect(outRes.status).toBe(201);
    expect(outRes.body.success).toBe(true);
    expect(Number(outRes.body.data.balanceQtyAfter)).toBe(postInwardQty - 5);
  });

  it('GET /api/v1/inventory/sync/status returns checkpoints for all categories', async () => {
    const res = await request(app)
      .get('/api/v1/inventory/sync/status')
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.categories).toBeInstanceOf(Array);
    expect(res.body.data).toHaveProperty('running');
  });
});


/* ── 2026-10-16 audit fixes: exports match their lists, bad input is 422, auto-indent states ── */

describe('inventory exports and auto-indent states', () => {
  // The suite reuses its database between runs, so every fixture carries a per-run code.
  const run = `T${Date.now().toString(36).toUpperCase()}`;
  const get = (path: string) => request(app).get(path).set(auth(adminToken));
  const post = (path: string, body: object = {}) => request(app).post(path).set(auth(adminToken)).send(body);
  const csvCodes = (text: string) => text.split('\r\n').slice(1).filter(Boolean).map((l) => l.split(',')[0]!.replace(/"/g, ''));

  it('an invalid filter value is a 422, not a 500', async () => {
    expect((await get('/api/v1/inventory/categories/RM?status=FOO')).status).toBe(422);
    expect((await get('/api/v1/inventory/reconciliation?status=FOO')).status).toBe(422);
  });

  it("the stock export applies the stock-status filter and uses the screen's status rule", async () => {
    const { query } = await import('../db/index.js');
    await query(
      `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, min_stock, reorder_level, is_active)
       VALUES ($1, 'critical', 'GENERAL', 2, 10, 0, TRUE), ($2, 'normal', 'GENERAL', 50, 0, 0, TRUE)`,
      [`${run}-CRIT`, `${run}-OK`],
    );
    const list = await get(`/api/v1/inventory/stock?category=GENERAL&stockStatus=CRITICAL&search=${run}`);
    expect(list.body.data.map((r: { item_code: string }) => r.item_code)).toEqual([`${run}-CRIT`]);
    const csv = await get(`/api/v1/inventory/stock/export?category=GENERAL&stockStatus=CRITICAL&search=${run}`);
    expect(csv.status).toBe(200);
    expect(csvCodes(csv.text)).toEqual([`${run}-CRIT`]);
    expect(csv.text.split('\r\n')[1]!.endsWith(',CRITICAL')).toBe(true);
    const all = await get(`/api/v1/inventory/stock/export?category=GENERAL&search=${run}`);
    expect(all.text).toMatch(new RegExp(`${run}-OK.*,NORMAL`));
  });

  it('the ledger export prints plain dates', async () => {
    const csv = await get('/api/v1/inventory/ledger/export');
    expect(csv.status).toBe(200);
    const first = csv.text.split('\r\n')[1];
    if (first) expect(first.slice(0, 10)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(csv.text).not.toMatch(/GMT[+-]\d{4}/);
  });

  it('a category export holds exactly the rows its list shows', async () => {
    const { query } = await import('../db/index.js');
    const item = (await query<{ id: number }>(`SELECT id FROM items WHERE item_code = 'TEST-INV-001'`))[0]!;
    await query(
      `INSERT INTO inventory_items (item_id, item_code, item_description, category, live_stock_qty)
       VALUES ($1, $2, 'Export zero', 'RM', 0), ($1, $3, 'Export some', 'RM', 7)`, [item.id, `${run}-ZERO`, `${run}-SOME`],
    );
    const list = await get(`/api/v1/inventory/categories/RM?status=ZERO_STOCK&search=${run}`);
    expect(list.body.data.map((r: { item_code: string }) => r.item_code)).toEqual([`${run}-ZERO`]);
    const csv = await get(`/api/v1/inventory/categories/RM/export?status=ZERO_STOCK&search=${run}`);
    expect(csvCodes(csv.text)).toEqual([`${run}-ZERO`]);
  });

  it('an auto-indent suggestion is converted only once, and only after approval', async () => {
    const { query } = await import('../db/index.js');
    const dept = await post('/api/v1/lookups/DEPARTMENT', { code: `${run}-D`, name: `Auto indent dept ${run}` });
    expect(dept.status).toBe(201);
    const cc = await post("/api/v1/lookups/COST_CENTRE", { code: `${run}-CC`, name: `Auto indent cost centre ${run}` });
    expect(cc.status).toBe(201);
    const item = (await query<{ id: number }>(`SELECT id FROM items WHERE item_code = 'TEST-INV-001'`))[0]!;
    const suggest = async () => (await query<{ id: number }>(
      `INSERT INTO auto_indents (item_id, item_code, item_name, eligible_stock, min_stock, reorder_level, suggested_qty, department_id, cost_centre_id, status)
       VALUES ($1, 'TEST-INV-001', 'Test Inventory General Item', 5, 10, 20, 15, $2, $3, 'PENDING_APPROVAL') RETURNING id`,
      [item.id, dept.body.data.id, cc.body.data.id],
    ))[0]!.id;

    const a = await suggest();
    expect((await post(`/api/v1/inventory/auto-indents/${a}/convert`)).status).toBe(422);
    const approved = await post(`/api/v1/inventory/auto-indents/${a}/approve`);
    expect(approved.status).toBe(200);
    const converted = await post(`/api/v1/inventory/auto-indents/${a}/convert`);
    expect(converted.status, JSON.stringify(converted.body)).toBe(200);
    expect((await post(`/api/v1/inventory/auto-indents/${a}/convert`)).status).toBe(422);
    expect((await post(`/api/v1/inventory/auto-indents/${a}/approve`)).status).toBe(422);
    expect((await post(`/api/v1/inventory/auto-indents/${a}/reject`, { reason: 'late' })).status).toBe(422);
    const history = await query<{ action: string }>(`SELECT action FROM indent_approvals WHERE indent_id = $1`, [converted.body.data.indentId]);
    expect(history.map((h) => h.action)).toEqual(['SUBMIT']);

    const b = await suggest();
    expect((await post(`/api/v1/inventory/auto-indents/${b}/reject`, { reason: 'not needed' })).status).toBe(200);
    expect((await post(`/api/v1/inventory/auto-indents/${b}/approve`)).status).toBe(422);
    expect((await post(`/api/v1/inventory/auto-indents/${b}/convert`)).status).toBe(422);
  });
});
