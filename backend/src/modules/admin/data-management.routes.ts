/**
 * Admin Data Management & Audit Control (SRS §17, §18, §20, §24).
 *
 * Dedicated administrative interface for Super Admins and authorized Administrators:
 * - Search & inspect Master Data and Transaction Documents.
 * - Deep inspection of record dependencies and foreign key relations.
 * - Deactivate / Reactivate (soft toggle is_active = TRUE / FALSE).
 * - Soft-Delete & Restore (deleted_at timestamp toggle).
 * - Safe Hard-Delete (Permanent Purge) strictly guarded by dependency checks.
 * - System Super Admins (10221, 10422) can NEVER be deleted or deactivated.
 * - Any other Super Admin account is changed only by a Super Admin, and the last
 *   active Super Admin is never deactivated or deleted (super-admin-guard.ts).
 */
import { createHash } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import { asyncHandler, sendOk, validateBody, validateQuery, listQuerySchema, offsetOf } from '../../core/http.js';
import { BusinessRuleError, ConflictError, NotFoundError, ValidationError } from '../../core/errors.js';
import { requirePermission, invalidateAuthState } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { assertMayChangeUsers, assertActiveSuperAdminRemains } from './super-admin-guard.js';

const router = Router();

// Hard deletes and bulk (de)activation of users, suppliers and items are system
// administration. This accepted role.view — a read-only right — or 'user.admin',
// which does not exist in the permission catalogue.
router.use(requirePermission('system.admin'));

const PROTECTED_EMPLOYEE_IDS = new Set(['10221', '10422']);

export interface DependencyCheck {
  table: string;
  label: string;
  count: number;
}

/* ── 1. Summary of all entities ────────────────────────────────────────────── */

