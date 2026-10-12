/**
 * Master tabs: Item Master, Supplier Master, User Master, Lookup & Configuration.
 *
 * Item Master is the tab this redesign is really shaped around. It holds 12,461
 * rows today and has to stay cheap at 100,000, so it is deliberately FLAT: six
 * primary-key joins into `lookups` for the human labels, and nothing else. The
 * previous version carried four correlated subqueries per row over the balance
 * views ("Open Indent Qty", "Pending GRN Qty", "Total Received Qty"), i.e.
 * ~50,000 subplan executions per export, each aggregating the whole PO and GRN
 * population. Those figures belong on the transaction tabs, where there is one
 * row per transaction rather than one per item.
 *
 * Lookup & Configuration replaces FOURTEEN separate tabs. Department, Cost
 * Centre, Machine, UOM, Currency, Payment Terms, Item Type, Main Group, Sub
 * Main Group, PO/Indent/GRN Type, State and City are not fourteen tables — they
 * are fourteen values of `lookups.category` in ONE table, so they are one tab
 * with a Category column. (PACKING_TYPE and LOCATION had no tab at all under
 * the old layout even though the GRN tab exports both; folding by category
 * fixes that by construction.)
 */
import type { BusinessView } from './types.js';
import { ts, qty, money, yesNo } from './common.js';

/* ── Item Master ────────────────────────────────────────────────────────────── */

