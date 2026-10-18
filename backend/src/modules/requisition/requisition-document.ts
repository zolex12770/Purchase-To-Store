/**
 * The Requisition Slip — ONE HTML template for in-app Preview, Print, and
 * server-rendered PDF (mirrors po-document.ts/grn-document.ts exactly: one
 * implementation, so preview/print/PDF can never disagree). A requisition is
 * a MATERIAL REQUEST, not a purchase document — no pricing/GST here, only
 * Requested/Issued/Pending quantities, read straight off
 * v_requisition_line_balance so the document can never disagree with the screen.
 *
 * Visual language: deep maroon + charcoal + gold, matching the real ZOLEX
 * mark (company.logoDataUri) — deliberately NOT green, and deliberately
 * distinct from Issue Slip's own copper theme so the two read as related but
 * separate documents at a glance.
 */
import { formatIndian } from '../../domain/money.js';
import type { CompanySettings } from '../../domain/company.js';
// The shared escape also covers quotes: the logo and brand are written into attributes.
import { escapeHtml as esc, PRINT_DOCUMENT_CSP_META } from '../../core/html.js';

export type RequisitionDocumentCompany = CompanySettings;

export interface RequisitionDocumentLine {
  line_no: number;
  item_code: string;
  item_description: string;
  main_group_name: string;
  uom_code: string | null;
  requested_qty: string;
  issued_qty: string;
  pending_qty: string;
}

export interface RequisitionDocumentData {
  requisition_no: string;
  requisition_date: string;
  employee_name: string;
  employee_code: string;
  department_name: string;
  hod_name: string;
  machine_name: string | null;
  cost_centre_name: string | null;
  status: string;
  hod_status: string;
  store_status: string;
  remarks: string;
  lines: RequisitionDocumentLine[];
  company: CompanySettings;
}

