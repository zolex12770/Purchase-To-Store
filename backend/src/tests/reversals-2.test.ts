/**
 * Integration tests — reversals for the remaining stock documents, and the
 * controlled ledger-only void of the 2026-10-14 production test chain (2026-10-16).
 *
 *   1. A requisition issue slip can be reversed: stock comes back through a
 *      REQUISITION_REVERSAL entry, the slip is kept and marked REVERSED, the
 *      requisition's status is re-derived, every total ignores the slip, it cannot
 *      be reversed twice, and once all slips are reversed the requisition can be
 *      cancelled.
 *   2. A GRN can be cancelled once the issue that consumed it is reversed (the
 *      guard counts NET requisition consumption).
 *   3. Hard-delete refuses posted stock documents; inspecting a GRN no longer fails.
 *   4. The void, on a reproduction of item 1161480001: live 3 (= its sheet), ledger
 *      17 = +3 real, +20 GRN, -5 issue slip, -1 direct issue, +1/-1 adjustments.
 *      Voiding the GRN, the slip and the direct issue gives 17 - 20 + 5 + 1 = 3.
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
let adminUserId = 0;
let uomId = 0;
let supplierId = 0;
let poTypeId = 0;
const PASSWORD = 'Revers@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;

const stockOf = async (itemId: number) =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const ledgerSumOf = async (itemId: number) =>
  Number((await query<{ s: string }>(
    'SELECT COALESCE(SUM(inward_qty - outward_qty), 0) AS s FROM stock_ledger WHERE item_id = $1', [itemId],
  ))[0]!.s);
const ledgerCount = async () => Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger'))[0]!.n);
const lastLedger = async (itemId: number) => (await query<{
  txn_type: string; reference_no: string; inward_qty: string; outward_qty: string; balance_qty: string; location: string;
}>(
  'SELECT txn_type, reference_no, inward_qty, outward_qty, balance_qty, location FROM stock_ledger WHERE item_id = $1 ORDER BY id DESC LIMIT 1',
  [itemId],
))[0]!;

async function mkItem(code: string): Promise<number> {
  const r = await request(app).post(api('/items')).set(auth(adminToken))
    .send({ itemCode: code, itemDescription: `Reversal test ${code}`, uomId, standardRate: '100' });
  expect(r.status).toBe(201);
  return r.body.data.id as number;
}

async function grnDirect(itemId: number, qty: string): Promise<{ id: number; grnNo: string }> {
  const r = await request(app).post(api('/grn')).set(auth(adminToken))
    .send({ mode: 'DIRECT', supplierId, post: true, lines: [{ itemId, grnQty: qty, rate: '100' }] });
  expect(r.status).toBe(201);
  return { id: r.body.data.id, grnNo: r.body.data.grn_no };
}

/** Raised and approved by the Super Admin (who may approve their own). */
async function approvedRequisition(itemId: number, qty: string): Promise<{ id: number; no: string; lineId: number }> {
  const created = await request(app).post(api('/requisitions')).set(auth(adminToken))
    .send({ remarks: 'Reversal test', submit: true, lines: [{ itemId, requestedQty: qty }] });
  expect(created.status).toBe(201);
  const id = created.body.data.id as number;
  expect((await request(app).post(api(`/requisitions/${id}/approve`)).set(auth(adminToken)).send({})).status).toBe(200);
  const detail = await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken));
  return { id, no: created.body.data.requisition_no, lineId: detail.body.data.lines[0].requisition_line_id };
}

async function issue(reqId: number, lineId: number, qty: string): Promise<{ id: number; no: string }> {
  const r = await request(app).post(api(`/requisitions/${reqId}/issue`)).set(auth(storeToken))
    .send({ lines: [{ requisitionLineId: lineId, issueQty: qty }] });
  expect(r.status).toBe(201);
  return { id: r.body.data.issueId, no: r.body.data.issueSlipNo };
}

