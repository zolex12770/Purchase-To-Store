/**
 * Seeding & bootstrap.
 *
 * Two distinct concerns, deliberately separated:
 *
 *  1. `seedSystem()`  — idempotent reconciliation of things the application cannot
 *     run without: the permission catalogue, the default roles, the bootstrap
 *     administrators, app settings, sheet mappings and universal units. Safe to run
 *     on every boot.
 *
 *  2. `seedDemoData()` — synthetic sample transactions so the analytics, drill-down
 *     and workflow screens can be exercised immediately. EVERY row it creates is
 *     tagged `extra.seed = 'demo'` / remarks prefixed `[DEMO]` so it is never
 *     mistaken for real business data (build brief §46, §52). Removable with
 *     `npm run db:reset`.
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { query, queryOne, withTransaction, txQuery, txQueryOne, type Queryable } from './index.js';
import { PERMISSIONS, ROLES } from '../auth/permissions.js';
import { hashPassword } from '../auth/tokens.js';
import { logger } from '../core/logger.js';
import { env } from '../config/env.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../domain/numbering.js';
import { finalRate, lineAmount, toQty, toRate } from '../domain/money.js';

/**
 * The real ZOLEX/Zeeta logo, embedded as a data URI default for
 * `company.logo_data_uri` (read once at seed time, not on every print — the
 * database, not this file, is what every document renderer actually reads).
 * Read relative to this compiled module's own location, so the same relative
 * path (`../assets/zolex-logo.png`) resolves correctly under both `tsx`
 * (running from `src/`) and the built `dist/` tree (`package.json`'s build
 * script copies `src/assets` alongside `dist/db`).
 */
function loadDefaultLogoDataUri(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const logoPath = join(here, '../assets/zolex-logo.png');
    if (!existsSync(logoPath)) return '';
    return `data:image/png;base64,${readFileSync(logoPath).toString('base64')}`;
  } catch {
    return '';
  }
}

/* ── Deterministic pseudo-randomness ────────────────────────────────────────── */
/** Seeded LCG so a reseed produces identical demo data (reproducible tests). */
function makeRng(seed = 20260824) {
  let s = seed >>> 0;
  return {
    next(): number {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 0x100000000;
    },
    int(min: number, max: number): number {
      return min + Math.floor(this.next() * (max - min + 1));
    },
    pick<T>(arr: readonly T[]): T {
      return arr[Math.floor(this.next() * arr.length)] as T;
    },
    chance(p: number): boolean {
      return this.next() < p;
    },
  };
}

/* ─────────────────────────── 1. SYSTEM SEED ────────────────────────────────── */

/**
 * Reconciles the permission catalogue and returns the codes that did not exist
 * before this run — a fresh database, or rights added by a new release.
 */
async function seedPermissions(): Promise<Set<string>> {
  const existing = new Set((await query<{ code: string }>('SELECT code FROM permissions')).map((r) => r.code));
  for (const [i, p] of PERMISSIONS.entries()) {
    await query(
      `INSERT INTO permissions (code, module, action, label, description, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (code) DO UPDATE
         SET module = EXCLUDED.module, action = EXCLUDED.action,
             label = EXCLUDED.label, description = EXCLUDED.description,
             sort_order = EXCLUDED.sort_order`,
      [p.code, p.module, p.action, p.label, p.description, i],
    );
  }
  logger.info(`  · permissions reconciled (${PERMISSIONS.length})`);
  return new Set(PERMISSIONS.map((p) => p.code).filter((code) => !existing.has(code)));
}

/**
 * Creates the system roles and gives each its default rights.
 *
 * Defaults are granted ONCE: to a role that is being created now, and — for a
 * role that already exists — only for rights that are new to the catalogue.
 * This used to re-grant every default on every start, so a right an
 * administrator had removed from a system role on the Roles screen silently
 * came back at the next restart of the server.
 *
 * Consequence for future releases: changing the DEFAULT list of an existing
 * role in auth/permissions.ts no longer reaches databases where that role
 * already exists (only brand-new permission codes do). Ship such a change as a
 * migration, or have an administrator grant it on the Roles screen.
 *
 * SUPER_ADMIN is the exception: it holds everything by definition
 * (auth/middleware) and cannot be edited, so it is always granted in full to
 * keep the Role Management screen an honest picture.
 */
async function seedRoles(newPermissionCodes: Set<string>): Promise<void> {
  const existingRoles = new Set((await query<{ code: string }>('SELECT code FROM roles')).map((r) => r.code));

  for (const role of ROLES) {
    await query(
      `INSERT INTO roles (code, name, description, is_system)
       VALUES ($1,$2,$3,TRUE)
       ON CONFLICT (code) DO UPDATE
         SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = now()`,
      [role.code, role.name, role.description],
    );

    const roleRow = await queryOne<{ id: number }>('SELECT id FROM roles WHERE code = $1', [role.code]);
    if (!roleRow) continue;

    const defaults = role.permissions === '*' ? PERMISSIONS.map((p) => p.code) : role.permissions;
    const codes = role.permissions === '*' || !existingRoles.has(role.code)
      ? defaults
      : defaults.filter((code) => newPermissionCodes.has(code));
    if (codes.length === 0) continue;

    await query(
      `INSERT INTO role_permissions (role_id, permission_id)
       SELECT $1, p.id FROM permissions p
        WHERE p.code = ANY($2)
       ON CONFLICT DO NOTHING`,
      [roleRow.id, codes],
    );
  }
  logger.info(`  · roles reconciled (${ROLES.length})`);
}

/**
 * Bootstrap administrators (SRS §6).
 * Created with `must_change_password = true` — the API refuses every non-auth route
 * for such a user until the password is rotated (R-07).
 */
const BOOTSTRAP_ADMINS = [
  { employeeId: '10221', name: 'System Administrator', designation: 'Super Admin' },
  { employeeId: '10422', name: 'Secondary Administrator', designation: 'Super Admin' },
];

async function seedBootstrapUsers(): Promise<void> {
  const hash = await hashPassword('Admin@12345');
  for (const admin of BOOTSTRAP_ADMINS) {
    const existing = await queryOne<{ id: number }>(
      'SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL',
      [admin.employeeId],
    );
    if (existing) continue;

    const user = await queryOne<{ id: number }>(
      `INSERT INTO users (employee_id, employee_name, designation, password_hash,
                          is_active, must_change_password)
       VALUES ($1,$2,$3,$4,TRUE,FALSE)
       RETURNING id`,
      [admin.employeeId, admin.name, admin.designation, hash],
    );
    if (!user) continue;

    await query(
      `INSERT INTO user_roles (user_id, role_id)
       SELECT $1, id FROM roles WHERE code = 'SUPER_ADMIN'
       ON CONFLICT DO NOTHING`,
      [user.id],
    );
    logger.info(`  · bootstrap Super Admin created: ${admin.employeeId} (password change required)`);
  }
}

const DEFAULT_SETTINGS: { key: string; value: unknown; description: string }[] = [
  { key: 'google_sync.enabled', value: false, description: 'Google Sheets Live Sync master switch (header toggle).' },
  { key: 'google_sync.interval_minutes', value: 15, description: 'Poll interval while sync is ON.' },
  { key: 'google_sync.sheet_id', value: env.GOOGLE_SHEET_ID, description: 'Source spreadsheet ID.' },
  { key: 'company.name', value: 'Zeeta Electrical Engineering Pvt. Ltd.', description: 'Legal entity name on reports and prints.' },
  { key: 'company.brand', value: 'ZOLEX', description: 'Product brand shown in the application shell.' },
  {
    key: 'company.address', value: 'Survey No.124,118, Near Zydus Cadila, Opp. L & T Ltd., Chancharvadi, Mataji Na Patiya, Sarkhej Bavla Road, Ta. Sanand, Ahmedabad, INDIA',
    description: 'Registered address printed on purchase orders.',
  },
  { key: 'company.gst_no', value: '', description: 'Company GST number for printed documents.' },
  { key: 'company.phone', value: '9099947215', description: 'Company phone number for printed documents.' },
  { key: 'company.fax', value: '00912717251794', description: 'Company fax number for printed documents.' },
  { key: 'company.tagline', value: 'Connecting Electrical World', description: 'Brand tagline shown under the logo on printed documents.' },
  {
    key: 'company.logo_data_uri', value: loadDefaultLogoDataUri(),
    description: 'Company logo as a data:image/... URI, embedded on printed documents (PO, Requisition, Issue Slip). Empty shows a placeholder mark instead.',
  },
  { key: 'defaults.currency', value: 'INR', description: 'Default transaction currency.' },
  { key: 'backup.retention_days', value: 30, description: 'Minimum age before a backup may be pruned.' },
  { key: 'backup.retention_count', value: 50, description: 'Minimum number of backups always retained.' },
  { key: 'po.allow_over_order', value: false, description: 'Permit PO quantity above the eligible indent quantity.' },
  { key: 'grn.allow_over_receipt', value: false, description: 'Permit GRN quantity above the outstanding PO quantity.' },
  {
    key: 'form_fields.indent.remarks_visible', value: false,
    description: 'Show the optional Remarks field on the Purchase Indent form. Off by default — Remarks is not part of the core Indent field contract.',
  },
  {
    key: 'form_fields.indent.required_by_visible', value: true,
    description: 'Show the optional Expected Date (Required By) field on the Purchase Indent form.',
  },
];

