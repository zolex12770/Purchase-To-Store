/**
 * Item Master (SRS §7.1).
 *
 * `GET /items/:id/profile` is the auto-population endpoint required by SRS §10 and
 * §29: choosing an Item Code on an indent or PO line returns description, type,
 * department, cost centre, groups, HSN, UOM and specification in a single call, so
 * the user never retypes information the master already holds.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvIdArray,
} from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { toRate } from '../../domain/money.js';

const router = Router();

/** Shared projection: an item plus every resolved master label. */
const ITEM_SELECT = `
  SELECT i.id, i.item_code, i.item_description, i.item_description AS item_name, i.hsn_code, i.item_specification,
         '' AS rack_id,
         i.standard_rate, i.reorder_level, i.min_stock, i.max_stock, i.reorder_qty, i.gst_rate,
         i.live_stock_qty, i.qc_required,
         COALESCE((SELECT SUM(pending_grn_qty) FROM v_po_line_balance plb WHERE plb.item_id = i.id AND plb.is_receivable), 0) AS pending_grn_qty,
         i.is_active, i.created_at, i.updated_at,
         i.item_type_id,      it.name  AS item_type_name,
         i.department_id,     d.name   AS department_name,
         i.cost_centre_id,    cc.name  AS cost_centre_name,
         i.main_group_id,     mg.name  AS main_group_name,
         i.sub_main_group_id, smg.name AS sub_main_group_name,
         i.indent_type_id,    ind.name AS indent_type_name,
         i.uom_id,            u.name   AS uom_name, u.code AS uom_code
    FROM items i
    LEFT JOIN lookups it  ON it.id  = i.item_type_id
    LEFT JOIN lookups d   ON d.id   = i.department_id
    LEFT JOIN lookups cc  ON cc.id  = i.cost_centre_id
    LEFT JOIN lookups mg  ON mg.id  = i.main_group_id
    LEFT JOIN lookups smg ON smg.id = i.sub_main_group_id
    LEFT JOIN lookups ind ON ind.id = i.indent_type_id
    LEFT JOIN lookups u   ON u.id   = i.uom_id`;

const SORTABLE: Record<string, string> = {
  itemCode: 'i.item_code',
  itemDescription: 'i.item_description',
  standardRate: 'i.standard_rate',
  createdAt: 'i.created_at',
  updatedAt: 'i.updated_at',
  mainGroup: 'mg.name',
};

const listSchema = listQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  qcRequired: z.enum(['true', 'false']).optional(),
  itemTypeId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  mainGroupId: csvIdArray,
  subMainGroupId: csvIdArray,
  uomId: csvIdArray,
  hodId: csvIdArray,
});

/* ── GET /items ─────────────────────────────────────────────────────────────── */

router.get(
  '/',
  requirePermission('item.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);

    const b = new SqlBuilder();
    b.addRaw('i.deleted_at IS NULL');
    if (q.isActive) b.addRaw(`i.is_active = ${q.isActive === 'true' ? 'TRUE' : 'FALSE'}`);
    if (q.qcRequired) b.addRaw(`i.qc_required = ${q.qcRequired === 'true' ? 'TRUE' : 'FALSE'}`);
    b.addIn('i.item_type_id', q.itemTypeId);
    b.addIn('i.department_id', q.departmentId);
    b.addIn('i.cost_centre_id', q.costCentreId);
    b.addIn('i.main_group_id', q.mainGroupId);
    b.addIn('i.sub_main_group_id', q.subMainGroupId);
    b.addIn('i.uom_id', q.uomId);
    if (q.hodId && q.hodId.length > 0) {
      const p = b.push(q.hodId);
      b.addRaw(`EXISTS (SELECT 1 FROM lookups d WHERE d.id = i.department_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
    }
    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p} ` +
        `OR lower(i.hsn_code) LIKE ${p} OR lower(i.item_specification) LIKE ${p})`,
      );
    }

    // Counting needs no lookup joins: every filter above targets `items` itself,
    // and the joins only supply display labels for the page query.
    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM items i ${b.where()}`,
      b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const counts = await queryOne<{ active_count: string; inactive_count: string; qc_count: string }>(
      `SELECT COUNT(CASE WHEN i.is_active = TRUE THEN 1 END) AS active_count,
              COUNT(CASE WHEN i.is_active = FALSE THEN 1 END) AS inactive_count,
              COUNT(CASE WHEN i.qc_required = TRUE THEN 1 END) AS qc_count
         FROM items i ${b.where()}`,
      b.params,
    );

    const order = resolveSort(q, SORTABLE, 'itemCode');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `${ITEM_SELECT} ${b.where()} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize, {
      totals: {
        totalItems: total,
        activeItems: Number(counts?.active_count ?? 0),
        inactiveItems: Number(counts?.inactive_count ?? 0),
        qcRequiredItems: Number(counts?.qc_count ?? 0),
      },
    });
  }),
);

