/**
 * Integration tests — an export holds exactly the rows its list shows (2026-10-16 audit, F06).
 *
 * Each io export used to keep a smaller filter of its own; on staging ten filtered
 * exports differed from their lists: PO view=pending 179 vs 180, overdue 0 vs 180,
 * search=cable 4 vs 0; indents itemId 8 vs 1,814, search 8 vs 0; GRN qcStatus 0 vs
 * 2,718, poId 1 vs 2,718; the requisition Mine / HOD / Store-queue views 22, 20 and 591
 * requisitions vs all 1,256 in the file; audit entity=grn 44 vs 1,430. Every case is
 * pinned here as list total == export rows, and the same rows. The Item, User and
 * Supplier lists, whose exports took one filter or none, are pinned too.
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
let requesterToken = '';
let hodToken = '';
const ids: Record<string, number> = {};
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

function qs(params: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(Array.isArray(v) ? v.join(',') : String(v))}`);
  }
  return parts.length > 0 ? `?${parts.join('&')}` : '';
}

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

/** RFC 4180 records: quoted cells may hold commas, quotes and line breaks. */
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

interface ExportFile { context: string[]; rows: Record<string, string>[] }

/** An io export as CSV: four context lines and a blank line, then the header and the data rows. */
async function exportFile(dataset: string, filters: Record<string, unknown>, token = adminToken): Promise<ExportFile> {
  const res = await request(app).get(`/api/v1/io/export/${dataset}${qs({ ...filters, format: 'csv' })}`).set(auth(token));
  expect(res.status).toBe(200);
  const records = parseCsv(res.text.replace(/^﻿/, ''));
  const header = records[5]!;
  return {
    context: records.slice(0, 4).map((r) => r[0] ?? ''),
    rows: records.slice(6).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? '']))),
  };
}

/** The list exactly as the screen asks for it, every row on one page. */
async function list(path: string, filters: Record<string, unknown>, token = adminToken) {
  const res = await request(app).get(`/api/v1/${path}${qs({ ...filters, pageSize: 200 })}`).set(auth(token));
  expect(res.status).toBe(200);
  expect(res.body.meta.total).toBeLessThanOrEqual(200);
  return res.body as { data: Record<string, unknown>[]; meta: { total: number; totals?: Record<string, unknown> } };
}

/** list total == export rows, and the same records by their document number. */
async function expectParity(
  path: string, dataset: string, filters: Record<string, unknown>, keys: { list: string; file: string }, token = adminToken,
): Promise<{ total: number; file: ExportFile }> {
  const l = await list(path, filters, token);
  const file = await exportFile(dataset, filters, token);
  expect(file.rows).toHaveLength(l.meta.total);
  expect(file.rows.map((r) => r[keys.file]).sort()).toEqual(l.data.map((r) => String(r[keys.list])).sort());
  return { total: l.meta.total, file };
}

