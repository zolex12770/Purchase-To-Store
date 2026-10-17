/**
 * Purchase Indent — header/detail document with approval workflow (SRS §10).
 *
 * Lifecycle: DRAFT → PENDING_APPROVAL → APPROVED | REJECTED (→ CLOSED when fully
 * ordered). Transitions are enforced by `domain/status.ts`; balances come from
 * `v_indent_line_balance` (ADR-005). A rejection always carries its reason, and an
 * approved indent is protected from further editing (SRS §10).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray,
} from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError, AuthorizationError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission, hasPermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import {
  assertIndentTransition, assertIndentEditable, assertNotAlready, type IndentStatus,
} from '../../domain/status.js';
import { toQty, toRate } from '../../domain/money.js';

const router = Router();

/* ── Shared list query ──────────────────────────────────────────────────────── */

const SORTABLE: Record<string, string> = {
  indentNo: 'h.indent_no',
  indentDate: 'h.indent_date',
  status: 'h.status',
  createdAt: 'h.created_at',
  totalValue: 'b.total_estimated_value',
};

/** The list's query; its Export accepts exactly the same (io/datasets.ts). */
export const listSchema = listQuerySchema.extend({
  status: csvArray,
  indentTypeId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  supplierId: csvIdArray,
  userId: csvIdArray,
  hodId: csvIdArray,
  itemId: csvIdArray,
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  pendingOnly: z.enum(['true', 'false']).optional(),
});

export function buildIndentFilter(q: z.infer<typeof listSchema>): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('h.status', q.status);
  b.addIn('h.indent_type_id', q.indentTypeId);
  b.addIn('h.department_id', q.departmentId);
  b.addIn('h.cost_centre_id', q.costCentreId);
  b.addIn('h.suggested_supplier_id', q.supplierId);
  b.addIn('h.requested_by_user_id', q.userId);
  b.add('h.indent_date >= ?', q.dateFrom);
  b.add('h.indent_date <= ?', q.dateTo);
  if (q.hodId && q.hodId.length > 0) {
    const p = b.push(q.hodId);
    b.addRaw(`(h.approved_by = ANY(${p}) OR EXISTS (SELECT 1 FROM lookups d WHERE d.id = h.department_id AND (d.extra->>'hodUserId')::bigint = ANY(${p})))`);
  }
  if (q.pendingOnly === 'true') b.addRaw("h.status = 'PENDING_APPROVAL'");
  if (q.itemId && q.itemId.length > 0) {
    const p = b.push(q.itemId);
    b.addRaw(`EXISTS (SELECT 1 FROM purchase_indent_lines l WHERE l.indent_id = h.id AND l.item_id = ANY(${p}))`);
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(h.indent_no) LIKE ${p} OR lower(h.remarks) LIKE ${p} ` +
      `OR EXISTS (SELECT 1 FROM purchase_indent_lines l WHERE l.indent_id = h.id ` +
      `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p})))`,
    );
  }
  return b;
}

/* ── GET /indents ───────────────────────────────────────────────────────────── */

router.get(
  '/',
  requirePermission('indent.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildIndentFilter(q);

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM purchase_indent_headers h ${b.where()}`, b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const order = resolveSort(q, SORTABLE, 'indentDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT h.id, h.indent_no, h.indent_date, h.indent_time, h.status, h.remarks,
              h.required_by_date, h.submitted_at, h.approved_at, h.rejected_at, h.rejection_reason,
              h.indent_type_id, it.name AS indent_type_name,
              h.department_id, d.name AS department_name,
              h.cost_centre_id, cc.name AS cost_centre_name,
              h.suggested_supplier_id, s.supplier_name AS suggested_supplier_name,
              h.requested_by_user_id, u.employee_name AS requested_by_name, u.employee_id AS requested_by_code,
              ap.employee_name AS approved_by_name,
              b.line_count, b.total_indent_qty, b.total_ordered_qty, b.total_pending_qty,
              b.total_estimated_value, b.eligible_line_count,
              (CURRENT_DATE - h.indent_date)::int AS age_days
         FROM purchase_indent_headers h
         JOIN v_indent_header_balance b ON b.indent_id = h.id
         LEFT JOIN lookups it ON it.id = h.indent_type_id
         LEFT JOIN lookups d  ON d.id  = h.department_id
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN suppliers s ON s.id = h.suggested_supplier_id
         LEFT JOIN users u  ON u.id  = h.requested_by_user_id
         LEFT JOIN users ap ON ap.id = h.approved_by
         ${b.where()}
        ORDER BY ${order}, h.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    // Status counts for the tab strip — computed over the SAME filter minus status,
    // so the badges always agree with what the list would show.
    const cb = buildIndentFilter({ ...q, status: undefined });
    const counts = await query<{ status: string; n: string }>(
      `SELECT h.status, COUNT(*) AS n FROM purchase_indent_headers h ${cb.where()} GROUP BY h.status`,
      cb.params,
    );

    // Dynamic totals across the active filter
    const tb = buildIndentFilter(q);
    const totals = await queryOne<{
      indentCount: string;
      lineCount: string;
      totalIndentQty: string;
      totalOrderedQty: string;
      totalPendingQty: string;
      totalEstimatedValue: string;
    }>(
      `SELECT COUNT(DISTINCT h.id)::int AS "indentCount",
              COALESCE(SUM(b.line_count), 0)::int AS "lineCount",
              COALESCE(SUM(b.total_indent_qty), 0) AS "totalIndentQty",
              COALESCE(SUM(b.total_ordered_qty), 0) AS "totalOrderedQty",
              COALESCE(SUM(b.total_pending_qty), 0) AS "totalPendingQty",
              COALESCE(SUM(b.total_estimated_value), 0) AS "totalEstimatedValue"
         FROM purchase_indent_headers h
         JOIN v_indent_header_balance b ON b.indent_id = h.id
         LEFT JOIN lookups it ON it.id = h.indent_type_id
         LEFT JOIN lookups d  ON d.id  = h.department_id
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN suppliers s ON s.id = h.suggested_supplier_id
         ${tb.where()}`,
      tb.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize, {
      statusCounts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])),
      totals,
    });
  }),
);

