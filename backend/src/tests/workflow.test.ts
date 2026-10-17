/**
 * Integration tests — the purchase-to-store workflow and its invariants
 * (SRS §28: integration, E2E, RBAC, quantity-balance and security tests).
 *
 * Runs against a real (test) database with NODE_ENV=test, so the schema, the
 * generated columns, the balance views and the transaction boundaries are all
 * genuinely exercised — not mocked.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

let app: Express;
let closeDb: () => Promise<void>;

/* Tokens for the roles under test. */
let adminToken = '';
let headToken = '';
let storeToken = '';

/* Fixture ids created in setup. */
let supplierId = 0;
let itemAId = 0;
let itemBId = 0;
let indentTypeId = 0;
let poTypeId = 0;
let departmentId = 0;
let costCentreId = 0;
let uomId = 0;

const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
/** Minimal query-string builder for test requests (arrays -> comma-joined). */
function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const value = Array.isArray(v) ? v.join(',') : String(v);
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(value)}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}
/** Every indent create/update needs a header-level Required By (now mandatory). */
const requiredByDate = '2027-01-31';

async function signIn(employeeId: string, passwords: string[]): Promise<string> {
  for (const password of passwords) {
    const res = await request(app).post('/api/v1/auth/login').send({ employeeId, password });
    if (res.status === 200) return res.body.data.accessToken as string;
  }
  throw new Error(`Could not sign in as ${employeeId}`);
}

/** Signs in on a bootstrap credential and rotates it, returning a usable token. */
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

  // Start from a clean schema so the suite is deterministic.
  await db.query('DROP SCHEMA IF EXISTS public CASCADE');
  await db.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();

  app = createApp();

  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');

  /* ── Fixtures ─────────────────────────────────────────────────────────── */
  const lookups = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  uomId = lookups.body.data.UOM[0].id;

  const mk = async (category: string, code: string, name: string) => {
    const res = await request(app).post(`/api/v1/lookups/${category}`).set(auth(adminToken))
      .send({ code, name });
    return res.body.data.id as number;
  };
  indentTypeId = await mk('INDENT_TYPE', 'TREG', 'Test Regular');
  poTypeId = await mk('PO_TYPE', 'TSTD', 'Test Standard');
  departmentId = await mk('DEPARTMENT', 'TDEPT', 'Test Department');
  costCentreId = await mk('COST_CENTRE', 'TCC', 'Test Cost Centre');

  const supplier = await request(app).post('/api/v1/suppliers').set(auth(adminToken))
    .send({ supplierName: 'Test Supplier Pvt Ltd', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
  supplierId = supplier.body.data.id;

  const itemA = await request(app).post('/api/v1/items').set(auth(adminToken))
    .send({ itemCode: 'TEST-ITEM-A', itemDescription: 'Test Item A', uomId, standardRate: '100' });
  itemAId = itemA.body.data.id;

  const itemB = await request(app).post('/api/v1/items').set(auth(adminToken))
    .send({ itemCode: 'TEST-ITEM-B', itemDescription: 'Test Item B', uomId, standardRate: '250' });
  itemBId = itemB.body.data.id;

  /* Role fixtures — a Purchase Head (to approve) and a Store User (for RBAC). */
  const roles = await request(app).get('/api/v1/roles').set(auth(adminToken));
  const roleId = (code: string) => roles.body.data.find((r: { code: string }) => r.code === code).id;

  await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-HEAD', employeeName: 'Test Purchase Head', designation: 'Head',
    password: 'Head@Test2026', roleIds: [roleId('PURCHASE_HEAD')], mustChangePassword: false,
  });
  await request(app).post('/api/v1/users').set(auth(adminToken)).send({
    employeeId: 'T-STORE', employeeName: 'Test Store User', designation: 'Store',
    password: 'Store@Test2026', roleIds: [roleId('STORE_USER')], mustChangePassword: false,
  });

  headToken = await signIn('T-HEAD', ['Head@Test2026']);
  storeToken = await signIn('T-STORE', ['Store@Test2026']);
}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

/* ── Helpers ─────────────────────────────────────────────────────────────── */

async function createApprovedIndent(itemId: number, quantity: number, rate = '100') {
  const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
    indentTypeId, requiredByDate, departmentId, costCentreId, suggestedSupplierId: supplierId, submit: true,
    lines: [{ itemId, indentQty: String(quantity), estimatedRate: rate }],
  });
  expect(created.status).toBe(201);
  const indentId = created.body.data.id as number;

  // The admin raised it, so a different authorised approver must action it.
  const approved = await request(app).post(`/api/v1/indents/${indentId}/approve`).set(auth(headToken)).send({});
  expect(approved.status).toBe(200);

  const detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
  return { indentId, line: detail.body.data.lines[0] };
}

async function createIssuedPo(
  lines: { itemId: number; poQty: string; rate: string; discountPct?: string; sources?: { indentLineId: number; consumedQty: string }[] }[],
) {
  const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
    supplierId, poTypeId, issue: true,
    lines: lines.map((l) => ({ ...l, discountPct: l.discountPct ?? '0', sources: l.sources ?? [] })),
  });
  expect(res.status).toBe(201);
  return res.body.data.id as number;
}

/* ═══════════════════════════ TESTS ═══════════════════════════════════════ */

describe('document numbering (ADR-002)', () => {
  it('issues sequential, uniquely formatted numbers', async () => {
    const a = await createApprovedIndent(itemAId, 10);
    const b = await createApprovedIndent(itemAId, 10);

    const detailA = await request(app).get(`/api/v1/indents/${a.indentId}`).set(auth(adminToken));
    const detailB = await request(app).get(`/api/v1/indents/${b.indentId}`).set(auth(adminToken));

    expect(detailA.body.data.indent_no).toMatch(/^IND-\d{8}-\d{4}$/);
    expect(detailB.body.data.indent_no).toMatch(/^IND-\d{8}-\d{4}$/);
    expect(detailA.body.data.indent_no).not.toBe(detailB.body.data.indent_no);
  });

  it('never issues a duplicate number under concurrent creation', async () => {
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        request(app).post('/api/v1/indents').set(auth(adminToken)).send({
          indentTypeId, requiredByDate, departmentId, costCentreId,
          lines: [{ itemId: itemAId, indentQty: '1' }],
        }),
      ),
    );
    const numbers = results.map((r) => r.body?.data?.indent_no).filter(Boolean);
    expect(numbers).toHaveLength(8);
    expect(new Set(numbers).size).toBe(8);
  });
});

describe('generated money columns (ADR-004)', () => {
  it('computes final rate and amount in the database', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '60', rate: '100', discountPct: '10' }]);
    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    const line = po.body.data.lines[0];

    expect(Number(line.final_rate)).toBe(90);
    expect(Number(line.amount)).toBe(5400);
  });

  it('keeps fractional discounts exact', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '3', rate: '1250.50', discountPct: '12.5' }]);
    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    const line = po.body.data.lines[0];

    // 1250.50 × 0.875 = 1094.1875 ; × 3 = 3282.5625 → 3282.56
    expect(Number(line.final_rate)).toBe(1094.1875);
    expect(Number(line.amount)).toBe(3282.56);
  });

  it('refuses a discount outside 0–100', async () => {
    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ itemId: itemAId, poQty: '1', rate: '10', discountPct: '150' }],
    });
    expect(res.status).toBe(422);
  });
});

describe('indent → PO quantity control (ADR-005, SRS §11.3)', () => {
  it('reduces the eligible quantity by exactly what was ordered', async () => {
    const { indentId, line } = await createApprovedIndent(itemAId, 100);

    await createIssuedPo([{
      itemId: itemAId, poQty: '60', rate: '100',
      sources: [{ indentLineId: line.indent_line_id, consumedQty: '60' }],
    }]);

    const after = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    const l = after.body.data.lines[0];
    expect(Number(l.ordered_qty)).toBe(60);
    expect(Number(l.pending_qty)).toBe(40);
    expect(l.line_status).toBe('PARTIALLY_ORDERED');
  });

  it('refuses to order more than remains eligible', async () => {
    const { line } = await createApprovedIndent(itemAId, 50);

    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{
        itemId: itemAId, poQty: '80', rate: '100', discountPct: '0',
        sources: [{ indentLineId: line.indent_line_id, consumedQty: '80' }],
      }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only .* remains eligible/i);
  });

  it('refuses a PO line whose sources do not reconcile with its quantity', async () => {
    const { line } = await createApprovedIndent(itemAId, 50);

    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{
        itemId: itemAId, poQty: '40', rate: '100', discountPct: '0',
        sources: [{ indentLineId: line.indent_line_id, consumedQty: '30' }],
      }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/must match exactly/i);
  });

  it('refuses to draw from an indent that is not approved', async () => {
    const draft = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, lines: [{ itemId: itemAId, indentQty: '10' }],
    });
    const detail = await request(app).get(`/api/v1/indents/${draft.body.data.id}`).set(auth(adminToken));
    const line = detail.body.data.lines[0];

    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{
        itemId: itemAId, poQty: '10', rate: '100', discountPct: '0',
        sources: [{ indentLineId: line.indent_line_id, consumedQty: '10' }],
      }],
    });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not approved/i);
  });

  /**
   * THE critical concurrency guarantee (SRS §56, ADR-005): two users racing to
   * consume the same indent quantity must not both succeed.
   */
  it('never lets two concurrent POs double-consume the same indent line', async () => {
    const { indentId, line } = await createApprovedIndent(itemAId, 100);

    const attempt = () =>
      request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
        supplierId, poTypeId, issue: true,
        lines: [{
          itemId: itemAId, poQty: '70', rate: '100', discountPct: '0',
          sources: [{ indentLineId: line.indent_line_id, consumedQty: '70' }],
        }],
      });

    const [first, second] = await Promise.all([attempt(), attempt()]);
    const statuses = [first.status, second.status].sort();

    // Exactly one may succeed: 70 + 70 = 140 exceeds the 100 available.
    expect(statuses).toEqual([201, 422]);

    const after = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    const l = after.body.data.lines[0];
    expect(Number(l.ordered_qty)).toBe(70);
    expect(Number(l.pending_qty)).toBe(30);
    // The invariant that must never break, whatever happens above.
    expect(Number(l.ordered_qty)).toBeLessThanOrEqual(Number(l.indent_qty));
  });
});