async function seedSettings(): Promise<void> {
  for (const s of DEFAULT_SETTINGS) {
    await query(
      `INSERT INTO app_settings (key, value, description)
       VALUES ($1, $2::jsonb, $3)
       ON CONFLICT (key) DO UPDATE SET description = EXCLUDED.description`,
      [s.key, JSON.stringify(s.value), s.description],
    );
  }
  logger.info(`  · settings reconciled (${DEFAULT_SETTINGS.length})`);
}

/**
 * Declarative Google Sheet → entity mappings with header ALIASES (ADR-006).
 * `sync_order` guarantees masters land before the transactions that reference them.
 */
const SHEET_MAPPINGS = [
  {
    sheet: 'Item Master', entity: 'items', order: 30, keys: ['item_code'],
    columns: [
      { field: 'item_code', headers: ['Item Code'], required: true },
      { field: 'item_description', headers: ['Item Description', 'item Description', 'Item Name'], required: true },
      // The live sheet has BOTH columns and fills only "Item Name" on a third of
      // its rows — read separately so the engine can fall back to it per row.
      { field: 'item_name', headers: ['Item Name'] },
      { field: 'item_type', headers: ['Item Type'], lookup: 'ITEM_TYPE' },
      { field: 'department', headers: ['Department'], lookup: 'DEPARTMENT' },
      { field: 'cost_centre', headers: ['Cost Centre', 'Cost Center'], lookup: 'COST_CENTRE' },
      { field: 'main_group', headers: ['Main Group', 'Category'], lookup: 'MAIN_GROUP' },
      { field: 'sub_main_group', headers: ['Sub Main Group', 'Sub Category'], lookup: 'SUB_MAIN_GROUP' },
      { field: 'hsn_code', headers: ['HSN Code'] },
      { field: 'source_date', headers: ['date', 'Date'] },
      { field: 'source_time', headers: ['time', 'Time'] },
      { field: 'indent_type', headers: ['Indent Type'], lookup: 'INDENT_TYPE' },
      // The live sheet heads this column "Unit".
      { field: 'uom', headers: ['UOM', 'Uom', 'Unit'], lookup: 'UOM' },
      { field: 'item_specification', headers: ['Item Specification'] },
      // Set B additions (docs/FINAL_GAP_AUDIT.md §4) — stock planning fields.
      { field: 'min_stock', headers: ['Min', 'Min Stock'], numeric: true },
      { field: 'max_stock', headers: ['Max', 'Max Stock'], numeric: true },
      { field: 'reorder_level', headers: ['Reorder Level'], numeric: true },
      { field: 'reorder_qty', headers: ['Reorder Qty'], numeric: true },
      { field: 'is_active', headers: ['Is Active'] },
      { field: 'standard_rate', headers: ['Rate'], numeric: true },
      { field: 'gst_rate', headers: ['GST Rate'], numeric: true },
      { field: 'qc_required', headers: ['QC Required', 'QC required', 'QC Required?'] },
    ],
  },
  {
    sheet: 'Supplier Master', entity: 'suppliers', order: 20, keys: ['supplier_code', 'supplier_name'],
    columns: [
      // Set B makes Supplier Code the natural key; a sheet without one still
      // works exactly as before (auto-generated, matched by name).
      { field: 'supplier_code', headers: ['Supplier Code'] },
      { field: 'supplier_name', headers: ['Supplier Name'], required: true },
      { field: 'address', headers: ['Address'] },
      { field: 'state', headers: ['State'] },
      { field: 'city', headers: ['City'] },
      { field: 'country', headers: ['Country'] },
      { field: 'mobile_no', headers: ['Mobile No.', 'Mobile No', 'Phone'] },
      // The live sheet's own spellings: "Email ID", "Currancy", "Zip".
      { field: 'email', headers: ['Gmail ID', 'Email', 'Email ID'] },
      { field: 'gst_no', headers: ['GST No', 'GST No.'] },
      { field: 'contact_person', headers: ['Contact Person'] },
      { field: 'pin_code', headers: ['Pin Code', 'Zip'] },
      { field: 'is_active', headers: ['Is Active'] },
      { field: 'payment_terms', headers: ['Payment Terms'] },
      { field: 'currency_code', headers: ['Currency', 'Currancy'] },
    ],
  },
  {
    // ONE combined tab, three columns — not three tabs. Each column is the
    // option list of its own form field (Indent / GRN / PO), read into its own
    // lookup category by the engine's `document_types` handler. The separate
    // 'PO Type' and 'Indent Type' tabs this replaces do not exist in the
    // spreadsheet; every run reported them as "not found" and the GRN Type
    // dropdown stayed empty.
    sheet: 'Indent / PO / GRN Type', entity: 'document_types', order: 10,
    keys: ['indent_type', 'grn_type', 'po_type'],
    columns: [
      { field: 'indent_type', headers: ['Indent Type'], lookup: 'INDENT_TYPE' },
      { field: 'grn_type', headers: ['GRN Type'], lookup: 'GRN_TYPE' },
      { field: 'po_type', headers: ['PO Type'], lookup: 'PO_TYPE' },
    ],
    notes: 'Each column feeds its own dropdown. A value no longer listed is switched off, never deleted, so documents that already carry it keep showing it.',
  },
  {
    // ADR-006 — the supplied sheet's header appears to be a typo ('Indent Type').
    // Both spellings are accepted; no special case anywhere in the sync engine.
    sheet: 'Cost Center', entity: 'lookups:COST_CENTRE', order: 10, keys: ['name'],
    columns: [
      { field: 'code', headers: ['Cost Centre Code'] },
      { field: 'name', headers: ['Cost Center', 'Cost Centre', 'Cost Centre Name', 'Indent Type'], required: true },
      { field: 'is_active', headers: ['Is Active'] },
    ],
    notes: 'Header alias absorbs the source-sheet naming defect flagged in SRS §9/§44.',
  },
  {
    sheet: 'User Master', entity: 'users', order: 15, keys: ['employee_id'],
    columns: [
      { field: 'employee_id', headers: ['Employee ID', 'Employee Code'], required: true },
      { field: 'employee_name', headers: ['Employee Name', 'Full Name'], required: true },
      { field: 'designation', headers: ['Designation'] },
      // Set B additions. Role and Is Active are deliberately NOT mapped here —
      // account activation and role grants stay ERP-owned security decisions,
      // never set by a spreadsheet (see the comment on syncUserRow).
      { field: 'email', headers: ['Email'] },
      { field: 'department', headers: ['Department'], lookup: 'DEPARTMENT' },
      { field: 'mobile_no', headers: ['Mobile'] },
      { field: 'dept_name', headers: ['Department Name'] },
      { field: 'hod_name', headers: ['HOD Name'] },
    ],
  },
  {
    sheet: 'Purchase Indent', entity: 'purchase_indents', order: 40, keys: ['indent_no', 'item_code'],
    columns: [
      { field: 'indent_no', headers: ['Indent No'], required: true },
      { field: 'date', headers: ['date', 'Date'] },
      { field: 'time', headers: ['time', 'Time'] },
      { field: 'indent_type', headers: ['Indent Type'], lookup: 'INDENT_TYPE' },
      { field: 'item_code', headers: ['Item code', 'Item Code'], required: true },
      { field: 'item_description', headers: ['Item Description'] },
      { field: 'indent_qty', headers: ['Indent Qty', 'Quantity'], numeric: true, required: true },
      { field: 'uom', headers: ['UOM', 'Uom'], lookup: 'UOM' },
      { field: 'item_specification', headers: ['Item Specification'] },
      { field: 'department', headers: ['Department'], lookup: 'DEPARTMENT' },
      { field: 'cost_centre', headers: ['Cost Centre', 'Cost Center'], lookup: 'COST_CENTRE' },
      { field: 'required_by', headers: ['Required By'] },
      { field: 'remarks', headers: ['Remarks'] },
      { field: 'priority', headers: ['Priority'] },
    ],
    notes: 'Live Qty / Pending GRN Qty in the sheet are DERIVED here and never imported (ADR-005). Required By / Remarks / Priority are captured for reconciliation display only — this sheet stays read-only, per Set B.',
  },
  {
    sheet: 'Purchase Order', entity: 'purchase_orders', order: 50, keys: ['po_no', 'item_code'],
    columns: [
      { field: 'indent_no', headers: ['Indent No', 'Indent No.', 'Indent No (source)'] },
      { field: 'indent_type', headers: ['Indent type', 'Indent Type'], lookup: 'INDENT_TYPE' },
      { field: 'indent_qty', headers: ['Indent qty', 'Indent Qty'], numeric: true },
      { field: 'po_type', headers: ['Po type', 'PO Type'], lookup: 'PO_TYPE' },
      { field: 'date', headers: ['date', 'Date', 'PO Date'] },
      { field: 'time', headers: ['time', 'Time'] },
      { field: 'po_no', headers: ['Po no', 'PO No'], required: true },
      { field: 'po_qty', headers: ['Po qty', 'PO Qty', 'Quantity'], numeric: true, required: true },
      { field: 'item_code', headers: ['Item code', 'Item Code'], required: true },
      { field: 'item_description', headers: ['Item Description'] },
      { field: 'rate', headers: ['Rate/pc', 'Rate'], numeric: true },
      { field: 'discount_pct', headers: ['Discount %'], numeric: true },
      { field: 'item_specification', headers: ['Item Specification'] },
      { field: 'supplier_code', headers: ['Supplier Code'] },
      { field: 'supplier_name', headers: ['Supplier', 'Supplier Name'] },
      { field: 'delivery_date', headers: ['Delivery Date', 'Excpected Date', 'Expected Date'] },
      { field: 'terms', headers: ['Terms'] },
    ],
    notes: 'Final Rate/pc and Amount in the sheet are DERIVED columns here and never imported (ADR-004). Supplier Code / Delivery Date / Terms are captured for display only — reconciliation still checks qty and rate.',
  },
  {
    sheet: 'GRN', entity: 'grns', order: 60, keys: ['po_no', 'item_code', 'date'],
    columns: [
      { field: 'po_no', headers: ['Po no', 'PO No'], required: true },
      { field: 'po_type', headers: ['Po type', 'PO Type'], lookup: 'PO_TYPE' },
      { field: 'item_code', headers: ['Item code', 'Item Code'], required: true },
      { field: 'item_description', headers: ['Item description', 'Item Description'] },
      // "Recieved Qty" is how the live sheet spells it. Without that alias the
      // whole tab was refused as "missing required column" on every run.
      { field: 'grn_qty', headers: ['Grn qty', 'GRN Qty', 'Received Qty', 'Recieved Qty'], numeric: true, required: true },
      { field: 'date', headers: ['date', 'Date', 'GRN Date'] },
      { field: 'time', headers: ['time', 'Time'] },
      { field: 'accepted_qty', headers: ['Accepted Qty'], numeric: true },
      { field: 'rejected_qty', headers: ['Rejected Qty'], numeric: true },
      { field: 'receipt_location', headers: ['Receipt Location'] },
      { field: 'remarks', headers: ['Remarks'] },
      { field: 'qc_status', headers: ['QC Status', 'QC status', 'QC_Status'] },
    ],
    notes: 'GRN number is issued by the ERP (ADR-008); Pending GRN qty is derived, never imported. Accepted/Rejected Qty and Receipt Location (Set B) are captured for reconciliation display only — grn_qty (Received Qty) keeps its existing meaning for stock and pending-PO everywhere it is already used.',
  },
  {
    // Requisition (Purchase Module tab 4) — reconciled exactly like Purchase
    // Indent/PO/GRN above: never creates or mutates a requisition, only flags
    // a divergence for review. HOD Approval Status / Issue Slip No / Issue
    // Date / Issued Qty are ERP-derived (v_requisition_line_balance) and are
    // read for the conflict message only.
    sheet: 'Requisition', entity: 'requisitions', order: 70, keys: ['requisition_no', 'item_code'],
    columns: [
      { field: 'sr_no', headers: ['Sr no', 'Sr. no', 'Sr No'] },
      { field: 'item_code', headers: ['Item code', 'Item Code'], required: true },
      { field: 'item_name', headers: ['Item Name'] },
      { field: 'uom', headers: ['UOM', 'Uom'], lookup: 'UOM' },
      { field: 'main_group', headers: ['Main Group'], lookup: 'MAIN_GROUP' },
      { field: 'user_name', headers: ['User Name'] },
      { field: 'department', headers: ['Department'], lookup: 'DEPARTMENT' },
      { field: 'machine_no', headers: ['Machine No', 'Machine No.'] },
      { field: 'cost_centre', headers: ['Cost Centre', 'Cost Center'], lookup: 'COST_CENTRE' },
      { field: 'requisition_qty', headers: ['Requisition Qty'], numeric: true, required: true },
      { field: 'requisition_date', headers: ['Requisition Date'] },
      { field: 'requisition_no', headers: ['Requisition No'], required: true },
      { field: 'hod_name', headers: ['HOD Name'] },
      { field: 'hod_approval_status', headers: ['HOD Approval Status'] },
      { field: 'issue_slip_no', headers: ['Issue Slip No'] },
      { field: 'issue_date', headers: ['Issue Date'] },
      { field: 'issued_qty', headers: ['Issued Qty'], numeric: true },
      { field: 'remarks', headers: ['Remarks'] },
    ],
    notes: 'Read-only reconciliation, exactly like Purchase Indent/PO/GRN — requisitions are raised only through the Requisition screen. HOD Approval Status, Issue Slip No, Issue Date and Issued Qty are always ERP-derived and are never imported.',
  },
  {
    // Machine — new master data (Requisition's Machine No dropdown,
    // cascading from Department: lookup.routes.ts PARENT_OF['MACHINE']).
    // The parent Department is looked up, never auto-created, from a machine sheet.
    sheet: 'Machine', entity: 'lookups:MACHINE', order: 12, keys: ['machine_no'],
    columns: [
      { field: 'machine_no', headers: ['Machine No', 'Machine No.', 'Machine'], required: true },
      { field: 'department', headers: ['Department'], lookup: 'DEPARTMENT', required: true },
    ],
    notes: 'Machine No is both the code and display name. Department must already exist in Supporting Masters — this sheet does not create departments.',
  },
];

