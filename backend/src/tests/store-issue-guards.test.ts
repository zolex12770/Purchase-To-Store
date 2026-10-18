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
let uomId = 0;
let supplierId = 0;
const PASSWORD = 'StoreIss@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;

const stockOf = async (itemId: number) =>
  Number((await query<{ q: string }>('SELECT live_stock_qty AS q FROM items WHERE id = $1', [itemId]))[0]!.q);
const ledgerRowsOf = async (itemId: number) =>
  Number((await query<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1', [itemId]))[0]!.n);

async function mkItem(code: string, description = `Store issue test ${code}`): Promise<number> {
  const r = await request(app).post(api('/items')).set(auth(adminToken))
    .send({ itemCode: code, itemDescription: description, uomId, standardRate: '10' });
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
    const bad = await issue(plain.id, [{ requisitionLineId: plain.lineIds[0]!, issueQty: '1', expectedIssuedQty: '-1' }]);
    expect(bad.status).toBe(422);
    const blank = await issue(plain.id, [{ requisitionLineId: plain.lineIds[0]!, issueQty: '1', expectedIssuedQty: ' ' }]);
    expect(blank.status).toBe(422);
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
