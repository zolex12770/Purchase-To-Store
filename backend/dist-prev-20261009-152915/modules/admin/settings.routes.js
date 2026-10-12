/**
 * Application settings (SRS §17 configuration management).
 *
 * Settings are database rows, not constants, so an administrator can change
 * company details, defaults and retention without a deployment.
 */
import { Router } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '../../db/index.js';
import { asyncHandler, sendOk, validateBody } from '../../core/http.js';
import { NotFoundError, ValidationError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
const router = Router();
/** Settings any signed-in user may read (branding shown in the shell and prints). */
const PUBLIC_KEYS = new Set([
    'company.name', 'company.brand', 'company.tagline', 'company.address', 'company.gst_no',
    'company.phone', 'company.fax', 'company.logo_data_uri',
    'defaults.currency', 'google_sync.enabled',
    // Read by the forms themselves to decide whether to render an optional field.
    'form_fields.indent.remarks_visible',
    'form_fields.indent.required_by_visible',
]);
/** Settings that must never be changed through this generic endpoint. */
const PROTECTED_KEYS = new Set(['google_sync.sheet_id']);
router.get('/', asyncHandler(async (req, res) => {
    const canAdmin = req.user.permissions.has('system.admin');
    const rows = await query('SELECT key, value, description, updated_at FROM app_settings ORDER BY key');
    const visible = canAdmin ? rows : rows.filter((r) => PUBLIC_KEYS.has(r.key));
    sendOk(res, Object.fromEntries(visible.map((r) => [r.key, r.value])), {
        descriptions: Object.fromEntries(visible.map((r) => [r.key, r.description])),
        updatedAt: Object.fromEntries(visible.map((r) => [r.key, r.updated_at])),
        canEdit: canAdmin,
    });
}));
router.put('/', requirePermission('system.admin'), validateBody(z.record(z.string(), z.unknown())), asyncHandler(async (req, res) => {
    const updates = req.body;
    const keys = Object.keys(updates);
    if (keys.length === 0)
        throw ValidationError('No settings supplied.');
    const existing = await query('SELECT key, value FROM app_settings WHERE key = ANY($1)', [keys]);
    const known = new Map(existing.map((e) => [e.key, e.value]));
    const unknownKeys = keys.filter((k) => !known.has(k));
    if (unknownKeys.length > 0) {
        throw ValidationError(`Unknown setting(s): ${unknownKeys.join(', ')}.`);
    }
    const blocked = keys.filter((k) => PROTECTED_KEYS.has(k));
    if (blocked.length > 0) {
        throw ValidationError(`These settings are managed through environment configuration and cannot be edited here: ${blocked.join(', ')}.`);
    }
    await withTransaction(async (tx) => {
        for (const key of keys) {
            await tx.query('UPDATE app_settings SET value = $2::jsonb, updated_at = now(), updated_by = $3 WHERE key = $1', [key, JSON.stringify(updates[key]), req.user.id]);
            await auditIn(tx, {
                actor: actorFrom(req), action: 'SETTING_CHANGE', entity: 'app_setting',
                entityId: key, entityLabel: key,
                before: { value: known.get(key) }, after: { value: updates[key] },
            });
        }
    });
    const rows = await query('SELECT key, value FROM app_settings ORDER BY key');
    sendOk(res, Object.fromEntries(rows.map((r) => [r.key, r.value])), {
        message: `${keys.length} setting(s) updated.`,
    });
}));
router.get('/:key', asyncHandler(async (req, res) => {
    const key = req.params.key ?? '';
    if (!PUBLIC_KEYS.has(key) && !req.user.permissions.has('system.admin')) {
        throw NotFoundError('Setting');
    }
    const row = await queryOne('SELECT key, value, description, updated_at FROM app_settings WHERE key = $1', [key]);
    if (!row)
        throw NotFoundError('Setting');
    sendOk(res, row);
}));
export default router;
//# sourceMappingURL=settings.routes.js.map