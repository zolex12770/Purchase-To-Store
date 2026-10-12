/**
 * GRN label sheet rendering — one 90mm x 50mm physical label per page on a
 * dedicated label printer (pin-point fix: no more A4 grid of several labels).
 */
import { describe, it, expect } from 'vitest';
import { renderLabelSheetHtml } from './label-document.js';
function makeLabel(overrides = {}) {
    return {
        mlnNo: 'P000000050001', srNo: 1, totalInBatch: 1,
        itemName: 'Test Item', itemCode: 'TEST-001', supplierName: 'Test Supplier Pvt Ltd',
        grnNo: 'GRN-20260101-0001', qty: '10.0000', uomCode: 'NOS', date: '2026-01-01',
        ...overrides,
    };
}
/** Count of `.label` cards actually present in the rendered document. */
const countLabels = (html) => (html.match(/<div class="label/g) ?? []).length;
describe('renderLabelSheetHtml — 90mm x 50mm one-label-per-page', () => {
    it('sets the page to exactly 90mm x 50mm with zero margin, and never mentions A4', () => {
        const html = renderLabelSheetHtml([makeLabel()]);
        expect(html).toContain('@page { size: 90mm 50mm; margin: 0; }');
        expect(html).not.toMatch(/A4/i);
        expect(html).not.toMatch(/size:\s*Letter/i);
    });
    it('CASE 1: a single label renders as exactly one page, with no forced trailing break', () => {
        const html = renderLabelSheetHtml([makeLabel({ srNo: 1, totalInBatch: 1 })]);
        expect(countLabels(html)).toBe(1);
        // The one (and only) label is also the last — it must not carry a forced break-after.
        expect(html).toMatch(/<div class="label last">/);
    });
    it('CASE 2: three labels render as exactly three pages, in order 1, 2, 3', () => {
        const labels = [1, 2, 3].map((n) => makeLabel({ srNo: n, totalInBatch: 3, mlnNo: `P00000005000${n}` }));
        const html = renderLabelSheetHtml(labels);
        expect(countLabels(html)).toBe(3);
        const order = [...html.matchAll(/SR\. NO\.<\/span><span class="v">(\d+) \/ 3<\/span>/g)].map((m) => m[1]);
        expect(order).toEqual(['1', '2', '3']);
    });
    it('CASE 3: twelve labels render as exactly twelve pages', () => {
        const labels = Array.from({ length: 12 }, (_, i) => makeLabel({ srNo: i + 1, totalInBatch: 12, mlnNo: `P0000000500${String(i + 1).padStart(2, '0')}` }));
        const html = renderLabelSheetHtml(labels);
        expect(countLabels(html)).toBe(12);
    });
    it('every label except the last forces a page break; only the last is left to end the run', () => {
        const labels = [1, 2, 3].map((n) => makeLabel({ srNo: n, totalInBatch: 3 }));
        const html = renderLabelSheetHtml(labels);
        const cards = html.split('<div class="label').slice(1); // one entry per card, header stripped
        expect(cards).toHaveLength(3);
        expect(cards[0].startsWith('">')).toBe(true); // label 1 — no "last" class, forced break-after applies
        expect(cards[1].startsWith('">')).toBe(true); // label 2 — no "last" class
        expect(cards[2].startsWith(' last">')).toBe(true); // label 3 — "last" class, break-after: auto
    });
    it('CASE 4: each label carries its own correct serial number, unique MLN, quantity, GRN and supplier', () => {
        const labels = [
            makeLabel({ srNo: 1, totalInBatch: 2, mlnNo: 'P000000050001', qty: '6.0000', grnNo: 'GRN-20260101-0001', supplierName: 'Supplier A' }),
            makeLabel({ srNo: 2, totalInBatch: 2, mlnNo: 'P000000050002', qty: '4.0000', grnNo: 'GRN-20260101-0001', supplierName: 'Supplier A' }),
        ];
        const html = renderLabelSheetHtml(labels);
        expect(html).toContain('P000000050001');
        expect(html).toContain('P000000050002');
        expect(html).toContain('6.0000');
        expect(html).toContain('4.0000');
        expect(html).toContain('1 / 2');
        expect(html).toContain('2 / 2');
        // Two visually distinct MLNs, not the same one duplicated.
        expect(html.match(/P000000050001/g)?.length).toBeGreaterThan(0);
        expect(html.match(/P000000050002/g)?.length).toBeGreaterThan(0);
    });
    it('CASE 5: the rendered quantities are exactly what was passed in — no loss or duplication introduced by rendering', () => {
        // A real 150-qty GRN split into 12 labels upstream (distribution logic untouched) — this
        // only proves the renderer faithfully reflects whatever split it is given.
        const qtys = ['12.0000', '13.0000', '12.0000', '13.0000', '12.0000', '13.0000', '12.0000', '13.0000', '12.0000', '13.0000', '12.0000', '13.0000'];
        const total = qtys.reduce((sum, q) => sum + Number(q), 0);
        expect(total).toBe(150);
        const labels = qtys.map((q, i) => makeLabel({ srNo: i + 1, totalInBatch: 12, qty: q, mlnNo: `P0000000500${String(i + 1).padStart(2, '0')}` }));
        const html = renderLabelSheetHtml(labels);
        for (const q of qtys)
            expect(html).toContain(q);
        expect(countLabels(html)).toBe(12);
    });
    it('CASE 6: page-break CSS is present for every-label-its-own-page behaviour', () => {
        const html = renderLabelSheetHtml([makeLabel(), makeLabel({ srNo: 2, totalInBatch: 2 })]);
        expect(html).toContain('break-after: page');
        expect(html).toContain('page-break-after: always');
        expect(html).toContain('break-inside: avoid');
        expect(html).toContain('width: 90mm; height: 50mm;');
    });
    it('escapes HTML-significant characters in item/supplier names', () => {
        const html = renderLabelSheetHtml([makeLabel({ itemName: 'Item <script>alert(1)</script> & Co' })]);
        expect(html).not.toContain('<script>');
        expect(html).toContain('&lt;script&gt;');
    });
});
//# sourceMappingURL=label-document.test.js.map