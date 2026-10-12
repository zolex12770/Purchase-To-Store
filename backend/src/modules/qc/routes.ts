/**
 * Quality Control (QC) Inspection Module (Requirement 10).
 *
 * Post-GRN QC inspection lifecycle:
 * - Material with `qc_required = true` is held in QC before entering usable stock.
 * - Inspectors record test findings, accepted/rejected quantities, and dispositions.
 * - On QC Passed / Accepted with Deviation, accepted quantity is released into live stock.
 * - On QC Rejected, rejected quantity remains isolated and routed for RTV/Scrap.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { actorFrom, auditIn } from '../../core/audit.js';
import { inwardGrnLine, type GrnLineForStock } from '../../domain/stock.js';
import { toQty, dec } from '../../domain/money.js';

const router = Router();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── GET /qc/stats ──────────────────────────────────────────────────────────── */

const statsSchema = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  inspectorId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
});

router.get(
  '/stats',
  requirePermission('qc.view'),
  validateQuery(statsSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof statsSchema>>(res);
    const b = new SqlBuilder();
    if (q.supplierId) b.add('supplier_id = ?', q.supplierId);
    if (q.itemId) b.add('item_id = ?', q.itemId);
    const inspector = q.inspectorId || q.userId;
    if (inspector) b.add('inspector_id = ?', inspector);
    if (q.dateFrom) b.add('created_at >= ?::timestamptz', `${q.dateFrom} 00:00:00Z`);
    if (q.dateTo) b.add('created_at <= ?::timestamptz', `${q.dateTo} 23:59:59Z`);

    const counts = await query<{ status: string; n: string }>(
      `SELECT status, COUNT(*)::int AS n FROM qc_inspections ${b.where()} GROUP BY status`,
      b.params,
    );
    const byStatus = Object.fromEntries(counts.map((c) => [c.status, Number(c.n)]));

    const total = await queryOne<{ total: string }>(
      `SELECT COUNT(*)::int AS total FROM qc_inspections ${b.where()}`,
      b.params,
    );

    sendOk(res, {
      total: Number(total?.total ?? 0),
      pending: byStatus.PENDING_QC ?? 0,
      inProgress: byStatus.QC_IN_PROGRESS ?? 0,
      passed: (byStatus.QC_PASSED ?? 0) + (byStatus.ACCEPTED_WITH_DEVIATION ?? 0),
      failed: byStatus.QC_FAILED ?? 0,
      onHold: byStatus.ON_HOLD ?? 0,
    });
  }),
);

/* ── GET /qc/inspections ────────────────────────────────────────────────────── */

const listSchema = listQuerySchema.extend({
  status: z.string().optional(),
  grnNo: z.string().optional(),
  itemCode: z.string().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  supplierId: z.coerce.number().int().positive().optional(),
  inspectorId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
});

router.get(
  '/inspections',
  requirePermission('qc.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = new SqlBuilder();

    if (q.status) {
      const statuses = q.status.split(',').map((s) => s.trim()).filter(Boolean);
      if (statuses.length > 0) b.addIn('qi.status', statuses);
    }
    if (q.grnNo) {
      const p = b.push(`%${q.grnNo.toLowerCase()}%`);
      b.addRaw(`lower(qi.grn_no) LIKE ${p}`);
    }
    if (q.itemCode) {
      const p = b.push(`%${q.itemCode.toLowerCase()}%`);
      b.addRaw(`lower(qi.item_code) LIKE ${p}`);
    }
    if (q.itemId) b.add('qi.item_id = ?', q.itemId);
    if (q.supplierId) b.add('qi.supplier_id = ?', q.supplierId);
    const inspector = q.inspectorId || q.userId;
    if (inspector) b.add('qi.inspector_id = ?', inspector);
    if (q.dateFrom) b.add('qi.created_at >= ?::timestamptz', `${q.dateFrom} 00:00:00Z`);
    if (q.dateTo) b.add('qi.created_at <= ?::timestamptz', `${q.dateTo} 23:59:59Z`);

    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(qi.grn_no) LIKE ${p} OR lower(qi.item_code) LIKE ${p} OR ` +
        `lower(qi.item_name) LIKE ${p} OR lower(qi.supplier_name) LIKE ${p})`,
      );
    }

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM qc_inspections qi ${b.where()}`,
      b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT qi.id, qi.grn_id, qi.grn_line_id, qi.grn_no, qi.item_id, qi.item_code,
              qi.item_name, qi.supplier_id, qi.supplier_name, qi.received_qty,
              qi.accepted_qty, qi.rejected_qty, qi.uom_id, qi.uom_code, qi.status,
              qi.inspector_id, qi.inspector_name, qi.inspection_date, qi.remarks,
              qi.rejection_reason, qi.next_action, qi.created_at, qi.updated_at
         FROM qc_inspections qi
         ${b.where()}
        ORDER BY qi.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize);
  }),
);

