/**
 * Inventory Google Sheets synchronisation (read-only on the Google side).
 *
 * One run per category:
 *   1. Read every needed range in ONE batchGet, before any database transaction
 *      is opened (no lock is held while waiting on Google).
 *   2. Classify every row with the pure rules in sheet-model.ts — the sheets' own
 *      live-stock formulas. Rows the sheet does not count are reported with a
 *      reason (quarantine) or counted in the report, never silently dropped.
 *   3. Apply the category in ONE transaction, so the ERP always reflects one
 *      consistent reading of the sheet:
 *        · live-stock tab  → inventory_items (opening, live stock, adjustment total)
 *        · movement tabs   → inventory_transactions, identified by content
 *                            (source_key), not by row number. A movement that
 *                            disappears from the sheet is REVERSED with a reason,
 *                            never deleted; edits to its identity show as a
 *                            reversal plus a new movement.
 *        · per-item proof  → opening + inward − outward + adjustments vs the
 *                            sheet's live stock, stored on inventory_items
 *        · Purchase stock  → items.live_stock_qty follows the sheet total for
 *                            the code; every change is written to stock_ledger
 *                            as SHEET_SYNC, so the ledger explains each figure.
 *   4. Record a per-tab reconciliation report (inventory_sync_checkpoints).
 *
 * Safety valve: a tab whose new reading would reverse an unusually large share of
 * its movements (a cleared or re-sorted sheet, a partial read) is BLOCKED — left
 * exactly as it was — until an administrator re-runs with `applyLargeChanges`.
 * `dryRun` performs the whole run and rolls it back, returning the report.
 */
import crypto from 'node:crypto';
import { withTransaction, txQuery, query, type Queryable } from '../../db/index.js';
import { env } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { INVENTORY_CATEGORIES, type InventoryCategory } from '../../domain/inventory.js';
import {
  INVENTORY_SHEETS, ADJUSTMENT_TAB, financialYearMonths, colIndex,
  parseStockTab, parseMovementTab, parseAdjustmentTab, reconcileItems,
  REPORT_ONLY,
  type CategorySheetConfig, type ExclusionCode, type MovementParse, type MovementRecord,
  type QuarantineCandidate, type Row, type StockParse,
} from './sheet-model.js';

/* ── Result shapes ──────────────────────────────────────────────────────────── */

export interface TabSyncReport {
  tab: string;
  kind: 'STOCK' | 'MOVEMENT' | 'ADJUSTMENT';
  range: string;
  firstDataRow: number;
  sourceRows: number;
  blankRows: number;
  /** Rows the sheet's own formula counts (all imported unless the tab is BLOCKED). */
  validRows: number;
  excluded: Partial<Record<ExclusionCode, number>>;
  /** Counted rows the sheet owner should still correct (e.g. a Month cell holding a date). */
  warnings?: Record<string, number>;
  quarantined: number;
  inserted: number;
  updated: number;
  unchanged: number;
  reversed: number;
  duplicateRows?: number;
  duplicateCodes?: string[];
  firstRecord: string | null;
  lastRecord: string | null;
  status: 'SUCCESS' | 'BLOCKED';
  message?: string;
}

export interface ItemMismatch {
  itemCode: string;
  sheetLive: number;
  computed: number;
  difference: number;
  note: string;
}

export interface CategorySyncResult {
  category: InventoryCategory;
  spreadsheetId: string;
  runId: string;
  dryRun: boolean;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  startedAt: string;
  durationMs: number;
  tabs: TabSyncReport[];
  items: { inSheet: number; inserted: number; updated: number; noLongerInSheet: number; negativeInSheet: number; linkedToPurchaseItem: number };
  reconciliation: { checked: number; matched: number; mismatched: number; mismatches: ItemMismatch[] };
  purchaseStock: { aligned: number; negativeHeldAtZero: string[]; categoryChanged: number };
  /** Totals kept for the screens that show a one-line toast. */
  totalRowsRead: number;
  validRecordsImported: number;
  transactionsImported: number;
  quarantinedRecords: number;
  errorMessage?: string;
}

export interface SyncOptions {
  dryRun?: boolean;
  applyLargeChanges?: boolean;
  userId?: number | null;
  runId?: string;
  /** Replaces the Google read — tests supply sheet contents directly. */
  reader?: (cfg: CategorySheetConfig) => Promise<CategoryRead>;
}

/* ── Google read ────────────────────────────────────────────────────────────── */

async function getSheetsClient() {
  const { google } = await import('googleapis');
  const { GoogleAuth } = await import('google-auth-library');
  const keyFile = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE || 'C:\\secure\\google-service-account.json';
  const auth = new GoogleAuth({ keyFile, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  return google.sheets({ version: 'v4', auth: auth as never });
}

const quoteTab = (tab: string) => `'${tab.replace(/'/g, "''")}'`;

export interface CategoryRead {
  stockMain: Row[];
  stockOpening: Row[];
  stockAdjustment: Row[];
  movements: Row[][];
  adjustments: Row[];
  ranges: string[];
}

export function rangesFor(cfg: CategorySheetConfig): string[] {
  const s = cfg.stock;
  return [
    `${quoteTab(s.tab)}!A${s.headerRow}:${s.lastCol}`,
    `${quoteTab(s.tab)}!${s.openingCol}${s.headerRow}:${s.openingCol}`,
    `${quoteTab(s.tab)}!${s.adjustmentCol}${s.headerRow}:${s.adjustmentCol}`,
    ...cfg.movements.map((m) => `${quoteTab(m.tab)}!A${m.firstRow}:Z`),
    `${quoteTab(ADJUSTMENT_TAB.tab)}!A${ADJUSTMENT_TAB.firstRow}:K`,
  ];
}

async function readCategory(cfg: CategorySheetConfig): Promise<CategoryRead> {
  const sheets = await getSheetsClient();
  const ranges = rangesFor(cfg);
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const res = await sheets.spreadsheets.values.batchGet({
        spreadsheetId: cfg.spreadsheetId,
        ranges,
        // Raw numbers (no thousands separators or display rounding); dates as the sheet shows them.
        valueRenderOption: 'UNFORMATTED_VALUE',
        dateTimeRenderOption: 'FORMATTED_STRING',
      });
      const vr = res.data.valueRanges ?? [];
      if (vr.length !== ranges.length) {
        throw new Error(`Google returned ${vr.length} of ${ranges.length} ranges.`);
      }
      const rows = (i: number) => (vr[i]?.values ?? []) as Row[];
      const n = cfg.movements.length;
      return {
        stockMain: rows(0), stockOpening: rows(1), stockAdjustment: rows(2),
        movements: cfg.movements.map((_, i) => rows(3 + i)),
        adjustments: rows(3 + n),
        ranges,
      };
    } catch (err) {
      lastErr = err;
      const status = (err as { code?: unknown }).code ?? (err as { status?: unknown }).status;
      // Network errors carry a string code (ECONNRESET …); HTTP errors a number.
      const transient = typeof status !== 'number' || status === 429 || status >= 500;
      if (!transient || attempt === 3) break;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/* ── Small helpers ──────────────────────────────────────────────────────────── */

export function newRunId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
  return `INV-${stamp}-${crypto.randomBytes(2).toString('hex')}`;
}

/** Runs `sql` with `$1` = a JSON array of row objects, in chunks. */
async function jsonBatch(tx: Queryable, sql: string, rows: object[], extra: unknown[] = [], chunk = 1000): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await tx.query(sql, [JSON.stringify(rows.slice(i, i + chunk)), ...extra]);
  }
}

