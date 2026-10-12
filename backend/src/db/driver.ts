/**
 * Database driver adapter (ADR-001).
 *
 * One SQL dialect (PostgreSQL), two interchangeable backends:
 *   • pglite — embedded PostgreSQL 18 (WASM), zero external setup, data outside the repo
 *   • pg     — a real PostgreSQL server, for production / horizontal scale
 *
 * The adapter exposes ONLY query/transaction/close. No business logic and no dialect
 * branching lives here: the same SQL text and the same migrations run on both backends.
 */
import path from 'node:path';
import fs from 'node:fs';
import { env, paths } from '../config/env.js';

export interface QueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

/** A handle that can run SQL. Both the pool and a transaction satisfy this. */
export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<QueryResult<T>>;
}

export interface Database extends Queryable {
  /**
   * Runs `fn` inside a single database transaction.
   * Commits on resolve, ROLLBACKs on throw. Nested calls reuse the outer transaction
   * so a service method can be composed without accidentally committing early.
   */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly driver: 'pglite' | 'pg';
  readonly location: string;
}

/* ────────────────────────────── PGlite backend ─────────────────────────────── */

/**
 * Guards the embedded data directory against a second process opening it.
 *
 * PGlite is a single-writer engine: two processes on one directory corrupts it.
 * `tsx watch` restarts and stray CLI runs are the realistic causes, so the lock
 * is explicit and its error message says exactly what to do.
 */
/** A lock not refreshed within this window is treated as abandoned. */
const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;

interface LockFile {
  pid: number;
  /** Refreshed on a timer while the holder is alive. */
  heartbeat: number;
  startedAt: number;
}

/** Reads the current holder, or `null` if the lock is free/unreadable. */
function readHolder(lockPath: string): LockFile | null {
  if (!fs.existsSync(lockPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockFile;
  } catch {
    return null; // unreadable or legacy format — treat as abandoned
  }
}

/**
 * `true` while another process demonstrably holds the lock.
 *
 * A PID alone is not a reliable liveness signal — Windows recycles PIDs quickly,
 * so a dead holder's id may belong to an unrelated process. The holder refreshes
 * a heartbeat, and a lock that has stopped ticking is reclaimed.
 */
function isHeldByAnother(lockPath: string): LockFile | null {
  const held = readHolder(lockPath);
  if (!held || held.pid === process.pid) return null;

  const age = Date.now() - (held.heartbeat ?? 0);
  let pidAlive = false;
  try {
    process.kill(held.pid, 0); // signal 0 tests existence without killing
    pidAlive = true;
  } catch {
    pidAlive = false;
  }

  return pidAlive && age < LOCK_STALE_MS ? held : null;
}

export interface LockStatus {
  state: 'free' | 'held' | 'stale' | 'unreadable';
  pid?: number;
  /** Seconds since the holder last refreshed its heartbeat. */
  ageSeconds?: number;
}

/**
 * Reports who holds the data-directory lock.
 *
 * Exported so diagnostics describe the lock with the SAME rule the driver uses
 * to honour it. They previously disagreed — the doctor parsed the file as a bare
 * PID while the driver wrote JSON, so every live lock was reported as stale.
 */
export function inspectDirectoryLock(dir: string): LockStatus {
  const lockPath = path.join(dir, '.zolex.lock');
  if (!fs.existsSync(lockPath)) return { state: 'free' };

  const held = readHolder(lockPath);
  if (!held || typeof held.pid !== 'number' || !Number.isFinite(held.pid)) {
    return { state: 'unreadable' };
  }

  const ageSeconds = Math.round((Date.now() - (held.heartbeat ?? 0)) / 1000);
  let pidAlive = false;
  try { process.kill(held.pid, 0); pidAlive = true; } catch { pidAlive = false; }

  const live = pidAlive && ageSeconds * 1000 < LOCK_STALE_MS;
  return { state: live ? 'held' : 'stale', pid: held.pid, ageSeconds };
}

/** How long a starting process waits for a departing one to let go. */
const LOCK_WAIT_MS = 20_000;

async function acquireDirectoryLock(dir: string): Promise<() => void> {
  const lockPath = path.join(dir, '.zolex.lock');

  // A dev-server restart briefly overlaps the outgoing process, so wait for it to
  // release rather than failing instantly. Only a genuinely persistent holder is
  // treated as an error.
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = isHeldByAnother(lockPath);
  let waited = false;

  while (held && Date.now() < deadline) {
    waited = true;
    await new Promise((r) => setTimeout(r, 500));
    held = isHeldByAnother(lockPath);
  }

  if (held) {
    throw new Error(
      `The Zolex database at ${dir} is already open by process ${held.pid}.\n` +
        `        The embedded engine allows only one process at a time.\n` +
        `        Stop the other backend (or CLI command) and try again.`,
    );
  }
  if (waited) {
    // eslint-disable-next-line no-console
    console.log('[zolex] waited for the previous process to release the database');
  }

  const write = () => {
    const payload: LockFile = { pid: process.pid, heartbeat: Date.now(), startedAt: Date.now() };
    try {
      fs.writeFileSync(lockPath, JSON.stringify(payload), 'utf8');
    } catch { /* directory is being rebuilt */ }
  };
  write();

  const timer = setInterval(write, LOCK_HEARTBEAT_MS);
  timer.unref?.(); // never hold the event loop open

  const release = () => {
    clearInterval(timer);
    try {
      const held = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as LockFile;
      if (held.pid === process.pid) fs.unlinkSync(lockPath);
    } catch { /* already gone, or claimed by someone else */ }
  };
  process.once('exit', release);
  return release;
}

/**
 * Turns PGlite's opaque WASM abort into an actionable diagnosis.
 *
 * The realistic cause is an unclean kill (taskkill /F, a power loss, a crashed
 * watch restart) leaving the write-ahead log without a valid checkpoint, which
 * PostgreSQL cannot auto-repair.
 */
function describeOpenFailure(dir: string, err: unknown): Error {
  const raw = err instanceof Error ? err.message : String(err);
  const looksLikeCrashDamage = /Aborted|abort|PANIC|checkpoint/i.test(raw);

  if (!looksLikeCrashDamage) {
    return new Error(`Could not open the Zolex database at ${dir}: ${raw}`);
  }

  return new Error(
    `The Zolex database at ${dir} could not be opened.\n\n` +
      `  Diagnosis: the embedded PostgreSQL data directory did not shut down cleanly and its\n` +
      `  write-ahead log has no valid checkpoint, so crash recovery cannot complete. This is\n` +
      `  almost always caused by the process being force-killed mid-write.\n\n` +
      `  Recovery options, in order of preference:\n` +
      `    1. Restore the most recent backup from ${paths.backups}\n` +
      `       (npm run db:restore -- <filename>)\n` +
      `    2. Rebuild an empty database:  npm run db:reset\n` +
      `       This DISCARDS the current contents.\n\n` +
      `  To avoid this in future, stop the server with Ctrl+C rather than killing it, and for\n` +
      `  production use a real PostgreSQL server (DB_DRIVER=pg) — see docs/09_DEPLOYMENT.md.\n\n` +
      `  Underlying error: ${raw}`,
  );
}

async function createPgliteDatabase(): Promise<Database> {
  const { PGlite } = await import('@electric-sql/pglite');
  const dir = paths.database;
  fs.mkdirSync(dir, { recursive: true });

  const releaseLock = await acquireDirectoryLock(dir);

  let pg: InstanceType<typeof PGlite>;
  try {
    pg = new PGlite(dir);
    await pg.waitReady;
  } catch (err) {
    releaseLock();
    throw describeOpenFailure(dir, err);
  }

  // PGlite is a single in-process writer. Serialise transactions through a promise
  // chain so two concurrent HTTP requests can never interleave BEGIN/COMMIT blocks.
  let chain: Promise<unknown> = Promise.resolve();

  const db: Database = {
    driver: 'pglite',
    location: dir,

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await pg.query<T>(sql, params as never[]);
      return { rows: res.rows as T[], rowCount: res.rows.length };
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const run = async (): Promise<T> =>
        pg.transaction(async (tx) => {
          const handle: Queryable = {
            async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
              const res = await tx.query<R>(sql, params as never[]);
              return { rows: res.rows as R[], rowCount: res.rows.length };
            },
          };
          return fn(handle);
        }) as Promise<T>;

      const next = chain.then(run, run);
      // Keep the chain alive even when this transaction rejects.
      chain = next.catch(() => undefined);
      return next;
    },

    async close() {
      await chain.catch(() => undefined);
      await pg.close();
      releaseLock();
    },
  };

  return db;
}

