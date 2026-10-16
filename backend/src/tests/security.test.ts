/**
 * Integration tests — security hardening (2026-10-16, audit AUTH-03 .. AUTH-10).
 *
 *   1. A user who owes a password change reaches only the auth routes (403
 *      PASSWORD_CHANGE_REQUIRED everywhere else) until they change it, and the
 *      block lifts at once. Login, refresh and /auth/me report the real flag; a
 *      new account and an administrator's reset owe a change by default.
 *   2. The password policy refuses a published password, in any letter case,
 *      and one that contains the account's Employee ID.
 *   3. Data management needs system.admin (it accepted role.view).
 *   4. Only a Super Admin may reset, edit, re-role, unlock or deactivate a Super
 *      Admin account.
 *   5. By default only the proxy on this machine may name the client's address
 *      (TRUST_PROXY values other than the default: trust-proxy.test.ts).
 *   6. Viewer's default is four view rights, and a restart never re-grants a
 *      right an administrator removed from it.
 *   7. The last active Super Admin can be neither deactivated nor demoted.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';
// §5 is about the default, whatever the shell or a .env sets.
process.env.TRUST_PROXY = '';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let adminUserId = 0;
let roles: { id: number; code: string }[] = [];
let permissions: { id: number; code: string }[] = [];

/** The test databases' bootstrap password — itself a published one, which the policy must refuse. */
const BOOTSTRAP_PASSWORD = 'Admin@12345';
const PASSWORD = 'Secur@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const roleId = (code: string) => roles.find((r) => r.code === code)!.id;
const permId = (code: string) => permissions.find((p) => p.code === code)!.id;

interface SignedIn { accessToken: string; user: { id: number; mustChangePassword: boolean } }

async function signIn(employeeId: string, password = PASSWORD): Promise<SignedIn> {
  const res = await request(app).post(api('/auth/login')).send({ employeeId, password });
  expect(res.status).toBe(200);
  return res.body.data as SignedIn;
}

/** An account the administrator created; it owes no password change unless `extra` says so. */
async function createUser(employeeId: string, roleCodes: string[], extra: Record<string, unknown> = {}) {
  const res = await request(app).post(api('/users')).set(auth(adminToken)).send({
    employeeId, employeeName: `Security ${employeeId}`, designation: 'test',
    password: PASSWORD, mustChangePassword: false, roleIds: roleCodes.map(roleId), ...extra,
  });
  expect(res.status).toBe(201);
  return { ...res.body.data, id: Number(res.body.data.id) } as { id: number; employee_id: string; employee_name: string; must_change_password: boolean };
}

async function createRole(code: string, codes: string[]) {
  const res = await request(app).post(api('/roles')).set(auth(adminToken))
    .send({ code, name: `Security ${code}`, permissionIds: codes.map(permId) });
  expect(res.status).toBe(201);
  roles.push({ id: res.body.data.id, code });
}

const codesOf = async (roleCode: string) =>
  ((await request(app).get(api(`/roles/${roleId(roleCode)}`)).set(auth(adminToken))).body.data.permissions as { code: string }[])
    .map((p) => p.code).sort();

const userBody = (u: { employee_id: string; employee_name: string }, roleCodes: string[], isActive = true) => ({
  employeeId: u.employee_id, employeeName: u.employee_name, designation: 'test', isActive, roleIds: roleCodes.map(roleId),
});

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
  adminToken = (await signIn('10221', BOOTSTRAP_PASSWORD)).accessToken;
  adminUserId = Number((await query<{ id: string }>(`SELECT id FROM users WHERE employee_id = '10221'`))[0]!.id);
  roles = (await request(app).get(api('/roles')).set(auth(adminToken))).body.data;
  permissions = (await request(app).get(api('/roles/permissions')).set(auth(adminToken))).body.data
    .flatMap((g: { permissions: { id: number; code: string }[] }) => g.permissions);
});

afterAll(async () => { await closeDb?.(); });

/* ── 1. A password change that is owed is enforced ─────────────────────────── */

