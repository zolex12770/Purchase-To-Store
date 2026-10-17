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
 *   · the reviewer did not keep it out of the run (excludeGrnLineIds);
 *   · its GRN number and item are on the tab, the item matched as the engine's GRN
 *     reconciliation matches it: the resolved item, the code or the description;
 *   · every tab row for it names the same one PO (a blank or '-' names none);
 *   · that PO is in the ERP, is neither DRAFT nor CANCELLED (neither can hold a
 *     receipt), and has exactly one line for the item, matched the same way;
 *   · the PO is the GRN's supplier's: the ERP's own receipt takes a PO GRN's supplier
 *     from its PO and never mixes two. A GRN the import gave its placeholder supplier
 *     is exempt, and so are two supplier records the reviewer confirms are one
 *     company (sameSupplierPairs);
 *   · the PO is dated no more than 30 days after the receipt;
 *   · the PO line has then received no more than it ordered (+0.0001), counting at
 *     once every receipt the tab assigns to it, so the result never depends on which
 *     receipt happens to be counted first;
 *   · every other unlinked line of its GRN is linked too. GET /grn/:id calls a GRN
 *     with any linked line a PO GRN, and PUT /grn/:id then wants a PO line on every
 *     line, so a GRN linked in part could no longer be saved from the GRN screen.
 * Every other line is listed with its reason and figures. Only grn_lines.po_line_id
 * and grn_headers.po_id (the one PO all the GRN's lines point to, else none) are
 * written, and the affected POs' statuses are re-derived. Quantities, stock and the
 * ledger are never touched and nothing is deleted. Each batch of links is recorded
 * in the audit log with the values it replaced, and undo takes back exactly the
 * links recorded there, a whole GRN at a time.
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
/**
 * The supplier the store import gave a GRN whose tab row named none
 * (scripts/live_source_reimport.ts). Its PO is then the only supplier evidence: 231
 * of the 3,752 lines the 2026-10-17 copy links carry it.
 */
export const IMPORT_PLACEHOLDER_SUPPLIER_CODE = 'SUP-UNSPECIFIED';
/**
 * A PO dated more than this many days after the receipt is not taken as the order the
 * goods came against. In the 2026-10-17 copy 197 links had their PO dated the day after
 * the GRN, and one 165 days after it (ZG/RM/0029 to Z/RM/00222, another supplier's).
 */
export const PO_AFTER_RECEIPT_DAYS = 30;
/** A PO line may end up with its ordered quantity plus this (NUMERIC(18,4)). */
const OVER_RECEIPT_TOLERANCE = dec('0.0001');
/** GRN lines per audit entry. A GRN is never split between two entries. */
const AUDIT_BATCH_LINES = 500;
/** Lines shown per reason in a response's samples; the full lists follow them. */
const SAMPLES_PER_REASON = 10;
/** Blocking lines named in a GRN_PARTLY_HELD detail; blockedBy lists them all. */
const BLOCKERS_NAMED = 5;
const DAY_MS = 86_400_000;

/** Reads one tab of the business sheet: the sync engine's readSheet, or a test's grid. */
export type SheetReader = (sheetName: string) => Promise<string[][]>;

/** In the order the checks run; a line is held by the first one it fails. */
export const HOLD_REASONS = {
  EXCLUDED: 'The reviewer kept it out of this run (excludeGrnLineIds).',
  NOT_ON_TAB: 'Its GRN number and item are not on the GRN tab.',
  NO_PO_NAMED: 'A tab row for it names no PO (blank or -).',
  SEVERAL_POS: 'Its tab rows name more than one PO.',
  PO_NOT_IN_ERP: 'The PO the tab names is not in the ERP.',
  PO_NOT_RECEIVABLE: 'The PO the tab names is DRAFT or CANCELLED in the ERP and cannot hold a receipt.',
  ITEM_NOT_ON_PO: 'The PO the tab names has no line for this item.',
  SEVERAL_PO_LINES: 'The PO the tab names has more than one line for this item.',
  SUPPLIER_MISMATCH: "The PO the tab names is another supplier's, and the two supplier records are not confirmed as one company (sameSupplierPairs).",
  PO_AFTER_RECEIPT: `The PO the tab names is dated more than ${PO_AFTER_RECEIPT_DAYS} days after the GRN.`,
  OVER_RECEIPT: 'With every receipt the tab assigns to that PO line, it would receive more than it ordered.',
  GRN_PARTLY_HELD: 'Another line of its GRN is held, and a GRN is linked whole or not at all.',
} as const;
export type HoldReason = keyof typeof HOLD_REASONS;
const REASONS = Object.keys(HOLD_REASONS) as HoldReason[];

/** Two supplier records; a GRN of one may be linked to a PO of the other once the reviewer confirms them. */
export interface SupplierPairRef { grnSupplierId: number; poSupplierId: number }

/** What the reviewer decides on the dry run and repeats on the apply; the selectionHash covers it. */
export interface ReviewChoices {
  /** GRN lines kept out of this run; each one holds its whole GRN back. */
  excludeGrnLineIds?: number[];
  /** Supplier records confirmed as one company, e.g. 'GLOBAL  STAR' and 'GLOBAL STAR'. */
  sameSupplierPairs?: SupplierPairRef[];
}

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
  /** SUPPLIER_MISMATCH: the GRN's supplier and the PO's. */
  suppliers?: { grnSupplierId: number; grnSupplier: string; poSupplierId: number; poSupplier: string };
  /** PO_AFTER_RECEIPT: the two dates. */
  dates?: { grnDate: string; poDate: string; days: number };
  /** GRN_PARTLY_HELD: the lines of the same GRN that hold it back. */
  blockedBy?: Array<{ grnLineId: number; itemCode: string; reason: HoldReason }>;
}