async function seedSheetMappings(): Promise<void> {
  // One-time cleanup: an earlier seed briefly registered the Machine mapping
  // under the wrong tab name ('Machine-Machine' instead of the real sheet
  // name 'Machine'), which the sync engine reported every run as
  // 'Sheet "Machine-Machine" was not found' and silently synced zero rows.
  // ON CONFLICT (sheet_name) only reconciles a row whose name still matches,
  // so the stray row is removed explicitly rather than left as a dead entry
  // once the mapping below is corrected.
  await query(`DELETE FROM google_sheet_mappings WHERE sheet_name = 'Machine-Machine'`);
  // Same cleanup, same reason: 'PO Type' and 'Indent Type' were registered as
  // two separate tabs, but the spreadsheet holds them as columns of ONE tab,
  // 'Indent / PO / GRN Type' (mapped below). Both rows failed on every run.
  await query(`DELETE FROM google_sheet_mappings WHERE sheet_name IN ('PO Type', 'Indent Type')`);

  for (const m of SHEET_MAPPINGS) {
    await query(
      `INSERT INTO google_sheet_mappings (sheet_name, target_entity, sync_order, key_fields, column_map, notes)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)
       ON CONFLICT (sheet_name) DO UPDATE
         SET target_entity = EXCLUDED.target_entity,
             sync_order    = EXCLUDED.sync_order,
             key_fields    = EXCLUDED.key_fields,
             column_map    = EXCLUDED.column_map,
             notes         = EXCLUDED.notes,
             updated_at    = now()`,
      [m.sheet, m.entity, m.order, JSON.stringify(m.keys), JSON.stringify(m.columns), m.notes ?? ''],
    );
  }
  logger.info(`  · Google sheet mappings reconciled (${SHEET_MAPPINGS.length})`);
}

/**
 * Universal units and currencies. These are international standards, not
 * company-specific business data, so they ship as `is_system` rows.
 */
const SYSTEM_LOOKUPS: { category: string; code: string; name: string }[] = [
  ...[
    ['NOS', 'Numbers'], ['PCS', 'Pieces'], ['SET', 'Set'], ['KG', 'Kilogram'],
    ['GM', 'Gram'], ['MTR', 'Meter'], ['CM', 'Centimeter'], ['FT', 'Feet'],
    ['LTR', 'Litre'], ['BOX', 'Box'], ['ROLL', 'Roll'], ['PKT', 'Packet'],
    ['PAIR', 'Pair'], ['SQM', 'Square Meter'], ['TON', 'Tonne'], ['COIL', 'Coil'],
  ].map(([code, name]) => ({ category: 'UOM', code: code as string, name: name as string })),
  ...[
    ['INR', 'Indian Rupee (₹)'], ['USD', 'US Dollar ($)'], ['EUR', 'Euro (€)'], ['GBP', 'Pound Sterling (£)'],
  ].map(([code, name]) => ({ category: 'CURRENCY', code: code as string, name: name as string })),
  ...[
    ['ADV', 'Advance'], ['NET15', 'Net 15 Days'], ['NET30', 'Net 30 Days'],
    ['NET45', 'Net 45 Days'], ['NET60', 'Net 60 Days'], ['COD', 'Cash on Delivery'],
    ['50-50', '50% Advance, 50% on Delivery'],
  ].map(([code, name]) => ({ category: 'PAYMENT_TERMS', code: code as string, name: name as string })),
];

async function seedSystemLookups(): Promise<void> {
  for (const [i, l] of SYSTEM_LOOKUPS.entries()) {
    await query(
      `INSERT INTO lookups (category, code, name, sort_order, is_system, extra)
       VALUES ($1,$2,$3,$4,TRUE,'{"seed":"system"}'::jsonb)
       ON CONFLICT (category, upper(code)) WHERE deleted_at IS NULL DO NOTHING`,
      [l.category, l.code, l.name, i],
    );
  }
  logger.info(`  · system lookups reconciled (${SYSTEM_LOOKUPS.length})`);
}

