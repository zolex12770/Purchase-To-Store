/**
 * Integration tests — linking the store's imported GRNs to their purchase orders (2026-10-17).
 *
 * The store's GRNs were imported on 2026-10-14 from the business sheet's GRN tab before
 * their POs existed, so 6,394 of 6,404 GRN lines had no PO link; after the PO register
 * import of 2026-10-16 (sync job 2736) 2,000 of 2,003 POs showed OPEN. POST
 * /admin/data-management/repair/link-store-grns links a line only on the tab's own
 * evidence. Pinned here:
 *
 *   1. Super Admin only; applying needs the typed confirmation and the dry run's hash.
 *   2. A line whose tab rows name one PO holding one line for its item is linked (the
 *      item matched by resolved item, code or description; the PO number ignoring
 *      case), its GRN header names the PO when all its lines agree, and the PO's
 *      status is re-derived (OPEN -> COMPLETED / PARTIALLY_RECEIVED). Quantities, stock
 *      and the ledger do not move.
 *   3. Every other POSTED line without a link is listed with its reason: not on the
 *      tab, no PO named ('-', blank, or on one of its rows), several POs, PO not in the
 *      ERP, PO cancelled, item not on the PO, several lines for the item, another
 *      supplier's PO (unless the GRN carries the import placeholder or the reviewer
 *      confirms the pair), a PO dated over 30 days after the GRN, over-receipt
 *      (counting what the PO line already received; all its receipts held together),
 *      kept out by the reviewer.
 *   4. A tab, ERP or review-choice change between the dry run and the apply: 409,
 *      nothing written.
 *   5. A second run proposes nothing for the lines already linked.
 *   6. Undo by GRN line ids or by audit entry takes back exactly the links this repair
 *      made, a GRN whole, sets back the headers it changed and re-derives the statuses.
 *   7. Links are audited in batches of whole GRNs, at most 500 lines each.
 *   8. A GRN is linked whole or not at all (2026-10-17 review: 169 GRNs would have been
 *      left with some lines linked, which the GRN screen can no longer save). Linked or
 *      held, a store GRN saves again through PUT /grn/:id as the GRN screen sends it;
 *      its header names the one PO of all its lines, else none, also on a later run.
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
let stewardToken = '';
let supplierId = 0;
let uomId = 0;
const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
const api = (p: string) => `/api/v1${p}`;
const LINK = api('/admin/data-management/repair/link-store-grns');
const UNDO = `${LINK}/undo`;

const HEADER = ['GRN No', 'GRN Date', 'Supplier Name', 'Item Code', 'Item Name', 'Unit', 'Recieved Qty', 'Po No'];
const row = (grn: string, code: string, qty: string, po: string) => [grn, '01-Oct-2026', 'Link Store Supplier', code, `Item ${code}`, 'NOS', qty, po];
let grid: string[][] = [HEADER];

const items: Record<string, number> = {};
const pos: Record<string, { id: number; lines: number[] }> = {};
const grns: Record<string, { id: number; lines: number[] }> = {};

async function mkItem(code: string, live = '0'): Promise<number> {
  items[code] = Number((await query<{ id: number }>(
    `INSERT INTO items (item_code, item_description, uom_id, live_stock_qty) VALUES ($1, $2, $3, $4) RETURNING id`,
    [code, `Link store item ${code}`, uomId, live],
  ))[0]!.id);
  return items[code]!;
}

async function mkSupplier(code: string, name: string): Promise<number> {
  return Number((await query<{ id: number }>(
    'INSERT INTO suppliers (supplier_code, supplier_name) VALUES ($1, $2) RETURNING id', [code, name],
  ))[0]!.id);
}

/** A PO as the 2026-10-16 register import left it: OPEN, nothing received. A line may carry another description. */
async function mkPo(
  no: string, lines: Array<[string, string, string?]>, status = 'OPEN', opts: { supplier?: number; date?: string } = {},
): Promise<void> {
  const id = Number((await query<{ id: number }>(
    `INSERT INTO purchase_order_headers (po_no, po_date, supplier_id, status, close_reason)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [no, opts.date ?? '2026-09-01', opts.supplier ?? supplierId, status, status === 'CANCELLED' ? 'Cancelled for the test' : null],
  ))[0]!.id);
  const ids: number[] = [];
  for (const [i, [code, qty, description]] of lines.entries()) {
    ids.push(Number((await query<{ id: number }>(
      `INSERT INTO purchase_order_lines (po_id, line_no, item_id, item_code, item_description, po_qty, uom_id, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 100) RETURNING id`,
      [id, i + 1, items[code], code, description ?? `Link store item ${code}`, qty, uomId],
    ))[0]!.id));
  }
  pos[no] = { id, lines: ids };
}

/**
 * A GRN as the 2026-10-14 store import left it: POSTED, no PO on the header or the
 * lines. A line may be stored under another code than its item's (`storedCode`), or
 * already point to a PO line (an ERP-made GRN), and the header may name a PO.
 */
async function mkGrn(
  no: string, lines: Array<{ code: string; qty: string; storedCode?: string; poLineId?: number }>, status = 'POSTED',
  opts: { supplier?: number; date?: string; poId?: number } = {},
): Promise<void> {
  const id = Number((await query<{ id: number }>(
    `INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status, remarks, po_id)
     VALUES ($1, $2, $3, $4, 'Live import from Google Sheets source', $5) RETURNING id`,
    [no, opts.date ?? '2026-10-01', opts.supplier ?? supplierId, status, opts.poId ?? null],
  ))[0]!.id);
  const ids: number[] = [];
  for (const [i, l] of lines.entries()) {
    ids.push(Number((await query<{ id: number }>(
      `INSERT INTO grn_lines (grn_id, line_no, po_line_id, item_id, item_code, item_description, grn_qty, uom_id, rate)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 100) RETURNING id`,
      [id, i + 1, l.poLineId ?? null, items[l.code], l.storedCode ?? l.code, `Item ${l.storedCode ?? l.code}`, l.qty, uomId],
    ))[0]!.id));
  }
  grns[no] = { id, lines: ids };
}

const poLineOf = async (grnLineId: number) =>
  (await query<{ po_line_id: number | null }>('SELECT po_line_id FROM grn_lines WHERE id = $1', [grnLineId]))[0]!.po_line_id;
const headerPoOf = async (grnNo: string) =>
  (await query<{ po_id: number | null }>('SELECT po_id FROM grn_headers WHERE grn_no = $1', [grnNo]))[0]!.po_id;
const statusOf = async (poNo: string) =>
  (await query<{ status: string }>('SELECT status FROM purchase_order_headers WHERE po_no = $1', [poNo]))[0]!.status;
const count = async (sql: string, params: unknown[] = []) => Number((await query<{ n: number }>(sql, params))[0]!.n);
const linkedLines = () => count(`SELECT COUNT(*)::int AS n FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id WHERE gh.grn_no LIKE 'ZG/LSG/%' AND gl.po_line_id IS NOT NULL`);
const linkAudits = () => count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'store_grn_link'`);
/** Everything the repair must never move: quantities, stock and the ledger. */
const untouchables = async () => (await query<{ grn: string; stock: string; ledger: number }>(
  `SELECT (SELECT COALESCE(SUM(grn_qty), 0)::text FROM grn_lines) AS grn,
          (SELECT COALESCE(SUM(live_stock_qty), 0)::text FROM items) AS stock,
          (SELECT COUNT(*)::int FROM stock_ledger) AS ledger`,
))[0];

type Review = { excludeGrnLineIds?: number[]; sameSupplierPairs?: Array<{ grnSupplierId: number; poSupplierId: number }> };
const dryRun = async (review: Review = {}) => {
  const res = await request(app).post(LINK).set(auth(adminToken)).send(review);
  expect(res.status).toBe(200);
  return res.body.data;
};
const apply = (expectedHash: string, review: Review = {}) =>
  request(app).post(LINK).set(auth(adminToken)).send({ dryRun: false, confirm: 'LINK STORE GRNS', expectedHash, ...review });
const undoLines = (grnLineIds: number[], reason = 'Linked to the wrong PO') =>
  request(app).post(UNDO).set(auth(adminToken)).send({ grnLineIds, reason, confirm: 'UNDO STORE GRN LINKS' });
const heldOf = (d: { held: Array<{ grnNo: string; reason: string }> }, grn: string) => d.held.filter((h) => h.grnNo === grn);
const linksOf = (d: { links: Array<{ grnNo: string; itemCode: string; poNo: string }> }, grn: string) =>
  d.links.filter((l) => l.grnNo === grn).map((l) => `${l.itemCode}>${l.poNo}`);

/**
 * Saves a posted GRN again exactly as the GRN screen does (pages/grn/GrnForm.tsx: the
 * GET /grn/:id document turned into its PUT body), with only the remark changed.
 */
async function resave(grnNo: string, remarks: string) {
  const id = (await query<{ id: number }>('SELECT id FROM grn_headers WHERE grn_no = $1', [grnNo]))[0]!.id;
  const doc = await request(app).get(api(`/grn/${id}`)).set(auth(adminToken));
  expect(doc.status).toBe(200);
  const d = doc.body.data;
  const day = (v: unknown) => (v ? String(v).slice(0, 10) : null);
  const text = (v: unknown) => (v == null ? '' : String(v));
  const num = (v: unknown) => (v == null || v === '' ? null : String(v));
  return request(app).put(api(`/grn/${id}`)).set(auth(adminToken)).send({
    mode: d.mode,
    supplierId: d.mode === 'DIRECT' ? d.supplier_id : undefined,
    grnTypeId: d.grn_type_id, grnDate: day(d.grn_date), invoiceNo: text(d.invoice_no), invoiceDate: day(d.invoice_date),
    challanNo: text(d.challan_no), challanDate: day(d.challan_date),
    transporterName: text(d.transporter_name), vehicleNo: text(d.vehicle_no), driverName: text(d.driver_name),
    lrNo: text(d.lr_no), lrDate: day(d.lr_date),
    remarks, post: true,
    lines: d.lines.map((l: Record<string, unknown>) => ({
      id: l.id, poLineId: l.po_line_id, itemId: l.item_id,
      grnQty: String(l.grn_qty), invoiceQty: num(l.invoice_qty),
      rate: d.mode === 'DIRECT' ? String(l.rate) : undefined,
      batchNo: text(l.batch_no), packageCount: num(l.package_count), packingType: text(l.packing_type),
      expiryDate: day(l.expiry_date), labelCount: num(l.label_count), labelQty: num(l.label_qty),
      location: text(l.receipt_location), remarks: text(l.remarks),
    })),
  });
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
  await conn.query('DROP SCHEMA IF EXISTS public CASCADE');
  await conn.query('CREATE SCHEMA public');
  await runMigrations({ silent: true });
  await seedSystem();
  query = db.query as Q;

  app = createApp();
  // The GRN tab, in place of the Google read.
  app.locals.storeGrnTabReader = async (sheet: string) => (sheet === 'GRN' ? grid : []);
  adminToken = (await request(app).post(api('/auth/login')).send({ employeeId: '10221', password: 'Admin@12345' })).body.data.accessToken;

  // A data steward: reaches Data Management (system.admin) but is not a Super Admin.
  const permission = (await query<{ id: string }>(`SELECT id FROM permissions WHERE code = 'system.admin'`))[0]!.id;
  const role = await request(app).post(api('/roles')).set(auth(adminToken))
    .send({ code: 'LSG_STEWARD', name: 'Link Steward', permissionIds: [Number(permission)] });
  expect(role.status).toBe(201);
  const user = await request(app).post(api('/users')).set(auth(adminToken))
    .send({ employeeId: 'LSG-STEWARD', employeeName: 'Link Steward', password: 'Steward@2026x', mustChangePassword: false, roleIds: [role.body.data.id] });
  expect(user.status).toBe(201);
  stewardToken = (await request(app).post(api('/auth/login')).send({ employeeId: 'LSG-STEWARD', password: 'Steward@2026x' })).body.data.accessToken;

  uomId = Number((await query<{ id: number }>(`SELECT id FROM lookups WHERE category = 'UOM' AND code = 'NOS'`))[0]!.id);
  supplierId = Number((await query<{ id: number }>(
    `INSERT INTO suppliers (supplier_code, supplier_name) VALUES ('LSG-SUP', 'Link Store Supplier') RETURNING id`,
  ))[0]!.id);
  for (const code of ['LSG-A', 'LSG-B', 'LSG-C', 'LSG-D', 'LSG-E', 'LSG-F', 'LSG-G', 'LSG-H', 'LSG-I', 'LSG-J', 'LSG-K', 'LSG-L', 'LSG-N', 'LSG-O', 'LSG-P', 'LSG-Q']) {
    await mkItem(code, '50');
  }
  // The purchase code the tab and the GRN use (CCLSG625) is not the item master's code.
  await mkItem('FCLSG62.5', '7');

  await mkPo('Z/LSG/00001', [['LSG-A', '10'], ['LSG-B', '5']]);
  await mkPo('Z/LSG/00002', [['LSG-C', '10']]);
  await mkPo('Z/LSG/00003', [['LSG-E', '5']]);
  await mkPo('Z/LSG/00004', [['LSG-E', '5']]);
  await mkPo('Z/LSG/00005', [['LSG-A', '5']]);
  await mkPo('Z/LSG/00006', [['LSG-G', '5'], ['LSG-G', '5']]);
  await mkPo('Z/LSG/00007', [['LSG-H', '10']]);
  await mkPo('Z/LSG/00008', [['LSG-J', '5']], 'CANCELLED');
  await mkPo('Z/LSG/00009', [['LSG-K', '2']]);
  await mkPo('Z/LSG/00010', [['LSG-L', '10']]);
  await mkPo('Z/LSG/00011', [['FCLSG62.5', '7']]);
  await mkPo('Z/LSG/00013', [['LSG-O', '5']], 'PARTIALLY_RECEIVED');
  // Held under a duplicate item master row (LSG-Q) that carries the receipt's description.
  await mkPo('Z/LSG/00014', [['LSG-Q', '1', 'Item LSG-P']]);

  await mkGrn('ZG/LSG/0001', [{ code: 'LSG-A', qty: '10' }, { code: 'LSG-B', qty: '5' }]);
  await mkGrn('ZG/LSG/0002', [{ code: 'LSG-C', qty: '4' }]);
  await mkGrn('ZG/LSG/0003', [{ code: 'LSG-D', qty: '1' }]);
  await mkGrn('ZG/LSG/0004', [{ code: 'LSG-D', qty: '2' }]);
  await mkGrn('ZG/LSG/0005', [{ code: 'LSG-E', qty: '3' }]);
  await mkGrn('ZG/LSG/0006', [{ code: 'LSG-E', qty: '1' }]);
  await mkGrn('ZG/LSG/0007', [{ code: 'LSG-F', qty: '2' }]);
  await mkGrn('ZG/LSG/0008', [{ code: 'LSG-G', qty: '2' }]);
  await mkGrn('ZG/LSG/0009', [{ code: 'LSG-H', qty: '6' }]);
  await mkGrn('ZG/LSG/0010', [{ code: 'LSG-H', qty: '5' }]);
  await mkGrn('ZG/LSG/0011', [{ code: 'LSG-I', qty: '1' }]);
  await mkGrn('ZG/LSG/0012', [{ code: 'LSG-J', qty: '1' }]);
  await mkGrn('ZG/LSG/0013', [{ code: 'LSG-K', qty: '2' }, { code: 'LSG-L', qty: '3' }]);
  await mkGrn('ZG/LSG/0014', [{ code: 'FCLSG62.5', storedCode: 'CCLSG625', qty: '7' }]);
  await mkGrn('ZG/LSG/0015', [{ code: 'LSG-N', qty: '2' }]);
  // Z/LSG/00013 has already received 4 of 5 through a GRN raised in the ERP.
  await mkGrn('GRN-LSG-0001', [{ code: 'LSG-O', qty: '4', poLineId: pos['Z/LSG/00013']!.lines[0] }]);
  await mkGrn('ZG/LSG/0017', [{ code: 'LSG-O', qty: '2' }]);
  await mkGrn('ZG/LSG/0018', [{ code: 'LSG-P', qty: '1' }]);
  // Not posted: never considered, though the tab names a PO for it.
  await mkGrn('ZG/LSG/0099', [{ code: 'LSG-A', qty: '1' }], 'DRAFT');

  grid = [
    HEADER,
    row('ZG/LSG/0001', 'LSG-A', '10', 'Z/LSG/00001'),
    row('ZG/LSG/0001', 'LSG-B', '5', 'Z/LSG/00001'),
    row('ZG/LSG/0002', 'LSG-C', '4', 'z/lsg/00002'),
    row('ZG/LSG/0003', 'LSG-D', '1', '-'),
    row('ZG/LSG/0004', 'LSG-D', '2', ''),
    row('ZG/LSG/0005', 'LSG-E', '2', 'Z/LSG/00003'),
    row('ZG/LSG/0005', 'LSG-E', '1', 'Z/LSG/00004'),
    row('ZG/LSG/0006', 'LSG-E', '1', 'Z/LSG/09999'),
    row('ZG/LSG/0007', 'LSG-F', '2', 'Z/LSG/00005'),
    row('ZG/LSG/0008', 'LSG-G', '2', 'Z/LSG/00006'),
    row('ZG/LSG/0009', 'LSG-H', '6', 'Z/LSG/00007'),
    row('ZG/LSG/0010', 'LSG-H', '5', 'Z/LSG/00007'),
    row('ZG/LSG/0012', 'LSG-J', '1', 'Z/LSG/00008'),
    row('ZG/LSG/0013', 'LSG-K', '2', 'Z/LSG/00009'),
    row('ZG/LSG/0013', 'LSG-L', '3', 'Z/LSG/00010'),
    row('ZG/LSG/0014', 'CCLSG625', '7', 'Z/LSG/00011'),
    row('ZG/LSG/0015', 'LSG-N', '1', 'Z/LSG/00012'),
    row('ZG/LSG/0015', 'LSG-N', '1', '-'),
    row('ZG/LSG/0017', 'LSG-O', '2', 'Z/LSG/00013'),
    row('ZG/LSG/0018', 'LSG-P', '1', 'Z/LSG/00014'),
    row('ZG/LSG/0099', 'LSG-A', '1', 'Z/LSG/00001'),
    ['', '', '', '', '', '', '', ''],
  ];
});

