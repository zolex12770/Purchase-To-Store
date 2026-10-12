/**
 * Integration tests — production hardening (2026-10).
 *
 * Each block pins a defect found by end-to-end testing against a copy of the
 * live data, so it cannot return:
 *
 *   1. Saving a requisition WITHOUT submitting failed with HTTP 500.
 *   2. A workflow action could be repeated on a document already in that state,
 *      adding a second history row and overwriting who decided, when and why.
 *   3. "Issue" could be applied to a purchase order that was past DRAFT, forcing
 *      a received / completed / short-closed order back to OPEN.
 *   4. Saving a purchase order with "issue now" skipped the approval right.
 *   5. A deactivated user, a removed role and an administrator's password reset
 *      took effect only when the access token expired (up to 8 hours later).
 *   6. A malformed request body was answered with HTTP 500.
 *   7. The Indent / GRN Analysis screens' own rights did not open their charts.
 *
 * Same harness as workflow.test.ts / requisition.test.ts: a real PGlite
 * database migrated and seeded from scratch, real HTTP through the Express app.
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
let headToken = '';   // PURCHASE_HEAD: may approve indents and issue purchase orders
let buyerToken = '';  // PURCHASE_USER: may create indents and purchase orders, not approve
let storeToken = '';  // STORE_USER
let empToken = '';    // EMPLOYEE: raises requisitions

let uomId = 0;
let departmentId = 0;
let costCentreId = 0;
let supplierId = 0;
let itemId = 0;
let headUserId = 0;
let roles: { id: number; code: string }[] = [];
let permissions: { id: number; code: string }[] = [];

const PASSWORD = 'Harden@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (path: string) => `/api/v1${path}`;
const roleId = (code: string) => roles.find((r) => r.code === code)!.id;
const permId = (code: string) => permissions.find((p) => p.code === code)!.id;

async function signIn(employeeId: string, password = PASSWORD): Promise<string> {
  const res = await request(app).post(api('/auth/login')).send({ employeeId, password });
  if (res.status !== 200) throw new Error(`Could not sign in as ${employeeId}: ${res.status}`);
  return res.body.data.accessToken as string;
}

async function createUser(employeeId: string, roleCodes: string[], extra: Record<string, unknown> = {}) {
  const res = await request(app).post(api('/users')).set(auth(adminToken)).send({
    employeeId, employeeName: `Hardening ${employeeId}`, designation: 'test', departmentId,
    password: PASSWORD, mustChangePassword: false, roleIds: roleCodes.map(roleId), ...extra,
  });
  expect(res.status).toBe(201);
  return res.body.data as { id: number; employee_id: string; employee_name: string };
}

const indentBody = (qty: number, submit = true) => ({
  departmentId, costCentreId, lines: [{ itemId, indentQty: qty, uomId }], submit,
});
const poBody = (qty: number, extra: Record<string, unknown> = {}) => ({
  supplierId, lines: [{ itemId, poQty: qty, uomId, rate: 10, sources: [] }], ...extra,
});
const getPo = async (id: number) => (await request(app).get(api(`/purchase-orders/${id}`)).set(auth(adminToken))).body.data;
const getIndent = async (id: number) => (await request(app).get(api(`/indents/${id}`)).set(auth(adminToken))).body.data;

/** An issued PO for `qty`, with its single line id. */
async function issuedPo(qty: number): Promise<{ id: number; poNo: string; lineId: number }> {
  const created = await request(app).post(api('/purchase-orders')).set(auth(headToken)).send(poBody(qty, { issue: true }));
  expect(created.status).toBe(201);
  const doc = await getPo(created.body.data.id);
  return { id: doc.id, poNo: doc.po_no, lineId: doc.lines[0].po_line_id };
}

let invoiceSeq = 0;
async function receive(poLineId: number, qty: number) {
  invoiceSeq += 1;
  return request(app).post(api('/grn')).set(auth(storeToken)).send({
    mode: 'PO', supplierId, invoiceNo: `HARD-INV-${invoiceSeq}`, lines: [{ poLineId, grnQty: qty }], post: true,
  });
}

