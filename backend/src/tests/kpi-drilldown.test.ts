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

let app: Express;
let closeDb: () => Promise<void>;
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
  const { createApp } = await import('../app.js');

  ensureStorageDirs();
  const conn = await getDatabase();
  closeDb = closeDatabase;
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
  ids.cc = await mk('COST_CENTRE', 'KPI-CC', 'KPI Cost Centre');
  for (const [key, supplierName] of [['s1', 'KPI Supplier One'], ['s2', 'KPI Supplier Two']] as const) {
    const res = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send({ supplierName, city: 'Pune', state: 'Maharashtra' });
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }
  for (const [key, itemCode, itemDescription, standardRate] of [
    ['a', 'KPI-CABLE', 'Copper cable', '100'], ['b', 'KPI-BOLT', 'Hex bolt', '50'],
  ] as const) {
    const res = await request(app).post('/api/v1/items').set(auth(adminToken)).send({ itemCode, itemDescription, uomId, standardRate });
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
  const indent = async (itemId: number, qty: string, submit: boolean) => {
    const res = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId: ids.indentType, requiredByDate: '2026-12-31', departmentId: ids.dept, costCentreId: ids.cc, submit,
      lines: [{ itemId, indentQty: qty, estimatedRate: '10' }],
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
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
  const lineOf = async (poId: number) =>
    (await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken))).body.data.lines[0].po_line_id as number;
  const grn = async (body: Record<string, unknown>) => {
    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send(body);
    expect(res.status).toBe(201);
  };
  await grn({ mode: 'PO', post: true, lines: [{ poLineId: await lineOf(ids.poDone), grnQty: '4' }] });
  await grn({ mode: 'PO', post: true, lines: [{ poLineId: await lineOf(ids.poPartial), grnQty: '2' }] });
  await grn({ mode: 'DIRECT', supplierId: ids.s2, post: true, lines: [{ itemId: ids.b, grnQty: '5', rate: '40' }] });
  await grn({ mode: 'DIRECT', supplierId: ids.s1, post: false, lines: [{ itemId: ids.a, grnQty: '1', rate: '10' }] });

  /* Requisitions: pending with the HOD, approved, approved then cancelled, a draft. */
  const requisition = async (submit: boolean, lines: Array<[number, string]>) => {
    const res = await request(app).post('/api/v1/requisitions').set(auth(adminToken)).send({
      requesterUserId: ids.requester, costCentreId: ids.cc, submit,
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
  ids.reqApproved = await requisition(true, [[ids.b, '3']]);
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
  const contexts: Array<[string, Record<string, string>]> = [
    ['no filter', {}],
    ['a supplier and a period', { supplierId: '__s1__', dateFrom: day(-2), dateTo: day(2) }],
  ];

  for (const [name, raw] of contexts) {
    describe(name, () => {
      const ctx = () => Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v === '__s1__' ? String(ids.s1) : v]));

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

      it('indents: total, pending approval, and the quantity awaiting a purchase order', async () => {
        const k = await kpis(ctx());
        const all = await drill(k.get('indent_count')!.drilldown, ctx());
        expect(Number(k.get('indent_count')!.value)).toBe(all.meta.total);
        const pending = await drill(k.get('indent_pending_approval')!.drilldown, ctx());
        expect(Number(k.get('indent_pending_approval')!.value)).toBe(pending.meta.total);
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
    // Five orders, one cancelled; the draft was never issued, so it is not pending.
    expect(v('po_count')).toBe(4);
    expect(v('po_pending_count')).toBe(2);
    expect(v('po_pending_value')).toBe(1400);
    expect(v('grn_pending_qty')).toBe(14);
    expect(v('po_overdue_count')).toBe(1);
    expect(v('po_completed_count')).toBe(1);
    // 4 + 2 received against orders, 5 received directly; the unposted GRN does not count.
    expect(v('grn_count')).toBe(3);
    expect(v('grn_qty_total')).toBe(11);
    expect(v('grn_value_total')).toBe(600);
    expect(v('indent_count')).toBe(3);
    expect(v('indent_approved_open_qty')).toBe(10);
    expect(v('requisition_count')).toBe(3);
    // Approved then cancelled keeps HOD status Approved; the KPI and its list leave it out.
    expect(v('requisition_hod_approved')).toBe(1);
  });

  it('the awaiting-PO list holds the approved indent with open quantity and nothing else', async () => {
    const k = await kpis();
    const list = await drill(k.get('indent_approved_open_qty')!.drilldown);
    expect(list.data.map((r) => Number(r.id))).toEqual([ids.indentOpen]);
    const unfiltered = await drill('/indents');
    expect(unfiltered.meta.total).toBe(4);
  });
});
