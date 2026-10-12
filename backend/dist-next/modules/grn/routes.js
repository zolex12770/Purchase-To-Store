/**
 * Goods Receipt Note — Store/Goods Receipt module (SRS §12; ADR-008; GRN reconstruction).
 *
 * TWO creation modes, matching the UI's two tabs exactly:
 *   PO      — every line traces to a purchase_order_lines row (po_line_id set).
 *             A single GRN may span MULTIPLE purchase orders; each line still
 *             resolves and locks its OWN po_line_id independently (ADR-005), so
 *             traceability is per-line, never lost by consolidation. All lines
 *             on one GRN must resolve to the SAME supplier — a GRN never mixes
 *             suppliers (see `assertSingleSupplier`).
 *   DIRECT  — no purchase order at all. Every line carries only item_id; the
 *             item's own Item Master snapshot (code/description/specification/
 *             UOM) is taken server-side, never trusted from the client.
 *
 * Quantities are validated against the outstanding PO balance under a row lock
 * exactly as before (`lockPoLineBalance` / `assertGrnReceiptAllowed` in
 * domain/quantities.ts — unchanged, reused as-is), so two concurrent receipts
 * against the same pending quantity still cannot both succeed. Posting a GRN
 * transactionally recomputes the status of EVERY purchase order the GRN
 * touched (there can be more than one now), not just a single `po.id`.
 */
import { Router } from 'express';
import { z } from 'zod';
import { chromium } from 'playwright';
import { query, queryOne, execute, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import { renderGrnDocumentHtml } from './grn-document.js';
import { renderLabelSheetHtml } from './label-document.js';
import { asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery, parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray, } from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { audit, auditIn, actorFrom } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp, toDateOnly } from '../../domain/numbering.js';
import { assertGrnTransition, assertGrnEditable, assertNotAlready } from '../../domain/status.js';
import { lockPoLineBalance, assertGrnReceiptAllowed, recomputePoStatus, } from '../../domain/quantities.js';
import { toQty, toRate, dec, distributeQty } from '../../domain/money.js';
import { inwardGrnLine, reverseGrnLine, adjustGrnLineStock, hasRequisitionConsumption, usableQtyOf, } from '../../domain/stock.js';
import { loadCompanySettings } from '../../domain/company.js';
const router = Router();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const numLike = z.union([z.number(), z.string()]);
const nullableNum = numLike.nullable().optional();
/**
 * Upper bounds for physical label printing.
 *
 * "No. of labels" is typed by hand on a GRN line, and the label routes build
 * one label object per unit of it. A live line held 6,876,867,979 (a phone
 * number, by the look of it) — asking for that lot's labels made the server
 * try to build that many in memory, which freezes every user and then takes
 * the whole backend down with an out-of-memory crash. Nothing legitimate comes
 * near these limits (the largest real value is 15).
 */
const MAX_LABELS_PER_LOT = 500;
const MAX_LABELS_PER_PRINT = 2000;
const labelCountSchema = nullableNum.refine((v) => v == null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= MAX_LABELS_PER_LOT), `No. of labels must be a whole number from 0 to ${MAX_LABELS_PER_LOT}.`);
/* ── List ───────────────────────────────────────────────────────────────────── */
const SORTABLE = {
    grnNo: 'g.grn_no',
    grnDate: 'g.grn_date',
    status: 'g.status',
    supplier: 's.supplier_name',
    poNo: 'p.po_no',
    createdAt: 'g.created_at',
};
const listSchema = listQuerySchema.extend({
    status: csvArray,
    supplierId: csvIdArray,
    poId: csvIdArray,
    itemId: csvIdArray,
    userId: csvIdArray,
    mode: z.enum(['PO', 'DIRECT']).optional(),
    grnTypeId: csvIdArray,
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
});
// A GRN's PO reference is now nullable and possibly plural (multi-PO), so the
// list join is LEFT — an INNER join would silently drop every Direct GRN and
// every multi-PO GRN whose header `po_id` was left NULL.
const GRN_FROM = `
  FROM grn_headers g
  LEFT JOIN purchase_order_headers p ON p.id = g.po_id
  JOIN suppliers s ON s.id = g.supplier_id
  LEFT JOIN lookups gt ON gt.id = g.grn_type_id`;
