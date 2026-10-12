/**
 * Purchase Indent — document view (SRS §10, §14).
 *
 * Header, lines with live balances, approval history, and the purchase orders the
 * indent produced — the drill-down §14 requires from a document to what it became.
 */
import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Pencil, Send, CheckCircle2, XCircle, Ban, Printer,
  ShoppingCart, RotateCcw, Trash2, History,
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader, PrintHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, StatusBadge, Badge, ConfirmDialog, DetailItem, DetailGrid, LoadingBlock, ErrorState, ProgressBar,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { money, qty, formatDate, formatDateTime, count, text, statusLabel } from '../../lib/format';

interface IndentLine {
  indent_line_id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  indent_qty: string;
  ordered_qty: string;
  pending_qty: string;
  estimated_rate: string | null;
  estimated_value: string;
  uom_code: string | null;
  department_name: string | null;
  cost_centre_name: string | null;
  line_status: string;
  is_eligible_for_po: boolean;
  required_by_date: string | null;
  remarks: string;
}

interface IndentDoc {
  id: number;
  indent_no: string;
  indent_date: string;
  indent_time: string;
  status: string;
  indent_type_name: string | null;
  department_name: string | null;
  cost_centre_name: string | null;
  suggested_supplier_name: string | null;
  requested_by_name: string | null;
  requested_by_code: string | null;
  approved_by_name: string | null;
  rejected_by_name: string | null;
  approved_at: string | null;
  rejected_at: string | null;
  submitted_at: string | null;
  rejection_reason: string | null;
  required_by_date: string | null;
  remarks: string;
  line_count: number;
  total_indent_qty: string;
  total_ordered_qty: string;
  total_pending_qty: string;
  total_estimated_value: string;
  eligible_line_count: number;
  lines: IndentLine[];
  approvals: { id: number; action: string; reason: string | null; from_status: string; to_status: string; created_at: string; actor_name: string | null; actor_code: string | null }[];
  linkedPurchaseOrders: { po_id: number; po_no: string; po_date: string; status: string; total_amount: string; supplier_name: string }[];
}

type ActionKind = 'submit' | 'approve' | 'reject' | 'unapprove' | 'cancel' | 'reopen' | 'delete';

