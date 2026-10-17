/**
 * Integration tests — store receipts awaiting their PO link (2026-10-17).
 *
 * The link repair (POST /admin/data-management/repair/link-store-grns) links a store
 * GRN line to a PO line only on unambiguous GRN-tab evidence and holds the rest; on
 * the 2026-10-17 copy it held 2,642 lines, and once applied a PO whose receipt was
 * held looked exactly like a PO nothing was received against. Pinned here:
 *
 *   1. The apply records every held line in store_grn_link_holds (migration 030): one
 *      row per PO the tab names (two for SEVERAL_POS), the ERP PO when the number is
 *      in the ERP (none for PO_NOT_IN_ERP), the PO line when the plan settled on one.
 *      A dry run writes nothing; a second apply that links nothing still records,
 *      and leaves the same content; a reviewer's exclusion keeps the PO it names.
 *   2. Undo records the lines it unlinks as UNDONE on the PO they were linked to; a
 *      later apply replaces the record.
 *   3. GET /purchase-orders flags each PO (store_receipts_awaiting_link) and filters
 *      receiptEvidence=awaiting_link|none_recorded with view=pending and any other
 *      filter; its export holds exactly the rows the list shows.
 *   4. GET /purchase-orders/:id lists the receipts awaiting link with the reason in
 *      words; GET /purchase-orders/receipt-evidence/summary splits the pending POs so
 *      that the two parts add up to the pending list's totals, which equal the
 *      dashboard's Pending POs and Pending PO Value; PO view permission is needed.
 *   5. A receipt linked since, or a GRN cancelled since, no longer counts.
 *
 * Real PGlite database, migrated and seeded from scratch. The GRN tab is a grid handed
 * to the app in place of the Google read (app.locals.storeGrnTabReader).
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
let viewerToken = '';
let uomId = 0;
const sup: Record<string, number> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const LINK = api('/admin/data-management/repair/link-store-grns');
const SUMMARY = api('/purchase-orders/receipt-evidence/summary');

const HEADER = ['GRN No', 'GRN Date', 'Supplier Name', 'Item Code', 'Item Name', 'Unit', 'Recieved Qty', 'Po No'];
const row = (grn: string, code: string, qty: string, po: string) => [grn, '01-Oct-2026', 'Receipt Evidence Supplier', code, `Item ${code}`, 'NOS', qty, po];

const items: Record<string, number> = {};
const pos: Record<string, { id: number; lines: number[] }> = {};
const grns: Record<string, { id: number; lines: number[] }> = {};

async function mkItem(code: string): Promise<void> {
  items[code] = Number((await query<{ id: number }>(
    `INSERT INTO items (item_code, item_description, uom_id) VALUES ($1, $2, $3) RETURNING id`,
    [code, `Receipt evidence item ${code}`, uomId],
  ))[0]!.id);
}

/** A PO as the 2026-10-16 register import left it: nothing received, rate 100. */
async function mkPo(no: string, lines: Array<[string, string]>, opts: { supplier?: string; status?: string; date?: string } = {}): Promise<void> {
  const status = opts.status ?? 'OPEN';
  const id = Number((await query<{ id: number }>(
    `INSERT INTO purchase_order_headers (po_no, po_date, supplier_id, status, close_reason) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [no, opts.date ?? '2026-09-01', sup[opts.supplier ?? 'S1'], status, status === 'CANCELLED' ? 'Cancelled for the test' : null],
  ))[0]!.id);
  const ids: number[] = [];
  for (const [i, [code, qty]] of lines.entries()) {
    ids.push(Number((await query<{ id: number }>(
      `INSERT INTO purchase_order_lines (po_id, line_no, item_id, item_code, item_description, po_qty, uom_id, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100) RETURNING id`,
      [id, i + 1, items[code], code, `Receipt evidence item ${code}`, qty, uomId],
    ))[0]!.id));
  }
  pos[no] = { id, lines: ids };
}

/** A GRN as the 2026-10-14 store import left it: POSTED, no PO on the header or the lines. */
async function mkGrn(no: string, lines: Array<[string, string]>, opts: { supplier?: string } = {}): Promise<void> {
  const id = Number((await query<{ id: number }>(
    `INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status, remarks) VALUES ($1, '2026-10-01', $2, 'POSTED', 'Live import from Google Sheets source') RETURNING id`,
    [no, sup[opts.supplier ?? 'S1']],
  ))[0]!.id);
  const ids: number[] = [];
  for (const [i, [code, qty]] of lines.entries()) {
    ids.push(Number((await query<{ id: number }>(
      `INSERT INTO grn_lines (grn_id, line_no, item_id, item_code, item_description, grn_qty, uom_id, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100) RETURNING id`,
      [id, i + 1, items[code], code, `Item ${code}`, qty, uomId],
    ))[0]!.id));
  }
  grns[no] = { id, lines: ids };
}

let grid: string[][] = [HEADER];

type HoldRow = {
  grn_line_id: number; grn_no: string; item_code: string; grn_qty: string; po_id: number | null; po_line_id: number | null;
  po_no: string | null; reason: string; detail: string; run_id: string;
};
/** The record as content: everything but the row id, run and time. */
const holds = () => query<HoldRow>(
  `SELECT grn_line_id::int AS grn_line_id, grn_no, item_code, grn_qty::text AS grn_qty, po_id::int AS po_id,
          po_line_id::int AS po_line_id, po_no, reason, detail, run_id
     FROM store_grn_link_holds ORDER BY grn_line_id, po_no NULLS FIRST, po_id`,
);
const content = (rows: HoldRow[]) => rows.map(({ run_id: _run, ...rest }) => rest);
const holdCount = async () => Number((await query<{ n: number }>('SELECT COUNT(*)::int AS n FROM store_grn_link_holds'))[0]!.n);

const dryRun = async (review: Record<string, unknown> = {}) => {
  const res = await request(app).post(LINK).set(auth(adminToken)).send(review);
  expect(res.status).toBe(200);
  return res.body.data;
};
const apply = (expectedHash: string, review: Record<string, unknown> = {}) =>
  request(app).post(LINK).set(auth(adminToken)).send({ dryRun: false, confirm: 'LINK STORE GRNS', expectedHash, ...review });

type ListRow = { id: number; po_no: string; store_receipts_awaiting_link: number };
const list = async (params: Record<string, string | number>) => {
  const res = await request(app).get(api('/purchase-orders')).query({ pageSize: 200, ...params }).set(auth(adminToken));
  expect(res.status).toBe(200);
  return res.body as { data: ListRow[]; meta: { total: number; totals: { poCount: number; pending: string } } };
};
const listNos = async (params: Record<string, string | number>) => (await list(params)).data.map((r) => r.po_no).sort();
const flagOf = async (poNo: string) => (await list({ search: poNo })).data.find((r) => r.po_no === poNo)!.store_receipts_awaiting_link;
/** The PO numbers of a CSV export: the first column under the header row. */
const exportNos = async (params: Record<string, string | number>) => {
  const res = await request(app).get(api('/io/export/purchase-orders')).query({ format: 'csv', ...params }).set(auth(adminToken));
  expect(res.status).toBe(200);
  const lines = res.text.replace(/^﻿/, '').split('\r\n');
  const header = lines.findIndex((l) => l.startsWith('PO No,'));
  expect(lines[header]).toMatch(/Store Receipts Awaiting Link,Receipts on Store Sheet Only$/);
  return lines.slice(header + 1).filter(Boolean).map((l) => l.split(',')[0]!).sort();
};
const summary = async (params: Record<string, string | number> = {}) => {
  const res = await request(app).get(SUMMARY).query(params).set(auth(adminToken));
  expect(res.status).toBe(200);
  return res.body.data;
};
const kpi = async (key: string) => {
  const res = await request(app).get(api('/analytics/kpis')).set(auth(adminToken));
  expect(res.status).toBe(200);
  return (res.body.data.kpis as Array<{ key: string; value: string | number }>).find((k) => k.key === key)!.value;
};
const cents = (v: string | number) => Math.round(Number(v) * 100);

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
  app.locals.storeGrnTabReader = async (sheet: string) => (sheet === 'GRN' ? grid : []);
  adminToken = (await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' })).body.data.accessToken;

  // Sees the dashboard, not purchase orders.
  const permission = (await query<{ id: string }>(`SELECT id FROM permissions WHERE code = 'dashboard.view'`))[0]!.id;
  const role = await request(app).post(api('/roles')).set(auth(adminToken))
    .send({ code: 'RE_DASHBOARD', name: 'Dashboard only', permissionIds: [Number(permission)] });
  expect(role.status).toBe(201);
  const user = await request(app).post(api('/users')).set(auth(adminToken))
    .send({ employeeId: 'RE-VIEWER', employeeName: 'Dashboard Viewer', password: 'Viewer@2026x', mustChangePassword: false, roleIds: [role.body.data.id] });
  expect(user.status).toBe(201);
  viewerToken = (await request(app).post(api('/auth/login')).send({ employeeId: 'RE-VIEWER', password: 'Viewer@2026x' })).body.data.accessToken;

  uomId = Number((await query<{ id: number }>(`SELECT id FROM lookups WHERE category = 'UOM' AND code = 'NOS'`))[0]!.id);
  for (const [k, code, name] of [['S1', 'RE-SUP-1', 'Receipt Evidence Supplier'], ['S2', 'RE-SUP-2', 'Receipt Evidence Other'], ['S3', 'RE-SUP-3', 'Receipt Evidence Third']]) {
    sup[k!] = Number((await query<{ id: number }>('INSERT INTO suppliers (supplier_code, supplier_name) VALUES ($1, $2) RETURNING id', [code, name]))[0]!.id);
  }
  for (const c of ['RE-A', 'RE-B', 'RE-C', 'RE-D', 'RE-E', 'RE-F', 'RE-G', 'RE-H', 'RE-I', 'RE-J', 'RE-K', 'RE-L', 'RE-M', 'RE-N', 'RE-P', 'RE-Q', 'RE-R', 'RE-S']) {
    await mkItem(c);
  }

  await mkPo('Z/RE/00001', [['RE-A', '10']]);
  await mkPo('Z/RE/00002', [['RE-B', '10']]);
  await mkPo('Z/RE/00003', [['RE-C', '5']]);
  await mkPo('Z/RE/00004', [['RE-C', '5']]);
  await mkPo('Z/RE/00005', [['RE-E', '2']]);
  await mkPo('Z/RE/00006', [['RE-F', '10'], ['RE-G', '10']]);
  await mkPo('Z/RE/00007', [['RE-K', '5']], { supplier: 'S2' });
  await mkPo('Z/RE/00008', [['RE-L', '5']]);
  await mkPo('Z/RE/00009', [['RE-M', '5'], ['RE-M', '5']]);
  await mkPo('Z/RE/00010', [['RE-N', '4']]);
  await mkPo('Z/RE/00011', [['RE-P', '5']], { date: '2026-12-01' });
  await mkPo('Z/RE/00012', [['RE-Q', '5']], { status: 'CANCELLED' });
  await mkPo('Z/RE/00013', [['RE-R', '5']], { supplier: 'S3' });
  await mkPo('Z/RE/00014', [['RE-S', '5']], { supplier: 'S3' });

  await mkGrn('ZG/RE/0001', [['RE-A', '10']]);
  await mkGrn('ZG/RE/0002', [['RE-B', '4']]);
  await mkGrn('ZG/RE/0003', [['RE-C', '3']]);
  await mkGrn('ZG/RE/0004', [['RE-D', '1']]);
  await mkGrn('ZG/RE/0005', [['RE-E', '3']]);
  await mkGrn('ZG/RE/0006', [['RE-F', '1'], ['RE-H', '1']]);
  await mkGrn('ZG/RE/0007', [['RE-I', '1']]);
  await mkGrn('ZG/RE/0008', [['RE-J', '1']]);
  await mkGrn('ZG/RE/0009', [['RE-K', '1']]);
  await mkGrn('ZG/RE/0010', [['RE-M', '1']]);
  await mkGrn('ZG/RE/0011', [['RE-N', '4']]);
  await mkGrn('ZG/RE/0012', [['RE-P', '1']]);
  await mkGrn('ZG/RE/0013', [['RE-Q', '1']]);
  await mkGrn('ZG/RE/0014', [['RE-R', '1']], { supplier: 'S3' });

  grid = [
    HEADER,
    row('ZG/RE/0001', 'RE-A', '10', 'Z/RE/00001'), // linked: completes Z/RE/00001
    row('ZG/RE/0002', 'RE-B', '4', 'Z/RE/00002'), // linked: 4 of 10
    row('ZG/RE/0003', 'RE-C', '2', 'Z/RE/00003'), // SEVERAL_POS: two POs, both in the ERP
    row('ZG/RE/0003', 'RE-C', '1', 'Z/RE/00004'),
    row('ZG/RE/0004', 'RE-D', '1', 'Z/RE/09999'), // PO_NOT_IN_ERP
    row('ZG/RE/0005', 'RE-E', '3', 'Z/RE/00005'), // OVER_RECEIPT: 3 on a line of 2
    row('ZG/RE/0006', 'RE-F', '1', 'Z/RE/00006'), // GRN_PARTLY_HELD, held by its other line
    row('ZG/RE/0006', 'RE-H', '1', 'Z/RE/00006'), // ITEM_NOT_ON_PO
    // ZG/RE/0007 is not on the tab: NOT_ON_TAB
    row('ZG/RE/0008', 'RE-J', '1', '-'), // NO_PO_NAMED
    row('ZG/RE/0009', 'RE-K', '1', 'Z/RE/00007'), // SUPPLIER_MISMATCH: Z/RE/00007 is S2's
    row('ZG/RE/0010', 'RE-M', '1', 'Z/RE/00009'), // SEVERAL_PO_LINES
    row('ZG/RE/0011', 'RE-N', '4', 'Z/RE/00010'), // linked, undone below
    row('ZG/RE/0012', 'RE-P', '1', 'Z/RE/00011'), // PO_AFTER_RECEIPT: dated 61 days after
    row('ZG/RE/0013', 'RE-Q', '1', 'Z/RE/00012'), // PO_NOT_RECEIVABLE: cancelled
    row('ZG/RE/0014', 'RE-R', '1', 'Z/RE/00013'), // SEVERAL_POS: one in the ERP, one not
    row('ZG/RE/0014', 'RE-R', '1', 'Z/RE/00099'),
  ];
});

afterAll(async () => {
  await closeDb?.();
});

describe('Store receipts awaiting link — the record the link repair writes', () => {
  let firstRecord: HoldRow[] = [];

  it('a dry run writes nothing', async () => {
    const d = await dryRun();
    expect(d.totals).toMatchObject({ linkable: 3, held: 12 });
    expect(await holdCount()).toBe(0);
  });

  it('the apply records every held line, one row per PO the tab names', async () => {
    const d = await dryRun();
    const res = await apply(d.selectionHash);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ linesLinked: 3, heldLines: 12, holdsRecorded: 14 });
    expect(res.body.data.message).toMatch(/12 held store receipt line\(s\) recorded as awaiting link \(14 row\(s\), one per PO the GRN tab names\)/);

    const rows = await holds();
    expect(rows).toHaveLength(14);
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([res.body.data.runId]));
    const byReason: Record<string, number> = {};
    for (const r of rows) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
    expect(byReason).toEqual({
      SEVERAL_POS: 4, PO_NOT_IN_ERP: 1, OVER_RECEIPT: 1, GRN_PARTLY_HELD: 1, ITEM_NOT_ON_PO: 1, NOT_ON_TAB: 1,
      NO_PO_NAMED: 1, SUPPLIER_MISMATCH: 1, SEVERAL_PO_LINES: 1, PO_AFTER_RECEIPT: 1, PO_NOT_RECEIVABLE: 1,
    });
    const of = (grn: string, i = 0) => rows.filter((r) => r.grn_line_id === grns[grn]!.lines[i]);
    // One row per PO the tab names, each with its ERP PO.
    expect(of('ZG/RE/0003').map((r) => [r.po_no, r.po_id, r.po_line_id])).toEqual([
      ['Z/RE/00003', pos['Z/RE/00003']!.id, null], ['Z/RE/00004', pos['Z/RE/00004']!.id, null],
    ]);
    // A PO number the ERP lacks keeps the number, without a PO.
    expect(of('ZG/RE/0014').map((r) => [r.po_no, r.po_id])).toEqual([['Z/RE/00013', pos['Z/RE/00013']!.id], ['Z/RE/00099', null]]);
    expect(of('ZG/RE/0004')).toMatchObject([{ reason: 'PO_NOT_IN_ERP', po_no: 'Z/RE/09999', po_id: null, po_line_id: null }]);
    // The PO line, where the plan settled on one.
    expect(of('ZG/RE/0005')).toMatchObject([{ reason: 'OVER_RECEIPT', po_id: pos['Z/RE/00005']!.id, po_line_id: pos['Z/RE/00005']!.lines[0], grn_qty: '3.0000' }]);
    expect(of('ZG/RE/0006', 0)).toMatchObject([{ reason: 'GRN_PARTLY_HELD', po_id: pos['Z/RE/00006']!.id, po_line_id: pos['Z/RE/00006']!.lines[0] }]);
    expect(of('ZG/RE/0006', 1)).toMatchObject([{ reason: 'ITEM_NOT_ON_PO', po_id: pos['Z/RE/00006']!.id, po_line_id: null, item_code: 'RE-H' }]);
    expect(of('ZG/RE/0010')).toMatchObject([{ reason: 'SEVERAL_PO_LINES', po_id: pos['Z/RE/00009']!.id, po_line_id: null }]);
    expect(of('ZG/RE/0009')).toMatchObject([{ reason: 'SUPPLIER_MISMATCH', po_id: pos['Z/RE/00007']!.id }]);
    expect(of('ZG/RE/0012')).toMatchObject([{ reason: 'PO_AFTER_RECEIPT', po_id: pos['Z/RE/00011']!.id }]);
    expect(of('ZG/RE/0013')).toMatchObject([{ reason: 'PO_NOT_RECEIVABLE', po_id: pos['Z/RE/00012']!.id }]);
    // Naming no PO, or no tab row at all: one row without a PO.
    expect(of('ZG/RE/0007')).toMatchObject([{ reason: 'NOT_ON_TAB', po_no: null, po_id: null }]);
    expect(of('ZG/RE/0008')).toMatchObject([{ reason: 'NO_PO_NAMED', po_no: null, po_id: null }]);
    // The detail is the plan's own sentence.
    expect(of('ZG/RE/0005')[0]!.detail).toMatch(/^Z\/RE\/00005 line 1 \(RE-E\) ordered 2\.0000/);

    const [runEntry] = await query<{ after_data: { holdsRecorded: number; heldLines: number }; message: string }>(
      `SELECT after_data, message FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run' ORDER BY id DESC LIMIT 1`,
    );
    expect(runEntry!.after_data).toMatchObject({ holdsRecorded: 14, heldLines: 12 });
    expect(runEntry!.message).toMatch(/14 row\(s\) for the 12 held receipt line\(s\) recorded as store receipts awaiting link/);
    firstRecord = rows;
  });

  it('a dry run after the apply leaves the record as it is', async () => {
    await dryRun();
    expect(content(await holds())).toEqual(content(firstRecord));
  });

  it('an apply that links nothing still records, says so, and leaves the same content', async () => {
    const d = await dryRun();
    expect(d.totals).toMatchObject({ linkable: 0, held: 12 });
    const res = await apply(d.selectionHash);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ linesLinked: 0, holdsRecorded: 14, auditIds: [] });
    expect(res.body.data.message).toBe(
      'Nothing was linked: no GRN line can be linked from the tab\'s evidence. 12 held store receipt line(s) recorded as awaiting link '
        + '(14 row(s), one per PO the GRN tab names), replacing the earlier record. Quantities, stock and the ledger were not changed.',
    );
    const rows = await holds();
    expect(content(rows)).toEqual(content(firstRecord));
    expect(new Set(rows.map((r) => r.run_id))).toEqual(new Set([res.body.data.runId]));
    expect(res.body.data.runId).not.toBe(firstRecord[0]!.run_id);
    const [runEntry] = await query<{ message: string }>(
      `SELECT message FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run' ORDER BY id DESC LIMIT 1`,
    );
    expect(runEntry!.message).toMatch(/Nothing was linked; 14 row\(s\) for the 12 held receipt line\(s\) recorded/);
  });

  it('keeps the PO a reviewer\'s exclusion names, and a later apply puts the reason back', async () => {
    const line = grns['ZG/RE/0005']!.lines[0]!;
    const d = await dryRun({ excludeGrnLineIds: [line] });
    expect((await apply(d.selectionHash, { excludeGrnLineIds: [line] })).status).toBe(200);
    expect((await holds()).filter((r) => r.grn_line_id === line)).toMatchObject([
      { reason: 'EXCLUDED', po_no: 'Z/RE/00005', po_id: pos['Z/RE/00005']!.id, po_line_id: null },
    ]);
    expect(await flagOf('Z/RE/00005')).toBe(1);
    const again = await dryRun();
    expect((await apply(again.selectionHash)).status).toBe(200);
    expect(content(await holds())).toEqual(content(firstRecord));
  });
});