function buildGrnFilter(q) {
    const b = new SqlBuilder();
    b.addIn('g.status', q.status);
    b.addIn('g.supplier_id', q.supplierId);
    b.addIn('g.po_id', q.poId);
    b.addIn('g.received_by_user_id', q.userId);
    b.addIn('g.grn_type_id', q.grnTypeId);
    b.add('g.grn_date >= ?', q.dateFrom);
    b.add('g.grn_date <= ?', q.dateTo);
    if (q.mode === 'DIRECT') {
        b.addRaw('NOT EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id AND l.po_line_id IS NOT NULL)');
    }
    else if (q.mode === 'PO') {
        b.addRaw('EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id AND l.po_line_id IS NOT NULL)');
    }
    if (q.itemId && q.itemId.length > 0) {
        const p = b.push(q.itemId);
        b.addRaw(`EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id AND l.item_id = ANY(${p}))`);
    }
    if (q.poId && q.poId.length > 0) {
        // A multi-PO GRN's header po_id may be NULL even though one of its lines
        // belongs to the requested PO — search through the lines too.
        const p = b.push(q.poId);
        b.addRaw(`(g.po_id = ANY(${p}) OR EXISTS (SELECT 1 FROM grn_lines l JOIN purchase_order_lines pol ` +
            `ON pol.id = l.po_line_id WHERE l.grn_id = g.id AND pol.po_id = ANY(${p})))`);
    }
    if (q.search) {
        const p = b.push(`%${q.search.toLowerCase()}%`);
        b.addRaw(`(lower(g.grn_no) LIKE ${p} OR lower(COALESCE(p.po_no,'')) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
            `OR lower(g.challan_no) LIKE ${p} OR lower(g.invoice_no) LIKE ${p} OR lower(g.lr_no) LIKE ${p} ` +
            `OR EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id ` +
            `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p} OR lower(l.batch_no) LIKE ${p} ` +
            `OR lower(l.receipt_location) LIKE ${p})) ` +
            `OR EXISTS (SELECT 1 FROM grn_lines l JOIN purchase_order_lines pol ON pol.id = l.po_line_id ` +
            `JOIN purchase_order_headers poh ON poh.id = pol.po_id WHERE l.grn_id = g.id AND lower(poh.po_no) LIKE ${p}) ` +
            `OR EXISTS (SELECT 1 FROM grn_lines l JOIN po_indent_sources pis ON pis.po_line_id = l.po_line_id ` +
            `JOIN purchase_indent_headers ih ON ih.id = pis.indent_id WHERE l.grn_id = g.id AND lower(ih.indent_no) LIKE ${p}))`);
    }
    return b;
}
router.get('/', requirePermission('grn.view'), validateQuery(listSchema), asyncHandler(async (_req, res) => {
    const q = parsedQuery(res);
    const b = buildGrnFilter(q);
    const totalRow = await queryOne(`SELECT COUNT(*) AS n ${GRN_FROM} ${b.where()}`, b.params);
    const total = Number(totalRow?.n ?? 0);
    const order = resolveSort(q, SORTABLE, 'grnDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));
    const rows = await query(`SELECT g.id, g.grn_no, g.grn_date, g.grn_time, g.status, g.invoice_no, g.invoice_date,
              g.challan_no, g.challan_date, g.vehicle_no, g.transporter_name, g.lr_no, g.remarks, g.posted_at,
              g.grn_type_id, gt.name AS grn_type_name,
              g.po_id, p.po_no, p.po_date, p.status AS po_status,
              g.supplier_id, s.supplier_name, s.supplier_code,
              u.employee_name AS received_by_name,
              agg.line_count, agg.total_qty, agg.total_amount,
              (EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id AND l.po_line_id IS NOT NULL)) AS is_po_based,
              (SELECT string_agg(DISTINCT poh.po_no, ', ' ORDER BY poh.po_no)
                 FROM grn_lines l JOIN purchase_order_lines pol ON pol.id = l.po_line_id
                 JOIN purchase_order_headers poh ON poh.id = pol.po_id
                WHERE l.grn_id = g.id) AS po_numbers
         ${GRN_FROM}
         LEFT JOIN users u ON u.id = g.received_by_user_id
         LEFT JOIN (
           SELECT grn_id, COUNT(*)::int AS line_count,
                  SUM(grn_qty) AS total_qty, SUM(amount) AS total_amount
             FROM grn_lines GROUP BY grn_id
         ) agg ON agg.grn_id = g.id
         ${b.where()}
        ORDER BY ${order}, g.id DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    const cb = buildGrnFilter({ ...q, status: undefined });
    const counts = await query(`SELECT g.status, COUNT(*) AS n ${GRN_FROM} ${cb.where()} GROUP BY g.status`, cb.params);
    sendPage(res, rows, total, q.page, q.pageSize, {
        statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
    });
}));
/* ── GET /grn/po-items — the "PO ITEMS" picker (search across ALL open POs) ─── */
const poItemsQuerySchema = z.object({
    search: z.string().trim().max(200).optional(),
    supplierId: csvIdArray,
    poId: csvIdArray,
    poTypeId: csvIdArray,
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
    view: z.enum(['pending', 'all']).default('pending'),
    limit: z.coerce.number().int().min(1).max(500).default(200),
});
router.get('/po-items', requirePermission('grn.create'), validateQuery(poItemsQuerySchema), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const b = new SqlBuilder();
    // A DRAFT PO has never been issued — it must not appear as receivable even
    // though its lines otherwise look "pending" (po_qty > received_qty).
    b.addRaw("v.po_status <> 'DRAFT'");
    if (f.view === 'pending')
        b.addRaw('v.is_receivable = TRUE');
    b.addIn('v.supplier_id', f.supplierId);
    b.addIn('v.po_id', f.poId);
    b.addIn('v.po_type_id', f.poTypeId);
    b.add('v.po_date >= ?', f.dateFrom);
    b.add('v.po_date <= ?', f.dateTo);
    if (f.search) {
        const p = b.push(`%${f.search.toLowerCase()}%`);
        b.addRaw(`(lower(v.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
            `OR lower(v.item_code) LIKE ${p} OR lower(v.item_description) LIKE ${p})`);
    }
    const lim = b.push(f.limit);
    const rows = await query(`SELECT v.po_line_id, v.po_id, v.po_no, v.po_date, v.po_status,
              v.supplier_id, s.supplier_name, s.supplier_code,
              v.po_type_id, pt.name AS po_type_name,
              v.item_id, v.item_code, v.item_description, v.item_specification,
              v.uom_id, u.code AS uom_code, u.name AS uom_name,
              v.po_qty, v.received_qty, v.pending_grn_qty, v.rate, v.final_rate, v.amount,
              v.line_status, v.is_receivable, v.delivery_date, v.age_days,
              (SELECT string_agg(DISTINCT ih.indent_no, ', ' ORDER BY ih.indent_no)
                 FROM po_indent_sources pis JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
                WHERE pis.po_line_id = v.po_line_id) AS indent_no
         FROM v_po_line_balance v
         JOIN suppliers s ON s.id = v.supplier_id
         LEFT JOIN lookups pt ON pt.id = v.po_type_id
         LEFT JOIN lookups u ON u.id = v.uom_id
         ${b.where()}
        ORDER BY v.po_date DESC, v.po_no, v.line_no
        LIMIT ${lim}`, b.params);
    sendOk(res, rows);
}));
/* ── Labels (GRN reconstruction Part 3/4/5) ──────────────────────────────────
 * MLN is the permanent, unique, server-issued identity of one received GRN
 * line (Part 2). This is the store-facing screen that finds an already-issued
 * MLN and prints its physical label — it never creates a new MLN, and
 * reprinting is always the SAME barcode (Part 5: SR. NO. is just the label's
 * position within its own print batch, not a second identity).
 *
 * IMPORTANT: every one of these routes MUST be registered before `GET /:id`
 * (and the other `/:id/...` routes) below. Express matches routes in
 * registration order, and `/:id` matches ANY single path segment — so
 * `/grn/labels` would otherwise be swallowed by `/:id` (id="labels") and
 * `/grn/labels/print-view` / `/grn/labels/pdf` would be swallowed by
 * `/:id/print-view` / `/:id/pdf`, both failing idParam's integer check with a
 * 422 before ever reaching the real handler below.
 * ──────────────────────────────────────────────────────────────────────── */
const labelSearchSchema = z.object({
    search: z.string().trim().max(200).optional(), // matches MLN, GRN no, item code/description
    mlnNo: z.string().trim().max(30).optional(),
    grnId: z.coerce.number().int().positive().optional(),
    itemId: csvIdArray,
    supplierId: csvIdArray,
    poId: csvIdArray,
    batchNo: z.string().trim().max(120).optional(),
    location: z.string().trim().max(120).optional(),
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
    status: z.enum(['PENDING', 'PRINTED', 'CANCELLED']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(50),
});
const LABEL_FROM = `
  FROM grn_line_mlns m
  JOIN grn_lines gl ON gl.id = m.grn_line_id
  JOIN grn_headers g ON g.id = m.grn_id
  JOIN suppliers s ON s.id = g.supplier_id
  LEFT JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
  LEFT JOIN purchase_order_headers poh ON poh.id = pol.po_id
  LEFT JOIN lookups u ON u.id = gl.uom_id`;
function buildLabelFilter(q) {
    const b = new SqlBuilder();
    b.add('m.grn_id = ?', q.grnId);
    b.addIn('gl.item_id', q.itemId);
    b.addIn('g.supplier_id', q.supplierId);
    b.addIn('pol.po_id', q.poId);
    b.add('m.batch_no ILIKE ?', q.batchNo ? `%${q.batchNo}%` : undefined);
    b.add('m.location ILIKE ?', q.location ? `%${q.location}%` : undefined);
    b.add('g.grn_date >= ?', q.dateFrom);
    b.add('g.grn_date <= ?', q.dateTo);
    b.add('m.mln_no ILIKE ?', q.mlnNo ? `%${q.mlnNo}%` : undefined);
    // A label's usability tracks its parent GRN's live status (Part: "cancelled
    // GRN's labels become invalid but stay traceable") — never a stored flag on
    // grn_line_mlns itself, which is never mutated once issued.
    if (q.status === 'CANCELLED') {
        b.addRaw("g.status = 'CANCELLED'");
    }
    else if (q.status === 'PENDING') {
        b.addRaw("g.status <> 'CANCELLED' AND m.print_count = 0");
    }
    else if (q.status === 'PRINTED') {
        b.addRaw("g.status <> 'CANCELLED' AND m.print_count > 0");
    }
    if (q.search) {
        const p = b.push(`%${q.search.toLowerCase()}%`);
        b.addRaw(`(lower(m.mln_no) LIKE ${p} OR lower(g.grn_no) LIKE ${p} OR lower(gl.item_code) LIKE ${p} ` +
            `OR lower(gl.item_description) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
            `OR lower(COALESCE(poh.po_no,'')) LIKE ${p})`);
    }
    return b;
}
router.get('/labels', requirePermission('grn.view'), validateQuery(labelSearchSchema), asyncHandler(async (_req, res) => {
    const q = parsedQuery(res);
    const b = buildLabelFilter(q);
    const totalRow = await queryOne(`SELECT COUNT(*) AS n ${LABEL_FROM} ${b.where()}`, b.params);
    const limit = b.push(q.pageSize);
    const offset = b.push((q.page - 1) * q.pageSize);
    const rows = await query(`SELECT m.id, m.mln_no, m.sr_no, m.qty, m.batch_no, m.location, m.issued_at,
              m.print_count, m.last_printed_at,
              g.id AS grn_id, g.grn_no, g.grn_date, g.status AS grn_status,
              gl.item_id, gl.item_code, gl.item_description, gl.label_count,
              u.code AS uom_code,
              s.supplier_name, poh.po_no
         ${LABEL_FROM}
         ${b.where()}
        ORDER BY m.issued_at DESC, m.id DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, Number(totalRow?.n ?? 0), q.page, q.pageSize);
}));
/**
 * Loads full label data for a set of MLNs, in the order given, EXPANDING each
 * MLN row into its GRN line's "No. of Label" physical labels (default 1 when
 * unset). All labels for one MLN share that MLN's barcode/number — it is the
 * receipt lot's identity, not a per-label identity — but each gets its own
 * SR. NO. (e.g. 3/14) and its own share of the lot's quantity, computed via
 * `distributeQty` so the shares always sum to exactly the lot's usable qty
 * (never a naive division that drops or duplicates a remainder).
 */
async function loadLabelData(mlnIds) {
    if (mlnIds.length === 0)
        return [];
    const rows = await query(`SELECT m.id, m.mln_no, m.qty, gl.item_code, gl.item_description,
            s.supplier_name, g.grn_no, g.grn_date, u.code AS uom_code, gl.label_count
       ${LABEL_FROM}
      WHERE m.id = ANY($1)`, [mlnIds]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = mlnIds.map((id) => byId.get(id)).filter((r) => Boolean(r));
    // Refuse BEFORE anything is built: every label below is an object in memory.
    // The check also covers values that did not come through the GRN form (old
    // rows, the spreadsheet import), which the form's own limit cannot.
    const labelCountOf = (r) => Math.max(1, Math.trunc(Number(r.label_count ?? 1)) || 1);
    const tooMany = ordered.find((r) => labelCountOf(r) > MAX_LABELS_PER_LOT);
    if (tooMany) {
        throw BusinessRuleError(`${tooMany.grn_no}: item ${tooMany.item_code} (lot ${tooMany.mln_no}) is set to print ` +
            `${labelCountOf(tooMany).toLocaleString('en-IN')} labels. At most ${MAX_LABELS_PER_LOT} labels can be printed for one lot — ` +
            `open that GRN, correct "No. of labels" on the line, and print again.`, { grnNo: tooMany.grn_no, mlnNo: tooMany.mln_no, labelCount: labelCountOf(tooMany), limit: MAX_LABELS_PER_LOT });
    }
    const total = ordered.reduce((n, r) => n + labelCountOf(r), 0);
    if (total > MAX_LABELS_PER_PRINT) {
        throw BusinessRuleError(`That selection would print ${total.toLocaleString('en-IN')} labels. Print at most ` +
            `${MAX_LABELS_PER_PRINT.toLocaleString('en-IN')} at a time — select fewer lots.`, { labels: total, limit: MAX_LABELS_PER_PRINT });
    }
    const out = [];
    for (const r of ordered) {
        const count = labelCountOf(r);
        const portions = distributeQty(r.qty, count);
        for (let i = 0; i < count; i++) {
            out.push({
                mlnNo: r.mln_no, srNo: i + 1, totalInBatch: count,
                itemName: r.item_description, itemCode: r.item_code, supplierName: r.supplier_name,
                grnNo: r.grn_no, qty: qtyStr(portions[i]), uomCode: r.uom_code, date: toDateOnly(r.grn_date),
            });
        }
    }
    return out;
}
const qtyStr = (v) => toQty(v).replace(/\.0000$/, '');
const labelIdsSchema = z.object({
    ids: z.string().trim().min(1, 'Select at least one label.')
        .transform((v) => v.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)),
});
router.get('/labels/print-view', requirePermission('grn.view'), validateQuery(labelIdsSchema), asyncHandler(async (_req, res) => {
    const { ids } = parsedQuery(res);
    const labels = await loadLabelData(ids);
    if (labels.length === 0)
        throw NotFoundError('Label(s)');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLabelSheetHtml(labels));
}));
router.post('/labels/print', requirePermission('grn.view'), validateBody(z.object({ ids: z.array(z.number().int().positive()).min(1) })), asyncHandler(async (req, res) => {
    const { ids } = req.body;
    // Records the print/reprint event — never mints a new MLN (Part 5).
    await execute('UPDATE grn_line_mlns SET print_count = print_count + 1, last_printed_at = now() WHERE id = ANY($1)', [ids]);
    await audit({
        actor: actorFrom(req), action: 'PRINT', entity: 'grn_label', entityLabel: `${ids.length} label(s)`,
        after: { mlnIds: ids },
    });
    sendOk(res, { printed: ids.length });
}));
router.get('/labels/pdf', requirePermission('grn.view'), validateQuery(labelIdsSchema), asyncHandler(async (req, res) => {
    const { ids } = parsedQuery(res);
    const labels = await loadLabelData(ids);
    if (labels.length === 0)
        throw NotFoundError('Label(s)');
    const html = renderLabelSheetHtml(labels);
    await execute('UPDATE grn_line_mlns SET print_count = print_count + 1, last_printed_at = now() WHERE id = ANY($1)', [ids]);
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        // One physical 90x50mm label per PDF page — matches the label printer
        // exactly, no A4 sheet. `preferCSSPageSize` makes the template's own
        // `@page { size: 90mm 50mm }` the single source of truth, so the PDF and
        // the browser-print path can never disagree about the page size — and it
        // reproduces 90mm more precisely than passing width/height here does
        // (Chromium rounds those through px, landing at ~90.34mm instead).
        const pdf = await page.pdf({
            preferCSSPageSize: true, printBackground: true,
            margin: { top: '0mm', bottom: '0mm', left: '0mm', right: '0mm' },
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="labels-${Date.now()}.pdf"`);
        res.send(pdf);
    }
    finally {
        await browser.close();
    }
}));
/* ── GET /grn/:id ───────────────────────────────────────────────────────────── */
router.get('/:id', requirePermission('grn.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne(`SELECT g.*, p.po_no, p.po_date, p.status AS po_status, p.po_type_id, pt.name AS po_type_name,
              gt.name AS grn_type_name,
              s.supplier_name, s.supplier_code, s.address AS supplier_address,
              s.gst_no AS supplier_gst, s.city AS supplier_city, s.state AS supplier_state,
              s.mobile_no AS supplier_mobile, s.email AS supplier_email,
              u.employee_name AS received_by_name, pu.employee_name AS posted_by_name,
              cu.employee_name AS created_by_name, xu.employee_name AS cancelled_by_name
         FROM grn_headers g
         LEFT JOIN purchase_order_headers p ON p.id = g.po_id
         JOIN suppliers s ON s.id = g.supplier_id
         LEFT JOIN lookups pt ON pt.id = p.po_type_id
         LEFT JOIN lookups gt ON gt.id = g.grn_type_id
         LEFT JOIN users u  ON u.id  = g.received_by_user_id
         LEFT JOIN users pu ON pu.id = g.posted_by
         LEFT JOIN users cu ON cu.id = g.created_by
         LEFT JOIN users xu ON xu.id = g.cancelled_by
        WHERE g.id = $1`, [id]);
    if (!header)
        throw NotFoundError('GRN');
    // Each line shows what it received AND the PO line's standing balance
    // (when PO-based), plus its own indent trace and MLN, so the document is
    // self-explanatory without opening the PO (SRS §12).
    const lines = await query(`SELECT gl.id, gl.line_no, gl.po_line_id, gl.item_id, gl.item_code, gl.item_description,
              gl.item_specification, gl.grn_qty, gl.invoice_qty, gl.rate, gl.amount,
              gl.accepted_qty, gl.rejected_qty, gl.receipt_location,
              gl.batch_no, gl.package_count, gl.packing_type, gl.expiry_date,
              gl.label_count, gl.label_qty, gl.remarks, gl.uom_id,
              u.code AS uom_code, u.name AS uom_name,
              b.po_id, poh.po_no, b.po_qty, b.received_qty, b.pending_grn_qty, b.final_rate AS po_final_rate,
              b.line_no AS po_line_no,
              m.mln_no, m.sr_no AS mln_sr_no,
              (SELECT string_agg(DISTINCT ih.indent_no, ', ' ORDER BY ih.indent_no)
                 FROM po_indent_sources pis JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
                WHERE pis.po_line_id = gl.po_line_id) AS indent_no,
              -- A Requisition has already issued stock against this item (Section 4) —
              -- the received quantity can no longer be corrected on this line.
              EXISTS (SELECT 1 FROM stock_ledger sl WHERE sl.item_id = gl.item_id AND sl.txn_type = 'REQUISITION_ISSUE') AS qty_locked
         FROM grn_lines gl
         LEFT JOIN lookups u ON u.id = gl.uom_id
         LEFT JOIN v_po_line_balance b ON b.po_line_id = gl.po_line_id
         LEFT JOIN purchase_order_headers poh ON poh.id = b.po_id
         LEFT JOIN grn_line_mlns m ON m.grn_line_id = gl.id
        WHERE gl.grn_id = $1
        ORDER BY gl.line_no`, [id]);
    const isPoBased = lines.some((l) => l.po_line_id != null);
    const poNumbers = [...new Set(lines.map((l) => l.po_no).filter(Boolean))];
    sendOk(res, { ...header, mode: isPoBased ? 'PO' : 'DIRECT', poNumbers, lines });
}));
/* ── Create / update ────────────────────────────────────────────────────────── */
const grnLineSchema = z.object({
    // Present (from GET /grn/:id) only when editing an already-POSTED GRN's
    // existing line — absent/null means "a new line being added on this edit".
    // Used to match submitted lines back to their real grn_lines row so a
    // POSTED line's stock-affecting fields can be corrected in place (its MLN
    // is never deleted/reissued) instead of the DRAFT-only wipe-and-reinsert.
    id: z.coerce.number().int().positive().nullable().optional(),
    poLineId: z.coerce.number().int().positive().nullable().optional(),
    itemId: z.coerce.number().int().positive().nullable().optional(),
    grnQty: numLike.refine((v) => Number(v) > 0, 'Received quantity must be greater than zero.'),
    invoiceQty: nullableNum,
    rate: nullableNum, // Direct-mode only; PO-mode always snapshots the PO's own rate.
    acceptedQty: nullableNum,
    rejectedQty: nullableNum,
    batchNo: z.string().trim().max(120).default(''),
    packageCount: nullableNum,
    packingType: z.string().trim().max(120).default(''),
    expiryDate: dateStr.nullable().optional(),
    labelCount: labelCountSchema,
    labelQty: nullableNum,
    location: z.string().trim().max(120).default(''),
    remarks: z.string().trim().max(500).default(''),
}).refine((l) => l.acceptedQty == null || l.rejectedQty == null
    || Math.abs(Number(l.acceptedQty) + Number(l.rejectedQty) - Number(l.grnQty)) < 0.0005, { message: 'Accepted Qty + Rejected Qty must equal Received Qty.', path: ['acceptedQty'] });
const grnSchema = z.object({
    mode: z.enum(['PO', 'DIRECT']).default('PO'),
    supplierId: z.coerce.number().int().positive().nullable().optional(),
    // GRN Type is GRN's own separate classification, stored on grn_headers.
    // "PO Type" is never stored here — for a PO-mode GRN it is simply
    // displayed, read live from the linked purchase order(s).
    grnTypeId: z.coerce.number().int().positive().nullable().optional(),
    grnDate: dateStr.optional(),
    invoiceNo: z.string().trim().max(60).default(''),
    invoiceDate: dateStr.nullable().optional(),
    challanNo: z.string().trim().max(60).default(''),
    challanDate: dateStr.nullable().optional(),
    transporterName: z.string().trim().max(200).default(''),
    vehicleNo: z.string().trim().max(30).default(''),
    driverName: z.string().trim().max(200).default(''),
    lrNo: z.string().trim().max(60).default(''),
    lrDate: dateStr.nullable().optional(),
    receivedByUserId: z.coerce.number().int().positive().nullable().optional(),
    remarks: z.string().trim().max(1000).default(''),
    lines: z.array(grnLineSchema).min(1, 'Enter at least one received line.'),
    /** When true the GRN is posted immediately (balances update on post, not on save). */
    post: z.boolean().default(false),
}).superRefine((body, ctx) => {
    body.lines.forEach((line, i) => {
        if (body.mode === 'PO' && !line.poLineId) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'poLineId'], message: 'Select a purchase order line.' });
        }
        if (body.mode === 'DIRECT') {
            if (!line.itemId) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'itemId'], message: 'Select an item.' });
            }
            if (line.rate != null && Number(line.rate) < 0) {
                ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['lines', i, 'rate'], message: 'Rate cannot be negative.' });
            }
        }
    });
    if (body.mode === 'DIRECT' && !body.supplierId) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['supplierId'], message: 'Select a supplier.' });
    }
    // Goods cannot be received before they arrive — a receipt dated in the
    // future is never legitimate and is almost always a data-entry slip (e.g. a
    // mistyped year). One day of grace absorbs timezone skew between the
    // browser and server. Backdating is deliberately NOT restricted here — a
    // GRN entered late for goods that already arrived is a normal, legitimate
    // catch-up entry, not a data integrity risk.
    const oneDayMs = 24 * 60 * 60 * 1000;
    const notFuture = (value, path, label) => {
        if (!value)
            return;
        const d = new Date(`${value}T00:00:00`);
        if (!Number.isNaN(d.getTime()) && d.getTime() > Date.now() + oneDayMs) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${label} cannot be in the future.` });
        }
    };
    notFuture(body.grnDate, 'grnDate', 'GRN date');
    notFuture(body.invoiceDate, 'invoiceDate', 'Invoice date');
    notFuture(body.challanDate, 'challanDate', 'Challan date');
    notFuture(body.lrDate, 'lrDate', 'L.R. date');
});
/**
 * Resolves and locks every line's source (PO line or Item Master row) WITHOUT
 * writing anything yet, so the whole GRN can be validated — including the
 * single-supplier rule — before a single row is inserted.
 */