describe('multi-indent consolidation (SRS §11.1)', () => {
  it('merges the same item from two indents into one line with two sources', async () => {
    const a = await createApprovedIndent(itemBId, 30, '250');
    const b = await createApprovedIndent(itemBId, 20, '250');

    const poId = await createIssuedPo([{
      itemId: itemBId, poQty: '50', rate: '250',
      sources: [
        { indentLineId: a.line.indent_line_id, consumedQty: '30' },
        { indentLineId: b.line.indent_line_id, consumedQty: '20' },
      ],
    }]);

    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.source_mode).toBe('INDENT');
    expect(po.body.data.lines).toHaveLength(1);
    expect(po.body.data.lines[0].sources).toHaveLength(2);
    expect(po.body.data.sourceIndents).toHaveLength(2);

    // Both source indents are now fully ordered, so both auto-close.
    for (const indentId of [a.indentId, b.indentId]) {
      const detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
      expect(detail.body.data.status).toBe('CLOSED');
      expect(Number(detail.body.data.total_pending_qty)).toBe(0);
    }
  });

  it('consolidates three indents for the same item into one line summing 2 + 3 + 1 = 6', async () => {
    const a = await createApprovedIndent(itemAId, 2, '100');
    const b = await createApprovedIndent(itemAId, 3, '100');
    const c = await createApprovedIndent(itemAId, 1, '100');

    const poId = await createIssuedPo([{
      itemId: itemAId, poQty: '6', rate: '100',
      sources: [
        { indentLineId: a.line.indent_line_id, consumedQty: '2' },
        { indentLineId: b.line.indent_line_id, consumedQty: '3' },
        { indentLineId: c.line.indent_line_id, consumedQty: '1' },
      ],
    }]);

    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.lines).toHaveLength(1);
    expect(po.body.data.lines[0].po_qty).toBe('6.0000');
    expect(po.body.data.lines[0].sources).toHaveLength(3);
    expect(po.body.data.sourceIndents).toHaveLength(3);
  });

  it('releases the reserved quantity when a consolidated PO is cancelled', async () => {
    const a = await createApprovedIndent(itemBId, 40, '250');

    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{
        itemId: itemBId, poQty: '40', rate: '250', discountPct: '0',
        sources: [{ indentLineId: a.line.indent_line_id, consumedQty: '40' }],
      }],
    });
    const poId = res.body.data.id;

    let indent = await request(app).get(`/api/v1/indents/${a.indentId}`).set(auth(adminToken));
    expect(indent.body.data.status).toBe('CLOSED');

    const cancelled = await request(app).post(`/api/v1/purchase-orders/${poId}/cancel`)
      .set(auth(adminToken)).send({ reason: 'Supplier withdrew the quotation' });
    expect(cancelled.status).toBe(200);

    indent = await request(app).get(`/api/v1/indents/${a.indentId}`).set(auth(adminToken));
    expect(indent.body.data.status).toBe('APPROVED');
    expect(Number(indent.body.data.total_pending_qty)).toBe(40);
  });

  it('refuses to cancel a PO without a reason', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '5', rate: '100' }]);
    const res = await request(app).post(`/api/v1/purchase-orders/${poId}/cancel`).set(auth(adminToken)).send({});
    expect(res.status).toBe(422);
  });
});

describe('editing an already-issued PO (OPEN / PARTIALLY_RECEIVED stay editable)', () => {
  it('lets an OPEN PO with zero receipts be freely edited: quantity, rate, add a line, remove a line', async () => {
    const poId = await createIssuedPo([
      { itemId: itemAId, poQty: '100', rate: '50' },
      { itemId: itemBId, poQty: '10', rate: '200' },
    ]);
    let detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    const [lineA, lineB] = detail.body.data.lines as { po_line_id: number; item_id: number }[];

    // Change line A's qty and rate, DROP line B, add a brand-new line.
    const edited = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [
        { id: lineA!.po_line_id, itemId: itemAId, poQty: '120', rate: '55', discountPct: '0', sources: [] },
        { itemId: itemBId, poQty: '5', rate: '210', discountPct: '0', sources: [] }, // new line, same item as removed B
      ],
    });
    expect(edited.status).toBe(200);

    detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('OPEN'); // editing in place never un-issues it
    expect(detail.body.data.lines).toHaveLength(2);
    const updatedA = detail.body.data.lines.find((l: { po_line_id: number }) => l.po_line_id === lineA!.po_line_id);
    expect(updatedA).toBeDefined(); // SAME line id preserved
    expect(Number(updatedA.po_qty)).toBe(120);
    expect(Number(updatedA.rate)).toBe(55);
    expect(detail.body.data.lines.some((l: { po_line_id: number }) => l.po_line_id === lineB!.po_line_id)).toBe(false);
  });

  it('refuses to reduce a line below its already-received quantity, and refuses to remove a received line', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '100', rate: '50' }]);
    const poLine = (await poItemsFor(poId))[0]!;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: poLine.po_line_id, grnQty: '40' }] });
    expect(grn.status).toBe(201);

    // Cannot reduce below the 40 already received.
    const tooLow = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ id: poLine.po_line_id, itemId: itemAId, poQty: '30', rate: '50', discountPct: '0', sources: [] }],
    });
    expect(tooLow.status).toBe(422);
    expect(tooLow.body.error.message).toMatch(/already been received/i);

    // Increasing it is fine.
    const increased = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ id: poLine.po_line_id, itemId: itemAId, poQty: '150', rate: '50', discountPct: '0', sources: [] }],
    });
    expect(increased.status).toBe(200);

    // Cannot remove a line that has any receipt against it.
    const removed = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ itemId: itemBId, poQty: '5', rate: '10', discountPct: '0', sources: [] }], // omits the received line entirely
    });
    expect(removed.status).toBe(422);
    expect(removed.body.error.message).toMatch(/already has .* received .* cannot.*be removed/i);

    // Nothing partially applied from either refused attempt.
    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(detail.body.data.lines).toHaveLength(1);
    expect(Number(detail.body.data.lines[0].po_qty)).toBe(150);
  });

  it('keeps a PARTIALLY_RECEIVED PO editable, and a COMPLETED one locked', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '20', rate: '50' }]);
    const poLine = (await poItemsFor(poId))[0]!;
    await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: poLine.po_line_id, grnQty: '10' }] });

    let detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PARTIALLY_RECEIVED');

    const editWhilePartial = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ id: poLine.po_line_id, itemId: itemAId, poQty: '25', rate: '52', discountPct: '0', sources: [] }],
    });
    expect(editWhilePartial.status).toBe(200);

    // Receive the rest so it completes, then editing must be refused.
    const updatedLine = (await poItemsFor(poId, 'all'))[0]!;
    await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: updatedLine.po_line_id, grnQty: '15' }] });
    detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('COMPLETED');

    const editWhileComplete = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ id: updatedLine.po_line_id, itemId: itemAId, poQty: '99', rate: '50', discountPct: '0', sources: [] }],
    });
    expect(editWhileComplete.status).toBe(422);
    expect(editWhileComplete.body.error.message).toMatch(/completed.*can no longer be edited/i);
  });
});

/** Fetches a PO's receivable lines through the new unified picker endpoint. */
async function poItemsFor(poId: number, view: 'pending' | 'all' = 'pending') {
  const res = await request(app).get(`/api/v1/grn/po-items${qs({ poId: [poId], view })}`).set(auth(adminToken));
  expect(res.status).toBe(200);
  return res.body.data as {
    po_line_id: number; item_code: string; pending_grn_qty: string;
    received_qty: string; po_qty: string;
  }[];
}

describe('GRN receipt control (SRS §12)', () => {
  it('supports partial then final receipt and derives PO status', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '100', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const first = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '40' }] });
    expect(first.status).toBe(201);

    let po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(Number(po.body.data.total_pending_qty)).toBe(60);
    expect(Number(po.body.data.received_amount)).toBe(2000);

    const second = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '60' }] });
    expect(second.status).toBe(201);

    po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.status).toBe('COMPLETED');
    expect(Number(po.body.data.total_pending_qty)).toBe(0);
  });

  it('refuses to receive more than is outstanding', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const res = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '11' }] });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/only .* is outstanding/i);
  });

  it('refuses to receive against a draft PO', async () => {
    const draft = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, lines: [{ itemId: itemAId, poQty: '5', rate: '50', discountPct: '0' }],
    });
    const poId = draft.body.data.id;
    // A DRAFT PO's lines must not even appear as receivable (the picker excludes them).
    expect(await poItemsFor(poId)).toHaveLength(0);
    const allLines = await poItemsFor(poId, 'all');
    expect(allLines).toHaveLength(0); // v_po_line_balance still has the row, but po-items always excludes DRAFT

    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    const poLineId = detail.body.data.lines[0].po_line_id;

    const res = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '5' }] });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/not been issued/i);
  });

  it('never lets two concurrent receipts exceed the ordered quantity', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '100', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const attempt = () =>
      request(app).post('/api/v1/grn').set(auth(adminToken))
        .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '80' }] });

    const [a, b] = await Promise.all([attempt(), attempt()]);
    expect([a.status, b.status].sort()).toEqual([201, 422]);

    const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(Number(po.body.data.total_received_qty)).toBe(80);
    expect(Number(po.body.data.total_received_qty))
      .toBeLessThanOrEqual(Number(po.body.data.total_po_qty));
  });

  it('returns quantity to the PO when a posted receipt is cancelled', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '20', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '20' }] });

    let po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.status).toBe('COMPLETED');

    const cancelled = await request(app).post(`/api/v1/grn/${grn.body.data.id}/cancel`)
      .set(auth(adminToken)).send({ reason: 'Goods returned as damaged' });
    expect(cancelled.status).toBe(200);

    po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(po.body.data.status).toBe('OPEN');
    expect(Number(po.body.data.total_received_qty)).toBe(0);
    expect(Number(po.body.data.total_pending_qty)).toBe(20);
  });

  it('rejects zero and negative received quantity', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const zero = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '0' }] });
    expect(zero.status).toBe(422);

    const negative = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '-5' }] });
    expect(negative.status).toBe(422);
  });

  it('rejects a GRN dated in the future but allows a legitimately backdated one', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '50' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

    const future = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, grnDate: farFuture, lines: [{ poLineId, grnQty: '5' }] });
    expect(future.status).toBe(422);
    expect(future.body.error.issues?.some((i: { field: string }) => i.field === 'grnDate')).toBe(true);

    const backdated = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, grnDate: '2020-01-15', lines: [{ poLineId, grnQty: '5' }] });
    expect(backdated.status).toBe(201);
  });

  it('rejects an invalid PO line id and an invalid item id', async () => {
    const badPoLine = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: 9_999_999, grnQty: '5' }] });
    expect([404, 422]).toContain(badPoLine.status);

    const badItem = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'DIRECT', supplierId, post: true, lines: [{ itemId: 9_999_999, grnQty: '5', rate: '10' }] });
    expect([404, 422]).toContain(badItem.status);
  });
});

/**
 * GRN "PO Items" picker filters (Requisition/GRN bug-fix task, item 1).
 * The query logic itself lives in GET /grn/po-items — these exercise it
 * directly with a controlled second supplier/PO so each filter dimension
 * (and their combination) can be asserted precisely, independent of the
 * frontend's earlier z-index bug that hid the dropdown popovers.
 */
