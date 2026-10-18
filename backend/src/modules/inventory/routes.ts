/**
 * Inventory & Auto Indent Module (Requirement 9).
 *
 * Subtab A — Stock & Reorder:
 * - Live stock, allocated stock, available stock, reorder level/qty, min/max stock.
 * - Stock status: Normal, Below Reorder, Critical / Below Minimum, Excess.
 * - In-pipeline tracking: Pending Indents, Pending POs, Pending GRNs.
 *
 * Subtab B — Auto Indent Queue & Approval:
 * - Suggested indents calculation: Max(Reorder Qty, (Max Stock or Reorder Level) - Available - Pipeline).
 * - Multi-stage approval: Store Incharge review, Purchase Head approval.
 * - Direct conversion to real Purchase Indent.
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam, csvIdArray, toKolkataStartOfDay, toKolkataEndOfDay,
  EXPORT_ROW_CAP, refuseTruncatedExport,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError, ConflictError, AuthorizationError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { actorFrom, auditIn, audit } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import { toQty, toRate } from '../../domain/money.js';
import { toShortUom } from '../../domain/uom.js';
import { adjustStockPhysicalCount, reverseStockAdjustment } from '../../domain/stock.js';
import { recordInventoryMovement, reverseInventoryMovement, INVENTORY_CATEGORIES, type InventoryCategory } from '../../domain/inventory.js';
import { syncCategoryFromSheet, syncAllInventoryCategories, activeInventorySync, type CategorySyncResult } from './sync-engine.js';
import { EXCLUSION_TEXT } from './sheet-model.js';
import directIssueRoutes from './direct-issue.routes.js';

const router = Router();
router.use('/direct-issues', directIssueRoutes);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── GET /inventory/overview ────────────────────────────────────────────────── */

router.get(
  '/overview',
  requireAnyPermission('inventory.view', 'auto_indent.view'),
  asyncHandler(async (_req, res) => {
    // 1. Overall stock health stats
    const statsSql = `
      SELECT
        COUNT(*)::int AS total_items,
        COALESCE(SUM(i.live_stock_qty), 0)::numeric(18, 4) AS total_stock_qty,
        (SELECT COALESCE(SUM(live_stock_qty * COALESCE(unit_price, 0)), 0)::numeric(18, 2) FROM inventory_items WHERE deleted_at IS NULL) AS total_valuation,
        COUNT(CASE WHEN i.live_stock_qty = 0 THEN 1 END)::int AS zero_stock_count,
        COUNT(CASE WHEN i.live_stock_qty > 0 THEN 1 END)::int AS positive_stock_count,
        COUNT(CASE WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                     OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0)
                   THEN 1 END)::int AS critical_stock,
        COUNT(CASE WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0)
                     AND COALESCE(i.reorder_level, 0) > 0
                     AND NOT (GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                              OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0))
                   THEN 1 END)::int AS below_reorder,
        COUNT(CASE WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                     AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock
                   THEN 1 END)::int AS excess_stock,
        COUNT(CASE WHEN NOT (GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0) AND COALESCE(i.reorder_level, 0) > 0)
                     AND NOT (GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                              OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0))
                     AND NOT (i.max_stock IS NOT NULL AND i.max_stock > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock)
                   THEN 1 END)::int AS normal_stock
        FROM items i
        LEFT JOIN (
          SELECT rl.item_id, SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)) AS allocated_qty
            FROM requisition_lines rl
            JOIN requisition_headers rh ON rh.id = rl.requisition_id
            JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
           WHERE rh.status IN ('APPROVED', 'PARTIALLY_ISSUED')
           GROUP BY rl.item_id
        ) req ON req.item_id = i.id
       WHERE i.deleted_at IS NULL AND i.is_active = TRUE
    `;
    const stats = await queryOne<Record<string, unknown>>(statsSql);

    // 2. Unit Breakdown (no mixed units)
    const unitsSummary = await query<{ primary_uom: string; item_count: number; total_qty: string }>(
      `SELECT primary_uom, COUNT(*)::int AS item_count, COALESCE(SUM(live_stock_qty), 0)::numeric(18, 4) AS total_qty
         FROM inventory_items
        WHERE deleted_at IS NULL
        GROUP BY primary_uom
        ORDER BY item_count DESC`,
    );

    // 3. Category distribution from dedicated inventory_items
    const catSql = `
      SELECT
        ii.category,
        COUNT(*)::int AS item_count,
        COUNT(CASE WHEN ii.source_spreadsheet_id IS NOT NULL THEN 1 END)::int AS sheet_items_count,
        COUNT(CASE WHEN ii.source_spreadsheet_id IS NULL THEN 1 END)::int AS unsynced_items_count,
        COALESCE(SUM(ii.live_stock_qty), 0)::numeric(18, 4) AS stock_qty,
        COALESCE(SUM(CASE WHEN ii.source_spreadsheet_id IS NOT NULL THEN ii.live_stock_qty ELSE 0 END), 0)::numeric(18, 4) AS sheet_stock_qty,
        COALESCE(SUM(ii.live_weight_kg), 0)::numeric(18, 4) AS total_weight_kg,
        ROUND(COALESCE(SUM(ii.live_weight_kg), 0) / 1000, 2)::numeric(18, 2) AS weight_ton,
        COALESCE(SUM(ii.live_stock_qty * COALESCE(ii.unit_price, 0)), 0)::numeric(18, 2) AS valuation,
        COUNT(CASE WHEN ii.live_stock_qty = 0 THEN 1 END)::int AS zero_stock_count,
        COUNT(CASE WHEN ii.live_stock_qty > 0 THEN 1 END)::int AS positive_stock_count,
        COUNT(CASE WHEN ii.live_stock_qty < 0 OR ii.available_qty < ii.min_stock_level OR (ii.min_stock_level > 0 AND ii.available_qty = 0) THEN 1 END)::int AS critical_count,
        COUNT(CASE WHEN ii.available_qty <= ii.reorder_point AND ii.reorder_point > 0 AND NOT (ii.available_qty < ii.min_stock_level) THEN 1 END)::int AS below_reorder_count,
        COALESCE(q.quarantined_count, 0)::int AS quarantined_count
      FROM inventory_items ii
      LEFT JOIN (
        SELECT category, COUNT(*)::int AS quarantined_count
        FROM inventory_quarantine
        WHERE resolution_status = 'PENDING'
        GROUP BY category
      ) q ON q.category = ii.category
      WHERE ii.deleted_at IS NULL
      GROUP BY ii.category, q.quarantined_count
      ORDER BY ii.category
    `;
    const catRows = await query<Record<string, unknown>>(catSql);

    // 4. Pipeline activity
    const indentsSummary = await queryOne<{ count: string; qty: string }>(
      `SELECT COUNT(DISTINCT indent_id)::int AS count, COALESCE(SUM(pending_qty), 0)::numeric(18, 4) AS qty
         FROM v_indent_line_balance WHERE indent_status IN ('APPROVED', 'PENDING_APPROVAL')`,
    );
    const posSummary = await queryOne<{ count: string; qty: string }>(
      `SELECT COUNT(DISTINCT po_id)::int AS count, COALESCE(SUM(pending_grn_qty), 0)::numeric(18, 4) AS qty
         FROM v_po_line_balance WHERE is_receivable = TRUE`,
    );
    const reqsSummary = await queryOne<{ count: string; qty: string }>(
      `SELECT COUNT(DISTINCT rh.id)::int AS count, COALESCE(SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)), 0)::numeric(18, 4) AS qty
         FROM requisition_lines rl
         JOIN requisition_headers rh ON rh.id = rl.requisition_id
         JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
        WHERE rh.status IN ('APPROVED', 'PARTIALLY_ISSUED')`,
    );

    // 5. Today's movement. The one-time opening alignment is a book entry dated the day it
    // is applied (on the 2026-10-16 snapshot 6,557 rows, 13.7M in and 13.2M out), not
    // stock that moved that day.
    const todayMovements = await queryOne<{ inward_qty: string; outward_qty: string; txns_count: string }>(
      `SELECT
         COALESCE(SUM(inward_qty), 0)::numeric(18, 4) AS inward_qty,
         COALESCE(SUM(outward_qty), 0)::numeric(18, 4) AS outward_qty,
         COUNT(*)::int AS txns_count
        FROM stock_ledger
       WHERE txn_date = CURRENT_DATE AND reference_type <> 'OPENING_ALIGNMENT'`,
    );

    // 6. Quarantine & Unsynced Discrepancies
    const quarantineSummary = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM inventory_quarantine WHERE resolution_status = 'PENDING'`,
    );
    const unsyncedSummary = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM inventory_items WHERE source_spreadsheet_id IS NULL AND deleted_at IS NULL`,
    );

    // 7. Recent 10 ledger movements
    const recentLedger = await query<Record<string, unknown>>(
      `SELECT sl.id, sl.item_id, i.item_code, i.item_description, i.inventory_category AS category,
              COALESCE(u.code, '') AS uom_code,
              sl.txn_type, sl.reference_type, sl.reference_id, sl.reference_no,
              sl.inward_qty, sl.outward_qty, sl.balance_qty, sl.txn_date,
              sl.created_at, usr.employee_name AS created_by_name
         FROM stock_ledger sl
         JOIN items i ON i.id = sl.item_id
         LEFT JOIN lookups u ON u.id = sl.uom_id
         LEFT JOIN users usr ON usr.id = sl.created_by
        ORDER BY sl.id DESC
        LIMIT 10`,
    );

    sendOk(res, {
      kpis: {
        totalItems: Number(stats?.total_items ?? 0),
        totalStockQty: Number(stats?.total_stock_qty ?? 0),
        totalValuation: Number(stats?.total_valuation ?? 0),
        zeroStockCount: Number(stats?.zero_stock_count ?? 0),
        positiveStockCount: Number(stats?.positive_stock_count ?? 0),
        normalStock: Number(stats?.normal_stock ?? 0),
        belowReorder: Number(stats?.below_reorder ?? 0),
        criticalStock: Number(stats?.critical_stock ?? 0),
        excessStock: Number(stats?.excess_stock ?? 0),
        pendingIndentsCount: Number(indentsSummary?.count ?? 0),
        pendingIndentsQty: Number(indentsSummary?.qty ?? 0),
        pendingPosCount: Number(posSummary?.count ?? 0),
        pendingPosQty: Number(posSummary?.qty ?? 0),
        pendingRequisitionsCount: Number(reqsSummary?.count ?? 0),
        pendingRequisitionsQty: Number(reqsSummary?.qty ?? 0),
        todayInwardQty: Number(todayMovements?.inward_qty ?? 0),
        todayOutwardQty: Number(todayMovements?.outward_qty ?? 0),
        todayTxnsCount: Number(todayMovements?.txns_count ?? 0),
        quarantinedCount: Number(quarantineSummary?.count ?? 0),
        unsyncedCount: Number(unsyncedSummary?.count ?? 0),
      },
      unitsSummary: unitsSummary.map((u) => ({
        uom: u.primary_uom,
        itemCount: Number(u.item_count),
        totalQty: Number(u.total_qty),
      })),
      categoryBreakdown: catRows,
      recentMovements: recentLedger.map((r) => ({
        ...r,
        uom_code: toShortUom(r.uom_code as string),
      })),
    });
  }),
);

/** The register's one stock-status rule, used by its rows, counts, summary and export.
    The CSV kept its own copy, which had drifted: it marked 1,759 items BELOW_REORDER that
    the screen showed as NORMAL (2026-10-16). */
const AVAILABLE_SQL = 'GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0))';

const STOCK_STATUS_SQL = `CASE
                 WHEN ${AVAILABLE_SQL} < COALESCE(i.min_stock, 0)
                      OR (COALESCE(i.min_stock, 0) > 0 AND ${AVAILABLE_SQL} = 0)
                   THEN 'CRITICAL'
                 WHEN ${AVAILABLE_SQL} <= COALESCE(i.reorder_level, 0)
                      AND COALESCE(i.reorder_level, 0) > 0
                   THEN 'BELOW_REORDER'
                 WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                      AND ${AVAILABLE_SQL} > i.max_stock
                   THEN 'EXCESS'
                 ELSE 'NORMAL'
               END`;

