/**
 * Requisition — Purchase Module tab 4 (material request, distinct from the
 * supplier-facing Indent → PO → GRN chain — see status.ts header comment).
 *
 * USER creates → SUBMIT → HOD APPROVE/REJECT/RETURN → STORE ISSUE (atomic
 * stock deduction + issue slip) → COMPLETED. Reuses, unchanged: document
 * numbering (nextDocumentNumber), the audit trail, requirePermission /
 * requireAnyPermission, the lookups master (Department/Cost Centre/Machine),
 * and the stock ledger (domain/stock.ts issueRequisitionLine).
 */
import { Router, type Request } from 'express';
import { z } from 'zod';
import { chromium } from 'playwright';
import { query, queryOne, execute, withTransaction, txQuery, txQueryOne, SqlBuilder, type Queryable } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray, attachmentDisposition,
} from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError, AuthorizationError, ConflictError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { auditIn, audit, actorFrom } from '../../core/audit.js';
import { sendPrintDocument } from '../../core/html.js';
import { nextDocumentNumber, dateStamp, timeStamp, toDateOnly } from '../../domain/numbering.js';
import {
  assertRequisitionTransition, assertRequisitionEditable, assertNotAlready, REQUISITION_ISSUABLE, type RequisitionStatus,
} from '../../domain/status.js';
import { toQty, dec } from '../../domain/money.js';
import { recomputeRequisitionStatus } from '../../domain/quantities.js';
import { issueRequisitionLine, reverseRequisitionIssueLine } from '../../domain/stock.js';
import { loadCompanySettings } from '../../domain/company.js';
import { renderRequisitionDocumentHtml } from './requisition-document.js';
import { renderIssueSlipHtml } from './issue-slip-document.js';

const router = Router();

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/* ── Department → HOD mapping (reuses lookups.extra JSONB, ADR-014) ─────────── */

router.get(
  '/departments/:id/hod',
  requireAnyPermission('lookup.view', 'requisition.view', 'requisition.create'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const row = await queryOne<{ category: string; name: string; extra: Record<string, unknown> }>(
      'SELECT category, name, extra FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!row || row.category !== 'DEPARTMENT') throw NotFoundError('Department');
    let hodUserId = row.extra?.hodUserId ? Number(row.extra.hodUserId) : null;
    let hod = hodUserId
      ? await queryOne<{ id: number; employee_name: string; employee_id: string }>(
          'SELECT id, employee_name, employee_id FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId],
        )
      : null;
    let hodName = typeof row.extra?.hodName === 'string' ? row.extra.hodName : '';

    if (!hod && hodName) {
      hod = await queryOne<{ id: number; employee_name: string; employee_id: string }>(
        'SELECT id, employee_name, employee_id FROM users WHERE lower(employee_name) = lower($1) AND deleted_at IS NULL LIMIT 1',
        [hodName],
      );
      if (!hod) {
        const clean = hodName.replace(/^Mr\.?\s*/i, '').trim();
        hod = await queryOne<{ id: number; employee_name: string; employee_id: string }>(
          'SELECT id, employee_name, employee_id FROM users WHERE lower(employee_name) LIKE lower($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1',
          [`%${clean}%`],
        );
      }
    }

    if (!hod && row.name.trim().toUpperCase() === 'MDO') {
      hod = await queryOne<{ id: number; employee_name: string; employee_id: string }>(
        "SELECT id, employee_name, employee_id FROM users WHERE employee_id = '10221' AND deleted_at IS NULL",
      );
    }

    if (hod) {
      hodUserId = hod.id;
      hodName = hod.employee_name;
    }

    sendOk(res, { departmentId: id, hodUserId, hodName, hod });
  }),
);

router.put(
  '/departments/:id/hod',
  requirePermission('lookup.edit'),
  validateBody(z.object({ hodUserId: z.coerce.number().int().positive().nullable() })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { hodUserId } = req.body as { hodUserId: number | null };

    const dept = await queryOne<{ category: string; name: string; extra: Record<string, unknown> }>(
      'SELECT category, name, extra FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!dept || dept.category !== 'DEPARTMENT') throw NotFoundError('Department');

    let hodUser: { id: number; employee_name: string } | null = null;
    if (hodUserId != null) {
      hodUser = await queryOne<{ id: number; employee_name: string }>('SELECT id, employee_name FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId]);
      if (!hodUser) throw ValidationError('The selected HOD user does not exist.', [{ field: 'hodUserId', message: 'Not found.' }]);
    }

    await withTransaction(async (tx) => {
      const nextExtra: Record<string, unknown> = { ...dept.extra, hodUserId };
      if (hodUser) {
        nextExtra.hodName = hodUser.employee_name;
      }
      await tx.query('UPDATE lookups SET extra = $2, updated_at = now(), updated_by = $3 WHERE id = $1',
        [id, JSON.stringify(nextExtra), req.user!.id]);
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'department_hod', entityId: id, entityLabel: dept.name,
        before: { hodUserId: dept.extra?.hodUserId ?? null }, after: { hodUserId },
      });
    });
    sendOk(res, { departmentId: id, hodUserId, message: `HOD mapping for ${dept.name} updated.` });
  }),
);

/** Resolves the department's currently-mapped HOD, snapshotting the name too. */
async function resolveHod(tx: Queryable, departmentId: number | null): Promise<{ hodUserId: number | null; hodName: string }> {
  if (!departmentId) return { hodUserId: null, hodName: '' };
  const dept = await txQueryOne<{ name: string; extra: Record<string, unknown> }>(
    tx, 'SELECT name, extra FROM lookups WHERE id = $1', [departmentId],
  );
  let hodUserId = dept?.extra?.hodUserId ? Number(dept.extra.hodUserId) : null;
  let hodName = typeof dept?.extra?.hodName === 'string' ? dept.extra.hodName : '';

  if (hodUserId) {
    const hod = await txQueryOne<{ employee_name: string }>(
      tx, 'SELECT employee_name FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId],
    );
    if (hod?.employee_name) hodName = hod.employee_name;
  } else if (hodName) {
    let matchedUser = await txQueryOne<{ id: number; employee_name: string }>(
      tx, 'SELECT id, employee_name FROM users WHERE lower(employee_name) = lower($1) AND deleted_at IS NULL LIMIT 1', [hodName],
    );
    if (!matchedUser) {
      const clean = hodName.replace(/^Mr\.?\s*/i, '').trim();
      matchedUser = await txQueryOne<{ id: number; employee_name: string }>(
        tx, 'SELECT id, employee_name FROM users WHERE lower(employee_name) LIKE lower($1) AND deleted_at IS NULL ORDER BY id ASC LIMIT 1', [`%${clean}%`],
      );
    }
    if (matchedUser) {
      hodUserId = matchedUser.id;
      hodName = matchedUser.employee_name;
    }
  }

  // Explicit MDO fallback
  if (!hodUserId && dept?.name?.trim().toUpperCase() === 'MDO') {
    const kunal = await txQueryOne<{ id: number; employee_name: string }>(
      tx, "SELECT id, employee_name FROM users WHERE employee_id = '10221' AND deleted_at IS NULL",
    );
    if (kunal) {
      hodUserId = kunal.id;
      hodName = kunal.employee_name;
    }
  }

  return { hodUserId, hodName };
}