describe('an account that owes a password change', () => {
  const expectBlocked = (res: request.Response) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');
  };

  it('reaches only the auth routes until it changes the password, and is let in at once afterwards', async () => {
    // A new account owes a change by default: the administrator knows the password.
    const created = await request(app).post(api('/users')).set(auth(adminToken)).send({
      employeeId: 'T-SEC-NEW', employeeName: 'Security new user', password: PASSWORD, roleIds: [roleId('STORE_USER')],
    });
    expect(created.status).toBe(201);
    expect(created.body.data.must_change_password).toBe(true);

    const agent = request.agent(app);
    const login = await agent.post(api('/auth/login')).send({ employeeId: 'T-SEC-NEW', password: PASSWORD });
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
    const token = login.body.data.accessToken as string;

    const me = await agent.get(api('/auth/me')).set(auth(token));
    expect(me.status).toBe(200);
    expect(me.body.data.mustChangePassword).toBe(true);

    // Screens its role opens, a write, and an unknown address: all refused.
    expectBlocked(await agent.get(api('/items?pageSize=1')).set(auth(token)));
    expectBlocked(await agent.get(api('/grn/po-items?limit=1')).set(auth(token)));
    expectBlocked(await agent.post(api('/requisitions')).set(auth(token)).send({ lines: [] }));
    expectBlocked(await agent.get(api('/no-such-endpoint')).set(auth(token)));

    // Renewing the session keeps the obligation.
    const refreshed = await agent.post(api('/auth/refresh'));
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.data.user.mustChangePassword).toBe(true);
    const renewed = refreshed.body.data.accessToken as string;
    expectBlocked(await agent.get(api('/items?pageSize=1')).set(auth(renewed)));

    const changed = await agent.post(api('/auth/change-password')).set(auth(renewed))
      .send({ currentPassword: PASSWORD, newPassword: 'Secur@Own2026' });
    expect(changed.status).toBe(200);

    // The cached account state still said "must change"; the change clears it,
    // so the next session is not refused for up to the cache window.
    const fresh = await signIn('T-SEC-NEW', 'Secur@Own2026');
    expect(fresh.user.mustChangePassword).toBe(false);
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(fresh.accessToken))).status).toBe(200);
    expect((await request(app).get(api('/auth/me')).set(auth(fresh.accessToken))).body.data.mustChangePassword).toBe(false);
  });

  it('an administrator reset owes a change unless the administrator opts out; signing out stays possible', async () => {
    const user = await createUser('T-SEC-RESET', ['STORE_USER']);
    const before = await signIn('T-SEC-RESET');
    expect(before.user.mustChangePassword).toBe(false);
    expect((await request(app).get(api('/auth/me')).set(auth(before.accessToken))).body.data.mustChangePassword).toBe(false);

    const reset = await request(app).post(api(`/users/${user.id}/reset-password`)).set(auth(adminToken))
      .send({ newPassword: 'Secur@Reset2026' });
    expect(reset.status).toBe(200);
    const flag = await query<{ must_change_password: boolean }>('SELECT must_change_password FROM users WHERE id = $1', [user.id]);
    expect(flag[0]!.must_change_password).toBe(true);

    const agent = request.agent(app);
    const login = await agent.post(api('/auth/login')).send({ employeeId: 'T-SEC-RESET', password: 'Secur@Reset2026' });
    expect(login.body.data.user.mustChangePassword).toBe(true);
    const token = login.body.data.accessToken as string;
    expectBlocked(await agent.get(api('/items?pageSize=1')).set(auth(token)));
    expect((await agent.post(api('/auth/logout')).set(auth(token))).status).toBe(200);

    const optOut = await request(app).post(api(`/users/${user.id}/reset-password`)).set(auth(adminToken))
      .send({ newPassword: 'Secur@Again2026', mustChangePassword: false });
    expect(optOut.status).toBe(200);
    const again = await signIn('T-SEC-RESET', 'Secur@Again2026');
    expect(again.user.mustChangePassword).toBe(false);
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(again.accessToken))).status).toBe(200);
  });

  it('is judged by the account as it is now, not by the flag inside an older token', async () => {
    const { invalidateAuthState } = await import('../auth/middleware.js');
    const user = await createUser('T-SEC-LIVE', ['STORE_USER']);
    const { accessToken } = await signIn('T-SEC-LIVE');
    expect((await request(app).get(api('/items?pageSize=1')).set(auth(accessToken))).status).toBe(200);

    // The flag is set after this token was issued (and says false inside it).
    await query('UPDATE users SET must_change_password = TRUE WHERE id = $1', [user.id]);
    invalidateAuthState(user.id);
    expectBlocked(await request(app).get(api('/items?pageSize=1')).set(auth(accessToken)));
    expect((await request(app).get(api('/auth/me')).set(auth(accessToken))).body.data.mustChangePassword).toBe(true);
  });
});

