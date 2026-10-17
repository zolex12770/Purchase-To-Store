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
    constructor(options: Record<string, unknown>) {
      state.authOptions.push(options);
    }
  }
  const sheets = () => ({
    spreadsheets: {
      values: {
        // A permanent refusal, so the sync does not retry: it proves the read was attempted.
        batchGet: async (req: Record<string, unknown>) => {
          state.requests.push(req);
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
        expect(res.status).toBe(502);
        expect(res.body.error.code).toBe('INTEGRATION_ERROR');
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
    expect(verify.status).toBe(502);
    expect(verify.body.error.message).toMatch(/not configured/);
    const reconcile = await request(app).post('/api/v1/google-sync/reconcile').set(auth(adminToken)).send({ dryRun: false });
    expect(reconcile.status).toBe(502);
    expect(reconcile.body.error.message).toMatch(/not configured/);
    expect(fake.state.authOptions).toHaveLength(0);
    expect(fake.state.requests).toHaveLength(0);
    expect(await count('backup_metadata')).toBe(backups);
  });
});

describe('Key configured (production): read-only, with exactly that key', () => {
  it('the inventory sync builds its client from GOOGLE_SERVICE_ACCOUNT_KEY_FILE and reads the category sheet', async () => {
    const keyFile = path.join(os.tmpdir(), `zolex-test-key-${process.pid}-sync.json`);
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
      expect(res.status).toBe(502);
      expect(res.body.error.message).toMatch(/does not exist on this server/);
      expect(res.body.error.message).not.toContain(path.basename(keyFile));
      expect(fake.state.authOptions).toHaveLength(0);
    } finally {
      envRef.GOOGLE_SERVICE_ACCOUNT_KEY_FILE = '';
    }
  });
});
