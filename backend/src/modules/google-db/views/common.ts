/**
 * Shared SQL fragments for the business tabs.
 *
 * The date helpers are not cosmetic. PGlite's driver registers type parsers for
 * numeric and int8 only, so a DATE column arrives as a JS Date at LOCAL
 * midnight; rendering that with toISOString() on an IST server moves every
 * document one calendar day EARLIER ("2026-09-03" exported as
 * "2026-09-02T18:30:00.000Z"), and a controlled import then writes the shifted
 * date back into SQL. Formatting in the database instead means the cell holds
 * exactly the calendar date Postgres stored, with no driver or timezone in the
 * path at all — and it reads as a date to a human, which is the point of the
 * sheet.
 */

/** A DATE column, as the stored calendar date. */
export const d = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD')`;

/** A TIMESTAMPTZ column, to the minute. */
export const ts = (expr: string) => `to_char(${expr}, 'YYYY-MM-DD HH24:MI')`;

/** A quantity — trailing zeros trimmed so a sheet shows 6, not 6.0000. */
export const qty = (expr: string) => `trim_scale(${expr})`;

/** A money value, always to 2 decimals. */
export const money = (expr: string) => `to_char(${expr}, 'FM9999999999990.00')`;

/**
 * A lookup's HUMAN value.
 *
 * `code` rather than `name` for UOM specifically, because that is what every
 * ERP surface shows under a column headed "UOM" — the item list, every
 * Indent/PO/GRN/Requisition line table, the print documents and the Excel
 * exports all render lookups.code ("NOS"), not lookups.name ("Numbers"). A
 * replica that disagreed with the screen would be reconciled against the screen
 * and lose. The full name stays one lookup away on the Lookup & Configuration
 * tab rather than being repeated down 12,461 item rows.
 */
export const UOM_EXPR = 'code';

/** Yes/No is friendlier than TRUE/FALSE, and the importer accepts both. */
export const yesNo = (expr: string) => `CASE WHEN ${expr} THEN 'Yes' ELSE 'No' END`;
