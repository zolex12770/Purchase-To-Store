/**
 * The contract a Google business tab is declared against.
 *
 * A header and its SQL expression are declared as ONE pair, so the sheet's
 * column titles and the query that fills them cannot drift apart.
 *
 * Two things carry the redesign:
 *
 *  • `columns[].cls` records WHY a column is exported (business / reporting /
 *    import / traceability). A column that cannot be justified as one of those
 *    is technical-only and does not belong in Google at all — the classification
 *    is part of the declaration rather than a document that rots beside it.
 *
 *  • `sources[]` says, for every SQL table that can affect this tab, exactly
 *    which sheet rows a change to it touches. That is what removes whole-tab
 *    rewrites: previously any table without an explicit row mapping fell back
 *    to re-exporting the entire sheet, so editing one unit-of-measure rewrote
 *    all 12,461 rows of Item Master.
 */
export function fieldColumn(f) {
    return typeof f === 'string' ? f : f.column;
}
export function fieldLookup(f) {
    return typeof f === 'string' ? null : f.lookup;
}
/** Double-quotes an identifier for use as a SQL alias. */
export function quoteIdent(name) {
    return `"${name.replace(/"/g, '""')}"`;
}
/** The full SELECT for a tab. */
export function buildViewSql(view) {
    const select = view.columns.map((c) => `${c.expr} AS ${quoteIdent(c.header)}`).join(',\n       ');
    return [
        `SELECT ${select}`,
        `  FROM ${view.from}`,
        view.where ? ` WHERE ${view.where}` : '',
        ` ORDER BY ${view.orderBy}`,
    ].filter(Boolean).join('\n');
}
/**
 * One page of a tab, by ascending order.
 *
 * Paging is not a nicety here: PGlite runs inside the ERP's own process, so
 * materialising 100,000 rows would stall every concurrent HTTP request. The
 * export walks a tab in slices and yields between them.
 */
export function buildPagedSql(view, limit, offset) {
    return `${buildViewSql(view)}\n LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}
/**
 * Rows of a tab affected by a change, per a source binding's predicate.
 *
 * The predicate is spliced into the view's own WHERE — not wrapped around the
 * finished view — so the database restricts the base tables first. Wrapping
 * instead would leave the planner free to materialise all 12,461 item rows and
 * discard 12,460 of them, which is precisely the cost this redesign removes.
 *
 * No ORDER BY: a targeted refresh addresses rows by their recorded sheet
 * position, so sorting them would be work with no effect.
 */
export function buildRestrictedSql(view, restrict, limit) {
    const select = view.columns.map((c) => `${c.expr} AS ${quoteIdent(c.header)}`).join(',\n       ');
    const where = [view.where, restrict].filter(Boolean).map((w) => `(${w})`).join(' AND ');
    return `SELECT ${select}\n  FROM ${view.from}\n WHERE ${where}\n LIMIT ${Number(limit)}`;
}
/** COUNT of the rows a change would touch — used only to detect a large fan-out. */
export function buildRestrictedCountSql(view, restrict) {
    const where = [view.where, restrict].filter(Boolean).map((w) => `(${w})`).join(' AND ');
    return `SELECT COUNT(*)::int AS n FROM ${view.from} WHERE ${where}`;
}
/** COUNT(*) for a tab, used for progress and for reconciliation. */
export function buildCountSql(view) {
    return `SELECT COUNT(*)::int AS n FROM ${view.from}${view.where ? ` WHERE ${view.where}` : ''}`;
}
export function headersOf(view) {
    return view.columns.map((c) => c.header);
}
//# sourceMappingURL=types.js.map