afterAll(async () => {
  await closeDb?.();
});

describe('Link store GRNs — access and confirmation', () => {
  it('refuses anyone but a Super Admin, even with Data Management access', async () => {
    const dry = await request(app).post(LINK).set(auth(stewardToken)).send({});
    expect(dry.status).toBe(403);
    expect(dry.body.error.message).toBe('Super Admin access is required.');
    const undo = await request(app).post(UNDO).set(auth(stewardToken)).send({ auditId: 1, reason: 'not allowed', confirm: 'UNDO STORE GRN LINKS' });
    expect(undo.status).toBe(403);
    expect(undo.body.error.message).toBe('Super Admin access is required.');
  });

  it('applies only with the typed confirmation and the dry run hash', async () => {
    const noConfirm = await request(app).post(LINK).set(auth(adminToken)).send({ dryRun: false, expectedHash: 'a'.repeat(64) });
    expect(noConfirm.status).toBe(422);
    const noHash = await request(app).post(LINK).set(auth(adminToken)).send({ dryRun: false, confirm: 'LINK STORE GRNS' });
    expect(noHash.status).toBe(422);
    expect(await linkedLines()).toBe(0);
  });
});

describe('Link store GRNs — dry run, apply, second run', () => {
  let hash = '';
  let before: Awaited<ReturnType<typeof untouchables>>;

  it('lists what it would link and why every other posted line is not, and writes nothing', async () => {
    before = await untouchables();
    const d = await dryRun();
    expect(d.dryRun).toBe(true);
    expect(d.selectionHash).toMatch(/^[0-9a-f]{64}$/);
    hash = d.selectionHash;
    expect(d.totals).toMatchObject({
      unlinkedLines: 19, linkable: 7, linkableBeforeOverReceipt: 10, linkableBeforeWholeGrn: 7, held: 12, grns: 5,
      grnHeadersSet: 4, grnHeadersCleared: 0, affectedPos: 6, placeholderSupplierLinks: 0,
      byReason: {
        EXCLUDED: 0, NOT_ON_TAB: 1, NO_PO_NAMED: 3, SEVERAL_POS: 1, PO_NOT_IN_ERP: 1, PO_NOT_RECEIVABLE: 1,
        ITEM_NOT_ON_PO: 1, SEVERAL_PO_LINES: 1, SUPPLIER_MISMATCH: 0, PO_AFTER_RECEIPT: 0, OVER_RECEIPT: 3, GRN_PARTLY_HELD: 0,
      },
    });
    expect(d.supplierPairs).toEqual([]);
    expect(d.review).toEqual({ excludeGrnLineIds: [], excludedNotUnlinked: [], sameSupplierPairs: [] });
    expect(d.overReceivedPoLines).toBe(2);

    const linkOf = (grn: string) => d.links.filter((l: { grnNo: string }) => l.grnNo === grn).map((l: { itemCode: string; poNo: string }) => `${l.itemCode}>${l.poNo}`);
    expect(linkOf('ZG/LSG/0001')).toEqual(['LSG-A>Z/LSG/00001', 'LSG-B>Z/LSG/00001']);
    expect(linkOf('ZG/LSG/0002')).toEqual(['LSG-C>Z/LSG/00002']); // the tab wrote the PO number in lower case
    expect(linkOf('ZG/LSG/0013')).toEqual(['LSG-K>Z/LSG/00009', 'LSG-L>Z/LSG/00010']);
    expect(linkOf('ZG/LSG/0014')).toEqual(['CCLSG625>Z/LSG/00011']); // matched by the resolved item, not the code
    expect(linkOf('ZG/LSG/0018')).toEqual(['LSG-P>Z/LSG/00014']); // matched by the description

    const reasonOf = (grn: string) => d.held.filter((h: { grnNo: string }) => h.grnNo === grn).map((h: { reason: string }) => h.reason);
    expect(reasonOf('ZG/LSG/0003')).toEqual(['NO_PO_NAMED']);
    expect(reasonOf('ZG/LSG/0004')).toEqual(['NO_PO_NAMED']);
    expect(reasonOf('ZG/LSG/0015')).toEqual(['NO_PO_NAMED']); // one of its two rows names no PO
    expect(reasonOf('ZG/LSG/0005')).toEqual(['SEVERAL_POS']);
    expect(reasonOf('ZG/LSG/0006')).toEqual(['PO_NOT_IN_ERP']);
    expect(reasonOf('ZG/LSG/0007')).toEqual(['ITEM_NOT_ON_PO']);
    expect(reasonOf('ZG/LSG/0008')).toEqual(['SEVERAL_PO_LINES']);
    expect(reasonOf('ZG/LSG/0009')).toEqual(['OVER_RECEIPT']);
    expect(reasonOf('ZG/LSG/0010')).toEqual(['OVER_RECEIPT']);
    expect(reasonOf('ZG/LSG/0011')).toEqual(['NOT_ON_TAB']);
    expect(reasonOf('ZG/LSG/0012')).toEqual(['PO_NOT_RECEIVABLE']);
    expect(reasonOf('ZG/LSG/0017')).toEqual(['OVER_RECEIPT']);
    expect(reasonOf('ZG/LSG/0099')).toEqual([]); // a DRAFT GRN is not a receipt
    const several = d.held.find((h: { grnNo: string }) => h.grnNo === 'ZG/LSG/0005');
    expect(several.poNos).toEqual(['Z/LSG/00003', 'Z/LSG/00004']);
    // Together the two receipts on Z/LSG/00007 exceed its 10: neither is linked.
    const over = d.held.find((h: { grnNo: string }) => h.grnNo === 'ZG/LSG/0009');
    expect(over.poLine).toMatchObject({ poNo: 'Z/LSG/00007', poQty: '10.0000', receivedQty: '0.0000', proposedQty: '11.0000', wouldReceive: '11.0000', receipts: 2 });
    // What a PO line received before counts: 4 + 2 > 5.
    const already = d.held.find((h: { grnNo: string }) => h.grnNo === 'ZG/LSG/0017');
    expect(already.poLine).toMatchObject({ poQty: '5.0000', receivedQty: '4.0000', wouldReceive: '6.0000' });

    const status = Object.fromEntries(d.affectedPos.map((p: { poNo: string; statusBefore: string; statusAfter: string }) => [p.poNo, `${p.statusBefore}>${p.statusAfter}`]));
    expect(status).toEqual({
      'Z/LSG/00001': 'OPEN>COMPLETED', 'Z/LSG/00002': 'OPEN>PARTIALLY_RECEIVED', 'Z/LSG/00009': 'OPEN>COMPLETED',
      'Z/LSG/00010': 'OPEN>PARTIALLY_RECEIVED', 'Z/LSG/00011': 'OPEN>COMPLETED', 'Z/LSG/00014': 'OPEN>COMPLETED',
    });
    expect(d.statusTransitions).toEqual({ 'OPEN -> COMPLETED': 4, 'OPEN -> PARTIALLY_RECEIVED': 2 });
    // Pending value at rate 100: A 10 + B 5 + C 4 + K 2 + L 3 + FCLSG 7 + P 1 = 32 units received.
    expect(Number(d.pendingValue.before) - Number(d.pendingValue.after)).toBe(3200);
    expect(d.headers.map((h: { grnNo: string; poNoBefore: string | null; poNoAfter: string }) => `${h.grnNo}:${h.poNoBefore}>${h.poNoAfter}`)).toEqual([
      'ZG/LSG/0001:null>Z/LSG/00001', 'ZG/LSG/0002:null>Z/LSG/00002', 'ZG/LSG/0014:null>Z/LSG/00011', 'ZG/LSG/0018:null>Z/LSG/00014',
    ]);

    expect(await linkedLines()).toBe(0);
    expect(await linkAudits()).toBe(0);
    expect(await untouchables()).toEqual(before);
  });

  it('refuses with 409 and writes nothing when the tab has changed since the dry run', async () => {
    const saved = grid;
    grid = grid.map((r) => (r[0] === 'ZG/LSG/0002' ? row('ZG/LSG/0002', 'LSG-C', '4', '-') : r));
    const res = await apply(hash);
    expect(res.status).toBe(409);
    expect(res.body.error.message).toMatch(/changed since the dry run/);
    grid = saved;
    expect(await linkedLines()).toBe(0);
    expect(await linkAudits()).toBe(0);
  });

  it('refuses with 409 and writes nothing when a receipt arrived in the ERP since the dry run', async () => {
    const extra = await query<{ id: number }>(
      `INSERT INTO grn_lines (grn_id, line_no, po_line_id, item_id, item_code, item_description, grn_qty, uom_id, rate)
       VALUES ($1, 2, $2, $3, 'LSG-C', 'Item LSG-C', 1, $4, 100) RETURNING id`,
      [grns['GRN-LSG-0001']!.id, pos['Z/LSG/00002']!.lines[0], items['LSG-C'], uomId],
    );
    const res = await apply(hash);
    expect(res.status).toBe(409);
    await query('DELETE FROM grn_lines WHERE id = $1', [extra[0]!.id]);
    expect(await linkedLines()).toBe(0);
    expect(await linkAudits()).toBe(0);
  });

  it('links exactly the planned lines, names the PO on single-PO GRNs and re-derives the PO statuses', async () => {
    const res = await apply(hash);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d).toMatchObject({ dryRun: false, linesLinked: 7, headersSet: 4, poStatusesRederived: 6 });
    expect(d.auditIds).toHaveLength(1);

    const g = (no: string, i = 0) => grns[no]!.lines[i]!;
    const p = (no: string, i = 0) => pos[no]!.lines[i]!;
    expect(Number(await poLineOf(g('ZG/LSG/0001', 0)))).toBe(p('Z/LSG/00001', 0));
    expect(Number(await poLineOf(g('ZG/LSG/0001', 1)))).toBe(p('Z/LSG/00001', 1));
    expect(Number(await poLineOf(g('ZG/LSG/0002')))).toBe(p('Z/LSG/00002'));
    expect(Number(await poLineOf(g('ZG/LSG/0013', 0)))).toBe(p('Z/LSG/00009'));
    expect(Number(await poLineOf(g('ZG/LSG/0013', 1)))).toBe(p('Z/LSG/00010'));
    expect(Number(await poLineOf(g('ZG/LSG/0014')))).toBe(p('Z/LSG/00011'));
    expect(Number(await poLineOf(g('ZG/LSG/0018')))).toBe(p('Z/LSG/00014'));
    for (const held of ['ZG/LSG/0003', 'ZG/LSG/0005', 'ZG/LSG/0009', 'ZG/LSG/0010', 'ZG/LSG/0012', 'ZG/LSG/0017', 'ZG/LSG/0099']) {
      expect(await poLineOf(g(held))).toBeNull();
    }
    expect(Number(await headerPoOf('ZG/LSG/0001'))).toBe(pos['Z/LSG/00001']!.id);
    expect(Number(await headerPoOf('ZG/LSG/0014'))).toBe(pos['Z/LSG/00011']!.id);
    expect(await headerPoOf('ZG/LSG/0013')).toBeNull(); // its lines went to two POs
    expect(await headerPoOf('ZG/LSG/0009')).toBeNull();

    expect(await statusOf('Z/LSG/00001')).toBe('COMPLETED');
    expect(await statusOf('Z/LSG/00002')).toBe('PARTIALLY_RECEIVED');
    expect(await statusOf('Z/LSG/00009')).toBe('COMPLETED');
    expect(await statusOf('Z/LSG/00010')).toBe('PARTIALLY_RECEIVED');
    expect(await statusOf('Z/LSG/00011')).toBe('COMPLETED');
    expect(await statusOf('Z/LSG/00014')).toBe('COMPLETED');
    expect(await statusOf('Z/LSG/00007')).toBe('OPEN');
    expect(await statusOf('Z/LSG/00013')).toBe('PARTIALLY_RECEIVED');
    expect(await count(`SELECT COUNT(*)::int AS n FROM v_po_line_balance WHERE received_qty > po_qty`)).toBe(0);
    expect(await untouchables()).toEqual(before);

    const [batch] = await query<{
      before_data: { links: Array<{ grnLineId: number; poLineId: number | null }>; headers: Array<{ grnId: number; poId: number | null }> };
      after_data: { kind: string; links: Array<{ grnLineId: number; poLineId: number }> };
    }>('SELECT before_data, after_data FROM audit_logs WHERE id = $1', [d.auditIds[0]]);
    expect(batch!.after_data.kind).toBe('links');
    expect(batch!.before_data.links).toHaveLength(7);
    expect(batch!.before_data.links.every((l) => l.poLineId === null)).toBe(true);
    expect(batch!.before_data.headers).toEqual([
      { grnId: grns['ZG/LSG/0001']!.id, poId: null }, { grnId: grns['ZG/LSG/0002']!.id, poId: null },
      { grnId: grns['ZG/LSG/0014']!.id, poId: null }, { grnId: grns['ZG/LSG/0018']!.id, poId: null },
    ]);
    expect(batch!.after_data.links.find((l) => l.grnLineId === g('ZG/LSG/0002'))!.poLineId).toBe(p('Z/LSG/00002'));
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run'`)).toBe(1);
  });

  it('proposes nothing on a second run for the lines it already linked', async () => {
    const d = await dryRun();
    expect(d.totals).toMatchObject({ unlinkedLines: 12, linkable: 0, held: 12 });
    expect(d.held.every((h: { reason: string }) => h.reason !== 'NOT_ON_TAB' || h.grnNo === 'ZG/LSG/0011')).toBe(true);
    const again = await apply(d.selectionHash);
    expect(again.status).toBe(422);
    expect(await linkedLines()).toBe(7);
  });
});

