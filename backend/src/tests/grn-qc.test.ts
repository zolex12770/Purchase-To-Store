/**
 * Integration tests — GRN posting, cancelling and quality inspection
 * (2026-10-17, audit A7 F03, F04, F10, F16).
 *
 *   1. Every posting route holds an item that needs inspection out of stock and
 *      raises its inspection: POST /grn and PUT /grn/:id with post:true (the GRN
 *      form), POST /grn/:id/post, and a line added to a posted GRN. Other lines
 *      go into stock with their MLN, as before.
 *   2. A line under inspection, on edit: while QC is open a corrected quantity
 *      moves no stock; once QC has decided, the received quantity is locked and
 *      QC's accepted and rejected quantities are kept.
 *   3. Cancel takes back out only what went into stock (a held line nothing, a
 *      passed line what QC accepted), closes the inspections still open, and
 *      refuses in words, before writing anything, when the stock has left.
 *   4. A QC decision is refused on a GRN that is not POSTED, and a failed one
 *      ('Full Rejection / RTV') that accepts any quantity.
 *   5. The GRN list's QC tiles count the codes GRNs store.
 *   6. The label PDF does not count a print, POST /grn/labels/print does, and a
 *      PDF's file name carries no slash or quote.
 *   7. A save that another user's cancel or post overtook is refused: an edit
 *      of a GRN cancelled meanwhile moves no stock and raises no inspection on
 *      it, and a draft posted meanwhile keeps the lines it was posted with.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
let uomId = 0;
let supplierId = 0;
let poTypeId = 0;
const PASSWORD = 'GrnQc@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;

interface GrnLine {
  id: number; line_no: number; item_id: number; grn_qty: string; accepted_qty: string | null;
  rejected_qty: string | null; batch_no: string; mln_no: string | null; mln_sr_no: number | null;
}

const stockOf = async (itemId: number) =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const ledgerCount = async () => Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger'))[0]!.n);
const grnOf = async (id: number) =>
  (await query<{ status: string; qc_status: string }>('SELECT status, qc_status FROM grn_headers WHERE id = $1', [id]))[0]!;
const inspectionsOf = (grnId: number) => query<{
  id: string; grn_line_id: string; status: string; received_qty: string; accepted_qty: string; rejected_qty: string;
}>('SELECT id, grn_line_id, status, received_qty, accepted_qty, rejected_qty FROM qc_inspections WHERE grn_id = $1 ORDER BY id', [grnId]);
const grnLedger = async (grnId: number) => (await query<{ item_id: string; txn_type: string; inward_qty: string; outward_qty: string }>(
  `SELECT item_id, txn_type, inward_qty, outward_qty FROM stock_ledger
    WHERE reference_type = 'GRN' AND reference_id = $1 ORDER BY id`, [grnId],
)).map((r) => [Number(r.item_id), r.txn_type, Number(r.inward_qty) - Number(r.outward_qty)]);
const linesOf = async (grnId: number) =>
  (await request(app).get(api(`/grn/${grnId}`)).set(auth(adminToken))).body.data.lines as GrnLine[];
const lineOfItem = (lines: GrnLine[], itemId: number) => lines.find((l) => Number(l.item_id) === itemId)!;

async function mkItem(code: string, qcRequired: boolean): Promise<number> {
  const r = await request(app).post(api('/items')).set(auth(adminToken))
    .send({ itemCode: code, itemDescription: `GRN QC test ${code}`, uomId, standardRate: '10', qcRequired });
  expect(r.status).toBe(201);
  return Number(r.body.data.id);
}

async function mkSupplier(name: string): Promise<number> {
  const r = await request(app).post(api('/suppliers')).set(auth(adminToken))
    .send({ supplierName: name, city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  expect(r.status).toBe(201);
  return Number(r.body.data.id);
}

/** A Direct GRN, posted unless `post` is false — the GRN form's own call. */
async function receive(
  lines: { itemId: number; qty: string }[], opts: { post?: boolean; supplier?: number } = {},
): Promise<{ id: number; grnNo: string }> {
  const r = await request(app).post(api('/grn')).set(auth(adminToken)).send({
    mode: 'DIRECT', supplierId: opts.supplier ?? supplierId, post: opts.post ?? true,
    lines: lines.map((l) => ({ itemId: l.itemId, grnQty: l.qty, rate: '10' })),
  });
  expect(r.status).toBe(201);
  return { id: Number(r.body.data.id), grnNo: r.body.data.grn_no as string };
}

async function issuedPo(itemId: number, qty: string): Promise<{ id: number; lineId: number }> {
  const po = await request(app).post(api('/purchase-orders')).set(auth(adminToken)).send({
    supplierId, poTypeId, issue: true,
    lines: [{ itemId, poQty: qty, rate: '10', discountPct: '0', sources: [] }],
  });
  expect(po.status).toBe(201);
  const id = Number(po.body.data.id);
  const lineId = Number((await request(app).get(api(`/purchase-orders/${id}`)).set(auth(adminToken))).body.data.lines[0].po_line_id);
  return { id, lineId };
}

const poStatus = async (poId: number) =>
  (await query<{ status: string }>('SELECT status FROM purchase_order_headers WHERE id = $1', [poId]))[0]!.status;

/** PUT of a posted Direct GRN, as the GRN form sends it (no accepted / rejected quantity). */
const editLines = (grnId: number, lines: Record<string, unknown>[]) =>
  request(app).put(api(`/grn/${grnId}`)).set(auth(adminToken)).send({ mode: 'DIRECT', supplierId, post: true, lines });

