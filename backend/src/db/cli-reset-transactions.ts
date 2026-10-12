/**
 * CLI: full transaction-data reset.  `npm run db:reset-transactions [-- --apply]`
 *
 * Empties every Purchase Indent / PO / GRN table completely — this is a wider
 * operation than `db:purify` (which only removes rows tagged demo/test).
 * Use this ONLY when the real external source of truth (the Google Sheet, or
 * an operator decision) confirms there is currently no real transaction data
 * to preserve. See `db/reset-transactions.ts` for the full rationale.
 *
 *   • Default is a DRY RUN. Nothing is deleted without an explicit `--apply`.
 *   • `--apply` takes a checksum-verified backup FIRST and aborts if it can't
 *     be written back and read cleanly.
 *   • Master tables (suppliers, items, users, roles, permissions, lookups)
 *     are counted before and after — the report proves they were untouched.
 */
import { ensureStorageDirs, env } from '../config/env.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { inventoryForReset, resetAllTransactionData } from './reset-transactions.js';
import { takePrePurifyBackup } from './purify.js';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const SKIP_BACKUP = args.includes('--no-backup') && args.includes('--i-know');
const AS_JSON = args.includes('--json');

const out = (m = '') => { if (!AS_JSON) console.log(m); };
const ok = (m: string) => out(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => out(`  \x1b[33m!\x1b[0m ${m}`);

async function main(): Promise<void> {
  ensureStorageDirs();

  out('\nZOLEX full transaction-data reset');
  out('─'.repeat(77));
  out(`Driver   : ${env.DB_DRIVER}`);
  out(`Location : ${databaseLabel()}`);
  out(`Mode     : ${APPLY ? '\x1b[31mAPPLY (ALL Indent/PO/GRN data will be deleted)\x1b[0m' : '\x1b[32mDRY RUN (nothing will be deleted)\x1b[0m'}`);
  out('─'.repeat(77));

  const inv = await inventoryForReset();
  out('\nCurrent transaction counts (to be deleted on --apply):');
  for (const [t, n] of Object.entries(inv.transactionCounts)) out(`  ${t.padEnd(28)} ${String(n).padStart(8)}`);
  out('\nMaster counts (left untouched):');
  for (const [t, n] of Object.entries(inv.masterCounts)) out(`  ${t.padEnd(28)} ${String(n).padStart(8)}`);

  if (!APPLY) {
    out('\nDry run complete. Nothing was changed.');
    out('Re-run with  npm run db:reset-transactions -- --apply  to actually delete the rows above.\n');
    if (AS_JSON) console.log(JSON.stringify({ mode: 'dry-run', ...inv }, null, 2));
    await closeDatabase();
    return;
  }

  out('\nSafety backup');
  if (SKIP_BACKUP) {
    warn('Backup SKIPPED at your explicit request (--no-backup --i-know)');
  } else {
    const backup = await takePrePurifyBackup('Automatic safety backup before full transaction-data reset');
    ok(`Created and verified: ${backup.filename} (${(backup.bytes / 1024).toFixed(1)} KB)`);
    ok(`SHA-256: ${backup.checksum}`);
  }

  out('\nResetting');
  const result = await resetAllTransactionData({ actorEmployeeId: 'SYSTEM', actorName: 'db:reset-transactions CLI' });
  for (const [table, n] of Object.entries(result.deleted)) ok(`${table.padEnd(28)} ${String(n).padStart(6)} row(s) deleted`);

  out('\nBefore → after (transactions)');
  for (const [t, n] of Object.entries(result.before)) out(`  ${t.padEnd(28)} ${String(n).padStart(6)} → ${String(result.after[t] ?? 0).padStart(6)}`);

  out('\nMaster tables (proof nothing else was touched)');
  for (const m of result.masterCounts) out(`  ${m.table.padEnd(28)} ${String(m.before).padStart(6)} → ${String(m.after).padStart(6)}`);

  out('\n' + '─'.repeat(77));
  if (result.mastersUnchanged) {
    ok('Master tables confirmed unchanged.');
  } else {
    out('\x1b[31mWARNING: a master table count changed — investigate before trusting this reset.\x1b[0m');
  }
  const allZero = Object.values(result.after).every((n) => n === 0);
  out(allZero ? '\x1b[32mAll transaction tables are now empty.\x1b[0m' : '\x1b[31mSome transaction tables are NOT empty after reset.\x1b[0m');
  out('');

  if (AS_JSON) console.log(JSON.stringify({ mode: 'apply', ...result }, null, 2));

  await closeDatabase();
  process.exit(result.mastersUnchanged && allZero ? 0 : 1);
}

main().catch(async (err) => {
  console.error('\nReset failed:\n', err instanceof Error ? err.message : err);
  console.error('\nNo partial state is possible: the reset runs in a single transaction.');
  await closeDatabase().catch(() => undefined);
  process.exit(1);
});