beforeAll(async () => {
  const { ensureStorageDirs } = await import('../config/env.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');
  const { getDatabase, closeDatabase } = await import('../db/driver.js');
  const { createApp } = await import('../app.js');

  ensureStorageDirs();
  const db = await getDatabase();
  closeDb = closeDatabase;

  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();

  app = createApp();
  adminToken = await signIn('10221', 'Admin@12345');

  const lookups = await request(app).get(api('/lookups/options')).set(auth(adminToken));
  uomId = lookups.body.data.UOM[0].id;
  const mk = async (category: string, code: string, name: string) => {
    const res = await request(app).post(api(`/lookups/${category}`)).set(auth(adminToken)).send({ code, name });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  departmentId = await mk('DEPARTMENT', 'THARD-D', 'Hardening Department');
  costCentreId = await mk('COST_CENTRE', 'THARD-CC', 'Hardening Cost Centre');

  const supplier = await request(app).post(api('/suppliers')).set(auth(adminToken))
    .send({ supplierName: 'Hardening Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra' });
  supplierId = supplier.body.data.id;
  const item = await request(app).post(api('/items')).set(auth(adminToken))
    .send({ itemCode: 'THARD-ITEM', itemDescription: 'Hardening Item', uomId, standardRate: '10' });
  itemId = item.body.data.id;

  roles = (await request(app).get(api('/roles')).set(auth(adminToken))).body.data;
  permissions = (await request(app).get(api('/roles/permissions')).set(auth(adminToken))).body.data
    .flatMap((g: { permissions: { id: number; code: string }[] }) => g.permissions);

  headUserId = (await createUser('T-HARD-HEAD', ['PURCHASE_HEAD'])).id;
  await createUser('T-HARD-BUYER', ['PURCHASE_USER']);
  await createUser('T-HARD-STORE', ['STORE_USER']);
  await createUser('T-HARD-EMP', ['EMPLOYEE']);
  headToken = await signIn('T-HARD-HEAD');
  buyerToken = await signIn('T-HARD-BUYER');
  storeToken = await signIn('T-HARD-STORE');
  empToken = await signIn('T-HARD-EMP');

  // The purchase head is the HOD of the test department, so requisitions raised
  // by the employee route to them.
  const hod = await request(app).put(api(`/requisitions/departments/${departmentId}/hod`)).set(auth(adminToken))
    .send({ hodUserId: headUserId });
  expect(hod.status).toBe(200);
}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

/* ── 1. Requisition: saving without submitting ───────────────────────────── */

describe('requisition — save without submitting', () => {
  const reqBody = (qty: number, submit: boolean, remarks = '') => ({
    remarks, lines: [{ itemId, requestedQty: qty }], submit,
  });

  it('the raiser can save an existing draft again without submitting it', async () => {
    const created = await request(app).post(api('/requisitions')).set(auth(empToken)).send(reqBody(2, false, 'first'));
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;

    const saved = await request(app).put(api(`/requisitions/${id}`)).set(auth(empToken)).send(reqBody(5, false, 'edited'));
    expect(saved.status).toBe(200);

    const doc = (await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken))).body.data;
    expect(doc.status).toBe('DRAFT');
    expect(Number(doc.lines[0].requested_qty)).toBe(5);
    expect(doc.remarks).toBe('edited');
    // A draft that was only saved has never been submitted by anyone.
    expect(doc.submitted_at).toBeNull();
    expect(doc.submitted_by).toBeNull();
  });

  it('the HOD can correct a pending requisition without it leaving the approval queue', async () => {
    const created = await request(app).post(api('/requisitions')).set(auth(empToken)).send(reqBody(3, true));
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;
    const submittedBy = created.body.data.submitted_by;

    const corrected = await request(app).put(api(`/requisitions/${id}`)).set(auth(headToken)).send(reqBody(4, false, 'hod correction'));
    expect(corrected.status).toBe(200);

    const doc = (await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken))).body.data;
    expect(doc.status).toBe('PENDING_APPROVAL');
    expect(Number(doc.lines[0].requested_qty)).toBe(4);
    // Still attributed to the person who actually submitted it.
    expect(doc.submitted_by).toBe(submittedBy);
  });

  it('saving AND submitting still stamps the submission and routes to the HOD', async () => {
    const created = await request(app).post(api('/requisitions')).set(auth(empToken)).send(reqBody(1, false));
    const id = created.body.data.id as number;
    const sent = await request(app).put(api(`/requisitions/${id}`)).set(auth(empToken)).send(reqBody(1, true));
    expect(sent.status).toBe(200);
    expect(sent.body.data.status).toBe('PENDING_APPROVAL');
    expect(sent.body.data.submitted_at).not.toBeNull();
    expect(sent.body.data.hod_user_id).toBe(headUserId);
  });
});

/* ── 2. A workflow action cannot be repeated ─────────────────────────────── */