async function resolveGrnLines(tx, mode, lines, priorQtyByPoLine) {
    const resolved = [];
    const poIdsTouched = new Set();
    const supplierIdsSeen = new Map(); // supplierId -> a PO/label naming it, for the error message
    for (const [i, line] of lines.entries()) {
        if (mode === 'PO') {
            const balance = await lockPoLineBalance(tx, line.poLineId);
            assertGrnReceiptAllowed(balance, toQty(line.grnQty), priorQtyByPoLine.get(line.poLineId) ?? '0');
            poIdsTouched.add(Number(balance.po_id));
            supplierIdsSeen.set(Number(balance.supplier_id), balance.po_no);
            resolved.push({
                line, poLineBalance: balance,
                itemSnapshot: {
                    id: balance.item_id, item_code: balance.item_code, item_description: balance.item_description,
                    item_specification: balance.item_specification ?? '', uom_id: balance.uom_id, rate: balance.final_rate,
                },
            });
        }
        else {
            const item = await txQueryOne(tx, `SELECT id, item_code, item_description, item_specification, uom_id, standard_rate, is_active
           FROM items WHERE id = $1 AND deleted_at IS NULL`, [line.itemId]);
            if (!item) {
                throw ValidationError(`Line ${i + 1}: the selected item does not exist.`, [
                    { field: `lines.${i}.itemId`, message: 'Item not found.' },
                ]);
            }
            if (!item.is_active) {
                throw BusinessRuleError(`Item ${item.item_code} is inactive and cannot be received.`);
            }
            const rate = line.rate == null || line.rate === '' ? (item.standard_rate ?? '0') : line.rate;
            resolved.push({
                line, poLineBalance: null,
                itemSnapshot: {
                    id: item.id, item_code: item.item_code, item_description: item.item_description,
                    item_specification: item.item_specification ?? '', uom_id: item.uom_id, rate: toRate(rate),
                },
            });
        }
    }
    // A GRN never mixes suppliers — production-safe behaviour per the reference
    // spec: refuse rather than silently merging or guessing an attribution.
    let supplierId;
    if (mode === 'DIRECT') {
        supplierId = 0; // filled by the caller from body.supplierId — DIRECT has no per-line supplier to check
    }
    else if (supplierIdsSeen.size > 1) {
        const detail = [...supplierIdsSeen.entries()].map(([, poNo]) => poNo).join(', ');
        throw BusinessRuleError(`The selected purchase order lines belong to more than one supplier (from POs: ${detail}). ` +
            `A single GRN must be raised for one supplier — remove lines from the other supplier's PO(s), or create a separate GRN for them.`);
    }
    else {
        supplierId = [...supplierIdsSeen.keys()][0];
    }
    return { resolved, supplierId, poIdsTouched };
}
/** Inserts every line and returns exactly what `inwardGrnLine`/`reverseGrnLine` need to move stock, in line order. */
async function insertGrnLines(tx, grnId, resolved) {
    const inserted = [];
    for (const [i, r] of resolved.entries()) {
        const { line, itemSnapshot: s } = r;
        const row = await txQueryOne(tx, `INSERT INTO grn_lines
         (grn_id, line_no, po_line_id, item_id, item_code, item_description, item_specification,
          grn_qty, invoice_qty, uom_id, rate, accepted_qty, rejected_qty, receipt_location,
          batch_no, package_count, packing_type, expiry_date, label_count, label_qty, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`, [
            grnId, i + 1, r.poLineBalance ? line.poLineId : null, s.id, s.item_code, s.item_description, s.item_specification,
            toQty(line.grnQty),
            line.invoiceQty == null || line.invoiceQty === '' ? null : toQty(line.invoiceQty),
            s.uom_id, s.rate,
            line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty),
            line.rejectedQty == null || line.rejectedQty === '' ? null : toQty(line.rejectedQty),
            line.location,
            line.batchNo,
            line.packageCount == null || line.packageCount === '' ? null : toQty(line.packageCount),
            line.packingType,
            line.expiryDate ?? null,
            line.labelCount == null || line.labelCount === '' ? null : toQty(line.labelCount),
            line.labelQty == null || line.labelQty === '' ? null : toQty(line.labelQty),
            line.remarks,
        ]);
        inserted.push({
            id: row.id, item_id: s.id, po_line_id: r.poLineBalance ? line.poLineId : null,
            grn_qty: toQty(line.grnQty),
            accepted_qty: line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty),
            uom_id: s.uom_id, batch_no: line.batchNo, receipt_location: line.location,
        });
    }
    return inserted;
}
/** Runs stock inward + MLN issuance for every line of a GRN that is being posted right now. */
async function inwardAllLines(tx, lines, ctx) {
    for (const [i, line] of lines.entries()) {
        await inwardGrnLine(tx, line, { ...ctx, srNo: i + 1 });
    }
}
router.post('/', requirePermission('grn.create'), validateBody(grnSchema), asyncHandler(async (req, res) => {
    const body = req.body;
    const userId = req.user.id;
    const when = body.grnDate ? new Date(`${body.grnDate}T00:00:00`) : new Date();
    if (body.post && !req.user.permissions.has('grn.approve')) {
        throw ValidationError('You can save this GRN as a draft, but posting it requires the GRN approve permission.');
    }
    const id = await withTransaction(async (tx) => {
        const { resolved, supplierId: resolvedSupplierId, poIdsTouched } = await resolveGrnLines(tx, body.mode, body.lines, new Map());
        const supplierId = body.mode === 'DIRECT' ? body.supplierId : resolvedSupplierId;
        // Header po_id is a convenience denormalisation for the common single-PO
        // case only — NULL when the GRN is Direct or spans several POs. Nothing
        // downstream may treat it as the complete picture (see file header).
        const headerPoId = poIdsTouched.size === 1 ? [...poIdsTouched][0] : null;
        // Duplicate-invoice protection (Part 13): the same supplier's invoice
        // number should not be received twice. A cancelled GRN releases the
        // number for reuse (it was a mistake, not a real receipt).
        if (body.invoiceNo.trim()) {
            const dupe = await txQueryOne(tx, `SELECT grn_no FROM grn_headers
            WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED'`, [supplierId, body.invoiceNo.trim()]);
            if (dupe) {
                throw BusinessRuleError(`Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
                    `If this is genuinely a different delivery, use a distinct invoice number.`);
            }
        }
        const grnNo = await nextDocumentNumber(tx, 'GRN', when);
        const status = body.post ? 'POSTED' : 'DRAFT';
        const header = await txQueryOne(tx, `INSERT INTO grn_headers
           (grn_no, grn_date, grn_time, po_id, supplier_id, grn_type_id,
            invoice_no, invoice_date, challan_no, challan_date, vehicle_no,
            transporter_name, driver_name, lr_no, lr_date,
            received_by_user_id, remarks, status, posted_at, posted_by, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$21)
         RETURNING id`, [
            grnNo, dateStamp(when), timeStamp(), headerPoId, supplierId, body.grnTypeId ?? null,
            body.invoiceNo, body.invoiceDate ?? null, body.challanNo, body.challanDate ?? null, body.vehicleNo,
            body.transporterName, body.driverName, body.lrNo, body.lrDate ?? null,
            body.receivedByUserId ?? userId, body.remarks, status,
            body.post ? new Date().toISOString() : null, body.post ? userId : null, userId,
        ]);
        if (!header)
            throw new Error('Failed to create GRN header.');
        const insertedLines = await insertGrnLines(tx, header.id, resolved);
        // Posting is what moves the balance, assigns MLNs and inwards stock; a
        // draft leaves every PO, MLN and stock balance untouched.
        if (body.post) {
            for (const poId of poIdsTouched)
                await recomputePoStatus(tx, poId);
            await inwardAllLines(tx, insertedLines, {
                grnId: header.id, grnNo, grnDate: dateStamp(when), supplierId, userId,
            });
        }
        await auditIn(tx, {
            actor: actorFrom(req), action: body.post ? 'POST' : 'CREATE', entity: 'grn',
            entityId: header.id, entityLabel: grnNo,
            after: {
                grnNo, status, mode: body.mode, lineCount: body.lines.length,
                poCount: poIdsTouched.size, poIds: [...poIdsTouched],
            },
        });
        return header.id;
    });
    sendCreated(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
}));
/**
 * PUT /grn/:id for an already-POSTED GRN (Section 4). Header fields (invoice/
 * challan/vehicle/transporter/driver/LR/dates/remarks/received-by) never
 * touch stock or an MLN, so they stay editable unconditionally. Lines are
 * updated IN PLACE — never deleted/reinserted, since every posted line
 * already owns an immutable MLN (`grn_line_mlns.grn_line_id` is `ON DELETE
 * RESTRICT`) — and a line's quantity fields are locked only once
 * `hasRequisitionConsumption` reports that a Requisition has actually issued
 * stock against that item; everything else on the line (batch, location,
 * packing, remarks, rate/invoice qty) stays editable regardless, since none
 * of it feeds the pooled balance a Requisition may already rely on.
 */
async function updatePostedGrn(req, res, id, before, body, userId) {
    await withTransaction(async (tx) => {
        const header = await txQueryOne(tx, 'SELECT supplier_id FROM grn_headers WHERE id = $1 FOR UPDATE', [id]);
        const supplierId = header.supplier_id;
        const existingLines = await txQuery(tx, `SELECT id, line_no, po_line_id, item_id, item_code, grn_qty, accepted_qty, rejected_qty,
              uom_id, batch_no, receipt_location
         FROM grn_lines WHERE grn_id = $1 ORDER BY line_no`, [id]);
        const byId = new Map(existingLines.map((l) => [l.id, l]));
        const existingMode = existingLines.some((l) => l.po_line_id != null) ? 'PO' : 'DIRECT';
        if (body.mode !== existingMode) {
            throw BusinessRuleError(`This GRN was posted in ${existingMode} mode and cannot switch to ${body.mode} mode on edit.`);
        }
        const submittedExisting = body.lines.filter((l) => l.id != null);
        const submittedNew = body.lines.filter((l) => l.id == null);
        // Removing an already-posted line would require deleting its grn_lines
        // row, which the MLN's RESTRICT foreign key refuses outright — surfaced
        // here as a clear business message instead of a raw FK-violation error.
        const submittedIds = new Set(submittedExisting.map((l) => l.id));
        for (const existing of existingLines) {
            if (!submittedIds.has(existing.id)) {
                throw BusinessRuleError(`Line ${existing.line_no} (${existing.item_code}) has already been posted and assigned a lot number — ` +
                    `it cannot be removed. Correct its quantity instead, or cancel this GRN and raise a fresh one.`);
            }
        }
        const poIdsTouched = new Set();
        if (before.po_id)
            poIdsTouched.add(before.po_id);
        if (body.invoiceNo.trim()) {
            const dupe = await txQueryOne(tx, `SELECT grn_no FROM grn_headers
          WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED' AND id <> $3`, [supplierId, body.invoiceNo.trim(), id]);
            if (dupe) {
                throw BusinessRuleError(`Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
                    `If this is genuinely a different delivery, use a distinct invoice number.`);
            }
        }
        let maxLineNo = existingLines.reduce((m, l) => Math.max(m, l.line_no), 0);
        for (const line of submittedExisting) {
            const existing = byId.get(line.id);
            if (!existing) {
                throw ValidationError(`Line ${line.id} does not belong to this GRN.`);
            }
            if (body.mode === 'PO' && line.poLineId !== existing.po_line_id) {
                throw BusinessRuleError(`Line ${existing.line_no} (${existing.item_code}) has already been posted — its purchase order line cannot be changed. ` +
                    `Remove the line item selection and add it as a new line instead.`);
            }
            if (body.mode === 'DIRECT' && line.itemId !== existing.item_id) {
                throw BusinessRuleError(`Line ${existing.line_no} (${existing.item_code}) has already been posted — its item cannot be changed. ` +
                    `Add the new item as a separate line instead.`);
            }
            const newGrnQty = toQty(line.grnQty);
            const newAccepted = line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty);
            const newRejected = line.rejectedQty == null || line.rejectedQty === '' ? null : toQty(line.rejectedQty);
            const oldUsable = usableQtyOf(existing);
            const newUsable = usableQtyOf({ grn_qty: newGrnQty, accepted_qty: newAccepted });
            const qtyChanged = dec(newUsable).minus(dec(oldUsable)).abs().greaterThan(0.00005)
                || dec(newGrnQty).minus(dec(existing.grn_qty)).abs().greaterThan(0.00005);
            if (qtyChanged) {
                const consumed = await hasRequisitionConsumption(tx, existing.item_id);
                if (consumed) {
                    throw BusinessRuleError(`${existing.item_code} (line ${existing.line_no}) has already been issued against a Requisition — ` +
                        `its received quantity can no longer be corrected. Other details on this line remain editable.`, { itemCode: existing.item_code, lineNo: existing.line_no });
                }
                if (body.mode === 'PO' && existing.po_line_id) {
                    const balance = await lockPoLineBalance(tx, existing.po_line_id);
                    assertGrnReceiptAllowed(balance, newGrnQty, existing.grn_qty);
                    poIdsTouched.add(Number(balance.po_id));
                }
            }
            // Rate is a DIRECT-mode-only correction — a PO-mode line's rate is a
            // locked snapshot of the purchase order's own price (never editable
            // from the GRN, on create or on edit) and stays untouched here.
            const newRate = body.mode === 'DIRECT' && line.rate != null && line.rate !== '' ? toRate(line.rate) : null;
            await tx.query(`UPDATE grn_lines
            SET grn_qty = $2, invoice_qty = $3, accepted_qty = $4, rejected_qty = $5,
                receipt_location = $6, batch_no = $7, package_count = $8, packing_type = $9,
                expiry_date = $10, label_count = $11, label_qty = $12, remarks = $13,
                rate = COALESCE($14, rate), updated_at = now()
          WHERE id = $1`, [
                existing.id, newGrnQty,
                line.invoiceQty == null || line.invoiceQty === '' ? null : toQty(line.invoiceQty),
                newAccepted, newRejected,
                line.location, line.batchNo,
                line.packageCount == null || line.packageCount === '' ? null : toQty(line.packageCount),
                line.packingType, line.expiryDate ?? null,
                line.labelCount == null || line.labelCount === '' ? null : toQty(line.labelCount),
                line.labelQty == null || line.labelQty === '' ? null : toQty(line.labelQty),
                line.remarks, newRate,
            ]);
            if (qtyChanged) {
                const delta = dec(newUsable).minus(dec(oldUsable));
                await adjustGrnLineStock(tx, { id: existing.id, item_id: existing.item_id, po_line_id: existing.po_line_id, grn_qty: newGrnQty, accepted_qty: newAccepted, uom_id: existing.uom_id, batch_no: line.batchNo, receipt_location: line.location }, toQty(delta), { grnId: id, grnNo: before.grn_no, grnDate: body.grnDate ?? dateStamp(new Date()), supplierId: supplierId, userId });
            }
        }
        // Brand-new lines added to an already-posted GRN inward immediately —
        // adding stock never conflicts with anything a Requisition already relied on.
        if (submittedNew.length > 0) {
            const { resolved, supplierId: newSupplierId, poIdsTouched: newPoIds } = await resolveGrnLines(tx, body.mode, submittedNew, new Map());
            // A GRN never mixes suppliers (existing invariant) — a brand-new line
            // must resolve to the SAME supplier this GRN was already posted under.
            if (body.mode === 'PO' && newSupplierId !== supplierId) {
                throw BusinessRuleError(`The new line(s) belong to a different supplier than this GRN's existing lines. ` +
                    `A single GRN must be raised for one supplier — create a separate GRN for that supplier instead.`);
            }
            if (body.mode === 'DIRECT' && body.supplierId != null && body.supplierId !== supplierId) {
                throw BusinessRuleError(`This GRN was posted for a different supplier — its supplier cannot be changed on edit. ` +
                    `Create a separate GRN for the other supplier instead.`);
            }
            const inserted = [];
            for (const [i, r] of resolved.entries()) {
                const { line, itemSnapshot: s } = r;
                const row = await txQueryOne(tx, `INSERT INTO grn_lines
             (grn_id, line_no, po_line_id, item_id, item_code, item_description, item_specification,
              grn_qty, invoice_qty, uom_id, rate, accepted_qty, rejected_qty, receipt_location,
              batch_no, package_count, packing_type, expiry_date, label_count, label_qty, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           RETURNING id`, [
                    id, maxLineNo + i + 1, r.poLineBalance ? line.poLineId : null, s.id, s.item_code, s.item_description, s.item_specification,
                    toQty(line.grnQty),
                    line.invoiceQty == null || line.invoiceQty === '' ? null : toQty(line.invoiceQty),
                    s.uom_id, s.rate,
                    line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty),
                    line.rejectedQty == null || line.rejectedQty === '' ? null : toQty(line.rejectedQty),
                    line.location, line.batchNo,
                    line.packageCount == null || line.packageCount === '' ? null : toQty(line.packageCount),
                    line.packingType, line.expiryDate ?? null,
                    line.labelCount == null || line.labelCount === '' ? null : toQty(line.labelCount),
                    line.labelQty == null || line.labelQty === '' ? null : toQty(line.labelQty),
                    line.remarks,
                ]);
                inserted.push({
                    id: row.id, item_id: s.id, po_line_id: r.poLineBalance ? line.poLineId : null,
                    grn_qty: toQty(line.grnQty),
                    accepted_qty: line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty),
                    uom_id: s.uom_id, batch_no: line.batchNo, receipt_location: line.location,
                });
            }
            maxLineNo += resolved.length;
            for (const poId of newPoIds)
                poIdsTouched.add(poId);
            await inwardAllLines(tx, inserted, {
                grnId: id, grnNo: before.grn_no, grnDate: body.grnDate ?? dateStamp(new Date()), supplierId, userId,
            });
        }
        // All PO lines on this GRN (pre-existing + newly added) resolve their
        // own po_line_id independently either way — this is only the same
        // single-PO display convenience the create/draft path already computes.
        const allLinePoIds = new Set();
        for (const l of existingLines)
            if (l.po_line_id) {
                const b = await txQueryOne(tx, 'SELECT po_id FROM purchase_order_lines WHERE id = $1', [l.po_line_id]);
                if (b)
                    allLinePoIds.add(Number(b.po_id));
            }
        for (const poId of poIdsTouched)
            allLinePoIds.add(poId);
        const headerPoId = allLinePoIds.size === 1 ? [...allLinePoIds][0] : null;
        await tx.query(`UPDATE grn_headers
          SET po_id = $2, grn_type_id = $3, grn_date = COALESCE($4, grn_date), invoice_no = $5, invoice_date = $6,
              challan_no = $7, challan_date = $8, vehicle_no = $9, transporter_name = $10, driver_name = $11,
              lr_no = $12, lr_date = $13, received_by_user_id = $14, remarks = $15,
              updated_at = now(), updated_by = $16
        WHERE id = $1`, [
            id, headerPoId, body.grnTypeId ?? null, body.grnDate ?? null, body.invoiceNo, body.invoiceDate ?? null,
            body.challanNo, body.challanDate ?? null, body.vehicleNo, body.transporterName, body.driverName,
            body.lrNo, body.lrDate ?? null, body.receivedByUserId ?? userId, body.remarks, userId,
        ]);
        for (const poId of poIdsTouched)
            await recomputePoStatus(tx, poId);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'UPDATE', entity: 'grn', entityId: id, entityLabel: before.grn_no,
            before: { lineCount: existingLines.length },
            after: { lineCount: body.lines.length, newLines: submittedNew.length, poIds: [...poIdsTouched] },
        });
    });
    sendOk(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
}
router.put('/:id', requirePermission('grn.edit'), validateBody(grnSchema), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body;
    const userId = req.user.id;
    const before = await queryOne('SELECT grn_no, status, po_id FROM grn_headers WHERE id = $1', [id]);
    if (!before)
        throw NotFoundError('GRN');
    assertGrnEditable(before.status, before.grn_no);
    // Posting is the approval step whichever route it arrives by — the same rule
    // POST /grn and POST /grn/:id/post already apply. Without it, a user with
    // edit but not approve rights could post a draft simply by saving it.
    if (body.post && before.status === 'DRAFT' && !req.user.permissions.has('grn.approve')) {
        throw ValidationError('You can save this GRN as a draft, but posting it requires the GRN approve permission.');
    }
    // A POSTED GRN has already issued MLNs (immutable, never deleted/
    // reissued — Part 2), so it cannot go through the wipe-and-reinsert path
    // below. It stays genuinely editable in place instead, gated per item by
    // `hasRequisitionConsumption` rather than locked wholesale (Section 4).
    if (before.status === 'POSTED') {
        await updatePostedGrn(req, res, id, before, body, userId);
        return;
    }
    await withTransaction(async (tx) => {
        await tx.query('SELECT id FROM grn_headers WHERE id = $1 FOR UPDATE', [id]);
        await tx.query('DELETE FROM grn_lines WHERE grn_id = $1', [id]);
        // A DRAFT contributes nothing to any PO balance, so prior quantities are
        // zero — re-saving a draft can never fail against its own earlier entry.
        const { resolved, supplierId: resolvedSupplierId, poIdsTouched } = await resolveGrnLines(tx, body.mode, body.lines, new Map());
        const supplierId = body.mode === 'DIRECT' ? body.supplierId : resolvedSupplierId;
        const headerPoId = poIdsTouched.size === 1 ? [...poIdsTouched][0] : null;
        if (body.invoiceNo.trim()) {
            const dupe = await txQueryOne(tx, `SELECT grn_no FROM grn_headers
            WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED' AND id <> $3`, [supplierId, body.invoiceNo.trim(), id]);
            if (dupe) {
                throw BusinessRuleError(`Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
                    `If this is genuinely a different delivery, use a distinct invoice number.`);
            }
        }
        const status = body.post ? 'POSTED' : before.status;
        if (body.post)
            assertGrnTransition(before.status, 'POSTED');
        await tx.query(`UPDATE grn_headers
            SET po_id = $2, supplier_id = $3, grn_type_id = $4,
                grn_date = COALESCE($5, grn_date), invoice_no = $6, invoice_date = $7,
                challan_no = $8, challan_date = $9, vehicle_no = $10,
                transporter_name = $11, driver_name = $12, lr_no = $13, lr_date = $14,
                received_by_user_id = $15, remarks = $16, status = $17,
                posted_at = COALESCE(posted_at, $18), posted_by = COALESCE(posted_by, $19),
                updated_at = now(), updated_by = $19
          WHERE id = $1`, [
            id, headerPoId, supplierId, body.grnTypeId ?? null,
            body.grnDate ?? null, body.invoiceNo, body.invoiceDate ?? null,
            body.challanNo, body.challanDate ?? null, body.vehicleNo,
            body.transporterName, body.driverName, body.lrNo, body.lrDate ?? null,
            body.receivedByUserId ?? userId, body.remarks, status,
            body.post ? new Date().toISOString() : null, userId,
        ]);
        const insertedLines = await insertGrnLines(tx, id, resolved);
        // A GRN can only be edited while still DRAFT (assertGrnEditable), so
        // `body.post` here always means "posting for the first time" — the
        // same stock/MLN treatment as the create path, never a second inward.
        if (body.post) {
            const allTouched = new Set(poIdsTouched);
            if (before.po_id)
                allTouched.add(before.po_id); // release the OLD PO too if the edit changed which PO(s) are referenced
            for (const poId of allTouched)
                await recomputePoStatus(tx, poId);
            await inwardAllLines(tx, insertedLines, {
                grnId: id, grnNo: before.grn_no, grnDate: body.grnDate ?? dateStamp(new Date()), supplierId, userId,
            });
        }
        await auditIn(tx, {
            actor: actorFrom(req), action: body.post ? 'POST' : 'UPDATE', entity: 'grn',
            entityId: id, entityLabel: before.grn_no,
            before, after: { status, mode: body.mode, lineCount: body.lines.length, poIds: [...poIdsTouched] },
        });
    });
    sendOk(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
}));
/* ── POST /grn/:id/post ─────────────────────────────────────────────────────── */
router.post('/:id/post', requirePermission('grn.approve'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const result = await withTransaction(async (tx) => {
        const grn = await txQueryOne(tx, 'SELECT grn_no, status, grn_date, supplier_id FROM grn_headers WHERE id = $1 FOR UPDATE', [id]);
        if (!grn)
            throw NotFoundError('GRN');
        assertNotAlready('GRN', grn.grn_no, grn.status, 'POSTED');
        assertGrnTransition(grn.status, 'POSTED');
        const lines = await txQuery(tx, `SELECT id, po_line_id, grn_qty, item_code, item_id, accepted_qty, uom_id, batch_no, receipt_location
           FROM grn_lines WHERE grn_id = $1 ORDER BY line_no`, [id]);
        if (lines.length === 0)
            throw BusinessRuleError('Add at least one line before posting this GRN.');
        // Re-validate EVERY PO-based line against the live balance at post time.
        // The balance may have moved since the draft was saved, and posting is
        // the moment the quantity actually counts. Direct-mode lines have no PO
        // balance to re-check.
        const poIdsTouched = new Set();
        for (const line of lines) {
            if (line.po_line_id == null)
                continue;
            const balance = await lockPoLineBalance(tx, line.po_line_id);
            assertGrnReceiptAllowed(balance, line.grn_qty, '0');
            poIdsTouched.add(Number(balance.po_id));
        }
        await tx.query(`UPDATE grn_headers
            SET status = 'POSTED', posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
          WHERE id = $1`, [id, req.user.id]);
        const poStatuses = [];
        for (const poId of poIdsTouched)
            poStatuses.push(await recomputePoStatus(tx, poId));
        await inwardAllLines(tx, lines, {
            grnId: id, grnNo: grn.grn_no, grnDate: toDateOnly(grn.grn_date),
            supplierId: grn.supplier_id, userId: req.user.id,
        });
        await auditIn(tx, {
            actor: actorFrom(req), action: 'POST', entity: 'grn', entityId: id,
            entityLabel: grn.grn_no, before: { status: grn.status },
            after: { status: 'POSTED', poIds: [...poIdsTouched], poStatuses },
        });
        return { grnNo: grn.grn_no, poStatuses };
    });
    sendOk(res, {
        ...result,
        message: result.poStatuses.length > 0
            ? `GRN ${result.grnNo} has been posted. Purchase order status: ${result.poStatuses.map((s) => s.replace(/_/g, ' ').toLowerCase()).join(', ')}.`
            : `GRN ${result.grnNo} has been posted.`,
    });
}));
/* ── POST /grn/:id/cancel ───────────────────────────────────────────────────── */
router.post('/:id/cancel', requirePermission('grn.approve'), validateBody(z.object({ reason: z.string().trim().max(1000).optional() })), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body;
    if (!reason?.trim()) {
        throw ValidationError('A reason is required to cancel a GRN.', [
            { field: 'reason', message: 'Please state why this receipt is being reversed.' },
        ]);
    }
    const result = await withTransaction(async (tx) => {
        const grn = await txQueryOne(tx, 'SELECT grn_no, status, grn_date, supplier_id FROM grn_headers WHERE id = $1 FOR UPDATE', [id]);
        if (!grn)
            throw NotFoundError('GRN');
        // Without this a second cancel sailed through (same-state transitions are
        // allowed for saves) and replaced the original reason, time and person.
        assertNotAlready('GRN', grn.grn_no, grn.status, 'CANCELLED');
        assertGrnTransition(grn.status, 'CANCELLED');
        const wasPosted = grn.status === 'POSTED';
        const lines = await txQuery(tx, `SELECT id, po_line_id, item_id, item_code, grn_qty, accepted_qty, uom_id, batch_no, receipt_location
           FROM grn_lines WHERE grn_id = $1`, [id]);
        const poIdsTouched = new Set();
        for (const l of lines) {
            if (l.po_line_id == null)
                continue;
            const balance = await txQueryOne(tx, 'SELECT po_id FROM purchase_order_lines WHERE id = $1', [l.po_line_id]);
            if (balance)
                poIdsTouched.add(Number(balance.po_id));
        }
        // Same real relationship as the edit-lock (Section 4): reversing a
        // posted receipt whose item has since been issued against a
        // Requisition would try to pull the pooled balance below what that
        // Requisition already relied on — refuse cleanly instead of letting
        // the item's own nonneg stock constraint fail as a raw DB error.
        if (grn.status === 'POSTED') {
            for (const l of lines) {
                const consumed = await hasRequisitionConsumption(tx, l.item_id);
                if (consumed) {
                    throw BusinessRuleError(`${grn.grn_no} cannot be cancelled — ${l.item_code} has already been issued against a Requisition, ` +
                        `so reversing this receipt could take its stock below zero. Correct the GRN's other details instead of cancelling it.`, { itemCode: l.item_code });
                }
            }
        }
        await tx.query(`UPDATE grn_headers
            SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2,
                cancel_reason = $3, updated_at = now(), updated_by = $2
          WHERE id = $1`, [id, req.user.id, reason]);
        // Reversing a posted receipt gives the quantity back on EVERY purchase
        // order this GRN touched; each may fall from COMPLETED to
        // PARTIALLY_RECEIVED or back to OPEN, which recompute handles (ADR-003).
        const poStatuses = [];
        for (const poId of poIdsTouched)
            poStatuses.push(await recomputePoStatus(tx, poId));
        // A DRAFT cancelled directly never moved stock or issued an MLN in the
        // first place (Part 2/6/8) — only a POSTED receipt has anything to
        // reverse. The MLN rows themselves are never deleted; their "cancelled"
        // status is answered by joining to grn_headers.status, not erased here.
        if (wasPosted) {
            for (const l of lines) {
                await reverseGrnLine(tx, l, {
                    grnId: id, grnNo: grn.grn_no, grnDate: toDateOnly(grn.grn_date),
                    supplierId: grn.supplier_id, userId: req.user.id,
                });
            }
        }
        await auditIn(tx, {
            actor: actorFrom(req), action: 'CANCEL', entity: 'grn', entityId: id,
            entityLabel: grn.grn_no, before: { status: grn.status },
            after: { status: 'CANCELLED', poIds: [...poIdsTouched], poStatuses, stockReversed: wasPosted }, message: reason,
        });
        return { grnNo: grn.grn_no, poStatuses, wasPosted };
    });
    sendOk(res, {
        ...result,
        message: result.wasPosted
            ? `GRN ${result.grnNo} has been cancelled — its quantities returned to the purchase order balance and stock was reversed.`
            : `Draft GRN ${result.grnNo} has been cancelled.`,
    });
}));
/* ── DELETE (drafts only) ───────────────────────────────────────────────────── */
router.delete('/:id', requirePermission('grn.delete'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const grn = await queryOne('SELECT grn_no, status FROM grn_headers WHERE id = $1', [id]);
    if (!grn)
        throw NotFoundError('GRN');
    if (grn.status !== 'DRAFT') {
        throw BusinessRuleError(`Only draft GRNs can be deleted. GRN ${grn.grn_no} is ${grn.status.toLowerCase()} — cancel it instead so the receipt history is preserved.`);
    }
    await withTransaction(async (tx) => {
        await auditIn(tx, {
            actor: actorFrom(req), action: 'DELETE', entity: 'grn', entityId: id,
            entityLabel: grn.grn_no, before: grn,
        });
        await tx.query('DELETE FROM grn_headers WHERE id = $1', [id]);
    });
    sendOk(res, { deleted: true, message: `Draft GRN ${grn.grn_no} has been deleted.` });
}));
/* ── Print-view / PDF — one document, two ways to consume it ────────────────── */
async function buildDocument(id) {
    const header = await queryOne(`SELECT g.*, gt.name AS grn_type_name,
            s.supplier_name, s.address AS supplier_address, s.city AS supplier_city,
            s.state AS supplier_state, s.gst_no AS supplier_gst, s.mobile_no AS supplier_mobile
       FROM grn_headers g
       JOIN suppliers s ON s.id = g.supplier_id
       LEFT JOIN lookups gt ON gt.id = g.grn_type_id
      WHERE g.id = $1`, [id]);
    if (!header)
        throw NotFoundError('GRN');
    const lines = await query(`SELECT gl.line_no, gl.item_code, gl.item_description, gl.item_specification,
            gl.grn_qty, gl.invoice_qty, gl.rate, gl.amount, gl.batch_no, gl.receipt_location,
            u.code AS uom_code,
            (SELECT string_agg(DISTINCT poh.po_no, ', ') FROM purchase_order_lines pol
               JOIN purchase_order_headers poh ON poh.id = pol.po_id WHERE pol.id = gl.po_line_id) AS po_no,
            (SELECT string_agg(DISTINCT ih.indent_no, ', ') FROM po_indent_sources pis
               JOIN purchase_indent_headers ih ON ih.id = pis.indent_id WHERE pis.po_line_id = gl.po_line_id) AS indent_no
       FROM grn_lines gl
       LEFT JOIN lookups u ON u.id = gl.uom_id
      WHERE gl.grn_id = $1
      ORDER BY gl.line_no`, [id]);
    const company = await loadCompanySettings();
    const h = header;
    const totalQty = lines.reduce((s, l) => s.plus(dec(l.grn_qty)), dec(0));
    const totalAmount = lines.reduce((s, l) => s.plus(dec(l.amount)), dec(0));
    return {
        grn_no: h.grn_no, grn_date: h.grn_date, grn_type_name: h.grn_type_name ?? null,
        invoice_no: h.invoice_no, invoice_date: h.invoice_date,
        challan_no: h.challan_no, challan_date: h.challan_date,
        transporter_name: h.transporter_name, vehicle_no: h.vehicle_no, driver_name: h.driver_name,
        lr_no: h.lr_no, lr_date: h.lr_date, remarks: h.remarks,
        supplier_name: h.supplier_name, supplier_address: h.supplier_address, supplier_city: h.supplier_city,
        supplier_state: h.supplier_state, supplier_gst: h.supplier_gst, supplier_mobile: h.supplier_mobile,
        total_qty: toQty(totalQty), total_amount: toQty(totalAmount) === '' ? '0.00' : totalAmount.toFixed(2),
        lines: lines.map((l) => ({
            line_no: Number(l.line_no), item_code: String(l.item_code), item_description: String(l.item_description),
            item_specification: String(l.item_specification ?? ''), po_no: l.po_no ?? null,
            indent_no: l.indent_no ?? null, uom_code: l.uom_code,
            batch_no: String(l.batch_no ?? ''), receipt_location: String(l.receipt_location ?? ''),
            grn_qty: String(l.grn_qty), invoice_qty: l.invoice_qty == null ? null : String(l.invoice_qty),
            rate: String(l.rate), amount: String(l.amount),
        })),
        company,
    };
}
router.get('/:id/print-view', requirePermission('grn.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildDocument(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderGrnDocumentHtml(doc));
}));
router.get('/:id/pdf', requirePermission('grn.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildDocument(id);
    const html = renderGrnDocumentHtml(doc);
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        const pdf = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' },
            displayHeaderFooter: true,
            headerTemplate: '<div></div>',
            footerTemplate: '<div style="width:100%;font-size:8px;color:#8a93a6;text-align:center;">' +
                'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
        });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.grn_no}.pdf"`);
        res.send(pdf);
    }
    finally {
        await browser.close();
    }
}));
/* ── Analysis (SRS §12 reporting) ────────────────────────────────────────────
 * Consolidated into a small number of genuinely distinct, filterable views
 * rather than one endpoint per named report in the reference spec — the same
 * "Item-wise" table answers Item Receipt Analysis / Item-wise GRN / Rate
 * Analysis at once by sorting/filtering, which is what the reference spec
 * itself asks for ("Do not create meaningless duplicate reports"). Dashboard
 * cards and date/supplier/item trend breakdowns are already served generically
 * by the existing /analytics endpoints (GrnAnalysis.tsx) and are not
 * duplicated here.
 * ──────────────────────────────────────────────────────────────────────── */
