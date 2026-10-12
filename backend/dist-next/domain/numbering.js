/**
 * Document numbering service (ADR-002, SRS §10, §41 of the build brief).
 *
 * Numbers are issued SERVER-SIDE ONLY, inside the caller's transaction, from a
 * counter row locked with FOR UPDATE. Two concurrent requests therefore serialise
 * on that row instead of racing, and a UNIQUE constraint on each document number
 * is the final backstop.
 */
import { txQueryOne } from '../db/index.js';
const DEFAULTS = {
    INDENT: { prefix: 'IND', padding: 4 },
    PO: { prefix: 'PO', padding: 4 },
    GRN: { prefix: 'GRN', padding: 4 },
    REQUISITION: { prefix: 'REQ', padding: 4 },
    ISSUE_SLIP: { prefix: 'ISS', padding: 4 },
};
/** `YYYYMMDD` in local time — the period the counter resets on. */
export function periodKeyFor(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}${m}${d}`;
}
/**
 * Reserves and returns the next document number for `docType`.
 * MUST be called inside a transaction — the reservation is only durable if the
 * document it names commits alongside it.
 */
export async function nextDocumentNumber(tx, docType, date = new Date()) {
    const periodKey = periodKeyFor(date);
    const fallback = DEFAULTS[docType];
    // Create the counter if this is the first document of the period. ON CONFLICT DO
    // NOTHING keeps it safe when two requests reach this line at the same moment.
    await tx.query(`INSERT INTO document_sequences (doc_type, period_key, prefix, padding, next_value)
     VALUES ($1, $2, $3, $4, 1)
     ON CONFLICT (doc_type, period_key) DO NOTHING`, [docType, periodKey, fallback.prefix, fallback.padding]);
    // Lock the counter, read it, then advance it. The lock is held until the caller's
    // transaction ends.
    const row = await txQueryOne(tx, `SELECT prefix, padding, next_value
       FROM document_sequences
      WHERE doc_type = $1 AND period_key = $2
      FOR UPDATE`, [docType, periodKey]);
    const prefix = row?.prefix ?? fallback.prefix;
    const padding = Number(row?.padding ?? fallback.padding);
    const value = Number(row?.next_value ?? 1);
    await tx.query(`UPDATE document_sequences
        SET next_value = $3, updated_at = now()
      WHERE doc_type = $1 AND period_key = $2`, [docType, periodKey, value + 1]);
    return `${prefix}-${periodKey}-${String(value).padStart(padding, '0')}`;
}
/**
 * Peeks at the number that would be issued next, without reserving it.
 * For UI preview only — never persist a peeked value.
 */
export async function peekDocumentNumber(tx, docType, date = new Date()) {
    const periodKey = periodKeyFor(date);
    const fallback = DEFAULTS[docType];
    const row = await txQueryOne(tx, `SELECT prefix, padding, next_value FROM document_sequences
      WHERE doc_type = $1 AND period_key = $2`, [docType, periodKey]);
    const prefix = row?.prefix ?? fallback.prefix;
    const padding = Number(row?.padding ?? fallback.padding);
    const value = Number(row?.next_value ?? 1);
    return `${prefix}-${periodKey}-${String(value).padStart(padding, '0')}`;
}
/** `HH:MM:SS` stamp for the document's `*_time` column. */
export function timeStamp(date = new Date()) {
    return date.toTimeString().slice(0, 8);
}
/** `YYYY-MM-DD` stamp for the document's `*_date` column. */
export function dateStamp(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}
/**
 * Normalises a DATE column's driver value to 'YYYY-MM-DD'. PGlite hands DATE
 * columns back as JS `Date` objects, not ISO strings — `String(dateObj)`
 * invokes `Date.prototype.toString()` ("Sun Aug 30 2026...") rather than an
 * ISO date, which silently corrupts anything that naively `.slice(0, 10)`s
 * it (a later `::date` cast rejects it outright; a display label just shows
 * the wrong text). Handles a plain ISO string input too, so callers never
 * need to know which shape they received.
 */
export function toDateOnly(v) {
    if (v instanceof Date)
        return dateStamp(v);
    const s = String(v);
    const m = /^\d{4}-\d{2}-\d{2}/.exec(s);
    return m ? m[0] : dateStamp(new Date(s));
}
//# sourceMappingURL=numbering.js.map