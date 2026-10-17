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
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { chromium } from 'playwright';
import { query, queryOne, execute, withTransaction, txQuery, txQueryOne, SqlBuilder, type Queryable } from '../../db/index.js';
import { renderGrnDocumentHtml, type GrnDocumentData } from './grn-document.js';
import { renderLabelSheetHtml, type LabelData } from './label-document.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray, attachmentDisposition,
} from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { audit, auditIn, actorFrom } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp, toDateOnly } from '../../domain/numbering.js';
import { assertGrnTransition, assertGrnEditable, assertNotAlready, statusLabel, type GrnStatus } from '../../domain/status.js';
import {
  lockPoLineBalance, assertGrnReceiptAllowed, recomputePoStatus, type PoLineBalance,
} from '../../domain/quantities.js';
import { toQty, toRate, dec, distributeQty } from '../../domain/money.js';
import {
  inwardGrnLine, reverseGrnLine, adjustGrnLineStock, hasRequisitionConsumption, usableQtyOf,
  stockReceivedByGrnLine, assertGrnCancelCovered, type GrnLineForStock,
} from '../../domain/stock.js';
import {
  OPEN_QC_STATUSES, PASSED_QC_STATUSES, isOpenQcStatus, qcStatusLabel, refreshGrnQcStatus, closeOpenInspections,
} from '../../domain/qc.js';
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
const labelCountSchema = nullableNum.refine(
  (v) => v == null || v === '' || (Number.isInteger(Number(v)) && Number(v) >= 0 && Number(v) <= MAX_LABELS_PER_LOT),
  `No. of labels must be a whole number from 0 to ${MAX_LABELS_PER_LOT}.`,
);

/* ── List ───────────────────────────────────────────────────────────────────── */

const SORTABLE: Record<string, string> = {
  grnNo: 'g.grn_no',
  grnDate: 'g.grn_date',
  status: 'g.status',
  supplier: 's.supplier_name',
  poNo: 'p.po_no',
  createdAt: 'g.created_at',
};

const listSchema = listQuerySchema.extend({
  status: csvArray,
  qcStatus: csvArray,
  supplierId: csvIdArray,
  poId: csvIdArray,
  itemId: csvIdArray,
  userId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  hodId: csvIdArray,
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

function buildGrnFilter(q: z.infer<typeof listSchema>): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('g.status', q.status);
  b.addIn('g.qc_status', q.qcStatus);
  b.addIn('g.supplier_id', q.supplierId);
  b.addIn('g.po_id', q.poId);
  b.addIn('g.received_by_user_id', q.userId);
  b.addIn('g.grn_type_id', q.grnTypeId);
  b.add('g.grn_date >= ?', q.dateFrom);
  b.add('g.grn_date <= ?', q.dateTo);
  if (q.departmentId && q.departmentId.length > 0) {
    const p = b.push(q.departmentId);
    b.addRaw(`EXISTS (SELECT 1 FROM grn_lines l JOIN items i ON i.id = l.item_id WHERE l.grn_id = g.id AND i.department_id = ANY(${p}))`);
  }
  if (q.costCentreId && q.costCentreId.length > 0) {
    const p = b.push(q.costCentreId);
    b.addRaw(`EXISTS (SELECT 1 FROM grn_lines l JOIN items i ON i.id = l.item_id WHERE l.grn_id = g.id AND i.cost_centre_id = ANY(${p}))`);
  }
  if (q.hodId && q.hodId.length > 0) {
    const p = b.push(q.hodId);
    b.addRaw(`EXISTS (SELECT 1 FROM grn_lines l JOIN items i ON i.id = l.item_id JOIN lookups d ON d.id = i.department_id WHERE l.grn_id = g.id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
  }
  if (q.mode === 'DIRECT') {
    b.addRaw('NOT EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id AND l.po_line_id IS NOT NULL)');
  } else if (q.mode === 'PO') {
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
    b.addRaw(
      `(g.po_id = ANY(${p}) OR EXISTS (SELECT 1 FROM grn_lines l JOIN purchase_order_lines pol ` +
      `ON pol.id = l.po_line_id WHERE l.grn_id = g.id AND pol.po_id = ANY(${p})))`,
    );
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(g.grn_no) LIKE ${p} OR lower(COALESCE(p.po_no,'')) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
      `OR lower(g.challan_no) LIKE ${p} OR lower(g.invoice_no) LIKE ${p} OR lower(g.lr_no) LIKE ${p} ` +
      `OR EXISTS (SELECT 1 FROM grn_lines l WHERE l.grn_id = g.id ` +
      `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p} OR lower(l.batch_no) LIKE ${p} ` +
      `OR lower(l.receipt_location) LIKE ${p})) ` +
      `OR EXISTS (SELECT 1 FROM grn_lines l JOIN purchase_order_lines pol ON pol.id = l.po_line_id ` +
      `JOIN purchase_order_headers poh ON poh.id = pol.po_id WHERE l.grn_id = g.id AND lower(poh.po_no) LIKE ${p}) ` +
      `OR EXISTS (SELECT 1 FROM grn_lines l JOIN po_indent_sources pis ON pis.po_line_id = l.po_line_id ` +
      `JOIN purchase_indent_headers ih ON ih.id = pis.indent_id WHERE l.grn_id = g.id AND lower(ih.indent_no) LIKE ${p}))`,
    );
  }
  return b;
}

router.get(
  '/',
  requirePermission('grn.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildGrnFilter(q);

    const totalRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n ${GRN_FROM} ${b.where()}`, b.params);
    const total = Number(totalRow?.n ?? 0);

    const order = resolveSort(q, SORTABLE, 'grnDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT g.id, g.grn_no, g.grn_date, g.grn_time, g.status, g.qc_status, g.invoice_no, g.invoice_date,
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
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    const cb = buildGrnFilter({ ...q, status: undefined });
    const counts = await query<{ status: string; n: string }>(
      `SELECT g.status, COUNT(*) AS n ${GRN_FROM} ${cb.where()} GROUP BY g.status`,
      cb.params,
    );

    const tb = buildGrnFilter(q);
    const totalsRow = await queryOne<{
      grn_count: string;
      line_count: string;
      total_qty: string;
      total_amount: string;
    }>(
      `SELECT
         COUNT(DISTINCT g.id) AS grn_count,
         COALESCE(COUNT(gl.id), 0) AS line_count,
         COALESCE(SUM(gl.grn_qty), 0) AS total_qty,
         COALESCE(SUM(gl.amount), 0) AS total_amount
       ${GRN_FROM}
       LEFT JOIN grn_lines gl ON gl.grn_id = g.id
       ${tb.where()}`,
      tb.params,
    );

    // The QC tiles count the codes the GRN really stores (migration 021's CHECK).
    // They counted 'PENDING', 'PASSED' and 'FAILED', which no row ever holds, so
    // all three read 0 on every screen (A7 F10). Pending QC is everything still
    // held for inspection, QC Passed includes acceptance with deviation.
    const qb = buildGrnFilter(q);
    const qcCounts = await query<{ qc_status: string; n: string }>(
      `SELECT g.qc_status, COUNT(*) AS n ${GRN_FROM} ${qb.where()} GROUP BY g.qc_status`,
      qb.params,
    );
    const qcStatusCounts: Record<string, number> = Object.fromEntries(qcCounts.map((c) => [c.qc_status, Number(c.n)]));
    const countOf = (codes: readonly string[]) => codes.reduce((n, code) => n + (qcStatusCounts[code] ?? 0), 0);

    sendPage(res, rows, total, q.page, q.pageSize, {
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      totals: {
        grnCount: Number(totalsRow?.grn_count ?? total),
        lineCount: Number(totalsRow?.line_count ?? 0),
        totalQty: Number(totalsRow?.total_qty ?? 0),
        totalAmount: Number(totalsRow?.total_amount ?? 0),
        pendingQcCount: countOf(OPEN_QC_STATUSES),
        qcPassedCount: countOf(PASSED_QC_STATUSES),
        qcFailedCount: countOf(['QC_FAILED']),
        qcStatusCounts,
      },
    });
  }),
);

/* ── GET /grn/po-items — the "PO ITEMS" picker (search across ALL open POs) ─── */

