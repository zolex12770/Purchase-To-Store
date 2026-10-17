/**
 * Document quick view (Purchase Module pin-point, Point 4/5; spec §3.9).
 *
 * Clicking an Indent/PO/GRN number in a list opens this instead of navigating
 * away — the same detail endpoint the full page already uses
 * (`/indents/:id`, `/purchase-orders/:id`, `/grn/:id`), rendered compactly in
 * a side drawer so the list stays in view. "Open full page" is always there:
 * this is an additive quick look, not a replacement workflow.
 */
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { Drawer, Button, StatusBadge, DetailItem, DetailGrid, EmptyState, ErrorState, LoadingBlock } from './ui';
import { money, qty, formatDate, text } from '../lib/format';

export type DocumentType = 'indent' | 'po' | 'grn';

// Doubles as both the API path and the frontend route — both happen to share
// this exact shape (`/indents/:id`, `/purchase-orders/:id`, `/grn/:id`).
const BASE_PATH: Record<DocumentType, string> = {
  indent: '/indents', po: '/purchase-orders', grn: '/grn',
};
const TITLE: Record<DocumentType, string> = {
  indent: 'Purchase indent', po: 'Purchase order', grn: 'Goods receipt',
};

interface AnyDoc {
  id: number;
  status: string;
  [key: string]: unknown;
}

/** Pending quantities read amber; zero reads quiet, never coloured. */
const pendingStyle = (v: unknown) => ({ color: Number(v ?? 0) > 0 ? 'var(--value-pending)' : 'var(--value-zero)' });

export function DocumentQuickViewModal({ type, id, onClose }: { type: DocumentType; id: number | null; onClose: () => void }) {
  const navigate = useNavigate();

  const detail = useQuery({
    queryKey: ['doc-quick-view', type, id],
    queryFn: () => api.get<AnyDoc>(`${BASE_PATH[type]}/${id}`),
    enabled: id !== null,
  });

  const d = detail.data;
  const lines = (d?.lines as Record<string, unknown>[] | undefined) ?? [];
  const docNo = d ? String(d[`${type}_no`] ?? '') : '';

  return (
    <Drawer
      open={id !== null}
      onClose={onClose}
      wide
      title={d ? `${TITLE[type]} ${docNo}` : `${TITLE[type]}`}
      subtitle={d ? <span className="row" style={{ gap: 8, marginTop: 4 }}><StatusBadge status={d.status} /></span> : 'Loading…'}
      footer={
        d && (
          <>
            <Button variant="secondary" onClick={onClose}>Close</Button>
            <Button
              variant="primary" icon={<ExternalLink size={14} />}
              onClick={() => { onClose(); navigate(`${BASE_PATH[type]}/${d.id}`); }}
            >
              Open full page
            </Button>
          </>
        )
      }
    >
      {detail.isLoading ? (
        <LoadingBlock label={`Loading ${TITLE[type].toLowerCase()}…`} />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title={`Could not load this ${TITLE[type].toLowerCase()}`} />
      ) : !d ? null : (
        <>
          {type === 'indent' && (
            <div style={{ marginBottom: 'var(--space-5)' }}><DetailGrid cols={3}>
              <DetailItem label="Date">{formatDate(String(d.indent_date))}</DetailItem>
              <DetailItem label="Indent type">{text(d.indent_type_name as string)}</DetailItem>
              <DetailItem label="Department">{text(d.department_name as string)}</DetailItem>
              <DetailItem label="Cost centre">{text(d.cost_centre_name as string)}</DetailItem>
              <DetailItem label="Raised by">{text(d.requested_by_name as string)}</DetailItem>
              <DetailItem label="Remarks">{text(d.remarks as string)}</DetailItem>
            </DetailGrid></div>
          )}
          {type === 'po' && (
            <div style={{ marginBottom: 'var(--space-5)' }}><DetailGrid cols={3}>
              <DetailItem label="Date">{formatDate(String(d.po_date))}</DetailItem>
              <DetailItem label="Supplier">{text(d.supplier_name as string)}</DetailItem>
              <DetailItem label="PO type">{text(d.po_type_name as string)}</DetailItem>
              <DetailItem label="Payment terms">{text(d.payment_terms as string)}</DetailItem>
              <DetailItem label="Indent(s)">
                {text(((d.sourceIndents as { indentNo: string }[] | undefined) ?? []).map((s) => s.indentNo).join(', '))}
              </DetailItem>
              <DetailItem label="Grand total">{money(d.grand_total as string)}</DetailItem>
            </DetailGrid></div>
          )}
          {type === 'grn' && (
            <div style={{ marginBottom: 'var(--space-5)' }}><DetailGrid cols={3}>
              <DetailItem label="Date">{formatDate(String(d.grn_date))}</DetailItem>
              <DetailItem label="PO(s)">{text(((d.poNumbers as string[] | undefined) ?? []).join(', '))}</DetailItem>
              <DetailItem label="Invoice no.">{text(d.invoice_no as string)}</DetailItem>
              <DetailItem label="Invoice date">{d.invoice_date ? formatDate(String(d.invoice_date)) : '—'}</DetailItem>
              <DetailItem label="Challan no.">{text(d.challan_no as string)}</DetailItem>
              <DetailItem label="Transporter">{text(d.transporter_name as string)}</DetailItem>
              <DetailItem label="Vehicle no.">{text(d.vehicle_no as string)}</DetailItem>
              <DetailItem label="LR no.">{text(d.lr_no as string)}</DetailItem>
              <DetailItem label="Remarks">{text(d.remarks as string)}</DetailItem>
            </DetailGrid></div>
          )}

          {lines.length === 0 ? (
            <EmptyState title="No items on this document" />
          ) : (
          <div className="table-wrap" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)', maxHeight: '55vh' }}>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th>Item code</th>
                  <th>Item description</th>
                  {type !== 'grn' && <th className="right">Qty</th>}
                  {type === 'po' && <th className="right">Received</th>}
                  {type === 'po' && <th className="right">Pending GRN</th>}
                  {type === 'grn' && <th className="right">GRN qty</th>}
                  {type !== 'indent' && <th className="right">Rate</th>}
                  {type !== 'indent' && <th className="right">Amount</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="cell-muted num">{i + 1}</td>
                    <td className="cell-code">{text(l.item_code as string)}</td>
                    <td className="cell-wrap" style={{ minWidth: 240, maxWidth: 360 }}>{text(l.item_description as string)}</td>
                    {type === 'indent' && <td className="right num">{qty(l.indent_qty as string)}</td>}
                    {type === 'po' && (
                      <>
                        <td className="right num">{qty(l.po_qty as string)}</td>
                        <td className="right num">{qty((l.received_qty as string) ?? '0')}</td>
                        <td className="right num" style={pendingStyle(l.pending_grn_qty)}>
                          {qty((l.pending_grn_qty as string) ?? '0')}
                        </td>
                      </>
                    )}
                    {type === 'grn' && <td className="right num cell-strong">{qty(l.grn_qty as string)}</td>}
                    {type !== 'indent' && <td className="right num">{money((l.rate as string) ?? '0', 4)}</td>}
                    {type !== 'indent' && <td className="right num cell-strong">{money((l.amount as string) ?? '0')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </Drawer>
  );
}
