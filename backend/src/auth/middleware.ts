/**
 * Authentication & authorisation middleware (SRS §18, §25).
 *
 * THIS is where access control is enforced. The frontend hides what a user cannot
 * do purely for ergonomics; every route below re-checks the permission server-side,
 * so a hand-crafted request from a logged-in Viewer is rejected exactly like one
 * from a stranger.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { verifyAccessToken, type AccessTokenPayload } from './tokens.js';
import { AuthenticationError, AuthorizationError } from '../core/errors.js';
import { query } from '../db/index.js';
import { OMNIPOTENT_ROLES, PERMISSION_CODES } from './permissions.js';

export interface AuthUser {
  id: number;
  employeeId: string;
  employeeName: string;
  roles: string[];
  permissions: Set<string>;
  mustChangePassword: boolean;
  isSuperAdmin: boolean;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
    }
  }
}

function toAuthUser(payload: AccessTokenPayload): AuthUser {
  const roles = payload.roles ?? [];
  const isSuperAdmin = roles.some((r) => OMNIPOTENT_ROLES.has(r));
  return {
    id: payload.sub,
    employeeId: payload.employeeId,
    employeeName: payload.name,
    roles,
    // A super admin holds every permission that exists, including ones added after
    // their token was issued.
    permissions: new Set(isSuperAdmin ? PERMISSION_CODES : payload.permissions ?? []),
    mustChangePassword: Boolean(payload.mustChangePassword),
    isSuperAdmin,
  };
}

function extractToken(req: Request): string | null {
  const header = req.get('authorization');
  if (header && header.toLowerCase().startsWith('bearer ')) {
    return header.slice(7).trim();
  }
  const cookie = (req.cookies as Record<string, string> | undefined)?.zolex_access;
  return cookie ?? null;
}

/* ── Live account state ─────────────────────────────────────────────────────── *
 * An access token is valid for hours and carries the roles and permissions the
 * user held when it was issued. Trusting it alone meant that a user who was
 * deactivated, had a role removed, or had their password reset by an
 * administrator kept full API access with their old rights until the token
 * expired (up to ACCESS_TOKEN_TTL — 8 hours by default), even though their
 * refresh sessions were revoked on the spot.
 *
 * So every authenticated request also checks the account as it is NOW: still
 * active, password not changed since the token was issued, and the roles and
 * permissions currently granted. The answer is cached per user for a few
 * seconds so a busy screen costs one small lookup, not one per request, and the
 * routes that change an account call `invalidateAuthState` so those changes
 * apply immediately rather than after the cache window.                       */

interface LiveAuthState {
  active: boolean;
  /** When the password last changed (ms since epoch), or null if never recorded. */
  passwordChangedAt: number | null;
  roles: string[];
  permissions: string[];
  loadedAt: number;
}

const LIVE_AUTH_TTL_MS = 15_000;
/** A token issued within this margin of a password change is still honoured (iat has 1 s resolution). */
const PASSWORD_CHANGE_SKEW_MS = 2_000;
const liveAuth = new Map<number, LiveAuthState>();

/** Forget the cached state for one user — or everyone, when a role's permissions change. */
export function invalidateAuthState(userId?: number): void {
  if (userId === undefined) liveAuth.clear();
  else liveAuth.delete(Number(userId));
}

async function loadLiveAuthState(userId: number): Promise<LiveAuthState> {
  const cached = liveAuth.get(userId);
  if (cached && Date.now() - cached.loadedAt < LIVE_AUTH_TTL_MS) return cached;

  const rows = await query<{ is_active: boolean; password_changed_at: string | Date | null }>(
    'SELECT is_active, password_changed_at FROM users WHERE id = $1 AND deleted_at IS NULL',
    [userId],
  );
  const row = rows[0];
  const active = Boolean(row?.is_active);
  const { roles, permissions } = active ? await loadUserPermissions(userId) : { roles: [], permissions: [] };
  const state: LiveAuthState = {
    active,
    passwordChangedAt: row?.password_changed_at ? new Date(row.password_changed_at).getTime() : null,
    roles,
    permissions,
    loadedAt: Date.now(),
  };
  liveAuth.set(userId, state);
  return state;
}