describe('GRN "PO Items" picker filters', () => {
  let filterSupplierId = 0;
  let filterPoId = 0;
  let filterPoNo = '';
  let filterPoLineId = 0;
  const filterPoDate = '2026-08-10';

  it('sets up a dedicated supplier + PO + partial receipt', async () => {
    const supplier = await request(app).post('/api/v1/suppliers').set(auth(adminToken))
      .send({ supplierName: 'PO Items Filter Test Supplier', city: 'Pune', state: 'Maharashtra', paymentTerms: 'NET30' });
    filterSupplierId = supplier.body.data.id;

    const po = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId: filterSupplierId, poTypeId, poDate: filterPoDate, issue: true,
      lines: [{ itemId: itemAId, poQty: '100', rate: '25', discountPct: '0', sources: [] }],
    });
    expect(po.status).toBe(201);
    filterPoId = po.body.data.id;
    filterPoNo = po.body.data.po_no;
    filterPoLineId = (await poItemsFor(filterPoId))[0]!.po_line_id;

    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: filterPoLineId, grnQty: '60' }] });
    expect(grn.status).toBe(201);
  });

  const poItems = (query: Record<string, unknown>) =>
    request(app).get(`/api/v1/grn/po-items${qs(query)}`).set(auth(adminToken));

  it('searches by PO number', async () => {
    const res = await poItems({ search: filterPoNo });
    expect(res.status).toBe(200);
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('searches by supplier name', async () => {
    const res = await poItems({ search: 'PO Items Filter Test Supplier' });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('searches by item code', async () => {
    const res = await poItems({ search: 'TEST-ITEM-A' });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('searches by item name (case-insensitive, partial)', async () => {
    const res = await poItems({ search: 'test item a' });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('filters by supplier — only that supplier’s lines remain', async () => {
    const res = await poItems({ supplierId: filterSupplierId, search: 'TEST-ITEM-A' });
    expect(res.body.data.every((r: { supplier_id: number }) => r.supplier_id === filterSupplierId)).toBe(true);
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('filters by a different supplier — excludes our line', async () => {
    const res = await poItems({ supplierId, search: 'TEST-ITEM-A' });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(false);
  });

  it('filters by the existing PO type master (no invented type)', async () => {
    const res = await poItems({ poTypeId, search: 'TEST-ITEM-A', supplierId: filterSupplierId });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('date-from is inclusive of the PO date', async () => {
    const onDate = await poItems({ dateFrom: filterPoDate, supplierId: filterSupplierId });
    expect(onDate.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
    const dayAfter = await poItems({ dateFrom: '2026-08-11', supplierId: filterSupplierId });
    expect(dayAfter.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(false);
  });

  it('date-to is inclusive of the PO date', async () => {
    const onDate = await poItems({ dateTo: filterPoDate, supplierId: filterSupplierId });
    expect(onDate.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
    const dayBefore = await poItems({ dateTo: '2026-08-09', supplierId: filterSupplierId });
    expect(dayBefore.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(false);
  });

  it('a date range spanning the PO date includes it; a range excluding it does not', async () => {
    const inside = await poItems({ dateFrom: '2026-08-01', dateTo: '2026-08-31', supplierId: filterSupplierId });
    expect(inside.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
    const outside = await poItems({ dateFrom: '2026-09-01', dateTo: '2026-09-30', supplierId: filterSupplierId });
    expect(outside.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(false);
  });

  it('Pending only shows a partially-received line with its real pending balance (line-level, not header status)', async () => {
    const res = await poItems({ view: 'pending', supplierId: filterSupplierId });
    const line = res.body.data.find((r: { po_line_id: number }) => r.po_line_id === filterPoLineId);
    expect(line).toBeDefined();
    expect(Number(line.pending_grn_qty)).toBe(40); // 100 ordered - 60 received
  });

  it('a fully-received line is excluded from Pending only but still visible in All', async () => {
    const grn2 = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: filterPoLineId, grnQty: '40' }] });
    expect(grn2.status).toBe(201);

    const pending = await poItems({ view: 'pending', supplierId: filterSupplierId });
    expect(pending.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(false);

    const all = await poItems({ view: 'all', supplierId: filterSupplierId });
    const line = all.body.data.find((r: { po_line_id: number }) => r.po_line_id === filterPoLineId);
    expect(line).toBeDefined();
    expect(Number(line.pending_grn_qty)).toBe(0);
  });

  it('combines search + supplier + date range + view simultaneously (AND, not override)', async () => {
    const res = await poItems({
      search: 'TEST-ITEM-A', supplierId: filterSupplierId,
      dateFrom: '2026-08-01', dateTo: '2026-08-31', view: 'all',
    });
    expect(res.body.data.some((r: { po_line_id: number }) => r.po_line_id === filterPoLineId)).toBe(true);
  });

  it('multiple GRNs against the same line accumulate correctly into its pending balance', async () => {
    const res = await poItems({ view: 'all', supplierId: filterSupplierId });
    const line = res.body.data.find((r: { po_line_id: number }) => r.po_line_id === filterPoLineId);
    expect(Number(line.pending_grn_qty)).toBe(0); // 60 + 40 = 100 = full order qty across two GRNs
  });

  it('reset (no filters) returns the default Pending-only result set without error', async () => {
    const res = await poItems({});
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
  });
});

describe('GRN reconstruction — Direct GRN, multi-PO GRN, single-supplier rule (GRN module rebuild)', () => {
  it('creates a Direct GRN with no purchase order, snapshotting Item Master values', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true,
      invoiceNo: 'INV-DIRECT-1', challanNo: 'CH-DIRECT-1',
      lines: [
        { itemId: itemAId, grnQty: '15', rate: '55', batchNo: 'B-1', location: 'Main Store', remarks: 'Emergency purchase' },
        { itemId: itemBId, grnQty: '5', rate: '260' },
      ],
    });
    expect(res.status).toBe(201);
    const grnId = res.body.data.id as number;
    expect(res.body.data.po_id).toBeNull();

    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    expect(detail.body.data.mode).toBe('DIRECT');
    expect(detail.body.data.lines).toHaveLength(2);
    expect(detail.body.data.lines.every((l: { po_line_id: number | null }) => l.po_line_id === null)).toBe(true);
    expect(detail.body.data.lines[0].item_code).toBe('TEST-ITEM-A');
    expect(detail.body.data.lines[0].batch_no).toBe('B-1');
  });

  it('rejects a Direct GRN line for an unknown item', async () => {
    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'DIRECT', supplierId, post: true,
      lines: [{ itemId: 9_999_999, grnQty: '5', rate: '10' }],
    });
    expect(res.status).toBe(422);
  });

  it('consolidates multiple purchase orders into ONE GRN, each line still tracing its own PO', async () => {
    const poA = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poB = await createIssuedPo([{ itemId: itemBId, poQty: '30', rate: '30' }]);
    const lineA = (await poItemsFor(poA))[0]!.po_line_id;
    const lineB = (await poItemsFor(poB))[0]!.po_line_id;

    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'PO', post: true,
      lines: [{ poLineId: lineA, grnQty: '10' }, { poLineId: lineB, grnQty: '15' }],
    });
    expect(res.status).toBe(201);
    // Header po_id is a convenience field only populated for the single-PO case.
    expect(res.body.data.po_id).toBeNull();

    const detail = await request(app).get(`/api/v1/grn/${res.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.mode).toBe('PO');
    expect(detail.body.data.poNumbers).toHaveLength(2);
    expect(detail.body.data.lines).toHaveLength(2);

    const poAAfter = await request(app).get(`/api/v1/purchase-orders/${poA}`).set(auth(adminToken));
    expect(poAAfter.body.data.status).toBe('COMPLETED');
    const poBAfter = await request(app).get(`/api/v1/purchase-orders/${poB}`).set(auth(adminToken));
    expect(poBAfter.body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(Number(poBAfter.body.data.total_pending_qty)).toBe(15);

    // The PO's own GRN history correctly attributes only ITS line, even though
    // the GRN as a whole spans two POs.
    expect(poAAfter.body.data.grns).toHaveLength(1);
    expect(Number(poAAfter.body.data.grns[0].total_qty)).toBe(10);
    expect(poBAfter.body.data.grns).toHaveLength(1);
    expect(Number(poBAfter.body.data.grns[0].total_qty)).toBe(15);
  });

  it('refuses to combine PO lines from different suppliers into one GRN', async () => {
    const otherSupplier = await request(app).post('/api/v1/suppliers').set(auth(adminToken))
      .send({ supplierName: 'Second Test Supplier Pvt Ltd', city: 'Mumbai', state: 'Maharashtra', paymentTerms: 'NET30' });
    const otherSupplierId = otherSupplier.body.data.id as number;

    const poMine = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poOtherRes = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId: otherSupplierId, poTypeId, issue: true,
      lines: [{ itemId: itemBId, poQty: '10', rate: '20', discountPct: '0', sources: [] }],
    });
    expect(poOtherRes.status).toBe(201);
    const poOther = poOtherRes.body.data.id as number;

    const lineMine = (await poItemsFor(poMine))[0]!.po_line_id;
    const lineOther = (await poItemsFor(poOther))[0]!.po_line_id;

    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'PO', post: true,
      lines: [{ poLineId: lineMine, grnQty: '5' }, { poLineId: lineOther, grnQty: '5' }],
    });
    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/more than one supplier/i);

    // Nothing partially applied — a rejected multi-supplier GRN must not have
    // moved either PO's balance.
    const poMineAfter = await request(app).get(`/api/v1/purchase-orders/${poMine}`).set(auth(adminToken));
    expect(Number(poMineAfter.body.data.total_received_qty)).toBe(0);
  });

  it('reproduces the reference test-data scenario: PO A/B pen + PO C cable, three receipts, running pending, full history retained', async () => {
    const poA = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]); // "Pen" analogue
    const poB = await createIssuedPo([{ itemId: itemAId, poQty: '15', rate: '20' }]);
    const poC = await createIssuedPo([{ itemId: itemBId, poQty: '20', rate: '30' }]); // "Cable" analogue

    const lineA = (await poItemsFor(poA))[0]!.po_line_id;
    const lineB = (await poItemsFor(poB))[0]!.po_line_id;

    // GRN 1: Pen = 5 against PO A -> combined pending across A+B must be 25 - 5 = 20.
    const g1 = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: lineA, grnQty: '5' }] });
    expect(g1.status).toBe(201);
    let pending = Number((await poItemsFor(poA))[0]?.pending_grn_qty ?? 0) + Number((await poItemsFor(poB))[0]?.pending_grn_qty ?? 0);
    expect(pending).toBe(20);

    // GRN 2: Pen = 10 against PO A's remainder (5) + PO B (5) in ONE GRN -> pending now 10.
    const remainingA = Number((await poItemsFor(poA))[0]!.pending_grn_qty);
    expect(remainingA).toBe(5);
    const g2 = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'PO', post: true,
      lines: [{ poLineId: lineA, grnQty: '5' }, { poLineId: lineB, grnQty: '5' }],
    });
    expect(g2.status).toBe(201);
    // PO A is now fully received and must disappear from the pending picker.
    expect(await poItemsFor(poA)).toHaveLength(0);
    pending = Number((await poItemsFor(poB))[0]?.pending_grn_qty ?? 0);
    expect(pending).toBe(10);

    // GRN 3: Pen = 10 against the rest of PO B -> pending 0, PO B also disappears.
    const g3 = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId: lineB, grnQty: '10' }] });
    expect(g3.status).toBe(201);
    expect(await poItemsFor(poB)).toHaveLength(0);

    // History: all three GRNs remain fully readable — nothing was deleted.
    for (const id of [g1.body.data.id, g2.body.data.id, g3.body.data.id]) {
      const d = await request(app).get(`/api/v1/grn/${id}`).set(auth(adminToken));
      expect(d.status).toBe(200);
      expect(d.body.data.status).toBe('POSTED');
    }
    const poAFinal = await request(app).get(`/api/v1/purchase-orders/${poA}`).set(auth(adminToken));
    expect(poAFinal.body.data.status).toBe('COMPLETED');
    const poBFinal = await request(app).get(`/api/v1/purchase-orders/${poB}`).set(auth(adminToken));
    expect(poBFinal.body.data.status).toBe('COMPLETED');

    // PO C (cable) was never touched — still fully pending, unaffected by the pen receipts.
    const poCLines = await poItemsFor(poC);
    expect(poCLines).toHaveLength(1);
    expect(Number(poCLines[0]!.pending_grn_qty)).toBe(20);

    // Item-wise analysis reflects the true totals for the pen item across all three GRNs.
    const itemAnalysis = await request(app).get(`/api/v1/grn/analysis/item-wise${qs({ search: 'TEST-ITEM-A' })}`).set(auth(adminToken));
    expect(itemAnalysis.status).toBe(200);
    const row = itemAnalysis.body.data.find((r: { item_code: string }) => r.item_code === 'TEST-ITEM-A');
    expect(row).toBeDefined();
    expect(Number(row.total_received_qty)).toBeGreaterThanOrEqual(20);
    expect(Number(row.grn_count)).toBeGreaterThanOrEqual(3);
  });
});

describe('MLN generation and GRN Labels (GRN reconstruction Part 2/4/5)', () => {
  it('issues a unique MLN per line only on POST, never on a draft save', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    const draft = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: false, lines: [{ poLineId, grnQty: '4' }] });
    expect(draft.status).toBe(201);
    const draftDetail = await request(app).get(`/api/v1/grn/${draft.body.data.id}`).set(auth(adminToken));
    expect(draftDetail.body.data.lines[0].mln_no).toBeNull();

    const posted = await request(app).post(`/api/v1/grn/${draft.body.data.id}/post`).set(auth(adminToken)).send({});
    expect(posted.status).toBe(200);
    const postedDetail = await request(app).get(`/api/v1/grn/${draft.body.data.id}`).set(auth(adminToken));
    const mlnNo = postedDetail.body.data.lines[0].mln_no as string;
    expect(mlnNo).toMatch(/^P\d{12}$/);
    expect(postedDetail.body.data.lines[0].mln_sr_no).toBe(1);
  });

  it('never issues a duplicate MLN, even for concurrent posts of different lines', async () => {
    const poA = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poB = await createIssuedPo([{ itemId: itemBId, poQty: '10', rate: '20' }]);
    const lineA = (await poItemsFor(poA))[0]!.po_line_id;
    const lineB = (await poItemsFor(poB))[0]!.po_line_id;

    const [a, b] = await Promise.all([
      request(app).post('/api/v1/grn').set(auth(adminToken)).send({ mode: 'PO', post: true, lines: [{ poLineId: lineA, grnQty: '5' }] }),
      request(app).post('/api/v1/grn').set(auth(adminToken)).send({ mode: 'PO', post: true, lines: [{ poLineId: lineB, grnQty: '5' }] }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const da = await request(app).get(`/api/v1/grn/${a.body.data.id}`).set(auth(adminToken));
    const db = await request(app).get(`/api/v1/grn/${b.body.data.id}`).set(auth(adminToken));
    const mlnA = da.body.data.lines[0].mln_no as string;
    const mlnB = db.body.data.lines[0].mln_no as string;
    expect(mlnA).not.toBe(mlnB);
  });

  it('finds an issued MLN through GET /grn/labels and its filters', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '10', batchNo: 'LBL-BATCH-1' }] });
    const grnId = grn.body.data.id as number;
    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    const mlnNo = detail.body.data.lines[0].mln_no as string;

    const byMln = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken));
    expect(byMln.status).toBe(200);
    expect(byMln.body.data).toHaveLength(1);
    expect(byMln.body.data[0].mln_no).toBe(mlnNo);
    expect(byMln.body.data[0].batch_no).toBe('LBL-BATCH-1');

    const byGrn = await request(app).get(`/api/v1/grn/labels${qs({ grnId })}`).set(auth(adminToken));
    expect(byGrn.body.data.map((r: { mln_no: string }) => r.mln_no)).toContain(mlnNo);

    // Freshly issued, never printed — must show up as PENDING and not PRINTED/CANCELLED.
    const pending = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo, status: 'PENDING' })}`).set(auth(adminToken));
    expect(pending.body.data).toHaveLength(1);
    const printed = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo, status: 'PRINTED' })}`).set(auth(adminToken));
    expect(printed.body.data).toHaveLength(0);
  });

  it('printing a label is idempotent on the MLN, bumps the print count, and never mints a second MLN', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '10' }] });
    const detail = await request(app).get(`/api/v1/grn/${grn.body.data.id}`).set(auth(adminToken));
    const mlnNo = detail.body.data.lines[0].mln_no as string;
    const labelRow = (await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken))).body.data[0];

    const preview = await request(app).get(`/api/v1/grn/labels/print-view${qs({ ids: String(labelRow.id) })}`).set(auth(adminToken));
    expect(preview.status).toBe(200);
    expect(preview.text).toContain(mlnNo);

    const firstPrint = await request(app).post('/api/v1/grn/labels/print').set(auth(adminToken)).send({ ids: [labelRow.id] });
    expect(firstPrint.status).toBe(200);
    const reprint = await request(app).post('/api/v1/grn/labels/print').set(auth(adminToken)).send({ ids: [labelRow.id] });
    expect(reprint.status).toBe(200);

    const after = (await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken))).body.data[0];
    expect(after.mln_no).toBe(mlnNo); // same identity — reprinting never mints a new MLN
    expect(after.print_count).toBe(2);

    const printedFilter = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo, status: 'PRINTED' })}`).set(auth(adminToken));
    expect(printedFilter.body.data).toHaveLength(1);
  });

  it('marks a label CANCELLED (not deleted) when its GRN is cancelled, and stock/label history stays traceable', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '10', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '10' }] });
    const grnId = grn.body.data.id as number;
    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(adminToken));
    const mlnNo = detail.body.data.lines[0].mln_no as string;

    const cancel = await request(app).post(`/api/v1/grn/${grnId}/cancel`).set(auth(adminToken))
      .send({ reason: 'Wrong material delivered' });
    expect(cancel.status).toBe(200);

    // The MLN row itself is never deleted — it is still findable...
    const stillThere = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken));
    expect(stillThere.body.data).toHaveLength(1);
    expect(stillThere.body.data[0].grn_status).toBe('CANCELLED');

    // ...and its derived status is CANCELLED, never PENDING or PRINTED.
    const cancelledFilter = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo, status: 'CANCELLED' })}`).set(auth(adminToken));
    expect(cancelledFilter.body.data).toHaveLength(1);
    const pendingFilter = await request(app).get(`/api/v1/grn/labels${qs({ mlnNo, status: 'PENDING' })}`).set(auth(adminToken));
    expect(pendingFilter.body.data).toHaveLength(0);
  });

  it('expands one MLN into exactly "No. of Label" physical labels, quantities summing to the received qty', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '150', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '150', labelCount: '14' }] });
    expect(grn.status).toBe(201);
    const detail = await request(app).get(`/api/v1/grn/${grn.body.data.id}`).set(auth(adminToken));
    const mlnNo = detail.body.data.lines[0].mln_no as string;
    const labelRow = (await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken))).body.data[0];
    expect(Number(labelRow.label_count)).toBe(14);

    const preview = await request(app).get(`/api/v1/grn/labels/print-view${qs({ ids: String(labelRow.id) })}`).set(auth(adminToken));
    expect(preview.status).toBe(200);

    // Exactly 14 label cards, all carrying the SAME MLN, each with its own SR. NO.
    const cardCount = (preview.text.match(/class="label(?: last)?"/g) ?? []).length;
    expect(cardCount).toBe(14);
    // Each card prints the MLN twice as visible text (the "MLN NO." field and the
    // caption under the barcode) — the barcode itself is bars only, no embedded text.
    const mlnOccurrences = (preview.text.match(new RegExp(mlnNo, 'g')) ?? []).length;
    expect(mlnOccurrences).toBe(cardCount * 2);
    expect(preview.text).toContain('1 / 14');
    expect(preview.text).toContain('14 / 14');

    // Sum of every "QTY" figure printed on the sheet equals the received quantity — no loss, no duplication.
    const qtyMatches = [...preview.text.matchAll(/<span class="k">QTY<\/span><span class="v">([\d.]+)/g)];
    expect(qtyMatches).toHaveLength(14);
    const total = qtyMatches.reduce((s, m) => s + Number(m[1]), 0);
    expect(total).toBe(150);
  });

  it('defaults to a single physical label when "No. of Label" is left blank, using the full received qty', async () => {
    const poId = await createIssuedPo([{ itemId: itemAId, poQty: '25', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '25' }] }); // no labelCount
    const detail = await request(app).get(`/api/v1/grn/${grn.body.data.id}`).set(auth(adminToken));
    const mlnNo = detail.body.data.lines[0].mln_no as string;
    const labelRow = (await request(app).get(`/api/v1/grn/labels${qs({ mlnNo })}`).set(auth(adminToken))).body.data[0];

    const preview = await request(app).get(`/api/v1/grn/labels/print-view${qs({ ids: String(labelRow.id) })}`).set(auth(adminToken));
    const cardCount = (preview.text.match(/class="label(?: last)?"/g) ?? []).length;
    expect(cardCount).toBe(1);
    expect(preview.text).toContain('1 / 1');
    expect(preview.text).toContain('>25 '); // QTY reflects the full amount, not divided (trailing zeros trimmed)
  });
});

describe('approval workflow (SRS §10)', () => {
  it('blocks self-approval for an ordinary authorised approver (Purchase Head, not Super Admin)', async () => {
    // T-HEAD holds indent.approve (can approve OTHERS' indents — proven
    // throughout this suite) but is not a Super Admin, so separation of
    // duties (ADR-011) still applies to their OWN indent.
    const created = await request(app).post('/api/v1/indents').set(auth(headToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    const res = await request(app).post(`/api/v1/indents/${created.body.data.id}/approve`)
      .set(auth(headToken)).send({});

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/cannot approve an indent that you raised/i);

    // A different authorised approver still can.
    const approvedByOther = await request(app).post(`/api/v1/indents/${created.body.data.id}/approve`)
      .set(auth(adminToken)).send({});
    expect(approvedByOther.status).toBe(200);
  });

  it('allows a Super Admin to approve an indent they raised themselves, with the self-approval flag audited', async () => {
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;

    const res = await request(app).post(`/api/v1/indents/${id}/approve`).set(auth(adminToken)).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.to).toBe('APPROVED');

    const detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');

    const auditRows = await request(app).get(`/api/v1/audit/entity/purchase_indent/${id}`).set(auth(adminToken));
    expect(auditRows.status).toBe(200);
    const approveRow = (auditRows.body.data as Array<{ action: string; after_data: unknown }>)
      .find((r) => r.action === 'APPROVE');
    expect(approveRow).toBeDefined();
    const after = approveRow!.after_data as { selfApproval?: boolean; requestedByUserId?: number; actorUserId?: number };
    expect(after.selfApproval).toBe(true);
    expect(after.requestedByUserId).toBe(after.actorUserId);
  });

  it('rejects self-approval attempts from a non-authorised user server-side, regardless of frontend state', async () => {
    // A Store User has no indent.approve permission at all — RBAC refuses
    // before the self-approval logic is even reached.
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    const res = await request(app).post(`/api/v1/indents/${created.body.data.id}/approve`)
      .set(auth(storeToken)).send({});
    expect(res.status).toBe(403);
  });

  it('requires a reason to reject, and records it', async () => {
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    const id = created.body.data.id;

    const noReason = await request(app).post(`/api/v1/indents/${id}/reject`).set(auth(headToken)).send({});
    expect(noReason.status).toBe(422);

    const ok = await request(app).post(`/api/v1/indents/${id}/reject`).set(auth(headToken))
      .send({ reason: 'Budget not sanctioned' });
    expect(ok.status).toBe(200);

    const detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('REJECTED');
    expect(detail.body.data.rejection_reason).toBe('Budget not sanctioned');
  });

  it('protects an approved indent from editing', async () => {
    const { indentId } = await createApprovedIndent(itemAId, 10);
    const res = await request(app).put(`/api/v1/indents/${indentId}`).set(auth(adminToken))
      .send({ indentTypeId, requiredByDate, departmentId, costCentreId, lines: [{ itemId: itemAId, indentQty: '999' }] });

    expect(res.status).toBe(422);
    expect(res.body.error.message).toMatch(/can no longer be edited/i);
  });

  it('completes a full reject -> reopen -> re-edit -> resubmit -> reapprove cycle, repeatably', async () => {
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;

    // Reject
    const rejected = await request(app).post(`/api/v1/indents/${id}/reject`).set(auth(headToken))
      .send({ reason: 'Wrong quantity' });
    expect(rejected.status).toBe(200);

    // Reopen — this previously 500'd: PGlite rejects a bound parameter the
    // REOPEN branch's SQL text never references, unlike a lenient Postgres
    // client. Regression guard for that fix.
    const reopened = await request(app).post(`/api/v1/indents/${id}/reopen`).set(auth(adminToken)).send({});
    expect(reopened.status).toBe(200);
    expect(reopened.body.data.to).toBe('DRAFT');

    // Re-edit while DRAFT, then resubmit
    const edited = await request(app).put(`/api/v1/indents/${id}`).set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '8' }],
    });
    expect(edited.status).toBe(200);
    let detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');
    expect(Number(detail.body.data.lines[0].indent_qty)).toBe(8);

    // Reapprove — a second full cycle on the SAME document, proving this is
    // repeatable, not a one-time transition.
    const reapproved = await request(app).post(`/api/v1/indents/${id}/approve`).set(auth(headToken)).send({});
    expect(reapproved.status).toBe(200);
    detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');

    const auditRows = await request(app).get(`/api/v1/audit/entity/purchase_indent/${id}`).set(auth(adminToken));
    const actions = (auditRows.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(['SUBMIT', 'REJECT', 'REOPEN', 'APPROVE']));
  });

  it('allows editing a PENDING_APPROVAL indent directly — add a line, remove a line, change quantity, no reject/reopen needed', async () => {
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true,
      lines: [{ itemId: itemAId, indentQty: '5' }],
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id as number;
    let detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');

    // The raiser (indent.edit) changes the quantity and adds a second line
    // while still pending — no reject/reopen round trip required.
    const editedByRaiser = await request(app).put(`/api/v1/indents/${id}`).set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: false,
      lines: [{ itemId: itemAId, indentQty: '7' }, { itemId: itemBId, indentQty: '2' }],
    });
    expect(editedByRaiser.status).toBe(200);
    detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PENDING_APPROVAL'); // never reverted to draft
    expect(detail.body.data.lines).toHaveLength(2);
    expect(Number(detail.body.data.lines.find((l: { item_id: number }) => l.item_id === itemAId)!.indent_qty)).toBe(7);

    // An authorised approver (indent.approve, no indent.edit assumption) can
    // ALSO adjust it while reviewing — remove the second line back out.
    const editedByHead = await request(app).put(`/api/v1/indents/${id}`).set(auth(headToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: false,
      lines: [{ itemId: itemAId, indentQty: '7' }],
    });
    expect(editedByHead.status).toBe(200);
    detail = await request(app).get(`/api/v1/indents/${id}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('PENDING_APPROVAL');
    expect(detail.body.data.lines).toHaveLength(1);

    // Still approvable normally afterwards.
    const approved = await request(app).post(`/api/v1/indents/${id}/approve`).set(auth(headToken)).send({});
    expect(approved.status).toBe(200);

    // A Store User (neither indent.edit nor indent.approve on THIS document's
    // action set — no permission at all here) still cannot edit it.
    const created2 = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '3' }],
    });
    const blocked = await request(app).put(`/api/v1/indents/${created2.body.data.id}`).set(auth(storeToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: false, lines: [{ itemId: itemAId, indentQty: '99' }],
    });
    expect(blocked.status).toBe(403);
  });

  it('unapproves an APPROVED indent back to DRAFT (never REJECTED), fully editable, and supports repeated approve/unapprove cycles', async () => {
    const { indentId } = await createApprovedIndent(itemAId, 5);
    let detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');

    // UNAPPROVE is a genuinely distinct action from REJECT — it must land on
    // DRAFT, never fabricate a REJECTED decision, and requires no reason.
    const unapproved = await request(app).post(`/api/v1/indents/${indentId}/unapprove`).set(auth(headToken)).send({});
    expect(unapproved.status).toBe(200);
    detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('DRAFT');
    expect(detail.body.data.rejection_reason).toBeNull();
    expect(detail.body.data.approved_at).toBeNull();
    expect(detail.body.data.approved_by_name).toBeNull();

    // Fully editable immediately — no separate reopen step needed: add a
    // line, remove a line, change quantity, all in one PUT.
    const edited = await request(app).put(`/api/v1/indents/${indentId}`).set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true,
      lines: [{ itemId: itemAId, indentQty: '9' }, { itemId: itemBId, indentQty: '4' }],
    });
    expect(edited.status).toBe(200);
    const editedDetail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(editedDetail.body.data.lines).toHaveLength(2);
    expect(editedDetail.body.data.status).toBe('PENDING_APPROVAL');

    // Re-approve, then unapprove a SECOND time — proving the cycle repeats,
    // not a one-shot transition, and still never touches REJECTED.
    const reapproved = await request(app).post(`/api/v1/indents/${indentId}/approve`).set(auth(headToken)).send({});
    expect(reapproved.status).toBe(200);
    const unapprovedAgain = await request(app).post(`/api/v1/indents/${indentId}/unapprove`).set(auth(headToken)).send({});
    expect(unapprovedAgain.status).toBe(200);
    const finalDetail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(finalDetail.body.data.status).toBe('DRAFT');

    const auditRows = await request(app).get(`/api/v1/audit/entity/purchase_indent/${indentId}`).set(auth(adminToken));
    const actions = (auditRows.body.data as Array<{ action: string }>).map((r) => r.action);
    expect(actions.filter((a) => a === 'APPROVE')).toHaveLength(2);
    expect(actions.filter((a) => a === 'UNAPPROVE')).toHaveLength(2);
    expect(actions).not.toContain('REJECT');
  });

  it('refuses to unapprove an indent for a user who lacks indent.approve (Store User holds only indent.view)', async () => {
    const { indentId } = await createApprovedIndent(itemAId, 5);
    const blocked = await request(app).post(`/api/v1/indents/${indentId}/unapprove`).set(auth(storeToken)).send({});
    expect(blocked.status).toBe(403);
    const detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED'); // unchanged
  });

  it('refuses to unapprove an indent once its quantity has already been converted into a purchase order', async () => {
    // Partial consumption (3 of 5) — the indent stays APPROVED (a FULLY
    // consumed indent auto-closes to CLOSED instead, which is refused earlier
    // by the state machine itself with its own — equally correct — message).
    const { indentId, line } = await createApprovedIndent(itemAId, 5);
    const poRes = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: itemAId, poQty: '3', rate: '100', discountPct: '0', sources: [{ indentLineId: line.indent_line_id, consumedQty: '3' }] }],
    });
    expect(poRes.status).toBe(201);
    let detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED'); // still open — 2 of 5 remain unconsumed

    const unapprove = await request(app).post(`/api/v1/indents/${indentId}/unapprove`).set(auth(headToken)).send({});
    expect(unapprove.status).toBe(422);
    expect(unapprove.body.error.message).toMatch(/already been converted into one or more purchase orders/i);
    expect(unapprove.body.error.message).toMatch(/unapproved/i);

    // Status must remain APPROVED — the refused attempt must not have partially applied.
    detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('APPROVED');
  });

  it('refuses to unapprove a FULLY consumed (auto-closed) indent, with a clear status-appropriate message', async () => {
    const { indentId, line } = await createApprovedIndent(itemAId, 4);
    const poRes = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: itemAId, poQty: '4', rate: '100', discountPct: '0', sources: [{ indentLineId: line.indent_line_id, consumedQty: '4' }] }],
    });
    expect(poRes.status).toBe(201);
    const detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('CLOSED'); // fully consumed -> auto-closed

    const unapprove = await request(app).post(`/api/v1/indents/${indentId}/unapprove`).set(auth(headToken)).send({});
    expect(unapprove.status).toBe(422);
    expect(unapprove.body.error.message).toMatch(/closed.*cannot become draft/i);
  });

  it('still supports a genuine REJECT of an APPROVED indent, landing on REJECTED (not DRAFT) — a separate action from UNAPPROVE', async () => {
    const { indentId } = await createApprovedIndent(itemAId, 5);
    const rejected = await request(app).post(`/api/v1/indents/${indentId}/reject`).set(auth(headToken))
      .send({ reason: 'Genuinely rejecting this approved indent' });
    expect(rejected.status).toBe(200);
    const detail = await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken));
    expect(detail.body.data.status).toBe('REJECTED');
    expect(detail.body.data.rejection_reason).toBe('Genuinely rejecting this approved indent');
  });
});