describe('a decision already taken cannot be taken again', () => {
  it('indent: a second approval is refused and the first approver stays on record', async () => {
    const created = await request(app).post(api('/indents')).set(auth(buyerToken)).send(indentBody(4));
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;

    expect((await request(app).post(api(`/indents/${id}/submit`)).set(auth(buyerToken))).status).toBe(422);
    expect((await request(app).post(api(`/indents/${id}/approve`)).set(auth(headToken))).status).toBe(200);
    const first = await getIndent(id);

    const again = await request(app).post(api(`/indents/${id}/approve`)).set(auth(adminToken));
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already approved/i);

    const after = await getIndent(id);
    expect(after.approved_by).toBe(first.approved_by);
    expect(after.approved_at).toBe(first.approved_at);
    expect(after.approvals.filter((a: { action: string }) => a.action === 'APPROVE')).toHaveLength(1);
    expect(after.approvals.filter((a: { action: string }) => a.action === 'SUBMIT')).toHaveLength(1);
  });

  it('indent: a second cancel is refused and the original reason is kept', async () => {
    const created = await request(app).post(api('/indents')).set(auth(buyerToken)).send(indentBody(1));
    const id = created.body.data.id as number;
    expect((await request(app).post(api(`/indents/${id}/cancel`)).set(auth(buyerToken)).send({ reason: 'first reason' })).status).toBe(200);
    const again = await request(app).post(api(`/indents/${id}/cancel`)).set(auth(buyerToken)).send({ reason: 'second reason' });
    expect(again.status).toBe(422);
    expect((await getIndent(id)).close_reason).toBe('first reason');
  });

  it('requisition: a second approval and a second cancel are refused', async () => {
    const created = await request(app).post(api('/requisitions')).set(auth(empToken))
      .send({ lines: [{ itemId, requestedQty: 1 }], submit: true });
    const id = created.body.data.id as number;
    expect((await request(app).post(api(`/requisitions/${id}/approve`)).set(auth(headToken))).status).toBe(200);
    const again = await request(app).post(api(`/requisitions/${id}/approve`)).set(auth(headToken));
    expect(again.status).toBe(422);
    expect(again.body.error.message).toMatch(/already approved/i);

    expect((await request(app).post(api(`/requisitions/${id}/cancel`)).set(auth(empToken)).send({ reason: 'one' })).status).toBe(200);
    expect((await request(app).post(api(`/requisitions/${id}/cancel`)).set(auth(empToken)).send({ reason: 'two' })).status).toBe(422);
    const doc = (await request(app).get(api(`/requisitions/${id}`)).set(auth(adminToken))).body.data;
    expect(doc.close_reason).toBe('one');
    expect(doc.approvals.filter((a: { action: string }) => a.action === 'APPROVE')).toHaveLength(1);
  });

  it('purchase order: a second cancel and a second short-close are refused, reasons kept', async () => {
    const a = await issuedPo(2);
    expect((await request(app).post(api(`/purchase-orders/${a.id}/cancel`)).set(auth(headToken)).send({ reason: 'r1' })).status).toBe(200);
    expect((await request(app).post(api(`/purchase-orders/${a.id}/cancel`)).set(auth(headToken)).send({ reason: 'r2' })).status).toBe(422);
    expect((await getPo(a.id)).close_reason).toBe('r1');

    const b = await issuedPo(2);
    expect((await request(app).post(api(`/purchase-orders/${b.id}/short-close`)).set(auth(headToken)).send({ reason: 's1' })).status).toBe(200);
    expect((await request(app).post(api(`/purchase-orders/${b.id}/short-close`)).set(auth(headToken)).send({ reason: 's2' })).status).toBe(422);
    expect((await getPo(b.id)).close_reason).toBe('s1');
  });

  it('GRN: posting twice and cancelling twice are refused; stock moves exactly once each way', async () => {
    const stock = async () => Number((await request(app).get(api(`/items/${itemId}`)).set(auth(adminToken))).body.data.live_stock_qty);
    const before = await stock();

    const draft = await request(app).post(api('/grn')).set(auth(storeToken)).send({
      mode: 'DIRECT', supplierId, invoiceNo: 'HARD-DIRECT-1', lines: [{ itemId, grnQty: 5, rate: 2 }], post: false,
    });
    expect(draft.status).toBe(201);
    const id = draft.body.data.id as number;

    expect((await request(app).post(api(`/grn/${id}/post`)).set(auth(storeToken))).status).toBe(200);
    const postedAgain = await request(app).post(api(`/grn/${id}/post`)).set(auth(storeToken));
    expect(postedAgain.status).toBe(422);
    expect(postedAgain.body.error.message).toMatch(/already posted/i);
    expect(await stock()).toBe(before + 5);

    expect((await request(app).post(api(`/grn/${id}/cancel`)).set(auth(storeToken)).send({ reason: 'first reason' })).status).toBe(200);
    const cancelledAgain = await request(app).post(api(`/grn/${id}/cancel`)).set(auth(storeToken)).send({ reason: 'second reason' });
    expect(cancelledAgain.status).toBe(422);
    expect(cancelledAgain.body.error.message).toMatch(/already cancelled/i);
    expect(await stock()).toBe(before);

    const doc = (await request(app).get(api(`/grn/${id}`)).set(auth(adminToken))).body.data;
    expect(doc.status).toBe('CANCELLED');
    expect(doc.cancel_reason).toBe('first reason');
  });
});

/* ── 3. "Issue" is the DRAFT -> OPEN step only ───────────────────────────── */

describe('purchase order — issue applies to a draft only', () => {
  it('refuses to issue an order that is already open, received, completed or short-closed', async () => {
    const po = await issuedPo(4);
    const issued = await getPo(po.id);

    const openAgain = await request(app).post(api(`/purchase-orders/${po.id}/issue`)).set(auth(adminToken));
    expect(openAgain.status).toBe(422);
    expect(openAgain.body.error.message).toMatch(/already been issued/i);

    expect((await receive(po.lineId, 1)).status).toBe(201);
    const partial = await request(app).post(api(`/purchase-orders/${po.id}/issue`)).set(auth(adminToken));
    expect(partial.status).toBe(422);
    let doc = await getPo(po.id);
    expect(doc.status).toBe('PARTIALLY_RECEIVED');
    // Who issued it, and when, is untouched by the refused attempts.
    expect(doc.issued_by).toBe(issued.issued_by);
    expect(doc.issued_at).toBe(issued.issued_at);

    expect((await receive(po.lineId, 3)).status).toBe(201);
    expect((await request(app).post(api(`/purchase-orders/${po.id}/issue`)).set(auth(adminToken))).status).toBe(422);
    doc = await getPo(po.id);
    expect(doc.status).toBe('COMPLETED');

    const closed = await issuedPo(2);
    expect((await request(app).post(api(`/purchase-orders/${closed.id}/short-close`)).set(auth(headToken)).send({ reason: 'not coming' })).status).toBe(200);
    expect((await request(app).post(api(`/purchase-orders/${closed.id}/issue`)).set(auth(adminToken))).status).toBe(422);
    expect((await getPo(closed.id)).status).toBe('SHORT_CLOSED');

    const cancelled = await issuedPo(2);
    await request(app).post(api(`/purchase-orders/${cancelled.id}/cancel`)).set(auth(headToken)).send({ reason: 'mistake' });
    const afterCancel = await request(app).post(api(`/purchase-orders/${cancelled.id}/issue`)).set(auth(adminToken));
    expect(afterCancel.status).toBe(422);
    expect(afterCancel.body.error.message).toMatch(/cancelled/i);
  });

  it('editing an issued order never changes its status, even when the request says "issue"', async () => {
    const po = await issuedPo(4);
    expect((await receive(po.lineId, 1)).status).toBe(201);
    const edited = await request(app).put(api(`/purchase-orders/${po.id}`)).set(auth(headToken)).send({
      supplierId, lines: [{ id: po.lineId, itemId, poQty: 6, uomId, rate: 10, sources: [] }], issue: true,
    });
    expect(edited.status).toBe(200);
    const doc = await getPo(po.id);
    expect(doc.status).toBe('PARTIALLY_RECEIVED');
    expect(Number(doc.total_po_qty)).toBe(6);
  });
});

