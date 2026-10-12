/**
 * The RBAC catalogue (SRS §5, §18).
 *
 * This file is the single source of truth for what permissions exist and which
 * roles hold them by default. The seeder reconciles the database against it, so
 * adding a permission here and re-running `npm run seed` provisions it everywhere.
 */
export const ACTIONS = [
    'view', 'create', 'edit', 'delete', 'approve', 'reject', 'issue',
    'export', 'import', 'print', 'analyze', 'admin',
];
const MODULES = [
    {
        module: 'dashboard',
        label: 'Management Analysis',
        actions: {
            view: 'Open the management dashboard',
            analyze: 'Use analytics, filters and drill-down',
            export: 'Export or snapshot dashboards',
        },
    },
    {
        module: 'item',
        label: 'Item Master',
        actions: {
            view: 'View items', create: 'Create items', edit: 'Edit items',
            delete: 'Deactivate/delete items', import: 'Import items', export: 'Export items',
        },
    },
    {
        module: 'supplier',
        label: 'Supplier Master',
        actions: {
            view: 'View suppliers', create: 'Create suppliers', edit: 'Edit suppliers',
            delete: 'Deactivate/delete suppliers', import: 'Import suppliers', export: 'Export suppliers',
        },
    },
    {
        module: 'lookup',
        label: 'Supporting Masters',
        actions: {
            view: 'View PO Type, Indent Type, Cost Centre, Department, UOM and groups',
            create: 'Create supporting master values',
            edit: 'Edit supporting master values',
            delete: 'Deactivate supporting master values',
            import: 'Import supporting masters',
            export: 'Export supporting masters',
        },
    },
    {
        module: 'indent',
        label: 'Purchase Indent',
        actions: {
            view: 'View indents', create: 'Create indents', edit: 'Edit draft indents',
            delete: 'Delete draft indents', approve: 'Approve indents', reject: 'Reject indents',
            export: 'Export indents', print: 'Print indents', analyze: 'Indent analysis',
        },
    },
    {
        module: 'po',
        label: 'Purchase Order',
        actions: {
            view: 'View purchase orders', create: 'Create purchase orders', edit: 'Edit draft POs',
            delete: 'Delete draft POs', approve: 'Issue, short-close or cancel POs',
            export: 'Export POs', print: 'Print POs', analyze: 'PO analysis',
        },
    },
    {
        module: 'grn',
        label: 'GRN',
        actions: {
            view: 'View GRNs', create: 'Create GRNs', edit: 'Edit draft GRNs',
            delete: 'Delete draft GRNs', approve: 'Post or cancel GRNs',
            export: 'Export GRNs', print: 'Print GRNs', analyze: 'GRN analysis',
        },
    },
    {
        module: 'requisition',
        label: 'Requisition',
        actions: {
            view: 'View requisitions', create: 'Create/submit requisitions',
            edit: 'Edit own draft/pending/returned requisitions',
            delete: 'Delete draft requisitions',
            approve: 'HOD approve, reject, return or unapprove requisitions',
            issue: 'Store: issue material against an approved requisition',
            export: 'Export requisitions', print: 'Print requisitions/issue slips', analyze: 'Requisition analysis',
        },
    },
    {
        module: 'user',
        label: 'User Management',
        actions: {
            view: 'View users', create: 'Create users', edit: 'Edit users',
            delete: 'Deactivate users', export: 'Export users', import: 'Import users',
        },
    },
    {
        module: 'role',
        label: 'Role & Permission Management',
        actions: {
            view: 'View roles and permissions', create: 'Create roles',
            edit: 'Edit roles and grant permissions', delete: 'Delete roles',
        },
    },
    {
        module: 'audit',
        label: 'Audit Log',
        actions: { view: 'View the audit trail', export: 'Export audit records' },
    },
    {
        module: 'sync',
        label: 'Google Sheets Sync',
        actions: {
            view: 'View sync status and history',
            admin: 'Turn sync on/off, run a sync, resolve conflicts',
        },
    },
    {
        module: 'backup',
        label: 'Backup & Restore',
        actions: { view: 'View backups', create: 'Create a backup', admin: 'Restore or delete a backup' },
    },
    {
        module: 'system',
        label: 'System Administration',
        actions: { admin: 'Manage settings and system configuration' },
    },
];
export const PERMISSIONS = MODULES.flatMap((m) => Object.entries(m.actions).map(([action, description]) => ({
    code: `${m.module}.${action}`,
    module: m.module,
    action,
    label: `${m.label} — ${action}`,
    description,
})));
export const PERMISSION_CODES = PERMISSIONS.map((p) => p.code);
export const MODULE_LABELS = Object.fromEntries(MODULES.map((m) => [m.module, m.label]));
const viewAll = (modules) => modules.map((m) => `${m}.view`);
export const ROLES = [
    {
        code: 'SUPER_ADMIN',
        name: 'Super Admin',
        description: 'Unrestricted system administration, security configuration and data management.',
        permissions: '*',
    },
    {
        code: 'PURCHASE_HEAD',
        name: 'Purchase Head',
        description: 'Approves or rejects purchase indents and performs authorised purchasing analysis.',
        permissions: [
            'dashboard.view', 'dashboard.analyze', 'dashboard.export',
            ...viewAll(['item', 'supplier', 'lookup', 'audit', 'sync']),
            'indent.view', 'indent.create', 'indent.edit', 'indent.approve', 'indent.reject',
            'indent.export', 'indent.print', 'indent.analyze',
            'po.view', 'po.create', 'po.edit', 'po.approve', 'po.export', 'po.print', 'po.analyze',
            'grn.view', 'grn.export', 'grn.print', 'grn.analyze',
            'item.export', 'supplier.export',
            // A Purchase Head is very often ALSO a department HOD — same
            // "explicit permission, never a blanket role check" self-approval
            // policy as Indent applies here (requisition/routes.ts).
            'requisition.view', 'requisition.create', 'requisition.edit', 'requisition.approve',
            'requisition.export', 'requisition.print', 'requisition.analyze',
        ],
    },
    {
        code: 'PURCHASE_USER',
        name: 'Purchase User',
        description: 'Creates and manages permitted indents and purchase orders.',
        permissions: [
            'dashboard.view', 'dashboard.analyze',
            ...viewAll(['item', 'supplier', 'lookup']),
            'indent.view', 'indent.create', 'indent.edit', 'indent.delete',
            'indent.export', 'indent.print', 'indent.analyze',
            'po.view', 'po.create', 'po.edit', 'po.delete', 'po.export', 'po.print', 'po.analyze',
            'grn.view', 'grn.print',
            'item.create', 'item.edit', 'supplier.create', 'supplier.edit',
            'requisition.view', 'requisition.create', 'requisition.edit', 'requisition.print',
        ],
    },
    {
        code: 'STORE_USER',
        name: 'Store User',
        description: 'Manages authorised GRN and store receipt activities, and issues material against approved requisitions.',
        permissions: [
            'dashboard.view',
            ...viewAll(['item', 'supplier', 'lookup']),
            'indent.view',
            'po.view', 'po.print',
            'grn.view', 'grn.create', 'grn.edit', 'grn.delete', 'grn.approve',
            'grn.export', 'grn.print', 'grn.analyze',
            'requisition.view', 'requisition.create', 'requisition.edit', 'requisition.issue',
            'requisition.print', 'requisition.analyze',
        ],
    },
    {
        code: 'MANAGEMENT',
        name: 'Management',
        description: 'Read-only analytical access with full drill-down to source transactions.',
        permissions: [
            'dashboard.view', 'dashboard.analyze', 'dashboard.export',
            ...viewAll(['item', 'supplier', 'lookup', 'indent', 'po', 'grn', 'audit', 'sync', 'requisition']),
            'indent.analyze', 'po.analyze', 'grn.analyze', 'requisition.analyze',
            'indent.export', 'po.export', 'grn.export', 'requisition.export',
            'indent.print', 'po.print', 'grn.print', 'requisition.print',
        ],
    },
    {
        code: 'VIEWER',
        name: 'Viewer',
        description: 'Read-only access to permitted screens.',
        permissions: [
            'dashboard.view',
            ...viewAll(['item', 'supplier', 'lookup', 'indent', 'po', 'grn', 'requisition']),
        ],
    },
    {
        code: 'EMPLOYEE',
        name: 'Employee',
        description: 'General staff baseline: raise material requisitions for their own department, and — where their ' +
            'department\'s HOD mapping names them specifically — review and decide their department\'s requisitions.',
        permissions: [
            'dashboard.view',
            ...viewAll(['item', 'lookup']),
            'requisition.view', 'requisition.create', 'requisition.edit', 'requisition.delete',
            // Holding this does NOT make someone an approver for every requisition —
            // requisition/routes.ts additionally requires actorId === the specific
            // requisition's resolved hod_user_id (or Super Admin), exactly like the
            // Indent self-approval exception. An ordinary Employee whose department
            // maps to someone else is refused just the same as a wrong HOD.
            'requisition.approve', 'requisition.print',
        ],
    },
];
/** Roles that always hold every permission, regardless of grants in the database. */
export const OMNIPOTENT_ROLES = new Set(['SUPER_ADMIN']);
//# sourceMappingURL=permissions.js.map