/**
 * The Issue Slip — Store's proof of material actually handed out against a
 * requisition, sharing the same branding system as requisition-document.ts
 * so the two read as one professional document family. "Issued Qty" here is
 * always THIS transaction's actual issue, never substituted with the
 * requested quantity — Previously Issued / Current Issue / Total Issued /
 * Extra are shown side by side so a partial or excess issue is unambiguous
 * on paper, exactly as it is on screen. Over-issue is never hidden.
 */
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
const qty = (v) => formatIndian(v, 2).replace(/\.00$/, '');
/** Fallback brand mark drawn as inline SVG when no real logo has been uploaded yet (Settings → company.logo_data_uri). */
const LOGO_SVG_FALLBACK = `
<svg width="44" height="44" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 8 L28 32 L8 56" fill="none" stroke="#6b7280" stroke-width="9" stroke-linecap="square"/>
  <path d="M56 8 L36 32 L56 56" fill="none" stroke="#7a1530" stroke-width="9" stroke-linecap="square"/>
</svg>`;
function logoMarkup(company) {
    return company.logoDataUri
        ? `<img src="${esc(company.logoDataUri)}" alt="${esc(company.brand) || 'Logo'}" style="height:48px; width:auto; display:block;" />`
        : LOGO_SVG_FALLBACK;
}
export function renderIssueSlipHtml(d) {
    let grandExtra = 0;
    const rows = d.lines.map((l, i) => {
        const pending = Number(l.requested_qty_snapshot) - Number(l.previously_issued_qty);
        const extra = Number(l.issue_qty) > Math.max(0, pending) ? Number(l.issue_qty) - Math.max(0, pending) : 0;
        grandExtra += extra;
        return `
    <tr class="${i % 2 === 1 ? 'alt' : ''}">
      <td class="c">${i + 1}</td>
      <td class="l mono">${esc(l.item_code)}</td>
      <td class="l">${esc(l.item_description)}</td>
      <td class="c">${esc(l.uom_code) || '—'}</td>
      <td class="r">${qty(l.requested_qty_snapshot)}</td>
      <td class="r">${qty(l.previously_issued_qty)}</td>
      <td class="r strong ${extra > 0 ? 'excess' : ''}">${qty(l.issue_qty)}</td>
      <td class="r strong">${qty(l.total_issued_qty)}</td>
      <td class="r ${extra > 0 ? 'excess' : 'muted'}">${extra > 0 ? `+${qty(extra)}` : '—'}</td>
      <td class="r muted">${l.available_stock != null ? qty(l.available_stock) : '—'}</td>
    </tr>`;
    }).join('');
    return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${esc(d.issue_slip_no)}</title>
<style>
  @page { size: A4; margin: 12mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif; color: #241c1f; font-size: 10.5px;
    margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
    background: #fffdfb;
  }

  .header { display: flex; justify-content: space-between; align-items: flex-start; padding-bottom: 12px; }
  .brand-row { display: flex; gap: 12px; align-items: center; }
  .brand-text .brand-name { font-size: 20px; font-weight: 800; color: #7a1530; letter-spacing: 0.5px; line-height: 1; }
  .brand-text .brand-tagline { font-size: 8.4px; color: #6b7280; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; margin-top: 2px; }
  .company-block { text-align: right; max-width: 300px; }
  .company-block .legal-name { font-size: 11px; font-weight: 700; color: #3d2b30; }
  .company-meta { font-size: 8.4px; color: #7a6f72; margin-top: 3px; line-height: 1.5; }

  .accent-bar { height: 4px; background: linear-gradient(90deg, #8a3f0a 0%, #b45309 45%, #d4af37 100%); border-radius: 2px; margin-bottom: 10px; }

  .title-band {
    display: flex; justify-content: space-between; align-items: center;
    background: linear-gradient(115deg, #6b2f08 0%, #8a3f0a 55%, #b45309 100%); color: #fff;
    border-radius: 6px; padding: 9px 16px; margin-bottom: 12px;
    border-bottom: 2px solid #d4af37;
  }
  .title-band h1 { font-size: 14px; margin: 0; letter-spacing: 1.4px; font-weight: 700; }
  .title-band .doc-meta { text-align: right; font-size: 9.5px; }
  .title-band .doc-no { font-size: 13px; font-weight: 800; letter-spacing: 0.4px; color: #f9dfae; }
  .title-band .doc-date { opacity: 0.9; margin-top: 1px; }

  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .info-box { border: 1px solid #ecdcc8; border-radius: 6px; padding: 9px 12px; background: #fefaf5; }
  .info-box h3 {
    font-size: 8.6px; text-transform: uppercase; letter-spacing: 0.6px; color: #b45309;
    margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1.5px solid #f2e0c8; font-weight: 800;
  }
  .info-row { display: flex; justify-content: space-between; font-size: 9.8px; padding: 2px 0; }
  .info-row .k { color: #8a7d80; }
  .info-row .v { font-weight: 600; text-align: right; color: #241c1f; }

  table.items { width: 100%; border-collapse: collapse; margin-bottom: 10px; }
  table.items th {
    background: #8a3f0a; color: #fff; font-size: 8.2px; text-transform: uppercase; letter-spacing: 0.3px;
    padding: 7px 5px; text-align: left; border: 1px solid #8a3f0a;
  }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { padding: 6px 5px; border: 1px solid #eee0d2; vertical-align: top; font-size: 9.4px; }
  table.items tr.alt td { background: #fdf7ee; }
  .mono { font-family: 'Consolas', monospace; font-size: 8.8px; }
  .strong { font-weight: 700; }
  .muted { color: #a89a9d; }
  .excess { color: #b45309; background: #fef3e2 !important; }

  .excess-banner {
    display: flex; gap: 8px; align-items: flex-start; margin-bottom: 12px;
    background: #fff6e5; border: 1px solid #f3ddab; border-left: 3px solid #d97706;
    border-radius: 4px; padding: 8px 11px; font-size: 9px; color: #7a4c00;
  }
  .excess-banner strong { text-transform: uppercase; font-size: 8.2px; letter-spacing: 0.4px; }

  .footer { margin-top: 18px; page-break-inside: avoid; }
  .sign-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 18px; margin-top: 34px; max-width: 420px; margin-left: auto; margin-right: auto; }
  .sign-box { text-align: center; }
  .sign-box .line { border-top: 1.4px solid #3d2b30; padding-top: 5px; }
  .sign-box .role { font-size: 9.6px; font-weight: 700; color: #3d2b30; }
  .sign-box .sub { font-size: 8px; color: #a89a9d; margin-top: 1px; }
  .doc-footer-note { margin-top: 16px; border-top: 1px solid #ecdfd3; padding-top: 7px; font-size: 7.8px; color: #a89a9d; text-align: center; }
</style>
</head>
<body>
  <div class="header">
    <div class="brand-row">
      ${logoMarkup(d.company)}
      ${!d.company.logoDataUri ? `
      <div class="brand-text">
        <div class="brand-name">${esc(d.company.brand) || 'ZOLEX'}</div>
        ${d.company.tagline ? `<div class="brand-tagline">${esc(d.company.tagline)}</div>` : ''}
      </div>` : ''}
    </div>
    <div class="company-block">
      <div class="legal-name">${esc(d.company.name)}</div>
      <div class="company-meta">
        ${d.company.address ? esc(d.company.address) + '<br/>' : ''}
        ${[d.company.phone ? `Phone: ${esc(d.company.phone)}` : '', d.company.fax ? `Fax: ${esc(d.company.fax)}` : ''].filter(Boolean).join(' &nbsp;|&nbsp; ')}
      </div>
    </div>
  </div>
  <div class="accent-bar"></div>

  <div class="title-band">
    <h1>MATERIAL ISSUE SLIP</h1>
    <div class="doc-meta">
      <div class="doc-no">${esc(d.issue_slip_no)}</div>
      <div class="doc-date">Dated ${fmtDate(d.issue_date)}</div>
    </div>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Against Requisition</h3>
      <div class="info-row"><span class="k">Requisition No.</span><span class="v">${esc(d.requisition_no)}</span></div>
      <div class="info-row"><span class="k">Requester</span><span class="v">${esc(d.employee_name)}</span></div>
      <div class="info-row"><span class="k">Employee Code</span><span class="v">${esc(d.employee_code) || '—'}</span></div>
      <div class="info-row"><span class="k">Department</span><span class="v">${esc(d.department_name) || '—'}</span></div>
      <div class="info-row"><span class="k">HOD</span><span class="v">${esc(d.hod_name) || '—'}</span></div>
    </div>
    <div class="info-box">
      <h3>Issue Details</h3>
      <div class="info-row"><span class="k">Machine No.</span><span class="v">${esc(d.machine_name) || '—'}</span></div>
      <div class="info-row"><span class="k">Cost Centre</span><span class="v">${esc(d.cost_centre_name) || '—'}</span></div>
      <div class="info-row"><span class="k">Store User</span><span class="v">${esc(d.store_user_name) || '—'}</span></div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:22px;">Sr</th>
        <th style="width:108px;">Item Code</th>
        <th>Item Name</th>
        <th class="c" style="width:38px;">Unit</th>
        <th class="r" style="width:62px;">Requested</th>
        <th class="r" style="width:70px;">Prev. Issued</th>
        <th class="r" style="width:66px;">This Issue</th>
        <th class="r" style="width:66px;">Total Issued</th>
        <th class="r" style="width:48px;">Extra</th>
        <th class="r" style="width:62px;">Avail. Stock</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
  </table>

  ${grandExtra > 0 ? `
  <div class="excess-banner">
    <span>&#9888;</span>
    <span><strong>Over-issue recorded.</strong> One or more lines on this slip issued more than the remaining requested quantity
    (total extra: ${qty(grandExtra)}). This was deliberately authorised at issue time, subject only to available stock — the
    excess is shown here for audit, never hidden.</span>
  </div>` : ''}

  <div class="footer">
    <div class="sign-grid">
      <div class="sign-box"><div class="line"><div class="role">Issued By (Store)</div><div class="sub">Name &amp; Signature</div></div></div>
      <div class="sign-box"><div class="line"><div class="role">Received By</div><div class="sub">Name &amp; Signature</div></div></div>
    </div>
    <div class="doc-footer-note">
      This slip records the actual quantity physically handed out by Stores against the requisition named above.
    </div>
  </div>
</body>
</html>`;
}
//# sourceMappingURL=issue-slip-document.js.map