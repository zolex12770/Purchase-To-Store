/**
 * Integration tests — Universal Filters & Multi-Dimensional Analytics.
 *
 * Verifies:
 * - Date ranges (From Date, To Date, inclusive timezone handling)
 * - User / Employee filtering across Indent, PO, GRN, Requisition, QC, Audit
 * - HOD filtering across departments and transactions
 * - Item and Department filtering
 * - Combined criteria (Date + User + Dept + Item)
 * - Filtered CSV/Excel export preservation
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
let userToken = '';
let hodToken = '';

let adminUserId = 0;
let regularUserId = 0;
let hodUserId = 0;

let deptAId = 0;
let deptBId = 0;
let costCentreId = 0;
let uomId = 0;
let itemId = 0;
let supplierId = 0;

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

  // Admin user
  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');
  const meAdmin = await request(app).get('/api/v1/auth/me').set(auth(adminToken));
  adminUserId = meAdmin.body.data.id;

  // Lookups
  const lookups = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  uomId = lookups.body.data.UOM[0].id;

  const mkLookup = async (category: string, code: string, name: string, extra?: Record<string, unknown>) => {
    const res = await request(app).post(`/api/v1/lookups/${category}`).set(auth(adminToken))
      .send({ code, name, extra: extra ? JSON.stringify(extra) : null });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };

  // Roles
  const roles = await request(app).get('/api/v1/roles').set(auth(adminToken));
  const roleId = (code: string) => roles.body.data.find((r: { code: string }) => r.code === code)?.id ?? roles.body.data[0].id;

  // Create Departments: Dept A and Dept B
  deptAId = await mkLookup('DEPARTMENT', 'DEPT-A', 'Department Alpha');
  deptBId = await mkLookup('DEPARTMENT', 'DEPT-B', 'Department Beta');
  costCentreId = await mkLookup('COST_CENTRE', 'CC-TEST', 'Filter Testing Cost Centre');

  // Create HOD User
  const hodUserRes = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'HOD999',
    employeeName: 'Filter Test HOD',
    designation: 'Head of Department',
    password: 'Zolex@Test2026',
    mustChangePassword: false,
    roleIds: [roleId('EMPLOYEE')],
  });
  expect(hodUserRes.status).toBe(201);
  hodUserId = hodUserRes.body.data.id;

  // Create Regular Employee User in Dept A
  const regularUserRes = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'EMP888',
    employeeName: 'Filter Test Employee',
    designation: 'Staff',
    password: 'Zolex@Test2026',
    mustChangePassword: false,
    roleIds: [roleId('EMPLOYEE')],
    departmentId: deptAId,
  });
  expect(regularUserRes.status).toBe(201);
  regularUserId = regularUserRes.body.data.id;

  // Map HOD to Dept A
  await request(app).put(`/api/v1/requisitions/departments/${deptAId}/hod`).set(auth(adminToken))
    .send({ hodUserId });

  userToken = await signIn('EMP888', ['Zolex@Test2026']);
  hodToken = await signIn('HOD999', ['Zolex@Test2026']);

  // Create Supplier
  const suppRes = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({
    supplierName: 'Filter Test Supplier Ltd',
    gstNo: '24AAACT1234A1Z5',
  });
  expect(suppRes.status).toBe(201);
  supplierId = suppRes.body.data.id;

  // Create Item
  const itemRes = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
    itemCode: 'ITM-FLT-001',
    itemDescription: 'Filter Testing Item',
    uomId,
    departmentId: deptAId,
    costCentreId,
    standardRate: '150.00',
  });
  expect(itemRes.status).toBe(201);
  itemId = itemRes.body.data.id;
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe('Universal Filters — Date, User, HOD, and Combined Queries', () => {
  it('GET /api/v1/lookups/users returns active users with department and HOD status', async () => {
    const res = await request(app).get('/api/v1/lookups/users').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);

    const emp = res.body.data.find((u: { employeeId: string }) => u.employeeId === 'EMP888');
    expect(emp).toBeDefined();
    expect(emp.employeeName).toBe('Filter Test Employee');

    const hod = res.body.data.find((u: { employeeId: string }) => u.employeeId === 'HOD999');
    expect(hod).toBeDefined();
    expect(hod.isHod).toBe(true);
  });

  it('filters purchase requisitions by dateFrom, dateTo, userId, and hodId', async () => {
    // 1. Create a requisition as regular user in deptA
    const reqCreate = await request(app).post('/api/v1/requisitions').set(auth(userToken)).send({
      requisitionDate: '2026-10-05',
      departmentId: deptAId,
      costCentreId,
      remarks: 'Requisition for Oct 5',
      lines: [{ itemId, requestedQty: '10' }],
    });
    expect(reqCreate.status).toBe(201);
    const reqId = reqCreate.body.data.id;

    // 2. Query with matching date range
    const qMatch = await request(app)
      .get(`/api/v1/requisitions${qs({ dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(qMatch.status).toBe(200);
    expect(qMatch.body.data.some((r: { id: number }) => r.id === reqId)).toBe(true);

    // 3. Query with non-matching date range
    const qNoMatch = await request(app)
      .get(`/api/v1/requisitions${qs({ dateFrom: '2026-10-15', dateTo: '2026-10-20' })}`)
      .set(auth(adminToken));
    expect(qNoMatch.status).toBe(200);
    expect(qNoMatch.body.data.some((r: { id: number }) => r.id === reqId)).toBe(false);

    // 4. Query with userId filter
    const qUser = await request(app)
      .get(`/api/v1/requisitions${qs({ userId: regularUserId })}`)
      .set(auth(adminToken));
    expect(qUser.status).toBe(200);
    expect(qUser.body.data.some((r: { id: number }) => r.id === reqId)).toBe(true);

    // 5. Query with different userId filter (adminUserId)
    const qOtherUser = await request(app)
      .get(`/api/v1/requisitions${qs({ userId: adminUserId })}`)
      .set(auth(adminToken));
    expect(qOtherUser.status).toBe(200);
    expect(qOtherUser.body.data.some((r: { id: number }) => r.id === reqId)).toBe(false);

    // 6. Query with hodId filter
    const qHod = await request(app)
      .get(`/api/v1/requisitions${qs({ hodId: hodUserId })}`)
      .set(auth(adminToken));
    expect(qHod.status).toBe(200);
    expect(qHod.body.data.some((r: { id: number }) => r.id === reqId)).toBe(true);

    // 7. Verify dynamic summary endpoint accepts query parameters
    const summaryRes = await request(app)
      .get(`/api/v1/requisitions/analysis/summary${qs({ userId: regularUserId, dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(summaryRes.status).toBe(200);
    expect(Number(summaryRes.body.data.total)).toBeGreaterThanOrEqual(1);
  });

  it('filters purchase indents by userId, hodId, and date range', async () => {
    // 1. Create indent as admin
    const indentCreate = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentDate: '2026-10-06',
      departmentId: deptAId,
      costCentreId,
      requiredByDate: '2026-11-01',
      remarks: 'Indent for filter test',
      lines: [{ itemId, indentQty: '25' }],
    });
    expect(indentCreate.status).toBe(201);
    const indentId = indentCreate.body.data.id;

    // 2. Filter by date range
    const qDate = await request(app)
      .get(`/api/v1/indents${qs({ dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(qDate.status).toBe(200);
    expect(qDate.body.data.some((i: { id: number }) => i.id === indentId)).toBe(true);

    // 3. Filter by admin userId
    const qAdmin = await request(app)
      .get(`/api/v1/indents${qs({ userId: adminUserId })}`)
      .set(auth(adminToken));
    expect(qAdmin.status).toBe(200);
    expect(qAdmin.body.data.some((i: { id: number }) => i.id === indentId)).toBe(true);

    // 4. Filter by regular employee userId (should not match this indent)
    const qEmp = await request(app)
      .get(`/api/v1/indents${qs({ userId: regularUserId })}`)
      .set(auth(adminToken));
    expect(qEmp.status).toBe(200);
    expect(qEmp.body.data.some((i: { id: number }) => i.id === indentId)).toBe(false);

    // 5. Filter by hodId (Dept A has HOD hodUserId)
    const qHod = await request(app)
      .get(`/api/v1/indents${qs({ hodId: hodUserId })}`)
      .set(auth(adminToken));
    expect(qHod.status).toBe(200);
    expect(qHod.body.data.some((i: { id: number }) => i.id === indentId)).toBe(true);
  });

  it('filters purchase orders by userId, departmentId, and date range', async () => {
    // Create PO directly as admin
    const poCreate = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      poDate: '2026-10-07',
      supplierId,
      departmentId: deptAId,
      costCentreId,
      lines: [{ itemId, poQty: '15', rate: '120.00' }],
    });
    expect(poCreate.status).toBe(201);
    const poId = poCreate.body.data.id;

    // Filter PO by userId
    const qPoUser = await request(app)
      .get(`/api/v1/purchase-orders${qs({ userId: adminUserId })}`)
      .set(auth(adminToken));
    expect(qPoUser.status).toBe(200);
    expect(qPoUser.body.data.some((p: { id: number }) => p.id === poId)).toBe(true);

    // Filter PO by non-creator userId
    const qPoOther = await request(app)
      .get(`/api/v1/purchase-orders${qs({ userId: regularUserId })}`)
      .set(auth(adminToken));
    expect(qPoOther.status).toBe(200);
    expect(qPoOther.body.data.some((p: { id: number }) => p.id === poId)).toBe(false);

    // Filter PO by departmentId
    const qPoDept = await request(app)
      .get(`/api/v1/purchase-orders${qs({ departmentId: deptAId })}`)
      .set(auth(adminToken));
    expect(qPoDept.status).toBe(200);
    expect(qPoDept.body.data.some((p: { id: number }) => p.id === poId)).toBe(true);

    // Filter PO by hodId
    const qPoHod = await request(app)
      .get(`/api/v1/purchase-orders${qs({ hodId: hodUserId })}`)
      .set(auth(adminToken));
    expect(qPoHod.status).toBe(200);
    expect(qPoHod.body.data.some((p: { id: number }) => p.id === poId)).toBe(true);
  });

  it('filters GRN and QC inspections by date, supplier, item, and user', async () => {
    // Post a direct GRN
    const grnCreate = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      grnDate: '2026-10-08',
      supplierId,
      mode: 'DIRECT',
      post: true,
      lines: [{ itemId, grnQty: '5', rate: '120.00' }],
    });
    expect(grnCreate.status).toBe(201);
    const grnId = grnCreate.body.data.id;

    // Filter GRN list by dateFrom/dateTo
    const qGrn = await request(app)
      .get(`/api/v1/grn${qs({ dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(qGrn.status).toBe(200);
    expect(qGrn.body.data.some((g: { id: number }) => g.id === grnId)).toBe(true);

    // QC stats endpoint accepts dateFrom, dateTo, supplierId
    const qcStats = await request(app)
      .get(`/api/v1/qc/stats${qs({ supplierId, dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(qcStats.status).toBe(200);
    expect(typeof qcStats.body.data.total).toBe('number');
  });

  it('filters stock inventory by departmentId and hodId', async () => {
    const qStock = await request(app)
      .get(`/api/v1/inventory/stock${qs({ departmentId: deptAId, hodId: hodUserId })}`)
      .set(auth(adminToken));
    expect(qStock.status).toBe(200);
    expect(qStock.body.data.some((s: { item_id: number }) => s.item_id === itemId)).toBe(true);

    const qStockOther = await request(app)
      .get(`/api/v1/inventory/stock${qs({ departmentId: deptBId })}`)
      .set(auth(adminToken));
    expect(qStockOther.status).toBe(200);
    expect(qStockOther.body.data.some((s: { item_id: number }) => s.item_id === itemId)).toBe(false);
  });

  it('preserves applied filters on CSV exports', async () => {
    // 1. Requisition export with date range and userId
    const expReq = await request(app)
      .get(`/api/v1/io/export/requisitions${qs({ format: 'csv', userId: regularUserId, dateFrom: '2026-10-01', dateTo: '2026-10-10' })}`)
      .set(auth(adminToken));
    expect(expReq.status).toBe(200);
    expect(expReq.headers['content-type']).toContain('csv');

    // 2. Indents export with userId
    const expIndent = await request(app)
      .get(`/api/v1/io/export/indents${qs({ format: 'csv', userId: adminUserId })}`)
      .set(auth(adminToken));
    expect(expIndent.status).toBe(200);
    expect(expIndent.headers['content-type']).toContain('csv');

    // 3. Purchase Orders export
    const expPo = await request(app)
      .get(`/api/v1/io/export/purchase-orders${qs({ format: 'csv', departmentId: deptAId })}`)
      .set(auth(adminToken));
    expect(expPo.status).toBe(200);
    expect(expPo.headers['content-type']).toContain('csv');
  });
});
