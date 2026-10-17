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
import { query, queryOne, withTransaction, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam, csvIdArray, toKolkataStartOfDay, toKolkataEndOfDay,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { actorFrom, auditIn } from '../../core/audit.js';
import { inwardGrnLine, type GrnLineForStock } from '../../domain/stock.js';
import { toQty, dec } from '../../domain/money.js';
import { toDateOnly } from '../../domain/numbering.js';
import { CLOSED_QC_STATUS, refreshGrnQcStatus } from '../../domain/qc.js';

const router = Router();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── GET /qc/stats ──────────────────────────────────────────────────────────── */

const statsSchema = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  itemId: z.coerce.number().int().positive().optional(),
  inspectorId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  hodId: csvIdArray,
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
    if (q.departmentId && q.departmentId.length > 0) {
      const p = b.push(q.departmentId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = qc_inspections.item_id AND i.department_id = ANY(${p}))`);
    }
    if (q.costCentreId && q.costCentreId.length > 0) {
      const p = b.push(q.costCentreId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = qc_inspections.item_id AND i.cost_centre_id = ANY(${p}))`);
    }
    if (q.hodId && q.hodId.length > 0) {
      const p = b.push(q.hodId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i JOIN lookups d ON d.id = i.department_id WHERE i.id = qc_inspections.item_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
    }
    if (q.dateFrom) b.add('created_at >= ?::timestamptz', toKolkataStartOfDay(q.dateFrom));
    if (q.dateTo) b.add('created_at <= ?::timestamptz', toKolkataEndOfDay(q.dateTo));

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
      // Closed without a decision because their GRN was cancelled (migration 029).
      closed: byStatus[CLOSED_QC_STATUS] ?? 0,
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
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  hodId: csvIdArray,
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
    if (q.departmentId && q.departmentId.length > 0) {
      const p = b.push(q.departmentId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = qi.item_id AND i.department_id = ANY(${p}))`);
    }
    if (q.costCentreId && q.costCentreId.length > 0) {
      const p = b.push(q.costCentreId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i WHERE i.id = qi.item_id AND i.cost_centre_id = ANY(${p}))`);
    }
    if (q.hodId && q.hodId.length > 0) {
      const p = b.push(q.hodId);
      b.addRaw(`EXISTS (SELECT 1 FROM items i JOIN lookups d ON d.id = i.department_id WHERE i.id = qi.item_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
    }
    if (q.dateFrom) b.add('qi.created_at >= ?::timestamptz', toKolkataStartOfDay(q.dateFrom));
    if (q.dateTo) b.add('qi.created_at <= ?::timestamptz', toKolkataEndOfDay(q.dateTo));

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

    const totalsRow = await queryOne<{
      total_received: string;
      total_accepted: string;
      total_rejected: string;
    }>(
      `SELECT
         COALESCE(SUM(qi.received_qty), 0) AS total_received,
         COALESCE(SUM(qi.accepted_qty), 0) AS total_accepted,
         COALESCE(SUM(qi.rejected_qty), 0) AS total_rejected
       FROM qc_inspections qi ${b.where()}`,
      b.params,
    );

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT qi.id, qi.grn_id, qi.grn_line_id, qi.grn_no, qi.item_id, qi.item_code,
              qi.item_name, qi.supplier_id, qi.supplier_name, qi.received_qty,
              qi.accepted_qty, qi.rejected_qty, qi.uom_id, qi.uom_code, qi.status,
              qi.inspector_id, qi.inspector_name, qi.inspection_date, qi.remarks,
              qi.rejection_reason, qi.next_action, qi.created_at, qi.updated_at,
              gh.status AS grn_status
         FROM qc_inspections qi
         JOIN grn_headers gh ON gh.id = qi.grn_id
         ${b.where()}
        ORDER BY qi.created_at DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize, {
      totals: {
        totalInspections: total,
        totalReceivedQty: Number(totalsRow?.total_received ?? 0),
        totalAcceptedQty: Number(totalsRow?.total_accepted ?? 0),
        totalRejectedQty: Number(totalsRow?.total_rejected ?? 0),
      },
    });
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
      // The GRN is locked before the inspection, the order GRN cancel takes
      // them in, so a decision and a cancel of the same GRN wait for each other.
      const ref = await txQueryOne<{ grn_id: number }>(tx, 'SELECT grn_id FROM qc_inspections WHERE id = $1', [id]);
      if (!ref) throw NotFoundError('QC Inspection');
      const grn = await txQueryOne<{ grn_no: string; status: string; grn_date: string; supplier_id: number | null }>(
        tx, 'SELECT grn_no, status, grn_date, supplier_id FROM grn_headers WHERE id = $1 FOR UPDATE', [ref.grn_id],
      );
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
      if (!qi || !grn) throw NotFoundError('QC Inspection');

      // Only a posted GRN's material is held for inspection. Nothing checked the
      // GRN, so a pass on a cancelled one would add the stock of a receipt that
      // no longer exists, and nothing would take it back out (A7 F04).
      if (grn.status !== 'POSTED' || qi.status === CLOSED_QC_STATUS) {
        throw BusinessRuleError(
          grn.status === 'DRAFT'
            ? `GRN ${grn.grn_no} is still a draft — its material is inspected once the GRN is posted.`
            : `GRN ${grn.grn_no} has been cancelled, so this inspection is closed and no decision can be recorded on it.`,
          { grnStatus: grn.status, inspectionStatus: qi.status },
        );
      }

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
      const isFinal = isPass || isFail;

      if (isFail && !body.rejectionReason) {
        throw ValidationError('Rejection reason is mandatory when failing inspection.', [
          { field: 'rejectionReason', message: 'Rejection reason is required.' },
        ]);
      }

      // A final decision accounts for the whole received quantity: what QC does
      // not accept, it rejects. The GRN line keeps that split, and its CHECK
      // (chk_grn_accepted_rejected, migration 007) wants the two to add up to
      // the received quantity, so a short split used to fail as a bare
      // "violate a data rule" error, and so did every interim decision.
      if (isFinal && toQty(dec(body.acceptedQty).plus(dec(body.rejectedQty))) !== toQty(qi.received_qty)) {
        throw ValidationError(
          `A final QC decision must account for the whole received quantity: accepted (${body.acceptedQty}) ` +
          `+ rejected (${body.rejectedQty}) must equal received (${receivedNum}).`,
          [{ field: 'acceptedQty', message: 'Accepted + Rejected must equal the received quantity.' }],
        );
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

      // The GRN line carries the split of a final decision only; while QC is
      // still testing or holding, its figures stay on the inspection and the
      // line reads "not split yet".
      await tx.query(
        `UPDATE grn_lines
            SET accepted_qty = $2, rejected_qty = $3, updated_at = now()
          WHERE id = $1`,
        [qi.grn_line_id, isFinal ? body.acceptedQty : null, isFinal ? body.rejectedQty : null],
      );

      // If passed / accepted with deviation and acceptedQty > 0, release into usable stock!
      let stockMoved = false;
      if (isPass && body.acceptedQty > 0) {
        const grnLine = await txQueryOne<{
          id: number; line_no: number; item_id: number; po_line_id: number | null; grn_qty: string;
          uom_id: number | null; batch_no: string; receipt_location: string;
        }>(
          tx, 'SELECT id, line_no, item_id, po_line_id, grn_qty, uom_id, batch_no, receipt_location FROM grn_lines WHERE id = $1',
          [qi.grn_line_id],
        );

        if (grnLine) {
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

          // grn_date arrives as a Date: its text cut to ten characters was
          // "Sat Oct 17", and every release failed with a 500 (found 2026-10-17;
          // production had never run a QC pass). SR. NO. is the line's number,
          // as for every line received at posting.
          await inwardGrnLine(tx, lineForStock, {
            grnId: qi.grn_id,
            grnNo: qi.grn_no,
            grnDate: toDateOnly(grn.grn_date),
            supplierId: grn.supplier_id,
            srNo: grnLine.line_no,
            userId: req.user!.id,
          });
          stockMoved = true;
        }
      }

      const overallQcStatus = await refreshGrnQcStatus(tx, qi.grn_id);

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
