/**
 * Integration tests — the store issue, its queue and the direct-issue slip
 * (browser E2E run 10171445, 2026-10-17, suite S4).
 *
 *   1. S4-12: a double click on "Issue material" posted two slips and deducted the
 *      stock twice. An issue that carries the issued quantity its dialog showed
 *      (expectedIssuedQty) is refused with 409 once that quantity has moved, and
 *      nothing is issued. An over-issue prepared on current figures is still
 *      accepted (Rule 24).
 *   2. S4-07b: the store requisition queue read "Shortage" for a line its stock
 *      covered, because the line's own balance was counted against it.
 *   3. S4-24b: the direct-issue slip wrote what users typed straight into its HTML,
 *      and a cancelled issue's slip did not say so. The print documents now go out
 *      with a policy that lets them run and load nothing.
 *   4. S1-06: the requisition list names the raiser and the HOD of each row, so the
 *      screen can offer the HOD decisions to that HOD only.
 *   5. Review case RV-C09b (2026-10-18): a requisition submitted from the detail page
 *      (POST /:id/submit) goes to its department's HOD as mapped now, as the edit
 *      form's resubmit does; it waited on the former HOD.
 *   6. C06 follow-up (2026-10-17 E2E review of T1): a line over-issued under Rule 24
 *      held negative demand in the stock figures, so it lowered its item's allocated
 *      stock and raised the stock shown available for every other line. The register,
 *      its export, the Overview and the stock scan count each open line at zero or more.
 *   7. Review of the C06 follow-up (2026-10-18): an over-issue on one line closed the
 *      whole requisition (FULLY_ISSUED once the issued total reached the requested
 *      total), so another line with nothing issued left the stock figures and both
 *      store queues. A requisition is fully issued when every line is; migration 032
 *      re-derives the ones the old rule closed early.
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
let adminUserId = 0;
let storeUserId = 0;
let deptId = 0;
let uomId = 0;
let supplierId = 0;
const PASSWORD = 'StoreIss@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;

const stockOf = async (itemId: number) =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const ledgerRowsOf = async (itemId: number) =>
  Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1', [itemId]))[0]!.n);

async function mkItem(code: string, description = `Store issue test ${code}`, extra: Record<string, unknown> = {}): Promise<number> {
  const r = await request(app).post(api('/items')).set(auth(adminToken))
    .send({ itemCode: code, itemDescription: description, uomId, standardRate: '10', ...extra });
  expect(r.status).toBe(201);
  return r.body.data.id as number;
}

async function stockUp(itemId: number, qty: string): Promise<void> {
  const r = await request(app).post(api('/grn')).set(auth(adminToken))
    .send({ mode: 'DIRECT', supplierId, post: true, lines: [{ itemId, grnQty: qty, rate: '10' }] });
  expect(r.status).toBe(201);
}

/** Raised and approved by the Super Admin (who may approve their own). */
async function approvedRequisition(lines: { itemId: number; qty: string }[]): Promise<{ id: number; lineIds: number[] }> {
  const created = await request(app).post(api('/requisitions')).set(auth(adminToken))
    .send({ remarks: 'Store issue guard test', submit: true, lines: lines.map((l) => ({ itemId: l.itemId, requestedQty: l.qty })) });
  expect(created.status).toBe(201);
  const id = created.body.data.id as number;
  expect((await request(app).post(api(`/requisitions/${id}/approve`)).set(auth(adminToken)).send({})).status).toBe(200);
  const detail = await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken));
  return { id, lineIds: (detail.body.data.lines as { requisition_line_id: number }[]).map((l) => l.requisition_line_id) };
}

const issue = (reqId: number, lines: { requisitionLineId: number; issueQty: string; expectedIssuedQty?: string }[]) =>
  request(app).post(api(`/requisitions/${reqId}/issue`)).set(auth(storeToken)).send({ lines });
const requisition = async (id: number) => (await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken))).body.data;

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
  const dept = await request(app).post(api('/lookups/DEPARTMENT')).set(auth(adminToken)).send({ code: 'TSIG-D', name: 'Store Issue Guard Dept' });
  expect(dept.status).toBe(201);
  uomId = (await request(app).get(api('/lookups/options')).set(auth(adminToken))).body.data.UOM[0].id;
  const supplier = await request(app).post(api('/suppliers')).set(auth(adminToken))
    .send({ supplierName: 'Store Issue Guard Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  expect(supplier.status).toBe(201);
  supplierId = supplier.body.data.id;
  const store = await request(app).post(api('/users')).set(auth(adminToken)).send({
    employeeId: 'T-SIG-STORE', employeeName: 'Store Issue Guard Store', designation: 'test', departmentId: dept.body.data.id,
    password: PASSWORD, mustChangePassword: false, roleIds: [roles.find((x) => x.code === 'STORE_USER')!.id],
  });
  expect(store.status).toBe(201);
  storeUserId = Number(store.body.data.id);
  deptId = Number(dept.body.data.id);
  storeToken = await login('T-SIG-STORE', PASSWORD);
});