const reverse = (reqId: number, issueId: number, reason: string, token = storeToken) =>
  request(app).post(api(`/requisitions/${reqId}/issues/${issueId}/reverse`)).set(auth(token)).send({ reason });
const requisition = async (id: number) => (await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken))).body.data;
const kpi = async (key: string) => {
  const r = await request(app).get(api('/analytics/kpis')).set(auth(adminToken));
  expect(r.status).toBe(200);
  return Number((r.body.data.kpis as { key: string; value: unknown }[]).find((k) => k.key === key)!.value);
};

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
  const mk = async (category: string, code: string, name: string) => {
    const r = await request(app).post(api(`/lookups/${category}`)).set(auth(adminToken)).send({ code, name });
    expect(r.status).toBe(201);
    return r.body.data.id as number;
  };
  const deptId = await mk('DEPARTMENT', 'TREV2-D', 'Reversal 2 Dept');
  poTypeId = await mk('PO_TYPE', 'TREV2-PT', 'Reversal 2 PO Type');
  uomId = (await request(app).get(api('/lookups/options')).set(auth(adminToken))).body.data.UOM[0].id;
  const supplier = await request(app).post(api('/suppliers')).set(auth(adminToken))
    .send({ supplierName: 'Reversal Two Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  expect(supplier.status).toBe(201);
  supplierId = supplier.body.data.id;
  const mkUser = async (employeeId: string, role: string) => {
    const r = await request(app).post(api('/users')).set(auth(adminToken)).send({
      employeeId, employeeName: `Reversal2 ${role}`, designation: 'test', departmentId: deptId,
      password: PASSWORD, mustChangePassword: false, roleIds: [roles.find((x) => x.code === role)!.id],
    });
    expect(r.status).toBe(201);
    return login(employeeId, PASSWORD);
  };
  storeToken = await mkUser('T-REV2-STORE', 'STORE_USER');
  buyerToken = await mkUser('T-REV2-BUYER', 'PURCHASE_USER');
});

afterAll(async () => { await closeDb?.(); });

