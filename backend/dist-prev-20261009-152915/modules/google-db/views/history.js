import { ts } from './common.js';
/** Audit entities that are infrastructure or security noise, never business history. */
const EXCLUDED_AUDIT_ENTITIES = [
    'auth', 'google_sync', 'google_db', 'backup', 'database', 'database_export', 'seed', 'app_setting',
];
const excluded = EXCLUDED_AUDIT_ENTITIES.map((e) => `'${e}'`).join(', ');
export const HISTORY_AUDIT = {
    sheet: 'History & Audit',
    description: 'Approval history and the business audit trail in one place — who did what, to which document, when.',
    from: `(
         SELECT 'INDENT_APPROVAL'::text AS source, ia.id AS history_id,
                'PURCHASE_INDENT'::text AS entity_type, ia.indent_id AS entity_id,
                ih.indent_no AS document_no, ia.action, ia.from_status, ia.to_status,
                ia.reason AS detail, ia.actor_user_id, ia.created_at
           FROM indent_approvals ia
           JOIN purchase_indent_headers ih ON ih.id = ia.indent_id
         UNION ALL
         SELECT 'REQUISITION_APPROVAL', ra.id,
                'REQUISITION', ra.requisition_id,
                rh.requisition_no, ra.action, ra.from_status, ra.to_status,
                ra.reason, ra.actor_user_id, ra.created_at
           FROM requisition_approvals ra
           JOIN requisition_headers rh ON rh.id = ra.requisition_id
         UNION ALL
         SELECT 'AUDIT', al.id,
                upper(al.entity), NULLIF(al.entity_id, '')::bigint,
                al.entity_label, al.action, NULL, al.result,
                al.message, al.actor_user_id, al.created_at
           FROM audit_logs al
          WHERE al.entity NOT IN (${excluded})
       ) h
       LEFT JOIN users au ON au.id = h.actor_user_id`,
    orderBy: 'h.created_at, h.source, h.history_id',
    primaryKey: ['Source', 'History ID'],
    appendOnly: true,
    columns: [
        { header: 'Source', expr: 'h.source', cls: 'D' },
        { header: 'History ID', expr: 'h.history_id', cls: 'D' },
        { header: 'Entity Type', expr: 'h.entity_type', cls: 'A' },
        { header: 'Entity ID', expr: 'h.entity_id', cls: 'D' },
        { header: 'Document No', expr: 'h.document_no', cls: 'A' },
        { header: 'Action', expr: 'h.action', cls: 'A' },
        { header: 'From Status', expr: 'h.from_status', cls: 'B' },
        { header: 'To Status', expr: 'h.to_status', cls: 'B' },
        { header: 'Detail', expr: 'h.detail', cls: 'B' },
        { header: 'Changed By ID', expr: 'h.actor_user_id', cls: 'D' },
        { header: 'Changed By', expr: 'au.employee_name', cls: 'A' },
        { header: 'Changed At', expr: ts('h.created_at'), cls: 'A' },
    ],
    sources: [
        // Each predicate carries its own `source` literal, so the planner prunes the
        // other UNION ALL branches and drives the surviving one off its primary key
        // instead of materialising the whole history.
        { table: 'indent_approvals', restrict: "h.source = 'INDENT_APPROVAL' AND h.history_id::text = ANY($1)" },
        { table: 'requisition_approvals', restrict: "h.source = 'REQUISITION_APPROVAL' AND h.history_id::text = ANY($1)" },
        { table: 'audit_logs', restrict: "h.source = 'AUDIT' AND h.history_id::text = ANY($1)" },
        { table: 'users', restrict: 'h.actor_user_id::text = ANY($1)', fanoutLimit: 200 },
    ],
    // No importTargets. History is a record of what the ERP did; a spreadsheet
    // must not be able to write an approval that never happened.
};
export const HISTORY_VIEWS = [HISTORY_AUDIT];
export { EXCLUDED_AUDIT_ENTITIES };
//# sourceMappingURL=history.js.map