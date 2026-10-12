/**
 * Role & Permission Management (SRS §17, §18).
 *
 * The permission catalogue itself is code (`auth/permissions.ts`) and is reconciled
 * into the database by the seeder; roles are data and are edited here.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne } from '../../db/index.js';
import { asyncHandler, sendOk, sendCreated, validateBody, idParam } from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError } from '../../core/errors.js';
import { requirePermission, invalidateAuthState } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { MODULE_LABELS, OMNIPOTENT_ROLES } from '../../auth/permissions.js';

const router = Router();

/* ── GET /roles/permissions — the full catalogue, grouped by module ─────────── */

router.get(
  '/permissions',
  requirePermission('role.view'),
  asyncHandler(async (_req, res) => {
    const rows = await query<{
      id: number; code: string; module: string; action: string; label: string; description: string;
    }>('SELECT id, code, module, action, label, description FROM permissions ORDER BY sort_order, code');

    const modules = new Map<string, { module: string; label: string; permissions: typeof rows }>();
    for (const p of rows) {
      if (!modules.has(p.module)) {
        modules.set(p.module, {
          module: p.module,
          label: MODULE_LABELS[p.module] ?? p.module,
          permissions: [],
        });
      }
      modules.get(p.module)!.permissions.push(p);
    }
    sendOk(res, [...modules.values()]);
  }),
);

/* ── GET /roles ─────────────────────────────────────────────────────────────── */

router.get(
  '/',
  requirePermission('role.view'),
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT r.id, r.code, r.name, r.description, r.is_system, r.is_active,
              r.created_at, r.updated_at,
              (SELECT COUNT(*)::int FROM user_roles ur WHERE ur.role_id = r.id) AS user_count,
              (SELECT COUNT(*)::int FROM role_permissions rp WHERE rp.role_id = r.id) AS permission_count
         FROM roles r
        ORDER BY r.is_system DESC, r.name`,
    );
    sendOk(res, rows);
  }),
);

router.get(
  '/:id',
  requirePermission('role.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const role = await queryOne('SELECT * FROM roles WHERE id = $1', [id]);
    if (!role) throw NotFoundError('Role');

    const permissions = await query<{ id: number; code: string; module: string; action: string; label: string }>(
      `SELECT p.id, p.code, p.module, p.action, p.label
         FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
        WHERE rp.role_id = $1 ORDER BY p.sort_order`,
      [id],
    );
    const users = await query(
      `SELECT u.id, u.employee_id, u.employee_name, u.designation, u.is_active
         FROM user_roles ur JOIN users u ON u.id = ur.user_id
        WHERE ur.role_id = $1 AND u.deleted_at IS NULL
        ORDER BY u.employee_name`,
      [id],
    );
    sendOk(res, { ...role, permissions, permissionCodes: permissions.map((p) => p.code), users });
  }),
);

/* ── Create / update ────────────────────────────────────────────────────────── */

const roleSchema = z.object({
  code: z.string().trim().min(1, 'Role code is required.').max(50)
    .regex(/^[A-Z][A-Z0-9_]*$/, 'Use uppercase letters, digits and underscores (e.g. SITE_ENGINEER).'),
  name: z.string().trim().min(1, 'Role name is required.').max(100),
  description: z.string().trim().max(500).default(''),
  isActive: z.boolean().default(true),
  permissionIds: z.array(z.coerce.number().int().positive()).default([]),
});

router.post(
  '/',
  requirePermission('role.create'),
  validateBody(roleSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof roleSchema>;
    if (OMNIPOTENT_ROLES.has(body.code)) {
      throw BusinessRuleError(`${body.code} is a reserved system role code.`);
    }

    const id = await withTransaction(async (tx) => {
      const created = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO roles (code, name, description, is_system, is_active, created_by, updated_by)
         VALUES ($1,$2,$3,FALSE,$4,$5,$5) RETURNING id`,
        [body.code, body.name, body.description, body.isActive, req.user!.id],
      );
      if (!created) throw new Error('Failed to create role.');

      if (body.permissionIds.length > 0) {
        await tx.query(
          'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE id = ANY($2)',
          [created.id, body.permissionIds],
        );
      }
      await auditIn(tx, {
        actor: actorFrom(req), action: 'CREATE', entity: 'role', entityId: created.id,
        entityLabel: body.name, after: { ...body, permissionCount: body.permissionIds.length },
      });
      return created.id;
    });

    sendCreated(res, await queryOne('SELECT * FROM roles WHERE id = $1', [id]));
  }),
);

router.put(
  '/:id',
  requirePermission('role.edit'),
  validateBody(roleSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof roleSchema>;

    const before = await queryOne<{ code: string; name: string; is_system: boolean }>(
      'SELECT * FROM roles WHERE id = $1', [id],
    );
    if (!before) throw NotFoundError('Role');

    // SUPER_ADMIN always holds every permission; letting it be edited would risk
    // creating a system nobody can administer.
    if (OMNIPOTENT_ROLES.has(before.code)) {
      throw BusinessRuleError(
        `The ${before.name} role always holds every permission and cannot be modified.`,
      );
    }

    await withTransaction(async (tx) => {
      const permIds = await txQuery<{ id: number }>(
        tx, 'SELECT id FROM permissions WHERE id = ANY($1)', [body.permissionIds],
      );
      if (permIds.length !== body.permissionIds.length) {
        throw ValidationError('One or more selected permissions do not exist.');
      }

      await tx.query(
        `UPDATE roles
            SET code = $2, name = $3, description = $4, is_active = $5,
                updated_at = now(), updated_by = $6
          WHERE id = $1`,
        // A system role keeps its code so seeding continues to match it.
        [id, before.is_system ? before.code : body.code, body.name, body.description,
         body.isActive, req.user!.id],
      );

      await tx.query('DELETE FROM role_permissions WHERE role_id = $1', [id]);
      if (body.permissionIds.length > 0) {
        await tx.query(
          'INSERT INTO role_permissions (role_id, permission_id) SELECT $1, id FROM permissions WHERE id = ANY($2)',
          [id, body.permissionIds],
        );
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: 'PERMISSION_CHANGE', entity: 'role', entityId: id,
        entityLabel: body.name, before,
        after: { ...body, permissionCount: body.permissionIds.length },
      });
    });
    // Everyone holding this role must get its new rights on their next request.
    invalidateAuthState();

    sendOk(res, await queryOne('SELECT * FROM roles WHERE id = $1', [id]));
  }),
);

router.delete(
  '/:id',
  requirePermission('role.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const role = await queryOne<{ code: string; name: string; is_system: boolean }>(
      'SELECT * FROM roles WHERE id = $1', [id],
    );
    if (!role) throw NotFoundError('Role');
    if (role.is_system) throw BusinessRuleError(`${role.name} is a system role and cannot be deleted.`);

    const users = await queryOne<{ n: string }>(
      'SELECT COUNT(*) AS n FROM user_roles WHERE role_id = $1', [id],
    );
    if (Number(users?.n ?? 0) > 0) {
      throw BusinessRuleError(
        `${role.name} is assigned to ${users?.n} user(s). Reassign them before deleting this role.`,
      );
    }

    await withTransaction(async (tx) => {
      await auditIn(tx, {
        actor: actorFrom(req), action: 'DELETE', entity: 'role', entityId: id,
        entityLabel: role.name, before: role,
      });
      await tx.query('DELETE FROM roles WHERE id = $1', [id]);
    });

    sendOk(res, { deleted: true, message: `Role ${role.name} has been deleted.` });
  }),
);

export default router;
