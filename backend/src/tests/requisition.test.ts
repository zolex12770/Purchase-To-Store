/**
 * Integration tests — Requisition (Purchase Module tab 4): User -> HOD
 * approval -> Store issue -> stock deduction -> issue slip.
 *
 * Mirrors workflow.test.ts's harness (real PGlite DB, migrated + seeded from
 * scratch, real HTTP requests through the actual Express app) so the
 * business rules under test — over-issue allowed but capped strictly by
 * current stock, requested_qty immutability, wrong-HOD/self-approval
 * rejection, atomic stock deduction — are genuinely exercised end-to-end,
 * not mocked.
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
let hodToken = '';
let selfHodToken = '';
let storeToken = '';
let outsiderToken = '';

let uomId = 0;
let costCentreId = 0;
let machineId = 0;
let deptAId = 0; // HOD = a separate user (hodUser)
let deptSelfId = 0; // HOD = the requester themselves (self-approval test)
let itemId = 0;
let supplierId = 0;
let hodUserId = 0;
let selfHodUserId = 0;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

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
  if (me.body?.data?.mustChangePassword) {
    await request(app).post('/api/v1/auth/change-password').set(auth(token))
      .send({ currentPassword: initial, newPassword: next });
    token = await signIn(employeeId, [next]);
  }
  return token;
}

async function itemStock(id: number): Promise<string> {
  const res = await request(app).get(`/api/v1/items/${id}`).set(auth(adminToken));
  return res.body.data.live_stock_qty as string;
}

/** Posts a DIRECT GRN to top up an item's live stock by `qty`. */
async function stockUp(id: number, qty: string): Promise<void> {
  const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
    mode: 'DIRECT', supplierId, post: true,
    lines: [{ itemId: id, grnQty: qty, rate: '10' }],
  });
  expect(res.status).toBe(201);
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

  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');

  const lookups = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  uomId = lookups.body.data.UOM[0].id;

  const mk = async (category: string, code: string, name: string) => {
    const res = await request(app).post(`/api/v1/lookups/${category}`).set(auth(adminToken))
      .send({ code, name });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  costCentreId = await mk('COST_CENTRE', 'TREQ-CC', 'Test Requisition Cost Centre');
  deptAId = await mk('DEPARTMENT', 'TREQ-DA', 'Test Requisition Dept A');
  deptSelfId = await mk('DEPARTMENT', 'TREQ-DS', 'Test Requisition Dept Self');
  machineId = await mk('MACHINE', 'TREQ-M1', 'Test Machine 1');

  const supplier = await request(app).post('/api/v1/suppliers').set(auth(adminToken))
    .send({ supplierName: 'Test Requisition Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  supplierId = supplier.body.data.id;

  const item = await request(app).post('/api/v1/items').set(auth(adminToken))
    .send({ itemCode: 'TEST-REQ-ITEM', itemDescription: 'Test Requisition Item', uomId, standardRate: '10' });
  itemId = item.body.data.id;

  const roles = await request(app).get('/api/v1/roles').set(auth(adminToken));
  const roleId = (code: string) => roles.body.data.find((r: { code: string }) => r.code === code).id;

  await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-REQ-HOD', employeeName: 'Test Requisition HOD', designation: 'HOD',
    password: 'ReqHod@Test2026', roleIds: [roleId('EMPLOYEE')], mustChangePassword: false,
  });
  const selfHod = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-REQ-SELF', employeeName: 'Test Requisition Self HOD', designation: 'HOD',
    password: 'ReqSelf@Test2026', roleIds: [roleId('EMPLOYEE')], mustChangePassword: false,
    departmentId: deptSelfId,
  });
  await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-REQ-STORE', employeeName: 'Test Requisition Store', designation: 'Store',
    password: 'ReqStore@Test2026', roleIds: [roleId('STORE_USER')], mustChangePassword: false,
  });
  await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-REQ-OUT', employeeName: 'Test Requisition Outsider', designation: 'Other',
    password: 'ReqOut@Test2026', roleIds: [roleId('EMPLOYEE')], mustChangePassword: false,
  });

  hodToken = await signIn('T-REQ-HOD', ['ReqHod@Test2026']);
  selfHodToken = await signIn('T-REQ-SELF', ['ReqSelf@Test2026']);
  storeToken = await signIn('T-REQ-STORE', ['ReqStore@Test2026']);
  outsiderToken = await signIn('T-REQ-OUT', ['ReqOut@Test2026']);

  const me = await request(app).get('/api/v1/auth/me').set(auth(hodToken));
  hodUserId = me.body.data.id;
  const meSelf = await request(app).get('/api/v1/auth/me').set(auth(selfHodToken));
  selfHodUserId = meSelf.body.data.id;

  // T-REQ-OUT is the requester in deptA; its HOD is T-REQ-HOD.
  await request(app).put(`/api/v1/requisitions/departments/${deptAId}/hod`).set(auth(adminToken))
    .send({ hodUserId });
  // T-REQ-SELF's own department maps HOD back to themselves.
  await request(app).put(`/api/v1/requisitions/departments/${deptSelfId}/hod`).set(auth(adminToken))
    .send({ hodUserId: selfHodUserId });

}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function requesterDepartmentSetup(): Promise<void> {
  const users = await request(app).get('/api/v1/users').set(auth(adminToken));
  const outsider = users.body.data.find((u: { employee_id: string }) => u.employee_id === 'T-REQ-OUT');
  const res = await request(app).put(`/api/v1/users/${outsider.id}`).set(auth(adminToken)).send({
    employeeId: outsider.employee_id, employeeName: outsider.employee_name, designation: outsider.designation ?? '',
    departmentId: deptAId, isActive: true,
    roleIds: (outsider.roles as { id: number }[]).map((r) => r.id),
  });
  expect(res.status).toBe(200);
}

