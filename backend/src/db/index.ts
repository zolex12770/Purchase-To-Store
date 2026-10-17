/**
 * Database access helpers used by every service.
 *
 * All SQL is parameterised ($1, $2 …) — string interpolation of user input is never
 * used anywhere in this codebase (SRS §25).
 */
import { getDatabase, type Queryable, type Database } from './driver.js';

export { getDatabase, closeDatabase, databaseLabel, type Queryable, type Database } from './driver.js';

/** Run a query on the ambient connection. */
export async function query<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = await getDatabase();
  const res = await db.query<T>(sql, params);
  return res.rows;
}

/** First row or `null`. */
export async function queryOne<T = Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(sql, params);
  return rows.length > 0 ? (rows[0] as T) : null;
}

/** Number of affected/returned rows. */
export async function execute(sql: string, params: unknown[] = []): Promise<number> {
  const db = await getDatabase();
  const res = await db.query(sql, params);
  return res.rowCount;
}

/** Run `fn` inside a transaction (see ADR-005 for why this is mandatory for documents). */
export async function withTransaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const db: Database = await getDatabase();
  return db.transaction(fn);
}

/**
 * Runs `fn` in a read-only transaction whose statements all read one snapshot, for
 * figures that must add up to one another (the receipt evidence summary's parts and
 * their whole). On a PostgreSQL server a plain BEGIN is READ COMMITTED, where each
 * statement takes a fresh snapshot and a GRN posted between two of them shows in one
 * and not the other; PGlite runs one transaction at a time, so there it changes nothing.
 */
export async function withSnapshot<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
  return withTransaction(async (tx) => {
    await tx.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    return fn(tx);
  });
}

/** Query helper bound to a specific handle (pool or transaction). */
export async function txQuery<T = Record<string, unknown>>(
  tx: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await tx.query<T>(sql, params);
  return res.rows;
}

export async function txQueryOne<T = Record<string, unknown>>(
  tx: Queryable,
  sql: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await txQuery<T>(tx, sql, params);
  return rows.length > 0 ? (rows[0] as T) : null;
}

/**
 * Builds a parameterised `WHERE` clause from a list of optional conditions.
 * Returns the clause plus the ordered parameter array.
 */
export class SqlBuilder {
  private readonly conditions: string[] = [];
  readonly params: unknown[] = [];

  /** Adds `sql` (which may contain a single `?` placeholder) when `value` is present. */
  add(sql: string, value?: unknown): this {
    if (value === undefined || value === null || value === '') return this;
    this.params.push(value);
    this.conditions.push(sql.replace('?', `$${this.params.length}`));
    return this;
  }

  /** Adds a raw condition with no parameter. */
  addRaw(sql: string): this {
    this.conditions.push(sql);
    return this;
  }

  /** Adds `column = ANY($n)` for a non-empty array. */
  addIn(column: string, values?: unknown[]): this {
    if (!values || values.length === 0) return this;
    this.params.push(values);
    this.conditions.push(`${column} = ANY($${this.params.length})`);
    return this;
  }

  /** Next placeholder index, for callers appending LIMIT/OFFSET. */
  push(value: unknown): string {
    this.params.push(value);
    return `$${this.params.length}`;
  }

  where(prefix = 'WHERE'): string {
    return this.conditions.length === 0 ? '' : `${prefix} ${this.conditions.join(' AND ')}`;
  }

  and(): string {
    return this.conditions.length === 0 ? '' : `AND ${this.conditions.join(' AND ')}`;
  }
}