/* ── List ───────────────────────────────────────────────────────────────────── */

const SORTABLE: Record<string, string> = {
  requisitionNo: 'h.requisition_no',
  requisitionDate: 'h.requisition_date',
  status: 'h.status',
  createdAt: 'h.created_at',
};

/** The list's query; its Export accepts exactly the same, views included (io/datasets.ts). */
export const listSchema = listQuerySchema.extend({
  status: csvArray,
  /** User-facing, independent status columns (v_requisition_header_balance) — never merged with `status`. */
  hodStatus: csvArray,
  storeStatus: csvArray,
  departmentId: csvIdArray,
  requesterId: csvIdArray,
  userId: csvIdArray,
  hodId: csvIdArray,
  machineId: csvIdArray,
  costCentreId: csvIdArray,
  itemId: csvIdArray,
  dateFrom: dateStr.optional(),
  dateTo: dateStr.optional(),
  /** `mine` | `hod-pending` | `store-queue` | omitted (everything the caller may view). */
  view: z.enum(['mine', 'hod-pending', 'store-queue']).optional(),
  /** The requisitions the requisition KPIs count: every one but cancelled. */
  excludeCancelled: z.enum(['true', 'false']).optional(),
});

export const LIST_FROM = `
  FROM requisition_headers h
  JOIN v_requisition_header_balance b ON b.requisition_id = h.id
  LEFT JOIN users ru ON ru.id = h.requester_user_id
  LEFT JOIN lookups d ON d.id = h.department_id`;

