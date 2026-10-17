/**
 * Export dataset catalogue (SRS §22, §35).
 *
 * Each dataset declares its permission, its human-readable column headers, and the
 * list it exports: the export parses the request with that list's own query schema
 * and selects its rows through that list's own filter builder, so a filtered export
 * holds exactly the rows the list shows. "Export current view" and "export full
 * dataset" are the same code path with different filter arguments.
 *
 * Until 2026-10-16 each dataset kept a smaller filter of its own, and ten filtered
 * exports differed from their lists on staging (audit A7, F06): indents for one item
 * showed 8 on screen and 1,814 in the file, GRNs pending QC 0 and 2,718, the "my
 * requisitions" view 22 requisitions and all 1,256 in the file.
 */
import type { z } from 'zod';
import type { SqlBuilder } from '../../db/index.js';
import { csvIdArray } from '../../core/http.js';
import { listSchema as itemListSchema, buildItemFilter } from '../masters/item.routes.js';
import { listSchema as supplierListSchema, buildSupplierFilter } from '../masters/supplier.routes.js';
import { listSchema as indentListSchema, buildIndentFilter, indentLineScope } from '../indent/routes.js';
import { listSchema as poListSchema, buildPoFilter, poLineScope, PO_FROM } from '../purchase-order/routes.js';
import { EVIDENCE_COUNTS_WITH, evidenceCountColumns } from '../purchase-order/receipt-evidence.js';
import { listSchema as grnListSchema, buildGrnFilter, grnLineScope, GRN_FROM } from '../grn/routes.js';
import {
  listSchema as requisitionListSchema, buildFilter as buildRequisitionFilter, LIST_FROM as REQUISITION_FROM,
} from '../requisition/routes.js';
import { listSchema as userListSchema, buildUserFilter } from '../admin/user.routes.js';
import { listSchema as auditListSchema, buildFilter as buildAuditFilter } from '../admin/audit.routes.js';

export interface ColumnDef {
  /** Column name as returned by the query. */
  key: string;
  /** Business-readable header written into the file (SRS §22). */
  header: string;
  /** Formatting hint for Excel. */
  type?: 'text' | 'number' | 'money' | 'date' | 'datetime';
  width?: number;
}

export interface ExportContext {
  /** The signed-in user: the requisition views "mine" and "hod-pending" are theirs, as on screen. */
  userId: number;
}

export interface DatasetDef {
  key: string;
  title: string;
  permission: string;
  columns: ColumnDef[];
  /** The exported list's query schema, plus `ids` to export chosen records only. */
  schema: z.ZodTypeAny;
  build(q: Record<string, unknown>, ctx: ExportContext): { sql: string; params: unknown[] };
}

function dataset<S extends z.ZodTypeAny>(def: Omit<DatasetDef, 'schema' | 'build'> & {
  schema: S;
  build: (q: z.infer<S>, ctx: ExportContext) => { sql: string; params: unknown[] };
}): DatasetDef {
  return def as DatasetDef;
}

/**
 * `column IN (the list's own row query)`: the list counts its rows with exactly this
 * FROM and WHERE, so the export can neither gain nor lose one.
 */
const inList = (column: string, listId: string, listFrom: string, b: SqlBuilder): string =>
  `${column} IN (SELECT ${listId} ${listFrom} ${b.where()})`;

const ITEM_FROM = 'FROM items i';
const SUPPLIER_FROM = 'FROM suppliers s';
const INDENT_FROM = 'FROM purchase_indent_headers h';
const USER_FROM = 'FROM users u';
const AUDIT_FROM = 'FROM audit_logs a';