describe('requisition issue slips can be reversed', () => {
  let itemId = 0;
  let req = { id: 0, no: '', lineId: 0 };
  let slip1 = { id: 0, no: '' };
  let slip2 = { id: 0, no: '' };
  let kpiBefore = { count: 0, issued: 0 };

  it('posts two slips against one requisition, which then cannot be cancelled', async () => {
    itemId = await mkItem('TREV2-A');
    await grnDirect(itemId, '50');
    req = await approvedRequisition(itemId, '10');
    slip1 = await issue(req.id, req.lineId, '4');
    slip2 = await issue(req.id, req.lineId, '6');
    expect(await stockOf(itemId)).toBe(40);
    expect((await requisition(req.id)).status).toBe('FULLY_ISSUED');
    kpiBefore = { count: await kpi('requisition_issue_transaction_count'), issued: await kpi('requisition_issued_qty') };
    const cancel = await request(app).post(api(`/requisitions/${req.id}/cancel`)).set(auth(adminToken)).send({ reason: 'No longer needed' });
    expect(cancel.status).toBe(422);
  });

  it('needs the issue right and a reason of at least 5 characters', async () => {
    expect((await reverse(req.id, slip2.id, 'Issued in error', buyerToken)).status).toBe(403);
    expect((await reverse(req.id, slip2.id, 'oops')).status).toBe(422);
    // The slip must belong to the requisition named in the URL.
    expect((await reverse(req.id + 9999, slip2.id, 'Issued in error')).status).toBe(404);
    expect(await stockOf(itemId)).toBe(40);
  });

  it('returns the stock through REQUISITION_REVERSAL, keeps the slip marked REVERSED and re-derives the status', async () => {
    const r = await reverse(req.id, slip2.id, 'Issued against the wrong machine');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ issueSlipNo: slip2.no, status: 'PARTIALLY_ISSUED', returnedLines: 1 });
    expect(await stockOf(itemId)).toBe(46);
    const last = await lastLedger(itemId);
    expect(last).toMatchObject({ txn_type: 'REQUISITION_REVERSAL', reference_no: slip2.no });
    expect(Number(last.inward_qty)).toBe(6);
    expect(Number(last.balance_qty)).toBe(46);

    const doc = await requisition(req.id);
    expect(doc.status).toBe('PARTIALLY_ISSUED');
    expect(Number(doc.lines[0].issued_qty)).toBe(4);
    expect(Number(doc.lines[0].pending_qty)).toBe(6);
    expect(Number(doc.total_issued_qty)).toBe(4);
    const reversed = doc.issues.find((i: { id: number }) => i.id === slip2.id);
    expect(reversed).toMatchObject({ status: 'REVERSED', reversal_reason: 'Issued against the wrong machine' });
    expect(reversed.reversed_by_name).toBeTruthy();
    expect(doc.issues.find((i: { id: number }) => i.id === slip1.id).status).toBe('POSTED');

    const audit = await query<{ action: string; entity_label: string }>(
      `SELECT action, entity_label FROM audit_logs WHERE entity = 'requisition_issue' AND entity_id = $1`, [String(slip2.id)],
    );
    expect(audit).toEqual([expect.objectContaining({ action: 'CANCEL', entity_label: slip2.no })]);
  });

  it('cannot reverse the same slip twice', async () => {
    const again = await reverse(req.id, slip2.id, 'Issued against the wrong machine');
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already reversed/i);
    expect(await stockOf(itemId)).toBe(46);
  });

  it('a new issue snapshots only what is still issued', async () => {
    const slip3 = await issue(req.id, req.lineId, '1');
    const line = (await query<{ previously_issued_qty: string }>(
      `SELECT ril.previously_issued_qty FROM requisition_issue_lines ril WHERE ril.requisition_issue_id = $1`, [slip3.id],
    ))[0]!;
    expect(Number(line.previously_issued_qty)).toBe(4); // not 10: slip 2 was reversed
    expect((await reverse(req.id, slip3.id, 'Test issue taken back')).status).toBe(200);
    expect(await stockOf(itemId)).toBe(46);
  });

  it('reversing the last slip returns the requisition to APPROVED; every total ignores reversed slips', async () => {
    const r = await reverse(req.id, slip1.id, 'Whole request withdrawn');
    expect(r.status).toBe(200);
    expect(r.body.data.status).toBe('APPROVED');
    expect(await stockOf(itemId)).toBe(50);

    const doc = await requisition(req.id);
    expect(doc).toMatchObject({ status: 'APPROVED', store_status: 'PENDING' });
    expect(Number(doc.total_issued_qty)).toBe(0);
    expect(Number(doc.lines[0].pending_qty)).toBe(10);

    const list = await request(app).get(api('/requisitions')).query({ search: req.no }).set(auth(adminToken));
    const row = list.body.data.find((x: { id: number }) => x.id === req.id);
    expect(Number(row.total_issued_qty)).toBe(0);
    expect(row.last_issue_slip_no).toBeNull();

    const queue = await request(app).get(api('/inventory/requisition-queue')).set(auth(storeToken));
    const queued = queue.body.data.find((x: { requisition_id: number }) => x.requisition_id === req.id);
    expect(Number(queued.issued_qty)).toBe(0);
    expect(Number(queued.balance_to_issue)).toBe(10);

    // slips 1 and 2 were in the "before" snapshot (slip 3 came and went after it).
    expect(await kpi('requisition_issue_transaction_count')).toBe(kpiBefore.count - 2);
    expect(await kpi('requisition_issued_qty')).toBe(kpiBefore.issued - 10);

    const item = await request(app).get(api(`/items/${itemId}`)).set(auth(adminToken));
    expect(item.status).toBe(200);
    expect(item.body.data.issueHistory).toHaveLength(0);

    const print = await request(app).get(api(`/requisitions/issues/${slip1.id}/print-view`)).set(auth(adminToken));
    expect(print.status).toBe(200);
    expect(print.text).toMatch(/REVERSED/);
    expect(print.text).toMatch(/Whole request withdrawn/);

    // Every movement on this item is ledgered, so the ledger still explains the stock.
    expect(await ledgerSumOf(itemId)).toBe(await stockOf(itemId));
  });

  it('can be cancelled once every slip is reversed', async () => {
    const cancel = await request(app).post(api(`/requisitions/${req.id}/cancel`)).set(auth(adminToken))
      .send({ reason: 'No longer needed' });
    expect(cancel.status).toBe(200);
    expect((await requisition(req.id)).status).toBe('CANCELLED');
  });
});