/* ── GET /inventory/stock ───────────────────────────────────────────────────── */

const stockQuerySchema = listQuerySchema.extend({
  category: z.enum(['ALL', 'GENERAL', 'RM', 'FG', 'TRADING', 'WIP']).default('ALL'),
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  itemTypeId: csvIdArray,
  mainGroupId: csvIdArray,
  subMainGroupId: csvIdArray,
  itemId: csvIdArray,
  hodId: csvIdArray,
  stockStatus: z.enum(['ALL', 'NORMAL', 'BELOW_REORDER', 'CRITICAL', 'EXCESS']).default('ALL'),
});

/** The register's item filter (all but the stock status, which the list applies around its
    rows and the export in its WHERE), shared by the list and its export. */
function stockItemFilter(q: z.infer<typeof stockQuerySchema>): SqlBuilder {
  const b = new SqlBuilder();
  b.addRaw('i.deleted_at IS NULL AND i.is_active = TRUE');
  if (q.category && q.category !== 'ALL') {
    b.add('i.inventory_category = ?', q.category);
  }
  b.addIn('i.department_id', q.departmentId);
  b.addIn('i.cost_centre_id', q.costCentreId);
  b.addIn('i.item_type_id', q.itemTypeId);
  b.addIn('i.main_group_id', q.mainGroupId);
  b.addIn('i.sub_main_group_id', q.subMainGroupId);
  b.addIn('i.id', q.itemId);
  if (q.hodId && q.hodId.length > 0) {
    const p = b.push(q.hodId);
    b.addRaw(`EXISTS (SELECT 1 FROM lookups d WHERE d.id = i.department_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p} OR lower(i.hsn_code) LIKE ${p})`,
    );
  }
  return b;
}

router.get(
  '/stock',
  requireAnyPermission('inventory.view', 'auto_indent.view'),
  validateQuery(stockQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof stockQuerySchema>>(res);
    const b = stockItemFilter(q);

    const baseFrom = `
      FROM items i
      LEFT JOIN lookups u ON u.id = i.uom_id
      LEFT JOIN lookups d ON d.id = i.department_id
      LEFT JOIN lookups cc ON cc.id = i.cost_centre_id
      LEFT JOIN lookups it ON it.id = i.item_type_id
      LEFT JOIN lookups mg ON mg.id = i.main_group_id
      LEFT JOIN lookups smg ON smg.id = i.sub_main_group_id
      LEFT JOIN (
        SELECT rl.item_id, SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)) AS allocated_qty
          FROM requisition_lines rl
          JOIN requisition_headers rh ON rh.id = rl.requisition_id
          JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
         WHERE rh.status IN ('APPROVED', 'PARTIALLY_ISSUED')
         GROUP BY rl.item_id
      ) req ON req.item_id = i.id
      LEFT JOIN (
        SELECT item_id, SUM(pending_qty) AS pending_indent_qty
          FROM v_indent_line_balance
         WHERE indent_status IN ('APPROVED', 'PENDING_APPROVAL')
         GROUP BY item_id
      ) ind ON ind.item_id = i.id
      LEFT JOIN (
        SELECT item_id, SUM(pending_grn_qty) AS pending_po_qty
          FROM v_po_line_balance
         WHERE is_receivable = TRUE
         GROUP BY item_id
      ) po ON po.item_id = i.id
      LEFT JOIN (
        SELECT item_id, SUM(received_qty - accepted_qty - rejected_qty) AS qc_pending_qty
          FROM qc_inspections
         WHERE status IN ('PENDING_QC', 'QC_IN_PROGRESS')
         GROUP BY item_id
      ) qc ON qc.item_id = i.id
      -- Valuation rate: the Item Master's standard rate, else the store's own rate from the
      -- inventory sheet the stock comes from. No Purchase item has a standard rate (all
      -- 17,379 were 0 on 2026-10-16), so valuing at standard rate alone showed Rs 0 for
      -- 3,191 items while the Overview valued the same stock at sheet rates.
      LEFT JOIN LATERAL (
        SELECT ii.unit_price AS sheet_rate
          FROM inventory_items ii
         WHERE ii.item_id = i.id AND ii.deleted_at IS NULL AND COALESCE(ii.unit_price, 0) > 0
         ORDER BY (ii.category = i.inventory_category) DESC, ii.id
         LIMIT 1
      ) sr ON TRUE
    `;

    // Filter by stockStatus in SQL wrapper
    let statusFilter = '';
    if (q.stockStatus === 'CRITICAL') {
      statusFilter = 'WHERE t.stock_status = \'CRITICAL\'';
    } else if (q.stockStatus === 'BELOW_REORDER') {
      statusFilter = 'WHERE t.stock_status = \'BELOW_REORDER\'';
    } else if (q.stockStatus === 'EXCESS') {
      statusFilter = 'WHERE t.stock_status = \'EXCESS\'';
    } else if (q.stockStatus === 'NORMAL') {
      statusFilter = 'WHERE t.stock_status = \'NORMAL\'';
    }

    const countSql = `
      SELECT COUNT(*) AS n FROM (
        SELECT i.id,
               ${STOCK_STATUS_SQL} AS stock_status
        ${baseFrom}
        ${b.where()}
      ) t ${statusFilter}
    `;

    const totalRow = await queryOne<{ n: string }>(countSql, b.params);
    const total = Number(totalRow?.n ?? 0);

    const summaryRow = await queryOne<{
      total_active: string;
      normal_stock: string;
      below_reorder: string;
      critical_stock: string;
      excess_stock: string;
      total_valuation: string;
      unvalued_with_stock: string;
      sheet_rated_with_stock: string;
      total_fg: string;
      total_rm: string;
      total_trading: string;
      total_general: string;
      total_wip: string;
    }>(
      `SELECT
         COUNT(*) AS total_active,
         COUNT(CASE WHEN t.stock_status = 'NORMAL' THEN 1 END) AS normal_stock,
         COUNT(CASE WHEN t.stock_status = 'BELOW_REORDER' THEN 1 END) AS below_reorder,
         COUNT(CASE WHEN t.stock_status = 'CRITICAL' THEN 1 END) AS critical_stock,
         COUNT(CASE WHEN t.stock_status = 'EXCESS' THEN 1 END) AS excess_stock,
         COALESCE(SUM(t.live_stock_qty * t.valuation_rate), 0) AS total_valuation,
         COUNT(CASE WHEN t.live_stock_qty > 0 AND t.valuation_rate = 0 THEN 1 END) AS unvalued_with_stock,
         COUNT(CASE WHEN t.live_stock_qty > 0 AND t.valuation_basis = 'SHEET' THEN 1 END) AS sheet_rated_with_stock,
         COUNT(CASE WHEN t.inventory_category = 'FG' THEN 1 END) AS total_fg,
         COUNT(CASE WHEN t.inventory_category = 'RM' THEN 1 END) AS total_rm,
         COUNT(CASE WHEN t.inventory_category = 'TRADING' THEN 1 END) AS total_trading,
         COUNT(CASE WHEN t.inventory_category = 'GENERAL' THEN 1 END) AS total_general,
         COUNT(CASE WHEN t.inventory_category = 'WIP' THEN 1 END) AS total_wip
       FROM (
         SELECT i.id,
                i.inventory_category,
                i.live_stock_qty,
                COALESCE(NULLIF(i.standard_rate, 0), sr.sheet_rate, 0) AS valuation_rate,
                CASE WHEN COALESCE(i.standard_rate, 0) > 0 THEN 'STANDARD' WHEN sr.sheet_rate IS NOT NULL THEN 'SHEET' ELSE 'NONE' END AS valuation_basis,
                ${STOCK_STATUS_SQL} AS stock_status
          ${baseFrom}
          ${b.where()}
       ) t`,
      b.params,
    );

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const selectSql = `
      SELECT t.* FROM (
        SELECT i.id AS item_id,
               i.item_code,
               i.item_description,
               i.inventory_category AS category,
               COALESCE(i.opening_stock_qty, 0) AS opening_stock_qty,
               ROUND((i.live_stock_qty * COALESCE(NULLIF(i.standard_rate, 0), sr.sheet_rate, 0)), 2) AS stock_valuation,
               CASE WHEN COALESCE(i.standard_rate, 0) > 0 THEN 'STANDARD' WHEN sr.sheet_rate IS NOT NULL THEN 'SHEET' ELSE 'NONE' END AS valuation_basis,
               u.id AS uom_id,
               COALESCE(u.code, '') AS uom_code,
               COALESCE(u.name, '') AS uom_name,
               i.department_id,
               COALESCE(d.name, '') AS department_name,
               i.cost_centre_id,
               COALESCE(cc.name, '') AS cost_centre_name,
               i.item_type_id,
               COALESCE(it.name, '') AS item_type_name,
               i.main_group_id,
               COALESCE(mg.name, '') AS main_group_name,
               i.sub_main_group_id,
               COALESCE(smg.name, '') AS sub_main_group_name,
               i.live_stock_qty,
               COALESCE(req.allocated_qty, 0) AS allocated_stock_qty,
               GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) AS available_stock_qty,
               COALESCE(qc.qc_pending_qty, 0) AS qc_pending_stock_qty,
               COALESCE(i.min_stock, 0) AS min_stock,
               i.max_stock,
               COALESCE(i.reorder_level, 0) AS reorder_level,
               COALESCE(i.reorder_qty, 0) AS reorder_qty,
               COALESCE(ind.pending_indent_qty, 0) AS pending_indent_qty,
               COALESCE(po.pending_po_qty, 0) AS pending_po_qty,
               COALESCE(po.pending_po_qty, 0) AS pending_grn_qty,
               COALESCE(i.standard_rate, 0) AS standard_rate,
               i.qc_required,
               ${STOCK_STATUS_SQL} AS stock_status
        ${baseFrom}
        ${b.where()}
      ) t
      ${statusFilter}
      ORDER BY
        CASE t.stock_status
          WHEN 'CRITICAL' THEN 1
          WHEN 'BELOW_REORDER' THEN 2
          WHEN 'EXCESS' THEN 3
          ELSE 4
        END,
        t.item_code ASC
      LIMIT ${limit} OFFSET ${offset}
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);

    const formatted = rows.map((r) => ({
      ...r,
      uom_code: toShortUom(r.uom_code as string),
    }));

    sendPage(res, formatted, total, q.page, q.pageSize, {
      summary: {
        totalActive: Number(summaryRow?.total_active ?? total),
        normalStock: Number(summaryRow?.normal_stock ?? 0),
        belowReorder: Number(summaryRow?.below_reorder ?? 0),
        criticalStock: Number(summaryRow?.critical_stock ?? 0),
        excessStock: Number(summaryRow?.excess_stock ?? 0),
        totalValuation: Number(summaryRow?.total_valuation ?? 0),
        // How the figure was reached, so a screen never presents an unvalued stock as Rs 0.
        valuationBasis: 'Item Master standard rate, else the store sheet rate',
        unvaluedWithStock: Number(summaryRow?.unvalued_with_stock ?? 0),
        sheetRatedWithStock: Number(summaryRow?.sheet_rated_with_stock ?? 0),
        categories: {
          FG: Number(summaryRow?.total_fg ?? 0),
          RM: Number(summaryRow?.total_rm ?? 0),
          TRADING: Number(summaryRow?.total_trading ?? 0),
          GENERAL: Number(summaryRow?.total_general ?? 0),
          WIP: Number(summaryRow?.total_wip ?? 0),
        },
      },
    });
  }),
);

/* ── GET /inventory/stock/export ────────────────────────────────────────────── */

router.get(
  '/stock/export',
  requireAnyPermission('inventory.export', 'inventory.view', 'auto_indent.view'),
  validateQuery(stockQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof stockQuerySchema>>(res);
    // The list's own filter (the CSV ignored hodId and stockStatus).
    const b = stockItemFilter(q);
    if (q.stockStatus !== 'ALL') {
      b.addRaw(`(${STOCK_STATUS_SQL}) = ${b.push(q.stockStatus)}`);
    }

    const selectSql = `
      SELECT i.item_code, i.item_description,
             i.inventory_category AS category,
             COALESCE(i.opening_stock_qty, 0) AS opening_stock,
             COALESCE(u.code, '') AS uom,
             COALESCE(d.name, '') AS department,
             COALESCE(cc.name, '') AS cost_centre,
             i.live_stock_qty,
             COALESCE(req.allocated_qty, 0) AS allocated_stock,
             GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) AS available_stock,
             COALESCE(i.reorder_level, 0) AS reorder_level,
             COALESCE(i.reorder_qty, 0) AS reorder_qty,
             COALESCE(i.min_stock, 0) AS min_stock,
             COALESCE(i.max_stock, 0) AS max_stock,
             COALESCE(ind.pending_indent_qty, 0) AS pending_indents,
             COALESCE(po.pending_po_qty, 0) AS pending_pos,
             ROUND((i.live_stock_qty * COALESCE(NULLIF(i.standard_rate, 0), sr.sheet_rate, 0)), 2) AS stock_valuation,
             ${STOCK_STATUS_SQL} AS stock_status
        FROM items i
        LEFT JOIN lookups u ON u.id = i.uom_id
        LEFT JOIN lookups d ON d.id = i.department_id
        LEFT JOIN lookups cc ON cc.id = i.cost_centre_id
        LEFT JOIN (
          SELECT rl.item_id, SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)) AS allocated_qty
            FROM requisition_lines rl
            JOIN requisition_headers rh ON rh.id = rl.requisition_id
            JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
           WHERE rh.status IN ('APPROVED', 'PARTIALLY_ISSUED')
           GROUP BY rl.item_id
        ) req ON req.item_id = i.id
        LEFT JOIN (
          SELECT item_id, SUM(pending_qty) AS pending_indent_qty
            FROM v_indent_line_balance
           WHERE indent_status IN ('APPROVED', 'PENDING_APPROVAL')
           GROUP BY item_id
        ) ind ON ind.item_id = i.id
        LEFT JOIN (
          SELECT item_id, SUM(pending_grn_qty) AS pending_po_qty
            FROM v_po_line_balance
           WHERE is_receivable = TRUE
           GROUP BY item_id
        ) po ON po.item_id = i.id
        LEFT JOIN LATERAL (
          SELECT ii.unit_price AS sheet_rate
            FROM inventory_items ii
           WHERE ii.item_id = i.id AND ii.deleted_at IS NULL AND COALESCE(ii.unit_price, 0) > 0
           ORDER BY (ii.category = i.inventory_category) DESC, ii.id
           LIMIT 1
        ) sr ON TRUE
       ${b.where()}
       ORDER BY i.item_code ASC
       LIMIT ${EXPORT_ROW_CAP + 1}
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);
    refuseTruncatedExport(rows.length);

    const headers = [
      'Item Code', 'Item Description', 'Category', 'Opening Stock', 'UOM', 'Department', 'Cost Centre',
      'Live Stock', 'Allocated Stock', 'Available Stock', 'Reorder Level',
      'Reorder Qty', 'Min Stock', 'Max Stock', 'Pending Indents', 'Pending POs', 'Valuation (INR)', 'Status',
    ];

    const csvRows = [headers.join(',')];
    for (const r of rows) {
      csvRows.push([
        `"${String(r.item_code).replace(/"/g, '""')}"`,
        `"${String(r.item_description).replace(/"/g, '""')}"`,
        `"${String(r.category || 'GENERAL')}"`,
        r.opening_stock,
        `"${toShortUom(r.uom as string)}"`,
        `"${String(r.department).replace(/"/g, '""')}"`,
        `"${String(r.cost_centre).replace(/"/g, '""')}"`,
        r.live_stock_qty,
        r.allocated_stock,
        r.available_stock,
        r.reorder_level,
        r.reorder_qty,
        r.min_stock,
        r.max_stock,
        r.pending_indents,
        r.pending_pos,
        r.stock_valuation,
        r.stock_status,
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="inventory_stock_register.csv"');
    res.status(200).send(csvRows.join('\r\n'));
  }),
);