router.get(
  '/summary',
  asyncHandler(async (_req, res) => {
    const [
      usersCount,
      suppliersCount,
      itemsCount,
      lookupsCount,
      indentsCount,
      posCount,
      grnsCount,
      requisitionsCount,
      directIssuesCount,
    ] = await Promise.all([
      queryOne<{ total: string; active: string; inactive: string; deleted: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN is_active = TRUE AND deleted_at IS NULL THEN 1 END) AS active,
               COUNT(CASE WHEN is_active = FALSE AND deleted_at IS NULL THEN 1 END) AS inactive,
               COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted
          FROM users
      `),
      queryOne<{ total: string; active: string; inactive: string; deleted: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN is_active = TRUE AND deleted_at IS NULL THEN 1 END) AS active,
               COUNT(CASE WHEN is_active = FALSE AND deleted_at IS NULL THEN 1 END) AS inactive,
               COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted
          FROM suppliers
      `),
      queryOne<{ total: string; active: string; inactive: string; deleted: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN is_active = TRUE AND deleted_at IS NULL THEN 1 END) AS active,
               COUNT(CASE WHEN is_active = FALSE AND deleted_at IS NULL THEN 1 END) AS inactive,
               COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted
          FROM items
      `),
      queryOne<{ total: string; active: string; inactive: string; deleted: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN is_active = TRUE AND deleted_at IS NULL THEN 1 END) AS active,
               COUNT(CASE WHEN is_active = FALSE AND deleted_at IS NULL THEN 1 END) AS inactive,
               COUNT(CASE WHEN deleted_at IS NOT NULL THEN 1 END) AS deleted
          FROM lookups
      `),
      queryOne<{ total: string; draft: string; open: string; closed: string; cancelled: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) AS draft,
               COUNT(CASE WHEN status IN ('PENDING_APPROVAL', 'APPROVED') THEN 1 END) AS open,
               COUNT(CASE WHEN status = 'CLOSED' THEN 1 END) AS closed,
               COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) AS cancelled
          FROM purchase_indent_headers
      `),
      queryOne<{ total: string; draft: string; open: string; closed: string; cancelled: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) AS draft,
               COUNT(CASE WHEN status IN ('OPEN', 'PARTIALLY_RECEIVED') THEN 1 END) AS open,
               COUNT(CASE WHEN status IN ('COMPLETED', 'SHORT_CLOSED') THEN 1 END) AS closed,
               COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) AS cancelled
          FROM purchase_order_headers
      `),
      queryOne<{ total: string; completed: string; cancelled: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN status = 'COMPLETED' THEN 1 END) AS completed,
               COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) AS cancelled
          FROM grn_headers
      `),
      queryOne<{ total: string; draft: string; pending: string; issued: string; cancelled: string }>(`
        SELECT COUNT(*) AS total,
               COUNT(CASE WHEN status = 'DRAFT' THEN 1 END) AS draft,
               COUNT(CASE WHEN status = 'PENDING_APPROVAL' THEN 1 END) AS pending,
               COUNT(CASE WHEN status IN ('APPROVED', 'PARTIALLY_ISSUED', 'ISSUED') THEN 1 END) AS issued,
               COUNT(CASE WHEN status = 'CANCELLED' THEN 1 END) AS cancelled
          FROM requisition_headers
      `),
      queryOne<{ total: string }>(`
        SELECT COUNT(*) AS total FROM direct_issue_headers
      `),
    ]);

    sendOk(res, {
      masters: {
        users: {
          total: Number(usersCount?.total ?? 0),
          active: Number(usersCount?.active ?? 0),
          inactive: Number(usersCount?.inactive ?? 0),
          deleted: Number(usersCount?.deleted ?? 0),
        },
        suppliers: {
          total: Number(suppliersCount?.total ?? 0),
          active: Number(suppliersCount?.active ?? 0),
          inactive: Number(suppliersCount?.inactive ?? 0),
          deleted: Number(suppliersCount?.deleted ?? 0),
        },
        items: {
          total: Number(itemsCount?.total ?? 0),
          active: Number(itemsCount?.active ?? 0),
          inactive: Number(itemsCount?.inactive ?? 0),
          deleted: Number(itemsCount?.deleted ?? 0),
        },
        lookups: {
          total: Number(lookupsCount?.total ?? 0),
          active: Number(lookupsCount?.active ?? 0),
          inactive: Number(lookupsCount?.inactive ?? 0),
          deleted: Number(lookupsCount?.deleted ?? 0),
        },
      },
      transactions: {
        indents: {
          total: Number(indentsCount?.total ?? 0),
          draft: Number(indentsCount?.draft ?? 0),
          open: Number(indentsCount?.open ?? 0),
          closed: Number(indentsCount?.closed ?? 0),
          cancelled: Number(indentsCount?.cancelled ?? 0),
        },
        purchaseOrders: {
          total: Number(posCount?.total ?? 0),
          draft: Number(posCount?.draft ?? 0),
          open: Number(posCount?.open ?? 0),
          closed: Number(posCount?.closed ?? 0),
          cancelled: Number(posCount?.cancelled ?? 0),
        },
        grn: {
          total: Number(grnsCount?.total ?? 0),
          completed: Number(grnsCount?.completed ?? 0),
          cancelled: Number(grnsCount?.cancelled ?? 0),
        },
        requisitions: {
          total: Number(requisitionsCount?.total ?? 0),
          draft: Number(requisitionsCount?.draft ?? 0),
          pending: Number(requisitionsCount?.pending ?? 0),
          issued: Number(requisitionsCount?.issued ?? 0),
          cancelled: Number(requisitionsCount?.cancelled ?? 0),
        },
        directIssues: {
          total: Number(directIssuesCount?.total ?? 0),
        },
      },
    });
  }),
);

/* ── 2. Unified query records endpoint ──────────────────────────────────────── */

const queryRecordsSchema = listQuerySchema.extend({
  entity: z.enum([
    'users',
    'suppliers',
    'items',
    'lookups',
    'indents',
    'purchase_orders',
    'grn',
    'requisitions',
    'direct_issues',
  ]),
  status: z.enum(['all', 'active', 'inactive', 'deleted']).default('all'),
  category: z.string().optional(),
});

router.get(
  '/records',
  validateQuery(queryRecordsSchema),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof queryRecordsSchema>;
    const search = q.search ? `%${q.search.toLowerCase()}%` : null;
    const page = Number(q.page ?? 1);
    const pageSize = Number(q.pageSize ?? 25);
    const offset = (page - 1) * pageSize;

    let items: Array<{
      id: number;
      code: string;
      title: string;
      subtitle: string;
      extraInfo: string;
      status: string;
      isActive: boolean;
      deletedAt: string | null;
      createdAt: string;
      isProtected: boolean;
    }> = [];
    let total = 0;

    if (q.entity === 'users') {
      const b = new SqlBuilder();
      if (q.status === 'active') b.addRaw('u.is_active = TRUE AND u.deleted_at IS NULL');
      else if (q.status === 'inactive') b.addRaw('u.is_active = FALSE AND u.deleted_at IS NULL');
      else if (q.status === 'deleted') b.addRaw('u.deleted_at IS NOT NULL');

      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(u.employee_id) LIKE ${p} OR lower(u.employee_name) LIKE ${p} OR lower(COALESCE(u.designation, '')) LIKE ${p})`);
      }

      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM users u ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        employee_id: string;
        employee_name: string;
        designation: string;
        department_name: string;
        email: string;
        is_active: boolean;
        deleted_at: string | null;
        created_at: string;
      }>(
        `SELECT u.id, u.employee_id, u.employee_name, u.designation, d.name AS department_name,
                u.email, u.is_active, u.deleted_at, u.created_at
           FROM users u
           LEFT JOIN lookups d ON d.id = u.department_id
           ${b.where()}
          ORDER BY u.id ASC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.employee_id,
        title: r.employee_name,
        subtitle: [r.designation, r.department_name].filter(Boolean).join(' · '),
        extraInfo: r.email || '—',
        status: r.deleted_at ? 'DELETED' : r.is_active ? 'ACTIVE' : 'INACTIVE',
        isActive: r.is_active,
        deletedAt: r.deleted_at,
        createdAt: r.created_at,
        isProtected: PROTECTED_EMPLOYEE_IDS.has(r.employee_id),
      }));
    } else if (q.entity === 'suppliers') {
      const b = new SqlBuilder();
      if (q.status === 'active') b.addRaw('s.is_active = TRUE AND s.deleted_at IS NULL');
      else if (q.status === 'inactive') b.addRaw('s.is_active = FALSE AND s.deleted_at IS NULL');
      else if (q.status === 'deleted') b.addRaw('s.deleted_at IS NOT NULL');

      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(s.supplier_code) LIKE ${p} OR lower(s.supplier_name) LIKE ${p} OR lower(COALESCE(s.city, '')) LIKE ${p} OR lower(COALESCE(s.gst_no, '')) LIKE ${p})`);
      }

      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM suppliers s ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        supplier_code: string;
        supplier_name: string;
        city: string;
        state: string;
        gst_no: string;
        is_active: boolean;
        deleted_at: string | null;
        created_at: string;
      }>(
        `SELECT s.id, s.supplier_code, s.supplier_name, s.city, s.state, s.gst_no,
                s.is_active, s.deleted_at, s.created_at
           FROM suppliers s
           ${b.where()}
          ORDER BY s.id ASC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.supplier_code,
        title: r.supplier_name,
        subtitle: [r.city, r.state].filter(Boolean).join(', ') || 'No location',
        extraInfo: r.gst_no ? `GST: ${r.gst_no}` : '—',
        status: r.deleted_at ? 'DELETED' : r.is_active ? 'ACTIVE' : 'INACTIVE',
        isActive: r.is_active,
        deletedAt: r.deleted_at,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'items') {
      const b = new SqlBuilder();
      if (q.status === 'active') b.addRaw('i.is_active = TRUE AND i.deleted_at IS NULL');
      else if (q.status === 'inactive') b.addRaw('i.is_active = FALSE AND i.deleted_at IS NULL');
      else if (q.status === 'deleted') b.addRaw('i.deleted_at IS NOT NULL');

      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(i.item_code) LIKE ${p} OR lower(i.item_description) LIKE ${p} OR lower(COALESCE(i.item_specification, '')) LIKE ${p} OR lower(COALESCE(i.hsn_code, '')) LIKE ${p})`);
      }

      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM items i ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        item_code: string;
        item_description: string;
        uom_code: string;
        live_stock_qty: string;
        standard_rate: string;
        is_active: boolean;
        deleted_at: string | null;
        created_at: string;
      }>(
        `SELECT i.id, i.item_code, i.item_description, u.name AS uom_code,
                i.live_stock_qty, i.standard_rate, i.is_active, i.deleted_at, i.created_at
           FROM items i
           LEFT JOIN lookups u ON u.id = i.uom_id
           ${b.where()}
          ORDER BY i.id ASC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.item_code,
        title: r.item_description,
        subtitle: `UOM: ${r.uom_code || '—'} · Rate: ₹${r.standard_rate || 0}`,
        extraInfo: `Stock: ${Number(r.live_stock_qty || 0).toLocaleString('en-IN')}`,
        status: r.deleted_at ? 'DELETED' : r.is_active ? 'ACTIVE' : 'INACTIVE',
        isActive: r.is_active,
        deletedAt: r.deleted_at,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'lookups') {
      const b = new SqlBuilder();
      if (q.category) {
        const p = b.push(q.category);
        b.addRaw(`l.category = ${p}`);
      }
      if (q.status === 'active') b.addRaw('l.is_active = TRUE AND l.deleted_at IS NULL');
      else if (q.status === 'inactive') b.addRaw('l.is_active = FALSE AND l.deleted_at IS NULL');
      else if (q.status === 'deleted') b.addRaw('l.deleted_at IS NOT NULL');

      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(l.name) LIKE ${p} OR lower(l.code) LIKE ${p} OR lower(l.category) LIKE ${p})`);
      }

      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM lookups l ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        code: string;
        name: string;
        category: string;
        extra: Record<string, unknown>;
        is_active: boolean;
        deleted_at: string | null;
        created_at: string;
      }>(
        `SELECT l.id, l.code, l.name, l.category, l.extra,
                l.is_active, l.deleted_at, l.created_at
           FROM lookups l
           ${b.where()}
          ORDER BY l.category ASC, l.name ASC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.code || `#${r.id}`,
        title: r.name,
        subtitle: `Category: ${r.category}`,
        extraInfo: r.extra?.hodName ? `HOD: ${r.extra.hodName}` : '—',
        status: r.deleted_at ? 'DELETED' : r.is_active ? 'ACTIVE' : 'INACTIVE',
        isActive: r.is_active,
        deletedAt: r.deleted_at,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'indents') {
      const b = new SqlBuilder();
      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(h.indent_no) LIKE ${p} OR lower(h.remarks) LIKE ${p})`);
      }
      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM purchase_indent_headers h ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        indent_no: string;
        indent_date: string;
        department_name: string;
        requester_name: string;
        status: string;
        created_at: string;
      }>(
        `SELECT h.id, h.indent_no, h.indent_date, d.name AS department_name,
                u.employee_name AS requester_name, h.status, h.created_at
           FROM purchase_indent_headers h
           LEFT JOIN lookups d ON d.id = h.department_id
           LEFT JOIN users u ON u.id = h.requested_by_user_id
           ${b.where()}
          ORDER BY h.id DESC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.indent_no,
        title: `Indent: ${r.indent_no}`,
        subtitle: [r.requester_name, r.department_name].filter(Boolean).join(' · '),
        extraInfo: `Date: ${r.indent_date}`,
        status: r.status,
        isActive: r.status !== 'CANCELLED' && r.status !== 'CLOSED',
        deletedAt: null,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'purchase_orders') {
      const b = new SqlBuilder();
      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(h.po_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p})`);
      }
      const countRow = await queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM purchase_order_headers h LEFT JOIN suppliers s ON s.id = h.supplier_id ${b.where()}`,
        b.params,
      );
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        po_no: string;
        po_date: string;
        supplier_name: string;
        status: string;
        created_at: string;
      }>(
        `SELECT h.id, h.po_no, h.po_date, s.supplier_name, h.status, h.created_at
           FROM purchase_order_headers h
           LEFT JOIN suppliers s ON s.id = h.supplier_id
           ${b.where()}
          ORDER BY h.id DESC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.po_no,
        title: `PO: ${r.po_no}`,
        subtitle: `Supplier: ${r.supplier_name || '—'}`,
        extraInfo: `Date: ${r.po_date}`,
        status: r.status,
        isActive: r.status !== 'CANCELLED' && r.status !== 'SHORT_CLOSED',
        deletedAt: null,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'grn') {
      const b = new SqlBuilder();
      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(h.grn_no) LIKE ${p} OR lower(s.supplier_name) LIKE ${p})`);
      }
      const countRow = await queryOne<{ n: string }>(
        `SELECT COUNT(*) AS n FROM grn_headers h LEFT JOIN suppliers s ON s.id = h.supplier_id ${b.where()}`,
        b.params,
      );
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        grn_no: string;
        grn_date: string;
        supplier_name: string;
        status: string;
        created_at: string;
      }>(
        `SELECT h.id, h.grn_no, h.grn_date, s.supplier_name, h.status, h.created_at
           FROM grn_headers h
           LEFT JOIN suppliers s ON s.id = h.supplier_id
           ${b.where()}
          ORDER BY h.id DESC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.grn_no,
        title: `GRN: ${r.grn_no}`,
        subtitle: `Supplier: ${r.supplier_name || '—'}`,
        extraInfo: `Date: ${r.grn_date}`,
        status: r.status,
        isActive: r.status !== 'CANCELLED',
        deletedAt: null,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'requisitions') {
      const b = new SqlBuilder();
      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(h.requisition_no) LIKE ${p} OR lower(h.employee_name) LIKE ${p} OR lower(h.department_name) LIKE ${p})`);
      }
      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM requisition_headers h ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        requisition_no: string;
        requisition_date: string;
        employee_name: string;
        department_name: string;
        hod_name: string;
        status: string;
        created_at: string;
      }>(
        `SELECT h.id, h.requisition_no, h.requisition_date, h.employee_name, h.department_name,
                h.hod_name, h.status, h.created_at
           FROM requisition_headers h
           ${b.where()}
          ORDER BY h.id DESC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.requisition_no,
        title: `Req: ${r.requisition_no}`,
        subtitle: `${r.employee_name} (${r.department_name || '—'})`,
        extraInfo: `HOD: ${r.hod_name || '—'} · Date: ${r.requisition_date}`,
        status: r.status,
        isActive: r.status !== 'CANCELLED',
        deletedAt: null,
        createdAt: r.created_at,
        isProtected: false,
      }));
    } else if (q.entity === 'direct_issues') {
      const b = new SqlBuilder();
      if (search) {
        const p = b.push(search);
        b.addRaw(`(lower(h.issue_no) LIKE ${p} OR lower(h.recipient_name) LIKE ${p})`);
      }
      const countRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM direct_issue_headers h ${b.where()}`, b.params);
      total = Number(countRow?.n ?? 0);

      const limitP = b.push(pageSize);
      const offsetP = b.push(offset);
      const rows = await query<{
        id: number;
        issue_no: string;
        issue_date: string;
        recipient_name: string;
        department_name: string;
        total_qty: string;
        created_at: string;
      }>(
        `SELECT h.id, h.issue_no, h.issue_date, h.recipient_name, h.department_name,
                h.total_qty, h.created_at
           FROM direct_issue_headers h
           ${b.where()}
          ORDER BY h.id DESC
          LIMIT ${limitP} OFFSET ${offsetP}`,
        b.params,
      );

      items = rows.map((r) => ({
        id: Number(r.id),
        code: r.issue_no,
        title: `Issue: ${r.issue_no}`,
        subtitle: `${r.recipient_name} (${r.department_name || '—'})`,
        extraInfo: `Qty: ${r.total_qty} · Date: ${r.issue_date}`,
        status: 'ISSUED',
        isActive: true,
        deletedAt: null,
        createdAt: r.created_at,
        isProtected: false,
      }));
    }

    sendOk(res, {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    });
  }),
);