afterAll(async () => { await closeDb?.(); });

describe('a store issue sent twice, or from a stale dialog, is refused (S4-12)', () => {
  let itemId = 0;
  let req = { id: 0, lineIds: [] as number[] };

  it('refuses the same issue a second time with 409, and issues nothing more', async () => {
    itemId = await mkItem('TSIG-DBL');
    await stockUp(itemId, '10');
    req = await approvedRequisition([{ itemId, qty: '1' }]);
    const body = [{ requisitionLineId: req.lineIds[0]!, issueQty: '1', expectedIssuedQty: '0' }];

    const first = await issue(req.id, body);
    expect(first.status).toBe(201);
    expect(await stockOf(itemId)).toBe(9);
    const ledgerAfterFirst = await ledgerRowsOf(itemId);

    const repeat = await issue(req.id, body);
    expect(repeat.status).toBe(409);
    expect(repeat.body.error.code).toBe('CONFLICT');
    expect(repeat.body.error.message).toMatch(/now has 1\.0000 issued, not the 0\.0000/);
    expect(repeat.body.error.message).toMatch(/Nothing was issued/);
    expect(repeat.body.error.details).toMatchObject({ requisitionLineId: req.lineIds[0], expectedIssuedQty: '0.0000', issuedQty: '1.0000' });

    expect(await stockOf(itemId)).toBe(9);
    expect(await ledgerRowsOf(itemId)).toBe(ledgerAfterFirst);
    const doc = await requisition(req.id);
    expect(doc.issues).toHaveLength(1);
    expect(doc.lines[0].issued_qty).toBe('1.0000');
  });

  it('accepts a deliberate over-issue prepared on the current figures (Rule 24)', async () => {
    const over = await issue(req.id, [{ requisitionLineId: req.lineIds[0]!, issueQty: '2', expectedIssuedQty: '1.0000' }]);
    expect(over.status).toBe(201);
    expect(await stockOf(itemId)).toBe(7);
    expect((await requisition(req.id)).lines[0].issued_qty).toBe('3.0000');
  });

  it('a slip reversed meanwhile makes the dialog stale too', async () => {
    const doc = await requisition(req.id);
    const latest = (doc.issues as { id: number; status: string }[])[0]!;
    const reversed = await request(app).post(api(`/requisitions/${req.id}/issues/${latest.id}/reverse`)).set(auth(storeToken))
      .send({ reason: 'Over-issue taken back' });
    expect(reversed.status).toBe(200);
    expect(await stockOf(itemId)).toBe(9);

    const stale = await issue(req.id, [{ requisitionLineId: req.lineIds[0]!, issueQty: '1', expectedIssuedQty: '3' }]);
    expect(stale.status).toBe(409);
    expect(await stockOf(itemId)).toBe(9);
  });

  it('of two identical issues sent together, one posts and the other is refused', async () => {
    const twin = await approvedRequisition([{ itemId, qty: '2' }]);
    const body = [{ requisitionLineId: twin.lineIds[0]!, issueQty: '2', expectedIssuedQty: '0' }];
    const stockBefore = await stockOf(itemId);
    const [a, b] = await Promise.all([issue(twin.id, body), issue(twin.id, body)]);
    expect([a.status, b.status].sort()).toEqual([201, 409]);
    expect(await stockOf(itemId)).toBe(stockBefore - 2);
    expect((await requisition(twin.id)).issues).toHaveLength(1);
  });

  it('refuses a stale line without issuing the lines before it', async () => {
    const other = await mkItem('TSIG-DBL-2');
    await stockUp(other, '5');
    const two = await approvedRequisition([{ itemId: other, qty: '1' }, { itemId, qty: '1' }]);
    expect((await issue(two.id, [{ requisitionLineId: two.lineIds[1]!, issueQty: '1' }])).status).toBe(201);
    const otherBefore = await stockOf(other);
    const itemBefore = await stockOf(itemId);

    const stale = await issue(two.id, [
      { requisitionLineId: two.lineIds[0]!, issueQty: '1', expectedIssuedQty: '0' },
      { requisitionLineId: two.lineIds[1]!, issueQty: '1', expectedIssuedQty: '0' },
    ]);
    expect(stale.status).toBe(409);
    expect(stale.body.error.message).toMatch(/^Line 2 \(TSIG-DBL\)/);
    expect(await stockOf(other)).toBe(otherBefore);
    expect(await stockOf(itemId)).toBe(itemBefore);
    expect((await requisition(two.id)).issues).toHaveLength(1);
  });

  it('keeps the old behaviour for a caller that does not send the issued quantity, and validates it when sent', async () => {
    const plain = await approvedRequisition([{ itemId, qty: '1' }]);
    expect((await issue(plain.id, [{ requisitionLineId: plain.lineIds[0]!, issueQty: '1' }])).status).toBe(201);
    expect((await issue(plain.id, [{ requisitionLineId: plain.lineIds[0]!, issueQty: '1' }])).status).toBe(201);
    for (const expectedIssuedQty of ['-1', ' ', 'two']) {
      const bad = await issue(plain.id, [{ requisitionLineId: plain.lineIds[0]!, issueQty: '1', expectedIssuedQty }]);
      expect(bad.status, expectedIssuedQty).toBe(422);
      expect(bad.body.error.issues, expectedIssuedQty).toEqual([{ field: 'lines.0.expectedIssuedQty', message: 'Must be a quantity of zero or more.' }]);
    }
    expect((await requisition(plain.id)).issues).toHaveLength(2);
  });
});