const decide = (inspectionId: number, body: Record<string, unknown>) =>
  request(app).post(api(`/qc/inspections/${inspectionId}/decide`)).set(auth(adminToken)).send(body);

const cancel = (grnId: number) =>
  request(app).post(api(`/grn/${grnId}/cancel`)).set(auth(adminToken)).send({ reason: 'Supplier sent the wrong item' });

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
  const pt = await request(app).post(api('/lookups/PO_TYPE')).set(auth(adminToken)).send({ code: 'TGRNQC-PT', name: 'GRN QC PO Type' });
  expect(pt.status).toBe(201);
  poTypeId = Number(pt.body.data.id);
  uomId = (await request(app).get(api('/lookups/options')).set(auth(adminToken))).body.data.UOM[0].id;
  supplierId = await mkSupplier('GRN QC Supplier Pvt Ltd');
  const store = await request(app).post(api('/users')).set(auth(adminToken)).send({
    employeeId: 'T-GRNQC-STORE', employeeName: 'GRN QC Store', designation: 'test',
    password: PASSWORD, mustChangePassword: false, roleIds: [roles.find((x) => x.code === 'STORE_USER')!.id],
  });
  expect(store.status).toBe(201);
  storeToken = await login('T-GRNQC-STORE', PASSWORD);
});

afterAll(async () => { await closeDb?.(); });

/* ── 1. Every posting route holds an item that needs inspection ─────────────── */

describe('every posting route holds an item that needs inspection', () => {
  it('POST /grn with post:true (the GRN form): the inspected line is held, the other goes into stock', async () => {
    const qcItem = await mkItem('TGRNQC-A1', true);
    const plain = await mkItem('TGRNQC-A2', false);
    const grn = await receive([{ itemId: qcItem, qty: '10' }, { itemId: plain, qty: '5' }]);

    expect(await grnOf(grn.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await stockOf(qcItem)).toBe(0);
    expect(await stockOf(plain)).toBe(5);

    const lines = await linesOf(grn.id);
    expect(lineOfItem(lines, qcItem).mln_no).toBeNull();
    expect(lineOfItem(lines, plain).mln_no).toMatch(/^P\d{12}$/);
    expect(lineOfItem(lines, plain).mln_sr_no).toBe(2); // its own line number

    const inspections = await inspectionsOf(grn.id);
    expect(inspections.map((i) => [Number(i.grn_line_id), i.status, Number(i.received_qty)]))
      .toEqual([[Number(lineOfItem(lines, qcItem).id), 'PENDING_QC', 10]]);
    expect(await grnLedger(grn.id)).toEqual([[plain, 'GRN_INWARD', 5]]);

    const audit = await query<{ after_data: Record<string, unknown> }>(
      `SELECT after_data FROM audit_logs WHERE entity = 'grn' AND entity_id = $1 AND action = 'POST'`, [String(grn.id)],
    );
    expect(audit[0]!.after_data).toMatchObject({ qcStatus: 'PENDING_QC', heldForQc: 1 });
  });

  it('PUT /grn/:id with post:true on a draft', async () => {
    const qcItem = await mkItem('TGRNQC-B1', true);
    const draft = await receive([{ itemId: qcItem, qty: '4' }], { post: false });
    expect(await grnOf(draft.id)).toEqual({ status: 'DRAFT', qc_status: 'NOT_APPLICABLE' });

    const r = await request(app).put(api(`/grn/${draft.id}`)).set(auth(adminToken))
      .send({ mode: 'DIRECT', supplierId, post: true, lines: [{ itemId: qcItem, grnQty: '4', rate: '10' }] });
    expect(r.status).toBe(200);
    expect(await grnOf(draft.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await stockOf(qcItem)).toBe(0);
    expect((await inspectionsOf(draft.id)).map((i) => [i.status, Number(i.received_qty)])).toEqual([['PENDING_QC', 4]]);
    expect(await grnLedger(draft.id)).toEqual([]);
  });

  it('against a purchase order, by POST /grn and by POST /grn/:id/post: held, while the PO counts the receipt', async () => {
    const qcItem = await mkItem('TGRNQC-C1', true);
    const viaForm = await issuedPo(qcItem, '10');
    const formGrn = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: viaForm.lineId, grnQty: '10' }] });
    expect(formGrn.status).toBe(201);
    expect(formGrn.body.data).toMatchObject({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await poStatus(viaForm.id)).toBe('COMPLETED');

    const viaPost = await issuedPo(qcItem, '8');
    const draft = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', post: false, lines: [{ poLineId: viaPost.lineId, grnQty: '6' }] });
    expect(draft.status).toBe(201);
    const posted = await request(app).post(api(`/grn/${draft.body.data.id}/post`)).set(auth(adminToken)).send({});
    expect(posted.status).toBe(200);
    expect(posted.body.data).toMatchObject({ qcStatus: 'PENDING_QC', heldForQc: 1, poStatuses: ['PARTIALLY_RECEIVED'] });
    expect(posted.body.data.message).toMatch(/1 line\(s\) are held for quality inspection/);

    expect(await stockOf(qcItem)).toBe(0);
    expect((await inspectionsOf(Number(draft.body.data.id))).map((i) => i.status)).toEqual(['PENDING_QC']);
  });

  it('a line added to a posted GRN is held the same way', async () => {
    const plain = await mkItem('TGRNQC-D1', false);
    const qcItem = await mkItem('TGRNQC-D2', true);
    const grn = await receive([{ itemId: plain, qty: '5' }]);
    expect((await grnOf(grn.id)).qc_status).toBe('NOT_APPLICABLE');
    const [line] = await linesOf(grn.id);

    const r = await editLines(grn.id, [
      { id: line!.id, itemId: plain, grnQty: '5', rate: '10' },
      { itemId: qcItem, grnQty: '3', rate: '10' },
    ]);
    expect(r.status).toBe(200);
    expect(await grnOf(grn.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await stockOf(plain)).toBe(5);
    expect(await stockOf(qcItem)).toBe(0);

    const added = lineOfItem(await linesOf(grn.id), qcItem);
    expect(added.line_no).toBe(2);
    expect(added.mln_no).toBeNull();
    expect((await inspectionsOf(grn.id)).map((i) => [Number(i.grn_line_id), i.status])).toEqual([[Number(added.id), 'PENDING_QC']]);
  });
});