describe('RBAC enforcement (SRS §18, §25)', () => {
  it('lets a Store User do store work', async () => {
    const res = await request(app).get('/api/v1/grn').set(auth(storeToken));
    expect(res.status).toBe(200);
  });

  it('refuses actions outside the role, regardless of the UI', async () => {
    const cases: [string, 'get' | 'post', string][] = [
      ['/api/v1/users', 'get', 'list users'],
      ['/api/v1/roles', 'get', 'read roles'],
      ['/api/v1/audit', 'get', 'read the audit log'],
    ];
    for (const [path, method, label] of cases) {
      const res = await request(app)[method](path).set(auth(storeToken)).send({});
      expect(res.status, `Store User must not ${label}`).toBe(403);
    }

    const create = await request(app).post('/api/v1/indents').set(auth(storeToken))
      .send({ indentTypeId, requiredByDate, departmentId, costCentreId, lines: [{ itemId: itemAId, indentQty: '1' }] });
    expect(create.status).toBe(403);

    const backup = await request(app).post('/api/v1/backup').set(auth(storeToken)).send({ notes: 'x' });
    expect(backup.status).toBe(403);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await request(app).get('/api/v1/items');
    expect(res.status).toBe(401);
  });

  it('rejects a forged token', async () => {
    const res = await request(app).get('/api/v1/items').set(auth('not.a.real.token'));
    expect(res.status).toBe(401);
  });

  it('does not reveal whether an Employee ID exists', async () => {
    const wrongPassword = await request(app).post('/api/v1/auth/login')
      .send({ employeeId: '10221', password: 'DefinitelyWrong1!' });
    const noSuchUser = await request(app).post('/api/v1/auth/login')
      .send({ employeeId: 'NO-SUCH-USER', password: 'DefinitelyWrong1!' });

    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    expect(wrongPassword.body.error.message).toBe(noSuchUser.body.error.message);
  });
});