describe('the store requisition queue gives each line the stock left for it (S4-07b)', () => {
  type QueueRow = { requisition_id: number; requisition_line_id: number; balance_to_issue: string; available_stock_qty: string };
  const queue = async () => {
    const r = await request(app).get(api('/inventory/requisition-queue')).set(auth(storeToken));
    expect(r.status).toBe(200);
    return r.body.data as QueueRow[];
  };
  const rowOf = (rows: QueueRow[], lineId: number) => rows.find((r) => r.requisition_line_id === lineId)!;
  const covered = (r: QueueRow) => Number(r.available_stock_qty) >= Number(r.balance_to_issue);

  it('reads a line as covered when its stock covers it and nothing is ahead of it', async () => {
    const itemId = await mkItem('TSIG-Q1');
    await stockUp(itemId, '3');
    const req = await approvedRequisition([{ itemId, qty: '2' }]);
    const row = rowOf(await queue(), req.lineIds[0]!);
    expect(Number(row.balance_to_issue)).toBe(2);
    expect(Number(row.available_stock_qty)).toBe(3);
    expect(covered(row)).toBe(true);
  });

  it('serves the lines in queue order: of two lines needing 6 against 10, the first is covered', async () => {
    const itemId = await mkItem('TSIG-Q2');
    await stockUp(itemId, '10');
    const older = await approvedRequisition([{ itemId, qty: '6' }]);
    const younger = await approvedRequisition([{ itemId, qty: '6' }]);
    const rows = await queue();
    expect(Number(rowOf(rows, older.lineIds[0]!).available_stock_qty)).toBe(10);
    expect(covered(rowOf(rows, older.lineIds[0]!))).toBe(true);
    expect(Number(rowOf(rows, younger.lineIds[0]!).available_stock_qty)).toBe(4);
    expect(covered(rowOf(rows, younger.lineIds[0]!))).toBe(false);
  });

  it('a line over-issued on a requisition still in the queue adds no stock for the others', async () => {
    const itemId = await mkItem('TSIG-Q3');
    const otherId = await mkItem('TSIG-Q3-OTHER');
    await stockUp(itemId, '5');
    // Line 1 needs 1 and gets 4; line 2 (10 still to issue) keeps the requisition
    // PARTIALLY_ISSUED, so the over-issued line stays among the ones the old
    // allocation summed.
    const first = await approvedRequisition([{ itemId, qty: '1' }, { itemId: otherId, qty: '10' }]);
    expect((await issue(first.id, [{ requisitionLineId: first.lineIds[0]!, issueQty: '4' }])).status).toBe(201);
    expect((await requisition(first.id)).status).toBe('PARTIALLY_ISSUED');
    expect(await stockOf(itemId)).toBe(1);

    const second = await approvedRequisition([{ itemId, qty: '2' }]);
    const row = rowOf(await queue(), second.lineIds[0]!);
    // 1 on hand cannot cover 2. The old figure was 1 - ((1 - 4) + 2) = 2: "Sufficient".
    expect(Number(row.available_stock_qty)).toBe(1);
    expect(covered(row)).toBe(false);
  });
});