const fmtDate = (d: string | null): string => {
  if (!d) return '—';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const qty = (v: string | number): string => formatIndian(v, 2).replace(/\.00$/, '');

/** Labels for the two independent status columns (PENDING/APPROVED/REJECTED, PENDING/ISSUED) — never the full workflow vocabulary. */
const STATUS_LABEL: Record<string, string> = {
  PENDING: 'Pending', APPROVED: 'Approved', REJECTED: 'Rejected', ISSUED: 'Issued',
};

/** Fallback brand mark drawn as inline SVG when no real logo has been uploaded yet (Settings → company.logo_data_uri). */
const LOGO_SVG_FALLBACK = `
<svg width="52" height="52" viewBox="0 0 64 64" xmlns="http://www.w3.org/2000/svg">
  <path d="M8 8 L28 32 L8 56" fill="none" stroke="#6b7280" stroke-width="9" stroke-linecap="square"/>
  <path d="M56 8 L36 32 L56 56" fill="none" stroke="#7a1530" stroke-width="9" stroke-linecap="square"/>
</svg>`;

function logoMarkup(company: CompanySettings): string {
  return company.logoDataUri
    ? `<img src="${esc(company.logoDataUri)}" alt="${esc(company.brand) || 'Logo'}" style="height:52px; width:auto; display:block;" />`
    : LOGO_SVG_FALLBACK;
}

function statusPillClass(status: string): string {
  // Blue reads as "confirmed/positive" without using green anywhere on this document.
  if (status === 'APPROVED' || status === 'ISSUED') return 'approved';
  if (status === 'REJECTED') return 'rejected';
  return 'pending';
}

export function renderRequisitionDocumentHtml(d: RequisitionDocumentData): string {
  const rows = d.lines.map((l, i) => `
    <tr class="${i % 2 === 1 ? 'alt' : ''}">
      <td class="c">${l.line_no}</td>
      <td class="l mono">${esc(l.item_code)}</td>
      <td class="l">
        <div class="item-desc">${esc(l.item_description)}</div>
        ${l.main_group_name ? `<div class="item-spec">${esc(l.main_group_name)}</div>` : ''}
      </td>
      <td class="c">${esc(l.uom_code) || '—'}</td>
      <td class="r strong">${qty(l.requested_qty)}</td>
      <td class="r">${qty(l.issued_qty)}</td>
      <td class="r">${qty(l.pending_qty)}</td>
    </tr>`).join('');

  // Pad to a tidy minimum row count so a short requisition still reads as a
  // complete, deliberately-formatted document rather than a truncated table.
  const padRows = Math.max(0, 6 - d.lines.length);
  const padding = Array.from({ length: padRows }, () => `
    <tr><td class="c">&nbsp;</td><td></td><td></td><td></td><td></td><td></td><td></td></tr>`).join('');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
${PRINT_DOCUMENT_CSP_META}
<title>${esc(d.requisition_no)}</title>
<style>
  @page { size: A4; margin: 12mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body {
    font-family: 'Segoe UI', Arial, sans-serif; color: #241c1f; font-size: 10.5px;
    margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
    background: #fffdfb;
  }

  /* ── Header ─────────────────────────────────────────────────────────── */
  .header {
    display: flex; justify-content: space-between; align-items: flex-start;
    padding-bottom: 12px;
  }
  .brand-row { display: flex; gap: 12px; align-items: center; }
  .brand-text .brand-name { font-size: 22px; font-weight: 800; color: #7a1530; letter-spacing: 0.5px; line-height: 1; }
  .brand-text .brand-tagline { font-size: 8.6px; color: #6b7280; font-weight: 700; letter-spacing: 0.6px; text-transform: uppercase; margin-top: 2px; }
  .company-block { text-align: right; max-width: 300px; }
  .company-block .legal-name { font-size: 11.5px; font-weight: 700; color: #3d2b30; }
  .company-meta { font-size: 8.6px; color: #7a6f72; margin-top: 3px; line-height: 1.55; }

  .accent-bar { height: 4px; background: linear-gradient(90deg, #5c0f24 0%, #9c2142 45%, #d4af37 100%); border-radius: 2px; margin-bottom: 10px; }

  /* ── Title band ─────────────────────────────────────────────────────── */
  .title-band {
    display: flex; justify-content: space-between; align-items: center;
    background: linear-gradient(115deg, #4a0d1e 0%, #7a1530 55%, #9c2142 100%); color: #fdf3e7;
    border-radius: 6px; padding: 9px 16px; margin-bottom: 12px;
    border-bottom: 2px solid #d4af37;
  }
  .title-band h1 { font-size: 14px; margin: 0; letter-spacing: 1.4px; font-weight: 700; color: #fff; }
  .title-band .doc-meta { text-align: right; font-size: 9.5px; }
  .title-band .doc-no { font-size: 13px; font-weight: 800; letter-spacing: 0.4px; color: #f3d78a; }
  .title-band .doc-date { opacity: 0.92; margin-top: 1px; }

  .status-row { display: flex; gap: 8px; justify-content: flex-end; margin-top: 5px; }
  .status-pill {
    display: inline-flex; align-items: center; gap: 4px; padding: 2px 10px; border-radius: 20px;
    font-size: 8.2px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.4px;
    border: 1px solid transparent;
  }
  .status-pill.approved { background: #eaf1fb; color: #1a4d8f; border-color: #c3d9f5; }
  .status-pill.rejected { background: #fbeaec; color: #8f1a2e; border-color: #f0c3ca; }
  .status-pill.pending  { background: #fdf3e0; color: #8a6400; border-color: #f0deac; }

  /* ── Info grid ──────────────────────────────────────────────────────── */
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .info-box { border: 1px solid #ecdfd3; border-radius: 6px; padding: 9px 12px; background: #fdfaf5; }
  .info-box h3 {
    font-size: 8.6px; text-transform: uppercase; letter-spacing: 0.6px; color: #7a1530;
    margin: 0 0 6px; padding-bottom: 4px; border-bottom: 1.5px solid #ecd9a8; font-weight: 800;
  }
  .info-row { display: flex; justify-content: space-between; font-size: 9.8px; padding: 2px 0; }
  .info-row .k { color: #8a7d80; }
  .info-row .v { font-weight: 600; text-align: right; color: #241c1f; }

  /* ── Items table ────────────────────────────────────────────────────── */
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 12px; }
  table.items thead { display: table-header-group; }
  table.items th {
    background: #4a0d1e; color: #f3d78a; font-size: 8.4px; text-transform: uppercase; letter-spacing: 0.4px;
    padding: 7px 6px; text-align: left; border: 1px solid #4a0d1e;
  }
  table.items th.r, table.items td.r { text-align: right; }
  table.items th.c, table.items td.c { text-align: center; }
  table.items td { padding: 6px 6px; border: 1px solid #ecdfd3; vertical-align: top; font-size: 9.6px; height: 20px; }
  table.items tr.alt td { background: #fbf3e6; }
  .mono { font-family: 'Consolas', monospace; font-size: 9px; }
  .item-desc { font-weight: 600; }
  .item-spec { font-size: 8.2px; color: #8a7d80; margin-top: 2px; }
  .strong { font-weight: 700; }

  .remarks { font-size: 9px; color: #4a3a3f; margin-bottom: 14px; border: 1px solid #ecdfd3; border-left: 3px solid #d4af37; border-radius: 4px; padding: 8px 11px; background: #fdfaf5; }
  .remarks strong { color: #7a1530; text-transform: uppercase; font-size: 8.2px; letter-spacing: 0.4px; }

  /* ── Footer / signatures ────────────────────────────────────────────── */
  .footer { margin-top: 18px; page-break-inside: avoid; }
  .sign-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 18px; margin-top: 30px; }
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
        ${d.company.gstNo ? `<br/>GSTIN: ${esc(d.company.gstNo)}` : ''}
      </div>
    </div>
  </div>
  <div class="accent-bar"></div>

  <div class="title-band">
    <h1>MATERIAL REQUISITION SLIP</h1>
    <div class="doc-meta">
      <div class="doc-no">${esc(d.requisition_no)}</div>
      <div class="doc-date">Dated ${fmtDate(d.requisition_date)}</div>
    </div>
  </div>
  <div class="status-row">
    <span class="status-pill ${statusPillClass(d.hod_status)}">HOD: ${esc(STATUS_LABEL[d.hod_status] ?? d.hod_status)}</span>
    <span class="status-pill ${statusPillClass(d.store_status)}">Store: ${esc(STATUS_LABEL[d.store_status] ?? d.store_status)}</span>
  </div>

  <div class="info-grid">
    <div class="info-box">
      <h3>Requester</h3>
      <div class="info-row"><span class="k">Prepared By</span><span class="v">${esc(d.employee_name)}</span></div>
      <div class="info-row"><span class="k">Employee Code</span><span class="v">${esc(d.employee_code) || '—'}</span></div>
      <div class="info-row"><span class="k">Department</span><span class="v">${esc(d.department_name) || '—'}</span></div>
      <div class="info-row"><span class="k">HOD</span><span class="v">${esc(d.hod_name) || '—'}</span></div>
    </div>
    <div class="info-box">
      <h3>Requisition Details</h3>
      <div class="info-row"><span class="k">Machine No.</span><span class="v">${esc(d.machine_name) || '—'}</span></div>
      <div class="info-row"><span class="k">Cost Centre</span><span class="v">${esc(d.cost_centre_name) || '—'}</span></div>
      <div class="info-row"><span class="k">HOD Status</span><span class="v">${esc(STATUS_LABEL[d.hod_status] ?? d.hod_status)}</span></div>
      <div class="info-row"><span class="k">Store Status</span><span class="v">${esc(STATUS_LABEL[d.store_status] ?? d.store_status)}</span></div>
    </div>
  </div>

  <table class="items">
    <thead>
      <tr>
        <th style="width:26px;">Sr</th>
        <th style="width:100px;">Item Code</th>
        <th>Item / Main Group</th>
        <th class="c" style="width:44px;">Unit</th>
        <th class="r" style="width:72px;">Requested</th>
        <th class="r" style="width:64px;">Issued</th>
        <th class="r" style="width:64px;">Pending</th>
      </tr>
    </thead>
    <tbody>${rows}${padding}</tbody>
  </table>

  ${d.remarks ? `<div class="remarks"><strong>Special Instructions / Remarks</strong><br/>${esc(d.remarks)}</div>` : ''}

  <div class="footer">
    <div class="sign-grid">
      <div class="sign-box"><div class="line"><div class="role">Prepared By</div><div class="sub">Name &amp; Signature</div></div></div>
      <div class="sign-box"><div class="line"><div class="role">Issued By</div><div class="sub">Store — Name &amp; Signature</div></div></div>
      <div class="sign-box"><div class="line"><div class="role">Approved By HOD</div><div class="sub">Name &amp; Signature</div></div></div>
    </div>
    <div class="doc-footer-note">
      This is a system-generated Material Requisition Slip. Material is issued by Stores only against HOD approval, subject to available stock.
    </div>
  </div>
</body>
</html>`;
}