/* ── GET /inventory/ledger ──────────────────────────────────────────────────── */

const ledgerQuerySchema = listQuerySchema.extend({
  category: z.enum(['ALL', 'GENERAL', 'RM', 'FG', 'TRADING', 'WIP']).default('ALL'),
  itemId: csvIdArray,
  txnType: z.string().optional(),
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
});

/** The movement ledger's filter, shared by the list and its export. */
function ledgerFilter(q: z.infer<typeof ledgerQuerySchema>): SqlBuilder {
  const b = new SqlBuilder();
  if (q.category && q.category !== 'ALL') {
    b.add('i.inventory_category = ?', q.category);
  }
  b.addIn('sl.item_id', q.itemId);
  if (q.txnType) {
    b.add('sl.txn_type = ?', q.txnType);
  }
  if (q.fromDate) {
    b.add('sl.txn_date >= ?', q.fromDate);
  }
  if (q.toDate) {
    b.add('sl.txn_date <= ?', q.toDate);
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p} OR lower(COALESCE(sl.reference_no, '')) LIKE ${p} OR lower(sl.txn_type) LIKE ${p})`,
    );
  }
  return b;
}

router.get(
  '/ledger',
  requireAnyPermission('inventory.view', 'auto_indent.view'),
  validateQuery(ledgerQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof ledgerQuerySchema>>(res);
    const b = ledgerFilter(q);

    const baseFrom = `
      FROM stock_ledger sl
      JOIN items i ON i.id = sl.item_id
      LEFT JOIN lookups u ON u.id = sl.uom_id
      LEFT JOIN users usr ON usr.id = sl.created_by
    `;

    const summaryRow = await queryOne<{
      total_count: string;
      total_inward: string;
      total_outward: string;
    }>(
      `SELECT
         COUNT(*)::int AS total_count,
         COALESCE(SUM(sl.inward_qty), 0)::numeric(18, 4) AS total_inward,
         COALESCE(SUM(sl.outward_qty), 0)::numeric(18, 4) AS total_outward
       ${baseFrom}
       ${b.where()}`,
      b.params,
    );

    const total = Number(summaryRow?.total_count ?? 0);
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const selectSql = `
      SELECT sl.id, sl.item_id, i.item_code, i.item_description, i.inventory_category AS category,
             COALESCE(u.code, '') AS uom_code,
             sl.txn_type, sl.reference_type, sl.reference_id, sl.reference_no,
             sl.inward_qty, sl.outward_qty, sl.balance_qty, sl.txn_date,
             sl.created_at, usr.employee_name AS created_by_name
       ${baseFrom}
       ${b.where()}
       ORDER BY sl.id DESC
       LIMIT ${limit} OFFSET ${offset}
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);

    sendPage(res, rows.map((r) => ({ ...r, uom_code: toShortUom(r.uom_code as string) })), total, q.page, q.pageSize, {
      summary: {
        totalMovements: total,
        totalInward: Number(summaryRow?.total_inward ?? 0),
        totalOutward: Number(summaryRow?.total_outward ?? 0),
      },
    });
  }),
);

/* ── GET /inventory/ledger/export ───────────────────────────────────────────── */

router.get(
  '/ledger/export',
  requireAnyPermission('inventory.export', 'inventory.view', 'auto_indent.view'),
  validateQuery(ledgerQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof ledgerQuerySchema>>(res);
    const b = ledgerFilter(q);

    const selectSql = `
      SELECT sl.id, sl.item_id, i.item_code, i.item_description, i.inventory_category AS category,
             COALESCE(u.code, '') AS uom_code,
             sl.txn_type, sl.reference_type, sl.reference_id, sl.reference_no,
             sl.inward_qty, sl.outward_qty, sl.balance_qty,
             -- A plain date: the CSV printed 'Fri Oct 16 2026 05:30:00 GMT+0530 (India Standard Time)'.
             to_char(sl.txn_date, 'YYYY-MM-DD') AS txn_date,
             sl.created_at, usr.employee_name AS created_by_name
        FROM stock_ledger sl
        JOIN items i ON i.id = sl.item_id
        LEFT JOIN lookups u ON u.id = sl.uom_id
        LEFT JOIN users usr ON usr.id = sl.created_by
       ${b.where()}
       ORDER BY sl.id DESC
       LIMIT ${EXPORT_ROW_CAP + 1}
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);
    refuseTruncatedExport(rows.length);

    const headers = [
      'Date', 'Time', 'Item Code', 'Item Description', 'Category', 'Movement Type',
      'Reference Doc', 'Inward Qty', 'Outward Qty', 'Balance Qty', 'UOM', 'Recorded By',
    ];

    const csvRows = [headers.join(',')];
    for (const r of rows) {
      const createdAt = new Date(r.created_at as string);
      const timeStr = createdAt.toLocaleTimeString('en-IN', { hour12: false });
      csvRows.push([
        r.txn_date,
        timeStr,
        `"${String(r.item_code).replace(/"/g, '""')}"`,
        `"${String(r.item_description).replace(/"/g, '""')}"`,
        `"${String(r.category || 'GENERAL')}"`,
        r.txn_type,
        `"${String(r.reference_no || '—').replace(/"/g, '""')}"`,
        r.inward_qty,
        r.outward_qty,
        r.balance_qty,
        `"${toShortUom(r.uom_code as string)}"`,
        `"${String(r.created_by_name || 'System').replace(/"/g, '""')}"`,
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock_movement_ledger.csv"');
    res.status(200).send(csvRows.join('\r\n'));
  }),
);

/* ── GET /inventory/adjustments ─────────────────────────────────────────────── */

const adjustmentQuerySchema = listQuerySchema.extend({
  category: z.enum(['ALL', 'GENERAL', 'RM', 'FG', 'TRADING', 'WIP']).default('ALL'),
  itemId: csvIdArray,
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
});

router.get(
  '/adjustments',
  requireAnyPermission('inventory.view', 'auto_indent.view'),
  validateQuery(adjustmentQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof adjustmentQuerySchema>>(res);
    const b = new SqlBuilder();

    if (q.category && q.category !== 'ALL') {
      b.add('sa.category = ?', q.category);
    }
    b.addIn('sa.item_id', q.itemId);
    if (q.fromDate) {
      b.add('sa.adjustment_date >= ?', q.fromDate);
    }
    if (q.toDate) {
      b.add('sa.adjustment_date <= ?', q.toDate);
    }
    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(sa.adjustment_no) LIKE ${p} OR lower(sa.item_code) LIKE ${p} OR lower(sa.item_description) LIKE ${p} OR lower(sa.reason) LIKE ${p})`,
      );
    }

    const countSql = `SELECT COUNT(*)::int AS n FROM stock_adjustments sa ${b.where()}`;
    const totalRow = await queryOne<{ n: number }>(countSql, b.params);
    const total = Number(totalRow?.n ?? 0);

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const selectSql = `
      SELECT sa.*, u.employee_name AS created_by_name, app.employee_name AS approved_by_name
        FROM stock_adjustments sa
        LEFT JOIN users u ON u.id = sa.created_by
        LEFT JOIN users app ON app.id = sa.approved_by
       ${b.where()}
       ORDER BY sa.id DESC
       LIMIT ${limit} OFFSET ${offset}
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);
    sendPage(res, rows, total, q.page, q.pageSize);
  }),
);

/* ── POST /inventory/adjustments ────────────────────────────────────────────── */

const createAdjustmentSchema = z.object({
  itemId: z.coerce.number().int().positive('Item selection is required.'),
  actualStockQty: z.union([z.number(), z.string()]).refine((v) => Number(v) >= 0, 'Actual stock cannot be negative.'),
  reason: z.string().trim().min(2, 'Reason is mandatory for stock adjustments.').max(500),
  findings: z.string().trim().max(1000).default(''),
  remarks: z.string().trim().max(1000).default(''),
  adjustmentDate: dateStr.default(() => dateStamp(new Date())),
});

