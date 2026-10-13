/**
 * Direct Issue from Store Routes (Priority 4).
 *
 * Distinct from Requisition issues:
 *  - Issues material directly from the store to an authorized recipient.
 *  - Strictly checks available stock and deducts exactly once via `issueDirectStoreLine`.
 *  - Recorded in `stock_ledger` with `txn_type = 'DIRECT_ISSUE'`.
 *  - Supports date range, recipient, department, cost centre, and item filters.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam, csvIdArray, toKolkataStartOfDay, toKolkataEndOfDay,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { actorFrom, auditIn } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import { toQty } from '../../domain/money.js';
import { issueDirectStoreLine } from '../../domain/stock.js';
import { loadCompanySettings } from '../../domain/company.js';

const router = Router();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── GET /inventory/direct-issues ─────────────────────────────────────────── */

const listSchema = listQuerySchema.extend({
  fromDate: dateStr.optional(),
  toDate: dateStr.optional(),
  recipientId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  itemId: csvIdArray,
});

router.get(
  '/',
  requirePermission('auto_indent.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = new SqlBuilder();

    if (q.fromDate) {
      b.add('h.issue_date >= ?', q.fromDate);
    }
    if (q.toDate) {
      b.add('h.issue_date <= ?', q.toDate);
    }
    b.addIn('h.recipient_user_id', q.recipientId);
    b.addIn('h.department_id', q.departmentId);
    b.addIn('h.cost_centre_id', q.costCentreId);

    if (q.itemId && q.itemId.length > 0) {
      const p = b.push(q.itemId);
      b.addRaw(`EXISTS (SELECT 1 FROM direct_issue_lines l WHERE l.direct_issue_id = h.id AND l.item_id = ANY(${p}))`);
    }

    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(
        `(lower(h.issue_no) LIKE ${p} OR lower(h.recipient_name) LIKE ${p} OR lower(h.purpose) LIKE ${p} OR lower(h.remarks) LIKE ${p})`,
      );
    }

    const countSql = `
      SELECT COUNT(*)::int AS total,
             COALESCE(SUM(h.total_qty), 0)::numeric(18, 4) AS sum_qty,
             COALESCE(SUM(h.item_count), 0)::int AS sum_items
        FROM direct_issue_headers h
       ${b.where()}
    `;
    const summary = await queryOne<{ total: string; sum_qty: string; sum_items: string }>(countSql, b.params);
    const total = Number(summary?.total ?? 0);

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const selectSql = `
      SELECT h.*, u.employee_name AS created_by_name
        FROM direct_issue_headers h
        LEFT JOIN users u ON u.id = h.created_by
       ${b.where()}
       ORDER BY h.issue_date DESC, h.id DESC
       LIMIT ${limit} OFFSET ${offset}
    `;
    const rows = await query<Record<string, unknown>>(selectSql, b.params);

    sendPage(res, rows, total, q.page, q.pageSize, {
      summary: {
        totalIssues: total,
        totalQuantity: Number(summary?.sum_qty ?? 0),
        totalItemsCount: Number(summary?.sum_items ?? 0),
      },
    });
  }),
);

/* ── GET /inventory/direct-issues/:id ─────────────────────────────────────── */

router.get(
  '/:id',
  requirePermission('auto_indent.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne<Record<string, unknown>>(
      `SELECT h.*, u.employee_name AS created_by_name
         FROM direct_issue_headers h
         LEFT JOIN users u ON u.id = h.created_by
        WHERE h.id = $1`,
      [id],
    );
    if (!header) throw NotFoundError('Direct Issue');

    const lines = await query<Record<string, unknown>>(
      `SELECT l.*, i.hsn_code, i.live_stock_qty
         FROM direct_issue_lines l
         JOIN items i ON i.id = l.item_id
        WHERE l.direct_issue_id = $1
        ORDER BY l.line_no ASC`,
      [id],
    );

    sendOk(res, { ...header, lines });
  }),
);

/* ── POST /inventory/direct-issues ────────────────────────────────────────── */

const createLineSchema = z.object({
  itemId: z.coerce.number().int().positive(),
  issueQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Issue quantity must be greater than zero.'),
  remarks: z.string().trim().max(500).default(''),
});

const createDirectIssueSchema = z.object({
  recipientUserId: z.coerce.number().int().positive(),
  departmentId: z.coerce.number().int().positive().optional().nullable(),
  costCentreId: z.coerce.number().int().positive().optional().nullable(),
  issueDate: dateStr.default(() => dateStamp(new Date())),
  purpose: z.string().trim().max(500).default('Store direct issue'),
  remarks: z.string().trim().max(1000).default(''),
  lines: z.array(createLineSchema).min(1, 'Select at least one item to issue.'),
});

