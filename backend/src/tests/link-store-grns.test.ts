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
 *      case), its GRN header names the PO when all its linked lines agree, and the PO's
 *      status is re-derived (OPEN -> COMPLETED / PARTIALLY_RECEIVED). Quantities, stock
 *      and the ledger do not move.
 *   3. Every other POSTED line without a link is listed with its reason: not on the
 *      tab, no PO named ('-', blank, or on one of its rows), several POs, PO not in the
 *      ERP, PO cancelled, item not on the PO, several lines for the item, over-receipt
 *      (counting what the PO line already received; all its receipts held together).
 *   4. A tab or ERP change between the dry run and the apply: 409, nothing written.
 *   5. A second run proposes nothing for the lines already linked.
 *   6. Undo by GRN line ids or by audit entry takes back exactly the links this repair
 *      made, clears the headers it set and re-derives the statuses.
 *   7. Links are audited in batches of whole GRNs, at most 500 lines each.
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

/** A PO as the 2026-10-16 register import left it: OPEN, nothing received. A line may carry another description. */
async function mkPo(no: string, lines: Array<[string, string, string?]>, status = 'OPEN'): Promise<void> {
  const id = Number((await query<{ id: number }>(
    `INSERT INTO purchase_order_headers (po_no, po_date, supplier_id, status, close_reason)
     VALUES ($1, '2026-09-01', $2, $3, $4) RETURNING id`,
    [no, supplierId, status, status === 'CANCELLED' ? 'Cancelled for the test' : null],
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
 * already point to a PO line (an ERP-made GRN).
 */
async function mkGrn(no: string, lines: Array<{ code: string; qty: string; storedCode?: string; poLineId?: number }>, status = 'POSTED'): Promise<void> {
  const id = Number((await query<{ id: number }>(
    `INSERT INTO grn_headers (grn_no, grn_date, supplier_id, status, remarks) VALUES ($1, '2026-10-01', $2, $3, 'Live import from Google Sheets source') RETURNING id`,
    [no, supplierId, status],
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

const dryRun = async () => {
  const res = await request(app).post(LINK).set(auth(adminToken)).send({});
  expect(res.status).toBe(200);
  return res.body.data;
};
const apply = (expectedHash: string) =>
  request(app).post(LINK).set(auth(adminToken)).send({ dryRun: false, confirm: 'LINK STORE GRNS', expectedHash });

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
      unlinkedLines: 19, linkable: 7, linkableBeforeOverReceipt: 10, held: 12, grns: 5, grnHeadersSet: 4, affectedPos: 6,
      byReason: {
        NOT_ON_TAB: 1, NO_PO_NAMED: 3, SEVERAL_POS: 1, PO_NOT_IN_ERP: 1, PO_NOT_RECEIVABLE: 1,
        ITEM_NOT_ON_PO: 1, SEVERAL_PO_LINES: 1, OVER_RECEIPT: 3,
      },
    });
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
    expect(d.headers.map((h: { grnNo: string; poNo: string }) => `${h.grnNo}>${h.poNo}`)).toEqual([
      'ZG/LSG/0001>Z/LSG/00001', 'ZG/LSG/0002>Z/LSG/00002', 'ZG/LSG/0014>Z/LSG/00011', 'ZG/LSG/0018>Z/LSG/00014',
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

    const [batch] = await query<{ before_data: { links: Array<{ grnLineId: number; poLineId: number | null }> }; after_data: { kind: string; links: Array<{ grnLineId: number; poLineId: number }> } }>(
      'SELECT before_data, after_data FROM audit_logs WHERE id = $1', [d.auditIds[0]],
    );
    expect(batch!.after_data.kind).toBe('links');
    expect(batch!.before_data.links).toHaveLength(7);
    expect(batch!.before_data.links.every((l) => l.poLineId === null)).toBe(true);
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
    expect(d.headersCleared.map((h: { grnNo: string }) => h.grnNo).sort()).toEqual(['ZG/LSG/0001', 'ZG/LSG/0014', 'ZG/LSG/0018']);
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
    expect(undo.body.data.headersCleared).toHaveLength(260);
    expect(await statusOf('Z/LSG/00500')).toBe('OPEN');
  });
});