export function buildFilter(q: z.infer<typeof listSchema>, userId: number): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('h.status', q.status);
  if (q.excludeCancelled === 'true') b.addRaw("h.status <> 'CANCELLED'");
  b.addIn('b.hod_status', q.hodStatus);
  b.addIn('b.store_status', q.storeStatus);
  b.addIn('h.department_id', q.departmentId);
  b.addIn('h.requester_user_id', q.userId || q.requesterId);
  b.addIn('h.hod_user_id', q.hodId);
  b.addIn('h.machine_id', q.machineId);
  b.addIn('h.cost_centre_id', q.costCentreId);
  b.add('h.requisition_date >= ?', q.dateFrom);
  b.add('h.requisition_date <= ?', q.dateTo);
  if (q.itemId && q.itemId.length > 0) {
    const p = b.push(q.itemId);
    b.addRaw(`EXISTS (SELECT 1 FROM requisition_lines l WHERE l.requisition_id = h.id AND l.item_id = ANY(${p}))`);
  }
  if (q.view === 'mine') {
    b.add('h.requester_user_id = ?', userId);
  } else if (q.view === 'hod-pending') {
    b.add('h.hod_user_id = ?', userId);
    b.addRaw("h.status = 'PENDING_APPROVAL'");
  } else if (q.view === 'store-queue') {
    b.addRaw("h.status IN ('APPROVED','PARTIALLY_ISSUED')");
  }
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(h.requisition_no) LIKE ${p} OR lower(COALESCE(ru.employee_name,'')) LIKE ${p} ` +
      `OR lower(COALESCE(ru.employee_id,'')) LIKE ${p} OR lower(COALESCE(d.name,'')) LIKE ${p} ` +
      `OR EXISTS (SELECT 1 FROM requisition_lines l WHERE l.requisition_id = h.id ` +
      `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p})))`,
    );
  }
  return b;
}

router.get(
  '/',
  requirePermission('requisition.view'),
  validateQuery(listSchema),
  asyncHandler(async (req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildFilter(q, req.user!.id);

    const totalRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n ${LIST_FROM} ${b.where()}`, b.params);
    const total = Number(totalRow?.n ?? 0);
    const order = resolveSort(q, SORTABLE, 'requisitionDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(
      `SELECT h.id, h.requisition_no, h.requisition_date, h.status,
              h.employee_name, h.employee_code, h.department_name, h.hod_name, h.machine_id, h.cost_centre_id,
              h.requester_user_id, h.hod_user_id,
              cc.name AS cost_centre_name, m.name AS machine_name,
              b.hod_status, b.store_status,
              b.line_count, b.total_requested_qty, b.total_issued_qty, b.total_pending_qty, b.total_excess_qty,
              (SELECT string_agg(DISTINCT l.item_code, ', ' ORDER BY l.item_code) FROM requisition_lines l WHERE l.requisition_id = h.id) AS item_codes,
              (SELECT l.item_description FROM requisition_lines l WHERE l.requisition_id = h.id ORDER BY l.line_no LIMIT 1) AS first_item_description,
              (SELECT i.live_stock_qty FROM requisition_lines l JOIN items i ON i.id = l.item_id
                WHERE l.requisition_id = h.id ORDER BY l.line_no LIMIT 1) AS first_item_available_stock,
              (SELECT i.issue_slip_no FROM requisition_issues i WHERE i.requisition_id = h.id AND i.status = 'POSTED'
                ORDER BY i.created_at DESC LIMIT 1) AS last_issue_slip_no,
              (SELECT MAX(i.issue_date) FROM requisition_issues i WHERE i.requisition_id = h.id AND i.status = 'POSTED') AS last_issue_date,
              (CURRENT_DATE - h.requisition_date)::int AS age_days
         ${LIST_FROM}
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN lookups m ON m.id = h.machine_id
         ${b.where()}
        ORDER BY ${order}, h.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    const cb = buildFilter({ ...q, status: undefined, hodStatus: undefined, storeStatus: undefined }, req.user!.id);
    const tb = buildFilter(q, req.user!.id);
    const [statusCounts, hodStatusCounts, storeStatusCounts, totalsRow] = await Promise.all([
      query<{ status: string; n: string }>(`SELECT h.status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY h.status`, cb.params),
      query<{ hod_status: string; n: string }>(`SELECT b.hod_status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY b.hod_status`, cb.params),
      query<{ store_status: string; n: string }>(`SELECT b.store_status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY b.store_status`, cb.params),
      queryOne<{
        requisition_count: string;
        line_count: string;
        total_requested_qty: string;
        total_issued_qty: string;
        total_pending_qty: string;
        total_excess_qty: string;
      }>(
        `SELECT
           COUNT(DISTINCT h.id) AS requisition_count,
           COALESCE(SUM(b.line_count), 0) AS line_count,
           COALESCE(SUM(b.total_requested_qty), 0) AS total_requested_qty,
           COALESCE(SUM(b.total_issued_qty), 0) AS total_issued_qty,
           COALESCE(SUM(b.total_pending_qty), 0) AS total_pending_qty,
           COALESCE(SUM(b.total_excess_qty), 0) AS total_excess_qty
         ${LIST_FROM}
         ${tb.where()}`,
        tb.params,
      ),
    ]);

    sendPage(res, rows, total, q.page, q.pageSize, {
      statusCounts: Object.fromEntries(statusCounts.map((c) => [c.status, Number(c.n)])),
      hodStatusCounts: Object.fromEntries(hodStatusCounts.map((c) => [c.hod_status, Number(c.n)])),
      storeStatusCounts: Object.fromEntries(storeStatusCounts.map((c) => [c.store_status, Number(c.n)])),
      totals: {
        requisitionCount: Number(totalsRow?.requisition_count ?? total),
        lineCount: Number(totalsRow?.line_count ?? 0),
        totalRequestedQty: Number(totalsRow?.total_requested_qty ?? 0),
        totalIssuedQty: Number(totalsRow?.total_issued_qty ?? 0),
        totalPendingQty: Number(totalsRow?.total_pending_qty ?? 0),
        totalExcessQty: Number(totalsRow?.total_excess_qty ?? 0),
      },
    });
  }),
);

/* ── Detail ─────────────────────────────────────────────────────────────────── */

router.get(
  '/:id',
  requirePermission('requisition.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne<Record<string, unknown>>(
      `SELECT h.*, ru.employee_name AS requester_name_live, ru.employee_id AS requester_employee_id,
              d.name AS department_name_live, cc.name AS cost_centre_name, m.name AS machine_name,
              su.employee_name AS submitted_by_name, hu.employee_name AS hod_decided_by_name,
              cu.employee_name AS created_by_name, xu.employee_name AS closed_by_name,
              hb.hod_status, hb.store_status,
              hb.total_requested_qty, hb.total_issued_qty, hb.total_pending_qty, hb.total_excess_qty
         FROM requisition_headers h
         JOIN v_requisition_header_balance hb ON hb.requisition_id = h.id
         LEFT JOIN users ru ON ru.id = h.requester_user_id
         LEFT JOIN lookups d ON d.id = h.department_id
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN lookups m ON m.id = h.machine_id
         LEFT JOIN users su ON su.id = h.submitted_by
         LEFT JOIN users hu ON hu.id = h.hod_decided_by
         LEFT JOIN users cu ON cu.id = h.created_by
         LEFT JOIN users xu ON xu.id = h.closed_by
        WHERE h.id = $1`,
      [id],
    );
    if (!header) throw NotFoundError('Requisition');

    const lines = await query(
      `SELECT v.*, u.code AS uom_code, u.name AS uom_name, l.remarks, i.live_stock_qty AS available_stock,
              COALESCE(
                NULLIF(i.standard_rate, 0),
                (SELECT gl.rate FROM grn_lines gl WHERE gl.item_id = l.item_id AND gl.rate > 0 ORDER BY gl.id DESC LIMIT 1)
              ) AS estimated_rate,
              CASE
                WHEN COALESCE(
                  NULLIF(i.standard_rate, 0),
                  (SELECT gl.rate FROM grn_lines gl WHERE gl.item_id = l.item_id AND gl.rate > 0 ORDER BY gl.id DESC LIMIT 1)
                ) IS NOT NULL
                THEN ROUND(l.requested_qty * COALESCE(
                  NULLIF(i.standard_rate, 0),
                  (SELECT gl.rate FROM grn_lines gl WHERE gl.item_id = l.item_id AND gl.rate > 0 ORDER BY gl.id DESC LIMIT 1)
                ), 2)
                ELSE NULL
              END AS estimated_value
         FROM requisition_lines l
         JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN lookups u ON u.id = l.uom_id
        WHERE l.requisition_id = $1
        ORDER BY l.line_no`,
      [id],
    );

    const approvals = await query(
      `SELECT a.id, a.action, a.reason, a.from_status, a.to_status, a.created_at,
              u.employee_name AS actor_name, u.employee_id AS actor_code
         FROM requisition_approvals a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.requisition_id = $1
        ORDER BY a.created_at ASC`,
      [id],
    );

    // Reversed slips stay in the history (marked, with who/when/why); the line
    // balances above already ignore them.
    const issues = await query(
      `SELECT i.id, i.issue_slip_no, i.issue_date, i.remarks, i.created_at,
              i.status, i.reversed_at, i.reversal_reason, xu.employee_name AS reversed_by_name,
              su.employee_name AS store_user_name,
              json_agg(json_build_object(
                'itemCode', ril.item_code, 'itemDescription', ril.item_description,
                'requestedQtySnapshot', ril.requested_qty_snapshot,
                'previouslyIssuedQty', ril.previously_issued_qty,
                'issueQty', ril.issue_qty
              ) ORDER BY ril.id) AS lines
         FROM requisition_issues i
         LEFT JOIN users su ON su.id = i.store_user_id
         LEFT JOIN users xu ON xu.id = i.reversed_by
         LEFT JOIN (
           SELECT ril.*, rl.item_code, rl.item_description
             FROM requisition_issue_lines ril
             JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
         ) ril ON ril.requisition_issue_id = i.id
        WHERE i.requisition_id = $1
        GROUP BY i.id, i.issue_slip_no, i.issue_date, i.remarks, i.created_at,
                 i.status, i.reversed_at, i.reversal_reason, xu.employee_name, su.employee_name
        ORDER BY i.created_at DESC`,
      [id],
    );

    sendOk(res, { ...header, lines, approvals, issues });
  }),
);

/* ── Create / update ────────────────────────────────────────────────────────── */

const requisitionLineSchema = z.object({
  itemId: z.coerce.number().int().positive({ message: 'Select an item.' }),
  requestedQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Requested quantity must be greater than zero.'),
  remarks: z.string().trim().max(500).default(''),
  rate: z.union([z.number(), z.string()]).nullable().optional(),
  estimatedRate: z.union([z.number(), z.string()]).nullable().optional(),
});

const requisitionSchema = z.object({
  requesterUserId: z.coerce.number().int().positive().nullable().optional(),
  requisitionDate: dateStr.optional(),
  machineId: z.coerce.number().int().positive().nullable().optional(),
  costCentreId: z.coerce.number().int().positive().nullable().optional(),
  remarks: z.string().trim().max(1000).default(''),
  lines: z.array(requisitionLineSchema).min(1, 'Add at least one item line.'),
  /** When true, immediately submits for HOD approval after saving. */
  submit: z.boolean().default(false),
});

type RequisitionBody = z.infer<typeof requisitionSchema>;

async function writeRequisitionLines(tx: Queryable, requisitionId: number, lines: RequisitionBody['lines']): Promise<void> {
  const itemIds = [...new Set(lines.map((l) => l.itemId))];
  const items = await txQuery<{ id: number; item_code: string; item_description: string; uom_id: number | null; main_group_id: number | null; is_active: boolean }>(
    tx, 'SELECT id, item_code, item_description, uom_id, main_group_id, is_active FROM items WHERE id = ANY($1) AND deleted_at IS NULL', [itemIds],
  );
  const itemMap = new Map(items.map((i) => [Number(i.id), i]));
  const missing = itemIds.filter((i) => !itemMap.has(i));
  if (missing.length > 0) {
    throw ValidationError('One or more selected items no longer exist.', [{ field: 'lines', message: `Unknown item id(s): ${missing.join(', ')}.` }]);
  }
  const inactive = items.filter((i) => !i.is_active).map((i) => i.item_code);
  if (inactive.length > 0) throw BusinessRuleError(`These items are inactive and cannot be requisitioned: ${inactive.join(', ')}.`);

  let mainGroupNames = new Map<number, string>();
  const groupIds = [...new Set(items.map((i) => i.main_group_id).filter((v): v is number => v != null))];
  if (groupIds.length > 0) {
    const groups = await txQuery<{ id: number; name: string }>(tx, 'SELECT id, name FROM lookups WHERE id = ANY($1)', [groupIds]);
    mainGroupNames = new Map(groups.map((g) => [Number(g.id), g.name]));
  }

  await tx.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [requisitionId]);
  for (const [i, line] of lines.entries()) {
    const item = itemMap.get(line.itemId)!;
    await tx.query(
      `INSERT INTO requisition_lines
         (requisition_id, line_no, item_id, item_code, item_description, main_group_name, uom_id, requested_qty, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        requisitionId, i + 1, item.id, item.item_code, item.item_description,
        item.main_group_id ? (mainGroupNames.get(item.main_group_id) ?? '') : '',
        item.uom_id, toQty(line.requestedQty), line.remarks,
      ],
    );
  }
}