/* ── 2. A line under inspection, on edit ───────────────────────────────────── */

describe('a line under inspection, on edit', () => {
  it('while QC is open: a corrected quantity moves no stock and becomes the inspection\'s', async () => {
    const qcItem = await mkItem('TGRNQC-E1', true);
    const grn = await receive([{ itemId: qcItem, qty: '10' }]);
    const [line] = await linesOf(grn.id);
    const ledgerBefore = await ledgerCount();

    const r = await editLines(grn.id, [{ id: line!.id, itemId: qcItem, grnQty: '12', rate: '10' }]);
    expect(r.status).toBe(200);
    expect(await stockOf(qcItem)).toBe(0);
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(Number((await inspectionsOf(grn.id))[0]!.received_qty)).toBe(12);
  });

  it('once QC has decided: the received quantity is locked, and QC\'s quantities stay as QC recorded them', async () => {
    const qcItem = await mkItem('TGRNQC-E2', true);
    const grn = await receive([{ itemId: qcItem, qty: '10' }]);
    const [inspection] = await inspectionsOf(grn.id);
    const passed = await decide(Number(inspection!.id), { status: 'QC_PASSED', acceptedQty: 8, rejectedQty: 2, remarks: 'Two dented' });
    expect(passed.status).toBe(200);
    expect(passed.body.data).toMatchObject({ stockMoved: true, overallQcStatus: 'QC_PASSED' });
    expect(await stockOf(qcItem)).toBe(8);
    const released = (await linesOf(grn.id))[0]!;
    expect(released.mln_no).toMatch(/^P\d{12}$/);
    expect(await grnLedger(grn.id)).toEqual([[qcItem, 'GRN_INWARD', 8]]);

    // The GRN form sends no accepted quantity: saving a new batch number must not
    // put the 2 rejected back into stock or erase what QC recorded.
    const saved = await editLines(grn.id, [{ id: released.id, itemId: qcItem, grnQty: '10', rate: '10', batchNo: 'B-77' }]);
    expect(saved.status).toBe(200);
    expect(await stockOf(qcItem)).toBe(8);
    const after = (await linesOf(grn.id))[0]!;
    expect([Number(after.accepted_qty), Number(after.rejected_qty), after.batch_no]).toEqual([8, 2, 'B-77']);

    const changed = await editLines(grn.id, [{ id: released.id, itemId: qcItem, grnQty: '11', rate: '10' }]);
    expect(changed.status).toBe(422);
    expect(changed.body.error.message).toMatch(/been through quality inspection \(passed\)/);
    expect(await stockOf(qcItem)).toBe(8);
  });
});

/* ── 3. Cancelling a GRN ───────────────────────────────────────────────────── */

let closedInspection = 0;
let failedInspectionOfCancelledGrn = 0;