const poItemsQuerySchema = z.object({
  search: z.string().trim().max(200).optional(),
  supplierId: csvIdArray,
  poId: csvIdArray,
  poTypeId: csvIdArray,
  itemId: csvIdArray,
  userId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  hodId: csvIdArray,
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  view: z.enum(['pending', 'all']).default('pending'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

router.get(
  '/po-items',
  requirePermission('grn.create'),
  validateQuery(poItemsQuerySchema),
  asyncHandler(async (_req, res) => {
    const f = parsedQuery<z.infer<typeof poItemsQuerySchema>>(res);
    const b = new SqlBuilder();

    // A DRAFT PO has never been issued — it must not appear as receivable even
    // though its lines otherwise look "pending" (po_qty > received_qty).
    b.addRaw("v.po_status <> 'DRAFT'");
    if (f.view === 'pending') b.addRaw('v.is_receivable = TRUE');
    b.addIn('v.supplier_id', f.supplierId);
    b.addIn('v.po_id', f.poId);
    b.addIn('v.po_type_id', f.poTypeId);
    b.addIn('v.item_id', f.itemId);
    b.add('v.po_date >= ?', f.dateFrom);
    b.add('v.po_date <= ?', f.dateTo);

    if (f.userId && f.userId.length > 0) {
      const p = b.push(f.userId);
      b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_headers poh WHERE poh.id = v.po_id AND poh.created_by = ANY(${p}))`);
    }
    if (f.departmentId && f.departmentId.length > 0) {
      const p = b.push(f.departmentId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = v.item_id AND i.department_id = ANY(${p}))`);
    }
    if (f.costCentreId && f.costCentreId.length > 0) {
      const p = b.push(f.costCentreId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = v.item_id AND i.cost_centre_id = ANY(${p}))`);
    }
    if (f.hodId && f.hodId.length > 0) {
      const p = b.push(f.hodId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i JOIN lookups d ON d.id = i.department_id WHERE i.id = v.item_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
    }

    if (f.search) {
      const p = b.push(`%${f.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(v.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
        `OR lower(v.item_code) LIKE ${p} OR lower(v.item_description) LIKE ${p})`,
      );
    }
    const lim = b.push(f.limit);

    const rows = await query(
      `SELECT v.po_line_id, v.po_id, v.po_no, v.po_date, v.po_status,
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
        LIMIT ${lim}`,
      b.params,
    );
    sendOk(res, rows);
  }),
);

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

function buildLabelFilter(q: z.infer<typeof labelSearchSchema>): SqlBuilder {
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
  } else if (q.status === 'PENDING') {
    b.addRaw("g.status <> 'CANCELLED' AND m.print_count = 0");
  } else if (q.status === 'PRINTED') {
    b.addRaw("g.status <> 'CANCELLED' AND m.print_count > 0");
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(m.mln_no) LIKE ${p} OR lower(g.grn_no) LIKE ${p} OR lower(gl.item_code) LIKE ${p} ` +
      `OR lower(gl.item_description) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} ` +
      `OR lower(COALESCE(poh.po_no,'')) LIKE ${p})`,
    );
  }
  return b;
}

router.get(
  '/labels',
  requirePermission('grn.view'),
  validateQuery(labelSearchSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof labelSearchSchema>>(res);
    const b = buildLabelFilter(q);

    const totalRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n ${LABEL_FROM} ${b.where()}`, b.params);
    const limit = b.push(q.pageSize);
    const offset = b.push((q.page - 1) * q.pageSize);

    const rows = await query(
      `SELECT m.id, m.mln_no, m.sr_no, m.qty, m.batch_no, m.location, m.issued_at,
              m.print_count, m.last_printed_at,
              g.id AS grn_id, g.grn_no, g.grn_date, g.status AS grn_status,
              gl.item_id, gl.item_code, gl.item_description, gl.label_count,
              u.code AS uom_code,
              s.supplier_name, poh.po_no
         ${LABEL_FROM}
         ${b.where()}
        ORDER BY m.issued_at DESC, m.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );
    sendPage(res, rows, Number(totalRow?.n ?? 0), q.page, q.pageSize);
  }),
);

/**
 * Loads full label data for a set of MLNs, in the order given, EXPANDING each
 * MLN row into its GRN line's "No. of Label" physical labels (default 1 when
 * unset). All labels for one MLN share that MLN's barcode/number — it is the
 * receipt lot's identity, not a per-label identity — but each gets its own
 * SR. NO. (e.g. 3/14) and its own share of the lot's quantity, computed via
 * `distributeQty` so the shares always sum to exactly the lot's usable qty
 * (never a naive division that drops or duplicates a remainder).
 */
async function loadLabelData(mlnIds: number[]): Promise<LabelData[]> {
  if (mlnIds.length === 0) return [];
  const rows = await query<{
    id: number; mln_no: string; qty: string; item_code: string; item_description: string;
    supplier_name: string; grn_no: string; grn_date: string; uom_code: string | null;
    label_count: string | null;
  }>(
    `SELECT m.id, m.mln_no, m.qty, gl.item_code, gl.item_description,
            s.supplier_name, g.grn_no, g.grn_date, u.code AS uom_code, gl.label_count
       ${LABEL_FROM}
      WHERE m.id = ANY($1)`,
    [mlnIds],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ordered = mlnIds.map((id) => byId.get(id)).filter((r): r is typeof rows[number] => Boolean(r));

  // Refuse BEFORE anything is built: every label below is an object in memory.
  // The check also covers values that did not come through the GRN form (old
  // rows, the spreadsheet import), which the form's own limit cannot.
  const labelCountOf = (r: typeof rows[number]) => Math.max(1, Math.trunc(Number(r.label_count ?? 1)) || 1);
  const tooMany = ordered.find((r) => labelCountOf(r) > MAX_LABELS_PER_LOT);
  if (tooMany) {
    throw BusinessRuleError(
      `${tooMany.grn_no}: item ${tooMany.item_code} (lot ${tooMany.mln_no}) is set to print ` +
      `${labelCountOf(tooMany).toLocaleString('en-IN')} labels. At most ${MAX_LABELS_PER_LOT} labels can be printed for one lot — ` +
      `open that GRN, correct "No. of labels" on the line, and print again.`,
      { grnNo: tooMany.grn_no, mlnNo: tooMany.mln_no, labelCount: labelCountOf(tooMany), limit: MAX_LABELS_PER_LOT },
    );
  }
  const total = ordered.reduce((n, r) => n + labelCountOf(r), 0);
  if (total > MAX_LABELS_PER_PRINT) {
    throw BusinessRuleError(
      `That selection would print ${total.toLocaleString('en-IN')} labels. Print at most ` +
      `${MAX_LABELS_PER_PRINT.toLocaleString('en-IN')} at a time — select fewer lots.`,
      { labels: total, limit: MAX_LABELS_PER_PRINT },
    );
  }

  const out: LabelData[] = [];
  for (const r of ordered) {
    const count = labelCountOf(r);
    const portions = distributeQty(r.qty, count);
    for (let i = 0; i < count; i++) {
      out.push({
        mlnNo: r.mln_no, srNo: i + 1, totalInBatch: count,
        itemName: r.item_description, itemCode: r.item_code, supplierName: r.supplier_name,
        grnNo: r.grn_no, qty: qtyStr(portions[i]!), uomCode: r.uom_code, date: toDateOnly(r.grn_date),
      });
    }
  }
  return out;
}

const qtyStr = (v: string) => toQty(v).replace(/\.0000$/, '');

const labelIdsSchema = z.object({
  ids: z.string().trim().min(1, 'Select at least one label.')
    .transform((v) => v.split(',').map(Number).filter((n) => Number.isInteger(n) && n > 0)),
});

router.get(
  '/labels/print-view',
  requirePermission('grn.view'),
  validateQuery(labelIdsSchema),
  asyncHandler(async (_req, res) => {
    const { ids } = parsedQuery<z.infer<typeof labelIdsSchema>>(res);
    const labels = await loadLabelData(ids);
    if (labels.length === 0) throw NotFoundError('Label(s)');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderLabelSheetHtml(labels));
  }),
);

// Recording a print moves the lot's print_count, which is what tells the store a
// label is a reprint — so it needs the print right, not merely the view right.
router.post(
  '/labels/print',
  requirePermission('grn.print'),
  validateBody(z.object({ ids: z.array(z.number().int().positive()).min(1) })),
  asyncHandler(async (req, res) => {
    const { ids } = req.body as { ids: number[] };
    // Records the print/reprint event — never mints a new MLN (Part 5).
    await execute(
      'UPDATE grn_line_mlns SET print_count = print_count + 1, last_printed_at = now() WHERE id = ANY($1)',
      [ids],
    );
    await audit({
      actor: actorFrom(req), action: 'PRINT', entity: 'grn_label', entityLabel: `${ids.length} label(s)`,
      after: { mlnIds: ids },
    });
    sendOk(res, { printed: ids.length });
  }),
);

router.get(
  '/labels/pdf',
  // The PDF is the printable label set, so it needs the print right. It no
  // longer counts the print itself: a GET must not change data, and a refused
  // or abandoned download was counted as a print (A7 F16). The Labels screen
  // records the print through POST /labels/print once the PDF has arrived.
  requirePermission('grn.print'),
  validateQuery(labelIdsSchema),
  asyncHandler(async (_req, res) => {
    const { ids } = parsedQuery<z.infer<typeof labelIdsSchema>>(res);
    const labels = await loadLabelData(ids);
    if (labels.length === 0) throw NotFoundError('Label(s)');
    const html = renderLabelSheetHtml(labels);

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
      res.setHeader('Content-Disposition', attachmentDisposition(`labels-${Date.now()}`, 'pdf'));
      res.send(pdf);
    } finally {
      await browser.close();
    }
  }),
);

/* ── GET /grn/:id ───────────────────────────────────────────────────────────── */

router.get(
  '/:id',
  requirePermission('grn.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne<Record<string, unknown>>(
      `SELECT g.*, p.po_no, p.po_date, p.status AS po_status, p.po_type_id, pt.name AS po_type_name,
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
        WHERE g.id = $1`,
      [id],
    );
    if (!header) throw NotFoundError('GRN');

    // Each line shows what it received AND the PO line's standing balance
    // (when PO-based), plus its own indent trace and MLN, so the document is
    // self-explanatory without opening the PO (SRS §12).
    const lines = await query(
      `SELECT gl.id, gl.line_no, gl.po_line_id, gl.item_id, gl.item_code, gl.item_description,
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
              -- Requisitions hold a net issued quantity of this item (Section 4) — the
              -- received quantity can no longer be corrected on this line. Same rule
              -- as hasRequisitionConsumption: reversed issues no longer count.
              COALESCE((SELECT SUM(sl.outward_qty - sl.inward_qty) FROM stock_ledger sl
                         WHERE sl.item_id = gl.item_id
                           AND sl.txn_type IN ('REQUISITION_ISSUE', 'REQUISITION_REVERSAL')), 0) > 0 AS qty_locked
         FROM grn_lines gl
         LEFT JOIN lookups u ON u.id = gl.uom_id
         LEFT JOIN v_po_line_balance b ON b.po_line_id = gl.po_line_id
         LEFT JOIN purchase_order_headers poh ON poh.id = b.po_id
         LEFT JOIN grn_line_mlns m ON m.grn_line_id = gl.id
        WHERE gl.grn_id = $1
        ORDER BY gl.line_no`,
      [id],
    );

    const isPoBased = lines.some((l) => l.po_line_id != null);
    const poNumbers = [...new Set(lines.map((l) => l.po_no).filter(Boolean))];

    sendOk(res, { ...header, mode: isPoBased ? 'PO' : 'DIRECT', poNumbers, lines });
  }),
);

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
}).refine(
  (l) => l.acceptedQty == null || l.rejectedQty == null
    || Math.abs(Number(l.acceptedQty) + Number(l.rejectedQty) - Number(l.grnQty)) < 0.0005,
  { message: 'Accepted Qty + Rejected Qty must equal Received Qty.', path: ['acceptedQty'] },
);

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
  const notFuture = (value: string | null | undefined, path: string, label: string) => {
    if (!value) return;
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

type GrnBody = z.infer<typeof grnSchema>;

interface ResolvedLine {
  line: GrnBody['lines'][number];
  poLineBalance: PoLineBalance | null; // null for a Direct-mode line
  itemSnapshot: {
    id: number; item_code: string; item_description: string; item_specification: string;
    uom_id: number | null; rate: string;
  };
}

/**
 * Resolves and locks every line's source (PO line or Item Master row) WITHOUT
 * writing anything yet, so the whole GRN can be validated — including the
 * single-supplier rule — before a single row is inserted.
 */
async function resolveGrnLines(
  tx: Queryable,
  mode: 'PO' | 'DIRECT',
  lines: GrnBody['lines'],
  priorQtyByPoLine: Map<number, string>,
): Promise<{ resolved: ResolvedLine[]; supplierId: number; poIdsTouched: Set<number> }> {
  const resolved: ResolvedLine[] = [];
  const poIdsTouched = new Set<number>();
  const supplierIdsSeen = new Map<number, string>(); // supplierId -> a PO/label naming it, for the error message

  for (const [i, line] of lines.entries()) {
    if (mode === 'PO') {
      const balance = await lockPoLineBalance(tx, line.poLineId!);
      assertGrnReceiptAllowed(balance, toQty(line.grnQty), priorQtyByPoLine.get(line.poLineId!) ?? '0');
      poIdsTouched.add(Number(balance.po_id));
      supplierIdsSeen.set(Number(balance.supplier_id), balance.po_no);
      resolved.push({
        line, poLineBalance: balance,
        itemSnapshot: {
          id: balance.item_id, item_code: balance.item_code, item_description: balance.item_description,
          item_specification: balance.item_specification ?? '', uom_id: balance.uom_id, rate: balance.final_rate,
        },
      });
    } else {
      const item = await txQueryOne<{
        id: number; item_code: string; item_description: string; item_specification: string;
        uom_id: number | null; standard_rate: string | null; is_active: boolean;
      }>(
        tx,
        `SELECT id, item_code, item_description, item_specification, uom_id, standard_rate, is_active
           FROM items WHERE id = $1 AND deleted_at IS NULL`,
        [line.itemId],
      );
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
  let supplierId: number;
  if (mode === 'DIRECT') {
    supplierId = 0; // filled by the caller from body.supplierId — DIRECT has no per-line supplier to check
  } else if (supplierIdsSeen.size > 1) {
    const detail = [...supplierIdsSeen.entries()].map(([, poNo]) => poNo).join(', ');
    throw BusinessRuleError(
      `The selected purchase order lines belong to more than one supplier (from POs: ${detail}). ` +
      `A single GRN must be raised for one supplier — remove lines from the other supplier's PO(s), or create a separate GRN for them.`,
    );
  } else {
    supplierId = [...supplierIdsSeen.keys()][0]!;
  }

  return { resolved, supplierId, poIdsTouched };
}

