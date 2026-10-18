/**
 * Integration tests — platform follow-ups of the 2026-10-17 browser E2E (run 10171445).
 *
 *   1. C36: an export or import the caller has no right to answers 403
 *      AUTHORIZATION_ERROR, like every other missing permission (it answered 422
 *      VALIDATION_ERROR, so the client showed a validation error).
 *   2. C01: the planner statistics are kept current while the server runs, which PGlite
 *      never does on its own: a date-filtered KPI on the copy of production ran for 211 s
 *      because the PO and GRN tables had never been analysed.
 *        · the rule: autovacuum's (50 rows + 10% changed since the last ANALYZE), and a
 *          table that holds rows but has no statistics at all;
 *        · one table per statement, with requests served between tables;
 *        · the 10-minute check analyses the tables due, the check that took an automatic
 *          backup every table, and a business-sheet sync that wrote rows the tables it
 *          changed.
 *   3. C40: migration 034 gives the HOD role item.view and lookup.view, so an account
 *      holding only HOD can find and choose the items of the requisition it raises.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
process.env.GOOGLE_API_KEY = '';
process.env.GOOGLE_SHEET_ID = 'TEST_INBOUND_SHEET_NOT_REAL';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let viewerToken = '';
let roles: { id: number; code: string }[] = [];
let permissions: { id: number; code: string }[] = [];

const PASSWORD = 'Platf@Test2026';
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;

async function signIn(employeeId: string, passwords: string[]): Promise<string> {
  for (const password of passwords) {
    const res = await request(app).post(api('/auth/login')).send({ employeeId, password });
    if (res.status === 200) return res.body.data.accessToken as string;
  }
  throw new Error(`Could not sign in as ${employeeId}`);
}

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

  let token = await signIn('10221', ['Admin@12345', PASSWORD]);
  const me = await request(app).get(api('/auth/me')).set(auth(token));
  if (me.body?.data?.mustChangePassword) {
    await request(app).post(api('/auth/change-password')).set(auth(token)).send({ currentPassword: 'Admin@12345', newPassword: PASSWORD });
    token = await signIn('10221', [PASSWORD]);
  }
  adminToken = token;
  roles = (await request(app).get(api('/roles')).set(auth(adminToken))).body.data;
  permissions = (await request(app).get(api('/roles/permissions')).set(auth(adminToken))).body.data
    .flatMap((g: { permissions: { id: number; code: string }[] }) => g.permissions);

  // Sees the audit log and the Item Master, may export or import neither.
  const permId = (code: string) => permissions.find((p) => p.code === code)!.id;
  const role = await request(app).post(api('/roles')).set(auth(adminToken))
    .send({ code: 'T_PLATFORM_VIEW', name: 'Platform view only', permissionIds: ['audit.view', 'item.view'].map(permId) });
  expect(role.status).toBe(201);
  roles.push({ id: role.body.data.id, code: 'T_PLATFORM_VIEW' });
  const user = await request(app).post(api('/users')).set(auth(adminToken)).send({
    employeeId: 'T-PLAT-VIEW', employeeName: 'Platform viewer', designation: 'test',
    password: PASSWORD, mustChangePassword: false, roleIds: [role.body.data.id],
  });
  expect(user.status).toBe(201);
  viewerToken = await signIn('T-PLAT-VIEW', [PASSWORD]);
});

afterAll(async () => {
  await closeDb?.();
});

/* ── 1. C36: a missing export or import right is a 403 ──────────────────────── */

