/**
 * One-time stock-ledger alignment (2026-10-16 audit, SLR-8).
 *
 * Until 2026-10-16 the inventory sync wrote the Google Sheet figures into
 * items.live_stock_qty with no ledger row, and the sync that replaced it ledgers
 * only the change from that figure — so the old gap stays: on the 07:15 UTC
 * snapshot 2,769 items' stock ledgers did not explain their stock.
 * scripts/compute-stock-alignment.mjs rebuilds each item's stock from evidence —
 * the sheet's opening cell, sheet movement rows, the item's existing ledger rows —
 * and this module posts those figures as ledger rows. It never derives a figure:
 *
 *   · an item is aligned only when its ledger balance plus its entries equals
 *     items.live_stock_qty to within 0.0001 (the stock-reconciliation report's own
 *     rule) — a difference is never plugged, the item is refused with its figures;
 *   · an item whose alignment is in place (OPENING_ALIGNMENT rows no undo points
 *     at) is refused, so running the same file again changes nothing; after an undo
 *     the item can be aligned again from corrected evidence;
 *   · items.live_stock_qty is never written;
 *   · the dry run returns a selectionHash over exactly what it would write, and
 *     applying requires it: the plan is rebuilt in one transaction with the items
 *     locked, so a sync or a stock posting in between ends in 409, nothing written;
 *   · undo appends the opposite rows; nothing is ever deleted;
 *   · each run numbers its rows ALN-<date>-<run>-<item>-<NNN>, the run a short id of
 *     its own, and an undo row carries the number of the row it reverses. The numbers
 *     were ALN-<date>-<item>-<NNN>, so aligning an item again on the day its alignment
 *     was undone gave its new rows the numbers of the undone ones (rows posted that way
 *     keep their numbers).
 */
import { createHash, randomBytes } from 'node:crypto';
import { txQuery, type Queryable } from '../../db/index.js';
import { dec, toQty } from '../../domain/money.js';
import { BusinessRuleError, ConflictError } from '../../core/errors.js';
import { auditIn, type AuditActor } from '../../core/audit.js';

/** Every alignment row, and every undo of one, carries this reference type. */
export const ALIGNMENT_REFERENCE_TYPE = 'OPENING_ALIGNMENT';
export const ALIGNMENT_TXN_TYPE = 'STOCK_ALIGNMENT';
/** The largest |ledger + entries − live stock| accepted: the stock-reconciliation report's mismatch rule. */
export const ALIGNMENT_TOLERANCE = '0.0001';

/** What an entry stands for; the label starts the row's remarks. */
export const ALIGNMENT_COMPONENTS = {
  OPENING: 'Opening',
  SHEET_RECEIPT: 'Receipt',
  SHEET_INWARD: 'Inward',
  SHEET_ISSUES: 'Issues',
  SHEET_ADJUSTMENT: 'Adjustment',
  SHEET_SYNC_REVERSAL: 'Reversal of sheet sync',
} as const;
export type AlignmentComponent = keyof typeof ALIGNMENT_COMPONENTS;
export const ALIGNMENT_COMPONENT_CODES = Object.keys(ALIGNMENT_COMPONENTS) as [AlignmentComponent, ...AlignmentComponent[]];

export interface AlignmentEntry {
  itemId: number;
  component: AlignmentComponent;
  /** Signed, at most 4 decimals: inward when positive, outward when negative. */
  qty: string;
  /** The date, month or document the entry stands for, e.g. "2026-04-01". */
  reference: string;
  /** Where it is recorded, e.g. "General Item Live Stock!BI1088". */
  evidence: string;
}

export interface PlannedItem {
  itemId: number;
  itemCode: string;
  isActive: boolean;
  uomId: number | null;
  ledgerBalance: string;
  entriesNet: string;
  liveStock: string;
  difference: string;
  entries: AlignmentEntry[];
}

export interface RefusedItem {
  itemId: number;
  itemCode: string | null;
  reason: string;
  entries: number;
  entriesNet: string;
  ledgerBalance?: string;
  liveStock?: string;
  difference?: string;
}

export interface AlignmentPlan {
  accepted: PlannedItem[];
  refused: RefusedItem[];
  totals: { items: number; activeItems: number; inactiveItems: number; entries: number; net: string; refused: number };
  selectionHash: string;
}

type Run = <T>(sql: string, params: unknown[]) => Promise<T[]>;

