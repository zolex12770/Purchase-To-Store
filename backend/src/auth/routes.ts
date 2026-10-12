/**
 * Authentication routes (SRS §6, §25; ADR-013).
 *
 *   POST /auth/login            employee ID + password → access token + refresh cookie
 *   POST /auth/refresh          rotate the refresh token
 *   POST /auth/logout           revoke the current session
 *   GET  /auth/me               current identity, roles and effective permissions
 *   POST /auth/change-password  rotate own password (also clears must_change_password)
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { query, queryOne, execute } from '../db/index.js';
import { asyncHandler, sendOk, validateBody } from '../core/http.js';
import { AuthenticationError, ValidationError, BusinessRuleError } from '../core/errors.js';
import { audit, actorFrom } from '../core/audit.js';
import { env } from '../config/env.js';
import { requireAuth, loadUserPermissions, invalidateAuthState } from './middleware.js';
import {
  signAccessToken, generateRefreshToken, hashRefreshToken, refreshTokenExpiry,
  hashPassword, verifyPassword, checkPasswordStrength,
} from './tokens.js';

const router = Router();

const REFRESH_COOKIE = 'zolex_refresh';

/**
 * Attributes that identify the refresh cookie.
 *
 * A browser only replaces or removes a cookie when name, path, domain and
 * security attributes all match, so setting and clearing must share exactly
 * these — hence one definition rather than two that could drift apart.
 */
/**
 * `Secure` exactly when the site is served over HTTPS.
 *
 * This used to be `env.isProd`. But this ERP is deployed on the plant LAN over
 * plain HTTP (`FRONTEND_URL=http://172.16.18.22:8080`), and a browser silently
 * DISCARDS a `Secure` cookie that arrives over HTTP from anything other than
 * localhost. So in production the refresh cookie was never stored at all:
 * every page refresh, new tab or bookmark dropped the user back on the sign-in
 * screen, and a session could not be renewed. (It looked fine when tested on
 * the server itself, because browsers exempt http://localhost.)
 *
 * Tying the flag to the scheme keeps it ON for any HTTPS deployment and stops
 * it breaking an HTTP one. `httpOnly` and `sameSite: strict` are unchanged, so
 * the cookie is still unreadable by scripts and never sent cross-site.
 */
const SERVED_OVER_HTTPS = /^https:\/\//i.test(env.FRONTEND_URL);

function refreshCookieAttributes() {
  return {
    httpOnly: true,
    secure: SERVED_OVER_HTTPS,
    sameSite: 'strict' as const,
    path: '/api/v1/auth',
  };
}

/** Options for SETTING the cookie — lifetime included. */
function refreshCookieOptions() {
  return {
    ...refreshCookieAttributes(),
    maxAge: env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000,
  };
}

/**
 * Options for CLEARING the cookie — deliberately without `maxAge`.
 * Express 4 deprecates passing it here and Express 5 ignores it outright;
 * `clearCookie` sets its own expiry in the past.
 */
function clearRefreshCookie(res: Response): void {
  res.clearCookie(REFRESH_COOKIE, refreshCookieAttributes());
}

interface UserRow {
  id: number;
  employee_id: string;
  employee_name: string;
  designation: string;
  email: string | null;
  password_hash: string;
  is_active: boolean;
  must_change_password: boolean;
  failed_login_count: number;
  locked_until: string | null;
  department_id: number | null;
  department_name: string | null;
}

async function issueSession(
  user: UserRow,
  req: Request,
  res: Response,
): Promise<{ accessToken: string; profile: Record<string, unknown> }> {
  const { roles, permissions } = await loadUserPermissions(user.id);

  const accessToken = signAccessToken({
    sub: user.id,
    employeeId: user.employee_id,
    name: user.employee_name,
    roles,
    permissions,
    mustChangePassword: false,
  });

  const { token: refreshToken, hash } = generateRefreshToken();
  await query(
    `INSERT INTO user_sessions (user_id, refresh_token_hash, expires_at, ip_address, user_agent)
     VALUES ($1,$2,$3,$4,$5)`,
    [user.id, hash, refreshTokenExpiry().toISOString(), req.ip ?? null, req.get('user-agent') ?? null],
  );
  res.cookie(REFRESH_COOKIE, refreshToken, refreshCookieOptions());

  return {
    accessToken,
    profile: {
      id: user.id,
      employeeId: user.employee_id,
      employeeName: user.employee_name,
      designation: user.designation,
      email: user.email,
      department: user.department_name,
      departmentId: user.department_id,
      roles,
      permissions,
      mustChangePassword: false,
    },
  };
}

/* ── POST /auth/login ───────────────────────────────────────────────────────── */

const loginSchema = z.object({
  employeeId: z.string().trim().min(1, 'Employee ID is required.').max(50),
  password: z.string().min(1, 'Password is required.').max(200),
});