/* ── 3. Record Deep Inspection & Dependency Audit ───────────────────────────── */

async function inspectDependencies(entity: string, id: number): Promise<{
  dependencies: DependencyCheck[];
  canHardDelete: boolean;
  blockingReasons: string[];
}> {
  const dependencies: DependencyCheck[] = [];
  const blockingReasons: string[] = [];

  if (entity === 'users') {
    const user = await queryOne<{ employee_id: string; employee_name: string }>(
      'SELECT employee_id, employee_name FROM users WHERE id = $1', [id],
    );
    if (user && PROTECTED_EMPLOYEE_IDS.has(user.employee_id)) {
      blockingReasons.push(`System Super Admin (${user.employee_name} - ${user.employee_id}) cannot be deleted.`);
    }

    const [indents, pos, grns, requisitions, issues, stockMovements] = await Promise.all([
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_indent_headers WHERE requested_by_user_id = $1 OR created_by = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_order_headers WHERE created_by = $1 OR issued_by = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM grn_headers WHERE received_by_user_id = $1 OR created_by = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM requisition_headers WHERE requester_user_id = $1 OR hod_user_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM requisition_issues WHERE store_user_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger WHERE created_by = $1', [id]),
    ]);

    dependencies.push(
      { table: 'purchase_indent_headers', label: 'Purchase Indents authored/requested', count: Number(indents?.n ?? 0) },
      { table: 'purchase_order_headers', label: 'Purchase Orders authored/issued', count: Number(pos?.n ?? 0) },
      { table: 'grn_headers', label: 'GRNs received/authored', count: Number(grns?.n ?? 0) },
      { table: 'requisition_headers', label: 'Requisitions requested/approved', count: Number(requisitions?.n ?? 0) },
      { table: 'requisition_issues', label: 'Issue Slips issued', count: Number(issues?.n ?? 0) },
      { table: 'stock_ledger', label: 'Stock Movements posted', count: Number(stockMovements?.n ?? 0) },
    );

    const totalRefs = dependencies.reduce((acc, d) => acc + d.count, 0);
    if (totalRefs > 0) {
      blockingReasons.push(`User is referenced in ${totalRefs} transaction document(s) and cannot be hard deleted. Deactivate instead.`);
    }
  } else if (entity === 'suppliers') {
    const [indents, pos, grns] = await Promise.all([
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_indent_headers WHERE suggested_supplier_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_order_headers WHERE supplier_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM grn_headers WHERE supplier_id = $1', [id]),
    ]);

    dependencies.push(
      { table: 'purchase_indent_headers', label: 'Purchase Indent suggestions', count: Number(indents?.n ?? 0) },
      { table: 'purchase_order_headers', label: 'Purchase Orders', count: Number(pos?.n ?? 0) },
      { table: 'grn_headers', label: 'Goods Receipt Notes', count: Number(grns?.n ?? 0) },
    );

    const totalRefs = dependencies.reduce((acc, d) => acc + d.count, 0);
    if (totalRefs > 0) {
      blockingReasons.push(`Supplier is referenced in ${totalRefs} transaction document(s). Deactivate instead.`);
    }
  } else if (entity === 'items') {
    const [indentLines, poLines, grnLines, reqLines, directLines, stockLedger] = await Promise.all([
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_indent_lines WHERE item_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_order_lines WHERE item_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM grn_lines WHERE item_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM requisition_lines WHERE item_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM direct_issue_lines WHERE item_id = $1', [id]),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM stock_ledger WHERE item_id = $1', [id]),
    ]);

    dependencies.push(
      { table: 'purchase_indent_lines', label: 'Indent Lines', count: Number(indentLines?.n ?? 0) },
      { table: 'purchase_order_lines', label: 'PO Lines', count: Number(poLines?.n ?? 0) },
      { table: 'grn_lines', label: 'GRN Lines', count: Number(grnLines?.n ?? 0) },
      { table: 'requisition_lines', label: 'Requisition Lines', count: Number(reqLines?.n ?? 0) },
      { table: 'direct_issue_lines', label: 'Direct Issue Lines', count: Number(directLines?.n ?? 0) },
      { table: 'stock_ledger', label: 'Stock Ledger Movements', count: Number(stockLedger?.n ?? 0) },
    );

    const totalRefs = dependencies.reduce((acc, d) => acc + d.count, 0);
    if (totalRefs > 0) {
      blockingReasons.push(`Item is referenced in ${totalRefs} document line(s) and stock movements. Deactivate instead.`);
    }
  } else if (entity === 'lookups') {
    const [itemsCount, usersCount, indentsCount, posCount, reqsCount] = await Promise.all([
      queryOne<{ n: string }>(
        'SELECT COUNT(*) AS n FROM items WHERE uom_id = $1 OR main_group_id = $1 OR item_type_id = $1 OR department_id = $1 OR cost_centre_id = $1',
        [id],
      ),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM users WHERE department_id = $1', [id]),
      queryOne<{ n: string }>(
        'SELECT COUNT(*) AS n FROM purchase_indent_headers WHERE indent_type_id = $1 OR department_id = $1 OR cost_centre_id = $1',
        [id],
      ),
      queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM purchase_order_headers WHERE po_type_id = $1', [id]),
      queryOne<{ n: string }>(
        'SELECT COUNT(*) AS n FROM requisition_headers WHERE department_id = $1 OR cost_centre_id = $1 OR machine_id = $1',
        [id],
      ),
    ]);

    dependencies.push(
      { table: 'items', label: 'Items linked', count: Number(itemsCount?.n ?? 0) },
      { table: 'users', label: 'Users linked', count: Number(usersCount?.n ?? 0) },
      { table: 'purchase_indent_headers', label: 'Purchase Indents linked', count: Number(indentsCount?.n ?? 0) },
      { table: 'purchase_order_headers', label: 'Purchase Orders linked', count: Number(posCount?.n ?? 0) },
      { table: 'requisition_headers', label: 'Requisitions linked', count: Number(reqsCount?.n ?? 0) },
    );

    const totalRefs = dependencies.reduce((acc, d) => acc + d.count, 0);
    if (totalRefs > 0) {
      blockingReasons.push(`Lookup value is referenced by ${totalRefs} record(s). Deactivate instead.`);
    }
  } else if (entity === 'indents') {
    const poSources = await queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM po_indent_sources WHERE indent_id = $1', [id]);
    dependencies.push({ table: 'po_indent_sources', label: 'Linked PO Lines', count: Number(poSources?.n ?? 0) });
    if (Number(poSources?.n ?? 0) > 0) {
      blockingReasons.push(`Indent is linked to ${poSources?.n} PO line(s). Cannot hard-delete.`);
    }
  } else if (entity === 'purchase_orders') {
    const grnRefs = await queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM grn_headers WHERE po_id = $1', [id]);
    dependencies.push({ table: 'grn_headers', label: 'Linked GRNs', count: Number(grnRefs?.n ?? 0) });
    if (Number(grnRefs?.n ?? 0) > 0) {
      blockingReasons.push(`Purchase Order is referenced by ${grnRefs?.n} GRN(s). Cannot hard-delete.`);
    }
  } else if (entity === 'grn') {
    const stockRefs = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM stock_ledger WHERE grn_id = $1 OR (reference_id = $1 AND reference_type IN ('GRN', 'GRN_INWARD', 'GRN_REVERSAL'))`,
      [id],
    );
    dependencies.push({ table: 'stock_ledger', label: 'Stock Movements posted', count: Number(stockRefs?.n ?? 0) });
    if (Number(stockRefs?.n ?? 0) > 0) {
      blockingReasons.push(`GRN has ${stockRefs?.n} stock movements in the ledger. Cannot hard-delete posted inventory.`);
    }
  } else if (entity === 'requisitions') {
    const issueRefs = await queryOne<{ n: string }>('SELECT COUNT(*) AS n FROM requisition_issues WHERE requisition_id = $1', [id]);
    dependencies.push({ table: 'requisition_issues', label: 'Material Issue Slips', count: Number(issueRefs?.n ?? 0) });
    if (Number(issueRefs?.n ?? 0) > 0) {
      blockingReasons.push(`Requisition has ${issueRefs?.n} issued material slip(s). Cannot hard-delete.`);
    }
  }

  const canHardDelete = blockingReasons.length === 0;
  return { dependencies, canHardDelete, blockingReasons };
}

router.get(
  '/inspect/:entity/:id',
  asyncHandler(async (req, res) => {
    const { entity } = req.params;
    const id = Number(req.params.id);
    if (!id || Number.isNaN(id)) throw ValidationError('Valid record ID required.');

    let record: Record<string, unknown> | null = null;
    let entityLabel = `${entity} #${id}`;

    if (entity === 'users') {
      record = await queryOne('SELECT * FROM users WHERE id = $1', [id]);
    } else if (entity === 'suppliers') {
      record = await queryOne('SELECT * FROM suppliers WHERE id = $1', [id]);
    } else if (entity === 'items') {
      record = await queryOne('SELECT * FROM items WHERE id = $1', [id]);
    } else if (entity === 'lookups') {
      record = await queryOne('SELECT * FROM lookups WHERE id = $1', [id]);
    } else if (entity === 'indents') {
      record = await queryOne('SELECT * FROM purchase_indent_headers WHERE id = $1', [id]);
    } else if (entity === 'purchase_orders') {
      record = await queryOne('SELECT * FROM purchase_order_headers WHERE id = $1', [id]);
    } else if (entity === 'grn') {
      record = await queryOne('SELECT * FROM grn_headers WHERE id = $1', [id]);
    } else if (entity === 'requisitions') {
      record = await queryOne('SELECT * FROM requisition_headers WHERE id = $1', [id]);
    } else if (entity === 'direct_issues') {
      record = await queryOne('SELECT * FROM direct_issue_headers WHERE id = $1', [id]);
    }

    if (!record) throw NotFoundError(`${entity} record`);

    const { dependencies, canHardDelete, blockingReasons } = await inspectDependencies(entity, id);

    // Audit trail for this record
    const auditLogs = await query<{
      id: number;
      action: string;
      actor_name: string;
      actor_employee_id: string;
      message: string;
      created_at: string;
    }>(
      `SELECT id, action, actor_name, actor_employee_id, message, created_at
         FROM audit_logs
        WHERE (entity = $1 AND entity_id = $2)
           OR (entity_label = $3)
        ORDER BY id DESC LIMIT 20`,
      [entity, id, entityLabel],
    );

    sendOk(res, {
      entity,
      id,
      record,
      dependencies,
      canHardDelete,
      blockingReasons,
      auditLogs,
    });
  }),
);