describe('Link store GRNs — undo', () => {
  it('takes back the links of the GRN lines named, clears the header it set and re-derives the PO', async () => {
    const line = grns['ZG/LSG/0002']!.lines[0]!;
    const bad = await request(app).post(UNDO).set(auth(adminToken)).send({ grnLineIds: [line], reason: 'Wrong PO on the tab' });
    expect(bad.status).toBe(422);
    const both = await request(app).post(UNDO).set(auth(adminToken))
      .send({ grnLineIds: [line], auditId: 1, reason: 'Wrong PO on the tab', confirm: 'UNDO STORE GRN LINKS' });
    expect(both.status).toBe(422);

    const res = await request(app).post(UNDO).set(auth(adminToken))
      .send({ grnLineIds: [line, grns['ZG/LSG/0003']!.lines[0]], reason: 'Wrong PO on the tab', confirm: 'UNDO STORE GRN LINKS' });
    expect(res.status).toBe(200);
    expect(res.body.data.undone.map((u: { grnNo: string }) => u.grnNo)).toEqual(['ZG/LSG/0002']);
    expect(res.body.data.headersRestored).toEqual([
      { grnId: grns['ZG/LSG/0002']!.id, grnNo: 'ZG/LSG/0002', repairSet: pos['Z/LSG/00002']!.id, restoredTo: null },
    ]);
    expect(res.body.data.skipped).toEqual([{ grnLineId: grns['ZG/LSG/0003']!.lines[0], reason: 'This repair never linked it.' }]);
    expect(await poLineOf(line)).toBeNull();
    expect(await headerPoOf('ZG/LSG/0002')).toBeNull();
    expect(await statusOf('Z/LSG/00002')).toBe('OPEN');
    expect(await linkedLines()).toBe(6);
  });

  it('takes back a whole run by its audit entry, skipping what is already undone, and only once', async () => {
    const [run] = await query<{ id: number }>(`SELECT id FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run'`);
    const res = await request(app).post(UNDO).set(auth(adminToken))
      .send({ auditId: run!.id, reason: 'Re-run after the tab is corrected', confirm: 'UNDO STORE GRN LINKS' });
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.undone).toHaveLength(6);
    expect(d.skipped).toEqual([{ grnLineId: grns['ZG/LSG/0002']!.lines[0], reason: 'It is not linked now (already undone).' }]);
    expect(d.headersRestored.map((h: { grnNo: string; restoredTo: number | null }) => `${h.grnNo}>${h.restoredTo}`).sort())
      .toEqual(['ZG/LSG/0001>null', 'ZG/LSG/0014>null', 'ZG/LSG/0018>null']);
    expect(d.headersLeft).toEqual([]);
    expect(await linkedLines()).toBe(0);
    for (const po of ['Z/LSG/00001', 'Z/LSG/00009', 'Z/LSG/00010', 'Z/LSG/00011', 'Z/LSG/00014']) expect(await statusOf(po)).toBe('OPEN');
    expect(await statusOf('Z/LSG/00013')).toBe('PARTIALLY_RECEIVED'); // its ERP-made GRN link was never this repair's
    expect(Number(await poLineOf(grns['GRN-LSG-0001']!.lines[0]!))).toBe(pos['Z/LSG/00013']!.lines[0]);
    expect(await count(`SELECT COUNT(*)::int AS n FROM audit_logs WHERE entity = 'store_grn_link' AND action = 'CANCEL'`)).toBe(2);

    const again = await request(app).post(UNDO).set(auth(adminToken))
      .send({ auditId: run!.id, reason: 'Re-run after the tab is corrected', confirm: 'UNDO STORE GRN LINKS' });
    expect(again.status).toBe(422);
    const undoEntry = (await query<{ id: number }>(`SELECT id FROM audit_logs WHERE entity = 'store_grn_link' AND action = 'CANCEL' ORDER BY id DESC LIMIT 1`))[0]!;
    const ofUndo = await request(app).post(UNDO).set(auth(adminToken))
      .send({ auditId: undoEntry.id, reason: 'Undo the undo', confirm: 'UNDO STORE GRN LINKS' });
    expect(ofUndo.status).toBe(422);
  });

  it('proposes the same links again from the same evidence once they are undone', async () => {
    const d = await dryRun();
    expect(d.totals).toMatchObject({ unlinkedLines: 19, linkable: 7 });
  });
});

