/**
 * Global search (SRS §14 / build brief §30).
 *
 * Searches every authorised entity in one call and returns results grouped by
 * entity with a drill-down target. Results a user lacks permission to view are
 * never returned — the search itself is permission-aware, not just the UI.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../db/index.js';
import { asyncHandler, sendOk, validateQuery, parsedQuery } from '../../core/http.js';
import { toDateOnly } from '../../domain/numbering.js';
const router = Router();
const schema = z.object({
    q: z.string().trim().min(1, 'Enter something to search for.').max(120),
    limit: z.coerce.number().int().min(1).max(20).default(6),
});
router.get('/', validateQuery(schema), asyncHandler(async (req, res) => {
    const { q, limit } = parsedQuery(res);
    const term = `%${q.toLowerCase()}%`;
    const can = (code) => req.user.permissions.has(code);
    const groups = [];
    if (can('item.view')) {
        const rows = await query(`SELECT id, item_code, item_description, hsn_code
           FROM items
          WHERE deleted_at IS NULL
            AND (lower(item_code) LIKE $1 OR lower(item_description) LIKE $1 OR lower(hsn_code) LIKE $1)
          ORDER BY (lower(item_code) LIKE $1) DESC, item_code
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'item', label: 'Items', icon: 'package',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.item_code, subtitle: r.item_description,
                    meta: r.hsn_code ? `HSN ${r.hsn_code}` : undefined,
                    route: `/masters/items/${r.id}`,
                })),
            });
        }
    }
    if (can('supplier.view')) {
        const rows = await query(`SELECT id, supplier_code, supplier_name, city, state, gst_no
           FROM suppliers
          WHERE deleted_at IS NULL
            AND (lower(supplier_name) LIKE $1 OR lower(supplier_code) LIKE $1
                 OR lower(gst_no) LIKE $1 OR lower(city) LIKE $1)
          ORDER BY supplier_name
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'supplier', label: 'Suppliers', icon: 'building',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.supplier_name,
                    subtitle: [r.city, r.state].filter(Boolean).join(', ') || r.supplier_code,
                    meta: r.gst_no || undefined,
                    route: `/masters/suppliers/${r.id}`,
                })),
            });
        }
    }
    if (can('indent.view')) {
        const rows = await query(`SELECT h.id, h.indent_no, h.indent_date, h.status,
                (SELECT string_agg(DISTINCT l.item_code, ', ')
                   FROM purchase_indent_lines l WHERE l.indent_id = h.id) AS items
           FROM purchase_indent_headers h
          WHERE lower(h.indent_no) LIKE $1
             OR EXISTS (SELECT 1 FROM purchase_indent_lines l
                         WHERE l.indent_id = h.id
                           AND (lower(l.item_code) LIKE $1 OR lower(l.item_description) LIKE $1))
          ORDER BY h.indent_date DESC
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'indent', label: 'Purchase Indents', icon: 'file-text',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.indent_no,
                    subtitle: r.items ? String(r.items).slice(0, 70) : 'No lines',
                    meta: `${r.status.replace(/_/g, ' ')} · ${toDateOnly(r.indent_date)}`,
                    route: `/indents/${r.id}`,
                })),
            });
        }
    }
    if (can('po.view')) {
        const rows = await query(`SELECT h.id, h.po_no, h.po_date, h.status, s.supplier_name
           FROM purchase_order_headers h
           JOIN suppliers s ON s.id = h.supplier_id
          WHERE lower(h.po_no) LIKE $1 OR lower(s.supplier_name) LIKE $1
             OR EXISTS (SELECT 1 FROM purchase_order_lines l
                         WHERE l.po_id = h.id
                           AND (lower(l.item_code) LIKE $1 OR lower(l.item_description) LIKE $1))
          ORDER BY h.po_date DESC
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'po', label: 'Purchase Orders', icon: 'shopping-cart',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.po_no, subtitle: r.supplier_name,
                    meta: `${r.status.replace(/_/g, ' ')} · ${toDateOnly(r.po_date)}`,
                    route: `/purchase-orders/${r.id}`,
                })),
            });
        }
    }
    if (can('grn.view')) {
        const rows = await query(`SELECT g.id, g.grn_no, g.grn_date, g.status, g.challan_no, p.po_no, s.supplier_name
           FROM grn_headers g
           LEFT JOIN purchase_order_headers p ON p.id = g.po_id
           JOIN suppliers s ON s.id = g.supplier_id
          WHERE lower(g.grn_no) LIKE $1 OR lower(g.challan_no) LIKE $1
             OR lower(COALESCE(p.po_no,'')) LIKE $1 OR lower(s.supplier_name) LIKE $1
          ORDER BY g.grn_date DESC
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'grn', label: 'Goods Receipts', icon: 'truck',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.grn_no,
                    subtitle: r.po_no ? `${r.po_no} · ${r.supplier_name}` : `Direct receipt · ${r.supplier_name}`,
                    meta: `${r.status} · ${toDateOnly(r.grn_date)}`,
                    route: `/grn/${r.id}`,
                })),
            });
        }
    }
    if (can('requisition.view')) {
        const rows = await query(`SELECT h.id, h.requisition_no, h.requisition_date, h.status, h.employee_name, h.department_name,
                (SELECT string_agg(DISTINCT l.item_code, ', ')
                   FROM requisition_lines l WHERE l.requisition_id = h.id) AS items
           FROM requisition_headers h
          WHERE lower(h.requisition_no) LIKE $1
             OR lower(h.employee_name) LIKE $1 OR lower(h.employee_code) LIKE $1
             OR lower(h.department_name) LIKE $1 OR lower(h.hod_name) LIKE $1
             OR EXISTS (SELECT 1 FROM requisition_lines l
                         WHERE l.requisition_id = h.id
                           AND (lower(l.item_code) LIKE $1 OR lower(l.item_description) LIKE $1))
             OR EXISTS (SELECT 1 FROM requisition_issues i
                         WHERE i.requisition_id = h.id AND lower(i.issue_slip_no) LIKE $1)
          ORDER BY h.requisition_date DESC
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'requisition', label: 'Requisitions', icon: 'package-check',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.requisition_no,
                    subtitle: `${r.employee_name} · ${r.department_name}${r.items ? ` · ${String(r.items).slice(0, 50)}` : ''}`,
                    meta: `${r.status.replace(/_/g, ' ')} · ${toDateOnly(r.requisition_date)}`,
                    route: `/requisitions/${r.id}`,
                })),
            });
        }
    }
    if (can('user.view')) {
        const rows = await query(`SELECT id, employee_id, employee_name, designation
           FROM users
          WHERE deleted_at IS NULL
            AND (lower(employee_name) LIKE $1 OR lower(employee_id) LIKE $1 OR lower(designation) LIKE $1)
          ORDER BY employee_name
          LIMIT $2`, [term, limit]);
        if (rows.length) {
            groups.push({
                entity: 'user', label: 'Users', icon: 'user',
                results: rows.map((r) => ({
                    id: String(r.id), title: r.employee_name,
                    subtitle: r.designation || 'No designation',
                    meta: `ID ${r.employee_id}`,
                    route: `/admin/users/${r.id}`,
                })),
            });
        }
    }
    sendOk(res, {
        query: q,
        groups,
        totalResults: groups.reduce((n, g) => n + g.results.length, 0),
    });
}));
export default router;
//# sourceMappingURL=routes.js.map