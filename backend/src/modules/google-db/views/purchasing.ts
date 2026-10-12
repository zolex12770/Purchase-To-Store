/**
 * Purchasing tabs: Purchase Indent, Purchase Order, GRN.
 *
 * One tab per document type, line-grained, carrying the document's own state
 * AND its downstream linkage — so an indent line shows which POs consumed it
 * and which GRNs received against them, without a separate "history",
 * "status" or "receive" tab beside it.
 *
 * Every quantity is read from the authoritative balance views the ERP screens
 * read (`v_indent_line_balance`, `v_po_line_balance`), never re-derived here.
 * Where the raw view value is not the business answer, the correction is the
 * ERP's own rule, applied explicitly:
 *
 *   • Pending is zero on a PO line that can no longer receive. `pending_grn_qty`
 *     is GREATEST(po_qty - received, 0) for EVERY line, including CANCELLED and
 *     SHORT_CLOSED orders; the view publishes `is_receivable` precisely so
 *     consumers can exclude that dead supply, and the ERP's own metrics do.
 *
 *   • Only POSTED GRNs count as receipts, and only POSTED GRNs are listed as
 *     receiving GRNs. Listing DRAFT receipts beside "Received Qty: 0" asserted
 *     a receipt that had not happened.
 *
 *   • A CANCELLED PO releases its claim on an indent line, so it is excluded
 *     from ordered quantity AND from the PO numbers listed against that line.
 *
 *   • A DIRECT GRN (no PO line) still received goods and still moved stock, so
 *     its receipt totals come from the direct receipts rather than from a
 *     LEFT JOIN that can only produce NULL.
 *
 * Each aggregate is a LEFT JOIN LATERAL with no GROUP BY, which returns exactly
 * one row per driving line — a many-to-many join here would silently duplicate
 * a PO line once per source indent.
 */
import type { BusinessView } from './types.js';
import { d, ts, qty, money } from './common.js';

/* ── Purchase Indent ────────────────────────────────────────────────────────── */

