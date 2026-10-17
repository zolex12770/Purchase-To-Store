/**
 * Purchase Order (SRS §11).
 *
 * Supports all four creation modes required by §11.1:
 *   1. DIRECT               — no originating indent
 *   2. INDENT-BASED         — drawn from one approved indent
 *   3. MULTI-INDENT         — several indents consolidated onto one PO
 *   4. SUPPLIER-WISE        — pending indents for one supplier consolidated
 *
 * Modes 2–4 are the same code path: a PO line carries a list of source indent
 * lines. One source is mode 2; several sources across indents is modes 3 and 4.
 * Every draw is validated and locked through `domain/quantities.ts` (ADR-005), so
 * a quantity can never be consumed twice, and `po_indent_sources` preserves the
 * traceability §11.3 demands.
 */
import { Router } from 'express';
import { z } from 'zod';
import { chromium } from 'playwright';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import { renderPoDocumentHtml, type PoDocumentData } from './po-document.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray, attachmentDisposition,
} from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError, AuthorizationError } from '../../core/errors.js';
import { requirePermission, hasPermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import { assertPoTransition, assertPoEditable, assertNotAlready, statusLabel, type PoStatus } from '../../domain/status.js';
import {
  lockIndentLineBalance, assertIndentDrawAllowed, recomputeIndentClosure,
} from '../../domain/quantities.js';
import { toQty, toRate, toNumeric, dec, lineAmount } from '../../domain/money.js';
import { loadCompanySettings } from '../../domain/company.js';
import { itemLineScope } from '../../domain/item-scope.js';

const router = Router();

/* ── List ───────────────────────────────────────────────────────────────────── */

const SORTABLE: Record<string, string> = {
  poNo: 'h.po_no',
  poDate: 'h.po_date',
  status: 'h.status',
  supplier: 's.supplier_name',
  totalAmount: 'b.total_amount',
  pendingAmount: 'b.pending_amount',
  createdAt: 'h.created_at',
};

/** The list's query; its Export accepts exactly the same (io/datasets.ts). */
export const listSchema = listQuerySchema.extend({
  status: csvArray,
  supplierId: csvIdArray,
  poTypeId: csvIdArray,
  itemId: csvIdArray,
  userId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  mainGroupId: csvIdArray,
  subMainGroupId: csvIdArray,
  itemTypeId: csvIdArray,
  hodId: csvIdArray,
  sourceMode: z.enum(['DIRECT', 'INDENT']).optional(),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** `pending` and `complete` back the dedicated SRS §11.4 sub-tabs. */
  view: z.enum(['all', 'pending', 'complete']).default('all'),
  overdue: z.enum(['true', 'false']).optional(),
  /** The orders the PO KPIs count (Total PO Value, Purchase Orders, …): every one but cancelled. */
  excludeCancelled: z.enum(['true', 'false']).optional(),
});

/**
 * A PO line still to be received: on an issued, open order (a DRAFT was never sent to
 * the supplier), not closed, with quantity outstanding. The Pending view, the overdue
 * filter and the pending KPIs (analytics) share this one rule, so a pending KPI opens
 * exactly the orders it counts. `alias` is a v_po_line_balance row.
 */
export const pendingLineSql = (alias: string): string =>
  `${alias}.is_receivable AND ${alias}.po_status IN ('OPEN', 'PARTIALLY_RECEIVED')`;

/** The list's filters (paging and sort aside): what the PO KPIs and charts count by, too. */
export type PoListFilter = Omit<z.infer<typeof listSchema>, 'page' | 'pageSize' | 'sortBy' | 'sortDir'>;

/**
 * The order lines the list's item-level filters select (item, department, cost centre,
 * groups, type, HOD), as a condition on `line`; '' when none is set (domain/item-scope.ts).
 * The list, its total tiles, its lines export and the PO KPIs and charts all use it.
 */
export const poLineScope = (q: PoListFilter, b: SqlBuilder, line: string): string => itemLineScope(q, b, line);

export function buildPoFilter(q: PoListFilter): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('h.status', q.status);
  if (q.excludeCancelled === 'true') b.addRaw("h.status <> 'CANCELLED'");
  b.addIn('h.supplier_id', q.supplierId);
  b.addIn('h.po_type_id', q.poTypeId);
  b.addIn('h.created_by', q.userId);
  b.add('h.source_mode = ?', q.sourceMode);
  b.add('h.po_date >= ?', q.dateFrom);
  b.add('h.po_date <= ?', q.dateTo);

  // An order is listed when one of its lines satisfies every item-level filter, and the
  // Pending view and "overdue only" ask that of the pending line itself: with a separate
  // "any line" test per filter, an order whose only pending line belonged to another
  // department was listed as pending for this one (2026-10-17 review).
  const scope = poLineScope(q, b, 'pl');
  const inScope = scope ? ` AND ${scope}` : '';
  if (scope) b.addRaw(`EXISTS (SELECT 1 FROM purchase_order_lines pl WHERE pl.po_id = h.id${inScope})`);

  // "Pending" and "Complete" are defined by the authoritative balance, not by a
  // status string a user could have set by hand (ADR-003). Pending is a line still to
  // be received (pendingLineSql), the rule the pending KPIs count by.
  if (q.view === 'pending') {
    b.addRaw(`EXISTS (SELECT 1 FROM v_po_line_balance pl WHERE pl.po_id = h.id AND ${pendingLineSql('pl')}${inScope})`);
  }
  if (q.view === 'complete') b.addRaw("h.status IN ('COMPLETED','SHORT_CLOSED')");

  if (q.overdue === 'true') {
    b.addRaw(
      `EXISTS (SELECT 1 FROM v_po_line_balance pl
                WHERE pl.po_id = h.id AND ${pendingLineSql('pl')}
                  AND pl.delivery_date IS NOT NULL AND pl.delivery_date < CURRENT_DATE${inScope})`,
    );
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(h.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} OR lower(h.remarks) LIKE ${p} ` +
      `OR EXISTS (SELECT 1 FROM purchase_order_lines l WHERE l.po_id = h.id ` +
      `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p})))`,
    );
  }
  return b;
}

export const PO_FROM = `
  FROM purchase_order_headers h
  JOIN v_po_header_balance b ON b.po_id = h.id
  JOIN suppliers s ON s.id = h.supplier_id`;

export interface PoListTotals {
  poCount: number;
  lineCount: number;
  totalPoQty: string;
  totalReceivedQty: string;
  totalPendingQty: string;
  value: string;
  pending: string;
  received: string;
  cancelledValue: string;
  /** True when an item-level filter narrowed the sums to its lines (rows still show whole orders). */
  lineScoped: boolean;
}

/**
 * The list's total tiles, which the PO KPI cards read too (analytics), so a card shows
 * exactly the tile of the list it opens. They add up the lines poLineScope selects: every
 * line of the listed orders, or under an item-level filter only that filter's lines.
 *
 * `value` deliberately EXCLUDES cancelled orders so it means exactly what the
 * `po_value_total` metric means (ADR-009 — one definition per KPI). Cancelled
 * value is reported separately so nothing is hidden from the user.
 */
export async function poListTotals(q: PoListFilter): Promise<PoListTotals> {
  const b = buildPoFilter(q);
  const scope = poLineScope(q, b, 'tl');
  const row = await queryOne<Omit<PoListTotals, 'lineScoped'>>(
    `SELECT COUNT(DISTINCT h.id)::int AS "poCount",
            (COUNT(tl.po_line_id) FILTER (WHERE h.status <> 'CANCELLED'))::int AS "lineCount",
            COALESCE(SUM(tl.po_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalPoQty",
            COALESCE(SUM(tl.received_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalReceivedQty",
            COALESCE(SUM(tl.pending_grn_qty) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS "totalPendingQty",
            COALESCE(SUM(tl.amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS value,
            COALESCE(SUM(tl.pending_amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS pending,
            COALESCE(SUM(tl.received_amount) FILTER (WHERE h.status <> 'CANCELLED'), 0) AS received,
            COALESCE(SUM(tl.amount) FILTER (WHERE h.status = 'CANCELLED'), 0) AS "cancelledValue"
       ${PO_FROM}
       LEFT JOIN v_po_line_balance tl ON tl.po_id = h.id${scope ? ` AND ${scope}` : ''}
       ${b.where()}`,
    b.params,
  );
  return {
    poCount: 0, lineCount: 0, totalPoQty: '0', totalReceivedQty: '0', totalPendingQty: '0',
    value: '0', pending: '0', received: '0', cancelledValue: '0', ...row, lineScoped: Boolean(scope),
  };
}

router.get(
  '/',
  requirePermission('po.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildPoFilter(q);

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n ${PO_FROM} ${b.where()}`, b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const order = resolveSort(q, SORTABLE, 'poDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT h.id, h.po_no, h.po_date, h.po_time, h.status, h.source_mode, h.remarks,
              h.delivery_date, h.currency_code, h.payment_terms, h.issued_at, h.close_reason,
              h.po_type_id, pt.name AS po_type_name,
              h.supplier_id, s.supplier_name, s.supplier_code, s.city AS supplier_city,
              b.line_count, b.total_po_qty, b.total_received_qty, b.total_pending_qty,
              b.total_amount, b.received_amount, b.pending_amount, b.derived_status, b.age_days,
              b.total_gst_amount, b.discount_amount, b.freight_amount, b.packing_amount,
              b.insurance_amount, b.grand_total,
              u.employee_name AS created_by_name,
              (SELECT COUNT(DISTINCT src.indent_id)::int FROM v_po_line_sources src WHERE src.po_id = h.id) AS source_indent_count,
              -- A GRN's own header.po_id is only a convenience denormalisation
              -- (NULL for a Direct GRN or one spanning several POs) — the
              -- authoritative trace is always grn_lines.po_line_id, so this
              -- counts through the lines, not the header, to include every
              -- GRN that actually touched this PO (GRN reconstruction).
              (SELECT COUNT(DISTINCT gl.grn_id)::int FROM grn_lines gl
                 JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
                 JOIN grn_headers gh ON gh.id = gl.grn_id
                WHERE pol.po_id = h.id AND gh.status = 'POSTED') AS grn_count
         ${PO_FROM}
         LEFT JOIN lookups pt ON pt.id = h.po_type_id
         LEFT JOIN users u ON u.id = h.created_by
         ${b.where()}
        ORDER BY ${order}, h.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    const cb = buildPoFilter({ ...q, status: undefined, view: 'all' });
    const counts = await query<{ status: string; n: string }>(
      `SELECT h.status, COUNT(*) AS n ${PO_FROM} ${cb.where()} GROUP BY h.status`,
      cb.params,
    );
    const totals = await poListTotals(q);

    sendPage(res, rows, total, q.page, q.pageSize, {
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      totals,
    });
  }),
);

/* ── GET /purchase-orders/:id ───────────────────────────────────────────────── */

/**
 * Header + lines + source traceability for one PO — the ONE query shared by
 * the JSON detail route, the print-view HTML, and the PDF (Module 12): none
 * of the three can ever show different numbers because none of them compute
 * anything themselves, they all just render this.
 */
async function loadPoForDocument(id: number): Promise<{
  header: Record<string, unknown>;
  lines: (Record<string, unknown> & { sources: Record<string, unknown>[] })[];
  sourceIndents: { indentId: unknown; indentNo: unknown; indentDate: unknown }[];
}> {
  const header = await queryOne<Record<string, unknown>>(
    `SELECT h.*, pt.name AS po_type_name,
            s.supplier_name, s.supplier_code, s.address AS supplier_address,
            s.city AS supplier_city, s.state AS supplier_state, s.country AS supplier_country,
            s.gst_no AS supplier_gst, s.email AS supplier_email, s.mobile_no AS supplier_mobile,
            s.contact_person AS supplier_contact,
            cu.employee_name AS created_by_name, iu.employee_name AS issued_by_name,
            b.line_count, b.total_po_qty, b.total_received_qty, b.total_pending_qty,
            b.total_amount, b.received_amount, b.pending_amount, b.derived_status, b.age_days,
            b.total_gst_amount, b.discount_amount, b.freight_amount, b.packing_amount,
            b.insurance_amount, b.grand_total
       FROM purchase_order_headers h
       JOIN v_po_header_balance b ON b.po_id = h.id
       JOIN suppliers s ON s.id = h.supplier_id
       LEFT JOIN lookups pt ON pt.id = h.po_type_id
       LEFT JOIN users cu ON cu.id = h.created_by
       LEFT JOIN users iu ON iu.id = h.issued_by
      WHERE h.id = $1`,
    [id],
  );
  if (!header) throw NotFoundError('Purchase order');

  const lines = await query<Record<string, unknown>>(
    `SELECT v.*, u.code AS uom_code, u.name AS uom_name, l.remarks, l.closed_reason
       FROM v_po_line_balance v
       JOIN purchase_order_lines l ON l.id = v.po_line_id
       LEFT JOIN lookups u ON u.id = v.uom_id
      WHERE v.po_id = $1
      ORDER BY v.line_no`,
    [id],
  );

  // Source traceability for every line (SRS §11.3) — fetched in ONE query and
  // attached in memory rather than per line (no N+1, SRS §30).
  const sources = await query<Record<string, unknown>>(
    `SELECT * FROM v_po_line_sources WHERE po_id = $1 ORDER BY po_line_no, indent_no`,
    [id],
  );
  const byLine = new Map<number, Record<string, unknown>[]>();
  for (const s of sources) {
    const key = Number(s.po_line_id);
    (byLine.get(key) ?? byLine.set(key, []).get(key)!).push(s);
  }

  return {
    header,
    lines: lines.map((l) => ({ ...l, sources: byLine.get(Number(l.po_line_id)) ?? [] })),
    sourceIndents: [...new Map(sources.map((s) => [s.indent_id, {
      indentId: s.indent_id, indentNo: s.indent_no, indentDate: s.indent_date,
    }])).values()],
  };
}

router.get(
  '/:id',
  requirePermission('po.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { header, lines, sourceIndents } = await loadPoForDocument(id);

    // Joined through the LINES, not g.po_id — a GRN spanning several POs (or a
    // Direct GRN) leaves the header po_id NULL, so this is the only join that
    // correctly finds every GRN that actually received against THIS PO, and
    // sums only the quantity/amount attributable to it (GRN reconstruction).
    const grns = await query(
      `SELECT g.id, g.grn_no, g.grn_date, g.status, g.challan_no,
              u.employee_name AS received_by_name,
              COALESCE(SUM(gl.grn_qty), 0) AS total_qty,
              COALESCE(SUM(gl.amount), 0)  AS total_amount
         FROM grn_lines gl
         JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
         JOIN grn_headers g ON g.id = gl.grn_id
         LEFT JOIN users u ON u.id = g.received_by_user_id
        WHERE pol.po_id = $1
        GROUP BY g.id, g.grn_no, g.grn_date, g.status, g.challan_no, u.employee_name
        ORDER BY g.grn_date DESC, g.id DESC`,
      [id],
    );

    sendOk(res, { ...header, lines, grns, sourceIndents });
  }),
);

/* ── Print-view / PDF — one document, two ways to consume it ────────────────── */

async function buildDocument(id: number): Promise<PoDocumentData> {
  const { header, lines, sourceIndents } = await loadPoForDocument(id);
  const company = await loadCompanySettings();

  const h = header as Record<string, string>;
  return {
    po_no: h.po_no, po_date: h.po_date, po_type_name: h.po_type_name,
    payment_terms: h.payment_terms, delivery_date: h.delivery_date, delivery_address: h.delivery_address,
    remarks: h.remarks,
    supplier_name: h.supplier_name, supplier_address: h.supplier_address, supplier_city: h.supplier_city,
    supplier_state: h.supplier_state, supplier_gst: h.supplier_gst, supplier_mobile: h.supplier_mobile,
    supplier_email: h.supplier_email,
    total_amount: h.total_amount, total_gst_amount: h.total_gst_amount,
    discount_mode: h.discount_mode as 'PERCENTAGE' | 'AMOUNT', discount_value: h.discount_value, discount_amount: h.discount_amount,
    freight_mode: h.freight_mode as 'PERCENTAGE' | 'AMOUNT', freight_value: h.freight_value, freight_amount: h.freight_amount,
    packing_mode: h.packing_mode as 'PERCENTAGE' | 'AMOUNT', packing_value: h.packing_value, packing_amount: h.packing_amount,
    insurance_mode: h.insurance_mode as 'PERCENTAGE' | 'AMOUNT', insurance_value: h.insurance_value, insurance_amount: h.insurance_amount,
    grand_total: h.grand_total,
    lines: lines.map((l) => ({
      line_no: Number(l.line_no), item_code: String(l.item_code), item_description: String(l.item_description),
      item_specification: String(l.item_specification ?? ''), po_qty: String(l.po_qty), uom_code: l.uom_code as string | null,
      rate: String(l.rate), gst_pct: String(l.gst_pct ?? '0'), gst_amount: String(l.gst_amount ?? '0'), amount: String(l.amount),
      sources: l.sources.map((s) => ({ indent_no: String(s.indent_no), consumed_qty: String(s.consumed_qty) })),
    })),
    sourceIndents: sourceIndents.map((s) => ({ indentNo: String(s.indentNo) })),
    company,
  };
}

router.get(
  '/:id/print-view',
  requirePermission('po.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildDocument(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderPoDocumentHtml(doc));
  }),
);

router.get(
  '/:id/pdf',
  requirePermission('po.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildDocument(id);
    const html = renderPoDocumentHtml(doc);

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
      // Imported PO numbers carry slashes (Z/PM/00368): see attachmentDisposition.
      res.setHeader('Content-Disposition', attachmentDisposition(doc.po_no, 'pdf'));
      res.send(pdf);
    } finally {
      await browser.close();
    }
  }),
);

/* ── Create ─────────────────────────────────────────────────────────────────── */

const sourceSchema = z.object({
  indentLineId: z.coerce.number().int().positive(),
  consumedQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Consumed quantity must be greater than zero.'),
});

const poLineSchema = z.object({
  /** Present when editing an EXISTING line on an already-issued PO — absent for a new line. */
  id: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive({ message: 'Select an item.' }),
  poQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'PO quantity must be greater than zero.'),
  uomId: z.coerce.number().int().positive().nullable().optional(),
  rate: z.union([z.number(), z.string()]).refine((v) => Number(v) >= 0, 'Rate cannot be negative.'),
  discountPct: z.union([z.number(), z.string()]).default(0)
    .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'Discount must be between 0 and 100.'),
  // GST stays per line, not one PO-wide rate — different items legitimately carry
  // different GST rates (HSN-dependent).
  gstPct: z.union([z.number(), z.string()]).default(0)
    .refine((v) => Number(v) >= 0 && Number(v) <= 100, 'GST must be between 0 and 100.'),
  itemSpecification: z.string().trim().max(1000).default(''),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  remarks: z.string().trim().max(500).default(''),
  /** Present for indent-based / consolidated POs; omitted for a direct PO. */
  sources: z.array(sourceSchema).default([]),
});

// A PO-level charge is entered as EITHER a percentage of the line subtotal OR a
// fixed amount — `mode` is the source of truth; the other side is always
// DERIVED (never stored), computed identically here and in v_po_header_balance
// (008_po_charges.sql) and mirrored for live preview in
// frontend/src/lib/poCalc.ts. See that migration's header comment for the full
// calculation sequence.
const chargeSchema = z.object({
  mode: z.enum(['PERCENTAGE', 'AMOUNT']).default('PERCENTAGE'),
  value: z.union([z.number(), z.string()]).default(0)
    .refine((v) => Number(v) >= 0, 'Must be zero or greater.'),
});

const poSchema = z.object({
  poDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  // PO Type is its own field, stored in its own column — its dropdown
  // OPTIONS happen to be sourced from the same shared master as Indent Type
  // (migration 013), but the selection itself is PO-specific.
  poTypeId: z.coerce.number().int().positive().nullable().optional(),
  supplierId: z.coerce.number().int().positive({ message: 'Select a supplier.' }),
  currencyCode: z.string().trim().max(10).optional(),
  paymentTerms: z.string().trim().max(100).optional(),
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  deliveryAddress: z.string().trim().max(500).default(''),
  remarks: z.string().trim().max(1000).default(''),
  lines: z.array(poLineSchema).min(1, 'Add at least one purchase order line.'),
  discount: chargeSchema.default({ mode: 'PERCENTAGE', value: 0 }),
  freight: chargeSchema.default({ mode: 'PERCENTAGE', value: 0 }),
  packing: chargeSchema.default({ mode: 'PERCENTAGE', value: 0 }),
  insurance: chargeSchema.default({ mode: 'PERCENTAGE', value: 0 }),
  /** When true the PO is issued (status OPEN) immediately after saving. */
  issue: z.boolean().default(false),
});

type PoBody = z.infer<typeof poSchema>;

/**
 * Writes PO lines and their source references, validating every indent draw under
 * a row lock. Shared by create and update so the rules cannot diverge.
 *
 * `receivedByLineId` is only non-empty when editing an ALREADY-ISSUED PO that
 * may have GRN history: `grn_lines.po_line_id` is `ON DELETE RESTRICT`, so an
 * existing line that has ANY posted receipt against it can never be deleted
 * and reinserted as a fresh row — it must be UPDATED in place (same id), and
 * its quantity can never drop below what has already been received. A line
 * whose `id` is present in `receivedByLineId` is matched to that existing
 * row; every other submitted line is a plain INSERT (new line). The caller
 * (PUT /:id) is responsible for first deleting whichever existing rows are
 * safe to remove (not resubmitted AND zero received) before calling this.
 */
async function writePoLines(
  tx: Parameters<typeof txQuery>[0],
  poId: number,
  lines: PoBody['lines'],
  receivedByLineId: Map<number, string> = new Map(),
): Promise<{ touchedIndents: Set<number>; totalAmount: string }> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const items = await txQuery<{
    id: number; item_code: string; item_description: string; uom_id: number | null;
    item_specification: string; is_active: boolean;
  }>(tx, 'SELECT * FROM items WHERE id = ANY($1) AND deleted_at IS NULL', [itemIds]);
  const itemMap = new Map(items.map((i) => [Number(i.id), i]));

  const missing = itemIds.filter((i) => !itemMap.has(i));
  if (missing.length > 0) {
    throw ValidationError('One or more selected items no longer exist.', [
      { field: 'lines', message: `Unknown item id(s): ${missing.join(', ')}.` },
    ]);
  }
  const inactive = items.filter((i) => !i.is_active).map((i) => i.item_code);
  if (inactive.length > 0) {
    throw BusinessRuleError(`These items are inactive and cannot be ordered: ${inactive.join(', ')}.`);
  }

  const touchedIndents = new Set<number>();
  let total = dec(0);

  for (const [i, line] of lines.entries()) {
    const item = itemMap.get(line.itemId)!;
    const poQty = toQty(line.poQty);

    // Traceability invariant: when a line declares sources, the quantities must
    // reconcile exactly — otherwise "where did this quantity come from?" has no
    // honest answer (SRS §11.3).
    if (line.sources.length > 0) {
      const sourceTotal = line.sources.reduce((acc, s) => acc.plus(dec(s.consumedQty)), dec(0));
      if (!sourceTotal.equals(dec(poQty))) {
        throw BusinessRuleError(
          `Line ${i + 1} (${item.item_code}): the quantities drawn from indents total ` +
          `${toQty(sourceTotal)} but the PO quantity is ${poQty}. They must match exactly ` +
          `so every ordered unit is traceable to its source.`,
          { lineNo: i + 1, itemCode: item.item_code, poQty, sourceTotal: toQty(sourceTotal) },
        );
      }
    }

    const existingReceived = line.id != null ? receivedByLineId.get(line.id) : undefined;
    const isUpdate = existingReceived != null;

    if (isUpdate && dec(poQty).lessThan(dec(existingReceived))) {
      throw BusinessRuleError(
        `Line ${i + 1} (${item.item_code}): quantity cannot be reduced to ${poQty} — ` +
        `${toQty(existingReceived)} has already been received against this line. ` +
        `Cancel the relevant GRN first if that receipt was a mistake.`,
        { lineNo: i + 1, itemCode: item.item_code, poQty, receivedQty: toQty(existingReceived) },
      );
    }

    const inserted = isUpdate
      ? await txQueryOne<{ id: number; amount: string }>(
          tx,
          `UPDATE purchase_order_lines
              SET line_no = $2, item_id = $3, item_code = $4, item_description = $5, po_qty = $6,
                  uom_id = $7, rate = $8, discount_pct = $9, gst_pct = $10, item_specification = $11,
                  delivery_date = $12, remarks = $13
            WHERE id = $14 AND po_id = $1
            RETURNING id, amount`,
          [
            poId, i + 1, item.id, item.item_code, item.item_description, poQty,
            line.uomId ?? item.uom_id, toRate(line.rate), toRate(line.discountPct),
            toNumeric(line.gstPct, 2),
            line.itemSpecification || item.item_specification,
            line.deliveryDate ?? null, line.remarks, line.id,
          ],
        )
      : await txQueryOne<{ id: number; amount: string }>(
          tx,
          `INSERT INTO purchase_order_lines
             (po_id, line_no, item_id, item_code, item_description, po_qty, uom_id,
              rate, discount_pct, gst_pct, item_specification, delivery_date, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id, amount`,
          [
            poId, i + 1, item.id, item.item_code, item.item_description, poQty,
            line.uomId ?? item.uom_id, toRate(line.rate), toRate(line.discountPct),
            toNumeric(line.gstPct, 2),
            line.itemSpecification || item.item_specification,
            line.deliveryDate ?? null, line.remarks,
          ],
        );
    if (!inserted) throw new Error(`Failed to ${isUpdate ? 'update' : 'insert'} purchase order line.`);
    total = total.plus(dec(inserted.amount));

    for (const source of line.sources) {
      // Lock the indent line, re-read its balance INSIDE the lock, then validate.
      const balance = await lockIndentLineBalance(tx, source.indentLineId);

      if (Number(balance.item_id) !== line.itemId) {
        throw BusinessRuleError(
          `Line ${i + 1}: indent ${balance.indent_no} line ${balance.line_no} is for ` +
          `${balance.item_code}, which does not match the ordered item ${item.item_code}.`,
        );
      }
      assertIndentDrawAllowed(balance, toQty(source.consumedQty));

      await tx.query(
        `INSERT INTO po_indent_sources (po_line_id, indent_line_id, indent_id, consumed_qty)
         VALUES ($1,$2,$3,$4)`,
        [inserted.id, source.indentLineId, balance.indent_id, toQty(source.consumedQty)],
      );
      touchedIndents.add(Number(balance.indent_id));
    }
  }

  return { touchedIndents, totalAmount: total.toFixed(2) };
}