/** Inserts the lines, numbered from `firstLineNo`, and returns their ids in line order. */
async function insertGrnLines(tx: Queryable, grnId: number, resolved: ResolvedLine[], firstLineNo = 1): Promise<number[]> {
  const ids: number[] = [];
  for (const [i, r] of resolved.entries()) {
    const { line, itemSnapshot: s } = r;
    const row = await txQueryOne<{ id: number }>(
      tx,
      `INSERT INTO grn_lines
         (grn_id, line_no, po_line_id, item_id, item_code, item_description, item_specification,
          grn_qty, invoice_qty, uom_id, rate, accepted_qty, rejected_qty, receipt_location,
          batch_no, package_count, packing_type, expiry_date, label_count, label_qty, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING id`,
      [
        grnId, firstLineNo + i, r.poLineBalance ? line.poLineId : null, s.id, s.item_code, s.item_description, s.item_specification,
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
      ],
    );
    ids.push(row!.id);
  }
  return ids;
}

/* ── Posting: the one place a GRN line is received ────────────────────────────
 * POST /grn and PUT /grn/:id with post:true, POST /grn/:id/post, and a line
 * added to a GRN that is already posted all receive their lines here (A7 F03).
 * Only POST /grn/:id/post used to hold back an item that needs quality
 * inspection; the GRN form posts through POST /grn, so a qc_required item went
 * straight into stock and no inspection was ever raised.
 * ──────────────────────────────────────────────────────────────────────── */

interface LineToReceive extends GrnLineForStock {
  line_no: number;
  item_code: string;
  item_description: string;
  qc_required: boolean;
}

async function loadLinesToReceive(tx: Queryable, grnId: number, lineIds?: number[]): Promise<LineToReceive[]> {
  return txQuery<LineToReceive>(
    tx,
    `SELECT gl.id, gl.line_no, gl.po_line_id, gl.item_id, gl.item_code, gl.item_description,
            gl.grn_qty, gl.accepted_qty, gl.uom_id, gl.batch_no, gl.receipt_location,
            COALESCE(i.qc_required, FALSE) AS qc_required
       FROM grn_lines gl
       LEFT JOIN items i ON i.id = gl.item_id
      WHERE gl.grn_id = $1 ${lineIds ? 'AND gl.id = ANY($2::bigint[])' : ''}
      ORDER BY gl.line_no`,
    lineIds ? [grnId, lineIds] : [grnId],
  );
}

