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
import { Router } from 'express';
import { z } from 'zod';
import { chromium } from 'playwright';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import { asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery, parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvArray, csvIdArray, } from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError, AuthorizationError } from '../../core/errors.js';
import { requirePermission, requireAnyPermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { nextDocumentNumber, dateStamp, timeStamp } from '../../domain/numbering.js';
import { assertRequisitionTransition, assertRequisitionEditable, assertNotAlready, REQUISITION_ISSUABLE, } from '../../domain/status.js';
import { toQty, dec } from '../../domain/money.js';
import { issueRequisitionLine } from '../../domain/stock.js';
import { loadCompanySettings } from '../../domain/company.js';
import { renderRequisitionDocumentHtml } from './requisition-document.js';
import { renderIssueSlipHtml } from './issue-slip-document.js';
const router = Router();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
/* ── Department → HOD mapping (reuses lookups.extra JSONB, ADR-014) ─────────── */
router.get('/departments/:id/hod', requirePermission('lookup.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const row = await queryOne('SELECT category, extra FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!row || row.category !== 'DEPARTMENT')
        throw NotFoundError('Department');
    const hodUserId = row.extra?.hodUserId ? Number(row.extra.hodUserId) : null;
    const hod = hodUserId
        ? await queryOne('SELECT id, employee_name, employee_id FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId])
        : null;
    sendOk(res, { departmentId: id, hodUserId, hod });
}));
router.put('/departments/:id/hod', requirePermission('lookup.edit'), validateBody(z.object({ hodUserId: z.coerce.number().int().positive().nullable() })), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { hodUserId } = req.body;
    const dept = await queryOne('SELECT category, name, extra FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!dept || dept.category !== 'DEPARTMENT')
        throw NotFoundError('Department');
    if (hodUserId != null) {
        const user = await queryOne('SELECT id FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId]);
        if (!user)
            throw ValidationError('The selected HOD user does not exist.', [{ field: 'hodUserId', message: 'Not found.' }]);
    }
    await withTransaction(async (tx) => {
        const nextExtra = { ...dept.extra, hodUserId };
        await tx.query('UPDATE lookups SET extra = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [id, JSON.stringify(nextExtra), req.user.id]);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'UPDATE', entity: 'department_hod', entityId: id, entityLabel: dept.name,
            before: { hodUserId: dept.extra?.hodUserId ?? null }, after: { hodUserId },
        });
    });
    sendOk(res, { departmentId: id, hodUserId, message: `HOD mapping for ${dept.name} updated.` });
}));
/** Resolves the department's currently-mapped HOD, snapshotting the name too. */
async function resolveHod(tx, departmentId) {
    if (!departmentId)
        return { hodUserId: null, hodName: '' };
    const dept = await txQueryOne(tx, 'SELECT extra FROM lookups WHERE id = $1', [departmentId]);
    const hodUserId = dept?.extra?.hodUserId ? Number(dept.extra.hodUserId) : null;
    if (!hodUserId)
        return { hodUserId: null, hodName: '' };
    const hod = await txQueryOne(tx, 'SELECT employee_name FROM users WHERE id = $1 AND deleted_at IS NULL', [hodUserId]);
    return { hodUserId, hodName: hod?.employee_name ?? '' };
}
/* ── List ───────────────────────────────────────────────────────────────────── */
const SORTABLE = {
    requisitionNo: 'h.requisition_no',
    requisitionDate: 'h.requisition_date',
    status: 'h.status',
    createdAt: 'h.created_at',
};
const listSchema = listQuerySchema.extend({
    status: csvArray,
    /** User-facing, independent status columns (v_requisition_header_balance) — never merged with `status`. */
    hodStatus: csvArray,
    storeStatus: csvArray,
    departmentId: csvIdArray,
    requesterId: csvIdArray,
    hodId: csvIdArray,
    machineId: csvIdArray,
    costCentreId: csvIdArray,
    itemId: csvIdArray,
    dateFrom: dateStr.optional(),
    dateTo: dateStr.optional(),
    /** `mine` | `hod-pending` | `store-queue` | omitted (everything the caller may view). */
    view: z.enum(['mine', 'hod-pending', 'store-queue']).optional(),
});
const LIST_FROM = `
  FROM requisition_headers h
  JOIN v_requisition_header_balance b ON b.requisition_id = h.id
  LEFT JOIN users ru ON ru.id = h.requester_user_id
  LEFT JOIN lookups d ON d.id = h.department_id`;