/* ── 4. Bulk Toggle Active (Deactivate / Reactivate) ────────────────────────── */

const bulkToggleActiveSchema = z.object({
  entity: z.enum(['users', 'suppliers', 'items', 'lookups']),
  ids: z.array(z.number().int().positive()).min(1, 'Select at least one record.'),
  isActive: z.boolean(),
});

router.post(
  '/bulk-toggle-active',
  validateBody(bulkToggleActiveSchema),
  asyncHandler(async (req, res) => {
    const { entity, ids, isActive } = req.body as z.infer<typeof bulkToggleActiveSchema>;
    const actor = actorFrom(req);

    let filteredIds = [...ids];
    if (entity === 'users') {
      // Protect super admins
      const protectedUsers = await query<{ id: number; employee_name: string }>(
        `SELECT id, employee_name FROM users WHERE id = ANY($1) AND employee_id = ANY($2)`,
        [ids, [...PROTECTED_EMPLOYEE_IDS]],
      );
      if (protectedUsers.length > 0) {
        if (!isActive) {
          const protectedSet = new Set(protectedUsers.map((u) => Number(u.id)));
          filteredIds = ids.filter((id) => !protectedSet.has(id));
          if (filteredIds.length === 0) {
            throw BusinessRuleError('Super Admin accounts (10221, 10422) cannot be deactivated.');
          }
        }
      }
      if (!isActive && filteredIds.includes(Number(req.user!.id))) {
        throw BusinessRuleError('You cannot deactivate your own account.');
      }
    }

    await withTransaction(async (tx) => {
      if (entity === 'users') {
        await assertMayChangeUsers(tx, req, filteredIds);
        if (!isActive) await assertActiveSuperAdminRemains(tx, filteredIds);
      }
      const table = entity;
      await tx.query(
        `UPDATE ${table}
            SET is_active = $1, updated_at = now(), updated_by = $2
          WHERE id = ANY($3)`,
        [isActive, req.user!.id, filteredIds],
      );

      if (entity === 'users') {
        for (const uid of filteredIds) {
          invalidateAuthState(uid);
        }
      }

      await auditIn(tx, {
        actor,
        action: 'UPDATE',
        entity: `admin.${entity}`,
        entityId: filteredIds[0],
        entityLabel: `${filteredIds.length} ${entity} records`,
        message: `Bulk ${isActive ? 'reactivated' : 'deactivated'} ${filteredIds.length} ${entity} row(s).`,
        after: { ids: filteredIds, isActive },
      });
    });

    sendOk(res, {
      updatedCount: filteredIds.length,
      message: `Successfully ${isActive ? 'activated' : 'deactivated'} ${filteredIds.length} ${entity} record(s).`,
    });
  }),
);