/* ── GET /items/search — typeahead for indent/PO line entry ─────────────────── */

router.get(
  '/search',
  requirePermission('item.view'),
  validateQuery(z.object({
    q: z.string().trim().max(120).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })),
  asyncHandler(async (_req, res) => {
    const { q, limit } = parsedQuery<{ q?: string; limit: number }>(res);
    const term = `%${(q ?? '').toLowerCase()}%`;
    const rows = await query(
      `SELECT i.id, i.item_code, i.item_description, i.item_specification, i.standard_rate,
              i.uom_id, u.code AS uom_code, u.name AS uom_name, i.hsn_code,
              COALESCE(i.live_stock_qty, 0)::numeric(18, 4) AS live_stock_qty,
              i.department_id, i.cost_centre_id, i.min_stock, i.max_stock
         FROM items i
         LEFT JOIN lookups u ON u.id = i.uom_id
        WHERE i.deleted_at IS NULL AND i.is_active = TRUE
          AND ($1 = '%%' OR lower(i.item_code) LIKE $1 OR lower(i.item_description) LIKE $1)
        ORDER BY i.item_code
        LIMIT $2`,
      [term, limit],
    );
    sendOk(res, rows);
  }),
);

/* ── GET /items/analysis/stock-reconciliation ─────────────────────────────────
   Opening + GRN Inward − Requisition Outward = Current Stock, computed purely
   from the SAME authoritative stock_ledger every inward/outward movement
   already posts to (GRN reconstruction Part 6/9; domain/stock.ts). There is
   no second, independently-maintained balance here — a mismatch means the
   ledger and items.live_stock_qty have drifted, and it is surfaced, never
   silently corrected. */

const reconciliationSchema = listQuerySchema.extend({
  mismatchOnly: z.enum(['true', 'false']).default('false'),
});

