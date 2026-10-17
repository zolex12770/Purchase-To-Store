/**
 * What the store has recorded against a pending purchase order (backend
 * purchase-order/receipt-evidence.ts): the evidence badges of a PO row and header,
 * the Pending PO list's filter tiles, and the PO screen's banners with the next action.
 *
 * On 2026-10-17, 2,000 of 2,003 POs showed OPEN with Rs 79.50 Cr pending, mostly
 * because the store's receipts were imported before their POs existed. The owner asked
 * to tell genuinely pending orders apart from those whose receipts are not yet reliably
 * linked; these components only show that evidence, they never link anything.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Link2Off, FileSpreadsheet } from 'lucide-react';
import { Badge, Banner, Tooltip } from './ui';
import { FilterTiles } from './KpiCard';
import { count, formatDate, formatDateTime, money, qty } from '../lib/format';
import {
  RECEIPT_EVIDENCE_OPTIONS,
  type ReceiptEvidence, type ReceiptEvidenceSummary, type StoreReceiptAwaitingLink, type StoreSheetReceipt,
} from '../lib/receiptEvidence';

const plural = (n: number, one: string, many: string) => `${count(n)} ${n === 1 ? one : many}`;

/** A badge with its explanation in a tooltip; focusable, so keyboard users get it too. */
function EvidenceBadge({ label, tip, icon }: { label: string; tip: string; icon: ReactNode }) {
  return (
    <Tooltip content={tip}>
      <span className="badge-tip" tabIndex={0} role="img" aria-label={`${label}. ${tip}`}>
        <Badge tone="attention" icon={icon}>{label}</Badge>
      </span>
    </Tooltip>
  );
}

/** The evidence badges of one PO: receipt lines awaiting link, and lines on the store sheet only. */
export function ReceiptEvidenceBadges({ awaiting, sheet }: { awaiting: number; sheet: number }) {
  if (!(awaiting > 0) && !(sheet > 0)) return null;
  return (
    <span className="evidence-badges">
      {awaiting > 0 && (
        <EvidenceBadge
          label="Receipt awaiting link"
          icon={<Link2Off size={12} strokeWidth={2.25} />}
          tip={`${plural(awaiting, 'store receipt line names', 'store receipt lines name')} this PO but `
            + `${awaiting === 1 ? 'is' : 'are'} not linked to it yet, so its goods may have come. Open the PO to see why.`}
        />
      )}
      {sheet > 0 && (
        <EvidenceBadge
          label="Receipt on store sheet only"
          icon={<FileSpreadsheet size={12} strokeWidth={2.25} />}
          tip={`The store's GRN sheet records ${plural(sheet, 'receipt line', 'receipt lines')} for this PO `
            + 'that no GRN in the ERP holds. Open the PO to see them.'}
        />
      )}
    </span>
  );
}

/**
 * The Pending PO list's filter by receipt evidence: one tile per class with its POs and
 * pending value from the summary, which adds up to the list's own Pending Value tile.
 * Loading shows skeletons and a failure shows "—" with the reason, never a zero.
 */
export function ReceiptEvidenceTiles({
  summary, loading, error, value, onChange,
}: {
  summary: ReceiptEvidenceSummary | undefined;
  loading: boolean;
  error: unknown;
  value: ReceiptEvidence | null;
  onChange: (value: ReceiptEvidence | null) => void;
}) {
  const part = (v: ReceiptEvidence) => (!summary ? null
    : v === 'awaiting_link' ? summary.awaitingLink : v === 'sheet_only' ? summary.sheetOnly : summary.noneRecorded);
  const asOf = [
    summary?.asOf ? `receipts awaiting link as the last Link store GRNs run recorded them (${formatDateTime(summary.asOf)})` : null,
    summary?.sheetOnly.jobId ? `the store sheet as of sheet sync #${summary.sheetOnly.jobId} (${formatDateTime(summary.sheetOnly.asOf)})` : null,
  ].filter(Boolean);
  return (
    <div className="evidence-tiles">
      <FilterTiles
        ariaLabel="Receipt evidence"
        value={value}
        onChange={(v) => onChange(v as ReceiptEvidence | null)}
        options={RECEIPT_EVIDENCE_OPTIONS.map((o) => {
          const p = part(o.value);
          return {
            value: o.value,
            label: o.label,
            count: p ? plural(p.pos, 'PO', 'POs') : '',
            sub: p ? `${money(p.value)} pending` : undefined,
            tone: o.value === 'none_recorded' ? 'default' as const : 'warning' as const,
            loading: loading && !summary,
            error: summary ? undefined : error ?? undefined,
          };
        })}
      />
      <p className="evidence-note">
        {RECEIPT_EVIDENCE_OPTIONS.map((o) => <span key={o.value}><strong>{o.label}:</strong> {o.hint} </span>)}
        {asOf.length > 0 && <span>Counted from {asOf.join(' and ')}.</span>}
      </p>
    </div>
  );
}