/** "Opening 2026-04-01 - General Item Live Stock!BI1088" */
export const remarksOf = (e: Pick<AlignmentEntry, 'component' | 'reference' | 'evidence'>) =>
  `${ALIGNMENT_COMPONENTS[e.component]} ${e.reference} - ${e.evidence}`;

/**
 * Checks every item the entries name. `lock` (inside the apply transaction) takes
 * each item row FOR UPDATE, in id order, before its figures are read.
 */
export async function planAlignment(run: Run, entries: AlignmentEntry[], opts: { lock?: boolean } = {}): Promise<AlignmentPlan> {
  const byItem = new Map<number, AlignmentEntry[]>();
  for (const e of entries) {
    const list = byItem.get(e.itemId) ?? [];
    list.push(e);
    byItem.set(e.itemId, list);
  }
  const ids = [...byItem.keys()].sort((a, b) => a - b);
  const items = await run<{ id: string; item_code: string; is_active: boolean; deleted: boolean; live: string; uom_id: string | null }>(
    `SELECT id, item_code, is_active, deleted_at IS NOT NULL AS deleted, live_stock_qty::text AS live, uom_id
       FROM items WHERE id = ANY($1::bigint[]) ORDER BY id${opts.lock ? ' FOR UPDATE' : ''}`,
    [ids],
  );
  // Only an alignment still in place blocks a new one: a row an undo row points at
  // (reference_id) no longer counts, so a disputed opening can be undone, corrected and
  // aligned again. Counting every original row left an undone item unalignable for good.
  const ledger = await run<{ item_id: string; balance: string; aligned_rows: number; aligned_on: string | null }>(
    `WITH undone AS (
       SELECT DISTINCT reference_id AS id FROM stock_ledger
        WHERE item_id = ANY($1::bigint[]) AND reference_type = $2 AND reference_id IS NOT NULL)
     SELECT l.item_id, SUM(l.inward_qty - l.outward_qty)::text AS balance,
            COUNT(*) FILTER (WHERE l.reference_type = $2 AND l.reference_id IS NULL AND u.id IS NULL)::int AS aligned_rows,
            MIN(l.txn_date) FILTER (WHERE l.reference_type = $2 AND l.reference_id IS NULL AND u.id IS NULL)::text AS aligned_on
       FROM stock_ledger l LEFT JOIN undone u ON u.id = l.id
      WHERE l.item_id = ANY($1::bigint[]) GROUP BY l.item_id`,
    [ids, ALIGNMENT_REFERENCE_TYPE],
  );
  const itemById = new Map(items.map((i) => [Number(i.id), i]));
  const ledgerById = new Map(ledger.map((l) => [Number(l.item_id), l]));
  const tolerance = dec(ALIGNMENT_TOLERANCE);

  const accepted: PlannedItem[] = [];
  const refused: RefusedItem[] = [];
  for (const itemId of ids) {
    const list = byItem.get(itemId)!;
    const net = list.reduce((a, e) => a.plus(dec(e.qty)), dec(0));
    const item = itemById.get(itemId);
    if (!item || item.deleted) {
      refused.push({
        itemId, itemCode: item?.item_code ?? null, entries: list.length, entriesNet: toQty(net),
        reason: item ? 'The item is deleted.' : 'No item has this id.',
      });
      continue;
    }
    const led = ledgerById.get(itemId);
    const balance = dec(led?.balance ?? 0);
    const live = dec(item.live);
    const difference = live.minus(balance.plus(net));
    const figures = {
      entries: list.length, ledgerBalance: toQty(balance), entriesNet: toQty(net), liveStock: toQty(live), difference: toQty(difference),
    };
    if ((led?.aligned_rows ?? 0) > 0) {
      refused.push({
        itemId, itemCode: item.item_code, ...figures,
        reason: `Already aligned on ${led!.aligned_on} (${led!.aligned_rows} ${ALIGNMENT_REFERENCE_TYPE} ledger row(s) in place); ` +
          'undo that alignment before aligning the item again.',
      });
      continue;
    }
    if (difference.abs().greaterThan(tolerance)) {
      refused.push({
        itemId, itemCode: item.item_code, ...figures,
        reason: `Ledger ${toQty(balance)} + entries ${toQty(net)} = ${toQty(balance.plus(net))}, but the live stock is ${toQty(live)} ` +
          `(difference ${toQty(difference)}). Only entries that close the gap exactly are posted; a difference is never plugged.`,
      });
      continue;
    }
    accepted.push({
      itemId, itemCode: item.item_code, isActive: item.is_active, uomId: item.uom_id === null ? null : Number(item.uom_id),
      ...figures, entries: list,
    });
  }

  // One fingerprint for exactly what would be written: the items, the figures they were
  // checked against, and every entry in order (its position fixes its reference number).
  const selectionHash = createHash('sha256').update(JSON.stringify(accepted.map((a) => [
    a.itemId, a.ledgerBalance, a.liveStock, a.entries.map((e) => [e.component, toQty(e.qty), e.reference, e.evidence]),
  ]))).digest('hex');
  return {
    accepted,
    refused,
    totals: {
      items: accepted.length,
      activeItems: accepted.filter((a) => a.isActive).length,
      inactiveItems: accepted.filter((a) => !a.isActive).length,
      entries: accepted.reduce((n, a) => n + a.entries.length, 0),
      net: toQty(accepted.reduce((s, a) => s.plus(dec(a.entriesNet)), dec(0))),
      refused: refused.length,
    },
    selectionHash,
  };
}