router.post(
  '/',
  requireAnyPermission('auto_indent.approve', 'requisition.issue', 'item.create'),
  validateBody(createDirectIssueSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createDirectIssueSchema>;
    const userId = req.user!.id;
    const when = new Date();

    const result = await withTransaction(async (tx) => {
      // 1. Resolve recipient
      const recipient = await txQueryOne<{ id: number; employee_id: string; employee_name: string; department_id: number | null }>(
        tx,
        'SELECT id, employee_id, employee_name, department_id FROM users WHERE id = $1 AND deleted_at IS NULL',
        [body.recipientUserId],
      );
      if (!recipient) throw ValidationError('The selected recipient user does not exist.', [{ field: 'recipientUserId', message: 'Not found.' }]);

      const deptId = body.departmentId ?? recipient.department_id;
      let deptName = '';
      if (deptId) {
        const d = await txQueryOne<{ name: string }>(tx, 'SELECT name FROM lookups WHERE id = $1', [deptId]);
        if (d) deptName = d.name;
      }

      let costCentreName = '';
      if (body.costCentreId) {
        const cc = await txQueryOne<{ name: string }>(tx, 'SELECT name FROM lookups WHERE id = $1', [body.costCentreId]);
        if (cc) costCentreName = cc.name;
      }

      // 2. Generate issue number
      const issueNo = await nextDocumentNumber(tx, 'DIRECT_ISSUE', when);
      const issueDate = body.issueDate || dateStamp(when);
      const issueTime = timeStamp();

      // 3. Insert header
      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO direct_issue_headers
           (issue_no, issue_date, issue_time, recipient_user_id, recipient_name, recipient_employee_code,
            department_id, department_name, cost_centre_id, cost_centre_name, purpose, remarks,
            total_qty, item_count, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 0, $13, $14)
         RETURNING id`,
        [
          issueNo, issueDate, issueTime, recipient.id, recipient.employee_name, recipient.employee_id,
          deptId, deptName, body.costCentreId ?? null, costCentreName, body.purpose, body.remarks,
          body.lines.length, userId,
        ],
      );
      if (!header) throw new Error('Failed to create direct issue header.');

      let totalQty = 0;
      const issuedLines: any[] = [];

      // 4. Process each line with row-level item locking and ledger deduction
      for (const [idx, l] of body.lines.entries()) {
        const item = await txQueryOne<{
          id: number; item_code: string; item_description: string; uom_id: number | null; uom_code: string | null;
          live_stock_qty: string;
        }>(
          tx,
          `SELECT i.id, i.item_code, i.item_description, i.uom_id, u.code AS uom_code, i.live_stock_qty
             FROM items i
             LEFT JOIN lookups u ON u.id = i.uom_id
            WHERE i.id = $1 AND i.deleted_at IS NULL`,
          [l.itemId],
        );
        if (!item) throw ValidationError(`Line ${idx + 1}: Item not found.`, [{ field: `lines.${idx}.itemId`, message: 'Not found.' }]);

        const qtyStr = toQty(l.issueQty);
        totalQty += Number(qtyStr);

        // Deduct from stock exactly once
        await issueDirectStoreLine(
          tx,
          { item_id: item.id, uom_id: item.uom_id },
          qtyStr,
          { directIssueId: header.id, issueNo, issueDate, userId },
        );

        // Insert line record
        await tx.query(
          `INSERT INTO direct_issue_lines
             (direct_issue_id, line_no, item_id, item_code, item_description, issue_qty, uom_id, uom_code, remarks)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            header.id, idx + 1, item.id, item.item_code, item.item_description,
            qtyStr, item.uom_id, item.uom_code ?? '', l.remarks,
          ],
        );

        issuedLines.push({
          itemCode: item.item_code,
          description: item.item_description,
          issueQty: qtyStr,
          uom: item.uom_code,
        });
      }

      // Update total quantity on header
      await tx.query('UPDATE direct_issue_headers SET total_qty = $2 WHERE id = $1', [header.id, totalQty]);

      // 5. Audit log
      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'CREATE',
        entity: 'direct_issue',
        entityId: header.id,
        entityLabel: issueNo,
        after: {
          issueNo,
          recipient: recipient.employee_name,
          itemCount: body.lines.length,
          totalQty,
        },
        message: `Issued ${totalQty} units across ${body.lines.length} items directly from store to ${recipient.employee_name}.`,
      });

      return {
        id: header.id,
        issueNo,
        issueDate,
        recipientName: recipient.employee_name,
        totalQty,
        itemCount: body.lines.length,
        lines: issuedLines,
      };
    });

    sendCreated(res, {
      ...result,
      message: `Direct Store Issue ${result.issueNo} successfully posted. Stock deducted from ledger.`,
    });
  }),
);

