/**
 * Full transaction-data reset — DISTINCT from `purify.ts`.
 *
 * `purify.ts` removes rows it can PROVE are non-production (`seed_tag`
 * demo/test). This module does something narrower and more absolute: it
 * empties every Indent/PO/GRN transaction table completely, regardless of
 * `seed_tag`, because the real Google Sheet source for those three document
 * types currently has zero rows — meaning every existing row, tagged or not,
 * is QA/testing residue, not a real business record. This is only safe to run
 * on an explicit, informed instruction (an operator decision, not something
 * this code infers on its own).
 *
 * Master data (suppliers, items, users, lookups, permissions, roles, sheet
 * mappings, settings) is never touched. Document-numbering counters
 * (`document_sequences`) are date-scoped and left alone — not business data.
 */
import { queryOne, withTransaction, txQuery } from './index.js';

const TRANSACTION_TABLES = [
  'grn_lines', 'grn_headers',
  'po_indent_sources', 'purchase_order_lines', 'purchase_order_headers',
  'indent_approvals', 'purchase_indent_lines', 'purchase_indent_headers',
] as const;

const MASTER_TABLES_TO_VERIFY_UNCHANGED = [
  'suppliers', 'items', 'users', 'roles', 'permissions', 'lookups',
] as const;

export interface ResetResult {
  deleted: Record<string, number>;
  before: Record<string, number>;
  after: Record<string, number>;
  mastersUnchanged: boolean;
  masterCounts: { table: string; before: number; after: number }[];
}

async function countAll(tables: readonly string[]): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of tables) {
    const row = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ${t}`);
    out[t] = Number(row?.n ?? 0);
  }
  return out;
}

/** Read-only: what would be deleted, and current master counts, for a dry-run report. */
export async function inventoryForReset(): Promise<{
  transactionCounts: Record<string, number>;
  masterCounts: Record<string, number>;
}> {
  const [transactionCounts, masterCounts] = await Promise.all([
    countAll(TRANSACTION_TABLES),
    countAll(MASTER_TABLES_TO_VERIFY_UNCHANGED),
  ]);
  return { transactionCounts, masterCounts };
}

/**
 * Deletes EVERY row from every Indent/PO/GRN table, unconditionally, inside
 * one transaction. Verifies master-table counts are unchanged before and
 * after, so the claim "only transactions were touched" is proven, not assumed.
 */
export async function resetAllTransactionData(opts: {
  actorEmployeeId?: string;
  actorName?: string;
} = {}): Promise<ResetResult> {
  const before = await countAll(TRANSACTION_TABLES);
  const masterBefore = await countAll(MASTER_TABLES_TO_VERIFY_UNCHANGED);
  const deleted: Record<string, number> = {};

  await withTransaction(async (tx) => {
    for (const table of TRANSACTION_TABLES) {
      const res = await txQuery(tx, `DELETE FROM ${table} RETURNING 1 AS x`);
      deleted[table] = res.length;
    }

    await txQuery(
      tx,
      `INSERT INTO audit_logs (actor_employee_id, actor_name, action, entity, entity_label, result, message)
       VALUES ($1, $2, 'PURGE', 'database', 'all transaction data', 'SUCCESS', $3)`,
      [
        opts.actorEmployeeId ?? 'SYSTEM', opts.actorName ?? 'Transaction reset',
        `Full transaction reset (not seed_tag-scoped — every Indent/PO/GRN row removed): ` +
          Object.entries(deleted).map(([t, n]) => `${t}=${n}`).join(', '),
      ],
    );
  });

  const after = await countAll(TRANSACTION_TABLES);
  const masterAfter = await countAll(MASTER_TABLES_TO_VERIFY_UNCHANGED);

  const masterCounts = MASTER_TABLES_TO_VERIFY_UNCHANGED.map((t) => ({
    table: t, before: masterBefore[t] ?? 0, after: masterAfter[t] ?? 0,
  }));
  const mastersUnchanged = masterCounts.every((m) => m.before === m.after);

  return { deleted, before, after, mastersUnchanged, masterCounts };
}