export async function seedSystem(): Promise<void> {
  logger.info('Seeding system data…');
  const newPermissionCodes = await seedPermissions();
  await seedRoles(newPermissionCodes);
  await seedBootstrapUsers();
  await seedSettings();
  await seedSheetMappings();
  await seedSystemLookups();
  logger.info('System seed complete.');
}

/* ─────────────────────────── 2. DEMO SEED ──────────────────────────────────── */

/**
 * Company-specific masters. These are DEMO values so the product is usable
 * immediately; a real deployment replaces them from the Item/Supplier Master or a
 * Google Sheet sync. Every row is tagged `extra.seed = 'demo'` so it can be
 * identified and removed, and so nothing here is mistaken for real data.
 */
const DEMO_LOOKUPS: { category: string; code: string; name: string; parent?: string }[] = [
  ...[
    ['PROD', 'Production'], ['MAINT', 'Maintenance'], ['PROJ', 'Projects'],
    ['QC', 'Quality Control'], ['STORE', 'Stores'], ['ADMIN', 'Administration'],
    ['RND', 'Research & Development'], ['SAFETY', 'Safety & Compliance'],
  ].map(([code, name]) => ({ category: 'DEPARTMENT', code: code as string, name: name as string })),
  ...[
    ['CC-PLANT1', 'Plant 1 — Panel Shop'], ['CC-PLANT2', 'Plant 2 — Winding'],
    ['CC-SITE-N', 'Site — North Zone'], ['CC-SITE-S', 'Site — South Zone'],
    ['CC-MAINT', 'Plant Maintenance'], ['CC-CAPEX', 'Capital Expenditure'],
    ['CC-OVH', 'General Overheads'],
  ].map(([code, name]) => ({ category: 'COST_CENTRE', code: code as string, name: name as string })),
  ...[
    ['RM', 'Raw Material'], ['CONS', 'Consumable'], ['SPARE', 'Spare Part'],
    ['CAPEX', 'Capital Equipment'], ['TOOL', 'Tools & Tackles'], ['PACK', 'Packing Material'],
  ].map(([code, name]) => ({ category: 'ITEM_TYPE', code: code as string, name: name as string })),
  ...[
    ['REG', 'Regular'], ['URG', 'Urgent'], ['CAP', 'Capital'],
    ['BRK', 'Breakdown'], ['PROJ', 'Project'], ['AMC', 'AMC / Service'],
  ].map(([code, name]) => ({ category: 'INDENT_TYPE', code: code as string, name: name as string })),
  ...[
    ['STD', 'Standard PO'], ['URG', 'Urgent PO'], ['BLKT', 'Blanket PO'],
    ['CAPEX', 'Capital PO'], ['SVC', 'Service PO'], ['IMP', 'Import PO'],
  ].map(([code, name]) => ({ category: 'PO_TYPE', code: code as string, name: name as string })),
  ...[
    ['CABLE', 'Cables & Wires'], ['SWGR', 'Switchgear'], ['MOTOR', 'Motors & Drives'],
    ['PANEL', 'Panel Components'], ['LIGHT', 'Lighting'], ['HW', 'Hardware & Fasteners'],
    ['INSTR', 'Instrumentation'],
  ].map(([code, name]) => ({ category: 'MAIN_GROUP', code: code as string, name: name as string })),
];

const DEMO_SUB_GROUPS: { code: string; name: string; parent: string }[] = [
  { code: 'CU-CABLE', name: 'Copper Cable', parent: 'CABLE' },
  { code: 'AL-CABLE', name: 'Aluminium Cable', parent: 'CABLE' },
  { code: 'CTRL-CABLE', name: 'Control Cable', parent: 'CABLE' },
  { code: 'MCB', name: 'MCB / MCCB', parent: 'SWGR' },
  { code: 'CONTACTOR', name: 'Contactors & Relays', parent: 'SWGR' },
  { code: 'ACB', name: 'Air Circuit Breakers', parent: 'SWGR' },
  { code: 'IND-MOTOR', name: 'Induction Motors', parent: 'MOTOR' },
  { code: 'VFD', name: 'Variable Frequency Drives', parent: 'MOTOR' },
  { code: 'BUSBAR', name: 'Busbars & Copper Flats', parent: 'PANEL' },
  { code: 'ENCL', name: 'Enclosures & Cabinets', parent: 'PANEL' },
  { code: 'LED', name: 'LED Luminaires', parent: 'LIGHT' },
  { code: 'FAST', name: 'Fasteners', parent: 'HW' },
  { code: 'LUGS', name: 'Lugs & Glands', parent: 'HW' },
  { code: 'XMITTER', name: 'Transmitters & Sensors', parent: 'INSTR' },
];