/* ── 2. Password policy ────────────────────────────────────────────────────── */

describe('the password policy', () => {
  // The published password, and the same letters with every case flipped, which
  // passes every character rule and is refused only because it is published.
  const published = [BOOTSTRAP_PASSWORD, [...BOOTSTRAP_PASSWORD].map((c) => (c === c.toUpperCase() ? c.toLowerCase() : c.toUpperCase())).join('')];
  const refusedFor = (res: request.Response, field: string, reason: RegExp) => {
    expect(res.status).toBe(422);
    const issue = (res.body.error.issues as { field: string; message: string }[]).find((i) => i.field === field);
    expect(issue?.message).toMatch(reason);
  };

  it('refuses a published password wherever a password is set', async () => {
    const user = await createUser('T-SEC-PW', ['EMPLOYEE']);
    const token = (await signIn('T-SEC-PW')).accessToken;
    for (const candidate of published) {
      refusedFor(await request(app).post(api('/users')).set(auth(adminToken)).send({
        employeeId: 'T-SEC-DENY', employeeName: 'Security deny-list', password: candidate, roleIds: [roleId('EMPLOYEE')],
      }), 'password', /published/);
      refusedFor(await request(app).post(api(`/users/${user.id}/reset-password`)).set(auth(adminToken))
        .send({ newPassword: candidate }), 'newPassword', /published/);
      refusedFor(await request(app).post(api('/auth/change-password')).set(auth(token))
        .send({ currentPassword: PASSWORD, newPassword: candidate }), 'newPassword', /published/);
    }
    // Nothing was changed, and an unpublished password is accepted.
    expect((await query('SELECT id FROM users WHERE employee_id = $1', ['T-SEC-DENY'])).length).toBe(0);
    await signIn('T-SEC-PW');
    await createUser('T-SEC-DENY', ['EMPLOYEE']);
  });

  it('refuses a password that contains the Employee ID', async () => {
    refusedFor(await request(app).post(api('/users')).set(auth(adminToken)).send({
      employeeId: 'TSEC7731', employeeName: 'Security employee ID', password: 'Key#tsec7731', roleIds: [roleId('EMPLOYEE')],
    }), 'password', /Employee ID/);

    const user = await createUser('T-SEC-ID', ['EMPLOYEE']);
    refusedFor(await request(app).post(api(`/users/${user.id}/reset-password`)).set(auth(adminToken))
      .send({ newPassword: 'Rst@T-SEC-ID9' }), 'newPassword', /Employee ID/);
    const token = (await signIn('T-SEC-ID')).accessToken;
    refusedFor(await request(app).post(api('/auth/change-password')).set(auth(token))
      .send({ currentPassword: PASSWORD, newPassword: 'Abc!t-sec-id9' }), 'newPassword', /Employee ID/);
  });
});

/* ── 3. Data management ────────────────────────────────────────────────────── */