const describe = (r: MovementRecord | undefined) =>
  r ? `row ${r.rowNumber}: ${r.dateIso} ${r.code} ${r.direction === 'IN' ? '+' : '−'}${r.qty}` : null;

class DryRunRollback extends Error {
  constructor(readonly result: CategorySyncResult) {
    super('dry run — rolled back');
  }
}

let activeRun: { runId: string; startedAt: string; scope: string } | null = null;

export function activeInventorySync() {
  return activeRun;
}

/* ── Stock tab ──────────────────────────────────────────────────────────────── */

async function applyStock(
  tx: Queryable,
  cfg: CategorySheetConfig,
  stock: StockParse,
  itemIdByCode: Map<string, number>,
  result: CategorySyncResult,
  report: TabSyncReport,
  opts: SyncOptions,
): Promise<boolean> {
  const category = cfg.category;
  interface ExistingItem {
    id: string; item_code: string; item_id: string | null; item_description: string; primary_uom: string;
    opening: number; live: number; weight: number | null; rack_id: string | null; main_group: string | null;
    w1000: number | null; rate: number | null; adj: number; row_count: number;
    source_spreadsheet_id: string | null; source_tab: string | null; source_row_index: number | null; deleted: boolean;
  }
  const existing = await txQuery<ExistingItem>(
    tx,
    `SELECT id, item_code, item_id, item_description, primary_uom,
            opening_stock_qty::float8 AS opening, live_stock_qty::float8 AS live, live_weight_kg::float8 AS weight,
            rack_id, main_group, weight_per_1000pc_kg::float8 AS w1000, unit_price::float8 AS rate,
            sheet_adjustment_qty::float8 AS adj, sheet_row_count AS row_count,
            source_spreadsheet_id, source_tab, source_row_index, (deleted_at IS NOT NULL) AS deleted
       FROM inventory_items WHERE category = $1 ORDER BY id`,
    [category],
  );
  const byCode = new Map<string, ExistingItem>();
  for (const e of existing) {
    const k = e.item_code.trim().toUpperCase();
    const prev = byCode.get(k);
    // Prefer the row the sheet already owns when two rows differ only by letter case.
    if (!prev || (!prev.source_tab && e.source_tab)) byCode.set(k, e);
  }
  const same = (a: number | null, b: number | null) => (a === null || b === null ? a === b : Math.abs(a - b) < 0.00005);
  /** True when the UPDATE below would leave the stored row exactly as it is. */
  const unchanged = (e: ExistingItem, r: {
    item_id: number | null; item_description: string; uom: string; opening: number; live: number; weight: number | null;
    rack: string | null; main_group: string | null; w1000: number; rate: number; row_no: number; adj: number; row_count: number;
  }) =>
    !e.deleted &&
    (e.item_id === null ? null : Number(e.item_id)) === r.item_id &&
    (!r.item_description || e.item_description === r.item_description) &&
    (!r.uom || e.primary_uom === r.uom) &&
    same(e.opening, r.opening) && same(e.live, r.live) && same(e.adj, r.adj) &&
    (r.weight === null || same(e.weight, r.weight)) &&
    (r.rack === null || e.rack_id === r.rack) &&
    (r.main_group === null || e.main_group === r.main_group) &&
    (!(r.w1000 > 0) || same(e.w1000, r.w1000)) &&
    (!(r.rate > 0) || same(e.rate, r.rate)) &&
    e.source_spreadsheet_id === cfg.spreadsheetId && e.source_tab === cfg.stock.tab &&
    e.source_row_index === r.row_no && e.row_count === r.row_count;
  const inSheetBefore = existing.filter((e) => e.source_tab && e.source_row_index !== null).length;
  if (!opts.applyLargeChanges && inSheetBefore > 50 && stock.records.length < inSheetBefore * 0.5) {
    report.status = 'BLOCKED';
    report.message =
      `The live-stock tab now lists ${stock.records.length} items; ${inSheetBefore} were listed before. ` +
      'Nothing was changed for this category — check the sheet. An administrator can re-run with "apply large changes".';
    return false;
  }

  const inserts: object[] = [];
  const updates: object[] = [];
  let unchangedCount = 0;
  for (const s of stock.records) {
    const row = {
      item_id: itemIdByCode.get(s.codeKey) ?? null,
      item_code: s.code,
      item_description: s.description,
      uom: s.uom,
      opening: s.opening,
      live: s.liveQty,
      weight: s.weightKg,
      rack: s.rack,
      main_group: s.mainGroup,
      w1000: s.weight1000pc,
      rate: s.rate,
      row_no: s.rowNumber,
      adj: s.adjustment,
      row_count: s.rowCount,
    };
    const hit = byCode.get(s.codeKey);
    if (!hit) inserts.push(row);
    else if (unchanged(hit, row)) unchangedCount += 1;
    else updates.push({ id: Number(hit.id), ...row });
    if (row.item_id) result.items.linkedToPurchaseItem += 1;
    if (s.liveQty < 0) result.items.negativeInSheet += 1;
  }
  const recordset = `item_id bigint, item_code text, item_description text, uom text, opening numeric, live numeric,
       weight numeric, rack text, main_group text, w1000 numeric, rate numeric, row_no int, adj numeric, row_count int`;
  await jsonBatch(
    tx,
    `INSERT INTO inventory_items (
       item_id, item_code, item_description, category, primary_uom,
       opening_stock_qty, live_stock_qty, live_weight_kg, available_qty,
       rack_id, main_group, weight_per_1000pc_kg, unit_price,
       source_spreadsheet_id, source_tab, source_row_index, sheet_adjustment_qty, sheet_row_count, last_sync_at)
     SELECT v.item_id, v.item_code, v.item_description, $2, v.uom,
            v.opening, v.live, v.weight, GREATEST(v.live, 0),
            v.rack, v.main_group, v.w1000, v.rate,
            $3, $4, v.row_no, v.adj, v.row_count, now()
       FROM jsonb_to_recordset($1::jsonb) AS v(${recordset})`,
    inserts, [category, cfg.spreadsheetId, cfg.stock.tab],
  );
  await jsonBatch(
    tx,
    `UPDATE inventory_items ii
        SET item_id = v.item_id,
            item_description = COALESCE(NULLIF(v.item_description, ''), ii.item_description),
            primary_uom = COALESCE(NULLIF(v.uom, ''), ii.primary_uom),
            opening_stock_qty = v.opening,
            live_stock_qty = v.live,
            live_weight_kg = COALESCE(v.weight, ii.live_weight_kg),
            available_qty = GREATEST(v.live - ii.allocated_qty, 0),
            rack_id = COALESCE(v.rack, ii.rack_id),
            main_group = COALESCE(v.main_group, ii.main_group),
            weight_per_1000pc_kg = CASE WHEN v.w1000 > 0 THEN v.w1000 ELSE ii.weight_per_1000pc_kg END,
            unit_price = CASE WHEN v.rate > 0 THEN v.rate ELSE ii.unit_price END,
            source_spreadsheet_id = $2, source_tab = $3, source_row_index = v.row_no,
            sheet_adjustment_qty = v.adj, sheet_row_count = v.row_count,
            deleted_at = NULL, last_sync_at = now(), updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(id bigint, ${recordset})
      WHERE ii.id = v.id`,
    updates, [cfg.spreadsheetId, cfg.stock.tab],
  );
  result.items.inSheet = stock.records.length;
  result.items.inserted = inserts.length;
  result.items.updated = updates.length;

  // Items the sheet no longer lists keep their last figures, clearly marked.
  const listed = stock.records.map((s) => s.codeKey);
  const gone = await txQuery<{ id: string }>(
    tx,
    `UPDATE inventory_items
        SET source_row_index = NULL, recon_status = 'NOT_IN_SHEET', recon_checked_at = now(), updated_at = now(),
            recon_note = $3
      WHERE category = $1 AND deleted_at IS NULL AND source_tab IS NOT NULL AND source_row_index IS NOT NULL
        AND NOT (upper(item_code) = ANY($2::text[]))
      RETURNING id`,
    [category, listed, `No longer listed in "${cfg.stock.tab}" (sync ${result.runId}); last synced figures kept.`],
  );
  result.items.noLongerInSheet = gone.length;
  report.inserted = inserts.length;
  report.updated = updates.length;
  report.unchanged = unchangedCount;
  return true;
}

