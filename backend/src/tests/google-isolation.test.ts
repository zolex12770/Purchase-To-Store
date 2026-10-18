/**
 * Integration tests — Google access comes only from GOOGLE_SERVICE_ACCOUNT_KEY_FILE
 * (2026-10-16 audit, F02).
 *
 * The inventory sync and the Live Data Verify fell back to a fixed key path that exists
 * on the production host, so a staging copy started WITHOUT the variable still read the
 * live sheets and rewrote its stock from them. Pinned here:
 *
 *   1. With no key configured, sync, sync-all, verify and reconcile are refused with a
 *      plain "not configured" — no Google client is built, no checkpoint and no safety
 *      backup are written.
 *   2. With the key configured (production), the sync and the verify build their client
 *      from exactly that file, read-only.
 *
 * googleapis and google-auth-library are replaced by fakes that record what they are
 * given; nothing in this file can reach the network.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';
// Set before config/env.js is first imported; dotenv leaves a variable that is already set alone.
process.env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
process.env.GOOGLE_API_KEY = '';
process.env.GOOGLE_SHEET_ID = 'TEST_INBOUND_SHEET_NOT_REAL';

const fake = vi.hoisted(() => {
  const state = {
    authOptions: [] as Array<Record<string, unknown>>,
    requests: [] as Array<Record<string, unknown>>,
  };
  class FakeGoogleAuth {
    constructor(readonly options: Record<string, unknown>) {
      state.authOptions.push(options);
    }
  }
  const sheets = (init?: { auth?: unknown }) => ({
    spreadsheets: {
      values: {
        // A permanent refusal, so the sync does not retry: it proves the read was attempted.
        batchGet: async (req: Record<string, unknown>) => {
          state.requests.push(req);
          // As google-auth-library does, the key file is first read by the first call: a
          // missing one fails there with ENOENT and its path, the way production would.
          const keyFile = (init?.auth as { options?: { keyFile?: string } } | undefined)?.options?.keyFile;
          const { existsSync } = await import('node:fs');
          if (keyFile && !existsSync(keyFile)) {
            throw Object.assign(new Error(`ENOENT: no such file or directory, open '${keyFile}'`), { code: 'ENOENT' });
          }
          throw Object.assign(new Error('fake Google: the caller does not have permission'), { code: 403 });
        },
        get: async (req: Record<string, unknown>) => {
          state.requests.push(req);
          return { data: { values: [] } };
        },
      },
    },
  });
  return { state, FakeGoogleAuth, sheets };
});

vi.mock('googleapis', () => ({ google: { auth: { GoogleAuth: fake.FakeGoogleAuth }, sheets: fake.sheets } }));
vi.mock('google-auth-library', () => ({ GoogleAuth: fake.FakeGoogleAuth }));

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let envRef: { GOOGLE_SERVICE_ACCOUNT_KEY_FILE?: string };
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const READ_ONLY = 'https://www.googleapis.com/auth/spreadsheets.readonly';

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

const count = async (table: string) => (await query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM ${table}`))[0]!.n;

beforeAll(async () => {
  const { ensureStorageDirs, env } = await import('../config/env.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');
  const { getDatabase, closeDatabase } = await import('../db/driver.js');
  const db = await import('../db/index.js');
  const { createApp } = await import('../app.js');

  ensureStorageDirs();
  const conn = await getDatabase();
  closeDb = closeDatabase;
  query = db.query as Q;
  envRef = env as unknown as { GOOGLE_SERVICE_ACCOUNT_KEY_FILE?: string };

  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();

  app = createApp();
  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');
});

afterAll(async () => {
  envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
  if (closeDb) await closeDb();
});

describe('No key configured: refused plainly, nothing read or written', () => {
  it('the inventory sync and sync-all answer "not configured" and write no checkpoint', async () => {
    const checkpoints = await count('inventory_sync_checkpoints');
    for (const url of ['/api/v1/inventory/sync/GENERAL', '/api/v1/inventory/sync-all']) {
      for (const dryRun of [true, false]) {
        const res = await request(app).post(url).set(auth(adminToken)).send({ dryRun });
        // A state of this server, not a failed call to Google: 503, not 502 (S6-D1).
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SYNC_NOT_CONFIGURED');
        expect(res.body.error.message).toMatch(/not configured.*GOOGLE_SERVICE_ACCOUNT_KEY_FILE/);
        expect(res.body.error.message).toMatch(/nothing was changed/);
      }
    }
    expect(fake.state.authOptions).toHaveLength(0);
    expect(fake.state.requests).toHaveLength(0);
    expect(await count('inventory_sync_checkpoints')).toBe(checkpoints);
  });

  it('Live Data Verify and the master reconcile are refused before any read or safety backup', async () => {
    const backups = await count('backup_metadata');
    const verify = await request(app).get('/api/v1/google-sync/verify').set(auth(adminToken));
    expect(verify.status).toBe(503);
    expect(verify.body.error.code).toBe('SYNC_NOT_CONFIGURED');
    expect(verify.body.error.message).toMatch(/not configured/);
    const reconcile = await request(app).post('/api/v1/google-sync/reconcile').set(auth(adminToken)).send({ dryRun: false });
    expect(reconcile.status).toBe(503);
    expect(reconcile.body.error.code).toBe('SYNC_NOT_CONFIGURED');
    expect(reconcile.body.error.message).toMatch(/not configured/);
    expect(fake.state.authOptions).toHaveLength(0);
    expect(fake.state.requests).toHaveLength(0);
    expect(await count('backup_metadata')).toBe(backups);
  });
});

describe('Key configured (production): read-only, with exactly that key', () => {
  it('the inventory sync builds its client from GOOGLE_SERVICE_ACCOUNT_KEY_FILE and reads the category sheet', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-sync.json`);
    fs.writeFileSync(keyFile, '{}');
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    try {
      const { syncCategoryFromSheet } = await import('../modules/inventory/sync-engine.js');
      const { INVENTORY_SHEETS } = await import('../modules/inventory/sheet-model.js');
      const result = await syncCategoryFromSheet('GENERAL', { dryRun: true });
      expect(fake.state.authOptions).toEqual([{ keyFile, scopes: [READ_ONLY] }]);
      expect(fake.state.requests[0]).toMatchObject({ spreadsheetId: INVENTORY_SHEETS.GENERAL.spreadsheetId });
      // The fake refuses the read, so the run fails cleanly with Google's own words.
      expect(result.status).toBe('FAILED');
      expect(result.errorMessage).toMatch(/fake Google/);
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
      fs.rmSync(keyFile, { force: true });
      fake.state.authOptions.length = 0;
      fake.state.requests.length = 0;
    }
  });

  it('Live Data Verify builds its client from the configured key and returns its report', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-verify.json`);
    fs.writeFileSync(keyFile, '{}');
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    try {
      const res = await request(app).get('/api/v1/google-sync/verify').set(auth(adminToken));
      expect(res.status).toBe(200);
      expect(fake.state.authOptions).toEqual([{ keyFile, scopes: [READ_ONLY] }]);
      expect(fake.state.requests.some((r) => r.spreadsheetId === 'TEST_INBOUND_SHEET_NOT_REAL')).toBe(true);
      const report = res.body.data;
      expect(report.tabSummaries.itemMaster).toBeDefined();
      expect(report.tabSummaries.supplierMaster).toBeDefined();
      expect(report.tabSummaries.requisition).toBeDefined();
      expect(report.formulaAudit).toBeInstanceOf(Array);
      expect(typeof report.stats.parityPercentage).toBe('number');
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
      fs.rmSync(keyFile, { force: true });
      fake.state.authOptions.length = 0;
      fake.state.requests.length = 0;
    }
  });

  it('a configured key file that does not exist is reported without naming its path', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-missing.json`);
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    try {
      const res = await request(app).get('/api/v1/google-sync/verify').set(auth(adminToken));
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('SYNC_NOT_CONFIGURED');
      expect(res.body.error.message).toMatch(/Google key file not found.*does not exist on this server/);
      expect(res.body.error.message).not.toContain(path.basename(keyFile));
      expect(fake.state.authOptions).toHaveLength(0);
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
    }
  });

  // Leftover 5 (2026-10-18): the inventory sync passed the missing path to GoogleAuth, took
  // the ENOENT for a network blip (a string code), read three times and reported the path
  // in a "try again" message on a 200.
  it('the inventory sync refuses a configured key file that does not exist, once, as a configuration error', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-sync-missing.json`);
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    const checkpoints = await count('inventory_sync_checkpoints');
    try {
      for (const url of ['/api/v1/inventory/sync/GENERAL', '/api/v1/inventory/sync-all']) {
        const started = Date.now();
        const res = await request(app).post(url).set(auth(adminToken)).send({ dryRun: false });
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SYNC_NOT_CONFIGURED');
        expect(res.body.error.message).toMatch(/^Google key file not found: GOOGLE_SERVICE_ACCOUNT_KEY_FILE names a file that does not exist on this server\./);
        expect(res.body.error.message).toMatch(/nothing was changed/);
        expect(res.body.error.message).not.toContain(path.basename(keyFile));
        expect(res.body.error.message).not.toMatch(/ENOENT|try again/);
        // No retry with back-off: the old engine waited 1.5 s and 3 s between three reads.
        expect(Date.now() - started).toBeLessThan(1000);
      }
      expect(fake.state.authOptions).toHaveLength(0);
      expect(fake.state.requests).toHaveLength(0);
      expect(await count('inventory_sync_checkpoints')).toBe(checkpoints);
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
      fake.state.authOptions.length = 0;
      fake.state.requests.length = 0;
    }
  });

  it('a key file that is unreadable when the sheet is read fails that read once, without its path', async () => {
    const { syncCategoryFromSheet } = await import('../modules/inventory/sync-engine.js');
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-vanishing.json`);
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    try {
      // Present for the up-front check (which runs before the call returns), gone by the
      // time the sheet is read: a file-system code is not retried as a network blip.
      fs.writeFileSync(keyFile, '{}');
      const run = syncCategoryFromSheet('GENERAL', { dryRun: true });
      fs.rmSync(keyFile, { force: true });
      const result = await run;
      expect(result.status).toBe('FAILED');
      expect(fake.state.requests).toHaveLength(1);
      expect(result.errorMessage).toMatch(/the Google key file could not be read \(ENOENT\)/);
      expect(result.errorMessage).not.toContain(path.basename(keyFile));
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
      fs.rmSync(keyFile, { force: true });
      fake.state.authOptions.length = 0;
      fake.state.requests.length = 0;
    }
  });
});

/* ── The not-configured refusals are states of this server (S6-D1, C37) ──────── */