export const PURCHASE_INDENT: BusinessView = {
  sheet: 'Purchase Indent',
  description:
    'Indent lines with approval state, the POs raised against them and the GRNs received — '
    + 'the whole indent life cycle on one row.',
  from: `v_indent_line_balance b
       JOIN purchase_indent_lines   il ON il.id = b.indent_line_id
       JOIN purchase_indent_headers ih ON ih.id = b.indent_id
       LEFT JOIN users   ru      ON ru.id = ih.requested_by_user_id
       LEFT JOIN users   au      ON au.id = ih.approved_by
       LEFT JOIN lookups lk_type ON lk_type.id = ih.indent_type_id
       LEFT JOIN lookups lk_dept ON lk_dept.id = b.department_id
       LEFT JOIN lookups lk_cc   ON lk_cc.id   = b.cost_centre_id
       LEFT JOIN lookups lk_uom  ON lk_uom.id  = b.uom_id
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT poh.po_no, ', ')                       AS po_nos,
                COALESCE(SUM(plb.received_qty), 0)                         AS received_qty,
                COALESCE(SUM(CASE WHEN plb.is_receivable
                                  THEN plb.pending_grn_qty ELSE 0 END), 0) AS pending_grn_qty
           FROM po_indent_sources     pis
           JOIN purchase_order_lines  pol ON pol.id = pis.po_line_id
           JOIN purchase_order_headers poh ON poh.id = pol.po_id
           JOIN v_po_line_balance     plb ON plb.po_line_id = pol.id
          WHERE pis.indent_line_id = b.indent_line_id
            AND poh.status <> 'CANCELLED'
       ) po ON TRUE
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT gh.grn_no, ', ') AS grn_nos
           FROM po_indent_sources pis
           JOIN grn_lines   gl ON gl.po_line_id = pis.po_line_id
           JOIN grn_headers gh ON gh.id = gl.grn_id
          WHERE pis.indent_line_id = b.indent_line_id
            AND gh.status = 'POSTED'
       ) g ON TRUE`,
  orderBy: 'b.indent_line_id',
  primaryKey: ['Indent ID', 'Indent Line ID'],
  columns: [
    { header: 'Indent ID', expr: 'b.indent_id', cls: 'D' },
    { header: 'Indent Line ID', expr: 'b.indent_line_id', cls: 'D' },
    { header: 'Indent No', expr: 'b.indent_no', cls: 'A' },
    { header: 'Indent Date', expr: d('b.indent_date'), cls: 'A' },
    { header: 'Indent Time', expr: 'ih.indent_time', cls: 'B' },
    { header: 'Indent Type', expr: 'lk_type.name', cls: 'A' },
    { header: 'Department', expr: 'lk_dept.name', cls: 'A' },
    { header: 'Cost Centre', expr: 'lk_cc.name', cls: 'B' },
    { header: 'Requested By ID', expr: 'ih.requested_by_user_id', cls: 'D' },
    { header: 'Requested By', expr: 'ru.employee_name', cls: 'A' },
    { header: 'Approval Status', expr: 'b.indent_status', cls: 'A' },
    { header: 'Approved By', expr: 'au.employee_name', cls: 'A' },
    { header: 'Approval Date', expr: ts('ih.approved_at'), cls: 'A' },
    { header: 'Line No', expr: 'b.line_no', cls: 'C' },
    { header: 'Item ID', expr: 'b.item_id', cls: 'D' },
    { header: 'Item Code', expr: 'b.item_code', cls: 'A' },
    { header: 'Item Description', expr: 'b.item_description', cls: 'A' },
    { header: 'Specification', expr: 'b.item_specification', cls: 'B' },
    { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
    { header: 'Indent Qty', expr: qty('b.indent_qty'), cls: 'A' },
    // The authoritative ordered quantity, which EXCLUDES cancelled POs. The
    // previous tab summed po_indent_sources directly and so contradicted the
    // Pending Qty printed beside it the moment an order was cancelled.
    { header: 'PO Qty', expr: qty('b.ordered_qty'), cls: 'A' },
    { header: 'Pending PO Qty', expr: qty('b.pending_qty'), cls: 'A' },
    { header: 'PO No(s)', expr: "COALESCE(po.po_nos, '')", cls: 'D' },
    { header: 'GRN No(s)', expr: "COALESCE(g.grn_nos, '')", cls: 'D' },
    // Named for what they are: receipts recorded against the PO LINES this
    // indent line fed. Where one PO line was fed by several indent lines the
    // ERP stores no per-indent apportionment, and inventing one here would be
    // a number the ERP itself cannot reproduce.
    { header: 'Received Qty (Linked PO)', expr: qty('COALESCE(po.received_qty, 0)'), cls: 'A' },
    { header: 'Pending GRN Qty (Linked PO)', expr: qty('COALESCE(po.pending_grn_qty, 0)'), cls: 'A' },
    { header: 'Line Status', expr: 'b.line_status', cls: 'A' },
    { header: 'Required By Date', expr: d('b.required_by_date'), cls: 'B' },
    { header: 'Estimated Rate', expr: money('b.estimated_rate'), cls: 'B' },
    { header: 'Line Remarks', expr: 'il.remarks', cls: 'B' },
    { header: 'Indent Remarks', expr: 'ih.remarks', cls: 'B' },
    { header: 'Created At', expr: ts('ih.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('il.updated_at'), cls: 'B' },
  ],
  sources: [
    { table: 'purchase_indent_lines', restrict: 'il.id::text = ANY($1)' },
    { table: 'purchase_indent_headers', restrict: 'ih.id::text = ANY($1)' },
    {
      table: 'po_indent_sources',
      restrict: 'il.id IN (SELECT indent_line_id FROM po_indent_sources WHERE id::text = ANY($1))',
    },
    {
      table: 'purchase_order_lines',
      restrict: 'il.id IN (SELECT indent_line_id FROM po_indent_sources WHERE po_line_id::text = ANY($1))',
    },
    {
      table: 'purchase_order_headers',
      restrict: `il.id IN (SELECT pis.indent_line_id FROM po_indent_sources pis
                             JOIN purchase_order_lines pol2 ON pol2.id = pis.po_line_id
                            WHERE pol2.po_id::text = ANY($1))`,
    },
    {
      table: 'grn_lines',
      restrict: `il.id IN (SELECT pis.indent_line_id FROM po_indent_sources pis
                            WHERE pis.po_line_id IN (SELECT po_line_id FROM grn_lines WHERE id::text = ANY($1)))`,
    },
    {
      table: 'grn_headers',
      restrict: `il.id IN (SELECT pis.indent_line_id FROM po_indent_sources pis
                             JOIN grn_lines gl2 ON gl2.po_line_id = pis.po_line_id
                            WHERE gl2.grn_id::text = ANY($1))`,
    },
    { table: 'items', restrict: 'il.item_id::text = ANY($1)', fanoutLimit: 200 },
    {
      table: 'users',
      restrict: '(ih.requested_by_user_id::text = ANY($1) OR ih.approved_by::text = ANY($1))',
      fanoutLimit: 200,
    },
    {
      table: 'lookups',
      restrict: `(ih.indent_type_id::text = ANY($1) OR b.department_id::text = ANY($1)
               OR b.cost_centre_id::text = ANY($1) OR b.uom_id::text = ANY($1))`,
      fanoutLimit: 200,
    },
  ],
  importTargets: [
    {
      table: 'purchase_indent_headers',
      pk: ['id'],
      fields: {
        'Indent ID': 'id',
        'Indent No': 'indent_no',
        'Indent Date': 'indent_date',
        'Indent Time': 'indent_time',
        'Indent Type': { column: 'indent_type_id', lookup: 'INDENT_TYPE' },
        Department: { column: 'department_id', lookup: 'DEPARTMENT' },
        'Cost Centre': { column: 'cost_centre_id', lookup: 'COST_CENTRE' },
        'Requested By ID': 'requested_by_user_id',
        'Approval Status': 'status',
        'Indent Remarks': 'remarks',
      },
    },
    {
      table: 'purchase_indent_lines',
      pk: ['id'],
      fields: {
        'Indent Line ID': 'id',
        'Indent ID': 'indent_id',
        'Line No': 'line_no',
        'Item ID': 'item_id',
        'Item Code': 'item_code',
        'Item Description': 'item_description',
        Specification: 'item_specification',
        UOM: { column: 'uom_id', lookup: 'UOM' },
        'Indent Qty': 'indent_qty',
        'Required By Date': 'required_by_date',
        'Estimated Rate': 'estimated_rate',
        'Line Remarks': 'remarks',
        // PO Qty / Pending / Received are DERIVED. They are exported so a human
        // can read the sheet, and never imported: the ERP recomputes them from
        // the transactions themselves.
      },
    },
  ],
};

/* ── Purchase Order ─────────────────────────────────────────────────────────── */

export const PURCHASE_ORDER: BusinessView = {
  sheet: 'Purchase Order',
  description:
    'PO lines with supplier, commercial terms, source indents, receipts and outstanding quantity.',
  from: `v_po_line_balance b
       JOIN purchase_order_lines   pol ON pol.id = b.po_line_id
       JOIN purchase_order_headers poh ON poh.id = b.po_id
       JOIN suppliers s ON s.id = poh.supplier_id
       LEFT JOIN users   cu        ON cu.id = poh.created_by
       LEFT JOIN users   iu        ON iu.id = poh.issued_by
       LEFT JOIN lookups lk_potype ON lk_potype.id = poh.po_type_id
       LEFT JOIN lookups lk_uom    ON lk_uom.id    = b.uom_id
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT src.indent_no, ', ')          AS indent_nos,
                string_agg(DISTINCT src.indent_id::text, ', ')    AS indent_ids
           FROM v_po_line_sources src
          WHERE src.po_line_id = b.po_line_id
       ) ind ON TRUE
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT gh.grn_no, ', ') AS grn_nos
           FROM grn_lines   gl
           JOIN grn_headers gh ON gh.id = gl.grn_id
          WHERE gl.po_line_id = b.po_line_id
            AND gh.status = 'POSTED'
       ) g ON TRUE`,
  orderBy: 'b.po_line_id',
  primaryKey: ['PO ID', 'PO Line ID'],
  columns: [
    { header: 'PO ID', expr: 'b.po_id', cls: 'D' },
    { header: 'PO Line ID', expr: 'b.po_line_id', cls: 'D' },
    { header: 'PO No', expr: 'b.po_no', cls: 'A' },
    { header: 'PO Date', expr: d('b.po_date'), cls: 'A' },
    { header: 'PO Time', expr: 'poh.po_time', cls: 'B' },
    { header: 'PO Type', expr: 'lk_potype.name', cls: 'A' },
    { header: 'Source Mode', expr: 'b.source_mode', cls: 'B' },
    { header: 'Indent ID(s)', expr: "COALESCE(ind.indent_ids, '')", cls: 'D' },
    { header: 'Indent No(s)', expr: "COALESCE(ind.indent_nos, '')", cls: 'D' },
    { header: 'Line No', expr: 'b.line_no', cls: 'C' },
    { header: 'Item ID', expr: 'b.item_id', cls: 'D' },
    { header: 'Item Code', expr: 'b.item_code', cls: 'A' },
    { header: 'Item Description', expr: 'b.item_description', cls: 'A' },
    { header: 'Specification', expr: 'b.item_specification', cls: 'B' },
    { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
    { header: 'PO Qty', expr: qty('b.po_qty'), cls: 'A' },
    { header: 'Rate', expr: money('b.rate'), cls: 'A' },
    { header: 'Discount %', expr: qty('b.discount_pct'), cls: 'A' },
    { header: 'Final Rate', expr: money('b.final_rate'), cls: 'A' },
    { header: 'GST %', expr: qty('b.gst_pct'), cls: 'A' },
    { header: 'GST Amount', expr: money('b.gst_amount'), cls: 'A' },
    { header: 'Amount', expr: money('b.amount'), cls: 'A' },
    { header: 'Supplier ID', expr: 'poh.supplier_id', cls: 'D' },
    { header: 'Supplier Code', expr: 's.supplier_code', cls: 'A' },
    { header: 'Supplier Name', expr: 's.supplier_name', cls: 'A' },
    { header: 'Payment Terms', expr: 'poh.payment_terms', cls: 'A' },
    { header: 'Currency', expr: 'poh.currency_code', cls: 'A' },
    { header: 'Delivery Date', expr: d('COALESCE(pol.delivery_date, poh.delivery_date)'), cls: 'A' },
    { header: 'Received Qty', expr: qty('b.received_qty'), cls: 'A' },
    // Zero once the line can no longer receive. A CANCELLED or SHORT_CLOSED
    // order is not outstanding supply, and reporting it as such overstated the
    // purchase book against the ERP's own dashboards.
    {
      header: 'Pending GRN Qty',
      expr: qty('CASE WHEN b.is_receivable THEN b.pending_grn_qty ELSE 0 END'),
      cls: 'A',
    },
    { header: 'Received Amount', expr: money('b.received_amount'), cls: 'B' },
    {
      header: 'Pending Amount',
      expr: money('CASE WHEN b.is_receivable THEN b.pending_amount ELSE 0 END'),
      cls: 'B',
    },
    { header: 'GRN No(s)', expr: "COALESCE(g.grn_nos, '')", cls: 'D' },
    { header: 'Line Status', expr: 'b.line_status', cls: 'A' },
    { header: 'PO Status', expr: 'b.po_status', cls: 'A' },
    { header: 'Created By', expr: 'cu.employee_name', cls: 'B' },
    { header: 'Issued By', expr: 'iu.employee_name', cls: 'B' },
    { header: 'Issued At', expr: ts('poh.issued_at'), cls: 'B' },
    { header: 'Line Remarks', expr: 'pol.remarks', cls: 'B' },
    { header: 'PO Remarks', expr: 'poh.remarks', cls: 'B' },
    { header: 'Created At', expr: ts('poh.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('pol.updated_at'), cls: 'B' },
  ],
  sources: [
    { table: 'purchase_order_lines', restrict: 'pol.id::text = ANY($1)' },
    { table: 'purchase_order_headers', restrict: 'poh.id::text = ANY($1)' },
    {
      table: 'po_indent_sources',
      restrict: 'pol.id IN (SELECT po_line_id FROM po_indent_sources WHERE id::text = ANY($1))',
    },
    {
      table: 'grn_lines',
      restrict: 'pol.id IN (SELECT po_line_id FROM grn_lines WHERE id::text = ANY($1) AND po_line_id IS NOT NULL)',
    },
    {
      table: 'grn_headers',
      restrict: 'pol.id IN (SELECT po_line_id FROM grn_lines WHERE grn_id::text = ANY($1) AND po_line_id IS NOT NULL)',
    },
    { table: 'suppliers', restrict: 'poh.supplier_id::text = ANY($1)', fanoutLimit: 500 },
    { table: 'items', restrict: 'pol.item_id::text = ANY($1)', fanoutLimit: 200 },
    {
      table: 'users',
      restrict: '(poh.created_by::text = ANY($1) OR poh.issued_by::text = ANY($1))',
      fanoutLimit: 200,
    },
    {
      table: 'lookups',
      restrict: '(poh.po_type_id::text = ANY($1) OR pol.uom_id::text = ANY($1))',
      fanoutLimit: 200,
    },
  ],
  importTargets: [
    {
      table: 'purchase_order_headers',
      pk: ['id'],
      fields: {
        'PO ID': 'id',
        'PO No': 'po_no',
        'PO Date': 'po_date',
        'PO Time': 'po_time',
        'PO Type': { column: 'po_type_id', lookup: 'PO_TYPE' },
        'Source Mode': 'source_mode',
        'Supplier ID': 'supplier_id',
        'Payment Terms': 'payment_terms',
        Currency: 'currency_code',
        'PO Status': 'status',
        'PO Remarks': 'remarks',
      },
    },
    {
      table: 'purchase_order_lines',
      pk: ['id'],
      fields: {
        'PO Line ID': 'id',
        'PO ID': 'po_id',
        'Line No': 'line_no',
        'Item ID': 'item_id',
        'Item Code': 'item_code',
        'Item Description': 'item_description',
        Specification: 'item_specification',
        UOM: { column: 'uom_id', lookup: 'UOM' },
        'PO Qty': 'po_qty',
        Rate: 'rate',
        'Discount %': 'discount_pct',
        'GST %': 'gst_pct',
        'Line Remarks': 'remarks',
        // Final Rate, Amount and GST Amount are GENERATED ALWAYS columns — the
        // database computes them and refuses a write. Received/Pending are
        // derived from GRNs. None of them is importable.
      },
    },
  ],
};

/* ── GRN ────────────────────────────────────────────────────────────────────── */

export const GRN: BusinessView = {
  sheet: 'GRN',
  description:
    'Goods receipt lines — against a PO or direct — with inspection, packing, batch, label '
    + 'and MLN detail, and the resulting receipt position.',
  from: `grn_lines   gl
       JOIN grn_headers gh ON gh.id = gl.grn_id
       JOIN suppliers   s  ON s.id  = gh.supplier_id
       LEFT JOIN purchase_order_lines   pol ON pol.id = gl.po_line_id
       LEFT JOIN purchase_order_headers poh ON poh.id = pol.po_id
       LEFT JOIN v_po_line_balance      plb ON plb.po_line_id = gl.po_line_id
       LEFT JOIN users   pu         ON pu.id = gh.posted_by
       LEFT JOIN users   rbu        ON rbu.id = gh.received_by_user_id
       LEFT JOIN lookups lk_grntype ON lk_grntype.id = gh.grn_type_id
       LEFT JOIN lookups lk_uom     ON lk_uom.id     = gl.uom_id
       LEFT JOIN LATERAL (
         SELECT string_agg(DISTINCT src.indent_no, ', ') AS indent_nos
           FROM v_po_line_sources src
          WHERE src.po_line_id = gl.po_line_id
       ) ind ON TRUE
       LEFT JOIN LATERAL (
         SELECT string_agg(m.mln_no, ', ' ORDER BY m.sr_no) AS mln_nos
           FROM grn_line_mlns m
          WHERE m.grn_line_id = gl.id
       ) mln ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(pg.grn_qty), 0) AS prev_qty
           FROM grn_lines   pg
           JOIN grn_headers pgh ON pgh.id = pg.grn_id
          WHERE pgh.status = 'POSTED'
            AND pg.grn_id < gl.grn_id
            AND ((gl.po_line_id IS NOT NULL AND pg.po_line_id = gl.po_line_id)
              OR (gl.po_line_id IS NULL AND pg.po_line_id IS NULL AND pg.item_id = gl.item_id))
       ) prev ON TRUE
       LEFT JOIN LATERAL (
         SELECT COALESCE(SUM(dg.grn_qty), 0) AS total_qty
           FROM grn_lines   dg
           JOIN grn_headers dgh ON dgh.id = dg.grn_id
          WHERE gl.po_line_id IS NULL
            AND dg.po_line_id IS NULL
            AND dg.item_id = gl.item_id
            AND dgh.status = 'POSTED'
       ) direct ON TRUE`,
  orderBy: 'gl.id',
  primaryKey: ['GRN ID', 'GRN Line ID'],
  columns: [
    { header: 'GRN ID', expr: 'gl.grn_id', cls: 'D' },
    { header: 'GRN Line ID', expr: 'gl.id', cls: 'D' },
    { header: 'GRN No', expr: 'gh.grn_no', cls: 'A' },
    { header: 'GRN Date', expr: d('gh.grn_date'), cls: 'A' },
    { header: 'GRN Time', expr: 'gh.grn_time', cls: 'B' },
    { header: 'GRN Type', expr: 'lk_grntype.name', cls: 'A' },
    { header: 'GRN Status', expr: 'gh.status', cls: 'A' },
    { header: 'Mode', expr: "CASE WHEN gl.po_line_id IS NULL THEN 'DIRECT' ELSE 'AGAINST_PO' END", cls: 'A' },
    { header: 'PO ID', expr: 'pol.po_id', cls: 'D' },
    { header: 'PO Line ID', expr: 'gl.po_line_id', cls: 'D' },
    { header: 'PO No', expr: 'poh.po_no', cls: 'A' },
    { header: 'Indent No(s)', expr: "COALESCE(ind.indent_nos, '')", cls: 'D' },
    { header: 'Supplier ID', expr: 'gh.supplier_id', cls: 'D' },
    { header: 'Supplier Code', expr: 's.supplier_code', cls: 'A' },
    { header: 'Supplier Name', expr: 's.supplier_name', cls: 'A' },
    { header: 'Invoice No', expr: 'gh.invoice_no', cls: 'A' },
    { header: 'Invoice Date', expr: d('gh.invoice_date'), cls: 'A' },
    { header: 'Challan No', expr: 'gh.challan_no', cls: 'A' },
    { header: 'Challan Date', expr: d('gh.challan_date'), cls: 'A' },
    { header: 'Transporter', expr: 'gh.transporter_name', cls: 'B' },
    { header: 'Vehicle No', expr: 'gh.vehicle_no', cls: 'B' },
    { header: 'Driver', expr: 'gh.driver_name', cls: 'B' },
    { header: 'LR No', expr: 'gh.lr_no', cls: 'B' },
    { header: 'LR Date', expr: d('gh.lr_date'), cls: 'B' },
    { header: 'Line No', expr: 'gl.line_no', cls: 'C' },
    { header: 'Item ID', expr: 'gl.item_id', cls: 'D' },
    { header: 'Item Code', expr: 'gl.item_code', cls: 'A' },
    { header: 'Item Description', expr: 'gl.item_description', cls: 'A' },
    { header: 'Specification', expr: 'gl.item_specification', cls: 'B' },
    { header: 'UOM', expr: 'lk_uom.code', cls: 'A' },
    { header: 'Order Qty', expr: qty('plb.po_qty'), cls: 'A' },
    { header: 'Previously Received Qty', expr: qty('prev.prev_qty'), cls: 'A' },
    { header: 'Received Qty', expr: qty('gl.grn_qty'), cls: 'A' },
    // A DIRECT receipt has no PO line, so the LEFT JOIN above yields NULL and
    // the cell used to be BLANK on a line that physically received goods and
    // moved stock. Direct receipts are totalled on their own instead.
    { header: 'Total Received Qty', expr: qty('COALESCE(plb.received_qty, direct.total_qty)'), cls: 'A' },
    {
      header: 'Pending Qty',
      expr: qty(`CASE WHEN gl.po_line_id IS NULL THEN 0
                      WHEN plb.is_receivable THEN plb.pending_grn_qty
                      ELSE 0 END`),
      cls: 'A',
    },
    { header: 'Invoice Qty', expr: qty('gl.invoice_qty'), cls: 'B' },
    { header: 'Accepted Qty', expr: qty('gl.accepted_qty'), cls: 'A' },
    { header: 'Rejected Qty', expr: qty('gl.rejected_qty'), cls: 'A' },
    { header: 'Rate', expr: money('gl.rate'), cls: 'A' },
    { header: 'Amount', expr: money('gl.amount'), cls: 'A' },
    { header: 'Batch No', expr: 'gl.batch_no', cls: 'B' },
    { header: 'No. of Package', expr: qty('gl.package_count'), cls: 'B' },
    { header: 'Packing Type', expr: 'gl.packing_type', cls: 'B' },
    { header: 'Expiry Date', expr: d('gl.expiry_date'), cls: 'B' },
    { header: 'No. of Label', expr: qty('gl.label_count'), cls: 'B' },
    { header: 'Label Qty', expr: qty('gl.label_qty'), cls: 'B' },
    { header: 'MLN No(s)', expr: "COALESCE(mln.mln_nos, '')", cls: 'D' },
    { header: 'Location', expr: 'gl.receipt_location', cls: 'B' },
    { header: 'Remark', expr: 'gl.remarks', cls: 'B' },
    { header: 'Received By', expr: 'rbu.employee_name', cls: 'B' },
    { header: 'Posted By', expr: 'pu.employee_name', cls: 'B' },
    { header: 'Posted At', expr: ts('gh.posted_at'), cls: 'B' },
    { header: 'Created At', expr: ts('gh.created_at'), cls: 'B' },
    { header: 'Updated At', expr: ts('gl.updated_at'), cls: 'B' },
  ],
  sources: [
    // A new receipt changes the running totals on the SIBLING lines of the same
    // PO line too, so those are refreshed with it — otherwise "Previously
    // Received" and "Total Received" would quietly go stale on older rows.
    {
      table: 'grn_lines',
      restrict: `(gl.id::text = ANY($1)
               OR gl.po_line_id IN (SELECT po_line_id FROM grn_lines
                                     WHERE id::text = ANY($1) AND po_line_id IS NOT NULL))`,
    },
    {
      table: 'grn_headers',
      restrict: `(gl.grn_id::text = ANY($1)
               OR gl.po_line_id IN (SELECT po_line_id FROM grn_lines
                                     WHERE grn_id::text = ANY($1) AND po_line_id IS NOT NULL))`,
    },
    {
      table: 'grn_line_mlns',
      restrict: 'gl.id IN (SELECT grn_line_id FROM grn_line_mlns WHERE id::text = ANY($1))',
    },
    { table: 'purchase_order_lines', restrict: 'gl.po_line_id::text = ANY($1)' },
    {
      table: 'purchase_order_headers',
      restrict: 'gl.po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id::text = ANY($1))',
    },
    {
      table: 'po_indent_sources',
      restrict: 'gl.po_line_id IN (SELECT po_line_id FROM po_indent_sources WHERE id::text = ANY($1))',
    },
    { table: 'suppliers', restrict: 'gh.supplier_id::text = ANY($1)', fanoutLimit: 500 },
    { table: 'items', restrict: 'gl.item_id::text = ANY($1)', fanoutLimit: 200 },
    {
      table: 'users',
      restrict: '(gh.posted_by::text = ANY($1) OR gh.received_by_user_id::text = ANY($1))',
      fanoutLimit: 200,
    },
    {
      table: 'lookups',
      restrict: '(gh.grn_type_id::text = ANY($1) OR gl.uom_id::text = ANY($1))',
      fanoutLimit: 200,
    },
  ],
  importTargets: [
    {
      table: 'grn_headers',
      pk: ['id'],
      fields: {
        'GRN ID': 'id',
        'GRN No': 'grn_no',
        'GRN Date': 'grn_date',
        'GRN Time': 'grn_time',
        'GRN Type': { column: 'grn_type_id', lookup: 'GRN_TYPE' },
        'GRN Status': 'status',
        'PO ID': 'po_id',
        'Supplier ID': 'supplier_id',
        'Invoice No': 'invoice_no',
        'Invoice Date': 'invoice_date',
        'Challan No': 'challan_no',
        'Challan Date': 'challan_date',
        Transporter: 'transporter_name',
        'Vehicle No': 'vehicle_no',
        Driver: 'driver_name',
        'LR No': 'lr_no',
        'LR Date': 'lr_date',
      },
    },
    {
      table: 'grn_lines',
      pk: ['id'],
      fields: {
        'GRN Line ID': 'id',
        'GRN ID': 'grn_id',
        'Line No': 'line_no',
        'PO Line ID': 'po_line_id',
        'Item ID': 'item_id',
        'Item Code': 'item_code',
        'Item Description': 'item_description',
        Specification: 'item_specification',
        UOM: { column: 'uom_id', lookup: 'UOM' },
        'Received Qty': 'grn_qty',
        'Invoice Qty': 'invoice_qty',
        'Accepted Qty': 'accepted_qty',
        'Rejected Qty': 'rejected_qty',
        Rate: 'rate',
        'Batch No': 'batch_no',
        'No. of Package': 'package_count',
        'Packing Type': 'packing_type',
        'Expiry Date': 'expiry_date',
        'No. of Label': 'label_count',
        'Label Qty': 'label_qty',
        Location: 'receipt_location',
        Remark: 'remarks',
        // `Created At` / `Updated At` are NOT importable. Writing them back
        // would back-date grn_lines.updated_at to the previous export and so
        // disarm the importer's own stale-edit conflict check.
      },
    },
  ],
};

export const PURCHASING_VIEWS = [PURCHASE_INDENT, PURCHASE_ORDER, GRN];