/* ── Movement tabs ──────────────────────────────────────────────────────────── */

interface ExistingTxn {
  id: string;
  txn_no: string;
  item_id: string | null;
  source_key: string | null;
  source_attr_hash: string | null;
  source_row_index: number | null;
  code_key: string;
  quantity: number;
  txn_date: string;
  direction: string;
}

const sig = (code: string, qty: number, date: string, dir: string) => `${code}|${Number(qty).toFixed(4)}|${date}|${dir}`;

async function applyMovements(
  tx: Queryable,
  cfg: CategorySheetConfig,
  tab: { tab: string; slug: string; txnType: string; kind: 'MOVEMENT' | 'ADJUSTMENT' },
  parse: MovementParse,
  itemIdByCode: Map<string, number>,
  report: TabSyncReport,
  result: CategorySyncResult,
  opts: SyncOptions,
): Promise<void> {
  const category = cfg.category;
  const existing = await txQuery<ExistingTxn>(
    tx,
    `SELECT id, txn_no, item_id, source_key, source_attr_hash, source_row_index, upper(item_code) AS code_key,
            quantity::float8 AS quantity, txn_date::text AS txn_date, direction
       FROM inventory_transactions
      WHERE category = $1 AND source_tab = $2 AND origin = 'SHEET' AND status = 'POSTED'`,
    [category, tab.tab],
  );

  const byKey = new Map<string, ExistingTxn>();
  const legacyBySig = new Map<string, ExistingTxn[]>();
  for (const e of existing) {
    if (e.source_key) byKey.set(e.source_key, e);
    else {
      const k = sig(e.code_key, e.quantity, e.txn_date, e.direction);
      const list = legacyBySig.get(k) ?? [];
      list.push(e);
      legacyBySig.set(k, list);
    }
  }

  const matched = new Set<string>();
  const inserts: MovementRecord[] = [];
  const refresh: Array<{ id: string; r: MovementRecord }> = [];
  let attrChanged = 0;
  for (const r of parse.records) {
    const hit = byKey.get(r.key);
    if (hit) {
      matched.add(hit.id);
      const link = itemIdByCode.get(r.codeKey) ?? null;
      const linkChanged = link !== (hit.item_id === null ? null : Number(hit.item_id));
      if (hit.source_attr_hash !== r.attrHash) attrChanged += 1;
      // Only rows whose stored copy differs are rewritten (PGlite has no autovacuum).
      if (hit.source_attr_hash !== r.attrHash || hit.source_row_index !== r.rowNumber || linkChanged) refresh.push({ id: hit.id, r });
      continue;
    }
    // Rows imported before content identity existed: adopt the same movement
    // (same item, quantity, date and direction) instead of reversing and re-adding it.
    const list = legacyBySig.get(sig(r.codeKey, r.qty, r.dateIso, r.direction));
    if (list && list.length > 0) {
      let best = 0;
      for (let i = 1; i < list.length; i += 1) {
        if (Math.abs((list[i].source_row_index ?? 0) - r.rowNumber) < Math.abs((list[best].source_row_index ?? 0) - r.rowNumber)) best = i;
      }
      const e = list.splice(best, 1)[0];
      matched.add(e.id);
      refresh.push({ id: e.id, r });
      continue;
    }
    inserts.push(r);
  }
  const toReverse = existing.filter((e) => !matched.has(e.id));

  report.validRows = parse.records.length;
  if (!opts.applyLargeChanges && toReverse.length > 50 && toReverse.length > existing.length * 0.2) {
    report.status = 'BLOCKED';
    report.message =
      `${toReverse.length} of the ${existing.length} movements imported from this tab are no longer in the sheet as they were. ` +
      'Nothing was changed for this tab — check that the sheet was not cleared or re-sorted by mistake. ' +
      'An administrator can re-run with "apply large changes" once the sheet is confirmed.';
    report.unchanged = existing.length;
    return;
  }

  // New txn numbers: content-derived, made unique against every number ever used for this tab.
  const used = new Set(
    (await txQuery<{ txn_no: string }>(tx, `SELECT txn_no FROM inventory_transactions WHERE txn_no LIKE $1`, [`GS-${category}-${tab.slug}-%`]))
      .map((x) => x.txn_no),
  );
  const txnNoFor = (r: MovementRecord) => {
    const [hash, n] = r.key.split(':');
    const base = `GS-${category}-${tab.slug}-${hash.slice(0, 10).toUpperCase()}-${n}`;
    let candidate = base;
    for (let v = 2; used.has(candidate); v += 1) candidate = `${base}-V${v}`;
    used.add(candidate);
    return candidate;
  };
  const notesFor = (r: MovementRecord) =>
    [
      r.supplier && `Supplier: ${r.supplier}`,
      r.po && `PO: ${r.po}`,
      r.refDoc && r.refDoc !== r.docNo && `Ref: ${r.refDoc}`,
      r.type && `Type: ${r.type}`,
      r.description && r.description !== r.code && r.description,
      r.note,
    ].filter(Boolean).join(' | ') || null;
  const rowFor = (r: MovementRecord) => ({
    item_id: itemIdByCode.get(r.codeKey) ?? null,
    item_code: r.code,
    direction: r.direction,
    quantity: r.qty,
    weight_kg: r.weightKg ?? (category === 'RM' && tab.kind === 'MOVEMENT' ? r.qty : null),
    uom: r.uom || cfg.stock.defaultUom,
    rate: r.rate,
    amount: r.amount,
    ref_no: r.docNo || r.refDoc || r.po || null,
    from_loc: r.fromLocation,
    to_loc: r.toLocation,
    dept: r.dept || null,
    row_no: r.rowNumber,
    notes: notesFor(r),
    txn_date: r.dateIso,
    source_key: r.key,
    attr_hash: r.attrHash,
    month: r.month || null,
  });

  await jsonBatch(
    tx,
    `INSERT INTO inventory_transactions (
       txn_no, category, item_id, item_code, txn_type, direction, quantity, weight_kg, uom, rate, amount,
       balance_qty_after, balance_weight_after, reference_doc_type, reference_doc_no,
       from_location, to_location, department, source_spreadsheet_id, source_tab, source_row_index,
       status, notes, created_by_name, txn_date, origin, source_key, source_attr_hash, source_month, source_seen_at)
     SELECT v.txn_no, $2, v.item_id, v.item_code, $3, v.direction, v.quantity, v.weight_kg, v.uom, v.rate, v.amount,
            0, v.weight_kg, $3, v.ref_no, v.from_loc, v.to_loc, v.dept, $4, $5, v.row_no,
            'POSTED', v.notes, 'Google Sheet Sync', v.txn_date, 'SHEET', v.source_key, v.attr_hash, v.month, now()
       FROM jsonb_to_recordset($1::jsonb) AS v(
            txn_no text, item_id bigint, item_code text, direction text, quantity numeric, weight_kg numeric,
            uom text, rate numeric, amount numeric, ref_no text, from_loc text, to_loc text, dept text,
            row_no int, notes text, txn_date date, source_key text, attr_hash text, month text)`,
    inserts.map((r) => ({ txn_no: txnNoFor(r), ...rowFor(r) })),
    [category, tab.txnType, cfg.spreadsheetId, tab.tab],
  );

  await jsonBatch(
    tx,
    `UPDATE inventory_transactions t
        SET item_id = v.item_id, weight_kg = v.weight_kg, uom = v.uom, rate = v.rate, amount = v.amount,
            reference_doc_no = v.ref_no, from_location = v.from_loc, to_location = v.to_loc, department = v.dept,
            source_row_index = v.row_no, notes = v.notes, source_key = v.source_key,
            source_attr_hash = v.attr_hash, source_month = v.month, source_seen_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(
            id bigint, item_id bigint, weight_kg numeric, uom text, rate numeric, amount numeric, ref_no text,
            from_loc text, to_loc text, dept text, row_no int, notes text, source_key text, attr_hash text, month text)
      WHERE t.id = v.id`,
    refresh.map(({ id, r }) => {
      const x = rowFor(r);
      return {
        id: Number(id), item_id: x.item_id, weight_kg: x.weight_kg, uom: x.uom, rate: x.rate, amount: x.amount,
        ref_no: x.ref_no, from_loc: x.from_loc, to_loc: x.to_loc, dept: x.dept, row_no: x.row_no, notes: x.notes,
        source_key: x.source_key, attr_hash: x.attr_hash, month: x.month,
      };
    }),
  );

  // Reasons for each reversal, from what the sheet row says now.
  const whyNotCounted = new Map<number, string>();
  for (const q of parse.quarantine) whyNotCounted.set(q.rowNumber, q.reason);
  const recordAtRow = new Map(parse.records.map((r) => [r.rowNumber, r]));
  const reasonFor = (e: ExistingTxn): string => {
    if (e.source_key) return `No longer in the sheet as imported (row deleted, or its date, item, quantity or reference changed) — sync ${result.runId}.`;
    const why = e.source_row_index !== null ? whyNotCounted.get(e.source_row_index) : undefined;
    if (why) return `Not counted by the sheet: ${why} (sync ${result.runId}).`;
    const now = e.source_row_index !== null ? recordAtRow.get(e.source_row_index) : undefined;
    if (now && now.codeKey === e.code_key) {
      return `Sheet row ${e.source_row_index} now counts ${now.qty} on ${now.dateIso} (imported earlier as ${e.quantity} on ${e.txn_date}); re-imported from the sheet's counted figures (sync ${result.runId}).`;
    }
    return `Not found in the sheet any more (row deleted, moved or edited) — sync ${result.runId}.`;
  };
  await jsonBatch(
    tx,
    `UPDATE inventory_transactions t
        SET status = 'REVERSED', reversed_at = now(), reversal_reason = v.reason
       FROM jsonb_to_recordset($1::jsonb) AS v(id bigint, reason text)
      WHERE t.id = v.id AND t.status = 'POSTED'`,
    toReverse.map((e) => ({ id: Number(e.id), reason: reasonFor(e) })),
  );

  report.inserted = inserts.length;
  report.updated = attrChanged;
  report.unchanged = matched.size - attrChanged;
  report.reversed = toReverse.length;
  result.transactionsImported += inserts.length;
}