router.get(
  '/analysis/stock-reconciliation',
  requireAnyPermission('item.view', 'dashboard.analyze'),
  validateQuery(reconciliationSchema),
  asyncHandler(async (req, res) => {
    const q = parsedQuery<z.infer<typeof reconciliationSchema>>(res);
    const b = new SqlBuilder();
    b.addRaw('i.deleted_at IS NULL');
    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p})`);
    }

    // The computed balance is EVERY ledger entry's inward minus outward — direct
    // issues, physical-count adjustments, inventory-screen movements and Google
    // Sheet alignments (SHEET_SYNC) included. Counting only the GRN/requisition
    // types flagged every item that had any other entry as a false mismatch.
    const rows = await query<Record<string, string>>(
      `SELECT i.id, i.item_code, i.item_description, u.code AS uom_code, i.live_stock_qty,
              COALESCE(l.grn_inward, 0)              AS grn_inward,
              COALESCE(l.grn_reversal, 0)             AS grn_reversal,
              COALESCE(l.requisition_issue, 0)        AS requisition_issue,
              COALESCE(l.requisition_reversal, 0)     AS requisition_reversal,
              COALESCE(l.direct_issue_net, 0)         AS direct_issue_net,
              COALESCE(l.adjustment_net, 0)           AS adjustment_net,
              COALESCE(l.inventory_net, 0)            AS inventory_net,
              COALESCE(l.sheet_sync_net, 0)           AS sheet_sync_net,
              COALESCE(l.balance, 0)                  AS computed_balance
         FROM items i
         LEFT JOIN lookups u ON u.id = i.uom_id
         LEFT JOIN (
           SELECT item_id,
                  SUM(inward_qty)  FILTER (WHERE txn_type = 'GRN_INWARD')          AS grn_inward,
                  SUM(outward_qty) FILTER (WHERE txn_type = 'GRN_REVERSAL')        AS grn_reversal,
                  SUM(outward_qty) FILTER (WHERE txn_type = 'REQUISITION_ISSUE')   AS requisition_issue,
                  SUM(inward_qty)  FILTER (WHERE txn_type = 'REQUISITION_REVERSAL') AS requisition_reversal,
                  SUM(inward_qty - outward_qty) FILTER (WHERE txn_type IN ('DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL')) AS direct_issue_net,
                  SUM(inward_qty - outward_qty) FILTER (WHERE txn_type = 'STOCK_ADJUSTMENT') AS adjustment_net,
                  SUM(inward_qty - outward_qty) FILTER (WHERE txn_type IN ('INVENTORY_IN', 'INVENTORY_OUT', 'INVENTORY_ADJUST')) AS inventory_net,
                  SUM(inward_qty - outward_qty) FILTER (WHERE txn_type = 'SHEET_SYNC') AS sheet_sync_net,
                  SUM(inward_qty - outward_qty) AS balance
             FROM stock_ledger
            GROUP BY item_id
         ) l ON l.item_id = i.id
         ${b.where()}
        ORDER BY i.item_code
        LIMIT 5000`,
      b.params,
    );

    const data = rows
      .map((r) => {
        const computed = Number(r.computed_balance);
        const current = Number(r.live_stock_qty);
        return {
          id: Number(r.id), item_code: r.item_code, item_description: r.item_description, uom_code: r.uom_code,
          grn_inward: r.grn_inward, grn_reversal: r.grn_reversal,
          requisition_issue: r.requisition_issue, requisition_reversal: r.requisition_reversal,
          direct_issue_net: r.direct_issue_net, adjustment_net: r.adjustment_net,
          inventory_net: r.inventory_net, sheet_sync_net: r.sheet_sync_net,
          computed_balance: r.computed_balance, current_stock: r.live_stock_qty,
          mismatch: Math.abs(computed - current) > 0.0001,
        };
      })
      .filter((r) => q.mismatchOnly !== 'true' || r.mismatch);

    const order = resolveSort(q, { itemCode: 'item_code' }, 'itemCode');
    const dir = order.endsWith('DESC') ? -1 : 1;
    data.sort((a, b2) => dir * a.item_code.localeCompare(b2.item_code));

    const total = data.length;
    const offset = offsetOf(q);
    const page = data.slice(offset, offset + q.pageSize);

    sendPage(res, page, total, q.page, q.pageSize, {
      mismatchCount: data.filter((r) => r.mismatch).length,
    });
  }),
);

/* ── GET /items/:id/profile — AUTO-POPULATION (SRS §10, §29) ────────────────── */

router.get(
  '/:id/profile',
  requirePermission('item.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const item = await queryOne<Record<string, unknown>>(`${ITEM_SELECT} WHERE i.id = $1 AND i.deleted_at IS NULL`, [id]);
    if (!item) throw NotFoundError('Item');

    // "Live quantity" and "pending GRN quantity" the indent screen shows for an item
    // (SRS §10) — derived from the authoritative balance views, never stored.
    const [live] = await query<Record<string, unknown>>(
      `SELECT
         COALESCE((SELECT SUM(pending_qty) FROM v_indent_line_balance
                    WHERE item_id = $1 AND is_eligible_for_po), 0)          AS open_indent_qty,
         COALESCE((SELECT SUM(pending_grn_qty) FROM v_po_line_balance
                    WHERE item_id = $1 AND is_receivable), 0)               AS pending_grn_qty,
         COALESCE((SELECT SUM(received_qty) FROM v_po_line_balance
                    WHERE item_id = $1), 0)                                 AS total_received_qty,
         (SELECT final_rate FROM v_po_line_balance
           WHERE item_id = $1 AND po_status <> 'CANCELLED'
           ORDER BY po_date DESC, po_line_id DESC LIMIT 1)                  AS last_purchase_rate,
         (SELECT po_date FROM v_po_line_balance
           WHERE item_id = $1 AND po_status <> 'CANCELLED'
           ORDER BY po_date DESC, po_line_id DESC LIMIT 1)                  AS last_purchase_date`,
      [id],
    );

    sendOk(res, {
      id: item.id,
      itemCode: item.item_code,
      itemDescription: item.item_description,
      itemTypeId: item.item_type_id,
      itemTypeName: item.item_type_name,
      departmentId: item.department_id,
      departmentName: item.department_name,
      costCentreId: item.cost_centre_id,
      costCentreName: item.cost_centre_name,
      mainGroupId: item.main_group_id,
      mainGroupName: item.main_group_name,
      subMainGroupId: item.sub_main_group_id,
      subMainGroupName: item.sub_main_group_name,
      indentTypeId: item.indent_type_id,
      indentTypeName: item.indent_type_name,
      uomId: item.uom_id,
      uomCode: item.uom_code,
      uomName: item.uom_name,
      hsnCode: item.hsn_code,
      itemSpecification: item.item_specification,
      standardRate: item.standard_rate,
      reorderLevel: item.reorder_level,
      minStock: item.min_stock,
      maxStock: item.max_stock,
      reorderQty: item.reorder_qty,
      gstRate: item.gst_rate,
      isActive: item.is_active,
      qcRequired: Boolean(item.qc_required),
      live: {
        openIndentQty: live?.open_indent_qty ?? '0',
        pendingGrnQty: live?.pending_grn_qty ?? '0',
        totalReceivedQty: live?.total_received_qty ?? '0',
        // The genuine on-hand stock balance — moved ONLY by posted GRN
        // inward/reversal through stock_ledger (GRN reconstruction Part 6/9),
        // unlike the three figures above, which are always re-derived from
        // the balance views rather than stored.
        liveStockQty: item.live_stock_qty ?? '0',
        lastPurchaseRate: live?.last_purchase_rate ?? null,
        lastPurchaseDate: live?.last_purchase_date ?? null,
      },
    });
  }),
);

/* ── GET /items/:id — full record with purchase history ─────────────────────── */

const itemDetailQuerySchema = z.object({
  // Backs the Item History modal's "Latest 5/10/20/50/All" selector (Point 3)
  // — every history section below shares one limit rather than each needing
  // its own control. "All" is passed as 500: genuinely unbounded would let one
  // very old, very active item load thousands of rows into a modal.
  historyLimit: z.coerce.number().int().min(1).max(500).default(10),
});

router.get(
  '/:id',
  requirePermission('item.view'),
  validateQuery(itemDetailQuerySchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { historyLimit } = parsedQuery<z.infer<typeof itemDetailQuerySchema>>(res);
    const item = await queryOne(`${ITEM_SELECT} WHERE i.id = $1 AND i.deleted_at IS NULL`, [id]);
    if (!item) throw NotFoundError('Item');

    const [summary] = await query(
      `SELECT COUNT(DISTINCT po_id)::int        AS po_count,
              COALESCE(SUM(po_qty), 0)          AS total_ordered_qty,
              COALESCE(SUM(received_qty), 0)    AS total_received_qty,
              COALESCE(SUM(pending_grn_qty), 0) AS pending_qty,
              COALESCE(SUM(amount), 0)          AS total_value,
              COALESCE(AVG(final_rate), 0)      AS avg_rate,
              MIN(final_rate)                   AS min_rate,
              MAX(final_rate)                   AS max_rate
         FROM v_po_line_balance
        WHERE item_id = $1 AND po_status <> 'CANCELLED'`,
      [id],
    );

    // Rate history drives the item's price-trend chart and rate-variance analysis,
    // and is also the PO side of the Item History modal (Indent -> PO -> GRN).
    const rateHistory = await query(
      `SELECT b.po_date, b.po_no, b.po_id, b.final_rate, b.rate, b.discount_pct, b.po_qty,
              b.received_qty, b.pending_grn_qty, b.po_status,
              s.supplier_name, b.supplier_id
         FROM v_po_line_balance b
         JOIN suppliers s ON s.id = b.supplier_id
        WHERE b.item_id = $1 AND b.po_status <> 'CANCELLED'
        ORDER BY b.po_date DESC, b.po_line_id DESC
        LIMIT $2`,
      [id, historyLimit],
    );

    const suppliers = await query(
      `SELECT b.supplier_id, s.supplier_name,
              COUNT(DISTINCT b.po_id)::int AS po_count,
              SUM(b.po_qty)  AS total_qty,
              SUM(b.amount)  AS total_value,
              AVG(b.final_rate) AS avg_rate
         FROM v_po_line_balance b
         JOIN suppliers s ON s.id = b.supplier_id
        WHERE b.item_id = $1 AND b.po_status <> 'CANCELLED'
        GROUP BY b.supplier_id, s.supplier_name
        ORDER BY SUM(b.amount) DESC`,
      [id],
    );

    // The indent side of Indent -> PO -> GRN: every indent line this item is
    // still (or was ever) requested on, not only the currently-eligible ones —
    // the History modal must be able to show "this indent's 10 became one PO
    // line of 6" even after the indent line is no longer selectable for a PO.
    const indentHistory = await query(
      `SELECT v.indent_line_id, v.indent_id, v.indent_no, v.indent_date,
              v.indent_qty, v.ordered_qty, v.pending_qty, v.is_eligible_for_po,
              v.indent_status
         FROM v_indent_line_balance v
        WHERE v.item_id = $1
        ORDER BY v.indent_date DESC, v.indent_line_id DESC
        LIMIT $2`,
      [id, historyLimit],
    );
    const openIndents = indentHistory.filter((l) => (l as { is_eligible_for_po: boolean }).is_eligible_for_po);

    // Full material lifecycle for this item: Indent -> PO -> GRN -> Stock ->
    // Requisition -> Issue, and the complete stock ledger reconciling it, so
    // the drill-down never needs a second, invented traceability model — it
    // is built entirely from the tables/views the operational screens already
    // read from (Item Master, Requisition, GRN reconstruction Part 6/9).
    //
    // GRN is deliberately NOT read from `grn_headers.po_id` — a GRN can carry
    // lines from several POs, so attributing this item's receipts to "the"
    // header PO would misattribute quantity whenever that happens. The
    // authoritative link is line-level: grn_lines.po_line_id -> the exact PO
    // line this receipt actually reduced (GRN reconstruction Part 6/9).
    const grnHistory = await query(
      `SELECT gl.id AS grn_line_id, gh.id AS grn_id, gh.grn_no, gh.grn_date, gh.status AS grn_status,
              gl.grn_qty, gl.po_line_id, pol.po_id, poh.po_no, poh.supplier_id, s.supplier_name
         FROM grn_lines gl
         JOIN grn_headers gh ON gh.id = gl.grn_id
         JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
         JOIN purchase_order_headers poh ON poh.id = pol.po_id
         JOIN suppliers s ON s.id = poh.supplier_id
        WHERE gl.item_id = $1 AND gh.status <> 'CANCELLED'
        ORDER BY gh.grn_date DESC, gl.id DESC
        LIMIT $2`,
      [id, historyLimit],
    );

    let requisitions: unknown[] = [];
    let issueHistory: unknown[] = [];
    if (req.user!.permissions.has('requisition.view')) {
      requisitions = await query(
        `SELECT v.requisition_line_id, v.requisition_id, v.requisition_no, v.requisition_date,
                v.requested_qty, v.issued_qty, v.pending_qty, v.line_status,
                rh.employee_name, rh.department_name, rh.hod_name, hb.hod_status, hb.store_status
           FROM v_requisition_line_balance v
           JOIN requisition_headers rh ON rh.id = v.requisition_id
           JOIN v_requisition_header_balance hb ON hb.requisition_id = rh.id
          WHERE v.item_id = $1 AND v.requisition_status <> 'CANCELLED'
          ORDER BY v.requisition_date DESC
          LIMIT $2`,
        [id, historyLimit],
      );
      issueHistory = await query(
        `SELECT ril.id, ri.issue_slip_no, ri.issue_date, ri.requisition_id, rh.requisition_no,
                ril.issue_qty, ril.previously_issued_qty, su.employee_name AS store_user_name
           FROM requisition_issue_lines ril
           JOIN requisition_issues ri ON ri.id = ril.requisition_issue_id
           JOIN requisition_headers rh ON rh.id = ri.requisition_id
           LEFT JOIN users su ON su.id = ri.store_user_id
          WHERE ril.item_id = $1
          ORDER BY ri.issue_date DESC, ril.id DESC
          LIMIT $2`,
        [id, historyLimit],
      );
    }

    const stockLedger = await query(
      `SELECT l.id, l.txn_type, l.reference_type, l.reference_no, l.inward_qty, l.outward_qty,
              l.balance_qty, l.txn_date, l.mln_no, u.employee_name AS created_by_name
         FROM stock_ledger l
         LEFT JOIN users u ON u.id = l.created_by
        WHERE l.item_id = $1
        ORDER BY l.txn_date DESC, l.id DESC
        LIMIT $2`,
      [id, historyLimit],
    );

    sendOk(res, {
      ...item, summary, rateHistory, suppliers, openIndents, indentHistory, grnHistory,
      requisitions, issueHistory, stockLedger, historyLimit,
    });
  }),
);

/* ── Create / update ────────────────────────────────────────────────────────── */

const itemSchema = z.object({
  itemCode: z.string().trim().min(1, 'Item code is required.').max(60),
  itemDescription: z.string().trim().min(1, 'Item description is required.').max(300),
  itemTypeId: z.coerce.number().int().positive().nullable().optional(),
  departmentId: z.coerce.number().int().positive().nullable().optional(),
  costCentreId: z.coerce.number().int().positive().nullable().optional(),
  mainGroupId: z.coerce.number().int().positive().nullable().optional(),
  subMainGroupId: z.coerce.number().int().positive().nullable().optional(),
  indentTypeId: z.coerce.number().int().positive().nullable().optional(),
  uomId: z.coerce.number().int().positive().nullable().optional(),
  hsnCode: z.string().trim().max(20).default('')
    .refine((v) => v === '' || /^[0-9]{4,8}$/.test(v), 'HSN code must be 4 to 8 digits.'),
  itemSpecification: z.string().trim().max(1000).default(''),
  standardRate: z.union([z.number(), z.string()]).nullable().optional(),
  reorderLevel: z.union([z.number(), z.string()]).nullable().optional(),
  minStock: z.union([z.number(), z.string()]).nullable().optional(),
  maxStock: z.union([z.number(), z.string()]).nullable().optional(),
  reorderQty: z.union([z.number(), z.string()]).nullable().optional(),
  gstRate: z.union([z.number(), z.string()]).nullable().optional(),
  isActive: z.boolean().default(true),
  qcRequired: z.boolean().default(false),
}).refine((data) => {
  if (data.minStock != null && data.minStock !== '' && data.maxStock != null && data.maxStock !== '') {
    return Number(data.minStock) <= Number(data.maxStock);
  }
  return true;
}, {
  message: 'Minimum stock cannot exceed maximum stock.',
  path: ['minStock'],
});

type ItemBody = z.infer<typeof itemSchema>;

const numOrNull = (v: number | string | null | undefined) =>
  v === null || v === undefined || v === '' ? null : toRate(v);

const itemParams = (b: ItemBody, userId: number) => [
  b.itemCode, b.itemDescription, b.itemTypeId ?? null, b.departmentId ?? null,
  b.costCentreId ?? null, b.mainGroupId ?? null, b.subMainGroupId ?? null,
  b.indentTypeId ?? null, b.uomId ?? null, b.hsnCode, b.itemSpecification,
  numOrNull(b.standardRate), numOrNull(b.reorderLevel),
  numOrNull(b.minStock), numOrNull(b.maxStock), numOrNull(b.reorderQty), numOrNull(b.gstRate),
  b.isActive, b.qcRequired ?? false, userId,
];

router.post(
  '/',
  requirePermission('item.create'),
  validateBody(itemSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as ItemBody;

    const created = await withTransaction(async (tx) => {
      const row = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO items
           (item_code, item_description, item_type_id, department_id, cost_centre_id,
            main_group_id, sub_main_group_id, indent_type_id, uom_id, hsn_code,
            item_specification, standard_rate, reorder_level, min_stock, max_stock,
            reorder_qty, gst_rate, is_active, qc_required, created_by, updated_by, source_date, source_time)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$20,
                 CURRENT_DATE, to_char(now(),'HH24:MI:SS'))
         RETURNING id`,
        itemParams(body, req.user!.id),
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CREATE', entity: 'item', entityId: row?.id,
        entityLabel: `${body.itemCode} — ${body.itemDescription}`, after: body,
      });
      return row;
    });

    sendCreated(res, await queryOne(`${ITEM_SELECT} WHERE i.id = $1`, [created?.id]));
  }),
);