describe('Refusals that are states of this server, not failed calls to Google', () => {
  it('the business-sheet run and the inventory sync without credentials answer 503, logged as warnings without a stack', async () => {
    const { logger } = await import('../core/logger.js');
    const error = vi.spyOn(logger, 'error');
    const warn = vi.spyOn(logger, 'warn');
    try {
      for (const call of [
        () => request(app).post('/api/v1/google-sync/run').set(auth(adminToken)).send({ dryRun: true }),
        () => request(app).post('/api/v1/inventory/sync/RM').set(auth(adminToken)).send({ dryRun: true }),
      ]) {
        const res = await call();
        expect(res.status).toBe(503);
        expect(res.body.error.code).toBe('SYNC_NOT_CONFIGURED');
        expect(res.body.error.message).toMatch(/not configured|No Google credentials configured/);
      }
      // The request line is written once the response has gone.
      await new Promise((r) => setTimeout(r, 50));
      // Each was "Unhandled error on POST …" with the stack, plus the request line, both at error level.
      expect(error).not.toHaveBeenCalled();
      const lines = warn.mock.calls.map(([message]) => message);
      expect(lines).toEqual(expect.arrayContaining([
        expect.stringMatching(/^SYNC_NOT_CONFIGURED on POST \/api\/v1\/google-sync\/run: No Google credentials configured/),
        expect.stringMatching(/^POST \/api\/v1\/google-sync\/run 503 \d+ms$/),
        expect.stringMatching(/^SYNC_NOT_CONFIGURED on POST \/api\/v1\/inventory\/sync\/RM: Google Sheets access is not configured/),
        expect.stringMatching(/^POST \/api\/v1\/inventory\/sync\/RM 503 \d+ms$/),
      ]));
      expect(JSON.stringify(warn.mock.calls)).not.toMatch(/"stack"/);
    } finally {
      error.mockRestore();
      warn.mockRestore();
    }
  });

  it('an unexpected crash is still logged as an error, with its stack', async () => {
    const { logger } = await import('../core/logger.js');
    const { getDatabase } = await import('../db/driver.js');
    const db = await getDatabase();
    const original = db.query.bind(db);
    // Something nobody raised on purpose, thrown where the status screen reads its jobs.
    const crash = vi.spyOn(db, 'query').mockImplementation(async (sql: string, params?: unknown[]) => {
      if (/FROM google_sync_jobs j/.test(sql)) throw new Error('boom: not an AppError');
      return original(sql, params) as never;
    });
    const error = vi.spyOn(logger, 'error');
    try {
      const res = await request(app).get('/api/v1/google-sync/status').set(auth(adminToken));
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('SERVER_ERROR');
      await new Promise((r) => setTimeout(r, 50));
      const unhandled = error.mock.calls.find(([message]) => message === 'Unhandled error on GET /api/v1/google-sync/status');
      expect(unhandled?.[1]).toMatchObject({ error: 'boom: not an AppError', stack: expect.stringContaining('boom: not an AppError') });
      expect(error.mock.calls.some(([message]) => /^GET \/api\/v1\/google-sync\/status 500 \d+ms$/.test(message))).toBe(true);
    } finally {
      crash.mockRestore();
      error.mockRestore();
    }
  });

  it('a named key file that is missing makes the business-sheet sync "not configured" too, and it never reaches Google', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-business-missing.json`);
    envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = keyFile;
    try {
      const status = await request(app).get('/api/v1/google-sync/status').set(auth(adminToken));
      expect(status.status).toBe(200);
      expect(status.body.data).toMatchObject({ configured: false, mode: 'service-account' });
      expect(status.body.data.notConfiguredReason).toMatch(/^Google key file not found/);
      const run = await request(app).post('/api/v1/google-sync/run').set(auth(adminToken)).send({ dryRun: true });
      expect(run.status).toBe(503);
      expect(run.body.error.code).toBe('SYNC_NOT_CONFIGURED');
      expect(run.body.error.message).toMatch(/^Google key file not found/);
      expect(run.body.error.message).not.toContain(path.basename(keyFile));
      expect(fake.state.authOptions).toHaveLength(0);
      expect(fake.state.requests).toHaveLength(0);
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
    }
  });

  it('a second run while one is in progress is refused with 409 CONFLICT, not 502', async () => {
    const { runSync } = await import('../modules/google-sync/engine.js');
    const [mapping] = await query<{ sheet_name: string }>(`SELECT sheet_name FROM google_sheet_mappings WHERE is_enabled ORDER BY sync_order LIMIT 1`);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const first = runSync({ trigger: 'MANUAL', dryRun: true, sheets: [mapping!.sheet_name], reader: async () => { await gate; return []; } });
    try {
      await expect(runSync({ trigger: 'MANUAL', dryRun: true, reader: async () => [] }))
        .rejects.toMatchObject({ status: 409, code: 'CONFLICT', message: expect.stringMatching(/already in progress/) });
    } finally {
      // Whatever the answer, the first run is let finish: a run left waiting kept the worker alive.
      release();
    }
    expect((await first).status).toBe('SUCCESS');
  });
});
