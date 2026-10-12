/**
 * The GRN document — ONE HTML template consumed three ways: in-app Preview
 * (iframe), Print (the same iframe's native print), and server-rendered PDF
 * (Playwright screenshots this exact HTML to PDF). Mirrors
 * purchase-order/po-document.ts exactly for the same reason: one
 * implementation, so preview/print/PDF can never show different numbers from
 * each other or from the GRN screen.
 */
import { formatIndian } from '../../domain/money.js';
import type { CompanySettings } from '../../domain/company.js';

export interface GrnDocumentLine {
  line_no: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  po_no: string | null;
  indent_no: string | null;
  uom_code: string | null;
  batch_no: string;
  receipt_location: string;
  grn_qty: string;
  invoice_qty: string | null;
  rate: string;
  amount: string;
}

export interface GrnDocumentData {
  grn_no: string;
  grn_date: string;
  grn_type_name: string | null;
  invoice_no: string;
  invoice_date: string | null;
  challan_no: string;
  challan_date: string | null;
  transporter_name: string;
  vehicle_no: string;
  driver_name: string;
  lr_no: string;
  lr_date: string | null;
  remarks: string;
  supplier_name: string;
  supplier_address: string;
  supplier_city: string;
  supplier_state: string;
  supplier_gst: string;
  supplier_mobile: string;
  total_qty: string;
  total_amount: string;
  lines: GrnDocumentLine[];
  company: CompanySettings;
}

