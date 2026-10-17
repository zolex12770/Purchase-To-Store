/**
 * The Purchase Order list's filter and totals (SRS §11.4, §14).
 *
 * One builder for GET /purchase-orders, its export (io/datasets.ts) and the receipt
 * evidence summary, so the three can never disagree on which POs a filter selects:
 * an export holds exactly the rows the list shows, and the summary's pending figures
 * are the pending list's own totals.
 */
import { z } from 'zod';
import { queryOne, SqlBuilder } from '../../db/index.js';
import { csvArray, csvIdArray } from '../../core/http.js';
import { RECEIPT_EVIDENCE, receiptEvidenceCondition } from './receipt-evidence.js';

export const poFilterSchema = z.object({
  status: csvArray,
  supplierId: csvIdArray,
  poTypeId: csvIdArray,
  itemId: csvIdArray,
  userId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  mainGroupId: csvIdArray,
  hodId: csvIdArray,
  sourceMode: z.enum(['DIRECT', 'INDENT']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** `pending` and `complete` back the dedicated SRS §11.4 sub-tabs. */
  view: z.enum(['all', 'pending', 'complete']).default('all'),
  overdue: z.enum(['true', 'false']).optional(),
  /**
   * awaiting_link: a store receipt the link repair held back names the PO
   * (receipt-evidence.ts); none_recorded: none does.
   */
  receiptEvidence: z.enum(RECEIPT_EVIDENCE).optional(),
  search: z.string().trim().max(200).optional(),
});

export type PoFilter = z.infer<typeof poFilterSchema>;

/** The list's FROM: header `h`, its balance `b`, its supplier `s`. */
export const PO_FROM = `
  FROM purchase_order_headers h
  JOIN v_po_header_balance b ON b.po_id = h.id
  JOIN suppliers s ON s.id = h.supplier_id`;

export function buildPoFilter(q: Partial<PoFilter>): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('h.status', q.status);
  b.addIn('h.supplier_id', q.supplierId);
  b.addIn('h.po_type_id', q.poTypeId);
  b.addIn('h.created_by', q.userId);
  b.add('h.source_mode = ?', q.sourceMode);
  b.add('h.po_date >= ?', q.dateFrom);
  b.add('h.po_date <= ?', q.dateTo);

  if (q.departmentId && q.departmentId.length > 0) {
    const p = b.push(q.departmentId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN items i ON i.id = pol.item_id WHERE pol.po_id = h.id AND i.department_id = ANY(${p}))`);
  }
  if (q.costCentreId && q.costCentreId.length > 0) {
    const p = b.push(q.costCentreId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN items i ON i.id = pol.item_id WHERE pol.po_id = h.id AND i.cost_centre_id = ANY(${p}))`);
  }
  if (q.mainGroupId && q.mainGroupId.length > 0) {
    const p = b.push(q.mainGroupId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN items i ON i.id = pol.item_id WHERE pol.po_id = h.id AND i.main_group_id = ANY(${p}))`);
  }
  if (q.hodId && q.hodId.length > 0) {
    const p = b.push(q.hodId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines pol JOIN items i ON i.id = pol.item_id JOIN lookups d ON d.id = i.department_id WHERE pol.po_id = h.id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
  }

  // "Pending" and "Complete" are defined by the authoritative balance, not by a
  // status string a user could have set by hand (ADR-003).
  if (q.view === 'pending') b.addRaw('b.total_pending_qty > 0 AND h.status IN (\'OPEN\',\'PARTIALLY_RECEIVED\')');
  if (q.view === 'complete') b.addRaw("h.status IN ('COMPLETED','SHORT_CLOSED')");

  if (q.overdue === 'true') {
    b.addRaw(
      `EXISTS (SELECT 1 FROM v_po_line_balance l
                WHERE l.po_id = h.id AND l.is_receivable
                  AND l.delivery_date IS NOT NULL AND l.delivery_date < CURRENT_DATE)`,
    );
  }
  // A PO with a store receipt still awaiting its link may have had its goods; one with
  // none recorded is genuinely pending (receipt-evidence.ts).
  if (q.receiptEvidence) b.addRaw(receiptEvidenceCondition(q.receiptEvidence, 'h.id'));
  if (q.itemId && q.itemId.length > 0) {
    const p = b.push(q.itemId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = h.id AND l.item_id = ANY(${p}))`);
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(h.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} OR lower(h.remarks) LIKE ${p} ` +
      `OR EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = h.id ` +
      `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p})))`,
    );
  }
  return b;
}

export interface PoTotals {
  poCount: number;
  lineCount: number;
  totalPoQty: string;
  totalReceivedQty: string;
  totalPendingQty: string;
  value: string;
  pending: string;
  received: string;
  cancelledValue: string;
}

/**
 * The list's totals over the POs `b` selects. Its OWN builder, never the paged
 * query's, whose trailing LIMIT/OFFSET placeholders do not belong to an aggregate.
 *
 * `value` deliberately EXCLUDES cancelled orders so it means exactly what the
 * `po_value_total` metric means (ADR-009 — one definition per KPI). Cancelled
 * value is reported separately so nothing is hidden from the user.
 */
export async function poTotals(b: SqlBuilder): Promise<PoTotals> {
  const totals = await queryOne<PoTotals>(
    `SELECT COUNT(DISTINCT h.id)::int AS "poCount",
            COALESCE(SUM(b.line_count) FILTER (WHERE h.status <> 'CANCELLED'), 0)::int AS "lineCount",
            COALESCE(SUM(b.total_po_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalPoQty",
            COALESCE(SUM(b.total_received_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalReceivedQty",
            COALESCE(SUM(b.total_pending_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalPendingQty",
            COALESCE(SUM(b.total_amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS value,
            COALESCE(SUM(b.pending_amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS pending,
            COALESCE(SUM(b.received_amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS received,
            COALESCE(SUM(b.total_amount) FILTER (WHERE h.status = 'CANCELLED'), 0) AS "cancelledValue"
       ${PO_FROM} ${b.where()}`,
    b.params,
  );
  return totals!;
}