/* ── GET /indents/eligible-lines — the PO builder's source list (SRS §11.1) ─── */

const eligibleSchema = z.object({
  supplierId: z.coerce.number().int().positive().optional(),
  itemId: csvIdArray,
  indentId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  indentTypeId: csvIdArray,
  userId: csvIdArray,
  hodId: csvIdArray,
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().trim().max(200).optional(),
  /** `true` restricts to indents whose suggested supplier matches `supplierId`. */
  matchSupplier: z.enum(['true', 'false']).default('false'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(500).default(100),
});

router.get(
  '/eligible-lines',
  requirePermission('po.create'),
  validateQuery(eligibleSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof eligibleSchema>>(res);

    const b = new SqlBuilder();
    b.addRaw('v.is_eligible_for_po = TRUE');
    b.addIn('v.item_id', q.itemId);
    b.addIn('v.indent_id', q.indentId);
    b.addIn('v.department_id', q.departmentId);
    b.addIn('v.cost_centre_id', q.costCentreId);
    b.addIn('v.indent_type_id', q.indentTypeId);
    b.addIn('v.requested_by_user_id', q.userId);
    b.add('v.indent_date >= ?', q.dateFrom);
    b.add('v.indent_date <= ?', q.dateTo);
    if (q.hodId && q.hodId.length > 0) {
      const p = b.push(q.hodId);
      b.addRaw(`EXISTS (SELECT 1 FROM lookups d WHERE d.id = v.department_id AND (d.extra->>'hodUserId')::bigint = ANY(${p}))`);
    }
    // Supplier-wise consolidation: only lines whose indent suggests this supplier.
    if (q.matchSupplier === 'true' && q.supplierId) {
      b.add('v.suggested_supplier_id = ?', q.supplierId);
    }
    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(`(lower(v.item_code) LIKE ${p} OR lower(v.item_description) LIKE ${p} OR lower(v.indent_no) LIKE ${p})`);
    }

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM v_indent_line_balance v ${b.where()}`, b.params,
    );
    const totalsRow = await queryOne<{ totalLines: string; distinctIndents: string; totalPendingQty: string }>(
      `SELECT COUNT(*)::int AS "totalLines",
              COUNT(DISTINCT v.indent_id)::int AS "distinctIndents",
              COALESCE(SUM(v.pending_qty), 0) AS "totalPendingQty"
         FROM v_indent_line_balance v
        ${b.where()}`,
      b.params,
    );

    const limit = b.push(q.pageSize);
    const offset = b.push((q.page - 1) * q.pageSize);

    const rows = await query(
      `SELECT v.indent_line_id, v.indent_id, v.indent_no, v.indent_date, v.line_no,
              v.item_id, v.item_code, v.item_description, v.item_specification,
              v.indent_qty, v.ordered_qty, v.pending_qty, v.estimated_rate,
              v.required_by_date, v.uom_id, u.code AS uom_code,
              v.department_id, d.name AS department_name,
              v.cost_centre_id, cc.name AS cost_centre_name,
              v.indent_type_id, it.name AS indent_type_name,
              v.suggested_supplier_id, s.supplier_name AS suggested_supplier_name,
              (CURRENT_DATE - v.indent_date)::int AS age_days
         FROM v_indent_line_balance v
         LEFT JOIN lookups u  ON u.id  = v.uom_id
         LEFT JOIN lookups d  ON d.id  = v.department_id
         LEFT JOIN lookups cc ON cc.id = v.cost_centre_id
         LEFT JOIN lookups it ON it.id = v.indent_type_id
         LEFT JOIN suppliers s ON s.id = v.suggested_supplier_id
         ${b.where()}
        ORDER BY v.indent_date ASC, v.indent_no ASC, v.line_no ASC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, Number(totalRow?.n ?? 0), q.page, q.pageSize, {
      totals: totalsRow,
    });
  }),
);

