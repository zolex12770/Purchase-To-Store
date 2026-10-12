/**
 * Exact decimal arithmetic (ADR-004, SRS §20).
 *
 * The database owns the authoritative money maths — `final_rate` and `amount` are
 * GENERATED columns, so nothing here can disagree with a stored value. These helpers
 * exist for the paths that reach the database as text: import parsing, export
 * formatting, aggregation of already-fetched rows, and the preview totals a form
 * shows before it is saved.
 *
 * A monetary value NEVER passes through a JS `number` on its way to persistence.
 */
import Decimal from 'decimal.js';
// 28 significant digits comfortably exceeds NUMERIC(18,4); ROUND_HALF_UP matches
// PostgreSQL's `round(numeric, int)` behaviour.
Decimal.set({ precision: 28, rounding: Decimal.ROUND_HALF_UP, toExpNeg: -30, toExpPos: 30 });
export const QTY_DP = 4;
export const RATE_DP = 4;
export const AMOUNT_DP = 2;
export function dec(value) {
    if (value === null || value === undefined || value === '')
        return new Decimal(0);
    if (value instanceof Decimal)
        return value;
    try {
        const d = new Decimal(typeof value === 'number' ? value.toString() : String(value).trim());
        return d.isFinite() ? d : new Decimal(0);
    }
    catch {
        return new Decimal(0);
    }
}
/** Fixed-decimal string suitable for a NUMERIC parameter. */
export function toNumeric(value, dp) {
    return dec(value).toFixed(dp, Decimal.ROUND_HALF_UP);
}
export const toQty = (v) => toNumeric(v, QTY_DP);
export const toRate = (v) => toNumeric(v, RATE_DP);
export const toAmount = (v) => toNumeric(v, AMOUNT_DP);
/**
 * `final_rate = round(rate × (1 − discount% / 100), 4)`
 * Mirrors the generated column in `purchase_order_lines` exactly.
 */
export function finalRate(rate, discountPct) {
    const r = dec(rate);
    const d = dec(discountPct);
    return r.times(new Decimal(1).minus(d.div(100))).toFixed(RATE_DP, Decimal.ROUND_HALF_UP);
}
/**
 * `amount = round(qty × final_rate, 2)`
 * Mirrors the generated column in `purchase_order_lines` exactly.
 */
export function lineAmount(qty, rate, discountPct) {
    const fr = new Decimal(finalRate(rate, discountPct));
    return dec(qty).times(fr).toFixed(AMOUNT_DP, Decimal.ROUND_HALF_UP);
}
export function sum(values, dp = AMOUNT_DP) {
    return values.reduce((acc, v) => acc.plus(dec(v)), new Decimal(0)).toFixed(dp, Decimal.ROUND_HALF_UP);
}
export function gt(a, b) { return dec(a).greaterThan(dec(b)); }
export function gte(a, b) { return dec(a).greaterThanOrEqualTo(dec(b)); }
export function lte(a, b) { return dec(a).lessThanOrEqualTo(dec(b)); }
export function isPositive(a) { return dec(a).greaterThan(0); }
export function isZero(a) { return dec(a).isZero(); }
export function minus(a, b, dp = QTY_DP) {
    return dec(a).minus(dec(b)).toFixed(dp, Decimal.ROUND_HALF_UP);
}
/**
 * Splits `total` across `count` labels with NO loss and NO duplication — the
 * returned quantities always sum to exactly `total` (GRN reconstruction,
 * "No. of Label" vs "Label Qty"). Whole units are spread as evenly as
 * possible, with the first `remainder` labels getting one extra whole unit
 * (e.g. 150 across 14 labels -> ten labels of 11, four of 10, never a naive
 * 150/14 that drops the remainder). Any leftover fraction — only possible for
 * a non-integer total, e.g. a weight/volume UOM — is placed entirely on the
 * LAST label so every earlier label stays a clean whole number.
 */
export function distributeQty(total, count) {
    const t = dec(total);
    if (count <= 1)
        return [toQty(t)];
    const wholeUnits = t.toDecimalPlaces(0, Decimal.ROUND_DOWN);
    const fraction = t.minus(wholeUnits);
    const base = wholeUnits.dividedToIntegerBy(count);
    const remainder = wholeUnits.minus(base.times(count)).toNumber();
    const out = [];
    for (let i = 0; i < count; i++)
        out.push(i < remainder ? base.plus(1) : base);
    if (!fraction.isZero())
        out[out.length - 1] = out[out.length - 1].plus(fraction);
    return out.map((v) => v.toFixed(QTY_DP, Decimal.ROUND_HALF_UP));
}
/** Percentage change, guarding division by zero. Returns `null` when undefined. */
export function pctChange(current, previous) {
    const p = dec(previous);
    if (p.isZero())
        return null;
    return dec(current).minus(p).div(p).times(100).toDecimalPlaces(2).toNumber();
}
/** Share of a total as a percentage, guarding division by zero. */
export function shareOf(part, total) {
    const t = dec(total);
    if (t.isZero())
        return 0;
    return dec(part).div(t).times(100).toDecimalPlaces(2).toNumber();
}
/**
 * Parses a quantity/rate from spreadsheet or CSV input.
 * Tolerates thousands separators, currency symbols, blank strings and `(123)`
 * negative notation; returns `null` when the cell does not contain a number.
 */
export function parseNumericInput(raw) {
    if (raw === null || raw === undefined)
        return null;
    if (typeof raw === 'number')
        return Number.isFinite(raw) ? raw.toString() : null;
    const text = String(raw).trim();
    if (text === '' || text === '-')
        return null;
    const negative = /^\(.*\)$/.test(text);
    const cleaned = text
        .replace(/^\(|\)$/g, '')
        .replace(/[₹$€£,\s]/g, '')
        .replace(/[^0-9.\-]/g, '');
    if (cleaned === '' || cleaned === '-' || cleaned === '.')
        return null;
    try {
        const d = new Decimal(cleaned);
        if (!d.isFinite())
            return null;
        return (negative ? d.negated() : d).toString();
    }
    catch {
        return null;
    }
}
/** Indian-format display string (12,34,567.89). Presentation only. */
export function formatIndian(value, dp = AMOUNT_DP) {
    const d = dec(value);
    const negative = d.isNegative();
    const [intPart, fracPart] = d.abs().toFixed(dp).split('.');
    const digits = intPart ?? '0';
    let formatted;
    if (digits.length <= 3) {
        formatted = digits;
    }
    else {
        const last3 = digits.slice(-3);
        const rest = digits.slice(0, -3);
        formatted = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
    }
    const out = fracPart ? `${formatted}.${fracPart}` : formatted;
    return negative ? `-${out}` : out;
}
//# sourceMappingURL=money.js.map