/**
 * Issuing a purchase order is the approval step, whichever door it comes
 * through. `POST /:id/issue` has always required `po.approve`; saving with
 * "issue now" did not, so anyone who could create a PO could also issue it and
 * skip the approver entirely.
 */
function assertMayIssue(req: Parameters<typeof hasPermission>[0]): void {
  if (!hasPermission(req, 'po.approve')) {
    throw AuthorizationError(
      'You can save this purchase order as a draft, but issuing it needs the approval right (po.approve). ' +
      'Save it as a draft and ask a person who can issue purchase orders to issue it.',
    );
  }
}

router.post(
  '/',
  requirePermission('po.create'),
  validateBody(poSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as PoBody;
    const userId = req.user!.id;
    if (body.issue) assertMayIssue(req);
    const when = body.poDate ? new Date(`${body.poDate}T00:00:00`) : new Date();
    const hasSources = body.lines.some((l) => l.sources.length > 0);

    const id = await withTransaction(async (tx) => {
      const supplier = await txQueryOne<{
        id: number; supplier_name: string; payment_terms: string; currency_code: string;
        is_active: boolean;
      }>(tx, 'SELECT * FROM suppliers WHERE id = $1 AND deleted_at IS NULL', [body.supplierId]);
      if (!supplier) throw ValidationError('The selected supplier does not exist.', [{ field: 'supplierId', message: 'Not found.' }]);
      if (!supplier.is_active) throw BusinessRuleError(`${supplier.supplier_name} is inactive and cannot receive purchase orders.`);

      const poNo = await nextDocumentNumber(tx, 'PO', when);
      const status: PoStatus = body.issue ? 'OPEN' : 'DRAFT';

      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_order_headers
           (po_no, po_date, po_time, po_type_id, supplier_id, currency_code, payment_terms,
            delivery_date, delivery_address, remarks, source_mode, status,
            issued_at, issued_by, created_by, updated_by,
            discount_mode, discount_value, freight_mode, freight_value,
            packing_mode, packing_value, insurance_mode, insurance_value)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$15,$16,$17,$18,$19,$20,$21,$22,$23)
         RETURNING id`,
        [
          poNo, dateStamp(when), timeStamp(), body.poTypeId ?? null, body.supplierId,
          // Commercial terms default from the supplier master (auto-population, SRS §2).
          body.currencyCode || supplier.currency_code || 'INR',
          body.paymentTerms ?? supplier.payment_terms ?? '',
          body.deliveryDate ?? null, body.deliveryAddress, body.remarks,
          hasSources ? 'INDENT' : 'DIRECT', status,
          body.issue ? new Date().toISOString() : null, body.issue ? userId : null,
          userId,
          body.discount.mode, toNumeric(body.discount.value, 4),
          body.freight.mode, toNumeric(body.freight.value, 4),
          body.packing.mode, toNumeric(body.packing.value, 4),
          body.insurance.mode, toNumeric(body.insurance.value, 4),
        ],
      );
      if (!header) throw new Error('Failed to create purchase order header.');

      const { touchedIndents, totalAmount } = await writePoLines(tx, header.id, body.lines);

      // An indent that is now fully ordered stops appearing in the "awaiting PO" list.
      for (const indentId of touchedIndents) await recomputeIndentClosure(tx, indentId);

      await auditIn(tx, {
        actor: actorFrom(req), action: body.issue ? 'ISSUE' : 'CREATE',
        entity: 'purchase_order', entityId: header.id, entityLabel: poNo,
        after: {
          poNo, status, supplier: supplier.supplier_name, totalAmount,
          lineCount: body.lines.length, sourceMode: hasSources ? 'INDENT' : 'DIRECT',
          sourceIndentCount: touchedIndents.size,
        },
      });

      return header.id;
    });

    sendCreated(res, await queryOne('SELECT * FROM purchase_order_headers WHERE id = $1', [id]));
  }),
);

/* ── Update (drafts only) ───────────────────────────────────────────────────── */

router.put(
  '/:id',
  requirePermission('po.edit'),
  validateBody(poSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as PoBody;
    const userId = req.user!.id;

    const before = await queryOne<{ po_no: string; status: PoStatus }>(
      'SELECT po_no, status FROM purchase_order_headers WHERE id = $1', [id],
    );
    if (!before) throw NotFoundError('Purchase order');
    assertPoEditable(before.status, before.po_no);
    // "Issue now" only means something for a DRAFT. On an order that is already
    // issued it used to force the status back to OPEN — wiping PARTIALLY_RECEIVED
    // — so the flag is ignored there and the status is left exactly as it is.
    const issuing = body.issue && before.status === 'DRAFT';
    if (issuing) assertMayIssue(req);

    await withTransaction(async (tx) => {
      // Lock the header so no GRN can post against it mid-edit.
      await tx.query('SELECT id FROM purchase_order_headers WHERE id = $1 FOR UPDATE', [id]);

      const hasSources = body.lines.some((l) => l.sources.length > 0);

      // Release the old source claims first, then re-validate the new ones against
      // the freed balances. Both happen inside one transaction, so an indent line's
      // quantity is never double-counted and never transiently lost.
      const oldIndents = await txQuery<{ indent_id: number }>(
        tx,
        `SELECT DISTINCT pis.indent_id
           FROM po_indent_sources pis
           JOIN purchase_order_lines pol ON pol.id = pis.po_line_id
          WHERE pol.po_id = $1`,
        [id],
      );

      // A DRAFT PO has never been received against, so every existing line is
      // freely replaceable — the old blanket delete-and-reinsert stays exact.
      // An already-ISSUED PO may have GRN history: grn_lines.po_line_id is
      // ON DELETE RESTRICT, so a line with any posted receipt can never be
      // deleted — it must be updated in place (writePoLines handles that via
      // receivedByLineId), and it can never be removed from the line set or
      // reduced below what has already been received.
      const existingLines = await txQuery<{ id: number; item_code: string; received_qty: string }>(
        tx,
        `SELECT pol.id, pol.item_code,
                COALESCE((SELECT SUM(gl.grn_qty) FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id
                           WHERE gl.po_line_id = pol.id AND gh.status = 'POSTED'), 0) AS received_qty
           FROM purchase_order_lines pol
          WHERE pol.po_id = $1
          FOR UPDATE`,
        [id],
      );
      const receivedByLineId = new Map(existingLines.map((l) => [Number(l.id), l.received_qty]));
      const submittedIds = new Set(body.lines.map((l) => l.id).filter((v): v is number => v != null));

      for (const existing of existingLines) {
        const receivedQty = receivedByLineId.get(Number(existing.id))!;
        if (!submittedIds.has(Number(existing.id)) && dec(receivedQty).greaterThan(0)) {
          throw BusinessRuleError(
            `Line ${existing.item_code} already has ${toQty(receivedQty)} received against it and cannot ` +
            `be removed. Cancel the relevant GRN first if that receipt was a mistake.`,
            { itemCode: existing.item_code, receivedQty: toQty(receivedQty) },
          );
        }
      }

      // Every existing line's sources are re-derived fresh from the submitted
      // body below (po_indent_sources carries no FK from GRN, so this is
      // always safe regardless of receipts) — clear them all up front.
      await tx.query(
        'DELETE FROM po_indent_sources WHERE po_line_id IN (SELECT id FROM purchase_order_lines WHERE po_id = $1)',
        [id],
      );
      // The quantity this PO had claimed is free again from this point — but an
      // indent it had FULLY consumed is still marked CLOSED, and only an
      // APPROVED indent may be drawn from. Reopen those now (the same
      // recompute a cancelled PO uses), or the re-validation below refuses the
      // PO's own, unchanged, sources: every save of an issued indent-based PO
      // failed with "Indent … is not approved (currently CLOSED)". The loop at
      // the end closes them again if this PO still orders everything.
      for (const o of oldIndents) await recomputeIndentClosure(tx, Number(o.indent_id));
      // Only lines that are safe to remove (not resubmitted AND zero received)
      // are actually deleted — everything else is matched by id and UPDATEd
      // in writePoLines, preserving its identity for GRN traceability.
      const removableIds = existingLines
        .filter((l) => !submittedIds.has(Number(l.id)))
        .map((l) => Number(l.id));
      if (removableIds.length > 0) {
        await tx.query('DELETE FROM purchase_order_lines WHERE po_id = $1 AND id = ANY($2)', [id, removableIds]);
      }

      if (issuing) assertPoTransition(before.status, 'OPEN');
      const status: PoStatus = issuing ? 'OPEN' : before.status;

      // issued_at / issued_by are stamped only when THIS save issues the order
      // ($21). The issuer used to be written on every save, so merely editing a
      // draft recorded the editor as "issued by", and a later issue through this
      // route then kept that earlier name instead of the person who issued it.

      await tx.query(
        `UPDATE purchase_order_headers
            SET po_type_id = $2, supplier_id = $3, currency_code = COALESCE($4, currency_code),
                payment_terms = COALESCE($5, payment_terms), delivery_date = $6,
                delivery_address = $7, remarks = $8, source_mode = $9, status = $10,
                issued_at = CASE WHEN $21::boolean THEN $11::timestamptz ELSE issued_at END,
                issued_by = CASE WHEN $21::boolean THEN $12::bigint ELSE issued_by END,
                updated_at = now(), updated_by = $12,
                discount_mode = $13, discount_value = $14, freight_mode = $15, freight_value = $16,
                packing_mode = $17, packing_value = $18, insurance_mode = $19, insurance_value = $20
          WHERE id = $1`,
        [
          id, body.poTypeId ?? null, body.supplierId, body.currencyCode || null,
          body.paymentTerms || null, body.deliveryDate ?? null, body.deliveryAddress,
          body.remarks, hasSources ? 'INDENT' : 'DIRECT', status,
          issuing ? new Date().toISOString() : null, userId,
          body.discount.mode, toNumeric(body.discount.value, 4),
          body.freight.mode, toNumeric(body.freight.value, 4),
          body.packing.mode, toNumeric(body.packing.value, 4),
          body.insurance.mode, toNumeric(body.insurance.value, 4),
          issuing,
        ],
      );

      const { touchedIndents } = await writePoLines(tx, id, body.lines, receivedByLineId);

      for (const indentId of new Set([...oldIndents.map((o) => Number(o.indent_id)), ...touchedIndents])) {
        await recomputeIndentClosure(tx, indentId);
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: issuing ? 'ISSUE' : 'UPDATE',
        entity: 'purchase_order', entityId: id, entityLabel: before.po_no,
        before, after: { status, lineCount: body.lines.length },
      });
    });

    sendOk(res, await queryOne('SELECT * FROM purchase_order_headers WHERE id = $1', [id]));
  }),
);

/* ── Workflow: issue / cancel / short-close / reopen ────────────────────────── */

const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });

router.post(
  '/:id/issue',
  requirePermission('po.approve'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const result = await withTransaction(async (tx) => {
      const po = await txQueryOne<{ po_no: string; status: PoStatus }>(
        tx, 'SELECT po_no, status FROM purchase_order_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!po) throw NotFoundError('Purchase order');
      // Issue is the DRAFT -> OPEN step and nothing else. The transition table
      // also allows "back to OPEN" from PARTIALLY_RECEIVED / COMPLETED /
      // SHORT_CLOSED, but those exist for the SYSTEM (a cancelled GRN lowering
      // the received balance) — letting this button take them reset a received or
      // short-closed order to OPEN and replaced who had issued it and when.
      if (po.status !== 'DRAFT') {
        throw BusinessRuleError(
          po.status === 'CANCELLED'
            ? `Purchase order ${po.po_no} has been cancelled and cannot be issued.`
            : `Purchase order ${po.po_no} has already been issued (it is ${statusLabel(po.status).toLowerCase()}).`,
          { status: po.status },
        );
      }
      assertPoTransition(po.status, 'OPEN');

      const lines = await txQueryOne<{ n: string }>(
        tx, 'SELECT COUNT(*) AS n FROM purchase_order_lines WHERE po_id = $1', [id],
      );
      if (Number(lines?.n ?? 0) === 0) {
        throw BusinessRuleError('Add at least one line before issuing this purchase order.');
      }

      await tx.query(
        `UPDATE purchase_order_headers
            SET status = 'OPEN', issued_at = now(), issued_by = $2, updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [id, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'ISSUE', entity: 'purchase_order', entityId: id,
        entityLabel: po.po_no, before: { status: po.status }, after: { status: 'OPEN' },
      });
      return po.po_no;
    });

    sendOk(res, { message: `Purchase order ${result} has been issued and is now open for receipt.` });
  }),
);