/* ── GET /indents/:id ───────────────────────────────────────────────────────── */

router.get(
  '/:id',
  requirePermission('indent.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);

    const header = await queryOne<Record<string, unknown>>(
      `SELECT h.*, it.name AS indent_type_name, d.name AS department_name,
              cc.name AS cost_centre_name, s.supplier_name AS suggested_supplier_name,
              u.employee_name AS requested_by_name, u.employee_id AS requested_by_code,
              ap.employee_name AS approved_by_name, rj.employee_name AS rejected_by_name,
              b.line_count, b.total_indent_qty, b.total_ordered_qty, b.total_pending_qty,
              b.total_estimated_value, b.eligible_line_count
         FROM purchase_indent_headers h
         JOIN v_indent_header_balance b ON b.indent_id = h.id
         LEFT JOIN lookups it ON it.id = h.indent_type_id
         LEFT JOIN lookups d  ON d.id  = h.department_id
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN suppliers s ON s.id = h.suggested_supplier_id
         LEFT JOIN users u  ON u.id  = h.requested_by_user_id
         LEFT JOIN users ap ON ap.id = h.approved_by
         LEFT JOIN users rj ON rj.id = h.rejected_by
        WHERE h.id = $1`,
      [id],
    );
    if (!header) throw NotFoundError('Purchase indent');

    const lines = await query(
      `SELECT v.*, u.code AS uom_code, u.name AS uom_name,
              d.name AS department_name, cc.name AS cost_centre_name,
              l.remarks, l.closed_reason
         FROM v_indent_line_balance v
         JOIN purchase_indent_lines l ON l.id = v.indent_line_id
         LEFT JOIN lookups u  ON u.id  = v.uom_id
         LEFT JOIN lookups d  ON d.id  = v.department_id
         LEFT JOIN lookups cc ON cc.id = v.cost_centre_id
        WHERE v.indent_id = $1
        ORDER BY v.line_no`,
      [id],
    );

    const approvals = await query(
      `SELECT a.id, a.action, a.level, a.reason, a.from_status, a.to_status, a.created_at,
              u.employee_name AS actor_name, u.employee_id AS actor_code
         FROM indent_approvals a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.indent_id = $1
        ORDER BY a.created_at ASC, a.id ASC`,
      [id],
    );

    // Downstream POs — the drill-down from indent to what it became (SRS §14).
    const linkedPos = await query(
      `SELECT DISTINCT s.po_id, s.po_no, b.po_date, b.status, b.total_amount,
              sup.supplier_name
         FROM v_po_line_sources s
         JOIN v_po_header_balance b ON b.po_id = s.po_id
         JOIN suppliers sup ON sup.id = b.supplier_id
        WHERE s.indent_id = $1
        ORDER BY b.po_date DESC`,
      [id],
    );

    sendOk(res, { ...header, lines, approvals, linkedPurchaseOrders: linkedPos });
  }),
);