/* ── 4. Issuing needs the approval right, whichever way it is asked for ──── */

describe('purchase order — issuing is the approval step', () => {
  it('a user without the approval right can save a draft but not create-and-issue', async () => {
    const count = async () => (await request(app).get(api('/purchase-orders?pageSize=1')).set(auth(adminToken))).body.meta.total as number;
    const before = await count();

    const refused = await request(app).post(api('/purchase-orders')).set(auth(buyerToken)).send(poBody(1, { issue: true }));
    expect(refused.status).toBe(403);
    expect(await count()).toBe(before);

    const draft = await request(app).post(api('/purchase-orders')).set(auth(buyerToken)).send(poBody(1));
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    expect(draft.body.data.issued_by).toBeNull();
  });

  it('saving a draft never records an issuer; the person who issues it is the one recorded', async () => {
    const draft = await request(app).post(api('/purchase-orders')).set(auth(buyerToken)).send(poBody(2));
    const id = draft.body.data.id as number;
    const line = (await getPo(id)).lines[0].po_line_id as number;
    const body = (extra: Record<string, unknown>) => ({
      supplierId, lines: [{ id: line, itemId, poQty: 3, uomId, rate: 10, sources: [] }], ...extra,
    });

    const saved = await request(app).put(api(`/purchase-orders/${id}`)).set(auth(buyerToken)).send(body({}));
    expect(saved.status).toBe(200);
    let doc = await getPo(id);
    expect(doc.status).toBe('DRAFT');
    expect(doc.issued_by).toBeNull();
    expect(doc.issued_at).toBeNull();

    const refused = await request(app).put(api(`/purchase-orders/${id}`)).set(auth(buyerToken)).send(body({ issue: true }));
    expect(refused.status).toBe(403);
    expect((await getPo(id)).status).toBe('DRAFT');

    const issued = await request(app).put(api(`/purchase-orders/${id}`)).set(auth(headToken)).send(body({ issue: true }));
    expect(issued.status).toBe(200);
    doc = await getPo(id);
    expect(doc.status).toBe('OPEN');
    expect(doc.issued_by).toBe(headUserId);
    expect(doc.issued_at).not.toBeNull();
  });

  it('a GRN draft cannot be posted by saving it without the approval right', async () => {
    const role = await request(app).post(api('/roles')).set(auth(adminToken)).send({
      code: 'T_HARD_RECEIVER', name: 'Hardening Receiver (no approve)',
      permissionIds: ['grn.view', 'grn.create', 'grn.edit', 'supplier.view', 'item.view', 'lookup.view'].map(permId),
    });
    expect(role.status).toBe(201);
    roles.push({ id: role.body.data.id, code: 'T_HARD_RECEIVER' });
    await createUser('T-HARD-RECV', ['T_HARD_RECEIVER']);
    const token = await signIn('T-HARD-RECV');

    const body = (post: boolean) => ({ mode: 'DIRECT', supplierId, invoiceNo: 'HARD-DIRECT-2', lines: [{ itemId, grnQty: 1, rate: 2 }], post });
    expect((await request(app).post(api('/grn')).set(auth(token)).send(body(true))).status).toBe(422);
    const draft = await request(app).post(api('/grn')).set(auth(token)).send(body(false));
    expect(draft.status).toBe(201);
    const id = draft.body.data.id as number;

    const viaSave = await request(app).put(api(`/grn/${id}`)).set(auth(token)).send(body(true));
    expect(viaSave.status).toBe(422);
    expect((await request(app).get(api(`/grn/${id}`)).set(auth(adminToken))).body.data.status).toBe('DRAFT');
    expect((await request(app).put(api(`/grn/${id}`)).set(auth(token)).send(body(false))).status).toBe(200);
  });
});

/* ── 5. Account changes apply to sessions that are already open ──────────── */

