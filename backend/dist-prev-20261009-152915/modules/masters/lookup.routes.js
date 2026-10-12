/**
 * Supporting masters — PO Type, Indent Type, Cost Centre, Department, Item Type,
 * Main Group, Sub Main Group, UOM, Currency, Payment Terms (SRS §7.3, ADR-014).
 *
 * One table with a `category` discriminator backs every master-driven dropdown in
 * the product, so there is one CRUD implementation rather than ten copies.
 *
 * NOTHING in the frontend hard-codes these values (build brief §53) — every select
 * in the UI is populated from `GET /lookups/:category` or `GET /lookups/options`.
 *
 * Indent Type, PO Type and GRN Type are three SEPARATE fields (Indent, PO and
 * GRN each store their own classification in their own column), but PO Type's
 * and GRN Type's dropdown OPTIONS are deliberately sourced from the SAME
 * category as Indent Type (INDENT_TYPE) at the application layer, so all
 * three offer identical values without maintaining three lists that could
 * drift apart (migration 013). The PO_TYPE / GRN_TYPE categories remain
 * registered here for historical data (existing po_type_id/grn_type_id rows
 * keep pointing at real, readable lookup rows) even though new selections in
 * the PO/GRN forms are made from INDENT_TYPE's options.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQueryOne, SqlBuilder } from '../../db/index.js';
import { asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery, parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, } from '../../core/http.js';
import { NotFoundError, ConflictError, ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
const router = Router();
export const LOOKUP_CATEGORIES = [
    'DEPARTMENT', 'COST_CENTRE', 'ITEM_TYPE', 'MAIN_GROUP', 'SUB_MAIN_GROUP',
    'UOM', 'INDENT_TYPE', 'PO_TYPE', 'CURRENCY', 'PAYMENT_TERMS', 'STATE', 'CITY',
    'GRN_TYPE', 'PACKING_TYPE', 'LOCATION', 'MACHINE',
];
const CATEGORY_LABELS = {
    DEPARTMENT: { singular: 'Department', plural: 'Departments' },
    COST_CENTRE: { singular: 'Cost Centre', plural: 'Cost Centres' },
    ITEM_TYPE: { singular: 'Item Type', plural: 'Item Types' },
    MAIN_GROUP: { singular: 'Main Group', plural: 'Main Groups' },
    SUB_MAIN_GROUP: { singular: 'Sub Main Group', plural: 'Sub Main Groups' },
    UOM: { singular: 'Unit of Measure', plural: 'Units of Measure' },
    INDENT_TYPE: { singular: 'Indent Type', plural: 'Indent Types' },
    PO_TYPE: { singular: 'PO Type', plural: 'PO Types' },
    CURRENCY: { singular: 'Currency', plural: 'Currencies' },
    PAYMENT_TERMS: { singular: 'Payment Terms', plural: 'Payment Terms' },
    STATE: { singular: 'State', plural: 'States' },
    CITY: { singular: 'City', plural: 'Cities' },
    GRN_TYPE: { singular: 'GRN Type', plural: 'GRN Types' },
    PACKING_TYPE: { singular: 'Packing Type', plural: 'Packing Types' },
    LOCATION: { singular: 'Location', plural: 'Locations' },
    MACHINE: { singular: 'Machine', plural: 'Machines' },
};
/** Categories whose values may carry a parent (cascading dropdowns). */
const PARENT_OF = {
    SUB_MAIN_GROUP: 'MAIN_GROUP',
    CITY: 'STATE',
    // A Machine belongs to one Department, so the requisition form's Machine
    // dropdown can filter to the requester's own department (Requisition, tab 4).
    MACHINE: 'DEPARTMENT',
};
const categorySchema = z.enum(LOOKUP_CATEGORIES);
/** Which master tables reference a lookup — used to protect in-use values. */
const REFERENCES = [
    { table: 'items', column: 'item_type_id', label: 'items' },
    { table: 'items', column: 'department_id', label: 'items' },
    { table: 'items', column: 'cost_centre_id', label: 'items' },
    { table: 'items', column: 'main_group_id', label: 'items' },
    { table: 'items', column: 'sub_main_group_id', label: 'items' },
    { table: 'items', column: 'indent_type_id', label: 'items' },
    { table: 'items', column: 'uom_id', label: 'items' },
    { table: 'purchase_indent_headers', column: 'indent_type_id', label: 'purchase indents' },
    { table: 'purchase_indent_headers', column: 'department_id', label: 'purchase indents' },
    { table: 'purchase_indent_headers', column: 'cost_centre_id', label: 'purchase indents' },
    { table: 'purchase_indent_lines', column: 'uom_id', label: 'indent lines' },
    { table: 'purchase_order_headers', column: 'po_type_id', label: 'purchase orders' },
    { table: 'purchase_order_lines', column: 'uom_id', label: 'purchase order lines' },
    { table: 'grn_lines', column: 'uom_id', label: 'GRN lines' },
    { table: 'users', column: 'department_id', label: 'users' },
    { table: 'lookups', column: 'parent_id', label: 'sub-groups' },
];
async function countReferences(id) {
    const where = [];
    let total = 0;
    for (const ref of REFERENCES) {
        const row = await queryOne(`SELECT COUNT(*) AS n FROM ${ref.table} WHERE ${ref.column} = $1`, [id]);
        const n = Number(row?.n ?? 0);
        if (n > 0) {
            total += n;
            if (!where.includes(ref.label))
                where.push(ref.label);
        }
    }
    return { total, where };
}
/* ── GET /lookups/categories — catalogue for the admin UI ───────────────────── */
router.get('/categories', requirePermission('lookup.view'), asyncHandler(async (_req, res) => {
    const counts = await query(`SELECT category, COUNT(*) AS n, COUNT(*) FILTER (WHERE is_active) AS active
         FROM lookups WHERE deleted_at IS NULL GROUP BY category`);
    const map = new Map(counts.map((c) => [c.category, c]));
    sendOk(res, LOOKUP_CATEGORIES.map((c) => ({
        category: c,
        label: CATEGORY_LABELS[c].plural,
        singular: CATEGORY_LABELS[c].singular,
        parentCategory: PARENT_OF[c] ?? null,
        total: Number(map.get(c)?.n ?? 0),
        active: Number(map.get(c)?.active ?? 0),
    })));
}));
/* ── GET /lookups/options — every dropdown source in one call ───────────────── */
/* The frontend fetches this once and caches it, so no screen ever hard-codes a
   dropdown and no screen makes ten round-trips to render a form.               */