/**
 * A GRN header's PO once the run's links are in: the one PO all the GRN's lines point
 * to, else none. That is what the GRN edit derives (grn/routes.ts updatePostedGrn), so
 * re-saving the GRN keeps it.
 */
export interface HeaderChange {
  grnId: number;
  grnNo: string;
  poIdBefore: number | null;
  poNoBefore: string | null;
  poIdAfter: number | null;
  poNoAfter: string | null;
}

/** A GRN supplier and a PO supplier that differ on lines that passed every earlier check. */
export interface SupplierPair extends SupplierPairRef {
  grnSupplier: string;
  poSupplier: string;
  /** Confirmed as one company in sameSupplierPairs: its lines go on to the remaining checks. */
  confirmedSame: boolean;
  lines: number;
  grns: string[];
}

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
  headers: HeaderChange[];
  affectedPos: AffectedPo[];
  supplierPairs: SupplierPair[];
  /** The reviewer's choices as applied; exclusions naming no unlinked POSTED line are listed apart. */
  review: { excludeGrnLineIds: number[]; excludedNotUnlinked: number[]; sameSupplierPairs: SupplierPairRef[] };
  /** PO lines whose receipts were all held back as an over-receipt. */
  overReceivedPoLines: number;
  totals: {
    unlinkedLines: number;
    linkable: number;
    linkableBeforeOverReceipt: number;
    /** After the over-receipt check, before whole GRNs are held back for a held line. */
    linkableBeforeWholeGrn: number;
    held: number;
    byReason: Record<HoldReason, number>;
    qtyLinked: string;
    /** Links of GRNs the import gave its placeholder supplier to another supplier's PO. */
    placeholderSupplierLinks: number;
    grns: number;
    grnHeadersSet: number;
    grnHeadersCleared: number;
    affectedPos: number;
  };
  /** Every PO, by stored status: now, and once the affected POs carry their derived status. */
  poStatusCounts: { before: Record<string, number>; after: Record<string, number> };
  /** The dashboard's Pending PO Value (Σ pending_amount over receivable lines), before and after. */
  pendingValue: { before: string; after: string };
  /** sha256 over the links, the PO-line figures they were checked against, the header changes and the review choices. */
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