router.post(
  '/',
  requirePermission('requisition.create'),
  validateBody(requisitionSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as RequisitionBody;
    const userId = req.user!.id;
    const canCreateOnBehalf =
      req.user?.roles?.includes('ADMIN') ||
      req.user?.roles?.includes('SUPER_ADMIN') ||
      req.user?.roles?.includes('STORE') ||
      req.user?.isSuperAdmin;
    const effectiveRequesterId = body.requesterUserId && canCreateOnBehalf ? body.requesterUserId : userId;
    const when = body.requisitionDate ? new Date(`${body.requisitionDate}T00:00:00`) : new Date();

    const id = await withTransaction(async (tx) => {
      const requester = await txQueryOne<{ employee_name: string; employee_id: string; department_id: number | null }>(
        tx, 'SELECT employee_name, employee_id, department_id FROM users WHERE id = $1', [effectiveRequesterId],
      );
      if (!requester) throw new Error('Requester user not found.');
      const dept = requester.department_id
        ? await txQueryOne<{ name: string }>(tx, 'SELECT name FROM lookups WHERE id = $1', [requester.department_id])
        : null;
      const { hodUserId, hodName } = await resolveHod(tx, requester.department_id);

      // Auto-resolve cost centre if not explicitly supplied
      let costCentreId = body.costCentreId ?? null;
      if (!costCentreId && requester.department_id) {
        const cc = await txQueryOne<{ id: number }>(
          tx,
          `SELECT id FROM lookups
            WHERE category = 'COST_CENTRE'
              AND deleted_at IS NULL
              AND (upper(name) = upper($1) OR upper(name) LIKE upper($1 || '%'))
            ORDER BY id ASC LIMIT 1`,
          [dept?.name ?? ''],
        );
        if (cc) costCentreId = cc.id;
      }

      const requisitionNo = await nextDocumentNumber(tx, 'REQUISITION', when);
      const status: RequisitionStatus = body.submit ? 'PENDING_APPROVAL' : 'DRAFT';

      const header = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO requisition_headers
           (requisition_no, requisition_date, requisition_time, requester_user_id, employee_code, employee_name,
            department_id, department_name, hod_user_id, hod_name, machine_id, cost_centre_id, remarks, status,
            submitted_at, submitted_by, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         RETURNING id`,
        [
          requisitionNo, dateStamp(when), timeStamp(), effectiveRequesterId, requester.employee_id, requester.employee_name,
          requester.department_id, dept?.name ?? '', hodUserId, hodName, body.machineId ?? null, costCentreId,
          body.remarks, status, body.submit ? new Date().toISOString() : null, body.submit ? userId : null, userId,
        ],
      );
      if (!header) throw new Error('Failed to create requisition header.');

      await writeRequisitionLines(tx, header.id, body.lines);

      await auditIn(tx, {
        actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'CREATE', entity: 'requisition',
        entityId: header.id, entityLabel: requisitionNo,
        after: { requisitionNo, status, lineCount: body.lines.length, hodUserId },
      });
      if (body.submit) {
        await txQuery(tx,
          `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,'DRAFT','PENDING_APPROVAL')`,
          [header.id, userId]);
      }

      return header.id;
    });

    sendCreated(res, await queryOne('SELECT * FROM requisition_headers WHERE id = $1', [id]));
  }),
);

/**
 * A requisition belongs to the person who raised it.
 *
 * Editing, submitting, reopening, cancelling and deleting it are for that
 * person, for the HOD it is routed to (who reviews and may correct it), or for
 * a Super Admin. The permission alone cannot decide this: everybody who may
 * raise a requisition holds `requisition.edit`, so without this check any of
 * them could change the quantities on, or cancel, a colleague's request.
 * (HOD decisions — approve / reject / return — have their own check below.)
 */
function assertOwnRequisition(
  req: Request,
  doc: { requisition_no: string; requester_user_id: number | null; hod_user_id: number | null },
): void {
  const user = req.user!;
  if (user.isSuperAdmin) return;
  if (doc.requester_user_id != null && Number(doc.requester_user_id) === Number(user.id)) return;
  if (doc.hod_user_id != null && Number(doc.hod_user_id) === Number(user.id)) return;
  throw AuthorizationError(
    `Requisition ${doc.requisition_no} was raised by someone else. Only the person who raised it, ` +
    'its HOD or an administrator can change it.',
  );
}

router.put(
  '/:id',
  // The raiser (requisition.edit) or an authorised HOD reviewing it
  // (requisition.approve) may edit — mirrors the Indent PENDING_APPROVAL
  // edit fix exactly. WHICH raiser and WHICH HOD is enforced by
  // assertOwnRequisition, not by the permission.
  requireAnyPermission('requisition.edit', 'requisition.approve'),
  validateBody(requisitionSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as RequisitionBody;
    const userId = req.user!.id;

    const before = await queryOne<{
      requisition_no: string; status: RequisitionStatus; department_id: number | null;
      requester_user_id: number | null; hod_user_id: number | null;
    }>(
      'SELECT requisition_no, status, department_id, requester_user_id, hod_user_id FROM requisition_headers WHERE id = $1', [id],
    );
    if (!before) throw NotFoundError('Requisition');
    assertOwnRequisition(req, before);
    assertRequisitionEditable(before.status, before.requisition_no);

    await withTransaction(async (tx) => {
      await tx.query('SELECT id FROM requisition_headers WHERE id = $1 FOR UPDATE', [id]);

      const status: RequisitionStatus = body.submit ? 'PENDING_APPROVAL' : before.status;
      if (body.submit) assertRequisitionTransition(before.status, 'PENDING_APPROVAL');
      // Re-resolve the HOD at (re)submission time — a department's mapping
      // may have changed since this draft/returned document was first raised.
      const { hodUserId, hodName } = body.submit ? await resolveHod(tx, before.department_id) : { hodUserId: undefined, hodName: undefined };

      // Two separate statements, not one with an optional fragment: the old
      // single statement numbered its parameters for the "submit" case only, so
      // a plain "save draft" sent 7 values to a query that referenced $9 and
      // PGlite refused it ("could not determine data type of parameter $7") —
      // every save-without-submit of an existing requisition failed with a 500.
      // Saving without submitting also must not stamp submitted_at/_by at all.
      if (body.submit) {
        await tx.query(
          `UPDATE requisition_headers
              SET machine_id = $2, cost_centre_id = $3, remarks = $4, status = $5,
                  hod_user_id = $7, hod_name = $8,
                  submitted_at = COALESCE(submitted_at, $6), submitted_by = COALESCE(submitted_by, $9),
                  updated_at = now(), updated_by = $9
            WHERE id = $1`,
          [id, body.machineId ?? null, body.costCentreId ?? null, body.remarks, status,
           new Date().toISOString(), hodUserId, hodName, userId],
        );
      } else {
        await tx.query(
          `UPDATE requisition_headers
              SET machine_id = $2, cost_centre_id = $3, remarks = $4, status = $5,
                  updated_at = now(), updated_by = $6
            WHERE id = $1`,
          [id, body.machineId ?? null, body.costCentreId ?? null, body.remarks, status, userId],
        );
      }

      await writeRequisitionLines(tx, id, body.lines);

      await auditIn(tx, {
        actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'UPDATE', entity: 'requisition',
        entityId: id, entityLabel: before.requisition_no,
        before, after: { status, lineCount: body.lines.length },
      });
      if (body.submit) {
        await txQuery(tx,
          `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,$3,'PENDING_APPROVAL')`,
          [id, userId, before.status]);
      }
    });

    sendOk(res, await queryOne('SELECT * FROM requisition_headers WHERE id = $1', [id]));
  }),
);

/* ── Transitions: submit (draft->pending, no line changes) / approve / reject / return / reopen / cancel ── */

interface TransitionOptions {
  action: 'SUBMIT' | 'APPROVE' | 'REJECT' | 'RETURN' | 'REOPEN' | 'CANCEL';
  to: RequisitionStatus;
  permission: string;
  reasonRequired?: boolean;
  /** HOD-only actions additionally require actorId === the resolved hod_user_id (or Super Admin). */
  hodOnly?: boolean;
}

const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });

function transitionRoute(path: string, opts: TransitionOptions): void {
  router.post(
    path,
    requirePermission(opts.permission),
    validateBody(reasonSchema),
    asyncHandler(async (req, res) => {
      const id = idParam(req);
      const { reason } = req.body as z.infer<typeof reasonSchema>;
      const userId = req.user!.id;

      if (opts.reasonRequired && (!reason || reason.trim().length === 0)) {
        throw ValidationError('A reason is required.', [{ field: 'reason', message: 'Please state the reason.' }]);
      }

      const result = await withTransaction(async (tx) => {
        const header = await txQueryOne<{
          id: number; requisition_no: string; status: RequisitionStatus;
          requester_user_id: number; hod_user_id: number | null;
        }>(
          tx, 'SELECT id, requisition_no, status, requester_user_id, hod_user_id FROM requisition_headers WHERE id = $1 FOR UPDATE', [id],
        );
        if (!header) throw NotFoundError('Requisition');
        // Submit / reopen / cancel are the raiser's own actions (the HOD-only
        // decisions are checked separately just below).
        if (!opts.hodOnly) assertOwnRequisition(req, header);
        assertNotAlready('Requisition', header.requisition_no, header.status, opts.to);
        assertRequisitionTransition(header.status, opts.to);

        // Wrong HOD must not approve/reject/return (Rule: HOD approval
        // security) — only the SPECIFIC department's mapped HOD, or a Super
        // Admin override, exactly like Indent's self-approval exception.
        if (opts.hodOnly && !req.user!.isSuperAdmin && header.hod_user_id !== userId) {
          throw AuthorizationError(
            header.hod_user_id
              ? 'You are not the authorised HOD for this requisition\'s department.'
              : 'This requisition\'s department has no HOD configured — an administrator must set one.',
          );
        }

        // Self-approval: the SAME explicit-permission policy as Indent — a
        // Super Admin MAY approve their own requisition; an ordinary HOD
        // (even if they hold requisition.approve generally) may not,
        // regardless of write permissions elsewhere.
        const isSelfApproval = opts.action === 'APPROVE' && header.requester_user_id === userId;
        if (isSelfApproval && !req.user!.isSuperAdmin) {
          throw BusinessRuleError('You cannot approve a requisition you raised yourself. Another authorised HOD must action it.');
        }

        // Unapprove (APPROVE -> REJECTED via this same REJECT route, or a
        // CANCEL) is refused while anything is actually issued — reverse the
        // issue first, not the requisition (mirrors Indent/PO consumption guard).
        // A reversed slip has given its stock back, so it no longer counts.
        if ((opts.action === 'REJECT' && header.status === 'APPROVED') || opts.action === 'CANCEL') {
          const issued = await txQueryOne<{ n: string }>(
            tx, `SELECT COUNT(*) AS n FROM requisition_issue_lines ril
                   JOIN requisition_issues ri ON ri.id = ril.requisition_issue_id
                  WHERE ri.requisition_id = $1 AND ri.status = 'POSTED'`, [id],
          );
          if (Number(issued?.n ?? 0) > 0) {
            throw BusinessRuleError(
              `Requisition ${header.requisition_no} already has material issued against it and cannot be ` +
              `${opts.action === 'CANCEL' ? 'cancelled' : 'unapproved'}. Reverse the relevant issue(s) first.`,
            );
          }
        }

        const now = new Date().toISOString();
        const setters: Record<string, string> = {
          APPROVE: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = NULL',
          REJECT: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = $5',
          RETURN: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = $5',
          REOPEN: 'hod_decided_at = NULL, hod_decided_by = NULL, hod_decision_reason = NULL, submitted_at = NULL, submitted_by = NULL',
          CANCEL: 'closed_at = $3, closed_by = $4, close_reason = $5',
          SUBMIT: 'submitted_at = $3, submitted_by = $4',
        };
        const setClause = setters[opts.action]!;
        const params: unknown[] = [id, opts.to, now, userId];
        if (['REJECT', 'RETURN', 'CANCEL'].includes(opts.action)) params.push(reason ?? null);

        await tx.query(
          `UPDATE requisition_headers SET status = $2, ${setClause}, updated_at = $3, updated_by = $4 WHERE id = $1`,
          params,
        );
        await txQuery(tx,
          `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, reason, from_status, to_status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, opts.action, userId, reason ?? null, header.status, opts.to],
        );

        await auditIn(tx, {
          actor: actorFrom(req), action: opts.action,
          entity: 'requisition', entityId: id, entityLabel: header.requisition_no,
          before: { status: header.status },
          after: { status: opts.to, actorUserId: userId, requesterUserId: header.requester_user_id, selfApproval: isSelfApproval },
          message: reason ?? (isSelfApproval ? 'Self-approved by an authorised Super Admin.' : null),
        });

        return { requisitionNo: header.requisition_no, from: header.status, to: opts.to };
      });

      sendOk(res, { ...result, message: `Requisition ${result.requisitionNo} is now ${result.to.replace(/_/g, ' ').toLowerCase()}.` });
    }),
  );
}