interface GrnForReceipt { id: number; grnNo: string; grnDate: string; supplierId: number }

/**
 * Receives posted lines. A line whose item needs quality inspection
 * (items.qc_required) is held: no stock and no MLN, a PENDING_QC inspection
 * instead, and QC releases what it accepts (qc/routes.ts). Every other line goes
 * into stock with its MLN now. Each MLN's SR. NO. is its line's number.
 */
async function receiveLines(
  tx: Queryable, grn: GrnForReceipt, lines: LineToReceive[], userId: number,
): Promise<{ inwarded: number; heldForQc: number }> {
  let inwarded = 0;
  let heldForQc = 0;
  let supplierName: string | null = null;
  for (const line of lines) {
    if (!line.qc_required) {
      await inwardGrnLine(tx, line, {
        grnId: grn.id, grnNo: grn.grnNo, grnDate: grn.grnDate, supplierId: grn.supplierId, srNo: line.line_no, userId,
      });
      inwarded += 1;
      continue;
    }
    supplierName ??= (await txQueryOne<{ supplier_name: string }>(
      tx, 'SELECT supplier_name FROM suppliers WHERE id = $1', [grn.supplierId],
    ))?.supplier_name ?? '';
    await tx.query(
      `INSERT INTO qc_inspections
         (grn_id, grn_line_id, grn_no, item_id, item_code, item_name, supplier_id, supplier_name,
          received_qty, accepted_qty, rejected_qty, uom_id, uom_code, status, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,0,$10,'','PENDING_QC','Awaiting quality inspection')`,
      [
        grn.id, line.id, grn.grnNo, line.item_id, line.item_code, line.item_description,
        grn.supplierId, supplierName, line.grn_qty, line.uom_id,
      ],
    );
    heldForQc += 1;
  }
  return { inwarded, heldForQc };
}

/**
 * Posts a saved DRAFT GRN: re-checks every PO line against its live balance,
 * marks the GRN POSTED with its initial QC status, recomputes every purchase
 * order it touches (and `alsoRecompute`, e.g. the PO a draft edit moved away
 * from) and receives its lines. The caller holds the header's row lock. The
 * GRN is still DRAFT when the balances are read, so its own lines do not count
 * against them yet.
 */
async function postGrn(
  tx: Queryable, grnId: number, userId: number, alsoRecompute: (number | null)[] = [],
): Promise<{ grnNo: string; poIds: number[]; poStatuses: string[]; qcStatus: string; inwarded: number; heldForQc: number }> {
  const header = await txQueryOne<{ grn_no: string; grn_date: string; supplier_id: number }>(
    tx, 'SELECT grn_no, grn_date, supplier_id FROM grn_headers WHERE id = $1', [grnId],
  );
  if (!header) throw NotFoundError('GRN');
  const lines = await loadLinesToReceive(tx, grnId);
  if (lines.length === 0) throw BusinessRuleError('Add at least one line before posting this GRN.');

  const poIds = new Set<number>();
  for (const line of lines) {
    if (line.po_line_id == null) continue;
    const balance = await lockPoLineBalance(tx, line.po_line_id);
    assertGrnReceiptAllowed(balance, line.grn_qty, '0');
    poIds.add(Number(balance.po_id));
  }

  const qcStatus = lines.some((l) => l.qc_required) ? 'PENDING_QC' : 'NOT_APPLICABLE';
  await tx.query(
    `UPDATE grn_headers
        SET status = 'POSTED', qc_status = $3, posted_at = now(), posted_by = $2, updated_at = now(), updated_by = $2
      WHERE id = $1`,
    [grnId, userId, qcStatus],
  );
  const poStatuses: string[] = [];
  for (const poId of poIds) poStatuses.push(await recomputePoStatus(tx, poId));
  for (const poId of new Set(alsoRecompute)) {
    if (poId != null && !poIds.has(Number(poId))) await recomputePoStatus(tx, Number(poId));
  }

  const received = await receiveLines(tx, {
    id: grnId, grnNo: header.grn_no, grnDate: toDateOnly(header.grn_date), supplierId: header.supplier_id,
  }, lines, userId);
  return { grnNo: header.grn_no, poIds: [...poIds], poStatuses, qcStatus, ...received };
}

/** " 2 line(s) are held for quality inspection …", or nothing when none is. */
const qcHoldNote = (heldForQc: number) => (heldForQc > 0
  ? ` ${heldForQc} line(s) are held for quality inspection and go into stock when QC passes them.`
  : '');

