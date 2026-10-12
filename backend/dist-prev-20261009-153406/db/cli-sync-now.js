/**
 * CLI: trigger one Google Sheets sync run immediately, without going through
 * HTTP/login.  `npm run sync:now [-- --sheets "Item Master,Supplier Master"]`
 *
 * Same `runSync()` the scheduler and the authenticated `/google-sync` HTTP
 * route both call — this is not a second sync implementation, just a way to
 * run it from the CLI when exclusive DB access is already available.
 */
import { ensureStorageDirs } from '../config/env.js';
import { closeDatabase } from './driver.js';
import { runSync } from '../modules/google-sync/engine.js';
const args = process.argv.slice(2);
const sheetsFlagIndex = args.indexOf('--sheets');
const sheets = sheetsFlagIndex >= 0 ? args[sheetsFlagIndex + 1]?.split(',').map((s) => s.trim()) : undefined;
async function main() {
    ensureStorageDirs();
    console.log(`\nRunning Google Sheets sync${sheets ? ` (scoped to: ${sheets.join(', ')})` : ' (all enabled sheets)'}…\n`);
    const result = await runSync({ trigger: 'MANUAL', sheets });
    console.log(`Status: ${result.status}`);
    console.log(`Duration: ${result.durationMs}ms`);
    for (const s of result.sheets) {
        console.log(`  ${s.sheet.padEnd(20)} read=${s.rowsRead} inserted=${s.inserted} updated=${s.updated} ` +
            `skipped=${s.skipped} rejected=${s.rejected} conflicts=${s.conflicts}${s.message ? ` — ${s.message}` : ''}`);
    }
    console.log(`\n${result.message}\n`);
    await closeDatabase();
    process.exit(result.status === 'FAILED' ? 1 : 0);
}
main().catch(async (err) => {
    console.error('\nSync failed:\n', err instanceof Error ? err.message : err);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cli-sync-now.js.map