describe('an over-issued line holds no stock in the stock figures (C06 follow-up, 2026-10-17 E2E review of T1)', () => {
  // Live stock 10 and min stock 1. Requisition A asks 6 and is issued 8 (Rule 24); its
  // other line, for another item and not issued, keeps it PARTIALLY_ISSUED, so it stays
  // among the requisitions the stock figures sum. Requisition B asks 3 and is not issued.
  // That leaves 2 on hand against B's 3. The figures summed A's line as 6 - 8 = -2:
  // 1 allocated and 1 available, so the item read NORMAL.
  type Kpis = Record<string, number>;
  const get = async (path: string) => {
    const r = await request(app).get(api(path)).set(auth(adminToken));
    expect(r.status, path).toBe(200);
    return r;
  };
  const overview = async () => (await get('/inventory/overview')).body.data.kpis as Kpis;
  let itemId = 0;
  let reqA = { id: 0, lineIds: [] as number[] };
  let before: Kpis = {};

  beforeAll(async () => {
    itemId = await mkItem('TSIG-ALLOC', undefined, { minStock: '1' });
    const otherId = await mkItem('TSIG-ALLOC-OTHER');
    await stockUp(itemId, '10');
    before = await overview();

    reqA = await approvedRequisition([{ itemId, qty: '6' }, { itemId: otherId, qty: '10' }]);
    expect((await issue(reqA.id, [{ requisitionLineId: reqA.lineIds[0]!, issueQty: '8', expectedIssuedQty: '0' }])).status).toBe(201);
    expect((await requisition(reqA.id)).status).toBe('PARTIALLY_ISSUED');
    await approvedRequisition([{ itemId, qty: '3' }]);
    expect(await stockOf(itemId)).toBe(2);
  });

  it('the register allocates B\'s 3, not 1, and leaves nothing available: CRITICAL', async () => {
    const row = (await get(`/inventory/stock?itemId=${itemId}`)).body.data[0];
    expect([Number(row.live_stock_qty), Number(row.allocated_stock_qty), Number(row.available_stock_qty)]).toEqual([2, 3, 0]);
    expect(row.stock_status).toBe('CRITICAL');
    const critical = (await get(`/inventory/stock?itemId=${itemId}&stockStatus=CRITICAL`)).body.data as { item_id: number }[];
    expect(critical.map((r) => Number(r.item_id))).toEqual([itemId]);
  });

  it('its export says the same', async () => {
    const [head, line] = (await get(`/inventory/stock/export?itemId=${itemId}`)).text.split('\r\n');
    const headers = head!.split(',');
    const cells = line!.split(',');
    const cell = (h: string) => cells[headers.indexOf(h)];
    expect([Number(cell('Live Stock')), Number(cell('Allocated Stock')), Number(cell('Available Stock')), cell('Status')])
      .toEqual([2, 3, 0, 'CRITICAL']);
  });

  it('the Overview counts the item CRITICAL and the open requisitions at 0 + 10 + 3, as the register and the requisition list do', async () => {
    const after = await overview();
    expect(after.criticalStock - before.criticalStock).toBe(1);
    expect(after.normalStock - before.normalStock).toBe(-1);
    expect([after.belowReorder, after.excessStock]).toEqual([before.belowReorder, before.excessStock]);
    expect(after.pendingRequisitionsCount - before.pendingRequisitionsCount).toBe(2);
    expect(after.pendingRequisitionsQty - before.pendingRequisitionsQty).toBe(13); // was 11: -2 + 10 + 3

    const register = (await get('/inventory/stock')).body.meta.summary as Kpis;
    expect([after.criticalStock, after.belowReorder, after.normalStock, after.excessStock])
      .toEqual([register.criticalStock, register.belowReorder, register.normalStock, register.excessStock]);
    // The store queue's requisitions as the requisition list totals them (v_requisition_line_balance
    // counts each line's pending at zero or more). The earlier over-issue in this file (S4-07b) is
    // among them, so the Overview read 5 less.
    const open = (await get('/requisitions?view=store-queue')).body.meta.totals as Kpis;
    expect([after.pendingRequisitionsCount, after.pendingRequisitionsQty]).toEqual([open.requisitionCount, open.totalPendingQty]);
  });

  it('the stock scan suggests the item, nothing being left for it under its min stock', async () => {
    expect((await request(app).post(api('/inventory/auto-indent/generate')).set(auth(adminToken)).send({})).status).toBe(200);
    const suggested = await query<{ eligible_stock: string; reason: string; suggested_qty: string }>(
      'SELECT eligible_stock, reason, suggested_qty FROM auto_indents WHERE item_id = $1', [itemId],
    );
    expect(suggested.map((s) => [Number(s.eligible_stock), s.reason, Number(s.suggested_qty)])).toEqual([[0, 'Below Minimum Stock', 1]]);
  });

  it('the requisition itself still shows the over-issue', async () => {
    const line = (await requisition(reqA.id)).lines[0] as Record<string, string>;
    expect([Number(line.issued_qty), Number(line.pending_qty), Number(line.excess_qty)]).toEqual([8, 0, 2]);
  });
});

