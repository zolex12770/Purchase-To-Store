/**
 * GRN — document view (SRS §12; GRN module reconstruction).
 *
 * Handles all three shapes a GRN can now have: single-PO (the old common
 * case), multi-PO (several purchase orders combined into one receipt, each
 * line still tracing its own PO), and Direct (no purchase order at all).
 */
import { useState } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Pencil, Send, Ban, Printer, Trash2, ShoppingCart, FileDown, Tag } from 'lucide-react';
import { api } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader, PrintHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, StatusBadge, Badge, ConfirmDialog,
  DetailItem, DetailGrid, LoadingBlock, ErrorState,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { HelpStrip } from '../../components/simple';
import { money, qty, formatDate, formatDateTime, count, text } from '../../lib/format';

interface GrnLine {
  id: number;
  line_no: number;
  po_line_id: number | null;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string | null;
  indent_no: string | null;
  po_no: string | null;
  grn_qty: string;
  invoice_qty: string | null;
  rate: string;
  amount: string;
  uom_code: string | null;
  accepted_qty: string | null;
  rejected_qty: string | null;
  receipt_location: string | null;
  batch_no: string | null;
  package_count: string | null;
  packing_type: string | null;
  expiry_date: string | null;
  label_count: string | null;
  label_qty: string | null;
  remarks: string;
  po_qty: string | null;
  received_qty: string | null;
  pending_grn_qty: string | null;
  po_line_no: number | null;
  mln_no: string | null;
  mln_sr_no: number | null;
}

interface GrnDoc {
  id: number;
  grn_no: string;
  grn_date: string;
  grn_time: string;
  status: string;
  mode: 'PO' | 'DIRECT';
  poNumbers: string[];
  invoice_no: string;
  invoice_date: string | null;
  challan_no: string;
  challan_date: string | null;
  vehicle_no: string;
  transporter_name: string;
  driver_name: string;
  lr_no: string;
  lr_date: string | null;
  remarks: string;
  posted_at: string | null;
  cancel_reason: string | null;
  po_id: number | null;
  po_no: string | null;
  po_date: string | null;
  po_status: string | null;
  po_type_name: string | null;
  grn_type_name: string | null;
  supplier_name: string;
  supplier_code: string;
  supplier_address: string;
  supplier_gst: string;
  supplier_city: string;
  supplier_state: string;
  received_by_name: string | null;
  posted_by_name: string | null;
  created_by_name: string | null;
  lines: GrnLine[];
}

type ActionKind = 'post' | 'cancel' | 'delete';

