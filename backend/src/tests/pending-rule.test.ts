/**
 * Integration tests — one rule for "pending": what an issued, open order still has to
 * deliver on its open lines (2026-10-17 E2E run, S2-D1, S2-D2, S5-D8; migration 031).
 *
 * The pending KPIs, the Pending PO list and the GRN picker counted a line still to be
 * received on an OPEN or PARTIALLY_RECEIVED order (pendingLineSql). Everything else
 * summed every line's raw balance: a short-closed order kept its outstanding quantity
 * and value on the PO screen, the list rows, footer and 'Committed pending receipt'
 * tiles and the supplier summary; a cancelled order showed its whole quantity; a closed
 * line its balance; and the item profile, the indent form and the inventory card
 * 'Pipeline POs (Awaiting GRN)' counted drafts, which no supplier has seen. Pinned here:
 *
 *   1. The PO list rows, their footer sum and the list's tiles, the PO screen and its
 *      lines, the supplier summary and the GRN analysis summary show 0 pending for a
 *      short-closed, a cancelled and a draft order, and leave out a closed line.
 *   2. The dashboard's pending KPIs, the Pending PO list, the receipt evidence summary
 *      and the exports (orders and lines) agree to the rupee and the unit.
 *   3. The item profile, the item master and the inventory overview count only issued,
 *      open orders; the stock register still counts a draft as supply in the pipeline.
 *   4. The raw balance stays on the line for the GRN quantity guards.
 *
 * Real PGlite database, migrated and seeded from scratch.
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
let adminToken = '';
const ids: Record<string, number> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const num = (v: unknown) => Number(v ?? 0);

function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i += 1; } else if (ch === '"') quoted = false; else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** An io export as CSV rows keyed by header (four context lines and a blank one come first). */
async function exportRows(dataset: string, params: Record<string, string | number>): Promise<Record<string, string>[]> {
  const res = await request(app).get(api(`/io/export/${dataset}`)).query({ ...params, format: 'csv' }).set(auth(adminToken));
  expect(res.status).toBe(200);
  const records = parseCsv(res.text.replace(/^﻿/, ''));
  const header = records[5]!;
  return records.slice(6).filter((r) => r.some((c) => c !== '')).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

interface Row { id: number; po_no: string; status: string; total_pending_qty: string; pending_amount: string }
async function list(params: Record<string, string | number>) {
  const res = await request(app).get(api('/purchase-orders')).query({ pageSize: 200, ...params }).set(auth(adminToken));
  expect(res.status).toBe(200);
  return res.body as { data: Row[]; meta: { total: number; totals: { poCount: number; totalPendingQty: string; pending: string } } };
}
const kpi = async (params: Record<string, string | number> = {}) => {
  const res = await request(app).get(api('/analytics/kpis')).query({ ...params, compare: 'false' }).set(auth(adminToken));
  expect(res.status).toBe(200);
  return new Map((res.body.data.kpis as Array<{ key: string; value: string | number }>).map((k) => [k.key, k.value]));
};

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
  adminToken = (await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' })).body.data.accessToken;

  const options = await request(app).get(api('/lookups/options')).set(auth(adminToken));
  const uomId = options.body.data.UOM[0].id as number;
  const pt = await request(app).post(api('/lookups/PO_TYPE')).set(auth(adminToken)).send({ code: 'PEND-PT', name: 'Pending Rule' });
  expect(pt.status).toBe(201);
  ids.poType = pt.body.data.id;
  const s = await request(app).post(api('/suppliers')).set(auth(adminToken)).send({ supplierName: 'Pending Rule Supplier', city: 'Pune', state: 'Maharashtra' });
  expect(s.status).toBe(201);
  ids.supplier = s.body.data.id;
  for (const [key, itemCode] of [['cable', 'PEND-CABLE'], ['bolt', 'PEND-BOLT']] as const) {
    const r = await request(app).post(api('/items')).set(auth(adminToken)).send({ itemCode, itemDescription: `Pending rule ${itemCode}`, uomId, standardRate: '10' });
    expect(r.status).toBe(201);
    ids[key] = r.body.data.id;
  }

  const po = async (lines: Array<[number, string, string]>, issue = true) => {
    const r = await request(app).post(api('/purchase-orders')).set(auth(adminToken)).send({
      supplierId: ids.supplier, poTypeId: ids.poType, issue,
      lines: lines.map(([itemId, poQty, rate]) => ({ itemId, poQty, rate, discountPct: '0', sources: [] })),
    });
    expect(r.status).toBe(201);
    return r.body.data.id as number;
  };
  const lineIds = async (poId: number) =>
    ((await request(app).get(api(`/purchase-orders/${poId}`)).set(auth(adminToken))).body.data.lines as Array<{ po_line_id: number; item_id: number }>);

  // Open, nothing received: 10 cable at 100.
  ids.open = await po([[ids.cable, '10', '100']]);
  // 4 of 10 received, then short-closed: the 6 left is not coming.
  ids.shortClosed = await po([[ids.cable, '10', '100']]);
  const g = await request(app).post(api('/grn')).set(auth(adminToken))
    .send({ mode: 'PO', post: true, lines: [{ poLineId: (await lineIds(ids.shortClosed))[0]!.po_line_id, grnQty: '4' }] });
  expect(g.status).toBe(201);
  expect((await request(app).post(api(`/purchase-orders/${ids.shortClosed}/short-close`)).set(auth(adminToken)).send({ reason: 'Balance not coming' })).status).toBe(200);
  // Cancelled before anything came: 5 bolts at 50.
  ids.cancelled = await po([[ids.bolt, '5', '50']]);
  expect((await request(app).post(api(`/purchase-orders/${ids.cancelled}/cancel`)).set(auth(adminToken)).send({ reason: 'Withdrawn' })).status).toBe(200);
  // A draft: 3 cable at 100, never sent to the supplier.
  ids.draft = await po([[ids.cable, '3', '100']], false);
  // Open, with its cable line closed (2 at 100) and its bolt line open (4 at 50).
  ids.closedLine = await po([[ids.cable, '2', '100'], [ids.bolt, '4', '50']]);
  const mixed = await lineIds(ids.closedLine);
  ids.closedLineId = mixed.find((l) => Number(l.item_id) === ids.cable)!.po_line_id;
  await query('UPDATE purchase_order_lines SET is_closed = TRUE WHERE id = $1', [ids.closedLineId]);
}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

describe('What is pending, wherever a PO is shown', () => {
  it('the list rows show nothing pending for a short-closed, a cancelled or a draft order, nor for a closed line', async () => {
    const l = await list({ supplierId: ids.supplier });
    const of = (id: number) => l.data.find((r) => Number(r.id) === id)!;
    expect([num(of(ids.open).total_pending_qty), num(of(ids.open).pending_amount)]).toEqual([10, 1000]);
    // Before migration 031: 6 / 600, 5 / 250, 3 / 300 and 6 / 400.
    expect([num(of(ids.shortClosed).total_pending_qty), num(of(ids.shortClosed).pending_amount)]).toEqual([0, 0]);
    expect([num(of(ids.cancelled).total_pending_qty), num(of(ids.cancelled).pending_amount)]).toEqual([0, 0]);
    expect([num(of(ids.draft).total_pending_qty), num(of(ids.draft).pending_amount)]).toEqual([0, 0]);
    expect([num(of(ids.closedLine).total_pending_qty), num(of(ids.closedLine).pending_amount)]).toEqual([4, 200]);
  });

  it("the list's tiles are the sum of its rows (the footer), every view", async () => {
    for (const params of [{ supplierId: ids.supplier }, { supplierId: ids.supplier, excludeCancelled: 'true' }, { supplierId: ids.supplier, view: 'pending' }]) {
      const l = await list(params);
      const qty = l.data.reduce((s, r) => s + num(r.total_pending_qty), 0);
      const value = l.data.reduce((s, r) => s + num(r.pending_amount), 0);
      expect([num(l.meta.totals.totalPendingQty), num(l.meta.totals.pending)], JSON.stringify(params)).toEqual([qty, value]);
      expect([qty, value]).toEqual([14, 1200]);
    }
  });

  it('the PO screen: its tiles, and each line while the raw balance stays for the GRN guards', async () => {
    const sc = (await request(app).get(api(`/purchase-orders/${ids.shortClosed}`)).set(auth(adminToken))).body.data;
    expect([num(sc.total_pending_qty), num(sc.pending_amount)]).toEqual([0, 0]);
    expect([num(sc.lines[0].open_pending_qty), num(sc.lines[0].open_pending_amount), num(sc.lines[0].pending_grn_qty)]).toEqual([0, 0, 6]);
    const mixed = (await request(app).get(api(`/purchase-orders/${ids.closedLine}`)).set(auth(adminToken))).body.data;
    expect([num(mixed.total_pending_qty), num(mixed.pending_amount)]).toEqual([4, 200]);
    expect(mixed.lines.map((l: { item_id: number; open_pending_qty: string }) => [Number(l.item_id), num(l.open_pending_qty)]))
      .toEqual([[ids.cable, 0], [ids.bolt, 4]]);
    // Status is still derived from the raw balance: the closed cable line keeps it open.
    expect(mixed.status).toBe('OPEN');
  });

  it('the supplier summary and the GRN analysis summary', async () => {
    const sup = (await request(app).get(api(`/suppliers/${ids.supplier}`)).set(auth(adminToken))).body.data;
    expect(num(sup.summary.pending_value)).toBe(1200);
    const grn = (await request(app).get(api('/grn/analysis/summary')).set(auth(adminToken))).body.data;
    expect([num(grn.po.pendingQty), num(grn.po.pendingValue)]).toEqual([14, 1200]);
  });
});

describe('The pending figures agree: KPIs, the Pending PO list, the receipt evidence summary, the exports', () => {
  it('to the rupee and the unit', async () => {
    const ctx = { supplierId: ids.supplier };
    const k = await kpi(ctx);
    const pending = await list({ ...ctx, view: 'pending' });
    expect(pending.data.map((r) => Number(r.id)).sort((a, b) => a - b)).toEqual([ids.open, ids.closedLine].sort((a, b) => a - b));
    expect(num(k.get('po_pending_count'))).toBe(pending.meta.total);
    expect(num(k.get('po_pending_value'))).toBe(num(pending.meta.totals.pending));
    expect(num(k.get('grn_pending_qty'))).toBe(num(pending.meta.totals.totalPendingQty));

    const summary = (await request(app).get(api('/purchase-orders/receipt-evidence/summary')).query(ctx).set(auth(adminToken))).body.data;
    expect([summary.pending.pos, num(summary.pending.value)]).toEqual([2, 1200]);

    const orders = await exportRows('purchase-orders', ctx);
    const all = await list(ctx);
    expect(orders.map((r) => [r['PO No'], num(r['Pending GRN Qty']), num(r['Pending Value'])]).sort())
      .toEqual(all.data.map((r) => [r.po_no, num(r.total_pending_qty), num(r.pending_amount)]).sort());
    const lines = await exportRows('po-lines', ctx);
    expect(lines.reduce((s, r) => s + num(r['Pending GRN Qty']), 0)).toBe(num(all.meta.totals.totalPendingQty));
  });
});

describe('Pending GRN on the item and the inventory overview: issued, open orders only', () => {
  it('the item profile the indent form reads, and the item master', async () => {
    // Before: 13, the open order's 10 and the draft's 3.
    const profile = (await request(app).get(api(`/items/${ids.cable}/profile`)).set(auth(adminToken))).body.data;
    expect(num(profile.live.pendingGrnQty)).toBe(10);
    const item = (await request(app).get(api(`/items/${ids.cable}`)).set(auth(adminToken))).body.data;
    expect(num(item.pending_grn_qty)).toBe(10);
  });

  it("the overview's 'Pipeline POs (Awaiting GRN)' is the Pending PO list", async () => {
    const overview = (await request(app).get(api('/inventory/overview')).set(auth(adminToken))).body.data;
    const pending = await list({ view: 'pending' });
    expect([overview.kpis.pendingPosCount, overview.kpis.pendingPosQty]).toEqual([pending.meta.total, num(pending.meta.totals.totalPendingQty)]);
    expect(overview.kpis.pendingPosCount).toBe(2);
  });

  it('the stock register still counts a draft as supply on its way', async () => {
    const res = await request(app).get(api('/inventory/stock')).query({ search: 'PEND-CABLE' }).set(auth(adminToken));
    expect(res.status).toBe(200);
    const row = (res.body.data as Array<{ item_code: string; pending_po_qty: string }>).find((r) => r.item_code === 'PEND-CABLE')!;
    // The open order's 10 and the draft's 3: the draft already holds its indents' quantity.
    expect(num(row.pending_po_qty)).toBe(13);
  });
});
