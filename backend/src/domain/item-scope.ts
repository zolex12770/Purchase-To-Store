/**
 * Item-level filters select document LINES, not whole documents.
 *
 * A purchase order, GRN or indent carries lines of several items, and the item, its
 * department, cost centre, main group, sub group and type, and its department's HOD all
 * belong to the line. A filter on any of them therefore names lines: a list keeps the
 * documents holding such a line, its total tiles add up only those lines, its lines
 * export holds only those lines, and the dashboard KPIs and charts count the same lines.
 * One line must satisfy every item-level filter at once.
 *
 * Mixing the two readings made a KPI card and the list it opens disagree (2026-10-17
 * review of the F09 fix): filtered to one department, a PO whose only pending line
 * belonged to another department counted 0 Pending POs on the dashboard, while the
 * Pending PO list the card opened showed that PO with 50.00 pending, because the list
 * asked "any line of the department" and "any pending line" of two different lines.
 */
import type { SqlBuilder } from '../db/index.js';

/** The item-level filters a document list may offer. */
export interface ItemLineFilter {
  itemId?: number[];
  departmentId?: number[];
  costCentreId?: number[];
  mainGroupId?: number[];
  subMainGroupId?: number[];
  itemTypeId?: number[];
  hodId?: number[];
}

/**
 * The lines the item-level filters in `f` select, as a condition on `line` (any row
 * with an `item_id`: a document line table or its balance view), or '' when none is
 * set. Item-master dimensions are read from the Item Master as it stands. Parameters
 * are pushed onto `b`, so the condition may be repeated in several subqueries.
 */
export function itemLineScope(f: ItemLineFilter, b: SqlBuilder, line: string): string {
  const conds: string[] = [];
  if (f.itemId?.length) conds.push(`${line}.item_id = ANY(${b.push(f.itemId)})`);
  const master: string[] = [];
  for (const [column, ids] of [
    ['department_id', f.departmentId], ['cost_centre_id', f.costCentreId], ['main_group_id', f.mainGroupId],
    ['sub_main_group_id', f.subMainGroupId], ['item_type_id', f.itemTypeId],
  ] as const) {
    if (ids?.length) master.push(`si.${column} = ANY(${b.push(ids)})`);
  }
  if (f.hodId?.length) {
    master.push(`EXISTS (SELECT 1 FROM lookups sd WHERE sd.id = si.department_id AND (sd.extra->>'hodUserId')::bigint = ANY(${b.push(f.hodId)}))`);
  }
  if (master.length) conds.push(`EXISTS (SELECT 1 FROM items si WHERE si.id = ${line}.item_id AND ${master.join(' AND ')})`);
  return conds.join(' AND ');
}
