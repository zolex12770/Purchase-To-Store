/**
 * Integration tests — Admin Data Management & Requisition On-Behalf Capability.
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
let employeeId = 0;
let itemId = 0;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

async function signIn(empId: string, passwords: string[]): Promise<string> {
  for (const password of passwords) {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId: empId, password });
    if (res.status === 200) return res.body.data.accessToken as string;
  }
  throw new Error(`Could not sign in as ${empId}`);
}

async function signInAndRotate(empId: string, initial: string, next: string): Promise<string> {
  let token = await signIn(empId, [initial, next]);
  const me = await request(app).get('/api/v1/auth/me').set(auth(token));
  if (me.body?.data?.mustChangePassword) {
    await request(app).post('/api/v1/auth/change-password').set(auth(token))
      .send({ currentPassword: initial, newPassword: next });
    token = await signIn(empId, [next]);
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
  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');

  const rolesRes = await request(app).get('/api/v1/roles').set(auth(adminToken));
  const employeeRole = rolesRes.body.data.find((r: any) => r.code === 'EMPLOYEE');

  // Create an employee
  const uRes = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'EMP-9999',
    employeeName: 'Test Target Employee',
    designation: 'Staff',
    password: 'Password123!@',
    roleIds: [employeeRole.id],
  });
  expect(uRes.status).toBe(201);
  employeeId = uRes.body.data.id;

  // Create an item
  const lookups = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  const uomId = lookups.body.data.UOM[0].id;
  const iRes = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
    itemCode: 'TEST-ITEM-99',
    itemDescription: 'Test Item for Data Management',
    uomId,
    standardRate: '150.00',
    hsnCode: '8501',
  });
  expect(iRes.status).toBe(201);
  itemId = iRes.body.data.id;
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe('Admin Data Management & Audit API', () => {
  it('GET /api/v1/admin/data-management/summary returns entity totals', async () => {
    const res = await request(app).get('/api/v1/admin/data-management/summary').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.masters).toBeDefined();
    expect(res.body.data.masters.users.total).toBeGreaterThanOrEqual(2);
    expect(res.body.data.masters.items.total).toBeGreaterThanOrEqual(1);
    expect(res.body.data.transactions).toBeDefined();
  });

  it('GET /api/v1/admin/data-management/records returns paginated records with protected status', async () => {
    const res = await request(app).get('/api/v1/admin/data-management/records?entity=users&pageSize=10').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.items).toBeInstanceOf(Array);
    const adminRow = res.body.data.items.find((i: any) => i.code === '10221');
    expect(adminRow).toBeDefined();
    expect(adminRow.isProtected).toBe(true);
  });

  it('GET /api/v1/admin/data-management/inspect/users/:id audits dependencies and blocks super admin deletion', async () => {
    const res = await request(app).get('/api/v1/admin/data-management/inspect/users/1').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.canHardDelete).toBe(false);
    expect(res.body.data.blockingReasons.some((r: string) => r.includes('Super Admin'))).toBe(true);
  });

  it('POST /api/v1/admin/data-management/bulk-toggle-active refuses deactivating super admin', async () => {
    const res = await request(app).post('/api/v1/admin/data-management/bulk-toggle-active')
      .set(auth(adminToken))
      .send({ entity: 'users', ids: [1], isActive: false });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toContain('Super Admin accounts');
  });

  it('POST /api/v1/admin/data-management/hard-delete requires confirm string', async () => {
    const res = await request(app).post('/api/v1/admin/data-management/hard-delete')
      .set(auth(adminToken))
      .send({ entity: 'items', id: itemId, confirm: 'INVALID' });
    expect(res.status).toBe(422);
  });

  it('POST /api/v1/requisitions allows admin to create on behalf of employee and auto-resolves info', async () => {
    const res = await request(app).post('/api/v1/requisitions')
      .set(auth(adminToken))
      .send({
        requesterUserId: employeeId,
        requisitionDate: '2026-10-14',
        remarks: 'Test on behalf of employee',
        submit: false,
        lines: [{ itemId, requestedQty: '10', remarks: 'Test line' }],
      });
    expect(res.status).toBe(201);
    expect(res.body.data.id).toBeDefined();

    const detail = await request(app).get(`/api/v1/requisitions/${res.body.data.id}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.employee_name).toBe('Test Target Employee');
    expect(detail.body.data.employee_code).toBe('EMP-9999');

    // Test safe hard delete of this draft requisition
    const del = await request(app).post('/api/v1/admin/data-management/hard-delete')
      .set(auth(adminToken))
      .send({ entity: 'requisitions', id: res.body.data.id, confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect(del.body.data.deleted).toBe(true);
  });
});