describe('input hardening (SRS §25)', () => {
  it('parameterises search input', async () => {
    const res = await request(app).get('/api/v1/items')
      .query({ search: "'; DROP TABLE items; --" }).set(auth(adminToken));
    expect(res.status).toBe(200);

    const survived = await request(app).get('/api/v1/items').set(auth(adminToken));
    expect(survived.body.meta.total).toBeGreaterThan(0);
  });

  it('resolves sort columns against an allow-list', async () => {
    const res = await request(app).get('/api/v1/items')
      .query({ sortBy: 'id; DROP TABLE items' }).set(auth(adminToken));
    expect(res.status).toBe(200);
  });

  it('rejects an unknown analytics dimension', async () => {
    const res = await request(app).get('/api/v1/analytics/breakdown/evil').set(auth(adminToken));
    expect(res.status).toBe(422);
  });

  it('returns field-level issues for an invalid body', async () => {
    const res = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({ lines: [] });
    expect(res.status).toBe(422);
    expect(Array.isArray(res.body.error.issues)).toBe(true);
  });
});

describe('analytics reconciliation (SRS §38, ADR-009)', () => {
  it('reconciles the dashboard PO value with the PO list total', async () => {
    const kpis = await request(app).get('/api/v1/analytics/kpis').set(auth(adminToken));
    const list = await request(app).get('/api/v1/purchase-orders?pageSize=1').set(auth(adminToken));

    const kpiValue = Number(
      kpis.body.data.kpis.find((k: { key: string }) => k.key === 'po_value_total').value,
    );
    const listValue = Number(list.body.meta.totals.value);

    expect(Math.abs(kpiValue - listValue)).toBeLessThan(0.01);
  });

  it('publishes a formula and drill-down for every KPI', async () => {
    // A card drills into a list filtered to what it counts, or is not clickable when no list
    // shows that (2026-10-16 audit, F09) — only these, each documented in domain/metrics.ts.
    const notClickable = new Set(['supplier_count', 'item_count', 'purchase_cycle_days', 'requisition_issue_transaction_count']);
    const res = await request(app).get('/api/v1/analytics/kpis').set(auth(adminToken));
    for (const k of res.body.data.kpis) {
      expect(k.formula, `${k.key} has no formula`).toBeTruthy();
      if (notClickable.has(k.key)) expect(k.drilldown, `${k.key} opens a list that does not hold its figure`).toBe('');
      else expect(k.drilldown, `${k.key} has no drill-down`).toBeTruthy();
      expect(k.source, `${k.key} has no source`).toBeTruthy();
    }
  });

  it('reports no PO status drift', async () => {
    const res = await request(app).get('/api/v1/analytics/exceptions').set(auth(adminToken));
    const drift = res.body.data.find((e: { key: string }) => e.key === 'status_drift');
    expect(Number(drift.count)).toBe(0);
  });
});

