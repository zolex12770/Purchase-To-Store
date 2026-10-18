/**
 * Integration tests — a KPI card opens a list filtered to exactly what its number counts,
 * or is not clickable (2026-10-16 audit, F09).
 *
 * Found on staging: 'Approved Qty Awaiting PO' (50) drilled to '/indents?eligibleOnly=true',
 * which the list ignored (1,814 indents); 'Received Quantity' (267) and 'Received Value'
 * (₹20,195) counted purchase-order receipts only while 2,716 of the 2,718 GRNs are direct
 * (the GRN list: 17,051,110.899 and ₹792,071,674.86); 'Active Suppliers' 88 opened all 1,403
 * suppliers and 'Items Purchased' 531 all 4,748 items. Pinned here:
 *
 *   1. Every drill target names only filters its list handles.
 *   2. Each count KPI equals the total of the list it opens, and each quantity or value
 *      KPI equals that list's own total tile, with no filter and under dashboard filters
 *      (merged as the screen merges them: the target's own parameters win).
 *   3. The GRN KPIs count posted receipts of every kind.
 *   4. KPIs no list can show are not clickable.
 *   5. Item-level filters (item, department, main group, HOD) select lines: orders,
 *      receipts and indents here mix items of two departments, and a card counts, and
 *      the list it opens shows, only the filtered lines (2026-10-17 review: filtered to
 *      a department, Pending POs showed 0 and opened a PO whose only pending line
 *      belonged to another department; Approved Qty Awaiting PO showed 10 and opened an
 *      empty list).
 *
 * Real PGlite database, migrated and seeded from scratch.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import type { Express } from 'express';
import type { z } from 'zod';

process.env.NODE_ENV = 'test';
process.env.SEED_DEMO_DATA = 'false';
process.env.LOG_LEVEL = 'silent';

type Q = <T = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;

let app: Express;
let closeDb: () => Promise<void>;
let query: Q;
let adminToken = '';
let headToken = '';
let hodToken = '';
const ids: Record<string, number> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
// A period around today wide enough for any time zone the documents are dated in.
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

interface Kpi { key: string; value: string | number; drilldown: string }

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

async function kpis(context: Record<string, string> = {}): Promise<Map<string, Kpi>> {
  const res = await request(app).get('/api/v1/analytics/kpis').query({ ...context, compare: 'false' }).set(auth(adminToken));
  expect(res.status).toBe(200);
  return new Map((res.body.data.kpis as Kpi[]).map((k) => [k.key, k]));
}

/** The screen routes with a view of their own (the list pages derive `view` from the path). */
const ROUTE_VIEWS: Record<string, [string, string]> = {
  '/purchase-orders/pending': ['/purchase-orders', 'pending'],
  '/purchase-orders/complete': ['/purchase-orders', 'complete'],
  '/requisitions/mine': ['/requisitions', 'mine'],
  '/requisitions/store-queue': ['/requisitions', 'store-queue'],
};

/**
 * The list a drill target opens, with the dashboard context merged as drilldownLink
 * (frontend lib/useFilters.ts) merges it: the target's own parameters win.
 */
