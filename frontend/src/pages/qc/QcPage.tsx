/**
 * Quality Control (QC) Inspection Management (Purchase Module / Requirement 10).
 *
 * Post-GRN QC Workflow:
 * - Items with `qc_required = true` in Item Master are quarantined upon receipt.
 * - Material cannot enter usable store ledger until QC inspection is completed.
 * - Inspectors record accepted/rejected quantities, test findings, and disposition.
 * - Passing inspection releases accepted stock into the live usable inventory ledger.
 * - Rejected stock remains isolated for Return to Vendor (RTV) or scrap.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import {
  ShieldCheck, CheckCircle2, XCircle, AlertTriangle, Clock,
} from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, CardHeader, Badge, Tabs,
  Modal, Field, Input, Textarea, Select,
} from '../../components/ui';
import { qty, formatDate, count, toShortUom } from '../../lib/format';
import {
  qcDecisionToast, qcDecisionSplit, qcSplitProblem, qcRemainder, QC_FAILED_SPLIT_HINT, type QcDecisionResult,
} from '../../lib/grnQc';
import { refreshAfterGrnChange } from '../../lib/grnRefresh';

interface InspectionRow {
  id: number;
  grn_id: number;
  grn_line_id: number;
  grn_no: string;
  item_id: number;
  item_code: string;
  item_name: string;
  supplier_id: number;
  supplier_name: string;
  received_qty: string;
  accepted_qty: string;
  rejected_qty: string;
  uom_id: number | null;
  uom_code: string;
  // CANCELLED: closed without a decision because its GRN was cancelled.
  status: 'PENDING_QC' | 'QC_IN_PROGRESS' | 'QC_PASSED' | 'ACCEPTED_WITH_DEVIATION' | 'QC_FAILED' | 'ON_HOLD' | 'CANCELLED';
  inspector_id: number | null;
  inspector_name: string | null;
  inspection_date: string | null;
  remarks: string | null;
  rejection_reason: string | null;
  next_action: string | null;
  created_at: string;
  grn_status: 'DRAFT' | 'POSTED' | 'CANCELLED';
}

interface QcStats {
  total: number;
  pending: number;
  inProgress: number;
  passed: number;
  failed: number;
  onHold: number;
  closed: number;
}

/**
 * The server records a decision only on a posted GRN, and never changes a pass:
 * the button is not offered where it would be refused.
 */
const canDecide = (r: InspectionRow) =>
  r.grn_status === 'POSTED' && !['QC_PASSED', 'ACCEPTED_WITH_DEVIATION', 'CANCELLED'].includes(r.status);

/** A final decision accounts for everything received: what is not accepted is rejected. */
const FINAL_DECISIONS: InspectionRow['status'][] = ['QC_PASSED', 'ACCEPTED_WITH_DEVIATION', 'QC_FAILED'];