router.get('/options', asyncHandler(async (_req, res) => {
    const rows = await query(`SELECT id, category, code, name, parent_id
         FROM lookups
        WHERE deleted_at IS NULL AND is_active = TRUE
        ORDER BY category, sort_order, name`);
    const grouped = {};
    for (const c of LOOKUP_CATEGORIES)
        grouped[c] = [];
    for (const r of rows) {
        (grouped[r.category] ??= []).push({
            id: Number(r.id),
            code: r.code,
            name: r.name,
            parentId: r.parent_id === null ? null : Number(r.parent_id),
        });
    }
    sendOk(res, grouped, { generatedAt: new Date().toISOString() });
}));
/* ── GET /lookups/:category — paginated list ────────────────────────────────── */
const listSchema = listQuerySchema.extend({
    isActive: z.enum(['true', 'false']).optional(),
    parentId: z.coerce.number().int().positive().optional(),
});
const SORTABLE = {
    name: 'l.name',
    code: 'l.code',
    sortOrder: 'l.sort_order',
    createdAt: 'l.created_at',
    updatedAt: 'l.updated_at',
};
router.get('/:category', requirePermission('lookup.view'), validateQuery(listSchema), asyncHandler(async (req, res) => {
    const parsedCategory = categorySchema.safeParse(req.params.category?.toUpperCase());
    if (!parsedCategory.success)
        throw NotFoundError('Master category');
    const category = parsedCategory.data;
    const q = parsedQuery(res);
    const b = new SqlBuilder();
    b.addRaw('l.deleted_at IS NULL');
    b.add('l.category = ?', category);
    if (q.isActive)
        b.addRaw(`l.is_active = ${q.isActive === 'true' ? 'TRUE' : 'FALSE'}`);
    b.add('l.parent_id = ?', q.parentId);
    if (q.search) {
        const term = `%${q.search.toLowerCase()}%`;
        const p1 = b.push(term);
        b.addRaw(`(lower(l.name) LIKE ${p1} OR lower(l.code) LIKE ${p1} OR lower(l.description) LIKE ${p1})`);
    }
    const totalRow = await queryOne(`SELECT COUNT(*) AS n FROM lookups l ${b.where()}`, b.params);
    const total = Number(totalRow?.n ?? 0);
    const order = resolveSort(q, SORTABLE, 'sortOrder');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));
    const rows = await query(`SELECT l.id, l.category, l.code, l.name, l.description, l.parent_id,
              p.name AS parent_name, l.sort_order, l.is_active, l.is_system,
              l.extra, l.created_at, l.updated_at
         FROM lookups l
         LEFT JOIN lookups p ON p.id = l.parent_id
         ${b.where()}
        ORDER BY ${order}, l.name ASC
        LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, total, q.page, q.pageSize, {
        category,
        label: CATEGORY_LABELS[category].plural,
        parentCategory: PARENT_OF[category] ?? null,
    });
}));
/* ── POST /lookups/:category ────────────────────────────────────────────────── */
const upsertSchema = z.object({
    code: z.string().trim().min(1, 'Code is required.').max(50),
    name: z.string().trim().min(1, 'Name is required.').max(200),
    description: z.string().trim().max(500).default(''),
    parentId: z.coerce.number().int().positive().nullable().optional(),
    sortOrder: z.coerce.number().int().min(0).max(99999).default(0),
    isActive: z.boolean().default(true),
});
async function assertParentValid(category, parentId) {
    const expected = PARENT_OF[category];
    if (!expected)
        return;
    if (parentId === null || parentId === undefined)
        return;
    const parent = await queryOne('SELECT category FROM lookups WHERE id = $1 AND deleted_at IS NULL', [parentId]);
    if (!parent)
        throw ValidationError('The selected parent does not exist.', [{ field: 'parentId', message: 'Not found.' }]);
    if (parent.category !== expected) {
        throw ValidationError(`A ${CATEGORY_LABELS[category].singular} must belong to a ${CATEGORY_LABELS[expected].singular}.`, [{ field: 'parentId', message: `Must be a ${CATEGORY_LABELS[expected].singular}.` }]);
    }
}
router.post('/:category', requirePermission('lookup.create'), validateBody(upsertSchema), asyncHandler(async (req, res) => {
    const parsedCategory = categorySchema.safeParse(req.params.category?.toUpperCase());
    if (!parsedCategory.success)
        throw NotFoundError('Master category');
    const category = parsedCategory.data;
    const body = req.body;
    await assertParentValid(category, body.parentId);
    const created = await withTransaction(async (tx) => {
        const row = await txQueryOne(tx, `INSERT INTO lookups (category, code, name, description, parent_id, sort_order, is_active, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`, [category, body.code, body.name, body.description, body.parentId ?? null,
            body.sortOrder, body.isActive, req.user.id]);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'CREATE', entity: 'lookup', entityId: row?.id,
            entityLabel: `${CATEGORY_LABELS[category].singular}: ${body.name}`, after: { category, ...body },
        });
        return row;
    });
    const full = await queryOne('SELECT * FROM lookups WHERE id = $1', [created?.id]);
    sendCreated(res, full);
}));
/* ── PUT /lookups/:category/:id ─────────────────────────────────────────────── */
router.put('/:category/:id', requirePermission('lookup.edit'), validateBody(upsertSchema), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body;
    const before = await queryOne('SELECT * FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before)
        throw NotFoundError('Master value');
    const category = before.category;
    await assertParentValid(category, body.parentId);
    if (body.parentId === id) {
        throw ValidationError('A value cannot be its own parent.', [{ field: 'parentId', message: 'Invalid parent.' }]);
    }
    // System values (standard units, currencies) keep their code; the label may be edited.
    const code = before.is_system ? before.code : body.code;
    await withTransaction(async (tx) => {
        await tx.query(`UPDATE lookups
            SET code = $2, name = $3, description = $4, parent_id = $5,
                sort_order = $6, is_active = $7, updated_at = now(), updated_by = $8
          WHERE id = $1`, [id, code, body.name, body.description, body.parentId ?? null,
            body.sortOrder, body.isActive, req.user.id]);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'UPDATE', entity: 'lookup', entityId: id,
            entityLabel: `${CATEGORY_LABELS[category].singular}: ${body.name}`,
            before, after: { ...body, code },
        });
    });
    sendOk(res, await queryOne('SELECT * FROM lookups WHERE id = $1', [id]));
}));
/* ── DELETE /lookups/:category/:id ──────────────────────────────────────────── */
/* Soft delete when unreferenced; deactivate (never orphan history) when in use —
   SRS §20 "use soft delete for master records that have historical dependencies". */
router.delete('/:category/:id', requirePermission('lookup.delete'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const before = await queryOne('SELECT * FROM lookups WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!before)
        throw NotFoundError('Master value');
    if (before.is_system) {
        throw ConflictError('Standard system values cannot be deleted. You can deactivate them instead.');
    }
    const refs = await countReferences(id);
    const result = await withTransaction(async (tx) => {
        if (refs.total > 0) {
            await tx.query('UPDATE lookups SET is_active = FALSE, updated_at = now(), updated_by = $2 WHERE id = $1', [id, req.user.id]);
            await auditIn(tx, {
                actor: actorFrom(req), action: 'UPDATE', entity: 'lookup', entityId: id,
                entityLabel: before.name, before, after: { ...before, is_active: false },
                message: `Deactivated instead of deleted — referenced by ${refs.total} record(s)`,
            });
            return {
                deleted: false,
                message: `"${before.name}" is used by ${refs.total} record(s) in ${refs.where.join(', ')}, ` +
                    `so it has been deactivated rather than deleted. It will no longer appear in dropdowns, ` +
                    `and existing records keep their history.`,
            };
        }
        await tx.query('UPDATE lookups SET deleted_at = now(), is_active = FALSE, updated_by = $2 WHERE id = $1', [id, req.user.id]);
        await auditIn(tx, {
            actor: actorFrom(req), action: 'DELETE', entity: 'lookup', entityId: id,
            entityLabel: before.name, before,
        });
        return { deleted: true, message: `"${before.name}" has been deleted.` };
    });
    sendOk(res, result);
}));
/* ── GET /lookups/:category/:id/usage — what would break ────────────────────── */
router.get('/:category/:id/usage', requirePermission('lookup.view'), asyncHandler(async (req, res) => {
    const id = idParam(req);
    const refs = await countReferences(id);
    sendOk(res, { referenceCount: refs.total, referencedIn: refs.where, canDelete: refs.total === 0 });
}));
export default router;
//# sourceMappingURL=lookup.routes.js.map