router.post(
  '/login',
  validateBody(loginSchema),
  asyncHandler(async (req, res) => {
    const { employeeId, password } = req.body as z.infer<typeof loginSchema>;

    const user = await queryOne<UserRow>(
      `SELECT u.id, u.employee_id, u.employee_name, u.designation, u.email, u.password_hash,
              u.is_active, u.must_change_password, u.failed_login_count, u.locked_until,
              u.department_id, d.name AS department_name
         FROM users u
         LEFT JOIN lookups d ON d.id = u.department_id
        WHERE u.employee_id = $1 AND u.deleted_at IS NULL`,
      [employeeId],
    );

    // One generic message for "no such user" and "wrong password" so the endpoint
    // cannot be used to enumerate valid Employee IDs.
    const genericFailure = AuthenticationError('Invalid Employee ID or password.');

    if (!user) {
      await audit({
        actor: { employeeId, ip: req.ip, userAgent: req.get('user-agent') },
        action: 'LOGIN_FAILED', entity: 'auth', entityLabel: employeeId,
        result: 'FAILURE', message: 'Unknown Employee ID',
      });
      throw genericFailure;
    }

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      const minutes = Math.ceil((new Date(user.locked_until).getTime() - Date.now()) / 60000);
      await audit({
        actor: { userId: user.id, employeeId, name: user.employee_name, ip: req.ip },
        action: 'LOGIN_FAILED', entity: 'auth', entityId: user.id,
        result: 'FAILURE', message: 'Account locked',
      });
      throw AuthenticationError(
        `This account is temporarily locked after repeated failed sign-in attempts. Try again in ${minutes} minute(s).`,
      );
    }

    if (!user.is_active) {
      await audit({
        actor: { userId: user.id, employeeId, name: user.employee_name, ip: req.ip },
        action: 'LOGIN_FAILED', entity: 'auth', entityId: user.id,
        result: 'FAILURE', message: 'Account deactivated',
      });
      throw AuthenticationError('This account has been deactivated. Please contact your administrator.');
    }

    const ok = await verifyPassword(password, user.password_hash);
    if (!ok) {
      const failures = Number(user.failed_login_count) + 1;
      const shouldLock = failures >= env.MAX_FAILED_LOGINS;
      await execute(
        `UPDATE users
            SET failed_login_count = $2,
                locked_until = CASE WHEN $3 THEN now() + ($4 || ' minutes')::interval ELSE locked_until END,
                updated_at = now()
          WHERE id = $1`,
        [user.id, shouldLock ? 0 : failures, shouldLock, String(env.ACCOUNT_LOCK_MINUTES)],
      );
      await audit({
        actor: { userId: user.id, employeeId, name: user.employee_name, ip: req.ip },
        action: 'LOGIN_FAILED', entity: 'auth', entityId: user.id, result: 'FAILURE',
        message: shouldLock ? `Incorrect password — account locked for ${env.ACCOUNT_LOCK_MINUTES} minutes` : `Incorrect password (attempt ${failures})`,
      });
      throw shouldLock
        ? AuthenticationError(
            `Too many failed attempts. This account is locked for ${env.ACCOUNT_LOCK_MINUTES} minutes.`,
          )
        : genericFailure;
    }

    await execute(
      `UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = now() WHERE id = $1`,
      [user.id],
    );

    const { accessToken, profile } = await issueSession(user, req, res);

    await audit({
      actor: { userId: user.id, employeeId: user.employee_id, name: user.employee_name, ip: req.ip, userAgent: req.get('user-agent') },
      action: 'LOGIN', entity: 'auth', entityId: user.id, entityLabel: user.employee_id,
      message: user.must_change_password ? 'Signed in — password rotation required' : 'Signed in',
    });

    sendOk(res, { accessToken, user: profile });
  }),
);

/* ── POST /auth/refresh ─────────────────────────────────────────────────────── */