describe('an open session follows the account as it is now', () => {
  const userBody = (u: { employee_id: string; employee_name: string }, roleCodes: string[], isActive = true) => ({
    employeeId: u.employee_id, employeeName: u.employee_name, designation: 'test', departmentId, isActive,
    roleIds: roleCodes.map(roleId),
  });

  it('a role granted or removed by an administrator is in force on the very next request', async () => {
    const user = await createUser('T-HARD-LIVE1', ['VIEWER']);
    const token = await signIn('T-HARD-LIVE1');
    expect((await request(app).get(api('/grn/po-items?limit=1')).set(auth(token))).status).toBe(403);

    expect((await request(app).put(api(`/users/${user.id}`)).set(auth(adminToken)).send(userBody(user, ['VIEWER', 'STORE_USER']))).status).toBe(200);
    expect((await request(app).get(api('/grn/po-items?limit=1')).set(auth(token))).status).toBe(200);

    expect((await request(app).put(api(`/users/${user.id}`)).set(auth(adminToken)).send(userBody(user, ['VIEWER']))).status).toBe(200);
    expect((await request(app).get(api('/grn/po-items?limit=1')).set(auth(token))).status).toBe(403);
  });

  it('editing a role changes what its holders may do at once', async () => {
    const role = await request(app).post(api('/roles')).set(auth(adminToken)).send({
      code: 'T_HARD_LIVE', name: 'Hardening Live Role', permissionIds: ['item.view'].map(permId),
    });
    roles.push({ id: role.body.data.id, code: 'T_HARD_LIVE' });
    await createUser('T-HARD-LIVE2', ['T_HARD_LIVE']);
    const token = await signIn('T-HARD-LIVE2');
    expect((await request(app).get(api('/suppliers?pageSize=1')).set(auth(token))).status).toBe(403);

    await request(app).put(api(`/roles/${role.body.data.id}`)).set(auth(adminToken)).send({
      code: 'T_HARD_LIVE', name: 'Hardening Live Role', permissionIds: ['item.view', 'supplier.view'].map(permId),
    });
    expect((await request(app).get(api('/suppliers?pageSize=1')).set(auth(token))).status).toBe(200);

    await request(app).put(api(`/roles/${role.body.data.id}`)).set(auth(adminToken)).send({
      code: 'T_HARD_LIVE', name: 'Hardening Live Role', permissionIds: ['item.view'].map(permId),
    });
    expect((await request(app).get(api('/suppliers?pageSize=1')).set(auth(token))).status).toBe(403);
  });

  it('a deactivated user is locked out immediately, including from the profile endpoint', async () => {
    const user = await createUser('T-HARD-LIVE3', ['VIEWER']);
    const token = await signIn('T-HARD-LIVE3');
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(token))).status).toBe(200);

    expect((await request(app).put(api(`/users/${user.id}`)).set(auth(adminToken)).send(userBody(user, ['VIEWER'], false))).status).toBe(200);
    const refused = await request(app).get(api('/items?pageSize=1')).set(auth(token));
    expect(refused.status).toBe(401);
    expect((await request(app).get(api('/auth/me')).set(auth(token))).status).toBe(401);

    // Re-activating does not need a new sign-in for the same (still unexpired) token.
    expect((await request(app).put(api(`/users/${user.id}`)).set(auth(adminToken)).send(userBody(user, ['VIEWER'], true))).status).toBe(200);
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(token))).status).toBe(200);

    expect((await request(app).delete(api(`/users/${user.id}`)).set(auth(adminToken))).status).toBe(200);
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(token))).status).toBe(401);
  });

  it('an administrator password reset ends sessions opened with the old password', async () => {
    const user = await createUser('T-HARD-LIVE4', ['VIEWER']);
    const token = await signIn('T-HARD-LIVE4');
    // The token must be measurably older than the reset (token times have 1 s resolution).
    await new Promise((r) => setTimeout(r, 3200));

    const reset = await request(app).post(api(`/users/${user.id}/reset-password`)).set(auth(adminToken)).send({ newPassword: 'Harden@Reset2026' });
    expect(reset.status).toBe(200);
    const refused = await request(app).get(api('/items?pageSize=1')).set(auth(token));
    expect(refused.status).toBe(401);
    expect(refused.body.error.message).toMatch(/password was changed/i);

    const fresh = await signIn('T-HARD-LIVE4', 'Harden@Reset2026');
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(fresh))).status).toBe(200);
  });

  it('changing your own password ends the session that did it', async () => {
    await createUser('T-HARD-LIVE5', ['VIEWER']);
    const token = await signIn('T-HARD-LIVE5');
    await new Promise((r) => setTimeout(r, 3200));
    const changed = await request(app).post(api('/auth/change-password')).set(auth(token))
      .send({ currentPassword: PASSWORD, newPassword: 'Harden@Own2026' });
    expect(changed.status).toBe(200);
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(token))).status).toBe(401);
    const fresh = await signIn('T-HARD-LIVE5', 'Harden@Own2026');
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(fresh))).status).toBe(200);
  });

  it('the administrator keeps full access throughout', async () => {
    expect((await request(app).get(api('/users?pageSize=1')).set(auth(adminToken))).status).toBe(200);
    expect((await request(app).get(api('/auth/me')).set(auth(adminToken))).body.data.roles).toContain('SUPER_ADMIN');
  });
});

/* ── 6. Malformed requests ───────────────────────────────────────────────── */

