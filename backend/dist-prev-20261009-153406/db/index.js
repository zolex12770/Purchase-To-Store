/**
 * Database access helpers used by every service.
 *
 * All SQL is parameterised ($1, $2 …) — string interpolation of user input is never
 * used anywhere in this codebase (SRS §25).
 */
import { getDatabase } from './driver.js';
export { getDatabase, closeDatabase, databaseLabel } from './driver.js';
/** Run a query on the ambient connection. */
export async function query(sql, params = []) {
    const db = await getDatabase();
    const res = await db.query(sql, params);
    return res.rows;
}
/** First row or `null`. */
export async function queryOne(sql, params = []) {
    const rows = await query(sql, params);
    return rows.length > 0 ? rows[0] : null;
}
/** Number of affected/returned rows. */
export async function execute(sql, params = []) {
    const db = await getDatabase();
    const res = await db.query(sql, params);
    return res.rowCount;
}
/** Run `fn` inside a transaction (see ADR-005 for why this is mandatory for documents). */
export async function withTransaction(fn) {
    const db = await getDatabase();
    return db.transaction(fn);
}
/** Query helper bound to a specific handle (pool or transaction). */
export async function txQuery(tx, sql, params = []) {
    const res = await tx.query(sql, params);
    return res.rows;
}
export async function txQueryOne(tx, sql, params = []) {
    const rows = await txQuery(tx, sql, params);
    return rows.length > 0 ? rows[0] : null;
}
/**
 * Builds a parameterised `WHERE` clause from a list of optional conditions.
 * Returns the clause plus the ordered parameter array.
 */
export class SqlBuilder {
    conditions = [];
    params = [];
    /** Adds `sql` (which may contain a single `?` placeholder) when `value` is present. */
    add(sql, value) {
        if (value === undefined || value === null || value === '')
            return this;
        this.params.push(value);
        this.conditions.push(sql.replace('?', `$${this.params.length}`));
        return this;
    }
    /** Adds a raw condition with no parameter. */
    addRaw(sql) {
        this.conditions.push(sql);
        return this;
    }
    /** Adds `column = ANY($n)` for a non-empty array. */
    addIn(column, values) {
        if (!values || values.length === 0)
            return this;
        this.params.push(values);
        this.conditions.push(`${column} = ANY($${this.params.length})`);
        return this;
    }
    /** Next placeholder index, for callers appending LIMIT/OFFSET. */
    push(value) {
        this.params.push(value);
        return `$${this.params.length}`;
    }
    where(prefix = 'WHERE') {
        return this.conditions.length === 0 ? '' : `${prefix} ${this.conditions.join(' AND ')}`;
    }
    and() {
        return this.conditions.length === 0 ? '' : `AND ${this.conditions.join(' AND ')}`;
    }
}
//# sourceMappingURL=index.js.map