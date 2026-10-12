/**
 * Dates render as ISO so a sheet reads unambiguously regardless of the viewer's
 * locale; objects as JSON; null as an EMPTY cell — never the text "null", which
 * would import back as the four-character string.
 */
export function toCell(value) {
    if (value === null || value === undefined)
        return '';
    if (value instanceof Date)
        return value.toISOString();
    if (typeof value === 'boolean')
        return value ? 'TRUE' : 'FALSE';
    if (typeof value === 'object')
        return JSON.stringify(value);
    return String(value);
}
export function headerOf(view) {
    return view.columns.map((c) => c.header);
}
export function cellsOf(view, row) {
    return view.columns.map((c) => toCell(row[c.header]));
}
//# sourceMappingURL=render.js.map