export default function QcPage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const [activeTab, setActiveTab] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [search, setSearch] = useState('');

  /* ── Inspection Modal State ────────────────────────────────────────────── */
  const [inspectingItem, setInspectingItem] = useState<InspectionRow | null>(null);
  const [decisionStatus, setDecisionStatus] = useState<InspectionRow['status']>('QC_PASSED');
  const [acceptedQty, setAcceptedQty] = useState('');
  const [rejectedQty, setRejectedQty] = useState('0');
  const [rejectionReason, setRejectionReason] = useState('');
  const [nextAction, setNextAction] = useState('RELEASE_TO_STORE');
  const [remarks, setRemarks] = useState('');

  // What the form shows and sends: a failed inspection is fixed at nothing accepted and
  // everything received rejected ('Full Rejection / RTV'), the only split the server takes.
  const split = qcDecisionSplit(decisionStatus, acceptedQty, rejectedQty, inspectingItem?.received_qty ?? '0');

  /* ── Queries ───────────────────────────────────────────────────────────── */
  const params = {
    page: filters.page ?? page,
    pageSize: filters.pageSize ?? pageSize,
    search: (filters.search as string) || search || undefined,
    status: activeTab || undefined,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    supplierId: filters.supplierId,
    itemId: filters.itemId,
    userId: filters.userId,
    inspectorId: filters.userId,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    hodId: filters.hodId,
  };

  const statsParams = {
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    supplierId: filters.supplierId,
    itemId: filters.itemId,
    userId: filters.userId,
    inspectorId: filters.userId,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    hodId: filters.hodId,
  };

  const { data, isLoading } = useQuery({
    queryKey: ['qc-inspections', params],
    queryFn: () => api.getWithMeta<InspectionRow[], PageMeta & {
      totals?: {
        totalInspections: number;
        lineCount: number;
        totalReceivedQty: number;
        totalAcceptedQty: number;
        totalRejectedQty: number;
      };
    }>(`/qc/inspections${qs(params)}`),
  });

  const { data: stats } = useQuery({
    queryKey: ['qc-stats', statsParams],
    queryFn: () => api.get<QcStats>(`/qc/stats${qs(statsParams)}`),
  });

  /* ── Mutations ─────────────────────────────────────────────────────────── */
  const decideMutation = useMutation({
    mutationFn: ({ id, payload }: { id: number; payload: Record<string, unknown> }) =>
      api.post<QcDecisionResult>(`/qc/inspections/${id}/decide`, payload),
    onSuccess: (res) => {
      // Said 'stock updated' for every decision, a hold or a failure included, which
      // moved no stock at all (2026-10-17 E2E run, S3-D7).
      const t = qcDecisionToast(res);
      toast.success(t.title, t.detail);
      setInspectingItem(null);
      // The GRN screen shows the line's QC state and lot, the PO and stock screens what came in.
      void refreshAfterGrnChange(qc);
    },
    onError: (err) => toast.fromError(err, 'Failed to record inspection decision'),
  });

  const openInspection = (row: InspectionRow) => {
    setInspectingItem(row);
    setDecisionStatus(row.status === 'PENDING_QC' ? 'QC_PASSED' : row.status);
    // Updating a failed inspection opened with everything accepted and everything
    // rejected, a split that cannot be sent; a failed one accepted nothing.
    const failed = row.status === 'QC_FAILED';
    setAcceptedQty(failed ? '0' : row.accepted_qty && Number(row.accepted_qty) > 0 ? row.accepted_qty : row.received_qty);
    setRejectedQty(failed ? row.received_qty : row.rejected_qty ?? '0');
    setRejectionReason(row.rejection_reason ?? '');
    setNextAction(row.next_action ?? 'RELEASE_TO_STORE');
    setRemarks(row.remarks ?? '');
  };

  const submitDecision = () => {
    if (!inspectingItem) return;
    const acc = Number(split.accepted || 0);
    const rej = Number(split.rejected || 0);

    // Compared as the server compares them, in stored units: as floats 0.1 + 0.2 of a
    // 0.3 receipt exceeded it, and the split never reached the server.
    const problem = qcSplitProblem(split.accepted, split.rejected, inspectingItem.received_qty, FINAL_DECISIONS.includes(decisionStatus));
    if (problem) {
      toast.error(problem);
      return;
    }

    if ((decisionStatus === 'QC_FAILED' || rej > 0) && !rejectionReason.trim()) {
      toast.error('Rejection reason is mandatory when items are rejected.');
      return;
    }

    decideMutation.mutate({
      id: inspectingItem.id,
      payload: {
        status: decisionStatus,
        acceptedQty: acc,
        rejectedQty: rej,
        rejectionReason: rejectionReason.trim(),
        nextAction: nextAction.trim(),
        remarks: remarks.trim(),
      },
    });
  };

  /* ── Columns ───────────────────────────────────────────────────────────── */
  const columns: Column<InspectionRow>[] = [
    {
      key: 'grn_no',
      header: 'GRN No',
      width: '120px',
      render: (r) => (
        <Link to={`/grn/${r.grn_id}`} className="cell-code font-medium" style={{ textDecoration: 'none' }}>
          {r.grn_no}
        </Link>
      ),
    },
    {
      key: 'item',
      header: 'Item & Supplier',
      render: (r) => (
        <div>
          <span className="cell-code" style={{ fontSize: 'var(--text-xs)' }}>{r.item_code}</span>
          <div className="cell-strong">{r.item_name}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
            Supplier: {r.supplier_name}
          </div>
        </div>
      ),
    },
    {
      key: 'received_qty',
      header: 'Received Qty',
      align: 'right',
      render: (r) => (
        <span className="num cell-strong">
          {qty(r.received_qty)} <span style={{ fontSize: 'var(--text-xs)' }}>{toShortUom(r.uom_code)}</span>
        </span>
      ),
    },
    {
      key: 'inspection_results',
      header: 'Accepted / Rejected',
      align: 'right',
      render: (r) => {
        if (r.status === 'PENDING_QC') {
          return <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>Awaiting Test</span>;
        }
        if (r.status === 'CANCELLED') {
          return <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>Nothing released</span>;
        }
        return (
          <div className="num" style={{ fontSize: 'var(--text-xs)' }}>
            <div style={{ color: 'var(--success-600)', fontWeight: 600 }}>{qty(r.accepted_qty)} pass</div>
            {Number(r.rejected_qty) > 0 && (
              <div style={{ color: 'var(--danger-600)' }}>{qty(r.rejected_qty)} rejected</div>
            )}
          </div>
        );
      },
    },
    {
      key: 'status',
      header: 'QC Status',
      align: 'center',
      render: (r) => {
        switch (r.status) {
          case 'QC_PASSED':
            return <Badge tone="success"><CheckCircle2 size={11} style={{ marginRight: 3 }} /> Passed</Badge>;
          case 'ACCEPTED_WITH_DEVIATION':
            return <Badge tone="warning"><AlertTriangle size={11} style={{ marginRight: 3 }} /> Deviation Pass</Badge>;
          case 'QC_FAILED':
            return <Badge tone="danger"><XCircle size={11} style={{ marginRight: 3 }} /> Rejected</Badge>;
          case 'ON_HOLD':
            return <Badge tone="neutral"><Clock size={11} style={{ marginRight: 3 }} /> On Hold</Badge>;
          case 'QC_IN_PROGRESS':
            return <Badge tone="info"><Clock size={11} style={{ marginRight: 3 }} /> Testing</Badge>;
          case 'CANCELLED':
            return <Badge tone="neutral">Closed: GRN cancelled</Badge>;
          default:
            return <Badge tone="neutral">Pending QC</Badge>;
        }
      },
    },
    {
      key: 'inspector',
      header: 'Inspector & Findings',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          {r.inspector_name ? (
            <div>
              <span className="cell-strong">{r.inspector_name}</span>
              {r.inspection_date && <div className="cell-muted">{formatDate(r.inspection_date)}</div>}
            </div>
          ) : (
            <span className="cell-muted">Unassigned</span>
          )}
          {r.rejection_reason && (
            <div style={{ color: 'var(--danger-600)', marginTop: 2 }}>{r.rejection_reason}</div>
          )}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      locked: true,
      render: (r) => {
        const canInspect = (can('qc.inspect') || can('qc.approve')) && canDecide(r);
        return (
          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
            {canInspect && (
              <Button
                variant={r.status === 'PENDING_QC' ? 'primary' : 'secondary'}
                size="sm"
                icon={<ShieldCheck size={13} />}
                onClick={() => openInspection(r)}
              >
                {r.status === 'PENDING_QC' ? 'Inspect' : 'Update'}
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Quality Control (QC) Inspections"
        subtitle="Mandatory material quality inspection prior to store ledger entry"
        breadcrumbs={[
          { label: 'Quality Control', to: '/qc' },
          { label: 'Inspection Queue' },
        ]}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <StatTile label="Total Inspections" value={count(stats?.total ?? 0)} />
        <StatTile label="Pending Inspection" value={count(stats?.pending ?? 0)} tone="warning" />
        <StatTile label="In Progress" value={count(stats?.inProgress ?? 0)} tone="info" />
        <StatTile label="Passed & Released" value={count(stats?.passed ?? 0)} tone="success" />
        <StatTile label="Rejected / Failed" value={count(stats?.failed ?? 0)} tone="danger" />
        <StatTile label="On Hold" value={count(stats?.onHold ?? 0)} tone="default" />
        {(stats?.closed ?? 0) > 0 && (
          <StatTile label="Closed: GRN Cancelled" value={count(stats?.closed ?? 0)} tone="default" />
        )}
      </div>

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Tabs
          tabs={[
            { key: '', label: 'All Inspections' },
            { key: 'PENDING_QC', label: 'Pending Inspection', count: stats?.pending ?? undefined },
            { key: 'QC_IN_PROGRESS', label: 'In Progress', count: stats?.inProgress ?? undefined },
            { key: 'QC_PASSED,ACCEPTED_WITH_DEVIATION', label: 'Passed & Released', count: stats?.passed ?? undefined },
            { key: 'QC_FAILED', label: 'Rejected', count: stats?.failed ?? undefined },
            { key: 'ON_HOLD', label: 'On Hold', count: stats?.onHold ?? undefined },
          ]}
          active={activeTab}
          onChange={(t) => {
            setActiveTab(t);
            setPage(1);
          }}
        />
      </div>

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <FilterBar
          filters={filters}
          setFilters={setFilters}
          clearFilters={clearFilters}
          activeCount={activeCount}
          show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'item']}
        />
      </div>

      <Card>
        <CardHeader
          title="Material Inward Quality Records"
          subtitle="Materials held in Quarantine until passed by Quality Inspector"
        />
        <CardBody flush>
          <DataTable
            columns={columns}
            rows={data?.data ?? []}
            rowKey={(r) => r.id}
            loading={isLoading}
            search={search}
            onSearchChange={(s) => {
              setSearch(s);
              setPage(1);
            }}
            searchPlaceholder="Search GRN no, item code, supplier name…"
            meta={data?.meta}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
            emptyTitle="No QC inspections match the current filter"
            emptyMessage="New inspections will appear here when goods receipt notes with QC-controlled items are posted."
          />
        </CardBody>
      </Card>

      {/* ── Inspection Decision Modal ────────────────────────────────────── */}
      <Modal
        open={Boolean(inspectingItem)}
        onClose={() => setInspectingItem(null)}
        title="Record Quality Inspection Findings"
        subtitle={`GRN: ${inspectingItem?.grn_no} • Item: ${inspectingItem?.item_code} (${qty(inspectingItem?.received_qty ?? 0)} ${toShortUom(inspectingItem?.uom_code)})`}
        size="md"
        footer={
          <div className="row" style={{ gap: 'var(--sp-2)', justifyContent: 'flex-end' }}>
            <Button variant="ghost" onClick={() => setInspectingItem(null)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              loading={decideMutation.isPending}
              onClick={submitDecision}
            >
              Submit QC Decision
            </Button>
          </div>
        }
      >
        <div style={{ display: 'grid', gap: 'var(--sp-4)' }}>
          <Field label="Inspection Decision Status" required>
            <Select
              value={decisionStatus}
              onChange={(e) => {
                const s = e.target.value as InspectionRow['status'];
                setDecisionStatus(s);
                if (s === 'QC_PASSED' && inspectingItem) {
                  setAcceptedQty(inspectingItem.received_qty);
                  setRejectedQty('0');
                } else if (s === 'QC_FAILED' && inspectingItem) {
                  setAcceptedQty('0');
                  setRejectedQty(inspectingItem.received_qty);
                }
              }}
            >
              <option value="QC_PASSED">QC Passed (Full Acceptance into Store)</option>
              <option value="ACCEPTED_WITH_DEVIATION">Accepted with Deviation (Conditional Pass)</option>
              <option value="QC_FAILED">QC Failed (Full Rejection / RTV)</option>
              <option value="ON_HOLD">On Hold (Quarantine for Re-Testing)</option>
              <option value="QC_IN_PROGRESS">QC In Progress (Under Testing)</option>
            </Select>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
            <Field label="Accepted Quantity" required hint={split.fixed ? QC_FAILED_SPLIT_HINT : undefined}>
              <Input
                type="number"
                step="any"
                min="0"
                value={split.accepted}
                disabled={split.fixed}
                onChange={(e) => {
                  setAcceptedQty(e.target.value);
                  if (inspectingItem) {
                    const left = qcRemainder(inspectingItem.received_qty, e.target.value);
                    if (left !== null) setRejectedQty(left);
                  }
                }}
              />
            </Field>

            <Field label="Rejected Quantity">
              <Input
                type="number"
                step="any"
                min="0"
                value={split.rejected}
                disabled={split.fixed}
                onChange={(e) => setRejectedQty(e.target.value)}
              />
            </Field>
          </div>

          {(decisionStatus === 'QC_FAILED' || Number(rejectedQty) > 0) && (
            <Field label="Rejection Reason" required>
              <Input
                value={rejectionReason}
                onChange={(e) => setRejectionReason(e.target.value)}
                placeholder="State rejection defect or parameter failure (e.g. dimensional variance, cracked, tensile fail)…"
              />
            </Field>
          )}

          <Field label="Next Action / Material Disposition">
            <Select value={nextAction} onChange={(e) => setNextAction(e.target.value)}>
              <option value="RELEASE_TO_STORE">Release Accepted Material to Main Store</option>
              <option value="RETURN_TO_VENDOR">Return to Vendor (RTV)</option>
              <option value="REWORK">Internal Rework</option>
              <option value="SCRAP">Move to Scrap Yard</option>
              <option value="QUARANTINE">Hold in Quarantine Bay</option>
            </Select>
          </Field>

          <Field label="Inspection Notes & Remarks">
            <Textarea
              value={remarks}
              onChange={(e) => setRemarks(e.target.value)}
              placeholder="Record test measurements, certificate numbers, lab findings or visual notes…"
              rows={3}
            />
          </Field>
        </div>
      </Modal>
    </>
  );
}