describe('cancelling a GRN', () => {
  it('takes back out only what went into stock, and closes the inspections still open', async () => {
    const qcItem = await mkItem('TGRNQC-F1', true);
    const plain = await mkItem('TGRNQC-F2', false);
    const grn = await receive([{ itemId: qcItem, qty: '10' }, { itemId: plain, qty: '5' }]);

    // Before 2026-10-17 this took the held 10 out too, and failed: stock 0 - 10 < 0.
    const r = await cancel(grn.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ linesReversed: 1, qcInspectionsClosed: 1 });
    expect(r.body.data.message).toMatch(/stock was reversed\. 1 open quality inspection\(s\) were closed\./);
    expect(await stockOf(plain)).toBe(0);
    expect(await stockOf(qcItem)).toBe(0);
    expect(await grnLedger(grn.id)).toEqual([[plain, 'GRN_INWARD', 5], [plain, 'GRN_REVERSAL', -5]]);

    const [inspection] = await inspectionsOf(grn.id);
    expect(inspection!.status).toBe('CANCELLED');
    expect(await grnOf(grn.id)).toEqual({ status: 'CANCELLED', qc_status: 'CANCELLED' });
    closedInspection = Number(inspection!.id);

    const queue = await request(app).get(api('/qc/inspections?status=PENDING_QC')).set(auth(adminToken));
    expect(queue.body.data.some((i: { id: number }) => Number(i.id) === closedInspection)).toBe(false);
  });

  it('says so when none of the receipt had entered stock, and keeps the GRN with its inspection', async () => {
    const qcItem = await mkItem('TGRNQC-F3', true);
    const grn = await receive([{ itemId: qcItem, qty: '3' }]);
    const r = await cancel(grn.id);
    expect(r.status).toBe(200);
    expect(r.body.data.message).toMatch(/None of its material had entered stock, so stock is unchanged/);
    expect(await grnLedger(grn.id)).toEqual([]);

    // No ledger entry, but the closed inspection refers to its line: hard delete
    // is refused in words instead of failing on the foreign key.
    const inspect = await request(app).get(api(`/admin/data-management/inspect/grn/${grn.id}`)).set(auth(adminToken));
    expect(inspect.status).toBe(200);
    expect(inspect.body.data.canHardDelete).toBe(false);
    expect(inspect.body.data.blockingReasons.join(' ')).toMatch(/1 quality inspection record/);
    const del = await request(app).post(api('/admin/data-management/hard-delete')).set(auth(adminToken))
      .send({ entity: 'grn', id: grn.id, confirm: 'DELETE' });
    expect(del.status).toBe(422);
    expect((await query('SELECT 1 FROM grn_headers WHERE id = $1', [grn.id])).length).toBe(1);
  });

  it('gives back what QC accepted on a passed line, and nothing for a failed one', async () => {
    const qcItem = await mkItem('TGRNQC-G1', true);
    const grn = await receive([{ itemId: qcItem, qty: '10' }, { itemId: qcItem, qty: '6' }]);
    const [a, b] = await inspectionsOf(grn.id);
    expect((await decide(Number(a!.id), { status: 'QC_PASSED', acceptedQty: 7, rejectedQty: 3 })).status).toBe(200);
    expect((await decide(Number(b!.id), { status: 'QC_FAILED', acceptedQty: 0, rejectedQty: 6, rejectionReason: 'Wrong grade' })).status).toBe(200);
    expect(await stockOf(qcItem)).toBe(7);
    expect((await grnOf(grn.id)).qc_status).toBe('QC_FAILED');

    const r = await cancel(grn.id);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ linesReversed: 1, qcInspectionsClosed: 0 });
    expect(await stockOf(qcItem)).toBe(0);
    expect(await grnLedger(grn.id)).toEqual([[qcItem, 'GRN_INWARD', 7], [qcItem, 'GRN_REVERSAL', -7]]);
    // Decided inspections keep what QC found.
    expect((await inspectionsOf(grn.id)).map((i) => i.status)).toEqual(['QC_PASSED', 'QC_FAILED']);
    expect(await grnOf(grn.id)).toEqual({ status: 'CANCELLED', qc_status: 'QC_FAILED' });
    failedInspectionOfCancelledGrn = Number(b!.id);
  });

  it('refuses in words, before writing anything, when the received stock has already left', async () => {
    const plain = await mkItem('TGRNQC-H1', false);
    const qcItem = await mkItem('TGRNQC-H2', true);
    const po = await issuedPo(plain, '20');
    const g = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: po.lineId, grnQty: '10' }] });
    expect(g.status).toBe(201);
    const extra = await receive([{ itemId: plain, qty: '6' }, { itemId: plain, qty: '4' }, { itemId: qcItem, qty: '2' }]);
    expect(await stockOf(plain)).toBe(20);
    // 13 of the 20 leave through a direct issue, which the requisition guard does not see.
    const dir = await request(app).post(api('/inventory/direct-issues')).set(auth(storeToken))
      .send({ recipientUserId: adminUserId, lines: [{ itemId: plain, issueQty: 13 }] });
    expect(dir.status).toBe(201);
    expect(await stockOf(plain)).toBe(7);

    const ledgerBefore = await ledgerCount();
    const r = await cancel(extra.id);
    expect(r.status).toBe(422);
    // Its two lines of the same item are added up: 10 out of 7.
    expect(r.body.error.message).toMatch(
      /cannot be cancelled: it would take 10\.0000 of TGRNQC-H1 back out of stock, but only 7\.0000 is in stock now, so the stock would go below zero/,
    );
    expect(r.body.error.details.items).toEqual([
      { itemCode: 'TGRNQC-H1', inStock: '7.0000', cancelTakesOut: '10.0000', shortBy: '3.0000' },
    ]);
    // Nothing was written: not the header, the PO, the ledger, the stock or QC.
    expect(await grnOf(extra.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await ledgerCount()).toBe(ledgerBefore);
    expect(await stockOf(plain)).toBe(7);
    expect((await inspectionsOf(extra.id)).map((i) => i.status)).toEqual(['PENDING_QC']);

    // The PO receipt is refused the same way, and its purchase order keeps the receipt.
    const poCancel = await cancel(Number(g.body.data.id));
    expect(poCancel.status).toBe(422);
    expect(poCancel.body.error.message).toMatch(/below zero/);
    expect(await poStatus(po.id)).toBe('PARTIALLY_RECEIVED');
  });
});

/* ── 4. QC decisions ───────────────────────────────────────────────────────── */