function buildFilter(q, userId) {
    const b = new SqlBuilder();
    b.addIn('h.status', q.status);
    b.addIn('b.hod_status', q.hodStatus);
    b.addIn('b.store_status', q.storeStatus);
    b.addIn('h.department_id', q.departmentId);
    b.addIn('h.requester_user_id', q.requesterId);
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
    }
    else if (q.view === 'hod-pending') {
        b.add('h.hod_user_id = ?', userId);
        b.addRaw("h.status = 'PENDING_APPROVAL'");
    }
    else if (q.view === 'store-queue') {
        b.addRaw("h.status IN ('APPROVED','PARTIALLY_ISSUED')");
    }
    if (q.search) {
        const p = b.push(`%${q.search.toLowerCase()}%`);
        b.addRaw(`(lower(h.requisition_no) LIKE ${p} OR lower(COALESCE(ru.employee_name,'')) LIKE ${p} ` +
            `OR lower(COALESCE(ru.employee_id,'')) LIKE ${p} OR lower(COALESCE(d.name,'')) LIKE ${p} ` +
            `OR EXISTS (SELECT 1 FROM requisition_lines l WHERE l.requisition_id = h.id ` +
            `AND (lower(l.item_code) LIKE ${p} OR lower(l.item_description) LIKE ${p})))`);
    }
    return b;
}
router.get('/', requirePermission('requisition.view'), validateQuery(listSchema), asyncHandler(async (req, res) => {
    const q = parsedQuery(res);
    const b = buildFilter(q, req.user.id);
    const totalRow = await queryOne(`SELECT COUNT(*) AS n ${LIST_FROM} ${b.where()}`, b.params);
    const total = Number(totalRow?.n ?? 0);
    const order = resolveSort(q, SORTABLE, 'requisitionDate');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));
    const rows = await query(`SELECT h.id, h.requisition_no, h.requisition_date, h.status,
              h.employee_name, h.employee_code, h.department_name, h.hod_name, h.machine_id, h.cost_centre_id,
              cc.name AS cost_centre_name, m.name AS machine_name,
              b.hod_status, b.store_status,
              b.line_count, b.total_requested_qty, b.total_issued_qty, b.total_pending_qty, b.total_excess_qty,
              (SELECT string_agg(DISTINCT l.item_code, ', ' ORDER BY l.item_code) FROM requisition_lines l WHERE l.requisition_id = h.id) AS item_codes,
              (SELECT l.item_description FROM requisition_lines l WHERE l.requisition_id = h.id ORDER BY l.line_no LIMIT 1) AS first_item_description,
              (SELECT i.live_stock_qty FROM requisition_lines l JOIN items i ON i.id = l.item_id
                WHERE l.requisition_id = h.id ORDER BY l.line_no LIMIT 1) AS first_item_available_stock,
              (SELECT i.issue_slip_no FROM requisition_issues i WHERE i.requisition_id = h.id ORDER BY i.created_at DESC LIMIT 1) AS last_issue_slip_no,
              (SELECT MAX(i.issue_date) FROM requisition_issues i WHERE i.requisition_id = h.id) AS last_issue_date,
              (CURRENT_DATE - h.requisition_date)::int AS age_days
         ${LIST_FROM}
         LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
         LEFT JOIN lookups m ON m.id = h.machine_id
         ${b.where()}
        ORDER BY ${order}, h.id DESC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    const cb = buildFilter({ ...q, status: undefined, hodStatus: undefined, storeStatus: undefined }, req.user.id);
    const [statusCounts, hodStatusCounts, storeStatusCounts] = await Promise.all([
        query(`SELECT h.status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY h.status`, cb.params),
        query(`SELECT b.hod_status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY b.hod_status`, cb.params),
        query(`SELECT b.store_status, COUNT(*) AS n ${LIST_FROM} ${cb.where()} GROUP BY b.store_status`, cb.params),
    ]);
    sendPage(res, rows, total, q.page, q.pageSize, {
        statusCounts: Object.fromEntries(statusCounts.map((c) => [c.status, Number(c.n)])),
        hodStatusCounts: Object.fromEntries(hodStatusCounts.map((c) => [c.hod_status, Number(c.n)])),
        storeStatusCounts: Object.fromEntries(storeStatusCounts.map((c) => [c.store_status, Number(c.n)])),
    });
}));
/* ── Detail ─────────────────────────────────────────────────────────────────── */
router.get('/:id', requirePermission('requisition.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const header = await queryOne(`SELECT h.*, ru.employee_name AS requester_name_live, ru.employee_id AS requester_employee_id,
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
        WHERE h.id = $1`, [id]);
    if (!header)
        throw NotFoundError('Requisition');
    const lines = await query(`SELECT v.*, u.code AS uom_code, u.name AS uom_name, l.remarks, i.live_stock_qty AS available_stock
         FROM requisition_lines l
         JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
         LEFT JOIN items i ON i.id = l.item_id
         LEFT JOIN lookups u ON u.id = l.uom_id
        WHERE l.requisition_id = $1
        ORDER BY l.line_no`, [id]);
    const approvals = await query(`SELECT a.id, a.action, a.reason, a.from_status, a.to_status, a.created_at,
              u.employee_name AS actor_name, u.employee_id AS actor_code
         FROM requisition_approvals a
         LEFT JOIN users u ON u.id = a.actor_user_id
        WHERE a.requisition_id = $1
        ORDER BY a.created_at ASC`, [id]);
    const issues = await query(`SELECT i.id, i.issue_slip_no, i.issue_date, i.remarks, i.created_at,
              su.employee_name AS store_user_name,
              json_agg(json_build_object(
                'itemCode', ril.item_code, 'itemDescription', ril.item_description,
                'requestedQtySnapshot', ril.requested_qty_snapshot,
                'previouslyIssuedQty', ril.previously_issued_qty,
                'issueQty', ril.issue_qty
              ) ORDER BY ril.id) AS lines
         FROM requisition_issues i
         LEFT JOIN users su ON su.id = i.store_user_id
         LEFT JOIN (
           SELECT ril.*, rl.item_code, rl.item_description
             FROM requisition_issue_lines ril
             JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
         ) ril ON ril.requisition_issue_id = i.id
        WHERE i.requisition_id = $1
        GROUP BY i.id, i.issue_slip_no, i.issue_date, i.remarks, i.created_at, su.employee_name
        ORDER BY i.created_at DESC`, [id]);
    sendOk(res, { ...header, lines, approvals, issues });
}));
/* ── Create / update ────────────────────────────────────────────────────────── */
const requisitionLineSchema = z.object({
    itemId: z.coerce.number().int().positive({ message: 'Select an item.' }),
    requestedQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Requested quantity must be greater than zero.'),
    remarks: z.string().trim().max(500).default(''),
});
const requisitionSchema = z.object({
    requisitionDate: dateStr.optional(),
    machineId: z.coerce.number().int().positive().nullable().optional(),
    costCentreId: z.coerce.number().int().positive().nullable().optional(),
    remarks: z.string().trim().max(1000).default(''),
    lines: z.array(requisitionLineSchema).min(1, 'Add at least one item line.'),
    /** When true, immediately submits for HOD approval after saving. */
    submit: z.boolean().default(false),
});
async function writeRequisitionLines(tx, requisitionId, lines) {
    const itemIds = [...new Set(lines.map((l) => l.itemId))];
    const items = await txQuery(tx, 'SELECT id, item_code, item_description, uom_id, main_group_id, is_active FROM items WHERE id = ANY($1) AND deleted_at IS NULL', [itemIds]);
    const itemMap = new Map(items.map((i) => [Number(i.id), i]));
    const missing = itemIds.filter((i) => !itemMap.has(i));
    if (missing.length > 0) {
        throw ValidationError('One or more selected items no longer exist.', [{ field: 'lines', message: `Unknown item id(s): ${missing.join(', ')}.` }]);
    }
    const inactive = items.filter((i) => !i.is_active).map((i) => i.item_code);
    if (inactive.length > 0)
        throw BusinessRuleError(`These items are inactive and cannot be requisitioned: ${inactive.join(', ')}.`);
    let mainGroupNames = new Map();
    const groupIds = [...new Set(items.map((i) => i.main_group_id).filter((v) => v != null))];
    if (groupIds.length > 0) {
        const groups = await txQuery(tx, 'SELECT id, name FROM lookups WHERE id = ANY($1)', [groupIds]);
        mainGroupNames = new Map(groups.map((g) => [Number(g.id), g.name]));
    }
    await tx.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [requisitionId]);
    for (const [i, line] of lines.entries()) {
        const item = itemMap.get(line.itemId);
        await tx.query(`INSERT INTO requisition_lines
         (requisition_id, line_no, item_id, item_code, item_description, main_group_name, uom_id, requested_qty, remarks)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [
            requisitionId, i + 1, item.id, item.item_code, item.item_description,
            item.main_group_id ? (mainGroupNames.get(item.main_group_id) ?? '') : '',
            item.uom_id, toQty(line.requestedQty), line.remarks,
        ]);
    }
}
router.post('/', requirePermission('requisition.create'), validateBody(requisitionSchema), asyncHandler(async (req, res) => {
    const body = req.body;
    const userId = req.user.id;
    const when = body.requisitionDate ? new Date(`${body.requisitionDate}T00:00:00`) : new Date();
    const id = await withTransaction(async (tx) => {
        const requester = await txQueryOne(tx, 'SELECT employee_name, employee_id, department_id FROM users WHERE id = $1', [userId]);
        if (!requester)
            throw new Error('Signed-in user not found.');
        const dept = requester.department_id
            ? await txQueryOne(tx, 'SELECT name FROM lookups WHERE id = $1', [requester.department_id])
            : null;
        const { hodUserId, hodName } = await resolveHod(tx, requester.department_id);
        const requisitionNo = await nextDocumentNumber(tx, 'REQUISITION', when);
        const status = body.submit ? 'PENDING_APPROVAL' : 'DRAFT';
        const header = await txQueryOne(tx, `INSERT INTO requisition_headers
           (requisition_no, requisition_date, requisition_time, requester_user_id, employee_code, employee_name,
            department_id, department_name, hod_user_id, hod_name, machine_id, cost_centre_id, remarks, status,
            submitted_at, submitted_by, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$17)
         RETURNING id`, [
            requisitionNo, dateStamp(when), timeStamp(), userId, requester.employee_id, requester.employee_name,
            requester.department_id, dept?.name ?? '', hodUserId, hodName, body.machineId ?? null, body.costCentreId ?? null,
            body.remarks, status, body.submit ? new Date().toISOString() : null, body.submit ? userId : null, userId,
        ]);
        if (!header)
            throw new Error('Failed to create requisition header.');
        await writeRequisitionLines(tx, header.id, body.lines);
        await auditIn(tx, {
            actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'CREATE', entity: 'requisition',
            entityId: header.id, entityLabel: requisitionNo,
            after: { requisitionNo, status, lineCount: body.lines.length, hodUserId },
        });
        if (body.submit) {
            await txQuery(tx, `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,'DRAFT','PENDING_APPROVAL')`, [header.id, userId]);
        }
        return header.id;
    });
    sendCreated(res, await queryOne('SELECT * FROM requisition_headers WHERE id = $1', [id]));
}));
router.put('/:id', 
// The raiser (requisition.edit) or an authorised HOD reviewing it
// (requisition.approve) may edit — mirrors the Indent PENDING_APPROVAL
// edit fix exactly.
requireAnyPermission('requisition.edit', 'requisition.approve'), validateBody(requisitionSchema), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body;
    const userId = req.user.id;
    const before = await queryOne('SELECT requisition_no, status, department_id FROM requisition_headers WHERE id = $1', [id]);
    if (!before)
        throw NotFoundError('Requisition');
    assertRequisitionEditable(before.status, before.requisition_no);
    await withTransaction(async (tx) => {
        await tx.query('SELECT id FROM requisition_headers WHERE id = $1 FOR UPDATE', [id]);
        const status = body.submit ? 'PENDING_APPROVAL' : before.status;
        if (body.submit)
            assertRequisitionTransition(before.status, 'PENDING_APPROVAL');
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
            await tx.query(`UPDATE requisition_headers
              SET machine_id = $2, cost_centre_id = $3, remarks = $4, status = $5,
                  hod_user_id = $7, hod_name = $8,
                  submitted_at = COALESCE(submitted_at, $6), submitted_by = COALESCE(submitted_by, $9),
                  updated_at = now(), updated_by = $9
            WHERE id = $1`, [id, body.machineId ?? null, body.costCentreId ?? null, body.remarks, status,
                new Date().toISOString(), hodUserId, hodName, userId]);
        }
        else {
            await tx.query(`UPDATE requisition_headers
              SET machine_id = $2, cost_centre_id = $3, remarks = $4, status = $5,
                  updated_at = now(), updated_by = $6
            WHERE id = $1`, [id, body.machineId ?? null, body.costCentreId ?? null, body.remarks, status, userId]);
        }
        await writeRequisitionLines(tx, id, body.lines);
        await auditIn(tx, {
            actor: actorFrom(req), action: body.submit ? 'SUBMIT' : 'UPDATE', entity: 'requisition',
            entityId: id, entityLabel: before.requisition_no,
            before, after: { status, lineCount: body.lines.length },
        });
        if (body.submit) {
            await txQuery(tx, `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, from_status, to_status)
           VALUES ($1,'SUBMIT',$2,$3,'PENDING_APPROVAL')`, [id, userId, before.status]);
        }
    });
    sendOk(res, await queryOne('SELECT * FROM requisition_headers WHERE id = $1', [id]));
}));
const reasonSchema = z.object({ reason: z.string().trim().max(1000).optional() });
function transitionRoute(path, opts) {
    router.post(path, requirePermission(opts.permission), validateBody(reasonSchema), asyncHandler(async (req, res) => {
        const id = idParam(req);
        const { reason } = req.body;
        const userId = req.user.id;
        if (opts.reasonRequired && (!reason || reason.trim().length === 0)) {
            throw ValidationError('A reason is required.', [{ field: 'reason', message: 'Please state the reason.' }]);
        }
        const result = await withTransaction(async (tx) => {
            const header = await txQueryOne(tx, 'SELECT id, requisition_no, status, requester_user_id, hod_user_id FROM requisition_headers WHERE id = $1 FOR UPDATE', [id]);
            if (!header)
                throw NotFoundError('Requisition');
            assertNotAlready('Requisition', header.requisition_no, header.status, opts.to);
            assertRequisitionTransition(header.status, opts.to);
            // Wrong HOD must not approve/reject/return (Rule: HOD approval
            // security) — only the SPECIFIC department's mapped HOD, or a Super
            // Admin override, exactly like Indent's self-approval exception.
            if (opts.hodOnly && !req.user.isSuperAdmin && header.hod_user_id !== userId) {
                throw AuthorizationError(header.hod_user_id
                    ? 'You are not the authorised HOD for this requisition\'s department.'
                    : 'This requisition\'s department has no HOD configured — an administrator must set one.');
            }
            // Self-approval: the SAME explicit-permission policy as Indent — a
            // Super Admin MAY approve their own requisition; an ordinary HOD
            // (even if they hold requisition.approve generally) may not,
            // regardless of write permissions elsewhere.
            const isSelfApproval = opts.action === 'APPROVE' && header.requester_user_id === userId;
            if (isSelfApproval && !req.user.isSuperAdmin) {
                throw BusinessRuleError('You cannot approve a requisition you raised yourself. Another authorised HOD must action it.');
            }
            // Unapprove (APPROVE -> REJECTED via this same REJECT route, or a
            // CANCEL) is refused once anything has actually been issued — reverse
            // the issue first, not the requisition (mirrors Indent/PO consumption guard).
            if ((opts.action === 'REJECT' && header.status === 'APPROVED') || opts.action === 'CANCEL') {
                const issued = await txQueryOne(tx, `SELECT COUNT(*) AS n FROM requisition_issue_lines ril
                   JOIN requisition_issues ri ON ri.id = ril.requisition_issue_id
                  WHERE ri.requisition_id = $1`, [id]);
                if (Number(issued?.n ?? 0) > 0) {
                    throw BusinessRuleError(`Requisition ${header.requisition_no} already has material issued against it and cannot be ` +
                        `${opts.action === 'CANCEL' ? 'cancelled' : 'unapproved'}. Reverse the relevant issue(s) first.`);
                }
            }
            const now = new Date().toISOString();
            const setters = {
                APPROVE: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = NULL',
                REJECT: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = $5',
                RETURN: 'hod_decided_at = $3, hod_decided_by = $4, hod_decision_reason = $5',
                REOPEN: 'hod_decided_at = NULL, hod_decided_by = NULL, hod_decision_reason = NULL, submitted_at = NULL, submitted_by = NULL',
                CANCEL: 'closed_at = $3, closed_by = $4, close_reason = $5',
                SUBMIT: 'submitted_at = $3, submitted_by = $4',
            };
            const setClause = setters[opts.action];
            const params = [id, opts.to, now, userId];
            if (['REJECT', 'RETURN', 'CANCEL'].includes(opts.action))
                params.push(reason ?? null);
            await tx.query(`UPDATE requisition_headers SET status = $2, ${setClause}, updated_at = $3, updated_by = $4 WHERE id = $1`, params);
            await txQuery(tx, `INSERT INTO requisition_approvals (requisition_id, action, actor_user_id, reason, from_status, to_status)
           VALUES ($1,$2,$3,$4,$5,$6)`, [id, opts.action, userId, reason ?? null, header.status, opts.to]);
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
    }));
}
transitionRoute('/:id/submit', { action: 'SUBMIT', to: 'PENDING_APPROVAL', permission: 'requisition.create' });
transitionRoute('/:id/approve', { action: 'APPROVE', to: 'APPROVED', permission: 'requisition.approve', hodOnly: true });
transitionRoute('/:id/reject', { action: 'REJECT', to: 'REJECTED', permission: 'requisition.approve', reasonRequired: true, hodOnly: true });
transitionRoute('/:id/return', { action: 'RETURN', to: 'RETURNED', permission: 'requisition.approve', reasonRequired: true, hodOnly: true });
transitionRoute('/:id/reopen', { action: 'REOPEN', to: 'DRAFT', permission: 'requisition.edit' });
transitionRoute('/:id/cancel', { action: 'CANCEL', to: 'CANCELLED', permission: 'requisition.edit', reasonRequired: true });
/* ── DELETE (drafts only) ───────────────────────────────────────────────────── */
router.delete('/:id', requirePermission('requisition.delete'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const req_ = await queryOne('SELECT requisition_no, status FROM requisition_headers WHERE id = $1', [id]);
    if (!req_)
        throw NotFoundError('Requisition');
    if (req_.status !== 'DRAFT') {
        throw BusinessRuleError(`Only draft requisitions can be deleted. Requisition ${req_.requisition_no} is ${req_.status.toLowerCase()} — cancel it instead.`);
    }
    await withTransaction(async (tx) => {
        await auditIn(tx, { actor: actorFrom(req), action: 'DELETE', entity: 'requisition', entityId: id, entityLabel: req_.requisition_no, before: req_ });
        await tx.query('DELETE FROM requisition_headers WHERE id = $1', [id]);
    });
    sendOk(res, { deleted: true, message: `Draft requisition ${req_.requisition_no} has been deleted.` });
}));
/* ── Store issue — atomic multi-line stock deduction + issue slip ───────────── */
const issueLineSchema = z.object({
    requisitionLineId: z.coerce.number().int().positive(),
    issueQty: z.union([z.number(), z.string()]).refine((v) => Number(v) > 0, 'Issue quantity must be greater than zero.'),
});
const issueSchema = z.object({
    lines: z.array(issueLineSchema).min(1, 'Select at least one line to issue.'),
    remarks: z.string().trim().max(1000).default(''),
});
router.post('/:id/issue', requirePermission('requisition.issue'), validateBody(issueSchema), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body;
    const userId = req.user.id;
    const when = new Date();
    const result = await withTransaction(async (tx) => {
        const header = await txQueryOne(tx, 'SELECT id, requisition_no, status FROM requisition_headers WHERE id = $1 FOR UPDATE', [id]);
        if (!header)
            throw NotFoundError('Requisition');
        if (!REQUISITION_ISSUABLE.has(header.status)) {
            throw BusinessRuleError(`Requisition ${header.requisition_no} is ${header.status.replace(/_/g, ' ').toLowerCase()} and is not awaiting store issue. ` +
                'It must be HOD-approved first.');
        }
        const issueSlipNo = await nextDocumentNumber(tx, 'ISSUE_SLIP', when);
        const issueHeader = await txQueryOne(tx, `INSERT INTO requisition_issues (issue_slip_no, requisition_id, issue_date, issue_time, store_user_id, remarks, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$5) RETURNING id`, [issueSlipNo, id, dateStamp(when), timeStamp(), userId, body.remarks]);
        if (!issueHeader)
            throw new Error('Failed to create issue slip.');
        const issued = [];
        for (const [i, line] of body.lines.entries()) {
            // Lock this requisition line's balance row to serialise concurrent
            // store users issuing against the SAME line (Rule 29) — the item-row
            // lock inside issueRequisitionLine additionally serialises by ITEM,
            // which is what actually protects stock when two DIFFERENT
            // requisition lines compete for the same item.
            const bal = await txQueryOne(tx, `SELECT rl.item_id, rl.item_code, rl.requested_qty, rl.uom_id,
                  COALESCE((SELECT SUM(issue_qty) FROM requisition_issue_lines WHERE requisition_line_id = rl.id), 0) AS issued_qty
             FROM requisition_lines rl WHERE rl.id = $1 AND rl.requisition_id = $2 FOR UPDATE`, [line.requisitionLineId, id]);
            if (!bal) {
                throw ValidationError(`Line ${i + 1}: not a valid line on this requisition.`, [{ field: `lines.${i}.requisitionLineId`, message: 'Not found.' }]);
            }
            const issueQty = toQty(line.issueQty);
            // Rule 8/24: the ONLY ceiling is current stock — issueRequisitionLine
            // enforces that atomically under the item row lock. Rule 24 (explicit):
            // NEVER check issueQty against requested/pending — over-issue is allowed.
            await issueRequisitionLine(tx, { item_id: bal.item_id, uom_id: bal.uom_id }, issueQty, { requisitionId: id, requisitionNo: header.requisition_no, issueId: issueHeader.id, issueSlipNo, issueDate: dateStamp(when), requisitionLineId: line.requisitionLineId, userId });
            await tx.query(`INSERT INTO requisition_issue_lines
             (requisition_issue_id, requisition_line_id, item_id, requested_qty_snapshot, previously_issued_qty, issue_qty, uom_id, remarks)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [issueHeader.id, line.requisitionLineId, bal.item_id, bal.requested_qty, bal.issued_qty, issueQty, bal.uom_id, '']);
            issued.push({ itemCode: bal.item_code, issueQty });
        }
        // Recompute overall status from the authoritative balance view.
        const totals = await txQueryOne(tx, 'SELECT total_requested_qty, total_issued_qty FROM v_requisition_header_balance WHERE requisition_id = $1', [id]);
        const newStatus = dec(totals?.total_issued_qty ?? 0).greaterThanOrEqualTo(dec(totals?.total_requested_qty ?? 0))
            ? 'FULLY_ISSUED' : 'PARTIALLY_ISSUED';
        await tx.query('UPDATE requisition_headers SET status = $2, updated_at = now(), updated_by = $3 WHERE id = $1', [id, newStatus, userId]);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'ISSUE', entity: 'requisition', entityId: id, entityLabel: header.requisition_no,
            before: { status: header.status },
            after: { status: newStatus, issueSlipNo, lines: issued, totalRequested: totals?.total_requested_qty, totalIssued: totals?.total_issued_qty },
        });
        return { requisitionNo: header.requisition_no, issueSlipNo, status: newStatus, issueId: issueHeader.id };
    });
    sendCreated(res, { ...result, message: `Issue slip ${result.issueSlipNo} created against ${result.requisitionNo}.` });
}));
/* ── Print — one document, two ways to consume it (mirrors PO/GRN) ──────────── */
router.get('/:id/print-view', requirePermission('requisition.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildRequisitionDocument(id);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderRequisitionDocumentHtml(doc));
}));
router.get('/:id/pdf', requirePermission('requisition.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const doc = await buildRequisitionDocument(id);
    const html = renderRequisitionDocumentHtml(doc);
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.requisition_no}.pdf"`);
        res.send(pdf);
    }
    finally {
        await browser.close();
    }
}));
router.get('/issues/:issueId/print-view', requirePermission('requisition.view'), asyncHandler(async (req, res) => {
    const issueId = idParam(req, 'issueId');
    const doc = await buildIssueSlipDocument(issueId);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(renderIssueSlipHtml(doc));
}));
router.get('/issues/:issueId/pdf', requirePermission('requisition.view'), asyncHandler(async (req, res) => {
    const issueId = idParam(req, 'issueId');
    const doc = await buildIssueSlipDocument(issueId);
    const html = renderIssueSlipHtml(doc);
    const browser = await chromium.launch();
    try {
        const page = await browser.newPage();
        await page.setContent(html, { waitUntil: 'networkidle' });
        const pdf = await page.pdf({ format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '12mm', right: '12mm' } });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${doc.issue_slip_no}.pdf"`);
        res.send(pdf);
    }
    finally {
        await browser.close();
    }
}));
async function buildRequisitionDocument(id) {
    const header = await queryOne(`SELECT h.*, cc.name AS cost_centre_name, m.name AS machine_name, hb.hod_status, hb.store_status
       FROM requisition_headers h
       JOIN v_requisition_header_balance hb ON hb.requisition_id = h.id
       LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
       LEFT JOIN lookups m ON m.id = h.machine_id
      WHERE h.id = $1`, [id]);
    if (!header)
        throw NotFoundError('Requisition');
    const lines = await query(`SELECT v.line_no, v.item_code, v.item_description, v.main_group_name, u.code AS uom_code,
            v.requested_qty, v.issued_qty, v.pending_qty
       FROM requisition_lines l
       JOIN v_requisition_line_balance v ON v.requisition_line_id = l.id
       LEFT JOIN lookups u ON u.id = l.uom_id
      WHERE l.requisition_id = $1
      ORDER BY l.line_no`, [id]);
    const companyMap = await loadCompanySettings();
    const h = header;
    return {
        requisition_no: h.requisition_no, requisition_date: h.requisition_date,
        employee_name: h.employee_name, employee_code: h.employee_code, department_name: h.department_name,
        hod_name: h.hod_name, machine_name: h.machine_name, cost_centre_name: h.cost_centre_name,
        status: h.status, hod_status: h.hod_status, store_status: h.store_status, remarks: h.remarks,
        lines: lines.map((l) => ({
            line_no: Number(l.line_no), item_code: String(l.item_code), item_description: String(l.item_description),
            main_group_name: String(l.main_group_name ?? ''), uom_code: l.uom_code,
            requested_qty: String(l.requested_qty), issued_qty: String(l.issued_qty), pending_qty: String(l.pending_qty),
        })),
        company: companyMap,
    };
}
async function buildIssueSlipDocument(issueId) {
    const header = await queryOne(`SELECT i.*, h.requisition_no, h.employee_name, h.employee_code, h.department_name, h.hod_name,
            m.name AS machine_name, cc.name AS cost_centre_name,
            su.employee_name AS store_user_name
       FROM requisition_issues i
       JOIN requisition_headers h ON h.id = i.requisition_id
       LEFT JOIN lookups m ON m.id = h.machine_id
       LEFT JOIN lookups cc ON cc.id = h.cost_centre_id
       LEFT JOIN users su ON su.id = i.store_user_id
      WHERE i.id = $1`, [issueId]);
    if (!header)
        throw NotFoundError('Issue slip');
    const lines = await query(`SELECT ril.*, rl.item_code, rl.item_description, u.code AS uom_code, it.live_stock_qty AS available_stock
       FROM requisition_issue_lines ril
       JOIN requisition_lines rl ON rl.id = ril.requisition_line_id
       LEFT JOIN lookups u ON u.id = ril.uom_id
       LEFT JOIN items it ON it.id = ril.item_id
      WHERE ril.requisition_issue_id = $1
      ORDER BY ril.id`, [issueId]);
    const h = header;
    return {
        issue_slip_no: h.issue_slip_no, issue_date: h.issue_date, requisition_no: h.requisition_no,
        employee_name: h.employee_name, employee_code: h.employee_code, department_name: h.department_name,
        hod_name: h.hod_name, machine_name: h.machine_name, cost_centre_name: h.cost_centre_name,
        store_user_name: h.store_user_name,
        lines: lines.map((l) => ({
            item_code: String(l.item_code), item_description: String(l.item_description), uom_code: l.uom_code,
            requested_qty_snapshot: String(l.requested_qty_snapshot), previously_issued_qty: String(l.previously_issued_qty),
            issue_qty: String(l.issue_qty),
            total_issued_qty: toQty(dec(String(l.previously_issued_qty)).plus(dec(String(l.issue_qty)))),
            available_stock: l.available_stock,
        })),
        company: await loadCompanySettings(),
    };
}
/* ── Dashboard summary — backs the Requisition dashboard cards (Rule: HOD ─────
   Status / Store Status are independent; cards below read the SAME derived
   columns v_requisition_header_balance exposes everywhere else). ─────────── */
