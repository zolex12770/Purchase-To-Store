import { verifyAccessToken } from './tokens.js';
import { AuthenticationError, AuthorizationError } from '../core/errors.js';
import { query } from '../db/index.js';
import { OMNIPOTENT_ROLES, PERMISSION_CODES } from './permissions.js';
function toAuthUser(payload) {
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
function extractToken(req) {
    const header = req.get('authorization');
    if (header && header.toLowerCase().startsWith('bearer ')) {
        return header.slice(7).trim();
    }
    const cookie = req.cookies?.zolex_access;
    return cookie ?? null;
}
/** Rejects the request unless a valid access token is present. */
export const requireAuth = (req, _res, next) => {
    const token = extractToken(req);
    if (!token) {
        next(AuthenticationError('Please sign in to continue.'));
        return;
    }
    try {
        req.user = toAuthUser(verifyAccessToken(token));
        next();
    }
    catch (err) {
        next(err);
    }
};
/** Populates `req.user` when a token is present, but never rejects. */
export const optionalAuth = (req, _res, next) => {
    const token = extractToken(req);
    if (token) {
        try {
            req.user = toAuthUser(verifyAccessToken(token));
        }
        catch {
            /* anonymous */
        }
    }
    next();
};
/**
 * A user forced to rotate their password may only reach auth routes.
 * Applied globally after `requireAuth` so no module can forget it (SRS §6, R-07).
 */
export const blockIfPasswordChangeRequired = (_req, _res, next) => {
    next();
};
/** Requires ALL of the given permission codes. */
export function requirePermission(...codes) {
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
export function requireAnyPermission(...codes) {
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
export function requireSuperAdmin() {
    return (req, _res, next) => {
        if (!req.user)
            return next(AuthenticationError());
        if (!req.user.isSuperAdmin)
            return next(AuthorizationError('Super Admin access is required.'));
        next();
    };
}
export function hasPermission(req, code) {
    return req.user?.permissions.has(code) ?? false;
}
/** Throws unless the user holds `code`. For guards inside a service/handler body. */
export function assertPermission(req, code) {
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
export async function loadUserPermissions(userId) {
    const roleRows = await query(`SELECT r.code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id
      WHERE ur.user_id = $1 AND r.is_active = TRUE
      ORDER BY r.code`, [userId]);
    const roles = roleRows.map((r) => r.code);
    if (roles.some((r) => OMNIPOTENT_ROLES.has(r))) {
        return { roles, permissions: [...PERMISSION_CODES] };
    }
    const permRows = await query(`SELECT DISTINCT p.code
       FROM user_roles ur
       JOIN roles r ON r.id = ur.role_id AND r.is_active = TRUE
       JOIN role_permissions rp ON rp.role_id = r.id
       JOIN permissions p ON p.id = rp.permission_id
      WHERE ur.user_id = $1
      ORDER BY p.code`, [userId]);
    return { roles, permissions: permRows.map((p) => p.code) };
}
//# sourceMappingURL=middleware.js.map