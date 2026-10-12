/**
 * Data Audit & Purification (SRS production-hardening requirement).
 *
 * Exposes the SAME classification/purge engine the `db:purify` CLI uses
 * (`backend/src/db/purify.ts`) over HTTP, so an administrator can inspect and
 * clean non-production (demo/test) data from the live database WITHOUT
 * stopping the server — PGlite only forbids a SECOND PROCESS from opening the
 * data directory; queries from within the already-running process are fine,
 * the same reasoning already used by the DATABASE/ export endpoints.
 *
 * GET  /        — read-only inventory (demo/test/real/unknown per table).
 * POST /purify   — deletes demo/test rows. Backed up first, dry-run unless
 *                    `apply: true` is explicitly sent, typed confirmation
 *                    required to apply, same pattern as backup restore.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, sendOk, validateBody } from '../../core/http.js';
import { requirePermission } from '../../auth/middleware.js';
import { auditIn, actorFrom } from '../../core/audit.js';
import { ValidationError } from '../../core/errors.js';
import { withTransaction } from '../../db/index.js';
import { buildInventory, businessCounts, purgeNonProductionData, verifyPurified, takePrePurifyBackup, } from '../../db/purify.js';
const router = Router();
/* ── GET /audit — read-only inventory, no locking, no downtime ─────────────── */
router.get('/', requirePermission('backup.view'), asyncHandler(async (_req, res) => {
    const [inventory, counts] = await Promise.all([buildInventory(), businessCounts()]);
    const totalDemo = inventory.reduce((a, t) => a + t.demo + t.test, 0);
    const totalUnknown = inventory.reduce((a, t) => a + t.unknown, 0);
    sendOk(res, {
        inventory,
        businessCounts: counts,
        totalDemoOrTest: totalDemo,
        totalUnknown,
        generatedAt: new Date().toISOString(),
    });
}));
/* ── POST /purify — destructive; backed up, confirmed, verified ────────────── */
const purifySchema = z.object({
    apply: z.boolean().default(false),
    purgeAuditLogs: z.boolean().default(false),
    confirm: z.string().optional(),
});
router.post('/purify', requirePermission('backup.admin'), validateBody(purifySchema), asyncHandler(async (req, res) => {
    const { apply, purgeAuditLogs, confirm } = req.body;
    const before = await businessCounts();
    const inventory = await buildInventory();
    const totalDemo = inventory.reduce((a, t) => a + t.demo + t.test, 0);
    const totalUnknown = inventory.reduce((a, t) => a + t.unknown, 0);
    if (!apply) {
        return sendOk(res, {
            mode: 'dry-run', before, inventory, totalDemoOrTest: totalDemo, totalUnknown,
            message: totalDemo === 0
                ? 'Nothing to purge — no rows are classified demo/test.'
                : `${totalDemo} row(s) classified demo/test would be removed. Resend with apply: true and confirm: "PURIFY" to proceed.`,
        });
    }
    if (confirm !== 'PURIFY') {
        throw ValidationError('Type PURIFY in the confirm field to actually delete demo/test data. Nothing was changed.');
    }
    const actor = actorFrom(req);
    const backup = await takePrePurifyBackup(`Automatic safety backup before data purification (triggered by ${actor.name ?? actor.employeeId ?? 'admin'})`);
    const result = await purgeNonProductionData({
        keepAuditLogs: !purgeAuditLogs,
        actorEmployeeId: actor.employeeId ?? undefined,
        actorName: actor.name ?? undefined,
    });
    const checks = await verifyPurified();
    const failures = checks.filter((c) => !c.passed);
    const after = await businessCounts();
    await withTransaction(async (tx) => {
        await auditIn(tx, {
            actor, action: 'PURGE', entity: 'database', entityLabel: 'non-production data',
            after: { deleted: result.deleted, before, after },
            message: failures.length === 0
                ? `Purification complete. Backup: ${backup.filename}`
                : `Purification completed with ${failures.length} verification failure(s). Backup: ${backup.filename}`,
        });
    });
    sendOk(res, {
        mode: 'apply',
        before, after, result, checks,
        failures: failures.length,
        backup,
        message: failures.length === 0
            ? 'Purification complete and verified.'
            : `${failures.length} verification check(s) failed after purge — review before trusting reports.`,
    });
}));
export default router;
//# sourceMappingURL=data-audit.routes.js.map