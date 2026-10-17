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
 *      that the parts add up to the pending list's totals, which equal the
 *      dashboard's Pending POs and Pending PO Value; PO view permission is needed.
 *   5. A receipt linked since, or a GRN cancelled since, no longer counts.
 *   6. Receipts on the store's GRN sheet only (the GRN tab lines the business-sheet sync
 *      keeps open as MISSING_IN_ERP, as of the latest finished sync): a third class
 *      after 'awaiting link' and before 'none recorded'; the three add up to pending;
 *      the filter, its export, the list's count and the PO screen; a line the latest
 *      run no longer reports, one an administrator resolved, and one of a run still in
 *      progress do not count; one first recorded by an older run and still reported does.
 *
 * Real PGlite database, migrated and seeded from scratch. The GRN tab is a grid handed
 * to the app in place of the Google read (app.locals.storeGrnTabReader), and to the
 * sync engine's own run (runSync's reader).
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

  it('a dry run writes nothing, and gives each reason in the PO screen\'s words for the held list', async () => {
    const d = await dryRun();
    expect(d.totals).toMatchObject({ linkable: 3, held: 12 });
    expect(await holdCount()).toBe(0);
    const { REASON_TEXT } = await import('../modules/purchase-order/receipt-evidence.js');
    expect(d.reasonText).toEqual(REASON_TEXT);
    expect(d.reasonText.SEVERAL_PO_LINES).toBe('The PO has more than one line for this item and the GRN tab does not say which.');
    expect(d.held.every((h: { reason: string }) => typeof d.reasonText[h.reason] === 'string')).toBe(true);
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
    const sheet = await listNos({ view: 'pending', receiptEvidence: 'sheet_only' });
    const none = await listNos({ view: 'pending', receiptEvidence: 'none_recorded' });
    expect(awaiting).toEqual(['Z/RE/00003', 'Z/RE/00004', 'Z/RE/00005', 'Z/RE/00006', 'Z/RE/00007', 'Z/RE/00009', 'Z/RE/00011', 'Z/RE/00013']);
    expect(sheet).toEqual([]);
    expect(none).toEqual(['Z/RE/00002', 'Z/RE/00008', 'Z/RE/00014']);
    expect([...awaiting, ...sheet, ...none].sort()).toEqual(pending);
    // With a supplier filter, a search, an item (which selects lines) and the Complete view.
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', supplierId: sup.S3! })).toEqual(['Z/RE/00013']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded', supplierId: sup.S3! })).toEqual(['Z/RE/00014']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', search: 'RE-M' })).toEqual(['Z/RE/00009']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'awaiting_link', itemId: items['RE-C']! })).toEqual(['Z/RE/00003', 'Z/RE/00004']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded', itemId: items['RE-C']! })).toEqual([]);
    expect(await listNos({ view: 'complete', receiptEvidence: 'none_recorded' })).toEqual(['Z/RE/00001', 'Z/RE/00010']);
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
    expect(res.text.split('\r\n').find((l) => l.startsWith('Z/RE/00006,'))).toMatch(/,2,0$/);
  });

  it('lists the receipts awaiting link on the PO screen, the reason in words', async () => {
    const res = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00006']!.id}`)).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.storeReceiptsAwaitingLink).toEqual([
      {
        holdId: expect.any(Number),
        grnId: grns['ZG/RE/0006']!.id, grnNo: 'ZG/RE/0006', grnDate: '2026-10-01', itemCode: 'RE-F', grnQty: '1.0000', poLineNo: 1,
        reason: 'GRN_PARTLY_HELD', reasonText: 'Another line of the same GRN is held, and a GRN is linked whole.',
        detail: expect.stringMatching(/^ZG\/RE\/0006 is linked whole or not at all, and 1 of its line\(s\) are held: RE-H \(ITEM_NOT_ON_PO\)/),
        recordedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
      {
        holdId: expect.any(Number),
        grnId: grns['ZG/RE/0006']!.id, grnNo: 'ZG/RE/0006', grnDate: '2026-10-01', itemCode: 'RE-H', grnQty: '1.0000', poLineNo: null,
        reason: 'ITEM_NOT_ON_PO', reasonText: 'The PO named on the GRN tab has no line for this item.',
        detail: 'Z/RE/00006 has no line for RE-H (its 2 line(s): RE-F, RE-G).', recordedAt: expect.any(String),
      },
    ]);
    // Each row carries its hold row's id: a GRN may hold the same item twice with the same
    // reason and detail (ZG/PM/0008 on the 2026-10-17 copy), so nothing else keys it.
    const ids = res.body.data.storeReceiptsAwaitingLink.map((r: { holdId: number }) => r.holdId);
    expect(new Set(ids).size).toBe(ids.length);
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
  it('splits the pending POs into parts that add up to the pending list, the dashboard\'s figures', async () => {
    const s = await summary();
    expect(s.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(s.runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(s.pending.pos).toBe(11);
    expect(s.awaitingLink).toMatchObject({ pos: 8, receiptLines: 8 });
    // No sync of the business sheet has run, so nothing is on the store sheet only.
    expect(s.sheetOnly).toEqual({ pos: 0, value: '0', receiptLines: 0, asOf: null, jobId: null, laterRuns: 0 });
    expect(s.noneRecorded.pos).toBe(3);
    expect([cents(s.pending.value), cents(s.awaitingLink.value), cents(s.noneRecorded.value)]).toEqual([730000, 570000, 160000]);
    expect(s.awaitingLink.pos + s.sheetOnly.pos + s.noneRecorded.pos).toBe(s.pending.pos);
    expect(cents(s.awaitingLink.value) + cents(s.sheetOnly.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
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

  it('applies the list\'s filters to the whole and its parts', async () => {
    const s = await summary({ supplierId: sup.S3! });
    expect([s.pending.pos, s.awaitingLink.pos, s.sheetOnly.pos, s.noneRecorded.pos]).toEqual([2, 1, 0, 1]);
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

  it('lists a line a Super Admin took back that the next run would link again, and the run that keeps it out', async () => {
    // The tab still names Z/RE/00010, so the link rules link it again; the Data Management
    // panel keeps such lines out unless the Super Admin chooses to link them again.
    const line = grns['ZG/RE/0011']!.lines[0]!;
    const d = await dryRun();
    expect(d.totals.linkable).toBe(1);
    expect(d.previouslyUndone).toEqual([{
      grnLineId: line, grnId: grns['ZG/RE/0011']!.id, grnNo: 'ZG/RE/0011', itemCode: 'RE-N', grnQty: '4.0000', poNo: 'Z/RE/00010',
      wouldLink: true, undoAuditId: expect.any(Number), undoneAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      undoReason: 'Purchase says ZG/RE/0011 was against another PO',
    }]);
    expect(d.message).toMatch(/1 of these line\(s\) were linked before and taken back by a Super Admin; keep them out/);
    const kept = await dryRun({ excludeGrnLineIds: [line] });
    expect(kept.totals.linkable).toBe(0);
    expect(kept.previouslyUndone).toMatchObject([{ grnLineId: line, wouldLink: false, poNo: 'Z/RE/00010' }]);
    expect(kept.message).not.toMatch(/taken back/);
    expect(await holdCount()).toBe(15);
  });

  it('a later apply replaces the record as usual', async () => {
    const d = await dryRun();
    expect(d.totals.linkable).toBe(1);
    expect((await apply(d.selectionHash)).status).toBe(200);
    const rows = await holds();
    expect(rows.some((r) => r.reason === 'UNDONE')).toBe(false);
    expect(rows).toHaveLength(14);
    // Linked again by choice: the latest entry for the line is a link, not an undo.
    expect((await dryRun()).previouslyUndone).toEqual([]);
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

describe('Receipts on the store sheet only — GRN tab lines the sync keeps open as missing in the ERP', () => {
  // The business-sheet sync's own run of the GRN tab (google-sync/engine.ts), with the
  // tab handed to it: a GRN number the ERP lacks is kept open as a MISSING_IN_ERP
  // conflict naming the PO, and a row without a GRN number is compared by PO and item.
  const sheetSync = async (tab: string[][]) => (await import('../modules/google-sync/engine.js'))
    .runSync({ trigger: 'SCHEDULED', sheets: ['GRN'], reader: async (sheet: string) => (sheet === 'GRN' ? tab : []) });
  const firstRun = [
    HEADER,
    row('ZG/RE/0101', 'RE-B', '3', 'Z/RE/00002'), // row 2: Z/RE/00002, nothing else recorded
    row('ZG/RE/0102', 'RE-L', '2', ' z/re/00008 '), // row 3: Z/RE/00008, named in lower case
    row('', 'RE-L', '1', 'Z/RE/00008'), // row 4: no GRN number, compared by PO and item
    row('ZG/RE/0103', 'RE-C', '1', 'Z/RE/00003'), // row 5: Z/RE/00003 also awaits a link: counted there
    row('ZG/RE/0105', 'RE-S', '5', 'Z/RE/00014'), // row 6: an administrator resolves it
    row('ZG/RE/0104', 'RE-K', '1', 'Z/RE/00007'), // row 7: off the tab by the next run
  ];
  const jobs: number[] = [];
  type SheetRow = { po_no: string; store_sheet_receipts: number; store_receipts_awaiting_link: number };
  const sheetCounts = async () => Object.fromEntries(((await list({})).data as unknown as SheetRow[])
    .filter((r) => r.store_sheet_receipts > 0).map((r) => [r.po_no, r.store_sheet_receipts]));

  it('counts the lines the latest finished run reports, also those an older run first recorded', async () => {
    jobs.push((await sheetSync(firstRun)).jobId);
    const second = await sheetSync(firstRun.slice(0, -1));
    jobs.push(second.jobId);
    expect(second.sheets[0]!.conflicts).toBe(5);
    // The engine records a line once: the second run inserted none and closed the one it no longer saw.
    const open = await query<{ job_id: number; business_key: string }>(
      `SELECT job_id::int AS job_id, business_key FROM google_sync_errors
        WHERE sheet_name = 'GRN' AND error_code = 'MISSING_IN_ERP' AND resolved_at IS NULL ORDER BY row_number`,
    );
    expect(open.map((o) => [o.job_id, o.business_key])).toEqual([
      [jobs[0], 'ZG/RE/0101 / RE-B'], [jobs[0], 'ZG/RE/0102 / RE-L'], [jobs[0], 'Z/RE/00008 / RE-L'],
      [jobs[0], 'ZG/RE/0103 / RE-C'], [jobs[0], 'ZG/RE/0105 / RE-S'],
    ]);
    expect(await sheetCounts()).toEqual({ 'Z/RE/00002': 1, 'Z/RE/00003': 1, 'Z/RE/00008': 2, 'Z/RE/00014': 1 });
  });

  it('ignores a line the latest run no longer reports, and one an administrator resolved', async () => {
    const [gone] = await query<{ resolution: string }>(
      `SELECT resolution FROM google_sync_errors WHERE sheet_name = 'GRN' AND business_key = 'ZG/RE/0104 / RE-K'`,
    );
    expect(gone!.resolution).toBe(`No longer reported by sync run #${jobs[1]}: the sheet row or the ERP record has changed.`);
    const [issue] = await query<{ id: number }>(
      `SELECT id FROM google_sync_errors WHERE sheet_name = 'GRN' AND business_key = 'ZG/RE/0105 / RE-S' AND resolved_at IS NULL`,
    );
    const resolved = await request(app).post(api(`/google-sync/issues/${issue!.id}/resolve`)).set(auth(adminToken))
      .send({ resolution: 'Store says ZG/RE/0105 was entered on the wrong tab' });
    expect(resolved.status).toBe(200);
    expect(await sheetCounts()).toEqual({ 'Z/RE/00002': 1, 'Z/RE/00003': 1, 'Z/RE/00008': 2 });
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded' })).toEqual(['Z/RE/00007', 'Z/RE/00014']);
  });

  it('puts a PO in one class only: awaiting link before store sheet only before none recorded', async () => {
    const pending = await listNos({ view: 'pending' });
    const awaiting = await listNos({ view: 'pending', receiptEvidence: 'awaiting_link' });
    const sheet = await listNos({ view: 'pending', receiptEvidence: 'sheet_only' });
    const none = await listNos({ view: 'pending', receiptEvidence: 'none_recorded' });
    // Z/RE/00003 has a receipt awaiting link and one on the sheet only: it is counted once, as awaiting link.
    expect(awaiting).toEqual(['Z/RE/00003', 'Z/RE/00004', 'Z/RE/00005', 'Z/RE/00006', 'Z/RE/00009', 'Z/RE/00011', 'Z/RE/00013']);
    expect(sheet).toEqual(['Z/RE/00002', 'Z/RE/00008']);
    expect(none).toEqual(['Z/RE/00007', 'Z/RE/00014']);
    expect([...awaiting, ...sheet, ...none].sort()).toEqual(pending);
    expect(new Set([...awaiting, ...sheet, ...none]).size).toBe(pending.length);
    // With other filters: a supplier, and an item, which selects lines.
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only', supplierId: sup.S1! })).toEqual(['Z/RE/00002', 'Z/RE/00008']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only', itemId: items['RE-L']! })).toEqual(['Z/RE/00008']);
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only', supplierId: sup.S3! })).toEqual([]);
    const t = (await list({ view: 'pending', receiptEvidence: 'sheet_only' })).meta.totals;
    expect([Number(t.poCount), cents(t.pending)]).toEqual([2, 110000]);
  });

  it('adds the three classes up to the pending list exactly, as of the latest finished run', async () => {
    const s = await summary();
    expect(s.pending.pos).toBe(11);
    expect(s.awaitingLink).toMatchObject({ pos: 7, receiptLines: 7 });
    const [run] = await query<{ finished_at: Date }>('SELECT finished_at FROM google_sync_jobs WHERE id = $1', [jobs[1]]);
    expect(s.sheetOnly).toEqual({
      pos: 2, value: '1100.00', receiptLines: 3, asOf: new Date(run!.finished_at).toISOString(), jobId: jobs[1], laterRuns: 0,
    });
    expect(s.noneRecorded.pos).toBe(2);
    expect([cents(s.pending.value), cents(s.awaitingLink.value), cents(s.sheetOnly.value), cents(s.noneRecorded.value)])
      .toEqual([730000, 520000, 110000, 100000]);
    expect(s.awaitingLink.pos + s.sheetOnly.pos + s.noneRecorded.pos).toBe(s.pending.pos);
    expect(cents(s.awaitingLink.value) + cents(s.sheetOnly.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
    expect(s.pending.pos).toBe(Number(await kpi('po_pending_count')));
    expect(cents(s.pending.value)).toBe(cents(await kpi('po_pending_value')));
    const s1 = await summary({ supplierId: sup.S1! });
    expect([s1.awaitingLink.pos, s1.sheetOnly.pos, s1.noneRecorded.pos]).toEqual([6, 2, 0]);
    expect(cents(s1.awaitingLink.value) + cents(s1.sheetOnly.value) + cents(s1.noneRecorded.value)).toBe(cents(s1.pending.value));
  });

  it('exports exactly the rows the list shows, with the count of sheet lines', async () => {
    for (const params of [
      { view: 'pending', receiptEvidence: 'sheet_only' },
      { view: 'pending', receiptEvidence: 'none_recorded' },
      { receiptEvidence: 'sheet_only' },
      { view: 'pending', receiptEvidence: 'sheet_only', itemId: items['RE-L']! },
    ] as Array<Record<string, string | number>>) {
      expect([params, await exportNos(params)]).toEqual([params, await listNos(params)]);
    }
    const res = await request(app).get(api('/io/export/purchase-orders')).query({ format: 'csv', view: 'pending', receiptEvidence: 'sheet_only' })
      .set(auth(adminToken));
    expect(res.text).toMatch(/View: pending {2}· {2}Receipt on store sheet only/);
    expect(res.text.split('\r\n').find((l) => l.startsWith('Z/RE/00008,'))).toMatch(/,0,2$/);
  });

  it('lists the sheet lines on the PO screen, beside any receipt awaiting link', async () => {
    const doc = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00008']!.id}`)).set(auth(adminToken));
    expect(doc.status).toBe(200);
    expect(doc.body.data.storeReceiptsAwaitingLink).toEqual([]);
    const onSheet = { erpReceivedOnPoLine: '0.0000', erpReceiptCoversIt: false, postedAs: null, reportedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) };
    expect(doc.body.data.storeSheetReceipts).toEqual([
      { issueId: expect.any(Number), grnNo: 'ZG/RE/0102', itemCode: 'RE-L', grnQty: '2.0000', sheetRow: 3, ...onSheet },
      { issueId: expect.any(Number), grnNo: null, itemCode: 'RE-L', grnQty: '1.0000', sheetRow: 4, ...onSheet },
    ]);
    expect(doc.body.data.storeSheetReceiptsPostedInErp).toEqual([]);
    // Keyed by the sync issue that records each line.
    expect(new Set(doc.body.data.storeSheetReceipts.map((r: { issueId: number }) => r.issueId)).size).toBe(2);
    const both = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00003']!.id}`)).set(auth(adminToken));
    expect(both.body.data.storeReceiptsAwaitingLink).toMatchObject([{ grnNo: 'ZG/RE/0003', reason: 'SEVERAL_POS' }]);
    expect(both.body.data.storeSheetReceipts).toMatchObject([{ grnNo: 'ZG/RE/0103', itemCode: 'RE-C', grnQty: '1.0000', sheetRow: 5 }]);
    const plain = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00014']!.id}`)).set(auth(adminToken));
    expect(plain.body.data.storeSheetReceipts).toEqual([]);
  });

  it('waits for a run in progress to finish, and is as of the latest run that read the GRN tab through', async () => {
    const missing = (job: number, row: number, grn: string, po: string) => query(
      `INSERT INTO google_sync_errors (job_id, sheet_name, row_number, column_name, business_key, severity, error_code, error_message, incoming_value)
       VALUES ($1, 'GRN', $2, 'GRN No', $3, 'CONFLICT', 'MISSING_IN_ERP', 'GRN line is in the sheet but not in the ERP.', $4::jsonb)`,
      [job, row, `${grn} / RE-S`, JSON.stringify({ poNo: po, grnNo: grn, grnQty: 5, itemCode: 'RE-S' })],
    );
    const [running] = await query<{ id: number }>(`INSERT INTO google_sync_jobs (status, trigger_source) VALUES ('RUNNING', 'SCHEDULED') RETURNING id::int AS id`);
    await missing(running!.id, 8, 'ZG/RE/0106', 'Z/RE/00014');
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only' })).toEqual(['Z/RE/00002', 'Z/RE/00008']);
    expect((await summary()).sheetOnly).toMatchObject({ pos: 2, jobId: jobs[1], laterRuns: 0 });
    // It finishes, having read the tab through (its outcome for the tab carries issuesResolved).
    await query(
      `UPDATE google_sync_jobs SET status = 'PARTIAL', finished_at = now(),
              detail = '[{"sheet": "GRN", "entity": "grns", "rowsRead": 8, "conflicts": 6, "issuesResolved": 0}]'::jsonb
        WHERE id = $1`,
      [running!.id],
    );
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only' })).toEqual(['Z/RE/00002', 'Z/RE/00008', 'Z/RE/00014']);
    const s = await summary();
    expect(s.sheetOnly).toMatchObject({ pos: 3, receiptLines: 4, jobId: running!.id, laterRuns: 0 });
    expect(s.noneRecorded.pos).toBe(1);
    expect(cents(s.awaitingLink.value) + cents(s.sheetOnly.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));

    // Later runs that did not read the tab through still end PARTIAL (2026-10-17 review):
    // a heading renamed, a run of the PO tab only, and a run that failed. None of them
    // checked the tab's open issues, so the lines stay as of the run before; a line one
    // of them carries is not counted, and the summary says how many runs went by.
    const [renamed] = await query<{ id: number }>(
      `INSERT INTO google_sync_jobs (status, trigger_source, finished_at, detail)
       VALUES ('PARTIAL', 'SCHEDULED', now(), '[{"sheet": "GRN", "entity": "grns", "rowsRead": 0, "rejected": 8, "message": "Missing required column(s): Po No."}]'::jsonb)
       RETURNING id::int AS id`,
    );
    await missing(renamed!.id, 9, 'ZG/RE/0107', 'Z/RE/00007');
    await query(`INSERT INTO google_sync_jobs (status, trigger_source, finished_at, detail)
                 VALUES ('SUCCESS', 'MANUAL', now(), '[{"sheet": "Purchase Order", "entity": "purchase_orders", "rowsRead": 3, "issuesResolved": 0}]'::jsonb)`);
    await query(`INSERT INTO google_sync_jobs (status, trigger_source, finished_at, detail) VALUES ('FAILED', 'SCHEDULED', now(), '[]'::jsonb)`);
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only' })).toEqual(['Z/RE/00002', 'Z/RE/00008', 'Z/RE/00014']);
    const later = await summary();
    expect(later.sheetOnly).toMatchObject({ pos: 3, receiptLines: 4, jobId: running!.id, laterRuns: 3, asOf: s.sheetOnly.asOf });
    await query(`DELETE FROM google_sync_errors WHERE job_id = $1`, [renamed!.id]);
  });
});

describe('Receipts on the store sheet only — posted in the ERP under another number', () => {
  // The sync looks for an ERP GRN under the sheet's own GRN number; a GRN posted through
  // the ERP gets the ERP's number, so the sync keeps reporting the line (2026-10-17 review:
  // Z/SM/00043's ZG/SM/0084, posted as GRN-20261017-0001, still asked to be posted).
  const sheetSync = async (tab: string[][]) => (await import('../modules/google-sync/engine.js'))
    .runSync({ trigger: 'SCHEDULED', sheets: ['GRN'], reader: async (sheet: string) => (sheet === 'GRN' ? tab : []) });
  const blank = ['', '', '', '', '', '', '', ''];
  const postGrn = async (po: string, qty: string) => {
    const res = await request(app).post(api('/grn')).set(auth(adminToken))
      .send({ mode: 'PO', invoiceNo: `RE-INV-${po.slice(-2)}-${qty}`, lines: [{ poLineId: pos[po]!.lines[0], grnQty: qty }], post: true });
    expect([res.status, res.body.error?.message]).toEqual([201, undefined]);
    return String(res.body.data.grn_no ?? res.body.data.grnNo);
  };
  let erpGrnNo = '';

  it('stops counting a sheet line once an ERP receipt posted after the sync reported it covers it', async () => {
    await mkItem('RE-T');
    await mkItem('RE-U');
    await mkPo('Z/RE/00015', [['RE-T', '10']]);
    await mkPo('Z/RE/00016', [['RE-U', '10']]);
    // The earlier rows where they were (their issues stay as they are), row 6 cleared
    // (the line an administrator resolved), and two new lines.
    const tab = [
      HEADER,
      row('ZG/RE/0101', 'RE-B', '3', 'Z/RE/00002'),
      row('ZG/RE/0102', 'RE-L', '2', ' z/re/00008 '),
      row('', 'RE-L', '1', 'Z/RE/00008'),
      row('ZG/RE/0103', 'RE-C', '1', 'Z/RE/00003'),
      blank,
      row('ZG/RE/0201', 'RE-T', '4', 'Z/RE/00015'), // row 7: posted below through the ERP, as GRN-…
      row('ZG/RE/0202', 'RE-U', '3', 'Z/RE/00016'), // row 8: a smaller delivery of 2 is posted meanwhile
    ];
    await sheetSync(tab);
    const sheetBefore = await listNos({ view: 'pending', receiptEvidence: 'sheet_only' });
    expect(sheetBefore).toEqual(expect.arrayContaining(['Z/RE/00015', 'Z/RE/00016']));

    erpGrnNo = await postGrn('Z/RE/00015', '4');
    expect(erpGrnNo).toMatch(/^GRN-\d{8}-\d{4}$/);
    await postGrn('Z/RE/00016', '2');
    const again = await sheetSync(tab);
    expect(again.status).not.toBe('FAILED');
    // The sync still reports ZG/RE/0201: no ERP GRN carries that number.
    const [issue] = await query<{ resolved_at: Date | null }>(
      `SELECT resolved_at FROM google_sync_errors WHERE sheet_name = 'GRN' AND business_key = 'ZG/RE/0201 / RE-T' ORDER BY id DESC LIMIT 1`,
    );
    expect(issue!.resolved_at).toBeNull();

    // Z/RE/00015 leaves 'sheet only': 6 of its 10 are still to come and nothing else is
    // recorded against it. Z/RE/00016 stays: the 2 posted do not cover the sheet's 3.
    const sheetAfter = await listNos({ view: 'pending', receiptEvidence: 'sheet_only' });
    expect(sheetAfter).not.toContain('Z/RE/00015');
    expect(sheetAfter).toContain('Z/RE/00016');
    expect(await listNos({ view: 'pending', receiptEvidence: 'none_recorded', search: 'Z/RE/00015' })).toEqual(['Z/RE/00015']);
    expect((await list({ search: 'Z/RE/0001' })).data.filter((r) => ['Z/RE/00015', 'Z/RE/00016'].includes(r.po_no))
      .map((r) => [r.po_no, (r as unknown as { store_sheet_receipts: number }).store_sheet_receipts]).sort())
      .toEqual([['Z/RE/00015', 0], ['Z/RE/00016', 1]]);
    for (const params of [{ view: 'pending', receiptEvidence: 'sheet_only' }, { view: 'pending', receiptEvidence: 'none_recorded' }]) {
      expect([params, await exportNos(params)]).toEqual([params, await listNos(params)]);
    }
    const s = await summary();
    expect(s.awaitingLink.pos + s.sheetOnly.pos + s.noneRecorded.pos).toBe(s.pending.pos);
    expect(cents(s.awaitingLink.value) + cents(s.sheetOnly.value) + cents(s.noneRecorded.value)).toBe(cents(s.pending.value));
  });

  it('lists such a line on the PO screen as posted under the ERP\'s number, and says what the ERP has received', async () => {
    const done = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00015']!.id}`)).set(auth(adminToken));
    expect(done.body.data.storeSheetReceipts).toEqual([]);
    expect(done.body.data.storeSheetReceiptsPostedInErp).toEqual([{
      issueId: expect.any(Number), grnNo: 'ZG/RE/0201', itemCode: 'RE-T', grnQty: '4.0000', sheetRow: 7,
      reportedAt: expect.any(String), erpReceivedOnPoLine: '4.0000', erpReceiptCoversIt: true, postedAs: erpGrnNo,
    }]);
    const partly = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00016']!.id}`)).set(auth(adminToken));
    expect(partly.body.data.storeSheetReceipts).toEqual([{
      issueId: expect.any(Number), grnNo: 'ZG/RE/0202', itemCode: 'RE-U', grnQty: '3.0000', sheetRow: 8,
      reportedAt: expect.any(String), erpReceivedOnPoLine: '2.0000', erpReceiptCoversIt: false, postedAs: null,
    }]);
    expect(partly.body.data.storeSheetReceiptsPostedInErp).toEqual([]);
  });

  it('takes no receipt posted before the sync reported a line as that line, but says the ERP has received as much', async () => {
    // The ERP received 2 on Z/RE/00017 first; the sync then reports a sheet line of 2 for
    // it. Nothing proves the two are one receipt, so the PO stays 'sheet only'; the PO
    // screen says the ERP's 2 already cover the line (and offers no Receive material).
    await mkItem('RE-V');
    await mkPo('Z/RE/00017', [['RE-V', '10']]);
    await postGrn('Z/RE/00017', '2');
    const [job] = await query<{ id: number }>(
      `INSERT INTO google_sync_jobs (status, trigger_source, finished_at, detail)
       VALUES ('PARTIAL', 'SCHEDULED', now(), '[{"sheet": "GRN", "entity": "grns", "rowsRead": 9, "conflicts": 1, "issuesResolved": 0}]'::jsonb)
       RETURNING id::int AS id`,
    );
    await query(
      `INSERT INTO google_sync_errors (job_id, sheet_name, row_number, column_name, business_key, severity, error_code, error_message, incoming_value, created_at)
       VALUES ($1, 'GRN', 9, 'GRN No', 'ZG/RE/0203 / RE-V', 'CONFLICT', 'MISSING_IN_ERP', 'GRN line is in the sheet but not in the ERP.',
               '{"poNo": "Z/RE/00017", "grnNo": "ZG/RE/0203", "grnQty": 2, "itemCode": "RE-V"}'::jsonb, now() + interval '1 second')`,
      [job!.id],
    );
    const doc = await request(app).get(api(`/purchase-orders/${pos['Z/RE/00017']!.id}`)).set(auth(adminToken));
    expect(doc.body.data.storeSheetReceipts).toMatchObject([
      { grnNo: 'ZG/RE/0203', grnQty: '2.0000', erpReceivedOnPoLine: '2.0000', erpReceiptCoversIt: true, postedAs: null },
    ]);
    expect(doc.body.data.storeSheetReceiptsPostedInErp).toEqual([]);
    expect(await listNos({ view: 'pending', receiptEvidence: 'sheet_only', search: 'Z/RE/00017' })).toEqual(['Z/RE/00017']);
    await query('DELETE FROM google_sync_errors WHERE job_id = $1', [job!.id]);
    await query('DELETE FROM google_sync_jobs WHERE id = $1', [job!.id]);
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

  it('comes back whole from a restore, which clears and refills the GRN lines it refers to', async () => {
    const { BACKUP_TABLES, collectBackupData, restoreFromPayload } = await import('../db/restore.js');
    const at = (t: string) => (BACKUP_TABLES as readonly string[]).indexOf(t);
    for (const parent of ['purchase_order_headers', 'purchase_order_lines', 'grn_headers', 'grn_lines']) {
      expect([parent, at(parent) < at('store_grn_link_holds')]).toEqual([parent, true]);
    }
    const before = await holds();
    const beforeSummary = await summary();
    const { data } = await collectBackupData((sql) => query(sql));
    const { withTransaction } = await import('../db/index.js');
    await withTransaction((tx) => restoreFromPayload(tx, { data }));
    expect(await holds()).toEqual(before);
    expect(await summary()).toEqual(beforeSummary);
  });

  it('keeps a deleted PO\'s held receipts, as naming a PO the ERP does not hold, and the inspector lists them first', async () => {
    // Z/RE/00004 is named, with Z/RE/00003, by ZG/RE/0003's held receipt (SEVERAL_POS); its
    // GRN header names no PO, so the GRN count of the inspector never saw it.
    const id = pos['Z/RE/00004']!.id;
    const inspect = await request(app).get(api(`/admin/data-management/inspect/purchase_orders/${id}`)).set(auth(adminToken));
    expect(inspect.status).toBe(200);
    expect(inspect.body.data.dependencies).toContainEqual({ table: 'store_grn_link_holds', label: 'Store receipts awaiting link that name it', count: 1 });
    expect(inspect.body.data.canHardDelete).toBe(true);
    const before = await summary();
    const del = await request(app).post(api('/admin/data-management/hard-delete')).set(auth(adminToken))
      .send({ entity: 'purchase_orders', id, confirm: 'DELETE' });
    expect(del.status).toBe(200);
    expect((await holds()).filter((r) => r.po_no === 'Z/RE/00004')).toMatchObject([{ po_id: null, reason: 'SEVERAL_POS', grn_no: 'ZG/RE/0003' }]);
    const after = await summary();
    expect(after.notInErp).toEqual({ receiptLines: before.notInErp.receiptLines + 1, poNos: before.notInErp.poNos + 1 });
    // Still awaiting link on Z/RE/00003, the other PO the tab names.
    expect(await flagOf('Z/RE/00003')).toBe(1);
  });
});

describe('Planner statistics — a restored database is analysed, and the summary reads one snapshot', () => {
  const statsOf = async () => Object.fromEntries((await query<{ tablename: string; n: number }>(
    `SELECT tablename, COUNT(*)::int AS n FROM pg_stats
      WHERE schemaname = 'public' AND tablename IN ('grn_lines', 'purchase_order_lines') GROUP BY tablename`,
  )).map((r) => [r.tablename, Number(r.n)]));

  it('reads the summary from one snapshot, read only', async () => {
    const { withSnapshot } = await import('../db/index.js');
    const seen = await withSnapshot(async (tx) => ({
      level: (await tx.query<{ transaction_isolation: string }>('SHOW transaction_isolation')).rows[0]!.transaction_isolation,
      readOnly: (await tx.query<{ transaction_read_only: string }>('SHOW transaction_read_only')).rows[0]!.transaction_read_only,
    }));
    expect(seen).toEqual({ level: 'repeatable read', readOnly: 'on' });
    await expect(withSnapshot((tx) => tx.query('UPDATE store_grn_link_holds SET detail = detail'))).rejects.toThrow(/read-only/);
  });

  it('start-up analyses a database whose PO or GRN lines have rows but no statistics, and only then', async () => {
    const { ensurePlannerStatistics } = await import('../db/statistics.js');
    await query(`DELETE FROM pg_statistic WHERE starelid IN ('grn_lines'::regclass, 'purchase_order_lines'::regclass)`);
    expect(await statsOf()).toEqual({});
    expect(await ensurePlannerStatistics()).toEqual({ analysed: true, tables: ['purchase_order_lines', 'grn_lines'] });
    const after = await statsOf();
    expect([after.grn_lines! > 0, after.purchase_order_lines! > 0]).toEqual([true, true]);
    expect(await ensurePlannerStatistics()).toEqual({ analysed: false, tables: [] });
  });

  it('Admin restore analyses what it restored once it has committed', async () => {
    // A restore into a fresh folder left no statistics: on such a copy of the 2026-10-17
    // backup the summary took 76.7 s and froze every other request (2026-10-17 review).
    await query(`DELETE FROM pg_statistic WHERE starelid IN ('grn_lines'::regclass, 'purchase_order_lines'::regclass)`);
    expect(await statsOf()).toEqual({});
    const backup = await request(app).post(api('/backup')).set(auth(adminToken)).send({ notes: 'receipt evidence: restore analyses' });
    expect(backup.status).toBe(201);
    const restored = await request(app).post(api(`/backup/${backup.body.data.id}/restore`)).set(auth(adminToken)).send({ confirm: 'RESTORE' });
    expect(restored.status).toBe(200);
    const after = await statsOf();
    expect([after.grn_lines! > 0, after.purchase_order_lines! > 0]).toEqual([true, true]);
  });
});
