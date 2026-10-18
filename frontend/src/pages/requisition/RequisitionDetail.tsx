/**
 * Requisition — document view (Purchase Module tab 4).
 *
 * Header, lines with live Requested/Issued/Pending/Excess balances (never a
 * mutable "issued qty" field — always derived from v_requisition_line_balance,
 * same discipline as the Indent/PO balance views), HOD approval history, and
 * full store-issue history. The Store Issue action is the one safety-critical
 * piece: issue qty is capped ONLY by current stock server-side, never by the
 * requested quantity — this screen shows a non-blocking warning (Rule 23) when
 * a typed issue quantity exceeds what remains pending, but never blocks it.
 * A Store user can reverse an issue slip (with a reason): its material goes
 * back to stock and the slip stays in the history, marked Reversed.
 */
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft, Pencil, Send, CheckCircle2, XCircle, RotateCcw, Ban, Printer, Eye,
  Trash2, History, PackageCheck, TriangleAlert, FileText, Download, Undo2,
} from 'lucide-react';
import { api, ApiError, downloadFile, fetchHtml } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, StatusBadge, Badge, ConfirmDialog, Modal, DetailItem, DetailGrid,
  LoadingBlock, ErrorState, Input, Checkbox, Field, Textarea,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { qty, money, formatDate, formatDateTime, count, text, statusLabel } from '../../lib/format';

interface RequisitionLine {
  requisition_line_id: number;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  main_group_name: string;
  uom_code: string | null;
  requested_qty: string;
  issued_qty: string;
  pending_qty: string;
  excess_qty: string;
  available_stock: string | null;
  line_status: string;
  issue_count: number;
  remarks: string;
  estimated_rate?: string | null;
  estimated_value?: string | null;
}

interface RequisitionDoc {
  id: number;
  requisition_no: string;
  requisition_date: string;
  requisition_time: string;
  status: string;
  hod_status: 'PENDING' | 'APPROVED' | 'REJECTED';
  store_status: 'PENDING' | 'ISSUED';
  employee_name: string;
  employee_code: string;
  requester_user_id: number;
  department_name: string | null;
  hod_name: string | null;
  hod_user_id: number | null;
  machine_name: string | null;
  cost_centre_name: string | null;
  remarks: string;
  submitted_at: string | null;
  hod_decided_at: string | null;
  hod_decided_by_name: string | null;
  hod_decision_reason: string | null;
  close_reason: string | null;
  lines: RequisitionLine[];
  approvals: { id: number; action: string; reason: string | null; from_status: string; to_status: string; created_at: string; actor_name: string | null; actor_code: string | null }[];
  issues: IssueSlip[];
}

/** A REVERSED slip stays in the history; its stock went back and it no longer counts as issued. */
interface IssueSlip {
  id: number; issue_slip_no: string; issue_date: string; remarks: string; created_at: string; store_user_name: string | null;
  status: 'POSTED' | 'REVERSED';
  reversed_at: string | null;
  reversal_reason: string;
  reversed_by_name: string | null;
  lines: { itemCode: string; itemDescription: string; requestedQtySnapshot: string; previouslyIssuedQty: string; issueQty: string }[];
}

type ActionKind = 'submit' | 'approve' | 'reject' | 'return' | 'reopen' | 'cancel' | 'delete';

