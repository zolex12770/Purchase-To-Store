/**
 * Financial calculation tests (SRS §28, §42 of the build brief).
 *
 * These assert the property that matters: money maths is EXACT. Anything that
 * would be wrong under IEEE-754 floating point must be right here.
 */
import { describe, it, expect } from 'vitest';
import { dec, toQty, toRate, toAmount, finalRate, lineAmount, sum, minus, pctChange, shareOf, parseNumericInput, formatIndian, distributeQty, } from './money.js';
describe('exact decimal arithmetic', () => {
    it('adds values that float arithmetic gets wrong', () => {
        // 0.1 + 0.2 === 0.30000000000000004 in IEEE-754.
        expect(sum(['0.1', '0.2'], 4)).toBe('0.3000');
        expect(dec('0.1').plus(dec('0.2')).equals(dec('0.3'))).toBe(true);
    });
    it('multiplies rate × quantity without drift', () => {
        // 1.1 * 3 === 3.3000000000000003 in IEEE-754.
        expect(lineAmount('3', '1.1', '0')).toBe('3.30');
        expect(lineAmount('1000000', '0.07', '0')).toBe('70000.00');
    });
    it('keeps large enterprise values precise', () => {
        expect(lineAmount('999999', '18650.7500', '0')).toBe('18650731349.25');
    });
});
describe('finalRate — mirrors the generated column', () => {
    it('applies a whole-number discount', () => {
        expect(finalRate('100', '10')).toBe('90.0000');
        expect(finalRate('1250.50', '5')).toBe('1187.9750');
    });
    it('applies a fractional discount', () => {
        expect(finalRate('100', '12.5')).toBe('87.5000');
        expect(finalRate('2480.5', '7.5')).toBe('2294.4625');
    });
    it('handles the zero and full-discount boundaries', () => {
        expect(finalRate('500', '0')).toBe('500.0000');
        expect(finalRate('500', '100')).toBe('0.0000');
    });
    it('rounds half up to four places, as PostgreSQL round() does', () => {
        expect(finalRate('1', '0.00005')).toBe('1.0000');
        expect(finalRate('3.33335', '0')).toBe('3.3334');
    });
});
describe('lineAmount — mirrors the generated column', () => {
    it('computes qty × final rate to two places', () => {
        expect(lineAmount('60', '100', '10')).toBe('5400.00');
        expect(lineAmount('25', '90', '0')).toBe('2250.00');
    });
    it('handles fractional quantities', () => {
        expect(lineAmount('2.5', '99.99', '0')).toBe('249.98');
        expect(lineAmount('0.3333', '3', '0')).toBe('1.00');
    });
    it('returns zero for a zero quantity', () => {
        expect(lineAmount('0', '5000', '10')).toBe('0.00');
    });
    it('agrees with the two-step calculation', () => {
        const cases = [
            ['17', '243.7777', '13.25'],
            ['1', '0.0001', '99.99'],
            ['12345', '6789.4321', '7.5'],
        ];
        for (const [q, r, d] of cases) {
            const twoStep = dec(q).times(dec(finalRate(r, d))).toFixed(2);
            expect(lineAmount(q, r, d)).toBe(twoStep);
        }
    });
});
describe('scale helpers', () => {
    it('fixes quantities at 4 places and amounts at 2', () => {
        expect(toQty('10')).toBe('10.0000');
        expect(toRate('99.999999')).toBe('100.0000');
        expect(toAmount('1234.567')).toBe('1234.57');
    });
    it('subtracts balances exactly', () => {
        expect(minus('100', '60')).toBe('40.0000');
        expect(minus('0.3', '0.1')).toBe('0.2000');
    });
});
describe('percentages', () => {
    it('computes change and guards division by zero', () => {
        expect(pctChange(150, 100)).toBe(50);
        expect(pctChange(75, 100)).toBe(-25);
        expect(pctChange(100, 0)).toBeNull();
    });
    it('computes share and guards division by zero', () => {
        expect(shareOf(25, 100)).toBe(25);
        expect(shareOf(1, 3)).toBeCloseTo(33.33, 2);
        expect(shareOf(5, 0)).toBe(0);
    });
});
describe('parseNumericInput — spreadsheet and CSV cells', () => {
    it('accepts plain numbers', () => {
        expect(parseNumericInput('123.45')).toBe('123.45');
        expect(parseNumericInput(42)).toBe('42');
    });
    it('strips currency symbols and thousands separators', () => {
        expect(parseNumericInput('₹1,234.56')).toBe('1234.56');
        expect(parseNumericInput('  $ 2,000 ')).toBe('2000');
    });
    it('reads accounting-style negatives', () => {
        expect(parseNumericInput('(500)')).toBe('-500');
    });
    it('rejects non-numeric cells rather than guessing zero', () => {
        expect(parseNumericInput('')).toBeNull();
        expect(parseNumericInput('N/A')).toBeNull();
        expect(parseNumericInput('-')).toBeNull();
        expect(parseNumericInput(null)).toBeNull();
        expect(parseNumericInput(undefined)).toBeNull();
    });
});
describe('distributeQty — GRN label quantity split (No. of Label vs Label Qty)', () => {
    it('matches the reference example exactly: 150 across 14 labels -> ten of 11, four of 10', () => {
        const shares = distributeQty('150', 14);
        expect(shares).toHaveLength(14);
        expect(shares.slice(0, 10)).toEqual(Array(10).fill('11.0000'));
        expect(shares.slice(10)).toEqual(Array(4).fill('10.0000'));
        expect(sum(shares, 4)).toBe('150.0000');
    });
    it('never loses or duplicates a unit for an evenly-divisible total', () => {
        expect(distributeQty('100', 4)).toEqual(['25.0000', '25.0000', '25.0000', '25.0000']);
    });
    it('always sums back to the exact original total, including awkward primes', () => {
        for (const [total, count] of [['97', 7], ['1', 3], ['0', 5], ['12345', 11]]) {
            const shares = distributeQty(total, count);
            expect(shares).toHaveLength(count);
            expect(sum(shares, 4)).toBe(toQty(total));
        }
    });
    it('keeps every earlier label a clean whole number and puts a fractional remainder on the last label only', () => {
        const shares = distributeQty('150.5', 14);
        expect(shares.slice(0, -1).every((s) => s.endsWith('.0000'))).toBe(true);
        expect(shares[shares.length - 1]).toBe('10.5000');
        expect(sum(shares, 4)).toBe('150.5000');
    });
    it('returns the whole quantity on a single label when count is 1 or less', () => {
        expect(distributeQty('42.5', 1)).toEqual(['42.5000']);
        expect(distributeQty('42.5', 0)).toEqual(['42.5000']);
    });
});
describe('formatIndian', () => {
    it('groups in the Indian convention', () => {
        expect(formatIndian(1234567.89)).toBe('12,34,567.89');
        expect(formatIndian(1000)).toBe('1,000.00');
        expect(formatIndian(999)).toBe('999.00');
        expect(formatIndian(10000000, 0)).toBe('1,00,00,000');
    });
    it('keeps the sign on negatives', () => {
        expect(formatIndian(-1234567.89)).toBe('-12,34,567.89');
    });
});
//# sourceMappingURL=money.test.js.map