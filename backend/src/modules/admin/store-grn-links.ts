/**
 * Links the store's imported GRNs to their purchase orders (admin repair, 2026-10-17).
 *
 * The store's GRNs were imported on 2026-10-14 from the business sheet's GRN tab,
 * before their purchase orders existed in the ERP: 6,394 of 6,404 GRN lines carry no
 * po_line_id and their headers no po_id. On 2026-10-16 12:39 UTC the scheduled sync
 * imported the PO register (job 2736: 1,823 POs, 5,147 lines), and 2,000 of 2,003
 * POs then showed OPEN with about Rs 79.5 Cr pending receipt, although the tab
 * records each receipt's PO in its 'Po No' column.
 *
 * The evidence is that tab, read by the sync engine's reader with the engine's own
 * column mapping for it. A POSTED GRN line without a PO link is linked only when
 *   · its GRN number and item are on the tab, the item matched as the engine's GRN
 *     reconciliation matches it: the resolved item, the code or the description;
 *   · every tab row for it names the same one PO (a blank or '-' names none);
 *   · that PO is in the ERP, is neither DRAFT nor CANCELLED (neither can hold a
 *     receipt), and has exactly one line for the item, matched the same way;
 *   · the PO line has then received no more than it ordered (+0.0001). All the
 *     receipts the tab assigns to one PO line are linked together or not at all, so
 *     the result never depends on which receipt happens to be counted first.
 * Every other line is listed with its reason and figures. Only grn_lines.po_line_id
 * and, when all of a GRN's linked lines point to one PO, grn_headers.po_id are
 * written, and the affected POs' statuses are re-derived. Quantities, stock and the
 * ledger are never touched and nothing is deleted. Each batch of links is recorded
 * in the audit log, and undo takes back exactly the links recorded there.
 */
import { createHash, randomUUID } from 'node:crypto';
import { txQuery, type Queryable } from '../../db/index.js';
import { dec, toAmount, toQty } from '../../domain/money.js';
import { BusinessRuleError, ConflictError, NotFoundError, ServerError } from '../../core/errors.js';
import { auditIn, type AuditActor } from '../../core/audit.js';
import { recomputePoStatuses, resolveColumns, type ColumnMap } from '../google-sync/engine.js';

/** The business sheet's tab the store GRNs were imported from. */
export const STORE_GRN_TAB = 'GRN';
/** Every audit entry of this repair; after_data.kind tells a link batch, a run and an undo apart. */
export const LINK_AUDIT_ENTITY = 'store_grn_link';
/** A PO line may end up with its ordered quantity plus this (NUMERIC(18,4)). */
const OVER_RECEIPT_TOLERANCE = dec('0.0001');
/** GRN lines per audit entry. A GRN is never split between two entries. */
const AUDIT_BATCH_LINES = 500;
/** Lines shown per reason in a response's samples; the full lists follow them. */
const SAMPLES_PER_REASON = 10;

/** Reads one tab of the business sheet: the sync engine's readSheet, or a test's grid. */
export type SheetReader = (sheetName: string) => Promise<string[][]>;