transitionRoute('/:id/submit', { action: 'SUBMIT', to: 'PENDING_APPROVAL', permission: 'requisition.create' });
transitionRoute('/:id/approve', { action: 'APPROVE', to: 'APPROVED', permission: 'requisition.approve', hodOnly: true });
transitionRoute('/:id/reject', { action: 'REJECT', to: 'REJECTED', permission: 'requisition.approve', reasonRequired: true, hodOnly: true });
transitionRoute('/:id/return', { action: 'RETURN', to: 'RETURNED', permission: 'requisition.approve', reasonRequired: true, hodOnly: true });
transitionRoute('/:id/reopen', { action: 'REOPEN', to: 'DRAFT', permission: 'requisition.edit' });
transitionRoute('/:id/cancel', { action: 'CANCEL', to: 'CANCELLED', permission: 'requisition.edit', reasonRequired: true });

/* ── DELETE (drafts only) ───────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('requisition.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const req_ = await queryOne<{
      requisition_no: string; status: RequisitionStatus; requester_user_id: number | null; hod_user_id: number | null;
    }>(
      'SELECT requisition_no, status, requester_user_id, hod_user_id FROM requisition_headers WHERE id = $1', [id],
    );
    if (!req_) throw NotFoundError('Requisition');
    assertOwnRequisition(req, req_);
    if (req_.status !== 'DRAFT') {
      throw BusinessRuleError(`Only draft requisitions can be deleted. Requisition ${req_.requisition_no} is ${req_.status.toLowerCase()} — cancel it instead.`);
    }
    await withTransaction(async (tx) => {
      await auditIn(tx, { actor: actorFrom(req), action: 'DELETE', entity: 'requisition', entityId: id, entityLabel: req_.requisition_no, before: req_ });
      await tx.query('DELETE FROM requisition_headers WHERE id = $1', [id]);
    });
    sendOk(res, { deleted: true, message: `Draft requisition ${req_.requisition_no} has been deleted.` });
  }),
);

/* ── Store issue — atomic multi-line stock deduction + issue slip ───────────── */

