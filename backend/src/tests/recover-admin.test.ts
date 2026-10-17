/**
 * Break-glass account recovery (backend/src/db/cli-recover-admin.ts), 2026-10-17: the two
 * Super Admins could not sign in after their exposed default password was rotated, and the
 * only way back was another Super Admin. The command-line recovery sets a temporary password
 * that must be changed, ends the account's sessions, clears its lockout and is audited.
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
const api = (p: string) => `/api/v1${p}`;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const TEMP = 'Brk-Glass#2026Qz';

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
});

afterAll(async () => { await closeDb?.(); });

describe('break-glass recovery of an administrator account', () => {
  it('sets a temporary password that must be changed, ends old sessions, clears the lockout, and is audited', async () => {
    const before = await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' });
    expect(before.status).toBe(200);
    const oldToken = before.body.data.accessToken as string;
    // A token issued within the skew margin of a password change is honoured (iat has 1 s
    // resolution), as in the administrator-reset test in hardening.test.ts.
    await new Promise((r) => setTimeout(r, 3200));
    await query(`UPDATE users SET failed_login_count = 5, locked_until = now() + interval '15 minutes' WHERE employee_id = '10221'`);

    const { recoverAdminAccount } = await import('../db/cli-recover-admin.js');
    const r = await recoverAdminAccount('10221', TEMP, 'Break-glass CLI (tester@test-host)');
    expect(r.employeeId).toBe('10221');

    expect((await request(app).get(api('/auth/me')).set(auth(oldToken))).status).toBe(401);
    const login = await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: TEMP });
    expect(login.status).toBe(200);
    expect(login.body.data.user.mustChangePassword).toBe(true);
    const blocked = await request(app).get(api('/indents')).set(auth(login.body.data.accessToken));
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('PASSWORD_CHANGE_REQUIRED');

    const trail = (await query<{ action: string; entity_label: string; actor_name: string }>(
      `SELECT action, entity_label, actor_name FROM audit_logs WHERE entity = 'user' ORDER BY id DESC LIMIT 1`,
    ))[0]!;
    expect(trail).toMatchObject({ action: 'PASSWORD_RESET', entity_label: '10221', actor_name: 'Break-glass CLI (tester@test-host)' });
  });

  it('refuses a weak or published password, an unknown or deactivated account, and changes nothing', async () => {
    const { recoverAdminAccount } = await import('../db/cli-recover-admin.js');
    const hashBefore = (await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE employee_id = '10221'`))[0]!.password_hash;
    await expect(recoverAdminAccount('10221', 'short', 'x')).rejects.toThrow(/stronger/);
    await expect(recoverAdminAccount('10221', 'Admin@12345', 'x')).rejects.toThrow(/stronger/);
    await expect(recoverAdminAccount('NO-SUCH-ID', TEMP, 'x')).rejects.toThrow(/No account/);
    await query(`INSERT INTO users (employee_id, employee_name, password_hash, is_active) VALUES ('T-OFF', 'Inactive', '!', FALSE)`);
    await expect(recoverAdminAccount('T-OFF', TEMP, 'x')).rejects.toThrow(/deactivated/);
    const hashAfter = (await query<{ password_hash: string }>(`SELECT password_hash FROM users WHERE employee_id = '10221'`))[0]!.password_hash;
    expect(hashAfter).toBe(hashBefore);
  });
});
