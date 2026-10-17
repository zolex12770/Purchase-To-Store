/**
 * Supplier Master (SRS §7.2, ADR-010).
 *
 * `GET /suppliers/:id/profile` is the auto-population endpoint: selecting a supplier
 * anywhere in the product returns every mapped commercial field in one call, so the
 * user never retypes information that already exists (SRS §2, §29).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam,
} from '../../core/http.js';
import { NotFoundError, ConflictError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';

const router = Router();

const SORTABLE: Record<string, string> = {
  supplierName: 's.supplier_name',
  supplierCode: 's.supplier_code',
  city: 's.city',
  state: 's.state',
  createdAt: 's.created_at',
  updatedAt: 's.updated_at',
};

/** The list's query; its Export accepts exactly the same (io/datasets.ts). */
export const listSchema = listQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  state: z.string().trim().max(100).optional(),
  city: z.string().trim().max(100).optional(),
});

/** The Supplier Master list's filter, shared with its export (which searched fewer columns). */
export function buildSupplierFilter(q: z.infer<typeof listSchema>): SqlBuilder {
  const b = new SqlBuilder();
  b.addRaw('s.deleted_at IS NULL');
  if (q.isActive) b.addRaw(`s.is_active = ${q.isActive === 'true' ? 'TRUE' : 'FALSE'}`);
  b.add('lower(s.state) = lower(?)', q.state);
  b.add('lower(s.city) = lower(?)', q.city);
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(s.supplier_name) LIKE ${p} OR lower(s.supplier_code) LIKE ${p} ` +
      `OR lower(s.city) LIKE ${p} OR lower(s.state) LIKE ${p} ` +
      `OR lower(s.gst_no) LIKE ${p} OR lower(s.email) LIKE ${p} OR s.mobile_no LIKE ${p})`,
    );
  }
  return b;
}

/* ── GET /suppliers ─────────────────────────────────────────────────────────── */

router.get(
  '/',
  requirePermission('supplier.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildSupplierFilter(q);

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM suppliers s ${b.where()}`, b.params,
    );
    const total = Number(totalRow?.n ?? 0);

    const counts = await queryOne<{ active_count: string; inactive_count: string }>(
      `SELECT COUNT(CASE WHEN s.is_active = TRUE THEN 1 END) AS active_count,
              COUNT(CASE WHEN s.is_active = FALSE THEN 1 END) AS inactive_count
         FROM suppliers s ${b.where()}`,
      b.params,
    );

    const order = resolveSort(q, SORTABLE, 'supplierName');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    // Purchase summary is joined as an aggregate, not fetched per row (no N+1 — SRS §30).
    const rows = await query(
      `SELECT s.id, s.supplier_code, s.supplier_name, s.address, s.state, s.city, s.country,
              s.mobile_no, s.email, s.gst_no, s.payment_terms, s.currency_code,
              s.contact_person, s.pin_code, s.is_active, s.created_at, s.updated_at,
              COALESCE(p.po_count, 0)::int   AS po_count,
              COALESCE(p.total_value, 0)     AS total_purchase_value,
              p.last_po_date
         FROM suppliers s
         LEFT JOIN (
           SELECT b.supplier_id,
                  COUNT(DISTINCT b.po_id) AS po_count,
                  SUM(b.total_amount)     AS total_value,
                  MAX(b.po_date)          AS last_po_date
             FROM v_po_header_balance b
            WHERE b.status <> 'CANCELLED'
            GROUP BY b.supplier_id
         ) p ON p.supplier_id = s.id
         ${b.where()}
        ORDER BY ${order}
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, total, q.page, q.pageSize, {
      totals: {
        totalSuppliers: total,
        activeSuppliers: Number(counts?.active_count ?? 0),
        inactiveSuppliers: Number(counts?.inactive_count ?? 0),
      },
    });
  }),
);

/* ── GET /suppliers/search — typeahead for forms ────────────────────────────── */

router.get(
  '/search',
  requirePermission('supplier.view'),
  validateQuery(z.object({ q: z.string().trim().max(120).optional(), limit: z.coerce.number().int().min(1).max(50).default(20) })),
  asyncHandler(async (_req, res) => {
    const { q, limit } = parsedQuery<{ q?: string; limit: number }>(res);
    const term = `%${(q ?? '').toLowerCase()}%`;
    const rows = await query(
      `SELECT id, supplier_code, supplier_name, address, city, state, payment_terms, currency_code, gst_no, mobile_no, email
         FROM suppliers
        WHERE deleted_at IS NULL AND is_active = TRUE
          AND ($1 = '%%' OR lower(supplier_name) LIKE $1 OR lower(supplier_code) LIKE $1 OR lower(gst_no) LIKE $1)
        ORDER BY supplier_name
        LIMIT $2`,
      [term, limit],
    );
    sendOk(res, rows);
  }),
);

/* ── GET /suppliers/:id/profile — AUTO-POPULATION (SRS §2, §29) ─────────────── */

router.get(
  '/:id/profile',
  requirePermission('supplier.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const s = await queryOne<Record<string, unknown>>(
      `SELECT id, supplier_code, supplier_name, address, state, city, country,
              mobile_no, email, gst_no, payment_terms, currency_code, contact_person, pin_code, is_active
         FROM suppliers WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    );
    if (!s) throw NotFoundError('Supplier');

    // Everything a PO header needs from a supplier, in one round-trip.
    sendOk(res, {
      id: s.id,
      supplierCode: s.supplier_code,
      supplierName: s.supplier_name,
      address: s.address,
      state: s.state,
      city: s.city,
      country: s.country,
      mobileNo: s.mobile_no,
      email: s.email,
      gstNo: s.gst_no,
      paymentTerms: s.payment_terms,
      currencyCode: s.currency_code,
      contactPerson: s.contact_person,
      pinCode: s.pin_code,
      isActive: s.is_active,
    });
  }),
);