const issueLineSchema = z.object({
  requisitionLineId: z.coerce.number().int().positive(),
  issueQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Issue quantity must be greater than zero.'),
  /**
   * The line's issued quantity as the issue dialog showed it. When it no longer
   * matches, the issue is refused with 409: the dialog was stale, or this is the
   * same issue sent twice. A double click on "Issue material" posted two slips and
   * deducted the stock twice (2026-10-17 E2E S4-12), and nothing else can tell a
   * repeat from a deliberate over-issue, which Rule 24 allows. Optional, so a
   * caller that does not send it keeps the old behaviour.
   */
  expectedIssuedQty: z.union([z.number(), z.string()])
    .refine((v) => String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0, 'Must be a quantity of zero or more.')
    .optional(),
});

const issueSchema = z.object({
  lines: z.array(issueLineSchema).min(1, 'Select at least one line to issue.'),
  remarks: z.string().trim().max(1000).default(''),
});

router.post(
  '/:id/issue',
  requirePermission('requisition.issue'),
  validateBody(issueSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof issueSchema>;
    const userId = req.user!.id;
    const when = new Date();

    const result = await withTransaction(async (tx) => {
      const header = await txQueryOne<{ id: number; requisition_no: string; status: RequisitionStatus }>(
        tx, 'SELECT id, requisition_no, status FROM requisition_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!header) throw NotFoundError('Requisition');
      if (!REQUISITION_ISSUABLE.has(header.status)) {
        throw BusinessRuleError(
          `Requisition ${header.requisition_no} is ${header.status.replace(/_/g, ' ').toLowerCase()} and is not awaiting store issue. ` +
          'It must be HOD-approved first.',
        );
      }

      const issueSlipNo = await nextDocumentNumber(tx, 'ISSUE_SLIP', when);
      const issueHeader = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO requisition_issues (issue_slip_no, requisition_id, issue_date, issue_time, store_user_id, remarks, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING id`,
        [issueSlipNo, id, dateStamp(when), timeStamp(), userId, body.remarks],
      );
      if (!issueHeader) throw new Error('Failed to create issue slip.');

      const issued: { itemCode: string; issueQty: string }[] = [];
      for (const [i, line] of body.lines.entries()) {
        // Lock this requisition line's balance row to serialise concurrent
        // store users issuing against the SAME line (Rule 29) — the item-row
        // lock inside issueRequisitionLine additionally serialises by ITEM,
        // which is what actually protects stock when two DIFFERENT
        // requisition lines compete for the same item.
        const bal = await txQueryOne<{
          item_id: number; item_code: string; requested_qty: string; issued_qty: string; uom_id: number | null;
        }>(
          tx,
          `SELECT rl.item_id, rl.item_code, rl.requested_qty, rl.uom_id,
                  COALESCE((SELECT SUM(ril.issue_qty) FROM requisition_issue_lines ril
                              JOIN requisition_issues ri ON ri.id = ril.requisition_issue_id
                             WHERE ril.requisition_line_id = rl.id AND ri.status = 'POSTED'), 0) AS issued_qty
             FROM requisition_lines rl WHERE rl.id = $1 AND rl.requisition_id = $2 FOR UPDATE`,
          [line.requisitionLineId, id],
        );
        if (!bal) {
          throw ValidationError(`Line ${i + 1}: not a valid line on this requisition.`, [{ field: `lines.${i}.requisitionLineId`, message: 'Not found.' }]);
        }
        // A stale or repeated issue (expectedIssuedQty, issueLineSchema). Checked
        // under the line lock and inside the transaction, so the slip and any line
        // already deducted above roll back with it: nothing is issued.
        if (line.expectedIssuedQty !== undefined && !dec(line.expectedIssuedQty).eq(dec(bal.issued_qty))) {
          throw ConflictError(
            `Line ${i + 1} (${bal.item_code}) now has ${toQty(bal.issued_qty)} issued, not the ${toQty(line.expectedIssuedQty)} ` +
            'shown when this issue was prepared: another issue was posted or reversed in the meantime, or this one was sent twice. ' +
            'Nothing was issued. Check the quantities again before issuing.',
            { requisitionLineId: line.requisitionLineId, expectedIssuedQty: toQty(line.expectedIssuedQty), issuedQty: toQty(bal.issued_qty) },
          );
        }

        const issueQty = toQty(line.issueQty);
        // Rule 8/24: the ONLY ceiling is current stock — issueRequisitionLine
        // enforces that atomically under the item row lock. Rule 24 (explicit):
        // NEVER check issueQty against requested/pending — over-issue is allowed.
        await issueRequisitionLine(
          tx, { item_id: bal.item_id, uom_id: bal.uom_id }, issueQty,
          { requisitionId: id, requisitionNo: header.requisition_no, issueId: issueHeader.id, issueSlipNo, issueDate: dateStamp(when), requisitionLineId: line.requisitionLineId, userId },
        );

        await tx.query(
          `INSERT INTO requisition_issue_lines
             (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [issueHeader.id, line.requisitionLineId, bal.item_id, bal.requested_qty, bal.issued_qty, issueQty, bal.uom_id, ''],
        );
        issued.push({ itemCode: bal.item_code, issueQty });
      }

      // Recompute overall status from the authoritative balance view.
      const totals = await recomputeRequisitionStatus(tx, id, userId);
      const newStatus = totals.to as RequisitionStatus;

      await auditIn(tx, {
        actor: actorFrom(req), action: 'ISSUE', entity: 'requisition', entityId: id, entityLabel: header.requisition_no,
        before: { status: header.status },
        after: { status: newStatus, issueSlipNo, lines: issued, totalRequested: totals.totalRequested, totalIssued: totals.totalIssued },
      });

      return { requisitionNo: header.requisition_no, issueSlipNo, status: newStatus, issueId: issueHeader.id };
    });

    sendCreated(res, { ...result, message: `Issue slip ${result.issueSlipNo} created against ${result.requisitionNo}.` });
  }),
);