/** A confirmed pair holds in either direction: the two records are one company. */
const pairKey = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`);

/** Whole days from one 'YYYY-MM-DD' date to another. */
const daysFrom = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** The review choices in one order, so the same choices always hash the same. */
function normaliseReview(choices: ReviewChoices): { excluded: number[]; pairs: SupplierPairRef[] } {
  const excluded = [...new Set((choices.excludeGrnLineIds ?? []).map(Number))].sort((a, b) => a - b);
  const pairs = new Map<string, SupplierPairRef>();
  for (const p of choices.sameSupplierPairs ?? []) {
    const ref = { grnSupplierId: Number(p.grnSupplierId), poSupplierId: Number(p.poSupplierId) };
    pairs.set(pairKey(ref.grnSupplierId, ref.poSupplierId), ref);
  }
  return { excluded, pairs: [...pairs.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, p]) => p) };
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

type GrnLineRow = {
  id: number; grn_id: number; grn_no: string; grn_date: string; supplier_id: number; supplier_code: string; supplier_name: string;
  item_id: number; item_code: string; item_description: string; grn_qty: string;
};
type PoHeaderRow = { id: number; po_no: string; key: string; status: string; po_date: string; supplier_id: number; supplier_name: string };
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
 * `lock` (inside the apply transaction) takes the unlinked GRN lines, the named POs'
 * lines and the linked GRNs' headers FOR UPDATE first, so a GRN posted meanwhile
 * cannot slip past the over-receipt check.
 */
export async function planStoreGrnLinks(
  run: Run,
  grid: string[][],
  opts: ReviewChoices & { lock?: boolean } = {},
): Promise<LinkPlan> {
  const [mapping] = await run<{ column_map: ColumnMap[] }>(
    'SELECT column_map FROM google_sheet_mappings WHERE sheet_name = $1', [STORE_GRN_TAB],
  );
  if (!mapping) {
    throw BusinessRuleError(`The Google sync has no column mapping for the ${STORE_GRN_TAB} tab, so the tab cannot be read. Nothing was linked.`);
  }
  const tab = tabRowsOf(grid, Array.isArray(mapping.column_map) ? mapping.column_map : []);
  const review = normaliseReview(opts);
  const excluded = new Set(review.excluded);
  const confirmedSame = new Set(review.pairs.map((p) => pairKey(p.grnSupplierId, p.poSupplierId)));

  // 1. The receipts without a PO, with their GRN's supplier and date.
  const lines = await run<GrnLineRow>(
    `SELECT gl.id, gl.grn_id, gh.grn_no, to_char(gh.grn_date, 'YYYY-MM-DD') AS grn_date, gh.supplier_id, s.supplier_code, s.supplier_name,
            gl.item_id, gl.item_code, gl.item_description, gl.grn_qty::text AS grn_qty
       FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id JOIN suppliers s ON s.id = gh.supplier_id
      WHERE gl.po_line_id IS NULL AND gh.status = 'POSTED'
      ORDER BY gl.id${opts.lock ? ' FOR UPDATE OF gl' : ''}`,
    [],
  );
  const unlinkedIds = new Set(lines.map((l) => Number(l.id)));

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
    if (excluded.has(ref.grnLineId)) {
      hold(ref, 'EXCLUDED', 'Kept out of this run by the reviewer (excludeGrnLineIds).');
      continue;
    }
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

  // 4. The POs named, with their supplier and date, and their lines with what they have received so far.
  const poHeaders = named.length === 0 ? [] : await run<PoHeaderRow>(
    `SELECT h.id, h.po_no, upper(trim(h.po_no)) AS key, h.status, to_char(h.po_date, 'YYYY-MM-DD') AS po_date, h.supplier_id, s.supplier_name
       FROM purchase_order_headers h JOIN suppliers s ON s.id = h.supplier_id
      WHERE upper(trim(h.po_no)) = ANY($1::text[]) ORDER BY h.id`,
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
  //    Then the PO must be the GRN supplier's and not dated well after the receipt.
  const candidates: Array<{ ref: LineRef; header: PoHeaderRow; poLine: PoLineRow }> = [];
  const supplierPairs = new Map<string, SupplierPair>();
  const placeholderLines = new Set<number>();
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
    // The ERP's own receipt takes a PO GRN's supplier from its PO and refuses to mix two
    // (grn/routes.ts resolveGrnLines); the tab's PO number alone does not outweigh the
    // GRN's supplier. The 2026-10-17 review found ZG/RM/0330 (COPTEC) naming Z/RM/00200,
    // RATNACHINTAMANI's PO.
    const grnSupplierId = Number(n.line.supplier_id);
    const poSupplierId = Number(header.supplier_id);
    if (grnSupplierId !== poSupplierId) {
      if (n.line.supplier_code === IMPORT_PLACEHOLDER_SUPPLIER_CODE) {
        placeholderLines.add(n.ref.grnLineId);
      } else {
        const confirmed = confirmedSame.has(pairKey(grnSupplierId, poSupplierId));
        const pair = supplierPairs.get(`${grnSupplierId}>${poSupplierId}`) ?? {
          grnSupplierId, grnSupplier: n.line.supplier_name, poSupplierId, poSupplier: header.supplier_name,
          confirmedSame: confirmed, lines: 0, grns: [],
        };
        pair.lines += 1;
        if (!pair.grns.includes(n.ref.grnNo)) pair.grns.push(n.ref.grnNo);
        supplierPairs.set(`${grnSupplierId}>${poSupplierId}`, pair);
        if (!confirmed) {
          hold(n.ref, 'SUPPLIER_MISMATCH', `${n.ref.grnNo} is from ${n.line.supplier_name} (supplier ${grnSupplierId}); `
            + `${header.po_no} is ${header.supplier_name}'s (supplier ${poSupplierId}).`, {
            poNos: [n.poNo],
            suppliers: { grnSupplierId, grnSupplier: n.line.supplier_name, poSupplierId, poSupplier: header.supplier_name },
          });
          continue;
        }
      }
    }
    const days = daysFrom(n.line.grn_date, header.po_date);
    if (days > PO_AFTER_RECEIPT_DAYS) {
      hold(n.ref, 'PO_AFTER_RECEIPT', `${header.po_no} is dated ${header.po_date}, ${days} days after ${n.ref.grnNo} (${n.line.grn_date}).`, {
        poNos: [n.poNo], dates: { grnDate: n.line.grn_date, poDate: header.po_date, days },
      });
      continue;
    }
    candidates.push({ ref: n.ref, header, poLine: matches[0]! });
  }

  // 6. Over-receipt, per PO line, over all the receipts the tab assigns to it at once.
  const byPoLine = new Map<number, typeof candidates>();
  for (const c of candidates) addTo(byPoLine, Number(c.poLine.po_line_id), c);
  const linkable: PlannedLink[] = [];
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
      linkable.push({ ...c.ref, poId: Number(header.id), poNo: header.po_no, poLineId, poLineNo: Number(poLine.line_no) });
    }
  }
  checked.sort((a, b) => a[0] - b[0]);

  // 7. A GRN is linked whole or not at all. GET /grn/:id calls a GRN with any linked line
  //    a PO GRN; PUT /grn/:id then wants a PO line on every line (grnSchema) and will not
  //    switch it back to DIRECT (updatePostedGrn), so a GRN linked in part could no longer
  //    be saved. The 2026-10-17 review found 169 GRNs that would have been left so, e.g.
  //    ZG/RM/0011 with CRC245120 linked and CRC195120 held as an over-receipt. Holding a
  //    receipt back only lowers what its PO line receives, so no over-receipt follows.
  const heldOfGrn = new Map<number, HeldLine[]>();
  for (const h of held) addTo(heldOfGrn, h.grnId, h);
  const links: PlannedLink[] = [];
  for (const l of linkable) {
    const blocking = heldOfGrn.get(l.grnId);
    if (!blocking) {
      links.push(l);
      continue;
    }
    const blockers = blocking.slice(0, BLOCKERS_NAMED).map((b) => `${b.itemCode} (${b.reason})`).join(', ');
    hold(l, 'GRN_PARTLY_HELD', `${l.grnNo} is linked whole or not at all, and ${blocking.length} of its line(s) are held: `
      + `${blockers}${blocking.length > BLOCKERS_NAMED ? ', …' : ''}. It would link to ${l.poNo} line ${l.poLineNo}.`, {
      poNos: [l.poNo],
      blockedBy: blocking.map((b) => ({ grnLineId: b.grnLineId, itemCode: b.itemCode, reason: b.reason })),
    });
  }
  links.sort((a, b) => a.grnLineId - b.grnLineId);
  held.sort((a, b) => a.grnLineId - b.grnLineId);

  // 8. Each linked GRN's header then names the one PO all its lines point to, else none:
  //    what the GRN edit derives (grn/routes.ts updatePostedGrn), so re-saving the GRN
  //    keeps it. A header naming one PO while the lines point to two is cleared, and the
  //    value it held is recorded for undo.
  const grnIds = [...new Set(links.map((l) => l.grnId))];
  const linkedBefore = grnIds.length === 0 ? [] : await run<{ grn_id: number; header_po_id: number | null; header_po_no: string | null; po_id: number | null }>(
    `SELECT gh.id AS grn_id, gh.po_id AS header_po_id, hp.po_no AS header_po_no, pol.po_id
       FROM grn_headers gh
       LEFT JOIN purchase_order_headers hp ON hp.id = gh.po_id
       LEFT JOIN grn_lines gl ON gl.grn_id = gh.id AND gl.po_line_id IS NOT NULL
       LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
      WHERE gh.id = ANY($1::bigint[])${opts.lock ? ' FOR UPDATE OF gh' : ''}`,
    [grnIds],
  );
  const posOfGrn = new Map<number, { poIdBefore: number | null; poNoBefore: string | null; poIds: Set<number> }>();
  for (const r of linkedBefore) {
    const g = posOfGrn.get(Number(r.grn_id))
      ?? { poIdBefore: r.header_po_id == null ? null : Number(r.header_po_id), poNoBefore: r.header_po_no, poIds: new Set<number>() };
    if (r.po_id != null) g.poIds.add(Number(r.po_id));
    posOfGrn.set(Number(r.grn_id), g);
  }
  const firstLinkOf = new Map<number, PlannedLink>();
  const poNoOf = new Map<number, string>();
  for (const l of links) {
    posOfGrn.get(l.grnId)?.poIds.add(l.poId);
    poNoOf.set(l.poId, l.poNo);
    if (!firstLinkOf.has(l.grnId)) firstLinkOf.set(l.grnId, l);
  }
  const headers: HeaderChange[] = [];
  for (const grnId of grnIds) {
    const g = posOfGrn.get(grnId)!;
    // Every line of the GRN is linked now (step 7), so its lines' POs are these.
    const poIdAfter = g.poIds.size === 1 ? [...g.poIds][0]! : null;
    if (poIdAfter === g.poIdBefore) continue;
    headers.push({
      grnId, grnNo: firstLinkOf.get(grnId)!.grnNo, poIdBefore: g.poIdBefore, poNoBefore: g.poNoBefore,
      poIdAfter, poNoAfter: poIdAfter === null ? null : poNoOf.get(poIdAfter) ?? null,
    });
  }
  headers.sort((a, b) => a.grnId - b.grnId);

  // 9. The POs before and after, and the totals over every PO.
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
    headers: headers.map((h) => [h.grnId, h.poIdBefore, h.poIdAfter]),
    review: { excluded: review.excluded, sameSuppliers: review.pairs.map((p) => pairKey(p.grnSupplierId, p.poSupplierId)) },
  })).digest('hex');

  return {
    tab: { sheet: STORE_GRN_TAB, rowsRead: Math.max(grid.length - 1, 0), rowsWithGrnAndItem: tab.rows.length, columns: tab.columns },
    links,
    held,
    headers,
    affectedPos,
    supplierPairs: [...supplierPairs.values()].sort((a, b) => b.lines - a.lines || a.grnSupplierId - b.grnSupplierId || a.poSupplierId - b.poSupplierId),
    review: {
      excludeGrnLineIds: review.excluded,
      excludedNotUnlinked: review.excluded.filter((id) => !unlinkedIds.has(id)),
      sameSupplierPairs: review.pairs,
    },
    overReceivedPoLines,
    totals: {
      unlinkedLines: lines.length,
      linkable: links.length,
      linkableBeforeOverReceipt: candidates.length,
      linkableBeforeWholeGrn: linkable.length,
      held: held.length,
      byReason,
      qtyLinked: toQty(links.reduce((s, l) => s.plus(dec(l.grnQty)), dec(0))),
      placeholderSupplierLinks: links.filter((l) => placeholderLines.has(l.grnLineId)).length,
      grns: grnIds.length,
      grnHeadersSet: headers.filter((h) => h.poIdAfter !== null).length,
      grnHeadersCleared: headers.filter((h) => h.poIdAfter === null).length,
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
    review: plan.review,
    totals: plan.totals,
    overReceivedPoLines: plan.overReceivedPoLines,
    reasons: HOLD_REASONS,
    poStatusCounts: plan.poStatusCounts,
    statusTransitions: statusTransitions(plan),
    pendingValue: plan.pendingValue,
    supplierPairs: plan.supplierPairs,
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
function batchesOf(plan: LinkPlan): Array<{ links: PlannedLink[]; headers: HeaderChange[] }> {
  const byGrn = new Map<number, PlannedLink[]>();
  for (const l of plan.links) addTo(byGrn, l.grnId, l);
  const headerOf = new Map(plan.headers.map((h) => [h.grnId, h]));
  const batches: Array<{ links: PlannedLink[]; headers: HeaderChange[] }> = [];
  let current = { links: [] as PlannedLink[], headers: [] as HeaderChange[] };
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
  headersCleared: number;
  poStatusesRederived: number;
  runId: string;
  auditIds: number[];
}

/**
 * Writes the plan the dry run showed. MUST run inside a transaction: the plan is
 * rebuilt with the rows locked and must carry the dry run's hash (the same review
 * choices included), and every linked PO line, GRN and status is checked by the
 * database before anything commits.
 */
export async function applyStoreGrnLinks(
  tx: Queryable,
  grid: string[][],
  ctx: ReviewChoices & { expectedHash: string; actor: AuditActor },
): Promise<ApplyResult> {
  const run = runIn(tx);
  const plan = await planStoreGrnLinks(run, grid, {
    lock: true, excludeGrnLineIds: ctx.excludeGrnLineIds, sameSupplierPairs: ctx.sameSupplierPairs,
  });
  if (plan.selectionHash !== ctx.expectedHash) {
    throw ConflictError(
      `The GRN tab, the ERP or the review choices have changed since the dry run (now ${plan.totals.linkable} line(s) would be linked and `
        + `${plan.totals.held} listed). Nothing was linked; run the dry run again with the same excludeGrnLineIds and sameSupplierPairs, and review it.`,
      { linkable: plan.totals.linkable, held: plan.totals.held, selectionHash: plan.selectionHash },
    );
  }
  if (plan.links.length === 0) throw BusinessRuleError('No GRN line can be linked; nothing was written.');

  const runId = randomUUID();
  const batches = batchesOf(plan);
  let linesLinked = 0;
  let headersSet = 0;
  let headersCleared = 0;
  for (const [k, b] of batches.entries()) {
    const set = await run<{ id: number }>(
      `UPDATE grn_lines gl SET po_line_id = v.po_line_id, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(grn_line_id bigint, po_line_id bigint)
        WHERE gl.id = v.grn_line_id AND gl.po_line_id IS NULL
        RETURNING gl.id`,
      [JSON.stringify(b.links.map((l) => ({ grn_line_id: l.grnLineId, po_line_id: l.poLineId })))],
    );
    const changed = b.headers.length === 0 ? [] : await run<{ id: number }>(
      `UPDATE grn_headers gh SET po_id = v.po_id_after, updated_at = now()
         FROM jsonb_to_recordset($1::jsonb) AS v(grn_id bigint, po_id_before bigint, po_id_after bigint)
        WHERE gh.id = v.grn_id AND gh.po_id IS NOT DISTINCT FROM v.po_id_before
        RETURNING gh.id`,
      [JSON.stringify(b.headers.map((h) => ({ grn_id: h.grnId, po_id_before: h.poIdBefore, po_id_after: h.poIdAfter })))],
    );
    if (set.length !== b.links.length || changed.length !== b.headers.length) {
      // The rows were locked and re-read in this transaction; a difference is a bug.
      throw ServerError(`Linking batch ${k + 1} wrote ${set.length} of ${b.links.length} line(s) and ${changed.length} of ${b.headers.length} header(s); nothing was written.`);
    }
    const set1 = b.headers.filter((h) => h.poIdAfter !== null).length;
    const cleared1 = b.headers.length - set1;
    linesLinked += set.length;
    headersSet += set1;
    headersCleared += cleared1;
    const grns = new Set(b.links.map((l) => l.grnId)).size;
    await auditIn(tx, {
      actor: ctx.actor,
      action: 'UPDATE',
      entity: LINK_AUDIT_ENTITY,
      entityLabel: `store GRN links ${k + 1}/${batches.length}: ${b.links[0]!.grnNo} … ${b.links[b.links.length - 1]!.grnNo}`,
      before: {
        links: b.links.map((l) => ({ grnLineId: l.grnLineId, poLineId: null })),
        headers: b.headers.map((h) => ({ grnId: h.grnId, poId: h.poIdBefore })),
      },
      after: {
        kind: 'links', runId, batch: k + 1, batches: batches.length, selectionHash: plan.selectionHash,
        links: b.links.map((l) => ({
          grnLineId: l.grnLineId, grnId: l.grnId, grnNo: l.grnNo, itemCode: l.itemCode, grnQty: l.grnQty,
          poLineId: l.poLineId, poId: l.poId, poNo: l.poNo, poLineNo: l.poLineNo, tabRows: l.tabRows,
        })),
        headers: b.headers,
      },
      message: `Linked ${b.links.length} store GRN line(s) on ${grns} whole GRN(s) to the PO lines the ${STORE_GRN_TAB} tab's 'Po No' column names `
        + `(batch ${k + 1} of ${batches.length}); ${set1} GRN header(s) now name their one PO and ${cleared1} no longer name one, `
        + 'their lines pointing to several. Quantities, stock and the ledger were not changed.',
    });
  }

  const poStatusesRederived = await recomputePoStatuses(tx, plan.affectedPos.map((p) => p.poId));

  // Checked by the database before anything commits: no linked PO line has received
  // more than it ordered, no linked GRN is left with a line on no PO line or with a
  // header other than its lines' one PO, and every affected PO carries the status the
  // dry run showed.
  const over = await run<{ po_no: string; line_no: number; po_qty: string; received_qty: string }>(
    `SELECT po_no, line_no, po_qty::text AS po_qty, received_qty::text AS received_qty FROM v_po_line_balance
      WHERE po_line_id = ANY($1::bigint[]) AND received_qty > po_qty + $2::numeric`,
    [[...new Set(plan.links.map((l) => l.poLineId))], OVER_RECEIPT_TOLERANCE.toString()],
  );
  const partial = await run<{ grn_no: string }>(
    `SELECT gh.grn_no
       FROM grn_headers gh
       JOIN grn_lines gl ON gl.grn_id = gh.id
       LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
      WHERE gh.id = ANY($1::bigint[])
      GROUP BY gh.id, gh.grn_no, gh.po_id
     HAVING COUNT(*) FILTER (WHERE gl.po_line_id IS NULL) > 0
         OR gh.po_id IS DISTINCT FROM (CASE WHEN COUNT(DISTINCT pol.po_id) = 1 THEN MIN(pol.po_id) END)`,
    [[...new Set(plan.links.map((l) => l.grnId))]],
  );
  const statuses = await run<{ id: number; status: string }>(
    'SELECT id, status FROM purchase_order_headers WHERE id = ANY($1::bigint[])', [plan.affectedPos.map((p) => p.poId)],
  );
  const expected = new Map(plan.affectedPos.map((p) => [p.poId, p.statusAfter]));
  const drifted = statuses.filter((s) => expected.get(Number(s.id)) !== s.status);
  if (over.length > 0 || partial.length > 0 || drifted.length > 0) {
    throw ServerError(
      `Linking check failed (${over.length} PO line(s) over-received, ${partial.length} GRN(s) not linked whole or with another header PO, `
        + `${drifted.length} PO status(es) differ from the dry run); nothing was written.`,
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
      review: plan.review, supplierPairs: plan.supplierPairs,
      statusTransitions: statusTransitions(plan), poStatusesRederived,
      poStatusCounts: plan.poStatusCounts.after, pendingValue: plan.pendingValue.after,
    },
    message: `${summariseLinkPlan(plan)} Linked in ${auditIds.length} audited batch(es); undo takes back exactly these links. `
      + 'Quantities, stock and the ledger were not changed.',
  });
  return { plan, linesLinked, headersSet, headersCleared, poStatusesRederived, runId, auditIds };
}

type LinkRecord = { grnLineId: number; grnId: number; grnNo: string; poLineId: number; poId: number; poNo: string };
type AuditRow = { id: number; after_data: Record<string, unknown> | null };

export interface UndoResult {
  undone: Array<{ grnLineId: number; grnNo: string; poLineId: number; poNo: string }>;
  /** Headers set back to what they named before the run; `repairSet` is what the run had written. */
  headersRestored: Array<{ grnId: number; grnNo: string; repairSet: number | null; restoredTo: number | null }>;
  /** Headers the run changed that no longer hold what it wrote: left as they are. */
  headersLeft: Array<{ grnId: number; grnNo: string; reason: string }>;
  skipped: Array<{ grnLineId: number; reason: string }>;
  poStatusesRederived: number;
}

/**
 * Takes back links this repair made: by one audit entry (a batch, or a whole run's
 * summary entry) or by GRN line ids. A link is set back to NULL only while the line
 * still points to the PO line this repair set, and only by the latest audit entry
 * that linked it. A GRN is undone whole: one whose other repair-made links are not
 * in the undo is skipped, as a GRN left with some lines on a PO line and others on
 * none could no longer be saved from the GRN screen. A header the run changed is set
 * back to its previous value while it still holds what the run wrote. MUST run
 * inside a transaction.
 */
export async function undoStoreGrnLinks(
  tx: Queryable,
  target: { auditId?: number; grnLineIds?: number[] },
  ctx: { reason: string; actor: AuditActor },
): Promise<UndoResult> {
  const run = runIn(tx);
  const entries = await run<AuditRow>(
    `SELECT id, after_data FROM audit_logs WHERE entity = $1 AND after_data->>'kind' = 'links' ORDER BY id`,
    [LINK_AUDIT_ENTITY],
  );
  const linksOf = (e: AuditRow) => (Array.isArray(e.after_data?.links) ? e.after_data!.links as LinkRecord[] : []);
  const headersOf = (e: AuditRow) => (Array.isArray(e.after_data?.headers) ? e.after_data!.headers as HeaderChange[] : []);
  // The latest entry that linked each line, and that changed each header.
  const latest = new Map<number, { auditId: number; link: LinkRecord }>();
  const headerChangedBy = new Map<number, { auditId: number; header: HeaderChange }>();
  for (const e of entries) {
    for (const l of linksOf(e)) latest.set(Number(l.grnLineId), { auditId: Number(e.id), link: l });
    for (const h of headersOf(e)) headerChangedBy.set(Number(h.grnId), { auditId: Number(e.id), header: h });
  }

  const skipped: UndoResult['skipped'] = [];
  const requested: Array<{ auditId: number; link: LinkRecord }> = [];
  if (target.auditId !== undefined) {
    const [entry] = await run<AuditRow & { entity: string }>(
      'SELECT id, entity, after_data FROM audit_logs WHERE id = $1', [target.auditId],
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

  // Every line of the GRNs concerned, to check each link and that its GRN is undone whole.
  const grnIdsAsked = [...new Set(requested.map((r) => Number(r.link.grnId)))];
  const current = grnIdsAsked.length === 0 ? [] : await run<{ id: number; grn_id: number; po_line_id: number | null }>(
    'SELECT id, grn_id, po_line_id FROM grn_lines WHERE grn_id = ANY($1::bigint[]) ORDER BY id FOR UPDATE',
    [grnIdsAsked],
  );
  const nowOf = new Map<number, number | null>(current.map((c) => [Number(c.id), c.po_line_id == null ? null : Number(c.po_line_id)]));
  const inPlace: Array<{ auditId: number; link: LinkRecord }> = [];
  for (const r of requested) {
    const id = Number(r.link.grnLineId);
    const now = nowOf.get(id);
    if (!nowOf.has(id)) skipped.push({ grnLineId: id, reason: 'The GRN line no longer exists.' });
    else if (now === null) skipped.push({ grnLineId: id, reason: 'It is not linked now (already undone).' });
    else if (now !== Number(r.link.poLineId)) skipped.push({ grnLineId: id, reason: `It now points to another PO line (${now}), not the one this repair set.` });
    else inPlace.push(r);
  }

  const chosen = new Set(inPlace.map((r) => Number(r.link.grnLineId)));
  const byGrn = new Map<number, typeof inPlace>();
  for (const r of inPlace) addTo(byGrn, Number(r.link.grnId), r);
  const toUndo: typeof inPlace = [];
  for (const [grnId, group] of byGrn) {
    // The GRN's other lines that still carry a link this repair made.
    const left = current.filter((c) => Number(c.grn_id) === grnId && !chosen.has(Number(c.id)) && c.po_line_id != null
      && Number(latest.get(Number(c.id))?.link.poLineId) === Number(c.po_line_id));
    if (left.length === 0) {
      toUndo.push(...group);
      continue;
    }
    const names = left.map((c) => `${c.id} (audit #${latest.get(Number(c.id))!.auditId})`).join(', ');
    for (const r of group) {
      skipped.push({
        grnLineId: Number(r.link.grnLineId),
        reason: `${r.link.grnNo} is undone whole, and its line(s) ${names}, linked by this repair, are not in this undo; name them too.`,
      });
    }
  }
  if (toUndo.length === 0) {
    throw BusinessRuleError('Nothing to undo: none of these links is in place as this repair made it, or their GRNs are not named whole.', { skipped });
  }

  const cleared = await run<{ id: number }>(
    `UPDATE grn_lines gl SET po_line_id = NULL, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(grn_line_id bigint, po_line_id bigint)
      WHERE gl.id = v.grn_line_id AND gl.po_line_id = v.po_line_id
      RETURNING gl.id`,
    [JSON.stringify(toUndo.map((r) => ({ grn_line_id: Number(r.link.grnLineId), po_line_id: Number(r.link.poLineId) })))],
  );
  if (cleared.length !== toUndo.length) {
    throw ServerError(`Undo cleared ${cleared.length} of ${toUndo.length} link(s); nothing was changed.`);
  }

  // A header goes back to what it named before the entry being undone changed it.
  const restore: HeaderChange[] = [];
  for (const grnId of new Set(toUndo.map((r) => Number(r.link.grnId)))) {
    const change = headerChangedBy.get(grnId);
    if (change && toUndo.some((r) => Number(r.link.grnId) === grnId && r.auditId === change.auditId)) restore.push(change.header);
  }
  const restoredRows = restore.length === 0 ? [] : await run<{ id: number }>(
    `UPDATE grn_headers gh SET po_id = v.po_id_before, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(grn_id bigint, po_id_before bigint, po_id_after bigint)
      WHERE gh.id = v.grn_id AND gh.po_id IS NOT DISTINCT FROM v.po_id_after
      RETURNING gh.id`,
    [JSON.stringify(restore.map((h) => ({ grn_id: Number(h.grnId), po_id_before: h.poIdBefore, po_id_after: h.poIdAfter })))],
  );
  const restoredIds = new Set(restoredRows.map((r) => Number(r.id)));
  const poStatusesRederived = await recomputePoStatuses(tx, [...new Set(toUndo.map((r) => Number(r.link.poId)))]);

  const result: UndoResult = {
    undone: toUndo.map((r) => ({ grnLineId: Number(r.link.grnLineId), grnNo: r.link.grnNo, poLineId: Number(r.link.poLineId), poNo: r.link.poNo })),
    headersRestored: restore.filter((h) => restoredIds.has(Number(h.grnId)))
      .map((h) => ({ grnId: Number(h.grnId), grnNo: h.grnNo, repairSet: h.poIdAfter, restoredTo: h.poIdBefore })),
    headersLeft: restore.filter((h) => !restoredIds.has(Number(h.grnId)))
      .map((h) => ({ grnId: Number(h.grnId), grnNo: h.grnNo, reason: `It no longer names ${h.poNoAfter ?? 'no PO'} as this repair set it; left as it is.` })),
    skipped,
    poStatusesRederived,
  };
  await auditIn(tx, {
    actor: ctx.actor,
    action: 'CANCEL',
    entity: LINK_AUDIT_ENTITY,
    entityLabel: target.auditId !== undefined ? `undo of audit #${target.auditId}` : `undo of ${toUndo.length} GRN line link(s)`,
    before: {
      links: toUndo.map((r) => ({ grnLineId: Number(r.link.grnLineId), poLineId: Number(r.link.poLineId) })),
      headers: result.headersRestored.map((h) => ({ grnId: h.grnId, poId: h.repairSet })),
    },
    after: {
      kind: 'undo', reason: ctx.reason, target,
      links: toUndo.map((r) => ({ grnLineId: Number(r.link.grnLineId), poLineId: null })),
      headers: result.headersRestored.map((h) => ({ grnId: h.grnId, poId: h.restoredTo })),
      headersLeft: result.headersLeft, skipped, poStatusesRederived,
    },
    message: `Store GRN links undone: ${toUndo.length} GRN line(s) no longer point to a PO line and ${result.headersRestored.length} GRN header(s) `
      + `name what they named before; ${poStatusesRederived} PO status(es) re-derived. Quantities and stock were not changed. Reason: ${ctx.reason}`,
  });
  return result;
}
