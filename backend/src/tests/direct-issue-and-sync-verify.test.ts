/**
 * Integration tests — Direct Store Issue, Stock Ledger Deduction, and Google Sync Verification.
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
let testItemId = 0;
let testRecipientId = 0;
let testDeptId = 0;
let testCostCentreId = 0;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

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
  if (me.body.data?.mustChangePassword) {
    const rot = await request(app).post('/api/v1/auth/change-password').set(auth(token)).send({
      currentPassword: initial,
      newPassword: next,
    });
    token = rot.body.data.accessToken as string;
  }
  return token;
}

beforeAll(async () => {
  const { createApp } = await import('../app.js');
  const { getDatabase, closeDatabase, query } = await import('../db/index.js');
  const { runMigrations } = await import('../db/migrate.js');
  const { seedSystem } = await import('../db/seed.js');

  await getDatabase();
  await runMigrations({ silent: true });
  await seedSystem();

  app = createApp();
  closeDb = closeDatabase;

  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Admin@Testing2026!');

  // Lookups and test item setup
  async function ensureLookup(category: string, code: string, name: string): Promise<number> {
    const existing = await query<{ id: number }>(
      'SELECT id FROM lookups WHERE category = $1 AND upper(code) = upper($2) AND deleted_at IS NULL',
      [category, code],
    );
    if (existing.length > 0) return existing[0]!.id;
    const inserted = await query<{ id: number }>(
      'INSERT INTO lookups (category, code, name, is_system) VALUES ($1, $2, $3, FALSE) RETURNING id',
      [category, code, name],
    );
    return inserted[0]!.id;
  }

  testDeptId = await ensureLookup('DEPARTMENT', 'TEST_STORE_DEPT', 'Store Testing Dept');
  testCostCentreId = await ensureLookup('COST_CENTRE', 'TEST_STORE_CC', 'Store Testing CC');
  const uomId = await ensureLookup('UOM', 'NOS', 'Numbers');

  // Insert or reset test item with known live stock
  const existingItem = await query<{ id: number }>("SELECT id FROM items WHERE item_code = 'DIR-ITEM-01'");
  if (existingItem.length > 0) {
    testItemId = existingItem[0]!.id;
    await query("UPDATE items SET live_stock_qty = 50.0000 WHERE id = $1", [testItemId]);
  } else {
    const item = await query<{ id: number }>(
      `INSERT INTO items (item_code, item_description, uom_id, department_id, cost_centre_id, live_stock_qty, is_active)
       VALUES ('DIR-ITEM-01', 'Direct Issue Test Item', $1, $2, $3, 50.0000, TRUE)
       RETURNING id`,
      [uomId, testDeptId, testCostCentreId],
    );
    testItemId = item[0]!.id;
  }

  // Get recipient user (admin or any user)
  const user = await query<{ id: number }>('SELECT id FROM users LIMIT 1');
  testRecipientId = user[0]!.id;
});

afterAll(async () => {
  if (closeDb) await closeDb();
});

describe('Priority 1 & 2 — Live Data Verify and Master Sync Controls', () => {
  it('GET /api/v1/google-sync/verify returns live verification report', async () => {
    const res = await request(app).get('/api/v1/google-sync/verify').set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const report = res.body.data;
    expect(report).toBeDefined();
    expect(report.sourceSheetId).toBeDefined();
    expect(report.tabSummaries).toBeDefined();
    expect(report.tabSummaries.itemMaster).toBeDefined();
    expect(report.tabSummaries.supplierMaster).toBeDefined();
    expect(report.tabSummaries.requisition).toBeDefined();
    expect(report.formulaAudit).toBeInstanceOf(Array);
    expect(report.stats).toBeDefined();
    expect(typeof report.stats.parityPercentage).toBe('number');
  });

  it('POST /api/v1/google-sync/reconcile performs dry run reconciliation without altering transactions', async () => {
    const res = await request(app)
      .post('/api/v1/google-sync/reconcile')
      .set(auth(adminToken))
      .send({ dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.dryRun).toBe(true);
    expect(typeof res.body.data.itemsProcessed).toBe('number');
    expect(res.body.data.message).toContain('Dry run complete');
  });

  it('POST /api/v1/google-sync/toggle persists master sync toggle', async () => {
    // Toggle OFF
    const offRes = await request(app)
      .post('/api/v1/google-sync/toggle')
      .set(auth(adminToken))
      .send({ enabled: false });

    expect(offRes.status).toBe(200);
    expect(offRes.body.data.enabled).toBe(false);
    expect(offRes.body.data.message).toContain('OFF');

    // Verify status endpoint reflects OFF
    const statusRes = await request(app).get('/api/v1/google-sync/status').set(auth(adminToken));
    expect(statusRes.body.data.enabled).toBe(false);

    // Toggle back ON
    const onRes = await request(app)
      .post('/api/v1/google-sync/toggle')
      .set(auth(adminToken))
      .send({ enabled: true });

    expect(onRes.status).toBe(200);
    expect(onRes.body.data.enabled).toBe(true);
  });
});

describe('Priority 4 — Direct Issue from Store', () => {
  let createdIssueId = 0;
  let createdIssueNo = '';

  it('refuses direct issue if requested quantity exceeds available stock', async () => {
    const res = await request(app)
      .post('/api/v1/inventory/direct-issues')
      .set(auth(adminToken))
      .send({
        recipientUserId: testRecipientId,
        departmentId: testDeptId,
        costCentreId: testCostCentreId,
        issueDate: '2026-10-13',
        purpose: 'Excess issue test',
        lines: [
          { itemId: testItemId, issueQty: 999.0 }, // Available is 50
        ],
      });

    expect(res.status).toBe(422);
    expect(res.body.success).toBe(false);
    expect(res.body.error.message).toContain('Insufficient stock');
  });

  it('successfully creates direct store issue and deducts stock exactly once', async () => {
    const { query } = await import('../db/index.js');

    const res = await request(app)
      .post('/api/v1/inventory/direct-issues')
      .set(auth(adminToken))
      .send({
        recipientUserId: testRecipientId,
        departmentId: testDeptId,
        costCentreId: testCostCentreId,
        issueDate: '2026-10-13',
        purpose: 'Testing direct machine maintenance replacement',
        remarks: 'Issued directly by store incharge',
        lines: [
          { itemId: testItemId, issueQty: 10.0, remarks: 'Bearing spare' },
        ],
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.issueNo).toMatch(/^DIR-\d{8}-\d{4}$/);
    expect(res.body.data.totalQty).toBe(10);

    createdIssueId = res.body.data.id;
    createdIssueNo = res.body.data.issueNo;

    // Check item balance reduced from 50 to 40
    const [itemRow] = await query<{ live_stock_qty: string }>(
      'SELECT live_stock_qty FROM items WHERE id = $1',
      [testItemId],
    );
    expect(Number(itemRow!.live_stock_qty)).toBe(40);

    // Check exactly one stock_ledger entry with DIRECT_ISSUE
    const ledger = await query<{ txn_type: string; outward_qty: string; balance_qty: string }>(
      "SELECT txn_type, outward_qty, balance_qty FROM stock_ledger WHERE item_id = $1 AND reference_no = $2",
      [testItemId, createdIssueNo],
    );
    expect(ledger).toHaveLength(1);
    expect(ledger[0]!.txn_type).toBe('DIRECT_ISSUE');
    expect(Number(ledger[0]!.outward_qty)).toBe(10);
    expect(Number(ledger[0]!.balance_qty)).toBe(40);
  });

  it('GET /api/v1/inventory/direct-issues lists direct issues with date and recipient filters', async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/direct-issues?fromDate=2026-10-01&toDate=2026-10-15&recipientId=${testRecipientId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data).toBeInstanceOf(Array);
    const found = res.body.data.find((d: any) => d.id === createdIssueId);
    expect(found).toBeDefined();
    expect(found.issue_no).toBe(createdIssueNo);
    expect(res.body.meta.summary.totalIssues).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/v1/inventory/direct-issues/:id returns details and lines', async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/direct-issues/${createdIssueId}`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.body.data.issue_no).toBe(createdIssueNo);
    expect(res.body.data.lines).toHaveLength(1);
    expect(res.body.data.lines[0].item_code).toBe('DIR-ITEM-01');
  });

  it('GET /api/v1/inventory/direct-issues/:id/print renders printable HTML issue slip', async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/direct-issues/${createdIssueId}/print`)
      .set(auth(adminToken));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.text).toContain('STORE DIRECT ISSUE SLIP');
    expect(res.text).toContain(createdIssueNo);
    expect(res.text).toContain('DIR-ITEM-01');
  });
});