describe('an over-issue on one line leaves the other lines waiting (review of the C06 follow-up, 2026-10-18)', () => {
  // Item X has 10 in stock; item Y has 2 and min stock 1. Requisition [X 1, Y 2] is approved
  // and the store issues 4 of X (Rule 24). 4 issued reached the 3 requested in total, so the
  // requisition read FULLY_ISSUED (store status ISSUED) with nothing of Y issued, and every
  // figure that counts only APPROVED and PARTIALLY_ISSUED requisitions let Y's line go: the
  // register showed Y's 2 available and the item NORMAL, and the line left the store's queue
  // and the store-queue list, though the detail page still offered it for issue.
  type QueueRow = { requisition_line_id: number; balance_to_issue: string };
  let xId = 0;
  let yId = 0;
  let req = { id: 0, lineIds: [] as number[] };
  let ySlipId = 0;
  const yRow = async () => {
    const r = await request(app).get(api(`/inventory/stock?itemId=${yId}`)).set(auth(adminToken));
    expect(r.status).toBe(200);
    const row = r.body.data[0] as Record<string, string>;
    return [Number(row.live_stock_qty), Number(row.allocated_stock_qty), Number(row.available_stock_qty), row.stock_status];
  };
  const statusOf = async () => {
    const doc = await requisition(req.id);
    return [doc.status, doc.store_status];
  };
  /** This requisition's lines in the store's queue (GET /inventory/requisition-queue), with their balance. */
  const queueLines = async () => {
    const r = await request(app).get(api('/inventory/requisition-queue')).set(auth(storeToken));
    expect(r.status).toBe(200);
    return (r.body.data as QueueRow[])
      .filter((q) => req.lineIds.includes(Number(q.requisition_line_id)))
      .map((q) => [Number(q.requisition_line_id), Number(q.balance_to_issue)]);
  };
  /** The requisitions with a line for Y in the requisition list's store queue. */
  const storeQueue = async () => {
    const r = await request(app).get(api(`/requisitions?view=store-queue&itemId=${yId}`)).set(auth(adminToken));
    expect(r.status).toBe(200);
    return (r.body.data as { id: number }[]).map((h) => Number(h.id));
  };

  beforeAll(async () => {
    xId = await mkItem('TSIG-NET-X');
    yId = await mkItem('TSIG-NET-Y', undefined, { minStock: '1' });
    await stockUp(xId, '10');
    await stockUp(yId, '2');
    req = await approvedRequisition([{ itemId: xId, qty: '1' }, { itemId: yId, qty: '2' }]);
    expect(await yRow()).toEqual([2, 2, 0, 'CRITICAL']);
  });

  it('4 of X issued: the requisition is PARTIALLY_ISSUED and its store status PENDING, Y having 2 to come', async () => {
    const r = await issue(req.id, [{ requisitionLineId: req.lineIds[0]!, issueQty: '4', expectedIssuedQty: '0' }]);
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('PARTIALLY_ISSUED');
    expect(await statusOf()).toEqual(['PARTIALLY_ISSUED', 'PENDING']);
    const lines = (await requisition(req.id)).lines as Record<string, string>[];
    expect(lines.map((l) => [Number(l.issued_qty), Number(l.pending_qty)])).toEqual([[4, 0], [0, 2]]);
  });

  it("Y's 2 stay allocated: the register reads 2 live, 2 allocated, 0 available, CRITICAL", async () => {
    expect(await yRow()).toEqual([2, 2, 0, 'CRITICAL']);
  });

  it("Y's line stays in the store's queue, and the requisition in the store-queue list", async () => {
    expect(await queueLines()).toEqual([[req.lineIds[1], 2]]);
    expect(await storeQueue()).toEqual([req.id]);
  });

  it("Y's 2 issued: FULLY_ISSUED and ISSUED, nothing allocated, out of both queues", async () => {
    const r = await issue(req.id, [{ requisitionLineId: req.lineIds[1]!, issueQty: '2', expectedIssuedQty: '0' }]);
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('FULLY_ISSUED');
    ySlipId = Number(r.body.data.issueId);
    expect(await statusOf()).toEqual(['FULLY_ISSUED', 'ISSUED']);
    expect(await yRow()).toEqual([0, 0, 0, 'CRITICAL']);
    expect(await queueLines()).toEqual([]);
    expect(await storeQueue()).toEqual([]);
  });

  it("Y's slip reversed: back to PARTIALLY_ISSUED and PENDING, Y's 2 allocated and in the queue again", async () => {
    const r = await request(app).post(api(`/requisitions/${req.id}/issues/${ySlipId}/reverse`)).set(auth(storeToken))
      .send({ reason: 'Issued to the wrong machine' });
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('PARTIALLY_ISSUED');
    expect(await statusOf()).toEqual(['PARTIALLY_ISSUED', 'PENDING']);
    expect(await yRow()).toEqual([2, 2, 0, 'CRITICAL']);
    expect(await queueLines()).toEqual([[req.lineIds[1], 2]]);
    expect(await storeQueue()).toEqual([req.id]);
  });

  it('migration 032 sets a requisition the old rule left FULLY_ISSUED with a line to issue back to PARTIALLY_ISSUED, and nothing else', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { splitStatements } = await import('../db/migrate.js');
    const sql = fs.readFileSync(fileURLToPath(new URL('../db/migrations/032_requisition_fully_issued_every_line.sql', import.meta.url)), 'utf8');
    const backfill = splitStatements(sql).filter((s) => /^\s*UPDATE requisition_headers/m.test(s));
    expect(backfill).toHaveLength(1);

    // [X 1, Y 2] with 4 of X issued, stored as the old rule left it.
    const netted = await approvedRequisition([{ itemId: xId, qty: '1' }, { itemId: yId, qty: '2' }]);
    expect((await issue(netted.id, [{ requisitionLineId: netted.lineIds[0]!, issueQty: '4' }])).status).toBe(201);
    await query(`UPDATE requisition_headers SET status = 'FULLY_ISSUED' WHERE id = $1`, [netted.id]);
    // Every line issued in full, one of them over.
    await stockUp(yId, '3');
    const full = await approvedRequisition([{ itemId: xId, qty: '1' }, { itemId: yId, qty: '2' }]);
    expect((await issue(full.id, [
      { requisitionLineId: full.lineIds[0]!, issueQty: '1' }, { requisitionLineId: full.lineIds[1]!, issueQty: '3' },
    ])).status).toBe(201);
    // Stored FULLY_ISSUED with less issued than requested (1 of 3), which neither rule
    // derives: not the netting rule's doing, so the migration leaves it.
    const short = await approvedRequisition([{ itemId: xId, qty: '1' }, { itemId: yId, qty: '2' }]);
    expect((await issue(short.id, [{ requisitionLineId: short.lineIds[0]!, issueQty: '1' }])).status).toBe(201);
    await query(`UPDATE requisition_headers SET status = 'FULLY_ISSUED' WHERE id = $1`, [short.id]);
    // Nothing issued yet.
    const waiting = await approvedRequisition([{ itemId: xId, qty: '1' }, { itemId: yId, qty: '2' }]);

    const ids = [netted.id, full.id, short.id, waiting.id, req.id];
    const statuses = async () => {
      const rows = await query<{ id: string; status: string }>('SELECT id, status FROM requisition_headers WHERE id = ANY($1::bigint[])', [ids]);
      return ids.map((id) => rows.find((r) => Number(r.id) === id)!.status);
    };
    expect(await statuses()).toEqual(['FULLY_ISSUED', 'FULLY_ISSUED', 'FULLY_ISSUED', 'APPROVED', 'PARTIALLY_ISSUED']);
    await query(backfill[0]!);
    expect(await statuses()).toEqual(['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'FULLY_ISSUED', 'APPROVED', 'PARTIALLY_ISSUED']);
    await query(backfill[0]!);
    expect(await statuses()).toEqual(['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'FULLY_ISSUED', 'APPROVED', 'PARTIALLY_ISSUED']);
  });
});

describe('the direct-issue slip (S4-24b)', () => {
  let itemId = 0;
  let issueId = 0;
  let issueNo = '';
  const print = (id: number) => request(app).get(api(`/inventory/direct-issues/${id}/print`)).set(auth(storeToken));

  it('escapes every value a user typed', async () => {
    itemId = await mkItem('TSIG-DIR', 'Bearing <img src=x onerror="parent.__xss=1"> "6205"');
    await stockUp(itemId, '20');
    const r = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken)).send({
      recipientUserId: adminUserId, issueDate: '2026-10-13',
      purpose: '<script>parent.__xss=1</script> Maintenance',
      remarks: 'E2E remark <b>bold</b> & co',
      lines: [{ itemId, issueQty: 2, remarks: 'line "quoted" <i>x</i>' }],
    });
    expect(r.status).toBe(201);
    issueId = r.body.data.id;
    issueNo = r.body.data.issueNo;

    const slip = await print(issueId);
    expect(slip.status).toBe(200);
    expect(slip.headers['content-type']).toContain('text/html');
    expect(slip.text).toContain(issueNo);
    expect(slip.text).toContain('E2E remark &lt;b&gt;bold&lt;/b&gt; &amp; co');
    expect(slip.text).toContain('&lt;script&gt;parent.__xss=1&lt;/script&gt; Maintenance');
    expect(slip.text).toContain('Bearing &lt;img src=x onerror=&quot;parent.__xss=1&quot;&gt; &quot;6205&quot;');
    expect(slip.text).toContain('line &quot;quoted&quot; &lt;i&gt;x&lt;/i&gt;');
    for (const raw of ['<b>bold</b>', '<script>', '<img src=x', '<i>x</i>']) expect(slip.text).not.toContain(raw);
    expect(slip.text).not.toMatch(/CANCELLED/);
  });

  it('may not run or load anything, opened from its URL or shown through srcdoc', async () => {
    const slip = await print(issueId);
    const csp = slip.headers['content-security-policy'] as string;
    expect(csp).toMatch(/default-src 'none'/);
    expect(csp).toMatch(/style-src 'unsafe-inline'/);
    expect(csp).toMatch(/frame-ancestors 'none'/);
    expect(csp).not.toMatch(/script-src/);
    expect(slip.text).toMatch(/<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'" \/>/);
  });

  it('prints its date as a date', async () => {
    // It printed "Tue Oct 13": the DATE arrives as a Date and was cut to ten characters.
    expect((await print(issueId)).text).toMatch(/<strong>Date:<\/strong> 13 Oct 2026 \d{2}:\d{2}:\d{2}/);
  });

  it('marks a cancelled issue as cancelled, with when, by whom and why', async () => {
    const cancel = await request(app).post(api(`/inventory/direct-issues/${issueId}/cancel`)).set(auth(storeToken))
      .send({ reason: 'Issued to the wrong <dept>' });
    expect(cancel.status).toBe(200);
    const slip = await print(issueId);
    expect(slip.status).toBe(200);
    expect(slip.text).toContain('STORE DIRECT ISSUE SLIP — CANCELLED');
    expect(slip.text).toMatch(/Cancelled on \d{2} [A-Z][a-z]{2} \d{4} by Store Issue Guard Store\./);
    expect(slip.text).toContain('Reason: Issued to the wrong &lt;dept&gt;');
    expect(slip.text).toContain('this slip no longer counts as issued');
    expect(slip.text).toContain(`<title>Direct Store Issue Slip - ${issueNo} (cancelled)</title>`);
  });
});

describe('the requisition list says who raised each requisition and who decides it (E2E S1-06)', () => {
  it('returns requester_user_id and hod_user_id, so the list offers the HOD decisions only to that HOD', async () => {
    const itemId = await mkItem('TSIG-LIST');
    expect((await request(app).put(api(`/requisitions/departments/${deptId}/hod`)).set(auth(adminToken)).send({ hodUserId: adminUserId })).status).toBe(200);
    const created = await request(app).post(api('/requisitions')).set(auth(storeToken))
      .send({ remarks: 'list', submit: true, lines: [{ itemId, requestedQty: '1' }] });
    expect(created.status).toBe(201);
    const list = await request(app).get(api('/requisitions?search=TSIG-LIST')).set(auth(adminToken));
    expect(list.status).toBe(200);
    const row = (list.body.data as { id: number; requester_user_id: number; hod_user_id: number }[]).find((r) => r.id === created.body.data.id);
    expect(row).toMatchObject({ requester_user_id: storeUserId, hod_user_id: adminUserId });
  });
});

describe('a submit from the detail page goes to the department\'s HOD as mapped now (review case RV-C09b)', () => {
  const oldHod = { id: 0, token: '' };
  const newHod = { id: 0, token: '' };
  const mapHod = async (hodUserId: number) =>
    expect((await request(app).put(api(`/requisitions/departments/${deptId}/hod`)).set(auth(adminToken)).send({ hodUserId })).status).toBe(200);
  const raise = async (submit: boolean) => {
    const itemId = await mkItem(`TSIG-HOD-${submit ? 'S' : 'D'}`);
    const created = await request(app).post(api('/requisitions')).set(auth(storeToken))
      .send({ remarks: 'HOD routing', submit, lines: [{ itemId, requestedQty: '1' }] });
    expect(created.status).toBe(201);
    return created.body.data as { id: number; hod_user_id: number | null };
  };
  const submitFromDetail = (id: number) => request(app).post(api(`/requisitions/${id}/submit`)).set(auth(storeToken)).send({});

  beforeAll(async () => {
    const roles = (await request(app).get(api('/roles')).set(auth(adminToken))).body.data as { id: number; code: string }[];
    for (const [hod, employeeId, employeeName] of [
      [oldHod, 'T-SIG-HOD-OLD', 'Store Issue Guard Old HOD'], [newHod, 'T-SIG-HOD-NEW', 'Store Issue Guard New HOD'],
    ] as const) {
      const created = await request(app).post(api('/users')).set(auth(adminToken)).send({
        employeeId, employeeName, designation: 'HOD', password: PASSWORD, mustChangePassword: false,
        roleIds: [roles.find((x) => x.code === 'EMPLOYEE')!.id],
      });
      expect(created.status).toBe(201);
      hod.id = Number(created.body.data.id);
      hod.token = (await request(app).post(api('/auth/login')).send({ employeeId, password: PASSWORD })).body.data.accessToken;
    }
  });

  it('a RETURNED requisition resubmitted there goes to the new HOD, who may then decide it', async () => {
    await mapHod(oldHod.id);
    const raised = await raise(true);
    expect(raised.hod_user_id).toBe(oldHod.id);
    expect((await request(app).post(api(`/requisitions/${raised.id}/return`)).set(auth(oldHod.token)).send({ reason: 'Please correct it' })).status).toBe(200);

    await mapHod(newHod.id);
    expect((await submitFromDetail(raised.id)).status).toBe(200);
    expect(await requisition(raised.id)).toMatchObject({ status: 'PENDING_APPROVAL', hod_user_id: newHod.id, hod_name: 'Store Issue Guard New HOD' });
    expect((await request(app).post(api(`/requisitions/${raised.id}/approve`)).set(auth(oldHod.token)).send({})).status).toBe(403);
    expect((await request(app).post(api(`/requisitions/${raised.id}/approve`)).set(auth(newHod.token)).send({})).status).toBe(200);
  });

  it('a DRAFT submitted there is routed the same way, and the audit trail names both HODs', async () => {
    await mapHod(oldHod.id);
    const draft = await raise(false);
    expect(draft.hod_user_id).toBe(oldHod.id);

    await mapHod(newHod.id);
    expect((await submitFromDetail(draft.id)).status).toBe(200);
    expect(await requisition(draft.id)).toMatchObject({ status: 'PENDING_APPROVAL', hod_user_id: newHod.id });
    const audit = await query<{ before_data: { hodUserId?: number }; after_data: { hodUserId?: number } }>(
      `SELECT before_data, after_data FROM audit_logs WHERE entity = 'requisition' AND entity_id = $1 AND action = 'SUBMIT'`, [String(draft.id)],
    );
    expect(audit).toHaveLength(1);
    expect(audit[0]!.before_data.hodUserId).toBe(oldHod.id);
    expect(audit[0]!.after_data.hodUserId).toBe(newHod.id);
  });
});

describe('the requisition documents go out under the same policy', () => {
  it('the requisition and issue-slip print views carry it, and the PDF still renders', async () => {
    const itemId = await mkItem('TSIG-DOC');
    await stockUp(itemId, '5');
    const req = await approvedRequisition([{ itemId, qty: '1' }]);
    const issued = await issue(req.id, [{ requisitionLineId: req.lineIds[0]!, issueQty: '1', expectedIssuedQty: '0' }]);
    expect(issued.status).toBe(201);

    for (const path of [`/requisitions/${req.id}/print-view`, `/requisitions/issues/${issued.body.data.issueId}/print-view`]) {
      const view = await request(app).get(api(path)).set(auth(adminToken));
      expect(view.status, path).toBe(200);
      expect(view.headers['content-security-policy'], path).toMatch(/^default-src 'none'; style-src 'unsafe-inline'; img-src data:/);
      expect(view.text, path).toContain('<meta http-equiv="Content-Security-Policy"');
    }
    const pdf = await request(app).get(api(`/requisitions/${req.id}/pdf`)).set(auth(adminToken));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
  });
});