/* ── 5. Bulk Soft-Delete & Restore ─────────────────────────────────────────── */

const bulkSoftDeleteSchema = z.object({
  entity: z.enum(['users', 'suppliers', 'items', 'lookups']),
  ids: z.array(z.number().int().positive()).min(1, 'Select at least one record.'),
  restore: z.boolean().default(false),
});

router.post(
  '/bulk-soft-delete',
  validateBody(bulkSoftDeleteSchema),
  asyncHandler(async (req, res) => {
    const { entity, ids, restore } = req.body as z.infer<typeof bulkSoftDeleteSchema>;
    const actor = actorFrom(req);

    let filteredIds = [...ids];
    if (entity === 'users' && !restore) {
      const protectedUsers = await query<{ id: number }>(
        `SELECT id FROM users WHERE id = ANY($1) AND employee_id = ANY($2)`,
        [ids, [...PROTECTED_EMPLOYEE_IDS]],
      );
      if (protectedUsers.length > 0) {
        const protectedSet = new Set(protectedUsers.map((u) => Number(u.id)));
        filteredIds = ids.filter((id) => !protectedSet.has(id));
        if (filteredIds.length === 0) {
          throw BusinessRuleError('Super Admin accounts (10221, 10422) cannot be soft-deleted.');
        }
      }
      if (filteredIds.includes(Number(req.user!.id))) {
        throw BusinessRuleError('You cannot delete your own account.');
      }
    }

    await withTransaction(async (tx) => {
      if (entity === 'users') {
        await assertMayChangeUsers(tx, req, filteredIds);
        if (!restore) await assertActiveSuperAdminRemains(tx, filteredIds);
      }
      const table = entity;
      const timestamp = restore ? null : new Date().toISOString();
      await tx.query(
        `UPDATE ${table}
            SET deleted_at = $1, updated_at = now(), updated_by = $2
          WHERE id = ANY($3)`,
        [timestamp, req.user!.id, filteredIds],
      );

      if (entity === 'users') {
        for (const uid of filteredIds) {
          invalidateAuthState(uid);
        }
      }

      await auditIn(tx, {
        actor,
        action: restore ? 'RESTORE' : 'DELETE',
        entity: `admin.${entity}`,
        entityId: filteredIds[0],
        entityLabel: `${filteredIds.length} ${entity} records`,
        message: `Bulk ${restore ? 'restored' : 'soft-deleted'} ${filteredIds.length} ${entity} row(s).`,
        after: { ids: filteredIds, restore },
      });
    });

    sendOk(res, {
      updatedCount: filteredIds.length,
      message: `Successfully ${restore ? 'restored' : 'soft-deleted'} ${filteredIds.length} ${entity} record(s).`,
    });
  }),
);

