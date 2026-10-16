#!/usr/bin/env node
/**
 * Evidence for the one-time stock-ledger alignment (2026-10-16 audit, SLR-8).
 * Read-only: it writes its output files and changes nothing else — no database,
 * no sheet.
 *
 * Why: until 2026-10-16 the inventory sync wrote the Google Sheet figures into
 * items.live_stock_qty with no ledger row, so on the 07:15 UTC snapshot 2,769 items'
 * stock ledgers no longer explained their stock. For every such item this script
 * collects what the sheets themselves record — the opening cell, receipts the ERP
 * never received as a GRN, production inward, store issues the ERP never posted,
 * stock-adjustment rows — and the item's existing SHEET_SYNC entries (measured from
 * that un-ledgered starting figure, so they are reversed). Every quantity is an
 * existing record; the gap itself is never used as a figure. An item is proposed
 * only when those records close its gap EXACTLY, and the server checks that again
 * before it writes anything.
 *
 * Usage (from backend/):
 *   node scripts/compute-stock-alignment.mjs --backup <backup.json>
 *        [--sheets backup | live | <reads.json>] [--save-sheets <reads.json>] [--out <dir>]
 *
 *   --backup <file>      an app backup (Admin > Backup, or npm run db:backup); a verified
 *                        backup holds every table this needs.
 *   --sheets backup      (default) the inventory sync's own reading of the sheets, stored
 *                        in the backup (inventory_items / inventory_transactions). This
 *                        is the reading items.live_stock_qty was last aligned to.
 *   --sheets live        read the five inventory spreadsheets now, read-only, with the
 *                        service account named by GOOGLE_APPLICATION_CREDENTIALS (the
 *                        path and the key are never printed). Rows are classified with
 *                        the sync's own rules (src/modules/inventory/sheet-model.ts).
 *                        Run an inventory sync and take the backup right before, or
 *                        items will not close against items.live_stock_qty.
 *   --sheets <file>      re-use reads saved earlier with --save-sheets: the same run again.
 *   --save-sheets <file> with --sheets live, also save the raw reads to <file>.
 *   --out <dir>          output folder (default ./stock-alignment-out).
 *
 * Output:
 *   stock-alignment-entries.json  the request body for POST /api/v1/admin/data-management/
 *                                 repair/stock-alignment — run it as a dry run first;
 *   stock-alignment-items.csv     every item whose ledger does not explain its stock, with
 *                                 its tier and the reason;
 *   stock-alignment-summary.json  the counts printed at the end.
 *
 * Tiers. A: the records close the gap exactly — emitted. B: they would, but the sheet
 * counts the item in another unit than the Item Master; correct items.uom_id, re-run,
 * and the item is then A. C: an owner decision or a correction is needed first
 * (ERP receipts or issues the sheets do not have, a sheet that does not add up, an
 * item already aligned). An ERP document taken back with its supported reversal
 * (same document number, net 0) changed nothing and is left out of the comparison.
 *
 * Procedure: take a verified backup with no inventory sync running, right after a
 * sync; run this with --sheets backup; POST the entries file (dryRun defaults to true);
 * review accepted and refused; POST again with dryRun false, confirm
 * "ALIGN STOCK LEDGER" and expectedHash = the dry run's selectionHash.
 *
 * Checked against the 2026-10-16 07:15 UTC backup (audit A4): A4's Tier A — 2,653 items,
 * 6,545 entries, net +792,890.32 — is reproduced entry for entry, from the backup's own
 * sheet reading and equally from raw reads of the five sheets taken at 07:23 UTC. This
 * script adds 4 items (PTC2, PTC2/0, PTC4, PTC6; 12 entries, net −271): A4 held all 8
 * PTC codes back because the sync added their WIP pieces to their RM kilograms (SLR-4);
 * with the sync counting the Item Master's unit only, these 4 — whose WIP figure is
 * 0 — close exactly from their RM records.
 *
 * Needs Node 22.18 or later: it loads the sync's TypeScript sheet rules directly
 * (on an older Node: node --import tsx scripts/compute-stock-alignment.mjs …).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const CATEGORIES = ['RM', 'FG', 'TRADING', 'WIP', 'GENERAL'];
const READS_FORMAT = 'zolex-inventory-sheet-reads/1';
/** The tab where each spreadsheet records goods received from suppliers — the ERP's GRNs. FG and WIP inward is production. */
const RECEIPT_TYPE = { RM: 'GRN_INWARD', TRADING: 'PURCHASE_INWARD', GENERAL: 'GRN_INWARD' };
/** ERP ledger entries that are store issues; the same issue is also an outward row in the sheet. */
const ISSUE_TYPES = new Set(['REQUISITION_ISSUE', 'DIRECT_ISSUE']);
/** An ERP issue is the same as a sheet issue row of the same quantity at most this many days apart. */
const DATE_TOLERANCE_DAYS = 7;
/** Rows the endpoint posts carry this reference type; an item that has one is never aligned again. */
const ALIGNMENT_REFERENCE_TYPE = 'OPENING_ALIGNMENT';
/** The endpoint's limits on an entry's text (data-management.routes.ts). */
const MAX_REFERENCE = 300;
const MAX_EVIDENCE = 1000;