describe('export and import refusals (C36)', () => {
  const itemsCsv = () => Buffer.from(['Item Code,Item Description', 'T4-IMP-1,Platform import item'].join('\r\n'), 'utf8');
  const expectRefused = (res: request.Response, message: RegExp) => {
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('AUTHORIZATION_ERROR');
    expect(res.body.error.message).toMatch(message);
  };

  it('an export without its right answers 403 naming the right (it answered 422 VALIDATION_ERROR, S1-D9)', async () => {
    for (const format of ['csv', 'xlsx']) {
      expectRefused(
        await request(app).get(api(`/io/export/audit?format=${format}`)).set(auth(viewerToken)),
        /^You do not have permission to export Audit Log \(audit\.export\)\.$/,
      );
    }
    expectRefused(await request(app).get(api('/io/export/items?format=csv')).set(auth(viewerToken)), /\(item\.export\)/);
    // A dataset that does not exist is still the caller's mistake, whoever asks.
    const unknown = await request(app).get(api('/io/export/no-such-dataset?format=csv')).set(auth(viewerToken));
    expect(unknown.status).toBe(422);
    expect(unknown.body.error.code).toBe('VALIDATION_ERROR');
    // The administrator's export is unchanged.
    expect((await request(app).get(api('/io/export/audit?format=csv')).set(auth(adminToken))).status).toBe(200);
  });

  it('an import preview, its rows, its error report and its commit without the right answer 403', async () => {
    expectRefused(
      await request(app).post(api('/io/import/items/preview')).set(auth(viewerToken)).attach('file', itemsCsv(), 'items.csv'),
      /^You do not have permission to import Item Master \(item\.import\)\.$/,
    );
    const job = await request(app).post(api('/io/import/items/preview')).set(auth(adminToken)).attach('file', itemsCsv(), 'items.csv');
    expect(job.status).toBe(201);
    const jobId = job.body.data.jobId as number;
    expectRefused(await request(app).get(api(`/io/import/${jobId}/rows`)).set(auth(viewerToken)), /permission to view this import/);
    expectRefused(await request(app).get(api(`/io/import/${jobId}/errors.csv`)).set(auth(viewerToken)), /permission to view this import/);
    expectRefused(
      await request(app).post(api(`/io/import/${jobId}/commit`)).set(auth(viewerToken)).send({ mode: 'STRICT' }),
      /permission to import Item Master \(item\.import\)/,
    );
    // Nothing was imported by the refused commit; the administrator's still works.
    expect(await query(`SELECT id FROM items WHERE item_code = 'T4-IMP-1'`)).toEqual([]);
    expect((await request(app).get(api(`/io/import/${jobId}/rows`)).set(auth(adminToken))).status).toBe(200);
  });
});

/* ── C41: the filter bar names a record that arrives in the address by id ───── */

describe('the item and supplier searches name records by id (C41)', () => {
  it('returns exactly the records asked for, inactive ones too, under the same right', async () => {
    const [active] = await query<{ id: string }>(`INSERT INTO items (item_code, item_description, is_active) VALUES ('T4-ID-A', 'Platform item active', TRUE) RETURNING id`);
    const [inactive] = await query<{ id: string }>(`INSERT INTO items (item_code, item_description, is_active) VALUES ('T4-ID-B', 'Platform item inactive', FALSE) RETURNING id`);
    const [sup] = await query<{ id: string }>(`INSERT INTO suppliers (supplier_code, supplier_name, is_active) VALUES ('T4-SUP-ID', 'Platform supplier by id', FALSE) RETURNING id`);

    const items = await request(app).get(api(`/items/search?ids=${active!.id},${inactive!.id}&limit=2`)).set(auth(adminToken));
    expect(items.status).toBe(200);
    expect(items.body.data.map((r: { item_code: string }) => r.item_code)).toEqual(['T4-ID-A', 'T4-ID-B']);
    // The typeahead itself still offers active items only.
    const typed = await request(app).get(api('/items/search?q=T4-ID')).set(auth(adminToken));
    expect(typed.body.data.map((r: { item_code: string }) => r.item_code)).toEqual(['T4-ID-A']);

    const suppliers = await request(app).get(api(`/suppliers/search?ids=${sup!.id}&limit=1`)).set(auth(adminToken));
    expect(suppliers.status).toBe(200);
    expect(suppliers.body.data).toEqual([expect.objectContaining({ id: expect.anything(), supplier_name: 'Platform supplier by id' })]);

    // Nothing that is not an id reaches the query; the right is the search's own.
    const junk = await request(app).get(api('/items/search?ids=abc&limit=5')).set(auth(adminToken));
    expect(junk.status).toBe(200);
    expect((await request(app).get(api(`/suppliers/search?ids=${sup!.id}`)).set(auth(viewerToken))).status).toBe(403);
  });
});