export const ITEM_MASTER: BusinessView = {
  sheet: 'Item Master',
  description: 'Every stock item with its classification, rates, stock policy and current live stock.',
  from: `items i
       LEFT JOIN lookups lk_type ON lk_type.id = i.item_type_id
       LEFT JOIN lookups lk_uom  ON lk_uom.id  = i.uom_id
       LEFT JOIN lookups lk_mg   ON lk_mg.id   = i.main_group_id
       LEFT JOIN lookups lk_smg  ON lk_smg.id  = i.sub_main_group_id
       LEFT JOIN lookups lk_dept ON lk_dept.id = i.department_id
       LEFT JOIN lookups lk_cc   ON lk_cc.id   = i.cost_centre_id`,
  where: 'i.deleted_at IS NULL',
  orderBy: 'i.id',
  primaryKey: ['Item ID'],
  columns: [
    { header: 'Item ID', expr: 'i.id', cls: 'D' },
    { header: 'Item Code', expr: 'i.item_code', cls: 'A' },
    { header: 'Item Description', expr: 'i.item_description', cls: 'A' },
    { header: 'Specification', expr: 'i.item_specification', cls: 'A' },
    { header: 'Item Type', expr: 'lk_type.name', cls: 'A' },
    { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
    { header: 'Main Group', expr: 'lk_mg.name', cls: 'A' },
    { header: 'Sub Main Group', expr: 'lk_smg.name', cls: 'A' },
    { header: 'Department', expr: 'lk_dept.name', cls: 'B' },
    { header: 'Cost Centre', expr: 'lk_cc.name', cls: 'B' },
    { header: 'HSN Code', expr: 'i.hsn_code', cls: 'A' },
    { header: 'Standard Rate', expr: money('i.standard_rate'), cls: 'A' },
    { header: 'GST %', expr: qty('i.gst_rate'), cls: 'A' },
    { header: 'Min Stock', expr: qty('i.min_stock'), cls: 'A' },
    { header: 'Max Stock', expr: qty('i.max_stock'), cls: 'A' },
    { header: 'Reorder Level', expr: qty('i.reorder_level'), cls: 'A' },
    { header: 'Active', expr: yesNo('i.is_active'), cls: 'B' },
    { header: 'Current Live Stock', expr: qty('i.live_stock_qty'), cls: 'A' },
    { header: 'Created At', expr: ts('i.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('i.updated_at'), cls: 'B' },
  ],
  sources: [
    { table: 'items', restrict: 'i.id::text = ANY($1)' },
    // A lookup rename legitimately touches thousands of items. That is a bulk
    // operation, so it is handed to the paced background job rather than
    // rewritten inline — which is exactly the case that used to stall the ERP.
    {
      table: 'lookups',
      restrict: `(i.item_type_id::text = ANY($1) OR i.uom_id::text = ANY($1)
               OR i.main_group_id::text = ANY($1) OR i.sub_main_group_id::text = ANY($1)
               OR i.department_id::text = ANY($1) OR i.cost_centre_id::text = ANY($1))`,
      fanoutLimit: 200,
    },
  ],
  importTargets: [{
    table: 'items',
    pk: ['id'],
    fields: {
      'Item ID': 'id',
      'Item Code': 'item_code',
      'Item Description': 'item_description',
      Specification: 'item_specification',
      'Item Type': { column: 'item_type_id', lookup: 'ITEM_TYPE' },
      UOM: { column: 'uom_id', lookup: 'UOM' },
      'Main Group': { column: 'main_group_id', lookup: 'MAIN_GROUP' },
      'Sub Main Group': { column: 'sub_main_group_id', lookup: 'SUB_MAIN_GROUP' },
      Department: { column: 'department_id', lookup: 'DEPARTMENT' },
      'Cost Centre': { column: 'cost_centre_id', lookup: 'COST_CENTRE' },
      'HSN Code': 'hsn_code',
      'Standard Rate': 'standard_rate',
      'GST %': 'gst_rate',
      'Min Stock': 'min_stock',
      'Max Stock': 'max_stock',
      'Reorder Level': 'reorder_level',
      Active: 'is_active',
      // `Current Live Stock` is deliberately NOT importable: it is derived from
      // the stock ledger, and letting a sheet overwrite it would let a typo
      // silently replace the ERP's own stock arithmetic.
    },
  }],
};

/* ── Supplier Master ────────────────────────────────────────────────────────── */

export const SUPPLIER_MASTER: BusinessView = {
  sheet: 'Supplier Master',
  description: 'Supplier contact, tax, and default commercial terms. Purchase history lives on the PO and GRN tabs.',
  from: 'suppliers s',
  where: 's.deleted_at IS NULL',
  orderBy: 's.id',
  primaryKey: ['Supplier ID'],
  columns: [
    { header: 'Supplier ID', expr: 's.id', cls: 'D' },
    { header: 'Supplier Code', expr: 's.supplier_code', cls: 'A' },
    { header: 'Supplier Name', expr: 's.supplier_name', cls: 'A' },
    { header: 'Address', expr: 's.address', cls: 'A' },
    { header: 'City', expr: 's.city', cls: 'A' },
    { header: 'State', expr: 's.state', cls: 'A' },
    { header: 'Country', expr: 's.country', cls: 'A' },
    { header: 'Pin Code', expr: 's.pin_code', cls: 'A' },
    { header: 'Mobile No', expr: 's.mobile_no', cls: 'A' },
    { header: 'Email', expr: 's.email', cls: 'A' },
    { header: 'GST No', expr: 's.gst_no', cls: 'A' },
    { header: 'Contact Person', expr: 's.contact_person', cls: 'A' },
    { header: 'Payment Terms', expr: 's.payment_terms', cls: 'A' },
    { header: 'Currency', expr: 's.currency_code', cls: 'A' },
    { header: 'Active', expr: yesNo('s.is_active'), cls: 'B' },
    { header: 'Created At', expr: ts('s.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('s.updated_at'), cls: 'B' },
  ],
  sources: [{ table: 'suppliers', restrict: 's.id::text = ANY($1)' }],
  importTargets: [{
    table: 'suppliers',
    pk: ['id'],
    fields: {
      'Supplier ID': 'id',
      'Supplier Code': 'supplier_code',
      'Supplier Name': 'supplier_name',
      Address: 'address',
      City: 'city',
      State: 'state',
      Country: 'country',
      'Pin Code': 'pin_code',
      'Mobile No': 'mobile_no',
      Email: 'email',
      'GST No': 'gst_no',
      'Contact Person': 'contact_person',
      'Payment Terms': 'payment_terms',
      Currency: 'currency_code',
      Active: 'is_active',
    },
  }],
};

/* ── User / Employee Master ─────────────────────────────────────────────────── */

/**
 * Security columns are absent BY CONSTRUCTION, not by filtering: password_hash,
 * must_change_password, failed_login_count, locked_until, password_changed_at
 * and last_login_at have no expression here, and `user_sessions` is not a source
 * of any tab. There is nothing to accidentally widen.
 */
export const USER_MASTER: BusinessView = {
  sheet: 'User Master',
  description: 'Employees, their department and their roles. No credential, session or security data.',
  from: `users u
       LEFT JOIN lookups lk_dept ON lk_dept.id = u.department_id
       LEFT JOIN LATERAL (
         SELECT string_agg(r.name, ', ' ORDER BY r.name) AS names
           FROM user_roles ur JOIN roles r ON r.id = ur.role_id
          WHERE ur.user_id = u.id
       ) role_names ON TRUE`,
  where: 'u.deleted_at IS NULL',
  orderBy: 'u.id',
  primaryKey: ['User ID'],
  columns: [
    { header: 'User ID', expr: 'u.id', cls: 'D' },
    { header: 'Employee Code', expr: 'u.employee_id', cls: 'A' },
    { header: 'Employee Name', expr: 'u.employee_name', cls: 'A' },
    { header: 'Designation', expr: 'u.designation', cls: 'A' },
    { header: 'Department', expr: 'lk_dept.name', cls: 'A' },
    { header: 'Role', expr: "COALESCE(role_names.names, '')", cls: 'A' },
    { header: 'Email', expr: 'u.email', cls: 'A' },
    { header: 'Mobile No', expr: 'u.mobile_no', cls: 'B' },
    { header: 'Active', expr: yesNo('u.is_active'), cls: 'B' },
    { header: 'Created At', expr: ts('u.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('u.updated_at'), cls: 'B' },
  ],
  sources: [
    { table: 'users', restrict: 'u.id::text = ANY($1)' },
    { table: 'user_roles', restrict: 'u.id::text IN (SELECT split_part(k, chr(31), 1) FROM unnest($1::text[]) k)' },
    { table: 'roles', restrict: 'EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id::text = ANY($1))', fanoutLimit: 200 },
    { table: 'lookups', restrict: 'u.department_id::text = ANY($1)', fanoutLimit: 200 },
  ],
  importTargets: [{
    table: 'users',
    pk: ['id'],
    fields: {
      'User ID': 'id',
      'Employee Code': 'employee_id',
      'Employee Name': 'employee_name',
      Designation: 'designation',
      Department: { column: 'department_id', lookup: 'DEPARTMENT' },
      Email: 'email',
      'Mobile No': 'mobile_no',
      Active: 'is_active',
      // No credential column is importable. A sheet must never be able to set,
      // clear or weaken a password, and `Role` is a grant — it stays an
      // administrator action in the ERP rather than a spreadsheet edit.
    },
  }],
};

/* ── Lookup & Configuration (replaces 14 tabs) ──────────────────────────────── */

export const LOOKUP_CONFIG: BusinessView = {
  sheet: 'Lookup & Configuration',
  description:
    'Every configuration list in one tab, separated by Category: Department, Cost Centre, Machine, '
    + 'Item Type, Main Group, Sub Main Group, UOM, Currency, Payment Terms, Indent/PO/GRN Type, '
    + 'Packing Type, Location, State and City.',
  from: 'lookups l LEFT JOIN lookups p ON p.id = l.parent_id',
  where: 'l.deleted_at IS NULL',
  orderBy: 'l.id',
  primaryKey: ['Lookup ID'],
  columns: [
    { header: 'Lookup ID', expr: 'l.id', cls: 'D' },
    { header: 'Category', expr: 'l.category', cls: 'A' },
    { header: 'Code', expr: 'l.code', cls: 'A' },
    { header: 'Name', expr: 'l.name', cls: 'A' },
    { header: 'Description', expr: 'l.description', cls: 'B' },
    // Sub Main Group hangs off Main Group, and City off State; without the
    // parent the tab would list 395 sub-groups with no way to tell which group
    // each belongs to.
    { header: 'Parent ID', expr: 'l.parent_id', cls: 'D' },
    { header: 'Parent Name', expr: 'p.name', cls: 'A' },
    { header: 'Sort Order', expr: 'l.sort_order', cls: 'B' },
    { header: 'Active', expr: yesNo('l.is_active'), cls: 'B' },
    { header: 'Created At', expr: ts('l.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('l.updated_at'), cls: 'B' },
  ],
  sources: [
    { table: 'lookups', restrict: '(l.id::text = ANY($1) OR l.parent_id::text = ANY($1))', fanoutLimit: 500 },
  ],
  importTargets: [{
    table: 'lookups',
    pk: ['id'],
    fields: {
      'Lookup ID': 'id',
      Category: 'category',
      Code: 'code',
      Name: 'name',
      Description: 'description',
      'Parent ID': 'parent_id',
      'Sort Order': 'sort_order',
      Active: 'is_active',
    },
  }],
};

/* ── Indent / PO / GRN Type Master ─────────────────────────────────────────── */

export const PURCHASE_TYPE_MASTER: BusinessView = {
  sheet: 'Indent / PO / GRN Type',
  description:
    'Unified reference structure containing Indent Type, GRN Type, and PO Type dropdown values.',
  from: `(
    SELECT 
      l.name AS indent_type,
      l.name AS grn_type,
      l.name AS po_type,
      MIN(l.sort_order) AS sort_order
    FROM lookups l
    WHERE l.category IN ('INDENT_TYPE', 'PO_TYPE', 'GRN_TYPE')
      AND l.deleted_at IS NULL
    GROUP BY l.name
  ) t`,
  orderBy: 't.sort_order, t.indent_type',
  primaryKey: ['Indent Type'],
  columns: [
    { header: 'Indent Type', expr: 't.indent_type', cls: 'A' },
    { header: 'GRN Type', expr: 't.grn_type', cls: 'A' },
    { header: 'PO Type', expr: 't.po_type', cls: 'A' },
  ],
  sources: [
    { table: 'lookups', restrict: "l.category IN ('INDENT_TYPE', 'PO_TYPE', 'GRN_TYPE')" },
  ],
  importTargets: [
    {
      table: 'lookups',
      pk: ['name'],
      fields: {
        'Indent Type': { column: 'name', lookup: 'INDENT_TYPE' },
        'GRN Type': { column: 'name', lookup: 'GRN_TYPE' },
        'PO Type': { column: 'name', lookup: 'PO_TYPE' },
      },
    },
  ],
};

export const MASTER_VIEWS = [ITEM_MASTER, SUPPLIER_MASTER, USER_MASTER, LOOKUP_CONFIG, PURCHASE_TYPE_MASTER];