router.post(
  '/',
  requirePermission('grn.create'),
  validateBody(grnSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as GrnBody;
    const userId = req.user!.id;
    const when = body.grnDate ? new Date(`${body.grnDate}T00:00:00`) : new Date();

    if (body.post && !req.user!.permissions.has('grn.approve')) {
      throw ValidationError('You can save this GRN as a draft, but posting it requires the GRN approve permission.');
    }

    const id = await withTransaction(async (tx) => {
      const { resolved, supplierId: resolvedSupplierId, poIdsTouched } =
        await resolveGrnLines(tx, body.mode, body.lines, new Map());

      const supplierId = body.mode === 'DIRECT' ? body.supplierId! : resolvedSupplierId;
      // Header po_id is a convenience denormalisation for the common single-PO
      // case only — NULL when the GRN is Direct or spans several POs. Nothing
      // downstream may treat it as the complete picture (see file header).
      const headerPoId = poIdsTouched.size === 1 ? [...poIdsTouched][0]! : null;

      // Duplicate-invoice protection (Part 13): the same supplier's invoice
      // number should not be received twice. A cancelled GRN releases the
      // number for reuse (it was a mistake, not a real receipt).
      if (body.invoiceNo.trim()) {
        const dupe = await txQueryOne<{ grn_no: string }>(
          tx,
          `SELECT grn_no FROM grn_headers
            WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED'`,
          [supplierId, body.invoiceNo.trim()],
        );
        if (dupe) {
          throw BusinessRuleError(
            `Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
            `If this is genuinely a different delivery, use a distinct invoice number.`,
          );
        }
      }

      const grnNo = await nextDocumentNumber(tx, 'GRN', when);
      const status: GrnStatus = body.post ? 'POSTED' : 'DRAFT';

      // Saved as a draft first; posting it is postGrn's job, the same step as
      // every other posting route.
      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO grn_headers
           (grn_no, grn_date, grn_time, po_id, supplier_id, grn_type_id,
            invoice_no, invoice_date, challan_no, challan_date, vehicle_no,
            transporter_name, driver_name, lr_no, lr_date,
            received_by_user_id, remarks, status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'DRAFT',$18,$18)
         RETURNING id`,
        [
          grnNo, dateStamp(when), timeStamp(), headerPoId, supplierId, body.grnTypeId ?? null,
          body.invoiceNo, body.invoiceDate ?? null, body.challanNo, body.challanDate ?? null, body.vehicleNo,
          body.transporterName, body.driverName, body.lrNo, body.lrDate ?? null,
          body.receivedByUserId ?? userId, body.remarks, userId,
        ],
      );
      if (!header) throw new Error('Failed to create GRN header.');

      await insertGrnLines(tx, header.id, resolved);

      // Posting is what moves the balance, assigns MLNs and inwards stock; a
      // draft leaves every PO, MLN and stock balance untouched.
      const posted = body.post ? await postGrn(tx, header.id, userId) : null;

      await auditIn(tx, {
        actor: actorFrom(req), action: body.post ? 'POST' : 'CREATE', entity: 'grn',
        entityId: header.id, entityLabel: grnNo,
        after: {
          grnNo, status, mode: body.mode, lineCount: body.lines.length,
          poCount: poIdsTouched.size, poIds: [...poIdsTouched],
          ...(posted ? { qcStatus: posted.qcStatus, heldForQc: posted.heldForQc } : {}),
        },
      });

      return header.id;
    });

    sendCreated(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
  }),
);

/**
 * Locks the GRN's header and refuses the save unless the GRN is still in the
 * status PUT /grn/:id chose its path by. That status is read before the
 * transaction, and while a long transaction (an inventory sheet sync) holds
 * the database, waiting requests take turns, so another user's post or cancel
 * can commit in between. A second Post of the same draft would rewrite the
 * lines of the GRN the first had just posted; an edit of a GRN cancelled
 * meanwhile put stock that never arrived on it and raised a quality inspection
 * no decision could close (review of 2026-10-17).
 */
async function lockGrnInStatus(
  tx: Queryable, id: number, grnNo: string, expected: GrnStatus,
): Promise<{ supplier_id: number; grn_date: string }> {
  const locked = await txQueryOne<{ status: GrnStatus; supplier_id: number; grn_date: string }>(
    tx, 'SELECT status, supplier_id, grn_date FROM grn_headers WHERE id = $1 FOR UPDATE', [id],
  );
  if (!locked) throw NotFoundError('GRN');
  if (locked.status !== expected) {
    throw BusinessRuleError(
      `GRN ${grnNo} has just been ${statusLabel(locked.status).toLowerCase()} by someone else — reload it before saving.`,
      { status: locked.status },
    );
  }
  return locked;
}

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
 *
 * A line under quality inspection put into stock only what QC released, so
 * its quantities are QC's: while the inspection is open a corrected received
 * quantity moves no stock and becomes the inspection's received quantity;
 * once QC has decided, the received quantity is locked. Its accepted and
 * rejected quantities are the inspection's and are kept as QC recorded them.
 */
async function updatePostedGrn(
  req: Request, res: Response, id: number,
  before: { grn_no: string; status: GrnStatus; po_id: number | null },
  body: GrnBody, userId: number,
): Promise<void> {
  await withTransaction(async (tx) => {
    const header = await lockGrnInStatus(tx, id, before.grn_no, 'POSTED');
    const supplierId = header.supplier_id;

    const existingLines = await txQuery<{
      id: number; line_no: number; po_line_id: number | null; item_id: number; item_code: string;
      grn_qty: string; accepted_qty: string | null; rejected_qty: string | null;
      uom_id: number | null; batch_no: string; receipt_location: string;
      qc_id: number | null; qc_status: string | null; qc_accepted: string | null; qc_rejected: string | null;
    }>(
      tx,
      `SELECT gl.id, gl.line_no, gl.po_line_id, gl.item_id, gl.item_code, gl.grn_qty, gl.accepted_qty, gl.rejected_qty,
              gl.uom_id, gl.batch_no, gl.receipt_location,
              qi.id AS qc_id, qi.status AS qc_status, qi.accepted_qty AS qc_accepted, qi.rejected_qty AS qc_rejected
         FROM grn_lines gl
         LEFT JOIN LATERAL (
           SELECT q.id, q.status, q.accepted_qty, q.rejected_qty FROM qc_inspections q
            WHERE q.grn_line_id = gl.id ORDER BY q.id DESC LIMIT 1
         ) qi ON TRUE
        WHERE gl.grn_id = $1 ORDER BY gl.line_no`,
      [id],
    );
    const byId = new Map(existingLines.map((l) => [l.id, l]));

    const existingMode: 'PO' | 'DIRECT' = existingLines.some((l) => l.po_line_id != null) ? 'PO' : 'DIRECT';
    if (body.mode !== existingMode) {
      throw BusinessRuleError(`This GRN was posted in ${existingMode} mode and cannot switch to ${body.mode} mode on edit.`);
    }

    const submittedExisting = body.lines.filter((l) => l.id != null);
    const submittedNew = body.lines.filter((l) => l.id == null);

    // Removing an already-posted line would require deleting its grn_lines
    // row, which the MLN's RESTRICT foreign key refuses outright — surfaced
    // here as a clear business message instead of a raw FK-violation error.
    const submittedIds = new Set(submittedExisting.map((l) => l.id!));
    for (const existing of existingLines) {
      if (!submittedIds.has(existing.id)) {
        throw BusinessRuleError(
          `Line ${existing.line_no} (${existing.item_code}) has already been posted and assigned a lot number — ` +
          `it cannot be removed. Correct its quantity instead, or cancel this GRN and raise a fresh one.`,
        );
      }
    }

    const poIdsTouched = new Set<number>();
    if (before.po_id) poIdsTouched.add(before.po_id);

    if (body.invoiceNo.trim()) {
      const dupe = await txQueryOne<{ grn_no: string }>(
        tx,
        `SELECT grn_no FROM grn_headers
          WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED' AND id <> $3`,
        [supplierId, body.invoiceNo.trim(), id],
      );
      if (dupe) {
        throw BusinessRuleError(
          `Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
          `If this is genuinely a different delivery, use a distinct invoice number.`,
        );
      }
    }

    const maxLineNo = existingLines.reduce((m, l) => Math.max(m, l.line_no), 0);
    const grnDate = body.grnDate ?? toDateOnly(header.grn_date);

    for (const line of submittedExisting) {
      const existing = byId.get(line.id!);
      if (!existing) {
        throw ValidationError(`Line ${line.id} does not belong to this GRN.`);
      }
      if (body.mode === 'PO' && line.poLineId !== existing.po_line_id) {
        throw BusinessRuleError(
          `Line ${existing.line_no} (${existing.item_code}) has already been posted — its purchase order line cannot be changed. ` +
          `Remove the line item selection and add it as a new line instead.`,
        );
      }
      if (body.mode === 'DIRECT' && line.itemId !== existing.item_id) {
        throw BusinessRuleError(
          `Line ${existing.line_no} (${existing.item_code}) has already been posted — its item cannot be changed. ` +
          `Add the new item as a separate line instead.`,
        );
      }

      const underQc = existing.qc_id != null;
      const newGrnQty = toQty(line.grnQty);
      const newAccepted = underQc ? existing.accepted_qty
        : line.acceptedQty == null || line.acceptedQty === '' ? null : toQty(line.acceptedQty);
      const newRejected = underQc ? existing.rejected_qty
        : line.rejectedQty == null || line.rejectedQty === '' ? null : toQty(line.rejectedQty);
      const oldUsable = usableQtyOf(existing);
      const newUsable = usableQtyOf({ grn_qty: newGrnQty, accepted_qty: newAccepted });
      const receivedChanged = dec(newGrnQty).minus(dec(existing.grn_qty)).abs().greaterThan(0.00005);
      const qtyChanged = receivedChanged || (!underQc && dec(newUsable).minus(dec(oldUsable)).abs().greaterThan(0.00005));

      if (qtyChanged) {
        if (underQc) {
          if (!isOpenQcStatus(existing.qc_status!)) {
            throw BusinessRuleError(
              `${existing.item_code} (line ${existing.line_no}) has been through quality inspection ` +
              `(${qcStatusLabel(existing.qc_status!)}) — its received quantity can no longer be corrected. ` +
              `Other details on this line remain editable.`,
              { itemCode: existing.item_code, lineNo: existing.line_no, qcStatus: existing.qc_status },
            );
          }
          const recorded = dec(existing.qc_accepted ?? '0').plus(dec(existing.qc_rejected ?? '0'));
          if (dec(newGrnQty).lessThan(recorded)) {
            throw BusinessRuleError(
              `${existing.item_code} (line ${existing.line_no}): QC has already recorded ${toQty(recorded)} as accepted ` +
              `or rejected, so the received quantity cannot go below that.`,
              { itemCode: existing.item_code, lineNo: existing.line_no, recordedByQc: toQty(recorded) },
            );
          }
        } else {
          const consumed = await hasRequisitionConsumption(tx, existing.item_id);
          if (consumed) {
            throw BusinessRuleError(
              `${existing.item_code} (line ${existing.line_no}) has already been issued against a Requisition — ` +
              `its received quantity can no longer be corrected. Other details on this line remain editable.`,
              { itemCode: existing.item_code, lineNo: existing.line_no },
            );
          }
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

      await tx.query(
        `UPDATE grn_lines
            SET grn_qty = $2, invoice_qty = $3, accepted_qty = $4, rejected_qty = $5,
                receipt_location = $6, batch_no = $7, package_count = $8, packing_type = $9,
                expiry_date = $10, label_count = $11, label_qty = $12, remarks = $13,
                rate = COALESCE($14, rate), updated_at = now()
          WHERE id = $1`,
        [
          existing.id, newGrnQty,
          line.invoiceQty == null || line.invoiceQty === '' ? null : toQty(line.invoiceQty),
          newAccepted, newRejected,
          line.location, line.batchNo,
          line.packageCount == null || line.packageCount === '' ? null : toQty(line.packageCount),
          line.packingType, line.expiryDate ?? null,
          line.labelCount == null || line.labelCount === '' ? null : toQty(line.labelCount),
          line.labelQty == null || line.labelQty === '' ? null : toQty(line.labelQty),
          line.remarks, newRate,
        ],
      );

      if (qtyChanged && underQc) {
        // The material is still held, so stock does not move: the inspection
        // now checks the corrected quantity.
        await tx.query(
          'UPDATE qc_inspections SET received_qty = $2, updated_at = now() WHERE id = $1',
          [existing.qc_id, newGrnQty],
        );
      } else if (qtyChanged) {
        const delta = dec(newUsable).minus(dec(oldUsable));
        await adjustGrnLineStock(
          tx,
          { id: existing.id, item_id: existing.item_id, po_line_id: existing.po_line_id, grn_qty: newGrnQty, accepted_qty: newAccepted, uom_id: existing.uom_id, batch_no: line.batchNo, receipt_location: line.location },
          toQty(delta),
          { grnId: id, grnNo: before.grn_no, grnDate, supplierId: supplierId, userId },
        );
      }
    }

    // Brand-new lines added to an already-posted GRN are received at once,
    // through the same step as a posting — an item that needs inspection is
    // held for QC — and adding stock never conflicts with anything a
    // Requisition already relied on.
    let heldForQc = 0;
    if (submittedNew.length > 0) {
      const { resolved, supplierId: newSupplierId, poIdsTouched: newPoIds } =
        await resolveGrnLines(tx, body.mode, submittedNew, new Map());
      // A GRN never mixes suppliers (existing invariant) — a brand-new line
      // must resolve to the SAME supplier this GRN was already posted under.
      if (body.mode === 'PO' && newSupplierId !== supplierId) {
        throw BusinessRuleError(
          `The new line(s) belong to a different supplier than this GRN's existing lines. ` +
          `A single GRN must be raised for one supplier — create a separate GRN for that supplier instead.`,
        );
      }
      if (body.mode === 'DIRECT' && body.supplierId != null && body.supplierId !== supplierId) {
        throw BusinessRuleError(
          `This GRN was posted for a different supplier — its supplier cannot be changed on edit. ` +
          `Create a separate GRN for the other supplier instead.`,
        );
      }
      const newLineIds = await insertGrnLines(tx, id, resolved, maxLineNo + 1);
      for (const poId of newPoIds) poIdsTouched.add(poId);
      const received = await receiveLines(
        tx, { id, grnNo: before.grn_no, grnDate, supplierId }, await loadLinesToReceive(tx, id, newLineIds), userId,
      );
      heldForQc = received.heldForQc;
      if (heldForQc > 0) await refreshGrnQcStatus(tx, id);
    }

    // All PO lines on this GRN (pre-existing + newly added) resolve their
    // own po_line_id independently either way — this is only the same
    // single-PO display convenience the create/draft path already computes.
    const allLinePoIds = new Set<number>();
    for (const l of existingLines) if (l.po_line_id) {
      const b = await txQueryOne<{ po_id: number }>(tx, 'SELECT po_id FROM purchase_order_lines WHERE id = $1', [l.po_line_id]);
      if (b) allLinePoIds.add(Number(b.po_id));
    }
    for (const poId of poIdsTouched) allLinePoIds.add(poId);
    const headerPoId = allLinePoIds.size === 1 ? [...allLinePoIds][0]! : null;

    await tx.query(
      `UPDATE grn_headers
          SET po_id = $2, grn_type_id = $3, grn_date = COALESCE($4, grn_date), invoice_no = $5, invoice_date = $6,
              challan_no = $7, challan_date = $8, vehicle_no = $9, transporter_name = $10, driver_name = $11,
              lr_no = $12, lr_date = $13, received_by_user_id = $14, remarks = $15,
              updated_at = now(), updated_by = $16
        WHERE id = $1`,
      [
        id, headerPoId, body.grnTypeId ?? null, body.grnDate ?? null, body.invoiceNo, body.invoiceDate ?? null,
        body.challanNo, body.challanDate ?? null, body.vehicleNo, body.transporterName, body.driverName,
        body.lrNo, body.lrDate ?? null, body.receivedByUserId ?? userId, body.remarks, userId,
      ],
    );

    for (const poId of poIdsTouched) await recomputePoStatus(tx, poId);

    await auditIn(tx, {
      actor: actorFrom(req), action: 'UPDATE', entity: 'grn', entityId: id, entityLabel: before.grn_no,
      before: { lineCount: existingLines.length },
      after: { lineCount: body.lines.length, newLines: submittedNew.length, poIds: [...poIdsTouched], heldForQc },
    });
  });

  sendOk(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
}

router.put(
  '/:id',
  requirePermission('grn.edit'),
  validateBody(grnSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as GrnBody;
    const userId = req.user!.id;

    // This status only picks the path: each path reads it again under the row
    // lock (lockGrnInStatus) before it writes anything.
    const before = await queryOne<{ grn_no: string; status: GrnStatus; po_id: number | null }>(
      'SELECT grn_no, status, po_id FROM grn_headers WHERE id = $1', [id],
    );
    if (!before) throw NotFoundError('GRN');
    assertGrnEditable(before.status, before.grn_no);

    // Posting is the approval step whichever route it arrives by — the same rule
    // POST /grn and POST /grn/:id/post already apply. Without it, a user with
    // edit but not approve rights could post a draft simply by saving it.
    if (body.post && before.status === 'DRAFT' && !req.user!.permissions.has('grn.approve')) {
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
      await lockGrnInStatus(tx, id, before.grn_no, 'DRAFT');
      await tx.query('DELETE FROM grn_lines WHERE grn_id = $1', [id]);

      // A DRAFT contributes nothing to any PO balance, so prior quantities are
      // zero — re-saving a draft can never fail against its own earlier entry.
      const { resolved, supplierId: resolvedSupplierId, poIdsTouched } =
        await resolveGrnLines(tx, body.mode, body.lines, new Map());
      const supplierId = body.mode === 'DIRECT' ? body.supplierId! : resolvedSupplierId;
      const headerPoId = poIdsTouched.size === 1 ? [...poIdsTouched][0]! : null;

      if (body.invoiceNo.trim()) {
        const dupe = await txQueryOne<{ grn_no: string }>(
          tx,
          `SELECT grn_no FROM grn_headers
            WHERE supplier_id = $1 AND lower(invoice_no) = lower($2) AND status <> 'CANCELLED' AND id <> $3`,
          [supplierId, body.invoiceNo.trim(), id],
        );
        if (dupe) {
          throw BusinessRuleError(
            `Invoice ${body.invoiceNo.trim()} for this supplier has already been received on GRN ${dupe.grn_no}. ` +
            `If this is genuinely a different delivery, use a distinct invoice number.`,
          );
        }
      }

      const status: GrnStatus = body.post ? 'POSTED' : before.status;
      if (body.post) assertGrnTransition(before.status, 'POSTED');

      await tx.query(
        `UPDATE grn_headers
            SET po_id = $2, supplier_id = $3, grn_type_id = $4,
                grn_date = COALESCE($5, grn_date), invoice_no = $6, invoice_date = $7,
                challan_no = $8, challan_date = $9, vehicle_no = $10,
                transporter_name = $11, driver_name = $12, lr_no = $13, lr_date = $14,
                received_by_user_id = $15, remarks = $16,
                updated_at = now(), updated_by = $17
          WHERE id = $1`,
        [
          id, headerPoId, supplierId, body.grnTypeId ?? null,
          body.grnDate ?? null, body.invoiceNo, body.invoiceDate ?? null,
          body.challanNo, body.challanDate ?? null, body.vehicleNo,
          body.transporterName, body.driverName, body.lrNo, body.lrDate ?? null,
          body.receivedByUserId ?? userId, body.remarks, userId,
        ],
      );

      await insertGrnLines(tx, id, resolved);

      // Only a DRAFT reaches this path, so `body.post` here always means
      // "posting for the first time" — the same step as every other posting
      // route, never a second inward. The OLD PO is recomputed too when the
      // edit changed which PO(s) the GRN references.
      const posted = body.post ? await postGrn(tx, id, userId, [before.po_id]) : null;

      await auditIn(tx, {
        actor: actorFrom(req), action: body.post ? 'POST' : 'UPDATE', entity: 'grn',
        entityId: id, entityLabel: before.grn_no,
        before,
        after: {
          status, mode: body.mode, lineCount: body.lines.length, poIds: [...poIdsTouched],
          ...(posted ? { qcStatus: posted.qcStatus, heldForQc: posted.heldForQc } : {}),
        },
      });
    });

    sendOk(res, await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]));
  }),
);