/* ── POST /inventory/adjustments/:id/reverse ────────────────────────────────── */
/* Undoes a physical-count adjustment with a STOCK_ADJUSTMENT_REVERSAL entry; the
   adjustment row stays, marked with who reversed it, when and why. */

const reverseSchema = z.object({
  reason: z.string().trim().min(5, 'Give the reason (at least 5 characters).').max(500),
});

router.post(
  '/adjustments/:id/reverse',
  requirePermission('inventory.adjust'),
  validateBody(reverseSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as z.infer<typeof reverseSchema>;
    const result = await withTransaction(async (tx) => {
      const adj = await txQueryOne<{
        id: number; adjustment_no: string; item_id: number; item_code: string; adjustment_qty: string; reversed_at: string | null;
      }>(tx, 'SELECT id, adjustment_no, item_id, item_code, adjustment_qty, reversed_at FROM stock_adjustments WHERE id = $1 FOR UPDATE', [id]);
      if (!adj) throw NotFoundError('Stock adjustment');
      if (adj.reversed_at) throw BusinessRuleError(`Adjustment ${adj.adjustment_no} is already reversed.`);
      const item = await txQueryOne<{ uom_id: number | null }>(tx, 'SELECT uom_id FROM items WHERE id = $1', [adj.item_id]);
      const r = await reverseStockAdjustment(tx, { item_id: adj.item_id, uom_id: item?.uom_id ?? null }, adj.adjustment_qty,
        { adjustmentId: adj.id, adjustmentNo: adj.adjustment_no, date: dateStamp(new Date()), userId: req.user!.id });
      await tx.query(
        'UPDATE stock_adjustments SET reversed_at = now(), reversed_by = $2, reversal_reason = $3 WHERE id = $1',
        [id, req.user!.id, reason],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CANCEL', entity: 'stock_adjustment', entityId: id, entityLabel: adj.adjustment_no,
        before: { stock: r.previousBalance }, after: { stock: r.newBalance, reason },
        message: `Adjustment ${adj.adjustment_no} (${adj.item_code}, ${adj.adjustment_qty}) reversed: ${r.previousBalance} -> ${r.newBalance}. Reason: ${reason}`,
      });
      return { adjustmentNo: adj.adjustment_no, itemCode: adj.item_code, ...r };
    });
    sendOk(res, { ...result, message: `Adjustment ${result.adjustmentNo} reversed. ${result.itemCode} stock is now ${result.newBalance}.` });
  }),
);

/* ── POST /inventory/transactions/:id/reverse — undo a movement entered in the ERP ─ */

router.post(
  '/transactions/:id/reverse',
  requirePermission('inventory.adjust'),
  validateBody(reverseSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as z.infer<typeof reverseSchema>;
    const result = await withTransaction(async (tx) => {
      const r = await reverseInventoryMovement(tx, id, { reason, userId: req.user!.id });
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CANCEL', entity: 'inventory_movement', entityId: id, entityLabel: r.txnNo,
        after: { reversedQty: r.reversedQty, itemStockAfter: r.itemStockAfter, reason },
        message: `Inventory movement ${r.txnNo} (${r.itemCode}) reversed; stock change undone: ${-r.reversedQty}. Reason: ${reason}`,
      });
      return r;
    });
    sendOk(res, { ...result, message: `${result.txnNo} reversed.` });
  }),
);

router.post(
  '/adjustments',
  // Posting an adjustment changes stock directly: inventory.adjust only (it was
  // also open to auto_indent.approve, i.e. Purchase Heads).
  requirePermission('inventory.adjust'),
  validateBody(createAdjustmentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createAdjustmentSchema>;

    const result = await withTransaction(async (tx) => {
      const item = await txQueryOne<{
        id: number;
        item_code: string;
        item_description: string;
        inventory_category: string;
        uom_id: number | null;
        live_stock_qty: string;
      }>(
        tx,
        'SELECT id, item_code, item_description, inventory_category, uom_id, live_stock_qty FROM items WHERE id = $1 FOR UPDATE',
        [body.itemId],
      );
      if (!item) throw NotFoundError('Item');

      const when = new Date(body.adjustmentDate || Date.now());
      const adjustmentNo = await nextDocumentNumber(tx, 'STOCK_ADJUSTMENT', when);

      const adjRow = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO stock_adjustments
           (adjustment_no, adjustment_date, item_id, item_code, item_description,
            category, system_stock_qty, actual_stock_qty, adjustment_qty,
            reason, findings, approved_by, approver_name, remarks, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
         RETURNING id`,
        [
          adjustmentNo,
          body.adjustmentDate,
          item.id,
          item.item_code,
          item.item_description,
          item.inventory_category || 'GENERAL',
          item.live_stock_qty,
          toQty(body.actualStockQty),
          toQty(Number(body.actualStockQty) - Number(item.live_stock_qty)),
          body.reason,
          body.findings,
          req.user!.id,
          req.user!.employeeName,
          body.remarks,
          req.user!.id,
        ],
      );

      const adjusted = await adjustStockPhysicalCount(
        tx,
        { item_id: item.id, uom_id: item.uom_id },
        String(body.actualStockQty),
        {
          adjustmentId: adjRow!.id,
          adjustmentNo,
          adjustmentDate: body.adjustmentDate,
          reason: body.reason,
          findings: body.findings,
          userId: req.user!.id,
        },
      );

      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'CREATE',
        entity: 'stock_adjustment',
        entityId: adjRow!.id,
        entityLabel: adjustmentNo,
        before: { systemStock: adjusted.previousBalance },
        after: { actualStock: adjusted.newBalance, delta: adjusted.deltaQty },
        message: `Physical stock adjustment ${adjustmentNo} for ${item.item_code}: ${adjusted.previousBalance} -> ${adjusted.newBalance} (delta ${adjusted.deltaQty}). Reason: ${body.reason}`,
      });

      return {
        id: adjRow!.id,
        adjustmentNo,
        itemCode: item.item_code,
        previousStock: adjusted.previousBalance,
        newStock: adjusted.newBalance,
        deltaQty: adjusted.deltaQty,
      };
    });

    sendCreated(res, {
      ...result,
      message: `Stock adjustment ${result.adjustmentNo} posted successfully for ${result.itemCode}.`,
    });
  }),
);

/* ── GET /inventory/requisition-queue ───────────────────────────────────────── */
/* available_stock_qty is the stock left for a line once the lines ahead of it in
   this queue (oldest requisition first, the order it is listed in) have taken
   theirs; the page reads a line as Sufficient when that covers its balance. It
   used to be live stock less EVERY open line's balance, this line's own included,
   so a line needing 2 with 3 on hand and nothing else waiting read 1 and
   "Shortage" (2026-10-17 E2E S4-07b), and an over-issued line counted as negative
   demand. Live stock less only the OTHER lines' balances calls a line covered only
   when the stock covers every open line of the item, so of two lines needing 6
   against 10 on hand both would read short, though the first can be issued now;
   in queue order the first reads 10 and the second 4. Every line in the window
   has a positive balance (the WHERE below), so nothing over-issued counts. */

router.get(
  '/requisition-queue',
  requireAnyPermission('inventory.view', 'requisition.issue', 'auto_indent.view'),
  asyncHandler(async (_req, res) => {
    const rows = await query<Record<string, unknown>>(
      `SELECT h.id AS requisition_id,
              h.requisition_no,
              h.requisition_date,
              h.department_id,
              COALESCE(d.name, '') AS department_name,
              h.cost_centre_id,
              COALESCE(cc.name, '') AS cost_centre_name,
              u.employee_name AS requester_name,
              h.status,
              'APPROVED' AS hod_status,
              rl.id AS requisition_line_id,
              rl.line_no,
              rl.item_id,
              rl.item_code,
              rl.item_description,
              rl.requested_qty,
              COALESCE(v.issued_qty, 0) AS issued_qty,
              (rl.requested_qty - COALESCE(v.issued_qty, 0)) AS balance_to_issue,
              COALESCE(lu.code, '') AS uom_code,
              i.inventory_category AS category,
              i.live_stock_qty,
              GREATEST(0, i.live_stock_qty - COALESCE(SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)) OVER (
                PARTITION BY rl.item_id
                ORDER BY h.requisition_date, h.id, rl.line_no
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ), 0)) AS available_stock_qty
         FROM requisition_lines rl
         JOIN requisition_headers h ON h.id = rl.requisition_id
         JOIN items i ON i.id = rl.item_id
         LEFT JOIN lookups d ON d.id = h.department_id
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN lookups lu ON lu.id = rl.uom_id
         LEFT JOIN users u ON u.id = h.requester_user_id
         LEFT JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
        WHERE h.status IN ('APPROVED', 'PARTIALLY_ISSUED')
          AND (rl.requested_qty - COALESCE(v.issued_qty, 0)) > 0
        ORDER BY h.requisition_date ASC, h.id ASC, rl.line_no ASC`,
    );

    sendOk(res, rows.map((r) => ({ ...r, uom_code: toShortUom(r.uom_code as string) })));
  }),
);

/* ── POST /inventory/auto-indent/generate ───────────────────────────────────── */

router.post(
  ['/auto-indent/generate', '/auto-indents/generate'],
  requireAnyPermission('auto_indent.config', 'auto_indent.approve'),
  asyncHandler(async (req, res) => {
    const candidateSql = `
      SELECT i.id AS item_id,
             i.item_code,
             i.item_description,
             u.id AS uom_id,
             COALESCE(u.code, '') AS uom_code,
             d.id AS department_id,
             COALESCE(d.name, '') AS department_name,
             cc.id AS cost_centre_id,
             COALESCE(cc.name, '') AS cost_centre_name,
             i.live_stock_qty,
             COALESCE(req.allocated_qty, 0) AS allocated_stock,
             GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) AS available_stock,
             COALESCE(i.min_stock, 0) AS min_stock,
             i.max_stock,
             COALESCE(i.reorder_level, 0) AS reorder_level,
             COALESCE(i.reorder_qty, 0) AS reorder_qty,
             COALESCE(ind.pending_indent_qty, 0) AS pending_indent_qty,
             COALESCE(po.pending_po_qty, 0) AS pending_po_qty
        FROM items i
        LEFT JOIN lookups u ON u.id = i.uom_id
        LEFT JOIN lookups d ON d.id = i.department_id
        LEFT JOIN lookups cc ON cc.id = i.cost_centre_id
        LEFT JOIN (
          SELECT rl.item_id, SUM(rl.requested_qty - COALESCE(v.issued_qty, 0)) AS allocated_qty
            FROM requisition_lines rl
            JOIN requisition_headers rh ON rh.id = rl.requisition_id
            JOIN v_requisition_line_balance v ON v.requisition_line_id = rl.id
           WHERE rh.status IN ('APPROVED', 'PARTIALLY_ISSUED')
           GROUP BY rl.item_id
        ) req ON req.item_id = i.id
        LEFT JOIN (
          SELECT item_id, SUM(pending_qty) AS pending_indent_qty
            FROM v_indent_line_balance
           WHERE indent_status IN ('APPROVED', 'PENDING_APPROVAL')
           GROUP BY item_id
        ) ind ON ind.item_id = i.id
        LEFT JOIN (
          SELECT item_id, SUM(pending_grn_qty) AS pending_po_qty
            FROM v_po_line_balance
           WHERE is_receivable = TRUE
           GROUP BY item_id
        ) po ON po.item_id = i.id
       WHERE i.deleted_at IS NULL AND i.is_active = TRUE
         AND (
           (COALESCE(i.reorder_level, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= i.reorder_level)
           OR
           (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < i.min_stock)
         )
    `;

    const candidates = await query<{
      item_id: number; item_code: string; item_description: string;
      uom_id: number | null; uom_code: string;
      department_id: number | null; department_name: string;
      cost_centre_id: number | null; cost_centre_name: string;
      live_stock_qty: string; allocated_stock: string; available_stock: string;
      min_stock: string; max_stock: string | null; reorder_level: string; reorder_qty: string;
      pending_indent_qty: string; pending_po_qty: string;
    }>(candidateSql);

    let generated = 0;

    await withTransaction(async (tx) => {
      for (const item of candidates) {
        // Skip if active auto indent already pending
        const existing = await txQueryOne<{ id: number }>(
          tx,
          `SELECT id FROM auto_indents
            WHERE item_id = $1 AND status IN ('SUGGESTED', 'PENDING_APPROVAL', 'STORE_APPROVED', 'PURCHASE_APPROVED')`,
          [item.item_id],
        );
        if (existing) continue;

        const available = Number(item.available_stock);
        const minStock = Number(item.min_stock);
        const reorderLevel = Number(item.reorder_level);
        const reorderQty = Number(item.reorder_qty);
        const maxStock = item.max_stock != null ? Number(item.max_stock) : null;
        const pipeline = Number(item.pending_indent_qty) + Number(item.pending_po_qty);
        const effectiveAvailable = available + pipeline;

        // Skip if pipeline already covers minimum stock and reorder level
        if (minStock > 0 && effectiveAvailable >= minStock) {
          if (reorderLevel <= 0 || effectiveAvailable > reorderLevel) {
            continue;
          }
        } else if (reorderLevel > 0 && effectiveAvailable > reorderLevel) {
          continue;
        }

        // Target calculation: replenish up to max_stock, or reorder_level / min_stock
        const target = maxStock != null && maxStock > minStock ? maxStock : (reorderLevel > 0 ? reorderLevel : minStock);
        const shortfall = target - effectiveAvailable;
        if (shortfall <= 0) continue;

        const suggestedQty = Math.max(reorderQty > 0 ? reorderQty : 0, Math.max(1, shortfall));

        const reason = available < minStock
          ? 'Below Minimum Stock'
          : available <= reorderLevel
            ? 'Below Reorder Level'
            : 'Safety Stock Replenishment';

        await tx.query(
          `INSERT INTO auto_indents
             (item_id, item_code, item_name, eligible_stock, min_stock, max_stock,
              reorder_level, suggested_qty, uom_id, uom_code, department_id, department_name,
              cost_centre_id, cost_centre_name, reason, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'PENDING_APPROVAL')`,
          [
            item.item_id, item.item_code, item.item_description,
            available, minStock, maxStock, reorderLevel, suggestedQty,
            item.uom_id, toShortUom(item.uom_code), item.department_id, item.department_name,
            item.cost_centre_id, item.cost_centre_name, reason,
          ],
        );
        generated += 1;
      }

      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'CREATE',
        entity: 'auto_indent',
        entityId: null,
        entityLabel: 'Stock Replenishment Run',
        after: { generatedCount: generated, candidatesEvaluated: candidates.length },
        message: `Generated ${generated} automatic indent suggestion(s) from stock audit.`,
      });
    });

    sendOk(res, {
      candidates: candidates.length,
      generated,
      message: generated > 0
        ? `Successfully generated ${generated} automatic indent suggestions.`
        : 'All items are currently at or above safe stock levels. No new indents needed.',
    });
  }),
);

/* ── GET /inventory/auto-indents ────────────────────────────────────────────── */

const autoIndentListSchema = listQuerySchema.extend({
  status: z.string().optional(),
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  itemId: csvIdArray,
  hodId: csvIdArray,
  userId: csvIdArray,
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
});

function buildAutoIndentFilter(q: z.infer<typeof autoIndentListSchema>): SqlBuilder {
  const b = new SqlBuilder();
  if (q.status) {
    const statuses = q.status.split(',').map((s) => s.trim()).filter(Boolean);
    if (statuses.length > 0) b.addIn('ai.status', statuses);
  }
  b.addIn('ai.department_id', q.departmentId);
  b.addIn('ai.cost_centre_id', q.costCentreId);
  b.addIn('ai.item_id', q.itemId);
  b.addIn('ai.approved_by_user_id', q.userId);
  if (q.hodId && q.hodId.length > 0) {
    const p = b.push(q.hodId);
    b.addRaw(`EXISTS (SELECT 1 FROM lookups d WHERE d.id = ai.department_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
  }
  if (q.dateFrom) b.add('ai.created_at >= ?::timestamptz', toKolkataStartOfDay(q.dateFrom));
  if (q.dateTo) b.add('ai.created_at <= ?::timestamptz', toKolkataEndOfDay(q.dateTo));

  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(ai.item_code) LIKE ${p} OR lower(ai.item_name) LIKE ${p} OR lower(ai.department_name) LIKE ${p})`,
    );
  }
  return b;
}

router.get(
  '/auto-indents',
  requirePermission('auto_indent.view'),
  validateQuery(autoIndentListSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof autoIndentListSchema>>(res);
    const b = buildAutoIndentFilter(q);

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM auto_indents ai ${b.where()}`,
      b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const totalsRow = await queryOne<{
      total_qty: string;
      pending_count: string;
      approved_count: string;
      converted_count: string;
    }>(
      `SELECT
         COALESCE(SUM(ai.suggested_qty), 0) AS total_qty,
         COUNT(CASE WHEN ai.status = 'PENDING_APPROVAL' THEN 1 END) AS pending_count,
         COUNT(CASE WHEN ai.status IN ('STORE_APPROVED','PURCHASE_APPROVED','APPROVED') THEN 1 END) AS approved_count,
         COUNT(CASE WHEN ai.status = 'CONVERTED' THEN 1 END) AS converted_count
       FROM auto_indents ai
       ${b.where()}`,
      b.params,
    );

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT ai.* FROM auto_indents ai
       ${b.where()}
       ORDER BY
         CASE ai.status
            WHEN 'PENDING_APPROVAL' THEN 1
            WHEN 'STORE_APPROVED' THEN 2
            WHEN 'PURCHASE_APPROVED' THEN 3
            WHEN 'APPROVED' THEN 4
            WHEN 'CONVERTED' THEN 5
            ELSE 6
          END,
          ai.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize, {
      totals: {
        totalSuggestions: total,
        totalSuggestedQty: Number(totalsRow?.total_qty ?? 0),
        pendingCount: Number(totalsRow?.pending_count ?? 0),
        approvedCount: Number(totalsRow?.approved_count ?? 0),
        convertedCount: Number(totalsRow?.converted_count ?? 0),
      },
    });
  }),
);