/* ── Quarantine ─────────────────────────────────────────────────────────────── */

async function applyQuarantine(
  tx: Queryable,
  category: InventoryCategory,
  tabs: string[],
  candidates: QuarantineCandidate[],
  runId: string,
): Promise<number> {
  const ignored = new Set(
    (await txQuery<{ source_key: string }>(
      tx,
      `SELECT source_key FROM inventory_quarantine WHERE category = $1 AND resolution_status = 'IGNORED' AND source_key IS NOT NULL`,
      [category],
    )).map((r) => r.source_key),
  );
  const open = candidates.filter((c) => !ignored.has(c.key));
  await jsonBatch(
    tx,
    `INSERT INTO inventory_quarantine
       (category, source_tab, source_row_index, raw_data, quarantine_reason, source_key, reason_code, last_seen_at)
     SELECT $2, v.tab, v.row_no, v.raw, v.reason, v.source_key, v.code, now()
       FROM jsonb_to_recordset($1::jsonb) AS v(tab text, row_no int, raw jsonb, reason text, source_key text, code text)
     ON CONFLICT (category, source_tab, source_key) WHERE source_key IS NOT NULL AND resolution_status = 'PENDING'
     DO UPDATE SET last_seen_at = now(), source_row_index = EXCLUDED.source_row_index,
                   raw_data = EXCLUDED.raw_data, quarantine_reason = EXCLUDED.quarantine_reason`,
    open.map((c) => ({ tab: c.tab, row_no: c.rowNumber, raw: c.raw, reason: c.reason, source_key: c.key, code: c.code })),
    [category],
  );
  // Close what the sheet no longer shows (corrected rows, and entries from before content keys).
  await tx.query(
    `UPDATE inventory_quarantine
        SET resolution_status = 'RESOLVED', resolved_at = now(), resolution_note = $4
      WHERE category = $1 AND resolution_status = 'PENDING' AND source_tab = ANY($2::text[])
        AND (source_key IS NULL OR NOT (source_key = ANY($3::text[])))`,
    [category, tabs, open.map((c) => c.key), `No longer present in the sheet at sync ${runId}.`],
  );
  return open.length;
}