/* ──────────────────────────── node-postgres backend ────────────────────────── */

async function createPgDatabase(): Promise<Database> {
  const pgModule = await import('pg');
  const { Pool, types } = pgModule.default ?? pgModule;

  // Return NUMERIC/DECIMAL as string, never as a JS float (ADR-004).
  types.setTypeParser(1700, (v: string) => v);
  // int8 as string to avoid precision loss; we cast to ::int explicitly where we want a number.
  types.setTypeParser(20, (v: string) => v);

  const pool = new Pool({
    connectionString: env.DATABASE_URL,
    max: env.DB_POOL_MAX,
    application_name: 'zolex-erp',
  });

  const db: Database = {
    driver: 'pg',
    location: (env.DATABASE_URL ?? '').replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@'),

    async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []) {
      const res = await pool.query(sql, params as never[]);
      return { rows: res.rows as T[], rowCount: res.rowCount ?? res.rows.length };
    },

    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const handle: Queryable = {
          async query<R = Record<string, unknown>>(sql: string, params: unknown[] = []) {
            const res = await client.query(sql, params as never[]);
            return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
          },
        };
        const result = await fn(handle);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
      }
    },

    async close() {
      await pool.end();
    },
  };

  return db;
}

/* ─────────────────────────────── Singleton ─────────────────────────────────── */

let instance: Database | null = null;
let opening: Promise<Database> | null = null;

export async function getDatabase(): Promise<Database> {
  if (instance) return instance;
  if (!opening) {
    opening = (env.DB_DRIVER === 'pg' ? createPgDatabase() : createPgliteDatabase())
      .then((db) => {
        instance = db;
        return db;
      })
      .catch((err: unknown) => {
        // A failed open must NOT poison the singleton: recovery tooling repairs the
        // directory and calls back in, and it has to get a fresh attempt.
        opening = null;
        throw err;
      });
  }
  return opening;
}

export async function closeDatabase(): Promise<void> {
  if (instance) {
    const db = instance;
    instance = null;
    opening = null;
    await db.close();
  }
}

export const databaseLabel = () =>
  env.DB_DRIVER === 'pglite'
    ? `embedded PostgreSQL (PGlite) @ ${path.resolve(paths.database)}`
    : `PostgreSQL server @ ${(env.DATABASE_URL ?? '').replace(/:\/\/([^:]+):[^@]+@/, '://$1:***@')}`;