/* ── GET /inventory/auto-indents/stats ───────────────────────────────────────── */

router.get(
  '/auto-indents/stats',
  requirePermission('auto_indent.view'),
  validateQuery(autoIndentListSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof autoIndentListSchema>>(res);
    const b = buildAutoIndentFilter(q);
    const counts = await query<{ status: string; n: string }>(
      `SELECT ai.status, COUNT(*)::int AS n FROM auto_indents ai ${b.where()} GROUP BY ai.status`,
      b.params,
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));

    sendOk(res, {
      pending: (byStatus.PENDING_APPROVAL ?? 0) + (byStatus.STORE_APPROVED ?? 0),
      storeApproved: byStatus.STORE_APPROVED ?? 0,
      approved: (byStatus.PURCHASE_APPROVED ?? 0) + (byStatus.APPROVED ?? 0),
      converted: (byStatus.CONVERTED ?? 0) + (byStatus.ORDERED ?? 0),
      rejected: byStatus.REJECTED ?? 0,
      total: Object.values(byStatus).reduce((a, b) => a + b, 0),
    });
  }),
);

/* ── POST /inventory/auto-indents/:id/approve ───────────────────────────────── */

router.post(
  '/auto-indents/:id/approve',
  requirePermission('auto_indent.approve'),
  validateBody(z.object({ remarks: z.string().trim().max(500).optional() })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const roles = req.user!.roles;
    const isStoreUser = roles.includes('STORE_USER');
    const isPurchaseHead = roles.includes('PURCHASE_HEAD') || roles.includes('SUPER_ADMIN');

    const result = await withTransaction(async (tx) => {
      const ai = await txQueryOne<{
        id: number; item_code: string; status: string;
      }>(
        tx, 'SELECT id, item_code, status FROM auto_indents WHERE id = $1 FOR UPDATE', [id],
      );
      if (!ai) throw NotFoundError('Auto Indent');
      // A suggestion only moves forward: store approval, then purchase approval. Without
      // this check a rejected or converted suggestion could be approved again and then
      // converted a second time into a duplicate indent (2026-10-16 audit).
      const approvable = isStoreUser && !isPurchaseHead
        ? ['SUGGESTED', 'PENDING_APPROVAL']
        : ['SUGGESTED', 'PENDING_APPROVAL', 'STORE_APPROVED'];
      if (!approvable.includes(ai.status)) {
        throw BusinessRuleError(`Auto indent for ${ai.item_code} is ${ai.status.replace(/_/g, ' ').toLowerCase()} and cannot be approved now.`);
      }

      let nextStatus = 'APPROVED';
      if (isStoreUser && !isPurchaseHead) {
        nextStatus = 'STORE_APPROVED';
      } else {
        nextStatus = 'APPROVED';
      }

      await tx.query(
        `UPDATE auto_indents
            SET status = $2,
                approver_id = $3,
                approver_name = $4,
                approved_at = now(),
                updated_at = now()
          WHERE id = $1`,
        [id, nextStatus, req.user!.id, req.user!.employeeName],
      );

      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'APPROVE',
        entity: 'auto_indent',
        entityId: id,
        entityLabel: ai.item_code,
        before: { status: ai.status },
        after: { status: nextStatus },
        message: `Auto indent for ${ai.item_code} approved to ${nextStatus}.`,
      });

      return { id, itemCode: ai.item_code, status: nextStatus };
    });

    sendOk(res, {
      ...result,
      message: `Auto indent suggestion for ${result.itemCode} approved (${result.status.replace(/_/g, ' ')}).`,
    });
  }),
);

/* ── POST /inventory/auto-indents/:id/reject ────────────────────────────────── */

router.post(
  '/auto-indents/:id/reject',
  requirePermission('auto_indent.approve'),
  validateBody(z.object({ reason: z.string().trim().min(1, 'Rejection reason is required.').max(500) })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { reason } = req.body as { reason: string };

    const result = await withTransaction(async (tx) => {
      const ai = await txQueryOne<{ id: number; item_code: string; status: string }>(
        tx, 'SELECT id, item_code, status FROM auto_indents WHERE id = $1 FOR UPDATE', [id],
      );
      if (!ai) throw NotFoundError('Auto Indent');
      if (!['SUGGESTED', 'PENDING_APPROVAL', 'STORE_APPROVED', 'PURCHASE_APPROVED', 'APPROVED'].includes(ai.status)) {
        throw BusinessRuleError(`Auto indent for ${ai.item_code} is ${ai.status.replace(/_/g, ' ').toLowerCase()} and cannot be rejected now.`);
      }

      await tx.query(
        `UPDATE auto_indents
            SET status = 'REJECTED',
                rejection_reason = $2,
                approver_id = $3,
                approver_name = $4,
                updated_at = now()
          WHERE id = $1`,
        [id, reason, req.user!.id, req.user!.employeeName],
      );

      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'REJECT',
        entity: 'auto_indent',
        entityId: id,
        entityLabel: ai.item_code,
        before: { status: ai.status },
        after: { status: 'REJECTED', reason },
        message: `Auto indent for ${ai.item_code} rejected: ${reason}`,
      });

      return { id, itemCode: ai.item_code };
    });

    sendOk(res, {
      ...result,
      message: `Auto indent suggestion for ${result.itemCode} rejected.`,
    });
  }),
);

/* ── POST /inventory/auto-indents/:id/convert ───────────────────────────────── */