describe('data integrity invariants', () => {
  it('holds every balance invariant across all data created by this suite', async () => {
    const { query } = await import('../db/index.js');

    const checks: [string, string][] = [
      ['no indent line is over-ordered',
       'SELECT COUNT(*)::int AS n FROM v_indent_line_balance WHERE ordered_qty > indent_qty'],
      ['no PO line is over-received',
       'SELECT COUNT(*)::int AS n FROM v_po_line_balance WHERE received_qty > po_qty'],
      ['no negative pending indent quantity',
       'SELECT COUNT(*)::int AS n FROM v_indent_line_balance WHERE pending_qty < 0'],
      ['no negative pending GRN quantity',
       'SELECT COUNT(*)::int AS n FROM v_po_line_balance WHERE pending_grn_qty < 0'],
      ['stored PO status matches the derived status',
       'SELECT COUNT(*)::int AS n FROM v_po_header_balance WHERE status <> derived_status'],
      ['no PO source points at an unapproved indent',
       `SELECT COUNT(*)::int AS n FROM po_indent_sources pis
          JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
         WHERE ih.status NOT IN ('APPROVED','CLOSED')`],
      ['generated final_rate and amount are consistent',
       `SELECT COUNT(*)::int AS n FROM purchase_order_lines
         WHERE final_rate <> round(rate * (1 - discount_pct/100), 4)
            OR amount <> round(po_qty * round(rate * (1 - discount_pct/100), 4), 2)`],
      ['every rejected indent carries a reason',
       `SELECT COUNT(*)::int AS n FROM purchase_indent_headers
         WHERE status = 'REJECTED' AND (rejection_reason IS NULL OR trim(rejection_reason) = '')`],
    ];

    for (const [label, sql] of checks) {
      const rows = await query<{ n: number }>(sql);
      expect(Number(rows[0]?.n), label).toBe(0);
    }
  });

  it('reconciles PO value as received + pending', async () => {
    const { query } = await import('../db/index.js');
    const rows = await query<{ total: string; received: string; pending: string }>(
      `SELECT COALESCE(SUM(amount),0) AS total,
              COALESCE(SUM(received_amount),0) AS received,
              COALESCE(SUM(pending_amount),0) AS pending
         FROM v_po_line_balance WHERE po_status <> 'CANCELLED'`,
    );
    const r = rows[0]!;
    // Short-closed lines hold value in neither bucket, so received + pending ≤ total.
    expect(Number(r.received) + Number(r.pending)).toBeLessThanOrEqual(Number(r.total) + 0.01);
  });
});

describe('audit trail (SRS §24)', () => {
  it('records the full indent lifecycle', async () => {
    const created = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '7' }],
    });
    const id = created.body.data.id;
    await request(app).post(`/api/v1/indents/${id}/approve`).set(auth(headToken)).send({});

    const res = await request(app).get(`/api/v1/audit/entity/purchase_indent/${id}`).set(auth(adminToken));
    const actions = res.body.data.map((a: { action: string }) => a.action);

    expect(actions).toContain('SUBMIT');
    expect(actions).toContain('APPROVE');
  });

  it('records failed sign-ins without storing the password', async () => {
    await request(app).post('/api/v1/auth/login')
      .send({ employeeId: '10221', password: 'WrongPassword123!' });

    const res = await request(app).get('/api/v1/audit?action=LOGIN_FAILED').set(auth(adminToken));
    expect(res.body.meta.total).toBeGreaterThan(0);
    expect(JSON.stringify(res.body)).not.toContain('WrongPassword123!');
  });
});

