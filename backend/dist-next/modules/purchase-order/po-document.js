/**
 * The Purchase Order document — ONE HTML template consumed three ways:
 * in-app Preview (iframe), Print (same iframe's native print), and server-
 * rendered PDF (Playwright screenshots this exact HTML to PDF). One
 * implementation, so preview/print/PDF can never show different numbers
 * from each other or from the PO screen (Module 12 discipline) — every
 * total here is read straight off v_po_header_balance / v_po_line_balance,
 * the same views the API and the PO form both use.
 */
import { amountInWords } from '../../domain/numberToWords.js';
import { formatIndian } from '../../domain/money.js';
const esc = (s) => (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const fmtDate = (d) => {
    if (!d)
        return '—';
    const dt = new Date(d);
    if (Number.isNaN(dt.getTime()))
        return '—';
    return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};
const money = (v) => `Rs. ${formatIndian(v)}`;
const qty = (v) => formatIndian(v, 2).replace(/\.00$/, '');
/** Fallback brand mark drawn as inline SVG when no real logo has been uploaded yet (Settings → company.logo_data_uri). */
const LOGO_SVG_FALLBACK = `
<svg width="44" height="44" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 8 L28 32 L8 56" fill="none" stroke="#6b7280" stroke-width="9" stroke-linecap="square"/>
  <path d="M56 8 L36 32 L56 56" fill="none" stroke="#7a1530" stroke-width="9" stroke-linecap="square"/>
</svg>`;
function logoMarkup(company) {
    return company.logoDataUri
        ? `<img src="${esc(company.logoDataUri)}" alt="${esc(company.brand) || 'Logo'}" style="height:44px; width:auto; display:block;" />`
        : LOGO_SVG_FALLBACK;
}
function chargeLine(label, mode, value, amount, sign) {
    const amt = Number(amount);
    if (amt === 0 && Number(value) === 0)
        return '';
    const pctLabel = mode === 'PERCENTAGE' ? ` (${Number(value).toFixed(2)}%)` : '';
    return `
    <tr>
      <td class="totals-label">${label}${pctLabel}</td>
      <td class="totals-value">${sign} ${money(amount)}</td>
    </tr>`;
}
export function renderPoDocumentHtml(d) {
    const rows = d.lines.map((l) => `
    <tr>
      <td class="c">${l.line_no}</td>
      <td class="l mono">${esc(l.item_code)}</td>
      <td class="l">
        <div class="item-desc">${esc(l.item_description)}</div>
        ${l.item_specification ? `<div class="item-spec">${esc(l.item_specification)}</div>` : ''}
        ${l.sources.length > 0 ? `<div class="item-src">Source: ${l.sources.map((s) => `${esc(s.indent_no)} (${qty(s.consumed_qty)})`).join(', ')}</div>` : ''}
      </td>
      <td class="r">${qty(l.po_qty)}</td>
      <td class="c">${esc(l.uom_code) || '—'}</td>
      <td class="r">${money(l.rate)}</td>
      <td class="r">${Number(l.gst_pct) > 0 ? `${Number(l.gst_pct).toFixed(2)}%` : '—'}</td>
      <td class="r strong">${money(l.amount)}</td>
    </tr>`).join('');
    const indentRefs = d.sourceIndents.map((i) => esc(i.indentNo)).join(', ') || '—';
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(d.po_no)}</title>
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
  .doc-title .po-no { font-size: 12px; font-weight: 700; margin-top: 4px; }
  .doc-title .po-date { font-size: 9.5px; color: #4a5568; margin-top: 2px; }

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
  .totals { width: 300px; border: 1px solid #d5dbe5; border-radius: 4px; overflow: hidden; }
  .totals table { width: 100%; border-collapse: collapse; }
  .totals-label { padding: 5px 10px; font-size: 9.6px; color: #4a5568; }
  .totals-value { padding: 5px 10px; font-size: 9.6px; text-align: right; font-weight: 600; }
  .totals tr.subtotal td { border-bottom: 1px solid #eceff4; }
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
      <h1>PURCHASE ORDER</h1>
      <div class="po-no">${esc(d.po_no)}</div>
      <div class="po-date">Dated ${fmtDate(d.po_date)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Supplier</h3>
      <div class="supplier-name">${esc(d.supplier_name)}</div>
      <div class="company-meta">${esc([d.supplier_address, d.supplier_city, d.supplier_state].filter(Boolean).join(', '))}</div>
      <div class="info-row"><span class="k">GSTIN</span><span class="v">${esc(d.supplier_gst) || '—'}</span></div>
      <div class="info-row"><span class="k">Mobile</span><span class="v">${esc(d.supplier_mobile) || '—'}</span></div>
      <div class="info-row"><span class="k">Email</span><span class="v">${esc(d.supplier_email) || '—'}</span></div>
    </div>
    <div class="info-box">
      <h3>Order Details</h3>
      <div class="info-row"><span class="k">PO Type</span><span class="v">${esc(d.po_type_name) || '—'}</span></div>
      <div class="info-row"><span class="k">Indent Ref.</span><span class="v">${indentRefs}</span></div>
      <div class="info-row"><span class="k">Expected Delivery</span><span class="v">${fmtDate(d.delivery_date)}</span></div>
      <div class="info-row"><span class="k">Payment Terms</span><span class="v">${esc(d.payment_terms) || '—'}</span></div>
      <div class="info-row"><span class="k">Delivery Address</span><span class="v">${esc(d.delivery_address) || '—'}</span></div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:26px;">Sr</th>
        <th style="width:100px;">Item Code</th>
        <th>Description</th>
        <th class="r" style="width:55px;">Qty</th>
        <th class="c" style="width:40px;">Unit</th>
        <th class="r" style="width:70px;">Rate</th>
        <th class="r" style="width:50px;">GST %</th>
        <th class="r" style="width:80px;">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  <div class="bottom">
    <div class="words-box">
      <h3>Amount in Words</h3>
      ${esc(amountInWords(Number(d.grand_total)))}
      ${d.remarks ? `<div class="remarks" style="margin-top:8px;"><strong>Remarks:</strong> ${esc(d.remarks)}</div>` : ''}
    </div>
    <div class="totals">
      <table>
        <tr class="subtotal"><td class="totals-label">Subtotal</td><td class="totals-value">${money(d.total_amount)}</td></tr>
        ${chargeLine('GST', 'AMOUNT', '0', d.total_gst_amount, '+')}
        ${chargeLine('Discount', d.discount_mode, d.discount_value, d.discount_amount, '-')}
        ${chargeLine('Freight', d.freight_mode, d.freight_value, d.freight_amount, '+')}
        ${chargeLine('Packing', d.packing_mode, d.packing_value, d.packing_amount, '+')}
        ${chargeLine('Insurance', d.insurance_mode, d.insurance_value, d.insurance_amount, '+')}
        <tr class="grand"><td>Grand Total</td><td class="totals-value" style="color:#fff;">${money(d.grand_total)}</td></tr>
      </table>
    </div>
  </div>

  <div class="footer">
    <div class="terms">
      This is a system-generated Purchase Order. Please acknowledge receipt and confirm delivery schedule.
      ${d.payment_terms ? `Payment terms: ${esc(d.payment_terms)}.` : ''}
    </div>
    <div class="signature">
      <div class="line">Authorized Signatory</div>
    </div>
  </div>
</body>
</html>`;
}
//# sourceMappingURL=po-document.js.map