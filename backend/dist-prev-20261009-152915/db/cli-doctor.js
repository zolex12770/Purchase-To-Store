/**
 * CLI: diagnose the database. `npm run db:doctor`
 *
 * Answers the two questions an operator actually has when something looks wrong:
 * "can the database be opened?" and "is the data self-consistent?" — and, when
 * the answer is no, says exactly what to do next.
 */
import fs from 'node:fs';
import { ensureStorageDirs, env, paths } from '../config/env.js';
import { getDatabase, closeDatabase, databaseLabel, inspectDirectoryLock } from './driver.js';
import { query } from './index.js';
/* Plain console output: this is a diagnostic tool, not application logging. */
const ok = (m) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m) => console.log(`  \x1b[31m✗\x1b[0m ${m}`);
const info = (m) => console.log(`    ${m}`);
/** Invariants that must hold in a healthy database (ADR-005). */
const INTEGRITY_CHECKS = [
    ['No indent line is over-ordered',
        'SELECT COUNT(*)::int AS n FROM v_indent_line_balance WHERE ordered_qty > indent_qty'],
    ['No PO line is over-received',
        'SELECT COUNT(*)::int AS n FROM v_po_line_balance WHERE received_qty > po_qty'],
    ['No negative pending quantities',
        `SELECT (SELECT COUNT(*) FROM v_indent_line_balance WHERE pending_qty < 0)
         + (SELECT COUNT(*) FROM v_po_line_balance WHERE pending_grn_qty < 0) AS n`],
    ['Stored PO status matches the derived status',
        'SELECT COUNT(*)::int AS n FROM v_po_header_balance WHERE status <> derived_status'],
    ['Generated money columns are consistent',
        `SELECT COUNT(*)::int AS n FROM purchase_order_lines
     WHERE final_rate <> round(rate * (1 - discount_pct/100), 4)
        OR amount <> round(po_qty * round(rate * (1 - discount_pct/100), 4), 2)`],
    ['Every rejected indent carries a reason',
        `SELECT COUNT(*)::int AS n FROM purchase_indent_headers
     WHERE status = 'REJECTED' AND (rejection_reason IS NULL OR trim(rejection_reason) = '')`],
    ['Every PO source points at an approved indent',
        `SELECT COUNT(*)::int AS n FROM po_indent_sources pis
      JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
     WHERE ih.status NOT IN ('APPROVED','CLOSED')`],
    ['At least one active Super Admin exists',
        `SELECT CASE WHEN COUNT(*) = 0 THEN 1 ELSE 0 END AS n
      FROM users u JOIN user_roles ur ON ur.user_id = u.id
      JOIN roles r ON r.id = ur.role_id
     WHERE r.code = 'SUPER_ADMIN' AND u.is_active AND u.deleted_at IS NULL`],
];
async function main() {
    ensureStorageDirs();
    console.log('\nZOLEX database doctor');
    console.log('─'.repeat(60));
    console.log(`Driver   : ${env.DB_DRIVER}`);
    console.log(`Location : ${databaseLabel()}`);
    console.log(`Backups  : ${paths.backups}`);
    console.log('─'.repeat(60));
    /* ── Storage ──────────────────────────────────────────────────────────── */
    console.log('\nStorage');
    if (env.DB_DRIVER === 'pglite') {
        const exists = fs.existsSync(paths.database);
        exists ? ok(`Data directory exists: ${paths.database}`) : bad('Data directory does not exist yet');
        // Uses the driver's own rule, so the doctor and the engine can never
        // disagree about whether a lock is live.
        const lock = inspectDirectoryLock(paths.database);
        if (lock.state === 'held') {
            bad(`Database is currently open by process ${lock.pid} (heartbeat ${lock.ageSeconds}s ago)`);
            info('Stop that process before running maintenance commands.');
        }
        else if (lock.state === 'stale') {
            ok(`Stale lock from process ${lock.pid} (last heartbeat ${lock.ageSeconds}s ago) — it will be reclaimed automatically`);
        }
        else if (lock.state === 'unreadable') {
            ok('An unreadable lock file is present — it will be reclaimed automatically');
        }
        else {
            ok('No process lock held');
        }
    }
    else {
        ok('Using an external PostgreSQL server');
    }
    const backups = fs.existsSync(paths.backups)
        ? fs.readdirSync(paths.backups).filter((f) => f.endsWith('.json'))
        : [];
    if (backups.length > 0)
        ok(`${backups.length} backup(s) available`);
    else
        bad('No backups exist — create one from Admin → Backup & Restore');
    /* ── Connectivity ─────────────────────────────────────────────────────── */
    console.log('\nConnectivity');
    try {
        await getDatabase();
        ok('Database opens successfully');
    }
    catch (err) {
        bad('Database CANNOT be opened');
        console.log(`\n${err instanceof Error ? err.message : String(err)}\n`);
        process.exit(1);
    }
    const version = await query('SELECT version() AS v');
    ok(`Engine: ${(version[0]?.v ?? '').split(' on ')[0]}`);
    const migrations = await query('SELECT version FROM schema_migrations ORDER BY version').catch(() => []);
    if (migrations.length === 0) {
        bad('No migrations applied — run npm run migrate');
    }
    else {
        ok(`${migrations.length} migration(s) applied (latest: ${migrations.at(-1)?.version})`);
    }
    /* ── Volumes ──────────────────────────────────────────────────────────── */
    console.log('\nRecord counts');
    for (const t of ['users', 'suppliers', 'items', 'purchase_indent_headers',
        'purchase_order_headers', 'grn_headers', 'audit_logs']) {
        try {
            const rows = await query(`SELECT COUNT(*)::int AS n FROM ${t}`);
            info(`${t.padEnd(26)} ${String(rows[0]?.n ?? 0).padStart(8)}`);
        }
        catch {
            bad(`${t} — table missing`);
        }
    }
    /* ── Integrity ────────────────────────────────────────────────────────── */
    console.log('\nData integrity');
    let failures = 0;
    for (const [label, sql] of INTEGRITY_CHECKS) {
        try {
            const rows = await query(sql);
            const n = Number(rows[0]?.n ?? 0);
            if (n === 0)
                ok(label);
            else {
                bad(`${label} — ${n} violation(s)`);
                failures++;
            }
        }
        catch (err) {
            bad(`${label} — check could not run: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`);
            failures++;
        }
    }
    console.log('\n' + '─'.repeat(60));
    if (failures === 0) {
        console.log('\x1b[32mAll checks passed. The database is healthy.\x1b[0m\n');
    }
    else {
        console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m Investigate before relying on reports.\n`);
    }
    await closeDatabase();
    process.exit(failures === 0 ? 0 : 1);
}
main().catch(async (err) => {
    console.error('\nDoctor failed to run:\n', err);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cli-doctor.js.map