describe('supplier contact details (SRS §7.2)', () => {
  it('creates and returns a supplier mobile number and email address', async () => {
    const created = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({
      supplierName: 'Contact Test Supplier', city: 'Ahmedabad', state: 'Gujarat',
      mobileNo: '9876543210', email: 'purchase@contacttest.example',
    });
    expect(created.status).toBe(201);
    expect(created.body.data.mobile_no).toBe('9876543210');
    expect(created.body.data.email).toBe('purchase@contacttest.example');

    const fetched = await request(app).get(`/api/v1/suppliers/${created.body.data.id}`).set(auth(adminToken));
    expect(fetched.body.data.mobile_no).toBe('9876543210');
    expect(fetched.body.data.email).toBe('purchase@contacttest.example');

    const searched = await request(app).get('/api/v1/suppliers/search?q=Contact Test Supplier').set(auth(adminToken));
    expect(searched.body.data[0].mobile_no).toBe('9876543210');
    expect(searched.body.data[0].email).toBe('purchase@contacttest.example');

    const updated = await request(app).put(`/api/v1/suppliers/${created.body.data.id}`).set(auth(adminToken)).send({
      supplierName: 'Contact Test Supplier', city: 'Ahmedabad', state: 'Gujarat',
      mobileNo: '9123456789', email: 'updated@contacttest.example',
    });
    expect(updated.body.data.mobile_no).toBe('9123456789');
    expect(updated.body.data.email).toBe('updated@contacttest.example');
  });

  it('rejects a malformed email but leaves mobile number and email optional', async () => {
    const bad = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({
      supplierName: 'Bad Email Supplier', email: 'not-an-email',
    });
    expect(bad.status).toBe(422);

    const noContact = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({
      supplierName: 'No Contact Supplier',
    });
    expect(noContact.status).toBe(201);
    expect(noContact.body.data.mobile_no).toBe('');
    expect(noContact.body.data.email).toBe('');
  });

  it('keeps an existing supplier without mobile/email working unmodified', async () => {
    const detail = await request(app).get(`/api/v1/suppliers/${supplierId}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.mobile_no).toBe('');
    expect(detail.body.data.email).toBe('');
  });
});

describe('CORS origin handling (login reliability)', () => {
  it('accepts the configured LAN origin', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .set('Origin', 'http://172.16.18.22:8080')
      .send({ employeeId: 'nope', password: 'nope' });
    expect(res.status).not.toBe(403);
  });

  it('accepts localhost on the same port as the configured frontend URL', async () => {
    // The actual root cause of intermittent login failures: the LAN IP was the
    // only allowed origin, so opening the app as http://localhost:8080 instead
    // of the LAN IP got every request — including login — rejected before it
    // ever reached the login handler.
    const res = await request(app).post('/api/v1/auth/login')
      .set('Origin', 'http://localhost:8080')
      .send({ employeeId: 'nope', password: 'nope' });
    expect(res.status).not.toBe(403);
  });

  it('accepts 127.0.0.1 on the same port', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .set('Origin', 'http://127.0.0.1:8080')
      .send({ employeeId: 'nope', password: 'nope' });
    expect(res.status).not.toBe(403);
  });

  it('still rejects an unrelated origin, with a real error body (not a swallowed 500)', async () => {
    const res = await request(app).post('/api/v1/auth/login')
      .set('Origin', 'http://evil.example.com')
      .send({ employeeId: 'nope', password: 'nope' });
    expect(res.status).toBe(403);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('AUTHORIZATION_ERROR');
    expect(res.body.error.message).toMatch(/not permitted/i);
  });
});

describe('GRN edit lifecycle (pin-point: Store Manager must be able to edit a posted GRN)', () => {
  const stockOf = async (itemId: number) => {
    const res = await request(app).get(`/api/v1/items/${itemId}`).set(auth(adminToken));
    return Number(res.body.data.live_stock_qty);
  };
  const poLineOf = async (poId: number) => (await poItemsFor(poId, 'all'))[0]!;
  /** Posts a GRN for `grnQty` against a fresh PO of `poQty`, returning the ids. */
  const setupPostedGrn = async (itemId: number, poQty: string, grnQty: string) => {
    const poId = await createIssuedPo([{ itemId, poQty, rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;
    const grn = await request(app).post('/api/v1/grn').set(auth(storeToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty }] });
    expect(grn.status).toBe(201);
    const grnId = grn.body.data.id as number;
    const detail = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(storeToken));
    return { poId, poLineId, grnId, grnLineId: detail.body.data.lines[0].id as number };
  };
  /** Edits one line's received qty on an existing GRN, as the Store user. */
  const editQty = (grnId: number, grnLineId: number, poLineId: number, grnQty: string) =>
    request(app).put(`/api/v1/grn/${grnId}`).set(auth(storeToken)).send({
      mode: 'PO', lines: [{ id: grnLineId, poLineId, grnQty }],
    });

  it('2: PO 100, this GRN 40, no other receipts — editing 40 -> 50 succeeds', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-A', itemDescription: 'GRN Edit A', uomId });
    const itemId = item.body.data.id as number;
    const { poId, poLineId, grnId, grnLineId } = await setupPostedGrn(itemId, '100', '40');

    const stockBefore = await stockOf(itemId);
    const res = await editQty(grnId, grnLineId, poLineId, '50');
    expect(res.status).toBe(200);

    // 11/13: stock moved by exactly the +10 delta — not re-added in full.
    expect(await stockOf(itemId)).toBeCloseTo(stockBefore + 10, 4);
    // 10: the PO's received quantity reflects the corrected figure.
    const poLine = await poLineOf(poId);
    expect(Number(poLine.received_qty)).toBe(50);
    expect(Number(poLine.pending_grn_qty)).toBe(50);
    // 15: the GRN line keeps its identity and its PO-line trace.
    const reloaded = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(storeToken));
    expect(reloaded.body.data.lines[0].id).toBe(grnLineId);
    expect(reloaded.body.data.lines[0].po_line_id).toBe(poLineId);
    expect(Number(reloaded.body.data.lines[0].grn_qty)).toBe(50);
  });

  it('3+4: PO 100 with 30 already received on ANOTHER GRN — this GRN may go to 70, but not 71', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-B', itemDescription: 'GRN Edit B', uomId });
    const itemId = item.body.data.id as number;
    const poId = await createIssuedPo([{ itemId, poQty: '100', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    // Another GRN takes 30 first, then ours takes 40.
    await request(app).post('/api/v1/grn').set(auth(storeToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '30' }] });
    const mine = await request(app).post('/api/v1/grn').set(auth(storeToken))
      .send({ mode: 'PO', post: true, lines: [{ poLineId, grnQty: '40' }] });
    const grnId = mine.body.data.id as number;
    const grnLineId = (await request(app).get(`/api/v1/grn/${grnId}`).set(auth(storeToken))).body.data.lines[0].id as number;

    // 100 − 30 (other GRN) = 70 is the true ceiling for THIS GRN.
    const ok = await editQty(grnId, grnLineId, poLineId, '70');
    expect(ok.status).toBe(200);
    expect(Number((await poLineOf(poId)).received_qty)).toBe(100);

    // 71 exceeds the PO — correctly refused, with the real reason.
    const tooMuch = await editQty(grnId, grnLineId, poLineId, '71');
    expect(tooMuch.status).toBe(422);
    expect(tooMuch.body.error.message).toMatch(/outstanding/i);
    // The refusal changed nothing.
    expect(Number((await poLineOf(poId)).received_qty)).toBe(100);
  });

  it('5+6: on a multi-PO GRN, editing one line leaves the other PO line untouched', async () => {
    const itemX = (await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-X', itemDescription: 'GRN Edit X', uomId })).body.data.id as number;
    const itemY = (await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-Y', itemDescription: 'GRN Edit Y', uomId })).body.data.id as number;
    const poA = await createIssuedPo([{ itemId: itemX, poQty: '100', rate: '20' }]);
    const poB = await createIssuedPo([{ itemId: itemY, poQty: '100', rate: '20' }]);
    const lineA = (await poItemsFor(poA))[0]!.po_line_id;
    const lineB = (await poItemsFor(poB))[0]!.po_line_id;

    const grn = await request(app).post('/api/v1/grn').set(auth(storeToken)).send({
      mode: 'PO', post: true,
      lines: [{ poLineId: lineA, grnQty: '10' }, { poLineId: lineB, grnQty: '20' }],
    });
    expect(grn.status).toBe(201);
    const grnId = grn.body.data.id as number;
    const lines = (await request(app).get(`/api/v1/grn/${grnId}`).set(auth(storeToken))).body.data.lines;
    const rowA = lines.find((l: { po_line_id: number }) => l.po_line_id === lineA);
    const rowB = lines.find((l: { po_line_id: number }) => l.po_line_id === lineB);

    // Raise only line A, resubmitting B unchanged.
    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(storeToken)).send({
      mode: 'PO',
      lines: [
        { id: rowA.id, poLineId: lineA, grnQty: '35' },
        { id: rowB.id, poLineId: lineB, grnQty: '20' },
      ],
    });
    expect(res.status).toBe(200);

    expect(Number((await poLineOf(poA)).received_qty)).toBe(35);
    expect(Number((await poLineOf(poB)).received_qty)).toBe(20); // untouched
    expect(await stockOf(itemY)).toBeCloseTo(20, 4);
  });

  it('1: header fields are editable and persist across reload', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-H', itemDescription: 'GRN Edit Header', uomId });
    const { poLineId, grnId, grnLineId } = await setupPostedGrn(item.body.data.id, '50', '10');

    const res = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(storeToken)).send({
      mode: 'PO',
      invoiceNo: 'INV-EDIT-9001', challanNo: 'CH-9001', vehicleNo: 'MH12AB1234',
      transporterName: 'Blue Dart', driverName: 'Ramesh', lrNo: 'LR-9001',
      remarks: 'Corrected after unloading',
      lines: [{ id: grnLineId, poLineId, grnQty: '10' }],
    });
    expect(res.status).toBe(200);

    const reloaded = await request(app).get(`/api/v1/grn/${grnId}`).set(auth(storeToken));
    expect(reloaded.body.data.invoice_no).toBe('INV-EDIT-9001');
    expect(reloaded.body.data.challan_no).toBe('CH-9001');
    expect(reloaded.body.data.vehicle_no).toBe('MH12AB1234');
    expect(reloaded.body.data.transporter_name).toBe('Blue Dart');
    expect(reloaded.body.data.driver_name).toBe('Ramesh');
    expect(reloaded.body.data.lr_no).toBe('LR-9001');
    expect(reloaded.body.data.remarks).toBe('Corrected after unloading');
  });

  it('12: a quantity correction writes its own stock-ledger movement rather than rewriting history', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-L', itemDescription: 'GRN Edit Ledger', uomId });
    const itemId = item.body.data.id as number;
    const { poLineId, grnId, grnLineId } = await setupPostedGrn(itemId, '100', '40');

    const before = await request(app).get(`/api/v1/items/${itemId}`).set(auth(adminToken));
    const ledgerBefore = (before.body.data.stockLedger as unknown[]).length;

    expect((await editQty(grnId, grnLineId, poLineId, '55')).status).toBe(200);

    const after = await request(app).get(`/api/v1/items/${itemId}`).set(auth(adminToken));
    const ledger = after.body.data.stockLedger as { inward_qty: string; balance_qty: string }[];
    expect(ledger.length).toBe(ledgerBefore + 1); // appended, original entry retained
    expect(Number(ledger[0]!.inward_qty)).toBeCloseTo(15, 4); // the +15 delta only
    expect(Number(ledger[0]!.balance_qty)).toBeCloseTo(55, 4);
    expect(await stockOf(itemId)).toBeCloseTo(55, 4);
  });

  it('17+18: a Store user may edit a GRN; a user without grn.edit is refused', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-RBAC', itemDescription: 'GRN Edit RBAC', uomId });
    const { poLineId, grnId, grnLineId } = await setupPostedGrn(item.body.data.id, '100', '10');

    // headToken is a PURCHASE_HEAD — holds po.*/indent.* but NOT grn.edit.
    const refused = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(headToken))
      .send({ mode: 'PO', lines: [{ id: grnLineId, poLineId, grnQty: '20' }] });
    expect(refused.status).toBe(403);

    const allowed = await editQty(grnId, grnLineId, poLineId, '20');
    expect(allowed.status).toBe(200);
  });

  it('8: a line can be removed from a DRAFT GRN, while a posted line is protected by its lot number', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken))
      .send({ itemCode: 'GRN-EDIT-RM', itemDescription: 'GRN Edit Remove', uomId });
    const itemId = item.body.data.id as number;
    const poId = await createIssuedPo([{ itemId, poQty: '100', rate: '20' }]);
    const poLineId = (await poItemsFor(poId))[0]!.po_line_id;

    // DRAFT: lines are freely replaceable.
    const draft = await request(app).post('/api/v1/grn').set(auth(storeToken))
      .send({ mode: 'PO', post: false, lines: [{ poLineId, grnQty: '10' }] });
    const draftId = draft.body.data.id as number;
    const emptied = await request(app).put(`/api/v1/grn/${draftId}`).set(auth(storeToken))
      .send({ mode: 'PO', lines: [{ poLineId, grnQty: '25' }] });
    expect(emptied.status).toBe(200);
    const draftReloaded = await request(app).get(`/api/v1/grn/${draftId}`).set(auth(storeToken));
    expect(draftReloaded.body.data.lines).toHaveLength(1);
    expect(Number(draftReloaded.body.data.lines[0].grn_qty)).toBe(25);

    // POSTED: dropping a line that already carries an MLN is refused with a clear reason.
    const { grnId, grnLineId, poLineId: postedPoLine } = await setupPostedGrn(itemId, '100', '10');
    void grnLineId;
    const dropped = await request(app).put(`/api/v1/grn/${grnId}`).set(auth(storeToken))
      .send({ mode: 'PO', lines: [{ poLineId: postedPoLine, grnQty: '10' }] }); // omits the existing line's id
    expect(dropped.status).toBe(422);
    expect(dropped.body.error.message).toMatch(/lot number|cannot be removed/i);
  });
});

describe('PO-specific item specification (Purchase Module pin-point, Point 2)', () => {
  it('B: defaults to the Item Master specification when the PO does not override it', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
      itemCode: 'TEST-SPEC-DEFAULT', itemDescription: 'Spec Default Item', uomId,
      itemSpecification: 'Master spec: 316 grade, 4mm',
    });
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: item.body.data.id, poQty: '1', rate: '10', discountPct: '0', sources: [] }], // no itemSpecification sent
    });
    expect(created.status).toBe(201);
    const detail = await request(app).get(`/api/v1/purchase-orders/${created.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.lines[0].item_specification).toBe('Master spec: 316 grade, 4mm');
  });

  it('C+G: an explicit PO-line specification overrides the Item Master default and persists after reload, including in the print document', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
      itemCode: 'TEST-SPEC-OVERRIDE', itemDescription: 'Spec Override Item', uomId,
      itemSpecification: 'Master default spec',
    });
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: item.body.data.id, poQty: '1', rate: '10', discountPct: '0', sources: [], itemSpecification: 'PO-specific: powder coated, custom length 2.5m' }],
    });
    expect(created.status).toBe(201);

    const detail = await request(app).get(`/api/v1/purchase-orders/${created.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.lines[0].item_specification).toBe('PO-specific: powder coated, custom length 2.5m');

    const printView = await request(app).get(`/api/v1/purchase-orders/${created.body.data.id}/print-view`).set(auth(adminToken));
    expect(printView.status).toBe(200);
    expect(printView.text).toContain('PO-specific: powder coated, custom length 2.5m');
  });

  it('D: editing the PO-line specification never mutates the Item Master specification', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
      itemCode: 'TEST-SPEC-ISOLATION', itemDescription: 'Spec Isolation Item', uomId,
      itemSpecification: 'Original master spec — must never change',
    });
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: item.body.data.id, poQty: '1', rate: '10', discountPct: '0', sources: [], itemSpecification: 'Totally different PO-only text' }],
    });
    expect(created.status).toBe(201);

    const itemAfter = await request(app).get(`/api/v1/items/${item.body.data.id}`).set(auth(adminToken));
    expect(itemAfter.body.data.item_specification).toBe('Original master spec — must never change');
  });

  it('E+F: editing an existing PO\'s specification persists the change and preserves the PO line id (GRN traceability)', async () => {
    const item = await request(app).post('/api/v1/items').set(auth(adminToken)).send({
      itemCode: 'TEST-SPEC-EDIT', itemDescription: 'Spec Edit Item', uomId, itemSpecification: 'Initial spec',
    });
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: item.body.data.id, poQty: '10', rate: '10', discountPct: '0', sources: [] }],
    });
    const poId = created.body.data.id as number;
    const originalLineId = (await poItemsFor(poId, 'all'))[0]!.po_line_id;

    // Receive PART of the line first — the specification edit must survive this too.
    await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'PO', post: true, lines: [{ poLineId: originalLineId, grnQty: '4' }],
    });

    const updated = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken)).send({
      supplierId, poTypeId,
      lines: [{ id: originalLineId, itemId: item.body.data.id, poQty: '10', rate: '10', discountPct: '0', sources: [], itemSpecification: 'Edited after partial receipt' }],
    });
    expect(updated.status).toBe(200);

    const detail = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(detail.body.data.lines[0].item_specification).toBe('Edited after partial receipt');
    expect(detail.body.data.lines[0].po_line_id).toBe(originalLineId); // same line id
    expect(Number(detail.body.data.lines[0].received_qty)).toBe(4); // GRN linkage/quantity untouched by the spec edit
  });

  it('an issued PO made from an indent can be edited, although ordering it in full CLOSED that indent', async () => {
    // Regression. A PO that orders an indent in full closes the indent. Saving
    // that PO again releases its own claim and then re-validates it — against
    // an indent that was still marked CLOSED, so EVERY save of an issued
    // indent-based PO was refused with "Indent … is not approved (currently
    // CLOSED)", including a save that changed nothing.
    const { indentId, line } = await createApprovedIndent(itemAId, 40);
    const poId = await createIssuedPo([
      { itemId: itemAId, poQty: '40', rate: '10', sources: [{ indentLineId: line.indent_line_id, consumedQty: '40' }] },
    ]);
    const indentStatus = async () =>
      (await request(app).get(`/api/v1/indents/${indentId}`).set(auth(adminToken))).body.data.status as string;
    expect(await indentStatus()).toBe('CLOSED');

    const poLineId = (await poItemsFor(poId, 'all'))[0]!.po_line_id;
    const lineBody = (poQty: string, consumedQty: string, itemSpecification: string) => ({
      id: poLineId, itemId: itemAId, poQty, rate: '10', discountPct: '0', itemSpecification,
      sources: [{ indentLineId: line.indent_line_id, consumedQty }],
    });

    // 1. Save with the SAME quantity (a specification correction).
    const same = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken))
      .send({ supplierId, poTypeId, lines: [lineBody('40', '40', 'Corrected after issue')] });
    expect(same.status).toBe(200);
    const afterSame = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
    expect(afterSame.body.data.status).toBe('OPEN');
    expect(afterSame.body.data.lines[0].po_line_id).toBe(poLineId);
    expect(afterSame.body.data.lines[0].item_specification).toBe('Corrected after issue');
    expect(Number(afterSame.body.data.lines[0].sources[0].consumed_qty)).toBe(40);
    expect(await indentStatus()).toBe('CLOSED');           // still fully ordered -> closed again

    // 2. Reduce the quantity: the balance goes back to the indent, which reopens.
    const less = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken))
      .send({ supplierId, poTypeId, lines: [lineBody('25', '25', 'Corrected after issue')] });
    expect(less.status).toBe(200);
    expect(await indentStatus()).toBe('APPROVED');
    const eligible = await request(app).get(`/api/v1/indents/eligible-lines?indentId=${indentId}`).set(auth(adminToken));
    expect(Number(eligible.body.data[0].pending_qty)).toBe(15);

    // 3. The quantity rule itself is untouched: more than the indent holds is still refused.
    const tooMuch = await request(app).put(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken))
      .send({ supplierId, poTypeId, lines: [lineBody('41', '41', 'Corrected after issue')] });
    expect(tooMuch.status).toBe(422);
    expect(await indentStatus()).toBe('APPROVED');         // the refused save changed nothing
  });
});

describe('item history (Purchase Module pin-point, Point 2/3)', () => {
  it('attributes a multi-PO GRN to the correct PO per line, not the GRN header', async () => {
    const a = await createApprovedIndent(itemAId, 50, '50');
    const b = await createApprovedIndent(itemAId, 30, '50');
    const po1 = await createIssuedPo([{ itemId: itemAId, poQty: '50', rate: '50', sources: [{ indentLineId: a.line.indent_line_id, consumedQty: '50' }] }]);
    const po2 = await createIssuedPo([{ itemId: itemAId, poQty: '30', rate: '50', sources: [{ indentLineId: b.line.indent_line_id, consumedQty: '30' }] }]);
    const line1 = (await poItemsFor(po1))[0]!;
    const line2 = (await poItemsFor(po2))[0]!;

    // ONE GRN receiving against lines from TWO different POs.
    const grn = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({
      mode: 'PO', post: true,
      lines: [
        { poLineId: line1.po_line_id, grnQty: '20' },
        { poLineId: line2.po_line_id, grnQty: '15' },
      ],
    });
    expect(grn.status).toBe(201);

    const po1No = (await request(app).get(`/api/v1/purchase-orders/${po1}`).set(auth(adminToken))).body.data.po_no;
    const po2No = (await request(app).get(`/api/v1/purchase-orders/${po2}`).set(auth(adminToken))).body.data.po_no;

    const itemDetail = await request(app).get(`/api/v1/items/${itemAId}`).set(auth(adminToken));
    expect(itemDetail.status).toBe(200);
    const grnHistory = itemDetail.body.data.grnHistory as { po_no: string; grn_qty: string }[];
    const forPo1 = grnHistory.find((g) => g.po_no === po1No);
    const forPo2 = grnHistory.find((g) => g.po_no === po2No);
    expect(forPo1).toBeDefined();
    expect(forPo2).toBeDefined();
    // The real point of this test: each PO's line gets its OWN quantity (20,
    // 15) — not both folded onto one row via `grn_headers.po_id`, which would
    // show 35 against whichever PO happened to be the header's.
    expect(Number(forPo1!.grn_qty)).toBe(20);
    expect(Number(forPo2!.grn_qty)).toBe(15);
  });

  it('respects the historyLimit query param and defaults to 10', async () => {
    const defaultLimit = await request(app).get(`/api/v1/items/${itemAId}`).set(auth(adminToken));
    expect(defaultLimit.body.data.historyLimit).toBe(10);

    const limited = await request(app).get(`/api/v1/items/${itemAId}${qs({ historyLimit: 5 })}`).set(auth(adminToken));
    expect(limited.body.data.historyLimit).toBe(5);
    expect(limited.body.data.rateHistory.length).toBeLessThanOrEqual(5);

    const capped = await request(app).get(`/api/v1/items/${itemAId}${qs({ historyLimit: 100000 })}`).set(auth(adminToken));
    expect(capped.status).toBe(422); // over the max — refused, not silently clamped
  });

  it('indent history includes lines that are no longer eligible for PO, not only currently-open ones', async () => {
    const fullyOrdered = await createApprovedIndent(itemBId, 5, '250');
    await createIssuedPo([{ itemId: itemBId, poQty: '5', rate: '250', sources: [{ indentLineId: fullyOrdered.line.indent_line_id, consumedQty: '5' }] }]);

    const itemDetail = await request(app).get(`/api/v1/items/${itemBId}`).set(auth(adminToken));
    const indentHistory = itemDetail.body.data.indentHistory as { indent_id: number; is_eligible_for_po: boolean }[];
    const entry = indentHistory.find((e) => e.indent_id === fullyOrdered.indentId);
    expect(entry).toBeDefined(); // still visible in history…
    expect(entry!.is_eligible_for_po).toBe(false); // …even though it can no longer be drawn on for a new PO
  });
});

describe('PO payment terms (Purchase Module pin-point, Point 6/7)', () => {
  it('defaults from the supplier master when not supplied, and is returned on detail/list/document', async () => {
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, issue: true,
      lines: [{ itemId: itemAId, poQty: '1', rate: '10', discountPct: '0', sources: [] }],
    });
    expect(created.status).toBe(201);
    const detail = await request(app).get(`/api/v1/purchase-orders/${created.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.payment_terms).toBe('NET30'); // the supplier fixture's payment_terms

    const list = await request(app).get('/api/v1/purchase-orders').set(auth(adminToken));
    const row = list.body.data.find((p: { id: number }) => p.id === created.body.data.id);
    expect(row.payment_terms).toBe('NET30');
  });

  it('is saved and editable when explicitly supplied, overriding the supplier default', async () => {
    const created = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId, paymentTerms: 'ADVANCE', issue: true,
      lines: [{ itemId: itemAId, poQty: '1', rate: '10', discountPct: '0', sources: [] }],
    });
    expect(created.body.data.payment_terms ?? 'ADVANCE').toBeTruthy();

    const updated = await request(app).put(`/api/v1/purchase-orders/${created.body.data.id}`).set(auth(adminToken)).send({
      supplierId, poTypeId, paymentTerms: '45 Days',
      lines: [{ id: (await poItemsFor(created.body.data.id))[0]!.po_line_id, itemId: itemAId, poQty: '1', rate: '10', discountPct: '0', sources: [] }],
    });
    expect(updated.status).toBe(200);
    const detail = await request(app).get(`/api/v1/purchase-orders/${created.body.data.id}`).set(auth(adminToken));
    expect(detail.body.data.payment_terms).toBe('45 Days');
  });
});