export default function IndentDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { can, user, isSuperAdmin } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState('');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['indent', id],
    queryFn: () => api.get<IndentDoc>(`/indents/${id}`),
  });

  const run = useMutation({
    mutationFn: (kind: ActionKind) =>
      kind === 'delete'
        ? api.del<{ message: string }>(`/indents/${id}`)
        : api.post<{ message: string }>(`/indents/${id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res, kind) => {
      toast.success('Indent updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['indents'] });
      void qc.invalidateQueries({ queryKey: ['indent', id] });
      if (kind === 'delete') navigate('/indents');
    },
    onError: (err) => toast.fromError(err),
  });

  if (isLoading) return <LoadingBlock label="Loading indent…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const isDraft = data.status === 'DRAFT';
  const isPending = data.status === 'PENDING_APPROVAL';
  const isApproved = data.status === 'APPROVED';
  // Server-side rule (indent/routes.ts): a Super Admin MAY approve their own
  // indent; every other approver may not. Mirror that exactly here — this is
  // a UX convenience only, never the actual authorization boundary, which the
  // server re-checks on every request regardless.
  const ownIndent = data.requested_by_code === user?.employeeId;
  const blockedBySelfApproval = ownIndent && !isSuperAdmin;
  // Mirrors the server-side guard (indent/routes.ts): an APPROVED indent
  // cannot be unapproved once any of its quantity has actually been drawn
  // into a purchase order — reverse the PO first, not the indent.
  const hasBeenOrdered = Number(data.total_ordered_qty) > 0;

  const orderedPct = Number(data.total_indent_qty) > 0
    ? (Number(data.total_ordered_qty) / Number(data.total_indent_qty)) * 100
    : 0;

  return (
    <>
      <PrintHeader title={`Purchase Indent ${data.indent_no}`} />

      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
            {data.indent_no}
            <StatusBadge status={data.status} />
          </span>
        }
        subtitle={`Raised ${formatDate(data.indent_date)} by ${text(data.requested_by_name)} · ${count(data.line_count)} line(s)`}
        breadcrumbs={[
          { label: 'Purchase Indent', to: '/indents' },
          { label: 'Data', to: '/indents' },
          { label: data.indent_no },
        ]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/indents')}>Back</Button>
            <Button variant="secondary" size="sm" icon={<Printer size={13} />} onClick={() => window.print()}>Print</Button>

            {(isDraft || isPending) && (can('indent.edit') || can('indent.approve')) && (
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => navigate(`/indents/${id}/edit`)}>Edit</Button>
            )}
            {isDraft && can('indent.create') && (
              <Button variant="primary" size="sm" icon={<Send size={13} />} onClick={() => setAction('submit')}>Submit</Button>
            )}
            {isDraft && can('indent.delete') && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setAction('delete')}>Delete</Button>
            )}

            {isPending && can('indent.approve') && (
              <Button
                variant="success" size="sm" icon={<CheckCircle2 size={13} />}
                onClick={() => setAction('approve')}
                disabled={blockedBySelfApproval}
                title={blockedBySelfApproval ? 'You cannot approve an indent you raised yourself' : undefined}
              >
                Approve
              </Button>
            )}
            {isPending && can('indent.reject') && (
              <Button variant="danger" size="sm" icon={<XCircle size={13} />} onClick={() => { setReason(''); setAction('reject'); }}>
                Reject
              </Button>
            )}

            {data.status === 'REJECTED' && can('indent.edit') && (
              <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={() => setAction('reopen')}>
                Reopen as draft
              </Button>
            )}

            {isApproved && data.eligible_line_count > 0 && can('po.create') && (
              <Button
                variant="primary" size="sm" icon={<ShoppingCart size={13} />}
                onClick={() => navigate(`/purchase-orders/new?indentId=${data.id}`)}
              >
                Create purchase order
              </Button>
            )}
            {isApproved && can('indent.approve') && (
              <Button
                variant="danger" size="sm" icon={<RotateCcw size={13} />}
                onClick={() => { setReason(''); setAction('unapprove'); }}
                disabled={hasBeenOrdered}
                title={hasBeenOrdered
                  ? 'This indent has already been converted into a purchase order — cancel or short-close that PO first'
                  : undefined}
              >
                Unapprove
              </Button>
            )}
            {(isDraft || isApproved) && can('indent.edit') && (
              <Button variant="ghost" size="sm" icon={<Ban size={13} />} onClick={() => { setReason(''); setAction('cancel'); }}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {data.status === 'REJECTED' && data.rejection_reason && (
        <div
          role="alert"
          style={{
            padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--danger-50)', border: '1px solid var(--danger-100)',
            borderLeft: '3px solid var(--danger-500)', borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--danger-700)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            Rejected by {text(data.rejected_by_name)} · {formatDateTime(data.rejected_at)}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)', marginTop: 5 }}>{data.rejection_reason}</div>
        </div>
      )}

      {/* ── Summary ───────────────────────────────────────────────────────── */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Indent quantity" value={qty(data.total_indent_qty)} />
        <StatTile label="Ordered" value={qty(data.total_ordered_qty)} tone="info" />
        <StatTile
          label="Pending PO"
          value={qty(data.total_pending_qty)}
          tone={Number(data.total_pending_qty) > 0 ? 'warning' : 'success'}
        />
        <StatTile label="Lines eligible for PO" value={count(data.eligible_line_count)} tone={data.eligible_line_count > 0 ? 'info' : 'default'} />
      </div>

      {Number(data.total_ordered_qty) > 0 && (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardBody style={{ padding: 'var(--sp-4)' }}>
            <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-700)' }}>Conversion to purchase orders</span>
              <div className="spacer" />
              <span className="num" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                {qty(data.total_ordered_qty)} of {qty(data.total_indent_qty)} ordered
              </span>
            </div>
            <ProgressBar value={orderedPct} tone={orderedPct >= 100 ? 'success' : 'progress'} />
          </CardBody>
        </Card>
      )}

      {/* ── Header details ────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Indent header" />
        <CardBody>
          <DetailGrid cols={4}>
            <DetailItem label="Indent no." mono>{data.indent_no}</DetailItem>
            <DetailItem label="Date">{formatDate(data.indent_date)}</DetailItem>
            <DetailItem label="Expected date">{data.required_by_date ? formatDate(data.required_by_date) : '—'}</DetailItem>
            <DetailItem label="Time" mono>{text(data.indent_time)}</DetailItem>
            <DetailItem label="Indent type">{text(data.indent_type_name)}</DetailItem>
            <DetailItem label="Department">{text(data.department_name)}</DetailItem>
            <DetailItem label="Cost centre">{text(data.cost_centre_name)}</DetailItem>
            <DetailItem label="Requested by">
              {text(data.requested_by_name)}
              {data.requested_by_code && <span className="cell-muted"> · {data.requested_by_code}</span>}
            </DetailItem>
            <DetailItem label="Submitted">{data.submitted_at ? formatDateTime(data.submitted_at) : '—'}</DetailItem>
            <DetailItem label="Approved by">{text(data.approved_by_name)}</DetailItem>
            <DetailItem label="Approved at">{data.approved_at ? formatDateTime(data.approved_at) : '—'}</DetailItem>
          </DetailGrid>
        </CardBody>
      </Card>

      {/* ── Lines ─────────────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader
          title="Item lines"
          subtitle="Pending quantity is the indent quantity less what has already been ordered"
        />
        <CardBody flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Item Code</th>
                  <th>Item Description</th>
                  <th className="right">Indent Qty</th>
                  <th className="center">UOM</th>
                  <th className="right">Ordered</th>
                  <th className="right">Pending</th>
                  <th className="center">Line Status</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.indent_line_id} className="clickable" onClick={() => navigate(`/masters/items/${l.item_id}`)}>
                    <td className="cell-muted num">{l.line_no}</td>
                    <td className="cell-code">{l.item_code}</td>
                    <td style={{ minWidth: 200, maxWidth: 340 }}>
                      <div className="cell-strong cell-wrap">{l.item_description}</div>
                      {l.item_specification && (
                        <div className="cell-wrap" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{l.item_specification}</div>
                      )}
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                        {[l.department_name, l.cost_centre_name].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="right num cell-strong">{qty(l.indent_qty)}</td>
                    <td className="center"><Badge tone="neutral" plain>{l.uom_code ?? '—'}</Badge></td>
                    <td className="right num">{qty(l.ordered_qty)}</td>
                    <td className="right num" style={{ color: Number(l.pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>
                      {qty(l.pending_qty)}
                    </td>
                    <td className="center"><StatusBadge status={l.line_status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={3}>Total</td>
                  <td className="right num">{qty(data.total_indent_qty)}</td>
                  <td />
                  <td className="right num">{qty(data.total_ordered_qty)}</td>
                  <td className="right num">{qty(data.total_pending_qty)}</td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
        </CardBody>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-4)' }}>
        {/* ── Linked POs ──────────────────────────────────────────────────── */}
        <Card>
          <CardHeader icon={<ShoppingCart size={15} />} title="Purchase orders from this indent"
                      subtitle={data.linkedPurchaseOrders.length === 0 ? 'None raised yet' : `${data.linkedPurchaseOrders.length} order(s)`} />
          <CardBody flush>
            {data.linkedPurchaseOrders.length === 0 ? (
              <div style={{ padding: 'var(--sp-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {isApproved
                  ? 'This indent is approved and ready to be converted into a purchase order.'
                  : 'Purchase orders will appear here once the indent is approved and ordered.'}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead><tr><th>PO No</th><th>Date</th><th>Supplier</th><th className="center">Status</th><th className="right">Value</th></tr></thead>
                  <tbody>
                    {data.linkedPurchaseOrders.map((p) => (
                      <tr key={p.po_id} className="clickable" onClick={() => navigate(`/purchase-orders/${p.po_id}`)}>
                        <td className="cell-code">{p.po_no}</td>
                        <td>{formatDate(p.po_date)}</td>
                        <td className="cell-wrap" style={{ minWidth: 130, maxWidth: 220 }}>{p.supplier_name}</td>
                        <td className="center"><StatusBadge status={p.status} /></td>
                        <td className="right num cell-strong">{money(p.total_amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Approval history ────────────────────────────────────────────── */}
        <Card>
          <CardHeader icon={<History size={15} />} title="Approval history" subtitle="Every state change, with its actor and reason" />
          <CardBody>
            {data.approvals.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 'var(--sp-4)' }}>
                No workflow events yet — this indent is still a draft.
              </div>
            ) : (
              <div className="stack" style={{ gap: 0 }}>
                {data.approvals.map((a, i) => (
                  <div key={a.id} className="row" style={{ gap: 'var(--sp-3)', alignItems: 'flex-start', paddingBottom: i === data.approvals.length - 1 ? 0 : 'var(--sp-4)' }}>
                    <div className="stack" style={{ alignItems: 'center', alignSelf: 'stretch' }}>
                      <span
                        style={{
                          width: 26, height: 26, borderRadius: '50%', flexShrink: 0,
                          display: 'grid', placeItems: 'center',
                          background: a.action === 'APPROVE' ? 'var(--success-50)'
                            : a.action === 'REJECT' ? 'var(--danger-50)'
                            : a.action === 'CANCEL' ? 'var(--danger-50)' : 'var(--info-50)',
                          color: a.action === 'APPROVE' ? 'var(--success-600)'
                            : a.action === 'REJECT' || a.action === 'CANCEL' ? 'var(--danger-600)' : 'var(--info-600)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        {a.action === 'APPROVE' ? <CheckCircle2 size={13} />
                          : a.action === 'REJECT' ? <XCircle size={13} />
                          : a.action === 'CANCEL' ? <Ban size={13} />
                          : a.action === 'REOPEN' ? <RotateCcw size={13} /> : <Send size={13} />}
                      </span>
                      {i < data.approvals.length - 1 && (
                        <span style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 4 }} />
                      )}
                    </div>
                    <div className="grow" style={{ minWidth: 0, paddingTop: 2 }}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>
                          {statusLabel(a.action)}
                        </span>
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
                          {statusLabel(a.from_status)} → {statusLabel(a.to_status)}
                        </span>
                      </div>
                      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 1 }}>
                        {text(a.actor_name)}{a.actor_code ? ` · ${a.actor_code}` : ''} · {formatDateTime(a.created_at)}
                      </div>
                      {a.reason && (
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-700)', marginTop: 4, padding: '6px 9px', background: 'var(--bg-inset)', borderRadius: 'var(--radius-xs)', border: '1px solid var(--border-subtle)' }}>
                          {a.reason}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
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
          action === 'submit' ? 'Submit for approval?'
            : action === 'approve' ? 'Approve this indent?'
            : action === 'reject' ? 'Reject this indent?'
            : action === 'unapprove' ? 'Unapprove this indent?'
            : action === 'cancel' ? 'Cancel this indent?'
            : action === 'reopen' ? 'Reopen as draft?'
            : 'Delete this draft?'
        }
        confirmLabel={
          action === 'submit' ? 'Submit'
            : action === 'approve' ? 'Approve'
            : action === 'reject' ? 'Reject'
            : action === 'unapprove' ? 'Unapprove'
            : action === 'cancel' ? 'Cancel indent'
            : action === 'reopen' ? 'Reopen'
            : 'Delete'
        }
        variant={action === 'approve' ? 'success' : action === 'submit' || action === 'reopen' || action === 'unapprove' ? 'primary' : 'danger'}
        requireReason={action === 'reject' || action === 'cancel'}
        reasonLabel={action === 'reject' ? 'Rejection reason' : 'Cancellation reason'}
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action === 'submit' ? <>Indent <strong>{data.indent_no}</strong> will go to the Purchase Head and can no longer be edited.</>
            : action === 'approve' ? <>Its {count(data.line_count)} line(s) become available for purchase orders.</>
            : action === 'reject' ? <>The indent is permanently rejected. The reason is recorded on the document and in the audit trail.</>
            : action === 'unapprove' ? <>The indent returns directly to <strong>Draft</strong> — fully editable, not rejected — so it can be corrected and resubmitted for approval.</>
            : action === 'cancel' ? <>An indent already converted into a purchase order cannot be cancelled.</>
            : action === 'reopen' ? <>The indent returns to draft so it can be corrected and resubmitted.</>
            : <>Draft <strong>{data.indent_no}</strong> will be permanently deleted.</>
        }
      />
    </>
  );
}