describe('data management needs the system administration right', () => {
  it('role.view, which it used to accept, is refused; system.admin is enough', async () => {
    await createRole('T_SEC_ROLEVIEW', ['role.view', 'user.view']);
    await createRole('T_SEC_SYSADMIN', ['system.admin']);
    await createUser('T-SEC-RV', ['T_SEC_ROLEVIEW']);
    await createUser('T-SEC-SYS', ['T_SEC_SYSADMIN']);
    const viewer = (await signIn('T-SEC-RV')).accessToken;
    const sysAdmin = (await signIn('T-SEC-SYS')).accessToken;

    for (const base of ['/admin/data-management', '/data-management']) {
      expect((await request(app).get(api(`${base}/summary`)).set(auth(viewer))).status).toBe(403);
      expect((await request(app).get(api(`${base}/summary`)).set(auth(sysAdmin))).status).toBe(200);
    }
    const target = await createUser('T-SEC-DM', ['EMPLOYEE']);
    const toggle = (token: string) => request(app).post(api('/admin/data-management/bulk-toggle-active')).set(auth(token))
      .send({ entity: 'users', ids: [target.id], isActive: false });
    expect((await toggle(viewer)).status).toBe(403);
    expect((await toggle(sysAdmin)).status).toBe(200);
  });
});

/* ── 4. Super Admin accounts are changed only by a Super Admin ─────────────── */

describe('a Super Admin account', () => {
  let superAdmin: { id: number; employee_id: string; employee_name: string };
  let userAdmin = '';

  beforeAll(async () => {
    await createRole('T_SEC_USERS', ['user.view', 'user.create', 'user.edit', 'user.delete', 'role.view']);
    await createUser('T-SEC-UADMIN', ['T_SEC_USERS']);
    userAdmin = (await signIn('T-SEC-UADMIN')).accessToken;
    superAdmin = await createUser('T-SEC-SA2', ['SUPER_ADMIN']);
  });

  it('cannot be reset, edited, re-roled, unlocked or deactivated by a user administrator who is not one', async () => {
    const id = superAdmin.id;
    const refused = async (res: request.Response) => {
      expect(res.status).toBe(403);
      expect(res.body.error.message).toMatch(/Super Admin/);
    };
    await refused(await request(app).post(api(`/users/${id}/reset-password`)).set(auth(userAdmin)).send({ newPassword: 'Takeover@2026' }));
    await refused(await request(app).put(api(`/users/${id}`)).set(auth(userAdmin)).send(userBody(superAdmin, ['EMPLOYEE'])));
    await refused(await request(app).put(api(`/users/${id}`)).set(auth(userAdmin)).send({ ...userBody(superAdmin, ['SUPER_ADMIN']), employeeName: 'Renamed' }));
    await refused(await request(app).post(api(`/users/${id}/unlock`)).set(auth(userAdmin)).send({}));
    await refused(await request(app).delete(api(`/users/${id}`)).set(auth(userAdmin)));

    // The account is untouched: same password, still active, still a Super Admin.
    const still = await signIn('T-SEC-SA2');
    expect((await request(app).get(api('/auth/me')).set(auth(still.accessToken))).body.data.roles).toContain('SUPER_ADMIN');

    // The same administrator still manages ordinary accounts, and still cannot mint a Super Admin.
    const plain = await createUser('T-SEC-PLAIN', ['EMPLOYEE']);
    expect((await request(app).post(api(`/users/${plain.id}/reset-password`)).set(auth(userAdmin)).send({ newPassword: 'Plain@Reset2026' })).status).toBe(200);
    expect((await request(app).put(api(`/users/${plain.id}`)).set(auth(userAdmin)).send(userBody(plain, ['SUPER_ADMIN']))).status).toBe(422);
    expect((await request(app).delete(api(`/users/${plain.id}`)).set(auth(userAdmin))).status).toBe(200);
  });

  it('is likewise protected in data management from a system administrator who is not a Super Admin', async () => {
    const sysAdmin = (await signIn('T-SEC-SYS')).accessToken;
    const dm = (path: string, body: Record<string, unknown>) =>
      request(app).post(api(`/admin/data-management/${path}`)).set(auth(sysAdmin)).send(body);
    expect((await dm('bulk-toggle-active', { entity: 'users', ids: [superAdmin.id], isActive: false })).status).toBe(403);
    expect((await dm('bulk-soft-delete', { entity: 'users', ids: [superAdmin.id] })).status).toBe(403);
    expect((await dm('hard-delete', { entity: 'users', id: superAdmin.id, confirm: 'DELETE' })).status).toBe(403);
    const row = (await query<{ is_active: boolean; deleted_at: string | null }>('SELECT is_active, deleted_at FROM users WHERE id = $1', [superAdmin.id]))[0]!;
    expect(row).toEqual({ is_active: true, deleted_at: null });
  });

  it('can be changed by another Super Admin', async () => {
    const reset = await request(app).post(api(`/users/${superAdmin.id}/reset-password`)).set(auth(adminToken))
      .send({ newPassword: 'Super@Reset2026', mustChangePassword: false });
    expect(reset.status).toBe(200);
    await signIn('T-SEC-SA2', 'Super@Reset2026');
  });
});