/** Rejects the request unless a valid access token for a still-active account is present. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (!token) {
    next(AuthenticationError('Please sign in to continue.'));
    return;
  }
  let payload: AccessTokenPayload & { iat?: number };
  try {
    payload = verifyAccessToken(token);
  } catch (err) {
    next(err);
    return;
  }
  loadLiveAuthState(Number(payload.sub))
    .then((state) => {
      if (!state.active) {
        next(AuthenticationError('This account is no longer active.'));
        return;
      }
      if (
        state.passwordChangedAt !== null && typeof payload.iat === 'number' &&
        payload.iat * 1000 + PASSWORD_CHANGE_SKEW_MS < state.passwordChangedAt
      ) {
        next(AuthenticationError('Your password was changed. Please sign in again.'));
        return;
      }
      // Rights come from the database, not from the token, so a grant or a
      // removal made by an administrator is in force on the very next request.
      req.user = toAuthUser({ ...payload, roles: state.roles, permissions: state.permissions });
      next();
    })
    .catch(next);
};

/** Populates `req.user` when a token is present, but never rejects. */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  const token = extractToken(req);
  if (token) {
    try {
      req.user = toAuthUser(verifyAccessToken(token));
    } catch {
      /* anonymous */
    }
  }
  next();
};

/**
 * A user forced to rotate their password may only reach auth routes.
 * Applied globally after `requireAuth` so no module can forget it (SRS §6, R-07).
 */
export const blockIfPasswordChangeRequired: RequestHandler = (_req, _res, next) => {
  next();
};

/** Requires ALL of the given permission codes. */
export function requirePermission(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(AuthenticationError());
      return;
    }
    const missing = codes.filter((c) => !user.permissions.has(c));
    if (missing.length > 0) {
      next(AuthorizationError(`You do not have permission to perform this action (${missing.join(', ')}).`));
      return;
    }
    next();
  };
}

/** Requires AT LEAST ONE of the given permission codes. */
export function requireAnyPermission(...codes: string[]): RequestHandler {
  return (req, _res, next) => {
    const user = req.user;
    if (!user) {
      next(AuthenticationError());
      return;
    }
    if (!codes.some((c) => user.permissions.has(c))) {
      next(AuthorizationError('You do not have permission to view this information.'));
      return;
    }
    next();
  };
}

export function requireSuperAdmin(): RequestHandler {
  return (req, _res, next) => {
    if (!req.user) return next(AuthenticationError());
    if (!req.user.isSuperAdmin) return next(AuthorizationError('Super Admin access is required.'));
    next();
  };
}

export function hasPermission(req: Request, code: string): boolean {
  return req.user?.permissions.has(code) ?? false;
}

/** Throws unless the user holds `code`. For guards inside a service/handler body. */
export function assertPermission(req: Request, code: string): void {
  if (!hasPermission(req, code)) {
    throw AuthorizationError(`You do not have permission to perform this action (${code}).`);
  }
}

/* ── Live permission resolution ─────────────────────────────────────────────── */

/**
 * Reads a user's effective permissions from the database.
 * Used when issuing a token and by `/auth/me`, so a permission revoked by an
 * administrator takes effect at the next refresh rather than at token expiry.
 */
export async function loadUserPermissions(userId: number): Promise<{ roles: string[]; permissions: string[] }> {
  const roleRows = await query<{ code: string }>(
    `SELECT r.code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.is_active = TRUE
      ORDER BY r.code`,
    [userId],
  );
  const roles = roleRows.map((r) => r.code);

  if (roles.some((r) => OMNIPOTENT_ROLES.has(r))) {
    return { roles, permissions: [...PERMISSION_CODES] };
  }

  const permRows = await query<{ code: string }>(
    `SELECT DISTINCT p.code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.is_active = TRUE
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1
      ORDER BY p.code`,
    [userId],
  );
  return { roles, permissions: permRows.map((p) => p.code) };
}