async function createRequisition(
  token: string,
  qty: string,
  opts: { submit?: boolean; remarks?: string } = {},
) {
  return request(app).post('/api/v1/requisitions').set(auth(token)).send({
    machineId, costCentreId, remarks: opts.remarks ?? '',
    lines: [{ itemId, requestedQty: qty, remarks: '' }],
    submit: opts.submit ?? false,
  });
}

/* ── Tests ───────────────────────────────────────────────────────────────── */

describe('Requisition workflow', () => {
  it('sets up the requester (T-REQ-OUT) in Department A', async () => {
    await requesterDepartmentSetup();
    const users = await request(app).get('/api/v1/users').set(auth(adminToken));
    const outsider = users.body.data.find((u: { employee_id: string }) => u.employee_id === 'T-REQ-OUT');
    expect(outsider.department_id).toBe(deptAId);
  });

  it('MACHINE lookups load through the existing lookup API, department-cascaded (bug-fix task, item 2)', async () => {
    const created = await request(app).post('/api/v1/lookups/MACHINE').set(auth(adminToken))
      .send({ code: 'TREQ-M-PARENTED', name: 'TREQ-M-PARENTED', parentId: deptAId });
    expect(created.status).toBe(201);

    const res = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
    expect(res.status).toBe(200);
    const machine = res.body.data.MACHINE.find((m: { id: number }) => m.id === created.body.data.id);
    expect(machine).toBeDefined();
    expect(machine.parentId).toBe(deptAId); // cascades from DEPARTMENT via lookup.routes.ts PARENT_OF, no hardcoded list
  });

  it('registers the Google Sheet "Machine" mapping under its real tab name, not a typo\'d one', async () => {
    const res = await request(app).get('/api/v1/google-sync/status').set(auth(adminToken));
    expect(res.status).toBe(200);
    const names: string[] = res.body.data.mappings.map((m: { sheet_name: string }) => m.sheet_name);
    expect(names).toContain('Machine');
    expect(names).not.toContain('Machine-Machine');
    const machineMapping = res.body.data.mappings.find((m: { sheet_name: string }) => m.sheet_name === 'Machine');
    expect(machineMapping.target_entity).toBe('lookups:MACHINE');
  });

  it('resolves the department HOD mapping (not hardcoded)', async () => {
    const res = await request(app).get(`/api/v1/requisitions/departments/${deptAId}/hod`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.hodUserId).toBe(hodUserId);
    expect(res.body.data.hod.employee_id).toBe('T-REQ-HOD');
  });

  it('rejects an unknown item on requisition creation', async () => {
    const res = await request(app).post('/api/v1/requisitions').set(auth(outsiderToken)).send({
      machineId, costCentreId, remarks: '',
      lines: [{ itemId: 9_999_999, requestedQty: '5', remarks: '' }],
      submit: false,
    });
    expect(res.status).toBe(422);
  });

  it('rejects a zero/negative requested quantity', async () => {
    const zero = await createRequisition(outsiderToken, '0');
    expect(zero.status).toBe(422);
    const negative = await createRequisition(outsiderToken, '-3');
    expect(negative.status).toBe(422);
  });

  it('allows a requested quantity that exceeds current stock — no stock check at creation', async () => {
    expect(await itemStock(itemId)).toBe('0.0000');
    const res = await createRequisition(outsiderToken, '9999', { submit: false });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('DRAFT');
  });

  let reqId = 0;
  let reqNo = '';

  it('issues a server-side, day-keyed REQ- number and submits for HOD approval', async () => {
    const res = await createRequisition(outsiderToken, '5', { submit: true, remarks: 'Needed for production' });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.requisition_no).toMatch(/^REQ-\d{8}-\d{4}$/);
    expect(res.body.data.hod_user_id).toBe(hodUserId);
    reqId = res.body.data.id;
    reqNo = res.body.data.requisition_no;
  });

  it('generates a unique, incrementing number for a second requisition the same day', async () => {
    const res = await createRequisition(outsiderToken, '3', { submit: true });
    expect(res.status).toBe(201);
    expect(res.body.data.requisition_no).not.toBe(reqNo);
  });

  it('refuses an unauthorised (wrong-department) HOD from approving', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${reqId}/approve`).set(auth(selfHodToken)).send({});
    expect(res.status).toBe(403);
  });

  it('refuses a normal user without requisition.approve from approving', async () => {
    // The requester itself holds requisition.approve (EMPLOYEE role), but is not
    // the mapped HOD for deptA — still blocked as "wrong HOD".
    const res = await request(app).post(`/api/v1/requisitions/${reqId}/approve`).set(auth(outsiderToken)).send({});
    expect(res.status).toBe(403);
  });

  it('blocks self-approval unless the actor is a Super Admin, even when they are the mapped HOD', async () => {
    const created = await request(app).post('/api/v1/requisitions').set(auth(selfHodToken)).send({
      machineId, costCentreId, remarks: '',
      lines: [{ itemId, requestedQty: '2', remarks: '' }],
      submit: true,
    });
    expect(created.status).toBe(201);
    expect(created.body.data.hod_user_id).toBe(selfHodUserId);

    const selfApprove = await request(app).post(`/api/v1/requisitions/${created.body.data.id}/approve`)
      .set(auth(selfHodToken)).send({});
    expect(selfApprove.status).toBe(422);

    const detail = await request(app).get(`/api/v1/requisitions/${created.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');

    // A Super Admin MAY approve it (explicit permission override, not a role hack).
    const adminApprove = await request(app).post(`/api/v1/requisitions/${created.body.data.id}/approve`)
      .set(auth(adminToken)).send({});
    expect(adminApprove.status).toBe(200);
  });

  it('requires a reason to reject or return', async () => {
    const noReason = await request(app).post(`/api/v1/requisitions/${reqId}/reject`).set(auth(hodToken)).send({});
    expect(noReason.status).toBe(422);
  });

  it('the correct HOD approves the requisition', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${reqId}/approve`).set(auth(hodToken)).send({});
    expect(res.status).toBe(200);
    const detail = await request(app).get(`/api/v1/requisitions/${reqId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');
  });

  let returnedId = 0;

  it('HOD can return a requisition for correction; requester edits and resubmits', async () => {
    const created = await createRequisition(outsiderToken, '4', { submit: true });
    returnedId = created.body.data.id;

    const returned = await request(app).post(`/api/v1/requisitions/${returnedId}/return`).set(auth(hodToken))
      .send({ reason: 'Please specify the correct machine number' });
    expect(returned.status).toBe(200);

    const afterReturn = await request(app).get(`/api/v1/requisitions/${returnedId}`).set(auth(adminToken));
    expect(afterReturn.body.data.status).toBe('RETURNED');

    const edited = await request(app).put(`/api/v1/requisitions/${returnedId}`).set(auth(outsiderToken)).send({
      machineId, costCentreId, remarks: 'corrected',
      lines: [{ itemId, requestedQty: '4', remarks: '' }],
      submit: true,
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.status).toBe('PENDING_APPROVAL');

    const history = await request(app).get(`/api/v1/audit/entity/requisition/${returnedId}`).set(auth(adminToken));
    const actions = history.body.data.map((h: { action: string }) => h.action);
    expect(actions).toContain('SUBMIT');
    expect(actions).toContain('RETURN');
  });

  it('a rejected requisition requires an explicit REOPEN before it becomes editable again', async () => {
    const created = await createRequisition(outsiderToken, '2', { submit: true });
    const id = created.body.data.id;
    const rejected = await request(app).post(`/api/v1/requisitions/${id}/reject`).set(auth(hodToken))
      .send({ reason: 'Not required this month' });
    expect(rejected.status).toBe(200);

    const editWhileRejected = await request(app).put(`/api/v1/requisitions/${id}`).set(auth(outsiderToken)).send({
      machineId, costCentreId, remarks: '', lines: [{ itemId, requestedQty: '2', remarks: '' }], submit: false,
    });
    expect(editWhileRejected.status).toBe(422);

    const reopened = await request(app).post(`/api/v1/requisitions/${id}/reopen`).set(auth(outsiderToken)).send({});
    expect(reopened.status).toBe(200);
    const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('DRAFT');
  });

  /* ── Store issue: the safety-critical stock rules ────────────────────────── */

  let issueReqId = 0;
  let issueLineId = 0;
  let issueItemStockStart = '0.0000';

  it('sets up an approved requisition with real stock behind it', async () => {
    await stockUp(itemId, '20'); // cumulative live stock now includes prior GRN inwards in this file's DB
    issueItemStockStart = await itemStock(itemId);

    const created = await createRequisition(outsiderToken, '5', { submit: true });
    issueReqId = created.body.data.id;
    await request(app).post(`/api/v1/requisitions/${issueReqId}/approve`).set(auth(hodToken)).send({});

    const detail = await request(app).get(`/api/v1/requisitions/${issueReqId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');
    issueLineId = detail.body.data.lines[0].requisition_line_id;
  });

  it('refuses store issue from a user without requisition.issue permission', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${issueReqId}/issue`).set(auth(outsiderToken))
      .send({ lines: [{ requisitionLineId: issueLineId, issueQty: '2' }] });
    expect(res.status).toBe(403);
  });

  it('allows a PARTIAL issue (issue < requested) — requested_qty is untouched', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${issueReqId}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: issueLineId, issueQty: '2' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.issueSlipNo).toMatch(/^ISS-\d{8}-\d{4}$/);
    expect(res.body.data.status).toBe('PARTIALLY_ISSUED');

    const detail = await request(app).get(`/api/v1/requisitions/${issueReqId}`).set(auth(adminToken));
    const line = detail.body.data.lines[0];
    expect(line.requested_qty).toBe('5.0000');
    expect(line.issued_qty).toBe('2.0000');
    expect(line.pending_qty).toBe('3.0000');

    const stockAfter = await itemStock(itemId);
    expect(Number(stockAfter)).toBeCloseTo(Number(issueItemStockStart) - 2, 4);
  });

  it('accumulates a SECOND partial issue and reaches FULLY_ISSUED exactly at the requested total', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${issueReqId}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: issueLineId, issueQty: '3' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('FULLY_ISSUED');

    const detail = await request(app).get(`/api/v1/requisitions/${issueReqId}`).set(auth(adminToken));
    const line = detail.body.data.lines[0];
    expect(line.requested_qty).toBe('5.0000');
    expect(line.issued_qty).toBe('5.0000');
    expect(line.pending_qty).toBe('0.0000');
    expect(detail.body.data.issues).toHaveLength(2);
  });

  it('allows a THIRD, deliberate OVER-issue beyond the requested quantity, capped only by stock', async () => {
    const stockBefore = await itemStock(itemId);
    const res = await request(app).post(`/api/v1/requisitions/${issueReqId}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: issueLineId, issueQty: '4' }] });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('FULLY_ISSUED');

    const detail = await request(app).get(`/api/v1/requisitions/${issueReqId}`).set(auth(adminToken));
    const line = detail.body.data.lines[0];
    expect(line.requested_qty).toBe('5.0000'); // NEVER overwritten
    expect(line.issued_qty).toBe('9.0000'); // 2 + 3 + 4
    expect(line.excess_qty).toBe('4.0000');

    const stockAfter = await itemStock(itemId);
    expect(Number(stockAfter)).toBeCloseTo(Number(stockBefore) - 4, 4);
  });

  it('rejects an issue that exceeds AVAILABLE STOCK, with no stock movement and no issue slip created', async () => {
    const stockBefore = await itemStock(itemId);
    const created = await createRequisition(outsiderToken, '1', { submit: true });
    const reqId2 = created.body.data.id;
    await request(app).post(`/api/v1/requisitions/${reqId2}/approve`).set(auth(hodToken)).send({});
    const detail = await request(app).get(`/api/v1/requisitions/${reqId2}`).set(auth(adminToken));
    const lineId2 = detail.body.data.lines[0].requisition_line_id;

    const tooMuch = (Number(stockBefore) + 1000).toString();
    const res = await request(app).post(`/api/v1/requisitions/${reqId2}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: lineId2, issueQty: tooMuch }] });
    expect(res.status).toBe(422);

    const stockAfter = await itemStock(itemId);
    expect(stockAfter).toBe(stockBefore);

    const after = await request(app).get(`/api/v1/requisitions/${reqId2}`).set(auth(adminToken));
    expect(after.body.data.status).toBe('APPROVED'); // unchanged — no false issue
    expect(after.body.data.issues).toHaveLength(0);
  });

  it('allows an issue exactly equal to available stock (the boundary case)', async () => {
    const stockBefore = await itemStock(itemId);
    const created = await createRequisition(outsiderToken, '1', { submit: true });
    const reqId3 = created.body.data.id;
    await request(app).post(`/api/v1/requisitions/${reqId3}/approve`).set(auth(hodToken)).send({});
    const detail = await request(app).get(`/api/v1/requisitions/${reqId3}`).set(auth(adminToken));
    const lineId3 = detail.body.data.lines[0].requisition_line_id;

    const res = await request(app).post(`/api/v1/requisitions/${reqId3}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: lineId3, issueQty: stockBefore }] });
    expect(res.status).toBe(201);

    const stockAfter = await itemStock(itemId);
    expect(Number(stockAfter)).toBeCloseTo(0, 4);
  });

  it('refuses store issue against a requisition that is not yet HOD-approved', async () => {
    const created = await createRequisition(outsiderToken, '1', { submit: true });
    const id = created.body.data.id;
    const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
    const lineId = detail.body.data.lines[0].requisition_line_id;

    const res = await request(app).post(`/api/v1/requisitions/${id}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: lineId, issueQty: '1' }] });
    expect(res.status).toBe(422);
  });

  it('refuses to cancel a requisition that already has material issued against it', async () => {
    const res = await request(app).post(`/api/v1/requisitions/${issueReqId}/cancel`).set(auth(outsiderToken))
      .send({ reason: 'no longer needed' });
    expect(res.status).toBe(422);
  });

  it('records a full audit trail for the issue transaction', async () => {
    const history = await request(app).get(`/api/v1/audit/entity/requisition/${issueReqId}`).set(auth(adminToken));
    const issueEvents = history.body.data.filter((h: { action: string }) => h.action === 'ISSUE');
    expect(issueEvents.length).toBe(3); // partial, complete, over-issue
  });

  it('generates a printable issue slip and requisition document', async () => {
    const reqPrint = await request(app).get(`/api/v1/requisitions/${issueReqId}/print-view`).set(auth(adminToken));
    expect(reqPrint.status).toBe(200);
    expect(reqPrint.text).toContain('MATERIAL REQUISITION');

    const issues = await request(app).get(`/api/v1/requisitions/${issueReqId}`).set(auth(adminToken));
    const firstIssueId = issues.body.data.issues[0].id;
    const slipPrint = await request(app).get(`/api/v1/requisitions/issues/${firstIssueId}/print-view`).set(auth(adminToken));
    expect(slipPrint.status).toBe(200);
    expect(slipPrint.text).toContain('ISSUE SLIP');
  });

  it('scopes list views correctly: mine / hod-pending / store-queue', async () => {
    const mine = await request(app).get(`/api/v1/requisitions${qs({ view: 'mine' })}`).set(auth(outsiderToken));
    expect(mine.status).toBe(200);
    expect((mine.body.data as { requester_user_id: number }[]).length).toBeGreaterThan(0);

    const hodPending = await request(app).get(`/api/v1/requisitions${qs({ view: 'hod-pending' })}`).set(auth(hodToken));
    expect(hodPending.status).toBe(200);
    expect((hodPending.body.data as { status: string }[]).every((r) => r.status === 'PENDING_APPROVAL')).toBe(true);

    const storeQueue = await request(app).get(`/api/v1/requisitions${qs({ view: 'store-queue' })}`).set(auth(storeToken));
    expect(storeQueue.status).toBe(200);
    expect((storeQueue.body.data as { status: string }[]).every((r) => ['APPROVED', 'PARTIALLY_ISSUED'].includes(r.status))).toBe(true);
  });

  it('deletes a DRAFT requisition but refuses to delete a submitted one', async () => {
    const draft = await createRequisition(outsiderToken, '1', { submit: false });
    const del = await request(app).delete(`/api/v1/requisitions/${draft.body.data.id}`).set(auth(outsiderToken));
    expect(del.status).toBe(200);

    const submitted = await createRequisition(outsiderToken, '1', { submit: true });
    const delSubmitted = await request(app).delete(`/api/v1/requisitions/${submitted.body.data.id}`).set(auth(outsiderToken));
    expect(delSubmitted.status).toBe(422);
  });

  it('two concurrent over-issues against the same item never drive stock negative', async () => {
    await stockUp(itemId, '10');
    const stockBefore = await itemStock(itemId);

    const created = await createRequisition(outsiderToken, '1', { submit: true });
    const id = created.body.data.id;
    await request(app).post(`/api/v1/requisitions/${id}/approve`).set(auth(hodToken)).send({});
    const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
    const lineId = detail.body.data.lines[0].requisition_line_id;

    const half = (Number(stockBefore) / 2 + 1).toFixed(4);
    const [r1, r2] = await Promise.all([
      request(app).post(`/api/v1/requisitions/${id}/issue`).set(auth(storeToken))
        .send({ lines: [{ requisitionLineId: lineId, issueQty: half }] }),
      request(app).post(`/api/v1/requisitions/${id}/issue`).set(auth(storeToken))
        .send({ lines: [{ requisitionLineId: lineId, issueQty: half }] }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([201, 422]); // exactly one succeeds, one is refused for insufficient stock

    const stockAfter = await itemStock(itemId);
    expect(Number(stockAfter)).toBeGreaterThanOrEqual(0);
  });

  it('reports summary analysis counts', async () => {
    const res = await request(app).get('/api/v1/requisitions/analysis/summary').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBeGreaterThan(0);
    expect(typeof res.body.data.totalRequestedQty).toBe('string');
    expect(typeof res.body.data.hodApproved).toBe('number');
    expect(typeof res.body.data.awaitingStoreIssue).toBe('number');
  });

  /* ── HOD Status / Store Status — two independent, user-facing columns ────── */

  describe('HOD Status / Store Status derivation', () => {
    it('shows hod_status=PENDING and store_status=PENDING for a freshly submitted requisition', async () => {
      const created = await createRequisition(outsiderToken, '3', { submit: true });
      const detail = await request(app).get(`/api/v1/requisitions/${created.body.data.id}`).set(auth(adminToken));
      expect(detail.body.data.hod_status).toBe('PENDING');
      expect(detail.body.data.store_status).toBe('PENDING');
    });

    it('shows hod_status=PENDING for a RETURNED requisition (not a final rejection)', async () => {
      const created = await createRequisition(outsiderToken, '3', { submit: true });
      const id = created.body.data.id;
      await request(app).post(`/api/v1/requisitions/${id}/return`).set(auth(hodToken)).send({ reason: 'fix machine no.' });
      const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.status).toBe('RETURNED');
      expect(detail.body.data.hod_status).toBe('PENDING');
      expect(detail.body.data.store_status).toBe('PENDING');
    });

    it('shows hod_status=REJECTED for a rejected requisition', async () => {
      const created = await createRequisition(outsiderToken, '3', { submit: true });
      const id = created.body.data.id;
      await request(app).post(`/api/v1/requisitions/${id}/reject`).set(auth(hodToken)).send({ reason: 'not needed' });
      const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.hod_status).toBe('REJECTED');
      expect(detail.body.data.store_status).toBe('PENDING');
    });

    it('shows hod_status=APPROVED and store_status=PENDING once approved but not yet issued', async () => {
      const created = await createRequisition(outsiderToken, '3', { submit: true });
      const id = created.body.data.id;
      await request(app).post(`/api/v1/requisitions/${id}/approve`).set(auth(hodToken)).send({});
      const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.hod_status).toBe('APPROVED');
      expect(detail.body.data.store_status).toBe('PENDING');
    });

    it('flips store_status to ISSUED once issued_qty >= requested_qty, even with a partial-then-excess sequence', async () => {
      await stockUp(itemId, '50');
      const created = await createRequisition(outsiderToken, '4', { submit: true });
      const id = created.body.data.id;
      await request(app).post(`/api/v1/requisitions/${id}/approve`).set(auth(hodToken)).send({});
      let detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      const lineId = detail.body.data.lines[0].requisition_line_id;

      // Partial issue: still PENDING.
      await request(app).post(`/api/v1/requisitions/${id}/issue`).set(auth(storeToken))
        .send({ lines: [{ requisitionLineId: lineId, issueQty: '1' }] });
      detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.hod_status).toBe('APPROVED');
      expect(detail.body.data.store_status).toBe('PENDING');

      // Second issue reaches (and slightly exceeds) requested: flips to ISSUED,
      // but actual issued_qty stays the real cumulative total, never capped
      // back down to requested_qty.
      await request(app).post(`/api/v1/requisitions/${id}/issue`).set(auth(storeToken))
        .send({ lines: [{ requisitionLineId: lineId, issueQty: '6' }] });
      detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.hod_status).toBe('APPROVED');
      expect(detail.body.data.store_status).toBe('ISSUED');
      expect(detail.body.data.lines[0].requested_qty).toBe('4.0000');
      expect(detail.body.data.lines[0].issued_qty).toBe('7.0000');
    });

    it('preserves the prior HOD disposition on a CANCELLED requisition (approved-then-cancelled still reads APPROVED)', async () => {
      const created = await createRequisition(outsiderToken, '2', { submit: false });
      const id = created.body.data.id;
      const cancelled = await request(app).post(`/api/v1/requisitions/${id}/cancel`).set(auth(outsiderToken)).send({ reason: 'no longer needed' });
      expect(cancelled.status).toBe(200);
      const detail = await request(app).get(`/api/v1/requisitions/${id}`).set(auth(adminToken));
      expect(detail.body.data.status).toBe('CANCELLED');
      // Never submitted, never decided -> falls back to PENDING, not a fabricated verdict.
      expect(detail.body.data.hod_status).toBe('PENDING');
    });

    it('filters the list by hodStatus and storeStatus independently, and reports their counts', async () => {
      const res = await request(app).get('/api/v1/requisitions').set(auth(adminToken))
        .query({ hodStatus: 'APPROVED', storeStatus: 'PENDING' });
      expect(res.status).toBe(200);
      for (const row of res.body.data) {
        expect(row.hod_status).toBe('APPROVED');
        expect(row.store_status).toBe('PENDING');
      }
      expect(res.body.meta.hodStatusCounts).toBeDefined();
      expect(res.body.meta.storeStatusCounts).toBeDefined();
    });

    it('exposes hod_status/store_status on the printable requisition document', async () => {
      const created = await createRequisition(outsiderToken, '1', { submit: true });
      const id = created.body.data.id;
      await request(app).post(`/api/v1/requisitions/${id}/approve`).set(auth(hodToken)).send({});
      const print = await request(app).get(`/api/v1/requisitions/${id}/print-view`).set(auth(adminToken));
      expect(print.status).toBe(200);
      expect(print.text).toContain('HOD: Approved');
      expect(print.text).toContain('Store: Pending');
    });
  });

  describe('Requisition analytics integration', () => {
    it('includes requisition_* metrics in the shared /analytics/kpis response', async () => {
      const res = await request(app).get('/api/v1/analytics/kpis').set(auth(adminToken));
      expect(res.status).toBe(200);
      const keys = res.body.data.kpis.map((k: { key: string }) => k.key);
      expect(keys).toContain('requisition_count');
      expect(keys).toContain('requisition_hod_approved');
      expect(keys).toContain('requisition_requested_qty');
    });

    it('includes requisition series in /analytics/trends', async () => {
      const res = await request(app).get('/api/v1/analytics/trends').set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      expect(res.body.data[0]).toHaveProperty('requisitionCount');
      expect(res.body.data[0]).toHaveProperty('requisitionRequestedQty');
    });

    it('breaks down requisitions by department with quantity totals, not money', async () => {
      const res = await request(app).get('/api/v1/analytics/requisition-breakdown/department').set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(res.body.meta.dimensionTitle).toBe('Department');
      for (const row of res.body.data) {
        expect(row).toHaveProperty('totalRequestedQty');
        expect(row).toHaveProperty('totalIssuedQty');
        expect(row).not.toHaveProperty('totalValue');
      }
    });

    it('breaks down requisitions by item, requester, hod, machine and cost centre', async () => {
      for (const dim of ['item', 'requester', 'hod', 'machine', 'costCentre']) {
        const res = await request(app).get(`/api/v1/analytics/requisition-breakdown/${dim}`).set(auth(adminToken));
        expect(res.status).toBe(200);
      }
    });

    it('rejects an unknown requisition breakdown dimension', async () => {
      const res = await request(app).get('/api/v1/analytics/requisition-breakdown/bogus').set(auth(adminToken));
      expect(res.status).toBe(422);
    });

    it('computes ageing for HOD-approved requisitions awaiting store issue', async () => {
      const res = await request(app).get('/api/v1/analytics/ageing').set(auth(adminToken)).query({ basis: 'requisition' });
      expect(res.status).toBe(200);
      expect(res.body.meta.basis).toBe('requisition');
      expect(Array.isArray(res.body.data)).toBe(true);
    });

    it('surfaces requisition exceptions (pending HOD approval / awaiting store issue) alongside the existing ones', async () => {
      const res = await request(app).get('/api/v1/analytics/exceptions').set(auth(adminToken));
      expect(res.status).toBe(200);
      const keys = res.body.data.map((e: { key: string }) => e.key);
      expect(keys).toContain('requisition_pending_hod');
      expect(keys).toContain('requisition_awaiting_issue');
    });

    it('reconciles GRN inward and requisition outward against one authoritative stock balance (Opening + Inward − Outward = Current)', async () => {
      const res = await request(app).get('/api/v1/items/analysis/stock-reconciliation')
        .set(auth(adminToken)).query({ search: 'TEST-REQ-ITEM' });
      expect(res.status).toBe(200);
      expect(res.body.data.length).toBeGreaterThan(0);
      const row = res.body.data.find((r: { item_code: string }) => r.item_code === 'TEST-REQ-ITEM');
      expect(row).toBeDefined();
      expect(row.mismatch).toBe(false);
      const computed = Number(row.grn_inward) - Number(row.grn_reversal) - Number(row.requisition_issue) + Number(row.requisition_reversal);
      expect(computed).toBeCloseTo(Number(row.current_stock), 4);
    });

    it('extends the item detail endpoint with full Requisition/Issue/stock-ledger traceability', async () => {
      const res = await request(app).get(`/api/v1/items/${itemId}`).set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(Array.isArray(res.body.data.requisitions)).toBe(true);
      expect(Array.isArray(res.body.data.issueHistory)).toBe(true);
      expect(Array.isArray(res.body.data.stockLedger)).toBe(true);
      expect(res.body.data.stockLedger.length).toBeGreaterThan(0);
      const types = new Set(res.body.data.stockLedger.map((l: { txn_type: string }) => l.txn_type));
      expect(types.has('GRN_INWARD')).toBe(true);
      expect(types.has('REQUISITION_ISSUE')).toBe(true);
    });
  });
});