/* ── 6. Safe Hard-Delete (Permanent Purge) ─────────────────────────────────── */

const hardDeleteSchema = z.object({
  entity: z.enum([
    'users',
    'suppliers',
    'items',
    'lookups',
    'indents',
    'purchase_orders',
    'grn',
    'requisitions',
    'direct_issues',
  ]),
  id: z.coerce.number().int().positive(),
  confirm: z.string(),
});

router.post(
  '/hard-delete',
  validateBody(hardDeleteSchema),
  asyncHandler(async (req, res) => {
    const { entity, id, confirm } = req.body as z.infer<typeof hardDeleteSchema>;
    if (confirm !== 'DELETE') {
      throw ValidationError('Type "DELETE" in the confirmation field to authorize permanent deletion.');
    }
    if (entity === 'users') {
      if (id === Number(req.user!.id)) throw BusinessRuleError('You cannot delete your own account.');
      await assertMayChangeUsers(undefined, req, [id]);
      await assertActiveSuperAdminRemains(undefined, [id], 'This is the last active Super Admin and cannot be deleted.');
    }

    const { canHardDelete, blockingReasons } = await inspectDependencies(entity, id);
    if (!canHardDelete) {
      throw BusinessRuleError(
        `Permanent deletion blocked: ${blockingReasons.join(' ')} Use deactivation instead.`,
      );
    }

    const actor = actorFrom(req);

    await withTransaction(async (tx) => {
      if (entity === 'users') {
        await tx.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
        await tx.query('DELETE FROM user_sessions WHERE user_id = $1', [id]);
        await tx.query('DELETE FROM users WHERE id = $1', [id]);
        invalidateAuthState(id);
      } else if (entity === 'suppliers') {
        await tx.query('DELETE FROM suppliers WHERE id = $1', [id]);
      } else if (entity === 'items') {
        await tx.query('DELETE FROM items WHERE id = $1', [id]);
      } else if (entity === 'lookups') {
        await tx.query('DELETE FROM lookups WHERE id = $1', [id]);
      } else if (entity === 'indents') {
        await tx.query('DELETE FROM indent_approvals WHERE indent_id = $1', [id]);
        await tx.query('DELETE FROM purchase_indent_lines WHERE indent_id = $1', [id]);
        await tx.query('DELETE FROM purchase_indent_headers WHERE id = $1', [id]);
      } else if (entity === 'purchase_orders') {
        await tx.query('DELETE FROM purchase_order_lines WHERE po_id = $1', [id]);
        await tx.query('DELETE FROM purchase_order_headers WHERE id = $1', [id]);
      } else if (entity === 'grn') {
        await tx.query('DELETE FROM grn_lines WHERE grn_id = $1', [id]);
        await tx.query('DELETE FROM grn_headers WHERE id = $1', [id]);
      } else if (entity === 'requisitions') {
        await tx.query('DELETE FROM requisition_approvals WHERE requisition_id = $1', [id]);
        await tx.query('DELETE FROM requisition_lines WHERE requisition_id = $1', [id]);
        await tx.query('DELETE FROM requisition_headers WHERE id = $1', [id]);
      } else if (entity === 'direct_issues') {
        await tx.query('DELETE FROM direct_issue_lines WHERE direct_issue_id = $1', [id]);
        await tx.query('DELETE FROM direct_issue_headers WHERE id = $1', [id]);
      }

      await auditIn(tx, {
        actor,
        action: 'DELETE',
        entity: `admin.${entity}`,
        entityId: id,
        entityLabel: `${entity} #${id}`,
        message: `Permanently deleted ${entity} #${id} with zero blocking dependencies.`,
      });
    });

    sendOk(res, {
      deleted: true,
      message: `Record ${entity} #${id} has been permanently deleted from the database.`,
    });
  }),
);

/* ── Repair: indent lines the Google sync appended more than once ─────────────
   Until 2026-10-16 the scheduled Google sync failed to recognise an indent line
   it had stored under the item master's code and appended it again on every run
   (62 lines x ~40 runs in production). A line is listed here ONLY when
     · the Google sync inserted it (created inside a sync job's run window), and
     · an identical line — same indent, item and quantity — already existed before
       that run started, and
     · no purchase order draws on it.
   Lines a sheet legitimately lists twice were imported in the same run, so they
   are never listed. The earlier line must match in every business column, not
   only item and quantity. A copy that someone has since acted on is HELD, listed
   but never removed: it is on a purchase order, it is short-closed, or its indent
   has left draft / approval. dryRun (the default) only lists, and returns a
   selection hash. Removing requires a Super Admin, the typed confirmation and that
   hash: if the set has changed since the dry run, nothing is removed. Every removed
   row is written in full to the audit log so it can be put back. */