describe('Store receipts awaiting link — the PO list, its export and the PO screen', () => {
  it('flags each PO with the receipts awaiting link that name it', async () => {
    const all = await list({});
    const flags = Object.fromEntries(all.data.map((r) => [r.po_no, r.store_receipts_awaiting_link]));
    expect(flags).toEqual({
      'Z/RE/00001': 0, 'Z/RE/00002': 0, 'Z/RE/00003': 1, 'Z/RE/00004': 1, 'Z/RE/00005': 1, 'Z/RE/00006': 2,
      'Z/RE/00007': 1, 'Z/RE/00008': 0, 'Z/RE/00009': 1, 'Z/RE/00010': 0, 'Z/RE/00011': 1, 'Z/RE/00012': 1,
      'Z/RE/00013': 1, 'Z/RE/00014': 0,
    });
  });

  it('filters the pending POs by receipt evidence, with any other filter', async () => {
    const pending = await listNos({ view: 'pending' });
    expect(pending).toEqual(['Z/RE/00002', 'Z/RE/00003', 'Z/RE/00004', 'Z/RE/00005', 'Z/RE/00006', 'Z/RE/00007', 'Z/RE/00008',
      'Z/RE/00009', 'Z/RE/00011', 'Z/RE/00013', 'Z/RE/00014']);
    const awaiting = await listNos({ view: 'pending', receiptEvidence: 'awaiting_link' });
    const none = await listNos({ view: 'pending', receiptEvidence: 'none_recorded' });
    expect(awaiting).toEqual(['Z/RE/00003', 'Z/RE/00004', 'Z/RE/00005', 'Z/RE/00006', 'Z/RE/00007', 'Z/RE/00009', 'Z/RE/00011', 'Z/RE/00013']);
    expect(none).toEqual(['Z/RE/00002', 'Z/RE/00008', 'Z/RE/00014']);
    expect([...awaiting, ...none].sort()).toEqual(pending);
    // With a supplier filter, and with a search.
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', supplierId: sup.S3! })).toEqual(['Z/RE/00013']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded', supplierId: sup.S3! })).toEqual(['Z/RE/00014']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', search: 'RE-M' })).toEqual(['Z/RE/00009']);
    // The cancelled PO is flagged in the full list but is not pending.
    expect(await listNos({ receiptEvidence: 'awaiting_link', status: 'CANCELLED' })).toEqual(['Z/RE/00012']);
    // The list's totals follow the filter.
    const t = (await list({ view: 'pending', receiptEvidence: 'awaiting_link' })).meta.totals;
    expect([Number(t.poCount), cents(t.pending)]).toEqual([8, 570000]);
    const bad = await request(app).get(api('/purchase-orders')).query({ receiptEvidence: 'maybe' }).set(auth(adminToken));
    expect(bad.status).toBe(422);
  });

  it('exports exactly the rows the list shows', async () => {
    for (const params of [
      { view: 'pending' },
      { view: 'pending', receiptEvidence: 'awaiting_link' },
      { view: 'pending', receiptEvidence: 'none_recorded' },
      { view: 'pending', receiptEvidence: 'awaiting_link', supplierId: sup.S3! },
      { receiptEvidence: 'awaiting_link' },
      { view: 'pending', search: 'RE-M' },
    ] as Array<Record<string, string | number>>) {
      expect([params, await exportNos(params)]).toEqual([params, await listNos(params)]);
    }
    // The flag travels with the rows.
    const res = await request(app).get(api('/io/export/purchase-orders')).query({ format: 'csv', view: 'pending', receiptEvidence: 'awaiting_link' })
      .set(auth(adminToken));
    expect(res.text).toMatch(/View: pending {2}· {2}Store receipt awaiting link/);
    expect(res.text.split('\r\n').find((l) => l.startsWith('Z/RE/00006,'))).toMatch(/,2$/);
  });

  it('lists the receipts awaiting link on the PO screen, the reason in words', async () => {
    const res = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00006']!.id}`)).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.storeReceiptsAwaitingLink).toEqual([
      {
        grnId: grns['ZG/RE/0006']!.id, grnNo: 'ZG/RE/0006', grnDate: '2026-10-01', itemCode: 'RE-F', grnQty: '1.0000', poLineNo: 1,
        reason: 'GRN_PARTLY_HELD', reasonText: 'Another line of the same GRN is held, and a GRN is linked whole.',
        detail: expect.stringMatching(/^ZG\/RE\/0006 is linked whole or not at all, and 1 of its line\(s\) are held: RE-H \(ITEM_NOT_ON_PO\)/),
        recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      {
        grnId: grns['ZG/RE/0006']!.id, grnNo: 'ZG/RE/0006', grnDate: '2026-10-01', itemCode: 'RE-H', grnQty: '1.0000', poLineNo: null,
        reason: 'ITEM_NOT_ON_PO', reasonText: 'The PO named on the GRN tab has no line for this item.',
        detail: 'Z/RE/00006 has no line for RE-H (its 2 line(s): RE-F, RE-G).', recordedAt: expect.any(String),
      },
    ]);
    const over = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00005']!.id}`)).set(auth(adminToken));
    expect(over.body.data.storeReceiptsAwaitingLink).toMatchObject([{
      reason: 'OVER_RECEIPT', poLineNo: 1,
      reasonText: 'The store received more than this PO line ordered, counting every receipt the GRN tab assigns to it.',
    }]);
    const plain = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00008']!.id}`)).set(auth(adminToken));
    expect(plain.body.data.storeReceiptsAwaitingLink).toEqual([]);
  });
});

