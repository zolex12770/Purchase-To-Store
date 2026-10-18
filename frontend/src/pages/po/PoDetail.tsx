/**
 * Purchase Order — document view (SRS §11, §14).
 *
 * Every line answers "where did this quantity come from?" by showing its source
 * indent lines, and "where did it go?" by listing the goods receipts against it —
 * the full drill-down chain §14 requires.
 */
import { useState, useRef } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Pencil, Send, Ban, Eye, Download, Printer, Truck, Trash2, Lock, GitMerge, FileText, AlertTriangle,
} from 'lucide-react';
import { api, fetchHtml, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, StatusBadge, Badge, ConfirmDialog, DetailItem, DetailGrid, LoadingBlock, ErrorState, ProgressBar, Modal,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { HelpStrip } from '../../components/simple';
import { StoreReceiptBanners } from '../../components/ReceiptEvidence';
import { money, qty, formatDate, formatDateTime, count, text, percent } from '../../lib/format';
import type { StoreReceiptAwaitingLink, StoreSheetReceipt } from '../../lib/receiptEvidence';

interface PoSource {
  source_id: number;
  po_line_id: number;
  indent_id: number;
  indent_line_id: number;
  indent_no: string;
  indent_date: string;
  indent_line_no: number;
  consumed_qty: string;
  indent_qty: string;
}

interface PoLine {
  po_line_id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  po_qty: string;
  received_qty: string;
  pending_grn_qty: string;
  /** Still to be received: 0 on a short-closed, cancelled or draft order and on a closed line (migration 031). */
  open_pending_qty: string;
  rate: string;
  discount_pct: string;
  final_rate: string;
  amount: string;
  gst_pct: string;
  gst_amount: string;
  received_amount: string;
  pending_amount: string;
  uom_code: string | null;
  line_status: string;
  delivery_date: string | null;
  remarks: string;
  sources: PoSource[];
}

interface PoDoc {
  id: number;
  po_no: string;
  po_date: string;
  po_time: string;
  status: string;
  source_mode: string;
  po_type_name: string | null;
  supplier_id: number;
  supplier_name: string;
  supplier_code: string;
  supplier_address: string;
  supplier_city: string;
  supplier_state: string;
  supplier_gst: string;
  supplier_email: string;
  supplier_mobile: string;
  supplier_contact: string;
  currency_code: string;
  payment_terms: string;
  delivery_date: string | null;
  delivery_address: string;
  remarks: string;
  issued_at: string | null;
  close_reason: string | null;
  created_by_name: string | null;
  issued_by_name: string | null;
  line_count: number;
  total_po_qty: string;
  total_received_qty: string;
  total_pending_qty: string;
  total_amount: string;
  received_amount: string;
  pending_amount: string;
  age_days: number;
  total_gst_amount: string;
  discount_mode: 'PERCENTAGE' | 'AMOUNT'; discount_value: string; discount_amount: string;
  freight_mode: 'PERCENTAGE' | 'AMOUNT'; freight_value: string; freight_amount: string;
  packing_mode: 'PERCENTAGE' | 'AMOUNT'; packing_value: string; packing_amount: string;
  insurance_mode: 'PERCENTAGE' | 'AMOUNT'; insurance_value: string; insurance_amount: string;
  grand_total: string;
  lines: PoLine[];
  grns: { id: number; grn_no: string; grn_date: string; status: string; challan_no: string; received_by_name: string | null; total_qty: string; total_amount: string }[];
  sourceIndents: { indentId: number; indentNo: string; indentDate: string }[];
  /** Store receipts the link repair held back that name this PO (backend receipt-evidence.ts). */
  storeReceiptsAwaitingLink?: StoreReceiptAwaitingLink[];
  /** Receipts on the store's GRN sheet that no ERP GRN holds, naming this PO. */
  storeSheetReceipts?: StoreSheetReceipt[];
  /** Sheet lines an ERP receipt posted since covers: posted under another GRN number. */
  storeSheetReceiptsPostedInErp?: StoreSheetReceipt[];
}

type ActionKind = 'issue' | 'cancel' | 'short-close' | 'delete';

export default function PoDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  // Set only when arriving straight from the create screen (router state, so a
  // refresh or a link to this page does not show the 'just saved' message again).
  const justSaved = Boolean((useLocation().state as { justSaved?: string } | null)?.justSaved);
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState('');
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const html = await fetchHtml(`/purchase-orders/${id}/print-view`);
      setPreviewHtml(html);
    } catch (err) {
      toast.fromError(err, 'Could not load the PO preview');
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const printFromPreview = () => {
    const win = previewFrameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      await downloadFile(`/purchase-orders/${id}/pdf`, `${data?.po_no ?? 'purchase-order'}.pdf`);
    } catch (err) {
      toast.fromError(err, 'Could not download the PDF');
    } finally {
      setDownloading(false);
    }
  };

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['purchase-order', id],
    queryFn: () => api.get<PoDoc>(`/purchase-orders/${id}`),
  });

  const run = useMutation({
    mutationFn: (kind: ActionKind) =>
      kind === 'delete'
        ? api.del<{ message: string }>(`/purchase-orders/${id}`)
        : api.post<{ message: string }>(`/purchase-orders/${id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res, kind) => {
      toast.success('Purchase order updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['purchase-order', id] });
      void qc.invalidateQueries({ queryKey: ['indents'] });
      if (kind === 'delete') navigate('/purchase-orders');
    },
    onError: (err) => toast.fromError(err),
  });

  if (isLoading) return <LoadingBlock label="Loading purchase order…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const isDraft = data.status === 'DRAFT';
  const isReceivable = data.status === 'OPEN' || data.status === 'PARTIALLY_RECEIVED';
  const receivedPct = Number(data.total_po_qty) > 0
    ? (Number(data.total_received_qty) / Number(data.total_po_qty)) * 100
    : 0;
  const overdue = Boolean(
    data.delivery_date && new Date(data.delivery_date) < new Date() && Number(data.total_pending_qty) > 0,
  );

  return (
    <>
      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {data.po_no}
            <StatusBadge status={data.status} />
            <Badge tone={data.source_mode === 'INDENT' ? 'info' : 'neutral'}>
              {data.source_mode === 'INDENT' ? 'From indent' : 'Direct'}
            </Badge>
            {data.sourceIndents.length > 1 && (
              <Badge tone="progress">Consolidated · {data.sourceIndents.length} indents</Badge>
            )}
          </span>
        }
        subtitle={`${data.supplier_name} · ${formatDate(data.po_date)} · ${count(data.line_count)} line(s)`}
        breadcrumbs={[
          { label: 'Purchase Order', to: '/purchase-orders' },
          { label: 'Data', to: '/purchase-orders' },
          { label: data.po_no },
        ]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/purchase-orders')}>Back</Button>
            <Button variant="secondary" size="sm" icon={<Eye size={13} />} onClick={() => void openPreview()}>Preview</Button>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} loading={downloading} onClick={() => void downloadPdf()}>Download PDF</Button>

            {(isDraft || isReceivable) && can('po.edit') && (
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => navigate(`/purchase-orders/${id}/edit`)}>Edit</Button>
            )}
            {isDraft && can('po.approve') && (
              <Button variant="primary" size="sm" icon={<Send size={13} />} onClick={() => setAction('issue')}>Issue PO</Button>
            )}
            {isDraft && can('po.delete') && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setAction('delete')}>Delete</Button>
            )}

            {isReceivable && can('grn.create') && (
              <Button variant="primary" size="sm" icon={<Truck size={13} />} onClick={() => navigate(`/grn/new?poId=${data.id}`)}>
                Receive Material
              </Button>
            )}
            {isReceivable && can('po.approve') && Number(data.total_pending_qty) > 0 && (
              <Button variant="secondary" size="sm" icon={<Lock size={13} />} onClick={() => { setReason(''); setAction('short-close'); }}>
                Short close
              </Button>
            )}
            {(isDraft || data.status === 'OPEN') && can('po.approve') && (
              <Button variant="ghost" size="sm" icon={<Ban size={13} />} onClick={() => { setReason(''); setAction('cancel'); }}>Cancel</Button>
            )}
          </>
        }
      />

      {/* Arriving straight from Create Purchase Order: say what was saved, under
          which number, and what the next step is. */}
      {justSaved && (
        <HelpStrip tone="success">
          <strong>Saved. Purchase order number: {data.po_no}.</strong>{' '}
          {isDraft
            ? (can('po.approve')
              ? 'It is a draft. Next step: press “Issue PO” so the store can receive material against it.'
              : 'It is a draft. Next step: a person who can issue purchase orders must issue it.')
            : isReceivable
              ? 'It is issued. Next step: when the material comes, the store presses “Receive Material”.'
              : 'Nothing more is needed here.'}
        </HelpStrip>
      )}

      {data.close_reason && (
        <div
          style={{
            padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: data.status === 'CANCELLED' ? 'var(--danger-50)' : 'var(--warning-50)',
            border: `1px solid ${data.status === 'CANCELLED' ? 'var(--danger-100)' : 'var(--warning-100)'}`,
            borderLeft: `3px solid ${data.status === 'CANCELLED' ? 'var(--danger-500)' : 'var(--warning-500)'}`,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.04em', color: data.status === 'CANCELLED' ? 'var(--danger-700)' : 'var(--warning-700)' }}>
            {data.status === 'CANCELLED' ? 'Cancelled' : 'Short closed'}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)', marginTop: 5 }}>{data.close_reason}</div>
        </div>
      )}

      {overdue && (
        <div
          className="row"
          style={{
            gap: 9, padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--danger-50)', border: '1px solid var(--danger-100)',
            borderRadius: 'var(--radius-sm)', color: 'var(--danger-700)', fontSize: 'var(--text-sm)',
          }}
        >
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span>
            Delivery was promised for <strong>{formatDate(data.delivery_date)}</strong> and{' '}
            <strong>{qty(data.total_pending_qty)}</strong> is still outstanding.
          </span>
        </div>
      )}

      {/* Receipts the store recorded that the ERP does not count against this order yet:
          held back by the store GRN link repair, or on the store's GRN sheet only. */}
      <StoreReceiptBanners
        awaiting={data.storeReceiptsAwaitingLink ?? []}
        sheet={data.storeSheetReceipts ?? []}
        postedInErp={data.storeSheetReceiptsPostedInErp ?? []}
        poStatus={data.status}
        receiveAction={isReceivable && can('grn.create') ? (
          <Button variant="secondary" size="sm" icon={<Truck size={13} />} onClick={() => navigate(`/grn/new?poId=${data.id}`)}>
            Receive material
          </Button>
        ) : undefined}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="PO quantity" value={qty(data.total_po_qty)} />
        <StatTile label="Received" value={qty(data.total_received_qty)} tone="success" />
        <StatTile label="Pending GRN" value={qty(data.total_pending_qty)} tone={Number(data.total_pending_qty) > 0 ? 'warning' : 'success'} />
        <StatTile label="Order value" value={money(data.total_amount)} />
        <StatTile label="Received value" value={money(data.received_amount)} tone="success" />
        <StatTile label="Pending value" value={money(data.pending_amount)} tone={Number(data.pending_amount) > 0 ? 'warning' : 'default'} />
        <StatTile label="Grand total" value={money(data.grand_total)} tone="info" />
      </div>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody style={{ padding: 'var(--sp-4)' }}>
          <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 8 }}>
            <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-700)' }}>Receipt progress</span>
            <div className="spacer" />
            <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {qty(data.total_received_qty)} of {qty(data.total_po_qty)} · {percent(receivedPct)}
            </span>
          </div>
          <ProgressBar value={receivedPct} tone={receivedPct >= 100 ? 'success' : receivedPct > 0 ? 'progress' : 'info'} />
        </CardBody>
      </Card>

      {/* ── Header + supplier ─────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
        <Card>
          <CardHeader title="Purchase order header" />
          <CardBody>
            <DetailGrid cols={3}>
              <DetailItem label="PO no." mono>{data.po_no}</DetailItem>
              <DetailItem label="Date">{formatDate(data.po_date)}</DetailItem>
              <DetailItem label="Time" mono>{text(data.po_time)}</DetailItem>
              <DetailItem label="PO type">{text(data.po_type_name)}</DetailItem>
              <DetailItem label="Payment terms">{text(data.payment_terms)}</DetailItem>
              <DetailItem label="Created by">{text(data.created_by_name)}</DetailItem>
              <DetailItem label="Issued">{data.issued_at ? formatDateTime(data.issued_at) : 'Not issued'}</DetailItem>
            </DetailGrid>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Supplier"
            actions={
              <Button variant="ghost" size="sm" onClick={() => navigate(`/masters/suppliers/${data.supplier_id}`)}>
                Open supplier
              </Button>
            }
          />
          <CardBody>
            <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--ink-900)', marginBottom: 8 }}>
              {data.supplier_name}
            </div>
            <DetailGrid cols={2}>
              <DetailItem label="Supplier code" mono>{data.supplier_code}</DetailItem>
              <DetailItem label="Contact person">{text(data.supplier_contact)}</DetailItem>
              <DetailItem label="Mobile">{text(data.supplier_mobile)}</DetailItem>
              <DetailItem label="Email">{text(data.supplier_email)}</DetailItem>
              <DetailItem label="GST no." mono>{text(data.supplier_gst)}</DetailItem>
              <DetailItem label="Location">{text([data.supplier_city, data.supplier_state].filter(Boolean).join(', '))}</DetailItem>
              <div style={{ gridColumn: '1 / -1' }}>
                <DetailItem label="Address">{text(data.supplier_address)}</DetailItem>
              </div>
            </DetailGrid>
          </CardBody>
        </Card>
      </div>

      {/* ── Lines with source traceability ────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader
          title="Purchase order lines"
          subtitle="Final rate and amount are computed by the database from quantity, rate and discount"
        />
        <CardBody flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Item</th>
                  <th className="right">PO Qty</th>
                  <th className="right">Rate/pc</th>
                  <th className="right">Disc %</th>
                  <th className="right">Final Rate/pc</th>
                  <th className="right">Amount</th>
                  <th className="right">GST %</th>
                  <th className="right">GST Amt</th>
                  <th className="right">Received</th>
                  <th className="right">Pending GRN</th>
                  <th className="center">Line Status</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.po_line_id}>
                    <td className="cell-muted num">{l.line_no}</td>
                    <td style={{ maxWidth: 340 }}>
                      <div
                        className="cell-code"
                        style={{ cursor: 'pointer' }}
                        onClick={() => navigate(`/masters/items/${l.item_id}`)}
                      >
                        {l.item_code}
                      </div>
                      <div className="cell-wrap cell-strong">{l.item_description}</div>
                      {l.item_specification && (
                        <div className="cell-wrap" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                          {l.item_specification}
                        </div>
                      )}
                      {/* SRS §11.3 — where did this quantity come from? */}
                      {l.sources.length > 0 && (
                        <div className="row" style={{ gap: 5, marginTop: 5, flexWrap: 'wrap' }}>
                          <GitMerge size={11} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
                          {l.sources.map((s) => (
                            <button
                              key={s.source_id}
                              onClick={() => navigate(`/indents/${s.indent_id}`)}
                              className="chip"
                              style={{ cursor: 'pointer' }}
                              title={`Indent ${s.indent_no} line ${s.indent_line_no}: ${qty(s.consumed_qty)} of ${qty(s.indent_qty)} consumed`}
                            >
                              {s.indent_no} · L{s.indent_line_no} · {qty(s.consumed_qty)}
                            </button>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="right num cell-strong">{qty(l.po_qty)}</td>
                    <td className="right num cell-muted">{money(l.rate, 4)}</td>
                    <td className="right num">{Number(l.discount_pct) > 0 ? percent(l.discount_pct, 2) : '—'}</td>
                    <td className="right num">{money(l.final_rate, 4)}</td>
                    <td className="right num cell-strong">{money(l.amount)}</td>
                    <td className="right num">{Number(l.gst_pct) > 0 ? percent(l.gst_pct, 2) : '—'}</td>
                    <td className="right num cell-muted">{money(l.gst_amount)}</td>
                    <td className="right num" style={{ color: 'var(--success-600)' }}>{qty(l.received_qty)}</td>
                    {/* What the order still expects, as the tiles and the total below count it:
                        a short-closed order's lines said 6 pending under a total of 0. */}
                    <td className="right num" style={{ color: Number(l.open_pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
                      {qty(l.open_pending_qty)}
                    </td>
                    <td className="center"><StatusBadge status={l.line_status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={2}>Total</td>
                  <td className="right num">{qty(data.total_po_qty)}</td>
                  <td colSpan={3} />
                  <td className="right num" style={{ fontSize: 'var(--text-md)' }}>{money(data.total_amount)}</td>
                  <td />
                  <td className="right num cell-strong">{money(data.total_gst_amount)}</td>
                  <td className="right num">{qty(data.total_received_qty)}</td>
                  <td className="right num">{qty(data.total_pending_qty)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Charges" subtitle="Applied on the line subtotal; GST is per line item above" />
        <CardBody>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
            <DetailItem label="Subtotal">{money(data.total_amount)}</DetailItem>
            <DetailItem label="GST">{money(data.total_gst_amount)}</DetailItem>
            <DetailItem label="Discount">
              − {money(data.discount_amount)}
              {data.discount_mode === 'PERCENTAGE' && Number(data.discount_value) > 0 && ` (${percent(data.discount_value, 2)})`}
            </DetailItem>
            <DetailItem label="Freight">
              + {money(data.freight_amount)}
              {data.freight_mode === 'PERCENTAGE' && Number(data.freight_value) > 0 && ` (${percent(data.freight_value, 2)})`}
            </DetailItem>
            <DetailItem label="Packing">
              + {money(data.packing_amount)}
              {data.packing_mode === 'PERCENTAGE' && Number(data.packing_value) > 0 && ` (${percent(data.packing_value, 2)})`}
            </DetailItem>
            <DetailItem label="Insurance">
              + {money(data.insurance_amount)}
              {data.insurance_mode === 'PERCENTAGE' && Number(data.insurance_value) > 0 && ` (${percent(data.insurance_value, 2)})`}
            </DetailItem>
          </div>
          <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 'var(--sp-3)' }}>
            <strong style={{ fontSize: 'var(--text-md)' }}>Grand Total</strong>
            <strong className="num" style={{ fontSize: 'var(--text-lg)' }}>{money(data.grand_total)}</strong>
          </div>
        </CardBody>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-4)' }}>
        <Card>
          <CardHeader icon={<Truck size={15} />} title="Goods receipts"
                      subtitle={data.grns.length === 0 ? 'Nothing received yet' : `${data.grns.length} receipt(s)`} />
          <CardBody flush>
            {data.grns.length === 0 ? (
              <div style={{ padding: 'var(--sp-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {isReceivable
                  ? 'No goods received against this order yet.'
                  : 'This order has no goods receipts.'}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr><th>GRN No</th><th>Date</th><th>Challan</th><th className="center">Status</th><th className="right">Qty</th><th className="right">Value</th></tr>
                  </thead>
                  <tbody>
                    {data.grns.map((g) => (
                      <tr key={g.id} className="clickable" onClick={() => navigate(`/grn/${g.id}`)}>
                        <td className="cell-code">{g.grn_no}</td>
                        <td>{formatDate(g.grn_date)}</td>
                        <td className="cell-muted">{text(g.challan_no)}</td>
                        <td className="center"><StatusBadge status={g.status} /></td>
                        <td className="right num">{qty(g.total_qty)}</td>
                        <td className="right num cell-strong">{money(g.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<FileText size={15} />} title="Source indents"
                      subtitle={data.sourceIndents.length === 0 ? 'Direct purchase order — no originating indent' : `Consolidated from ${data.sourceIndents.length} indent(s)`} />
          <CardBody flush>
            {data.sourceIndents.length === 0 ? (
              <div style={{ padding: 'var(--sp-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                This order was raised directly, without an originating requisition.
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead><tr><th>Indent No</th><th>Date</th><th className="right">Lines drawn</th><th className="right">Qty consumed</th></tr></thead>
                  <tbody>
                    {data.sourceIndents.map((si) => {
                      const rows = data.lines.flatMap((l) => l.sources.filter((s) => s.indent_id === si.indentId));
                      const consumed = rows.reduce((sum, s) => sum + Number(s.consumed_qty), 0);
                      return (
                        <tr key={si.indentId} className="clickable" onClick={() => navigate(`/indents/${si.indentId}`)}>
                          <td className="cell-code">{si.indentNo}</td>
                          <td>{formatDate(si.indentDate)}</td>
                          <td className="right num">{count(rows.length)}</td>
                          <td className="right num cell-strong">{qty(consumed)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      <ConfirmDialog
        open={action !== null}
        onClose={() => { setAction(null); setReason(''); }}
        onConfirm={() => action && run.mutate(action)}
        loading={run.isPending}
        title={
          action === 'issue' ? 'Issue this purchase order?'
            : action === 'cancel' ? 'Cancel this purchase order?'
            : action === 'short-close' ? 'Short close this purchase order?'
            : 'Delete this draft?'
        }
        confirmLabel={
          action === 'issue' ? 'Issue PO'
            : action === 'cancel' ? 'Cancel PO'
            : action === 'short-close' ? 'Short close'
            : 'Delete'
        }
        variant={action === 'issue' ? 'primary' : action === 'short-close' ? 'accent' : 'danger'}
        requireReason={action === 'cancel' || action === 'short-close'}
        reasonLabel={action === 'cancel' ? 'Cancellation reason' : 'Reason for closing short'}
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action === 'issue' ? <>PO <strong>{data.po_no}</strong> becomes open for goods receipt and its lines can no longer be edited.</>
            : action === 'cancel' ? <>The order is cancelled and any indent quantity it reserved becomes available again. An order with goods already received cannot be cancelled — short close it instead.</>
            : action === 'short-close' ? <>The outstanding <strong>{qty(data.total_pending_qty)}</strong> will no longer be expected or counted as pending exposure. No further receipts will be accepted.</>
            : <>Draft <strong>{data.po_no}</strong> will be permanently deleted.</>
        }
      />

      <Modal
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewHtml(null); }}
        title={`Purchase Order — ${data.po_no}`}
        subtitle="This is the same document generated as a PDF"
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPreviewOpen(false); setPreviewHtml(null); }}>Close</Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={printFromPreview} disabled={!previewHtml}>Print</Button>
            <Button variant="primary" icon={<Download size={14} />} loading={downloading} onClick={() => void downloadPdf()}>Download PDF</Button>
          </>
        }
      >
        {previewLoading ? (
          <LoadingBlock height={500} />
        ) : (
          <iframe
            ref={previewFrameRef}
            title={`PO ${data.po_no} preview`}
            srcDoc={previewHtml ?? ''}
            style={{ width: '100%', height: '72vh', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: '#fff' }}
          />
        )}
      </Modal>
    </>
  );
}