/* ── Per-item proof and Purchase stock ──────────────────────────────────────── */

async function reconcileCategory(
  tx: Queryable,
  cfg: CategorySheetConfig,
  stock: StockParse,
  candidates: QuarantineCandidate[],
  result: CategorySyncResult,
): Promise<void> {
  const category = cfg.category;
  const totals = new Map<string, { inward: number; outward: number; adjustment: number }>();
  for (const t of await txQuery<{ code: string; inward: number; outward: number; adjustment: number }>(
    tx,
    `SELECT upper(item_code) AS code,
            COALESCE(SUM(quantity) FILTER (WHERE direction = 'IN'  AND txn_type <> 'SHEET_ADJUSTMENT'), 0)::float8 AS inward,
            COALESCE(SUM(quantity) FILTER (WHERE direction = 'OUT' AND txn_type <> 'SHEET_ADJUSTMENT'), 0)::float8 AS outward,
            (COALESCE(SUM(quantity) FILTER (WHERE direction = 'IN'  AND txn_type = 'SHEET_ADJUSTMENT'), 0)
           - COALESCE(SUM(quantity) FILTER (WHERE direction = 'OUT' AND txn_type = 'SHEET_ADJUSTMENT'), 0))::float8 AS adjustment
       FROM inventory_transactions
      WHERE category = $1 AND origin = 'SHEET' AND status = 'POSTED'
      GROUP BY upper(item_code)`,
    [category],
  )) totals.set(t.code, { inward: Number(t.inward), outward: Number(t.outward), adjustment: Number(t.adjustment) });

  const erpByCode = new Map<string, number>();
  for (const r of await txQuery<{ code: string; n: number }>(
    tx,
    `SELECT upper(item_code) AS code, COUNT(*)::int AS n FROM inventory_transactions
      WHERE category = $1 AND origin = 'ERP' AND status = 'POSTED' GROUP BY upper(item_code)`,
    [category],
  )) erpByCode.set(r.code, r.n);

  const notCounted = new Map<string, Map<string, number>>();
  for (const c of candidates) {
    if (!c.itemCode) continue;
    const k = c.itemCode.toUpperCase();
    const m = notCounted.get(k) ?? new Map<string, number>();
    m.set(c.code, (m.get(c.code) ?? 0) + 1);
    notCounted.set(k, m);
  }

  const stockByCode = new Map(stock.records.map((s) => [s.codeKey, s]));
  const rec = reconcileItems(stock.records, totals);
  const updates = rec.map((r) => {
    const s = stockByCode.get(r.codeKey)!;
    let note: string | null = null;
    if (!r.matched) {
      const parts = [
        `Sheet shows ${r.sheetLive}; opening ${r.opening} + inward ${r.inward} − outward ${r.outward} + adjustments ${r.adjustment} = ${r.computed} (difference ${r.difference}).`,
      ];
      const nc = notCounted.get(r.codeKey);
      if (nc) parts.push(`Rows not counted for this item: ${[...nc].map(([k, n]) => `${n} × ${k.replace(/_/g, ' ').toLowerCase()}`).join(', ')}.`);
      if (Math.abs(s.adjustment - r.adjustment) > 0.001) parts.push(`The sheet's adjustment column shows ${s.adjustment}.`);
      note = parts.join(' ');
    }
    const erp = erpByCode.get(r.codeKey);
    if (erp) note = `${note ? `${note} ` : ''}${erp} movement(s) entered in the ERP are not part of the sheet figure.`;
    return { code: r.codeKey, computed: r.computed, status: r.matched ? 'MATCHED' : 'MISMATCH', note };
  });
  await jsonBatch(
    tx,
    `UPDATE inventory_items ii
        SET computed_stock_qty = v.computed, recon_status = v.status, recon_note = v.note, recon_checked_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(code text, computed numeric, status text, note text)
      WHERE ii.category = $2 AND upper(ii.item_code) = v.code AND ii.source_row_index IS NOT NULL
        AND (ii.computed_stock_qty IS DISTINCT FROM v.computed OR ii.recon_status IS DISTINCT FROM v.status
             OR ii.recon_note IS DISTINCT FROM v.note)`,
    updates, [category],
  );
  await tx.query(
    `UPDATE inventory_items SET recon_status = 'ERP_ONLY', recon_note = 'Not in the Google Sheet — stock recorded in the ERP only.',
            recon_checked_at = now()
      WHERE category = $1 AND source_tab IS NULL AND recon_status IS DISTINCT FROM 'ERP_ONLY'`,
    [category],
  );

  const mismatched = rec.filter((r) => !r.matched);
  result.reconciliation = {
    checked: rec.length,
    matched: rec.length - mismatched.length,
    mismatched: mismatched.length,
    mismatches: mismatched.slice(0, 50).map((r) => ({
      itemCode: stockByCode.get(r.codeKey)!.code,
      sheetLive: r.sheetLive, computed: r.computed, difference: r.difference,
      note: updates.find((u) => u.code === r.codeKey)?.note ?? '',
    })),
  };

  // Running balance per item through the sheet movements (by date; inward before outward on a day).
  await tx.query(
    `UPDATE inventory_transactions t
        SET balance_qty_after = x.bal
       FROM (
         SELECT t2.id,
                COALESCE(o.opening, 0) + SUM(CASE WHEN t2.direction = 'IN' THEN t2.quantity ELSE -t2.quantity END)
                  OVER (PARTITION BY upper(t2.item_code)
                        ORDER BY t2.txn_date, CASE WHEN t2.direction = 'IN' THEN 0 ELSE 1 END, t2.source_row_index NULLS LAST, t2.id) AS bal
           FROM inventory_transactions t2
           LEFT JOIN (SELECT upper(item_code) AS code, MAX(opening_stock_qty) AS opening
                        FROM inventory_items WHERE category = $1 GROUP BY upper(item_code)) o
                  ON o.code = upper(t2.item_code)
          WHERE t2.category = $1 AND t2.status = 'POSTED' AND t2.origin = 'SHEET'
       ) x
      WHERE t.id = x.id AND t.balance_qty_after IS DISTINCT FROM x.bal`,
    [category],
  );
}