/* ── 5. The client's address ───────────────────────────────────────────────── */

describe('the client address', () => {
  it('may be named only by the proxy on this machine', async () => {
    const { env } = await import('../config/env.js');
    expect(env.TRUST_PROXY).toBe('loopback');
    expect(app.get('trust proxy')).toBe('loopback');

    // req.ip exactly as Express resolves it for a connection from `remoteAddress`.
    const ipOf = (remoteAddress: string, forwardedFor: string) => {
      const req = Object.create(app.request) as { app: Express; headers: Record<string, string>; connection: unknown; socket: unknown; ip: string };
      req.app = app;
      req.headers = { 'x-forwarded-for': forwardedFor };
      req.connection = { remoteAddress };
      req.socket = req.connection;
      return req.ip;
    };
    // Through the vite proxy on 8080: the address it forwards.
    for (const proxy of ['127.0.0.1', '::ffff:127.0.0.1', '::1']) expect(ipOf(proxy, '172.16.18.40')).toBe('172.16.18.40');
    // The proxy appends the real address, so a forged entry in front of it is ignored.
    expect(ipOf('127.0.0.1', '203.0.113.9, 172.16.18.40')).toBe('172.16.18.40');
    // A LAN client calling the API port directly cannot choose its address.
    expect(ipOf('172.16.18.40', '203.0.113.9')).toBe('172.16.18.40');
  });

  it('is what the audit trail records for a sign-in through the proxy', async () => {
    const res = await request(app).post(api('/auth/login')).set('X-Forwarded-For', '198.51.100.23')
      .send({ employeeId: 'T-SEC-NOBODY', password: 'Not@Valid2026' });
    expect(res.status).toBe(401);
    const row = (await query<{ ip_address: string }>(
      "SELECT ip_address FROM audit_logs WHERE action = 'LOGIN_FAILED' AND entity_label = 'T-SEC-NOBODY' ORDER BY id DESC LIMIT 1",
    ))[0]!;
    expect(row.ip_address).toBe('198.51.100.23');
  });
});

/* ── 6. Viewer: least privilege, and a restart keeps an administrator's change ─ */

describe('the Viewer role', () => {
  const FOUR = ['dashboard.view', 'item.view', 'lookup.view', 'requisition.view'];

  it('holds only the dashboard, item, lookup and requisition view rights on a new database', async () => {
    const { ROLES } = await import('../auth/permissions.js');
    expect([...(ROLES.find((r) => r.code === 'VIEWER')!.permissions as string[])].sort()).toEqual(FOUR);
    expect(await codesOf('VIEWER')).toEqual(FOUR);

    await createUser('T-SEC-VIEW', ['VIEWER']);
    const token = (await signIn('T-SEC-VIEW')).accessToken;
    for (const path of ['/suppliers?pageSize=1', '/indents?pageSize=1', '/purchase-orders?pageSize=1', '/grn?pageSize=1']) {
      expect((await request(app).get(api(path)).set(auth(token))).status).toBe(403);
    }
    for (const path of ['/items?pageSize=1', '/lookups/options', '/requisitions?pageSize=1']) {
      expect((await request(app).get(api(path)).set(auth(token))).status).toBe(200);
    }
  });

  it('is never re-granted a right an administrator removed, at the next restart', async () => {
    const { seedSystem } = await import('../db/seed.js');
    const viewer = roleId('VIEWER');
    const detail = (await request(app).get(api(`/roles/${viewer}`)).set(auth(adminToken))).body.data;
    const setViewer = async (codes: string[]) => {
      const res = await request(app).put(api(`/roles/${viewer}`)).set(auth(adminToken)).send({
        code: 'VIEWER', name: detail.name, description: detail.description ?? '', permissionIds: codes.map(permId),
      });
      expect(res.status).toBe(200);
    };

    // An existing database keeps whatever its Viewer holds — here the old,
    // broader default the live database still has — across a restart ...
    const old = ['dashboard.view', 'item.view', 'supplier.view', 'lookup.view', 'indent.view', 'po.view', 'grn.view', 'requisition.view'];
    await setViewer(old);
    await seedSystem();
    expect(await codesOf('VIEWER')).toEqual([...old].sort());

    // ... until an administrator trims it on the Roles screen; it stays trimmed,
    await setViewer(FOUR);
    await seedSystem();
    expect(await codesOf('VIEWER')).toEqual(FOUR);

    // even of a right the catalogue default still lists.
    await setViewer(FOUR.filter((c) => c !== 'item.view'));
    await seedSystem();
    expect(await codesOf('VIEWER')).toEqual(FOUR.filter((c) => c !== 'item.view'));
  });
});