async function drill(target: string, context: Record<string, string> = {}) {
  const [path = '', own = ''] = target.split('?');
  const sp = new URLSearchParams(own);
  for (const [k, v] of Object.entries(context)) if (!sp.has(k)) sp.set(k, v);
  const [apiPath, view] = ROUTE_VIEWS[path] ?? [path, undefined];
  if (view) sp.set('view', view);
  sp.set('pageSize', '200');
  const res = await request(app).get(`/api/v1${apiPath}?${sp.toString()}`).set(auth(adminToken));
  expect(res.status).toBe(200);
  return res.body as { data: Record<string, unknown>[]; meta: { total: number; totals: Record<string, string | number> } };
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
  query = db.query as Q;
  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  app = createApp();
  adminToken = await signInAndRotate('10221', 'Admin@12345', 'Zolex@Test2026');

  const options = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  const uomId = options.body.data.UOM[0].id as number;
  const mk = async (category: string, code: string, name: string) => {
    const res = await request(app).post(`/api/v1/lookups/${category}`).set(auth(adminToken)).send({ code, name });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  ids.indentType = await mk('INDENT_TYPE', 'KPI-IT', 'KPI Regular');
  ids.poType = await mk('PO_TYPE', 'KPI-PT', 'KPI Standard');
  ids.dept = await mk('DEPARTMENT', 'KPI-D', 'KPI Department');
  ids.dept2 = await mk('DEPARTMENT', 'KPI-D2', 'KPI Second Department');
  ids.cc = await mk('COST_CENTRE', 'KPI-CC', 'KPI Cost Centre');
  ids.mg = await mk('MAIN_GROUP', 'KPI-MG', 'KPI Cables');
  for (const [key, supplierName] of [['s1', 'KPI Supplier One'], ['s2', 'KPI Supplier Two']] as const) {
    const res = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({ supplierName, city: 'Pune', state: 'Maharashtra' });
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }
  // Cable belongs to the first department and the cables group, bolt to the second.
  for (const [key, itemCode, itemDescription, standardRate, master] of [
    ['a', 'KPI-CABLE', 'Copper cable', '100', { departmentId: ids.dept, mainGroupId: ids.mg }],
    ['b', 'KPI-BOLT', 'Hex bolt', '50', { departmentId: ids.dept2 }],
  ] as const) {
    const res = await request(app).post('/api/v1/items').set(auth(adminToken)).send({ itemCode, itemDescription, uomId, standardRate, ...master });
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }

  const roles = await request(app).get('/api/v1/roles').set(auth(adminToken));
  const roleId = (code: string) => roles.body.data.find((r: { code: string }) => r.code === code).id as number;
  for (const [key, employeeId, role] of [['head', 'KPI-HEAD', 'PURCHASE_HEAD'], ['hod', 'KPI-HOD', 'EMPLOYEE'], ['requester', 'KPI-REQ', 'EMPLOYEE']] as const) {
    const res = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
      employeeId, employeeName: employeeId, designation: 'Staff', password: 'Kpi@Test2026x', mustChangePassword: false,
      roleIds: [roleId(role)], departmentId: ids.dept,
    });
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }
  await request(app).put(`/api/v1/requisitions/departments/${ids.dept}/hod`).set(auth(adminToken)).send({ hodUserId: ids.hod });
  headToken = await signIn('KPI-HEAD', ['Kpi@Test2026x']);
  hodToken = await signIn('KPI-HOD', ['Kpi@Test2026x']);

  /* Indents: one approved and unordered, one approved and fully ordered, one pending, one cancelled. */
  const indentOf = async (departmentId: number, lines: Array<[number, string]>, submit: boolean) => {
    const res = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId: ids.indentType, requiredByDate: '2026-12-31', departmentId, costCentreId: ids.cc, submit,
      lines: lines.map(([itemId, indentQty]) => ({ itemId, indentQty, estimatedRate: '10' })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  const indent = (itemId: number, qty: string, submit: boolean) => indentOf(ids.dept, [[itemId, qty]], submit);
  const approve = async (id: number) => {
    const res = await request(app).post(`/api/v1/indents/${id}/approve`).set(auth(headToken)).send({});
    expect(res.status).toBe(200);
  };
  ids.indentOpen = await indent(ids.a, '10', true);
  await approve(ids.indentOpen);
  ids.indentOrdered = await indent(ids.b, '4', true);
  await approve(ids.indentOrdered);
  ids.indentPending = await indent(ids.a, '7', true);
  ids.indentCancelled = await indent(ids.b, '2', false);
  const cancelled = await request(app).post(`/api/v1/indents/${ids.indentCancelled}/cancel`).set(auth(adminToken)).send({ reason: 'Not needed' });
  expect(cancelled.status).toBe(200);
  const orderedLine = (await request(app).get(`/api/v1/indents/${ids.indentOrdered}`).set(auth(adminToken))).body.data.lines[0].indent_line_id;

  /* Purchase orders: overdue and pending, completed, a draft, a cancelled one, part-received. */
  const po = async (supplierId: number, line: Record<string, unknown>, issue = true) => {
    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId: ids.poType, issue, lines: [{ discountPct: '0', sources: [], ...line }],
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  ids.poOverdue = await po(ids.s1, { itemId: ids.a, poQty: '10', rate: '100', deliveryDate: '2026-01-15' });
  ids.poDone = await po(ids.s1, { itemId: ids.b, poQty: '4', rate: '50', sources: [{ indentLineId: orderedLine, consumedQty: '4' }] });
  ids.poDraft = await po(ids.s2, { itemId: ids.b, poQty: '3', rate: '50' }, false);
  ids.poCancelled = await po(ids.s2, { itemId: ids.a, poQty: '2', rate: '100' });
  const poCancel = await request(app).post(`/api/v1/purchase-orders/${ids.poCancelled}/cancel`).set(auth(adminToken)).send({ reason: 'Withdrawn' });
  expect(poCancel.status).toBe(200);
  ids.poPartial = await po(ids.s1, { itemId: ids.a, poQty: '6', rate: '100', deliveryDate: '2099-01-01' });

  /* GRNs: two against orders, a posted direct receipt, an unposted direct one. */
  const lineOf = async (poId: number, itemId?: number) => {
    const lines = (await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken))).body.data.lines as Array<{ po_line_id: number; item_id: number }>;
    return (itemId === undefined ? lines[0] : lines.find((l) => Number(l.item_id) === itemId))!.po_line_id;
  };
  const grn = async (body: Record<string, unknown>) => {
    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send(body);
    expect(res.status).toBe(201);
  };
  await grn({ mode: 'PO', post: true, lines: [{ poLineId: await lineOf(ids.poDone), grnQty: '4' }] });
  await grn({ mode: 'PO', post: true, lines: [{ poLineId: await lineOf(ids.poPartial), grnQty: '2' }] });
  await grn({ mode: 'DIRECT', supplierId: ids.s2, post: true, lines: [{ itemId: ids.b, grnQty: '5', rate: '40' }] });
  await grn({ mode: 'DIRECT', supplierId: ids.s1, post: false, lines: [{ itemId: ids.a, grnQty: '1', rate: '10' }] });

  /* Documents mixing both departments' items (the 2026-10-17 review's cases). */
  const poOf = async (supplierId: number, lines: Array<[number, string, string, string]>) => {
    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId: ids.poType, issue: true,
      lines: lines.map(([itemId, poQty, rate, deliveryDate]) => ({ itemId, poQty, rate, deliveryDate, discountPct: '0', sources: [] })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  // Cable received in full; the bolt line is still pending and past its delivery date.
  ids.poMixed = await poOf(ids.s1, [[ids.a, '5', '10', '2026-01-10'], [ids.b, '5', '10', '2026-01-10']]);
  await grn({ mode: 'PO', post: true, lines: [{ poLineId: await lineOf(ids.poMixed, ids.a), grnQty: '5' }] });
  // Both lines pending, neither overdue.
  ids.poBoth = await poOf(ids.s2, [[ids.a, '3', '100', '2099-01-01'], [ids.b, '2', '50', '2099-01-01']]);
  await grn({ mode: 'DIRECT', supplierId: ids.s2, post: true, lines: [{ itemId: ids.a, grnQty: '2', rate: '10' }, { itemId: ids.b, grnQty: '3', rate: '20' }] });
  // An indent of the second department for a first-department item, and one of the first
  // department for both items; both approved, nothing ordered.
  ids.indentD2 = await indentOf(ids.dept2, [[ids.a, '6']], true);
  await approve(ids.indentD2);
  ids.indentMixed = await indentOf(ids.dept, [[ids.a, '3'], [ids.b, '5']], true);
  await approve(ids.indentMixed);

  /* Requisitions: pending with the HOD, approved (on a machine), approved then cancelled, a draft. */
  ids.machine = await mk('MACHINE', 'KPI-M1', 'KPI Press 1');
  const requisition = async (submit: boolean, lines: Array<[number, string]>, machineId?: number) => {
    const res = await request(app).post('/api/v1/requisitions').set(auth(adminToken)).send({
      requesterUserId: ids.requester, costCentreId: ids.cc, submit, machineId,
      lines: lines.map(([itemId, requestedQty]) => ({ itemId, requestedQty })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  const hodApprove = async (id: number) => {
    const res = await request(app).post(`/api/v1/requisitions/${id}/approve`).set(auth(hodToken)).send({});
    expect(res.status).toBe(200);
  };
  await requisition(true, [[ids.a, '2'], [ids.b, '1']]);
  ids.reqApproved = await requisition(true, [[ids.b, '3']], ids.machine);
  await hodApprove(ids.reqApproved);
  ids.reqCancelled = await requisition(true, [[ids.a, '1']]);
  await hodApprove(ids.reqCancelled);
  const reqCancel = await request(app).post(`/api/v1/requisitions/${ids.reqCancelled}/cancel`).set(auth(adminToken)).send({ reason: 'Duplicate' });
  expect(reqCancel.status).toBe(200);
  await requisition(false, [[ids.a, '5']]);
}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

describe('Drill targets name only filters their list handles', () => {
  it('every parameter of every target is a key of the target list query', async () => {
    const { METRICS } = await import('../domain/metrics.js');
    const schemas: Record<string, z.AnyZodObject> = {
      '/purchase-orders': (await import('../modules/purchase-order/routes.js')).listSchema,
      '/indents': (await import('../modules/indent/routes.js')).listSchema,
      '/grn': (await import('../modules/grn/routes.js')).listSchema,
      '/requisitions': (await import('../modules/requisition/routes.js')).listSchema,
    };
    for (const m of METRICS.filter((x) => x.drilldown)) {
      const [path = '', own = ''] = m.drilldown.split('?');
      const listPath = ROUTE_VIEWS[path]?.[0] ?? path;
      const schema = schemas[listPath];
      expect(schema, `${m.key} drills to ${m.drilldown}, which is no filterable list`).toBeDefined();
      for (const key of new URLSearchParams(own).keys()) {
        expect(Object.keys(schema!.shape), `${m.key}: ${listPath} has no "${key}" filter`).toContain(key);
      }
    }
  });

  it('a KPI no list can show is not clickable', async () => {
    const k = await kpis();
    for (const key of ['supplier_count', 'item_count', 'purchase_cycle_days', 'requisition_issue_transaction_count']) {
      expect(k.get(key)?.drilldown, key).toBe('');
    }
  });
});

describe('Each KPI equals the list it opens', () => {
  // `__key__` stands for ids.key, known once the fixture exists.
  const contexts: Array<[string, Record<string, string>]> = [
    ['no filter', {}],
    ['a supplier and a period', { supplierId: '__s1__', dateFrom: day(-2), dateTo: day(2) }],
    ['a department', { departmentId: '__dept__' }],
    ['an item', { itemId: '__a__' }],
    ['a main group', { mainGroupId: '__mg__' }],
    ['an HOD', { hodId: '__hod__' }],
    ['a department and a supplier', { departmentId: '__dept__', supplierId: '__s2__' }],
    ['a department and a main group no single line has', { departmentId: '__dept2__', mainGroupId: '__mg__' }],
    // Requisition Analysis sends its machine filter; the requisition figures dropped it
    // while the list they open applied it (2026-10-17 review). Purchase figures ignore it.
    ['a machine', { machineId: '__machine__' }],
  ];

  for (const [name, raw] of contexts) {
    describe(name, () => {
      const ctx = () => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /^__\w+__$/.test(v) ? String(ids[v.slice(2, -2)]) : v]));

      it('purchase orders: counts, value, quantity, pending, overdue, completed', async () => {
        const k = await kpis(ctx());
        const all = await drill(k.get('po_count')!.drilldown, ctx());
        expect(Number(k.get('po_count')!.value)).toBe(all.meta.total);
        expect(Number(k.get('po_value_total')!.value)).toBe(Number(all.meta.totals.value));
        expect(Number(k.get('po_qty_total')!.value)).toBe(Number(all.meta.totals.totalPoQty));
        const pending = await drill(k.get('po_pending_count')!.drilldown, ctx());
        expect(Number(k.get('po_pending_count')!.value)).toBe(pending.meta.total);
        expect(Number(k.get('po_pending_value')!.value)).toBe(Number(pending.meta.totals.pending));
        expect(Number(k.get('grn_pending_qty')!.value)).toBe(Number(pending.meta.totals.totalPendingQty));
        const overdue = await drill(k.get('po_overdue_count')!.drilldown, ctx());
        expect(Number(k.get('po_overdue_count')!.value)).toBe(overdue.meta.total);
        const completed = await drill(k.get('po_completed_count')!.drilldown, ctx());
        expect(Number(k.get('po_completed_count')!.value)).toBe(completed.meta.total);
      });

      it('goods receipts: posted receipts of every kind', async () => {
        const k = await kpis(ctx());
        const posted = await drill(k.get('grn_count')!.drilldown, ctx());
        expect(Number(k.get('grn_count')!.value)).toBe(posted.meta.total);
        expect(Number(k.get('grn_qty_total')!.value)).toBe(Number(posted.meta.totals.totalQty));
        expect(Number(k.get('grn_value_total')!.value)).toBe(Number(posted.meta.totals.totalAmount));
      });

      it('indents: total, pending approval and its value, and the quantity awaiting a purchase order', async () => {
        const k = await kpis(ctx());
        const all = await drill(k.get('indent_count')!.drilldown, ctx());
        expect(Number(k.get('indent_count')!.value)).toBe(all.meta.total);
        const pending = await drill(k.get('indent_pending_approval')!.drilldown, ctx());
        expect(Number(k.get('indent_pending_approval')!.value)).toBe(pending.meta.total);
        expect(k.get('indent_pending_value')!.drilldown).toBe(k.get('indent_pending_approval')!.drilldown);
        expect(Number(k.get('indent_pending_value')!.value)).toBe(Number(pending.meta.totals.totalEstimatedValue));
        const awaiting = await drill(k.get('indent_approved_open_qty')!.drilldown, ctx());
        expect(Number(k.get('indent_approved_open_qty')!.value)).toBe(Number(awaiting.meta.totals.totalPendingQty));
      });

      it('requisitions: counts and quantity totals', async () => {
        const k = await kpis(ctx());
        const all = await drill(k.get('requisition_count')!.drilldown, ctx());
        expect(Number(k.get('requisition_count')!.value)).toBe(all.meta.total);
        for (const [key, total] of [
          ['requisition_requested_qty', 'totalRequestedQty'], ['requisition_issued_qty', 'totalIssuedQty'],
          ['requisition_pending_qty', 'totalPendingQty'], ['requisition_excess_qty', 'totalExcessQty'],
        ] as const) {
          const list = await drill(k.get(key)!.drilldown, ctx());
          expect(Number(k.get(key)!.value), key).toBe(Number(list.meta.totals[total]));
        }
        for (const key of ['requisition_pending_hod', 'requisition_hod_approved', 'requisition_hod_rejected', 'requisition_awaiting_issue']) {
          const list = await drill(k.get(key)!.drilldown, ctx());
          expect(Number(k.get(key)!.value), key).toBe(list.meta.total);
        }
      });
    });
  }
});

describe('The figures themselves (no filter)', () => {
  it('match the documents created above', async () => {
    const k = await kpis();
    const v = (key: string) => Number(k.get(key)!.value);
    // Seven orders, one cancelled; the draft was never issued, so it is not pending.
    expect(v('po_count')).toBe(6);
    // Overdue 1,000, part-received 400, the mixed order's bolt line 50, both lines of the last 400.
    expect(v('po_pending_count')).toBe(4);
    expect(v('po_pending_value')).toBe(1850);
    expect(v('grn_pending_qty')).toBe(24);
    expect(v('po_overdue_count')).toBe(2);
    expect(v('po_completed_count')).toBe(1);
    // 4 + 2 + 5 received against orders, 5 + 5 received directly; the unposted GRN does not count.
    expect(v('grn_count')).toBe(5);
    expect(v('grn_qty_total')).toBe(21);
    expect(v('grn_value_total')).toBe(730);
    expect(v('indent_count')).toBe(5);
    expect(v('indent_approved_open_qty')).toBe(24);
    expect(v('requisition_count')).toBe(3);
    // Approved then cancelled keeps HOD status Approved; the KPI and its list leave it out.
    expect(v('requisition_hod_approved')).toBe(1);
  });

  it('the awaiting-PO list holds the approved indents with open quantity and nothing else', async () => {
    const k = await kpis();
    const list = await drill(k.get('indent_approved_open_qty')!.drilldown);
    expect(list.data.map((r) => Number(r.id)).sort((x, y) => x - y)).toEqual([ids.indentOpen, ids.indentD2, ids.indentMixed]);
    const unfiltered = await drill('/indents');
    expect(unfiltered.meta.total).toBe(6);
  });
});

describe('Item-level filters count lines (2026-10-17 review)', () => {
  const rowIds = (list: { data: Record<string, unknown>[] }) => list.data.map((r) => Number(r.id)).sort((x, y) => x - y);
  const sorted = (...xs: number[]) => xs.sort((x, y) => x - y);

  it("filtered to a department, an order whose only pending line is another department's is not pending for it", async () => {
    const ctx = { departmentId: String(ids.dept) };
    const k = await kpis(ctx);
    // The mixed order holds a line of the department, so the order list shows it…
    expect(rowIds(await drill('/purchase-orders?excludeCancelled=true', ctx))).toContain(ids.poMixed);
    // …but that line was received in full: its pending, overdue bolt line is the other department's.
    const pending = await drill('/purchase-orders/pending', ctx);
    expect(rowIds(pending)).toEqual(sorted(ids.poOverdue, ids.poPartial, ids.poBoth));
    expect(Number(k.get('po_pending_count')!.value)).toBe(3);
    // Cable lines only: 1,000 + 400 + 300, not the bolt line's 100 on the order pending both.
    expect(Number(pending.meta.totals.pending)).toBe(1700);
    expect(Number(k.get('po_pending_value')!.value)).toBe(1700);
    expect(rowIds(await drill('/purchase-orders/pending?overdue=true', ctx))).toEqual([ids.poOverdue]);
    expect(Number(k.get('po_overdue_count')!.value)).toBe(1);

    // The other department sees the mixed order's overdue bolt line, and only its own value.
    const other = { departmentId: String(ids.dept2) };
    expect(rowIds(await drill('/purchase-orders/pending?overdue=true', other))).toEqual([ids.poMixed]);
    expect(Number((await kpis(other)).get('po_pending_value')!.value)).toBe(150);
  });

  it('the list tiles and the received figures add up the filtered lines of mixed receipts', async () => {
    const ctx = { departmentId: String(ids.dept) };
    const k = await kpis(ctx);
    const posted = await drill('/grn?status=POSTED', ctx);
    // The part receipt (2 cable), the mixed order's receipt (5 cable) and the mixed direct one (2 of 5).
    expect(posted.meta.total).toBe(3);
    expect(Number(posted.meta.totals.totalQty)).toBe(9);
    expect(Number(posted.meta.totals.totalAmount)).toBe(270);
    expect(Number(posted.meta.totals.lineCount)).toBe(3);
    expect(posted.meta.totals.lineScoped).toBe(true);
    expect(Number(k.get('grn_qty_total')!.value)).toBe(9);
    // Unfiltered, a receipt's tiles are all its lines.
    expect((await drill('/grn?status=POSTED')).meta.totals.lineScoped).toBe(false);
  });

  it("an indent's department is its own, and the item filter counts that item's lines", async () => {
    // The second department's indent is for a first-department item: not the first department's.
    const dept = { departmentId: String(ids.dept) };
    const awaiting = await drill('/indents?eligibleOnly=true', dept);
    expect(rowIds(awaiting)).toEqual(sorted(ids.indentOpen, ids.indentMixed));
    expect(Number(awaiting.meta.totals.totalPendingQty)).toBe(18);
    expect(Number((await kpis(dept)).get('indent_approved_open_qty')!.value)).toBe(18);

    // For the cable: its lines on three indents, 10 + 6 + 3, not the mixed indent's bolt.
    const item = { itemId: String(ids.a) };
    const forItem = await drill('/indents?eligibleOnly=true', item);
    expect(rowIds(forItem)).toEqual(sorted(ids.indentOpen, ids.indentD2, ids.indentMixed));
    expect(Number(forItem.meta.totals.totalPendingQty)).toBe(19);
    expect(Number((await kpis(item)).get('indent_approved_open_qty')!.value)).toBe(19);
  });

  it('one line must satisfy every item-level filter', async () => {
    // Department 2 and the cables group are on different lines of the mixed orders.
    const ctx = { departmentId: String(ids.dept2), mainGroupId: String(ids.mg) };
    expect((await drill('/purchase-orders?excludeCancelled=true', ctx)).meta.total).toBe(0);
    expect(Number((await kpis(ctx)).get('po_count')!.value)).toBe(0);
  });
});

/* ── Breakdown bars and trend points (2026-10-17 E2E run, S1-D2, S1-D3) ──────────
   The Indent and GRN Analysis breakdowns grouped PO lines and opened the indent and
   GRN lists, and every PO bar opened a list that also held cancelled orders. Each bar
   now names the list it opens (meta.drilldown, its key under meta.drilldownParam), and
   shows that list's row count and total tiles; a trend point shows the list over its
   period. A bar with no key ('Unassigned') opens nothing: no list filter selects it. */

interface Bar { key: string | null; label: string; poCount?: number; documentCount?: number; requisitionCount?: number; [k: string]: unknown }
interface BarMeta { drilldown: string; drilldownParam: string }

async function bars(endpoint: string, dimension: string, context: Record<string, string>) {
  const res = await request(app).get(`/api/v1/analytics/${endpoint}/${dimension}`).query({ ...context, limit: 100 }).set(auth(adminToken));
  expect(res.status, `${endpoint}/${dimension}`).toBe(200);
  return res.body as { data: Bar[]; meta: BarMeta };
}

/** The list a bar opens, as drilldownLink builds it: the target's own parameters, the
    screen's filters it does not name, and the bar's key over both. */
async function drillBar(target: string, context: Record<string, string>, param: string, key: string) {
  const sp = new URLSearchParams(target.split('?')[1] ?? '');
  const merged = { ...Object.fromEntries(Object.entries(context).filter(([k]) => !sp.has(k))), [param]: key };
  return drill(`${target.split('?')[0]}?${new URLSearchParams({ ...Object.fromEntries(sp), ...merged }).toString()}`);
}

/** The last day of the period a trend point starts (date_trunc of day, week or month). */
function periodEnd(start: string, granularity: 'day' | 'week' | 'month'): string {
  const d = new Date(`${start}T00:00:00Z`);
  if (granularity === 'week') d.setUTCDate(d.getUTCDate() + 6);
  if (granularity === 'month') { d.setUTCMonth(d.getUTCMonth() + 1, 1); d.setUTCDate(0); }
  return d.toISOString().slice(0, 10);
}

describe('Each breakdown bar and trend point equals the list it opens', () => {
  const contexts: Array<[string, Record<string, string>]> = [
    ['no filter', {}],
    ['a supplier and a period', { supplierId: '__s1__', dateFrom: day(-2), dateTo: day(2) }],
    ['a department', { departmentId: '__dept__' }],
    ['an item', { itemId: '__a__' }],
    ['an HOD', { hodId: '__hod__' }],
    ['a machine', { machineId: '__machine__' }],
  ];
  const resolve = (raw: Record<string, string>) =>
    Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, /^__\w+__$/.test(v) ? String(ids[v.slice(2, -2)]) : v]));

  beforeAll(async () => {
    // The PO register wrote an item's description into a line's code column: grouped by
    // that snapshot, one item gave two bars, each opening the list of both.
    await query(`UPDATE purchase_order_lines SET item_code = 'Copper cable as the PO register wrote it' WHERE po_id = $1`, [ids.poOverdue]);
  });

  /** Every bar with a key, against the list it opens: its count and its own measures. */
  async function expectBars(endpoint: string, dims: string[], target: string, ctx: Record<string, string>,
    measures: (bar: Bar, totals: Record<string, string | number>, total: number) => void) {
    for (const dim of dims) {
      const b = await bars(endpoint, dim, ctx);
      expect(b.meta.drilldown, `${endpoint}/${dim}`).toBe(target);
      const keys = b.data.map((r) => r.key);
      expect(new Set(keys).size, `${endpoint}/${dim}: one bar per key`).toBe(keys.length);
      for (const bar of b.data) {
        if (bar.key == null) continue;
        const list = await drillBar(b.meta.drilldown, ctx, b.meta.drilldownParam, bar.key);
        measures(bar, list.meta.totals, list.meta.total);
      }
    }
  }

  for (const [name, raw] of contexts) {
    describe(name, () => {
      it('purchase orders: every bar opens the non-cancelled orders it counts', async () => {
        await expectBars('breakdown', ['supplier', 'item', 'department', 'costCentre', 'mainGroup', 'subMainGroup', 'itemType', 'poType', 'status', 'user', 'hod'],
          '/purchase-orders?excludeCancelled=true', resolve(raw), (bar, totals, total) => {
            expect([bar.poCount, Number(bar.totalValue), Number(bar.totalQty)], `${bar.label}`)
              .toEqual([total, Number(totals.value), Number(totals.totalPoQty)]);
          });
      });

      it('indents: every bar opens the indents it counts, with their tiles', async () => {
        await expectBars('indent-breakdown', ['department', 'costCentre', 'item', 'indentType', 'supplier', 'status', 'user', 'hod'],
          '/indents?excludeCancelled=true', resolve(raw), (bar, totals, total) => {
            expect([bar.documentCount, bar.lineCount, Number(bar.totalQty), Number(bar.totalValue), Number(bar.orderedQty), Number(bar.pendingQty)], `${bar.label}`)
              .toEqual([total, Number(totals.lineCount), Number(totals.totalIndentQty), Number(totals.totalEstimatedValue), Number(totals.totalOrderedQty), Number(totals.totalPendingQty)]);
          });
      });

      it('goods receipts: every bar opens the posted receipts it counts, direct ones included', async () => {
        await expectBars('grn-breakdown', ['supplier', 'item', 'department', 'costCentre', 'mainGroup', 'itemType', 'grnType', 'user', 'hod'],
          '/grn?status=POSTED', resolve(raw), (bar, totals, total) => {
            expect([bar.documentCount, bar.lineCount, Number(bar.totalQty), Number(bar.totalValue)], `${bar.label}`)
              .toEqual([total, Number(totals.lineCount), Number(totals.totalQty), Number(totals.totalAmount)]);
          });
      });

      it('requisitions: every row opens the requisitions it counts, cancelled ones left out', async () => {
        await expectBars('requisition-breakdown', ['item', 'department', 'requester', 'hod', 'machine', 'costCentre', 'user'],
          '/requisitions?excludeCancelled=true', resolve(raw), (bar, totals, total) => {
            expect([bar.requisitionCount, Number(bar.totalRequestedQty), Number(bar.totalIssuedQty)], `${bar.label}`)
              .toEqual([total, Number(totals.totalRequestedQty), Number(totals.totalIssuedQty)]);
          });
      });

      it('trend points: the period opens each module\'s list over it', async () => {
        const ctx = resolve(raw);
        for (const granularity of ['day', 'week', 'month'] as const) {
          const res = await request(app).get('/api/v1/analytics/trends').query({ ...ctx, granularity }).set(auth(adminToken));
          expect(res.status).toBe(200);
          for (const p of res.body.data as Array<Record<string, string | number>>) {
            // The point's days within the screen's own period.
            const from = [String(p.period), ctx.dateFrom].filter(Boolean).sort().at(-1)!;
            const to = [periodEnd(String(p.period), granularity), ctx.dateTo].filter(Boolean).sort()[0]!;
            const period = { ...ctx, dateFrom: from, dateTo: to };
            const pos = await drill('/purchase-orders?excludeCancelled=true', period);
            expect([Number(p.poCount), Number(p.poValue)], `${granularity} ${p.period}`).toEqual([pos.meta.total, Number(pos.meta.totals.value)]);
            expect(Number(p.indentCount)).toBe((await drill('/indents?excludeCancelled=true', period)).meta.total);
            const grns = await drill('/grn?status=POSTED', period);
            expect([Number(p.grnCount), Number(p.grnValue)]).toEqual([grns.meta.total, Number(grns.meta.totals.totalAmount)]);
            expect(Number(p.requisitionCount)).toBe((await drill('/requisitions?excludeCancelled=true', period)).meta.total);
          }
        }
      });
    });
  }

  it('the PO list a bar opens leaves out the cancelled order the breakdown never counted', async () => {
    const b = await bars('breakdown', 'supplier', {});
    const s2 = b.data.find((r) => Number(r.key) === ids.s2)!;
    const opened = await drillBar(b.meta.drilldown, {}, 'supplierId', String(ids.s2));
    const plain = await drill(`/purchase-orders?supplierId=${ids.s2}`);
    // Supplier Two's cancelled order: the bare list the screens opened showed it.
    expect(plain.data.map((r) => Number(r.id))).toContain(ids.poCancelled);
    expect(opened.data.map((r) => Number(r.id))).not.toContain(ids.poCancelled);
    expect(s2.poCount).toBe(opened.meta.total);
  });
});