const DEMO_ITEMS: {
  code: string; desc: string; group: string; sub: string; type: string;
  uom: string; hsn: string; rate: number; spec: string;
}[] = [
  { code: 'CBL-CU-1C400', desc: 'Copper Cable 1C x 400 sq.mm XLPE', group: 'CABLE', sub: 'CU-CABLE', type: 'RM', uom: 'MTR', hsn: '85444910', rate: 2480.5, spec: '1100V grade, XLPE insulated, unarmoured' },
  { code: 'CBL-CU-3C25', desc: 'Copper Cable 3C x 25 sq.mm Armoured', group: 'CABLE', sub: 'CU-CABLE', type: 'RM', uom: 'MTR', hsn: '85444910', rate: 685.0, spec: '1100V grade, XLPE, steel armoured' },
  { code: 'CBL-AL-3C185', desc: 'Aluminium Cable 3.5C x 185 sq.mm', group: 'CABLE', sub: 'AL-CABLE', type: 'RM', uom: 'MTR', hsn: '85444920', rate: 940.75, spec: '1100V grade, XLPE armoured' },
  { code: 'CBL-CTRL-12C', desc: 'Control Cable 12C x 1.5 sq.mm', group: 'CABLE', sub: 'CTRL-CABLE', type: 'RM', uom: 'MTR', hsn: '85444930', rate: 168.25, spec: 'Copper conductor, PVC, screened' },
  { code: 'CBL-CTRL-4C', desc: 'Control Cable 4C x 2.5 sq.mm', group: 'CABLE', sub: 'CTRL-CABLE', type: 'RM', uom: 'MTR', hsn: '85444930', rate: 96.4, spec: 'Copper conductor, FRLS' },
  { code: 'MCB-C32-4P', desc: 'MCB 32A 4-Pole C-Curve', group: 'SWGR', sub: 'MCB', type: 'SPARE', uom: 'NOS', hsn: '85362000', rate: 1420.0, spec: '10kA breaking capacity, IS/IEC 60898' },
  { code: 'MCB-C16-2P', desc: 'MCB 16A 2-Pole C-Curve', group: 'SWGR', sub: 'MCB', type: 'SPARE', uom: 'NOS', hsn: '85362000', rate: 486.0, spec: '10kA breaking capacity' },
  { code: 'MCCB-250A', desc: 'MCCB 250A 3-Pole Thermal Magnetic', group: 'SWGR', sub: 'MCB', type: 'SPARE', uom: 'NOS', hsn: '85362000', rate: 14850.0, spec: '36kA, adjustable overload' },
  { code: 'CONT-AC3-95', desc: 'Power Contactor 95A AC-3 220V Coil', group: 'SWGR', sub: 'CONTACTOR', type: 'SPARE', uom: 'NOS', hsn: '85364900', rate: 6240.0, spec: 'AC-3 duty, 3 pole, 45kW' },
  { code: 'CONT-AC3-25', desc: 'Power Contactor 25A AC-3 220V Coil', group: 'SWGR', sub: 'CONTACTOR', type: 'SPARE', uom: 'NOS', hsn: '85364900', rate: 1850.0, spec: 'AC-3 duty, 3 pole, 11kW' },
  { code: 'RLY-OVLD-40', desc: 'Thermal Overload Relay 30-40A', group: 'SWGR', sub: 'CONTACTOR', type: 'SPARE', uom: 'NOS', hsn: '85364900', rate: 2180.0, spec: 'Class 10A, manual/auto reset' },
  { code: 'ACB-1600A', desc: 'Air Circuit Breaker 1600A 4-Pole EDO', group: 'SWGR', sub: 'ACB', type: 'CAPEX', uom: 'NOS', hsn: '85362000', rate: 186000.0, spec: '65kA, electrically operated, drawout' },
  { code: 'MTR-IE3-30KW', desc: 'Induction Motor 30kW IE3 4-Pole', group: 'MOTOR', sub: 'IND-MOTOR', type: 'CAPEX', uom: 'NOS', hsn: '85015220', rate: 98500.0, spec: 'Foot mounted, B3, IP55, 415V' },
  { code: 'MTR-IE3-7K5', desc: 'Induction Motor 7.5kW IE3 4-Pole', group: 'MOTOR', sub: 'IND-MOTOR', type: 'CAPEX', uom: 'NOS', hsn: '85015220', rate: 31200.0, spec: 'Flange mounted, B5, IP55' },
  { code: 'VFD-22KW', desc: 'Variable Frequency Drive 22kW 415V', group: 'MOTOR', sub: 'VFD', type: 'CAPEX', uom: 'NOS', hsn: '85044090', rate: 64800.0, spec: 'Vector control, built-in EMC filter' },
  { code: 'VFD-5K5', desc: 'Variable Frequency Drive 5.5kW 415V', group: 'MOTOR', sub: 'VFD', type: 'CAPEX', uom: 'NOS', hsn: '85044090', rate: 22400.0, spec: 'V/f control, IP20' },
  { code: 'BUS-CU-100X10', desc: 'Copper Busbar 100 x 10 mm', group: 'PANEL', sub: 'BUSBAR', type: 'RM', uom: 'KG', hsn: '74071010', rate: 892.0, spec: 'Electrolytic grade E-Cu, 99.9%' },
  { code: 'BUS-CU-50X6', desc: 'Copper Busbar 50 x 6 mm', group: 'PANEL', sub: 'BUSBAR', type: 'RM', uom: 'KG', hsn: '74071010', rate: 885.0, spec: 'Electrolytic grade E-Cu' },
  { code: 'ENCL-IP66-800', desc: 'Enclosure IP66 800x600x300 mm', group: 'PANEL', sub: 'ENCL', type: 'RM', uom: 'NOS', hsn: '85381010', rate: 12400.0, spec: 'CRCA 2mm, powder coated RAL7035' },
  { code: 'ENCL-IP54-600', desc: 'Enclosure IP54 600x400x250 mm', group: 'PANEL', sub: 'ENCL', type: 'RM', uom: 'NOS', hsn: '85381010', rate: 6850.0, spec: 'CRCA 1.6mm, powder coated' },
  { code: 'LED-HB-150W', desc: 'LED High Bay Luminaire 150W', group: 'LIGHT', sub: 'LED', type: 'CONS', uom: 'NOS', hsn: '94054090', rate: 4280.0, spec: 'IP65, 5700K, 130 lm/W' },
  { code: 'LED-ST-36W', desc: 'LED Street Light 36W', group: 'LIGHT', sub: 'LED', type: 'CONS', uom: 'NOS', hsn: '94054090', rate: 1980.0, spec: 'IP66, 6500K, surge 10kV' },
  { code: 'LED-BATT-20W', desc: 'LED Batten 20W 4ft', group: 'LIGHT', sub: 'LED', type: 'CONS', uom: 'NOS', hsn: '94054090', rate: 420.0, spec: '4000K, 100 lm/W' },
  { code: 'BOLT-M12X50', desc: 'Hex Bolt M12 x 50 mm SS304', group: 'HW', sub: 'FAST', type: 'CONS', uom: 'NOS', hsn: '73181500', rate: 28.5, spec: 'Stainless steel 304, full thread' },
  { code: 'BOLT-M8X25', desc: 'Hex Bolt M8 x 25 mm GI', group: 'HW', sub: 'FAST', type: 'CONS', uom: 'NOS', hsn: '73181500', rate: 9.75, spec: 'Galvanised, grade 8.8' },
  { code: 'LUG-CU-400', desc: 'Copper Lug 400 sq.mm', group: 'HW', sub: 'LUGS', type: 'CONS', uom: 'NOS', hsn: '85369090', rate: 385.0, spec: 'Tinned copper, long barrel' },
  { code: 'LUG-CU-25', desc: 'Copper Lug 25 sq.mm', group: 'HW', sub: 'LUGS', type: 'CONS', uom: 'NOS', hsn: '85369090', rate: 32.0, spec: 'Tinned copper ring type' },
  { code: 'GLND-DW-32', desc: 'Cable Gland Double Compression 32mm', group: 'HW', sub: 'LUGS', type: 'CONS', uom: 'NOS', hsn: '85389000', rate: 145.0, spec: 'Brass nickel plated, IP68' },
  { code: 'XMTR-PRES-4B', desc: 'Pressure Transmitter 0-4 bar', group: 'INSTR', sub: 'XMITTER', type: 'SPARE', uom: 'NOS', hsn: '90262000', rate: 18600.0, spec: '4-20mA HART, SS316 wetted' },
  { code: 'XMTR-TEMP-PT100', desc: 'Temperature Transmitter PT100', group: 'INSTR', sub: 'XMITTER', type: 'SPARE', uom: 'NOS', hsn: '90262000', rate: 9400.0, spec: '4-20mA, head mounted, 0-400°C' },
  { code: 'SNSR-PROX-M18', desc: 'Inductive Proximity Sensor M18', group: 'INSTR', sub: 'XMITTER', type: 'SPARE', uom: 'NOS', hsn: '85365090', rate: 1650.0, spec: 'PNP NO, 8mm sensing, IP67' },
  { code: 'TOOL-CRIMP-400', desc: 'Hydraulic Crimping Tool 16-400 sq.mm', group: 'HW', sub: 'FAST', type: 'TOOL', uom: 'NOS', hsn: '82055990', rate: 24500.0, spec: 'Manual hydraulic, with die set' },
  { code: 'TOOL-MEGGER', desc: 'Insulation Tester 5kV Digital', group: 'INSTR', sub: 'XMITTER', type: 'TOOL', uom: 'NOS', hsn: '90303900', rate: 87000.0, spec: '5kV, 1TΩ range, data logging' },
  { code: 'PACK-WOOD-L', desc: 'Wooden Packing Crate Large', group: 'HW', sub: 'FAST', type: 'PACK', uom: 'NOS', hsn: '44152000', rate: 3200.0, spec: 'ISPM-15 heat treated, 1.5x1.2x1.0m' },
  { code: 'CONS-TAPE-PVC', desc: 'PVC Insulation Tape 20m', group: 'HW', sub: 'FAST', type: 'CONS', uom: 'ROLL', hsn: '39191000', rate: 22.0, spec: 'Self-extinguishing, 0.18mm' },
  { code: 'CONS-FERR-1M', desc: 'Wire Ferrule 1.0 sq.mm (1000 pcs)', group: 'HW', sub: 'LUGS', type: 'CONS', uom: 'BOX', hsn: '85369090', rate: 640.0, spec: 'Insulated, colour coded red' },
];

const DEMO_SUPPLIERS: {
  name: string; city: string; state: string; gst: string; terms: string; contact: string;
}[] = [
  { name: 'Polycab Wires Pvt Ltd', city: 'Mumbai', state: 'Maharashtra', gst: '27AAACP1234F1Z5', terms: 'NET30', contact: 'Rajesh Menon' },
  { name: 'Havells India Ltd', city: 'Noida', state: 'Uttar Pradesh', gst: '09AAACH5678G1Z2', terms: 'NET45', contact: 'Sunita Rao' },
  { name: 'Schneider Electric India', city: 'Bengaluru', state: 'Karnataka', gst: '29AAACS9012H1Z8', terms: 'NET30', contact: 'Arun Prakash' },
  { name: 'Siemens Ltd', city: 'Pune', state: 'Maharashtra', gst: '27AAACS3456J1Z4', terms: 'NET60', contact: 'Deepa Iyer' },
  { name: 'ABB India Ltd', city: 'Vadodara', state: 'Gujarat', gst: '24AAACA7890K1Z1', terms: 'NET45', contact: 'Vikram Shah' },
  { name: 'Crompton Greaves Consumer', city: 'Ahmedabad', state: 'Gujarat', gst: '24AAACC2345L1Z9', terms: 'NET30', contact: 'Nilesh Patel' },
  { name: 'Finolex Cables Ltd', city: 'Pune', state: 'Maharashtra', gst: '27AAACF6789M1Z6', terms: '50-50', contact: 'Sameer Kulkarni' },
  { name: 'L&T Electrical & Automation', city: 'Chennai', state: 'Tamil Nadu', gst: '33AAACL0123N1Z3', terms: 'NET45', contact: 'Karthik Subramanian' },
  { name: 'Bharat Bijlee Ltd', city: 'Thane', state: 'Maharashtra', gst: '27AAACB4567P1Z7', terms: 'NET30', contact: 'Mahesh Joshi' },
  { name: 'Rittal India Pvt Ltd', city: 'Bengaluru', state: 'Karnataka', gst: '29AAACR8901Q1Z0', terms: 'ADV', contact: 'Anita Desai' },
  { name: 'Wago Private Limited', city: 'Gurugram', state: 'Haryana', gst: '06AAACW2345R1Z5', terms: 'NET30', contact: 'Pradeep Singh' },
  { name: 'Sundaram Fasteners Ltd', city: 'Chennai', state: 'Tamil Nadu', gst: '33AAACS6789T1Z2', terms: 'COD', contact: 'Ravi Chandran' },
];