/* ── POST /grn/:id/post ─────────────────────────────────────────────────────── */

router.post(
  '/:id/post',
  requirePermission('grn.approve'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);

    const result = await withTransaction(async (tx) => {
      const grn = await txQueryOne<{ grn_no: string; status: GrnStatus }>(
        tx, 'SELECT grn_no, status FROM grn_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!grn) throw NotFoundError('GRN');
      assertNotAlready('GRN', grn.grn_no, grn.status, 'POSTED');
      assertGrnTransition(grn.status, 'POSTED');

      const posted = await postGrn(tx, id, req.user!.id);

      await auditIn(tx, {
        actor: actorFrom(req), action: 'POST', entity: 'grn', entityId: id,
        entityLabel: grn.grn_no, before: { status: grn.status },
        after: {
          status: 'POSTED', poIds: posted.poIds, poStatuses: posted.poStatuses,
          qcStatus: posted.qcStatus, heldForQc: posted.heldForQc,
        },
      });

      return { grnNo: grn.grn_no, poStatuses: posted.poStatuses, qcStatus: posted.qcStatus, heldForQc: posted.heldForQc };
    });

    sendOk(res, {
      ...result,
      message: (result.poStatuses.length > 0
        ? `GRN ${result.grnNo} has been posted. Purchase order status: ${result.poStatuses.map((s) => s.replace(/_/g, ' ').toLowerCase()).join(', ')}.`
        : `GRN ${result.grnNo} has been posted.`) + qcHoldNote(result.heldForQc),
    });
  }),
);