export const DATASETS: Record<string, DatasetDef> = {
  /* ── Masters ──────────────────────────────────────────────────────────────── */
  items: dataset({
    key: 'items',
    title: 'Item Master',
    permission: 'item.export',
    columns: [
      { key: 'item_code', header: 'Item Code', width: 20 },
      { key: 'item_description', header: 'Item Description', width: 42 },
      { key: 'item_type_name', header: 'Item Type', width: 16 },
      { key: 'department_name', header: 'Department', width: 18 },
      { key: 'cost_centre_name', header: 'Cost Centre', width: 22 },
      { key: 'main_group_name', header: 'Main Group', width: 20 },
      { key: 'sub_main_group_name', header: 'Sub Main Group', width: 22 },
      { key: 'hsn_code', header: 'HSN Code', width: 12 },
      { key: 'indent_type_name', header: 'Indent Type', width: 14 },
      { key: 'uom_code', header: 'UOM', width: 8 },
      { key: 'item_specification', header: 'Item Specification', width: 45 },
      { key: 'standard_rate', header: 'Standard Rate', type: 'money', width: 14 },
      { key: 'is_active', header: 'Active', width: 8 },
    ],
    schema: itemListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildItemFilter(q);
      b.addIn('i.id', q.ids);
      return {
        sql: `SELECT i.item_code, i.item_description, it.name AS item_type_name,
                     d.name AS department_name, cc.name AS cost_centre_name,
                     mg.name AS main_group_name, smg.name AS sub_main_group_name,
                     i.hsn_code, ind.name AS indent_type_name, u.code AS uom_code,
                     i.item_specification, i.standard_rate, i.is_active
                FROM items i
                LEFT JOIN lookups it  ON it.id  = i.item_type_id
                LEFT JOIN lookups d   ON d.id   = i.department_id
                LEFT JOIN lookups cc  ON cc.id  = i.cost_centre_id
                LEFT JOIN lookups mg  ON mg.id  = i.main_group_id
                LEFT JOIN lookups smg ON smg.id = i.sub_main_group_id
                LEFT JOIN lookups ind ON ind.id = i.indent_type_id
                LEFT JOIN lookups u   ON u.id   = i.uom_id
               WHERE ${inList('i.id', 'i.id', ITEM_FROM, b)}
               ORDER BY i.item_code`,
        params: b.params,
      };
    },
  }),

  suppliers: dataset({
    key: 'suppliers',
    title: 'Supplier Master',
    permission: 'supplier.export',
    columns: [
      { key: 'supplier_code', header: 'Supplier Code', width: 16 },
      { key: 'supplier_name', header: 'Supplier Name', width: 34 },
      { key: 'address', header: 'Address', width: 40 },
      { key: 'city', header: 'City', width: 16 },
      { key: 'state', header: 'State', width: 18 },
      { key: 'country', header: 'Country', width: 14 },
      { key: 'mobile_no', header: 'Mobile No.', width: 18 },
      { key: 'email', header: 'Gmail ID', width: 28 },
      { key: 'gst_no', header: 'GST No', width: 20 },
      { key: 'payment_terms', header: 'Payment Terms', width: 16 },
      { key: 'currency_code', header: 'Currency', width: 10 },
      { key: 'contact_person', header: 'Contact Person', width: 22 },
      { key: 'is_active', header: 'Active', width: 8 },
    ],
    schema: supplierListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildSupplierFilter(q);
      b.addIn('s.id', q.ids);
      return {
        sql: `SELECT s.supplier_code, s.supplier_name, s.address, s.city, s.state, s.country,
                     s.mobile_no, s.email, s.gst_no, s.payment_terms, s.currency_code,
                     s.contact_person, s.is_active
                FROM suppliers s
               WHERE ${inList('s.id', 's.id', SUPPLIER_FROM, b)}
               ORDER BY s.supplier_name`,
        params: b.params,
      };
    },
  }),

  /* ── Transactions ─────────────────────────────────────────────────────────── */
  indents: dataset({
    key: 'indents',
    title: 'Purchase Indents',
    permission: 'indent.export',
    columns: [
      { key: 'indent_no', header: 'Indent No', width: 20 },
      { key: 'indent_date', header: 'Date', type: 'date', width: 12 },
      { key: 'indent_time', header: 'Time', width: 10 },
      { key: 'indent_type_name', header: 'Indent Type', width: 14 },
      { key: 'department_name', header: 'Department', width: 18 },
      { key: 'cost_centre_name', header: 'Cost Centre', width: 22 },
      { key: 'status', header: 'Status', width: 18 },
      { key: 'requested_by_name', header: 'Requested By', width: 22 },
      { key: 'approved_by_name', header: 'Approved By', width: 22 },
      { key: 'line_count', header: 'Lines', type: 'number', width: 8 },
      { key: 'total_indent_qty', header: 'Indent Qty', type: 'number', width: 14 },
      { key: 'total_ordered_qty', header: 'Ordered Qty', type: 'number', width: 14 },
      { key: 'total_pending_qty', header: 'Pending Qty', type: 'number', width: 14 },
      { key: 'total_estimated_value', header: 'Estimated Value', type: 'money', width: 16 },
      { key: 'rejection_reason', header: 'Rejection Reason', width: 34 },
      { key: 'remarks', header: 'Remarks', width: 30 },
    ],
    schema: indentListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildIndentFilter(q);
      b.addIn('h.id', q.ids);
      return {
        sql: `SELECT h.indent_no, h.indent_date, h.indent_time, it.name AS indent_type_name,
                     d.name AS department_name, cc.name AS cost_centre_name, h.status,
                     u.employee_name AS requested_by_name, ap.employee_name AS approved_by_name,
                     b.line_count, b.total_indent_qty, b.total_ordered_qty, b.total_pending_qty,
                     b.total_estimated_value, h.rejection_reason, h.remarks
                FROM purchase_indent_headers h
                JOIN v_indent_header_balance b ON b.indent_id = h.id
                LEFT JOIN lookups it ON it.id = h.indent_type_id
                LEFT JOIN lookups d  ON d.id  = h.department_id
                LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
                LEFT JOIN users u  ON u.id  = h.requested_by_user_id
                LEFT JOIN users ap ON ap.id = h.approved_by
               WHERE ${inList('h.id', 'h.id', INDENT_FROM, b)}
               ORDER BY h.indent_date DESC, h.indent_no DESC`,
        params: b.params,
      };
    },
  }),

  // The lines the indent list's tiles add up: every line of the indents it shows, or under
  // the item filter only that item's lines (indentLineScope).
  'indent-lines': dataset({
    key: 'indent-lines',
    title: 'Purchase Indent Lines',
    permission: 'indent.export',
    columns: [
      { key: 'indent_no', header: 'Indent No', width: 20 },
      { key: 'indent_date', header: 'Date', type: 'date', width: 12 },
      { key: 'indent_status', header: 'Status', width: 18 },
      { key: 'line_no', header: 'Line', type: 'number', width: 7 },
      { key: 'item_code', header: 'Item Code', width: 20 },
      { key: 'item_description', header: 'Item Description', width: 42 },
      { key: 'indent_qty', header: 'Indent Qty', type: 'number', width: 13 },
      { key: 'uom_code', header: 'UOM', width: 8 },
      { key: 'ordered_qty', header: 'Ordered Qty', type: 'number', width: 13 },
      { key: 'pending_qty', header: 'Pending Qty', type: 'number', width: 13 },
      { key: 'item_specification', header: 'Item Specification', width: 40 },
      { key: 'department_name', header: 'Department', width: 18 },
      { key: 'cost_centre_name', header: 'Cost Centre', width: 22 },
      { key: 'line_status', header: 'Line Status', width: 18 },
    ],
    schema: indentListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildIndentFilter(q);
      b.addIn('h.id', q.ids);
      const scope = indentLineScope(q, b, 'v');
      return {
        sql: `SELECT v.indent_no, v.indent_date, v.indent_status, v.line_no, v.item_code,
                     v.item_description, v.indent_qty, u.code AS uom_code, v.ordered_qty,
                     v.pending_qty, v.item_specification, d.name AS department_name,
                     cc.name AS cost_centre_name, v.line_status
                FROM v_indent_line_balance v
                LEFT JOIN lookups u  ON u.id  = v.uom_id
                LEFT JOIN lookups d  ON d.id  = v.department_id
                LEFT JOIN lookups cc ON cc.id = v.cost_centre_id
               WHERE ${inList('v.indent_id', 'h.id', INDENT_FROM, b)}${scope ? ` AND ${scope}` : ''}
               ORDER BY v.indent_date DESC, v.indent_no DESC, v.line_no`,
        params: b.params,
      };
    },
  }),

  'purchase-orders': dataset({
    key: 'purchase-orders',
    title: 'Purchase Orders',
    permission: 'po.export',
    columns: [
      { key: 'po_no', header: 'PO No', width: 20 },
      { key: 'po_date', header: 'Date', type: 'date', width: 12 },
      { key: 'po_time', header: 'Time', width: 10 },
      { key: 'po_type_name', header: 'PO Type', width: 14 },
      { key: 'supplier_name', header: 'Supplier', width: 32 },
      { key: 'status', header: 'Status', width: 20 },
      { key: 'source_mode', header: 'Source', width: 10 },
      { key: 'source_indents', header: 'Source Indents', width: 30 },
      { key: 'line_count', header: 'Lines', type: 'number', width: 8 },
      { key: 'total_po_qty', header: 'PO Qty', type: 'number', width: 13 },
      { key: 'total_received_qty', header: 'Received Qty', type: 'number', width: 14 },
      { key: 'total_pending_qty', header: 'Pending GRN Qty', type: 'number', width: 16 },
      { key: 'total_amount', header: 'Amount', type: 'money', width: 16 },
      { key: 'received_amount', header: 'Received Value', type: 'money', width: 16 },
      { key: 'pending_amount', header: 'Pending Value', type: 'money', width: 16 },
      { key: 'payment_terms', header: 'Payment Terms', width: 16 },
      { key: 'delivery_date', header: 'Delivery Date', type: 'date', width: 13 },
      { key: 'remarks', header: 'Remarks', width: 30 },
      { key: 'store_receipts_awaiting_link', header: 'Store Receipts Awaiting Link', type: 'number', width: 16 },
      { key: 'store_sheet_receipts', header: 'Receipts on Store Sheet Only', type: 'number', width: 16 },
    ],
    // The Pending / Complete views, "overdue only" and the receipt evidence included: the
    // file once held every PO.
    schema: poListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildPoFilter(q);
      b.addIn('h.id', q.ids);
      return {
        // The receipt evidence counts are each built once and looked up, as on the list.
        sql: `WITH ${EVIDENCE_COUNTS_WITH}
              SELECT h.po_no, h.po_date, h.po_time, pt.name AS po_type_name, s.supplier_name,
                     h.status, h.source_mode,
                     (SELECT string_agg(DISTINCT src.indent_no, ', ')
                        FROM v_po_line_sources src WHERE src.po_id = h.id) AS source_indents,
                     b.line_count, b.total_po_qty, b.total_received_qty, b.total_pending_qty,
                     b.total_amount, b.received_amount, b.pending_amount,
                     h.payment_terms, h.delivery_date, h.remarks,
                     ${evidenceCountColumns('h')}
                FROM purchase_order_headers h
                JOIN v_po_header_balance b ON b.po_id = h.id
                JOIN suppliers s ON s.id = h.supplier_id
                LEFT JOIN lookups pt ON pt.id = h.po_type_id
               WHERE ${inList('h.id', 'h.id', PO_FROM, b)}
               ORDER BY h.po_date DESC, h.po_no DESC`,
        params: b.params,
      };
    },
  }),

  // The lines the PO list's tiles add up: every line of the orders it shows, or under an
  // item-level filter only that filter's lines (poLineScope).
  'po-lines': dataset({
    key: 'po-lines',
    title: 'Purchase Order Lines',
    permission: 'po.export',
    columns: [
      { key: 'po_no', header: 'PO No', width: 20 },
      { key: 'po_date', header: 'Date', type: 'date', width: 12 },
      { key: 'po_type_name', header: 'PO Type', width: 14 },
      { key: 'supplier_name', header: 'Supplier', width: 30 },
      { key: 'source_indents', header: 'Indent No', width: 24 },
      { key: 'line_no', header: 'Line', type: 'number', width: 7 },
      { key: 'item_code', header: 'Item Code', width: 20 },
      { key: 'item_description', header: 'Item Description', width: 40 },
      { key: 'po_qty', header: 'PO Qty', type: 'number', width: 12 },
      { key: 'uom_code', header: 'UOM', width: 8 },
      { key: 'rate', header: 'Rate/pc', type: 'money', width: 13 },
      { key: 'discount_pct', header: 'Discount %', type: 'number', width: 12 },
      { key: 'final_rate', header: 'Final Rate/pc', type: 'money', width: 14 },
      { key: 'amount', header: 'Amount', type: 'money', width: 15 },
      { key: 'received_qty', header: 'Received Qty', type: 'number', width: 13 },
      { key: 'pending_grn_qty', header: 'Pending GRN Qty', type: 'number', width: 16 },
      { key: 'item_specification', header: 'Item Specification', width: 40 },
      { key: 'line_status', header: 'Line Status', width: 20 },
    ],
    schema: poListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildPoFilter(q);
      b.addIn('h.id', q.ids);
      const scope = poLineScope(q, b, 'v');
      return {
        sql: `SELECT v.po_no, v.po_date, pt.name AS po_type_name, s.supplier_name,
                     (SELECT string_agg(DISTINCT src.indent_no, ', ')
                        FROM v_po_line_sources src WHERE src.po_line_id = v.po_line_id) AS source_indents,
                     v.line_no, v.item_code, v.item_description, v.po_qty, u.code AS uom_code,
                     v.rate, v.discount_pct, v.final_rate, v.amount, v.received_qty,
                     v.pending_grn_qty, v.item_specification, v.line_status
                FROM v_po_line_balance v
                JOIN suppliers s ON s.id = v.supplier_id
                LEFT JOIN lookups pt ON pt.id = v.po_type_id
                LEFT JOIN lookups u  ON u.id  = v.uom_id
               WHERE ${inList('v.po_id', 'h.id', PO_FROM, b)}${scope ? ` AND ${scope}` : ''}
               ORDER BY v.po_date DESC, v.po_no DESC, v.line_no`,
        params: b.params,
      };
    },
  }),

  grn: dataset({
    key: 'grn',
    title: 'Goods Receipt Notes',
    permission: 'grn.export',
    columns: [
      { key: 'grn_no', header: 'GRN No', width: 20 },
      { key: 'grn_date', header: 'Date', type: 'date', width: 12 },
      { key: 'grn_time', header: 'Time', width: 10 },
      { key: 'po_no', header: 'PO No', width: 20 },
      { key: 'po_type_name', header: 'PO Type', width: 14 },
      { key: 'supplier_name', header: 'Supplier', width: 30 },
      { key: 'status', header: 'Status', width: 12 },
      { key: 'challan_no', header: 'Challan No', width: 16 },
      { key: 'received_by_name', header: 'Received By', width: 22 },
      { key: 'line_count', header: 'Lines', type: 'number', width: 8 },
      { key: 'total_qty', header: 'GRN Qty', type: 'number', width: 13 },
      { key: 'total_amount', header: 'Value', type: 'money', width: 16 },
      { key: 'remarks', header: 'Remarks', width: 30 },
    ],
    // QC status, PO, mode and GRN type included: the file once held every GRN.
    schema: grnListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildGrnFilter(q);
      b.addIn('g.id', q.ids);
      return {
        sql: `SELECT g.grn_no, g.grn_date, g.grn_time, p.po_no, pt.name AS po_type_name,
                     s.supplier_name, g.status, g.challan_no, u.employee_name AS received_by_name,
                     COALESCE(agg.line_count, 0) AS line_count,
                     COALESCE(agg.total_qty, 0) AS total_qty,
                     COALESCE(agg.total_amount, 0) AS total_amount, g.remarks
                FROM grn_headers g
                LEFT JOIN purchase_order_headers p ON p.id = g.po_id
                JOIN suppliers s ON s.id = g.supplier_id
                LEFT JOIN lookups pt ON pt.id = p.po_type_id
                LEFT JOIN users u ON u.id = g.received_by_user_id
                LEFT JOIN (SELECT grn_id, COUNT(*)::int AS line_count,
                                  SUM(grn_qty) AS total_qty, SUM(amount) AS total_amount
                             FROM grn_lines GROUP BY grn_id) agg ON agg.grn_id = g.id
               WHERE ${inList('g.id', 'g.id', GRN_FROM, b)}
               ORDER BY g.grn_date DESC, g.grn_no DESC`,
        params: b.params,
      };
    },
  }),

  // The lines the GRN list's tiles add up: every line of the receipts it shows, or under
  // an item-level filter only that filter's lines (grnLineScope).
  'grn-lines': dataset({
    key: 'grn-lines',
    title: 'GRN Lines',
    permission: 'grn.export',
    columns: [
      { key: 'grn_no', header: 'GRN No', width: 20 },
      { key: 'grn_date', header: 'Date', type: 'date', width: 12 },
      { key: 'po_no', header: 'PO No', width: 20 },
      { key: 'po_type_name', header: 'PO Type', width: 14 },
      { key: 'supplier_name', header: 'Supplier', width: 28 },
      { key: 'item_code', header: 'Item Code', width: 20 },
      { key: 'item_description', header: 'Item Description', width: 40 },
      { key: 'grn_qty', header: 'GRN Qty', type: 'number', width: 12 },
      { key: 'uom_code', header: 'UOM', width: 8 },
      { key: 'rate', header: 'Rate', type: 'money', width: 13 },
      { key: 'amount', header: 'Value', type: 'money', width: 15 },
      { key: 'po_qty', header: 'PO Qty', type: 'number', width: 12 },
      { key: 'pending_grn_qty', header: 'Pending GRN Qty', type: 'number', width: 16 },
      { key: 'status', header: 'GRN Status', width: 12 },
    ],
    schema: grnListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildGrnFilter(q);
      b.addIn('g.id', q.ids);
      const scope = grnLineScope(q, b, 'gl');
      return {
        // po_no is joined through the LINE's own po_line_id, not the header's
        // po_id — correct for a multi-PO GRN, and NULL for a Direct GRN line.
        sql: `SELECT g.grn_no, g.grn_date, p.po_no, pt.name AS po_type_name, s.supplier_name,
                     gl.item_code, gl.item_description, gl.grn_qty, u.code AS uom_code,
                     gl.rate, gl.amount, bal.po_qty, bal.pending_grn_qty, g.status
                FROM grn_lines gl
                JOIN grn_headers g ON g.id = gl.grn_id
                JOIN suppliers s ON s.id = g.supplier_id
                LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                LEFT JOIN purchase_order_headers p ON p.id = pol.po_id
                LEFT JOIN lookups pt ON pt.id = p.po_type_id
                LEFT JOIN lookups u  ON u.id  = gl.uom_id
                LEFT JOIN v_po_line_balance bal ON bal.po_line_id = gl.po_line_id
               WHERE ${inList('gl.grn_id', 'g.id', GRN_FROM, b)}${scope ? ` AND ${scope}` : ''}
               ORDER BY g.grn_date DESC, g.grn_no DESC, gl.line_no`,
        params: b.params,
      };
    },
  }),

  /* ── Requisition (Purchase Module tab 4) ─────────────────────────────────── */
  requisitions: dataset({
    key: 'requisitions',
    title: 'Requisitions',
    permission: 'requisition.export',
    columns: [
      { key: 'requisition_no', header: 'Requisition No', width: 20 },
      { key: 'requisition_date', header: 'Date', type: 'date', width: 12 },
      { key: 'employee_name', header: 'Requester', width: 24 },
      { key: 'employee_code', header: 'Employee Code', width: 14 },
      { key: 'department_name', header: 'Department', width: 18 },
      { key: 'hod_name', header: 'HOD', width: 22 },
      { key: 'machine_name', header: 'Machine No', width: 16 },
      { key: 'cost_centre_name', header: 'Cost Centre', width: 20 },
      { key: 'line_count', header: 'Lines', type: 'number', width: 8 },
      { key: 'total_requested_qty', header: 'Requested Qty', type: 'number', width: 14 },
      { key: 'total_issued_qty', header: 'Issued Qty', type: 'number', width: 14 },
      { key: 'total_pending_qty', header: 'Pending Qty', type: 'number', width: 14 },
      { key: 'hod_status', header: 'HOD Status', width: 14 },
      { key: 'store_status', header: 'Store Status', width: 14 },
      { key: 'remarks', header: 'Remarks', width: 30 },
    ],
    schema: requisitionListSchema.extend({ ids: csvIdArray }),
    build: (q, ctx) => {
      const b = buildRequisitionFilter(q, ctx.userId);
      b.addIn('h.id', q.ids);
      return {
        sql: `SELECT h.requisition_no, h.requisition_date, h.employee_name, h.employee_code,
                     h.department_name, h.hod_name, m.name AS machine_name, cc.name AS cost_centre_name,
                     b.line_count, b.total_requested_qty, b.total_issued_qty, b.total_pending_qty,
                     b.hod_status, b.store_status, h.remarks
                FROM requisition_headers h
                JOIN v_requisition_header_balance b ON b.requisition_id = h.id
                LEFT JOIN lookups m  ON m.id  = h.machine_id
                LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
               WHERE ${inList('h.id', 'h.id', REQUISITION_FROM, b)}
               ORDER BY h.requisition_date DESC, h.requisition_no DESC`,
        params: b.params,
      };
    },
  }),

  // Every line of the requisitions the requisition list shows — its Mine, HOD and Store
  // queue views included, which the file used to ignore.
  'requisition-lines': dataset({
    key: 'requisition-lines',
    title: 'Requisition Lines',
    permission: 'requisition.export',
    // Column order mirrors the business "Requisition" reference sheet exactly
    // (Sr no, Item code, Item Name, UOM, Main Group, User Name, Department,
    // Machine No, Cost Centre, Requisition Qty, Requisition Date, Requisition
    // No, HOD Name, HOD Approval Status, Issue Slip No, Issue Date, Issued
    // Qty, Remarks) — one row per item line, never one row per requisition.
    columns: [
      { key: 'item_code', header: 'Item Code', width: 20 },
      { key: 'item_description', header: 'Item Name', width: 36 },
      { key: 'uom_code', header: 'UOM', width: 8 },
      { key: 'main_group_name', header: 'Main Group', width: 18 },
      { key: 'employee_name', header: 'User Name', width: 24 },
      { key: 'department_name', header: 'Department', width: 18 },
      { key: 'machine_name', header: 'Machine No', width: 16 },
      { key: 'cost_centre_name', header: 'Cost Centre', width: 20 },
      { key: 'requested_qty', header: 'Requisition Qty', type: 'number', width: 14 },
      { key: 'requisition_date', header: 'Requisition Date', type: 'date', width: 14 },
      { key: 'requisition_no', header: 'Requisition No', width: 20 },
      { key: 'hod_name', header: 'HOD Name', width: 22 },
      { key: 'hod_status', header: 'HOD Approval Status', width: 16 },
      { key: 'last_issue_slip_no', header: 'Issue Slip No', width: 18 },
      { key: 'last_issue_date', header: 'Issue Date', type: 'date', width: 12 },
      { key: 'issued_qty', header: 'Issued Qty', type: 'number', width: 12 },
      { key: 'remarks', header: 'Remarks', width: 30 },
    ],
    schema: requisitionListSchema.extend({ ids: csvIdArray }),
    build: (q, ctx) => {
      const b = buildRequisitionFilter(q, ctx.userId);
      b.addIn('h.id', q.ids);
      return {
        sql: `SELECT l.item_code, l.item_description, u.code AS uom_code, l.main_group_name,
                     h.employee_name, h.department_name, m.name AS machine_name, cc.name AS cost_centre_name,
                     v.requested_qty, h.requisition_date, h.requisition_no, h.hod_name, bal.hod_status,
                     (SELECT i.issue_slip_no FROM requisition_issues i WHERE i.requisition_id = h.id AND i.status = 'POSTED'
                       ORDER BY i.created_at DESC LIMIT 1) AS last_issue_slip_no,
                     (SELECT MAX(i.issue_date) FROM requisition_issues i
                       WHERE i.requisition_id = h.id AND i.status = 'POSTED') AS last_issue_date,
                     v.issued_qty, l.remarks
                FROM requisition_lines l
                JOIN requisition_headers h ON h.id = l.requisition_id
                JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
                JOIN v_requisition_header_balance bal ON bal.requisition_id = h.id
                LEFT JOIN lookups u  ON u.id  = l.uom_id
                LEFT JOIN lookups m  ON m.id  = h.machine_id
                LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
               WHERE ${inList('h.id', 'h.id', REQUISITION_FROM, b)}
               ORDER BY h.requisition_date DESC, h.requisition_no DESC, l.line_no`,
        params: b.params,
      };
    },
  }),

  users: dataset({
    key: 'users',
    title: 'User Master',
    permission: 'user.export',
    columns: [
      { key: 'employee_id', header: 'Employee ID', width: 14 },
      { key: 'employee_name', header: 'Employee Name', width: 28 },
      { key: 'designation', header: 'Designation', width: 26 },
      { key: 'department_name', header: 'Department', width: 20 },
      { key: 'email', header: 'Email', width: 28 },
      { key: 'mobile_no', header: 'Mobile No.', width: 16 },
      { key: 'roles', header: 'Roles', width: 30 },
      { key: 'is_active', header: 'Active', width: 8 },
      { key: 'last_login_at', header: 'Last Sign-in', type: 'datetime', width: 20 },
    ],
    schema: userListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildUserFilter(q);
      b.addIn('u.id', q.ids);
      return {
        sql: `SELECT u.employee_id, u.employee_name, u.designation, d.name AS department_name,
                     u.email, u.mobile_no,
                     (SELECT string_agg(r.name, ', ' ORDER BY r.name)
                        FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                       WHERE ur.user_id = u.id) AS roles,
                     u.is_active, u.last_login_at
                FROM users u
                LEFT JOIN lookups d ON d.id = u.department_id
               WHERE ${inList('u.id', 'u.id', USER_FROM, b)}
               ORDER BY u.employee_name`,
        params: b.params,
      };
    },
  }),

  audit: dataset({
    key: 'audit',
    title: 'Audit Log',
    permission: 'audit.export',
    columns: [
      { key: 'created_at', header: 'Timestamp', type: 'datetime', width: 22 },
      { key: 'actor_employee_id', header: 'Employee ID', width: 14 },
      { key: 'actor_name', header: 'User', width: 24 },
      { key: 'action', header: 'Action', width: 18 },
      { key: 'entity', header: 'Entity', width: 20 },
      { key: 'entity_label', header: 'Record', width: 28 },
      { key: 'source', header: 'Source', width: 14 },
      { key: 'result', header: 'Result', width: 12 },
      { key: 'message', header: 'Message', width: 44 },
      { key: 'ip_address', header: 'IP Address', width: 16 },
    ],
    // Action, entity, record, user, source and result included (entity=grn: 44 on screen,
    // 1,430 in the file); no silent 50,000-row cut either — the route refuses instead.
    schema: auditListSchema.extend({ ids: csvIdArray }),
    build: (q) => {
      const b = buildAuditFilter(q);
      b.addIn('a.id', q.ids);
      return {
        sql: `SELECT a.created_at, a.actor_employee_id, a.actor_name, a.action, a.entity,
                     a.entity_label, a.source, a.result, a.message, a.ip_address
                FROM audit_logs a
               WHERE ${inList('a.id', 'a.id', AUDIT_FROM, b)}
               ORDER BY a.created_at DESC, a.id DESC`,
        params: b.params,
      };
    },
  }),
};

export const DATASET_KEYS = Object.keys(DATASETS);