/**
 * items.live_stock_qty follows the Google Sheet: the sum of the code's live stock
 * across every category sheet that lists it. Each change is ledgered as SHEET_SYNC
 * (difference from the current figure), so the stock ledger explains it. A
 * negative sheet total is held at zero (the Purchase stock cannot be negative)
 * and reported.
 */
async function alignPurchaseStock(
  tx: Queryable,
  cfg: CategorySheetConfig,
  stock: StockParse,
  result: CategorySyncResult,
  opts: SyncOptions,
): Promise<void> {
  const codes = stock.records.map((s) => s.codeKey);
  if (codes.length === 0) return;
  const rows = await txQuery<{ id: string; current: number; sheet_qty: number; cats: number; cat: string; inventory_category: string; uom_id: string | null; item_code: string }>(
    tx,
    `WITH sheet AS (
       SELECT upper(item_code) AS code, SUM(live_stock_qty) AS qty,
              COUNT(DISTINCT category)::int AS cats, MIN(category) AS cat
         FROM inventory_items
        WHERE deleted_at IS NULL AND source_tab IS NOT NULL AND source_row_index IS NOT NULL
        GROUP BY upper(item_code))
     SELECT i.id, i.item_code, i.live_stock_qty::float8 AS current, s.qty::float8 AS sheet_qty, s.cats, s.cat,
            i.inventory_category, i.uom_id
       FROM items i JOIN sheet s ON s.code = upper(i.item_code)
      WHERE i.deleted_at IS NULL AND upper(i.item_code) = ANY($1::text[])`,
    [codes],
  );
  const changes: Array<{ item_id: number; target: number; delta: number; uom_id: number | null }> = [];
  const categoryChanges: number[] = [];
  for (const r of rows) {
    const sheetQty = Math.round(Number(r.sheet_qty) * 10000) / 10000;
    const target = Math.max(0, sheetQty);
    if (sheetQty < 0) result.purchaseStock.negativeHeldAtZero.push(r.item_code);
    const delta = Math.round((target - Number(r.current)) * 10000) / 10000;
    if (Math.abs(delta) >= 0.0001) changes.push({ item_id: Number(r.id), target, delta, uom_id: r.uom_id ? Number(r.uom_id) : null });
    if (r.cats === 1 && r.cat !== r.inventory_category) categoryChanges.push(Number(r.id));
  }
  await jsonBatch(
    tx,
    `UPDATE items i SET live_stock_qty = v.target, updated_at = now()
       FROM jsonb_to_recordset($1::jsonb) AS v(item_id bigint, target numeric) WHERE i.id = v.item_id`,
    changes,
  );
  await jsonBatch(
    tx,
    `INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_no, inward_qty, outward_qty, balance_qty,
                               uom_id, location, txn_date, created_by)
     SELECT v.item_id, 'SHEET_SYNC', 'INVENTORY_SYNC', $2, GREATEST(v.delta, 0), GREATEST(-v.delta, 0), v.target,
            v.uom_id, $3, CURRENT_DATE, $4
       FROM jsonb_to_recordset($1::jsonb) AS v(item_id bigint, delta numeric, target numeric, uom_id bigint)`,
    changes, [result.runId, `${cfg.category} sheet: ${cfg.stock.tab}`, opts.userId ?? null],
  );
  if (categoryChanges.length > 0) {
    await tx.query(
      `UPDATE items SET inventory_category = $2, updated_at = now() WHERE id = ANY($1::bigint[])`,
      [categoryChanges, cfg.category],
    );
  }
  result.purchaseStock.aligned = changes.length;
  result.purchaseStock.categoryChanged = categoryChanges.length;
}

/* ── Checkpoints ────────────────────────────────────────────────────────────── */