router.get('/analysis/po-wise', requirePermission('grn.view'), validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    supplierId: csvIdArray,
    status: csvArray,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
})), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const b = new SqlBuilder();
    b.addIn('h.supplier_id', f.supplierId);
    b.addIn('h.status', f.status);
    if (f.search) {
        const p = b.push(`%${f.search.toLowerCase()}%`);
        b.addRaw(`(lower(h.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p})`);
    }
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM purchase_order_headers h JOIN suppliers s ON s.id = h.supplier_id ${b.where()}`, b.params);
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);
    const rows = await query(`SELECT h.id AS po_id, h.po_no, h.po_date, h.status, s.supplier_name,
              bal.total_po_qty, bal.total_received_qty, bal.total_pending_qty, bal.derived_status,
              (SELECT COUNT(DISTINCT gl.grn_id)::int FROM grn_lines gl
                 JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                 JOIN grn_headers gh ON gh.id = gl.grn_id
                WHERE pol.po_id = h.id AND gh.status = 'POSTED') AS grn_count,
              (SELECT MIN(gh.grn_date) FROM grn_lines gl
                 JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                 JOIN grn_headers gh ON gh.id = gl.grn_id
                WHERE pol.po_id = h.id AND gh.status = 'POSTED') AS first_grn_date,
              (SELECT MAX(gh.grn_date) FROM grn_lines gl
                 JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                 JOIN grn_headers gh ON gh.id = gl.grn_id
                WHERE pol.po_id = h.id AND gh.status = 'POSTED') AS last_grn_date
         FROM purchase_order_headers h
         JOIN suppliers s ON s.id = h.supplier_id
         JOIN v_po_header_balance bal ON bal.po_id = h.id
         ${b.where()}
        ORDER BY h.po_date DESC, h.id DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, Number(totalRow?.n ?? 0), f.page, f.pageSize);
}));
router.get('/analysis/item-wise', requirePermission('grn.view'), validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
})), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const cb = new SqlBuilder();
    cb.addRaw('EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.item_id = i.id)');
    if (f.search) {
        const p = cb.push(`%${f.search.toLowerCase()}%`);
        cb.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p})`);
    }
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM items i ${cb.where()}`, cb.params);
    const b = new SqlBuilder();
    b.addRaw('EXISTS (SELECT 1 FROM purchase_order_lines l2 WHERE l2.item_id = i.id)');
    if (f.search) {
        const p = b.push(`%${f.search.toLowerCase()}%`);
        b.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p})`);
    }
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);
    const rows = await query(`SELECT i.id AS item_id, i.item_code, i.item_description, u.code AS uom_code,
              COALESCE(SUM(l.po_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS total_po_qty,
              COALESCE(SUM(gl.grn_qty) FILTER (WHERE gh.status = 'POSTED'), 0) AS total_received_qty,
              GREATEST(COALESCE(SUM(l.po_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0)
                - COALESCE(SUM(gl.grn_qty) FILTER (WHERE gh.status = 'POSTED'), 0), 0) AS pending_qty,
              COUNT(DISTINCT gh.id) FILTER (WHERE gh.status = 'POSTED')::int AS grn_count,
              COUNT(DISTINCT h.supplier_id)::int AS supplier_count,
              MAX(gh.grn_date) FILTER (WHERE gh.status = 'POSTED') AS last_receipt_date,
              AVG(gl.rate) FILTER (WHERE gh.status = 'POSTED') AS average_rate
         FROM items i
         LEFT JOIN lookups u ON u.id = i.uom_id
         LEFT JOIN purchase_order_lines l ON l.item_id = i.id
         LEFT JOIN purchase_order_headers h ON h.id = l.po_id
         LEFT JOIN grn_lines gl ON gl.po_line_id = l.id
         LEFT JOIN grn_headers gh ON gh.id = gl.grn_id
         ${b.where()}
        GROUP BY i.id, i.item_code, i.item_description, u.code
        ORDER BY total_received_qty DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, Number(totalRow?.n ?? rows.length), f.page, f.pageSize);
}));
router.get('/analysis/supplier-wise', requirePermission('grn.view'), validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
})), asyncHandler(async (_req, res) => {
    const f = parsedQuery(res);
    const cb = new SqlBuilder();
    cb.addRaw('EXISTS (SELECT 1 FROM purchase_order_headers h WHERE h.supplier_id = s.id)');
    if (f.search) {
        const p = cb.push(`%${f.search.toLowerCase()}%`);
        cb.addRaw(`lower(s.supplier_name) LIKE ${p}`);
    }
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM suppliers s ${cb.where()}`, cb.params);
    const b = new SqlBuilder();
    b.addRaw('EXISTS (SELECT 1 FROM purchase_order_headers h2 WHERE h2.supplier_id = s.id)');
    if (f.search) {
        const p = b.push(`%${f.search.toLowerCase()}%`);
        b.addRaw(`lower(s.supplier_name) LIKE ${p}`);
    }
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);
    const rows = await query(`SELECT s.id AS supplier_id, s.supplier_name, s.supplier_code,
              COALESCE(SUM(bal.total_po_qty), 0) AS total_po_qty,
              COALESCE(SUM(bal.total_received_qty), 0) AS total_received_qty,
              COALESCE(SUM(bal.total_pending_qty), 0) AS pending_qty,
              COUNT(DISTINCT h.id)::int AS po_count,
              COUNT(DISTINCT gh.id) FILTER (WHERE gh.status = 'POSTED')::int AS grn_count,
              COUNT(DISTINCT h.id) FILTER (WHERE h.status IN ('COMPLETED', 'SHORT_CLOSED'))::int AS completed_po_count,
              COUNT(DISTINCT h.id) FILTER (WHERE h.status IN ('OPEN', 'PARTIALLY_RECEIVED'))::int AS pending_po_count,
              COALESCE(SUM(bal.total_amount), 0) AS total_value,
              AVG(gl.rate) FILTER (WHERE gh.status = 'POSTED') AS average_rate,
              MAX(gh.grn_date) FILTER (WHERE gh.status = 'POSTED') AS last_receipt_date
         FROM suppliers s
         LEFT JOIN purchase_order_headers h ON h.supplier_id = s.id
         LEFT JOIN v_po_header_balance bal ON bal.po_id = h.id
         LEFT JOIN purchase_order_lines l ON l.po_id = h.id
         LEFT JOIN grn_lines gl ON gl.po_line_id = l.id
         LEFT JOIN grn_headers gh ON gh.id = gl.grn_id
         ${b.where()}
        GROUP BY s.id, s.supplier_name, s.supplier_code
        ORDER BY total_value DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, Number(totalRow?.n ?? rows.length), f.page, f.pageSize);
}));
router.get('/analysis/summary', requirePermission('grn.view'), asyncHandler(async (_req, res) => {
    const grnCounts = await query("SELECT status, COUNT(*) AS n FROM grn_headers GROUP BY status");
    const today = await queryOne("SELECT COUNT(*) AS n FROM grn_headers WHERE grn_date = CURRENT_DATE");
    const received = await queryOne(`SELECT COALESCE(SUM(gl.grn_qty), 0) AS qty, COALESCE(SUM(gl.amount), 0) AS value
         FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id WHERE gh.status = 'POSTED'`);
    const poCounts = await query('SELECT status, COUNT(*) AS n FROM purchase_order_headers GROUP BY status');
    const poPending = await queryOne("SELECT COALESCE(SUM(total_pending_qty),0) AS qty, COALESCE(SUM(pending_amount),0) AS value FROM v_po_header_balance WHERE status IN ('OPEN','PARTIALLY_RECEIVED')");
    const byStatus = Object.fromEntries(grnCounts.map((r) => [r.status, Number(r.n)]));
    const poByStatus = Object.fromEntries(poCounts.map((r) => [r.status, Number(r.n)]));
    sendOk(res, {
        grn: {
            total: grnCounts.reduce((a, r) => a + Number(r.n), 0),
            today: Number(today?.n ?? 0),
            draft: byStatus.DRAFT ?? 0,
            posted: byStatus.POSTED ?? 0,
            cancelled: byStatus.CANCELLED ?? 0,
            totalReceivedQty: received?.qty ?? '0',
            totalReceivedValue: received?.value ?? '0',
        },
        po: {
            total: poCounts.reduce((a, r) => a + Number(r.n), 0),
            open: poByStatus.OPEN ?? 0,
            partiallyReceived: poByStatus.PARTIALLY_RECEIVED ?? 0,
            completed: poByStatus.COMPLETED ?? 0,
            pendingQty: poPending?.qty ?? '0',
            pendingValue: poPending?.value ?? '0',
        },
    });
}));
export default router;
//# sourceMappingURL=routes.js.map