const esc = (s: string | null | undefined): string =>
  (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const fmtDate = (d: string | null): string => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const money = (v: string | number): string => `Rs. ${formatIndian(v)}`;
const qty = (v: string | number | null): string => (v == null ? '—' : formatIndian(v, 2).replace(/\.00$/, ''));

/** Fallback brand mark drawn as inline SVG when no real logo has been uploaded yet (Settings → company.logo_data_uri). */
const LOGO_SVG_FALLBACK = `
<svg width="44" height="44" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 8 L28 32 L8 56" fill="none" stroke="#6b7280" stroke-width="9" stroke-linecap="square"/>
  <path d="M56 8 L36 32 L56 56" fill="none" stroke="#7a1530" stroke-width="9" stroke-linecap="square"/>
</svg>`;

function logoMarkup(company: CompanySettings): string {
  return company.logoDataUri
    ? `<img src="${esc(company.logoDataUri)}" alt="${esc(company.brand) || 'Logo'}" style="height:44px; width:auto; display:block;" />`
    : LOGO_SVG_FALLBACK;
}

export function renderGrnDocumentHtml(d: GrnDocumentData): string {
  const rows = d.lines.map((l) => `
    <tr>
      <td class="c">${l.line_no}</td>
      <td class="l mono">${esc(l.item_code)}</td>
      <td class="l">
        <div class="item-desc">${esc(l.item_description)}</div>
        ${l.item_specification ? `<div class="item-spec">${esc(l.item_specification)}</div>` : ''}
        <div class="item-src">
          ${l.po_no ? `PO: ${esc(l.po_no)}` : 'Direct receipt (no PO)'}
          ${l.indent_no ? ` · Indent: ${esc(l.indent_no)}` : ''}
          ${l.batch_no ? ` · Batch: ${esc(l.batch_no)}` : ''}
          ${l.receipt_location ? ` · Loc: ${esc(l.receipt_location)}` : ''}
        </div>
      </td>
      <td class="c">${esc(l.uom_code) || '—'}</td>
      <td class="r">${qty(l.invoice_qty)}</td>
      <td class="r strong">${qty(l.grn_qty)}</td>
      <td class="r">${money(l.rate)}</td>
      <td class="r strong">${money(l.amount)}</td>
    </tr>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(d.grn_no)}</title>
<style>
  @page { size: A4; margin: 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif; color: #1a2233; font-size: 10.5px;
    margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .header { display: flex; justify-content: space-between; align-items: flex-start; border-bottom: 2.5px solid #1a3a6b; padding-bottom: 10px; margin-bottom: 14px; }
  .brand-row { display: flex; gap: 11px; align-items: center; }
  .brand-name { font-size: 19px; font-weight: 800; color: #1a3a6b; letter-spacing: 0.3px; line-height: 1; }
  .brand-tagline { font-size: 8px; color: #7a1530; font-weight: 700; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; }
  .company-name { font-size: 11.5px; font-weight: 700; color: #1a3a6b; letter-spacing: 0.2px; }
  .company-meta { font-size: 9.5px; color: #4a5568; margin-top: 3px; line-height: 1.5; max-width: 320px; }
  .doc-title { text-align: right; }
  .doc-title h1 { font-size: 17px; margin: 0; color: #1a3a6b; letter-spacing: 1px; }
  .doc-title .doc-no { font-size: 12px; font-weight: 700; margin-top: 4px; }
  .doc-title .doc-date { font-size: 9.5px; color: #4a5568; margin-top: 2px; }

  .info-grid { display: flex; gap: 14px; margin-bottom: 14px; }
  .info-box { flex: 1; border: 1px solid #d5dbe5; border-radius: 4px; padding: 9px 11px; }
  .info-box h3 { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: #6b7690; margin: 0 0 6px; border-bottom: 1px solid #eceff4; padding-bottom: 4px; }
  .info-row { display: flex; justify-content: space-between; font-size: 9.8px; padding: 1.5px 0; }
  .info-row .k { color: #6b7690; }
  .info-row .v { font-weight: 600; text-align: right; }
  .supplier-name { font-size: 12px; font-weight: 700; margin-bottom: 3px; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.items thead { display: table-header-group; }
  table.items th {
    background: #1a3a6b; color: #fff; font-size: 8.6px; text-transform: uppercase; letter-spacing: 0.4px;
    padding: 6px 6px; text-align: left; border: 1px solid #1a3a6b;
  }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { padding: 6px 6px; border: 1px solid #e1e5ee; vertical-align: top; font-size: 9.6px; }
  table.items tr:nth-child(even) td { background: #f7f9fc; }
  .mono { font-family: 'Consolas', monospace; font-size: 9px; }
  .item-desc { font-weight: 600; }
  .item-spec, .item-src { font-size: 8.4px; color: #6b7690; margin-top: 2px; }
  .strong { font-weight: 700; }

  .bottom { display: flex; justify-content: space-between; gap: 16px; margin-bottom: 14px; page-break-inside: avoid; }
  .words-box { flex: 1; border: 1px solid #d5dbe5; border-radius: 4px; padding: 9px 11px; font-size: 9.5px; align-self: flex-start; }
  .words-box h3 { font-size: 9px; text-transform: uppercase; letter-spacing: 0.6px; color: #6b7690; margin: 0 0 5px; }
  .totals { width: 260px; border: 1px solid #d5dbe5; border-radius: 4px; overflow: hidden; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals-label { padding: 5px 10px; font-size: 9.6px; color: #4a5568; }
  .totals-value { padding: 5px 10px; font-size: 9.6px; text-align: right; font-weight: 600; }
  .totals tr.grand td { background: #1a3a6b; color: #fff; font-size: 12.5px; font-weight: 700; padding: 8px 10px; }

  .remarks { font-size: 9px; color: #6b7690; margin-bottom: 14px; }
  .footer { border-top: 1px solid #d5dbe5; padding-top: 10px; display: flex; justify-content: space-between; align-items: flex-end; page-break-inside: avoid; }
  .terms { font-size: 8.4px; color: #6b7690; max-width: 320px; line-height: 1.6; }
  .signature { text-align: center; font-size: 9.5px; }
  .signature .line { border-top: 1px solid #1a2233; width: 160px; margin-top: 34px; padding-top: 4px; }
</style>
</head>
<body>
  <div class="header">
    <div>
      <div class="brand-row">
        ${logoMarkup(d.company)}
        ${!d.company.logoDataUri ? `
        <div>
          <div class="brand-name">${esc(d.company.brand) || 'ZOLEX'}</div>
          ${d.company.tagline ? `<div class="brand-tagline">${esc(d.company.tagline)}</div>` : ''}
        </div>` : ''}
      </div>
      <div class="company-name" style="margin-top: 6px;">${esc(d.company.name)}</div>
      <div class="company-meta">
        ${d.company.address ? esc(d.company.address) + '<br/>' : ''}
        ${[d.company.phone ? `Phone: ${esc(d.company.phone)}` : '', d.company.fax ? `Fax: ${esc(d.company.fax)}` : ''].filter(Boolean).join(' &nbsp;|&nbsp; ')}
        ${d.company.gstNo ? `<br/>GSTIN: ${esc(d.company.gstNo)}` : ''}
      </div>
    </div>
    <div class="doc-title">
      <h1>GOODS RECEIPT NOTE</h1>
      <div class="doc-no">${esc(d.grn_no)}</div>
      <div class="doc-date">Dated ${fmtDate(d.grn_date)}${d.grn_type_name ? ` · ${esc(d.grn_type_name)}` : ''}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Supplier</h3>
      <div class="supplier-name">${esc(d.supplier_name)}</div>
      <div class="company-meta">${esc([d.supplier_address, d.supplier_city, d.supplier_state].filter(Boolean).join(', '))}</div>
      <div class="info-row"><span class="k">GSTIN</span><span class="v">${esc(d.supplier_gst) || '—'}</span></div>
      <div class="info-row"><span class="k">Mobile</span><span class="v">${esc(d.supplier_mobile) || '—'}</span></div>
    </div>
    <div class="info-box">
      <h3>Invoice / Challan</h3>
      <div class="info-row"><span class="k">Invoice No.</span><span class="v">${esc(d.invoice_no) || '—'}</span></div>
      <div class="info-row"><span class="k">Invoice Date</span><span class="v">${fmtDate(d.invoice_date)}</span></div>
      <div class="info-row"><span class="k">Challan No.</span><span class="v">${esc(d.challan_no) || '—'}</span></div>
      <div class="info-row"><span class="k">Challan Date</span><span class="v">${fmtDate(d.challan_date)}</span></div>
    </div>
    <div class="info-box">
      <h3>Transport</h3>
      <div class="info-row"><span class="k">Transporter</span><span class="v">${esc(d.transporter_name) || '—'}</span></div>
      <div class="info-row"><span class="k">Vehicle No.</span><span class="v">${esc(d.vehicle_no) || '—'}</span></div>
      <div class="info-row"><span class="k">Driver</span><span class="v">${esc(d.driver_name) || '—'}</span></div>
      <div class="info-row"><span class="k">L.R. No. / Date</span><span class="v">${esc(d.lr_no) || '—'}${d.lr_date ? ` · ${fmtDate(d.lr_date)}` : ''}</span></div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:26px;">Sr</th>
        <th style="width:100px;">Item Code</th>
        <th>Description</th>
        <th class="c" style="width:40px;">Unit</th>
        <th class="r" style="width:60px;">Invoice Qty</th>
        <th class="r" style="width:60px;">Received Qty</th>
        <th class="r" style="width:70px;">Rate</th>
        <th class="r" style="width:80px;">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="bottom">
    <div class="words-box">
      ${d.remarks ? `<h3>Remarks</h3>${esc(d.remarks)}` : ''}
    </div>
    <div class="totals">
      <table>
        <tr><td class="totals-label">Total Qty</td><td class="totals-value">${qty(d.total_qty)}</td></tr>
        <tr class="grand"><td>Total Amount</td><td class="totals-value" style="color:#fff;">${money(d.total_amount)}</td></tr>
      </table>
    </div>
  </div>

  <div class="footer">
    <div class="terms">
      This is a system-generated Goods Receipt Note.
    </div>
    <div class="signature">
      <div class="line">Authorized Signatory</div>
    </div>
  </div>
</body>
</html>`;
}