/** The plan as a response: per-item figures, without echoing every entry back. */
export function describePlan(plan: AlignmentPlan) {
  return {
    selectionHash: plan.selectionHash,
    totals: plan.totals,
    accepted: plan.accepted.map(({ entries, uomId: _uomId, ...a }) => ({ ...a, entries: entries.length })),
    refused: plan.refused,
  };
}

/** Runs `sql` with `$1` = a JSON array of row objects, in chunks. */
async function jsonBatch(tx: Queryable, sql: string, rows: object[], extra: unknown[] = [], chunk = 1000): Promise<void> {
  for (let i = 0; i < rows.length; i += chunk) {
    await tx.query(sql, [JSON.stringify(rows.slice(i, i + chunk)), ...extra]);
  }
}

/**
 * A short id for one alignment run, unused by any ledger number of that day: the
 * reference numbers of one run never repeat another run's (stock_ledger.reference_no
 * has no unique index, so this check is what keeps them apart).
 */
async function newRunId(run: Run, stamp: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const id = randomBytes(3).toString('hex');
    const [{ taken }] = await run<{ taken: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM stock_ledger WHERE reference_type = $1 AND reference_no LIKE $2) AS taken`,
      [ALIGNMENT_REFERENCE_TYPE, `ALN-${stamp}-${id}-%`],
    );
    if (!taken) return id;
  }
  throw ConflictError('No unused alignment run number could be drawn; nothing was written. Try again.');
}

const INSERT_ROWS = `
  INSERT INTO stock_ledger (item_id, txn_type, reference_type, reference_id, reference_no,
                            inward_qty, outward_qty, balance_qty, uom_id, remarks, txn_date, created_by)
  SELECT v.item_id, '${ALIGNMENT_TXN_TYPE}', $2, v.reference_id, v.reference_no,
         v.inward, v.outward, v.balance, v.uom_id, v.remarks, $3::date, $4
    FROM jsonb_to_recordset($1::jsonb) AS v(item_id bigint, reference_id bigint, reference_no text,
                                            inward numeric, outward numeric, balance numeric, uom_id bigint, remarks text)`;

/**
 * Posts the plan the dry run showed. MUST run inside a transaction: the plan is
 * rebuilt with the items locked and must have the dry run's hash, and the ledger
 * must equal the live stock for every item before anything commits.
 */
export async function applyAlignment(
  tx: Queryable,
  entries: AlignmentEntry[],
  ctx: { expectedHash: string; actor: AuditActor; userId: number | null },
): Promise<{ plan: AlignmentPlan; rowsPosted: number; date: string; runId: string }> {
  const run: Run = (sql, params) => txQuery(tx, sql, params);
  const plan = await planAlignment(run, entries, { lock: true });
  if (plan.selectionHash !== ctx.expectedHash) {
    throw ConflictError(
      `The alignment is no longer what the dry run showed (now ${plan.totals.items} item(s) would be aligned and ${plan.totals.refused} refused). ` +
        'Nothing was written; run the dry run again and review it.',
      { items: plan.totals.items, refused: plan.totals.refused, selectionHash: plan.selectionHash },
    );
  }
  if (plan.accepted.length === 0) throw BusinessRuleError('None of these items can be aligned; nothing was written.');

  const [{ today }] = await run<{ today: string }>('SELECT CURRENT_DATE::text AS today', []);
  const stamp = today.replace(/-/g, '');
  const runId = await newRunId(run, stamp);
  const prefix = `ALN-${stamp}-${runId}`;
  const rows: object[] = [];
  for (const item of plan.accepted) {
    let balance = dec(item.ledgerBalance);
    item.entries.forEach((e, i) => {
      const qty = dec(e.qty);
      balance = balance.plus(qty);
      rows.push({
        item_id: item.itemId, reference_id: null,
        reference_no: `${prefix}-${item.itemId}-${String(i + 1).padStart(3, '0')}`,
        inward: qty.isPositive() ? toQty(qty) : '0', outward: qty.isNegative() ? toQty(qty.abs()) : '0',
        balance: toQty(balance), uom_id: item.uomId, remarks: remarksOf(e),
      });
    });
  }
  await jsonBatch(tx, INSERT_ROWS, rows, [ALIGNMENT_REFERENCE_TYPE, today, ctx.userId]);

  // The whole point, checked by the database before anything commits — with the
  // same rule as the stock-reconciliation report, so no aligned item is listed there.
  const off = await run<{ item_code: string; live: string; ledger: string }>(
    `SELECT i.item_code, i.live_stock_qty::text AS live, COALESCE(SUM(l.inward_qty - l.outward_qty), 0)::text AS ledger
       FROM items i LEFT JOIN stock_ledger l ON l.item_id = i.id
      WHERE i.id = ANY($1::bigint[])
      GROUP BY i.id, i.item_code, i.live_stock_qty
     HAVING abs(COALESCE(SUM(l.inward_qty - l.outward_qty), 0) - i.live_stock_qty) > $2::numeric`,
    [plan.accepted.map((a) => a.itemId), ALIGNMENT_TOLERANCE],
  );
  if (off.length > 0) {
    throw ConflictError(
      `After posting, the ledger would not equal the live stock for ${off.length} item(s) ` +
        `(${off.slice(0, 5).map((o) => `${o.item_code}: ledger ${o.ledger}, stock ${o.live}`).join('; ')}). Nothing was written.`,
    );
  }

  // One audit row per item, holding its entries; one for the run as a whole.
  for (const item of plan.accepted) {
    const n = item.entries.length;
    await auditIn(tx, {
      actor: ctx.actor,
      action: 'POST',
      entity: 'stock_alignment',
      entityId: item.itemId,
      entityLabel: item.itemCode,
      before: { ledgerBalance: item.ledgerBalance, liveStock: item.liveStock },
      after: {
        runId,
        referenceNos: `${prefix}-${item.itemId}-001…${String(n).padStart(3, '0')}`,
        entries: item.entries.map(({ component, qty, reference, evidence }) => ({ component, qty, reference, evidence })),
        ledgerBalance: toQty(dec(item.ledgerBalance).plus(dec(item.entriesNet))),
        selectionHash: plan.selectionHash,
      },
      message: `Opening alignment of ${item.itemCode}: ${n} ledger entr${n === 1 ? 'y' : 'ies'} (net ${item.entriesNet}) posted from sheet evidence; ` +
        `the ledger now explains the live stock ${item.liveStock}, which was not changed.`,
    });
  }
  await auditIn(tx, {
    actor: ctx.actor,
    action: 'POST',
    entity: 'stock_alignment',
    entityLabel: `alignment run ${plan.selectionHash.slice(0, 12)}`,
    after: { ...plan.totals, rowsPosted: rows.length, date: today, selectionHash: plan.selectionHash, runId, referencePrefix: prefix },
    message: `One-time stock-ledger alignment ${prefix}: ${plan.totals.items} item(s) aligned with ${rows.length} ledger row(s) ` +
      `(net ${plan.totals.net}); ${plan.totals.refused} item(s) refused. Live stock was not changed.`,
  });
  return { plan, rowsPosted: rows.length, date: today, runId };
}

export interface UndoResult {
  undone: Array<{ itemId: number; itemCode: string; rowsReversed: number; net: string }>;
  skipped: Array<{ itemId: number; itemCode: string | null; reason: string }>;
  rowsPosted: number;
  date: string;
}

/**
 * Takes alignments back by appending the opposite of each alignment row; the
 * original rows stay. Each undo row points at the row it reverses (reference_id),
 * so a row is never reversed twice. items.live_stock_qty is not touched. The item
 * can then be aligned again (planAlignment counts only rows no undo points at), e.g.
 * after its disputed opening cell is corrected.
 * MUST run inside a transaction.
 */
export async function undoAlignment(
  tx: Queryable,
  itemIds: number[],
  ctx: { reason: string; actor: AuditActor; userId: number | null },
): Promise<UndoResult> {
  const ids = [...new Set(itemIds)].sort((a, b) => a - b);
  const items = await txQuery<{ id: string; item_code: string }>(
    tx, 'SELECT id, item_code FROM items WHERE id = ANY($1::bigint[]) ORDER BY id FOR UPDATE', [ids],
  );
  const open = await txQuery<{ id: string; item_id: string; net: string; reference_no: string; uom_id: string | null }>(
    tx,
    `SELECT l.id, l.item_id, (l.inward_qty - l.outward_qty)::text AS net, l.reference_no, l.uom_id
       FROM stock_ledger l
      WHERE l.item_id = ANY($1::bigint[]) AND l.txn_type = '${ALIGNMENT_TXN_TYPE}' AND l.reference_type = $2
        AND l.reference_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM stock_ledger u WHERE u.reference_type = $2 AND u.reference_id = l.id)
      ORDER BY l.item_id, l.id`,
    [ids, ALIGNMENT_REFERENCE_TYPE],
  );
  const ledger = await txQuery<{ item_id: string; balance: string; aligned_rows: number }>(
    tx,
    `SELECT item_id, SUM(inward_qty - outward_qty)::text AS balance,
            COUNT(*) FILTER (WHERE reference_type = $2)::int AS aligned_rows
       FROM stock_ledger WHERE item_id = ANY($1::bigint[]) GROUP BY item_id`,
    [ids, ALIGNMENT_REFERENCE_TYPE],
  );
  const itemById = new Map(items.map((i) => [Number(i.id), i]));
  const ledgerById = new Map(ledger.map((l) => [Number(l.item_id), l]));
  const openByItem = new Map<number, typeof open>();
  for (const r of open) {
    const list = openByItem.get(Number(r.item_id)) ?? [];
    list.push(r);
    openByItem.set(Number(r.item_id), list);
  }

  const [{ today }] = await txQuery<{ today: string }>(tx, 'SELECT CURRENT_DATE::text AS today');
  const result: UndoResult = { undone: [], skipped: [], rowsPosted: 0, date: today };
  const rows: object[] = [];
  /** The numbers each item's undo reverses: its one run in place (planAlignment allows no second). */
  const reversedNos = new Map<number, string[]>();
  for (const itemId of ids) {
    const item = itemById.get(itemId);
    const list = openByItem.get(itemId) ?? [];
    if (!item || list.length === 0) {
      result.skipped.push({
        itemId, itemCode: item?.item_code ?? null,
        reason: !item ? 'No item has this id.'
          : (ledgerById.get(itemId)?.aligned_rows ?? 0) > 0 ? 'Its alignment has already been undone.' : 'It has not been aligned.',
      });
      continue;
    }
    let balance = dec(ledgerById.get(itemId)?.balance ?? 0);
    let net = dec(0);
    reversedNos.set(itemId, list.map((r) => r.reference_no));
    for (const r of list) {
      const back = dec(r.net).negated();
      balance = balance.plus(back);
      net = net.plus(back);
      // The undo row carries the number of the row it reverses, as a GRN reversal carries
      // its GRN's: with the run in that number, it names exactly the run it takes back.
      rows.push({
        item_id: itemId, reference_id: Number(r.id), reference_no: r.reference_no,
        inward: back.isPositive() ? toQty(back) : '0', outward: back.isNegative() ? toQty(back.abs()) : '0',
        balance: toQty(balance), uom_id: r.uom_id === null ? null : Number(r.uom_id),
        remarks: `Undo of ${r.reference_no} - ${ctx.reason}`,
      });
    }
    result.undone.push({ itemId, itemCode: item.item_code, rowsReversed: list.length, net: toQty(net) });
  }
  if (result.undone.length === 0) {
    throw BusinessRuleError('Nothing to undo: none of these items has an alignment in place.', { skipped: result.skipped });
  }
  await jsonBatch(tx, INSERT_ROWS, rows, [ALIGNMENT_REFERENCE_TYPE, today, ctx.userId]);
  result.rowsPosted = rows.length;

  for (const u of result.undone) {
    await auditIn(tx, {
      actor: ctx.actor,
      action: 'CANCEL',
      entity: 'stock_alignment',
      entityId: u.itemId,
      entityLabel: u.itemCode,
      after: { rowsReversed: u.rowsReversed, net: u.net, reason: ctx.reason, referenceNos: reversedNos.get(u.itemId) ?? [] },
      message: `Opening alignment of ${u.itemCode} undone: ${u.rowsReversed} opposite ledger row(s) appended (net ${u.net}); ` +
        `the original rows are kept and the live stock was not changed. Reason: ${ctx.reason}`,
    });
  }
  return result;
}
