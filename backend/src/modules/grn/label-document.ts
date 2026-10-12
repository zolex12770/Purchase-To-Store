/**
 * MLN label sheet — one HTML template for browser print, in-app preview and
 * server PDF (same one-implementation discipline as po-document.ts and
 * grn-document.ts). Compact, high-contrast, printer-friendly layout inspired
 * by common warehouse/retail shelf labels — no proprietary artwork or logos,
 * just the fields the reference spec asked for plus a scannable Code 128
 * barcode of the MLN (domain/barcode128.ts).
 */
import { barcodeSvg } from '../../domain/barcode128.js';

export interface LabelData {
  mlnNo: string;
  srNo: number;
  totalInBatch: number;
  itemName: string;
  itemCode: string;
  supplierName: string;
  grnNo: string;
  qty: string;
  uomCode: string | null;
  date: string; // ISO date (YYYY-MM-DD)
}

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (d: string): string => {
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: '2-digit', year: 'numeric' });
};

function labelCard(l: LabelData, isLast: boolean): string {
  return `
    <div class="label${isLast ? ' last' : ''}">
      <div class="item-name">${esc(l.itemName)}</div>
      <div class="row"><span class="k">SUPPLIER</span><span class="v">${esc(l.supplierName)}</span></div>
      <div class="grid2">
        <div><span class="k">GRN NO.</span><span class="v mono">${esc(l.grnNo)}</span></div>
        <div><span class="k">DATE</span><span class="v">${fmtDate(l.date)}</span></div>
        <div><span class="k">ITEM CODE</span><span class="v mono">${esc(l.itemCode)}</span></div>
        <div><span class="k">SR. NO.</span><span class="v">${l.srNo} / ${l.totalInBatch}</span></div>
        <div><span class="k">QTY</span><span class="v">${esc(l.qty)} ${esc(l.uomCode)}</span></div>
        <div><span class="k">MLN NO.</span><span class="v mono">${esc(l.mlnNo)}</span></div>
      </div>
      <div class="barcode">${barcodeSvg(l.mlnNo, { moduleWidth: 1.6, height: 34 })}</div>
      <div class="mln-text">${esc(l.mlnNo)}</div>
    </div>`;
}

/**
 * ONE label = ONE physical 90mm x 50mm page on a dedicated label printer — not
 * a sheet of several labels laid out on A4. `@page` sets the page itself to
 * 90x50mm with zero margin (the printer's own margin, not the browser's), and
 * every `.label` is forced onto its own page via `break-after: page` — except
 * the last one, which is left alone so the run doesn't end on a blank trailing
 * page. `overflow: hidden` on a box sized to exactly 90mm x 50mm keeps content
 * from ever bleeding onto a neighbouring label if a field is unexpectedly long.
 */
export function renderLabelSheetHtml(labels: LabelData[]): string {
  const cards = labels
    .map((l, i) => labelCard(l, i === labels.length - 1))
    .join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>Labels</title>
<style>
  @page { size: 90mm 50mm; margin: 0; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif; color: #111;
    -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .label {
    width: 90mm; height: 50mm;
    padding: 3mm 4mm;
    overflow: hidden;
    display: flex; flex-direction: column;
    break-after: page; page-break-after: always;
    break-inside: avoid; page-break-inside: avoid;
  }
  .label.last { break-after: auto; page-break-after: auto; }
  .row { font-size: 10px; margin-bottom: 3px; display: flex; justify-content: space-between; gap: 6px; }
  .item-name {
    font-size: 13px; font-weight: 700; margin-bottom: 5px; border-bottom: 1px solid #000;
    padding-bottom: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .grid2 { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; margin: 4px 0 6px; }
  .grid2 > div { display: flex; justify-content: space-between; font-size: 9.5px; gap: 4px; }
  .k { color: #444; letter-spacing: 0.02em; }
  .v { font-weight: 700; text-align: right; }
  .mono { font-family: 'Consolas', monospace; }
  .barcode { display: flex; justify-content: center; margin-top: auto; }
  .mln-text { text-align: center; font-size: 10px; font-weight: 700; letter-spacing: 0.06em; margin-top: 1px; }
</style>
</head>
<body>${cards}</body>
</html>`;
}