/* ── Create / update ────────────────────────────────────────────────────────── */

const lineSchema = z.object({
  itemId: z.coerce.number().int().positive({ message: 'Select an item.' }),
  indentQty: z.union([z.number(), z.string()]).refine(
    (v) => Number(v) > 0, 'Quantity must be greater than zero.',
  ),
  uomId: z.coerce.number().int().positive().nullable().optional(),
  itemSpecification: z.string().trim().max(1000).default(''),
  departmentId: z.coerce.number().int().positive().nullable().optional(),
  costCentreId: z.coerce.number().int().positive().nullable().optional(),
  estimatedRate: z.union([z.number(), z.string()]).nullable().optional(),
  remarks: z.string().trim().max(500).default(''),
});

const indentSchema = z.object({
  indentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  indentTypeId: z.coerce.number().int().positive().nullable().optional(),
  // Header-level required fields per the Purchase Indent reference contract.
  departmentId: z.coerce.number().int().positive({ message: 'Select a department.' }),
  costCentreId: z.coerce.number().int().positive({ message: 'Select a cost centre.' }),
  suggestedSupplierId: z.coerce.number().int().positive().nullable().optional(),
  // One Required By date per indent (header-level only) — there is deliberately
  // no per-line override; every line shares whatever the header holds, including
  // no value at all. Optional: Required By is not part of the Purchase Indent
  // reference field contract, so it must not be forced or auto-filled.
  requiredByDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a valid Required By date.').nullable().optional(),
  remarks: z.string().trim().max(1000).default(''),
  lines: z.array(lineSchema).min(1, 'Add at least one item line.'),
  /** When true the indent is submitted for approval immediately after saving. */
  submit: z.boolean().default(false),
});

type IndentBody = z.infer<typeof indentSchema>;

/** Resolves item snapshots so a later Item Master edit cannot rewrite history. */
async function resolveLineItems(tx: Parameters<typeof txQuery>[0], lines: IndentBody['lines']) {
  const ids = [...new Set(lines.map((l) => l.itemId))];
  const items = await txQuery<{
    id: number; item_code: string; item_description: string; uom_id: number | null;
    item_specification: string; department_id: number | null; cost_centre_id: number | null;
    standard_rate: string | null; is_active: boolean;
  }>(
    tx,
    'SELECT * FROM items WHERE id = ANY($1) AND deleted_at IS NULL',
    [ids],
  );
  const map = new Map(items.map((i) => [Number(i.id), i]));

  const missing = ids.filter((i) => !map.has(i));
  if (missing.length > 0) {
    throw ValidationError('One or more selected items no longer exist.', [
      { field: 'lines', message: `Unknown item id(s): ${missing.join(', ')}.` },
    ]);
  }
  const inactive = items.filter((i) => !i.is_active).map((i) => i.item_code);
  if (inactive.length > 0) {
    throw BusinessRuleError(
      `These items are inactive and cannot be indented: ${inactive.join(', ')}.`,
    );
  }
  return map;
}