export default function RequisitionDetail() {
  const { id } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { can, user, isSuperAdmin } = useAuth();
  const toast = useToast();
  const download = useDownload();
  const qc = useQueryClient();

  const [action, setAction] = useState<ActionKind | null>(null);
  const [reason, setReason] = useState('');
  const [issueOpen, setIssueOpen] = useState(searchParams.get('issue') === '1');

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['requisition', id],
    queryFn: () => api.get<RequisitionDoc>(`/requisitions/${id}`),
  });

  const openPreview = async () => {
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const html = await fetchHtml(`/requisitions/${id}/print-view`);
      setPreviewHtml(html);
    } catch (err) {
      toast.fromError(err, 'Could not load the requisition preview');
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
      await downloadFile(`/requisitions/${id}/pdf`, `${data?.requisition_no ?? 'requisition'}.pdf`);
    } catch (err) {
      toast.fromError(err, 'Could not download the PDF');
    } finally {
      setDownloading(false);
    }
  };

  const [issuePreview, setIssuePreview] = useState<{ id: number; slipNo: string } | null>(null);
  const [issuePreviewHtml, setIssuePreviewHtml] = useState<string | null>(null);
  const [issuePreviewLoading, setIssuePreviewLoading] = useState(false);
  const [issueDownloading, setIssueDownloading] = useState(false);
  const issuePreviewFrameRef = useRef<HTMLIFrameElement>(null);

  const openIssuePreview = async (issueId: number, slipNo: string) => {
    setIssuePreview({ id: issueId, slipNo });
    setIssuePreviewLoading(true);
    try {
      const html = await fetchHtml(`/requisitions/issues/${issueId}/print-view`);
      setIssuePreviewHtml(html);
    } catch (err) {
      toast.fromError(err, 'Could not load the issue slip preview');
      setIssuePreview(null);
    } finally {
      setIssuePreviewLoading(false);
    }
  };

  const printIssueFromPreview = () => {
    const win = issuePreviewFrameRef.current?.contentWindow;
    if (!win) return;
    win.focus();
    win.print();
  };

  const downloadIssuePdf = async () => {
    if (!issuePreview) return;
    setIssueDownloading(true);
    try {
      await downloadFile(`/requisitions/issues/${issuePreview.id}/pdf`, `${issuePreview.slipNo}.pdf`);
    } catch (err) {
      toast.fromError(err, 'Could not download the PDF');
    } finally {
      setIssueDownloading(false);
    }
  };

  const run = useMutation({
    mutationFn: (kind: ActionKind) =>
      kind === 'delete'
        ? api.del<{ message: string }>(`/requisitions/${id}`)
        : api.post<{ message: string }>(`/requisitions/${id}/${kind}`, { reason: reason || undefined }),
    onSuccess: (res, kind) => {
      toast.success('Requisition updated', res.message);
      setAction(null); setReason('');
      void qc.invalidateQueries({ queryKey: ['requisitions'] });
      void qc.invalidateQueries({ queryKey: ['requisition', id] });
      if (kind === 'delete') navigate('/requisitions');
    },
    onError: (err) => toast.fromError(err),
  });

  // Reverse one issue slip — its stock goes back; the slip stays, marked reversed.
  const [reversingSlip, setReversingSlip] = useState<IssueSlip | null>(null);
  const [reverseReason, setReverseReason] = useState('');
  const reverseIssue = useMutation({
    mutationFn: (p: { issueId: number; reason: string }) =>
      api.post<{ message: string }>(`/requisitions/${id}/issues/${p.issueId}/reverse`, { reason: p.reason }),
    onSuccess: (res) => {
      toast.success('Issue reversed', res.message);
      setReversingSlip(null); setReverseReason('');
      void qc.invalidateQueries({ queryKey: ['requisitions'] });
      void qc.invalidateQueries({ queryKey: ['requisition', id] });
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
    },
    onError: (err) => toast.fromError(err, 'Could not reverse the issue'),
  });

  if (isLoading) return <LoadingBlock label="Loading requisition…" />;
  if (error) return <ErrorState error={error} onRetry={() => void refetch()} />;
  if (!data) return null;

  const isDraft = data.status === 'DRAFT';
  const isPending = data.status === 'PENDING_APPROVAL';
  const isReturned = data.status === 'RETURNED';
  const isRejected = data.status === 'REJECTED';
  const isIssuable = data.status === 'APPROVED' || data.status === 'PARTIALLY_ISSUED' || data.status === 'FULLY_ISSUED';
  const editable = isDraft || isPending || isReturned;

  const ownRequisition = data.requester_user_id === user?.id;
  const blockedBySelfApproval = ownRequisition && !isSuperAdmin;
  const wrongHod = data.hod_user_id !== null && data.hod_user_id !== user?.id && !isSuperAdmin;
  const approveDisabled = blockedBySelfApproval || wrongHod;
  const approveDisabledReason = blockedBySelfApproval
    ? 'You cannot approve a requisition you raised yourself.'
    : wrongHod ? 'Only this requisition\'s HOD can approve it.' : undefined;

  // Only slips still standing block a cancel; a reversed one returned its stock.
  const postedIssueCount = data.issues.filter((i) => i.status !== 'REVERSED').length;
  const reversedIssueCount = data.issues.length - postedIssueCount;
  const hasAnyIssue = postedIssueCount > 0;
  const canSeeFinancials = can('requisition.approve') || isSuperAdmin;
  const totalRequested = data.lines.reduce((s, l) => s + Number(l.requested_qty), 0);
  const totalIssued = data.lines.reduce((s, l) => s + Number(l.issued_qty), 0);
  const totalPending = data.lines.reduce((s, l) => s + Number(l.pending_qty), 0);
  const totalExcess = data.lines.reduce((s, l) => s + Number(l.excess_qty), 0);
  const totalEstimatedValue = data.lines.reduce((s, l) => s + (l.estimated_value != null ? Number(l.estimated_value) : 0), 0);
  const unpricedLinesCount = data.lines.filter((l) => l.estimated_rate == null || Number(l.estimated_rate) <= 0).length;

  return (
    <>
      <PageHeader
        title={
          <span className="row" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            {data.requisition_no}
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', fontWeight: 400 }}>({statusLabel(data.status)})</span>
            <span className="row" style={{ gap: 4 }}>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>HOD</span>
              <StatusBadge status={data.hod_status} />
            </span>
            <span className="row" style={{ gap: 4 }}>
              <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>Store</span>
              <StatusBadge status={data.store_status} />
            </span>
          </span>
        }
        subtitle={`Raised ${formatDate(data.requisition_date)} by ${text(data.employee_name)} · ${count(data.lines.length)} line(s)`}
        breadcrumbs={[{ label: 'Requisition', to: '/requisitions' }, { label: 'Data', to: '/requisitions' }, { label: data.requisition_no }]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/requisitions')}>Back</Button>
            <Button variant="secondary" size="sm" icon={<Eye size={13} />} onClick={() => void openPreview()}>Preview</Button>
            <Button variant="secondary" size="sm" icon={<Download size={13} />} loading={downloading} onClick={() => void downloadPdf()}>Download PDF</Button>

            {editable && (can('requisition.edit') || can('requisition.approve')) && (
              <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => navigate(`/requisitions/${id}/edit`)}>Edit</Button>
            )}
            {isDraft && can('requisition.create') && (
              <Button variant="primary" size="sm" icon={<Send size={13} />} onClick={() => setAction('submit')}>Submit</Button>
            )}
            {isDraft && can('requisition.delete') && (
              <Button variant="ghost" size="sm" icon={<Trash2 size={13} />} onClick={() => setAction('delete')}>Delete</Button>
            )}

            {isPending && can('requisition.approve') && (
              <Button
                variant="success" size="sm" icon={<CheckCircle2 size={13} />}
                onClick={() => setAction('approve')}
                disabled={approveDisabled}
                title={approveDisabledReason}
              >
                Approve
              </Button>
            )}
            {isPending && can('requisition.approve') && (
              <Button
                variant="secondary" size="sm" icon={<RotateCcw size={13} />}
                onClick={() => { setReason(''); setAction('return'); }}
                disabled={wrongHod && !isSuperAdmin}
                title={wrongHod ? 'Only this requisition\'s HOD can return it.' : undefined}
              >
                Return
              </Button>
            )}
            {isPending && can('requisition.approve') && (
              <Button
                variant="danger" size="sm" icon={<XCircle size={13} />}
                onClick={() => { setReason(''); setAction('reject'); }}
                disabled={wrongHod && !isSuperAdmin}
                title={wrongHod ? 'Only this requisition\'s HOD can reject it.' : undefined}
              >
                Reject
              </Button>
            )}

            {isRejected && can('requisition.edit') && (
              <Button variant="secondary" size="sm" icon={<RotateCcw size={13} />} onClick={() => setAction('reopen')}>
                Reopen as draft
              </Button>
            )}

            {isIssuable && can('requisition.issue') && (
              <Button variant="primary" size="sm" icon={<PackageCheck size={13} />} onClick={() => setIssueOpen(true)}>
                Issue material
              </Button>
            )}

            {(isDraft || (data.status === 'APPROVED' && !hasAnyIssue)) && can('requisition.edit') && (
              <Button variant="ghost" size="sm" icon={<Ban size={13} />} onClick={() => { setReason(''); setAction('cancel'); }}>
                Cancel
              </Button>
            )}
          </>
        }
      />

      {(isRejected || isReturned) && data.hod_decision_reason && (
        <div
          role="alert"
          style={{
            padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: isRejected ? 'var(--danger-50)' : 'var(--warning-50)',
            border: `1px solid ${isRejected ? 'var(--danger-100)' : 'var(--warning-100)'}`,
            borderLeft: `3px solid ${isRejected ? 'var(--danger-500)' : 'var(--warning-500)'}`,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: isRejected ? 'var(--danger-700)' : 'var(--warning-700)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
            {isRejected ? 'Rejected' : 'Returned'} by {text(data.hod_decided_by_name)} · {data.hod_decided_at ? formatDateTime(data.hod_decided_at) : ''}
          </div>
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)', marginTop: 5 }}>{data.hod_decision_reason}</div>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Requested quantity" value={qty(totalRequested)} />
        <StatTile label="Issued" value={qty(totalIssued)} tone="info" />
        <StatTile label="Pending" value={qty(totalPending)} tone={totalPending > 0 ? 'warning' : 'success'} />
        <StatTile label="Excess (over-issued)" value={qty(totalExcess)} tone={totalExcess > 0 ? 'warning' : 'default'} />
        {canSeeFinancials && (
          <StatTile
            label="Estimated value"
            value={money(totalEstimatedValue)}
            tone={unpricedLinesCount > 0 ? 'warning' : 'info'}
            sub={unpricedLinesCount > 0 ? `${unpricedLinesCount} unpriced item(s)` : undefined}
          />
        )}
      </div>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Requisition header" />
        <CardBody>
          <DetailGrid cols={4}>
            <DetailItem label="Requisition no." mono>{data.requisition_no}</DetailItem>
            <DetailItem label="Date">{formatDate(data.requisition_date)}</DetailItem>
            <DetailItem label="Time" mono>{text(data.requisition_time)}</DetailItem>
            <DetailItem label="Department">{text(data.department_name)}</DetailItem>
            <DetailItem label="Requested by">
              {text(data.employee_name)}{data.employee_code && <span className="cell-muted"> · {data.employee_code}</span>}
            </DetailItem>
            <DetailItem label="HOD">{text(data.hod_name)}</DetailItem>
            <DetailItem label="Machine">{text(data.machine_name)}</DetailItem>
            <DetailItem label="Cost centre">{text(data.cost_centre_name)}</DetailItem>
            <DetailItem label="Submitted">{data.submitted_at ? formatDateTime(data.submitted_at) : '—'}</DetailItem>
            <DetailItem label="HOD decision">{data.hod_decided_at ? formatDateTime(data.hod_decided_at) : '—'}</DetailItem>
            <DetailItem label="Remarks" mono={false}>{text(data.remarks)}</DetailItem>
          </DetailGrid>
        </CardBody>
      </Card>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Item lines" subtitle="Pending is requested less all issue transactions to date; Excess is what has been issued beyond the requested quantity" />
        <CardBody flush>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th>Item Code</th>
                  <th>Item Name</th>
                  <th className="center">UOM</th>
                  <th className="right">Requested</th>
                  <th className="right">Issued</th>
                  <th className="right">Pending</th>
                  <th className="right">Excess</th>
                  <th className="right">Available Stock</th>
                  {canSeeFinancials && <th className="right" style={{ minWidth: 105 }}>Rate</th>}
                  {canSeeFinancials && <th className="right" style={{ minWidth: 110 }}>Value</th>}
                  <th className="center">Status</th>
                </tr>
              </thead>
              <tbody>
                {data.lines.map((l) => (
                  <tr key={l.requisition_line_id}>
                    <td className="cell-muted num">{l.line_no}</td>
                    <td className="cell-code">{l.item_code}</td>
                    <td style={{ minWidth: 200, maxWidth: 340 }}>
                      <div className="cell-strong cell-wrap">{l.item_description}</div>
                      {l.main_group_name && <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{l.main_group_name}</div>}
                    </td>
                    <td className="center"><Badge tone="neutral" plain>{l.uom_code ?? '—'}</Badge></td>
                    <td className="right num cell-strong">{qty(l.requested_qty)}</td>
                    <td className="right num">{qty(l.issued_qty)}</td>
                    <td className="right num" style={{ color: Number(l.pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)', fontWeight: 600 }}>{qty(l.pending_qty)}</td>
                    <td className="right num" style={{ color: Number(l.excess_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>{qty(l.excess_qty)}</td>
                    <td className="right num cell-muted">{l.available_stock != null ? qty(l.available_stock) : '—'}</td>
                    {canSeeFinancials && (
                      <td className="right num">
                        {l.estimated_rate != null && Number(l.estimated_rate) > 0 ? (
                          money(l.estimated_rate)
                        ) : (
                          <span style={{ color: 'var(--warning-700)', fontWeight: 500, fontSize: 'var(--text-xs)' }} title="No approved rate in Item Master or purchase receipts">
                            Not available
                          </span>
                        )}
                      </td>
                    )}
                    {canSeeFinancials && (
                      <td className="right num cell-strong">
                        {l.estimated_value != null && Number(l.estimated_value) > 0 ? (
                          money(l.estimated_value)
                        ) : (
                          <span style={{ color: 'var(--text-faint)' }}>—</span>
                        )}
                      </td>
                    )}
                    <td className="center"><StatusBadge status={l.line_status} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={4}>Total</td>
                  <td className="right num">{qty(totalRequested)}</td>
                  <td className="right num">{qty(totalIssued)}</td>
                  <td className="right num">{qty(totalPending)}</td>
                  <td className="right num">{qty(totalExcess)}</td>
                  <td />
                  {canSeeFinancials && <td />}
                  {canSeeFinancials && (
                    <td className="right num cell-strong" title={unpricedLinesCount > 0 ? `${unpricedLinesCount} unpriced item(s) excluded` : undefined}>
                      {money(totalEstimatedValue)}{unpricedLinesCount > 0 ? '*' : ''}
                    </td>
                  )}
                  <td />
                </tr>
              </tfoot>
            </table>
          </div>
          {canSeeFinancials && unpricedLinesCount > 0 && (
            <div style={{ padding: 'var(--sp-2) var(--sp-4)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)', background: 'var(--bg-subtle)' }}>
              * Rate is marked <strong>Not available</strong> for items with no rate configured in the Item Master or past purchase receipts. Those items are excluded from the estimated total value.
            </div>
          )}
        </CardBody>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: 'var(--sp-4)' }}>
        <Card>
          <CardHeader
            icon={<PackageCheck size={15} />}
            title="Issue history"
            subtitle={data.issues.length === 0
              ? 'No material issued yet'
              : `${postedIssueCount} issue transaction(s)${reversedIssueCount > 0 ? ` · ${reversedIssueCount} reversed` : ''}`}
          />
          <CardBody flush>
            {data.issues.length === 0 ? (
              <div style={{ padding: 'var(--sp-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                {isIssuable ? 'Approved and waiting for Stores to issue material.' : 'Material can be issued once this requisition is HOD-approved.'}
              </div>
            ) : (
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead><tr><th>Issue Slip</th><th>Date</th><th>Store User</th><th className="right">Qty Issued</th><th>Status</th><th /></tr></thead>
                  <tbody>
                    {data.issues.map((iss) => {
                      const total = iss.lines.reduce((s, l) => s + Number(l.issueQty), 0);
                      const reversed = iss.status === 'REVERSED';
                      return (
                        <tr key={iss.id}>
                          <td className="cell-code">{iss.issue_slip_no}</td>
                          <td>{formatDate(iss.issue_date)}</td>
                          <td>{text(iss.store_user_name)}</td>
                          {/* A reversed slip's quantity went back to stock; it is shown, not counted. */}
                          <td
                            className="right num cell-strong"
                            style={reversed ? { textDecoration: 'line-through', color: 'var(--text-faint)' } : undefined}
                          >
                            {qty(total)}
                          </td>
                          <td style={{ maxWidth: 220 }}>
                            {reversed ? (
                              <div style={{ fontSize: 'var(--text-xs)' }}>
                                <Badge tone="neutral">Reversed</Badge>
                                <div className="cell-wrap" style={{ color: 'var(--text-faint)', marginTop: 2 }}>
                                  {text(iss.reversal_reason)}
                                </div>
                                <div style={{ color: 'var(--text-faint)', fontSize: 'var(--text-2xs)', marginTop: 1 }}>
                                  {text(iss.reversed_by_name)}{iss.reversed_at ? ` · ${formatDateTime(iss.reversed_at)}` : ''}
                                </div>
                              </div>
                            ) : (
                              <Badge tone="success">Posted</Badge>
                            )}
                          </td>
                          <td className="right">
                            <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                              <Button variant="ghost" size="sm" icon={<Eye size={13} />} title="Preview" onClick={() => void openIssuePreview(iss.id, iss.issue_slip_no)} />
                              <Button
                                variant="ghost" size="sm" icon={<FileText size={13} />} title="Download PDF"
                                onClick={() => void download(`/requisitions/issues/${iss.id}/pdf`, `${iss.issue_slip_no}.pdf`)}
                              >
                                PDF
                              </Button>
                              {!reversed && can('requisition.issue') && (
                                <Button
                                  variant="ghost" size="sm" icon={<Undo2 size={13} />}
                                  title="Reverse issue: return this slip's material to stock"
                                  onClick={() => { setReverseReason(''); setReversingSlip(iss); }}
                                >
                                  Reverse
                                </Button>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        <Card>
          <CardHeader icon={<History size={15} />} title="Approval history" subtitle="Every state change, with its actor and reason" />
          <CardBody>
            {data.approvals.length === 0 ? (
              <div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 'var(--sp-4)' }}>
                No workflow events yet — this requisition is still a draft.
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
                          background: a.action === 'APPROVE' ? 'var(--success-50)' : a.action === 'REJECT' || a.action === 'CANCEL' ? 'var(--danger-50)' : 'var(--info-50)',
                          color: a.action === 'APPROVE' ? 'var(--success-600)' : a.action === 'REJECT' || a.action === 'CANCEL' ? 'var(--danger-600)' : 'var(--info-600)',
                          border: '1px solid var(--border)',
                        }}
                      >
                        {a.action === 'APPROVE' ? <CheckCircle2 size={13} />
                          : a.action === 'REJECT' ? <XCircle size={13} />
                          : a.action === 'CANCEL' ? <Ban size={13} />
                          : a.action === 'RETURN' || a.action === 'REOPEN' ? <RotateCcw size={13} /> : <Send size={13} />}
                      </span>
                      {i < data.approvals.length - 1 && <span style={{ width: 1, flex: 1, background: 'var(--border)', marginTop: 4 }} />}
                    </div>
                    <div className="grow" style={{ minWidth: 0, paddingTop: 2 }}>
                      <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                        <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>{statusLabel(a.action)}</span>
                        <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{statusLabel(a.from_status)} → {statusLabel(a.to_status)}</span>
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
          action === 'submit' ? 'Submit for HOD approval?'
            : action === 'approve' ? 'Approve this requisition?'
            : action === 'reject' ? 'Reject this requisition?'
            : action === 'return' ? 'Return for correction?'
            : action === 'cancel' ? 'Cancel this requisition?'
            : action === 'reopen' ? 'Reopen as draft?'
            : 'Delete this draft?'
        }
        confirmLabel={
          action === 'submit' ? 'Submit'
            : action === 'approve' ? 'Approve'
            : action === 'reject' ? 'Reject'
            : action === 'return' ? 'Return'
            : action === 'cancel' ? 'Cancel requisition'
            : action === 'reopen' ? 'Reopen'
            : 'Delete'
        }
        variant={action === 'approve' ? 'success' : action === 'submit' || action === 'reopen' || action === 'return' ? 'primary' : 'danger'}
        requireReason={action === 'reject' || action === 'return' || action === 'cancel'}
        reasonLabel={action === 'return' ? 'What needs correcting' : action === 'cancel' ? 'Cancellation reason' : 'Rejection reason'}
        reasonValue={reason}
        onReasonChange={setReason}
        message={
          action === 'submit' ? <>Requisition <strong>{data.requisition_no}</strong> will go to your department's HOD and can no longer be freely edited.</>
            : action === 'approve' ? <>It moves to the Store Issue Queue, ready for material to be issued.</>
            : action === 'reject' ? <>The reason is recorded on the document and in the audit trail.</>
            : action === 'return' ? <>The requester can edit and resubmit it — the reason is recorded in the audit trail.</>
            : action === 'cancel' ? <>A requisition with material still issued against it cannot be cancelled; reverse its issue slips first.</>
            : action === 'reopen' ? <>The requisition returns to draft so it can be corrected and resubmitted.</>
            : <>Draft <strong>{data.requisition_no}</strong> will be permanently deleted.</>
        }
      />

      {reversingSlip && (
        <Modal
          title={`Reverse ${reversingSlip.issue_slip_no}?`}
          subtitle={
            `${reversingSlip.lines.length} line(s), ${qty(reversingSlip.lines.reduce((s, l) => s + Number(l.issueQty), 0))} in all, go back into stock. `
            + 'The slip stays in the issue history, marked Reversed, and no longer counts as issued.'
          }
          open={Boolean(reversingSlip)}
          onClose={() => setReversingSlip(null)}
        >
          <Field label="Why is this issue being reversed?" required hint="At least 5 characters. Shown on the slip and saved in the audit log.">
            <Textarea
              rows={3}
              value={reverseReason}
              onChange={(e) => setReverseReason(e.target.value)}
              placeholder="e.g. Issued against the wrong requisition"
              autoFocus
            />
          </Field>
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
            <Button variant="ghost" onClick={() => setReversingSlip(null)}>Keep the issue</Button>
            <Button
              variant="danger"
              icon={<Undo2 size={14} />}
              loading={reverseIssue.isPending}
              disabled={reverseReason.trim().length < 5}
              onClick={() => reverseIssue.mutate({ issueId: reversingSlip.id, reason: reverseReason.trim() })}
            >
              Reverse issue
            </Button>
          </div>
        </Modal>
      )}

      <StoreIssueModal
        open={issueOpen}
        onClose={() => setIssueOpen(false)}
        requisition={data}
        onIssued={() => {
          setIssueOpen(false);
          void qc.invalidateQueries({ queryKey: ['requisitions'] });
          void qc.invalidateQueries({ queryKey: ['requisition', id] });
        }}
      />

      <Modal
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewHtml(null); }}
        title={`Requisition Slip — ${data.requisition_no}`}
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
            title={`Requisition ${data.requisition_no} preview`}
            srcDoc={previewHtml ?? ''}
            style={{ width: '100%', height: '72vh', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: '#fff' }}
          />
        )}
      </Modal>

      <Modal
        open={issuePreview !== null}
        onClose={() => { setIssuePreview(null); setIssuePreviewHtml(null); }}
        title={`Issue Slip — ${issuePreview?.slipNo ?? ''}`}
        subtitle="This is the same document generated as a PDF"
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setIssuePreview(null); setIssuePreviewHtml(null); }}>Close</Button>
            <Button variant="secondary" icon={<Printer size={14} />} onClick={printIssueFromPreview} disabled={!issuePreviewHtml}>Print</Button>
            <Button variant="primary" icon={<Download size={14} />} loading={issueDownloading} onClick={() => void downloadIssuePdf()}>Download PDF</Button>
          </>
        }
      >
        {issuePreviewLoading ? (
          <LoadingBlock height={500} />
        ) : (
          <iframe
            ref={issuePreviewFrameRef}
            title={`Issue slip ${issuePreview?.slipNo ?? ''} preview`}
            srcDoc={issuePreviewHtml ?? ''}
            style={{ width: '100%', height: '72vh', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: '#fff' }}
          />
        )}
      </Modal>
    </>
  );
}

/* ── Store Issue modal ────────────────────────────────────────────────────── */

function StoreIssueModal({
  open, onClose, requisition, onIssued,
}: { open: boolean; onClose: () => void; requisition: RequisitionDoc; onIssued: () => void }) {
  const toast = useToast();
  const [qtyByLine, setQtyByLine] = useState<Record<number, string>>({});
  const [remarks, setRemarks] = useState('');
  const [confirmedExcess, setConfirmedExcess] = useState(false);

  const issue = useMutation({
    mutationFn: () => {
      const lines = requisition.lines
        .map((l) => ({ requisitionLineId: l.requisition_line_id, issueQty: qtyByLine[l.requisition_line_id] ?? '' }))
        .filter((l) => Number(l.issueQty) > 0);
      return api.post<{ issueSlipNo: string; status: string; message: string }>(`/requisitions/${requisition.id}/issue`, { lines, remarks });
    },
    onSuccess: (res) => {
      toast.success('Material issued', res.message);
      setQtyByLine({}); setRemarks(''); setConfirmedExcess(false);
      onIssued();
    },
    onError: (err) => {
      toast.fromError(err instanceof ApiError ? err : err);
    },
  });

  // Suggested Issue Qty defaults to the pending (requested - issued) quantity
  // when the modal opens, but stays fully editable in both directions — Store
  // may reduce it, or raise it above what remains requested (Rule: issue qty
  // is dynamic, never capped at requested/pending).
  useEffect(() => {
    if (!open) return;
    setQtyByLine(Object.fromEntries(
      requisition.lines.filter((l) => Number(l.pending_qty) > 0).map((l) => [l.requisition_line_id, l.pending_qty]),
    ));
    setConfirmedExcess(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requisition.id]);

  const rows = requisition.lines.map((l) => {
    const enteredQty = Number(qtyByLine[l.requisition_line_id] ?? 0);
    const excess = enteredQty > Number(l.requested_qty) - Number(l.issued_qty)
      ? enteredQty - Math.max(0, Number(l.requested_qty) - Number(l.issued_qty))
      : 0;
    return { line: l, enteredQty, excess };
  });
  const anyEntered = rows.some((r) => r.enteredQty > 0);
  const anyExcess = rows.some((r) => r.excess > 0);
  const canSubmit = anyEntered && (!anyExcess || confirmedExcess);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Issue material"
      subtitle={`${requisition.requisition_no} · Stock availability is checked when you confirm — over-issue against the requested quantity is allowed, over-issue beyond current stock is not.`}
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={issue.isPending} disabled={!canSubmit} onClick={() => issue.mutate()}>
            Issue material
          </Button>
        </>
      }
    >
      <div className="table-wrap">
        <table className="table table-compact">
          <thead>
            <tr>
              <th>Item</th>
              <th className="right">Requested</th>
              <th className="right">Prev. Issued</th>
              <th className="right">Pending</th>
              <th className="right">Available Stock</th>
              <th className="right" style={{ width: 130 }}>Issue Qty</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ line: l, enteredQty, excess }) => (
              <tr key={l.requisition_line_id}>
                <td>
                  <div className="cell-strong">{l.item_code}</div>
                  <div className="cell-wrap cell-muted" style={{ minWidth: 160, maxWidth: 280 }}>{l.item_description}</div>
                </td>
                <td className="right num">{qty(l.requested_qty)}</td>
                <td className="right num">{qty(l.issued_qty)}</td>
                <td className="right num" style={{ fontWeight: 600, color: Number(l.pending_qty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>{qty(l.pending_qty)}</td>
                <td className="right num cell-muted">{l.available_stock != null ? qty(l.available_stock) : '—'}</td>
                <td>
                  <Input
                    numeric type="number" step="0.0001" min="0" className="input-sm"
                    value={qtyByLine[l.requisition_line_id] ?? ''}
                    placeholder="0"
                    onChange={(e) => setQtyByLine((prev) => ({ ...prev, [l.requisition_line_id]: e.target.value }))}
                    style={excess > 0 ? { borderColor: 'var(--warning-500)', color: 'var(--warning-700)', fontWeight: 600 } : undefined}
                  />
                  {excess > 0 && (
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--warning-600)', marginTop: 3 }}>
                      Requested {qty(l.requested_qty)} · Issue {qty(enteredQty)} · Extra {qty(excess)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 'var(--sp-3)' }}>
        <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Remarks (optional)" />
      </div>

      {anyExcess && (
        <div
          role="alert"
          className="row"
          style={{
            gap: 8, marginTop: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)',
            background: 'var(--warning-50)', border: '1px solid var(--warning-100)',
            borderRadius: 'var(--radius-sm)', alignItems: 'flex-start',
          }}
        >
          <TriangleAlert size={16} style={{ color: 'var(--warning-600)', flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--warning-700)' }}>
              Issue quantity is greater than the pending requested quantity for one or more lines.
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning-700)', marginTop: 3 }}>
              This is allowed — Stores may issue more than was originally requested — but it is unusual. The only
              hard limit is current stock, checked when you confirm.
            </div>
            <div style={{ marginTop: 8 }}>
              <Checkbox
                checked={confirmedExcess}
                onChange={setConfirmedExcess}
                label={<span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--warning-700)' }}>I confirm this over-issue is intentional</span>}
              />
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
}