/** The next actions, word for word as the owner's brief gives them. */
export const NEXT_ACTION_AWAITING_LINK = 'Purchase confirms which PO line each receipt belongs to (or corrects the GRN tab or the PO register); '
  + 'a Super Admin then re-runs Link store GRNs in Admin > Data Management.';
export const NEXT_ACTION_SHEET_ONLY = 'The store has recorded this receipt on the GRN sheet but not in the ERP. '
  + 'Post it through Goods Receipt (GRN) in the ERP; the sheet sync never creates receipts.';

/** The PO screen's banners: the receipts awaiting link, and the receipts on the store sheet only. */
export function StoreReceiptBanners({
  awaiting, sheet, receiveAction,
}: {
  awaiting: StoreReceiptAwaitingLink[];
  sheet: StoreSheetReceipt[];
  /** "Receive material" for a user who may post a GRN against this PO. */
  receiveAction?: ReactNode;
}) {
  return (
    <>
      {awaiting.length > 0 && (
        <Banner tone="attention">
          <div className="banner-title">
            {awaiting.length === 1
              ? 'A store receipt names this purchase order but is not linked to it yet'
              : `${count(awaiting.length)} store receipts name this purchase order but are not linked to it yet`}
          </div>
          <div className="banner-text">
            The goods may already have come: until a receipt is linked, this order counts its quantity as still to be received.
          </div>
          <div className="banner-table">
            <table className="table table-compact">
              <thead>
                <tr><th>GRN No</th><th>Date</th><th>Item</th><th className="right">Qty</th><th>Why it is not linked</th></tr>
              </thead>
              <tbody>
                {awaiting.map((r) => (
                  <tr key={`${r.grnId}-${r.itemCode}-${r.reason}-${r.detail}`}>
                    <td className="cell-code"><Link to={`/grn/${r.grnId}`}>{r.grnNo}</Link></td>
                    <td>{formatDate(r.grnDate)}</td>
                    <td className="cell-code">{r.itemCode}{r.poLineNo != null && <span className="cell-muted"> · PO line {r.poLineNo}</span>}</td>
                    <td className="right num">{qty(r.grnQty)}</td>
                    <td className="cell-wrap" style={{ minWidth: 260 }}>
                      <div>{r.reasonText}</div>
                      <div className="cell-muted">{r.detail}</div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="banner-next"><strong>Next:</strong> {NEXT_ACTION_AWAITING_LINK}</div>
        </Banner>
      )}
      {sheet.length > 0 && (
        <Banner tone="attention" action={receiveAction}>
          <div className="banner-title">
            {sheet.length === 1
              ? "A receipt on the store's GRN sheet names this purchase order, but no GRN in the ERP holds it"
              : `${count(sheet.length)} receipts on the store's GRN sheet name this purchase order, but no GRN in the ERP holds them`}
          </div>
          <div className="banner-table">
            <table className="table table-compact">
              <thead>
                <tr><th>GRN No (sheet)</th><th>Item</th><th className="right">Qty</th><th className="right">Sheet row</th><th>First reported by the sheet sync</th></tr>
              </thead>
              <tbody>
                {sheet.map((r) => (
                  <tr key={`${r.sheetRow}-${r.grnNo}-${r.itemCode}`}>
                    <td className="cell-code">{r.grnNo ?? <span className="cell-muted">No GRN number</span>}</td>
                    <td className="cell-code">{r.itemCode}</td>
                    <td className="right num">{qty(r.grnQty)}</td>
                    <td className="right num">{r.sheetRow ?? '—'}</td>
                    <td>{formatDateTime(r.reportedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="banner-next"><strong>Next:</strong> {NEXT_ACTION_SHEET_ONLY}</div>
        </Banner>
      )}
    </>
  );
}