const DUPLICATE_SYNC_LINES_SQL = `
  SELECT l.id, l.indent_id, h.indent_no, h.status, l.line_no, l.item_id, l.item_code, l.indent_qty, l.created_at,
         CASE WHEN EXISTS (SELECT 1 FROM po_indent_sources s WHERE s.indent_line_id = l.id) THEN 'ON_PURCHASE_ORDER'
              WHEN l.is_closed THEN 'SHORT_CLOSED'
              WHEN h.status NOT IN ('DRAFT', 'PENDING_APPROVAL') THEN 'INDENT_' || h.status
         END AS hold_reason
    FROM purchase_indent_lines l
    JOIN purchase_indent_headers h ON h.id = l.indent_id
   WHERE EXISTS (
           SELECT 1 FROM google_sync_jobs j
            WHERE l.created_at BETWEEN j.started_at AND COALESCE(j.finished_at, j.started_at + interval '15 minutes')
              AND EXISTS (
                    SELECT 1 FROM purchase_indent_lines e
                     WHERE e.indent_id = l.indent_id AND e.id < l.id AND e.created_at < j.started_at
                       AND e.item_id IS NOT DISTINCT FROM l.item_id AND e.indent_qty = l.indent_qty
                       AND e.item_code IS NOT DISTINCT FROM l.item_code
                       AND e.item_description IS NOT DISTINCT FROM l.item_description
                       AND e.uom_id IS NOT DISTINCT FROM l.uom_id
                       AND e.item_specification IS NOT DISTINCT FROM l.item_specification
                       AND e.department_id IS NOT DISTINCT FROM l.department_id
                       AND e.cost_centre_id IS NOT DISTINCT FROM l.cost_centre_id
                       AND e.estimated_rate IS NOT DISTINCT FROM l.estimated_rate
                       AND e.required_by_date IS NOT DISTINCT FROM l.required_by_date
                       AND e.remarks IS NOT DISTINCT FROM l.remarks))
   ORDER BY h.indent_no, l.item_code, l.id`;

type DuplicateLineRow = {
  id: number; indent_no: string; item_code: string; indent_qty: string; hold_reason: string | null;
};

/** One fingerprint for a set of line ids, so an apply removes exactly the set a dry run listed. */
const selectionHash = (ids: number[]) =>
  createHash('sha256').update([...ids].map(Number).sort((a, b) => a - b).join(',')).digest('hex');

function summariseDuplicates(found: DuplicateLineRow[]) {
  const removable = found.filter((r) => !r.hold_reason);
  const held = found.filter((r) => r.hold_reason);
  const byLine = new Map<string, number>();
  for (const r of removable) {
    const k = `${r.indent_no} | ${r.item_code} | ${Number(r.indent_qty)}`;
    byLine.set(k, (byLine.get(k) ?? 0) + 1);
  }
  const ids = removable.map((r) => Number(r.id));
  return {
    duplicateLines: removable.length,
    distinctLines: byLine.size,
    indents: new Set(removable.map((r) => r.indent_no)).size,
    duplicatedQty: Number(removable.reduce((a, r) => a + Number(r.indent_qty), 0).toFixed(4)),
    selectionHash: selectionHash(ids),
    ids,
    examples: [...byLine.entries()].slice(0, 25).map(([line, copies]) => ({ line, extraCopies: copies })),
    held: held.map((r) => ({ id: Number(r.id), indentNo: r.indent_no, itemCode: r.item_code, qty: Number(r.indent_qty), reason: r.hold_reason })),
  };
}

router.post(
  '/repair/duplicate-indent-lines',
  validateBody(z.object({
    dryRun: z.boolean().default(true),
    confirm: z.string().optional(),
    expectedHash: z.string().trim().regex(/^[0-9a-f]{64}$/, 'expectedHash is the selectionHash a dry run returned.').optional(),
  })),
  asyncHandler(async (req, res) => {
    const { dryRun, confirm, expectedHash } = req.body as { dryRun: boolean; confirm?: string; expectedHash?: string };
    if (dryRun) {
      const summary = summariseDuplicates(await query<DuplicateLineRow>(DUPLICATE_SYNC_LINES_SQL));
      sendOk(res, {
        dryRun: true,
        ...summary,
        message: `${summary.duplicateLines} duplicate line(s) on ${summary.indents} indent(s) would be removed`
          + `${summary.held.length ? `; ${summary.held.length} more are held for review` : ''}. Nothing was changed.`,
      });
      return;
    }
    if (!req.user!.roles.includes('SUPER_ADMIN')) {
      throw BusinessRuleError('Only a Super Admin can remove duplicate lines.');
    }
    if (confirm !== 'REMOVE DUPLICATES') {
      throw ValidationError('Type "REMOVE DUPLICATES" to confirm. Take a backup first.');
    }
    if (!expectedHash) {
      throw ValidationError('Run the dry run first and pass its selectionHash as expectedHash.');
    }
    const result = await withTransaction(async (tx) => {
      // Re-select inside the transaction: the rows removed are exactly the rows recorded,
      // and exactly the rows the dry run listed.
      const summary = summariseDuplicates(await txQuery<DuplicateLineRow>(tx, DUPLICATE_SYNC_LINES_SQL));
      if (summary.selectionHash !== expectedHash) {
        throw ConflictError(
          `The duplicate lines have changed since the dry run (now ${summary.duplicateLines}). Nothing was removed; run the dry run again and review it.`,
          { duplicateLines: summary.duplicateLines, selectionHash: summary.selectionHash },
        );
      }
      const rows = summary.ids.length
        ? await txQuery<Record<string, unknown>>(tx, 'SELECT * FROM purchase_indent_lines WHERE id = ANY($1::bigint[]) ORDER BY id', [summary.ids])
        : [];
      if (rows.length > 0) {
        await tx.query('DELETE FROM purchase_indent_lines WHERE id = ANY($1::bigint[])', [summary.ids]);
      }
      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'DELETE',
        entity: 'purchase_indent_lines',
        entityLabel: 'duplicate lines appended by the Google sync',
        before: rows,
        after: { removed: rows.length, distinctLines: summary.distinctLines, duplicatedQty: summary.duplicatedQty, selectionHash: summary.selectionHash, held: summary.held.length },
        message: `Removed ${rows.length} indent line(s) the Google sync had appended more than once (${summary.distinctLines} distinct line(s) on ${summary.indents} indent(s) kept once each, ${summary.duplicatedQty} units). Every removed row is stored in this audit entry.`,
      });
      return { removed: rows.length, summary };
    });
    const { ids: _ids, ...summary } = result.summary;
    sendOk(res, { dryRun: false, removed: result.removed, ...summary, message: `${result.removed} duplicate line(s) removed; the full rows are kept in the audit log.` });
  }),
);

/* ── Repair: undo the indent / PO lines one Google sync run inserted ───────────
   For a run that inserted lines it should not have (2026-10-16 05:33: a defective
   build matched existing lines too narrowly and re-inserted 293 PO + 51 indent
   lines). Removes exactly the indent and PO lines created inside that run's time
   window, the PO-to-indent links the run made for them and the GRN links it set
   on them, then re-derives the affected POs' status. It refuses when
     · the number of lines in the window differs from what the run recorded
       (someone else may have created lines at the same moment),
     · the run also created document headers (needs a person to review), or
     · anything made AFTER the run refers to those lines (a later GRN or PO).
   dryRun (default) only reports; applying needs a Super Admin and the typed
   confirmation "REVERT JOB <id>", and every removed row is kept in the audit log. */