router.post(
  '/',
  requirePermission('indent.create'),
  validateBody(indentSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as IndentBody;
    const userId = req.user!.id;
    const when = body.indentDate ? new Date(`${body.indentDate}T00:00:00`) : new Date();

    if (body.submit && !hasPermission(req, 'indent.create')) {
      throw AuthorizationError('You cannot submit indents.');
    }

    const id = await withTransaction(async (tx) => {
      const itemMap = await resolveLineItems(tx, body.lines);
      const indentNo = await nextDocumentNumber(tx, 'INDENT', when);
      const status: IndentStatus = body.submit ? 'PENDING_APPROVAL' : 'DRAFT';

      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO purchase_indent_headers
           (indent_no, indent_date, indent_time, indent_type_id, department_id, cost_centre_id,
            suggested_supplier_id, requested_by_user_id, required_by_date, remarks, status,
            submitted_at, submitted_by, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$8,$8)
         RETURNING id`,
        [
          indentNo, dateStamp(when), timeStamp(), body.indentTypeId ?? null,
          body.departmentId ?? null, body.costCentreId ?? null, body.suggestedSupplierId ?? null,
          userId, body.requiredByDate ?? null, body.remarks, status,
          body.submit ? new Date().toISOString() : null, body.submit ? userId : null,
        ],
      );
      if (!header) throw new Error('Failed to create indent header.');

      for (const [i, line] of body.lines.entries()) {
        const item = itemMap.get(line.itemId)!;
        await tx.query(
          `INSERT INTO purchase_indent_lines
             (indent_id, line_no, item_id, item_code, item_description, indent_qty, uom_id,
              item_specification, department_id, cost_centre_id, estimated_rate, required_by_date, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            header.id, i + 1, item.id, item.item_code, item.item_description,
            toQty(line.indentQty),
            line.uomId ?? item.uom_id,
            line.itemSpecification || item.item_specification,
            line.departmentId ?? item.department_id ?? body.departmentId ?? null,
            line.costCentreId ?? item.cost_centre_id ?? body.costCentreId ?? null,
            line.estimatedRate != null && line.estimatedRate !== ''
              ? toRate(line.estimatedRate) : item.standard_rate,
            // Header's Required By, always (may be null) — there is no line-level override.
            body.requiredByDate ?? null,
            line.remarks,
          ],
        );
      }

      if (body.submit) {
        await tx.query(
          `INSERT INTO indent_approvals (indent_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,'DRAFT','PENDING_APPROVAL')`,
          [header.id, userId],
        );
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'CREATE',
        entity: 'purchase_indent', entityId: header.id, entityLabel: indentNo,
        after: { indentNo, status, lineCount: body.lines.length },
      });

      return header.id;
    });

    const created = await queryOne('SELECT * FROM purchase_indent_headers WHERE id = $1', [id]);
    sendCreated(res, created);
  }),
);