router.post(
  '/auto-indents/:id/convert',
  requirePermission('indent.create'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);

    const result = await withTransaction(async (tx) => {
      const ai = await txQueryOne<{
        id: number; item_id: number; item_code: string; item_name: string;
        suggested_qty: string; uom_id: number | null; department_id: number | null;
        cost_centre_id: number | null; status: string;
      }>(
        tx, 'SELECT * FROM auto_indents WHERE id = $1 FOR UPDATE', [id],
      );
      if (!ai) throw NotFoundError('Auto Indent');

      if (ai.status === 'CONVERTED' || ai.status === 'ORDERED') {
        throw BusinessRuleError(`Auto indent for ${ai.item_code} has already been converted.`);
      }
      // Only a fully approved suggestion becomes an indent; a pending or rejected one
      // could be converted before (no approval at all).
      if (ai.status !== 'APPROVED' && ai.status !== 'PURCHASE_APPROVED') {
        throw BusinessRuleError(`Auto indent for ${ai.item_code} must be approved before it is converted (it is ${ai.status.replace(/_/g, ' ').toLowerCase()}).`);
      }

      // Read item details
      const item = await txQueryOne<{
        id: number; item_code: string; item_description: string; uom_id: number | null;
        department_id: number | null; cost_centre_id: number | null; indent_type_id: number | null;
        standard_rate: string | null; item_specification: string | null;
      }>(
        tx, 'SELECT * FROM items WHERE id = $1', [ai.item_id],
      );
      if (!item) throw NotFoundError('Item');

      // Issue indent number
      const when = new Date();
      const indentNo = await nextDocumentNumber(tx, 'INDENT', when);
      const dateStrVal = dateStamp(when);
      const timeStrVal = timeStamp();

      const deptId = ai.department_id ?? item.department_id;
      const ccId = ai.cost_centre_id ?? item.cost_centre_id;

      if (!deptId) throw ValidationError('Cannot convert to indent: Department is missing.');
      if (!ccId) throw ValidationError('Cannot convert to indent: Cost Centre is mandatory.');

      const indentHeader = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_indent_headers
           (indent_no, indent_date, indent_time, indent_type_id, department_id,
            cost_centre_id, requested_by_user_id, status, remarks, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,'PENDING_APPROVAL','Auto-indent replenish converted', $7)
         RETURNING id`,
        [
          indentNo, dateStrVal, timeStrVal, item.indent_type_id, deptId,
          ccId, req.user!.id,
        ],
      );

      // Insert line
      await tx.query(
        `INSERT INTO purchase_indent_lines
           (indent_id, line_no, item_id, item_code, item_description, indent_qty,
            uom_id, item_specification, department_id, cost_centre_id, estimated_rate)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [
          indentHeader!.id, item.id, item.item_code, item.item_description,
          toQty(ai.suggested_qty), ai.uom_id ?? item.uom_id, item.item_specification ?? '',
          deptId, ccId, item.standard_rate ? toRate(item.standard_rate) : null,
        ],
      );

      // The new indent's approval history starts like any submitted indent's.
      await tx.query(
        `INSERT INTO indent_approvals (indent_id, action, actor_user_id, reason, from_status, to_status)
         VALUES ($1, 'SUBMIT', $2, $3, 'DRAFT', 'PENDING_APPROVAL')`,
        [indentHeader!.id, req.user!.id, `Converted from auto-indent suggestion for ${ai.item_code}`],
      );

      // Mark auto indent as converted
      await tx.query(
        `UPDATE auto_indents
            SET status = 'CONVERTED',
                indent_id = $2,
                indent_no = $3,
                updated_at = now()
          WHERE id = $1`,
        [id, indentHeader!.id, indentNo],
      );

      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'CREATE',
        entity: 'auto_indent',
        entityId: id,
        entityLabel: ai.item_code,
        after: { indentId: indentHeader!.id, indentNo },
        message: `Converted auto indent for ${ai.item_code} to Purchase Indent ${indentNo}.`,
      });

      return {
        autoIndentId: id,
        indentId: indentHeader!.id,
        indentNo,
        itemCode: ai.item_code,
        qty: ai.suggested_qty,
      };
    });

    sendOk(res, {
      ...result,
      message: `Successfully created Purchase Indent ${result.indentNo} for item ${result.itemCode}.`,
    });
  }),
);

/* ── Category Workspaces & Live Data Synchronization ───────────────────────── */

const categoryParam = z.enum(['RM', 'FG', 'TRADING', 'WIP', 'GENERAL']);

// 1. GET /inventory/categories/:category - Category Stock Register
/** A category workspace's stock-status rule. The status filters are the exact counterparts
    of the displayed status, so a row never shows a status its filter does not return. */
const CAT_CRITICAL = '(ii.live_stock_qty < 0 OR ii.available_qty < ii.min_stock_level OR (ii.min_stock_level > 0 AND ii.available_qty = 0))';
const CAT_BELOW = '(ii.available_qty <= ii.reorder_point AND ii.reorder_point > 0)';
const CAT_EXCESS = '(ii.reorder_point > 0 AND ii.available_qty > (ii.reorder_point * 2))';
const CAT_STATUS_SQL = `CASE
          WHEN ${CAT_CRITICAL} THEN 'CRITICAL'
          WHEN ${CAT_BELOW} THEN 'BELOW_REORDER'
          WHEN ${CAT_EXCESS} THEN 'EXCESS'
          ELSE 'NORMAL'
        END`;

const categoryListSchema = listQuerySchema.extend({
  status: z.enum(['ALL', 'NORMAL', 'BELOW_REORDER', 'CRITICAL', 'EXCESS', 'ZERO_STOCK', 'POSITIVE_STOCK']).default('ALL'),
  source: z.enum(['ALL', 'LIVE_SHEET', 'ERP_ONLY']).default('ALL'),
  mainGroup: z.string().trim().optional(),
  recon: z.enum(['MATCHED', 'MISMATCH', 'NOT_IN_SHEET', 'ERP_ONLY']).optional(),
});

/** The category register's WHERE clause, shared by the list and its export (the export
    ignored every filter: 'RM, zero stock' listed 504 rows and exported 933, 2026-10-16). */
function categoryItemFilter(category: string, q: z.infer<typeof categoryListSchema>): { b: SqlBuilder; whereClause: string } {
  const b = new SqlBuilder();
  let whereClause = `ii.category = ${b.push(category)} AND ii.deleted_at IS NULL`;
  if (q.search) {
    const s = b.push(`%${q.search}%`);
    whereClause += ` AND (ii.item_code ILIKE ${s} OR ii.item_description ILIKE ${s} OR ii.rack_id ILIKE ${s})`;
  }
  if (q.source === 'LIVE_SHEET') whereClause += ' AND ii.source_spreadsheet_id IS NOT NULL';
  else if (q.source === 'ERP_ONLY') whereClause += ' AND ii.source_spreadsheet_id IS NULL';
  if (q.mainGroup) whereClause += ` AND ii.main_group = ${b.push(q.mainGroup)}`;
  if (q.recon) whereClause += ` AND ii.recon_status = ${b.push(q.recon)}`;
  if (q.status === 'CRITICAL') whereClause += ` AND ${CAT_CRITICAL}`;
  else if (q.status === 'BELOW_REORDER') whereClause += ` AND NOT ${CAT_CRITICAL} AND ${CAT_BELOW}`;
  else if (q.status === 'EXCESS') whereClause += ` AND NOT ${CAT_CRITICAL} AND NOT ${CAT_BELOW} AND ${CAT_EXCESS}`;
  else if (q.status === 'NORMAL') whereClause += ` AND NOT ${CAT_CRITICAL} AND NOT ${CAT_BELOW} AND NOT ${CAT_EXCESS}`;
  else if (q.status === 'ZERO_STOCK') whereClause += ' AND ii.live_stock_qty = 0';
  else if (q.status === 'POSITIVE_STOCK') whereClause += ' AND ii.live_stock_qty > 0';
  return { b, whereClause };
}