/** Error text from Google or the file system can quote the key file's path; it is never printed. */
function redact(message) {
  const keyPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  let out = String(message);
  if (keyPath) {
    for (const form of new Set([keyPath, keyPath.replace(/\\/g, '/'), keyPath.replace(/\//g, '\\')])) out = out.split(form).join('<GOOGLE_APPLICATION_CREDENTIALS>');
  }
  return out;
}

function fail(message) {
  console.error(`compute-stock-alignment: ${redact(message)}`);
  process.exit(1);
}

/* ── Arguments ──────────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const out = { sheets: 'backup', out: 'stock-alignment-out' };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) fail(`${flag} needs a value.`);
      i += 1;
      return v;
    };
    if (flag === '--backup') out.backup = value();
    else if (flag === '--sheets') out.sheets = value();
    else if (flag === '--save-sheets') out.saveSheets = value();
    else if (flag === '--out') out.out = value();
    else fail(`unknown argument ${flag}. See the header of this file for usage.`);
  }
  if (!out.backup) fail('--backup <file.json> is required.');
  if (out.saveSheets && out.sheets !== 'live') fail('--save-sheets only applies to --sheets live.');
  return out;
}

const args = parseArgs(process.argv.slice(2));

// The sync's own rules: one definition of the sheets and of "same unit" for the sync and this script.
let sheetModel;
let sameUnit;
try {
  sheetModel = await import(pathToFileURL(path.join(here, '..', 'src', 'modules', 'inventory', 'sheet-model.ts')).href);
  ({ sameUnit } = await import(pathToFileURL(path.join(here, '..', 'src', 'domain', 'uom.ts')).href));
} catch (err) {
  fail(`could not load the sync's sheet rules from backend/src (${err instanceof Error ? err.message : String(err)}). ` +
    'This script needs Node 22.18 or later, which runs TypeScript files directly.');
}
const { INVENTORY_SHEETS, ADJUSTMENT_TAB, FY_START, financialYearMonths, parseStockTab, parseMovementTab, parseAdjustmentTab, rangesFor } = sheetModel;

/* ── Exact quantities: integers in units of 0.0001 (every stored quantity has 4 decimals) ── */

const S = (v) => (v === null || v === undefined || v === '' ? 0 : Math.round(Number(v) * 10000));
const q = (n) => {
  const s = (n / 10000).toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
};
const day = (d) => (d === null || d === undefined ? '' : String(d).slice(0, 10));
const daysApart = (a, b) => Math.abs((Date.parse(a) - Date.parse(b)) / 86400000);
const norm = (s) => (s ?? '').trim().toUpperCase();
const push = (map, key, value) => {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
};
const group = (rows, keyFn) => {
  const m = new Map();
  for (const r of rows) push(m, keyFn(r), r);
  return m;
};
const byId = (a, b) => Number(a.id) - Number(b.id);
const colLetter = (index) => {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
};

/* ── Backup ─────────────────────────────────────────────────────────────────── */

function loadBackup(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    fail(`cannot read the backup ${file}: ${err.message}`);
  }
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    fail(`${file} is not a backup file (not valid JSON).`);
  }
  for (const table of ['items', 'lookups', 'stock_ledger', 'inventory_items', 'inventory_transactions']) {
    if (!Array.isArray(payload?.data?.[table])) {
      fail(`the backup has no ${table} table; take a new backup (any backup since migration 025 holds it).`);
    }
  }
  return {
    file: path.basename(file),
    sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    meta: payload.meta ?? {},
    data: payload.data,
  };
}

/* ── Sheet figures ──────────────────────────────────────────────────────────── *
 * Both sources give the same shape:
 *   stock: CODE → [{ category, tab, row, uom, O (opening), L (live), C (opening + in − out + adj), status }]
 *   moves: "CATEGORY|CODE" → [{ txnType, direction, qty, date, month, ref, row, tab, type }]   */

const typeOf = (notes) => /(?:^| \| )Type: (.*?)(?= \| |$)/.exec(notes ?? '')?.[1] ?? '';

function sheetsFromBackup(data) {
  const stock = new Map();
  for (const r of data.inventory_items) {
    if (r.deleted_at || r.source_tab === null || r.source_row_index === null) continue;
    push(stock, r.item_code.toUpperCase(), {
      category: r.category, tab: r.source_tab, row: Number(r.source_row_index), uom: r.primary_uom ?? '',
      O: S(r.opening_stock_qty), L: S(r.live_stock_qty), C: S(r.computed_stock_qty), status: r.recon_status,
    });
  }
  const moves = new Map();
  for (const t of [...data.inventory_transactions].sort(byId)) {
    if (t.origin !== 'SHEET' || t.status !== 'POSTED') continue;
    push(moves, `${t.category}|${t.item_code.toUpperCase()}`, {
      txnType: t.txn_type, direction: t.direction, qty: S(t.quantity), date: day(t.txn_date), month: t.source_month,
      ref: t.reference_doc_no, row: t.source_row_index === null ? null : Number(t.source_row_index), tab: t.source_tab, type: typeOf(t.notes),
    });
  }
  return { source: 'backup (inventory sync reading)', readAt: null, stock, moves };
}

async function readSheetsLive() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    fail('set GOOGLE_APPLICATION_CREDENTIALS to the service-account key file to read the sheets (it is used, never printed).');
  }
  const { google } = await import('googleapis');
  // Read-only scope: this script cannot change a sheet.
  const auth = new google.auth.GoogleAuth({ scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'] });
  const api = google.sheets({ version: 'v4', auth });
  const reads = { format: READS_FORMAT, readAt: new Date().toISOString(), categories: {} };
  for (const category of CATEGORIES) {
    const cfg = INVENTORY_SHEETS[category];
    const ranges = rangesFor(cfg);
    let res;
    for (let attempt = 1; ; attempt += 1) {
      try {
        // The same request as the sync: raw numbers, dates as the sheet shows them.
        res = await api.spreadsheets.values.batchGet({
          spreadsheetId: cfg.spreadsheetId, ranges,
          valueRenderOption: 'UNFORMATTED_VALUE', dateTimeRenderOption: 'FORMATTED_STRING',
        });
        break;
      } catch (err) {
        const status = err?.code ?? err?.status;
        const transient = typeof status !== 'number' || status === 429 || status >= 500;
        if (!transient || attempt === 3) fail(`could not read the ${category} spreadsheet: ${err instanceof Error ? err.message : String(err)}`);
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
    const valueRanges = res.data.valueRanges ?? [];
    if (valueRanges.length !== ranges.length) fail(`Google returned ${valueRanges.length} of ${ranges.length} ranges for ${category}.`);
    reads.categories[category] = { spreadsheetId: cfg.spreadsheetId, ranges, values: valueRanges.map((v) => v.values ?? []) };
    console.log(`read ${category}: ${ranges.length} ranges`);
  }
  return reads;
}

function loadReads(file) {
  let reads;
  try {
    reads = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    fail(`cannot read the sheet reads ${file}: ${err.message}`);
  }
  if (reads?.format !== READS_FORMAT) fail(`${file} is not a file written by --save-sheets (format ${READS_FORMAT}).`);
  return reads;
}

/** Classifies raw reads exactly as the sync does (runCategory → sheet-model.ts). */
function sheetsFromReads(reads, source) {
  const stock = new Map();
  const moves = new Map();
  const countedMonths = new Set(financialYearMonths());
  // A Month cell holding a date counts by the year the sheet was read in, as in the sync.
  const criterionYear = new Date(reads.readAt).getUTCFullYear();
  for (const category of CATEGORIES) {
    const cfg = INVENTORY_SHEETS[category];
    const c = reads.categories?.[category];
    if (!c) fail(`the sheet reads have no ${category} spreadsheet.`);
    if (c.spreadsheetId !== cfg.spreadsheetId || JSON.stringify(c.ranges) !== JSON.stringify(rangesFor(cfg))) {
      fail(`the saved ${category} reads do not match the current sheet configuration; read the sheets again (--sheets live).`);
    }
    const v = c.values;
    const parsed = parseStockTab(cfg.stock, v[0] ?? [], v[1] ?? [], v[2] ?? []);
    const stockCodes = new Set(parsed.records.map((s) => s.codeKey));
    const rows = [];
    cfg.movements.forEach((m, i) => {
      for (const r of parseMovementTab(m, v[3 + i] ?? [], { countedMonths, stockCodes, criterionYear }).records) {
        rows.push({ codeKey: r.codeKey, txnType: m.txnType, direction: r.direction, qty: S(r.qty), date: r.dateIso, month: r.month,
          ref: r.docNo || r.refDoc || r.po || null, row: r.rowNumber, tab: m.tab, type: r.type });
      }
    });
    for (const r of parseAdjustmentTab(v[3 + cfg.movements.length] ?? [], { stockCodes }).records) {
      rows.push({ codeKey: r.codeKey, txnType: ADJUSTMENT_TAB.txnType, direction: r.direction, qty: S(r.qty), date: r.dateIso, month: null,
        ref: null, row: r.rowNumber, tab: ADJUSTMENT_TAB.tab, type: r.type });
    }
    const computed = new Map();
    for (const r of rows) {
      const { codeKey, ...move } = r;
      push(moves, `${category}|${codeKey}`, move);
      computed.set(codeKey, (computed.get(codeKey) ?? 0) + (r.direction === 'IN' ? r.qty : -r.qty));
    }
    for (const s of parsed.records) {
      const O = S(s.opening);
      const L = S(s.liveQty);
      const C = O + (computed.get(s.codeKey) ?? 0);
      // reconcileItems: under a thousandth of a unit is the sheet's display rounding.
      push(stock, s.codeKey, { category, tab: cfg.stock.tab, row: s.rowNumber, uom: s.uom, O, L, C, status: Math.abs(L - C) < 10 ? 'MATCHED' : 'MISMATCH' });
    }
  }
  return { source, readAt: reads.readAt, stock, moves };
}

/* ── Matching ERP records with sheet rows ───────────────────────────────────── */

/**
 * ERP GRN lines vs the sheet's receipt rows: first by GRN number (summed per number),
 * then the rest by equal quantity within DATE_TOLERANCE_DAYS — the Trading inward tab
 * has no GRN-number column.
 */
function matchReceipts(erpLines, sheetRows) {
  const res = { pairs: [], qtyDiff: [], erpOnly: [], sheetOnly: [] };
  const usedE = new Set();
  const usedS = new Set();
  const sheetByNo = group(sheetRows.filter((t) => norm(t.ref)), (t) => norm(t.ref));
  for (const [no, es] of group(erpLines, (l) => norm(l.grnNo))) {
    const ss = sheetByNo.get(no);
    if (!ss) continue;
    const eq = es.reduce((a, l) => a + l.qty, 0);
    const sq = ss.reduce((a, t) => a + t.qty, 0);
    es.forEach((l) => usedE.add(l));
    ss.forEach((t) => usedS.add(t));
    (eq === sq ? res.pairs : res.qtyDiff).push({ grn: no, eq, sq });
  }
  const restE = erpLines.filter((l) => !usedE.has(l)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const restS = sheetRows.filter((t) => !usedS.has(t));
  for (const l of restE) {
    let best = null;
    for (const t of restS) {
      if (usedS.has(t) || t.qty !== l.qty) continue;
      const dd = daysApart(l.date, t.date);
      if (dd <= DATE_TOLERANCE_DAYS && (!best || dd < best.dd)) best = { t, dd };
    }
    if (best) {
      usedE.add(l);
      usedS.add(best.t);
      res.pairs.push({ grn: norm(l.grnNo), eq: l.qty, sq: best.t.qty });
    }
  }
  res.erpOnly = erpLines.filter((l) => !usedE.has(l));
  res.sheetOnly = sheetRows.filter((t) => !usedS.has(t));
  return res;
}

/* ── Evidence text ──────────────────────────────────────────────────────────── */

const OPENING_DATE = `${FY_START.year}-${String(FY_START.month).padStart(2, '0')}-01`;

function rowList(tab, rows) {
  const nums = [...new Set(rows.map((t) => t.row))].sort((a, b) => a - b);
  const all = `${tab} row${nums.length > 1 ? 's' : ''} ${nums.join(',')}`;
  return all.length <= 400 ? all : `${tab} ${nums.length} rows ${nums[0]}-${nums[nums.length - 1]}`;
}

/** "ids 27428,27433", or "ids 27428 … 31544 (37)" when the list would not fit in `max` characters. */
function listText(label, values, max) {
  const all = `${label} ${values.join(',')}`;
  return all.length <= max ? all : `${label} ${values[0]} … ${values[values.length - 1]} (${values.length})`;
}

/* ── Per item ───────────────────────────────────────────────────────────────── */

function analyse(backup, sheets) {
  const { data } = backup;
  const uomCode = new Map(data.lookups.filter((l) => l.category === 'UOM').map((l) => [String(l.id), l.code]));
  const ledger = group([...data.stock_ledger].sort(byId), (l) => String(l.item_id));
  const items = data.items.filter((i) => !i.deleted_at).sort(byId);
  const results = [];

  for (const it of items) {
    const rows = ledger.get(String(it.id)) ?? [];
    const B = rows.reduce((a, l) => a + S(l.inward_qty) - S(l.outward_qty), 0);
    const I = S(it.live_stock_qty);
    // Exactly the rule of GET /items/analysis/stock-reconciliation: |ledger − live| > 0.0001.
    if (Math.abs(I - B) <= 1) continue;

    const code = it.item_code.toUpperCase();
    const itemUom = uomCode.get(String(it.uom_id)) ?? null;
    const all = sheets.stock.get(code) ?? [];
    const inUnit = all.filter((r) => sameUnit(itemUom, r.uom));
    // The sync adds only the sheets that count the code in the Item Master's unit (SLR-4). With a
    // single sheet its rows are still used, so the evidence is shown; the unit then makes it Tier B.
    const listed = all.length > 1 && inUnit.length > 0 ? inUnit : all;
    const leftOut = all.filter((r) => !listed.includes(r));
    const cats = [...new Set(listed.map((r) => r.category))].sort();
    const sheetSum = listed.reduce((a, r) => a + r.L, 0);
    const target = Math.max(0, sheetSum);

    // Rows an earlier alignment posted: the item is not aligned twice.
    const alignedRows = rows.filter((l) => l.reference_type === ALIGNMENT_REFERENCE_TYPE);
    // An ERP document posted and then taken back with its supported reversal (the
    // reversal carries the same document number) changed nothing for this item, so it
    // needs no sheet counterpart — e.g. the 2026-10-14 test records once reversed.
    const byDoc = group(rows.filter((l) => l.reference_type !== ALIGNMENT_REFERENCE_TYPE && l.txn_type !== 'SHEET_SYNC' && l.reference_no),
      (l) => l.reference_no);
    const reversedDocs = new Set([...byDoc].filter(([, list]) => list.some((l) => l.txn_type.endsWith('_REVERSAL'))
      && list.reduce((a, l) => a + S(l.inward_qty) - S(l.outward_qty), 0) === 0).map(([no]) => no));
    const counted = rows.filter((l) => l.reference_type !== ALIGNMENT_REFERENCE_TYPE && !reversedDocs.has(l.reference_no));
    const grnRows = counted.filter((l) => l.txn_type === 'GRN_INWARD');
    const syncRows = counted.filter((l) => l.txn_type === 'SHEET_SYNC');
    const otherRows = counted.filter((l) => l.txn_type !== 'GRN_INWARD' && l.txn_type !== 'SHEET_SYNC');
    const netOf = (list) => list.reduce((a, l) => a + S(l.inward_qty) - S(l.outward_qty), 0);
    const G = netOf(grnRows);
    const SS = netOf(syncRows);

    const perCat = listed.map((r) => {
      const moves = sheets.moves.get(`${r.category}|${code}`) ?? [];
      const isAdj = (t) => t.txnType === ADJUSTMENT_TAB.txnType;
      const inRows = moves.filter((t) => t.direction === 'IN' && !isAdj(t));
      const outRows = moves.filter((t) => t.direction === 'OUT' && !isAdj(t));
      const adjRows = moves.filter(isAdj);
      const sum = (list) => list.reduce((a, t) => a + t.qty, 0);
      const receiptRows = RECEIPT_TYPE[r.category] ? inRows.filter((t) => t.txnType === RECEIPT_TYPE[r.category]) : [];
      const otherInRows = inRows.filter((t) => !receiptRows.includes(t));
      const SA = adjRows.reduce((a, t) => a + (t.direction === 'IN' ? t.qty : -t.qty), 0);
      return {
        ...r, cfg: INVENTORY_SHEETS[r.category], receiptRows, otherInRows, outRows, adjRows, SA,
        SIgrn: sum(receiptRows), SIother: sum(otherInRows), SO: sum(outRows), proof: r.O + sum(inRows) - sum(outRows) + SA,
      };
    });
    const tot = (k) => perCat.reduce((a, p) => a + p[k], 0);
    const O = tot('O');
    const SIgrn = tot('SIgrn');
    const SIother = tot('SIother');
    const SO = tot('SO');
    const SA = tot('SA');
    const Csum = tot('C');
    const eps = I - Csum;
    const gap = I - B;

    // Receipts: ERP GRN lines vs the sheet's receipt rows.
    const rm = matchReceipts(
      grnRows.map((l) => ({ grnNo: l.reference_no, qty: S(l.inward_qty) - S(l.outward_qty), date: day(l.txn_date) })),
      perCat.flatMap((p) => p.receiptRows),
    );
    // Issues already posted in the ERP are the same issues as sheet rows; they are not posted twice.
    const sheetOut = perCat.flatMap((p) => p.outRows);
    const matchedOut = new Map();
    const erpIssuesUnmatched = [];
    for (const e of otherRows.filter((l) => ISSUE_TYPES.has(l.txn_type))) {
      const eq = S(e.outward_qty) - S(e.inward_qty);
      let best = null;
      for (const t of sheetOut) {
        if (matchedOut.has(t) || t.qty !== eq) continue;
        const dd = daysApart(day(e.txn_date), t.date);
        if (dd <= DATE_TOLERANCE_DAYS && (!best || dd < best.dd)) best = { t, dd };
      }
      if (best) matchedOut.set(best.t, e.reference_no);
      else erpIssuesUnmatched.push(e);
    }
    const erpOther = otherRows.filter((l) => !ISSUE_TYPES.has(l.txn_type));

    // Units.
    const warnings = [];
    const uomOnly = [];
    const unitText = listed.map((p) => `${p.category} ${p.uom}`).join(' + ');
    if (listed.length === 1 && !sameUnit(itemUom, listed[0].uom)) {
      uomOnly.push(`unit: the Item Master says ${itemUom ?? '(none)'}, the ${listed[0].category} sheet counts ${listed[0].uom}; correct items.uom_id, then re-run`);
    }
    for (const r of leftOut) warnings.push(`${r.category} sheet counts it in ${r.uom}: not part of the Purchase stock (Item Master ${itemUom ?? '(none)'})`);
    if (!it.is_active) warnings.push('inactive in the Item Master');
    if (reversedDocs.size) warnings.push(`ERP ${[...reversedDocs].join(', ')} posted and reversed (net 0): left out of the comparison`);

    // Reasons that need a person first (Tier C).
    const reasons = [];
    if (alignedRows.length) {
      const undone = alignedRows.some((l) => l.reference_id !== null && l.reference_id !== undefined);
      reasons.push(`already aligned on ${day(alignedRows[0].txn_date)} (${alignedRows.length} ${ALIGNMENT_REFERENCE_TYPE} ledger row(s)` +
        `${undone ? ', since undone' : ''}); an item is aligned once only`);
    }
    if (listed.length === 0) reasons.push('not listed in any inventory sheet');
    else if (sheetSum < 0) reasons.push(`the sheet shows negative stock ${q(sheetSum)}, held at zero`);
    else if (cats.length > 1) {
      reasons.push(inUnit.length === 0
        ? `listed in ${unitText}, none in the Item Master unit ${itemUom ?? '(none)'}`
        : `listed in several sheets in the same unit (${unitText}); the sheets do not say which holds which stock`);
    } else if (listed.some((p) => p.status !== 'MATCHED')) reasons.push("the sheet's live stock is not explained by its own rows (fix the sheet first)");
    else if (I !== target) reasons.push(`live stock ${q(I)} is not the sheet figure ${q(target)} in the item's unit: run the inventory sync first`);
    for (const p of perCat) {
      if (p.proof !== p.C) reasons.push(`${p.category} row ${p.row}: opening + in - out + adjustments ${q(p.proof)} is not the computed ${q(p.C)}`);
    }
    // Never plugged: a difference between the sheet's live cell and its rows is not evidence of anything.
    if (eps !== 0 && listed.length > 0) reasons.push(`live stock differs from the sheet's own rows by ${q(eps)}`);
    if (rm.erpOnly.length) reasons.push(`ERP receipts with no sheet counterpart: ${rm.erpOnly.map((l) => `${l.grnNo} ${q(l.qty)} (${l.date})`).join('; ')}`);
    if (rm.qtyDiff.length) reasons.push(`GRN quantity differs ERP vs sheet: ${rm.qtyDiff.map((p) => `${p.grn} ERP ${q(p.eq)} / sheet ${q(p.sq)}`).join('; ')}`);
    if (erpIssuesUnmatched.length) reasons.push(`ERP issues with no sheet counterpart: ${erpIssuesUnmatched.map((e) => `${e.reference_no} ${q(S(e.outward_qty) - S(e.inward_qty))}`).join('; ')}`);
    if (erpOther.length) {
      reasons.push(`ERP ${[...new Set(erpOther.map((e) => e.txn_type))].join('/')} entries: ${erpOther.map((e) => `${e.reference_no} ${q(S(e.inward_qty) - S(e.outward_qty))}`).join('; ')}`);
    }
    if (O + SIgrn + SIother - SO + SA !== Csum) reasons.push("the sheet's rows do not add up to its computed stock");

    // Entries: each one an existing record — a sheet cell, sheet rows, or ledger rows.
    const dated = [];
    for (const p of perCat) {
      for (const t of rm.sheetOnly.filter((x) => p.receiptRows.includes(x))) {
        dated.push({
          at: t.date, inward: true, component: 'SHEET_RECEIPT', qty: t.qty,
          reference: `${t.date} ${t.ref ? `GRN ${t.ref}` : `${t.type || 'inward'} (no GRN no.)`}`,
          evidence: `${t.tab} row ${t.row}`,
        });
      }
      const monthly = (list, sign, component, exclusions) => {
        for (const [key, rs] of group(list, (t) => `${t.txnType}|${t.month}`)) {
          const month = key.split('|')[1];
          const last = rs.reduce((x, t) => (t.date > x ? t.date : x), '');
          const excluded = exclusions(rs[0].tab, month);
          dated.push({
            at: last, inward: sign > 0, component, qty: sign * rs.reduce((a, t) => a + t.qty, 0), reference: month,
            evidence: `${rowList(rs[0].tab, rs)}${excluded}`,
          });
        }
      };
      monthly(p.otherInRows, 1, 'SHEET_INWARD', () => '');
      monthly(p.outRows.filter((t) => !matchedOut.has(t)), -1, 'SHEET_ISSUES', (tab, month) => {
        const done = p.outRows.filter((t) => matchedOut.has(t) && t.month === month);
        return done.length ? ` (${done.map((t) => `row ${t.row} is ${matchedOut.get(t)}`).join(', ')}, already in the ERP)` : '';
      });
      for (const a of p.adjRows) {
        dated.push({
          at: a.date, inward: a.direction === 'IN', component: 'SHEET_ADJUSTMENT', qty: a.direction === 'IN' ? a.qty : -a.qty,
          reference: a.date, evidence: `${ADJUSTMENT_TAB.tab} row ${a.row} (${p.category} sheet)`,
        });
      }
    }
    // As the sheet's own running balance: by date, inward before outward on a day.
    dated.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : Number(b.inward) - Number(a.inward)));
    const entries = [
      ...perCat.filter((p) => p.O !== 0).map((p) => ({
        component: 'OPENING', qty: p.O, reference: OPENING_DATE, evidence: `${p.cfg.stock.tab}!${p.cfg.stock.openingCol}${p.row}`,
      })),
      ...dated.map(({ at: _at, inward: _inward, ...e }) => e),
    ];
    // SHEET_SYNC entries measured the sheet's changes from the un-ledgered figure the old sync
    // wrote; the opening and the rows above now explain the stock from the start, so they are reversed.
    if (SS !== 0) {
      // Remarks read "Reversal of sheet sync run INV-20261016-052733-bdc4 - stock_ledger id 27436".
      const runs = [...new Set(syncRows.map((l) => l.reference_no))];
      entries.push({
        component: 'SHEET_SYNC_REVERSAL', qty: -SS,
        reference: listText(runs.length > 1 ? 'runs' : 'run', runs, MAX_REFERENCE),
        evidence: listText(`stock_ledger id${syncRows.length > 1 ? 's' : ''}`, syncRows.map((l) => l.id), MAX_EVIDENCE),
      });
    }
    for (const e of entries) {
      if (e.reference.length > MAX_REFERENCE || e.evidence.length > MAX_EVIDENCE) {
        reasons.push(`an entry's text is longer than the endpoint accepts (${e.component} ${e.reference.slice(0, 40)}…)`);
        break;
      }
    }
    const entriesNet = entries.reduce((a, e) => a + e.qty, 0);
    const closes = entriesNet === gap;
    if (reasons.length === 0 && !closes) reasons.push(`the records add up to ${q(entriesNet)}, the gap is ${q(gap)}`);
    const tier = reasons.length ? 'C' : uomOnly.length ? 'B' : 'A';

    results.push({
      it, code, itemUom, listed, I, B, gap, O, SIother, SA, SS, eps, entries, entriesNet, closes, tier,
      reasons: [...reasons, ...uomOnly], warnings,
      receiptsNotInErp: rm.sheetOnly.reduce((a, t) => a + t.qty, 0),
      issuesNotInErp: SO - [...matchedOut.keys()].reduce((a, t) => a + t.qty, 0),
    });
  }
  return results;
}

/* ── Output ─────────────────────────────────────────────────────────────────── */

const csvCell = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function writeOutputs(results, backup, sheets, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const tierA = results.filter((r) => r.tier === 'A');
  const entries = tierA.flatMap((r) => r.entries.map((e) => ({
    itemId: Number(r.it.id), component: e.component, qty: e.qty / 10000, reference: e.reference, evidence: e.evidence,
  })));
  const count = (list, fn) => list.reduce((m, x) => { const k = fn(x); m[k] = (m[k] ?? 0) + 1; return m; }, {});
  const tierRow = (tier) => {
    const list = results.filter((r) => r.tier === tier);
    return {
      items: list.length, active: list.filter((r) => r.it.is_active).length, inactive: list.filter((r) => !r.it.is_active).length,
      gap: q(list.reduce((a, r) => a + r.gap, 0)),
    };
  };
  const byComponent = {};
  for (const r of tierA) {
    for (const e of r.entries) {
      const c = (byComponent[e.component] ??= { entries: 0, qty: 0 });
      c.entries += 1;
      c.qty += e.qty;
    }
  }
  for (const c of Object.values(byComponent)) c.qty = q(c.qty);
  const summary = {
    generatedAt: new Date().toISOString(),
    backup: { file: backup.file, createdAt: backup.meta.createdAt ?? null, schemaVersion: backup.meta.schemaVersion ?? null, sha256: backup.sha256 },
    sheets: { source: sheets.source, readAt: sheets.readAt },
    mismatchedItems: {
      total: results.length,
      active: results.filter((r) => r.it.is_active).length,
      inactive: results.filter((r) => !r.it.is_active).length,
      gap: q(results.reduce((a, r) => a + r.gap, 0)),
    },
    tiers: { A: tierRow('A'), B: tierRow('B'), C: tierRow('C') },
    tierA: { items: tierA.length, entries: entries.length, net: q(tierA.reduce((a, r) => a + r.entriesNet, 0)), byComponent },
    tierB: results.filter((r) => r.tier === 'B').map((r) => `${r.it.item_code}: ${r.reasons.join('; ')}`),
    tierCByFirstReason: count(results.filter((r) => r.tier === 'C'), (r) => r.reasons[0].replace(/:.*$/, '').replace(/-?\d[\d.,]*/g, 'n')),
  };

  const entriesFile = path.join(outDir, 'stock-alignment-entries.json');
  fs.writeFileSync(entriesFile, `${JSON.stringify({ meta: { ...summary, tierB: undefined, tierCByFirstReason: undefined }, entries }, null, 1)}\n`);

  const head = ['item_id', 'item_code', 'is_active', 'tier', 'reason', 'warnings', 'item_uom', 'sheet_listing', 'sheet_uom',
    'live_stock_qty', 'ledger_balance', 'gap', 'opening', 'sheet_receipts_not_in_erp', 'sheet_other_inward', 'sheet_issues_not_in_erp',
    'sheet_adjustments', 'sheet_sync_reversed', 'entries', 'entries_net', 'entries_close_gap'];
  const lines = [...results].sort((a, b) => a.code.localeCompare(b.code)).map((r) => [
    r.it.id, r.it.item_code, r.it.is_active ? 'Y' : 'N', r.tier, r.reasons.join(' | '), r.warnings.join(' | '), r.itemUom ?? '',
    r.listed.map((p) => `${p.category}:${p.tab}!${colLetter(INVENTORY_SHEETS[p.category].stock.qtyCol)}${p.row}`).join(' + '),
    r.listed.map((p) => p.uom).join(' + '),
    q(r.I), q(r.B), q(r.gap), q(r.O), q(r.receiptsNotInErp), q(r.SIother), q(r.issuesNotInErp), q(r.SA), q(-r.SS),
    r.entries.length, q(r.entriesNet), r.closes ? 'Y' : 'N',
  ].map(csvCell).join(','));
  const itemsFile = path.join(outDir, 'stock-alignment-items.csv');
  fs.writeFileSync(itemsFile, `${[head.join(','), ...lines].join('\r\n')}\r\n`);

  fs.writeFileSync(path.join(outDir, 'stock-alignment-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return { summary, entriesFile, itemsFile };
}

/* ── Main ───────────────────────────────────────────────────────────────────── */

const backup = loadBackup(args.backup);
let sheets;
if (args.sheets === 'backup') {
  sheets = sheetsFromBackup(backup.data);
} else if (args.sheets === 'live') {
  const reads = await readSheetsLive();
  if (args.saveSheets) {
    fs.writeFileSync(args.saveSheets, JSON.stringify(reads));
    console.log(`saved the raw reads to ${args.saveSheets}`);
  }
  sheets = sheetsFromReads(reads, 'Google Sheets (read now)');
} else {
  sheets = sheetsFromReads(loadReads(args.sheets), `saved reads ${path.basename(args.sheets)}`);
}

const results = analyse(backup, sheets);
const { summary, entriesFile, itemsFile } = writeOutputs(results, backup, sheets, args.out);
console.log(JSON.stringify(summary, null, 2));
console.log(`\nTier A entries: ${entriesFile}\nPer-item tiers: ${itemsFile}`);
console.log('Next: POST the entries file as a dry run, review the accepted and refused items, then apply with its selectionHash.');
