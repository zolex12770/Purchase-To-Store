import { query, txQuery } from '../db/index.js';
import { logger } from './logger.js';
const SQL = `
  INSERT INTO audit_logs
    (actor_user_id, actor_employee_id, actor_name, action, entity, entity_id, entity_label,
     before_data, after_data, source, result, message, ip_address, user_agent, request_id)
  VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
`;
/** Values that must never be persisted into the audit trail. */
const SENSITIVE = new Set([
    'password', 'password_hash', 'passwordHash', 'newPassword', 'currentPassword',
    'confirmPassword', 'refresh_token_hash', 'token', 'secret',
]);
function scrub(value, depth = 0) {
    if (value === undefined)
        return undefined;
    if (value === null || typeof value !== 'object' || depth > 8)
        return value;
    if (Array.isArray(value))
        return value.map((v) => scrub(v, depth + 1));
    const out = {};
    for (const [k, v] of Object.entries(value)) {
        out[k] = SENSITIVE.has(k) ? '[redacted]' : scrub(v, depth + 1);
    }
    return out;
}
function toParams(entry) {
    const a = entry.actor ?? {};
    const before = scrub(entry.before);
    const after = scrub(entry.after);
    return [
        a.userId ?? null,
        a.employeeId ?? null,
        a.name ?? null,
        entry.action,
        entry.entity,
        entry.entityId != null ? String(entry.entityId) : null,
        entry.entityLabel ?? null,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
        entry.source ?? 'API',
        entry.result ?? 'SUCCESS',
        entry.message ?? null,
        a.ip ?? null,
        a.userAgent ?? null,
        a.requestId ?? null,
    ];
}
/**
 * Writes an audit row inside an existing transaction.
 * Use this for business mutations: if the document rolls back, so does its audit
 * record, and the trail can never claim something happened that did not.
 */
export async function auditIn(tx, entry) {
    await txQuery(tx, SQL, toParams(entry));
}
/**
 * Writes an audit row outside any transaction, never throwing.
 * Use for observational events (login, export, print) where failing the user's
 * request because the audit insert failed would be the worse outcome.
 */
export async function audit(entry) {
    try {
        await query(SQL, toParams(entry));
    }
    catch (err) {
        logger.error('Audit write failed', {
            action: entry.action,
            entity: entry.entity,
            error: err instanceof Error ? err.message : String(err),
        });
    }
}
/** Builds an actor descriptor from the authenticated request. */
export function actorFrom(req) {
    const user = req.user;
    return {
        userId: user?.id ?? null,
        employeeId: user?.employeeId ?? null,
        name: user?.employeeName ?? null,
        ip: req.ip ?? null,
        userAgent: req.get('user-agent') ?? null,
        requestId: req.res?.locals.requestId ?? null,
    };
}
export const SYSTEM_ACTOR = { userId: null, employeeId: 'SYSTEM', name: 'System' };
//# sourceMappingURL=audit.js.map