/* ── GET /qc/inspections/:id ────────────────────────────────────────────────── */

router.get(
  '/inspections/:id',
  requirePermission('qc.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const inspection = await queryOne<Record<string, unknown>>(
      `SELECT qi.*, gh.grn_date, gh.challan_no, gh.challan_date, gh.vehicle_no
         FROM qc_inspections qi
         JOIN grn_headers gh ON gh.id = qi.grn_id
        WHERE qi.id = $1`,
      [id],
    );
    if (!inspection) throw NotFoundError('QC Inspection');
    sendOk(res, inspection);
  }),
);

/* ── POST /qc/inspections/:id/decide ────────────────────────────────────────── */

const decisionSchema = z.object({
  status: z.enum(['QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD', 'QC_IN_PROGRESS']),
  acceptedQty: z.coerce.number().min(0, 'Accepted quantity cannot be negative.').default(0),
  rejectedQty: z.coerce.number().min(0, 'Rejected quantity cannot be negative.').default(0),
  remarks: z.string().trim().max(1000).default(''),
  rejectionReason: z.string().trim().max(500).default(''),
  nextAction: z.string().trim().max(100).default(''),
});

router.post(
  '/inspections/:id/decide',
  requireAnyPermission('qc.inspect', 'qc.approve'),
  validateBody(decisionSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof decisionSchema>;

    const result = await withTransaction(async (tx) => {
      const qi = await txQueryOne<{
        id: number; grn_id: number; grn_line_id: number; grn_no: string; item_id: number;
        item_code: string; item_name: string; supplier_id: number | null; received_qty: string;
        status: string; uom_id: number | null;
      }>(
        tx,
        `SELECT id, grn_id, grn_line_id, grn_no, item_id, item_code, item_name, supplier_id,
                received_qty, status, uom_id
           FROM qc_inspections WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!qi) throw NotFoundError('QC Inspection');

      if (qi.status === 'QC_PASSED' || qi.status === 'ACCEPTED_WITH_DEVIATION') {
        throw BusinessRuleError(`QC Inspection for ${qi.item_code} on GRN ${qi.grn_no} has already been finalised and passed.`);
      }

      const receivedNum = Number(qi.received_qty);
      if (body.acceptedQty + body.rejectedQty > receivedNum) {
        throw ValidationError(
          `Sum of accepted (${body.acceptedQty}) and rejected (${body.rejectedQty}) cannot exceed received quantity (${receivedNum}).`,
          [{ field: 'acceptedQty', message: 'Accepted + Rejected exceeds received quantity.' }],
        );
      }

      const isPass = body.status === 'QC_PASSED' || body.status === 'ACCEPTED_WITH_DEVIATION';
      const isFail = body.status === 'QC_FAILED';

      if (isFail && !body.rejectionReason) {
        throw ValidationError('Rejection reason is mandatory when failing inspection.', [
          { field: 'rejectionReason', message: 'Rejection reason is required.' },
        ]);
      }

      // Update inspection record
      await tx.query(
        `UPDATE qc_inspections
            SET status = $2,
                accepted_qty = $3,
                rejected_qty = $4,
                inspector_id = $5,
                inspector_name = $6,
                inspection_date = now(),
                remarks = $7,
                rejection_reason = $8,
                next_action = $9,
                updated_at = now()
          WHERE id = $1`,
        [
          id, body.status, body.acceptedQty, body.rejectedQty,
          req.user!.id, req.user!.employeeName, body.remarks,
          body.rejectionReason, body.nextAction,
        ],
      );

      // Also update accepted_qty and rejected_qty on grn_lines
      await tx.query(
        `UPDATE grn_lines
            SET accepted_qty = $2, rejected_qty = $3, updated_at = now()
          WHERE id = $1`,
        [qi.grn_line_id, body.acceptedQty, body.rejectedQty],
      );

      // If passed / accepted with deviation and acceptedQty > 0, release into usable stock!
      let stockMoved = false;
      if (isPass && body.acceptedQty > 0) {
        const grnHeader = await txQueryOne<{ grn_date: string; supplier_id: number | null }>(
          tx, 'SELECT grn_date, supplier_id FROM grn_headers WHERE id = $1', [qi.grn_id],
        );
        const grnLine = await txQueryOne<{
          id: number; item_id: number; po_line_id: number | null; grn_qty: string;
          uom_id: number | null; batch_no: string; receipt_location: string;
        }>(
          tx, 'SELECT id, item_id, po_line_id, grn_qty, uom_id, batch_no, receipt_location FROM grn_lines WHERE id = $1',
          [qi.grn_line_id],
        );

        if (grnLine && grnHeader) {
          const lineForStock: GrnLineForStock = {
            id: grnLine.id,
            item_id: grnLine.item_id,
            po_line_id: grnLine.po_line_id,
            grn_qty: qi.received_qty,
            accepted_qty: String(body.acceptedQty),
            uom_id: grnLine.uom_id,
            batch_no: grnLine.batch_no ?? '',
            receipt_location: grnLine.receipt_location ?? '',
          };

          await inwardGrnLine(tx, lineForStock, {
            grnId: qi.grn_id,
            grnNo: qi.grn_no,
            grnDate: String(grnHeader.grn_date).slice(0, 10),
            supplierId: grnHeader.supplier_id,
            srNo: 1,
            userId: req.user!.id,
          });
          stockMoved = true;
        }
      }

      // Recompute and update overall grn_headers.qc_status
      const allGrnInspections = await txQuery<{ status: string }>(
        tx, 'SELECT status FROM qc_inspections WHERE grn_id = $1', [qi.grn_id],
      );
      let overallQcStatus = 'QC_PASSED';
      const hasPending = allGrnInspections.some((x) => x.status === 'PENDING_QC');
      const hasInProgress = allGrnInspections.some((x) => x.status === 'QC_IN_PROGRESS');
      const hasOnHold = allGrnInspections.some((x) => x.status === 'ON_HOLD');
      const hasFailed = allGrnInspections.some((x) => x.status === 'QC_FAILED');

      if (hasPending) overallQcStatus = 'PENDING_QC';
      else if (hasInProgress) overallQcStatus = 'QC_IN_PROGRESS';
      else if (hasOnHold) overallQcStatus = 'ON_HOLD';
      else if (hasFailed) overallQcStatus = 'QC_FAILED';
      else overallQcStatus = 'QC_PASSED';

      await tx.query(
        `UPDATE grn_headers SET qc_status = $2, updated_at = now() WHERE id = $1`,
        [qi.grn_id, overallQcStatus],
      );

      await auditIn(tx, {
        actor: actorFrom(req),
        action: isPass ? 'APPROVE' : isFail ? 'REJECT' : 'UPDATE',
        entity: 'qc_inspection',
        entityId: id,
        entityLabel: `${qi.grn_no} - ${qi.item_code}`,
        before: { status: qi.status },
        after: {
          status: body.status, acceptedQty: body.acceptedQty,
          rejectedQty: body.rejectedQty, overallQcStatus, stockMoved,
        },
        message: `QC inspection decision for ${qi.item_code} on GRN ${qi.grn_no}: ${body.status}.`,
      });

      return {
        inspectionId: id,
        itemCode: qi.item_code,
        status: body.status,
        overallQcStatus,
        stockMoved,
      };
    });

    sendOk(res, {
      ...result,
      message: `Quality inspection for ${result.itemCode} recorded as ${result.status.replace(/_/g, ' ')}.`,
    });
  }),
);

export default router;