router.post(
  '/refresh',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];

    // Having no session at all is a NORMAL state — it is what every first-time
    // visitor on the landing page looks like. Answering 200 keeps it out of the
    // browser console, and reserves 401 for a session that is genuinely invalid.
    if (!token) {
      sendOk(res, { authenticated: false });
      return;
    }

    const hash = hashRefreshToken(token);
    const session = await queryOne<{ id: number; user_id: number; expires_at: string; revoked_at: string | null }>(
      'SELECT id, user_id, expires_at, revoked_at FROM user_sessions WHERE refresh_token_hash = $1',
      [hash],
    );

    if (!session || session.revoked_at || new Date(session.expires_at) < new Date()) {
      clearRefreshCookie(res);
      throw AuthenticationError('Your session has expired. Please sign in again.');
    }

    const user = await queryOne<UserRow>(
      `SELECT u.id, u.employee_id, u.employee_name, u.designation, u.email, u.password_hash,
              u.is_active, u.must_change_password, u.failed_login_count, u.locked_until,
              u.department_id, d.name AS department_name
         FROM users u
         LEFT JOIN lookups d ON d.id = u.department_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [session.user_id],
    );
    if (!user || !user.is_active) {
      await execute('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
      clearRefreshCookie(res);
      throw AuthenticationError('This account is no longer active.');
    }

    // Rotate: the presented refresh token is single-use.
    await execute('UPDATE user_sessions SET revoked_at = now() WHERE id = $1', [session.id]);
    const { accessToken, profile } = await issueSession(user, req, res);

    sendOk(res, { accessToken, user: profile });
  }),
);

/* ── POST /auth/logout ──────────────────────────────────────────────────────── */

router.post(
  '/logout',
  asyncHandler(async (req, res) => {
    const token = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
    if (token) {
      const hash = hashRefreshToken(token);
      const session = await queryOne<{ user_id: number }>(
        'SELECT user_id FROM user_sessions WHERE refresh_token_hash = $1 AND revoked_at IS NULL',
        [hash],
      );
      await execute(
        'UPDATE user_sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL',
        [hash],
      );
      if (session) {
        const u = await queryOne<{ employee_id: string; employee_name: string }>(
          'SELECT employee_id, employee_name FROM users WHERE id = $1',
          [session.user_id],
        );
        await audit({
          actor: { userId: session.user_id, employeeId: u?.employee_id, name: u?.employee_name, ip: req.ip },
          action: 'LOGOUT', entity: 'auth', entityId: session.user_id,
        });
      }
    }
    clearRefreshCookie(res);
    sendOk(res, { message: 'Signed out.' });
  }),
);

/* ── GET /auth/me ───────────────────────────────────────────────────────────── */

router.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await queryOne<{
      id: number; employee_id: string; employee_name: string; designation: string;
      email: string | null; mobile_no: string | null; must_change_password: boolean;
      last_login_at: string | null; department_id: number | null; department_name: string | null;
    }>(
      `SELECT u.id, u.employee_id, u.employee_name, u.designation, u.email, u.mobile_no,
              u.must_change_password, u.last_login_at, u.department_id, d.name AS department_name
         FROM users u
         LEFT JOIN lookups d ON d.id = u.department_id
        WHERE u.id = $1 AND u.deleted_at IS NULL`,
      [req.user!.id],
    );
    if (!user) throw AuthenticationError('Your account is no longer available.');

    // Permissions are re-read from the database, so a revoked grant takes effect
    // immediately rather than at token expiry.
    const { roles, permissions } = await loadUserPermissions(user.id);

    sendOk(res, {
      id: user.id,
      employeeId: user.employee_id,
      employeeName: user.employee_name,
      designation: user.designation,
      email: user.email,
      mobileNo: user.mobile_no,
      department: user.department_name,
      departmentId: user.department_id,
      lastLoginAt: user.last_login_at,
      mustChangePassword: false,
      roles,
      permissions,
    });
  }),
);

/* ── POST /auth/change-password ─────────────────────────────────────────────── */

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, 'Your current password is required.'),
  newPassword: z.string().min(1, 'A new password is required.'),
});

router.post(
  '/change-password',
  requireAuth,
  validateBody(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const { currentPassword, newPassword } = req.body as z.infer<typeof changePasswordSchema>;
    const userId = req.user!.id;

    const user = await queryOne<{ password_hash: string; employee_id: string; employee_name: string }>(
      'SELECT password_hash, employee_id, employee_name FROM users WHERE id = $1 AND deleted_at IS NULL',
      [userId],
    );
    if (!user) throw AuthenticationError();

    if (!(await verifyPassword(currentPassword, user.password_hash))) {
      await audit({
        actor: actorFrom(req), action: 'PASSWORD_CHANGE', entity: 'user', entityId: userId,
        result: 'FAILURE', message: 'Current password incorrect',
      });
      throw ValidationError('Your current password is incorrect.', [
        { field: 'currentPassword', message: 'Incorrect password.' },
      ]);
    }

    const strength = checkPasswordStrength(newPassword);
    if (!strength.ok) {
      throw ValidationError('Choose a stronger password.', [
        { field: 'newPassword', message: `Password must ${strength.problems.join(', ')}.` },
      ]);
    }
    if (await verifyPassword(newPassword, user.password_hash)) {
      throw BusinessRuleError('Your new password must be different from your current password.');
    }

    await execute(
      `UPDATE users
          SET password_hash = $2, must_change_password = FALSE,
              password_changed_at = now(), updated_at = now(), updated_by = $1
        WHERE id = $1`,
      [userId, await hashPassword(newPassword)],
    );

    // Every other session for this user is revoked — a password change must evict
    // anyone holding the old credential.
    await execute(
      'UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
    );
    clearRefreshCookie(res);
    // The access token used for this very request must stop working too.
    invalidateAuthState(userId);

    await audit({
      actor: actorFrom(req), action: 'PASSWORD_CHANGE', entity: 'user', entityId: userId,
      entityLabel: user.employee_id, message: 'Password changed; all sessions revoked',
    });

    sendOk(res, { message: 'Password changed. Please sign in again with your new password.' });
  }),
);

export default router;