router.put(
  '/:id',
  requirePermission('item.edit'),
  validateBody(itemSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as ItemBody;

    const before = await queryOne('SELECT * FROM items WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before) throw NotFoundError('Item');

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE items
            SET item_code = $1, item_description = $2, item_type_id = $3, department_id = $4,
                cost_centre_id = $5, main_group_id = $6, sub_main_group_id = $7,
                indent_type_id = $8, uom_id = $9, hsn_code = $10, item_specification = $11,
                standard_rate = $12, reorder_level = $13, min_stock = $14, max_stock = $15,
                reorder_qty = $16, gst_rate = $17, is_active = $18, qc_required = $19,
                updated_by = $20, updated_at = now()
          WHERE id = $21`,
        [...itemParams(body, req.user!.id), id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'item', entityId: id,
        entityLabel: `${body.itemCode} — ${body.itemDescription}`, before, after: body,
      });
    });

    sendOk(res, await queryOne(`${ITEM_SELECT} WHERE i.id = $1`, [id]));
  }),
);

/* ── PATCH /items/:id/planning — update planning thresholds ─────────────────── */

const planningSchema = z.object({
  minStock: z.union([z.number(), z.string()]).nullable().optional(),
  maxStock: z.union([z.number(), z.string()]).nullable().optional(),
  reorderLevel: z.union([z.number(), z.string()]).nullable().optional(),
  reorderQty: z.union([z.number(), z.string()]).nullable().optional(),
}).refine((data) => {
  if (data.minStock != null && data.minStock !== '' && data.maxStock != null && data.maxStock !== '') {
    return Number(data.minStock) <= Number(data.maxStock);
  }
  return true;
}, {
  message: 'Minimum stock cannot exceed maximum stock.',
  path: ['minStock'],
});

router.patch(
  '/:id/planning',
  requirePermission('item.edit'),
  validateBody(planningSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof planningSchema>;
    const before = await queryOne<Record<string, unknown>>('SELECT * FROM items WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before) throw NotFoundError('Item');

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE items
            SET min_stock = CASE WHEN $1::boolean THEN $2 ELSE min_stock END,
                max_stock = CASE WHEN $3::boolean THEN $4 ELSE max_stock END,
                reorder_level = CASE WHEN $5::boolean THEN $6 ELSE reorder_level END,
                reorder_qty = CASE WHEN $7::boolean THEN $8 ELSE reorder_qty END,
                updated_by = $9, updated_at = now()
          WHERE id = $10`,
        [
          body.minStock !== undefined, numOrNull(body.minStock),
          body.maxStock !== undefined, numOrNull(body.maxStock),
          body.reorderLevel !== undefined, numOrNull(body.reorderLevel),
          body.reorderQty !== undefined, numOrNull(body.reorderQty),
          req.user!.id,
          id,
        ],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'item', entityId: id,
        entityLabel: `${before.item_code} planning thresholds`, before, after: body,
      });
    });

    sendOk(res, await queryOne(`${ITEM_SELECT} WHERE i.id = $1`, [id]));
  }),
);

