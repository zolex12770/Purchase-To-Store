/**
 * Audit log viewer (SRS §17, §24).
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendPage, validateQuery, parsedQuery,
  listQuerySchema, offsetOf, idParam, csvArray, csvIdArray,
} from '../../core/http.js';
import { NotFoundError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';

const router = Router();

/** The list's query; its Export accepts exactly the same (io/datasets.ts). */
export const listSchema = listQuerySchema.extend({
  action: csvArray,
  entity: csvArray,
  entityId: z.string().trim().max(60).optional(),
  actorUserId: csvIdArray,
  userId: csvIdArray,
  source: csvArray,
  result: csvArray,
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
});

export function buildFilter(q: z.infer<typeof listSchema>): SqlBuilder {
  const b = new SqlBuilder();
  b.addIn('a.action', q.action);
  b.addIn('a.entity', q.entity);
  b.addIn('a.source', q.source);
  b.addIn('a.result', q.result);
  const actorIds = q.actorUserId ?? q.userId;
  b.addIn('a.actor_user_id', actorIds);
  b.add('a.entity_id = ?', q.entityId);
  b.add('a.created_at >= ?', q.dateFrom);
  // Inclusive end-of-day so a same-day range returns that day's records.
  if (q.dateTo) b.add("a.created_at < (?::date + interval '1 day')", q.dateTo);
  if (q.search) {
    const p = b.push(`%${q.search.toLowerCase()}%`);
    b.addRaw(
      `(lower(COALESCE(a.entity_label,'')) LIKE ${p} OR lower(COALESCE(a.message,'')) LIKE ${p} ` +
      `OR lower(COALESCE(a.actor_name,'')) LIKE ${p} OR lower(COALESCE(a.actor_employee_id,'')) LIKE ${p} ` +
      `OR lower(a.entity) LIKE ${p} OR lower(a.action) LIKE ${p})`,
    );
  }
  return b;
}

router.get(
  '/',
  requirePermission('audit.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);
    const b = buildFilter(q);

    const totalRow = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM audit_logs a ${b.where()}`, b.params,
    );

    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    // before_data/after_data are omitted from the list (they can be large) and
    // fetched on demand from the detail endpoint.
    const rows = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.entity_label, a.source, a.result,
              a.message, a.ip_address, a.created_at, a.request_id,
              a.actor_user_id, a.actor_employee_id, a.actor_name,
              (a.before_data IS NOT NULL OR a.after_data IS NOT NULL) AS has_detail
         FROM audit_logs a
         ${b.where()}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${limit} OFFSET ${offset}`,
      b.params,
    );

    sendPage(res, rows, Number(totalRow?.n ?? 0), q.page, q.pageSize);
  }),
);

/* ── GET /audit/facets — filter options with live counts ────────────────────── */

router.get(
  '/facets',
  requirePermission('audit.view'),
  asyncHandler(async (_req, res) => {
    const actions = await query('SELECT action AS value, COUNT(*)::int AS count FROM audit_logs GROUP BY action ORDER BY COUNT(*) DESC');
    const entities = await query('SELECT entity AS value, COUNT(*)::int AS count FROM audit_logs GROUP BY entity ORDER BY COUNT(*) DESC');
    const sources = await query('SELECT source AS value, COUNT(*)::int AS count FROM audit_logs GROUP BY source ORDER BY COUNT(*) DESC');
    const actors = await query(
      `SELECT a.actor_user_id AS value, COALESCE(a.actor_name, a.actor_employee_id, 'System') AS label,
              COUNT(*)::int AS count
         FROM audit_logs a
        GROUP BY a.actor_user_id, COALESCE(a.actor_name, a.actor_employee_id, 'System')
        ORDER BY COUNT(*) DESC LIMIT 50`,
    );
    sendOk(res, { actions, entities, sources, actors });
  }),
);

/* ── GET /audit/entity/:entity/:entityId — one record's full history ────────── */

router.get(
  '/entity/:entity/:entityId',
  requirePermission('audit.view'),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.entity_label, a.source, a.result,
              a.message, a.created_at, a.actor_name, a.actor_employee_id,
              a.before_data, a.after_data
         FROM audit_logs a
        WHERE a.entity = $1 AND a.entity_id = $2
        ORDER BY a.created_at ASC, a.id ASC`,
      [req.params.entity, req.params.entityId],
    );
    sendOk(res, rows);
  }),
);

router.get(
  '/:id',
  requirePermission('audit.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const row = await queryOne('SELECT * FROM audit_logs WHERE id = $1', [id]);
    if (!row) throw NotFoundError('Audit record');
    sendOk(res, row);
  }),
);

export default router;