async function writeCheckpoints(
  tx: Queryable,
  cfg: CategorySheetConfig,
  result: CategorySyncResult,
  opts: SyncOptions,
): Promise<void> {
  const rows: Array<{ tab: string; read: number; valid: number; quarantined: number; status: string; error: string | null; report: unknown }> =
    result.tabs.map((t) => ({
      tab: t.tab,
      read: t.sourceRows,
      valid: t.validRows,
      quarantined: t.quarantined,
      status: t.status,
      error: t.message ?? null,
      report: t,
    }));
  rows.push({
    tab: '(all tabs)',
    read: result.totalRowsRead,
    valid: result.validRecordsImported,
    quarantined: result.quarantinedRecords,
    status: result.status,
    error: result.errorMessage ?? null,
    report: {
      items: result.items,
      reconciliation: { ...result.reconciliation, mismatches: result.reconciliation.mismatches.slice(0, 20) },
      purchaseStock: result.purchaseStock,
    },
  });
  await jsonBatch(
    tx,
    `INSERT INTO inventory_sync_checkpoints (category, spreadsheet_id, tab_name, total_rows_read, valid_records_imported,
        quarantined_records, status, error_message, sync_mode, sync_duration_ms, run_id, triggered_by, report)
     SELECT $2, $3, v.tab, v.read, v.valid, v.quarantined, v.status, v.error, 'MANUAL', $4, $5, $6, v.report
       FROM jsonb_to_recordset($1::jsonb) AS v(tab text, read int, valid int, quarantined int, status text, error text, report jsonb)`,
    rows, [cfg.category, cfg.spreadsheetId, Date.now() - Date.parse(result.startedAt), result.runId, opts.userId ?? null],
  );
}

/* ── Public entry points ────────────────────────────────────────────────────── */

function emptyResult(cfg: CategorySheetConfig, runId: string, dryRun: boolean): CategorySyncResult {
  return {
    category: cfg.category, spreadsheetId: cfg.spreadsheetId, runId, dryRun,
    status: 'SUCCESS', startedAt: new Date().toISOString(), durationMs: 0, tabs: [],
    items: { inSheet: 0, inserted: 0, updated: 0, noLongerInSheet: 0, negativeInSheet: 0, linkedToPurchaseItem: 0 },
    reconciliation: { checked: 0, matched: 0, mismatched: 0, mismatches: [] },
    purchaseStock: { aligned: 0, negativeHeldAtZero: [], categoryChanged: 0 },
    totalRowsRead: 0, validRecordsImported: 0, transactionsImported: 0, quarantinedRecords: 0,
  };
}

function tabReport(kind: TabSyncReport['kind'], tab: string, range: string, firstDataRow: number): TabSyncReport {
  return {
    tab, kind, range, firstDataRow, sourceRows: 0, blankRows: 0, validRows: 0, excluded: {}, quarantined: 0,
    inserted: 0, updated: 0, unchanged: 0, reversed: 0, firstRecord: null, lastRecord: null, status: 'SUCCESS',
  };
}