describe('Link store GRNs — a GRN is linked whole or not at all', () => {
  // ZG/LSW/0001: LSG-R on Z/LSG/00020, LSG-S on Z/LSG/00021, which the PO register has
  // not brought in yet. ZG/LSW/0002 links on its own. ZG/LSW/0003 was raised in the ERP
  // against Z/LSG/00024, which its header names; the tab puts its other line on Z/LSG/00023.
  // The earlier fixtures are not on this tab.
  beforeAll(async () => {
    for (const code of ['LSG-R', 'LSG-S', 'LSG-U', 'LSG-V', 'LSG-W']) await mkItem(code, '50');
    await mkPo('Z/LSG/00020', [['LSG-R', '10']]);
    await mkPo('Z/LSG/00022', [['LSG-U', '10']]);
    await mkPo('Z/LSG/00023', [['LSG-W', '10']]);
    await mkPo('Z/LSG/00024', [['LSG-V', '10']]);
    await mkGrn('ZG/LSW/0001', [{ code: 'LSG-R', qty: '4' }, { code: 'LSG-S', qty: '3' }]);
    await mkGrn('ZG/LSW/0002', [{ code: 'LSG-U', qty: '2' }]);
    await mkGrn('ZG/LSW/0003', [{ code: 'LSG-V', qty: '1', poLineId: pos['Z/LSG/00024']!.lines[0] }, { code: 'LSG-W', qty: '1' }],
      'POSTED', { poId: pos['Z/LSG/00024']!.id });
    grid = [
      HEADER,
      row('ZG/LSW/0001', 'LSG-R', '4', 'Z/LSG/00020'),
      row('ZG/LSW/0001', 'LSG-S', '3', 'Z/LSG/00021'),
      row('ZG/LSW/0002', 'LSG-U', '2', 'Z/LSG/00022'),
      row('ZG/LSW/0003', 'LSG-V', '1', 'Z/LSG/00024'),
      row('ZG/LSW/0003', 'LSG-W', '1', 'Z/LSG/00023'),
    ];
  });

  it('holds every line of a GRN that has a held line, naming it, and every store GRN still saves from the GRN screen', async () => {
    const d = await dryRun();
    const w1 = heldOf(d, 'ZG/LSW/0001');
    expect(w1.map((h) => `${h.itemCode}:${h.reason}`)).toEqual(['LSG-R:GRN_PARTLY_HELD', 'LSG-S:PO_NOT_IN_ERP']);
    expect(w1[0]).toMatchObject({
      poNos: ['Z/LSG/00020'],
      blockedBy: [{ grnLineId: grns['ZG/LSW/0001']!.lines[1], itemCode: 'LSG-S', reason: 'PO_NOT_IN_ERP' }],
    });
    expect((w1[0] as unknown as { detail: string }).detail).toMatch(/^ZG\/LSW\/0001 is linked whole or not at all, and 1 of its line\(s\) are held: LSG-S \(PO_NOT_IN_ERP\)/);
    expect(linksOf(d, 'ZG/LSW/0001')).toEqual([]);
    expect(linksOf(d, 'ZG/LSW/0002')).toEqual(['LSG-U>Z/LSG/00022']);
    expect(linksOf(d, 'ZG/LSW/0003')).toEqual(['LSG-W>Z/LSG/00023']);
    expect(d.totals).toMatchObject({
      linkable: 2, linkableBeforeWholeGrn: 3, grnHeadersSet: 1, grnHeadersCleared: 1, byReason: { GRN_PARTLY_HELD: 1, PO_NOT_IN_ERP: 1 },
    });
    // ZG/LSW/0003's lines will point to two POs, so its header no longer names one.
    expect(d.headers.map((h: { grnNo: string; poNoBefore: string | null; poNoAfter: string | null }) => `${h.grnNo}:${h.poNoBefore}>${h.poNoAfter}`))
      .toEqual(['ZG/LSW/0002:null>Z/LSG/00022', 'ZG/LSW/0003:Z/LSG/00024>null']);

    // Before the repair a store GRN saves as a DIRECT GRN.
    expect((await resave('ZG/LSW/0001', 'Checked before linking')).status).toBe(200);
    const res = await apply(d.selectionHash);
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ linesLinked: 2, headersSet: 1, headersCleared: 1 });

    // Held whole: no line points to a PO line, and it saves as before.
    for (const id of grns['ZG/LSW/0001']!.lines) expect(await poLineOf(id)).toBeNull();
    expect((await resave('ZG/LSW/0001', 'Edited after the link run')).status).toBe(200);
    // Linked whole: it saves as a PO GRN and its header keeps its one PO.
    const linked = await resave('ZG/LSW/0002', 'Edited after the link run');
    expect(linked.status).toBe(200);
    expect(Number(await headerPoOf('ZG/LSW/0002'))).toBe(pos['Z/LSG/00022']!.id);
    // On two POs: it saves, and the GRN edit derives the same empty header.
    expect((await resave('ZG/LSW/0003', 'Edited after the link run')).status).toBe(200);
    expect(await headerPoOf('ZG/LSW/0003')).toBeNull();
    const [batch] = await query<{ before_data: { headers: unknown[] }; after_data: { headers: unknown[] } }>(
      'SELECT before_data, after_data FROM audit_logs WHERE id = $1', [res.body.data.auditIds[0]],
    );
    expect(batch!.before_data.headers).toEqual([
      { grnId: grns['ZG/LSW/0002']!.id, poId: null }, { grnId: grns['ZG/LSW/0003']!.id, poId: pos['Z/LSG/00024']!.id },
    ]);
  });

  it('links the whole GRN once its second PO is in, and its header then names no PO', async () => {
    // The review's case: run 1 would have named Z/LSG/00020 on the header and kept it
    // when run 2 linked the other line to another PO.
    await mkPo('Z/LSG/00021', [['LSG-S', '10']]);
    const d = await dryRun();
    expect(linksOf(d, 'ZG/LSW/0001')).toEqual(['LSG-R>Z/LSG/00020', 'LSG-S>Z/LSG/00021']);
    expect(d.totals).toMatchObject({ linkable: 2, grnHeadersSet: 0, grnHeadersCleared: 0 });
    const res = await apply(d.selectionHash);
    expect(res.status).toBe(200);
    const [r, s] = grns['ZG/LSW/0001']!.lines;
    expect(Number(await poLineOf(r!))).toBe(pos['Z/LSG/00020']!.lines[0]);
    expect(Number(await poLineOf(s!))).toBe(pos['Z/LSG/00021']!.lines[0]);
    expect(await headerPoOf('ZG/LSW/0001')).toBeNull();
    expect(await statusOf('Z/LSG/00020')).toBe('PARTIALLY_RECEIVED');
    expect(await statusOf('Z/LSG/00021')).toBe('PARTIALLY_RECEIVED');
    expect((await resave('ZG/LSW/0001', 'Edited after the second run')).status).toBe(200);
    expect(await headerPoOf('ZG/LSW/0001')).toBeNull();
  });

  it('sets a header it cleared back to the PO it named when the link is undone', async () => {
    const w = grns['ZG/LSW/0003']!.lines[1]!;
    const res = await undoLines([w]);
    expect(res.status).toBe(200);
    expect(res.body.data.headersRestored).toEqual([
      { grnId: grns['ZG/LSW/0003']!.id, grnNo: 'ZG/LSW/0003', repairSet: null, restoredTo: pos['Z/LSG/00024']!.id },
    ]);
    expect(await poLineOf(w)).toBeNull();
    // The ERP's own link is not this repair's to take back.
    expect(Number(await poLineOf(grns['ZG/LSW/0003']!.lines[0]!))).toBe(pos['Z/LSG/00024']!.lines[0]);
    expect(Number(await headerPoOf('ZG/LSW/0003'))).toBe(pos['Z/LSG/00024']!.id);
    expect(await statusOf('Z/LSG/00023')).toBe('OPEN');
  });

  it('undoes a GRN whole: one line of a GRN linked whole is not taken back alone', async () => {
    const [r, s] = grns['ZG/LSW/0001']!.lines;
    const one = await undoLines([r!]);
    expect(one.status).toBe(422);
    expect(one.body.error.details.skipped).toEqual([
      { grnLineId: r, reason: expect.stringMatching(/^ZG\/LSW\/0001 is undone whole, and its line\(s\) \d+ \(audit #\d+\), linked by this repair, are not in this undo/) },
    ]);
    expect(Number(await poLineOf(r!))).toBe(pos['Z/LSG/00020']!.lines[0]);

    const both = await undoLines([r!, s!]);
    expect(both.status).toBe(200);
    expect(both.body.data.undone).toHaveLength(2);
    expect(await statusOf('Z/LSG/00020')).toBe('OPEN');
    expect(await statusOf('Z/LSG/00021')).toBe('OPEN');
    expect((await resave('ZG/LSW/0001', 'Edited after the undo')).status).toBe(200);
  });
});

describe('Link store GRNs — supplier, PO date and the reviewer\'s choices', () => {
  let starA = 0;
  let starB = 0;
  let other = 0;
  // Two records of one company (the copy of 2026-10-17 has 'GLOBAL  STAR' and 'GLOBAL STAR'),
  // another company, and the supplier the store import gave GRNs whose row named none.
  beforeAll(async () => {
    starA = await mkSupplier('LSG-STAR-1', 'LSG STAR  TRADERS');
    starB = await mkSupplier('LSG-STAR-2', 'LSG Star Traders Pvt Ltd');
    other = await mkSupplier('LSG-OTHER', 'LSG Other Company Ltd');
    const placeholder = await mkSupplier('SUP-UNSPECIFIED', 'Unspecified / Direct Store Inward');
    for (const code of ['LSG-X', 'LSG-Y', 'LSG-Z']) await mkItem(code, '50');
    await mkPo('Z/LSG/00030', [['LSG-X', '10']], 'OPEN', { supplier: other });
    await mkPo('Z/LSG/00031', [['LSG-Y', '5']]);
    await mkPo('Z/LSG/00032', [['LSG-Z', '10']], 'OPEN', { supplier: starB });
    await mkPo('Z/LSG/00033', [['LSG-Y', '5']]);
    await mkGrn('ZG/LSS/0001', [{ code: 'LSG-X', qty: '2' }], 'POSTED', { supplier: starA });
    await mkGrn('ZG/LSS/0002', [{ code: 'LSG-X', qty: '3' }], 'POSTED', { supplier: placeholder });
    await mkGrn('ZG/LSS/0003', [{ code: 'LSG-Y', qty: '1' }], 'POSTED', { date: '2026-07-15' });
    await mkGrn('ZG/LSS/0004', [{ code: 'LSG-Z', qty: '4' }], 'POSTED', { supplier: starA });
    await mkGrn('ZG/LSS/0005', [{ code: 'LSG-Y', qty: '1' }], 'POSTED', { date: '2026-08-02' });
    grid = [
      HEADER,
      row('ZG/LSS/0001', 'LSG-X', '2', 'Z/LSG/00030'),
      row('ZG/LSS/0002', 'LSG-X', '3', 'Z/LSG/00030'),
      row('ZG/LSS/0003', 'LSG-Y', '1', 'Z/LSG/00031'),
      row('ZG/LSS/0004', 'LSG-Z', '4', 'Z/LSG/00032'),
      row('ZG/LSS/0005', 'LSG-Y', '1', 'Z/LSG/00033'),
    ];
  });

  it('holds another supplier\'s PO and a PO dated over 30 days after the GRN, and lets the import placeholder through', async () => {
    const d = await dryRun();
    expect(heldOf(d, 'ZG/LSS/0001')).toMatchObject([{
      reason: 'SUPPLIER_MISMATCH', poNos: ['Z/LSG/00030'],
      suppliers: { grnSupplierId: starA, grnSupplier: 'LSG STAR  TRADERS', poSupplierId: other, poSupplier: 'LSG Other Company Ltd' },
    }]);
    expect(heldOf(d, 'ZG/LSS/0004').map((h) => h.reason)).toEqual(['SUPPLIER_MISMATCH']);
    // The import placeholder is no supplier evidence; the PO the tab names is.
    expect(linksOf(d, 'ZG/LSS/0002')).toEqual(['LSG-X>Z/LSG/00030']);
    expect(d.totals.placeholderSupplierLinks).toBe(1);
    expect(d.supplierPairs).toEqual([
      { grnSupplierId: starA, grnSupplier: 'LSG STAR  TRADERS', poSupplierId: starB, poSupplier: 'LSG Star Traders Pvt Ltd', confirmedSame: false, lines: 1, grns: ['ZG/LSS/0004'] },
      { grnSupplierId: starA, grnSupplier: 'LSG STAR  TRADERS', poSupplierId: other, poSupplier: 'LSG Other Company Ltd', confirmedSame: false, lines: 1, grns: ['ZG/LSS/0001'] },
    ]);
    // 2026-07-15 to 2026-09-01 is 48 days; 2026-08-02 to 2026-09-01 is 30 and still taken.
    expect(heldOf(d, 'ZG/LSS/0003')).toMatchObject([{ reason: 'PO_AFTER_RECEIPT', dates: { grnDate: '2026-07-15', poDate: '2026-09-01', days: 48 } }]);
    expect(linksOf(d, 'ZG/LSS/0005')).toEqual(['LSG-Y>Z/LSG/00033']);
  });

  it('links a supplier pair the reviewer confirms as one company, and the apply must carry the same choice', async () => {
    const plain = await dryRun();
    const pairs = [{ grnSupplierId: starA, poSupplierId: starB }];
    const d = await dryRun({ sameSupplierPairs: pairs });
    expect(linksOf(d, 'ZG/LSS/0004')).toEqual(['LSG-Z>Z/LSG/00032']);
    expect(heldOf(d, 'ZG/LSS/0001').map((h) => h.reason)).toEqual(['SUPPLIER_MISMATCH']);
    expect(d.supplierPairs.map((p: { poSupplierId: number; confirmedSame: boolean }) => [p.poSupplierId, p.confirmedSame])).toEqual([[starB, true], [other, false]]);
    expect(d.review.sameSupplierPairs).toEqual(pairs);
    expect(d.selectionHash).not.toBe(plain.selectionHash);
    // The same pair named the other way round is the same choice.
    expect((await dryRun({ sameSupplierPairs: [{ grnSupplierId: starB, poSupplierId: starA }] })).selectionHash).toBe(d.selectionHash);

    expect((await apply(d.selectionHash)).status).toBe(409);
    expect((await apply(plain.selectionHash, { sameSupplierPairs: pairs })).status).toBe(409);
    expect(await poLineOf(grns['ZG/LSS/0004']!.lines[0]!)).toBeNull();

    const res = await apply(d.selectionHash, { sameSupplierPairs: pairs });
    expect(res.status).toBe(200);
    expect(res.body.data.linesLinked).toBe(3);
    expect(Number(await poLineOf(grns['ZG/LSS/0004']!.lines[0]!))).toBe(pos['Z/LSG/00032']!.lines[0]);
    expect(Number(await poLineOf(grns['ZG/LSS/0002']!.lines[0]!))).toBe(pos['Z/LSG/00030']!.lines[0]);
    expect(await poLineOf(grns['ZG/LSS/0001']!.lines[0]!)).toBeNull();
    expect(await poLineOf(grns['ZG/LSS/0003']!.lines[0]!)).toBeNull();
    const [runEntry] = await query<{ after_data: { review: { sameSupplierPairs: unknown[] } } }>(
      `SELECT after_data FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run' ORDER BY id DESC LIMIT 1`,
    );
    expect(runEntry!.after_data.review.sameSupplierPairs).toEqual(pairs);
  });

  it('keeps out the lines the reviewer names, with the rest of their GRN, and the apply must name the same', async () => {
    for (const code of ['LSG-E1', 'LSG-E2', 'LSG-E3']) await mkItem(code, '50');
    await mkPo('Z/LSG/00040', [['LSG-E1', '10'], ['LSG-E2', '10']]);
    await mkPo('Z/LSG/00041', [['LSG-E3', '10']]);
    await mkGrn('ZG/LSE/0001', [{ code: 'LSG-E1', qty: '1' }, { code: 'LSG-E2', qty: '1' }]);
    await mkGrn('ZG/LSE/0002', [{ code: 'LSG-E3', qty: '1' }]);
    grid = [
      HEADER,
      row('ZG/LSE/0001', 'LSG-E1', '1', 'Z/LSG/00040'),
      row('ZG/LSE/0001', 'LSG-E2', '1', 'Z/LSG/00040'),
      row('ZG/LSE/0002', 'LSG-E3', '1', 'Z/LSG/00041'),
    ];
    const [e1, e2] = grns['ZG/LSE/0001']!.lines;
    const exclude = [999999999, e1!];
    const d = await dryRun({ excludeGrnLineIds: exclude });
    expect(heldOf(d, 'ZG/LSE/0001').map((h) => `${h.itemCode}:${h.reason}`)).toEqual(['LSG-E1:EXCLUDED', 'LSG-E2:GRN_PARTLY_HELD']);
    expect(heldOf(d, 'ZG/LSE/0001')[1]).toMatchObject({ blockedBy: [{ grnLineId: e1, itemCode: 'LSG-E1', reason: 'EXCLUDED' }] });
    expect(linksOf(d, 'ZG/LSE/0002')).toEqual(['LSG-E3>Z/LSG/00041']);
    expect(d.review).toEqual({ excludeGrnLineIds: [e1, 999999999], excludedNotUnlinked: [999999999], sameSupplierPairs: [] });

    // Other exclusions are another review, even when they would write the same links.
    expect((await apply(d.selectionHash)).status).toBe(409);
    expect((await apply(d.selectionHash, { excludeGrnLineIds: [e1!] })).status).toBe(409);
    expect(await poLineOf(grns['ZG/LSE/0002']!.lines[0]!)).toBeNull();

    const res = await apply(d.selectionHash, { excludeGrnLineIds: exclude });
    expect(res.status).toBe(200);
    expect(res.body.data.linesLinked).toBe(1);
    expect(await poLineOf(e1!)).toBeNull();
    expect(await poLineOf(e2!)).toBeNull();
    expect(Number(await poLineOf(grns['ZG/LSE/0002']!.lines[0]!))).toBe(pos['Z/LSG/00041']!.lines[0]);
  });
});

describe('Link store GRNs — audit batches', () => {
  it('audits at most 500 lines per entry, whole GRNs only, and undoes a run across its batches', async () => {
    // 260 GRNs of two lines each, all on one PO line; the tab now lists only them
    // (the earlier fixtures' lines are then simply not on the tab).
    await mkItem('LSG-BULK', '0');
    await mkPo('Z/LSG/00500', [['LSG-BULK', '1000']]);
    const created = await query<{ id: number }>(
      `WITH h AS (
         INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status)
         SELECT 'ZG/LSB/' || lpad(i::text, 4, '0'), '2026-10-01', $1, 'POSTED' FROM generate_series(1, 260) AS i
         RETURNING id)
       INSERT INTO grn_lines (grn_id, line_no, item_id, item_code, item_description, grn_qty, uom_id, rate)
       SELECT h.id, n, $2, 'LSG-BULK', 'Bulk item', 1, $3, 10 FROM h, generate_series(1, 2) AS n
       RETURNING id`,
      [supplierId, items['LSG-BULK'], uomId],
    );
    expect(created).toHaveLength(520);
    grid = [HEADER, ...Array.from({ length: 260 }, (_, k) => row(`ZG/LSB/${String(k + 1).padStart(4, '0')}`, 'LSG-BULK', '2', 'Z/LSG/00500'))];

    const d = await dryRun();
    expect(d.totals).toMatchObject({ linkable: 520, grnHeadersSet: 260 });
    const res = await apply(d.selectionHash);
    expect(res.status).toBe(200);
    expect(res.body.data.auditIds).toHaveLength(2);
    const sizes = await query<{ n: number }>(
      `SELECT jsonb_array_length(after_data->'links') AS n FROM audit_logs WHERE id = ANY($1::bigint[]) ORDER BY id`, [res.body.data.auditIds],
    );
    expect(sizes.map((s) => Number(s.n))).toEqual([500, 20]);
    expect(await statusOf('Z/LSG/00500')).toBe('PARTIALLY_RECEIVED');

    const [runEntry] = await query<{ id: number }>(
      `SELECT id FROM audit_logs WHERE entity = 'store_grn_link' AND after_data->>'kind' = 'run' ORDER BY id DESC LIMIT 1`,
    );
    const undo = await request(app).post(UNDO).set(auth(adminToken))
      .send({ auditId: runEntry!.id, reason: 'Batch test clean-up', confirm: 'UNDO STORE GRN LINKS' });
    expect(undo.status).toBe(200);
    expect(undo.body.data.undone).toHaveLength(520);
    expect(undo.body.data.headersRestored).toHaveLength(260);
    expect(await statusOf('Z/LSG/00500')).toBe('OPEN');
  });
});