describe('a quality decision', () => {
  it('is refused on a cancelled GRN, whether its inspection was closed or had failed', async () => {
    const before = await ledgerCount();
    for (const id of [closedInspection, failedInspectionOfCancelledGrn]) {
      expect(id).toBeGreaterThan(0);
      const r = await decide(id, { status: 'QC_PASSED', acceptedQty: 1, rejectedQty: 0 });
      expect(r.status).toBe(422);
      expect(r.body.error.message).toMatch(/has been cancelled, so this inspection is closed/);
    }
    // A pass used to put the stock of the cancelled receipt back.
    expect(await ledgerCount()).toBe(before);
    expect(await stockOf(Number((await query<{ item_id: string }>('SELECT item_id FROM qc_inspections WHERE id = $1', [failedInspectionOfCancelledGrn]))[0]!.item_id))).toBe(0);
  });

  it('keeps an interim finding on the inspection, and wants a final one to account for all that was received', async () => {
    const qcItem = await mkItem('TGRNQC-J2', true);
    const grn = await receive([{ itemId: qcItem, qty: '10' }]);
    const id = Number((await inspectionsOf(grn.id))[0]!.id);

    // 4 tested good and 1 cracked so far; this failed on the GRN line's own CHECK
    // (accepted + rejected = received) as a bare "violate a data rule" error.
    const interim = await decide(id, { status: 'QC_IN_PROGRESS', acceptedQty: 4, rejectedQty: 1, rejectionReason: 'One cracked' });
    expect(interim.status).toBe(200);
    expect(await stockOf(qcItem)).toBe(0);
    const [line] = await linesOf(grn.id);
    expect([line!.accepted_qty, line!.rejected_qty]).toEqual([null, null]);
    expect((await grnOf(grn.id)).qc_status).toBe('QC_IN_PROGRESS');

    // The store may still correct the received quantity, but not below what QC has counted.
    const below = await editLines(grn.id, [{ id: line!.id, itemId: qcItem, grnQty: '4', rate: '10' }]);
    expect(below.status).toBe(422);
    expect(below.body.error.message).toMatch(/QC has already recorded 5\.0000 as accepted or rejected/);
    expect((await editLines(grn.id, [{ id: line!.id, itemId: qcItem, grnQty: '9', rate: '10' }])).status).toBe(200);

    const short = await decide(id, { status: 'QC_PASSED', acceptedQty: 7, rejectedQty: 1, rejectionReason: 'One cracked' });
    expect(short.status).toBe(422);
    expect(short.body.error.message).toMatch(/must equal received \(9\)/);
    expect(await stockOf(qcItem)).toBe(0);

    const final = await decide(id, { status: 'ACCEPTED_WITH_DEVIATION', acceptedQty: 8, rejectedQty: 1, rejectionReason: 'One cracked' });
    expect(final.status).toBe(200);
    expect(await stockOf(qcItem)).toBe(8);
    const [decided] = await linesOf(grn.id);
    expect([Number(decided!.accepted_qty), Number(decided!.rejected_qty)]).toEqual([8, 1]);
    expect((await grnOf(grn.id)).qc_status).toBe('QC_PASSED');
  });

  it("a failed inspection rejects the whole lot, as the QC screen labels it ('Full Rejection / RTV')", async () => {
    const qcItem = await mkItem('TGRNQC-J3', true);
    const grn = await receive([{ itemId: qcItem, qty: '5' }]);
    const id = Number((await inspectionsOf(grn.id))[0]!.id);
    const decisionAudits = async () => Number((await query<{ n: string }>(
      `SELECT COUNT(*) AS n FROM audit_logs WHERE entity = 'qc_inspection' AND entity_id = $1`, [String(id)],
    ))[0]!.n);

    // Each was recorded: a 'failed' lot with 2 (or all 5, or 0.0001) accepted on its GRN
    // line, no stock moved, and a toast saying nothing was accepted (T3 review follow-up).
    for (const body of [
      { status: 'QC_FAILED', acceptedQty: 2, rejectedQty: 3, rejectionReason: 'Three cracked' },
      { status: 'QC_FAILED', acceptedQty: 5, rejectedQty: 0, rejectionReason: 'Test certificate missing' },
      { status: 'QC_FAILED', acceptedQty: '0.0001', rejectedQty: '4.9999', rejectionReason: 'Off spec' },
      { status: 'QC_FAILED', acceptedQty: 2, rejectedQty: 0 }, // short, and no reason: the acceptance is what is wrong
    ]) {
      const r = await decide(id, body);
      expect(r.status, JSON.stringify(body)).toBe(422);
      expect(r.body.error.message)
        .toBe('A failed inspection rejects the whole lot; record a partial acceptance as Accepted with deviation.');
      expect(r.body.error.issues).toEqual([{ field: 'acceptedQty', message: 'A failed inspection accepts nothing.' }]);
    }
    // Nothing was written: not the inspection, the GRN line, the GRN, the stock or the audit trail.
    expect((await inspectionsOf(grn.id)).map((i) => [i.status, Number(i.accepted_qty), Number(i.rejected_qty)]))
      .toEqual([['PENDING_QC', 0, 0]]);
    const [held] = await linesOf(grn.id);
    expect([held!.accepted_qty, held!.rejected_qty]).toEqual([null, null]);
    expect(await grnOf(grn.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect(await stockOf(qcItem)).toBe(0);
    expect(await decisionAudits()).toBe(0);

    // The failure itself: 0 accepted and all 5 rejected, on the inspection and the GRN line,
    // and the answer carries that split, which the QC screen's toast is worded from.
    const failed = await decide(id, { status: 'QC_FAILED', acceptedQty: 0, rejectedQty: 5, rejectionReason: 'Three cracked' });
    expect(failed.status).toBe(200);
    expect(failed.body.data).toMatchObject({ status: 'QC_FAILED', stockMoved: false, acceptedQty: '0.0000', rejectedQty: '5.0000' });
    expect((await inspectionsOf(grn.id)).map((i) => [i.status, Number(i.accepted_qty), Number(i.rejected_qty)]))
      .toEqual([['QC_FAILED', 0, 5]]);
    const [rejected] = await linesOf(grn.id);
    expect([Number(rejected!.accepted_qty), Number(rejected!.rejected_qty)]).toEqual([0, 5]);
    expect(await grnOf(grn.id)).toEqual({ status: 'POSTED', qc_status: 'QC_FAILED' });
    expect(await stockOf(qcItem)).toBe(0);

    // A partial acceptance is recorded the way the message says, and releases what it accepts.
    const deviation = await decide(id, {
      status: 'ACCEPTED_WITH_DEVIATION', acceptedQty: 2, rejectedQty: 3, rejectionReason: 'Three cracked; two taken on concession',
    });
    expect(deviation.status).toBe(200);
    expect(deviation.body.data).toMatchObject({ stockMoved: true, acceptedQty: '2.0000', rejectedQty: '3.0000' });
    expect(await stockOf(qcItem)).toBe(2);
    const [released] = await linesOf(grn.id);
    expect([Number(released!.accepted_qty), Number(released!.rejected_qty)]).toEqual([2, 3]);
  });

  it('is refused on a draft GRN', async () => {
    // Posting raises inspections, so only a planted row can sit on a draft.
    const qcItem = await mkItem('TGRNQC-J1', true);
    const draft = await receive([{ itemId: qcItem, qty: '3' }], { post: false });
    const [line] = await linesOf(draft.id);
    const [row] = await query<{ id: string }>(
      `INSERT INTO qc_inspections (grn_id, grn_line_id, grn_no, item_id, item_code, item_name, received_qty)
       VALUES ($1, $2, $3, $4, 'TGRNQC-J1', 'planted', 3) RETURNING id`,
      [draft.id, line!.id, draft.grnNo, qcItem],
    );
    const r = await decide(Number(row!.id), { status: 'QC_PASSED', acceptedQty: 3, rejectedQty: 0 });
    expect(r.status).toBe(422);
    expect(r.body.error.message).toMatch(/still a draft/);
    expect(await stockOf(qcItem)).toBe(0);
  });
});

/* ── 5. The GRN list's QC tiles ────────────────────────────────────────────── */

describe('the GRN list QC tiles', () => {
  it('count the codes GRNs really store', async () => {
    const sup = await mkSupplier('GRN QC Tiles Supplier Pvt Ltd');
    const qcItem = await mkItem('TGRNQC-K1', true);
    const plain = await mkItem('TGRNQC-K2', false);
    const g = (itemId: number) => receive([{ itemId, qty: '5' }], { supplier: sup });
    const decideOnly = async (grnId: number, body: Record<string, unknown>) => {
      const r = await decide(Number((await inspectionsOf(grnId))[0]!.id), body);
      expect([r.status, r.body.error?.message]).toEqual([200, undefined]);
    };

    await g(qcItem); // PENDING_QC
    await decideOnly((await g(qcItem)).id, { status: 'QC_IN_PROGRESS' });
    await decideOnly((await g(qcItem)).id, { status: 'ON_HOLD' });
    await decideOnly((await g(qcItem)).id, { status: 'QC_PASSED', acceptedQty: 5 });
    await decideOnly((await g(qcItem)).id, { status: 'QC_FAILED', rejectedQty: 5, rejectionReason: 'Off spec' });
    // The decision route records a deviation pass on the GRN as QC_PASSED, but the
    // code is allowed there (migration 021) and is counted when a GRN holds it.
    const deviation = await g(qcItem);
    await query(`UPDATE grn_headers SET qc_status = 'ACCEPTED_WITH_DEVIATION' WHERE id = $1`, [deviation.id]);
    await g(plain); // NOT_APPLICABLE
    expect((await cancel((await g(qcItem)).id)).status).toBe(200); // CANCELLED: no longer pending

    const list = await request(app).get(api(`/grn?supplierId=${sup}`)).set(auth(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.meta.totals).toMatchObject({ grnCount: 8, pendingQcCount: 3, qcPassedCount: 2, qcFailedCount: 1 });
    expect(list.body.meta.totals.qcStatusCounts).toEqual({
      PENDING_QC: 1, QC_IN_PROGRESS: 1, ON_HOLD: 1, QC_PASSED: 1, ACCEPTED_WITH_DEVIATION: 1,
      QC_FAILED: 1, NOT_APPLICABLE: 1, CANCELLED: 1,
    });

    // The Pending QC tile and the list filtered by the same codes agree.
    const held = await request(app).get(api(`/grn?supplierId=${sup}&qcStatus=PENDING_QC,QC_IN_PROGRESS,ON_HOLD`)).set(auth(adminToken));
    expect(held.body.meta.total).toBe(3);
  });
});

/* ── 6. Label printing and PDF file names ──────────────────────────────────── */

describe('label printing and PDF file names', () => {
  it('the label PDF does not count a print; POST /grn/labels/print does', async () => {
    const plain = await mkItem('TGRNQC-L1', false);
    const grn = await receive([{ itemId: plain, qty: '4' }]);
    const label = (await request(app).get(api(`/grn/labels?grnId=${grn.id}`)).set(auth(adminToken))).body.data[0] as { id: number };
    const printCount = async () =>
      Number((await query<{ n: string }>('SELECT print_count AS n FROM grn_line_mlns WHERE id = $1', [label.id]))[0]!.n);

    const pdf = await request(app).get(api(`/grn/labels/pdf?ids=${label.id}`)).set(auth(adminToken));
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toMatch(/application\/pdf/);
    expect(pdf.headers['content-disposition']).toMatch(/^attachment; filename="labels-\d+\.pdf"$/);
    expect(await printCount()).toBe(0);

    expect((await request(app).post(api('/grn/labels/print')).set(auth(adminToken)).send({ ids: [label.id] })).status).toBe(200);
    expect(await printCount()).toBe(1);
  });

  it('a PDF is named after its document, without slashes or quotes', async () => {
    const plain = await mkItem('TGRNQC-L2', false);
    const po = await issuedPo(plain, '5');
    // As the PO register import of 2026-10-16 numbered them.
    await query(`UPDATE purchase_order_headers SET po_no = 'Z/PM/00368' WHERE id = $1`, [po.id]);
    const poPdf = await request(app).get(api(`/purchase-orders/${po.id}/pdf`)).set(auth(adminToken));
    expect(poPdf.status).toBe(200);
    expect(poPdf.headers['content-disposition']).toBe('attachment; filename="Z-PM-00368.pdf"');

    const grn = await receive([{ itemId: plain, qty: '1' }]);
    await query(`UPDATE grn_headers SET grn_no = 'GRN/"Q"/1' WHERE id = $1`, [grn.id]);
    const grnPdf = await request(app).get(api(`/grn/${grn.id}/pdf`)).set(auth(adminToken));
    expect(grnPdf.status).toBe(200);
    expect(grnPdf.headers['content-disposition']).toBe('attachment; filename="GRN-Q-1.pdf"');
  });
});

/* ── 7. An edit overtaken by another user's post or cancel ─────────────────── */

/** Waits, up to five seconds, for `done` to come true. */
async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !done(); i += 1) await new Promise((r) => setTimeout(r, 10));
  expect(done()).toBe(true);
}

/**
 * Sends `edit`, then `other`, while a transaction holds the database the way an
 * inventory sheet sync does, and lets go once both are waiting: the edit on the
 * status it reads before its transaction, the other on its transaction. PGlite
 * serves them in that order (db/driver.ts), so the other request commits
 * between the edit's status read and the edit's own transaction.
 */
async function overtaken(edit: () => request.Test, other: () => request.Test): Promise<[request.Response, request.Response]> {
  const { getDatabase, withTransaction } = await import('../db/index.js');
  const { invalidateAuthState } = await import('../auth/middleware.js');
  // The admin's rights are loaded afresh, so neither request asks the database
  // anything before its route does.
  invalidateAuthState();
  expect((await request(app).get(api('/grn?pageSize=1')).set(auth(adminToken))).status).toBe(200);

  const db = await getDatabase();
  let release: (() => void) | undefined;
  const held = withTransaction(() => new Promise<void>((r) => { release = r; }));
  await until(() => release !== undefined);
  const queries = vi.spyOn(db, 'query');
  const transactions = vi.spyOn(db, 'transaction');
  try {
    const first = edit().then((r) => r);
    await until(() => queries.mock.calls.length > 0);
    const second = other().then((r) => r);
    await until(() => transactions.mock.calls.length > 0);
    release!();
    return await Promise.all([first, second]);
  } finally {
    release?.();
    await held;
    queries.mockRestore();
    transactions.mockRestore();
  }
}

describe('an edit overtaken by another user', () => {
  it('of a posted GRN cancelled meanwhile is refused, and moves no stock and raises no inspection', async () => {
    const plain = await mkItem('TGRNQC-M1', false);
    const qcItem = await mkItem('TGRNQC-M2', true);
    const grn = await receive([{ itemId: plain, qty: '5' }]);
    const [line] = await linesOf(grn.id);
    expect(await stockOf(plain)).toBe(5);

    const [edit, cancelled] = await overtaken(
      () => editLines(grn.id, [
        { id: line!.id, itemId: plain, grnQty: '7', rate: '10' },
        { itemId: qcItem, grnQty: '3', rate: '10' },
      ]),
      () => cancel(grn.id),
    );
    expect(cancelled.status).toBe(200);
    // Found in review on 2026-10-17: the edit went through on the cancelled GRN,
    // leaving 2 of TGRNQC-M1 in stock that never arrived and a PENDING_QC
    // inspection that no QC decision could close.
    expect(edit.status).toBe(422);
    expect(edit.body.error.message).toBe(`GRN ${grn.grnNo} has just been cancelled by someone else — reload it before saving.`);

    expect(await grnOf(grn.id)).toEqual({ status: 'CANCELLED', qc_status: 'NOT_APPLICABLE' });
    expect(await stockOf(plain)).toBe(0);
    expect(await stockOf(qcItem)).toBe(0);
    expect(await grnLedger(grn.id)).toEqual([[plain, 'GRN_INWARD', 5], [plain, 'GRN_REVERSAL', -5]]);
    expect(await inspectionsOf(grn.id)).toEqual([]);
    expect((await linesOf(grn.id)).map((l) => [Number(l.item_id), Number(l.grn_qty)])).toEqual([[plain, 5]]);
  });

  it('of a draft posted meanwhile is refused, and leaves the posted GRN as it was posted', async () => {
    const qcItem = await mkItem('TGRNQC-M3', true);
    const draft = await receive([{ itemId: qcItem, qty: '4' }], { post: false });

    const [edit, posted] = await overtaken(
      () => request(app).put(api(`/grn/${draft.id}`)).set(auth(adminToken))
        .send({ mode: 'DIRECT', supplierId, post: true, lines: [{ itemId: qcItem, grnQty: '6', rate: '10' }] }),
      () => request(app).post(api(`/grn/${draft.id}/post`)).set(auth(adminToken)).send({}),
    );
    expect(posted.status).toBe(200);
    // Refused in words before it touches the lines the post has just received;
    // without the check it got as far as deleting them and stopped on a
    // foreign key, as a bare conflict.
    expect(edit.status).toBe(422);
    expect(edit.body.error.message).toBe(`GRN ${draft.grnNo} has just been posted by someone else — reload it before saving.`);

    expect(await grnOf(draft.id)).toEqual({ status: 'POSTED', qc_status: 'PENDING_QC' });
    expect((await linesOf(draft.id)).map((l) => Number(l.grn_qty))).toEqual([4]);
    expect((await inspectionsOf(draft.id)).map((i) => [i.status, Number(i.received_qty)])).toEqual([['PENDING_QC', 4]]);
    expect(await stockOf(qcItem)).toBe(0);
  });
});

/* ── 8. Fractional splits, held lines, units and Direct cancels (2026-10-17 E2E run) ── */

describe('fractional QC splits, held lines, the unit and a Direct cancel', () => {
  it('compares a fractional split as the database stores it, not as a JS float', async () => {
    const qcItem = await mkItem('TGRNQC-N1', true);
    const grn = await receive([{ itemId: qcItem, qty: '0.3' }]);
    const id = Number((await inspectionsOf(grn.id))[0]!.id);
    // 0.1 + 0.2 is 0.30000000000000004 as JS numbers: both decisions were refused as
    // accepting and rejecting more than the 0.3 received.
    const interim = await decide(id, { status: 'QC_IN_PROGRESS', acceptedQty: 0.1, rejectedQty: 0.2, rejectionReason: 'Two strands short' });
    expect([interim.status, interim.body.error?.message]).toEqual([200, undefined]);
    const over = await decide(id, { status: 'QC_PASSED', acceptedQty: 0.2, rejectedQty: 0.2, rejectionReason: 'Two strands short' });
    expect(over.status).toBe(422);
    expect(over.body.error.message).toBe('Sum of accepted (0.2) and rejected (0.2) cannot exceed received quantity (0.3).');
    const final = await decide(id, { status: 'ACCEPTED_WITH_DEVIATION', acceptedQty: 0.1, rejectedQty: 0.2, rejectionReason: 'Two strands short' });
    expect([final.status, final.body.error?.message]).toEqual([200, undefined]);
    expect(final.body.data.stockMoved).toBe(true);
    expect(await stockOf(qcItem)).toBeCloseTo(0.1, 6);
    const [line] = await linesOf(grn.id);
    expect([Number(line!.accepted_qty), Number(line!.rejected_qty)]).toEqual([0.1, 0.2]);
  });

  it('holds an inspected line without an accepted / rejected split until QC decides, whatever the client sent', async () => {
    const qcItem = await mkItem('TGRNQC-N2', true);
    const plain = await mkItem('TGRNQC-N3', false);
    const r = await request(app).post(api('/grn')).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true,
      lines: [
        { itemId: qcItem, grnQty: '10', rate: '10', acceptedQty: '8', rejectedQty: '2' },
        { itemId: plain, grnQty: '5', rate: '10', acceptedQty: '4', rejectedQty: '1' },
      ],
    });
    expect(r.status).toBe(201);
    const grnId = Number(r.body.data.id);
    const lines = await linesOf(grnId) as Array<GrnLine & { qc_inspection_status: string | null }>;
    const held = lineOfItem(lines, qcItem) as GrnLine & { qc_inspection_status: string | null };
    // Nobody had inspected it, yet it read 'accepted 8 / rejected 2'.
    expect([held.accepted_qty, held.rejected_qty]).toEqual([null, null]);
    expect(held.qc_inspection_status).toBe('PENDING_QC');
    // A line nobody inspects keeps the store's own split, and only what it accepted is in stock.
    const kept = lineOfItem(lines, plain) as GrnLine & { qc_inspection_status: string | null };
    expect([Number(kept.accepted_qty), Number(kept.rejected_qty), kept.qc_inspection_status]).toEqual([4, 1, null]);
    expect([await stockOf(plain), await stockOf(qcItem)]).toEqual([4, 0]);

    // A split an earlier posting left on a held line goes with the next save, and the
    // received quantity can then be corrected: kept, 8 + 2 failed the line's CHECK against 12.
    await query('UPDATE grn_lines SET accepted_qty = 8, rejected_qty = 2 WHERE id = $1', [held.id]);
    const saved = await editLines(grnId, [
      { id: held.id, itemId: qcItem, grnQty: '12', rate: '10' },
      { id: kept.id, itemId: plain, grnQty: '5', rate: '10', acceptedQty: '4', rejectedQty: '1' },
    ]);
    expect([saved.status, saved.body.error?.message]).toEqual([200, undefined]);
    const after = lineOfItem(await linesOf(grnId), qcItem);
    expect([after.accepted_qty, after.rejected_qty, Number(after.grn_qty)]).toEqual([null, null, 12]);
    expect(Number((await inspectionsOf(grnId))[0]!.received_qty)).toBe(12);
    expect(await stockOf(qcItem)).toBe(0);
  });

  it("records the line's unit on its inspection", async () => {
    const qcItem = await mkItem('TGRNQC-N4', true);
    const grn = await receive([{ itemId: qcItem, qty: '2' }]);
    const [unit] = await query<{ code: string }>('SELECT code FROM lookups WHERE id = $1', [uomId]);
    expect(unit!.code).not.toBe('');
    // A literal '' was stored, and the QC queue showed '—' for the unit of every inspection.
    const list = await request(app).get(api(`/qc/inspections?grnNo=${encodeURIComponent(grn.grnNo)}`)).set(auth(adminToken));
    expect(list.status).toBe(200);
    expect(list.body.data.map((i: { uom_code: string }) => i.uom_code)).toEqual([unit!.code]);
  });

  it('cancelling a Direct GRN does not say its quantities went back to a purchase order', async () => {
    const plain = await mkItem('TGRNQC-N5', false);
    const direct = await receive([{ itemId: plain, qty: '3' }]);
    const r = await cancel(direct.id);
    expect(r.status).toBe(200);
    expect(r.body.data.poCount).toBe(0);
    expect(r.body.data.message).toBe(`GRN ${direct.grnNo} has been cancelled — stock was reversed.`);

    const po = await issuedPo(plain, '4');
    const g = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: po.lineId, grnQty: '4' }] });
    expect(g.status).toBe(201);
    const c = await cancel(Number(g.body.data.id));
    expect(c.status).toBe(200);
    expect(c.body.data.poCount).toBe(1);
    expect(c.body.data.message).toBe(
      `GRN ${g.body.data.grn_no} has been cancelled — its quantities returned to the purchase order balance and stock was reversed.`,
    );
  });
});