router.get('/analysis/summary', requirePermission('requisition.analyze'), asyncHandler(async (req, res) => {
    const [statusCounts, myCount, totals] = await Promise.all([
        query(`SELECT h.status, b.hod_status, b.store_status, COUNT(*) AS n
           FROM requisition_headers h JOIN v_requisition_header_balance b ON b.requisition_id = h.id
          GROUP BY h.status, b.hod_status, b.store_status`),
        queryOne('SELECT COUNT(*) AS n FROM requisition_headers WHERE requester_user_id = $1', [req.user.id]),
        queryOne(`SELECT COALESCE(SUM(total_requested_qty),0) AS requested, COALESCE(SUM(total_issued_qty),0) AS issued,
                COALESCE(SUM(total_pending_qty),0) AS pending, COALESCE(SUM(total_excess_qty),0) AS excess
           FROM v_requisition_header_balance`),
    ]);
    const byStatus = Object.fromEntries(Object.entries(statusCounts.reduce((acc, c) => {
        acc[c.status] = (acc[c.status] ?? 0) + Number(c.n);
        return acc;
    }, {})));
    const sumWhere = (pred) => statusCounts.filter(pred).reduce((a, c) => a + Number(c.n), 0);
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
}));
export default router;
//# sourceMappingURL=routes.js.map