router.post(
  '/:id/cancel',
  requirePermission('po.approve'),
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as z.infer<typeof reasonSchema>;
    if (!reason?.trim()) {
      throw ValidationError('A reason is required to cancel a purchase order.', [
        { field: 'reason', message: 'Please state why this PO is being cancelled.' },
      ]);
    }

    const result = await withTransaction(async (tx) => {
      const po = await txQueryOne<{ po_no: string; status: PoStatus }>(
        tx, 'SELECT po_no, status FROM purchase_order_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!po) throw NotFoundError('Purchase order');
      assertNotAlready('Purchase order', po.po_no, po.status, 'CANCELLED');
      assertPoTransition(po.status, 'CANCELLED');

      // Goods already received cannot be un-received by cancelling the order.
      const received = await txQueryOne<{ total_received_qty: string }>(
        tx, 'SELECT total_received_qty FROM v_po_header_balance WHERE po_id = $1', [id],
      );
      if (dec(received?.total_received_qty ?? 0).greaterThan(0)) {
        throw BusinessRuleError(
          `Purchase order ${po.po_no} already has goods receipted against it and cannot be cancelled. ` +
          `Short-close it instead to release the outstanding quantity.`,
        );
      }

      const indents = await txQuery<{ indent_id: number }>(
        tx,
        `SELECT DISTINCT pis.indent_id FROM po_indent_sources pis
           JOIN purchase_order_lines pol ON pol.id = pis.po_line_id WHERE pol.po_id = $1`,
        [id],
      );

      await tx.query(
        `UPDATE purchase_order_headers
            SET status = 'CANCELLED', closed_at = now(), closed_by = $2, close_reason = $3,
                updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [id, req.user!.id, reason],
      );

      // Cancelling releases the indent quantities it had claimed — the balance view
      // excludes cancelled POs, so this simply reopens any indent that had closed.
      for (const row of indents) await recomputeIndentClosure(tx, Number(row.indent_id));

      await auditIn(tx, {
        actor: actorFrom(req), action: 'CANCEL', entity: 'purchase_order', entityId: id,
        entityLabel: po.po_no, before: { status: po.status }, after: { status: 'CANCELLED' },
        message: reason,
      });
      return po.po_no;
    });

    sendOk(res, {
      message: `Purchase order ${result} has been cancelled. Any indent quantities it reserved are available again.`,
    });
  }),
);

router.post(
  '/:id/short-close',
  requirePermission('po.approve'),
  validateBody(reasonSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as z.infer<typeof reasonSchema>;
    if (!reason?.trim()) {
      throw ValidationError('A reason is required to short-close a purchase order.', [
        { field: 'reason', message: 'Please state why the balance will not be received.' },
      ]);
    }

    const result = await withTransaction(async (tx) => {
      const po = await txQueryOne<{ po_no: string; status: PoStatus }>(
        tx, 'SELECT po_no, status FROM purchase_order_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!po) throw NotFoundError('Purchase order');
      assertNotAlready('Purchase order', po.po_no, po.status, 'SHORT_CLOSED');
      assertPoTransition(po.status, 'SHORT_CLOSED');

      await tx.query(
        `UPDATE purchase_order_headers
            SET status = 'SHORT_CLOSED', closed_at = now(), closed_by = $2, close_reason = $3,
                updated_at = now(), updated_by = $2
          WHERE id = $1`,
        [id, req.user!.id, reason],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CLOSE', entity: 'purchase_order', entityId: id,
        entityLabel: po.po_no, before: { status: po.status }, after: { status: 'SHORT_CLOSED' },
        message: reason,
      });
      return po.po_no;
    });

    sendOk(res, {
      message: `Purchase order ${result} has been short-closed. Its outstanding quantity no longer appears as pending.`,
    });
  }),
);

/* ── DELETE (drafts only) ───────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('po.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const po = await queryOne<{ po_no: string; status: PoStatus }>(
      'SELECT po_no, status FROM purchase_order_headers WHERE id = $1', [id],
    );
    if (!po) throw NotFoundError('Purchase order');
    if (po.status !== 'DRAFT') {
      throw BusinessRuleError(
        `Only draft purchase orders can be deleted. PO ${po.po_no} is ${po.status.replace(/_/g, ' ').toLowerCase()} — cancel or short-close it instead so the audit trail is preserved.`,
      );
    }

    await withTransaction(async (tx) => {
      const indents = await txQuery<{ indent_id: number }>(
        tx,
        `SELECT DISTINCT pis.indent_id FROM po_indent_sources pis
           JOIN purchase_order_lines pol ON pol.id = pis.po_line_id WHERE pol.po_id = $1`,
        [id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'purchase_order', entityId: id,
        entityLabel: po.po_no, before: po,
      });
      await tx.query('DELETE FROM purchase_order_headers WHERE id = $1', [id]);
      for (const row of indents) await recomputeIndentClosure(tx, Number(row.indent_id));
    });

    sendOk(res, { deleted: true, message: `Draft purchase order ${po.po_no} has been deleted.` });
  }),
);

/* ── Helper: preview the amount maths before saving ─────────────────────────── */
/* The frontend shows live totals; this endpoint guarantees the preview uses the
   SAME formula the database will apply (ADR-004), so the number never changes on
   save. */

router.post(
  '/calculate',
  requirePermission('po.view'),
  validateBody(z.object({
    lines: z.array(z.object({
      poQty: z.union([z.number(), z.string()]),
      rate: z.union([z.number(), z.string()]),
      discountPct: z.union([z.number(), z.string()]).default(0),
    })),
  })),
  asyncHandler(async (req, res) => {
    const { lines } = req.body as { lines: { poQty: string; rate: string; discountPct: string }[] };
    let total = dec(0);
    let gross = dec(0);
    const computed = lines.map((l) => {
      const amount = lineAmount(l.poQty, l.rate, l.discountPct);
      const grossAmount = dec(l.poQty).times(dec(l.rate));
      total = total.plus(dec(amount));
      gross = gross.plus(grossAmount);
      return {
        finalRate: toRate(dec(l.rate).times(dec(1).minus(dec(l.discountPct).div(100)))),
        amount,
      };
    });
    sendOk(res, {
      lines: computed,
      grossAmount: gross.toFixed(2),
      totalAmount: total.toFixed(2),
      discountAmount: gross.minus(total).toFixed(2),
    });
  }),
);

export default router;