/* ── Issue reversal — the slip stays, marked REVERSED; its stock comes back ─────
   The counterpart of the store issue (and of a direct-issue cancel): every line's
   quantity returns to stock through a REQUISITION_REVERSAL ledger entry naming the
   slip, the slip and its lines are kept exactly as issued, and the requisition's
   status is re-derived from the slips still posted — back to APPROVED once all are
   reversed, from where it can be cancelled. */

const reverseIssueSchema = z.object({
  reason: z.string().trim().min(5, 'Give the reason for reversing (at least 5 characters).').max(500),
});

router.post(
  '/:id/issues/:issueId/reverse',
  // Whoever may issue may take an issue back — the same Store right.
  requirePermission('requisition.issue'),
  validateBody(reverseIssueSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const issueId = idParam(req, 'issueId');
    const { reason } = req.body as z.infer<typeof reverseIssueSchema>;
    const userId = req.user!.id;

    const result = await withTransaction(async (tx) => {
      // Requisition first, then the slip: the issue route's lock order, so an issue
      // and a reversal on the same requisition queue behind each other.
      const header = await txQueryOne<{ id: number; requisition_no: string; status: RequisitionStatus }>(
        tx, 'SELECT id, requisition_no, status FROM requisition_headers WHERE id = $1 FOR UPDATE', [id],
      );
      if (!header) throw NotFoundError('Requisition');
      const slip = await txQueryOne<{ id: number; issue_slip_no: string; status: string }>(
        tx, 'SELECT id, issue_slip_no, status FROM requisition_issues WHERE id = $1 AND requisition_id = $2 FOR UPDATE',
        [issueId, id],
      );
      if (!slip) throw NotFoundError('Issue slip');
      if (slip.status === 'REVERSED') throw BusinessRuleError(`Issue slip ${slip.issue_slip_no} is already reversed.`);

      const lines = await txQuery<{ item_id: number; uom_id: number | null; issue_qty: string; item_code: string }>(
        tx,
        `SELECT ril.item_id, ril.uom_id, ril.issue_qty, rl.item_code
           FROM requisition_issue_lines ril
           JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
          WHERE ril.requisition_issue_id = $1
          ORDER BY ril.id`,
        [issueId],
      );
      const today = dateStamp(new Date());
      for (const l of lines) {
        await reverseRequisitionIssueLine(tx, { item_id: l.item_id, uom_id: l.uom_id }, l.issue_qty,
          { requisitionId: id, issueSlipNo: slip.issue_slip_no, issueDate: today, userId });
      }
      await tx.query(
        `UPDATE requisition_issues SET status = 'REVERSED', reversed_at = now(), reversed_by = $2, reversal_reason = $3
          WHERE id = $1`,
        [issueId, userId, reason],
      );
      const status = await recomputeRequisitionStatus(tx, id, userId);

      await auditIn(tx, {
        actor: actorFrom(req), action: 'CANCEL', entity: 'requisition_issue', entityId: issueId, entityLabel: slip.issue_slip_no,
        before: { status: slip.status, requisitionStatus: header.status },
        after: {
          status: 'REVERSED', reason, requisitionNo: header.requisition_no, requisitionStatus: status.to,
          returnedLines: lines.map((l) => ({ item: l.item_code, qty: l.issue_qty })),
        },
        message: `Issue slip ${slip.issue_slip_no} (${header.requisition_no}) reversed — ${lines.length} line(s) returned to stock. Reason: ${reason}`,
      });

      return {
        issueSlipNo: slip.issue_slip_no, requisitionNo: header.requisition_no,
        returnedLines: lines.length, status: status.to,
      };
    });

    sendOk(res, {
      ...result,
      message: `Issue slip ${result.issueSlipNo} reversed; ${result.returnedLines} line(s) returned to stock. ` +
        `${result.requisitionNo} is now ${result.status.replace(/_/g, ' ').toLowerCase()}.`,
    });
  }),
);

/* ── Print — one document, two ways to consume it (mirrors PO/GRN) ──────────── */
/* The HTML goes out with a policy that lets it run and load nothing (core/html.ts). */

router.get(
  '/:id/print-view',
  requirePermission('requisition.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildRequisitionDocument(id);
    sendPrintDocument(res, renderRequisitionDocumentHtml(doc));
  }),
);

router.get(
  '/:id/pdf',
  requirePermission('requisition.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildRequisitionDocument(id);
    const html = renderRequisitionDocumentHtml(doc);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', attachmentDisposition(doc.requisition_no, 'pdf'));
      res.send(pdf);
    } finally {
      await browser.close();
    }
  }),
);

router.get(
  '/issues/:issueId/print-view',
  requirePermission('requisition.view'),
  asyncHandler(async (req, res) => {
    const issueId = idParam(req, 'issueId');
    const doc = await buildIssueSlipDocument(issueId);
    sendPrintDocument(res, renderIssueSlipHtml(doc));
  }),
);

router.get(
  '/issues/:issueId/pdf',
  requirePermission('requisition.view'),
  asyncHandler(async (req, res) => {
    const issueId = idParam(req, 'issueId');
    const doc = await buildIssueSlipDocument(issueId);
    const html = renderIssueSlipHtml(doc);
    const browser = await chromium.launch();
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle' });
      const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', attachmentDisposition(doc.issue_slip_no, 'pdf'));
      res.send(pdf);
    } finally {
      await browser.close();
    }
  }),
);

async function buildRequisitionDocument(id: number) {
  const header = await queryOne<Record<string, unknown>>(
    `SELECT h.*, cc.name AS cost_centre_name, m.name AS machine_name, hb.hod_status, hb.store_status
       FROM requisition_headers h
       JOIN v_requisition_header_balance hb ON hb.requisition_id = h.id
       LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
       LEFT JOIN lookups m ON m.id = h.machine_id
      WHERE h.id = $1`,
    [id],
  );
  if (!header) throw NotFoundError('Requisition');
  const lines = await query<Record<string, unknown>>(
    `SELECT v.line_no, v.item_code, v.item_description, v.main_group_name, u.code AS uom_code,
            v.requested_qty, v.issued_qty, v.pending_qty
       FROM requisition_lines l
       JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
       LEFT JOIN lookups u ON u.id = l.uom_id
      WHERE l.requisition_id = $1
      ORDER BY l.line_no`,
    [id],
  );
  const companyMap = await loadCompanySettings();
  const h = header as Record<string, string>;
  return {
    requisition_no: h.requisition_no, requisition_date: h.requisition_date,
    employee_name: h.employee_name, employee_code: h.employee_code, department_name: h.department_name,
    hod_name: h.hod_name, machine_name: h.machine_name as string | null, cost_centre_name: h.cost_centre_name as string | null,
    status: h.status, hod_status: h.hod_status, store_status: h.store_status, remarks: h.remarks,
    lines: lines.map((l) => ({
      line_no: Number(l.line_no), item_code: String(l.item_code), item_description: String(l.item_description),
      main_group_name: String(l.main_group_name ?? ''), uom_code: l.uom_code as string | null,
      requested_qty: String(l.requested_qty), issued_qty: String(l.issued_qty), pending_qty: String(l.pending_qty),
    })),
    company: companyMap,
  };
}