router.put(
  '/:id',
  // A PENDING_APPROVAL indent is now editable (see domain/status.ts) by
  // either its raiser (indent.edit) or an authorised approver reviewing it
  // (indent.approve) — a Purchase Head who holds ONLY the approve permission
  // must still be able to correct it while reviewing, not just once they
  // also happen to hold indent.edit.
  requireAnyPermission('indent.edit', 'indent.approve'),
  validateBody(indentSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as IndentBody;
    const userId = req.user!.id;

    const before = await queryOne<{ status: IndentStatus; indent_no: string; requested_by_user_id: number }>(
      'SELECT status, indent_no, requested_by_user_id FROM purchase_indent_headers WHERE id = $1',
      [id],
    );
    if (!before) throw NotFoundError('Purchase indent');

    // SRS §10: approved/rejected/terminal documents are protected from
    // further mutation. DRAFT and PENDING_APPROVAL are both editable.
    assertIndentEditable(before.status, before.indent_no);

    await withTransaction(async (tx) => {
      const itemMap = await resolveLineItems(tx, body.lines);
      const status: IndentStatus = body.submit ? 'PENDING_APPROVAL' : before.status;
      if (body.submit) assertIndentTransition(before.status, 'PENDING_APPROVAL');

      await tx.query(
        `UPDATE purchase_indent_headers
            SET indent_type_id = $2, department_id = $3, cost_centre_id = $4,
                suggested_supplier_id = $5, required_by_date = $6, remarks = $7,
                status = $8, submitted_at = COALESCE(submitted_at, $9), submitted_by = COALESCE(submitted_by, $10),
                updated_at = now(), updated_by = $10
          WHERE id = $1`,
        [
          id, body.indentTypeId ?? null, body.departmentId ?? null, body.costCentreId ?? null,
          body.suggestedSupplierId ?? null, body.requiredByDate ?? null, body.remarks, status,
          body.submit ? new Date().toISOString() : null, userId,
        ],
      );

      // A draft has no downstream references, so lines are replaced wholesale.
      await tx.query('DELETE FROM purchase_indent_lines WHERE indent_id = $1', [id]);
      for (const [i, line] of body.lines.entries()) {
        const item = itemMap.get(line.itemId)!;
        await tx.query(
          `INSERT INTO purchase_indent_lines
             (indent_id, line_no, item_id, item_code, item_description, indent_qty, uom_id,
              item_specification, department_id, cost_centre_id, estimated_rate, required_by_date, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            id, i + 1, item.id, item.item_code, item.item_description, toQty(line.indentQty),
            line.uomId ?? item.uom_id, line.itemSpecification || item.item_specification,
            line.departmentId ?? item.department_id ?? body.departmentId ?? null,
            line.costCentreId ?? item.cost_centre_id ?? body.costCentreId ?? null,
            line.estimatedRate != null && line.estimatedRate !== '' ? toRate(line.estimatedRate) : item.standard_rate,
            body.requiredByDate ?? null, line.remarks,
          ],
        );
      }

      if (body.submit) {
        await tx.query(
          `INSERT INTO indent_approvals (indent_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,$3,'PENDING_APPROVAL')`,
          [id, userId, before.status],
        );
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'UPDATE',
        entity: 'purchase_indent', entityId: id, entityLabel: before.indent_no,
        before, after: { status, lineCount: body.lines.length },
      });
    });

    sendOk(res, await queryOne('SELECT * FROM purchase_indent_headers WHERE id = $1', [id]));
  }),
);

/* ── Workflow transitions ───────────────────────────────────────────────────── */

interface TransitionOptions {
  action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'CANCEL' | 'REOPEN' | 'CLOSE' | 'UNAPPROVE';
  to: IndentStatus;
  permission: string;
  reasonRequired?: boolean;
  auditAction: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'CANCEL' | 'REOPEN' | 'CLOSE' | 'UNAPPROVE';
}

const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });

function transitionRoute(path: string, opts: TransitionOptions) {
  router.post(
    path,
    requirePermission(opts.permission),
    validateBody(reasonSchema),
    asyncHandler(async (req, res) => {
      const id = idParam(req);
      const { reason } = req.body as z.infer<typeof reasonSchema>;
      const userId = req.user!.id;

      if (opts.reasonRequired && (!reason || reason.trim().length === 0)) {
        throw ValidationError('A reason is required.', [
          { field: 'reason', message: 'Please state the reason.' },
        ]);
      }

      const result = await withTransaction(async (tx) => {
        const header = await txQueryOne<{
          id: number; indent_no: string; status: IndentStatus; requested_by_user_id: number | null;
        }>(
          tx,
          `SELECT id, indent_no, status, requested_by_user_id
             FROM purchase_indent_headers WHERE id = $1 FOR UPDATE`,
          [id],
        );
        if (!header) throw NotFoundError('Purchase indent');

        assertNotAlready('Indent', header.indent_no, header.status, opts.to);
        assertIndentTransition(header.status, opts.to);

        // Reopen is for a rejected indent, or for the requester pulling their own indent
        // back before a decision. From APPROVED it skipped UNAPPROVE's approve right and its
        // purchase-order check, so an indent already on a PO could be sent back to DRAFT
        // with indent.edit alone (2026-10-16 audit).
        if (opts.action === 'REOPEN') {
          const ownPending = header.status === 'PENDING_APPROVAL'
            && (header.requested_by_user_id === userId || req.user!.isSuperAdmin);
          if (header.status !== 'REJECTED' && !ownPending) {
            throw BusinessRuleError(
              header.status === 'APPROVED'
                ? `Indent ${header.indent_no} is approved. Use Unapprove, which checks the purchase orders drawing on it, instead of Reopen.`
                : `Only a rejected indent, or your own indent awaiting approval, can be reopened.`,
            );
          }
        }

        // Separation of duties: nobody approves their own requisition (ADR-011)
        // — EXCEPT a Super Admin, who by definition already holds every
        // permission in the system and cannot be routed around by requiring a
        // second approver that may not exist (e.g. a single-admin deployment,
        // or the admin genuinely is the only authorised Purchase Head). This
        // is a server-enforced role check (`req.user.isSuperAdmin`, computed
        // from the user's actual role grants — see auth/middleware.ts), never
        // a frontend-only bypass. An ordinary user with `indent.approve` but
        // without the Super Admin role is still blocked from self-approval.
        const isSelfApproval = opts.action === 'APPROVE' && header.requested_by_user_id === userId;
        if (isSelfApproval && !req.user!.isSuperAdmin) {
          throw BusinessRuleError(
            'You cannot approve an indent that you raised yourself. Another authorised approver must action it.',
          );
        }

        // A submitted indent must actually have lines.
        if (opts.action === 'SUBMIT') {
          const lines = await txQueryOne<{ n: string }>(
            tx, 'SELECT COUNT(*) AS n FROM purchase_indent_lines WHERE indent_id = $1', [id],
          );
          if (Number(lines?.n ?? 0) === 0) {
            throw BusinessRuleError('Add at least one item line before submitting this indent for approval.');
          }
        }

        // An indent that has already fed a PO cannot be cancelled underneath
        // it, nor reversed out of APPROVED at all — whether via a genuine
        // REJECT or via UNAPPROVE (back to DRAFT) — either would leave a PO's
        // source_qty referencing a line that is no longer a confirmed
        // commitment. Reverse the PO first in every case. A REJECT starting
        // from PENDING_APPROVAL never needs this check: nothing not-yet-
        // approved can have been drawn into a PO (v_indent_line_balance only
        // exposes APPROVED lines as PO-eligible).
        const isReversingApproval = header.status === 'APPROVED' && (opts.action === 'REJECT' || opts.action === 'UNAPPROVE');
        if (opts.action === 'CANCEL' || isReversingApproval) {
          const consumed = await txQueryOne<{ n: string }>(
            tx,
            `SELECT COUNT(*) AS n FROM po_indent_sources pis
               JOIN purchase_order_lines pol ON pol.id = pis.po_line_id
               JOIN purchase_order_headers poh ON poh.id = pol.po_id
              WHERE pis.indent_id = $1 AND poh.status <> 'CANCELLED'`,
            [id],
          );
          if (Number(consumed?.n ?? 0) > 0) {
            throw BusinessRuleError(
              opts.action === 'UNAPPROVE'
                ? `Indent ${header.indent_no} has already been converted into one or more purchase orders and ` +
                  `cannot be unapproved. Cancel or short-close the linked purchase orders first.`
                : opts.action === 'REJECT'
                ? `Indent ${header.indent_no} has already been converted into one or more purchase orders and ` +
                  `cannot be rejected. Cancel or short-close the linked purchase orders first.`
                : `Indent ${header.indent_no} has already been converted into one or more purchase orders and ` +
                  `cannot be cancelled. Cancel or short-close the linked purchase orders first.`,
            );
          }
        }

        const now = new Date().toISOString();
        const setters: Record<string, [string, unknown]> = {
          SUBMIT: ['submitted_at = $3, submitted_by = $4', now],
          APPROVE: ['approved_at = $3, approved_by = $4, rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL', now],
          REJECT: [`rejected_at = $3, rejected_by = $4, rejection_reason = ${'$5'}`, now],
          CANCEL: ['closed_at = $3, closed_by = $4, close_reason = $5', now],
          REOPEN: ['approved_at = NULL, approved_by = NULL, rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL, submitted_at = NULL, submitted_by = NULL', now],
          CLOSE: ['closed_at = $3, closed_by = $4, close_reason = $5', now],
          // Genuinely distinct from REJECT: clears the approval decision back
          // to a clean draft — never writes rejected_at/rejection_reason, so
          // an unapproved indent can never be mistaken for a rejected one.
          UNAPPROVE: ['approved_at = NULL, approved_by = NULL, rejected_at = NULL, rejected_by = NULL, rejection_reason = NULL, submitted_at = NULL, submitted_by = NULL', now],
        };
        const [setClause, stamp] = setters[opts.action]!;

        const params: unknown[] = [id, opts.to, stamp, userId];
        if (['REJECT', 'CANCEL', 'CLOSE'].includes(opts.action)) params.push(reason ?? null);

        // updated_at binds to the SAME $3 stamp every other timestamp column uses
        // here (not a bare now()) — REOPEN's own setClause never references $3
        // itself (it only nulls columns out), and PGlite (unlike a lenient
        // Postgres client) rejects a bound parameter the query text never uses
        // ("bind message supplies N parameters, but prepared statement requires
        // fewer"). Reusing $3 here keeps every action's parameter list valid.
        await tx.query(
          `UPDATE purchase_indent_headers
              SET status = $2, ${setClause}, updated_at = $3, updated_by = $4
            WHERE id = $1`,
          params,
        );

        await tx.query(
          `INSERT INTO indent_approvals (indent_id, action, actor_user_id, reason, from_status, to_status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, opts.action, userId, reason ?? null, header.status, opts.to],
        );

        await auditIn(tx, {
          actor: actorFrom(req), action: opts.auditAction, entity: 'purchase_indent',
          entityId: id, entityLabel: header.indent_no,
          before: { status: header.status },
          after: {
            status: opts.to,
            requestedByUserId: header.requested_by_user_id,
            actorUserId: userId,
            actorRoles: req.user!.roles,
            selfApproval: isSelfApproval,
          },
          message: reason ?? (isSelfApproval ? 'Self-approved by an authorised Super Admin.' : null),
        });

        return { indentNo: header.indent_no, from: header.status, to: opts.to };
      });

      sendOk(res, {
        ...result,
        message: `Indent ${result.indentNo} is now ${opts.to.replace(/_/g, ' ').toLowerCase()}.`,
      });
    }),
  );
}

