/**
 * Super Admin accounts (AUTH-10).
 *
 * Every route that changes a user account applies two rules:
 *
 *  · Only a Super Admin may change a Super Admin account — reset its password,
 *    edit it or its roles, unlock, (de)activate, delete or restore it. A user
 *    administrator who is not one could otherwise take over the most powerful
 *    account in the system simply by resetting its password; the reset and
 *    deactivate routes did not look at the target at all.
 *
 *  · The system always keeps one active Super Admin: nothing may deactivate,
 *    delete or strip the role from the last one, or nobody could administer it.
 *
 * Both take an optional transaction so a route can check inside the same
 * transaction that makes the change.
 */
import type { Request } from 'express';
import { query, txQuery, type Queryable } from '../../db/index.js';
import { AuthorizationError, BusinessRuleError } from '../../core/errors.js';

function rows<T>(tx: Queryable | undefined, sql: string, params: unknown[]): Promise<T[]> {
  return tx ? txQuery<T>(tx, sql, params) : query<T>(sql, params);
}

/** The accounts among `userIds` that hold the Super Admin role. */
export async function superAdminsAmong(tx: Queryable | undefined, userIds: number[]): Promise<number[]> {
  if (userIds.length === 0) return [];
  const supers = await rows<{ user_id: number }>(
    tx,
    `SELECT DISTINCT ur.user_id FROM user_roles ur JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'SUPER_ADMIN' AND ur.user_id = ANY($1::bigint[])`,
    [userIds.map(Number)],
  );
  return supers.map((s) => Number(s.user_id));
}

/** Refuses unless the actor is a Super Admin, when any of `userIds` holds the Super Admin role. */
export async function assertMayChangeUsers(tx: Queryable | undefined, req: Request, userIds: number[]): Promise<void> {
  if (req.user?.isSuperAdmin || userIds.length === 0) return;
  const supers = await superAdminsAmong(tx, userIds);
  if (supers.length > 0) {
    throw AuthorizationError(
      'Only a Super Admin can reset the password of, change, deactivate or delete a Super Admin account.',
    );
  }
}

/**
 * Refuses when deactivating, deleting or demoting `userIds` would leave no
 * active Super Admin. Accounts that are not active Super Admins are ignored.
 */
export async function assertActiveSuperAdminRemains(
  tx: Queryable | undefined,
  userIds: number[],
  message = 'This is the last active Super Admin. Grant Super Admin to another user before changing this account.',
): Promise<void> {
  const active = await rows<{ affected: boolean }>(
    tx,
    `SELECT DISTINCT u.id, u.id = ANY($1::bigint[]) AS affected
       FROM users u
       JOIN user_roles ur ON ur.user_id = u.id
       JOIN roles r ON r.id = ur.role_id
      WHERE r.code = 'SUPER_ADMIN' AND u.is_active AND u.deleted_at IS NULL`,
    [userIds.map(Number)],
  );
  if (active.some((a) => a.affected) && !active.some((a) => !a.affected)) {
    throw BusinessRuleError(message);
  }
}