describe('a GRN can be cancelled once the issue that consumed it is reversed', () => {
  it('counts net requisition consumption, not any issue ever written', async () => {
    const itemId = await mkItem('TREV2-B');
    const grn = await grnDirect(itemId, '30');
    const req = await approvedRequisition(itemId, '5');
    const slip = await issue(req.id, req.lineId, '5');
    expect(await stockOf(itemId)).toBe(25);
    const locked = async () => (await request(app).get(api(`/grn/${grn.id}`)).set(auth(adminToken))).body.data.lines[0].qty_locked;
    expect(await locked()).toBe(true);

    const refused = await request(app).post(api(`/grn/${grn.id}/cancel`)).set(auth(adminToken)).send({ reason: 'Supplier sent the wrong item' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/already been issued against a Requisition/i);

    expect((await reverse(req.id, slip.id, 'Returned to store unused')).status).toBe(200);
    expect(await locked()).toBe(false);
    const cancelled = await request(app).post(api(`/grn/${grn.id}/cancel`)).set(auth(adminToken)).send({ reason: 'Supplier sent the wrong item' });
    expect(cancelled.status).toBe(200);
    expect(await stockOf(itemId)).toBe(0);
    expect(await lastLedger(itemId)).toMatchObject({ txn_type: 'GRN_REVERSAL', reference_no: grn.grnNo });
    expect(await ledgerSumOf(itemId)).toBe(0);
  });

  it('refuses in words when a direct issue has since taken the received stock', async () => {
    const itemId = await mkItem('TREV2-C');
    const grn = await grnDirect(itemId, '10');
    const dir = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken))
      .send({ recipientUserId: adminUserId, lines: [{ itemId, issueQty: 4 }] });
    expect(dir.status).toBe(201);
    const refused = await request(app).post(api(`/grn/${grn.id}/cancel`)).set(auth(adminToken)).send({ reason: 'Supplier sent the wrong item' });
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/below zero/i);
    expect(await stockOf(itemId)).toBe(6);
  });
});

describe('hard-delete refuses posted stock documents', () => {
  it('blocks a direct issue that has ledger entries, and inspects a GRN without failing', async () => {
    const itemId = await mkItem('TREV2-D');
    const grn = await grnDirect(itemId, '5');
    const dir = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken))
      .send({ recipientUserId: adminUserId, lines: [{ itemId, issueQty: 2 }] });
    expect(dir.status).toBe(201);
    const dirId = dir.body.data.id as number;

    const inspectDir = await request(app).get(api(`/admin/data-management/inspect/direct_issues/${dirId}`)).set(auth(adminToken));
    expect(inspectDir.status).toBe(200);
    expect(inspectDir.body.data.canHardDelete).toBe(false);
    expect(inspectDir.body.data.blockingReasons.join(' ')).toMatch(/ledger/i);
    const del = await request(app).post(api('/admin/data-management/hard-delete')).set(auth(adminToken))
      .send({ entity: 'direct_issues', id: dirId, confirm: 'DELETE' });
    expect(del.status).toBe(422);
    expect((await query('SELECT 1 FROM direct_issue_headers WHERE id = $1', [dirId])).length).toBe(1);

    const inspectGrn = await request(app).get(api(`/admin/data-management/inspect/grn/${grn.id}`)).set(auth(adminToken));
    expect(inspectGrn.status).toBe(200);
    expect(inspectGrn.body.data.canHardDelete).toBe(false);
    const ledgerDep = inspectGrn.body.data.dependencies.find((d: { table: string }) => d.table === 'stock_ledger');
    expect(ledgerDep.count).toBe(1);
  });
});

