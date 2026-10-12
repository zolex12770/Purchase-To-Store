/**
 * Environment configuration — validated once, fail-fast (SRS §27).
 *
 * Nothing in the application reads `process.env` directly; everything imports `env`
 * from here so that a missing or malformed value is caught at boot, not at 3am.
 */
import 'dotenv/config';
import { z } from 'zod';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const bool = (def) => z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === 'true' || v === '1'));
const int = (def) => z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number(v)))
    .pipe(z.number().int());
const schema = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: int(4000),
    FRONTEND_URL: z.string().default('http://localhost:5173'),
    ZOLEX_DATA_ROOT: z.string().optional(),
    DB_DRIVER: z.enum(['pglite', 'pg']).default('pglite'),
    DATABASE_URL: z.string().optional(),
    DB_POOL_MAX: int(10),
    AUTH_SECRET: z.string().optional(),
    AUTH_REFRESH_SECRET: z.string().optional(),
    ACCESS_TOKEN_TTL: z.string().default('8h'),
    REFRESH_TOKEN_TTL_DAYS: int(30),
    BCRYPT_ROUNDS: int(12),
    MAX_FAILED_LOGINS: int(5),
    ACCOUNT_LOCK_MINUTES: int(15),
    GOOGLE_SHEET_ID: z.string().default('1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I'),
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: z.string().optional(),
    GOOGLE_API_KEY: z.string().optional(),
    GOOGLE_SYNC_INTERVAL_MINUTES: int(15),
    // The SQL -> Sheets REPLICA spreadsheet — a different document from
    // GOOGLE_SHEET_ID above, which is the hand-maintained master-data source the
    // one-way Sheets -> SQL sync reads. Keeping them separate is deliberate: the
    // replica is machine-owned (tabs created and rewritten by the exporter) and
    // must never overwrite the human-curated inbound sheet. Both spellings of the
    // name are accepted so an existing .env keeps working.
    GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID: z.string().optional(),
    GOOGLE_SHEETS_Database_SPREADSHEET_ID: z.string().optional(),
    GOOGLE_SHEETS_SYNC_ENABLED: z.enum(['true', 'false']).default('true'),
    RATE_LIMIT_WINDOW_MINUTES: int(15),
    RATE_LIMIT_MAX: int(1000),
    AUTH_RATE_LIMIT_MAX: int(20),
    MAX_UPLOAD_MB: int(15),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),
    SEED_DEMO_DATA: bool(true),
});
const parsed = schema.safeParse(process.env);
if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  • ${i.path.join('.')}: ${i.message}`).join('\n');
    // eslint-disable-next-line no-console
    console.error(`\n[zolex] Invalid environment configuration:\n${issues}\n`);
    process.exit(1);
}
const raw = parsed.data;
const isProd = raw.NODE_ENV === 'production';
/* ── Secrets ──────────────────────────────────────────────────────────────── */
function resolveSecret(value, name) {
    if (value && value.length >= 32)
        return value;
    if (isProd) {
        // eslint-disable-next-line no-console
        console.error(`\n[zolex] ${name} must be set to at least 32 characters in production.\n` +
            `        Generate one with:\n` +
            `        node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"\n`);
        process.exit(1);
    }
    if (value && value.length > 0) {
        // eslint-disable-next-line no-console
        console.warn(`[zolex] ${name} is shorter than 32 chars — using a generated development secret.`);
    }
    // Deterministic per-machine dev secret so tokens survive a dev-server restart.
    return crypto.createHash('sha256').update(`zolex-dev:${name}:${os.hostname()}`).digest('hex');
}
/* ── Storage paths (must live outside the project source — SRS §19, §23) ──── */
const dataRoot = path.resolve(raw.ZOLEX_DATA_ROOT && raw.ZOLEX_DATA_ROOT.trim().length > 0
    ? raw.ZOLEX_DATA_ROOT.trim()
    : path.join(os.homedir(), 'ZolexERP'));
export const paths = {
    root: dataRoot,
    database: path.join(dataRoot, raw.NODE_ENV === 'test' ? 'data-test' : 'data'),
    backups: path.join(dataRoot, 'backups'),
    uploads: path.join(dataRoot, 'uploads'),
    logs: path.join(dataRoot, 'logs'),
};
export function ensureStorageDirs() {
    for (const dir of Object.values(paths)) {
        fs.mkdirSync(dir, { recursive: true });
    }
}
/* ── Project-local DATABASE/ export area (SQL / Excel / Google Sheet archive) ─
 * Deliberately separate from `paths` above: `paths.backups` is the OPERATIONAL
 * restore mechanism and lives outside the repo by design (SRS §23). DATABASE/
 * is a read-only, project-local export/archive area for MySQL Workbench, Excel
 * and Google Sheets snapshots — never used to restore the ERP itself. Resolved
 * from this file's own location (not `process.cwd()`) so it is correct no
 * matter where the backend process is started from. */
const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const projectRoot = path.resolve(backendRoot, '..');
export const databasePaths = {
    root: path.join(projectRoot, 'DATABASE'),
    sql: path.join(projectRoot, 'DATABASE', 'SQL'),
    excel: path.join(projectRoot, 'DATABASE', 'EXCEL'),
    googleSheet: path.join(projectRoot, 'DATABASE', 'GOOGLE_SHEET'),
    backups: path.join(projectRoot, 'DATABASE', 'BACKUPS'),
};
if (raw.DB_DRIVER === 'pg' && !raw.DATABASE_URL) {
    // eslint-disable-next-line no-console
    console.error('\n[zolex] DB_DRIVER=pg requires DATABASE_URL to be set.\n');
    process.exit(1);
}
export const env = {
    ...raw,
    isProd,
    isTest: raw.NODE_ENV === 'test',
    isDev: raw.NODE_ENV === 'development',
    AUTH_SECRET: resolveSecret(raw.AUTH_SECRET, 'AUTH_SECRET'),
    AUTH_REFRESH_SECRET: resolveSecret(raw.AUTH_REFRESH_SECRET, 'AUTH_REFRESH_SECRET'),
    /** Replica spreadsheet id, accepting either spelling of the variable name. */
    GOOGLE_DB_SPREADSHEET_ID: (raw.GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID ?? raw.GOOGLE_SHEETS_Database_SPREADSHEET_ID ?? '').trim(),
    GOOGLE_DB_SYNC_ENABLED: raw.GOOGLE_SHEETS_SYNC_ENABLED === 'true',
    paths,
};
//# sourceMappingURL=env.js.map