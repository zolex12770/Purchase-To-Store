/**
 * User Management (SRS §17).
 *
 * Users are the User Master (Employee ID / Employee Name / Designation, SRS §7.3)
 * plus authentication and role assignment.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, txQuery, txQueryOne, SqlBuilder } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, sendPage, validateBody, validateQuery,
  parsedQuery, listQuerySchema, resolveSort, offsetOf, idParam, csvIdArray,
} from '../../core/http.js';
import { NotFoundError, BusinessRuleError, ValidationError, ConflictError } from '../../core/errors.js';
import { requirePermission, invalidateAuthState } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { hashPassword, checkPasswordStrength } from '../../auth/tokens.js';
import { assertMayChangeUsers, assertActiveSuperAdminRemains } from './super-admin-guard.js';

const router = Router();

const SORTABLE: Record<string, string> = {
  employeeId: 'u.employee_id',
  employeeName: 'u.employee_name',
  designation: 'u.designation',
  lastLoginAt: 'u.last_login_at',
  createdAt: 'u.created_at',
};

const listSchema = listQuerySchema.extend({
  isActive: z.enum(['true', 'false']).optional(),
  roleId: csvIdArray,
  departmentId: csvIdArray,
});

const USER_SELECT = `
  SELECT u.id, u.employee_id, u.employee_name, u.designation, u.email, u.mobile_no,
         u.is_active, u.must_change_password, u.last_login_at, u.locked_until,
         u.created_at, u.updated_at, u.department_id, d.name AS department_name,
         COALESCE(
           (SELECT json_agg(json_build_object('id', r.id, 'code', r.code, 'name', r.name) ORDER BY r.name)
              FROM user_roles ur JOIN roles r ON r.id = ur.role_id
             WHERE ur.user_id = u.id),
           '[]'::json
         ) AS roles
    FROM users u
    LEFT JOIN lookups d ON d.id = u.department_id`;

router.get(
  '/',
  requirePermission('user.view'),
  validateQuery(listSchema),
  asyncHandler(async (_req, res) => {
    const q = parsedQuery<z.infer<typeof listSchema>>(res);

    const b = new SqlBuilder();
    b.addRaw('u.deleted_at IS NULL');
    if (q.isActive) b.addRaw(`u.is_active = ${q.isActive === 'true' ? 'TRUE' : 'FALSE'}`);
    b.addIn('u.department_id', q.departmentId);
    if (q.roleId?.length) {
      const p = b.push(q.roleId);
      b.addRaw(`EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_id = u.id AND ur.role_id = ANY(${p}))`);
    }
    if (q.search) {
      const p = b.push(`%${q.search.toLowerCase()}%`);
      b.addRaw(`(lower(u.employee_name) LIKE ${p} OR lower(u.employee_id) LIKE ${p} OR lower(u.designation) LIKE ${p} OR lower(COALESCE(u.email,'')) LIKE ${p})`);
    }

    const totalRow = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM users u ${b.where()}`, b.params);

    const counts = await queryOne<{ active_count: string; inactive_count: string }>(
      `SELECT COUNT(CASE WHEN u.is_active = TRUE THEN 1 END) AS active_count,
              COUNT(CASE WHEN u.is_active = FALSE THEN 1 END) AS inactive_count
         FROM users u ${b.where()}`,
      b.params,
    );

    const order = resolveSort(q, SORTABLE, 'employeeName');
    const limit = b.push(q.pageSize);
    const offset = b.push(offsetOf(q));

    const rows = await query(`${USER_SELECT} ${b.where()} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`, b.params);
    sendPage(res, rows, Number(totalRow?.n ?? 0), q.page, q.pageSize, {
      totals: {
        totalUsers: Number(totalRow?.n ?? 0),
        activeUsers: Number(counts?.active_count ?? 0),
        inactiveUsers: Number(counts?.inactive_count ?? 0),
      },
    });
  }),
);

router.get(
  '/:id',
  requirePermission('user.view'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const user = await queryOne(`${USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [id]);
    if (!user) throw NotFoundError('User');

    const activity = await query(
      `SELECT action, entity, entity_label, created_at, result
         FROM audit_logs WHERE actor_user_id = $1
        ORDER BY created_at DESC LIMIT 20`,
      [id],
    );
    const sessions = await query(
      `SELECT id, issued_at, expires_at, ip_address, user_agent
         FROM user_sessions
        WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now()
        ORDER BY issued_at DESC`,
      [id],
    );
    sendOk(res, { ...user, recentActivity: activity, activeSessions: sessions });
  }),
);

/* ── Create ─────────────────────────────────────────────────────────────────── */