export const HOLD_REASONS = {
  NOT_ON_TAB: 'Its GRN number and item are not on the GRN tab.',
  NO_PO_NAMED: 'A tab row for it names no PO (blank or -).',
  SEVERAL_POS: 'Its tab rows name more than one PO.',
  PO_NOT_IN_ERP: 'The PO the tab names is not in the ERP.',
  PO_NOT_RECEIVABLE: 'The PO the tab names is DRAFT or CANCELLED in the ERP and cannot hold a receipt.',
  ITEM_NOT_ON_PO: 'The PO the tab names has no line for this item.',
  SEVERAL_PO_LINES: 'The PO the tab names has more than one line for this item.',
  OVER_RECEIPT: 'With every receipt the tab assigns to that PO line, it would receive more than it ordered.',
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;
const REASONS = Object.keys(HOLD_REASONS) as HoldReason[];

export interface TabRow {
  /** Sheet row number; the header is row 1. */
  row: number;
  grnNo: string;
  itemCode: string;
  /** '' when the mapping knows no description column on the tab (the live tab calls it 'Item Name'). */
  itemDescription: string;
  /** The 'Po No' cell as written; '' and '-' name no PO. */
  poNo: string;
}

interface LineRef {
  grnLineId: number;
  grnId: number;
  grnNo: string;
  itemCode: string;
  grnQty: string;
  tabRows: number[];
}

export interface PlannedLink extends LineRef {
  poId: number;
  poNo: string;
  poLineId: number;
  poLineNo: number;
}

export interface HeldLine extends LineRef {
  reason: HoldReason;
  detail: string;
  /** The PO numbers the tab rows name, as written. */
  poNos?: string[];
  /** SEVERAL_PO_LINES: the PO lines that match the item. */
  poLines?: Array<{ poLineId: number; lineNo: number; itemCode: string; poQty: string }>;
  /** OVER_RECEIPT: the PO line and what the tab's receipts would make it. */
  poLine?: { poNo: string; poLineId: number; lineNo: number; poQty: string; receivedQty: string; proposedQty: string; wouldReceive: string; receipts: number };
}

export interface HeaderLink { grnId: number; grnNo: string; poId: number; poNo: string }

export interface AffectedPo {
  poId: number;
  poNo: string;
  statusBefore: string;
  /** v_po_header_balance's derived status once the links are in: what recomputePoStatuses writes. */
  statusAfter: string;
  grnLinesLinked: number;
  qtyLinked: string;
  pendingQtyBefore: string;
  pendingQtyAfter: string;
  pendingValueBefore: string;
  pendingValueAfter: string;
}

export interface LinkPlan {
  tab: { sheet: string; rowsRead: number; rowsWithGrnAndItem: number; columns: Record<string, string> };
  links: PlannedLink[];
  held: HeldLine[];
  headers: HeaderLink[];
  affectedPos: AffectedPo[];
  /** PO lines whose receipts were all held back as an over-receipt. */
  overReceivedPoLines: number;
  totals: {
    unlinkedLines: number;
    linkable: number;
    linkableBeforeOverReceipt: number;
    held: number;
    byReason: Record<HoldReason, number>;
    qtyLinked: string;
    grns: number;
    grnHeadersSet: number;
    affectedPos: number;
  };
  /** Every PO, by stored status: now, and once the affected POs carry their derived status. */
  poStatusCounts: { before: Record<string, number>; after: Record<string, number> };
  /** The dashboard's Pending PO Value (Σ pending_amount over receivable lines), before and after. */
  pendingValue: { before: string; after: string };
  /** sha256 over the links, the PO-line figures they were checked against and the header links. */
  selectionHash: string;
}

type Run = <T>(sql: string, params: unknown[]) => Promise<T[]>;
export const runIn = (tx: Queryable): Run => (sql, params) => txQuery(tx, sql, params);

// The engine compares with upper()/lower() in SQL; the same, on values already read.
const U = (s: string | null | undefined) => (s ?? '').toUpperCase();
const L = (s: string | null | undefined) => (s ?? '').toLowerCase();

/** Appends `value` to the list `map` holds under `key`. */
function addTo<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/**
 * The tab's rows that name a GRN and an item, read with the column mapping the sync
 * engine uses for this tab (google_sheet_mappings), so both read the same columns.
 */
function tabRowsOf(grid: string[][], columns: ColumnMap[]): { rows: TabRow[]; columns: Record<string, string> } {
  const needed = ['grn_no', 'item_code', 'po_no'] as const;
  const unmapped = needed.filter((f) => !columns.some((c) => c.field === f));
  if (unmapped.length > 0) {
    // The mapping is reconciled from seed.ts when the backend starts; a database
    // restored from an older build carries the older mapping until then.
    throw BusinessRuleError(
      `The Google sync's mapping for the ${STORE_GRN_TAB} tab has no ${unmapped.join(', ')} field; restart the backend so it is `
        + 'reconciled. Nothing was linked.',
    );
  }
  const header = (grid[0] ?? []).map((c) => String(c ?? '').trim());
  const index = resolveColumns(header, columns);
  const missing = needed.filter((f) => !index.has(f));
  if (missing.length > 0) {
    const names = missing.map((f) => columns.find((c) => c.field === f)?.headers[0] ?? f);
    throw BusinessRuleError(
      `The ${STORE_GRN_TAB} tab has no ${names.join(', ')} column (found: ${header.filter(Boolean).join(', ') || 'no header row'}). `
        + 'Nothing was linked.',
    );
  }
  const cell = (r: unknown[], field: string) => {
    const i = index.get(field);
    return i === undefined ? '' : String(r[i] ?? '').trim();
  };
  const rows: TabRow[] = [];
  grid.slice(1).forEach((r, i) => {
    const row: TabRow = {
      row: i + 2, grnNo: cell(r, 'grn_no'), itemCode: cell(r, 'item_code'),
      itemDescription: cell(r, 'item_description'), poNo: cell(r, 'po_no'),
    };
    if (row.grnNo && row.itemCode) rows.push(row);
  });
  return { rows, columns: Object.fromEntries([...index].map(([field, i]) => [field, header[i] ?? ''])) };
}

type GrnLineRow = { id: number; grn_id: number; grn_no: string; item_id: number; item_code: string; item_description: string; grn_qty: string };
type PoHeaderRow = { id: number; po_no: string; key: string; status: string };
type PoLineRow = {
  po_line_id: number; po_id: number; line_no: number; item_id: number; item_code: string; item_description: string;
  po_qty: string; received_qty: string;
};

/**
 * Each affected PO before and after the links, with v_po_line_balance's arithmetic and
 * v_po_header_balance's status rule: $2 lists the quantity each PO line would gain.
 */
const PO_FIGURES_SQL = `
  WITH added AS (
    SELECT a.po_line_id, SUM(a.qty) AS qty
      FROM jsonb_to_recordset($2::jsonb) AS a(po_line_id bigint, qty numeric)
     GROUP BY a.po_line_id
  ), l AS (
    SELECT b.po_id, b.po_qty, b.final_rate, b.is_closed,
           b.received_qty AS rcv0, b.received_qty + COALESCE(a.qty, 0) AS rcv1
      FROM v_po_line_balance b LEFT JOIN added a ON a.po_line_id = b.po_line_id
     WHERE b.po_id = ANY($1::bigint[])
  )
  SELECT h.id AS po_id, h.po_no, h.status,
         COALESCE(SUM(GREATEST(l.po_qty - l.rcv0, 0)), 0)::text AS pending_qty_before,
         COALESCE(SUM(GREATEST(l.po_qty - l.rcv1, 0)), 0)::text AS pending_qty_after,
         COALESCE(SUM(round(GREATEST(l.po_qty - l.rcv0, 0) * l.final_rate, 2))
           FILTER (WHERE h.status NOT IN ('CANCELLED', 'SHORT_CLOSED') AND NOT l.is_closed AND l.po_qty - l.rcv0 > 0), 0)::text AS pending_value_before,
         COALESCE(SUM(round(GREATEST(l.po_qty - l.rcv1, 0) * l.final_rate, 2))
           FILTER (WHERE h.status NOT IN ('CANCELLED', 'SHORT_CLOSED') AND NOT l.is_closed AND l.po_qty - l.rcv1 > 0), 0)::text AS pending_value_after,
         CASE WHEN h.status IN ('DRAFT', 'CANCELLED', 'SHORT_CLOSED') THEN h.status
              WHEN COALESCE(SUM(GREATEST(l.po_qty - l.rcv1, 0)), 0) <= 0 AND COUNT(l.po_id) > 0 THEN 'COMPLETED'
              WHEN COALESCE(SUM(l.rcv1), 0) > 0 THEN 'PARTIALLY_RECEIVED'
              ELSE 'OPEN' END AS status_after
    FROM purchase_order_headers h
    LEFT JOIN l ON l.po_id = h.id
   WHERE h.id = ANY($1::bigint[])
   GROUP BY h.id, h.po_no, h.status
   ORDER BY h.po_no, h.id`;

/**
 * Works out every link from the tab's grid and the database as they are now.
 * `lock` (inside the apply transaction) takes the unlinked GRN lines and the named
 * POs' lines FOR UPDATE first, so a GRN posted meanwhile cannot slip past the
 * over-receipt check.
 */
export async function planStoreGrnLinks(run: Run, grid: string[][], opts: { lock?: boolean } = {}): Promise<LinkPlan> {
  const [mapping] = await run<{ column_map: ColumnMap[] }>(
    'SELECT column_map FROM google_sheet_mappings WHERE sheet_name = $1', [STORE_GRN_TAB],
  );
  if (!mapping) {
    throw BusinessRuleError(`The Google sync has no column mapping for the ${STORE_GRN_TAB} tab, so the tab cannot be read. Nothing was linked.`);
  }
  const tab = tabRowsOf(grid, Array.isArray(mapping.column_map) ? mapping.column_map : []);

  // 1. The receipts without a PO.
  const lines = await run<GrnLineRow>(
    `SELECT gl.id, gl.grn_id, gh.grn_no, gl.item_id, gl.item_code, gl.item_description, gl.grn_qty::text AS grn_qty
       FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id
      WHERE gl.po_line_id IS NULL AND gh.status = 'POSTED'
      ORDER BY gl.id${opts.lock ? ' FOR UPDATE OF gl' : ''}`,
    [],
  );

  // 2. The item each tab row names, resolved as the engine's findItem resolves it: by
  //    code, else by description (the code cell when the row has none). One query for
  //    all rows; where several items share a description the lowest id is taken.
  const items = await run<{ id: number; code: string; text: string }>(
    `SELECT id, upper(item_code) AS code, lower(item_description) AS text
       FROM items
      WHERE deleted_at IS NULL AND (upper(item_code) = ANY($1::text[]) OR lower(item_description) = ANY($2::text[]))
      ORDER BY id`,
    [[...new Set(tab.rows.map((r) => U(r.itemCode)))], [...new Set(tab.rows.map((r) => L(r.itemDescription || r.itemCode)))]],
  );
  const byCode = new Map<string, number>();
  const byText = new Map<string, number>();
  for (const it of items) {
    if (!byCode.has(it.code)) byCode.set(it.code, Number(it.id));
    if (!byText.has(it.text)) byText.set(it.text, Number(it.id));
  }
  const resolved = (r: TabRow) => byCode.get(U(r.itemCode)) ?? byText.get(L(r.itemDescription || r.itemCode)) ?? null;

  const rowsByGrn = new Map<string, TabRow[]>();
  for (const r of tab.rows) addTo(rowsByGrn, U(r.grnNo), r);
  // The engine's GRN-tab match of a row to an ERP line of the same GRN number.
  const rowNamesLine = (r: TabRow, l: GrnLineRow) =>
    resolved(r) === Number(l.item_id) || U(l.item_code) === U(r.itemCode) || L(l.item_description) === L(r.itemCode)
    || (r.itemDescription !== '' && L(l.item_description) === L(r.itemDescription));
  const poNamedBy = (r: TabRow) => (r.poNo === '' || r.poNo === '-' ? null : U(r.poNo));

  const held: HeldLine[] = [];
  const hold = (ref: LineRef, reason: HoldReason, detail: string, extra: Partial<HeldLine> = {}) =>
    held.push({ ...ref, reason, detail, ...extra });

  // 3. What the tab says about each line.
  const named: Array<{ ref: LineRef; line: GrnLineRow; rows: TabRow[]; poKey: string; poNo: string }> = [];
  for (const l of lines) {
    const rows = (rowsByGrn.get(U(l.grn_no)) ?? []).filter((r) => rowNamesLine(r, l));
    const ref: LineRef = {
      grnLineId: Number(l.id), grnId: Number(l.grn_id), grnNo: l.grn_no, itemCode: l.item_code,
      grnQty: toQty(l.grn_qty), tabRows: rows.map((r) => r.row),
    };
    if (rows.length === 0) {
      hold(ref, 'NOT_ON_TAB', `No row of the ${STORE_GRN_TAB} tab names GRN ${l.grn_no} with item ${l.item_code}.`);
      continue;
    }
    const spelled = new Map<string, string>();
    for (const r of rows) {
      const key = poNamedBy(r);
      if (key !== null && !spelled.has(key)) spelled.set(key, r.poNo);
    }
    const poNos = [...spelled.values()];
    if (spelled.size > 1) {
      hold(ref, 'SEVERAL_POS', `Tab row(s) ${ref.tabRows.join(', ')} name ${poNos.join(', ')}.`, { poNos });
      continue;
    }
    const silent = rows.filter((r) => poNamedBy(r) === null);
    if (silent.length > 0) {
      hold(ref, 'NO_PO_NAMED', spelled.size === 0
        ? `Tab row(s) ${ref.tabRows.join(', ')} name no PO.`
        : `Tab row(s) ${silent.map((r) => r.row).join(', ')} name no PO, while row(s) `
          + `${rows.filter((r) => poNamedBy(r) !== null).map((r) => r.row).join(', ')} name ${poNos[0]}.`, { poNos });
      continue;
    }
    named.push({ ref, line: l, rows, poKey: [...spelled.keys()][0]!, poNo: poNos[0]! });
  }

  // 4. The POs named, and their lines with what they have received so far.
  const poHeaders = named.length === 0 ? [] : await run<PoHeaderRow>(
    `SELECT id, po_no, upper(trim(po_no)) AS key, status FROM purchase_order_headers
      WHERE upper(trim(po_no)) = ANY($1::text[]) ORDER BY id`,
    [[...new Set(named.map((n) => n.poKey))]],
  );
  const posByKey = new Map<string, PoHeaderRow[]>();
  for (const h of poHeaders) addTo(posByKey, h.key, h);
  const poIds = poHeaders.map((h) => Number(h.id));
  if (opts.lock && poIds.length > 0) {
    await run('SELECT id FROM purchase_order_lines WHERE po_id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [poIds]);
  }
  const poLines = poIds.length === 0 ? [] : await run<PoLineRow>(
    `SELECT po_line_id, po_id, line_no, item_id, item_code, item_description,
            po_qty::text AS po_qty, received_qty::text AS received_qty
       FROM v_po_line_balance WHERE po_id = ANY($1::bigint[]) ORDER BY po_id, line_no, po_line_id`,
    [poIds],
  );
  const linesByPo = new Map<number, PoLineRow[]>();
  for (const pl of poLines) addTo(linesByPo, Number(pl.po_id), pl);

  // 5. The PO line for each item, matched as the engine matches a PO row to stored lines:
  //    the resolved item, the code, or the description (or the code cell read as one).
  const candidates: Array<{ ref: LineRef; header: PoHeaderRow; poLine: PoLineRow }> = [];
  for (const n of named) {
    const found = posByKey.get(n.poKey) ?? [];
    if (found.length === 0) {
      hold(n.ref, 'PO_NOT_IN_ERP', `The tab names ${n.poNo}, which is not in the ERP.`, { poNos: [n.poNo] });
      continue;
    }
    if (found.length > 1) {
      hold(n.ref, 'SEVERAL_POS', `The tab names ${n.poNo}, which matches ${found.map((h) => h.po_no).join(', ')} in the ERP.`, { poNos: [n.poNo] });
      continue;
    }
    const header = found[0]!;
    if (header.status === 'DRAFT' || header.status === 'CANCELLED') {
      hold(n.ref, 'PO_NOT_RECEIVABLE', `${header.po_no} is ${header.status} in the ERP.`, { poNos: [n.poNo] });
      continue;
    }
    const ids = new Set([Number(n.line.item_id), ...n.rows.map(resolved).filter((id): id is number => id !== null)]);
    const codes = new Set([n.line.item_code, ...n.rows.map((r) => r.itemCode)].map(U).filter(Boolean));
    const texts = new Set([n.line.item_description, n.line.item_code, ...n.rows.flatMap((r) => [r.itemCode, r.itemDescription])].map(L).filter(Boolean));
    const poLinesOfPo = linesByPo.get(Number(header.id)) ?? [];
    const matches = poLinesOfPo.filter((pl) => ids.has(Number(pl.item_id)) || codes.has(U(pl.item_code)) || texts.has(L(pl.item_description)));
    if (matches.length === 0) {
      const holds = poLinesOfPo.slice(0, 5).map((pl) => pl.item_code).join(', ');
      hold(n.ref, 'ITEM_NOT_ON_PO', `${header.po_no} has no line for ${n.line.item_code} (its ${poLinesOfPo.length} line(s): `
        + `${holds}${poLinesOfPo.length > 5 ? ', …' : ''}).`, { poNos: [n.poNo] });
      continue;
    }
    if (matches.length > 1) {
      hold(n.ref, 'SEVERAL_PO_LINES', `${header.po_no} has ${matches.length} lines for ${n.line.item_code} `
        + `(lines ${matches.map((pl) => pl.line_no).join(', ')}).`, {
        poNos: [n.poNo],
        poLines: matches.map((pl) => ({ poLineId: Number(pl.po_line_id), lineNo: Number(pl.line_no), itemCode: pl.item_code, poQty: toQty(pl.po_qty) })),
      });
      continue;
    }
    candidates.push({ ref: n.ref, header, poLine: matches[0]! });
  }

  // 6. Over-receipt, per PO line, over all the receipts the tab assigns to it at once.
  const byPoLine = new Map<number, typeof candidates>();
  for (const c of candidates) addTo(byPoLine, Number(c.poLine.po_line_id), c);
  const links: PlannedLink[] = [];
  const checked: Array<[number, string, string]> = [];
  let overReceivedPoLines = 0;
  for (const [poLineId, group] of byPoLine) {
    const { header, poLine } = group[0]!;
    const proposed = group.reduce((s, c) => s.plus(dec(c.ref.grnQty)), dec(0));
    const would = dec(poLine.received_qty).plus(proposed);
    checked.push([poLineId, toQty(poLine.po_qty), toQty(poLine.received_qty)]);
    if (would.greaterThan(dec(poLine.po_qty).plus(OVER_RECEIPT_TOLERANCE))) {
      overReceivedPoLines += 1;
      const figures = {
        poNo: header.po_no, poLineId, lineNo: Number(poLine.line_no), poQty: toQty(poLine.po_qty),
        receivedQty: toQty(poLine.received_qty), proposedQty: toQty(proposed), wouldReceive: toQty(would), receipts: group.length,
      };
      for (const c of group) {
        hold(c.ref, 'OVER_RECEIPT', `${header.po_no} line ${figures.lineNo} (${poLine.item_code}) ordered ${figures.poQty} and has received `
          + `${figures.receivedQty}; the ${group.length} receipt(s) the tab assigns to it total ${figures.proposedQty}, which would make ${figures.wouldReceive}.`,
        { poNos: [header.po_no], poLine: figures });
      }
      continue;
    }
    for (const c of group) {
      links.push({ ...c.ref, poId: Number(header.id), poNo: header.po_no, poLineId, poLineNo: Number(poLine.line_no) });
    }
  }
  links.sort((a, b) => a.grnLineId - b.grnLineId);
  held.sort((a, b) => a.grnLineId - b.grnLineId);
  checked.sort((a, b) => a[0] - b[0]);

  // 7. A GRN header names its PO once every linked line of the GRN points to that one PO.
  const grnIds = [...new Set(links.map((l) => l.grnId))];
  const linkedBefore = grnIds.length === 0 ? [] : await run<{ grn_id: number; header_po_id: number | null; po_id: number | null }>(
    `SELECT gh.id AS grn_id, gh.po_id AS header_po_id, pol.po_id
       FROM grn_headers gh
       LEFT JOIN grn_lines gl ON gl.grn_id = gh.id AND gl.po_line_id IS NOT NULL
       LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
      WHERE gh.id = ANY($1::bigint[])`,
    [grnIds],
  );
  const posOfGrn = new Map<number, { headerPoId: number | null; poIds: Set<number> }>();
  for (const r of linkedBefore) {
    const g = posOfGrn.get(Number(r.grn_id)) ?? { headerPoId: r.header_po_id == null ? null : Number(r.header_po_id), poIds: new Set<number>() };
    if (r.po_id != null) g.poIds.add(Number(r.po_id));
    posOfGrn.set(Number(r.grn_id), g);
  }
  const firstLinkOf = new Map<number, PlannedLink>();
  for (const l of links) {
    posOfGrn.get(l.grnId)?.poIds.add(l.poId);
    if (!firstLinkOf.has(l.grnId)) firstLinkOf.set(l.grnId, l);
  }
  const headers: HeaderLink[] = [];
  for (const grnId of grnIds) {
    const g = posOfGrn.get(grnId);
    // One PO in the set means it is this GRN's linked PO.
    if (!g || g.headerPoId !== null || g.poIds.size !== 1) continue;
    const link = firstLinkOf.get(grnId)!;
    headers.push({ grnId, grnNo: link.grnNo, poId: link.poId, poNo: link.poNo });
  }
  headers.sort((a, b) => a.grnId - b.grnId);

  // 8. The POs before and after, and the totals over every PO.
  const affectedIds = [...new Set(links.map((l) => l.poId))];
  const gained = new Map<number, { lines: number; qty: ReturnType<typeof dec> }>();
  const addedPerLine = new Map<number, ReturnType<typeof dec>>();
  for (const l of links) {
    const g = gained.get(l.poId) ?? { lines: 0, qty: dec(0) };
    gained.set(l.poId, { lines: g.lines + 1, qty: g.qty.plus(dec(l.grnQty)) });
    addedPerLine.set(l.poLineId, (addedPerLine.get(l.poLineId) ?? dec(0)).plus(dec(l.grnQty)));
  }
  const figures = affectedIds.length === 0 ? [] : await run<{
    po_id: number; po_no: string; status: string; status_after: string;
    pending_qty_before: string; pending_qty_after: string; pending_value_before: string; pending_value_after: string;
  }>(PO_FIGURES_SQL, [affectedIds, JSON.stringify([...addedPerLine].map(([po_line_id, qty]) => ({ po_line_id, qty: toQty(qty) })))]);
  const affectedPos: AffectedPo[] = figures.map((f) => ({
    poId: Number(f.po_id), poNo: f.po_no, statusBefore: f.status, statusAfter: f.status_after,
    grnLinesLinked: gained.get(Number(f.po_id))?.lines ?? 0, qtyLinked: toQty(gained.get(Number(f.po_id))?.qty ?? 0),
    pendingQtyBefore: toQty(f.pending_qty_before), pendingQtyAfter: toQty(f.pending_qty_after),
    pendingValueBefore: toAmount(f.pending_value_before), pendingValueAfter: toAmount(f.pending_value_after),
  }));

  const statusRows = await run<{ status: string; n: number }>(
    'SELECT status, COUNT(*)::int AS n FROM purchase_order_headers GROUP BY status ORDER BY status', [],
  );
  const before = Object.fromEntries(statusRows.map((s) => [s.status, Number(s.n)]));
  const after: Record<string, number> = { ...before };
  for (const p of affectedPos) {
    if (p.statusAfter === p.statusBefore) continue;
    after[p.statusBefore] = (after[p.statusBefore] ?? 0) - 1;
    after[p.statusAfter] = (after[p.statusAfter] ?? 0) + 1;
  }
  const [pending] = await run<{ value: string }>(
    'SELECT COALESCE(SUM(pending_amount) FILTER (WHERE is_receivable), 0)::text AS value FROM v_po_line_balance', [],
  );
  const pendingBefore = dec(pending?.value ?? 0);
  const pendingDrop = affectedPos.reduce((s, p) => s.plus(dec(p.pendingValueBefore)).minus(dec(p.pendingValueAfter)), dec(0));

  const byReason = Object.fromEntries(REASONS.map((r) => [r, 0])) as Record<HoldReason, number>;
  for (const h of held) byReason[h.reason] += 1;
  const selectionHash = createHash('sha256').update(JSON.stringify({
    links: links.map((l) => [l.grnLineId, l.poLineId, l.grnQty]),
    poLines: checked,
    headers: headers.map((h) => [h.grnId, h.poId]),
  })).digest('hex');

  return {
    tab: { sheet: STORE_GRN_TAB, rowsRead: Math.max(grid.length - 1, 0), rowsWithGrnAndItem: tab.rows.length, columns: tab.columns },
    links,
    held,
    headers,
    affectedPos,
    overReceivedPoLines,
    totals: {
      unlinkedLines: lines.length,
      linkable: links.length,
      linkableBeforeOverReceipt: candidates.length,
      held: held.length,
      byReason,
      qtyLinked: toQty(links.reduce((s, l) => s.plus(dec(l.grnQty)), dec(0))),
      grns: grnIds.length,
      grnHeadersSet: headers.length,
      affectedPos: affectedPos.length,
    },
    poStatusCounts: { before, after: Object.fromEntries(Object.entries(after).filter(([, n]) => n !== 0)) },
    pendingValue: { before: toAmount(pendingBefore), after: toAmount(pendingBefore.minus(pendingDrop)) },
    selectionHash,
  };
}

/** How many POs move from one status to another, e.g. { 'OPEN -> COMPLETED': 812 }. */
export function statusTransitions(plan: LinkPlan): Record<string, number> {
  const moves: Record<string, number> = {};
  for (const p of plan.affectedPos) {
    const k = `${p.statusBefore} -> ${p.statusAfter}`;
    moves[k] = (moves[k] ?? 0) + 1;
  }
  return moves;
}

/** The plan as a response: totals and samples first, then every line, linked or held. */
export function describeLinkPlan(plan: LinkPlan) {
  const samples: Record<string, unknown[]> = { LINK: plan.links.slice(0, SAMPLES_PER_REASON) };
  for (const reason of REASONS) {
    const some = plan.held.filter((h) => h.reason === reason).slice(0, SAMPLES_PER_REASON);
    if (some.length > 0) samples[reason] = some;
  }
  return {
    selectionHash: plan.selectionHash,
    tab: plan.tab,
    totals: plan.totals,
    overReceivedPoLines: plan.overReceivedPoLines,
    reasons: HOLD_REASONS,
    poStatusCounts: plan.poStatusCounts,
    statusTransitions: statusTransitions(plan),
    pendingValue: plan.pendingValue,
    samples,
    affectedPos: plan.affectedPos,
    headers: plan.headers,
    links: plan.links,
    held: plan.held,
  };
}

/** One sentence for the response and the run's audit entry. */
export function summariseLinkPlan(plan: LinkPlan): string {
  const t = plan.totals;
  const reasons = REASONS.filter((r) => t.byReason[r] > 0).map((r) => `${r} ${t.byReason[r]}`).join(', ');
  const moves = Object.entries(statusTransitions(plan)).map(([k, n]) => `${k} ${n}`).join(', ');
  return `${t.linkable} of ${t.unlinkedLines} unlinked GRN line(s) on ${t.grns} GRN(s) link to ${t.affectedPos} PO(s)`
    + `${t.held ? `; ${t.held} are listed, not linked (${reasons})` : ''}. `
    + `${moves ? `PO status: ${moves}. ` : ''}Pending PO value ${plan.pendingValue.before} -> ${plan.pendingValue.after}.`;
}

/** Splits the links into audit batches of whole GRNs, at most AUDIT_BATCH_LINES lines each. */
function batchesOf(plan: LinkPlan): Array<{ links: PlannedLink[]; headers: HeaderLink[] }> {
  const byGrn = new Map<number, PlannedLink[]>();
  for (const l of plan.links) addTo(byGrn, l.grnId, l);
  const headerOf = new Map(plan.headers.map((h) => [h.grnId, h]));
  const batches: Array<{ links: PlannedLink[]; headers: HeaderLink[] }> = [];
  let current = { links: [] as PlannedLink[], headers: [] as HeaderLink[] };
  for (const [grnId, grnLinks] of byGrn) {
    if (current.links.length > 0 && current.links.length + grnLinks.length > AUDIT_BATCH_LINES) {
      batches.push(current);
      current = { links: [], headers: [] };
    }
    current.links.push(...grnLinks);
    const h = headerOf.get(grnId);
    if (h) current.headers.push(h);
  }
  if (current.links.length > 0) batches.push(current);
  return batches;
}

export interface ApplyResult {
  plan: LinkPlan;
  linesLinked: number;
  headersSet: number;
  poStatusesRederived: number;
  runId: string;
  auditIds: number[];
}

/**
 * Writes the plan the dry run showed. MUST run inside a transaction: the plan is
 * rebuilt with the rows locked and must carry the dry run's hash, and every linked
 * PO line and status is checked by the database before anything commits.
 */
export async function applyStoreGrnLinks(
  tx: Queryable,
  grid: string[][],
  ctx: { expectedHash: string; actor: AuditActor },
): Promise<ApplyResult> {
  const run = runIn(tx);
  const plan = await planStoreGrnLinks(run, grid, { lock: true });
  if (plan.selectionHash !== ctx.expectedHash) {
    throw ConflictError(
      `The GRN tab or the ERP has changed since the dry run (now ${plan.totals.linkable} line(s) would be linked and ${plan.totals.held} listed). `
        + 'Nothing was linked; run the dry run again and review it.',
      { linkable: plan.totals.linkable, held: plan.totals.held, selectionHash: plan.selectionHash },
    );
  }
  if (plan.links.length === 0) throw BusinessRuleError('No GRN line can be linked; nothing was written.');

  const runId = randomUUID();
  const batches = batchesOf(plan);
  let linesLinked = 0;
  let headersSet = 0;
  for (const [k, b] of batches.entries()) {
    const set = await run<{ id: number }>(
      `UPDATE grn_lines gl SET po_line_id = v.po_line_id, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(grn_line_id bigint, po_line_id bigint)
        WHERE gl.id = v.grn_line_id AND gl.po_line_id IS NULL
        RETURNING gl.id`,
      [JSON.stringify(b.links.map((l) => ({ grn_line_id: l.grnLineId, po_line_id: l.poLineId })))],
    );
    const named = b.headers.length === 0 ? [] : await run<{ id: number }>(
      `UPDATE grn_headers gh SET po_id = v.po_id, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(grn_id bigint, po_id bigint)
        WHERE gh.id = v.grn_id AND gh.po_id IS NULL
        RETURNING gh.id`,
      [JSON.stringify(b.headers.map((h) => ({ grn_id: h.grnId, po_id: h.poId })))],
    );
    if (set.length !== b.links.length || named.length !== b.headers.length) {
      // The rows were locked and re-read in this transaction; a difference is a bug.
      throw ServerError(`Linking batch ${k + 1} wrote ${set.length} of ${b.links.length} line(s) and ${named.length} of ${b.headers.length} header(s); nothing was written.`);
    }
    linesLinked += set.length;
    headersSet += named.length;
    const grns = new Set(b.links.map((l) => l.grnId)).size;
    await auditIn(tx, {
      actor: ctx.actor,
      action: 'UPDATE',
      entity: LINK_AUDIT_ENTITY,
      entityLabel: `store GRN links ${k + 1}/${batches.length}: ${b.links[0]!.grnNo} … ${b.links[b.links.length - 1]!.grnNo}`,
      before: {
        links: b.links.map((l) => ({ grnLineId: l.grnLineId, poLineId: null })),
        headers: b.headers.map((h) => ({ grnId: h.grnId, poId: null })),
      },
      after: {
        kind: 'links', runId, batch: k + 1, batches: batches.length, selectionHash: plan.selectionHash,
        links: b.links.map((l) => ({
          grnLineId: l.grnLineId, grnId: l.grnId, grnNo: l.grnNo, itemCode: l.itemCode, grnQty: l.grnQty,
          poLineId: l.poLineId, poId: l.poId, poNo: l.poNo, poLineNo: l.poLineNo, tabRows: l.tabRows,
        })),
        headers: b.headers,
      },
      message: `Linked ${b.links.length} store GRN line(s) on ${grns} GRN(s) to the PO lines the ${STORE_GRN_TAB} tab's 'Po No' column names `
        + `(batch ${k + 1} of ${batches.length}); ${b.headers.length} GRN header(s) now name their one PO. Quantities, stock and the ledger were not changed.`,
    });
  }

  const poStatusesRederived = await recomputePoStatuses(tx, plan.affectedPos.map((p) => p.poId));

  // Checked by the database before anything commits: no linked PO line has received
  // more than it ordered, and every affected PO carries the status the dry run showed.
  const over = await run<{ po_no: string; line_no: number; po_qty: string; received_qty: string }>(
    `SELECT po_no, line_no, po_qty::text AS po_qty, received_qty::text AS received_qty FROM v_po_line_balance
      WHERE po_line_id = ANY($1::bigint[]) AND received_qty > po_qty + $2::numeric`,
    [[...new Set(plan.links.map((l) => l.poLineId))], OVER_RECEIPT_TOLERANCE.toString()],
  );
  const statuses = await run<{ id: number; status: string }>(
    'SELECT id, status FROM purchase_order_headers WHERE id = ANY($1::bigint[])', [plan.affectedPos.map((p) => p.poId)],
  );
  const expected = new Map(plan.affectedPos.map((p) => [p.poId, p.statusAfter]));
  const drifted = statuses.filter((s) => expected.get(Number(s.id)) !== s.status);
  if (over.length > 0 || drifted.length > 0) {
    throw ServerError(
      `Linking check failed (${over.length} PO line(s) over-received, ${drifted.length} PO status(es) differ from the dry run); nothing was written.`,
    );
  }

  const auditIds = (await run<{ id: number }>(
    `SELECT id FROM audit_logs WHERE entity = $1 AND after_data->>'runId' = $2 AND after_data->>'kind' = 'links' ORDER BY id`,
    [LINK_AUDIT_ENTITY, runId],
  )).map((r) => Number(r.id));
  await auditIn(tx, {
    actor: ctx.actor,
    action: 'UPDATE',
    entity: LINK_AUDIT_ENTITY,
    entityLabel: `store GRN link run ${plan.selectionHash.slice(0, 12)}`,
    before: { poStatusCounts: plan.poStatusCounts.before, pendingValue: plan.pendingValue.before },
    after: {
      kind: 'run', runId, selectionHash: plan.selectionHash, batchAuditIds: auditIds, totals: plan.totals,
      statusTransitions: statusTransitions(plan), poStatusesRederived,
      poStatusCounts: plan.poStatusCounts.after, pendingValue: plan.pendingValue.after,
    },
    message: `${summariseLinkPlan(plan)} Linked in ${auditIds.length} audited batch(es); undo takes back exactly these links. `
      + 'Quantities, stock and the ledger were not changed.',
  });
  return { plan, linesLinked, headersSet, poStatusesRederived, runId, auditIds };
}

type LinkRecord = { grnLineId: number; grnId: number; grnNo: string; poLineId: number; poId: number; poNo: string };
type AuditRow = { id: number; action: string; after_data: Record<string, unknown> | null };

export interface UndoResult {
  undone: Array<{ grnLineId: number; grnNo: string; poLineId: number; poNo: string }>;
  headersCleared: Array<{ grnId: number; grnNo: string; poId: number }>;
  skipped: Array<{ grnLineId: number; reason: string }>;
  poStatusesRederived: number;
}

/**
 * Takes back links this repair made: by one audit entry (a batch, or a whole run's
 * summary entry) or by GRN line ids. A link is set back to NULL only while the line
 * still points to the PO line this repair set, and only by the latest audit entry
 * that linked it. A header's po_id is cleared when the repair set it and no line of
 * the GRN points to that PO any more. MUST run inside a transaction.
 */
export async function undoStoreGrnLinks(
  tx: Queryable,
  target: { auditId?: number; grnLineIds?: number[] },
  ctx: { reason: string; actor: AuditActor },
): Promise<UndoResult> {
  const run = runIn(tx);
  const entries = await run<AuditRow>(
    `SELECT id, action, after_data FROM audit_logs WHERE entity = $1 AND after_data->>'kind' = 'links' ORDER BY id`,
    [LINK_AUDIT_ENTITY],
  );
  const linksOf = (e: AuditRow) => (Array.isArray(e.after_data?.links) ? e.after_data!.links as LinkRecord[] : []);
  const headersOf = (e: AuditRow) => (Array.isArray(e.after_data?.headers) ? e.after_data!.headers as HeaderLink[] : []);
  // The latest entry that linked each line, and that named each header.
  const latest = new Map<number, { auditId: number; link: LinkRecord }>();
  const headerSetBy = new Map<number, HeaderLink>();
  for (const e of entries) {
    for (const l of linksOf(e)) latest.set(Number(l.grnLineId), { auditId: Number(e.id), link: l });
    for (const h of headersOf(e)) headerSetBy.set(Number(h.grnId), h);
  }

  const skipped: UndoResult['skipped'] = [];
  const requested: Array<{ auditId: number; link: LinkRecord }> = [];
  if (target.auditId !== undefined) {
    const [entry] = await run<AuditRow & { entity: string }>(
      'SELECT id, action, entity, after_data FROM audit_logs WHERE id = $1', [target.auditId],
    );
    if (!entry || entry.entity !== LINK_AUDIT_ENTITY) throw NotFoundError(`Store GRN link audit entry #${target.auditId}`);
    const kind = entry.after_data?.kind;
    if (kind !== 'links' && kind !== 'run') {
      throw BusinessRuleError(`Audit entry #${target.auditId} records an undo, not links; nothing was changed.`);
    }
    const batches = kind === 'run' ? entries.filter((e) => e.after_data?.runId === entry.after_data?.runId) : [entry];
    for (const b of batches) {
      for (const l of linksOf(b)) {
        const last = latest.get(Number(l.grnLineId));
        if (last && last.auditId !== Number(b.id)) {
          skipped.push({ grnLineId: Number(l.grnLineId), reason: `Linked again later (audit #${last.auditId}); undo that entry instead.` });
        } else {
          requested.push({ auditId: Number(b.id), link: l });
        }
      }
    }
  } else {
    for (const id of [...new Set(target.grnLineIds ?? [])]) {
      const last = latest.get(id);
      if (last) requested.push(last);
      else skipped.push({ grnLineId: id, reason: 'This repair never linked it.' });
    }
  }

  const current = requested.length === 0 ? [] : await run<{ id: number; po_line_id: number | null }>(
    'SELECT id, po_line_id FROM grn_lines WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
    [requested.map((r) => Number(r.link.grnLineId))],
  );
  const nowOf = new Map<number, number | null>(current.map((c) => [Number(c.id), c.po_line_id == null ? null : Number(c.po_line_id)]));
  const toUndo: LinkRecord[] = [];
  for (const r of requested) {
    const id = Number(r.link.grnLineId);
    const now = nowOf.get(id);
    if (!nowOf.has(id)) skipped.push({ grnLineId: id, reason: 'The GRN line no longer exists.' });
    else if (now === null) skipped.push({ grnLineId: id, reason: 'It is not linked now (already undone).' });
    else if (now !== Number(r.link.poLineId)) skipped.push({ grnLineId: id, reason: `It now points to another PO line (${now}), not the one this repair set.` });
    else toUndo.push(r.link);
  }
  if (toUndo.length === 0) {
    throw BusinessRuleError('Nothing to undo: none of these links is in place as this repair made it.', { skipped });
  }

  const cleared = await run<{ id: number }>(
    `UPDATE grn_lines gl SET po_line_id = NULL, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(grn_line_id bigint, po_line_id bigint)
      WHERE gl.id = v.grn_line_id AND gl.po_line_id = v.po_line_id
      RETURNING gl.id`,
    [JSON.stringify(toUndo.map((l) => ({ grn_line_id: Number(l.grnLineId), po_line_id: Number(l.poLineId) })))],
  );
  if (cleared.length !== toUndo.length) {
    throw ServerError(`Undo cleared ${cleared.length} of ${toUndo.length} link(s); nothing was changed.`);
  }
  const headerCandidates = [...new Set(toUndo.map((l) => Number(l.grnId)))]
    .map((grnId) => headerSetBy.get(grnId))
    .filter((h): h is HeaderLink => h !== undefined);
  const headersCleared = headerCandidates.length === 0 ? [] : await run<{ id: number; grn_no: string; po_id: number }>(
    `UPDATE grn_headers gh SET po_id = NULL, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(grn_id bigint, po_id bigint)
      WHERE gh.id = v.grn_id AND gh.po_id = v.po_id
        AND NOT EXISTS (SELECT 1 FROM grn_lines gl JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                         WHERE gl.grn_id = gh.id AND pol.po_id = v.po_id)
      RETURNING gh.id, gh.grn_no, v.po_id`,
    [JSON.stringify(headerCandidates.map((h) => ({ grn_id: Number(h.grnId), po_id: Number(h.poId) })))],
  );
  const poStatusesRederived = await recomputePoStatuses(tx, [...new Set(toUndo.map((l) => Number(l.poId)))]);

  const result: UndoResult = {
    undone: toUndo.map((l) => ({ grnLineId: Number(l.grnLineId), grnNo: l.grnNo, poLineId: Number(l.poLineId), poNo: l.poNo })),
    headersCleared: headersCleared.map((h) => ({ grnId: Number(h.id), grnNo: h.grn_no, poId: Number(h.po_id) })),
    skipped,
    poStatusesRederived,
  };
  await auditIn(tx, {
    actor: ctx.actor,
    action: 'CANCEL',
    entity: LINK_AUDIT_ENTITY,
    entityLabel: target.auditId !== undefined ? `undo of audit #${target.auditId}` : `undo of ${toUndo.length} GRN line link(s)`,
    before: {
      links: toUndo.map((l) => ({ grnLineId: Number(l.grnLineId), poLineId: Number(l.poLineId) })),
      headers: result.headersCleared.map((h) => ({ grnId: h.grnId, poId: h.poId })),
    },
    after: {
      kind: 'undo', reason: ctx.reason, target,
      links: toUndo.map((l) => ({ grnLineId: Number(l.grnLineId), poLineId: null })),
      headers: result.headersCleared.map((h) => ({ grnId: h.grnId, poId: null })),
      skipped, poStatusesRederived,
    },
    message: `Store GRN links undone: ${toUndo.length} GRN line(s) no longer point to a PO line and ${result.headersCleared.length} GRN header(s) `
      + `no longer name a PO; ${poStatusesRederived} PO status(es) re-derived. Quantities and stock were not changed. Reason: ${ctx.reason}`,
  });
  return result;
}