const DEMO_USERS: { employeeId: string; name: string; designation: string; role: string }[] = [
  { employeeId: '20101', name: 'Anil Deshmukh', designation: 'Head — Purchase', role: 'PURCHASE_HEAD' },
  { employeeId: '20102', name: 'Priya Nair', designation: 'Purchase Executive', role: 'PURCHASE_USER' },
  { employeeId: '20103', name: 'Rohit Verma', designation: 'Purchase Officer', role: 'PURCHASE_USER' },
  { employeeId: '20201', name: 'Suresh Pawar', designation: 'Store Incharge', role: 'STORE_USER' },
  { employeeId: '20202', name: 'Manoj Kadam', designation: 'Store Assistant', role: 'STORE_USER' },
  { employeeId: '20301', name: 'Kavita Sharma', designation: 'General Manager — Operations', role: 'MANAGEMENT' },
  { employeeId: '20401', name: 'Imran Sheikh', designation: 'Accounts Executive', role: 'VIEWER' },
];

interface LookupIndex {
  byCode: Map<string, number>;
}

async function lookupIndex(tx: Queryable): Promise<LookupIndex> {
  const rows = await txQuery<{ id: number; category: string; code: string }>(
    tx,
    'SELECT id, category, code FROM lookups WHERE deleted_at IS NULL',
  );
  const byCode = new Map<string, number>();
  for (const r of rows) byCode.set(`${r.category}:${r.code.toUpperCase()}`, Number(r.id));
  return { byCode };
}

const lk = (idx: LookupIndex, category: string, code: string): number | null =>
  idx.byCode.get(`${category}:${code.toUpperCase()}`) ?? null;

/** True when demo transactions already exist, so reseeding is a no-op. */
async function demoAlreadySeeded(): Promise<boolean> {
  const row = await queryOne<{ n: string }>(
    "SELECT COUNT(*) AS n FROM purchase_indent_headers WHERE seed_tag = 'demo'",
  );
  return Number(row?.n ?? 0) > 0;
}

/**
 * True once `npm run db:purify -- --apply` has cleaned this database.
 *
 * A purge is a deliberate act of preparing for production. Re-creating demo data
 * afterwards — because a start-up noticed the rows were missing — would silently
 * undo it, so the marker outranks SEED_DEMO_DATA entirely. `db:reset` clears it.
 */
async function databaseWasPurified(): Promise<boolean> {
  const row = await queryOne<{ key: string }>(
    "SELECT key FROM app_settings WHERE key = 'data.purified_at'",
  );
  return Boolean(row);
}