transitionRoute('/:id/submit', { action: 'SUBMIT', to: 'PENDING_APPROVAL', permission: 'indent.create', auditAction: 'SUBMIT' });
transitionRoute('/:id/approve', { action: 'APPROVE', to: 'APPROVED', permission: 'indent.approve', auditAction: 'APPROVE' });
transitionRoute('/:id/reject', { action: 'REJECT', to: 'REJECTED', permission: 'indent.reject', reasonRequired: true, auditAction: 'REJECT' });
transitionRoute('/:id/cancel', { action: 'CANCEL', to: 'CANCELLED', permission: 'indent.edit', reasonRequired: true, auditAction: 'CANCEL' });
transitionRoute('/:id/reopen', { action: 'REOPEN', to: 'DRAFT', permission: 'indent.edit', auditAction: 'REOPEN' });
// UNAPPROVE requires approval authority (not mere edit authority) — it
// reverses another approver's (or the actor's own, subject to the same
// self-approval rule APPROVE already enforces) official decision, which is a
// materially different act from a requester correcting their own rejected draft.
transitionRoute('/:id/unapprove', { action: 'UNAPPROVE', to: 'DRAFT', permission: 'indent.approve', auditAction: 'UNAPPROVE' });

/* ── DELETE /indents/:id (drafts only) ──────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('indent.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne<{ indent_no: string; status: IndentStatus }>(
      'SELECT indent_no, status FROM purchase_indent_headers WHERE id = $1', [id],
    );
    if (!header) throw NotFoundError('Purchase indent');

    // SRS §20: posted transactional records are never hard-deleted through the UI.
    if (header.status !== 'DRAFT') {
      throw BusinessRuleError(
        `Only draft indents can be deleted. Indent ${header.indent_no} is ${header.status.replace(/_/g, ' ').toLowerCase()} — cancel it instead so the audit trail is preserved.`,
      );
    }

    await withTransaction(async (tx) => {
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'purchase_indent', entityId: id,
        entityLabel: header.indent_no, before: header,
      });
      await tx.query('DELETE FROM purchase_indent_headers WHERE id = $1', [id]);
    });

    sendOk(res, { deleted: true, message: `Draft indent ${header.indent_no} has been deleted.` });
  }),
);

export default router;