router.get(
  '/categories/:category',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const rawCategory = (req.params.category || '').toUpperCase();
    const parseCat = categoryParam.safeParse(rawCategory);
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}". Must be one of: RM, FG, TRADING, WIP, GENERAL.`);
    }
    const category = parseCat.data;

    const q = categoryListSchema.parse(req.query);
    const { b, whereClause } = categoryItemFilter(category, q);

    const countSql = `SELECT COUNT(*)::int AS count FROM inventory_items ii WHERE ${whereClause}`;
    const totalRow = await queryOne<{ count: number }>(countSql, b.params);
    const total = totalRow?.count || 0;

    const sortCol = q.sortBy === 'item_code' ? 'ii.item_code'
      : q.sortBy === 'live_stock_qty' ? 'ii.live_stock_qty'
      : q.sortBy === 'available_qty' ? 'ii.available_qty'
      : 'ii.id';
    const sortDir = q.sortDir === 'asc' ? 'ASC' : 'DESC';

    const limitParam = b.push(q.pageSize);
    const offsetParam = b.push(offsetOf(q));

    const rowsSql = `
      SELECT
        ii.id,
        ii.item_id,
        ii.item_code,
        ii.item_description,
        ii.category,
        ii.primary_uom,
        ii.secondary_uom,
        ii.conversion_factor,
        ii.weight_per_1000pc_kg,
        ii.opening_stock_qty,
        ii.opening_weight_kg,
        ii.live_stock_qty,
        ii.live_weight_kg,
        ii.allocated_qty,
        ii.available_qty,
        ii.qc_hold_qty,
        ii.min_stock_level,
        ii.reorder_point,
        ii.rack_id,
        ii.main_group,
        ii.unit_price,
        ROUND((ii.live_stock_qty * COALESCE(ii.unit_price, 0)), 2) AS stock_valuation,
        ii.source_spreadsheet_id,
        ii.source_tab,
        ii.source_row_index,
        ii.last_sync_at,
        ii.sheet_adjustment_qty,
        ii.computed_stock_qty,
        ii.recon_status,
        ii.recon_note,
        ${CAT_STATUS_SQL} AS stock_status
      FROM inventory_items ii
      WHERE ${whereClause}
      ORDER BY ${sortCol} ${sortDir}
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const rows = await query<any>(rowsSql, b.params);
    sendPage(res, rows, total, q.page, q.pageSize);
  }),
);

// 2. GET /inventory/categories/:category/summary - Category Metric Cards
router.get(
  '/categories/:category/summary',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const rawCategory = (req.params.category || '').toUpperCase();
    const parseCat = categoryParam.safeParse(rawCategory);
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}".`);
    }
    const category = parseCat.data;

    const sql = `
      SELECT
        COUNT(*)::int AS total_items,
        -- "In the sheet" = listed in the live-stock tab at the last sync.
        COUNT(CASE WHEN source_row_index IS NOT NULL THEN 1 END)::int AS sheet_items_count,
        COUNT(CASE WHEN source_spreadsheet_id IS NULL THEN 1 END)::int AS unsynced_items_count,
        COALESCE(SUM(live_stock_qty), 0)::numeric(18, 4) AS total_stock_qty,
        COALESCE(SUM(CASE WHEN source_row_index IS NOT NULL THEN live_stock_qty ELSE 0 END), 0)::numeric(18, 4) AS sheet_stock_qty,
        COALESCE(SUM(live_weight_kg), 0)::numeric(18, 4) AS total_weight_kg,
        COALESCE(SUM(live_stock_qty * COALESCE(unit_price, 0)), 0)::numeric(18, 2) AS total_valuation,
        COUNT(CASE WHEN live_stock_qty = 0 THEN 1 END)::int AS zero_stock_count,
        COUNT(CASE WHEN live_stock_qty > 0 THEN 1 END)::int AS positive_stock_count,
        COUNT(CASE WHEN available_qty < min_stock_level OR (min_stock_level > 0 AND available_qty = 0) THEN 1 END)::int AS critical_count,
        COUNT(CASE WHEN available_qty <= reorder_point AND reorder_point > 0 AND NOT (available_qty < min_stock_level) THEN 1 END)::int AS below_reorder_count,
        COUNT(CASE WHEN allocated_qty > 0 THEN 1 END)::int AS reserved_items_count,
        COALESCE(SUM(allocated_qty), 0)::numeric(18, 4) AS total_allocated_qty,
        MAX(last_sync_at) AS last_sync_at
      FROM inventory_items
      WHERE category = $1 AND deleted_at IS NULL
    `;

    const stats = await queryOne<any>(sql, [category]);

    // Last sync run for the category (its "(all tabs)" summary row).
    const lastCheck = await queryOne<any>(
      `SELECT id, category, spreadsheet_id, tab_name, total_rows_read, valid_records_imported, quarantined_records,
              status, error_message, sync_duration_ms, created_at, run_id
         FROM inventory_sync_checkpoints
        WHERE category = $1 AND (tab_name = '(all tabs)' OR run_id IS NULL)
        ORDER BY id DESC LIMIT 1`,
      [category],
    );

    // Check quarantined count
    const quarantineCount = await queryOne<{ count: string }>(
      `SELECT COUNT(*)::int AS count FROM inventory_quarantine WHERE category = $1 AND resolution_status = 'PENDING'`,
      [category],
    );

    // Movement counts: POSTED entries only (reversed ones are history, not stock), with the
    // Google Sheet rows and the movements entered in the ERP counted separately, so a card
    // can never silently disagree with the sheet's own row count. Stock adjustments are
    // counted on their own, not as inward/outward.
    const txnStats = await queryOne<any>(
      `SELECT
         COUNT(*) FILTER (WHERE direction = 'IN'  AND txn_type <> 'SHEET_ADJUSTMENT')::int AS inward_count,
         COALESCE(SUM(quantity) FILTER (WHERE direction = 'IN'  AND txn_type <> 'SHEET_ADJUSTMENT'), 0)::numeric(18, 4) AS inward_qty,
         COUNT(*) FILTER (WHERE direction = 'OUT' AND txn_type <> 'SHEET_ADJUSTMENT')::int AS outward_count,
         COALESCE(SUM(quantity) FILTER (WHERE direction = 'OUT' AND txn_type <> 'SHEET_ADJUSTMENT'), 0)::numeric(18, 4) AS outward_qty,
         COUNT(*) FILTER (WHERE direction = 'IN'  AND origin = 'SHEET' AND txn_type <> 'SHEET_ADJUSTMENT')::int AS sheet_inward_count,
         COUNT(*) FILTER (WHERE direction = 'OUT' AND origin = 'SHEET' AND txn_type <> 'SHEET_ADJUSTMENT')::int AS sheet_outward_count,
         COUNT(*) FILTER (WHERE direction = 'IN'  AND origin = 'ERP')::int AS erp_inward_count,
         COUNT(*) FILTER (WHERE direction = 'OUT' AND origin = 'ERP')::int AS erp_outward_count,
         COUNT(*) FILTER (WHERE direction = 'ADJUST' OR txn_type = 'SHEET_ADJUSTMENT')::int AS adjustment_count,
         COUNT(*) FILTER (WHERE txn_type = 'PRODUCTION_INWARD')::int AS prod_inward_count,
         COALESCE(SUM(quantity) FILTER (WHERE txn_type = 'PRODUCTION_INWARD'), 0)::numeric(18, 4) AS prod_inward_qty
       FROM inventory_transactions
       WHERE category = $1 AND status = 'POSTED'`,
      [category],
    );
    const reversedCount = await queryOne<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM inventory_transactions WHERE category = $1 AND status = 'REVERSED'`,
      [category],
    );
    const recon = await queryOne<{ matched: number; mismatched: number; not_in_sheet: number; erp_only: number }>(
      `SELECT COUNT(*) FILTER (WHERE recon_status = 'MATCHED')::int      AS matched,
              COUNT(*) FILTER (WHERE recon_status = 'MISMATCH')::int     AS mismatched,
              COUNT(*) FILTER (WHERE recon_status = 'NOT_IN_SHEET')::int AS not_in_sheet,
              COUNT(*) FILTER (WHERE recon_status = 'ERP_ONLY')::int     AS erp_only
         FROM inventory_items WHERE category = $1 AND deleted_at IS NULL`,
      [category],
    );

    // Main groups breakdown
    const mainGroups = await query<{ main_group: string; count: number; total_qty: string }>(
      `SELECT main_group, COUNT(*)::int AS count, COALESCE(SUM(live_stock_qty), 0)::numeric(18, 4) AS total_qty
       FROM inventory_items
       WHERE category = $1 AND deleted_at IS NULL AND main_group IS NOT NULL AND main_group <> ''
       GROUP BY main_group
       ORDER BY count DESC
       LIMIT 10`,
      [category],
    );

    sendOk(res, {
      category,
      stats: {
        totalItems: stats?.total_items || 0,
        sheetItemsCount: stats?.sheet_items_count || 0,
        unsyncedItemsCount: stats?.unsynced_items_count || 0,
        totalStockQty: Number(stats?.total_stock_qty || 0),
        sheetStockQty: Number(stats?.sheet_stock_qty || 0),
        totalWeightKg: Number(stats?.total_weight_kg || 0),
        totalWeightTon: Number((Number(stats?.total_weight_kg || 0) / 1000).toFixed(2)),
        totalValuation: Number(stats?.total_valuation || 0),
        valuationLakhs: Number((Number(stats?.total_valuation || 0) / 100000).toFixed(2)),
        valuationCr: Number((Number(stats?.total_valuation || 0) / 10000000).toFixed(2)),
        zeroStockCount: stats?.zero_stock_count || 0,
        positiveStockCount: stats?.positive_stock_count || 0,
        criticalCount: stats?.critical_count || 0,
        belowReorderCount: stats?.below_reorder_count || 0,
        reservedItemsCount: stats?.reserved_items_count || 0,
        totalAllocatedQty: Number(stats?.total_allocated_qty || 0),
        quarantinedCount: Number(quarantineCount?.count || 0),
        inwardTxnCount: txnStats?.inward_count || 0,
        inwardTxnQty: Number(txnStats?.inward_qty || 0),
        outwardTxnCount: txnStats?.outward_count || 0,
        outwardTxnQty: Number(txnStats?.outward_qty || 0),
        sheetInwardTxnCount: txnStats?.sheet_inward_count || 0,
        sheetOutwardTxnCount: txnStats?.sheet_outward_count || 0,
        erpInwardTxnCount: txnStats?.erp_inward_count || 0,
        erpOutwardTxnCount: txnStats?.erp_outward_count || 0,
        adjustmentTxnCount: txnStats?.adjustment_count || 0,
        reversedTxnCount: reversedCount?.count || 0,
        prodInwardTxnCount: txnStats?.prod_inward_count || 0,
        prodInwardTxnQty: Number(txnStats?.prod_inward_qty || 0),
        reconMatchedCount: recon?.matched || 0,
        reconMismatchCount: recon?.mismatched || 0,
        notInSheetCount: recon?.not_in_sheet || 0,
        erpOnlyItemsCount: recon?.erp_only || 0,
        lastSyncAt: stats?.last_sync_at,
      },
      mainGroups: mainGroups.map((m) => ({
        name: m.main_group,
        count: m.count,
        totalQty: Number(m.total_qty),
      })),
      lastSync: lastCheck || null,
    });
  }),
);

// 2b. GET /inventory/categories/:category/export - Export Category Register to CSV
router.get(
  '/categories/:category/export',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const rawCategory = (req.params.category || '').toUpperCase();
    const parseCat = categoryParam.safeParse(rawCategory);
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}".`);
    }
    const category = parseCat.data;
    const q = categoryListSchema.parse(req.query);
    const { b, whereClause } = categoryItemFilter(category, q);

    const rows = await query<any>(
      `SELECT
         ii.item_code,
         ii.item_description,
         ii.main_group,
         ii.primary_uom,
         ii.rack_id,
         ii.live_stock_qty,
         ii.live_weight_kg,
         ii.weight_per_1000pc_kg,
         ii.unit_price,
         ROUND((ii.live_stock_qty * COALESCE(ii.unit_price, 0)), 2) AS valuation,
         ${CAT_STATUS_SQL} AS stock_status,
         CASE WHEN ii.source_spreadsheet_id IS NOT NULL THEN 'LIVE_SHEET' ELSE 'ERP_ONLY' END AS origin,
         ii.source_tab,
         ii.source_row_index,
         ii.last_sync_at
       FROM inventory_items ii
       WHERE ${whereClause}
       ORDER BY ii.item_code ASC`,
      b.params,
    );

    const headers = [
      'Item Code', 'Description', 'Main Group', 'UOM', 'Rack ID',
      'Live Stock Qty', 'Live Weight (Kg)', '1000pc Wt (Kg)', 'Unit Rate (Rs)',
      'Valuation (Rs)', 'Stock Status', 'Data Source', 'Source Tab', 'Source Row', 'Last Sync At'
    ];

    const lines = [headers.join(',')];
    for (const r of rows) {
      lines.push([
        `"${(r.item_code || '').replace(/"/g, '""')}"`,
        `"${(r.item_description || '').replace(/"/g, '""')}"`,
        `"${(r.main_group || '').replace(/"/g, '""')}"`,
        `"${r.primary_uom || ''}"`,
        `"${(r.rack_id || '').replace(/"/g, '""')}"`,
        r.live_stock_qty ?? 0,
        r.live_weight_kg ?? '',
        r.weight_per_1000pc_kg ?? '',
        r.unit_price ?? 0,
        r.valuation ?? 0,
        r.stock_status,
        r.origin,
        `"${r.source_tab || ''}"`,
        r.source_row_index || '',
        r.last_sync_at ? new Date(r.last_sync_at).toISOString() : '',
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="inventory_${category.toLowerCase()}_${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send(lines.join('\r\n'));
  }),
);

