/**
 * Migration runner.
 *
 * Applies every `.sql` file in `migrations/` exactly once, in filename order, each inside
 * a single transaction. Applied migrations are recorded in `schema_migrations` together
 * with a checksum, so an already-applied migration that is later edited is reported as a
 * hard error rather than silently diverging from the live schema.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { getDatabase } from './driver.js';
import { logger } from '../core/logger.js';
const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(here, 'migrations');
/**
 * Splits a SQL script into individual statements.
 * Respects single-quoted strings, dollar-quoted blocks, line comments and block comments,
 * so a semicolon inside any of those does not split the statement.
 */
export function splitStatements(sql) {
    const out = [];
    let buf = '';
    let i = 0;
    while (i < sql.length) {
        const ch = sql[i];
        const next = sql[i + 1];
        // line comment
        if (ch === '-' && next === '-') {
            const nl = sql.indexOf('\n', i);
            const end = nl === -1 ? sql.length : nl;
            buf += sql.slice(i, end);
            i = end;
            continue;
        }
        // block comment
        if (ch === '/' && next === '*') {
            const end = sql.indexOf('*/', i + 2);
            const stop = end === -1 ? sql.length : end + 2;
            buf += sql.slice(i, stop);
            i = stop;
            continue;
        }
        // single-quoted string (with '' escape)
        if (ch === "'") {
            let j = i + 1;
            while (j < sql.length) {
                if (sql[j] === "'" && sql[j + 1] === "'") {
                    j += 2;
                    continue;
                }
                if (sql[j] === "'") {
                    j += 1;
                    break;
                }
                j += 1;
            }
            buf += sql.slice(i, j);
            i = j;
            continue;
        }
        // double-quoted identifier
        if (ch === '"') {
            let j = i + 1;
            while (j < sql.length && sql[j] !== '"')
                j += 1;
            buf += sql.slice(i, j + 1);
            i = j + 1;
            continue;
        }
        // dollar-quoted block: $tag$ ... $tag$
        if (ch === '$') {
            const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
            if (m) {
                const tag = m[0];
                const end = sql.indexOf(tag, i + tag.length);
                const stop = end === -1 ? sql.length : end + tag.length;
                buf += sql.slice(i, stop);
                i = stop;
                continue;
            }
        }
        if (ch === ';') {
            const stmt = buf.trim();
            if (stmt.length > 0)
                out.push(stmt);
            buf = '';
            i += 1;
            continue;
        }
        buf += ch;
        i += 1;
    }
    const tail = buf.trim();
    if (tail.length > 0)
        out.push(tail);
    // Drop statements that are only comments/whitespace.
    return out.filter((s) => s.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().length > 0);
}
async function runScript(tx, sql, label) {
    const statements = splitStatements(sql);
    for (const [idx, stmt] of statements.entries()) {
        try {
            await tx.query(stmt);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new Error(`${label}: statement ${idx + 1}/${statements.length} failed: ${message}\n--- SQL ---\n${stmt.slice(0, 600)}`);
        }
    }
}
/**
 * Reports which migrations would be applied, WITHOUT applying any of them.
 *
 * Deploy pipelines need to know whether a release carries a schema change
 * before they take traffic down; asking by running the migration is not an
 * acceptable way to find out.
 *
 * Uses the same checksum rule as `runMigrations`, so a file that was edited
 * after being applied is reported here rather than discovered mid-deploy.
 */
export async function pendingMigrations() {
    const db = await getDatabase();
    await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    }
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const existing = await db.query('SELECT version, checksum FROM schema_migrations');
    const appliedMap = new Map(existing.rows.map((r) => [r.version, r.checksum]));
    const pending = [];
    const applied = [];
    const changed = [];
    for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
        const prior = appliedMap.get(version);
        if (!prior)
            pending.push(version);
        else if (prior !== checksum)
            changed.push(version);
        else
            applied.push(version);
    }
    return { pending, applied, changed };
}
export async function runMigrations(options = {}) {
    const db = await getDatabase();
    await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      duration_ms INTEGER NOT NULL DEFAULT 0
    )
  `);
    if (!fs.existsSync(MIGRATIONS_DIR)) {
        throw new Error(`Migrations directory not found: ${MIGRATIONS_DIR}`);
    }
    const files = fs
        .readdirSync(MIGRATIONS_DIR)
        .filter((f) => f.endsWith('.sql'))
        .sort();
    const existing = await db.query('SELECT version, checksum FROM schema_migrations');
    const appliedMap = new Map(existing.rows.map((r) => [r.version, r.checksum]));
    const applied = [];
    const skipped = [];
    for (const file of files) {
        const version = file.replace(/\.sql$/, '');
        const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
        const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
        const prior = appliedMap.get(version);
        if (prior) {
            if (prior !== checksum) {
                throw new Error(`Migration ${version} has already been applied but its file has changed ` +
                    `(checksum ${prior.slice(0, 12)} → ${checksum.slice(0, 12)}). ` +
                    `Add a new migration instead of editing an applied one, or run \`npm run db:reset\` in development.`);
            }
            skipped.push(version);
            continue;
        }
        const started = Date.now();
        await db.transaction(async (tx) => {
            await runScript(tx, sql, `Migration ${version}`);
            await tx.query('INSERT INTO schema_migrations (version, checksum, duration_ms) VALUES ($1, $2, $3)', [version, checksum, Date.now() - started]);
        });
        applied.push(version);
        if (!options.silent)
            logger.info(`  ✓ migration ${version} (${Date.now() - started}ms)`);
    }
    return { applied, skipped };
}
//# sourceMappingURL=migrate.js.map