async function poLineIds(poId: number): Promise<number[]> {
  const po = await request(app).get(`/api/v1/purchase-orders/${poId}`).set(auth(adminToken));
  return po.body.data.lines.map((l: { po_line_id: number }) => Number(l.po_line_id));
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

  /* ── Masters ─────────────────────────────────────────────────────────────── */
  const options = await request(app).get('/api/v1/lookups/options').set(auth(adminToken));
  const uomId = options.body.data.UOM[0].id as number;
  const mk = async (category: string, code: string, name: string) => {
    const res = await request(app).post(`/api/v1/lookups/${category}`).set(auth(adminToken)).send({ code, name });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  ids.indentType = await mk('INDENT_TYPE', 'XPAR-IT', 'Parity Regular');
  ids.poType = await mk('PO_TYPE', 'XPAR-PT', 'Parity Standard');
  ids.dept = await mk('DEPARTMENT', 'XPAR-D', 'Parity Department');
  ids.cc = await mk('COST_CENTRE', 'XPAR-CC', 'Parity Cost Centre');

  for (const [key, body] of Object.entries({
    supplierOne: { supplierName: 'XPAR Supplier One', city: 'Surat', state: 'Gujarat', email: 'buyer@xpar-one.example' },
    supplierTwo: { supplierName: 'XPAR Supplier Two', city: 'Pune', state: 'Maharashtra' },
  })) {
    const res = await request(app).post('/api/v1/suppliers').set(auth(adminToken)).send(body);
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }
  for (const [key, body] of Object.entries({
    cable: { itemCode: 'XPAR-CABLE', itemDescription: 'Copper cable 4 sq mm', uomId, standardRate: '100', departmentId: ids.dept },
    bolt: { itemCode: 'XPAR-BOLT', itemDescription: 'Hex bolt M8', uomId, standardRate: '50', itemSpecification: 'XPAR-SPEC-ZINC' },
  })) {
    const res = await request(app).post('/api/v1/items').set(auth(adminToken)).send(body);
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }

  /* ── People: a requester and an HOD who may list and export requisitions ───── */
  const perms = await query<{ id: string }>(
    `SELECT id FROM permissions WHERE code = ANY($1)`,
    [['requisition.view', 'requisition.create', 'requisition.approve', 'requisition.export']],
  );
  const role = await request(app).post('/api/v1/roles').set(auth(adminToken))
    .send({ code: 'XPAR_REQ', name: 'Parity Requisitions', permissionIds: perms.map((p) => Number(p.id)) });
  expect(role.status).toBe(201);
  ids.role = role.body.data.id;
  for (const [key, employeeId, name] of [['requester', 'XPAR-REQ', 'Parity Requester'], ['hod', 'XPAR-HOD', 'Parity HOD']] as const) {
    const res = await request(app).post('/api/v1/users').set(auth(adminToken)).send({
      employeeId, employeeName: name, designation: 'Staff', password: 'Parity@Test2026', mustChangePassword: false,
      roleIds: [ids.role], departmentId: ids.dept,
    });
    expect(res.status).toBe(201);
    ids[key] = res.body.data.id;
  }
  const mapped = await request(app).put(`/api/v1/requisitions/departments/${ids.dept}/hod`).set(auth(adminToken))
    .send({ hodUserId: ids.hod });
  expect(mapped.status).toBe(200);
  requesterToken = await signIn('XPAR-REQ', ['Parity@Test2026']);
  hodToken = await signIn('XPAR-HOD', ['Parity@Test2026']);

  /* ── Indents: cable only, bolt only, both ──────────────────────────────────── */
  const indent = async (lines: Array<[number, string]>) => {
    const res = await request(app).post('/api/v1/indents').set(auth(adminToken)).send({
      indentTypeId: ids.indentType, requiredByDate: '2026-12-31', departmentId: ids.dept, costCentreId: ids.cc,
      lines: lines.map(([itemId, qty]) => ({ itemId, indentQty: qty, estimatedRate: '10' })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  await indent([[ids.cable, '10']]);
  await indent([[ids.bolt, '4']]);
  await indent([[ids.cable, '2'], [ids.bolt, '1']]);

  /* ── Purchase orders ───────────────────────────────────────────────────────── */
  const po = async (supplierId: number, lines: Array<[number, string, string, string?]>, issue = true) => {
    const res = await request(app).post('/api/v1/purchase-orders').set(auth(adminToken)).send({
      supplierId, poTypeId: ids.poType, issue,
      lines: lines.map(([itemId, poQty, rate, deliveryDate]) => ({ itemId, poQty, rate, discountPct: '0', sources: [], deliveryDate })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  ids.poOverdue = await po(ids.supplierOne, [[ids.cable, '10', '100', '2026-01-15']]);  // pending, overdue
  ids.poDone = await po(ids.supplierOne, [[ids.bolt, '5', '50']]);                      // received in full below
  ids.poDraft = await po(ids.supplierTwo, [[ids.bolt, '3', '50']], false);              // never issued
  ids.poPartial = await po(ids.supplierOne, [[ids.cable, '4', '100', '2099-01-01']]);   // half received below

  /* ── GRNs: one per PO, a direct one, and one spanning two POs ──────────────── */
  const grn = async (body: Record<string, unknown>) => {
    const res = await request(app).post('/api/v1/grn').set(auth(adminToken)).send({ post: true, ...body });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  const [doneLine] = await poLineIds(ids.poDone);
  const [partialLine] = await poLineIds(ids.poPartial);
  const [overdueLine] = await poLineIds(ids.poOverdue);
  ids.grnDone = await grn({ mode: 'PO', lines: [{ poLineId: doneLine, grnQty: '5' }] });
  ids.grnPartial = await grn({ mode: 'PO', lines: [{ poLineId: partialLine, grnQty: '1' }] });
  ids.grnDirect = await grn({ mode: 'DIRECT', supplierId: ids.supplierTwo, lines: [{ itemId: ids.bolt, grnQty: '2', rate: '40' }] });
  ids.grnMulti = await grn({ mode: 'PO', lines: [{ poLineId: overdueLine, grnQty: '1' }, { poLineId: partialLine, grnQty: '1' }] });
  // An inspection outcome the list can filter on (the GRN form's posting path sets none).
  await query(`UPDATE grn_headers SET qc_status = 'PENDING_QC' WHERE id = $1`, [ids.grnDirect]);

  /* ── Requisitions: pending with the HOD, approved, and a draft ─────────────── */
  const requisition = async (submit: boolean, lines: Array<[number, string]>) => {
    const res = await request(app).post('/api/v1/requisitions').set(auth(adminToken)).send({
      requesterUserId: ids.requester, costCentreId: ids.cc, submit,
      lines: lines.map(([itemId, requestedQty]) => ({ itemId, requestedQty })),
    });
    expect(res.status).toBe(201);
    return res.body.data.id as number;
  };
  ids.reqPending = await requisition(true, [[ids.cable, '2'], [ids.bolt, '1']]);
  ids.reqApproved = await requisition(true, [[ids.bolt, '3']]);
  const approved = await request(app).post(`/api/v1/requisitions/${ids.reqApproved}/approve`).set(auth(hodToken)).send({});
  expect(approved.status).toBe(200);
  ids.reqDraft = await requisition(false, [[ids.cable, '1']]);
}, 180_000);

afterAll(async () => {
  await closeDb?.();
});

describe('Purchase orders: the export holds exactly the rows the list shows', () => {
  const keys = { list: 'po_no', file: 'PO No' };

  it('the Pending view (the file held every PO)', async () => {
    const { total, file } = await expectParity('purchase-orders', 'purchase-orders', { view: 'pending' }, keys);
    expect(total).toBe(2);
    expect(file.context[2]).toContain('View: pending');
  });

  it('overdue only (0 on screen and 180 in the file on staging)', async () => {
    const { total } = await expectParity('purchase-orders', 'purchase-orders', { view: 'pending', overdue: 'true' }, keys);
    expect(total).toBe(1);
  });

  it('a search that matches an item on a line (4 on screen, 0 in the file)', async () => {
    const { total } = await expectParity('purchase-orders', 'purchase-orders', { search: 'cable' }, keys);
    expect(total).toBe(2);
  });

  it('the Complete view and a status filter', async () => {
    expect((await expectParity('purchase-orders', 'purchase-orders', { view: 'complete' }, keys)).total).toBe(1);
    expect((await expectParity('purchase-orders', 'purchase-orders', { status: 'DRAFT' }, keys)).total).toBe(1);
  });

  it('the lines export holds every line of exactly those orders', async () => {
    const l = await list('purchase-orders', { search: 'cable' });
    const file = await exportFile('po-lines', { search: 'cable' });
    expect([...new Set(file.rows.map((r) => r['PO No']))].sort()).toEqual(l.data.map((r) => String(r.po_no)).sort());
    expect(file.rows).toHaveLength(Number(l.meta.totals?.lineCount));
  });

  it('a value the list refuses is refused by its export, not ignored', async () => {
    const res = await request(app).get(`/api/v1/io/export/purchase-orders${qs({ format: 'csv', view: 'bogus' })}`).set(auth(adminToken));
    expect(res.status).toBe(422);
  });
});

describe('Indents', () => {
  const keys = { list: 'indent_no', file: 'Indent No' };

  it('an item filter (8 on screen, 1,814 in the file)', async () => {
    expect((await expectParity('indents', 'indents', { itemId: ids.cable }, keys)).total).toBe(2);
  });

  it('a search on an item code (8 on screen, 0 in the file)', async () => {
    expect((await expectParity('indents', 'indents', { search: 'XPAR-CABLE' }, keys)).total).toBe(2);
  });

  it('the lines export holds every line of exactly those indents', async () => {
    const l = await list('indents', { itemId: ids.cable });
    const file = await exportFile('indent-lines', { itemId: ids.cable });
    expect([...new Set(file.rows.map((r) => r['Indent No']))].sort()).toEqual(l.data.map((r) => String(r.indent_no)).sort());
    expect(file.rows).toHaveLength(Number(l.meta.totals?.lineCount));
  });
});

describe('Goods receipts', () => {
  const keys = { list: 'grn_no', file: 'GRN No' };

  it('a QC status (0 on screen, 2,718 in the file)', async () => {
    expect((await expectParity('grn', 'grn', { qcStatus: 'PENDING_QC' }, keys)).total).toBe(1);
  });

  it('a purchase order, a GRN spanning two orders included (1 on screen, 2,718 in the file)', async () => {
    const { file } = await expectParity('grn', 'grn', { poId: ids.poPartial }, keys);
    // Its own GRN and the two-PO GRN, whose header names no single PO.
    expect(file.rows).toHaveLength(2);
    const multi = await query<{ po_id: string | null }>(`SELECT po_id FROM grn_headers WHERE id = $1`, [ids.grnMulti]);
    expect(multi[0]!.po_id).toBeNull();
    expect((await expectParity('grn', 'grn', { poId: ids.poOverdue }, keys)).total).toBe(1);
  });

  it('the Direct mode and the lines export', async () => {
    expect((await expectParity('grn', 'grn', { mode: 'DIRECT' }, keys)).total).toBe(1);
    const l = await list('grn', { mode: 'PO' });
    const file = await exportFile('grn-lines', { mode: 'PO' });
    expect([...new Set(file.rows.map((r) => r['GRN No']))].sort()).toEqual(l.data.map((r) => String(r.grn_no)).sort());
    expect(file.rows).toHaveLength(Number(l.meta.totals?.lineCount));
  });
});

describe('Requisitions: the views export only what they list', () => {
  /** The requisition list's Export button exports lines: every line of exactly the listed requisitions. */
  async function expectLineParity(filters: Record<string, unknown>, token: string): Promise<number> {
    const l = await list('requisitions', filters, token);
    const file = await exportFile('requisition-lines', filters, token);
    expect([...new Set(file.rows.map((r) => r['Requisition No']))].sort())
      .toEqual(l.data.map((r) => String(r.requisition_no)).sort());
    expect(file.rows).toHaveLength(Number(l.meta.totals?.lineCount));
    const headers = await exportFile('requisitions', filters, token);
    expect(headers.rows).toHaveLength(l.meta.total);
    return l.meta.total;
  }

  it('Mine (22 on screen, all 1,256 in the file)', async () => {
    expect(await expectLineParity({ view: 'mine' }, requesterToken)).toBe(3);
    // The same view as someone else: theirs, not the requester's.
    expect(await expectLineParity({ view: 'mine' }, hodToken)).toBe(0);
  });

  it('HOD pending (20 on screen)', async () => {
    expect(await expectLineParity({ view: 'hod-pending' }, hodToken)).toBe(1);
  });

  it('Store queue (591 on screen)', async () => {
    expect(await expectLineParity({ view: 'store-queue' }, adminToken)).toBe(1);
  });

  it('an item filter: every line of the requisitions holding the item', async () => {
    expect(await expectLineParity({ itemId: ids.cable }, adminToken)).toBe(2);
  });
});

describe('Audit log and masters', () => {
  it('the audit log by entity (44 on screen, 1,430 in the file)', async () => {
    const l = await list('audit', { entity: 'grn' });
    expect(l.meta.total).toBeGreaterThan(0);
    const file = await exportFile('audit', { entity: 'grn' });
    expect(file.rows).toHaveLength(l.meta.total);
    expect(new Set(file.rows.map((r) => r.Entity))).toEqual(new Set(['grn']));
  });

  it('items: a search on the specification, which the export did not search', async () => {
    const { total } = await expectParity('items', 'items', { search: 'XPAR-SPEC' }, { list: 'item_code', file: 'Item Code' });
    expect(total).toBe(1);
  });

  it('suppliers: a search on the e-mail, and the active filter', async () => {
    const keys = { list: 'supplier_name', file: 'Supplier Name' };
    expect((await expectParity('suppliers', 'suppliers', { search: 'xpar-one.example' }, keys)).total).toBe(1);
    expect((await expectParity('suppliers', 'suppliers', { isActive: 'true', search: 'XPAR' }, keys)).total).toBe(2);
  });

  it('users: a role filter, which the export ignored', async () => {
    const { total } = await expectParity('users', 'users', { roleId: ids.role }, { list: 'employee_id', file: 'Employee ID' });
    expect(total).toBe(2);
  });

  it('the file header names the filters applied, an inactive-only filter included', async () => {
    const { file } = await expectParity('items', 'items', { isActive: 'false' }, { list: 'item_code', file: 'Item Code' });
    expect(file.context[2]).toBe('Active: No');
    const pending = await exportFile('purchase-orders', { view: 'pending', overdue: 'false', search: 'cable' });
    expect(pending.context[2]).toBe('View: pending  ·  Search: "cable"');
  });
});

describe('Exports are complete or refused', () => {
  it('refuses above the cap instead of cutting the file short', async () => {
    const { EXPORT_ROW_CAP, refuseTruncatedExport } = await import('../core/http.js');
    expect(() => refuseTruncatedExport(EXPORT_ROW_CAP)).not.toThrow();
    expect(() => refuseTruncatedExport(EXPORT_ROW_CAP + 1)).toThrow(/would exceed 2,00,000 rows/);
  });
});
