/**
 * Live Data Parity Verification Modal (Priority 1 & 2).
 *
 * Provides real-time field-by-field audit across:
 *  - Source Spreadsheet (1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I)
 *  - ERP Database (PGlite / PostgreSQL)
 *  - Reference Spreadsheet (1v-r7cdHsnWBPJhe7RgaNYgnl5T7kPhvAIIf58-q770g)
 *
 * Features:
 *  - Read-only verification by default.
 *  - Discrepancy Matrix and Formula Audit.
 *  - Authorized Dry-Run and Confirmed Reconciliation with automatic safety backup.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, AlertTriangle, CheckCircle2,
  Search, HardDriveDownload,
} from 'lucide-react';
import { api } from '../lib/api';
import { useToast } from './Toast';
import { useAuth } from '../lib/auth';
import { Modal, Button, Badge } from './ui';

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

  const [activeTab, setActiveTab] = useState<'matrix' | 'discrepancies' | 'formulas'>('matrix');
  const [filterTab, setFilterTab] = useState<string>('ALL');
  const [search, setSearch] = useState('');
  const [confirmReconcile, setConfirmReconcile] = useState(false);

  const { data, isFetching, refetch } = useQuery({
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
        toast.info('Dry Run Completed', res.message);
      } else {
        toast.success('Reconciliation Completed', res.message);
        setConfirmReconcile(false);
        void refetch();
        void qc.invalidateQueries({ queryKey: ['items'] });
        void qc.invalidateQueries({ queryKey: ['suppliers'] });
      }
    },
    onError: (err) => toast.fromError(err),
  });

  const report = data;
  const summaries = report ? Object.values(report.tabSummaries) : [];

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
      title="Live Data Parity Verification & Audit"
      size="xl"
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {/* Top summary banner */}
        <div
          style={{
            background: 'var(--bg-inset)',
            padding: '14px 16px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            flexWrap: 'wrap',
            gap: 12,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <div
              style={{
                width: 44,
                height: 44,
                borderRadius: '50%',
                background: report?.overallStatus === 'MATCHED' ? 'var(--success-50)' : 'var(--warning-50)',
                color: report?.overallStatus === 'MATCHED' ? 'var(--success-600)' : 'var(--warning-600)',
                display: 'grid',
                placeItems: 'center',
                flexShrink: 0,
              }}
            >
              {report?.overallStatus === 'MATCHED' ? <CheckCircle2 size={24} /> : <AlertTriangle size={24} />}
            </div>
            <div>
              <div style={{ fontSize: 'var(--text-base)', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>Parity Score: {report ? `${report.stats.parityPercentage}%` : '—'}</span>
                {report && (
                  <Badge tone={report.overallStatus === 'MATCHED' ? 'success' : 'warning'}>
                    {report.overallStatus === 'MATCHED' ? 'Fully Synchronized' : `${report.stats.totalDiscrepancies} Discrepancies Audited`}
                  </Badge>
                )}
              </div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 2 }}>
                Source Sheet: <code style={{ fontSize: '11px' }}>1Dyj3Ws9gyR2zOe6p6RafQrKUFyLKIFN5h-3XDe9KD9I</code> • System of Record: <strong>SQL Database</strong>
              </div>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <Button
              variant="secondary"
              size="sm"
              icon={<RefreshCw size={14} className={isFetching ? 'zx-spin' : ''} />}
              onClick={() => void refetch()}
              disabled={isFetching}
            >
              Verify Live Data
            </Button>
            {can('sync.admin') && (
              <>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => reconcileMutation.mutate(true)}
                  disabled={reconcileMutation.isPending || isFetching}
                >
                  Dry-Run Reconcile
                </Button>
                <Button
                  variant="primary"
                  size="sm"
                  onClick={() => setConfirmReconcile(true)}
                  disabled={reconcileMutation.isPending || isFetching}
                >
                  Reconcile Master Data
                </Button>
              </>
            )}
          </div>
        </div>

        {/* Confirmation banner if requested */}
        {confirmReconcile && (
          <div
            style={{
              background: 'var(--warning-50)',
              border: '1px solid var(--warning-200)',
              padding: '12px 16px',
              borderRadius: 'var(--radius)',
              display: 'flex',
              flexDirection: 'column',
              gap: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 600, color: 'var(--warning-800)', fontSize: 'var(--text-sm)' }}>
              <HardDriveDownload size={16} />
              Confirmed Master Data Reconciliation
            </div>
            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--warning-900)', lineHeight: 1.5 }}>
              This action will update Item Master and Supplier Master records from the Source Sheet.
              <strong> An automatic verified backup snapshot will be saved first.</strong>
              Approved transactional records (Indents, POs, GRNs, Requisitions) are strictly protected and will not be overwritten.
              ERP-to-Sheets write-back remains disabled.
            </div>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <Button
                variant="primary"
                size="sm"
                onClick={() => reconcileMutation.mutate(false)}
                disabled={reconcileMutation.isPending}
              >
                {reconcileMutation.isPending ? 'Backing up & Reconciling…' : 'Confirm Backup & Reconcile'}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmReconcile(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {/* Tab switchers */}
        <div style={{ display: 'flex', borderBottom: '1px solid var(--border)', gap: 16 }}>
          <button
            onClick={() => setActiveTab('matrix')}
            style={{
              padding: '8px 12px',
              borderBottom: activeTab === 'matrix' ? '2px solid var(--accent-600)' : '2px solid transparent',
              fontWeight: activeTab === 'matrix' ? 600 : 400,
              color: activeTab === 'matrix' ? 'var(--ink-900)' : 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Audit Matrix ({summaries.length} Tabs)
          </button>
          <button
            onClick={() => setActiveTab('discrepancies')}
            style={{
              padding: '8px 12px',
              borderBottom: activeTab === 'discrepancies' ? '2px solid var(--accent-600)' : '2px solid transparent',
              fontWeight: activeTab === 'discrepancies' ? 600 : 400,
              color: activeTab === 'discrepancies' ? 'var(--ink-900)' : 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Discrepancies ({report?.discrepancies.length ?? 0})
          </button>
          <button
            onClick={() => setActiveTab('formulas')}
            style={{
              padding: '8px 12px',
              borderBottom: activeTab === 'formulas' ? '2px solid var(--accent-600)' : '2px solid transparent',
              fontWeight: activeTab === 'formulas' ? 600 : 400,
              color: activeTab === 'formulas' ? 'var(--ink-900)' : 'var(--text-muted)',
              fontSize: 'var(--text-sm)',
            }}
          >
            Formula & Business Rules ({report?.formulaAudit.length ?? 0})
          </button>
        </div>

        {/* Tab Content: Matrix */}
        {activeTab === 'matrix' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
              <thead>
                <tr>
                  <th>Tab Name</th>
                  <th style={{ textAlign: 'right' }}>Source Sheet Rows</th>
                  <th style={{ textAlign: 'right' }}>ERP Database Rows</th>
                  <th style={{ textAlign: 'right' }}>Reference Replica</th>
                  <th style={{ textAlign: 'center' }}>Audit Status</th>
                  <th>Notes & Rules</th>
                </tr>
              </thead>
              <tbody>
                {summaries.map((s) => (
                  <tr key={s.tabName}>
                    <td style={{ fontWeight: 600 }}>{s.tabName}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{s.sourceRows.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{s.dbRows.toLocaleString()}</td>
                    <td style={{ textAlign: 'right', fontFamily: 'var(--font-mono)' }}>{s.refRows.toLocaleString()}</td>
                    <td style={{ textAlign: 'center' }}>
                      <Badge tone={s.status === 'MATCHED' ? 'success' : s.status === 'DISCREPANCY' ? 'warning' : 'neutral'}>
                        {s.status === 'MATCHED' ? 'MATCHED' : s.status === 'DISCREPANCY' ? `${s.discrepanciesCount} DIFFS` : 'VERIFIED'}
                      </Badge>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '11px' }}>{s.notes || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab Content: Discrepancies */}
        {activeTab === 'discrepancies' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Filter Tab:</span>
                {['ALL', 'Item Master', 'Supplier Master', 'Requisition'].map((t) => (
                  <button
                    key={t}
                    onClick={() => setFilterTab(t)}
                    style={{
                      padding: '3px 8px',
                      fontSize: '11px',
                      borderRadius: 'var(--radius-sm)',
                      background: filterTab === t ? 'var(--accent-100)' : 'var(--bg-inset)',
                      color: filterTab === t ? 'var(--accent-800)' : 'inherit',
                      border: '1px solid var(--border)',
                    }}
                  >
                    {t}
                  </button>
                ))}
              </div>

              <div style={{ position: 'relative', width: 220 }}>
                <Search size={13} style={{ position: 'absolute', left: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
                <input
                  className="input"
                  style={{ paddingLeft: 26, height: 28, fontSize: '11px' }}
                  placeholder="Search discrepancy…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
            </div>

            <div style={{ overflowX: 'auto', maxHeight: 380 }}>
              <table className="table" style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
                <thead>
                  <tr>
                    <th>Tab</th>
                    <th>Record Key</th>
                    <th>Field</th>
                    <th>Source Sheet Value</th>
                    <th>ERP Value</th>
                    <th>Type</th>
                    <th>Audit Recommendation</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredDiscrepancies.length === 0 ? (
                    <tr>
                      <td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>
                        No discrepancies found matching the current filter.
                      </td>
                    </tr>
                  ) : (
                    filteredDiscrepancies.slice(0, 100).map((d, i) => (
                      <tr key={i}>
                        <td style={{ fontWeight: 600 }}>{d.tab}</td>
                        <td style={{ fontFamily: 'var(--font-mono)' }}>{d.key}</td>
                        <td>{d.field}</td>
                        <td style={{ color: 'var(--danger-700)', fontWeight: 500 }}>
                          {d.sourceValue !== null && d.sourceValue !== undefined ? String(d.sourceValue) : '—'}
                        </td>
                        <td style={{ color: 'var(--success-700)', fontWeight: 500 }}>
                          {d.erpValue !== null && d.erpValue !== undefined ? String(d.erpValue) : '—'}
                        </td>
                        <td>
                          <Badge tone={d.severity === 'HIGH' ? 'danger' : d.severity === 'MEDIUM' ? 'warning' : 'neutral'}>
                            {d.type.replace(/_/g, ' ')}
                          </Badge>
                        </td>
                        <td style={{ fontSize: '11px', color: 'var(--text-muted)' }}>{d.recommendation}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
            {filteredDiscrepancies.length > 100 && (
              <div style={{ fontSize: '11px', color: 'var(--text-muted)', textAlign: 'center' }}>
                Showing first 100 of {filteredDiscrepancies.length} discrepancies. Use search to refine.
              </div>
            )}
          </div>
        )}

        {/* Tab Content: Formulas */}
        {activeTab === 'formulas' && (
          <div style={{ overflowX: 'auto' }}>
            <table className="table" style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
              <thead>
                <tr>
                  <th>Entity / View</th>
                  <th>Formula / Derived Field</th>
                  <th style={{ textAlign: 'center' }}>Status</th>
                  <th>Business Calculation Rule</th>
                </tr>
              </thead>
              <tbody>
                {(report?.formulaAudit || []).map((f, i) => (
                  <tr key={i}>
                    <td style={{ fontWeight: 600 }}>{f.entity}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{f.formulaField}</td>
                    <td style={{ textAlign: 'center' }}>
                      <Badge tone="success">VERIFIED DERIVED</Badge>
                    </td>
                    <td style={{ color: 'var(--text-muted)', fontSize: '12px' }}>{f.rule}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}