/* ── POST /grn/:id/cancel ───────────────────────────────────────────────────── */

router.post(
  '/:id/cancel',
  requirePermission('grn.approve'),
  validateBody(z.object({ reason: z.string().trim().max(1000).optional() })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as { reason?: string };
    if (!reason?.trim()) {
      throw ValidationError('A reason is required to cancel a GRN.', [
        { field: 'reason', message: 'Please state why this receipt is being reversed.' },
      ]);
    }

    const result = await withTransaction(async (tx) => {
      const grn = await txQueryOne<{ grn_no: string; status: GrnStatus; grn_date: string; supplier_id: number }>(
        tx, 'SELECT grn_no, status, grn_date, supplier_id FROM grn_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!grn) throw NotFoundError('GRN');
      // Without this a second cancel sailed through (same-state transitions are
      // allowed for saves) and replaced the original reason, time and person.
      assertNotAlready('GRN', grn.grn_no, grn.status, 'CANCELLED');
      assertGrnTransition(grn.status, 'CANCELLED');
      const wasPosted = grn.status === 'POSTED';

      const lines = await txQuery<{
        id: number; po_line_id: number | null; item_id: number; item_code: string; grn_qty: string;
        accepted_qty: string | null; uom_id: number | null; batch_no: string; receipt_location: string;
      }>(
        tx,
        `SELECT id, po_line_id, item_id, item_code, grn_qty, accepted_qty, uom_id, batch_no, receipt_location
           FROM grn_lines WHERE grn_id = $1 ORDER BY line_no`,
        [id],
      );
      const poIdsTouched = new Set<number>();
      for (const l of lines) {
        if (l.po_line_id == null) continue;
        const balance = await txQueryOne<{ po_id: number }>(
          tx, 'SELECT po_id FROM purchase_order_lines WHERE id = $1', [l.po_line_id],
        );
        if (balance) poIdsTouched.add(Number(balance.po_id));
      }

      // Only what the receipt actually put into stock comes back out. A line
      // held for quality inspection put in nothing, or only what QC released;
      // cancelling used to take every line's received quantity out, including
      // stock that had never come in (A7 F04). A DRAFT never moved stock or
      // issued an MLN at all (Part 2/6/8).
      const inStock = wasPosted ? await stockReceivedByGrnLine(tx, id) : new Map<number, string>();
      const toReverse = lines.filter((l) => inStock.has(Number(l.id))).map((l) => ({ line: l, qty: inStock.get(Number(l.id))! }));

      if (wasPosted) {
        // Same real relationship as the edit-lock (Section 4): reversing a
        // posted receipt whose item is still issued against a Requisition
        // would try to pull the pooled balance below what that Requisition
        // relies on — refuse cleanly instead of letting the item's own nonneg
        // stock constraint fail as a raw DB error. Issues that were reversed
        // gave their stock back and no longer count.
        for (const { line: l } of toReverse) {
          const consumed = await hasRequisitionConsumption(tx, l.item_id);
          if (consumed) {
            throw BusinessRuleError(
              `${grn.grn_no} cannot be cancelled — ${l.item_code} has already been issued against a Requisition ` +
              `and that issue still stands, so reversing this receipt could take its stock below zero. ` +
              `Reverse that issue slip first, or correct the GRN's other details instead of cancelling it.`,
              { itemCode: l.item_code },
            );
          }
        }
        // Stock that left another way (a direct issue, an adjustment, a sheet
        // sync) is checked here too, before anything is written.
        await assertGrnCancelCovered(tx, grn.grn_no, toReverse.map(({ line, qty }) => ({ item_id: line.item_id, qty })));
      }

      await tx.query(
        `UPDATE grn_headers
            SET status = 'CANCELLED', cancelled_at = now(), cancelled_by = $2,
                cancel_reason = $3, updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [id, req.user!.id, reason],
      );

      // Reversing a posted receipt gives the quantity back on EVERY purchase
      // order this GRN touched; each may fall from COMPLETED to
      // PARTIALLY_RECEIVED or back to OPEN, which recompute handles (ADR-003).
      const poStatuses: string[] = [];
      for (const poId of poIdsTouched) poStatuses.push(await recomputePoStatus(tx, poId));

      // The MLN rows themselves are never deleted; their "cancelled" status is
      // answered by joining to grn_headers.status, not erased here.
      for (const { line, qty } of toReverse) {
        await reverseGrnLine(tx, line, qty, {
          grnId: id, grnNo: grn.grn_no, grnDate: toDateOnly(grn.grn_date),
          supplierId: grn.supplier_id, userId: req.user!.id,
        });
      }

      // Inspections still waiting for a decision are closed: none of their
      // material is in stock, and a pass would add the stock of a receipt that
      // no longer exists.
      const qcInspectionsClosed = await closeOpenInspections(tx, id, `GRN cancelled: ${reason}`);
      if (qcInspectionsClosed > 0) await refreshGrnQcStatus(tx, id);

      await auditIn(tx, {
        actor: actorFrom(req), action: 'CANCEL', entity: 'grn', entityId: id,
        entityLabel: grn.grn_no, before: { status: grn.status },
        after: {
          status: 'CANCELLED', poIds: [...poIdsTouched], poStatuses, stockReversed: toReverse.length > 0,
          linesReversed: toReverse.map(({ line, qty }) => ({ itemCode: line.item_code, qty })), qcInspectionsClosed,
        },
        message: reason,
      });

      return { grnNo: grn.grn_no, poStatuses, wasPosted, linesReversed: toReverse.length, qcInspectionsClosed };
    });

    const qcNote = result.qcInspectionsClosed > 0
      ? ` ${result.qcInspectionsClosed} open quality inspection(s) were closed.`
      : '';
    sendOk(res, {
      ...result,
      message: !result.wasPosted
        ? `Draft GRN ${result.grnNo} has been cancelled.`
        : result.linesReversed > 0
          ? `GRN ${result.grnNo} has been cancelled — its quantities returned to the purchase order balance and stock was reversed.${qcNote}`
          : `GRN ${result.grnNo} has been cancelled — its quantities returned to the purchase order balance. ` +
            `None of its material had entered stock, so stock is unchanged.${qcNote}`,
    });
  }),
);

/* ── DELETE (drafts only) ───────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('grn.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const grn = await queryOne<{ grn_no: string; status: GrnStatus }>(
      'SELECT grn_no, status FROM grn_headers WHERE id = $1', [id],
    );
    if (!grn) throw NotFoundError('GRN');
    if (grn.status !== 'DRAFT') {
      throw BusinessRuleError(
        `Only draft GRNs can be deleted. GRN ${grn.grn_no} is ${grn.status.toLowerCase()} — cancel it instead so the receipt history is preserved.`,
      );
    }

    await withTransaction(async (tx) => {
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'grn', entityId: id,
        entityLabel: grn.grn_no, before: grn,
      });
      await tx.query('DELETE FROM grn_headers WHERE id = $1', [id]);
    });

    sendOk(res, { deleted: true, message: `Draft GRN ${grn.grn_no} has been deleted.` });
  }),
);

/* ── Print-view / PDF — one document, two ways to consume it ────────────────── */

async function buildDocument(id: number): Promise<GrnDocumentData> {
  const header = await queryOne<Record<string, unknown>>(
    `SELECT g.*, gt.name AS grn_type_name,
            s.supplier_name, s.address AS supplier_address, s.city AS supplier_city,
            s.state AS supplier_state, s.gst_no AS supplier_gst, s.mobile_no AS supplier_mobile
       FROM grn_headers g
       JOIN suppliers s ON s.id = g.supplier_id
       LEFT JOIN lookups gt ON gt.id = g.grn_type_id
      WHERE g.id = $1`,
    [id],
  );
  if (!header) throw NotFoundError('GRN');

  const lines = await query<Record<string, unknown>>(
    `SELECT gl.line_no, gl.item_code, gl.item_description, gl.item_specification,
            gl.grn_qty, gl.invoice_qty, gl.rate, gl.amount, gl.batch_no, gl.receipt_location,
            u.code AS uom_code,
            (SELECT string_agg(DISTINCT poh.po_no, ', ') FROM purchase_order_lines pol
               JOIN purchase_order_headers poh ON poh.id = pol.po_id WHERE pol.id = gl.po_line_id) AS po_no,
            (SELECT string_agg(DISTINCT ih.indent_no, ', ') FROM po_indent_sources pis
               JOIN purchase_indent_headers ih ON ih.id = pis.indent_id WHERE pis.po_line_id = gl.po_line_id) AS indent_no
       FROM grn_lines gl
       LEFT JOIN lookups u ON u.id = gl.uom_id
      WHERE gl.grn_id = $1
      ORDER BY gl.line_no`,
    [id],
  );

  const company = await loadCompanySettings();

  const h = header as Record<string, string>;
  const totalQty = lines.reduce((s, l) => s.plus(dec(l.grn_qty as string)), dec(0));
  const totalAmount = lines.reduce((s, l) => s.plus(dec(l.amount as string)), dec(0));

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
      item_specification: String(l.item_specification ?? ''), po_no: (l.po_no as string | null) ?? null,
      indent_no: (l.indent_no as string | null) ?? null, uom_code: l.uom_code as string | null,
      batch_no: String(l.batch_no ?? ''), receipt_location: String(l.receipt_location ?? ''),
      grn_qty: String(l.grn_qty), invoice_qty: l.invoice_qty == null ? null : String(l.invoice_qty),
      rate: String(l.rate), amount: String(l.amount),
    })),
    company,
  };
}

router.get(
  '/:id/print-view',
  requirePermission('grn.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildDocument(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderGrnDocumentHtml(doc));
  }),
);

router.get(
  '/:id/pdf',
  requirePermission('grn.view'),
  asyncHandler(async (req, res) => {
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
        footerTemplate:
          '<div style="width:100%;font-size:8px;color:#8a93a6;text-align:center;">' +
          'Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
      });

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', attachmentDisposition(doc.grn_no, 'pdf'));
      res.send(pdf);
    } finally {
      await browser.close();
    }
  }),
);

/* ── Analysis (SRS §12 reporting) ────────────────────────────────────────────
 * Consolidated into a small number of genuinely distinct, filterable views
 * rather than one endpoint per named report in the reference spec — the same
 * "Item-wise" table answers Item Receipt Analysis / Item-wise GRN / Rate
 * Analysis at once by sorting/filtering, which is what the reference spec
 * itself asks for ("Do not create meaningless duplicate reports"). Dashboard
 * cards and date/supplier/item trend breakdowns are already served generically
 * by the existing /analytics endpoints (GrnAnalysis.tsx) and are not
 * duplicated here.
 *
 * These need the GRN analysis right, not just the view right: they consolidate
 * received value by supplier and item, which a view-only role had no business
 * reading in bulk. Every role that holds grn.analyze (Purchase Head, Store User,
 * Management) keeps them; the GRN Analysis screen itself draws from /analytics,
 * whose rights are unchanged.
 * ──────────────────────────────────────────────────────────────────────── */

router.get(
  '/analysis/po-wise',
  requirePermission('grn.analyze'),
  validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    supplierId: csvIdArray,
    status: csvArray,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  })),
  asyncHandler(async (_req, res) => {
    const f = parsedQuery<{ search?: string; supplierId?: number[]; status?: string[]; page: number; pageSize: number }>(res);
    const b = new SqlBuilder();
    b.addIn('h.supplier_id', f.supplierId);
    b.addIn('h.status', f.status);
    if (f.search) {
      const p = b.push(`%${f.search.toLowerCase()}%`);
      b.addRaw(`(lower(h.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p})`);
    }
    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM purchase_order_headers h JOIN suppliers s ON s.id = h.supplier_id ${b.where()}`,
      b.params,
    );
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);
    const rows = await query(
      `SELECT h.id AS po_id, h.po_no, h.po_date, h.status, s.supplier_name,
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
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );
    sendPage(res, rows, Number(totalRow?.n ?? 0), f.page, f.pageSize);
  }),
);

router.get(
  '/analysis/item-wise',
  requirePermission('grn.analyze'),
  validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  })),
  asyncHandler(async (_req, res) => {
    const f = parsedQuery<{ search?: string; page: number; pageSize: number }>(res);

    const cb = new SqlBuilder();
    cb.addRaw('EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.item_id = i.id)');
    if (f.search) {
      const p = cb.push(`%${f.search.toLowerCase()}%`);
      cb.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p})`);
    }
    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM items i ${cb.where()}`, cb.params,
    );

    const b = new SqlBuilder();
    b.addRaw('EXISTS (SELECT 1 FROM purchase_order_lines l2 WHERE l2.item_id = i.id)');
    if (f.search) {
      const p = b.push(`%${f.search.toLowerCase()}%`);
      b.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p})`);
    }
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);

    const rows = await query(
      `SELECT i.id AS item_id, i.item_code, i.item_description, u.code AS uom_code,
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
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );
    sendPage(res, rows, Number(totalRow?.n ?? rows.length), f.page, f.pageSize);
  }),
);

router.get(
  '/analysis/supplier-wise',
  requirePermission('grn.analyze'),
  validateQuery(z.object({
    search: z.string().trim().max(200).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(200).default(25),
  })),
  asyncHandler(async (_req, res) => {
    const f = parsedQuery<{ search?: string; page: number; pageSize: number }>(res);

    const cb = new SqlBuilder();
    cb.addRaw('EXISTS (SELECT 1 FROM purchase_order_headers h WHERE h.supplier_id = s.id)');
    if (f.search) {
      const p = cb.push(`%${f.search.toLowerCase()}%`);
      cb.addRaw(`lower(s.supplier_name) LIKE ${p}`);
    }
    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM suppliers s ${cb.where()}`, cb.params,
    );

    const b = new SqlBuilder();
    b.addRaw('EXISTS (SELECT 1 FROM purchase_order_headers h2 WHERE h2.supplier_id = s.id)');
    if (f.search) {
      const p = b.push(`%${f.search.toLowerCase()}%`);
      b.addRaw(`lower(s.supplier_name) LIKE ${p}`);
    }
    const limit = b.push(f.pageSize);
    const offset = b.push((f.page - 1) * f.pageSize);

    const rows = await query(
      `SELECT s.id AS supplier_id, s.supplier_name, s.supplier_code,
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
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );
    sendPage(res, rows, Number(totalRow?.n ?? rows.length), f.page, f.pageSize);
  }),
);

router.get(
  '/analysis/summary',
  requirePermission('grn.analyze'),
  asyncHandler(async (_req, res) => {
    const grnCounts = await query<{ status: string; n: string }>(
      "SELECT status, COUNT(*) AS n FROM grn_headers GROUP BY status",
    );
    const today = await queryOne<{ n: string }>(
      "SELECT COUNT(*) AS n FROM grn_headers WHERE grn_date = CURRENT_DATE",
    );
    const received = await queryOne<{ qty: string; value: string }>(
      `SELECT COALESCE(SUM(gl.grn_qty), 0) AS qty, COALESCE(SUM(gl.amount), 0) AS value
         FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id WHERE gh.status = 'POSTED'`,
    );
    const poCounts = await query<{ status: string; n: string }>(
      'SELECT status, COUNT(*) AS n FROM purchase_order_headers GROUP BY status',
    );
    const poPending = await queryOne<{ qty: string; value: string }>(
      "SELECT COALESCE(SUM(total_pending_qty),0) AS qty, COALESCE(SUM(pending_amount),0) AS value FROM v_po_header_balance WHERE status IN ('OPEN','PARTIALLY_RECEIVED')",
    );

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
  }),
);

export default router;