async function runCategory(category: InventoryCategory, opts: SyncOptions): Promise<CategorySyncResult> {
  const cfg = INVENTORY_SHEETS[category];
  const result = emptyResult(cfg, opts.runId ?? newRunId(), !!opts.dryRun);
  const started = Date.now();

  let read: CategoryRead;
  try {
    read = await (opts.reader ?? readCategory)(cfg);
  } catch (err) {
    result.status = 'FAILED';
    result.errorMessage = `Could not read the ${category} Google Sheet: ${err instanceof Error ? err.message : String(err)}. Nothing was changed; try again.`;
    result.durationMs = Date.now() - started;
    logger.error(`Inventory sync ${result.runId} ${category}: ${result.errorMessage}`);
    if (!opts.dryRun) {
      await query(
        `INSERT INTO inventory_sync_checkpoints (category, spreadsheet_id, tab_name, status, error_message, sync_mode,
                                                 sync_duration_ms, run_id, triggered_by)
         VALUES ($1, $2, '(all tabs)', 'FAILED', $3, 'MANUAL', $4, $5, $6)`,
        [category, cfg.spreadsheetId, result.errorMessage, result.durationMs, result.runId, opts.userId ?? null],
      ).catch(() => undefined);
    }
    return result;
  }

  // Classify (pure).
  const stock = parseStockTab(cfg.stock, read.stockMain, read.stockOpening, read.stockAdjustment);
  const stockCodes = new Set(stock.records.map((s) => s.codeKey));
  const countedMonths = new Set(financialYearMonths());
  const movementParses = cfg.movements.map((m, i) => parseMovementTab(m, read.movements[i], { countedMonths, stockCodes }));
  const adjustmentParse = parseAdjustmentTab(read.adjustments, { stockCodes });
  const allCandidates = [...stock.quarantine, ...movementParses.flatMap((p) => p.quarantine), ...adjustmentParse.quarantine];

  const stockReport = tabReport('STOCK', cfg.stock.tab, read.ranges[0], cfg.stock.headerRow + 1);
  Object.assign(stockReport, {
    sourceRows: stock.sourceRows, blankRows: stock.blankRows, validRows: stock.records.length,
    quarantined: stock.quarantine.length, duplicateRows: stock.duplicateRows, duplicateCodes: stock.duplicateCodes.slice(0, 50),
    excluded: stock.quarantine.reduce<Partial<Record<ExclusionCode, number>>>((m, q) => ({ ...m, [q.code]: (m[q.code] ?? 0) + 1 }), {}),
    firstRecord: stock.records[0] ? `row ${stock.records[0].rowNumber}: ${stock.records[0].code} ${stock.records[0].liveQty}` : null,
    lastRecord: stock.records.length ? `row ${stock.records[stock.records.length - 1].rowNumber}: ${stock.records[stock.records.length - 1].code} ${stock.records[stock.records.length - 1].liveQty}` : null,
  });
  const movementReports = cfg.movements.map((m, i) => {
    const p = movementParses[i];
    const r = tabReport('MOVEMENT', m.tab, read.ranges[3 + i], m.firstRow);
    Object.assign(r, {
      sourceRows: p.sourceRows, blankRows: p.blankRows, validRows: p.records.length,
      excluded: p.excluded, quarantined: p.quarantine.length,
      warnings: Object.keys(p.warnings).length ? p.warnings : undefined,
      firstRecord: describe(p.records[0]), lastRecord: describe(p.records[p.records.length - 1]),
    });
    return r;
  });
  const adjustmentReport = tabReport('ADJUSTMENT', ADJUSTMENT_TAB.tab, read.ranges[read.ranges.length - 1], ADJUSTMENT_TAB.firstRow);
  Object.assign(adjustmentReport, {
    sourceRows: adjustmentParse.sourceRows, blankRows: adjustmentParse.blankRows, validRows: adjustmentParse.records.length,
    excluded: adjustmentParse.excluded, quarantined: adjustmentParse.quarantine.length,
    firstRecord: describe(adjustmentParse.records[0]), lastRecord: describe(adjustmentParse.records[adjustmentParse.records.length - 1]),
  });
  result.tabs = [stockReport, ...movementReports, adjustmentReport];
  result.totalRowsRead = result.tabs.reduce((a, t) => a + t.sourceRows, 0);

  const apply = async (tx: Queryable) => {
    const itemIdByCode = new Map<string, number>();
    for (const r of await txQuery<{ id: string; code: string }>(
      tx, `SELECT id, upper(item_code) AS code FROM items WHERE deleted_at IS NULL`,
    )) itemIdByCode.set(r.code, Number(r.id));

    const stockApplied = await applyStock(tx, cfg, stock, itemIdByCode, result, stockReport, opts);
    if (stockApplied) {
      for (let i = 0; i < cfg.movements.length; i += 1) {
        const m = cfg.movements[i];
        await applyMovements(tx, cfg, { tab: m.tab, slug: m.slug, txnType: m.txnType, kind: 'MOVEMENT' },
          movementParses[i], itemIdByCode, movementReports[i], result, opts);
      }
      await applyMovements(tx, cfg, { tab: ADJUSTMENT_TAB.tab, slug: ADJUSTMENT_TAB.slug, txnType: ADJUSTMENT_TAB.txnType, kind: 'ADJUSTMENT' },
        adjustmentParse, itemIdByCode, adjustmentReport, result, opts);
      result.quarantinedRecords = await applyQuarantine(
        tx, category, result.tabs.map((t) => t.tab), allCandidates, result.runId,
      );
      await reconcileCategory(tx, cfg, stock, allCandidates, result);
      await alignPurchaseStock(tx, cfg, stock, result, opts);
    }
    result.validRecordsImported = result.tabs.reduce((a, t) => a + (t.kind === 'STOCK' ? 0 : t.validRows), 0);
    result.status = result.tabs.some((t) => t.status === 'BLOCKED') ? 'PARTIAL' : 'SUCCESS';
    if (result.status === 'PARTIAL') {
      result.errorMessage = result.tabs.filter((t) => t.status === 'BLOCKED').map((t) => `${t.tab.trim()}: ${t.message}`).join(' ');
    }
    result.durationMs = Date.now() - started;
    if (opts.dryRun) throw new DryRunRollback(result);
    await writeCheckpoints(tx, cfg, result, opts);
  };

  try {
    await withTransaction(apply);
  } catch (err) {
    if (err instanceof DryRunRollback) return err.result;
    result.status = 'FAILED';
    result.errorMessage = `The ${category} update could not be saved: ${err instanceof Error ? err.message : String(err)}. Nothing was changed; try again.`;
    logger.error(`Inventory sync ${result.runId} ${category} failed`, { error: result.errorMessage });
    await query(
      `INSERT INTO inventory_sync_checkpoints (category, spreadsheet_id, tab_name, status, error_message, sync_mode,
                                               sync_duration_ms, run_id, triggered_by)
       VALUES ($1, $2, '(all tabs)', 'FAILED', $3, 'MANUAL', $4, $5, $6)`,
      [category, cfg.spreadsheetId, result.errorMessage, Date.now() - started, result.runId, opts.userId ?? null],
    ).catch(() => undefined);
  }
  result.durationMs = Date.now() - started;
  logger.info(
    `Inventory sync ${result.runId} ${category}${opts.dryRun ? ' (dry run)' : ''}: ${result.status}; ` +
      result.tabs.map((t) => `${t.tab.trim()} +${t.inserted}/~${t.updated}/-${t.reversed}${t.status === 'BLOCKED' ? ' BLOCKED' : ''}`).join(', ') +
      `; items matched ${result.reconciliation.matched}/${result.reconciliation.checked}; ${result.durationMs} ms`,
  );
  return result;
}

/**
 * PGlite runs no autovacuum: every row a sync rewrites leaves a dead copy behind
 * (the old engine's rewrite-everything runs grew `items` to 95 MB for 17k rows).
 * A plain VACUUM after an applied run lets that space be reused. Best-effort.
 */
const VACUUM_AFTER_SYNC = [
  'inventory_transactions', 'inventory_items', 'inventory_quarantine',
  'inventory_sync_checkpoints', 'items', 'stock_ledger',
];
async function vacuumAfterSync(): Promise<void> {
  for (const table of VACUUM_AFTER_SYNC) {
    await query(`VACUUM (ANALYZE) ${table}`).catch((err) =>
      logger.warn(`Inventory sync: VACUUM ${table} skipped`, { error: err instanceof Error ? err.message : String(err) }));
  }
}

async function exclusive<T>(scope: string, runId: string, fn: () => Promise<T>, dryRun = false): Promise<T> {
  if (activeRun) {
    const err = new Error(`An inventory sync is already running (${activeRun.scope}, started ${activeRun.startedAt}).`);
    (err as Error & { code?: string }).code = 'SYNC_RUNNING';
    throw err;
  }
  activeRun = { runId, startedAt: new Date().toISOString(), scope };
  try {
    const result = await fn();
    if (!dryRun) await vacuumAfterSync();
    return result;
  } finally {
    activeRun = null;
  }
}

export async function syncCategoryFromSheet(category: InventoryCategory, opts: SyncOptions = {}): Promise<CategorySyncResult> {
  const runId = opts.runId ?? newRunId();
  return exclusive(category, runId, () => runCategory(category, { ...opts, runId }), !!opts.dryRun);
}

/** All five categories, one after another, under one run id. */
export async function syncAllInventoryCategories(opts: SyncOptions = {}): Promise<CategorySyncResult[]> {
  const runId = opts.runId ?? newRunId();
  return exclusive('all categories', runId, async () => {
    const out: CategorySyncResult[] = [];
    for (const category of INVENTORY_CATEGORIES) out.push(await runCategory(category, { ...opts, runId }));
    return out;
  }, !!opts.dryRun);
}

/** Column index of a stock tab's opening column — exported for tests and reports. */
export const stockColumnIndex = colIndex;
export const REPORT_ONLY_EXCLUSIONS = REPORT_ONLY;