// 2c. GET /inventory/quarantine - View Quarantined Data Records
router.get(
  '/quarantine',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    // Defaults to the open entries — the same set the category card counts.
    const q = listQuerySchema.extend({
      category: categoryParam.optional(),
      status: z.enum(['PENDING', 'RESOLVED', 'IGNORED', 'ALL']).default('PENDING'),
      reasonCode: z.string().trim().max(40).optional(),
      sourceTab: z.string().trim().max(120).optional(),
    }).parse(req.query);

    const b = new SqlBuilder();
    let whereClause = '1=1';

    if (q.category) {
      const c = b.push(q.category);
      whereClause += ` AND category = ${c}`;
    }

    if (q.status !== 'ALL') {
      const s = b.push(q.status);
      whereClause += ` AND resolution_status = ${s}`;
    }

    if (q.reasonCode) {
      const r = b.push(q.reasonCode);
      whereClause += ` AND reason_code = ${r}`;
    }

    if (q.sourceTab) {
      const t = b.push(q.sourceTab);
      whereClause += ` AND TRIM(source_tab) = TRIM(${t})`;
    }

    if (q.search) {
      const s = b.push(`%${q.search}%`);
      whereClause += ` AND (quarantine_reason ILIKE ${s} OR raw_data::text ILIKE ${s})`;
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM inventory_quarantine WHERE ${whereClause}`;
    const totalRow = await queryOne<{ count: number }>(countSql, b.params);
    const total = totalRow?.count || 0;

    const limitParam = b.push(q.pageSize);
    const offsetParam = b.push(offsetOf(q));

    const rowsSql = `
      SELECT id, category, source_tab, source_row_index, raw_data, quarantine_reason, reason_code,
             resolution_status, resolution_note, created_at, last_seen_at, resolved_at
      FROM inventory_quarantine
      WHERE ${whereClause}
      ORDER BY category, source_tab, source_row_index, id
      LIMIT ${limitParam} OFFSET ${offsetParam}
    `;

    const rows = await query<any>(rowsSql, b.params);
    // Per-reason counts for the same filter minus the reason itself (the filter chips).
    const rb = new SqlBuilder();
    let reasonWhere = '1=1';
    if (q.category) reasonWhere += ` AND category = ${rb.push(q.category)}`;
    if (q.status !== 'ALL') reasonWhere += ` AND resolution_status = ${rb.push(q.status)}`;
    if (q.sourceTab) reasonWhere += ` AND TRIM(source_tab) = TRIM(${rb.push(q.sourceTab)})`;
    const byReason = await query<{ reason_code: string | null; count: number }>(
      `SELECT reason_code, COUNT(*)::int AS count FROM inventory_quarantine
        WHERE ${reasonWhere} GROUP BY reason_code ORDER BY count DESC`,
      rb.params,
    );
    sendPage(res, rows, total, q.page, q.pageSize, {
      byReason: byReason.map((r) => ({
        reasonCode: r.reason_code,
        label: r.reason_code ? (EXCLUSION_TEXT as Record<string, string>)[r.reason_code] ?? r.reason_code : 'Earlier sync (no reason code)',
        count: r.count,
      })),
    });
  }),
);

// 3. GET /inventory/categories/:category/transactions - Category Movement Ledger
router.get(
  '/categories/:category/transactions',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const rawCategory = (req.params.category || '').toUpperCase();
    const parseCat = categoryParam.safeParse(rawCategory);
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}".`);
    }
    const category = parseCat.data;

    const q = listQuerySchema.extend({
      direction: z.enum(['IN', 'OUT', 'ADJUST']).optional(),
      txnType: z.string().trim().optional(),
      itemCode: z.string().trim().optional(),
      sourceTab: z.string().trim().optional(),
      dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      // POSTED by default — the entries that make up stock (and what the cards count).
      status: z.enum(['POSTED', 'REVERSED', 'ALL']).default('POSTED'),
      origin: z.enum(['SHEET', 'ERP']).optional(),
    }).parse(req.query);

    const b = new SqlBuilder();
    const catP = b.push(category);
    let whereClause = `category = ${catP}`;
    if (q.status !== 'ALL') whereClause += ` AND status = ${b.push(q.status)}`;
    if (q.origin) whereClause += ` AND origin = ${b.push(q.origin)}`;

    if (q.direction) {
      const dp = b.push(q.direction);
      whereClause += ` AND direction = ${dp}`;
    }

    if (q.sourceTab) {
      const st = b.push(q.sourceTab.trim());
      whereClause += ` AND (TRIM(source_tab) = ${st} OR source_tab ILIKE ${st} OR TRIM(source_tab) ILIKE '%' || ${st} || '%')`;
    }

    if (q.search) {
      const s = b.push(`%${q.search}%`);
      whereClause += ` AND (item_code ILIKE ${s} OR reference_doc_no ILIKE ${s} OR txn_no ILIKE ${s} OR notes ILIKE ${s})`;
    }
    if (q.itemCode) {
      const ic = b.push(q.itemCode);
      whereClause += ` AND UPPER(item_code) = UPPER(${ic})`;
    }
    if (q.txnType) {
      const tt = b.push(q.txnType);
      whereClause += ` AND txn_type = ${tt}`;
    }
    if (q.dateFrom) {
      const df = b.push(q.dateFrom);
      whereClause += ` AND txn_date >= ${df}::date`;
    }
    if (q.dateTo) {
      const dt = b.push(q.dateTo);
      whereClause += ` AND txn_date <= ${dt}::date`;
    }

    const countSql = `SELECT COUNT(*)::int AS count FROM inventory_transactions WHERE ${whereClause}`;
    const totalRow = await queryOne<{ count: number }>(countSql, b.params);
    const total = totalRow?.count || 0;

    const limitP = b.push(q.pageSize);
    const offsetP = b.push(offsetOf(q));

    const rowsSql = `
      SELECT
        id, txn_no, category, item_id, item_code, txn_type, direction,
        quantity, weight_kg, uom, rate, amount,
        balance_qty_after, balance_weight_after,
        reference_doc_type, reference_doc_no,
        from_location, to_location, department,
        source_tab, source_row_index, source_month, origin, reversed_at, reversal_reason,
        status, notes, created_by_name, txn_date, created_at
      FROM inventory_transactions
      WHERE ${whereClause}
      ORDER BY txn_date DESC, source_row_index DESC NULLS FIRST, id DESC
      LIMIT ${limitP} OFFSET ${offsetP}
    `;

    const rows = await query<any>(rowsSql, b.params);
    sendPage(res, rows, total, q.page, q.pageSize);
  }),
);

// 4. POST /inventory/categories/:category/transactions - Post Atomic Category Movement
router.post(
  '/categories/:category/transactions',
  requirePermission('inventory.adjust'),
  asyncHandler(async (req, res) => {
    const rawCategory = (req.params.category || '').toUpperCase();
    const parseCat = categoryParam.safeParse(rawCategory);
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}".`);
    }
    const category = parseCat.data;

    const bodySchema = z.object({
      itemId: z.number().int().positive(),
      txnType: z.string().trim().min(1),
      direction: z.enum(['IN', 'OUT', 'ADJUST']),
      quantity: z.number().positive(),
      weightKg: z.number().optional().nullable(),
      uom: z.string().trim().default('Nos'),
      rate: z.number().optional().nullable(),
      amount: z.number().optional().nullable(),
      referenceDocType: z.string().optional().nullable(),
      referenceDocNo: z.string().optional().nullable(),
      fromLocation: z.string().optional().nullable(),
      toLocation: z.string().optional().nullable(),
      department: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
    });

    const parsed = bodySchema.parse(req.body);
    const actor = actorFrom(req);

    const result = await withTransaction(async (tx) => {
      const r = await recordInventoryMovement(tx, {
        ...parsed,
        category,
        userId: actor.userId,
        userName: actor.name,
      });
      await auditIn(tx, {
        actor,
        action: 'CREATE',
        entity: 'inventory_movement',
        entityLabel: r.txnNo,
        after: { category, itemCode: r.itemCode, direction: parsed.direction, txnType: parsed.txnType, quantity: r.quantity, balanceAfter: r.balanceQtyAfter },
        message: `${parsed.direction} ${r.quantity} ${parsed.uom} of ${r.itemCode} (${category}, ${parsed.txnType}) recorded as ${r.txnNo}.`,
      });
      return r;
    });

    sendCreated(res, {
      ...result,
      message: `Transaction ${result.txnNo} recorded successfully. New balance: ${result.balanceQtyAfter} ${parsed.uom}.`,
    });
  }),
);

// 5/6. POST /inventory/sync/:category and /inventory/sync-all — read the Google Sheets now.
//   dryRun=true            : do the whole run, report what WOULD change, change nothing.
//   applyLargeChanges=true : apply a tab the safety valve blocked (Super Admin only).
const syncBody = z.object({
  dryRun: z.boolean().default(false),
  applyLargeChanges: z.boolean().default(false),
}).default({});

async function runSync(
  req: Request,
  scope: InventoryCategory | 'ALL',
): Promise<CategorySyncResult[]> {
  const body = syncBody.parse(req.body ?? {});
  if (body.applyLargeChanges && !req.user!.roles.includes('SUPER_ADMIN')) {
    throw AuthorizationError('Only a Super Admin can apply a sync that the safety check stopped.');
  }
  const opts = { dryRun: body.dryRun, applyLargeChanges: body.applyLargeChanges, userId: req.user!.id };
  let results: CategorySyncResult[];
  try {
    results = scope === 'ALL' ? await syncAllInventoryCategories(opts) : [await syncCategoryFromSheet(scope, opts)];
  } catch (err) {
    if ((err as { code?: string }).code === 'SYNC_RUNNING') throw ConflictError((err as Error).message);
    throw err;
  }
  if (!body.dryRun) {
    const line = (r: CategorySyncResult) =>
      `${r.category} ${r.status}: +${r.transactionsImported} new, ` +
      `${r.tabs.reduce((a, t) => a + t.reversed, 0)} reversed, ${r.quarantinedRecords} not counted, ` +
      `items matched ${r.reconciliation.matched}/${r.reconciliation.checked}`;
    await audit({
      actor: actorFrom(req), action: 'SYNC', entity: 'inventory_sync', entityLabel: results[0]?.runId,
      after: results.map((r) => ({ category: r.category, status: r.status, runId: r.runId })),
      message: `Inventory sync from Google Sheets${body.applyLargeChanges ? ' (large changes applied)' : ''} — ${results.map(line).join('; ')}.`,
    });
  }
  return results;
}

router.post(
  '/sync/:category',
  requirePermission('inventory.adjust'),
  asyncHandler(async (req, res) => {
    const parseCat = categoryParam.safeParse((req.params.category || '').toUpperCase());
    if (!parseCat.success) {
      throw ValidationError(`Invalid inventory category "${req.params.category}".`);
    }
    const [result] = await runSync(req, parseCat.data);
    sendOk(res, result);
  }),
);

router.post(
  '/sync-all',
  requirePermission('inventory.adjust'),
  asyncHandler(async (req, res) => {
    sendOk(res, await runSync(req, 'ALL'));
  }),
);

// 7. GET /inventory/sync/status — the latest run per category with its per-tab reconciliation report.
router.get(
  '/sync/status',
  requirePermission('inventory.view'),
  asyncHandler(async (_req, res) => {
    const runs = await query<any>(`
      SELECT DISTINCT ON (category)
        id, category, spreadsheet_id, tab_name, total_rows_read,
        valid_records_imported, quarantined_records, status, error_message,
        sync_duration_ms, created_at, run_id, report
      FROM inventory_sync_checkpoints
      WHERE tab_name = '(all tabs)' OR run_id IS NULL
      ORDER BY category, id DESC
    `);
    const runIds = runs.map((r) => r.run_id).filter(Boolean);
    const tabs = runIds.length
      ? await query<any>(
          `SELECT category, run_id, tab_name, total_rows_read, valid_records_imported, quarantined_records,
                  status, error_message, report
             FROM inventory_sync_checkpoints
            WHERE run_id = ANY($1::text[]) AND tab_name <> '(all tabs)'
            ORDER BY id`,
          [runIds],
        )
      : [];
    sendOk(res, {
      running: activeInventorySync(),
      categories: runs.map((r) => ({
        ...r,
        tabs: tabs.filter((t) => t.category === r.category && t.run_id === r.run_id),
      })),
    });
  }),
);

// 8. GET /inventory/reconciliation — item-by-item proof against the sheet's own live stock.
router.get(
  '/reconciliation',
  requirePermission('inventory.view'),
  asyncHandler(async (req, res) => {
    const q = listQuerySchema.extend({
      category: categoryParam.optional(),
      status: z.enum(['MATCHED', 'MISMATCH', 'NOT_IN_SHEET', 'ERP_ONLY', 'ALL']).default('MISMATCH'),
    }).parse(req.query);
    const b = new SqlBuilder();
    let where = 'ii.deleted_at IS NULL';
    if (q.category) where += ` AND ii.category = ${b.push(q.category)}`;
    if (q.status !== 'ALL') where += ` AND ii.recon_status = ${b.push(q.status)}`;
    if (q.search) {
      const s = b.push(`%${q.search}%`);
      where += ` AND (ii.item_code ILIKE ${s} OR ii.item_description ILIKE ${s})`;
    }
    const total = (await queryOne<{ count: number }>(`SELECT COUNT(*)::int AS count FROM inventory_items ii WHERE ${where}`, b.params))?.count ?? 0;
    const counts = await query<{ category: string; recon_status: string | null; count: number }>(
      `SELECT category, recon_status, COUNT(*)::int AS count FROM inventory_items
        WHERE deleted_at IS NULL GROUP BY category, recon_status ORDER BY category, recon_status`,
    );
    const lim = b.push(q.pageSize);
    const off = b.push(offsetOf(q));
    const rows = await query<any>(
      `SELECT ii.id, ii.category, ii.item_code, ii.item_description, ii.primary_uom,
              ii.opening_stock_qty, ii.live_stock_qty AS sheet_live_stock_qty, ii.computed_stock_qty,
              (ii.live_stock_qty - ii.computed_stock_qty) AS difference, ii.sheet_adjustment_qty,
              ii.recon_status, ii.recon_note, ii.recon_checked_at, ii.source_tab, ii.source_row_index, ii.sheet_row_count
         FROM inventory_items ii
        WHERE ${where}
        ORDER BY ABS(COALESCE(ii.live_stock_qty - ii.computed_stock_qty, 0)) DESC, ii.category, ii.item_code
        LIMIT ${lim} OFFSET ${off}`,
      b.params,
    );
    sendPage(res, rows, total, q.page, q.pageSize, { counts });
  }),
);

export default router;