export default function GrnDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Set only when arriving straight from the create screen (router state, so a
  // refresh or a link to this page does not show the 'just saved' message again).
  const justSaved = Boolean((useLocation().state as { justSaved?: string } | null)?.justSaved);
  const { can } = useAuth();
  const toast = useToast();
  const download = useDownload();
  const qc = useQueryClient();

  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['grn-doc', id],
    queryFn: () => api.get<GrnDoc>(`/grn/${id}`),
  });

  const run = useMutation({
    mutationFn: (kind: ActionKind) =>
      kind === 'delete'
        ? api.del<{ message: string }>(`/grn/${id}`)
        : api.post<{ message: string }>(`/grn/${id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res, kind) => {
      toast.success('GRN updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['grn'] });
      void qc.invalidateQueries({ queryKey: ['grn-doc', id] });
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      if (kind === 'delete') navigate('/grn');
    },
    onError: (err) => toast.fromError(err),
  });

  if (isLoading) return <LoadingBlock label="Loading GRN…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const isDraft = data.status === 'DRAFT';
  const isPosted = data.status === 'POSTED';
  const isDirect = data.mode === 'DIRECT';
  const isMultiPo = data.poNumbers.length > 1;

  const totalQty = data.lines.reduce((s, l) => s + Number(l.grn_qty), 0);
  const totalInvoiceQty = data.lines.reduce((s, l) => s + Number(l.invoice_qty ?? 0), 0);
  const totalValue = data.lines.reduce((s, l) => s + Number(l.amount), 0);

  return (
    <>
      <PrintHeader title={`Goods Receipt Note ${data.grn_no}`} />

      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {data.grn_no}
            <StatusBadge status={data.status} />
            {isDirect && <Badge tone="info" plain>Direct GRN</Badge>}
            {isMultiPo && <Badge tone="info" plain>{data.poNumbers.length} POs</Badge>}
          </span>
        }
        subtitle={
          isDirect
            ? `${data.supplier_name} · received ${formatDate(data.grn_date)} · direct receipt (no PO)`
            : `${data.supplier_name} · received ${formatDate(data.grn_date)} against ${data.poNumbers.join(', ') || '—'}`
        }
        breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: 'Data', to: '/grn' }, { label: data.grn_no }]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/grn')}>Back</Button>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>
            <Button variant="secondary" size="sm" icon={<FileDown size={13} />}
                    onClick={() => void download(`/grn/${id}/pdf`, `${data.grn_no}.pdf`)}>
              PDF
            </Button>
            {isPosted && (
              <Button variant="secondary" size="sm" icon={<Tag size={13} />}
                      onClick={() => navigate(`/grn/labels?grnId=${id}`)}>
                Print Labels
              </Button>
            )}

            {(isDraft || isPosted) && can('grn.edit') && (
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => navigate(`/grn/${id}/edit`)}>Edit</Button>
            )}
            {isDraft && can('grn.approve') && (
              <Button variant="primary" size="sm" icon={<Send size={13} />} onClick={() => setAction('post')}>Post GRN</Button>
            )}
            {isDraft && can('grn.delete') && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setAction('delete')}>Delete</Button>
            )}
            {isPosted && can('grn.approve') && (
              <Button variant="ghost" size="sm" icon={<Ban size={13} />} onClick={() => { setReason(''); setAction('cancel'); }}>
                Cancel receipt
              </Button>
            )}
          </>
        }
      />

      {/* Arriving straight from Receive Material: say what was saved, under which
          number, and what the next step is. */}
      {justSaved && (
        <HelpStrip tone="success">
          <strong>Saved. GRN number: {data.grn_no}.</strong>{' '}
          {isDraft
            ? (can('grn.approve')
              ? 'It is a draft. Next step: press “Post GRN” to add this material to stock.'
              : 'It is a draft. Next step: a person who can post GRNs must post it.')
            : isPosted
              ? 'It is posted and the material is added to stock. Next step: print the labels if you need them.'
              : 'Nothing more is needed here.'}
        </HelpStrip>
      )}

      {isDraft && (
        <div
          style={{
            padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--warning-50)', border: '1px solid var(--warning-100)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', color: 'var(--warning-700)',
          }}
        >
          This GRN is a <strong>draft</strong>. {isDirect ? 'Nothing changes' : 'No purchase order balance changes'} until it is posted.
        </div>
      )}

      {data.cancel_reason && (
        <div
          style={{
            padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--danger-50)', border: '1px solid var(--danger-100)',
            borderLeft: '3px solid var(--danger-500)', borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--danger-700)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Receipt cancelled
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)', marginTop: 5 }}>{data.cancel_reason}</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Lines received" value={count(data.lines.length)} />
        <StatTile label="Total quantity" value={qty(totalQty)} tone="success" />
        <StatTile label="Invoice quantity" value={qty(totalInvoiceQty)} />
        <StatTile label="Receipt value" value={money(totalValue)} />
        {!isDirect && (
          <StatTile
            label={isMultiPo ? 'Purchase orders' : 'Purchase order'}
            value={isMultiPo ? String(data.poNumbers.length) : (data.po_no ?? '—')}
            sub={isMultiPo ? data.poNumbers.join(', ') : data.po_status ? `PO is ${data.po_status.replace(/_/g, ' ').toLowerCase()}` : undefined}
            onClick={!isMultiPo && data.po_id ? () => navigate(`/purchase-orders/${data.po_id}`) : undefined}
          />
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
        <Card>
          <CardHeader title="Receipt details" />
          <CardBody>
            <DetailGrid cols={3}>
              <DetailItem label="GRN no." mono>{data.grn_no}</DetailItem>
              <DetailItem label="Receipt date">{formatDate(data.grn_date)}</DetailItem>
              <DetailItem label="GRN type">{text(data.grn_type_name)}</DetailItem>
              <DetailItem label="Invoice no." mono>{text(data.invoice_no)}</DetailItem>
              <DetailItem label="Invoice date">{data.invoice_date ? formatDate(data.invoice_date) : '—'}</DetailItem>
              <DetailItem label="Challan no." mono>{text(data.challan_no)}</DetailItem>
              <DetailItem label="Transporter">{text(data.transporter_name)}</DetailItem>
              <DetailItem label="Vehicle no.">{text(data.vehicle_no)}</DetailItem>
              <DetailItem label="Driver">{text(data.driver_name)}</DetailItem>
              <DetailItem label="L.R. no. / date">{text(data.lr_no)}{data.lr_date ? ` · ${formatDate(data.lr_date)}` : ''}</DetailItem>
              <DetailItem label="Received by">{text(data.received_by_name)}</DetailItem>
              <DetailItem label="Posted by">{text(data.posted_by_name)}</DetailItem>
              <DetailItem label="Posted at">{data.posted_at ? formatDateTime(data.posted_at) : '—'}</DetailItem>
            </DetailGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            icon={<ShoppingCart size={15} />}
            title={isDirect ? 'Supplier' : 'Purchase order & supplier'}
            actions={!isMultiPo && !isDirect && data.po_id
              ? <Button variant="ghost" size="sm" onClick={() => navigate(`/purchase-orders/${data.po_id}`)}>Open PO</Button>
              : undefined}
          />
          <CardBody>
            <DetailGrid cols={2}>
              {!isDirect && (
                <>
                  <DetailItem label={isMultiPo ? 'PO no(s).' : 'PO no.'} mono>{isMultiPo ? data.poNumbers.join(', ') : text(data.po_no)}</DetailItem>
                  <DetailItem label="PO type">{text(data.po_type_name)}</DetailItem>
                  {!isMultiPo && <DetailItem label="PO status">{data.po_status ? <StatusBadge status={data.po_status} /> : '—'}</DetailItem>}
                </>
              )}
              <DetailItem label="Supplier">{data.supplier_name}</DetailItem>
              <DetailItem label="Supplier code" mono>{data.supplier_code}</DetailItem>
              <DetailItem label="GST no." mono>{text(data.supplier_gst)}</DetailItem>
              <DetailItem label="Location">{text([data.supplier_city, data.supplier_state].filter(Boolean).join(', '))}</DetailItem>
            </DetailGrid>
          </CardBody>
        </Card>
      </div>

      <Card>
        <CardHeader
          title="Received lines"
          subtitle={isDirect ? 'Direct receipt — no purchase order balance is affected' : 'PO balances shown alongside are the current position, after this receipt if it is posted'}
        />
        <CardBody flush>
          <div className="table-wrap" style={{ overflowX: 'auto' }}>
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  {!isDirect && <th>Indent / PO</th>}
                  <th>Item</th>
                  <th>MLN No.</th>
                  <th className="right">Invoice Qty</th>
                  <th className="right">GRN Qty</th>
                  <th className="center">UOM</th>
                  <th className="right">Rate</th>
                  <th className="right">Value</th>
                  <th>Batch / Location</th>
                  {!isDirect && <th className="right">Pending GRN Qty</th>}
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.id} className="clickable" onClick={() => navigate(`/masters/items/${l.item_id}`)}>
                    <td className="cell-muted num">{l.line_no}</td>
                    {!isDirect && (
                      <td style={{ fontSize: 'var(--text-2xs)' }}>
                        {l.indent_no && <div className="cell-muted">Indent: {l.indent_no}</div>}
                        <div className="cell-code">{text(l.po_no)}</div>
                      </td>
                    )}
                    <td style={{ maxWidth: 300 }}>
                      <div className="cell-code">{l.item_code}</div>
                      <div className="cell-wrap cell-strong">{l.item_description}</div>
                      {l.item_specification && (
                        <div className="cell-wrap" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                          {l.item_specification}
                        </div>
                      )}
                    </td>
                    <td>
                      {l.mln_no ? (
                        <span className="cell-code" title={`MLN — Material Lot Number (Sr. ${l.mln_sr_no ?? '—'})`}>{l.mln_no}</span>
                      ) : (
                        <span className="cell-muted" style={{ fontSize: 'var(--text-2xs)' }}>
                          {isDraft ? 'Assigned on post' : '—'}
                        </span>
                      )}
                    </td>
                    <td className="right num cell-muted">{l.invoice_qty ? qty(l.invoice_qty) : '—'}</td>
                    <td className="right num cell-strong" style={{ color: 'var(--success-600)' }}>{qty(l.grn_qty)}</td>
                    <td className="center"><Badge tone="neutral" plain>{l.uom_code ?? '—'}</Badge></td>
                    <td className="right num cell-muted">{money(l.rate, 4)}</td>
                    <td className="right num cell-strong">{money(l.amount)}</td>
                    <td style={{ fontSize: 'var(--text-2xs)' }} className="cell-muted">
                      {[l.batch_no, l.receipt_location].filter(Boolean).join(' · ') || '—'}
                    </td>
                    {!isDirect && (
                      <td className="right num" style={{ color: Number(l.pending_grn_qty ?? 0) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
                        {l.pending_grn_qty ? qty(l.pending_grn_qty) : '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={isDirect ? 3 : 4}>Total</td>
                  <td className="right num">{qty(totalInvoiceQty)}</td>
                  <td className="right num">{qty(totalQty)}</td>
                  <td />
                  <td />
                  <td className="right num" style={{ fontSize: 'var(--text-md)' }}>{money(totalValue)}</td>
                  <td colSpan={isDirect ? 1 : 2} />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardBody>
      </Card>

      <ConfirmDialog
        open={action !== null}
        onClose={() => { setAction(null); setReason(''); }}
        onConfirm={() => action && run.mutate(action)}
        loading={run.isPending}
        title={
          action === 'post' ? 'Post this goods receipt?'
            : action === 'cancel' ? 'Cancel this goods receipt?'
            : 'Delete this draft?'
        }
        confirmLabel={action === 'post' ? 'Post GRN' : action === 'cancel' ? 'Cancel receipt' : 'Delete'}
        variant={action === 'post' ? 'primary' : 'danger'}
        requireReason={action === 'cancel'}
        reasonLabel="Reason for reversal"
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action === 'post' ? (
            <>
              <strong>{qty(totalQty)}</strong> units will be recorded{isDirect ? '' : (
                <> against {isMultiPo ? `${data.poNumbers.length} purchase orders` : <strong>{data.po_no}</strong>} and its outstanding balance will update immediately</>
              )}.
              Quantities are re-validated at this moment against the live outstanding balance.
            </>
          ) : action === 'cancel' ? (
            <>
              {isDirect
                ? 'This direct receipt will be marked cancelled. It is retained with its reason for audit.'
                : "The received quantities return to the purchase order's outstanding balance, and PO status is recomputed. The receipt is retained with its reason for audit."}
            </>
          ) : (
            <>Draft <strong>{data.grn_no}</strong> will be permanently deleted.</>
          )
        }
      />
    </>
  );
}
