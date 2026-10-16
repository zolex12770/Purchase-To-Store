/**
 * Integration tests — supported reversals and the direct-issue permission boundary (2026-10-16).
 *
 *   1. A direct issue can be cancelled: stock comes back through a
 *      DIRECT_ISSUE_REVERSAL entry, the issue is kept and marked CANCELLED, and it
 *      cannot be cancelled twice.
 *   2. A physical-count adjustment can be reversed (STOCK_ADJUSTMENT_REVERSAL).
 *   3. A movement entered in the ERP inventory screens can be reversed
 *      (INVENTORY_REVERSAL); a reversal that would make stock negative is refused.
 *   4. Direct issues use their own rights: a Purchase User (item.create) can no
 *      longer post one; a Store User can.
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
let buyerToken = '';
let itemId = 0;
let adminUserId = 0;
const PASSWORD = 'Revers@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const stock = async () => Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const lastLedger = async () => (await query<{ txn_type: string; inward_qty: string; outward_qty: string; balance_qty: string }>(
  'SELECT txn_type, inward_qty, outward_qty, balance_qty FROM stock_ledger WHERE item_id = $1 ORDER BY id DESC LIMIT 1', [itemId],
))[0]!;

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
  adminUserId = Number((await query<{ id: string }>(`SELECT id FROM users WHERE employee_id = '10221'`))[0]!.id);
  const roles = (await request(app).get(api('/roles')).set(auth(adminToken))).body.data as { id: number; code: string }[];
  const dept = await request(app).post(api('/lookups/DEPARTMENT')).set(auth(adminToken)).send({ code: 'TREV-D', name: 'Reversal Dept' });
  const mkUser = async (employeeId: string, role: string) => {
    const r = await request(app).post(api('/users')).set(auth(adminToken)).send({
      employeeId, employeeName: `Reversal ${role}`, designation: 'test', departmentId: dept.body.data.id,
      password: PASSWORD, mustChangePassword: false, roleIds: [roles.find((x) => x.code === role)!.id],
    });
    expect(r.status).toBe(201);
    return login(employeeId, PASSWORD);
  };
  storeToken = await mkUser('T-REV-STORE', 'STORE_USER');
  buyerToken = await mkUser('T-REV-BUYER', 'PURCHASE_USER');
  const [it] = await query<{ id: string }>(
    `INSERT INTO items (item_code, item_description, inventory_category, live_stock_qty, is_active)
     VALUES ('TREV-ITEM', 'Reversal test item', 'GENERAL', 50, TRUE) RETURNING id`,
  );
  itemId = Number(it!.id);
});

afterAll(async () => { await closeDb?.(); });

describe('direct issues: own rights, and cancellation returns the stock', () => {
  let issueId = 0;
  const body = () => ({ recipientUserId: adminUserId, purpose: 'Maintenance', lines: [{ itemId, issueQty: 5 }] });

  it('a Purchase User may not post a direct issue; a Store User may', async () => {
    expect((await request(app).post(api('/inventory/direct-issues')).set(auth(buyerToken)).send(body())).status).toBe(403);
    const ok = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken)).send(body());
    expect(ok.status).toBe(201);
    issueId = ok.body.data.id;
    expect(await stock()).toBe(45);
  });

  it('cancelling needs a reason, returns the stock, keeps the issue, and cannot be repeated', async () => {
    const url = api(`/inventory/direct-issues/${issueId}/cancel`);
    expect((await request(app).post(url).set(auth(storeToken)).send({ reason: '' })).status).toBe(422);
    const done = await request(app).post(url).set(auth(storeToken)).send({ reason: 'Issued to the wrong department' });
    expect(done.status).toBe(200);
    expect(await stock()).toBe(50);
    expect(await lastLedger()).toMatchObject({ txn_type: 'DIRECT_ISSUE_REVERSAL' });
    expect(Number((await lastLedger()).inward_qty)).toBe(5);
    const h = (await query<{ status: string; cancel_reason: string }>('SELECT status, cancel_reason FROM direct_issue_headers WHERE id = $1', [issueId]))[0]!;
    expect(h).toMatchObject({ status: 'CANCELLED', cancel_reason: 'Issued to the wrong department' });
    const again = await request(app).post(url).set(auth(storeToken)).send({ reason: 'Issued to the wrong department' });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect(await stock()).toBe(50);
  });
});

describe('physical-count adjustments can be reversed', () => {
  it('reverses once, through its own ledger entry', async () => {
    const adj = await request(app).post(api('/inventory/adjustments')).set(auth(storeToken))
      .send({ itemId, actualStockQty: 47, reason: 'Counted 47' });
    expect(adj.status).toBe(201);
    expect(await stock()).toBe(47);
    const url = api(`/inventory/adjustments/${adj.body.data.id}/reverse`);
    expect((await request(app).post(url).set(auth(buyerToken)).send({ reason: 'Wrong count entered' })).status).toBe(403);
    const r = await request(app).post(url).set(auth(storeToken)).send({ reason: 'Wrong count entered' });
    expect(r.status).toBe(200);
    expect(await stock()).toBe(50);
    expect(await lastLedger()).toMatchObject({ txn_type: 'STOCK_ADJUSTMENT_REVERSAL' });
    expect(Number((await lastLedger()).inward_qty)).toBe(3);
    expect((await request(app).post(url).set(auth(storeToken)).send({ reason: 'Wrong count entered' })).status).toBeGreaterThanOrEqual(400);
    expect(await stock()).toBe(50);
  });
});

describe('ERP inventory movements can be reversed', () => {
  it('undoes the stock change, marks the movement REVERSED, and refuses to go negative', async () => {
    const mv = await request(app).post(api('/inventory/categories/GENERAL/transactions')).set(auth(storeToken))
      .send({ itemId, txnType: 'ERP_RECEIPT', direction: 'IN', quantity: 7, uom: 'Nos' });
    expect(mv.status).toBe(201);
    expect(await stock()).toBe(57);
    const txn = (await query<{ id: string }>('SELECT id FROM inventory_transactions WHERE txn_no = $1', [mv.body.data.txnNo]))[0]!;
    // Issue most of the stock, so undoing the receipt would go negative.
    const big = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken))
      .send({ recipientUserId: adminUserId, lines: [{ itemId, issueQty: 55 }] });
    expect(big.status).toBe(201);
    const url = api(`/inventory/transactions/${txn.id}/reverse`);
    const refused = await request(app).post(url).set(auth(storeToken)).send({ reason: 'Receipt entered twice' });
    expect(refused.status).toBe(409);
    expect(await stock()).toBe(2);
    await request(app).post(api(`/inventory/direct-issues/${big.body.data.id}/cancel`)).set(auth(storeToken)).send({ reason: 'Test sequence' });
    const ok = await request(app).post(url).set(auth(storeToken)).send({ reason: 'Receipt entered twice' });
    expect(ok.status).toBe(200);
    expect(await stock()).toBe(50);
    expect(await lastLedger()).toMatchObject({ txn_type: 'INVENTORY_REVERSAL' });
    const t = (await query<{ status: string; reversal_reason: string }>('SELECT status, reversal_reason FROM inventory_transactions WHERE id = $1', [txn.id]))[0]!;
    expect(t).toMatchObject({ status: 'REVERSED', reversal_reason: 'Receipt entered twice' });
    expect((await request(app).post(url).set(auth(storeToken)).send({ reason: 'Receipt entered twice' })).status).toBe(409);
    // The item began with 50 and no ledger history; every movement since is ledgered,
    // so ledger total + 50 must still equal the stock.
    const recon = await request(app).get(api('/items/analysis/stock-reconciliation')).query({ search: 'TREV-ITEM' }).set(auth(adminToken));
    expect(Number(recon.body.data[0].computed_balance) + 50).toBeCloseTo(Number(recon.body.data[0].current_stock), 4);
  });
});
