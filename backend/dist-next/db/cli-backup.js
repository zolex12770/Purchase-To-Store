/**
 * CLI: create a checksum-verified backup. `npm run db:backup`
 *
 * The same portable JSON export the Admin → Backup screen produces, available
 * without a browser so it can run from cron or a deploy script.
 *
 * Uses the shared collector in `restore.ts`, so a CLI backup and a UI backup are
 * byte-for-byte the same kind of artefact and either can restore the other.
 *
 * The file is written, read BACK, and re-checksummed before it is recorded as
 * VERIFIED. A backup that was never read back is only a hope.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureStorageDirs, paths } from '../config/env.js';
import { closeDatabase, databaseLabel } from './driver.js';
import { query, queryOne, execute } from './index.js';
import { BACKUP_TABLES, collectBackupData } from './restore.js';
import { logger } from '../core/logger.js';
const sha256 = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');
async function main() {
    ensureStorageDirs();
    logger.info(`Database: ${databaseLabel()}`);
    const noteArg = process.argv.indexOf('--note');
    const note = noteArg >= 0 ? (process.argv[noteArg + 1] ?? '') : 'Created by deploy/backup.sh';
    const schemaRow = await queryOne('SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1');
    const { data, counts } = await collectBackupData((sql) => query(sql));
    const payload = {
        meta: {
            product: 'ZOLEX Purchase-to-Store ERP',
            version: '1.0.0',
            createdAt: new Date().toISOString(),
            schemaVersion: schemaRow?.version ?? 'unknown',
            tableCounts: counts,
        },
        data,
    };
    const json = JSON.stringify(payload, null, 0);
    const checksum = sha256(json);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `zolex-backup-${stamp}.json`;
    const filePath = path.join(paths.backups, filename);
    fs.mkdirSync(paths.backups, { recursive: true });
    fs.writeFileSync(filePath, json, 'utf8');
    // Read back and re-verify before recording it as usable.
    const readBack = fs.readFileSync(filePath, 'utf8');
    if (sha256(readBack) !== checksum) {
        throw new Error(`Backup ${filename} does not match its checksum after writing — the file is not usable.`);
    }
    JSON.parse(readBack);
    const bytes = fs.statSync(filePath).size;
    const rows = Object.values(counts).reduce((a, b) => a + b, 0);
    await execute(`INSERT INTO backup_metadata
       (filename, file_path, kind, status, size_bytes, checksum_sha256,
        table_counts, schema_version, notes, verified_at)
     VALUES ($1,$2,'SCHEDULED','VERIFIED',$3,$4,$5::jsonb,$6,$7, now())`, [filename, filePath, bytes, checksum, JSON.stringify(counts), schemaRow?.version ?? '', note]);
    logger.info(`Backup verified: ${filename} (${(bytes / 1024).toFixed(1)} KB, ${rows} rows, ${BACKUP_TABLES.length} tables)`);
    logger.info(`SHA-256: ${checksum}`);
    await closeDatabase();
}
main().catch(async (err) => {
    logger.error('Backup failed', { error: err instanceof Error ? err.message : String(err) });
    // eslint-disable-next-line no-console
    console.error(err);
    await closeDatabase().catch(() => undefined);
    process.exit(1);
});
//# sourceMappingURL=cli-backup.js.map