/**
 * Document quick-view modal (Purchase Module pin-point, Point 4/5).
 *
 * Clicking an Indent/PO/GRN number in a list opens this instead of navigating
 * away — the same detail endpoint the full page already uses
 * (`/indents/:id`, `/purchase-orders/:id`, `/grn/:id`), just rendered
 * compactly. A "Open full page" link is always present, so nothing existing
 * is removed — this is an additive quick-look, not a replacement workflow.
 */
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { api } from '../lib/api';
import { Modal, Button, StatusBadge, DetailItem, DetailGrid, EmptyState, ErrorState } from './ui';
import { money, qty, formatDate, text } from '../lib/format';

export type DocumentType = 'indent' | 'po' | 'grn';

// Doubles as both the API path and the frontend route — both happen to share
// this exact shape (`/indents/:id`, `/purchase-orders/:id`, `/grn/:id`).
const BASE_PATH: Record<DocumentType, string> = {
  indent: '/indents', po: '/purchase-orders', grn: '/grn',
};
const TITLE: Record<DocumentType, string> = {
  indent: 'Purchase Indent', po: 'Purchase Order', grn: 'Goods Receipt',
};

interface AnyDoc {
  id: number;
  status: string;
  [key: string]: unknown;
}

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
    <Modal
      open={id !== null}
      onClose={onClose}
      size="xl"
      title={d ? `${TITLE[type]}: ${docNo}` : `Loading ${TITLE[type]}…`}
      subtitle={d ? <StatusBadge status={d.status} /> : undefined}
      footer={
        d && (
          <Button
            variant="secondary" size="sm" icon={<ExternalLink size={13} />}
            onClick={() => { onClose(); navigate(`${BASE_PATH[type]}/${d.id}`); }}
          >
            Open full page
          </Button>
        )
      }
    >
      {detail.isLoading ? (
        <div className="skeleton" style={{ height: 200 }} />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} />
      ) : !d ? null : (
        <>
          {type === 'indent' && (
            <div style={{ marginBottom: 'var(--sp-4)' }}><DetailGrid cols={3}>
              <DetailItem label="Date">{formatDate(String(d.indent_date))}</DetailItem>
              <DetailItem label="Indent type">{text(d.indent_type_name as string)}</DetailItem>
              <DetailItem label="Department">{text(d.department_name as string)}</DetailItem>
              <DetailItem label="Cost centre">{text(d.cost_centre_name as string)}</DetailItem>
              <DetailItem label="Raised by">{text(d.requested_by_name as string)}</DetailItem>
              <DetailItem label="Remarks">{text(d.remarks as string)}</DetailItem>
            </DetailGrid></div>
          )}
          {type === 'po' && (
            <div style={{ marginBottom: 'var(--sp-4)' }}><DetailGrid cols={3}>
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
            <div style={{ marginBottom: 'var(--sp-4)' }}><DetailGrid cols={3}>
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
          <div className="table-wrap" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
            <table className="table table-compact">
              <thead>
                <tr>
                  <th style={{ width: 34 }}>#</th>
                  <th>Item Code</th>
                  <th className="cell-wrap">Item Description</th>
                  {type !== 'grn' && <th className="right">Qty</th>}
                  {type === 'po' && <th className="right">Received</th>}
                  {type === 'po' && <th className="right">Pending GRN</th>}
                  {type === 'grn' && <th className="right">GRN Qty</th>}
                  {type !== 'indent' && <th className="right">Rate</th>}
                  {type !== 'indent' && <th className="right">Amount</th>}
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => (
                  <tr key={i}>
                    <td className="cell-muted num">{i + 1}</td>
                    <td className="cell-code">{text(l.item_code as string)}</td>
                    <td className="cell-wrap" style={{ minWidth: 160, maxWidth: 260 }}>{text(l.item_description as string)}</td>
                    {type === 'indent' && <td className="right num">{qty(l.indent_qty as string)}</td>}
                    {type === 'po' && (
                      <>
                        <td className="right num">{qty(l.po_qty as string)}</td>
                        <td className="right num cell-muted">{qty((l.received_qty as string) ?? '0')}</td>
                        <td className="right num" style={{ color: Number(l.pending_grn_qty ?? 0) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>
                          {qty((l.pending_grn_qty as string) ?? '0')}
                        </td>
                      </>
                    )}
                    {type === 'grn' && <td className="right num cell-strong">{qty(l.grn_qty as string)}</td>}
                    {type !== 'indent' && <td className="right num cell-muted">{money((l.rate as string) ?? '0', 4)}</td>}
                    {type !== 'indent' && <td className="right num cell-strong">{money((l.amount as string) ?? '0')}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          )}
        </>
      )}
    </Modal>
  );
}