describe('a request the server cannot read', () => {
  it('broken JSON is answered 400, not 500', async () => {
    const res = await request(app).post(api('/auth/login')).set('Content-Type', 'application/json').send('{"employeeId":');
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('broken JSON on a signed-in route is also 400', async () => {
    const res = await request(app).post(api('/indents')).set(auth(adminToken)).set('Content-Type', 'application/json').send('{"lines": [');
    expect(res.status).toBe(400);
  });
});

/* ── 7. Analysis charts open for the rights their screens use ────────────── */

describe('analytics permissions', () => {
  it('the GRN and Indent analyse rights open the breakdown and ageing charts their screens draw', async () => {
    const mkRole = async (code: string, perms: string[]) => {
      const res = await request(app).post(api('/roles')).set(auth(adminToken)).send({ code, name: `Hardening ${code}`, permissionIds: perms.map(permId) });
      expect(res.status).toBe(201);
      roles.push({ id: res.body.data.id, code });
    };
    await mkRole('T_HARD_GRN_AN', ['dashboard.view', 'grn.view', 'grn.analyze']);
    await mkRole('T_HARD_IND_AN', ['dashboard.view', 'indent.view', 'indent.analyze']);
    await createUser('T-HARD-AN1', ['T_HARD_GRN_AN']);
    await createUser('T-HARD-AN2', ['T_HARD_IND_AN']);

    for (const id of ['T-HARD-AN1', 'T-HARD-AN2']) {
      const token = await signIn(id);
      expect((await request(app).get(api('/analytics/trends?granularity=month')).set(auth(token))).status).toBe(200);
      expect((await request(app).get(api('/analytics/breakdown/supplier?limit=5')).set(auth(token))).status).toBe(200);
      expect((await request(app).get(api('/analytics/ageing?basis=po')).set(auth(token))).status).toBe(200);
      // Still closed: the charts that belong to other screens.
      expect((await request(app).get(api('/analytics/exceptions')).set(auth(token))).status).toBe(403);
      expect((await request(app).get(api('/analytics/supplier-performance')).set(auth(token))).status).toBe(403);
    }
  });

  it('a view-only role still gets no analysis charts', async () => {
    await createUser('T-HARD-AN3', ['VIEWER']);
    const token = await signIn('T-HARD-AN3');
    expect((await request(app).get(api('/analytics/kpis')).set(auth(token))).status).toBe(200);
    for (const path of ['/analytics/trends?granularity=month', '/analytics/breakdown/supplier?limit=5', '/analytics/ageing?basis=po']) {
      expect((await request(app).get(api(path)).set(auth(token))).status).toBe(403);
    }
  });
});

/* ── 8. Label printing cannot be asked to build an absurd number of labels ── */

describe('GRN labels — "No. of labels" is bounded', () => {
  const directGrn = (labelCount: number | null, invoiceNo: string) => ({
    mode: 'DIRECT', supplierId, invoiceNo, post: true,
    lines: [{ itemId, grnQty: 6, rate: 2, ...(labelCount === null ? {} : { labelCount }) }],
  });
  const labelsOf = async (grnId: number) =>
    (await request(app).get(api(`/grn/labels?grnId=${grnId}`)).set(auth(adminToken))).body.data as { id: number; mln_no: string }[];

  it('the GRN form value is limited to a sensible whole number', async () => {
    for (const bad of [501, 6876867979, 2.5, -1]) {
      const res = await request(app).post(api('/grn')).set(auth(storeToken)).send(directGrn(bad, `HARD-LBL-BAD-${bad}`));
      expect(res.status).toBe(422);
    }
    const ok = await request(app).post(api('/grn')).set(auth(storeToken)).send(directGrn(3, 'HARD-LBL-OK'));
    expect(ok.status).toBe(201);

    const [lot] = await labelsOf(ok.body.data.id);
    const view = await request(app).get(api(`/grn/labels/print-view?ids=${lot!.id}`)).set(auth(storeToken));
    expect(view.status).toBe(200);
    // Three physical labels for the one lot, numbered 1 / 3 .. 3 / 3.
    expect(view.text).toContain('3 / 3');
    expect(view.text).not.toContain('4 / ');
  });

  it('a stored value beyond the limit is refused at print time instead of taking the server down', async () => {
    const grn = await request(app).post(api('/grn')).set(auth(storeToken)).send(directGrn(2, 'HARD-LBL-HUGE'));
    expect(grn.status).toBe(201);
    const [lot] = await labelsOf(grn.body.data.id);

    // The value a live row actually held. It cannot come through the form any
    // more, so it is planted directly — as an old row or a sheet import could.
    const { getDatabase } = await import('../db/driver.js');
    const db = await getDatabase();
    await db.query('UPDATE grn_lines SET label_count = 6876867979 WHERE grn_id = $1', [grn.body.data.id]);

    const started = Date.now();
    const view = await request(app).get(api(`/grn/labels/print-view?ids=${lot!.id}`)).set(auth(storeToken));
    const pdf = await request(app).get(api(`/grn/labels/pdf?ids=${lot!.id}`)).set(auth(storeToken));
    expect(Date.now() - started).toBeLessThan(5000);
    for (const res of [view, pdf]) {
      expect(res.status).toBe(422);
      expect(res.body.error.message).toMatch(/At most 500 labels/);
      expect(res.body.error.message).toContain(lot!.mln_no);
    }
    // A refused print is not counted as a print.
    const after = (await labelsOf(grn.body.data.id))[0] as unknown as { print_count: number };
    expect(after.print_count).toBe(0);

    // The line can be corrected through the normal edit, after which it prints.
    const doc = (await request(app).get(api(`/grn/${grn.body.data.id}`)).set(auth(adminToken))).body.data;
    const fixed = await request(app).put(api(`/grn/${grn.body.data.id}`)).set(auth(storeToken)).send({
      mode: 'DIRECT', supplierId, invoiceNo: 'HARD-LBL-HUGE', post: true,
      lines: [{ id: doc.lines[0].id, itemId, grnQty: 6, rate: 2, labelCount: 2 }],
    });
    expect(fixed.status).toBe(200);
    expect((await request(app).get(api(`/grn/labels/print-view?ids=${lot!.id}`)).set(auth(storeToken))).status).toBe(200);
  });

  it('one print request cannot exceed the overall label limit either', async () => {
    const ids: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const grn = await request(app).post(api('/grn')).set(auth(storeToken)).send(directGrn(500, `HARD-LBL-MANY-${i}`));
      expect(grn.status).toBe(201);
      ids.push((await labelsOf(grn.body.data.id))[0]!.id);
    }
    const four = await request(app).get(api(`/grn/labels/print-view?ids=${ids.slice(0, 4).join(',')}`)).set(auth(storeToken));
    expect(four.status).toBe(200);
    const five = await request(app).get(api(`/grn/labels/print-view?ids=${ids.join(',')}`)).set(auth(storeToken));
    expect(five.status).toBe(422);
    expect(five.body.error.message).toMatch(/select fewer lots/i);
  });
});

/* ── 9. Portable exports carry no password hashes ────────────────────────── */

describe('portable SQL / Excel export', () => {
  it('replaces every password hash, while the operational backup data keeps them', async () => {
    const { collectBackupData } = await import('../db/restore.js');
    const { query } = await import('../db/index.js');
    const { redactForExport, buildMysqlDataDump, buildExcelWorkbook } = await import('../modules/admin/export.routes.js');

    const { data, counts } = await collectBackupData((sql) => query(sql));
    const users = data.users as { password_hash: string }[];
    const realHashes = users.map((u) => u.password_hash).filter((h) => h.startsWith('$2'));
    // The backup itself must stay restorable, hashes included.
    expect(realHashes.length).toBeGreaterThan(5);

    const redacted = redactForExport(data);
    expect((redacted.users as { password_hash: string }[]).every((u) => u.password_hash === '!')).toBe(true);
    expect(redacted.users).toHaveLength(users.length);
    // Nothing else is touched, and the caller's data is not mutated.
    expect(redacted.items).toBe(data.items);
    expect(users.some((u) => u.password_hash.startsWith('$2'))).toBe(true);

    const dump = buildMysqlDataDump(data, counts);
    for (const hash of realHashes) expect(dump.includes(hash)).toBe(false);
    expect(dump).toContain('INSERT INTO `users`');

    const ExcelJS = (await import('exceljs')).default;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await buildExcelWorkbook(data) as unknown as ArrayBuffer);
    const sheet = wb.getWorksheet('users')!;
    const header = (sheet.getRow(1).values as unknown[]).map(String);
    const col = header.indexOf('password_hash');
    expect(col).toBeGreaterThan(0);
    const values = new Set<string>();
    sheet.eachRow((row, n) => { if (n > 1) values.add(String(row.getCell(col).value)); });
    expect([...values]).toEqual(['!']);
  });
});