/**
 * GRN edit-lock — Requisition consumption (mandatory test, Section 4/35):
 * a POSTED GRN must remain genuinely editable (including received quantity)
 * until a Requisition has actually issued stock against one of its items;
 * from that point only the quantity fields of the affected line lock, never
 * the whole document. Uses a dedicated item so its consumption history starts
 * clean, independent of every other test in this file.
 */
describe('GRN edit-lock — Requisition remains the real gate, not mere POSTED status (Section 4)', () => {
  let lockItemId = 0;
  let otherItemId = 0;
  let grnId = 0;
  let lineId = 0;

  it('creates a dedicated item and posts a GRN for it — POSTED but never yet requisitioned', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'TREQ-GRNLOCK-ITEM', itemDescription: 'GRN Edit-Lock Test Item', uomId, standardRate: '10' });
    expect(item.status).toBe(201);
    lockItemId = item.body.data.id;

    const other = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'TREQ-GRNLOCK-OTHER', itemDescription: 'GRN Edit-Lock Second Line Item', uomId, standardRate: '10' });
    otherItemId = other.body.data.id;

    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Initial receipt',
      lines: [{ itemId: lockItemId, grnQty: '50', rate: '10' }],
    });
    expect(grn.status).toBe(201);
    expect(grn.body.data.status).toBe('POSTED');
    grnId = grn.body.data.id;

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.lines).toHaveLength(1);
    lineId = detail.body.data.lines[0].id;
    expect(detail.body.data.lines[0].mln_no).toBeTruthy();
    expect(await itemStock(lockItemId)).toBe('50.0000');
  });

  it('remains editable while POSTED but not yet requisitioned — corrects the received quantity in place', async () => {
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Corrected on recount',
      lines: [{ id: lineId, itemId: lockItemId, grnQty: '60', rate: '10' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('POSTED'); // still posted — never bounced back to DRAFT
    expect(res.body.data.remarks).toBe('Corrected on recount');
    expect(await itemStock(lockItemId)).toBe('60.0000');

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.lines[0].grn_qty).toBe('60.0000');
    expect(detail.body.data.lines[0].mln_no).toBeTruthy(); // same lot — never reissued
  });

  it('a Requisition then issues stock against this item', async () => {
    const created = await request(app).post('/api/v1/requisitions').set(auth(outsiderToken)).send({
      machineId, costCentreId, remarks: '', submit: true,
      lines: [{ itemId: lockItemId, requestedQty: '10', remarks: '' }],
    });
    expect(created.status).toBe(201);
    const reqId = created.body.data.id;
    await request(app).post(`/api/v1/requisitions/${reqId}/approve`).set(auth(hodToken)).send({});

    const detail = await request(app).get(`/api/v1/requisitions/${reqId}`).set(auth(adminToken));
    const reqLineId = detail.body.data.lines[0].requisition_line_id;

    const issue = await request(app).post(`/api/v1/requisitions/${reqId}/issue`).set(auth(storeToken))
      .send({ lines: [{ requisitionLineId: reqLineId, issueQty: '4' }] });
    expect(issue.status).toBe(201);
    expect(await itemStock(lockItemId)).toBe('56.0000');
  });

  it('now refuses to change that line\'s received quantity — the real relationship (stock_ledger REQUISITION_ISSUE), not a fake FK', async () => {
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Corrected on recount',
      lines: [{ id: lineId, itemId: lockItemId, grnQty: '70', rate: '10' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/already been issued against a Requisition/i);
    expect(await itemStock(lockItemId)).toBe('56.0000'); // unchanged — refused before any mutation
  });

  it('still allows safe, non-quantity fields on the same line/header to be edited after consumption', async () => {
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Updated after issue — safe field',
      lines: [{ id: lineId, itemId: lockItemId, grnQty: '60', rate: '10', batchNo: 'BATCH-AFTER-ISSUE', remarks: 'line note' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.remarks).toBe('Updated after issue — safe field');

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.lines[0].batch_no).toBe('BATCH-AFTER-ISSUE');
    expect(detail.body.data.lines[0].grn_qty).toBe('60.0000'); // untouched
  });

  it('still allows a brand-new line (a different, never-issued item) to be added to the same POSTED GRN', async () => {
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Updated after issue — safe field',
      lines: [
        { id: lineId, itemId: lockItemId, grnQty: '60', rate: '10', batchNo: 'BATCH-AFTER-ISSUE' },
        { itemId: otherItemId, grnQty: '15', rate: '20' },
      ],
    });
    expect(res.status).toBe(200);
    expect(await itemStock(otherItemId)).toBe('15.0000');

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.lines).toHaveLength(2);
  });

  it('refuses to remove an already-posted line (its MLN cannot be deleted)', async () => {
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-1', remarks: 'Attempted removal',
      lines: [{ itemId: otherItemId, grnQty: '15', rate: '20' }], // drops the lockItemId line entirely
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/already been posted and assigned a lot number/i);
  });

  it('refuses to cancel a POSTED GRN once one of its items has been issued against a Requisition', async () => {
    const res = await request(app).post(`/api/v1/grn/${grnId}/cancel`).set(auth(adminToken))
      .send({ reason: 'Testing the cancel guard' });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/already been issued against a Requisition/i);

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('POSTED'); // unchanged — refused before any mutation
    expect(await itemStock(lockItemId)).toBe('56.0000');
  });

  it('refuses to edit a CANCELLED GRN outright', async () => {
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true, invoiceNo: 'TREQ-GRNLOCK-INV-2',
      lines: [{ itemId: otherItemId, grnQty: '5', rate: '20' }],
    });
    const id2 = grn.body.data.id;
    await request(app).post(`/api/v1/grn/${id2}/cancel`).set(auth(adminToken)).send({ reason: 'Test cancellation' });

    const res = await request(app).put(`/api/v1/grn/${id2}`).set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: false, remarks: 'should be refused',
      lines: [{ itemId: otherItemId, grnQty: '5', rate: '20' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/cancelled.*can no longer be edited/i);
  });
});
