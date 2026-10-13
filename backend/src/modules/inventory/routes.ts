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
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam, csvIdArray, toKolkataStartOfDay, toKolkataEndOfDay,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { actorFrom, auditIn } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import { toQty, toRate } from '../../domain/money.js';
import { toShortUom } from '../../domain/uom.js';
import directIssueRoutes from './direct-issue.routes.js';

const router = Router();
router.use('/direct-issues', directIssueRoutes);

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── GET /inventory/stock ───────────────────────────────────────────────────── */

const stockQuerySchema = listQuerySchema.extend({
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  itemTypeId: csvIdArray,
  mainGroupId: csvIdArray,
  subMainGroupId: csvIdArray,
  itemId: csvIdArray,
  hodId: csvIdArray,
  stockStatus: z.enum(['ALL', 'NORMAL', 'BELOW_REORDER', 'CRITICAL', 'EXCESS']).default('ALL'),
});

router.get(
  '/stock',
  requirePermission('auto_indent.view'),
  validateQuery(stockQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof stockQuerySchema>>(res);
    const b = new SqlBuilder();

    b.addRaw('i.deleted_at IS NULL AND i.is_active = TRUE');
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
               CASE
                 WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                      OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0)
                   THEN 'CRITICAL'
                 WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0)
                      AND COALESCE(i.reorder_level, 0) > 0
                   THEN 'BELOW_REORDER'
                 WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                      AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock
                   THEN 'EXCESS'
                 ELSE 'NORMAL'
               END AS stock_status
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
    }>(
      `SELECT
         COUNT(*) AS total_active,
         COUNT(CASE WHEN t.stock_status = 'NORMAL' THEN 1 END) AS normal_stock,
         COUNT(CASE WHEN t.stock_status = 'BELOW_REORDER' THEN 1 END) AS below_reorder,
         COUNT(CASE WHEN t.stock_status = 'CRITICAL' THEN 1 END) AS critical_stock,
         COUNT(CASE WHEN t.stock_status = 'EXCESS' THEN 1 END) AS excess_stock
       FROM (
         SELECT i.id,
                CASE
                  WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                       OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0)
                    THEN 'CRITICAL'
                  WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0)
                       AND COALESCE(i.reorder_level, 0) > 0
                    THEN 'BELOW_REORDER'
                  WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                       AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock
                    THEN 'EXCESS'
                  ELSE 'NORMAL'
                END AS stock_status
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
               CASE
                 WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                      OR (COALESCE(i.min_stock, 0) > 0 AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) = 0)
                   THEN 'CRITICAL'
                 WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0)
                      AND COALESCE(i.reorder_level, 0) > 0
                   THEN 'BELOW_REORDER'
                 WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                      AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock
                   THEN 'EXCESS'
                 ELSE 'NORMAL'
               END AS stock_status
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
      },
    });
  }),
);

/* ── GET /inventory/stock/export ────────────────────────────────────────────── */

router.get(
  '/stock/export',
  requirePermission('auto_indent.view'),
  validateQuery(stockQuerySchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof stockQuerySchema>>(res);
    const b = new SqlBuilder();

    b.addRaw('i.deleted_at IS NULL AND i.is_active = TRUE');
    b.addIn('i.department_id', q.departmentId);
    b.addIn('i.cost_centre_id', q.costCentreId);
    b.addIn('i.item_type_id', q.itemTypeId);
    b.addIn('i.main_group_id', q.mainGroupId);
    b.addIn('i.sub_main_group_id', q.subMainGroupId);

    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p} OR lower(i.hsn_code) LIKE ${p})`,
      );
    }

    const selectSql = `
      SELECT i.item_code, i.item_description,
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
             CASE
               WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) < COALESCE(i.min_stock, 0)
                 THEN 'CRITICAL'
               WHEN GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) <= COALESCE(i.reorder_level, 0)
                 THEN 'BELOW_REORDER'
               WHEN i.max_stock IS NOT NULL AND i.max_stock > 0
                    AND GREATEST(0, i.live_stock_qty - COALESCE(req.allocated_qty, 0)) > i.max_stock
                 THEN 'EXCESS'
               ELSE 'NORMAL'
             END AS stock_status
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
       ${b.where()}
       ORDER BY i.item_code ASC
       LIMIT 5000
    `;

    const rows = await query<Record<string, unknown>>(selectSql, b.params);

    const headers = [
      'Item Code', 'Item Description', 'UOM', 'Department', 'Cost Centre',
      'Live Stock', 'Allocated Stock', 'Available Stock', 'Reorder Level',
      'Reorder Qty', 'Min Stock', 'Max Stock', 'Pending Indents', 'Pending POs', 'Status',
    ];

    const csvRows = [headers.join(',')];
    for (const r of rows) {
      csvRows.push([
        `"${String(r.item_code).replace(/"/g, '""')}"`,
        `"${String(r.item_description).replace(/"/g, '""')}"`,
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
        r.stock_status,
      ].join(','));
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="stock_and_reorder.csv"');
    res.status(200).send(csvRows.join('\r\n'));
  }),
);

/* ── POST /inventory/auto-indent/generate ───────────────────────────────────── */

router.post(
  '/auto-indent/generate',
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

export default router;
