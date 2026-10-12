import { ITEM_MASTER, SUPPLIER_MASTER, USER_MASTER, LOOKUP_CONFIG, PURCHASE_TYPE_MASTER } from './masters.js';
import { PURCHASE_INDENT, PURCHASE_ORDER, GRN } from './purchasing.js';
import { REQUISITION, REQUISITION_ISSUE, STOCK_LEDGER } from './stores.js';
import { HISTORY_AUDIT } from './history.js';
export const BUSINESS_VIEWS = [
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
export function viewBySheet(sheet) {
    return bySheet.get(sheet);
}
/** Every SQL table any tab reads — the set the change triggers must cover. */
export function mirroredTables() {
    return [...new Set(BUSINESS_VIEWS.flatMap((v) => v.sources.map((s) => s.table)))].sort();
}
export { ITEM_MASTER, SUPPLIER_MASTER, USER_MASTER, LOOKUP_CONFIG, PURCHASE_INDENT, PURCHASE_ORDER, GRN, REQUISITION, REQUISITION_ISSUE, STOCK_LEDGER, HISTORY_AUDIT, };
//# sourceMappingURL=index.js.map