/* ── 7. The last active Super Admin (runs last: it deactivates the others) ──── */

describe('the last active Super Admin', () => {
  it('can be neither deactivated nor demoted', async () => {
    const { assertActiveSuperAdminRemains } = await import('../modules/admin/super-admin-guard.js');
    const supers = await query<{ id: string; employee_id: string; employee_name: string }>(
      `SELECT u.id, u.employee_id, u.employee_name FROM users u
         JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id
        WHERE r.code = 'SUPER_ADMIN' AND u.is_active AND u.deleted_at IS NULL AND u.id <> $1`,
      [adminUserId],
    );
    expect(supers.length).toBeGreaterThanOrEqual(2); // 10422 and T-SEC-SA2

    // While another one remains, a Super Admin may deactivate a Super Admin.
    for (const other of supers) {
      expect((await request(app).delete(api(`/users/${other.id}`)).set(auth(adminToken))).status).toBe(200);
    }
    const me = { employee_id: '10221', employee_name: 'System Administrator' };
    await expect(assertActiveSuperAdminRemains(undefined, [adminUserId])).rejects.toThrow(/last active Super Admin/);

    // Now 10221 is the only one: every way of deactivating, deleting or demoting it is refused.
    const attempts = [
      request(app).put(api(`/users/${adminUserId}`)).set(auth(adminToken)).send(userBody(me, ['EMPLOYEE'])),
      request(app).put(api(`/users/${adminUserId}`)).set(auth(adminToken)).send(userBody(me, ['SUPER_ADMIN'], false)),
      request(app).delete(api(`/users/${adminUserId}`)).set(auth(adminToken)),
      request(app).post(api('/admin/data-management/bulk-toggle-active')).set(auth(adminToken)).send({ entity: 'users', ids: [adminUserId], isActive: false }),
      request(app).post(api('/admin/data-management/bulk-soft-delete')).set(auth(adminToken)).send({ entity: 'users', ids: [adminUserId] }),
      request(app).post(api('/admin/data-management/hard-delete')).set(auth(adminToken)).send({ entity: 'users', id: adminUserId, confirm: 'DELETE' }),
    ];
    for (const attempt of attempts) expect((await attempt).status).toBe(422);
    const row = (await query<{ is_active: boolean; deleted_at: string | null }>('SELECT is_active, deleted_at FROM users WHERE id = $1', [adminUserId]))[0]!;
    expect(row).toEqual({ is_active: true, deleted_at: null });
    expect((await request(app).get(api('/auth/me')).set(auth(adminToken))).body.data.roles).toContain('SUPER_ADMIN');

    // Once a second Super Admin is active again, the rule no longer stands in the way.
    const reactivated = await request(app).post(api('/admin/data-management/bulk-toggle-active')).set(auth(adminToken))
      .send({ entity: 'users', ids: supers.map((s) => Number(s.id)), isActive: true });
    expect(reactivated.status).toBe(200);
    await expect(assertActiveSuperAdminRemains(undefined, [adminUserId])).resolves.toBeUndefined();
  });
});