describe('Store receipts awaiting link — the summary', () => {
  it('splits the pending POs into two parts that add up to the pending list, the dashboard\'s figures', async () => {
    const s = await summary();
    expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.pending.pos).toBe(11);
    expect(s.awaitingLink).toMatchObject({ pos: 8, receiptLines: 8 });
    expect(s.noneRecorded.pos).toBe(3);
    expect([cents(s.pending.value), cents(s.awaitingLink.value), cents(s.noneRecorded.value)]).toEqual([730000, 570000, 160000]);
    expect(s.awaitingLink.pos + s.noneRecorded.pos).toBe(s.pending.pos);
    expect(cents(s.awaitingLink.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
    expect(s.awaitingLink.byReason).toEqual({
      EXCLUDED: 0, NOT_ON_TAB: 0, NO_PO_NAMED: 0, SEVERAL_POS: 2, PO_NOT_IN_ERP: 0, PO_NOT_RECEIVABLE: 0, ITEM_NOT_ON_PO: 1,
      SEVERAL_PO_LINES: 1, SUPPLIER_MISMATCH: 1, PO_AFTER_RECEIPT: 1, OVER_RECEIPT: 1, GRN_PARTLY_HELD: 1, UNDONE: 0,
    });
    expect(s.notInErp).toEqual({ receiptLines: 2, poNos: 2 });

    // The pending list's own totals, and the dashboard's Pending POs / Pending PO Value.
    const t = (await list({ view: 'pending' })).meta.totals;
    expect([s.pending.pos, s.pending.value]).toEqual([Number(t.poCount), t.pending]);
    expect(s.pending.pos).toBe(Number(await kpi('po_pending_count')));
    expect(cents(s.pending.value)).toBe(cents(await kpi('po_pending_value')));
  });

  it('applies the list\'s filters to all three', async () => {
    const s = await summary({ supplierId: sup.S3! });
    expect([s.pending.pos, s.awaitingLink.pos, s.noneRecorded.pos]).toEqual([2, 1, 1]);
    expect([cents(s.awaitingLink.value), cents(s.noneRecorded.value)]).toEqual([50000, 50000]);
    expect(s.awaitingLink.byReason.SEVERAL_POS).toBe(1);
  });

  it('needs the PO view permission, as the list does', async () => {
    const res = await request(app).get(SUMMARY).set(auth(viewerToken));
    expect(res.status).toBe(403);
    expect((await request(app).get(api('/purchase-orders')).set(auth(viewerToken))).status).toBe(403);
  });
});

describe('Store receipts awaiting link — undo, a later apply, and receipts that move on', () => {
  it('records the lines an undo takes back as UNDONE on their PO', async () => {
    const line = grns['ZG/RE/0011']!.lines[0]!;
    const res = await request(app).post(`${LINK}/undo`).set(auth(adminToken))
      .send({ grnLineIds: [line], reason: 'Purchase says ZG/RE/0011 was against another PO', confirm: 'UNDO STORE GRN LINKS' });
    expect(res.status).toBe(200);
    expect(res.body.data.holdsRecorded).toBe(1);
    expect(res.body.data.message).toMatch(/1 receipt line\(s\) recorded as awaiting link \(UNDONE\)/);
    const [undoEntry] = await query<{ id: number; after_data: { holdsRecorded: number } }>(
      `SELECT id, after_data FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'undo' ORDER BY id DESC LIMIT 1`,
    );
    expect(undoEntry!.after_data.holdsRecorded).toBe(1);
    const [linkEntry] = await query<{ id: number; run_id: string }>(
      `SELECT id, after_data->>'runId' AS run_id FROM audit_logs
        WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'links' AND after_data->'links' @> $1::jsonb ORDER BY id DESC LIMIT 1`,
      [JSON.stringify([{ grnLineId: line }])],
    );
    expect((await holds()).filter((r) => r.grn_line_id === line)).toEqual([{
      grn_line_id: line, grn_no: 'ZG/RE/0011', item_code: 'RE-N', grn_qty: '4.0000', po_id: pos['Z/RE/00010']!.id,
      po_line_id: pos['Z/RE/00010']!.lines[0], po_no: 'Z/RE/00010', reason: 'UNDONE', run_id: linkEntry!.run_id,
      detail: `Linked to Z/RE/00010 line 1 by audit #${linkEntry!.id}; taken back by a Super Admin (audit #${undoEntry!.id}): `
        + 'Purchase says ZG/RE/0011 was against another PO',
    }]);
    // The PO it belonged to is pending again, and not as a PO nothing came against.
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', search: 'Z/RE/00010' })).toEqual(['Z/RE/00010']);
    const doc = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00010']!.id}`)).set(auth(adminToken));
    expect(doc.body.data.storeReceiptsAwaitingLink).toMatchObject([{ grnNo: 'ZG/RE/0011', reason: 'UNDONE', reasonText: 'A Super Admin took this link back.', poLineNo: 1 }]);
    const s = await summary();
    expect([s.pending.pos, s.awaitingLink.pos, s.noneRecorded.pos, s.awaitingLink.byReason.UNDONE]).toEqual([12, 9, 3, 1]);
    expect(cents(s.awaitingLink.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
  });

  it('a later apply replaces the record as usual', async () => {
    const d = await dryRun();
    expect(d.totals.linkable).toBe(1);
    expect((await apply(d.selectionHash)).status).toBe(200);
    const rows = await holds();
    expect(rows.some((r) => r.reason === 'UNDONE')).toBe(false);
    expect(rows).toHaveLength(14);
  });

  it('a receipt linked since, or whose GRN is cancelled since, no longer counts', async () => {
    const line = grns['ZG/RE/0010']!.lines[0]!;
    // Purchase confirms the PO line and the receipt is linked from the GRN screen.
    await query('UPDATE grn_lines SET po_line_id = $2 WHERE id = $1', [line, pos['Z/RE/00009']!.lines[0]]);
    expect(await flagOf('Z/RE/00009')).toBe(0);
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded', search: 'Z/RE/00009' })).toEqual(['Z/RE/00009']);
    await query('UPDATE grn_lines SET po_line_id = NULL WHERE id = $1', [line]);
    expect(await flagOf('Z/RE/00009')).toBe(1);

    await query(`UPDATE grn_headers SET status = 'CANCELLED', cancel_reason = 'Duplicate receipt' WHERE id = $1`, [grns['ZG/RE/0009']!.id]);
    expect(await flagOf('Z/RE/00007')).toBe(0);
    const s = await summary();
    expect(cents(s.awaitingLink.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
    expect(s.awaitingLink.byReason.SUPPLIER_MISMATCH).toBe(0);
  });
});

describe('Store receipts awaiting link — the record itself', () => {
  it('accepts exactly the link run\'s reasons and UNDONE', async () => {
    const { HOLD_REASONS } = await import('../modules/admin/store-grn-links.js');
    const [c] = await query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'chk_store_grn_link_hold_reason'`,
    );
    const allowed = [...c!.def.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
    expect(allowed).toEqual([...Object.keys(HOLD_REASONS), 'UNDONE'].sort());
  });

  it('is part of every backup', async () => {
    const { BACKUP_TABLES, collectBackupData } = await import('../db/restore.js');
    expect(BACKUP_TABLES).toContain('store_grn_link_holds');
    const { counts } = await collectBackupData((sql) => query(sql));
    expect(counts.store_grn_link_holds).toBe(await holdCount());
  });
});
