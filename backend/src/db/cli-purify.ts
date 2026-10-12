/**
 * CLI: production data purification.  `npm run db:purify [-- --apply]`
 *
 * Removes demo/test data so a database can go into production, and refuses to
 * do anything destructive casually:
 *
 *   • Default is a DRY RUN. Nothing is deleted without an explicit `--apply`.
 *   • `--apply` takes a checksum-verified backup FIRST and aborts if the backup
 *     cannot be written back and read cleanly.
 *   • Rows that cannot be positively classified are reported, never deleted.
 *   • Afterwards it re-asserts the integrity invariants, so "the database is
 *     clean" is a verified statement rather than a hopeful one.
 *
 * Flags
 *   --apply           actually delete (default: dry run)
 *   --purge-audit     also clear the audit log (default: keep it)
 *   --no-backup       skip the safety backup — refused unless --i-know
 *   --json            machine-readable output for the purification report
 */
import { ensureStorageDirs, env, paths } from '../config/env.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { BACKUP_TABLES } from './restore.js';
import {
  buildInventory, purgeNonProductionData, verifyPurified, businessCounts,
  takePrePurifyBackup, type TableInventory,
} from './purify.js';

const args = process.argv.slice(2);
const has = (f: string) => args.includes(f);

const APPLY = has('--apply');
const PURGE_AUDIT = has('--purge-audit');
const SKIP_BACKUP = has('--no-backup') && has('--i-know');
const AS_JSON = has('--json');

const out = (m = '') => { if (!AS_JSON) console.log(m); };
const ok = (m: string) => out(`  \x1b[32m✓\x1b[0m ${m}`);
const bad = (m: string) => out(`  \x1b[31m✗\x1b[0m ${m}`);
const warn = (m: string) => out(`  \x1b[33m!\x1b[0m ${m}`);

function renderInventory(inv: TableInventory[]): void {
  const business = inv.filter((t) => t.kind === 'business');
  const operational = inv.filter((t) => t.kind === 'operational');
  const system = inv.filter((t) => t.kind === 'system');

  const header = 'TABLE'.padEnd(28) + 'TOTAL'.padStart(8) + 'REAL'.padStart(8)
    + 'DEMO'.padStart(8) + 'TEST'.padStart(8) + 'SYSTEM'.padStart(8) + 'UNKNOWN'.padStart(9);

  out('\nBUSINESS DATA');
  out(header);
  out('─'.repeat(77));
  for (const t of business) {
    out(t.table.padEnd(28) + String(t.total).padStart(8) + String(t.real).padStart(8)
      + String(t.demo).padStart(8) + String(t.test).padStart(8)
      + String(t.system).padStart(8) + String(t.unknown).padStart(9));
  }

  out('\nOPERATIONAL / HISTORY');
  for (const t of operational) out(`  ${t.table.padEnd(28)} ${String(t.total).padStart(8)}   ${t.basis}`);

  out('\nSYSTEM (never purged)');
  for (const t of system) out(`  ${t.table.padEnd(28)} ${String(t.total).padStart(8)}   ${t.basis}`);
}

async function main(): Promise<void> {
  ensureStorageDirs();

  out('\nZOLEX data purification');
  out('─'.repeat(77));
  out(`Driver   : ${env.DB_DRIVER}`);
  out(`Location : ${databaseLabel()}`);
  out(`Mode     : ${APPLY ? '\x1b[31mAPPLY (data will be deleted)\x1b[0m' : '\x1b[32mDRY RUN (nothing will be deleted)\x1b[0m'}`);
  out('─'.repeat(77));

  const before = await businessCounts();
  const inventory = await buildInventory();
  renderInventory(inventory);

  const totalDemo = inventory.reduce((a, t) => a + t.demo + t.test, 0);
  const totalUnknown = inventory.reduce((a, t) => a + t.unknown, 0);

  out('\n' + '─'.repeat(77));
  out(`Rows classified demo/test : ${totalDemo}`);
  out(`Rows classified UNKNOWN   : ${totalUnknown}`);
  if (totalUnknown > 0) {
    warn('UNKNOWN rows are NOT deleted. Classify them, or remove them by hand after review.');
  }

  if (!APPLY) {
    out('\nDry run complete. Nothing was changed.');
    out('Re-run with  npm run db:purify -- --apply  to remove the demo/test rows above.\n');
    if (AS_JSON) console.log(JSON.stringify({ mode: 'dry-run', before, inventory }, null, 2));
    await closeDatabase();
    return;
  }

  /* ── Backup ────────────────────────────────────────────────────────────── */
  out('\nSafety backup');
  let backup: { filename: string; checksum: string; bytes: number } | null = null;
  if (SKIP_BACKUP) {
    warn('Backup SKIPPED at your explicit request (--no-backup --i-know)');
  } else {
    backup = await takePrePurifyBackup();
    ok(`Created and verified: ${backup.filename} (${(backup.bytes / 1024).toFixed(1)} KB)`);
    ok(`SHA-256: ${backup.checksum}`);
    ok(`Tables captured: ${BACKUP_TABLES.length}`);
  }

  /* ── Purge ─────────────────────────────────────────────────────────────── */
  out('\nPurging');
  const result = await purgeNonProductionData({ keepAuditLogs: !PURGE_AUDIT });

  for (const [table, n] of Object.entries(result.deleted)) {
    if (n > 0) ok(`${table.padEnd(28)} ${String(n).padStart(6)} row(s) deleted`);
  }
  if (Object.values(result.deleted).every((n) => n === 0)) ok('Nothing to delete — already clean');

  for (const r of result.retained) warn(`${r.table}: ${r.rows} row(s) retained — ${r.reason}`);
  for (const s of result.skipped) out(`  · ${s.table}: ${s.rows} row(s) kept — ${s.reason}`);

  /* ── Verify ────────────────────────────────────────────────────────────── */
  out('\nVerification');
  const checks = await verifyPurified();
  let failures = 0;
  for (const c of checks) {
    if (c.passed) ok(c.label);
    else { bad(`${c.label} — ${c.detail}`); failures++; }
  }

  const after = await businessCounts();

  out('\nBefore → after');
  for (const [t, n] of Object.entries(before)) {
    out(`  ${t.padEnd(28)} ${String(n).padStart(6)} → ${String(after[t] ?? 0).padStart(6)}`);
  }

  out('\n' + '─'.repeat(77));
  if (failures === 0) {
    out('\x1b[32mPurification complete and verified.\x1b[0m');
    if (backup) out(`Recovery point: ${backup.filename}`);
  } else {
    out(`\x1b[31m${failures} verification check(s) FAILED.\x1b[0m`);
    if (backup) out(`Restore with:  npm run db:restore -- "${paths.backups}/${backup.filename}"`);
  }
  out('');

  if (AS_JSON) {
    console.log(JSON.stringify({ mode: 'apply', before, after, inventory, result, checks, backup }, null, 2));
  }

  await closeDatabase();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nPurification failed:\n', err instanceof Error ? err.message : err);
  console.error('\nNo partial state is possible: the purge runs in a single transaction.');
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
