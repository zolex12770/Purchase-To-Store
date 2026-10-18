/**
 * Rules of the inventory screens' forms that are kept out of the components so they can be
 * tested without a browser: matching an id from the API, the physical count's pre-fill and
 * the movement form's rate.
 */

/**
 * Whether two ids are the same id, whichever form each arrived in. PGlite returns bigint ids
 * as numbers; a PostgreSQL server (DB_DRIVER=pg) returns them as strings (backend
 * db/driver.ts parses int8 as text), so a strict `===` between an API id and `Number(...)`
 * never matched there: the header item picker could choose nothing (T2 review).
 */
export function sameId(a: unknown, b: unknown): boolean {
  return a !== null && a !== undefined && b !== null && b !== undefined && String(a) === String(b);
}

/** The row whose id is `id` (see sameId). */
export function rowById<T extends { id: unknown }>(rows: readonly T[], id: unknown): T | undefined {
  return rows.find((r) => sameId(r.id, id));
}

/**
 * The physical count field once the book stock is read, or read again. A figure the counter
 * typed stays as typed. A field the counter has not touched shows the book stock, and follows
 * it when that figure changes: it kept the first figure, so after a count was refused because
 * a receipt had been posted meanwhile (book stock 26 -> 27), the untouched 26 showed as a
 * shortfall of 1 that nobody counted, and a second Post wrote the receipt off (T2 review of
 * E2E S5-18, probe C10-STALE).
 */
export function countAfterBookRead(count: string, typed: boolean, bookStock: number | null): string {
  if (typed || bookStock === null) return count;
  return String(bookStock);
}

/**
 * The movement form's rate once an item is chosen. A rate the user typed stays; otherwise the
 * field shows the chosen item's own sheet rate, or nothing when it has none. Only an empty
 * field was filled, so choosing a second item kept the first item's rate and the receipt was
 * stored at it (T2 review, probe C28-RATE: 1161110001 received at 8 instead of its 21).
 */
export function rateAfterItemChoice(rate: string, typed: boolean, itemRate: number | null | undefined): string {
  if (typed && rate.trim() !== '') return rate;
  return itemRate ? String(itemRate) : '';
}
