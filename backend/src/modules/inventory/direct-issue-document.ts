/**
 * The Store Direct Issue Slip: material handed out from the store without a
 * requisition (direct-issue.routes.ts). One renderer, like the requisition
 * documents (requisition/issue-slip-document.ts), so the preview, the print and a
 * slip opened from its API URL are the same document.
 *
 *  - Every value is escaped. The route used to write database values straight
 *    into its HTML (2026-10-17 E2E S4-24b: General Remarks "<b>bold</b>" came back
 *    as markup).
 *  - A cancelled issue prints as cancelled, with when, by whom and why (S4-24b).
 *    Its stock went back; a reprint must never pass for a live issue, the rule
 *    the requisition issue slip already follows for a reversed slip.
 */
import { formatIndian } from '../../domain/money.js';
import type { CompanySettings } from '../../domain/company.js';
import { escapeHtml as esc, PRINT_DOCUMENT_CSP_META } from '../../core/html.js';

export interface DirectIssueSlipLine {
  item_code: string;
  item_description: string;
  uom_code: string | null;
  issue_qty: string;
  remarks: string | null;
}

export interface DirectIssueSlipData {
  issue_no: string;
  /** DATE column: a Date from the driver, or YYYY-MM-DD. */
  issue_date: string | Date;
  issue_time: string;
  purpose: string;
  remarks: string;
  recipient_name: string;
  recipient_employee_code: string;
  department_name: string;
  cost_centre_name: string;
  total_qty: string;
  created_by_name: string | null;
  /** Set once the issue is cancelled. */
  cancellation: { at: string | Date | null; by: string | null; reason: string } | null;
  lines: DirectIssueSlipLine[];
  company: CompanySettings;
}

/**
 * The slip printed "Sat Oct 17" for its date: the driver returns a DATE as a
 * Date, and the route cut ten characters off its string form.
 */
const fmtDate = (d: string | Date | null): string => {
  if (!d) return '—';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
};

const qty = (v: string | number): string => formatIndian(v, 2);

export function renderDirectIssueSlipHtml(d: DirectIssueSlipData): string {
  const cancelled = d.cancellation;
  const rows = d.lines.map((l, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td class="code">${esc(l.item_code)}</td>
        <td>${esc(l.item_description)}</td>
        <td class="c">${esc(l.uom_code) || '-'}</td>
        <td class="r strong">${qty(l.issue_qty)}</td>
        <td>${esc(l.remarks)}</td>
      </tr>`).join('');

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  ${PRINT_DOCUMENT_CSP_META}
  <title>Direct Store Issue Slip - ${esc(d.issue_no)}${cancelled ? ' (cancelled)' : ''}</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif; margin: 30px; color: #111; }
    .header { border-bottom: 2px solid #111; padding-bottom: 12px; margin-bottom: 20px; }
    .title { font-size: 20px; font-weight: 700; text-transform: uppercase; margin-bottom: 4px; }
    .company { font-size: 14px; color: #444; }
    .cancelled-banner {
      margin-bottom: 20px; padding: 10px 12px; font-size: 13px; color: #7a1414;
      background: #fdecec; border: 1px solid #f3c2c2; border-left: 4px solid #b42318; border-radius: 4px;
    }
    .cancelled-banner strong { text-transform: uppercase; letter-spacing: 0.4px; }
    .doc-meta { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 13px; }
    .box { background: #f9f9f9; padding: 12px; border: 1px solid #ddd; border-radius: 4px; width: 48%; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; font-size: 13px; }
    th { background: #f0f0f0; padding: 8px 6px; border: 1px solid #ccc; text-align: left; }
    td { padding: 6px; border: 1px solid #ccc; }
    td.c, th.c { text-align: center; }
    td.r, th.r { text-align: right; }
    td.code { font-weight: 600; }
    .strong { font-weight: 700; }
    tfoot td { background: #f4f4f4; font-weight: 700; padding: 8px; }
    .remarks { margin-top: 15px; font-size: 12px; }
    .signatures { display: flex; justify-content: space-between; margin-top: 60px; font-size: 13px; }
    .sig-line { border-top: 1px solid #444; width: 180px; text-align: center; padding-top: 5px; }
    .sig-name { font-size: 11px; color: #666; }
    @media print {
      body { margin: 15px; }
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="title">STORE DIRECT ISSUE SLIP${cancelled ? ' — CANCELLED' : ''}</div>
    <div class="company">${esc(d.company.name)}</div>
  </div>
${cancelled ? `
  <div class="cancelled-banner">
    <strong>Cancelled${cancelled.at ? ` on ${fmtDate(cancelled.at)}` : ''}${cancelled.by ? ` by ${esc(cancelled.by)}` : ''}.</strong>
    Every quantity below was returned to stock; this slip no longer counts as issued.
    Reason: ${esc(cancelled.reason) || '—'}
  </div>
` : ''}
  <div class="doc-meta">
    <div class="box">
      <div><strong>Issue Slip No:</strong> ${esc(d.issue_no)}</div>
      <div><strong>Date:</strong> ${fmtDate(d.issue_date)} ${esc(d.issue_time)}</div>
      <div><strong>Purpose:</strong> ${esc(d.purpose) || '-'}</div>
    </div>
    <div class="box">
      <div><strong>Recipient:</strong> ${esc(d.recipient_name)} (${esc(d.recipient_employee_code) || '-'})</div>
      <div><strong>Department:</strong> ${esc(d.department_name) || '-'}</div>
      <div><strong>Cost Centre:</strong> ${esc(d.cost_centre_name) || '-'}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th class="c" style="width: 40px;">#</th>
        <th style="width: 120px;">Item Code</th>
        <th>Description</th>
        <th class="c" style="width: 70px;">UOM</th>
        <th class="r" style="width: 90px;">Issued Qty</th>
        <th style="width: 140px;">Remarks</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
    <tfoot>
      <tr>
        <td colspan="4" class="r">Total Quantity Issued:</td>
        <td class="r">${qty(d.total_qty)}</td>
        <td></td>
      </tr>
    </tfoot>
  </table>
${d.remarks ? `
  <div class="remarks"><strong>Remarks:</strong> ${esc(d.remarks)}</div>
` : ''}
  <div class="signatures">
    <div class="sig-line">Store Incharge<br><span class="sig-name">${esc(d.created_by_name) || 'Store'}</span></div>
    <div class="sig-line">Recipient Signature<br><span class="sig-name">${esc(d.recipient_name)}</span></div>
  </div>
</body>
</html>`;
}