/* ── 3. C40: the HOD role may search the items a requisition needs ──────────── */

describe('the HOD role and the item search (C40, migration 034)', () => {
  const MIGRATION = '034_hod_role_item_and_lookup_view';
  /** Every grant, as role:permission, of the roles other than `except`. */
  const grants = async (except = '') => (await query<{ held: string }>(
    `SELECT r.code || ':' || p.code AS held FROM role_permissions rp
       JOIN roles r ON r.id = rp.role_id JOIN permissions p ON p.id = rp.permission_id
      WHERE r.code <> $1 ORDER BY 1`,
    [except],
  )).map((g) => g.held);
  /** A release with 034 starting on this database: its migrations run before it answers anyone. */
  const deploy034 = async () => {
    const { runMigrations } = await import('../db/migrate.js');
    const { invalidateAuthState } = await import('../auth/middleware.js');
    await query('DELETE FROM schema_migrations WHERE version = $1', [MIGRATION]);
    expect((await runMigrations({ silent: true })).applied).toEqual([MIGRATION]);
    invalidateAuthState();
  };

  it('a HOD role holding requisition rights only is given item.view and lookup.view, and its holder can find and choose an item', async () => {
    // The role as scripts/reconcile_all_department_hods_and_roles.ts created it on production.
    const [hod] = await query<{ id: number }>(
      `INSERT INTO roles (code, name, description, is_system, is_active)
       VALUES ('HOD', 'HOD', 'Department Head: approves and decides material requisitions.', TRUE, TRUE) RETURNING id`,
    );
    await query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, id FROM permissions
        WHERE code IN ('requisition.view', 'requisition.create', 'requisition.edit', 'requisition.approve', 'requisition.print')`,
      [hod!.id],
    );
    const user = await request(app).post(api('/users')).set(auth(adminToken)).send({
      employeeId: 'T-PLAT-HOD', employeeName: 'Platform HOD only', designation: 'HOD',
      password: PASSWORD, mustChangePassword: false, roleIds: [hod!.id],
    });
    expect(user.status).toBe(201);
    const hodToken = await signIn('T-PLAT-HOD', [PASSWORD]);
    const [item] = await query<{ id: string }>(
      `INSERT INTO items (item_code, item_description, is_active) VALUES ('T4-HOD-1', 'Platform HOD item', TRUE) RETURNING id`,
    );
    const search = () => request(app).get(api('/items/search?q=T4-HOD')).set(auth(hodToken));
    // S1-D10: the picker of Create Requisition was refused.
    expect((await search()).status).toBe(403);
    const others = await grants('HOD');

    await deploy034();

    expect(await grants('HOD')).toEqual(others);
    expect((await grants()).filter((g) => g.startsWith('HOD:'))).toEqual([
      'HOD:item.view', 'HOD:lookup.view',
      'HOD:requisition.approve', 'HOD:requisition.create', 'HOD:requisition.edit', 'HOD:requisition.print', 'HOD:requisition.view',
    ]);
    const found = await search();
    expect(found.status).toBe(200);
    expect(found.body.data.map((r: { item_code: string }) => r.item_code)).toEqual(['T4-HOD-1']);
    // Choosing it fills the line from its profile; the form's masters answer too.
    expect((await request(app).get(api(`/items/${item!.id}/profile`)).set(auth(hodToken))).status).toBe(200);
    expect((await request(app).get(api('/lookups/DEPARTMENT')).set(auth(hodToken))).status).toBe(200);
    // Nothing else came with it.
    expect((await request(app).get(api('/suppliers/search?q=T4')).set(auth(hodToken))).status).toBe(403);
  });

  it('a database without a HOD role is left as it was', async () => {
    await query(`DELETE FROM user_roles WHERE role_id = (SELECT id FROM roles WHERE code = 'HOD')`);
    await query(`DELETE FROM roles WHERE code = 'HOD'`);
    const before = await grants();
    await deploy034();
    expect(await query(`SELECT id FROM roles WHERE code = 'HOD'`)).toEqual([]);
    expect(await grants()).toEqual(before);
  });
});

/* ── 2. C01: planner statistics kept current ────────────────────────────────── */

describe('planner statistics while the server runs (C01)', () => {
  const flushed = async (table: string) => {
    await query('SELECT pg_stat_force_next_flush()');
    const [r] = await query<{ changed: number; analysed: boolean; reltuples: number }>(
      `SELECT COALESCE(s.n_mod_since_analyze, 0)::int AS changed, c.reltuples::float8 AS reltuples,
              EXISTS (SELECT 1 FROM pg_statistic st WHERE st.starelid = c.oid) AS analysed
         FROM pg_class c LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
        WHERE c.oid = $1::regclass`,
      [table],
    );
    return r!;
  };
  const fill = (table: string, from: number, to: number) =>
    query(`INSERT INTO ${table} (id, v) SELECT g, md5(g::text) FROM generate_series(${from}, ${to}) g`);

  it('names the tables autovacuum would analyse: over 50 + 10% changed, or rows with no statistics', async () => {
    const { tablesDueForAnalyse } = await import('../db/statistics.js');
    const t = (table: string, rowsAtLastAnalyse: number, changedSinceAnalyse: number, hasStatistics: boolean, hasPages = true) =>
      ({ table, rowsAtLastAnalyse, changedSinceAnalyse, hasStatistics, hasPages });
    expect(tablesDueForAnalyse([
      t('changed_over', 1000, 151, true),
      t('changed_at_threshold', 1000, 150, true),
      t('small_table', 0, 51, true),
      t('small_unchanged', 0, 50, true),
      // The PO tables of production on 2026-10-17: rows, never analysed (reltuples -1).
      t('never_analysed', -1, 0, false),
      t('empty_never_analysed', -1, 0, false, false),
    ])).toEqual(['changed_over', 'small_table', 'never_analysed']);
  });

  it('analyses the tables changed beyond the rule and the ones never analysed, then nothing until they change again', async () => {
    const { analyseStaleTables } = await import('../db/statistics.js');
    for (const name of ['t4_stats_grown', 't4_stats_steady', 't4_stats_new', 't4_stats_empty']) {
      await query(`CREATE TABLE ${name} (id int PRIMARY KEY, v text)`);
    }
    await fill('t4_stats_grown', 1, 1000);
    await fill('t4_stats_steady', 1, 1000);
    // As the server does: counts still pending would otherwise land on top of the ANALYZE.
    await query('SELECT pg_stat_force_next_flush()');
    await query('ANALYZE t4_stats_grown');
    await query('ANALYZE t4_stats_steady');
    await fill('t4_stats_grown', 1001, 1200); // 200 > 50 + 100
    await fill('t4_stats_steady', 1001, 1100); // 100 <= 150
    await fill('t4_stats_new', 1, 10); // rows, never analysed
    expect(await flushed('t4_stats_new')).toMatchObject({ analysed: false, reltuples: -1 });

    const out = await analyseStaleTables('test: stale tables');
    expect(out.tables).toEqual(expect.arrayContaining(['t4_stats_grown', 't4_stats_new']));
    expect(out.tables).not.toContain('t4_stats_steady');
    expect(out.tables).not.toContain('t4_stats_empty');
    expect(out.failed).toEqual([]);
    expect(await flushed('t4_stats_grown')).toMatchObject({ changed: 0, reltuples: 1200, analysed: true });
    expect(await flushed('t4_stats_new')).toMatchObject({ changed: 0, reltuples: 10, analysed: true });
    expect(await flushed('t4_stats_steady')).toMatchObject({ changed: 100, reltuples: 1000 });

    // Nothing is due any more; an emptied table without statistics is not analysed again and again.
    await query('CREATE TABLE t4_stats_emptied (id int PRIMARY KEY, v text)');
    await fill('t4_stats_emptied', 1, 5);
    await query('DELETE FROM t4_stats_emptied');
    const again = await analyseStaleTables('test: nothing due');
    expect(again.tables).not.toContain('t4_stats_emptied');
    expect(again.tables.filter((n) => n.startsWith('t4_stats_'))).toEqual([]);
  });

  it('analyses one table per statement and serves a request that arrives between two of them', async () => {
    const { getDatabase } = await import('../db/driver.js');
    const { analyseEveryTable } = await import('../db/statistics.js');
    const db = await getDatabase();
    const original = db.query.bind(db);
    /** Completions, in order: each ANALYZE statement, and the request's probe. */
    const events: string[] = [];
    let probeSent = false;
    const spy = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      const analyse = /^ANALYZE/.test(sql);
      if (analyse && !probeSent) {
        probeSent = true;
        // A request arriving while the first table is analysed.
        setImmediate(() => { void original('SELECT 1 AS probe').then(() => events.push('probe answered')); });
      }
      const result = await original(sql, params);
      if (analyse) events.push(sql);
      return result as never;
    });
    try {
      const out = await analyseEveryTable('test: every table');
      const analyses = events.filter((e) => e.startsWith('ANALYZE'));
      expect(analyses.length).toBeGreaterThan(5);
      expect(analyses.every((s) => /^ANALYZE "[a-z0-9_]+"$/.test(s))).toBe(true);
      expect(out.tables).toHaveLength(analyses.length);
      // The request waited for one table, not for the whole database.
      expect(events.indexOf('probe answered')).toBe(1);
      expect(out.slowest).not.toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('the check that takes an automatic backup analyses every table; the other checks only the tables due', async () => {
    const { runScheduledMaintenance } = await import('../modules/admin/backup-scheduler.js');
    // As a restored copy: rows, and their statistics gone.
    await query(`DELETE FROM pg_statistic WHERE starelid IN ('users'::regclass, 'roles'::regclass, 't4_stats_steady'::regclass)`);
    expect((await flushed('users')).analysed).toBe(false);
    const first = await runScheduledMaintenance();
    expect(first.backup).toBe('TAKEN');
    expect(first.statistics.tables).toEqual(expect.arrayContaining(['users', 'roles', 't4_stats_steady', 't4_stats_grown', 'permissions']));
    expect((await flushed('users')).analysed).toBe(true);
    expect(await flushed('t4_stats_steady')).toMatchObject({ changed: 0, reltuples: 1100, analysed: true });

    // The next check finds the backup not due, and analyses only what changed enough since.
    await fill('t4_stats_grown', 1201, 1400);
    const next = await runScheduledMaintenance();
    expect(next.backup).toBe('NOT_DUE');
    expect(next.statistics.tables).toContain('t4_stats_grown');
    expect(next.statistics.tables).not.toContain('t4_stats_steady');
  });

  it('a business-sheet sync that wrote rows leaves the tables it changed analysed', async () => {
    const { runSync } = await import('../modules/google-sync/engine.js');
    const grid = [['Supplier Code', 'Supplier Name'], ...Array.from({ length: 120 }, (_, i) => [`T4-SUP-${i + 1}`, `Platform supplier ${i + 1}`])];
    await query('SELECT pg_stat_force_next_flush()');
    await query('ANALYZE suppliers');
    const result = await runSync({ trigger: 'MANUAL', sheets: ['Supplier Master'], reader: async () => grid });
    expect(result.totals.inserted).toBe(120);
    // Before: the 120 suppliers stayed unknown to the planner until something analysed them.
    expect(await flushed('suppliers')).toMatchObject({ changed: 0, analysed: true });
    expect((await flushed('suppliers')).reltuples).toBeGreaterThanOrEqual(120);

    // A dry run writes nothing and analyses nothing.
    await fill('t4_stats_grown', 1401, 1700);
    await runSync({ trigger: 'MANUAL', sheets: ['Supplier Master'], dryRun: true, reader: async () => grid });
    expect((await flushed('t4_stats_grown')).changed).toBe(300);
  });
});