export async function seedDemoData(): Promise<void> {
  if (await databaseWasPurified()) {
    logger.warn(
      'This database has been purified for production — demo seeding refused. ' +
      'Run `npm run db:reset` if you deliberately want demo data back.',
    );
    return;
  }
  if (await demoAlreadySeeded()) {
    logger.info('Demo data already present — skipping.');
    return;
  }

  logger.info('Seeding demo data (all rows tagged [DEMO])…');
  const rng = makeRng();

  /* Masters ---------------------------------------------------------------- */
  await withTransaction(async (tx) => {
    for (const [i, l] of DEMO_LOOKUPS.entries()) {
      await tx.query(
        `INSERT INTO lookups (category, code, name, sort_order, extra, seed_tag)
         VALUES ($1,$2,$3,$4,'{"seed":"demo"}'::jsonb,'demo')
         ON CONFLICT (category, upper(code)) WHERE deleted_at IS NULL DO NOTHING`,
        [l.category, l.code, l.name, i],
      );
    }
    const idx1 = await lookupIndex(tx);
    for (const [i, s] of DEMO_SUB_GROUPS.entries()) {
      await tx.query(
        `INSERT INTO lookups (category, code, name, parent_id, sort_order, extra, seed_tag)
         VALUES ('SUB_MAIN_GROUP',$1,$2,$3,$4,'{"seed":"demo"}'::jsonb,'demo')
         ON CONFLICT (category, upper(code)) WHERE deleted_at IS NULL DO NOTHING`,
        [s.code, s.name, lk(idx1, 'MAIN_GROUP', s.parent), i],
      );
    }
  });

  const idx = await withTransaction((tx) => lookupIndex(tx));

  // Suppliers
  await withTransaction(async (tx) => {
    for (const [i, s] of DEMO_SUPPLIERS.entries()) {
      await tx.query(
        `INSERT INTO suppliers (supplier_code, supplier_name, address, state, city, country,
                                mobile_no, email, gst_no, payment_terms, currency_code,
                                contact_person, notes, seed_tag)
         VALUES ($1,$2,$3,$4,$5,'India',$6,$7,$8,$9,'INR',$10,'[DEMO] Sample supplier record','demo')
         ON CONFLICT DO NOTHING`,
        [
          `SUP-${String(i + 1).padStart(4, '0')}`,
          s.name,
          `Plot ${rng.int(1, 240)}, ${rng.pick(['MIDC Industrial Area', 'Industrial Estate', 'Export Promotion Park', 'Phase II Industrial Area'])}, ${s.city}`,
          s.state, s.city,
          `+91 ${rng.int(70000, 99999)}${rng.int(10000, 99999)}`,
          `${s.name.toLowerCase().replace(/[^a-z]/g, '').slice(0, 14)}@example.com`,
          s.gst, s.terms, s.contact,
        ],
      );
    }
  });

  // Items
  await withTransaction(async (tx) => {
    for (const it of DEMO_ITEMS) {
      await tx.query(
        `INSERT INTO items (item_code, item_description, item_type_id, department_id, cost_centre_id,
                            main_group_id, sub_main_group_id, indent_type_id, uom_id, hsn_code,
                            item_specification, standard_rate, reorder_level, source_date, source_time, seed_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,CURRENT_DATE,$14,'demo')
         ON CONFLICT DO NOTHING`,
        [
          it.code, it.desc,
          lk(idx, 'ITEM_TYPE', it.type),
          lk(idx, 'DEPARTMENT', rng.pick(['PROD', 'MAINT', 'PROJ', 'STORE'])),
          lk(idx, 'COST_CENTRE', rng.pick(['CC-PLANT1', 'CC-PLANT2', 'CC-MAINT', 'CC-CAPEX', 'CC-SITE-N'])),
          lk(idx, 'MAIN_GROUP', it.group),
          lk(idx, 'SUB_MAIN_GROUP', it.sub),
          lk(idx, 'INDENT_TYPE', rng.pick(['REG', 'URG', 'CAP', 'PROJ'])),
          lk(idx, 'UOM', it.uom),
          it.hsn, it.spec, toRate(it.rate), rng.int(5, 100), timeStamp(),
        ],
      );
    }
  });

  // Demo users — password identical to the bootstrap credential, rotation forced.
  const demoHash = await hashPassword('Admin@12345');
  await withTransaction(async (tx) => {
    for (const u of DEMO_USERS) {
      const existing = await txQueryOne<{ id: number }>(
        tx, 'SELECT id FROM users WHERE employee_id = $1 AND deleted_at IS NULL', [u.employeeId],
      );
      if (existing) continue;
      const created = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO users (employee_id, employee_name, designation, password_hash,
                            is_active, must_change_password, department_id, seed_tag)
         VALUES ($1,$2,$3,$4,TRUE,FALSE,$5,'demo') RETURNING id`,
        [u.employeeId, u.name, u.designation, demoHash, lk(idx, 'DEPARTMENT', rng.pick(['PROD', 'MAINT', 'STORE', 'ADMIN']))],
      );
      if (created) {
        await tx.query(
          `INSERT INTO user_roles (user_id, role_id) SELECT $1, id FROM roles WHERE code = $2
           ON CONFLICT DO NOTHING`,
          [created.id, u.role],
        );
      }
    }
  });

  /* Transactions ----------------------------------------------------------- */
  const items = await query<{
    id: number; item_code: string; item_description: string; uom_id: number | null;
    item_specification: string; standard_rate: string | null; department_id: number | null;
    cost_centre_id: number | null; indent_type_id: number | null;
  }>('SELECT * FROM items WHERE deleted_at IS NULL ORDER BY id');

  const suppliers = await query<{ id: number; payment_terms: string }>(
    'SELECT id, payment_terms FROM suppliers WHERE deleted_at IS NULL ORDER BY id',
  );
  const users = await query<{ id: number; employee_id: string }>(
    "SELECT id, employee_id FROM users WHERE employee_id LIKE '20%' ORDER BY id",
  );

  if (items.length === 0 || suppliers.length === 0 || users.length === 0) {
    logger.warn('Demo masters missing — skipping demo transactions.');
    return;
  }

  const purchaseUsers = users.filter((u) => ['20102', '20103'].includes(u.employee_id));
  const head = users.find((u) => u.employee_id === '20101');
  const storeUsers = users.filter((u) => ['20201', '20202'].includes(u.employee_id));

  const indentTypes = ['REG', 'URG', 'CAP', 'BRK', 'PROJ', 'AMC'].map((c) => lk(idx, 'INDENT_TYPE', c)).filter(Boolean) as number[];
  const poTypes = ['STD', 'URG', 'BLKT', 'CAPEX', 'SVC'].map((c) => lk(idx, 'PO_TYPE', c)).filter(Boolean) as number[];
  const departments = ['PROD', 'MAINT', 'PROJ', 'QC', 'STORE'].map((c) => lk(idx, 'DEPARTMENT', c)).filter(Boolean) as number[];
  const costCentres = ['CC-PLANT1', 'CC-PLANT2', 'CC-SITE-N', 'CC-SITE-S', 'CC-MAINT', 'CC-CAPEX'].map((c) => lk(idx, 'COST_CENTRE', c)).filter(Boolean) as number[];

  const DAYS_BACK = 210;
  const today = new Date();
  const dayOffset = (d: number) => {
    const dt = new Date(today);
    dt.setDate(dt.getDate() - d);
    return dt;
  };

  /* Indents: spread across 7 months so trend charts have real shape. */
  const createdIndents: { id: number; status: string; date: Date }[] = [];

  for (let i = 0; i < 68; i++) {
    const daysAgo = Math.floor((1 - Math.sqrt(rng.next())) * DAYS_BACK); // recency-weighted
    const when = dayOffset(daysAgo);
    const requester = rng.pick(purchaseUsers.length ? purchaseUsers : users);

    // Older indents are more likely to be fully decided.
    const roll = rng.next();
    let status: string;
    if (daysAgo < 6) status = roll < 0.35 ? 'DRAFT' : 'PENDING_APPROVAL';
    else if (daysAgo < 20) status = roll < 0.12 ? 'DRAFT' : roll < 0.42 ? 'PENDING_APPROVAL' : roll < 0.9 ? 'APPROVED' : 'REJECTED';
    else status = roll < 0.06 ? 'PENDING_APPROVAL' : roll < 0.88 ? 'APPROVED' : roll < 0.96 ? 'REJECTED' : 'CANCELLED';

    await withTransaction(async (tx) => {
      const indentNo = await nextDocumentNumber(tx, 'INDENT', when);
      const submittedAt = status === 'DRAFT' ? null : new Date(when.getTime() + 3600_000).toISOString();
      const decidedAt =
        status === 'APPROVED' || status === 'REJECTED'
          ? new Date(when.getTime() + rng.int(4, 72) * 3600_000).toISOString()
          : null;

      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_indent_headers
           (indent_no, indent_date, indent_time, indent_type_id, department_id, cost_centre_id,
            suggested_supplier_id, requested_by_user_id, required_by_date, remarks, status,
            submitted_at, submitted_by, approved_at, approved_by, rejected_at, rejected_by,
            rejection_reason, created_by, updated_by, created_at, seed_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$8,$8,$19,'demo')
         RETURNING id`,
        [
          indentNo, dateStamp(when), timeStamp(when),
          rng.pick(indentTypes), rng.pick(departments), rng.pick(costCentres),
          rng.chance(0.55) ? rng.pick(suppliers).id : null,
          requester.id,
          dateStamp(dayOffset(daysAgo - rng.int(10, 45))),
          `[DEMO] ${rng.pick(['Routine replenishment', 'Breakdown replacement', 'Project requirement', 'Annual maintenance stock', 'New line commissioning', 'Site mobilisation'])}`,
          status,
          submittedAt, status === 'DRAFT' ? null : requester.id,
          status === 'APPROVED' ? decidedAt : null, status === 'APPROVED' ? head?.id ?? null : null,
          status === 'REJECTED' ? decidedAt : null, status === 'REJECTED' ? head?.id ?? null : null,
          status === 'REJECTED'
            ? rng.pick([
                'Budget not sanctioned for this cost centre.',
                'Duplicate of an existing open indent.',
                'Specification incomplete — resubmit with datasheet.',
                'Quantity exceeds annual consumption norm.',
              ])
            : null,
          when.toISOString(),
        ],
      );
      if (!header) return;

      const lineCount = rng.int(1, 5);
      const used = new Set<number>();
      for (let l = 1; l <= lineCount; l++) {
        let item = rng.pick(items);
        let guard = 0;
        while (used.has(item.id) && guard++ < 10) item = rng.pick(items);
        used.add(item.id);

        const qty = rng.pick([1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500]) * (rng.chance(0.15) ? 2 : 1);
        await tx.query(
          `INSERT INTO purchase_indent_lines
             (indent_id, line_no, item_id, item_code, item_description, indent_qty, uom_id,
              item_specification, department_id, cost_centre_id, estimated_rate, required_by_date, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'')`,
          [
            header.id, l, item.id, item.item_code, item.item_description, toQty(qty), item.uom_id,
            item.item_specification, item.department_id, item.cost_centre_id,
            item.standard_rate, dateStamp(dayOffset(daysAgo - rng.int(10, 45))),
          ],
        );
      }

      if (status !== 'DRAFT') {
        await tx.query(
          `INSERT INTO indent_approvals (indent_id, action, actor_user_id, from_status, to_status, created_at)
           VALUES ($1,'SUBMIT',$2,'DRAFT','PENDING_APPROVAL',$3)`,
          [header.id, requester.id, submittedAt],
        );
      }
      if (status === 'APPROVED' || status === 'REJECTED') {
        await tx.query(
          `INSERT INTO indent_approvals (indent_id, action, actor_user_id, from_status, to_status, reason, created_at)
           VALUES ($1,$2,$3,'PENDING_APPROVAL',$4,$5,$6)`,
          [
            header.id, status === 'APPROVED' ? 'APPROVE' : 'REJECT', head?.id ?? null, status,
            status === 'REJECTED' ? 'See rejection reason on the document.' : null, decidedAt,
          ],
        );
      }
      createdIndents.push({ id: header.id, status, date: when });
    });
  }
  logger.info(`  · ${createdIndents.length} demo indents`);

  /* Purchase Orders — a genuine mix of direct, single-indent and consolidated. */
  let poCount = 0;
  const createdPos: { id: number; date: Date }[] = [];

  // (a) Indent-sourced POs, including multi-indent consolidation.
  const approvedIndents = createdIndents.filter((i) => i.status === 'APPROVED');
  const consumedLines = new Set<number>();

  for (let round = 0; round < approvedIndents.length; round++) {
    if (!rng.chance(0.78)) continue;

    const supplier = rng.pick(suppliers);
    // Consolidate 1–3 approved indents onto one PO (SRS §11.1 types 2, 3 and 4).
    const groupSize = rng.chance(0.32) ? rng.int(2, 3) : 1;
    const group: typeof approvedIndents = [];
    for (let g = 0; g < groupSize; g++) {
      const cand = approvedIndents[(round + g * 7) % approvedIndents.length];
      if (cand && !group.includes(cand)) group.push(cand);
    }
    if (group.length === 0) continue;

    const latest = group.reduce((a, b) => (a.date > b.date ? a : b));
    const poDate = dayOffset(
      Math.max(0, Math.floor((today.getTime() - latest.date.getTime()) / 86400000) - rng.int(1, 8)),
    );

    const eligible = await query<{
      indent_line_id: number; indent_id: number; item_id: number; item_code: string;
      item_description: string; uom_id: number | null; item_specification: string;
      pending_qty: string; estimated_rate: string | null;
    }>(
      `SELECT indent_line_id, indent_id, item_id, item_code, item_description, uom_id,
              item_specification, pending_qty, estimated_rate
         FROM v_indent_line_balance
        WHERE indent_id = ANY($1) AND is_eligible_for_po = TRUE
        ORDER BY item_code, indent_line_id`,
      [group.map((g) => g.id)],
    );

    const usable = eligible.filter((e) => !consumedLines.has(Number(e.indent_line_id)));
    if (usable.length === 0) continue;

    // Merge the same item across indents onto ONE PO line with MULTIPLE sources —
    // this is what supplier-wise consolidation must produce.
    const byItem = new Map<number, typeof usable>();
    for (const e of usable) {
      const key = Number(e.item_id);
      const list = byItem.get(key) ?? [];
      list.push(e);
      byItem.set(key, list);
    }

    await withTransaction(async (tx) => {
      const poNo = await nextDocumentNumber(tx, 'PO', poDate);
      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_order_headers
           (po_no, po_date, po_time, po_type_id, supplier_id, currency_code, payment_terms,
            delivery_date, remarks, source_mode, status, issued_at, issued_by,
            created_by, updated_by, created_at, seed_tag)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,$8,'INDENT','OPEN',$9,$10,$10,$10,$9,'demo')
         RETURNING id`,
        [
          poNo, dateStamp(poDate), timeStamp(poDate), rng.pick(poTypes), supplier.id,
          supplier.payment_terms,
          dateStamp(new Date(poDate.getTime() + rng.int(7, 40) * 86400000)),
          `[DEMO] Consolidated from ${group.length} indent(s)`,
          poDate.toISOString(),
          rng.pick(purchaseUsers.length ? purchaseUsers : users).id,
        ],
      );
      if (!header) return;

      let lineNo = 0;
      for (const [, group2] of byItem) {
        const first = group2[0];
        if (!first) continue;

        // Take a slice of each source line's pending quantity — partial ordering is
        // the realistic case and it exercises the remaining-balance maths.
        const draws = group2
          .map((g) => {
            const pending = Number(g.pending_qty);
            const take = rng.chance(0.72) ? pending : Math.max(1, Math.floor(pending * rng.pick([0.3, 0.5, 0.6])));
            return { line: g, qty: Math.min(pending, take) };
          })
          .filter((d) => d.qty > 0);
        if (draws.length === 0) continue;

        const totalQty = draws.reduce((s, d) => s + d.qty, 0);
        const baseRate = Number(first.estimated_rate ?? 100);
        const rate = baseRate * (1 + (rng.next() - 0.45) * 0.14); // ±7% market variance
        const discount = rng.chance(0.62) ? rng.pick([2, 2.5, 3, 5, 7.5, 10, 12.5, 15]) : 0;

        lineNo += 1;
        const poLine = await txQueryOne<{ id: number }>(
          tx,
          `INSERT INTO purchase_order_lines
             (po_id, line_no, item_id, item_code, item_description, po_qty, uom_id,
              rate, discount_pct, item_specification, delivery_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
          [
            header.id, lineNo, first.item_id, first.item_code, first.item_description,
            toQty(totalQty), first.uom_id, toRate(rate), toRate(discount),
            first.item_specification,
            dateStamp(new Date(poDate.getTime() + rng.int(7, 40) * 86400000)),
          ],
        );
        if (!poLine) continue;

        for (const d of draws) {
          await tx.query(
            `INSERT INTO po_indent_sources (po_line_id, indent_line_id, indent_id, consumed_qty)
             VALUES ($1,$2,$3,$4)`,
            [poLine.id, d.line.indent_line_id, d.line.indent_id, toQty(d.qty)],
          );
          consumedLines.add(Number(d.line.indent_line_id));
        }
      }

      if (lineNo === 0) {
        throw new Error('__no_lines__');
      }
      createdPos.push({ id: header.id, date: poDate });
      poCount += 1;
    }).catch((e) => {
      if (!(e instanceof Error && e.message === '__no_lines__')) throw e;
    });
  }

  // (b) Direct POs — no originating indent (SRS §11.1 type 1).
  for (let i = 0; i < 16; i++) {
    const daysAgo = Math.floor((1 - Math.sqrt(rng.next())) * DAYS_BACK);
    const poDate = dayOffset(daysAgo);
    const supplier = rng.pick(suppliers);

    await withTransaction(async (tx) => {
      const poNo = await nextDocumentNumber(tx, 'PO', poDate);
      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_order_headers
           (po_no, po_date, po_time, po_type_id, supplier_id, currency_code, payment_terms,
            delivery_date, remarks, source_mode, status, issued_at, issued_by,
            created_by, updated_by, created_at, seed_tag)
         VALUES ($1,$2,$3,$4,$5,'INR',$6,$7,'[DEMO] Direct purchase order','DIRECT',$8,$9,$10,$10,$10,$9,'demo')
         RETURNING id`,
        [
          poNo, dateStamp(poDate), timeStamp(poDate), rng.pick(poTypes), supplier.id,
          supplier.payment_terms,
          dateStamp(new Date(poDate.getTime() + rng.int(5, 30) * 86400000)),
          daysAgo < 4 && rng.chance(0.4) ? 'DRAFT' : 'OPEN',
          daysAgo < 4 && rng.chance(0.4) ? null : poDate.toISOString(),
          rng.pick(purchaseUsers.length ? purchaseUsers : users).id,
        ],
      );
      if (!header) return;

      const lineCount = rng.int(1, 4);
      const used = new Set<number>();
      for (let l = 1; l <= lineCount; l++) {
        let item = rng.pick(items);
        let guard = 0;
        while (used.has(item.id) && guard++ < 10) item = rng.pick(items);
        used.add(item.id);

        const qty = rng.pick([2, 5, 10, 25, 50, 100, 150, 300]);
        const baseRate = Number(item.standard_rate ?? 100);
        const rate = baseRate * (1 + (rng.next() - 0.45) * 0.14);
        const discount = rng.chance(0.5) ? rng.pick([2, 3, 5, 8, 10]) : 0;

        await tx.query(
          `INSERT INTO purchase_order_lines
             (po_id, line_no, item_id, item_code, item_description, po_qty, uom_id,
              rate, discount_pct, item_specification, delivery_date)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            header.id, l, item.id, item.item_code, item.item_description, toQty(qty),
            item.uom_id, toRate(rate), toRate(discount), item.item_specification,
            dateStamp(new Date(poDate.getTime() + rng.int(5, 30) * 86400000)),
          ],
        );
      }
      createdPos.push({ id: header.id, date: poDate });
      poCount += 1;
    });
  }
  logger.info(`  · ${poCount} demo purchase orders`);

  /* GRNs — a realistic mix of full, partial and not-yet-received. */
  let grnCount = 0;
  for (const po of createdPos) {
    const poRow = await queryOne<{ status: string; supplier_id: number }>(
      'SELECT status, supplier_id FROM purchase_order_headers WHERE id = $1', [po.id],
    );
    if (!poRow || poRow.status !== 'OPEN') continue;

    const ageDays = Math.floor((today.getTime() - po.date.getTime()) / 86400000);
    // Fresh POs mostly await delivery; older ones are mostly received.
    const receiptRoll = rng.next();
    const mode = ageDays < 10
      ? (receiptRoll < 0.72 ? 'none' : 'partial')
      : ageDays < 35
        ? (receiptRoll < 0.2 ? 'none' : receiptRoll < 0.62 ? 'partial' : 'full')
        : (receiptRoll < 0.08 ? 'none' : receiptRoll < 0.28 ? 'partial' : 'full');
    if (mode === 'none') continue;

    const lines = await query<{ po_line_id: number; item_id: number; item_code: string;
      item_description: string; uom_id: number | null; pending_grn_qty: string; final_rate: string }>(
      `SELECT po_line_id, item_id, item_code, item_description, uom_id, pending_grn_qty, final_rate
         FROM v_po_line_balance WHERE po_id = $1 AND is_receivable = TRUE ORDER BY line_no`,
      [po.id],
    );
    if (lines.length === 0) continue;

    const grnDate = dayOffset(Math.max(0, ageDays - rng.int(2, Math.max(3, Math.floor(ageDays * 0.7)))));

    await withTransaction(async (tx) => {
      const grnNo = await nextDocumentNumber(tx, 'GRN', grnDate);
      const receiver = rng.pick(storeUsers.length ? storeUsers : users);
      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO grn_headers
           (grn_no, grn_date, grn_time, po_id, supplier_id, challan_no, challan_date,
            vehicle_no, received_by_user_id, remarks, status, posted_at, posted_by,
            created_by, updated_by, created_at, seed_tag)
         VALUES ($1,$2,$3,$4,$5,$6,$2,$7,$8,'[DEMO] Goods receipt','POSTED',$9,$8,$8,$8,$9,'demo')
         RETURNING id`,
        [
          grnNo, dateStamp(grnDate), timeStamp(grnDate), po.id, poRow.supplier_id,
          `CH-${rng.int(10000, 99999)}`,
          `MH${rng.int(10, 48)}${rng.pick(['AB', 'CD', 'GH', 'KL'])}${rng.int(1000, 9999)}`,
          receiver.id, grnDate.toISOString(),
        ],
      );
      if (!header) return;

      let ln = 0;
      for (const line of lines) {
        const pending = Number(line.pending_grn_qty);
        if (pending <= 0) continue;
        // In partial mode some lines are skipped entirely — that is what real
        // partial delivery looks like.
        if (mode === 'partial' && rng.chance(0.3)) continue;
        const qty = mode === 'full' ? pending : Math.max(1, Math.floor(pending * rng.pick([0.25, 0.4, 0.5, 0.6, 0.75])));
        if (qty <= 0) continue;

        ln += 1;
        await tx.query(
          `INSERT INTO grn_lines
             (grn_id, line_no, po_line_id, item_id, item_code, item_description, grn_qty, uom_id, rate)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            header.id, ln, line.po_line_id, line.item_id, line.item_code,
            line.item_description, toQty(qty), line.uom_id, line.final_rate,
          ],
        );
      }

      if (ln === 0) throw new Error('__no_lines__');

      // Recompute the PO status from the receipts just posted (ADR-003).
      const bal = await txQueryOne<{ derived_status: string }>(
        tx, 'SELECT derived_status FROM v_po_header_balance WHERE po_id = $1', [po.id],
      );
      if (bal) {
        await tx.query('UPDATE purchase_order_headers SET status = $2 WHERE id = $1', [po.id, bal.derived_status]);
      }
      grnCount += 1;
    }).catch((e) => {
      if (!(e instanceof Error && e.message === '__no_lines__')) throw e;
    });
  }
  logger.info(`  · ${grnCount} demo goods receipts`);

  // Close approved indents that ended up fully ordered.
  await withTransaction(async (tx) => {
    await tx.query(
      `UPDATE purchase_indent_headers h
          SET status = 'CLOSED', closed_at = now(), close_reason = 'Fully ordered'
        FROM v_indent_header_balance b
       WHERE b.indent_id = h.id AND h.status = 'APPROVED'
         AND b.line_count > 0 AND b.total_pending_qty <= 0`,
    );
  });

  await query(
    `INSERT INTO audit_logs (actor_employee_id, actor_name, action, entity, entity_label, source, message)
     VALUES ('SYSTEM','System','CREATE','seed','Demo dataset','SYSTEM',
             'Synthetic demo dataset generated. All records are tagged [DEMO] and are not real business data.')`,
  );

  logger.info('Demo seed complete — all demo records are tagged [DEMO].');
}