async function buildIssueSlipDocument(issueId: number) {
  const header = await queryOne<Record<string, unknown>>(
    `SELECT i.*, h.requisition_no, h.employee_name, h.employee_code, h.department_name, h.hod_name,
            m.name AS machine_name, cc.name AS cost_centre_name,
            su.employee_name AS store_user_name, xu.employee_name AS reversed_by_name
       FROM requisition_issues i
       JOIN requisition_headers h ON h.id = i.requisition_id
       LEFT JOIN lookups m ON m.id = h.machine_id
       LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
       LEFT JOIN users su ON su.id = i.store_user_id
       LEFT JOIN users xu ON xu.id = i.reversed_by
      WHERE i.id = $1`,
    [issueId],
  );
  if (!header) throw NotFoundError('Issue slip');
  const lines = await query<Record<string, unknown>>(
    `SELECT ril.*, rl.item_code, rl.item_description, u.code AS uom_code, it.live_stock_qty AS available_stock
       FROM requisition_issue_lines ril
       JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
       LEFT JOIN lookups u ON u.id = ril.uom_id
       LEFT JOIN items it ON it.id = ril.item_id
      WHERE ril.requisition_issue_id = $1
      ORDER BY ril.id`,
    [issueId],
  );
  const h = header as Record<string, string>;
  return {
    issue_slip_no: h.issue_slip_no, issue_date: h.issue_date, requisition_no: h.requisition_no,
    employee_name: h.employee_name, employee_code: h.employee_code, department_name: h.department_name,
    hod_name: h.hod_name, machine_name: h.machine_name as string | null, cost_centre_name: h.cost_centre_name as string | null,
    store_user_name: h.store_user_name,
    reversal: h.status === 'REVERSED'
      ? { at: (header.reversed_at as string | null) ?? null, by: (header.reversed_by_name as string | null) ?? null, reason: h.reversal_reason }
      : null,
    lines: lines.map((l) => ({
      item_code: String(l.item_code), item_description: String(l.item_description), uom_code: l.uom_code as string | null,
      requested_qty_snapshot: String(l.requested_qty_snapshot), previously_issued_qty: String(l.previously_issued_qty),
      issue_qty: String(l.issue_qty),
      total_issued_qty: toQty(dec(String(l.previously_issued_qty)).plus(dec(String(l.issue_qty)))),
      available_stock: l.available_stock as string | null,
    })),
    company: await loadCompanySettings(),
  };
}

/* ── Dashboard summary — backs the Requisition dashboard cards (Rule: HOD ─────
   Status / Store Status are independent; cards below read the SAME derived
   columns v_requisition_header_balance exposes everywhere else). ─────────── */

router.get(
  '/analysis/summary',
  requirePermission('requisition.analyze'),
  validateQuery(listSchema.partial()),
  asyncHandler(async (req, res) => {
    const q = parsedQuery<Partial<z.infer<typeof listSchema>>>(res);
    const b = buildFilter(q as z.infer<typeof listSchema>, req.user!.id);
    const whereClause = b.where();

    const myB = buildFilter({ ...q, userId: undefined, requesterId: undefined } as z.infer<typeof listSchema>, req.user!.id);
    myB.add('h.requester_user_id = ?', req.user!.id);

    const [statusCounts, myCount, totals] = await Promise.all([
      query<{ status: string; hod_status: string; store_status: string; n: string }>(
        `SELECT h.status, b.hod_status, b.store_status, COUNT(*) AS n
           FROM requisition_headers h
           JOIN v_requisition_header_balance b ON b.requisition_id = h.id
           LEFT JOIN users ru ON ru.id = h.requester_user_id
           LEFT JOIN lookups d ON d.id = h.department_id
          ${whereClause}
          GROUP BY h.status, b.hod_status, b.store_status`,
        b.params,
      ),
      queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n
           FROM requisition_headers h
           JOIN v_requisition_header_balance b ON b.requisition_id = h.id
           LEFT JOIN users ru ON ru.id = h.requester_user_id
           LEFT JOIN lookups d ON d.id = h.department_id
          ${myB.where()}`,
        myB.params,
      ),
      queryOne<{ requested: string; issued: string; pending: string; excess: string }>(
        `SELECT COALESCE(SUM(b.total_requested_qty),0) AS requested, COALESCE(SUM(b.total_issued_qty),0) AS issued,
                COALESCE(SUM(b.total_pending_qty),0) AS pending, COALESCE(SUM(total_excess_qty),0) AS excess
           FROM requisition_headers h
           JOIN v_requisition_header_balance b ON b.requisition_id = h.id
           LEFT JOIN users ru ON ru.id = h.requester_user_id
           LEFT JOIN lookups d ON d.id = h.department_id
          ${whereClause}`,
        b.params,
      ),
    ]);

    const byStatus = Object.fromEntries(
      Object.entries(
        statusCounts.reduce<Record<string, number>>((acc, c) => {
          acc[c.status] = (acc[c.status] ?? 0) + Number(c.n);
          return acc;
        }, {}),
      ),
    );
    const sumWhere = (pred: (c: typeof statusCounts[number]) => boolean) =>
      statusCounts.filter(pred).reduce((a, c) => a + Number(c.n), 0);

    sendOk(res, {
      total: statusCounts.reduce((a, c) => a + Number(c.n), 0),
      myRequisitions: Number(myCount?.n ?? 0),
      pendingHodApproval: byStatus.PENDING_APPROVAL ?? 0,
      hodApproved: sumWhere((c) => c.hod_status === 'APPROVED'),
      hodRejected: sumWhere((c) => c.hod_status === 'REJECTED'),
      returned: byStatus.RETURNED ?? 0,
      awaitingStoreIssue: byStatus.APPROVED ?? 0,
      partiallyIssued: byStatus.PARTIALLY_ISSUED ?? 0,
      fullyIssued: byStatus.FULLY_ISSUED ?? 0,
      cancelled: byStatus.CANCELLED ?? 0,
      // Backward-compatible aliases for the original field names.
      pendingHod: byStatus.PENDING_APPROVAL ?? 0,
      approved: byStatus.APPROVED ?? 0,
      rejected: byStatus.REJECTED ?? 0,
      totalRequestedQty: totals?.requested ?? '0',
      totalIssuedQty: totals?.issued ?? '0',
      totalPendingQty: totals?.pending ?? '0',
      totalExcessQty: totals?.excess ?? '0',
    });
  }),
);

export default router;
