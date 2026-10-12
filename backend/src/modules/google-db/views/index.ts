/**
 * The business tab registry — ELEVEN tabs, in the order they appear in the
 * spreadsheet.
 *
 * The previous layout had 27 business tabs. Fourteen of them (Department, Cost
 * Centre, Machine, Item Type, Main Group, Sub Main Group, UOM, Currency,
 * Payment Terms, PO/Indent/GRN Type, State, City) were not fourteen tables —
 * they were fourteen values of `lookups.category` in ONE table, and are now one
 * tab. Three approval/audit tabs and a traceability tab became one History &
 * Audit tab, because they describe the same fact and the traceability links
 * already live on the document rows.
 *
 * Order matters twice: it is the tab order a person sees, and it is the order a
 * full export walks, so masters are written before the documents that reference
 * them.
 */
import type { BusinessView } from './types.js';
import { ITEM_MASTER, SUPPLIER_MASTER, USER_MASTER, LOOKUP_CONFIG, PURCHASE_TYPE_MASTER } from './masters.js';
import { PURCHASE_INDENT, PURCHASE_ORDER, GRN } from './purchasing.js';
import { REQUISITION, REQUISITION_ISSUE, STOCK_LEDGER } from './stores.js';
import { HISTORY_AUDIT } from './history.js';

export const BUSINESS_VIEWS: BusinessView[] = [
  ITEM_MASTER,
  SUPPLIER_MASTER,
  PURCHASE_TYPE_MASTER,
  PURCHASE_INDENT,
  PURCHASE_ORDER,
  GRN,
  REQUISITION,
  REQUISITION_ISSUE,
  STOCK_LEDGER,
  USER_MASTER,
  LOOKUP_CONFIG,
  HISTORY_AUDIT,
];

const bySheet = new Map(BUSINESS_VIEWS.map((v) => [v.sheet, v]));

export function viewBySheet(sheet: string): BusinessView | undefined {
  return bySheet.get(sheet);
}

/** Every SQL table any tab reads — the set the change triggers must cover. */
export function mirroredTables(): string[] {
  return [...new Set(BUSINESS_VIEWS.flatMap((v) => v.sources.map((s) => s.table)))].sort();
}

export {
  ITEM_MASTER, SUPPLIER_MASTER, USER_MASTER, LOOKUP_CONFIG,
  PURCHASE_INDENT, PURCHASE_ORDER, GRN,
  REQUISITION, REQUISITION_ISSUE, STOCK_LEDGER,
  HISTORY_AUDIT,
};
