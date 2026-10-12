import { d, ts, qty } from './common.js';
/* ── Requisition ────────────────────────────────────────────────────────────── */
export const REQUISITION = {
    sheet: 'Requisition',
    description: 'Requisition lines with HOD approval, store issue position and the item\'s live stock — '
        + 'HOD Status and Store Status kept separate.',
    from: `v_requisition_line_balance b
       JOIN requisition_lines   rl ON rl.id = b.requisition_line_id
       JOIN requisition_headers rh ON rh.id = b.requisition_id
       JOIN v_requisition_header_balance hb ON hb.requisition_id = b.requisition_id
       LEFT JOIN items   i          ON i.id = b.item_id
       LEFT JOIN lookups lk_uom     ON lk_uom.id     = b.uom_id
       LEFT JOIN lookups lk_dept    ON lk_dept.id    = rh.department_id
       LEFT JOIN lookups lk_machine ON lk_machine.id = rh.machine_id
       LEFT JOIN lookups lk_cc      ON lk_cc.id      = rh.cost_centre_id
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT ri.issue_slip_no, ', ') AS slip_nos,
                MAX(ri.issue_date)                          AS last_issue_date
           FROM requisition_issue_lines ril
           JOIN requisition_issues      ri ON ri.id = ril.requisition_issue_id
          WHERE ril.requisition_line_id = b.requisition_line_id
       ) iss ON TRUE`,
    orderBy: 'b.requisition_line_id',
    primaryKey: ['Requisition ID', 'Requisition Line ID'],
    columns: [
        { header: 'Requisition ID', expr: 'b.requisition_id', cls: 'D' },
        { header: 'Requisition Line ID', expr: 'b.requisition_line_id', cls: 'D' },
        { header: 'Requisition No', expr: 'b.requisition_no', cls: 'A' },
        { header: 'Requisition Date', expr: d('b.requisition_date'), cls: 'A' },
        { header: 'Requisition Time', expr: 'rh.requisition_time', cls: 'B' },
        { header: 'Sr No', expr: 'b.line_no', cls: 'C' },
        { header: 'Item ID', expr: 'b.item_id', cls: 'D' },
        { header: 'Item Code', expr: 'b.item_code', cls: 'A' },
        { header: 'Item Name', expr: 'b.item_description', cls: 'A' },
        { header: 'Main Group', expr: 'b.main_group_name', cls: 'A' },
        { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
        { header: 'Requested Qty', expr: qty('b.requested_qty'), cls: 'A' },
        { header: 'User ID', expr: 'rh.requester_user_id', cls: 'D' },
        { header: 'Employee Code', expr: 'rh.employee_code', cls: 'A' },
        { header: 'User Name', expr: 'rh.employee_name', cls: 'A' },
        { header: 'Department', expr: "COALESCE(NULLIF(rh.department_name, ''), lk_dept.name)", cls: 'A' },
        { header: 'Machine No', expr: 'lk_machine.code', cls: 'A' },
        { header: 'Cost Centre', expr: 'lk_cc.name', cls: 'B' },
        { header: 'HOD Name', expr: 'rh.hod_name', cls: 'A' },
        { header: 'HOD Status', expr: 'hb.hod_status', cls: 'A' },
        { header: 'HOD Approval Date', expr: ts('rh.hod_decided_at'), cls: 'A' },
        { header: 'Store Status', expr: 'hb.store_status', cls: 'A' },
        { header: 'Issue Slip No(s)', expr: "COALESCE(iss.slip_nos, '')", cls: 'D' },
        // The slip's BUSINESS issue date. The balance view's `last_issue_date` is
        // MAX(created_at) on the issue line — a row-insert stamp, which differs
        // whenever a slip is back-dated or keyed the next morning.
        { header: 'Issue Date', expr: d('iss.last_issue_date'), cls: 'A' },
        { header: 'Issued Qty', expr: qty('b.issued_qty'), cls: 'A' },
        { header: 'Remaining Qty', expr: qty('b.pending_qty'), cls: 'A' },
        { header: 'Excess Qty', expr: qty('b.excess_qty'), cls: 'A' },
        { header: 'Live Stock Qty', expr: qty('i.live_stock_qty'), cls: 'A' },
        { header: 'Line Status', expr: 'b.line_status', cls: 'A' },
        { header: 'Line Remarks', expr: 'rl.remarks', cls: 'B' },
        { header: 'Requisition Remarks', expr: 'rh.remarks', cls: 'B' },
        { header: 'Created At', expr: ts('rh.created_at'), cls: 'B' },
        { header: 'Updated At', expr: ts('rl.updated_at'), cls: 'B' },
    ],
    sources: [
        { table: 'requisition_lines', restrict: 'rl.id::text = ANY($1)' },
        { table: 'requisition_headers', restrict: 'rh.id::text = ANY($1)' },
        {
            table: 'requisition_issue_lines',
            restrict: 'rl.id IN (SELECT requisition_line_id FROM requisition_issue_lines WHERE id::text = ANY($1))',
        },
        {
            table: 'requisition_issues',
            restrict: `rl.id IN (SELECT ril.requisition_line_id FROM requisition_issue_lines ril
                            WHERE ril.requisition_issue_id::text = ANY($1))`,
        },
        // Live Stock Qty moves with every receipt and issue, so an item's stock
        // change refreshes the requisition lines that show it.
        { table: 'items', restrict: 'rl.item_id::text = ANY($1)', fanoutLimit: 200 },
        { table: 'users', restrict: '(rh.requester_user_id::text = ANY($1) OR rh.hod_user_id::text = ANY($1))', fanoutLimit: 200 },
        {
            table: 'lookups',
            restrict: `(rh.department_id::text = ANY($1) OR rh.machine_id::text = ANY($1)
               OR rh.cost_centre_id::text = ANY($1) OR rl.uom_id::text = ANY($1))`,
            fanoutLimit: 200,
        },
    ],
    importTargets: [
        {
            table: 'requisition_headers',
            pk: ['id'],
            fields: {
                'Requisition ID': 'id',
                'Requisition No': 'requisition_no',
                'Requisition Date': 'requisition_date',
                'Requisition Time': 'requisition_time',
                'User ID': 'requester_user_id',
                'Employee Code': 'employee_code',
                'User Name': 'employee_name',
                Department: { column: 'department_id', lookup: 'DEPARTMENT' },
                'Machine No': { column: 'machine_id', lookup: 'MACHINE' },
                'Cost Centre': { column: 'cost_centre_id', lookup: 'COST_CENTRE' },
                'HOD Name': 'hod_name',
                'Requisition Remarks': 'remarks',
                // HOD Status / Store Status are derived from the approval and issue
                // records; the ERP recomputes them rather than trusting a cell.
            },
        },
        {
            table: 'requisition_lines',
            pk: ['id'],
            fields: {
                'Requisition Line ID': 'id',
                'Requisition ID': 'requisition_id',
                'Sr No': 'line_no',
                'Item ID': 'item_id',
                'Item Code': 'item_code',
                'Item Name': 'item_description',
                'Main Group': 'main_group_name',
                UOM: { column: 'uom_id', lookup: 'UOM' },
                'Requested Qty': 'requested_qty',
                'Line Remarks': 'remarks',
            },
        },
    ],
};
/* ── Requisition Issue ──────────────────────────────────────────────────────── */
export const REQUISITION_ISSUE = {
    sheet: 'Requisition Issue',
    description: 'Store issue slip lines — what was actually handed out, against which requisition line.',
    from: `requisition_issue_lines ril
       JOIN requisition_issues   ri ON ri.id = ril.requisition_issue_id
       JOIN requisition_lines    rl ON rl.id = ril.requisition_line_id
       JOIN requisition_headers  rh ON rh.id = ri.requisition_id
       LEFT JOIN users   su         ON su.id = ri.store_user_id
       LEFT JOIN lookups lk_uom     ON lk_uom.id     = ril.uom_id
       LEFT JOIN lookups lk_dept    ON lk_dept.id    = rh.department_id
       LEFT JOIN lookups lk_machine ON lk_machine.id = rh.machine_id`,
    orderBy: 'ril.id',
    primaryKey: ['Issue ID', 'Issue Line ID'],
    columns: [
        { header: 'Issue ID', expr: 'ri.id', cls: 'D' },
        { header: 'Issue Line ID', expr: 'ril.id', cls: 'D' },
        { header: 'Issue Slip No', expr: 'ri.issue_slip_no', cls: 'A' },
        { header: 'Issue Date', expr: d('ri.issue_date'), cls: 'A' },
        { header: 'Issue Time', expr: 'ri.issue_time', cls: 'B' },
        { header: 'Requisition ID', expr: 'ri.requisition_id', cls: 'D' },
        { header: 'Requisition No', expr: 'rh.requisition_no', cls: 'A' },
        { header: 'Requisition Line ID', expr: 'ril.requisition_line_id', cls: 'D' },
        { header: 'Item ID', expr: 'ril.item_id', cls: 'D' },
        { header: 'Item Code', expr: 'rl.item_code', cls: 'A' },
        { header: 'Item Name', expr: 'rl.item_description', cls: 'A' },
        { header: 'Issued Qty', expr: qty('ril.issue_qty'), cls: 'A' },
        { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
        { header: 'Department', expr: "COALESCE(NULLIF(rh.department_name, ''), lk_dept.name)", cls: 'A' },
        { header: 'Machine No', expr: 'lk_machine.code', cls: 'A' },
        { header: 'Issued By', expr: 'su.employee_name', cls: 'A' },
        { header: 'Remarks', expr: 'ril.remarks', cls: 'B' },
        { header: 'Created At', expr: ts('ril.created_at'), cls: 'B' },
    ],
    sources: [
        { table: 'requisition_issue_lines', restrict: 'ril.id::text = ANY($1)' },
        { table: 'requisition_issues', restrict: 'ri.id::text = ANY($1)' },
        { table: 'requisition_lines', restrict: 'ril.requisition_line_id::text = ANY($1)' },
        {
            table: 'requisition_headers',
            restrict: 'ri.requisition_id::text = ANY($1)',
        },
        { table: 'users', restrict: 'ri.store_user_id::text = ANY($1)', fanoutLimit: 200 },
        {
            table: 'lookups',
            restrict: `(ril.uom_id::text = ANY($1) OR rh.department_id::text = ANY($1)
               OR rh.machine_id::text = ANY($1))`,
            fanoutLimit: 200,
        },
    ],
    importTargets: [
        {
            table: 'requisition_issues',
            pk: ['id'],
            fields: {
                'Issue ID': 'id',
                'Issue Slip No': 'issue_slip_no',
                'Requisition ID': 'requisition_id',
                'Issue Date': 'issue_date',
                'Issue Time': 'issue_time',
                'Issued By': 'store_user_id',
            },
        },
        {
            table: 'requisition_issue_lines',
            pk: ['id'],
            fields: {
                'Issue Line ID': 'id',
                'Issue ID': 'requisition_issue_id',
                'Requisition Line ID': 'requisition_line_id',
                'Item ID': 'item_id',
                'Issued Qty': 'issue_qty',
                UOM: { column: 'uom_id', lookup: 'UOM' },
                Remarks: 'remarks',
            },
        },
    ],
};
/* ── Stock Ledger ───────────────────────────────────────────────────────────── */
/**
 * `Rate` is deliberately absent: `stock_ledger` has no rate column, and the
 * brief asks not to invent fields that do not exist. Valuation is reconstructed
 * from the GRN tab through Reference No.
 */
export const STOCK_LEDGER = {
    sheet: 'Stock Ledger',
    description: 'Every stock movement — in, out and balance — with the document that caused it.',
    from: `stock_ledger sl
       JOIN items i ON i.id = sl.item_id
       LEFT JOIN lookups lk_uom ON lk_uom.id = sl.uom_id`,
    orderBy: 'sl.id',
    primaryKey: ['Stock Txn ID'],
    appendOnly: true,
    columns: [
        { header: 'Stock Txn ID', expr: 'sl.id', cls: 'D' },
        { header: 'Date', expr: d('sl.txn_date'), cls: 'A' },
        { header: 'Transaction Type', expr: 'sl.txn_type', cls: 'A' },
        { header: 'Reference Type', expr: 'sl.reference_type', cls: 'D' },
        { header: 'Reference ID', expr: 'sl.reference_id', cls: 'D' },
        { header: 'Reference No', expr: 'sl.reference_no', cls: 'D' },
        { header: 'Item ID', expr: 'sl.item_id', cls: 'D' },
        { header: 'Item Code', expr: 'i.item_code', cls: 'A' },
        { header: 'Item Description', expr: 'i.item_description', cls: 'A' },
        { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
        { header: 'In Qty', expr: qty('sl.inward_qty'), cls: 'A' },
        { header: 'Out Qty', expr: qty('sl.outward_qty'), cls: 'A' },
        { header: 'Balance Qty', expr: qty('sl.balance_qty'), cls: 'A' },
        { header: 'Location', expr: 'sl.location', cls: 'B' },
        { header: 'Batch', expr: 'sl.batch_no', cls: 'B' },
        { header: 'MLN', expr: 'sl.mln_no', cls: 'D' },
        { header: 'Created At', expr: ts('sl.created_at'), cls: 'B' },
    ],
    sources: [
        { table: 'stock_ledger', restrict: 'sl.id::text = ANY($1)' },
        { table: 'items', restrict: 'sl.item_id::text = ANY($1)', fanoutLimit: 200 },
    ],
    // No importTargets: the stock ledger is the ERP's own arithmetic. Historical
    // stock is restored by importing the TRANSACTIONS (GRN, issues), after which
    // the ERP rebuilds the ledger and live stock itself — which is the brief's
    // rule that Google must not overwrite authoritative calculated values.
};
export const STORE_VIEWS = [REQUISITION, REQUISITION_ISSUE, STOCK_LEDGER];
//# sourceMappingURL=stores.js.map