router.post(
  '/repair/revert-google-sync-job',
  validateBody(z.object({
    jobId: z.coerce.number().int().positive(),
    dryRun: z.boolean().default(true),
    confirm: z.string().optional(),
  })),
  asyncHandler(async (req, res) => {
    const { jobId, dryRun, confirm } = req.body as { jobId: number; dryRun: boolean; confirm?: string };
    const job = await queryOne<{ id: number; started_at: string; finished_at: string | null; detail: unknown; status: string }>(
      'SELECT id, started_at, finished_at, detail, status FROM google_sync_jobs WHERE id = $1', [jobId],
    );
    if (!job) throw NotFoundError('Google sync run');
    if (!job.finished_at) throw BusinessRuleError('That run has not finished.');
    const detail = Array.isArray(job.detail) ? (job.detail as Array<{ sheet: string; inserted?: number }>) : [];
    const recorded = (sheet: string) => Number(detail.find((d) => d.sheet === sheet)?.inserted ?? 0);
    const win = [job.started_at, job.finished_at];

    const inspect = async (run: <T>(sql: string, p?: unknown[]) => Promise<T[]>) => {
      const poLines = await run<Record<string, unknown> & { id: number; po_id: number }>(
        'SELECT * FROM purchase_order_lines WHERE created_at BETWEEN $1 AND $2 ORDER BY id', win);
      const indentLines = await run<Record<string, unknown> & { id: number }>(
        'SELECT * FROM purchase_indent_lines WHERE created_at BETWEEN $1 AND $2 ORDER BY id', win);
      const poIds = poLines.map((l) => l.id);
      const indentIds = indentLines.map((l) => l.id);
      const sources = await run<Record<string, unknown> & { id: number; created_at: string }>(
        'SELECT * FROM po_indent_sources WHERE po_line_id = ANY($1::bigint[]) OR indent_line_id = ANY($2::bigint[]) ORDER BY id',
        [poIds, indentIds]);
      const grnLinks = await run<{ id: number; po_line_id: number; grn_no: string; grn_created: string }>(
        `SELECT gl.id, gl.po_line_id, gh.grn_no, gh.created_at AS grn_created
           FROM grn_lines gl JOIN grn_headers gh ON gh.id = gl.grn_id
          WHERE gl.po_line_id = ANY($1::bigint[]) ORDER BY gl.id`, [poIds]);
      const headers = await run<{ kind: string; n: number }>(
        `SELECT 'purchase_order_headers' AS kind, COUNT(*)::int AS n FROM purchase_order_headers WHERE created_at BETWEEN $1 AND $2
         UNION ALL
         SELECT 'purchase_indent_headers', COUNT(*)::int FROM purchase_indent_headers WHERE created_at BETWEEN $1 AND $2`, win);
      const blockers: string[] = [];
      if (poLines.length !== recorded('Purchase Order')) blockers.push(`${poLines.length} PO line(s) were created in the run's window but the run recorded ${recorded('Purchase Order')}.`);
      if (indentLines.length !== recorded('Purchase Indent')) blockers.push(`${indentLines.length} indent line(s) were created in the run's window but the run recorded ${recorded('Purchase Indent')}.`);
      for (const h of headers) if (h.n > 0) blockers.push(`The run also created ${h.n} row(s) in ${h.kind}; review those by hand.`);
      const later = sources.filter((s) => s.created_at > job.finished_at!);
      if (later.length) blockers.push(`${later.length} PO-to-indent link(s) made after the run refer to these lines.`);
      const laterGrn = grnLinks.filter((g) => g.grn_created > job.finished_at!);
      if (laterGrn.length) blockers.push(`GRN(s) ${laterGrn.map((g) => g.grn_no).join(', ')} were made after the run against these lines.`);
      return { poLines, indentLines, sources, grnLinks, blockers };
    };

    const found = await inspect((sql, p) => query(sql, p ?? []));
    const summary = {
      jobId, window: win,
      poLines: found.poLines.length, indentLines: found.indentLines.length,
      poIndentLinks: found.sources.length, grnLinksToClear: found.grnLinks.length,
      affectedPOs: [...new Set(found.poLines.map((l) => l.po_id))].length,
      blockers: found.blockers,
    };
    if (dryRun) {
      sendOk(res, { dryRun: true, ...summary, message: found.blockers.length ? 'Cannot be reverted automatically — see blockers.' : 'Nothing was changed.' });
      return;
    }
    if (!req.user!.roles.includes('SUPER_ADMIN')) throw BusinessRuleError('Only a Super Admin can revert a sync run.');
    if (confirm !== `REVERT JOB ${jobId}`) throw ValidationError(`Type "REVERT JOB ${jobId}" to confirm. Take a backup first.`);
    if (found.blockers.length) throw BusinessRuleError(`This run cannot be reverted automatically: ${found.blockers.join(' ')}`);

    const { recomputePoStatuses } = await import('../google-sync/engine.js');
    const result = await withTransaction(async (tx) => {
      const again = await inspect((sql, p) => txQuery(tx, sql, p ?? []));
      if (again.blockers.length || again.poLines.length !== found.poLines.length || again.indentLines.length !== found.indentLines.length) {
        throw BusinessRuleError('The data changed while preparing the revert; nothing was changed. Try again.');
      }
      const poIds = again.poLines.map((l) => l.id);
      const indentIds = again.indentLines.map((l) => l.id);
      await tx.query('DELETE FROM po_indent_sources WHERE id = ANY($1::bigint[])', [again.sources.map((s) => s.id)]);
      await tx.query('UPDATE grn_lines SET po_line_id = NULL WHERE id = ANY($1::bigint[])', [again.grnLinks.map((g) => g.id)]);
      await tx.query('DELETE FROM purchase_order_lines WHERE id = ANY($1::bigint[])', [poIds]);
      await tx.query('DELETE FROM purchase_indent_lines WHERE id = ANY($1::bigint[])', [indentIds]);
      const statusChanged = await recomputePoStatuses(tx, [...new Set(again.poLines.map((l) => Number(l.po_id)))]);
      await auditIn(tx, {
        actor: actorFrom(req),
        action: 'DELETE',
        entity: 'google_sync_job',
        entityId: jobId,
        entityLabel: `revert of Google sync run #${jobId}`,
        before: { poLines: again.poLines, indentLines: again.indentLines, poIndentSources: again.sources, grnLinks: again.grnLinks },
        after: { removedPoLines: poIds.length, removedIndentLines: indentIds.length, clearedGrnLinks: again.grnLinks.length, poStatusesRederived: statusChanged },
        message: `Reverted Google sync run #${jobId}: removed ${poIds.length} PO line(s) and ${indentIds.length} indent line(s) it inserted, ${again.sources.length} PO-to-indent link(s) and ${again.grnLinks.length} GRN link(s) it made; re-derived ${statusChanged} PO status(es). Every removed row is stored in this audit entry.`,
      });
      return { statusChanged };
    });
    sendOk(res, { dryRun: false, ...summary, poStatusesRederived: result.statusChanged, message: `Run #${jobId} reverted.` });
  }),
);

export default router;