const createSchema = z.object({
  employeeId: z.string().trim().min(1, 'Employee ID is required.').max(50),
  employeeName: z.string().trim().min(1, 'Employee name is required.').max(150),
  designation: z.string().trim().max(150).default(''),
  email: z.string().trim().max(200).default('')
    .refine((v) => v === '' || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), 'Enter a valid email address.'),
  mobileNo: z.string().trim().max(30).default(''),
  departmentId: z.coerce.number().int().positive().nullable().optional(),
  password: z.string().min(1, 'A password is required.').max(128),
  // An administrator knows the password they typed, so by default the user must
  // replace it at first sign-in; the administrator may opt out explicitly.
  mustChangePassword: z.boolean().default(true),
  isActive: z.boolean().default(true),
  roleIds: z.array(z.coerce.number().int().positive()).min(1, 'Assign at least one role.'),
});

router.post(
  '/',
  requirePermission('user.create'),
  validateBody(createSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof createSchema>;

    const strength = checkPasswordStrength(body.password, { employeeId: body.employeeId });
    if (!strength.ok) {
      throw ValidationError('Choose a stronger password.', [
        { field: 'password', message: `Password must ${strength.problems.join(', ')}.` },
      ]);
    }

    const id = await withTransaction(async (tx) => {
      const roles = await txQuery<{ id: number; code: string }>(
        tx, 'SELECT id, code FROM roles WHERE id = ANY($1)', [body.roleIds],
      );
      if (roles.length !== body.roleIds.length) {
        throw ValidationError('One or more selected roles do not exist.', [{ field: 'roleIds', message: 'Invalid role.' }]);
      }
      // Only a Super Admin may mint another Super Admin.
      if (roles.some((r) => r.code === 'SUPER_ADMIN') && !req.user!.isSuperAdmin) {
        throw BusinessRuleError('Only a Super Admin can grant the Super Admin role.');
      }

      const created = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO users (employee_id, employee_name, designation, email, mobile_no,
                            department_id, password_hash, is_active, must_change_password,
                            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)
         RETURNING id`,
        [body.employeeId, body.employeeName, body.designation, body.email || null,
         body.mobileNo, body.departmentId ?? null, await hashPassword(body.password),
         body.isActive, body.mustChangePassword, req.user!.id],
      );
      if (!created) throw new Error('Failed to create user.');

      for (const roleId of body.roleIds) {
        await tx.query(
          'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING',
          [created.id, roleId, req.user!.id],
        );
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: 'CREATE', entity: 'user', entityId: created.id,
        entityLabel: `${body.employeeId} — ${body.employeeName}`,
        after: { ...body, password: undefined, roles: roles.map((r) => r.code) },
      });
      return created.id;
    });

    sendCreated(res, await queryOne(`${USER_SELECT} WHERE u.id = $1`, [id]));
  }),
);

/* ── Update ─────────────────────────────────────────────────────────────────── */

const updateSchema = createSchema.omit({ password: true, mustChangePassword: true }).extend({
  roleIds: z.array(z.coerce.number().int().positive()).min(1, 'Assign at least one role.'),
});

router.put(
  '/:id',
  requirePermission('user.edit'),
  validateBody(updateSchema),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const body = req.body as z.infer<typeof updateSchema>;

    const before = await queryOne<Record<string, unknown>>(
      `${USER_SELECT} WHERE u.id = $1 AND u.deleted_at IS NULL`, [id],
    );
    if (!before) throw NotFoundError('User');

    await withTransaction(async (tx) => {
      // A Super Admin's account — its roles above all — is changed only by a Super Admin.
      await assertMayChangeUsers(tx, req, [id]);

      const roles = await txQuery<{ id: number; code: string }>(
        tx, 'SELECT id, code FROM roles WHERE id = ANY($1)', [body.roleIds],
      );
      if (roles.length !== body.roleIds.length) {
        throw ValidationError('One or more selected roles do not exist.', [{ field: 'roleIds', message: 'Invalid role.' }]);
      }
      if (roles.some((r) => r.code === 'SUPER_ADMIN') && !req.user!.isSuperAdmin) {
        throw BusinessRuleError('Only a Super Admin can grant the Super Admin role.');
      }

      // Do not let an administrator lock themselves out of their own account.
      if (id === req.user!.id && !body.isActive) {
        throw BusinessRuleError('You cannot deactivate your own account.');
      }
      if (id === req.user!.id && req.user!.isSuperAdmin && !roles.some((r) => r.code === 'SUPER_ADMIN')) {
        throw BusinessRuleError('You cannot remove your own Super Admin role.');
      }

      // The system must always retain at least one active Super Admin.
      const wasSuper = Array.isArray(before.roles) &&
        (before.roles as { code: string }[]).some((r) => r.code === 'SUPER_ADMIN');
      const staysSuper = roles.some((r) => r.code === 'SUPER_ADMIN');
      if (wasSuper && (!staysSuper || !body.isActive)) {
        await assertActiveSuperAdminRemains(tx, [id]);
      }

      await tx.query(
        `UPDATE users
            SET employee_id = $2, employee_name = $3, designation = $4, email = $5,
                mobile_no = $6, department_id = $7, is_active = $8,
                updated_at = now(), updated_by = $9
          WHERE id = $1`,
        [id, body.employeeId, body.employeeName, body.designation, body.email || null,
         body.mobileNo, body.departmentId ?? null, body.isActive, req.user!.id],
      );

      await tx.query('DELETE FROM user_roles WHERE user_id = $1', [id]);
      for (const roleId of body.roleIds) {
        await tx.query(
          'INSERT INTO user_roles (user_id, role_id, assigned_by) VALUES ($1,$2,$3)',
          [id, roleId, req.user!.id],
        );
      }

      // Deactivating a user must evict their live sessions immediately.
      if (!body.isActive) {
        await tx.query(
          'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [id],
        );
      }

      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'user', entityId: id,
        entityLabel: `${body.employeeId} — ${body.employeeName}`,
        before, after: { ...body, roles: roles.map((r) => r.code) },
      });
    });
    // Role, status and department changes apply to the user's very next request.
    invalidateAuthState(id);

    sendOk(res, await queryOne(`${USER_SELECT} WHERE u.id = $1`, [id]));
  }),
);

/* ── Reset password ─────────────────────────────────────────────────────────── */

router.post(
  '/:id/reset-password',
  requirePermission('user.edit'),
  validateBody(z.object({
    newPassword: z.string().min(1, 'A new password is required.').max(128),
    // The administrator now knows this password, so by default the user must
    // replace it at their next sign-in. This defaulted to false, and the Users
    // screen always sent false, so reset passwords (often the screen's own
    // placeholder example) stayed in use indefinitely.
    mustChangePassword: z.boolean().default(true),
  })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { newPassword, mustChangePassword } = req.body as { newPassword: string; mustChangePassword: boolean };

    const user = await queryOne<{ employee_id: string; employee_name: string }>(
      'SELECT employee_id, employee_name FROM users WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!user) throw NotFoundError('User');
    await assertMayChangeUsers(undefined, req, [id]);

    const strength = checkPasswordStrength(newPassword, { employeeId: user.employee_id });
    if (!strength.ok) {
      throw ValidationError('Choose a stronger password.', [
        { field: 'newPassword', message: `Password must ${strength.problems.join(', ')}.` },
      ]);
    }

    await withTransaction(async (tx) => {
      await tx.query(
        `UPDATE users
            SET password_hash = $2, must_change_password = $3, failed_login_count = 0,
                locked_until = NULL, password_changed_at = now(), updated_at = now(), updated_by = $4
          WHERE id = $1`,
        [id, await hashPassword(newPassword), mustChangePassword, req.user!.id],
      );
      await tx.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'PASSWORD_RESET', entity: 'user', entityId: id,
        entityLabel: user.employee_id,
        message: 'Password reset by administrator; all sessions revoked',
      });
    });
    invalidateAuthState(id);

    sendOk(res, {
      message: `Password reset for ${user.employee_name}. Their active sessions have been signed out.`,
    });
  }),
);

/* ── Unlock ─────────────────────────────────────────────────────────────────── */

router.post(
  '/:id/unlock',
  requirePermission('user.edit'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const user = await queryOne<{ employee_name: string; employee_id: string }>(
      'SELECT employee_name, employee_id FROM users WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!user) throw NotFoundError('User');
    // Lifting a lockout re-opens password guessing against the account.
    await assertMayChangeUsers(undefined, req, [id]);

    await withTransaction(async (tx) => {
      await tx.query(
        'UPDATE users SET locked_until = NULL, failed_login_count = 0, updated_at = now(), updated_by = $2 WHERE id = $1',
        [id, req.user!.id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'user', entityId: id,
        entityLabel: user.employee_id, message: 'Account unlocked by administrator',
      });
    });

    sendOk(res, { message: `${user.employee_name} can sign in again.` });
  }),
);

/* ── Deactivate ─────────────────────────────────────────────────────────────── */

router.delete(
  '/:id',
  requirePermission('user.delete'),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    if (id === req.user!.id) throw BusinessRuleError('You cannot deactivate your own account.');

    const user = await queryOne<{ employee_id: string; employee_name: string }>(
      'SELECT employee_id, employee_name FROM users WHERE id = $1 AND deleted_at IS NULL', [id],
    );
    if (!user) throw NotFoundError('User');

    await assertMayChangeUsers(undefined, req, [id]);
    await assertActiveSuperAdminRemains(undefined, [id], 'This is the last active Super Admin and cannot be deactivated.');

    // Users are never hard-deleted: they author indents, approvals and audit records
    // that must keep pointing at a real identity (SRS §20, §24).
    await withTransaction(async (tx) => {
      await tx.query(
        'UPDATE users SET is_active = FALSE, updated_at = now(), updated_by = $2 WHERE id = $1',
        [id, req.user!.id],
      );
      await tx.query(
        'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id],
      );
      await auditIn(tx, {
        actor: actorFrom(req), action: 'UPDATE', entity: 'user', entityId: id,
        entityLabel: user.employee_id, message: 'User deactivated',
      });
    });
    invalidateAuthState(id);

    sendOk(res, {
      deleted: false,
      message:
        `${user.employee_name} has been deactivated and signed out. The account is retained so their ` +
        `indents, approvals and audit history remain attributable.`,
    });
  }),
);

export default router;