/* ── 11. Migration 020: duplicate indexes and duplicate sync-log rows ─────── */

describe('migration 020 — database simplification', () => {
  const DROPPED = [
    'idx_grn_status', 'idx_grn_lines_grn', 'idx_import_rows_job', 'idx_po_sources_po_line', 'idx_indent_status',
    'idx_indent_lines_indent', 'idx_po_status', 'idx_po_supplier', 'idx_po_lines_po', 'idx_requisition_status',
    'idx_requisition_lines_requisition',
  ];
  const COVERING = [
    'idx_grn_status_date', 'uq_grn_line_no', 'uq_import_row', 'uq_po_source', 'idx_indent_status_date',
    'uq_indent_line_no', 'idx_po_status_date', 'idx_po_supplier_date', 'uq_po_line_no', 'idx_requisition_status_date',
    'uq_requisition_line_no',
  ];

  it('removes the eleven duplicate indexes and keeps every index that covers them', async () => {
    const { getDatabase } = await import('../db/driver.js');
    const db = await getDatabase();
    const names = (await db.query<{ indexname: string }>("SELECT indexname FROM pg_indexes WHERE schemaname = 'public'"))
      .rows.map((r) => r.indexname);
    for (const name of DROPPED) expect(names).not.toContain(name);
    for (const name of COVERING) expect(names).toContain(name);

    // Keys are untouched: every table still has its primary key, and the
    // foreign-key and unique-constraint counts are those of the audited schema.
    const counts = (await db.query<{ type: string; n: string }>(
      `SELECT c.contype AS type, COUNT(*) AS n FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
        WHERE n.nspname = 'public' GROUP BY c.contype`)).rows;
    const of = (t: string) => Number(counts.find((c) => c.type === t)?.n ?? 0);
    expect(of('p')).toBeGreaterThanOrEqual(40);
    expect(of('f')).toBeGreaterThanOrEqual(108);
    expect(of('u')).toBe(18);
  });

  it('collapses duplicate OPEN sync issues to their first row, leaves resolved ones alone, and is repeatable', async () => {
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const { getDatabase } = await import('../db/driver.js');
    const { splitStatements } = await import('../db/migrate.js');
    const db = await getDatabase();

    const sql = fs.readFileSync(fileURLToPath(new URL('../db/migrations/020_simplify_redundant_indexes_and_sync_log.sql', import.meta.url)), 'utf8');
    const cleanup = splitStatements(sql).filter((s) => /DELETE FROM google_sync_errors/.test(s));
    expect(cleanup).toHaveLength(1);

    const job = async () => Number((await db.query<{ id: number }>(
      "INSERT INTO google_sync_jobs (status, trigger_source) VALUES ('SUCCESS', 'MANUAL') RETURNING id")).rows[0]!.id);
    const jobs = [await job(), await job(), await job()];
    const add = async (jobId: number, sheet: string, row: number | null, key: string | null, resolved = false) => Number((await db.query<{ id: number }>(
      `INSERT INTO google_sync_errors (job_id, sheet_name, row_number, business_key, severity, error_code, error_message, resolved_at)
       VALUES ($1, $2, $3, $4, 'ERROR', 'T020', 'same text', ${resolved ? 'now()' : 'NULL'}) RETURNING id`,
      [jobId, sheet, row, key])).rows[0]!.id);

    const firstA = await add(jobs[0]!, 'T020 Sheet', 5, 'K-1');           // logged on three runs
    await add(jobs[1]!, 'T020 Sheet', 5, 'K-1');
    await add(jobs[2]!, 'T020 Sheet', 5, 'K-1');
    const firstB = await add(jobs[0]!, 'T020 Sheet', null, null);         // no row, no key
    await add(jobs[1]!, 'T020 Sheet', null, null);
    const firstC = await add(jobs[0]!, 'T020 Sheet', 6, '');              // '' and NULL are one key to the engine
    await add(jobs[1]!, 'T020 Sheet', 6, null);
    const otherSheet = await add(jobs[0]!, 'T020 Other', 5, 'K-1');       // same key, different sheet
    const otherRow = await add(jobs[0]!, 'T020 Sheet', 7, 'K-1');         // same key, different sheet row
    const resolved1 = await add(jobs[0]!, 'T020 Sheet', 5, 'K-1', true);  // decided by a person: never touched
    const resolved2 = await add(jobs[1]!, 'T020 Sheet', 5, 'K-1', true);

    await db.query(cleanup[0]!);
    const left = (await db.query<{ id: number }>("SELECT id FROM google_sync_errors WHERE error_code = 'T020' ORDER BY id")).rows.map((r) => Number(r.id));
    expect(left).toEqual([firstA, firstB, firstC, otherSheet, otherRow, resolved1, resolved2].sort((x, y) => x - y));

    await db.query(cleanup[0]!);
    const again = (await db.query<{ n: string }>("SELECT COUNT(*) AS n FROM google_sync_errors WHERE error_code = 'T020'")).rows[0]!;
    expect(Number(again.n)).toBe(7);

    // The space-reclaim statement the runner issues after the migration works on this engine.
    await expect(db.query('VACUUM (FULL, ANALYZE) google_sync_errors')).resolves.toBeDefined();
    await db.query("DELETE FROM google_sync_errors WHERE error_code = 'T020'");
  });

  it('an unattended sync that changed nothing leaves no line in the audit trail; the job itself is still recorded', async () => {
    // Read from the source rather than run against Google: the rule is one condition.
    const fs = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const src = fs.readFileSync(fileURLToPath(new URL('../modules/google-sync/engine.ts', import.meta.url)), 'utf8');
    expect(src).toMatch(/options\.trigger === 'SCHEDULED' && status !== 'FAILED' && totals\.inserted === 0 && totals\.updated === 0/);
    expect(src).toMatch(/UPDATE google_sync_jobs\s+SET status = \$2, finished_at = now\(\)/);
  });
});

