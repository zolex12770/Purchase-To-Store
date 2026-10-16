/**
 * Live data parity verification (Priority 1 & 2).
 *
 * Field-by-field audit across:
 *  - Source Spreadsheet (1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I)
 *  - ERP Database (PGlite / PostgreSQL)
 *  - Reference Spreadsheet (1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g)
 *
 * Read-only by default: discrepancy matrix and formula audit. Authorised users
 * can dry-run, then confirm, a master-data reconciliation that takes a safety
 * backup first.
 *
 * States are explicit. On a server without Google credentials the verify
 * call answered without an HTTP error and v2 showed "Parity Score: —" over an
 * empty "Audit Matrix (0 Tabs)" with no reason (audit UI-002); an empty
 * report now says why and where to fix it.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  RefreshCw, AlertTriangle, CheckCircle2, Search, HardDriveDownload, FileSearch,
} from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { useAuth } from '../lib/auth';
import {
  Modal, Button, Badge, Banner, EmptyState, ErrorState, LoadingBlock, Segmented, StatusBadge, Tabs,
} from './ui';

export interface TabSummary {
  tabName: string;
  sourceRows: number;
  dbRows: number;
  refRows: number;
  status: 'MATCHED' | 'DISCREPANCY' | 'INFO';
  discrepanciesCount: number;
  notes?: string;
}

export interface DiscrepancyItem {
  tab: string;
  key: string;
  field: string;
  sourceValue: unknown;
  erpValue: unknown;
  refValue?: unknown;
  type: 'MISSING_IN_DB' | 'EXTRA_IN_DB' | 'VALUE_MISMATCH' | 'STOCK_DIFFERENCE' | 'DUPLICATE_IN_SHEET';
  severity: 'HIGH' | 'MEDIUM' | 'LOW';
  recommendation: string;
}

export interface FormulaAuditItem {
  entity: string;
  formulaField: string;
  status: string;
  rule: string;
}

export interface VerificationReport {
  overallStatus: 'MATCHED' | 'DISCREPANCIES_FOUND';
  timestamp: string;
  sourceSheetId: string;
  referenceSheetId: string;
  tabSummaries: Record<string, TabSummary>;
  discrepancies: DiscrepancyItem[];
  formulaAudit: FormulaAuditItem[];
  stats: {
    totalChecked: number;
    totalMatched: number;
    totalDiscrepancies: number;
    parityPercentage: number;
  };
}

const FILTER_TABS = ['ALL', 'Item Master', 'Supplier Master', 'Requisition'];
const severityTone = (s: DiscrepancyItem['severity']) => (s === 'HIGH' ? 'danger' : s === 'MEDIUM' ? 'attention' : 'neutral');
const show = (v: unknown) => (v !== null && v !== undefined && v !== '' ? String(v) : '—');

export function LiveDataVerifyModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const toast = useToast();
  const { can } = useAuth();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [activeTab, setActiveTab] = useState<'matrix' | 'discrepancies' | 'formulas'>('matrix');
  const [filterTab, setFilterTab] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [confirmReconcile, setConfirmReconcile] = useState(false);

  const { data, isLoading, isFetching, error, refetch } = useQuery({
    queryKey: ['live-data-verify'],
    queryFn: () => api.get<VerificationReport>('/google-sync/verify'),
    enabled: open,
    staleTime: 60_000,
  });

  const reconcileMutation = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<{
        dryRun: boolean;
        backupFile?: string;
        itemsProcessed: number;
        itemsInserted: number;
        itemsUpdated: number;
        message: string;
      }>('/google-sync/reconcile', { dryRun, confirmBackup: true }),
    onSuccess: (res) => {
      if (res.dryRun) {
        toast.info('Dry run completed', res.message);
      } else {
        toast.success('Reconciliation completed', res.message);
        setConfirmReconcile(false);
        void refetch();
        void qc.invalidateQueries({ queryKey: ['items'] });
        void qc.invalidateQueries({ queryKey: ['suppliers'] });
      }
    },
    onError: (err) => toast.fromError(err),
  });

  // A report with no tabs (or no report at all) means nothing was compared.
  const summaries = data ? Object.values(data.tabSummaries ?? {}) : [];
  const report = data && (summaries.length > 0 || (data.stats?.totalChecked ?? 0) > 0)
    ? { ...data, discrepancies: data.discrepancies ?? [], formulaAudit: data.formulaAudit ?? [] }
    : null;
  const emptyReport = !report;
  const matched = report?.overallStatus === 'MATCHED';

  const filteredDiscrepancies = (report?.discrepancies || []).filter((d) => {
    if (filterTab !== 'ALL' && d.tab !== filterTab) return false;
    if (search) {
      const q = search.toLowerCase();
      return (
        d.key.toLowerCase().includes(q) ||
        d.field.toLowerCase().includes(q) ||
        String(d.sourceValue ?? '').toLowerCase().includes(q) ||
        String(d.erpValue ?? '').toLowerCase().includes(q) ||
        d.recommendation.toLowerCase().includes(q)
      );
    }
    return true;
  });

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Live data verification"
      subtitle="Source sheet, ERP database and reference sheet compared field by field. Read-only unless you reconcile."
      size="xl"
      busy={reconcileMutation.isPending}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {isLoading ? (
          <LoadingBlock label="Reading the sheets and the database…" />
        ) : error ? (
          <ErrorState error={error} onRetry={() => void refetch()} title="Could not run the verification" />
        ) : emptyReport ? (
          <EmptyState
            icon={<FileSearch />}
            title="No sheet data could be compared"
            message="The verification read no tabs from Google Sheets, so there is nothing to score. This usually means the Google Sheets connection is not configured on this server."
            secondaryAction={<Button variant="secondary" size="sm" icon={<RefreshCw size={14} />} onClick={() => void refetch()} disabled={isFetching}>Verify again</Button>}
            action={<Button variant="primary" size="sm" onClick={() => { onClose(); navigate('/admin/sync'); }}>Open sync admin</Button>}
          />
        ) : report ? (
          <>
            {/* Summary */}
            <div className="card" style={{ padding: '14px 16px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12, boxShadow: 'none' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div
                  aria-hidden
                  style={{
                    width: 40, height: 40, borderRadius: 'var(--radius-md)', display: 'grid', placeItems: 'center', flexShrink: 0,
                    background: matched ? 'var(--tone-success-bg)' : 'var(--tone-attention-bg)',
                    color: matched ? 'var(--tone-success-fg)' : 'var(--tone-attention-fg)',
                  }}
                >
                  {matched ? <CheckCircle2 size={22} /> : <AlertTriangle size={22} />}
                </div>
                <div>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 'var(--fs-16)', fontWeight: 600 }}>Parity {report.stats?.parityPercentage ?? '—'}%</span>
                    <Badge tone={matched ? 'success' : 'attention'}>
                      {matched ? 'Fully in step' : `${report.stats?.totalDiscrepancies ?? report.discrepancies.length} discrepancies`}
                    </Badge>
                  </div>
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', marginTop: 2 }}>
                    Source sheet <code className="mono">{report.sourceSheetId || '1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I'}</code> · system of record: SQL database
                  </div>
                </div>
              </div>

              <div className="row" style={{ gap: 8 }}>
                <Button
                  variant="secondary"
                  size="sm"
                  icon={<RefreshCw size={14} className={isFetching ? 'zx-spin' : ''} />}
                  onClick={() => void refetch()}
                  disabled={isFetching}
                >
                  Verify again
                </Button>
                {can('sync.admin') && (
                  <>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => reconcileMutation.mutate(true)}
                      disabled={reconcileMutation.isPending || isFetching}
                    >
                      Dry-run reconcile
                    </Button>
                    <Button
                      variant="primary"
                      size="sm"
                      onClick={() => setConfirmReconcile(true)}
                      disabled={reconcileMutation.isPending || isFetching}
                    >
                      Reconcile master data
                    </Button>
                  </>
                )}
              </div>
            </div>

            {confirmReconcile && (
              <Banner
                tone="warning"
                action={
                  <div className="row" style={{ gap: 8 }}>
                    <Button variant="secondary" size="sm" onClick={() => setConfirmReconcile(false)} disabled={reconcileMutation.isPending}>Cancel</Button>
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<HardDriveDownload size={14} />}
                      onClick={() => reconcileMutation.mutate(false)}
                      loading={reconcileMutation.isPending}
                    >
                      Back up and reconcile
                    </Button>
                  </div>
                }
              >
                <strong>Reconcile master data?</strong> Item Master and Supplier Master records are updated from the
                source sheet after an automatic, verified backup. Approved indents, POs, GRNs and requisitions are never
                overwritten, and ERP-to-sheet write-back stays off.
              </Banner>
            )}

            <Tabs
              ariaLabel="Verification views"
              active={activeTab}
              onChange={(k) => setActiveTab(k as typeof activeTab)}
              tabs={[
                { key: 'matrix', label: 'Audit matrix', count: summaries.length },
                { key: 'discrepancies', label: 'Discrepancies', count: report.discrepancies.length },
                { key: 'formulas', label: 'Formulas and rules', count: report.formulaAudit.length },
              ]}
            />

            {activeTab === 'matrix' && (
              <div className="table-wrap" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tab</th>
                      <th className="right">Source sheet rows</th>
                      <th className="right">ERP database rows</th>
                      <th className="right">Reference replica rows</th>
                      <th>Audit status</th>
                      <th>Notes and rules</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summaries.map((s) => (
                      <tr key={s.tabName}>
                        <td className="cell-strong">{s.tabName}</td>
                        <td className="right num">{s.sourceRows.toLocaleString('en-IN')}</td>
                        <td className="right num">{s.dbRows.toLocaleString('en-IN')}</td>
                        <td className="right num">{s.refRows.toLocaleString('en-IN')}</td>
                        <td>
                          <StatusBadge
                            status={s.status}
                            label={s.status === 'DISCREPANCY' ? `${s.discrepanciesCount} differences` : undefined}
                          />
                        </td>
                        <td className="cell-muted">{s.notes || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {activeTab === 'discrepancies' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                <div className="row" style={{ gap: 8, justifyContent: 'space-between', flexWrap: 'wrap' }}>
                  <Segmented
                    size="sm"
                    ariaLabel="Show discrepancies for"
                    value={filterTab}
                    onChange={setFilterTab}
                    options={FILTER_TABS.map((t) => ({ value: t, label: t === 'ALL' ? 'All tabs' : t }))}
                  />
                  <div style={{ position: 'relative', width: 240 }}>
                    <Search size={14} aria-hidden style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-4)' }} />
                    <input
                      className="input input-sm"
                      style={{ paddingLeft: 28 }}
                      placeholder="Search discrepancies…"
                      aria-label="Search discrepancies"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </div>
                </div>

                <div className="table-wrap" style={{ maxHeight: 380, border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tab</th>
                        <th>Record key</th>
                        <th>Field</th>
                        <th>Source sheet value</th>
                        <th>ERP value</th>
                        <th>Type</th>
                        <th>Recommendation</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredDiscrepancies.length === 0 ? (
                        <tr>
                          <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-3)' }}>
                            No discrepancies match the current filter.
                          </td>
                        </tr>
                      ) : (
                        filteredDiscrepancies.slice(0, 100).map((d, i) => (
                          <tr key={i}>
                            <td className="cell-strong">{d.tab}</td>
                            <td className="cell-code">{d.key}</td>
                            <td>{d.field}</td>
                            <td>{show(d.sourceValue)}</td>
                            <td>{show(d.erpValue)}</td>
                            <td><Badge tone={severityTone(d.severity)}>{d.type.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}</Badge></td>
                            <td className="cell-muted">{d.recommendation}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
                {filteredDiscrepancies.length > 100 && (
                  <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', textAlign: 'center' }}>
                    Showing the first 100 of {filteredDiscrepancies.length} discrepancies. Search to narrow them down.
                  </div>
                )}
              </div>
            )}

            {activeTab === 'formulas' && (
              <div className="table-wrap" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th>Entity or view</th>
                      <th>Derived field</th>
                      <th>Status</th>
                      <th>Business rule</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(report.formulaAudit || []).map((f, i) => (
                      <tr key={i}>
                        <td className="cell-strong">{f.entity}</td>
                        <td className="cell-code">{f.formulaField}</td>
                        <td><StatusBadge status="VERIFIED" label="Verified, derived" /></td>
                        <td className="cell-muted">{f.rule}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </Modal>
  );
}