/* ── DELETE /items/:id ──────────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('item.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const before = await queryOne<{ item_code: string; item_description: string }>(
      'SELECT * FROM items WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!before) throw NotFoundError('Item');

    const usage = await queryOne<{ indent_lines: string; po_lines: string; grn_lines: string }>(
      `SELECT (SELECT COUNT(*) FROM purchase_indent_lines WHERE item_id = $1) AS indent_lines,
              (SELECT COUNT(*) FROM purchase_order_lines  WHERE item_id = $1) AS po_lines,
              (SELECT COUNT(*) FROM grn_lines             WHERE item_id = $1) AS grn_lines`,
      [id],
    );
    const refs =
      Number(usage?.indent_lines ?? 0) + Number(usage?.po_lines ?? 0) + Number(usage?.grn_lines ?? 0);

    const result = await withTransaction(async (tx) => {
      if (refs > 0) {
        await tx.query(
          'UPDATE items SET is_active = FALSE, updated_at = now(), updated_by = $2 WHERE id = $1',
          [id, req.user!.id],
        );
        await auditIn(tx, {
          actor: actorFrom(req), action: 'UPDATE', entity: 'item', entityId: id,
          entityLabel: before.item_code, before,
          message: `Deactivated instead of deleted — ${refs} linked transaction line(s)`,
        });
        return {
          deleted: false,
          message:
            `${before.item_code} appears on ${usage?.indent_lines} indent line(s), ${usage?.po_lines} PO line(s) ` +
            `and ${usage?.grn_lines} GRN line(s), so it has been deactivated rather than deleted. ` +
            `Transaction history is preserved and the item no longer appears in dropdowns.`,
        };
      }
      await tx.query(
        'UPDATE items SET deleted_at = now(), is_active = FALSE, updated_by = $2 WHERE id = $1',
        [id, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'item', entityId: id,
        entityLabel: before.item_code, before,
      });
      return { deleted: true, message: `${before.item_code} has been deleted.` };
    });

    sendOk(res, result);
  }),
);

export default router;