/* ── 10. A right removed from a system role stays removed across restarts ── */

describe('system roles — the start-up seed respects an administrator\'s changes', () => {
  it('does not re-grant a removed default right, but still grants rights that are new to the catalogue', async () => {
    const { seedSystem } = await import('../db/seed.js');
    const { getDatabase } = await import('../db/driver.js');
    const db = await getDatabase();
    const codesOf = async (roleCode: string) => {
      const res = await request(app).get(api(`/roles/${roleId(roleCode)}`)).set(auth(adminToken));
      return (res.body.data.permissions as { code: string }[]).map((p) => p.code);
    };

    const before = await codesOf('PURCHASE_USER');
    expect(before).toContain('po.delete');
    expect(before).toContain('po.create');

    // An administrator takes "delete purchase orders" away from Purchase User.
    const role = roles.find((r) => r.code === 'PURCHASE_USER')!;
    const detail = (await request(app).get(api(`/roles/${role.id}`)).set(auth(adminToken))).body.data;
    const edit = await request(app).put(api(`/roles/${role.id}`)).set(auth(adminToken)).send({
      code: 'PURCHASE_USER', name: detail.name, description: detail.description ?? '',
      permissionIds: before.filter((c) => c !== 'po.delete').map(permId),
    });
    expect(edit.status).toBe(200);
    expect(await codesOf('PURCHASE_USER')).not.toContain('po.delete');

    // A right that is NEW to this database: remove it from the catalogue table
    // (its grants go with it), exactly as if this release had introduced it.
    await db.query("DELETE FROM permissions WHERE code = 'po.create'");
    expect(await codesOf('PURCHASE_USER')).not.toContain('po.create');

    // Server restart.
    await seedSystem();
    permissions = (await request(app).get(api('/roles/permissions')).set(auth(adminToken))).body.data
      .flatMap((g: { permissions: { id: number; code: string }[] }) => g.permissions);

    const after = await codesOf('PURCHASE_USER');
    expect(after).not.toContain('po.delete');   // the administrator's change survives
    expect(after).toContain('po.create');       // the new right reaches its default roles
    expect(after.filter((c) => c !== 'po.create').sort()).toEqual(before.filter((c) => !['po.delete', 'po.create'].includes(c)).sort());

    // Super Admin is always complete.
    expect((await codesOf('SUPER_ADMIN')).length).toBe(permissions.length);
    // And the session of a signed-in Purchase User follows suit.
    expect((await request(app).post(api('/purchase-orders')).set(auth(buyerToken)).send(poBody(1))).status).toBe(201);
  });
});