/* ── GET /suppliers/:id — full record with purchase history summary ─────────── */

router.get(
  '/:id',
  requirePermission('supplier.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const supplier = await queryOne('SELECT * FROM suppliers WHERE id = $1 AND deleted_at IS NULL', [id]);
    if (!supplier) throw NotFoundError('Supplier');

    const [summary] = await query<Record<string, unknown>>(
      `SELECT COUNT(DISTINCT po_id)::int             AS po_count,
              COALESCE(SUM(total_amount), 0)         AS total_value,
              COALESCE(SUM(received_amount), 0)      AS received_value,
              COALESCE(SUM(pending_amount), 0)       AS pending_value,
              MAX(po_date)                           AS last_po_date,
              MIN(po_date)                           AS first_po_date
         FROM v_po_header_balance
        WHERE supplier_id = $1 AND status <> 'CANCELLED'`,
      [id],
    );

    const recentPos = await query(
      `SELECT po_id, po_no, po_date, status, total_amount, received_amount, pending_amount
         FROM v_po_header_balance
        WHERE supplier_id = $1
        ORDER BY po_date DESC, po_id DESC
        LIMIT 10`,
      [id],
    );

    const topItems = await query(
      `SELECT item_id, item_code, item_description,
              SUM(po_qty) AS total_qty, SUM(amount) AS total_value
         FROM v_po_line_balance
        WHERE supplier_id = $1 AND po_status <> 'CANCELLED'
        GROUP BY item_id, item_code, item_description
        ORDER BY SUM(amount) DESC
        LIMIT 10`,
      [id],
    );

    sendOk(res, { ...supplier, summary, recentPurchaseOrders: recentPos, topItems });
  }),
);

/* ── Create / update ────────────────────────────────────────────────────────── */

const supplierSchema = z.object({
  supplierCode: z.string().trim().max(50).optional(),
  supplierName: z.string().trim().min(1, 'Supplier name is required.').max(200),
  address: z.string().trim().max(500).default(''),
  state: z.string().trim().max(100).default(''),
  city: z.string().trim().max(100).default(''),
  country: z.string().trim().max(100).default('India'),
  mobileNo: z.string().trim().max(30).default('')
    .refine((v) => v === '' || /^[+0-9][0-9\s\-()]{6,29}$/.test(v), 'Enter a valid contact number.'),
  email: z.string().trim().max(200).default('')
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.'),
  // 15-character Indian GSTIN. Optional, but validated when supplied (SRS §7.2).
  gstNo: z.string().trim().max(20).default('')
    .refine(
      (v) => v === '' || /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/i.test(v),
      'Enter a valid 15-character GSTIN (e.g. 27AAACP1234F1Z5).',
    ),
  paymentTerms: z.string().trim().max(100).default(''),
  currencyCode: z.string().trim().max(10).default('INR'),
  contactPerson: z.string().trim().max(150).default(''),
  pinCode: z.string().trim().max(12).default(''),
  notes: z.string().trim().max(1000).default(''),
  isActive: z.boolean().default(true),
});