describe('controlled ledger-only void of the 2026-10-14 test chain', () => {
  const url = api('/admin/data-management/repair/void-test-documents');
  const REASON = 'Automated E2E test chain posted on production on 2026-10-14';
  let itemId = 0;
  let poId = 0;
  let grn = { id: 0, grnNo: '' };
  let req = { id: 0, no: '', lineId: 0 };
  let slip = { id: 0, no: '' };
  let dir = { id: 0, no: '' };
  const chain = () => [
    { type: 'GRN', number: grn.grnNo },
    { type: 'REQUISITION_ISSUE', number: slip.no },
    { type: 'DIRECT_ISSUE', number: dir.no },
  ];
  const statuses = async () => ({
    grn: (await query<{ status: string }>('SELECT status FROM grn_headers WHERE id = $1', [grn.id]))[0]!.status,
    slip: (await query<{ status: string }>('SELECT status FROM requisition_issues WHERE id = $1', [slip.id]))[0]!.status,
    dir: (await query<{ status: string }>('SELECT status FROM direct_issue_headers WHERE id = $1', [dir.id]))[0]!.status,
  });
  const UNTOUCHED = { grn: 'POSTED', slip: 'POSTED', dir: 'ISSUED' };
  const send = (body: Record<string, unknown>, token = adminToken) =>
    request(app).post(url).set(auth(token)).send({ documents: chain(), reason: REASON, ...body });

  it('reproduces item 1161480001: live 3 (its sheet figure), ledger 17', async () => {
    itemId = await mkItem('TREV2-1161480001');
    await grnDirect(itemId, '3'); // the real +3
    const po = await request(app).post(api('/purchase-orders')).set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId, poQty: '30', rate: '100', discountPct: '0', sources: [] }],
    });
    expect(po.status).toBe(201);
    poId = po.body.data.id;
    const poLineId = (await request(app).get(api(`/purchase-orders/${poId}`)).set(auth(adminToken))).body.data.lines[0].po_line_id;
    const g = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '20' }] });
    expect(g.status).toBe(201);
    grn = { id: g.body.data.id, grnNo: g.body.data.grn_no };
    req = await approvedRequisition(itemId, '5');
    slip = await issue(req.id, req.lineId, '5');
    const d = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken))
      .send({ recipientUserId: adminUserId, purpose: 'E2E Direct Issue Test', lines: [{ itemId, issueQty: 1 }] });
    expect(d.status).toBe(201);
    dir = { id: d.body.data.id, no: d.body.data.issueNo };
    for (const counted of [18, 17]) {
      const adj = await request(app).post(api('/inventory/adjustments')).set(auth(storeToken))
        .send({ itemId, actualStockQty: counted, reason: 'Physical count' });
      expect(adj.status).toBe(201);
    }
    expect(await stockOf(itemId)).toBe(17);
    expect(await ledgerSumOf(itemId)).toBe(17);
    expect((await query<{ status: string }>('SELECT status FROM purchase_order_headers WHERE id = $1', [poId]))[0]!.status)
      .toBe('PARTIALLY_RECEIVED');
    expect((await requisition(req.id)).status).toBe('FULLY_ISSUED');

    // The pre-8ccfd40 inventory sync: stock set to the sheet figure, no ledger row.
    await query('UPDATE items SET live_stock_qty = 3 WHERE id = $1', [itemId]);
    expect(await stockOf(itemId)).toBe(3);
    expect(await ledgerSumOf(itemId)).toBe(17);
  });

  it('is for a Super Admin only', async () => {
    expect((await send({}, storeToken)).status).toBe(403);
  });

  it('dry run: per-item figures, the rows it would write and a selection hash; nothing is written', async () => {
    const before = await ledgerCount();
    const dry = await send({});
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ dryRun: true, canApply: true, closesExactly: true, blockers: [] });
    expect(dry.body.data.selectionHash).toMatch(/^[0-9a-f]{64}$/);
    expect(dry.body.data.items).toHaveLength(1);
    expect(dry.body.data.items[0]).toMatchObject({
      itemId, ledgerSum: '17.0000', liveStock: '3.0000', voidNet: '-14.0000', resultingLedgerSum: '3.0000', closesExactly: true,
    });
    // Newest document first: 17 -> 18 -> 23 -> 3.
    expect(dry.body.data.items[0].rows).toEqual([
      { document: dir.no, txnType: 'DIRECT_ISSUE_REVERSAL', inwardQty: '1.0000', outwardQty: '0.0000', balanceQty: '18.0000' },
      { document: slip.no, txnType: 'REQUISITION_REVERSAL', inwardQty: '5.0000', outwardQty: '0.0000', balanceQty: '23.0000' },
      { document: grn.grnNo, txnType: 'GRN_REVERSAL', inwardQty: '0.0000', outwardQty: '20.0000', balanceQty: '3.0000' },
    ]);
    expect(dry.body.data.documents.map((d: { number: string; status: string; becomes: string }) => [d.number, d.status, d.becomes])).toEqual([
      [dir.no, 'ISSUED', 'CANCELLED'], [slip.no, 'POSTED', 'REVERSED'], [grn.grnNo, 'POSTED', 'CANCELLED'],
    ]);
    // The hash is of the plan, not of the order the documents were listed in.
    const reordered = await request(app).post(url).set(auth(adminToken))
      .send({ documents: [...chain()].reverse(), reason: REASON });
    expect(reordered.body.data.selectionHash).toBe(dry.body.data.selectionHash);
    expect(await ledgerCount()).toBe(before);
    expect(await statuses()).toEqual(UNTOUCHED);
  });

  it('applying needs the typed confirmation and the dry run hash', async () => {
    const hash = (await send({})).body.data.selectionHash as string;
    expect((await send({ dryRun: false, expectedHash: hash })).status).toBe(422);
    expect((await send({ dryRun: false, confirm: 'VOID TEST DOCUMENTS' })).status).toBe(422);
    expect(await statuses()).toEqual(UNTOUCHED);
  });

  it('a wrong hash is refused with 409 and nothing is written', async () => {
    const before = await ledgerCount();
    const r = await send({ dryRun: false, confirm: 'VOID TEST DOCUMENTS', expectedHash: '0'.repeat(64) });
    expect(r.status).toBe(409);
    expect(await ledgerCount()).toBe(before);
    expect(await statuses()).toEqual(UNTOUCHED);
    expect(await stockOf(itemId)).toBe(3);
  });

  it('refuses a void that would not close the ledger exactly to live stock', async () => {
    const before = await ledgerCount();
    const onlyGrn = { documents: [{ type: 'GRN', number: grn.grnNo }], reason: REASON };
    const dry = await request(app).post(url).set(auth(adminToken)).send(onlyGrn);
    expect(dry.status).toBe(200);
    expect(dry.body.data).toMatchObject({ canApply: false, closesExactly: false });
    expect(dry.body.data.items[0]).toMatchObject({ ledgerSum: '17.0000', voidNet: '-20.0000', resultingLedgerSum: '-3.0000', liveStock: '3.0000' });
    const r = await request(app).post(url).set(auth(adminToken))
      .send({ ...onlyGrn, dryRun: false, confirm: 'VOID TEST DOCUMENTS', expectedHash: dry.body.data.selectionHash });
    expect(r.status).toBe(409);
    expect(r.body.error.details.items[0]).toMatchObject({ itemId, ledgerSum: '17.0000', resultingLedgerSum: '-3.0000', liveStock: '3.0000' });
    expect(await ledgerCount()).toBe(before);
    expect(await statuses()).toEqual(UNTOUCHED);
  });

  it('applies: the ledger closes to live stock, live stock is unchanged, the documents are marked', async () => {
    const hash = (await send({})).body.data.selectionHash as string;
    const r = await send({ dryRun: false, confirm: 'VOID TEST DOCUMENTS', expectedHash: hash });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ dryRun: false, voided: 3, poStatusesRederived: 1 });
    expect(r.body.data.requisitionStatuses).toEqual([{ requisitionNo: req.no, from: 'FULLY_ISSUED', to: 'APPROVED' }]);

    expect(await stockOf(itemId)).toBe(3);
    expect(await ledgerSumOf(itemId)).toBe(3);
    const rows = await query<{ txn_type: string; reference_no: string; inward_qty: string; outward_qty: string; balance_qty: string; location: string }>(
      'SELECT txn_type, reference_no, inward_qty, outward_qty, balance_qty, location FROM stock_ledger WHERE item_id = $1 ORDER BY id DESC LIMIT 3',
      [itemId],
    );
    expect(rows.reverse().map((x) => [x.txn_type, x.reference_no, Number(x.inward_qty) - Number(x.outward_qty), Number(x.balance_qty)])).toEqual([
      ['DIRECT_ISSUE_REVERSAL', dir.no, 1, 18],
      ['REQUISITION_REVERSAL', slip.no, 5, 23],
      ['GRN_REVERSAL', grn.grnNo, -20, 3],
    ]);
    expect(rows.every((x) => /ledger-only void/i.test(x.location))).toBe(true);

    expect(await statuses()).toEqual({ grn: 'CANCELLED', slip: 'REVERSED', dir: 'CANCELLED' });
    expect((await query<{ cancel_reason: string }>('SELECT cancel_reason FROM grn_headers WHERE id = $1', [grn.id]))[0]!.cancel_reason).toBe(REASON);
    expect((await query<{ reversal_reason: string }>('SELECT reversal_reason FROM requisition_issues WHERE id = $1', [slip.id]))[0]!.reversal_reason).toBe(REASON);
    expect((await query<{ cancel_reason: string }>('SELECT cancel_reason FROM direct_issue_headers WHERE id = $1', [dir.id]))[0]!.cancel_reason).toBe(REASON);
    // Nothing deleted: the MLN stays with its cancelled GRN.
    expect((await query('SELECT 1 FROM grn_line_mlns WHERE grn_id = $1', [grn.id])).length).toBe(1);
    expect((await query<{ status: string }>('SELECT status FROM purchase_order_headers WHERE id = $1', [poId]))[0]!.status).toBe('OPEN');
    expect((await requisition(req.id)).status).toBe('APPROVED');

    const audit = await query<{ entity: string; entity_label: string }>(
      `SELECT entity, entity_label FROM audit_logs WHERE action = 'CANCEL' AND entity_label = ANY($1::text[]) ORDER BY id`,
      [[grn.grnNo, slip.no, dir.no]],
    );
    expect(audit.map((a) => [a.entity, a.entity_label])).toEqual([
      ['direct_issue', dir.no], ['requisition_issue', slip.no], ['grn', grn.grnNo],
    ]);
    const recon = await request(app).get(api('/items/analysis/stock-reconciliation')).query({ search: 'TREV2-1161480001' }).set(auth(adminToken));
    expect(recon.body.data[0]).toMatchObject({ mismatch: false });
  });

  it('cannot be applied a second time', async () => {
    const before = await ledgerCount();
    const dry = await send({});
    expect(dry.body.data.canApply).toBe(false);
    expect(dry.body.data.blockers.join(' ')).toMatch(/CANCELLED|REVERSED/);
    const r = await send({ dryRun: false, confirm: 'VOID TEST DOCUMENTS', expectedHash: dry.body.data.selectionHash });
    expect(r.status).toBe(409);
    expect(await ledgerCount()).toBe(before);
    expect(await stockOf(itemId)).toBe(3);
  });

  it('leaves the test requisition cancellable', async () => {
    const cancel = await request(app).post(api(`/requisitions/${req.id}/cancel`)).set(auth(adminToken))
      .send({ reason: 'Automated test record' });
    expect(cancel.status).toBe(200);
  });
});