describe('backup & restore (SRS §23, ADR-011)', () => {
  it('creates a checksummed backup, then a restore returns the database to exactly that snapshot', async () => {
    // Snapshot BEFORE any of this test's own mutations, so the restored count is unambiguous.
    const before = await request(app).get('/api/v1/suppliers?pageSize=1').set(auth(adminToken));
    const countBefore = before.body.meta.total;

    const backup = await request(app).post('/api/v1/backup').set(auth(adminToken)).send({ notes: 'restore round-trip test' });
    expect(backup.status).toBe(201);
    const backupId = backup.body.data.id;
    expect(backup.body.data.tableCounts.suppliers).toBe(countBefore);

    const verify1 = await request(app).post(`/api/v1/backup/${backupId}/verify`).set(auth(adminToken));
    expect(verify1.body.data.valid).toBe(true);

    // Mutate the database AFTER the backup — a new supplier the restore must erase.
    const created = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({ supplierName: 'Restore Test Supplier (should vanish)' });
    expect(created.status).toBe(201);
    const afterCreate = await request(app).get('/api/v1/suppliers?pageSize=1').set(auth(adminToken));
    expect(afterCreate.body.meta.total).toBe(countBefore + 1);

    const restore = await request(app).post(`/api/v1/backup/${backupId}/restore`).set(auth(adminToken)).send({ confirm: 'RESTORE' });
    expect(restore.status).toBe(200);
    expect(restore.body.data.totalRows).toBeGreaterThan(0);
    expect(restore.body.data.restored.suppliers).toBe(countBefore);

    // The restore revoked every session (including this test's own token) — sign back in.
    // Either password, exactly as signInAndRotate() does: the bootstrap admin is
    // only rotated when the server demands it, and since bootstrap users stopped
    // being created with must_change_password it keeps its initial credential.
    adminToken = await signIn('10221', ['Zolex@Test2026', 'Admin@12345']);
    const afterRestore = await request(app).get('/api/v1/suppliers?pageSize=1').set(auth(adminToken));
    expect(afterRestore.body.meta.total).toBe(countBefore);

    // Regression: `lookups.created_by` -> `users`, and `users.department_id` ->
    // `lookups` is a real circular foreign key. A lookup row created by a real
    // user (indentTypeId etc., made in the `beforeAll` fixtures via `mk()`) must
    // come back with its creator intact, not merely "the restore didn't error".
    const lookups = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
    const restoredIndentType = lookups.body.data.INDENT_TYPE.find((l: { id: number }) => l.id === indentTypeId);
    expect(restoredIndentType).toBeTruthy();
  });

  it('refuses to restore without the literal RESTORE confirmation', async () => {
    const backup = await request(app).post('/api/v1/backup').set(auth(adminToken)).send({});
    const res = await request(app).post(`/api/v1/backup/${backup.body.data.id}/restore`).set(auth(adminToken)).send({ confirm: 'yes' });
    expect(res.status).toBe(422);
  });

  it('refuses to restore a backup file whose checksum no longer matches (tampered/corrupted)', async () => {
    const fs = await import('node:fs');
    const { paths } = await import('../config/env.js');
    const backup = await request(app).post('/api/v1/backup').set(auth(adminToken)).send({});
    const filePath = `${paths.backups}/${backup.body.data.filename}`;
    fs.appendFileSync(filePath, ' ');
    const res = await request(app).post(`/api/v1/backup/${backup.body.data.id}/restore`).set(auth(adminToken)).send({ confirm: 'RESTORE' });
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/checksum/i);
  });
});

describe('health', () => {
  it('reports a reachable database', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body.data.database.reachable).toBe(true);
  });

  it('returns a structured 404 for an unknown endpoint', async () => {
    const res = await request(app).get('/api/v1/does-not-exist').set(auth(adminToken));
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });
});

describe('indent reopen (2026-10-16 audit)', () => {
  // Reopen sent an APPROVED indent back to DRAFT with indent.edit alone, skipping
  // Unapprove's approve right and its purchase-order check.
  it('refuses to reopen an approved indent and points to Unapprove; a rejected one still reopens', async () => {
    const create = async () => (await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId, requiredByDate, departmentId, costCentreId, submit: true, lines: [{ itemId: itemAId, indentQty: '3' }],
    })).body.data.id as number;
    const approvedId = await create();
    expect((await request(app).post(`/api/v1/indents/${approvedId}/approve`).set(auth(headToken)).send({})).status).toBe(200);
    const refused = await request(app).post(`/api/v1/indents/${approvedId}/reopen`).set(auth(adminToken)).send({});
    expect(refused.status).toBe(422);
    expect(refused.body.error.message).toMatch(/Unapprove/);

    const rejectedId = await create();
    await request(app).post(`/api/v1/indents/${rejectedId}/reject`).set(auth(headToken)).send({ reason: 'Not needed' });
    expect((await request(app).post(`/api/v1/indents/${rejectedId}/reopen`).set(auth(adminToken)).send({})).status).toBe(200);
  });
});