async function generateSupplierCode(): Promise<string> {
  const row = await queryOne<{ max_num: string | null }>(
    `SELECT MAX(CAST(substring(supplier_code FROM 'SUP-([0-9]+)$') AS INTEGER)) AS max_num
       FROM suppliers WHERE supplier_code ~ '^SUP-[0-9]+$'`,
  );
  return `SUP-${String(Number(row?.max_num ?? 0) + 1).padStart(4, '0')}`;
}

router.post(
  '/',
  requirePermission('supplier.create'),
  validateBody(supplierSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof supplierSchema>;
    const code = body.supplierCode && body.supplierCode.length > 0
      ? body.supplierCode
      : await generateSupplierCode();

    const created = await withTransaction(async (tx) => {
      const row = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO suppliers
           (supplier_code, supplier_name, address, state, city, country, mobile_no, email,
            gst_no, payment_terms, currency_code, contact_person, pin_code, notes, is_active,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)
         RETURNING id`,
        [code, body.supplierName, body.address, body.state, body.city, body.country,
         body.mobileNo, body.email, body.gstNo.toUpperCase(), body.paymentTerms,
         body.currencyCode, body.contactPerson, body.pinCode, body.notes, body.isActive, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CREATE', entity: 'supplier', entityId: row?.id,
        entityLabel: body.supplierName, after: { ...body, supplierCode: code },
      });
      return row;
    });

    sendCreated(res, await queryOne('SELECT * FROM suppliers WHERE id = $1', [created?.id]));
  }),
);

router.put(
  '/:id',
  requirePermission('supplier.edit'),
  validateBody(supplierSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof supplierSchema>;

    const before = await queryOne<Record<string, unknown>>(
      'SELECT * FROM suppliers WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!before) throw NotFoundError('Supplier');

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE suppliers
            SET supplier_code = $2, supplier_name = $3, address = $4, state = $5, city = $6,
                country = $7, mobile_no = $8, email = $9, gst_no = $10, payment_terms = $11,
                currency_code = $12, contact_person = $13, pin_code = $14, notes = $15, is_active = $16,
                updated_at = now(), updated_by = $17
          WHERE id = $1`,
        [id, body.supplierCode || (before.supplier_code as string), body.supplierName, body.address,
         body.state, body.city, body.country, body.mobileNo, body.email, body.gstNo.toUpperCase(),
         body.paymentTerms, body.currencyCode, body.contactPerson, body.pinCode, body.notes, body.isActive, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'supplier', entityId: id,
        entityLabel: body.supplierName, before, after: body,
      });
    });

    sendOk(res, await queryOne('SELECT * FROM suppliers WHERE id = $1', [id]));
  }),
);

/* ── DELETE /suppliers/:id ──────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('supplier.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const before = await queryOne<{ supplier_name: string }>(
      'SELECT * FROM suppliers WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!before) throw NotFoundError('Supplier');

    const usage = await queryOne<{ po_count: string; indent_count: string; grn_count: string }>(
      `SELECT (SELECT COUNT(*) FROM purchase_order_headers WHERE supplier_id = $1) AS po_count,
              (SELECT COUNT(*) FROM purchase_indent_headers WHERE suggested_supplier_id = $1) AS indent_count,
              (SELECT COUNT(*) FROM grn_headers WHERE supplier_id = $1) AS grn_count`,
      [id],
    );
    const refs = Number(usage?.po_count ?? 0) + Number(usage?.indent_count ?? 0) + Number(usage?.grn_count ?? 0);

    const result = await withTransaction(async (tx) => {
      if (refs > 0) {
        await tx.query(
          'UPDATE suppliers SET is_active = FALSE, updated_at = now(), updated_by = $2 WHERE id = $1',
          [id, req.user!.id],
        );
        await auditIn(tx, {
          actor: actorFrom(req), action: 'UPDATE', entity: 'supplier', entityId: id,
          entityLabel: before.supplier_name, before,
          message: `Deactivated instead of deleted — ${refs} linked transaction(s)`,
        });
        return {
          deleted: false,
          message:
            `${before.supplier_name} has ${usage?.po_count} purchase order(s), ${usage?.grn_count} GRN(s) ` +
            `and ${usage?.indent_count} indent reference(s), so the record has been deactivated rather than ` +
            `deleted. Purchase history is preserved and the supplier no longer appears in dropdowns.`,
        };
      }
      await tx.query(
        'UPDATE suppliers SET deleted_at = now(), is_active = FALSE, updated_by = $2 WHERE id = $1',
        [id, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'supplier', entityId: id,
        entityLabel: before.supplier_name, before,
      });
      return { deleted: true, message: `${before.supplier_name} has been deleted.` };
    });

    sendOk(res, result);
  }),
);

export default router;