/* ── GET /inventory/direct-issues/:id/print ───────────────────────────────── */

router.get(
  '/:id/print',
  requirePermission('auto_indent.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne<Record<string, unknown>>(
      `SELECT h.*, u.employee_name AS created_by_name
         FROM direct_issue_headers h
         LEFT JOIN users u ON u.id = h.created_by
        WHERE h.id = $1`,
      [id],
    );
    if (!header) throw NotFoundError('Direct Issue');

    const lines = await query<Record<string, unknown>>(
      `SELECT l.*, i.hsn_code
         FROM direct_issue_lines l
         JOIN items i ON i.id = l.item_id
        WHERE l.direct_issue_id = $1
        ORDER BY l.line_no ASC`,
      [id],
    );

    const company = await loadCompanySettings();

    const lineRowsHtml = lines.map((l, i) => `
      <tr>
        <td style="text-align:center; padding:6px; border:1px solid #ccc;">${i + 1}</td>
        <td style="padding:6px; border:1px solid #ccc; font-weight:600;">${l.item_code}</td>
        <td style="padding:6px; border:1px solid #ccc;">${l.item_description}</td>
        <td style="text-align:center; padding:6px; border:1px solid #ccc;">${l.uom_code || '-'}</td>
        <td style="text-align:right; padding:6px; border:1px solid #ccc; font-weight:700;">${Number(l.issue_qty).toFixed(2)}</td>
        <td style="padding:6px; border:1px solid #ccc;">${l.remarks || ''}</td>
      </tr>
    `).join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Direct Store Issue Slip - ${header.issue_no}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 30px; color: #111; }
    .header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
    .company { font-size: 14px; color: #444; }
    .doc-meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; }
    .box { background: #f9f9f9; padding: 12px; border: 1px solid #ddd; border-radius: 4px; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
    th { background: #f0f0f0; padding: 8px 6px; border: 1px solid #ccc; text-align: left; }
    .signatures { display: flex; justify-content: space-between; margin-top: 60px; font-size: 13px; }
    .sig-line { border-top: 1px solid #444; width: 180px; text-align: center; padding-top: 5px; }
    @media print {
      body { margin: 15px; }
      .no-print { display: none; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">STORE DIRECT ISSUE SLIP</div>
    <div class="company">${company.name || 'Zeeta Electrical Engineering Pvt. Ltd.'}</div>
  </div>

  <div class="doc-meta">
    <div class="box" style="width: 48%;">
      <div><strong>Issue Slip No:</strong> ${header.issue_no}</div>
      <div><strong>Date:</strong> ${String(header.issue_date).slice(0, 10)} ${header.issue_time || ''}</div>
      <div><strong>Purpose:</strong> ${header.purpose || '-'}</div>
    </div>
    <div class="box" style="width: 48%;">
      <div><strong>Recipient:</strong> ${header.recipient_name} (${header.recipient_employee_code || '-'})</div>
      <div><strong>Department:</strong> ${header.department_name || '-'}</div>
      <div><strong>Cost Centre:</strong> ${header.cost_centre_name || '-'}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th style="width: 40px; text-align: center;">#</th>
        <th style="width: 120px;">Item Code</th>
        <th>Description</th>
        <th style="width: 70px; text-align: center;">UOM</th>
        <th style="width: 90px; text-align: right;">Issued Qty</th>
        <th style="width: 140px;">Remarks</th>
      </tr>
    </thead>
    <tbody>
      ${lineRowsHtml}
    </tbody>
    <tfoot>
      <tr style="background:#f4f4f4; font-weight:700;">
        <td colspan="4" style="padding:8px; border:1px solid #ccc; text-align:right;">Total Quantity Issued:</td>
        <td style="padding:8px; border:1px solid #ccc; text-align:right;">${Number(header.total_qty).toFixed(2)}</td>
        <td style="border:1px solid #ccc;"></td>
      </tr>
    </tfoot>
  </table>

  ${header.remarks ? `<div style="margin-top:15px; font-size:12px;"><strong>Remarks:</strong> ${header.remarks}</div>` : ''}

  <div class="signatures">
    <div class="sig-line">Store Incharge<br><span style="font-size:11px; color:#666;">${header.created_by_name || 'Store'}</span></div>
    <div class="sig-line">Recipient Signature<br><span style="font-size:11px; color:#666;">${header.recipient_name}</span></div>
  </div>
</body>
</html>`;

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(200).send(html);
  }),
);

export default router;
