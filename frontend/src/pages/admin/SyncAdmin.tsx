/**
 * Google Sheets Live Sync administration (SRS §8, §9).
 *
 * The status panel is explicit about the one thing that matters: SQL is the
 * system of record, and a sheet never overwrites an approved or posted document.
 * Divergences appear here as conflicts for a person to resolve.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  RefreshCw, Play, AlertTriangle, CheckCircle2, Database, ArrowRight, Info, FileSpreadsheet, ShieldCheck,
} from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Badge, LoadingBlock, EmptyState,
  Tabs, Modal, Field, Textarea, DetailItem, DetailGrid, SectionTitle, StatusBadge,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { DataTable, type Column } from '../../components/DataTable';
import { formatDateTime, relativeTime, count, text } from '../../lib/format';

interface SheetMapping {
  sheet_name: string; target_entity: string; is_enabled: boolean; sync_order: number; notes: string;
}
interface SyncJobSummary {
  id: number; status: string; trigger_source: string; started_at: string; finished_at: string | null;
  duration_ms: number | null; sheets_processed: number; rows_read: number; rows_inserted: number;
  rows_updated: number; rows_skipped: number; rows_rejected: number; conflicts: number;
  message: string | null; actor_name: string | null;
  detail?: { sheet: string; entity: string; rowsRead: number; inserted: number; updated: number; skipped: number; rejected: number; conflicts: number; message?: string }[];
}
interface SyncStatus {
  enabled: boolean; running: boolean; configured: boolean; mode: string;
  sheetId: string; notConfiguredReason: string | null;
  lastJob: SyncJobSummary | null;
  unresolvedIssues: number; unresolvedConflicts: number;
  mappings: SheetMapping[];
  systemOfRecord: string; note: string;
}
interface SyncIssue {
  id: number; sheet_name: string; row_number: number | null; column_name: string | null;
  business_key: string | null; severity: string; error_code: string; error_message: string;
  raw_value: string | null; existing_value: unknown; incoming_value: unknown;
  resolved_at: string | null; resolution: string | null; resolved_by_name: string | null;
  created_at: string;
}

export default function SyncAdmin() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [tab, setTab] = useState<'overview' | 'issues' | 'history'>('overview');
  const [resolving, setResolving] = useState<SyncIssue | null>(null);
  const [resolution, setResolution] = useState('');
  const [showResolved, setShowResolved] = useState(false);

  const status = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: () => api.get<SyncStatus>('/google-sync/status'),
    refetchInterval: 30_000,
  });

  const jobs = useQuery({
    queryKey: ['sync', 'jobs'],
    queryFn: () => api.getWithMeta<SyncJobSummary[], PageMeta>('/google-sync/jobs?pageSize=50'),
    enabled: tab === 'history',
  });

  const issues = useQuery({
    queryKey: ['sync', 'issues', showResolved],
    queryFn: () => api.getWithMeta<SyncIssue[], PageMeta>(`/google-sync/issues${qs({ resolved: showResolved ? 'true' : 'false', pageSize: 100 })}`),
    enabled: tab === 'issues',
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ message: string }>('/google-sync/toggle', { enabled }),
    onSuccess: (res) => { toast.success('Live Sync updated', res.message); void qc.invalidateQueries({ queryKey: ['sync'] }); },
    onError: (err) => toast.fromError(err),
  });

  const run = useMutation({
    mutationFn: (dryRun: boolean) =>
      api.post<{ status: string; message: string; totals: { inserted: number; updated: number; rejected: number; conflicts: number } }>(
        '/google-sync/run', { dryRun },
      ),
    onSuccess: (res) => {
      if (res.status === 'SUCCESS') toast.success('Sync complete', res.message);
      else if (res.status === 'PARTIAL') toast.warning('Sync completed with issues', res.message);
      else toast.error('Sync failed', res.message);
      void qc.invalidateQueries({ queryKey: ['sync'] });
      void qc.invalidateQueries({ queryKey: ['items'] });
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['lookups'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const resolve = useMutation({
    mutationFn: (i: SyncIssue) => api.post<{ message: string }>(`/google-sync/issues/${i.id}/resolve`, { resolution }),
    onSuccess: (res) => {
      toast.success('Issue resolved', res.message);
      setResolving(null); setResolution('');
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const s = status.data;

  const issueColumns: Column<SyncIssue>[] = [
    {
      key: 'severity', header: 'Severity', align: 'center', width: '104px',
      render: (i) => (
        <Badge tone={i.severity === 'CONFLICT' ? 'warning' : i.severity === 'ERROR' ? 'danger' : 'info'}>
          {i.severity}
        </Badge>
      ),
    },
    { key: 'sheet', header: 'Sheet', render: (i) => <span className="cell-strong">{i.sheet_name}</span> },
    { key: 'row', header: 'Row', align: 'right', width: '64px', render: (i) => <span className="num">{i.row_number ?? '—'}</span> },
    { key: 'key', header: 'Record', render: (i) => <span className="cell-code">{text(i.business_key)}</span> },
    { key: 'code', header: 'Code', optional: true, render: (i) => <Badge tone="neutral" plain>{i.error_code}</Badge> },
    {
      key: 'message', header: 'What happened',
      render: (i) => <span style={{ display: 'block', maxWidth: 460, lineHeight: 1.5 }}>{i.error_message}</span>,
    },
    { key: 'when', header: 'When', align: 'right', render: (i) => <span className="cell-muted">{relativeTime(i.created_at)}</span> },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '96px',
      render: (i) =>
        i.resolved_at ? (
          <Badge tone="success"><CheckCircle2 size={9} /> Resolved</Badge>
        ) : can('sync.admin') ? (
          <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); setResolving(i); setResolution(''); }}>
            Resolve
          </Button>
        ) : null,
    },
  ];

  return (
    <>
      <PageHeader
        title="Google Sheets Sync"
        subtitle="A controlled one-way bridge from the spreadsheet into SQL"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Google Sheets Sync' }]}
        actions={
          can('sync.admin') ? (
            <>
              <Button variant="secondary" size="sm" icon={<Play size={13} />}
                      disabled={!s?.configured || s?.running}
                      loading={run.isPending && run.variables === true}
                      onClick={() => run.mutate(true)}>
                Dry run
              </Button>
              <Button variant="primary" size="sm" icon={<RefreshCw size={13} />}
                      disabled={!s?.configured || s?.running}
                      loading={run.isPending && run.variables === false}
                      onClick={() => run.mutate(false)}>
                Sync now
              </Button>
            </>
          ) : undefined
        }
      />

      {status.isLoading ? <LoadingBlock /> : s ? (
        <>
          {/* ── Configuration state ─────────────────────────────────────── */}
          {!s.configured && (
            <Card style={{ marginBottom: 'var(--sp-4)', borderColor: 'var(--warning-100)' }}>
              <CardBody>
                <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                  <AlertTriangle size={20} style={{ color: 'var(--warning-600)', flexShrink: 0, marginTop: 2 }} />
                  <div>
                    <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--ink-900)', marginBottom: 5 }}>
                      Sync is not configured
                    </div>
                    <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                      {s.notConfiguredReason}
                    </div>
                  </div>
                </div>
              </CardBody>
            </Card>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(430px, 1fr))', gap: 'var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
            <Card>
              <CardHeader icon={<RefreshCw size={16} />} title="Live Sync" subtitle="Global switch — persisted, not per-browser" />
              <CardBody>
                <div
                  className="row"
                  style={{
                    gap: 'var(--sp-4)', padding: 'var(--sp-4)',
                    borderRadius: 'var(--radius-sm)',
                    background: s.enabled ? 'var(--success-50)' : 'var(--bg-inset)',
                    border: `1px solid ${s.enabled ? 'var(--success-100)' : 'var(--border)'}`,
                  }}
                >
                  <div className="grow">
                    <div className="row" style={{ gap: 8 }}>
                      <span style={{ fontSize: 'var(--text-lg)', fontWeight: 700, color: s.enabled ? 'var(--success-700)' : 'var(--ink-600)' }}>
                        {s.enabled ? 'ON' : 'OFF'}
                      </span>
                      {s.running && <Badge tone="info">Running…</Badge>}
                    </div>
                    <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 3, lineHeight: 1.6 }}>
                      {s.enabled
                        ? 'Sheets are synchronised on the configured interval and on demand.'
                        : 'Synchronisation is stopped. The ERP continues to operate normally from its own database.'}
                    </div>
                  </div>
                  <button
                    role="switch"
                    aria-checked={s.enabled}
                    aria-label="Toggle Live Sync"
                    disabled={!can('sync.admin') || toggle.isPending}
                    onClick={() => toggle.mutate(!s.enabled)}
                    style={{
                      width: 52, height: 28, borderRadius: 'var(--radius-full)', flexShrink: 0,
                      background: s.enabled ? 'var(--success-500)' : 'var(--ink-300)',
                      position: 'relative', transition: 'background var(--dur) var(--ease)',
                      cursor: can('sync.admin') ? 'pointer' : 'not-allowed',
                      opacity: can('sync.admin') ? 1 : 0.6,
                    }}
                  >
                    <span style={{
                      position: 'absolute', top: 3, left: s.enabled ? 27 : 3,
                      width: 22, height: 22, borderRadius: '50%', background: '#fff',
                      transition: 'left var(--dur) var(--ease-spring)',
                      boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
                    }} />
                  </button>
                </div>

                <DetailGrid cols={2}>
                  <div style={{ marginTop: 'var(--sp-4)' }}>
                    <DetailItem label="System of record">
                      <span className="row" style={{ gap: 6 }}>
                        <Database size={13} style={{ color: 'var(--brand-600)' }} /> SQL
                      </span>
                    </DetailItem>
                  </div>
                  <div style={{ marginTop: 'var(--sp-4)' }}>
                    <DetailItem label="Credential mode">
                      <Badge tone={s.configured ? 'success' : 'warning'}>{s.mode}</Badge>
                    </DetailItem>
                  </div>
                  <div style={{ gridColumn: '1 / -1' }}>
                    <DetailItem label="Spreadsheet ID" mono>
                      <span style={{ wordBreak: 'break-all', fontSize: 'var(--text-2xs)' }}>{s.sheetId}</span>
                    </DetailItem>
                  </div>
                </DetailGrid>
              </CardBody>
            </Card>

            <Card>
              <CardHeader icon={<ShieldCheck size={16} />} title="Last synchronisation" />
              <CardBody>
                {!s.lastJob ? (
                  <EmptyState title="No sync has run yet" message="Run a dry run first to see what the sheets contain without writing anything." />
                ) : (
                  <>
                    <div className="row" style={{ gap: 10, marginBottom: 'var(--sp-4)' }}>
                      <StatusBadge status={s.lastJob.status} />
                      <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                        {relativeTime(s.lastJob.started_at)} · {s.lastJob.trigger_source.toLowerCase()}
                        {s.lastJob.duration_ms ? ` · ${(s.lastJob.duration_ms / 1000).toFixed(1)}s` : ''}
                      </span>
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(96px, 1fr))', gap: 'var(--sp-2)' }}>
                      <StatTile label="Read" value={count(s.lastJob.rows_read)} />
                      <StatTile label="Created" value={count(s.lastJob.rows_inserted)} tone="success" />
                      <StatTile label="Updated" value={count(s.lastJob.rows_updated)} tone="info" />
                      <StatTile label="Rejected" value={count(s.lastJob.rows_rejected)} tone={s.lastJob.rows_rejected > 0 ? 'danger' : 'default'} />
                      <StatTile label="Conflicts" value={count(s.lastJob.conflicts)} tone={s.lastJob.conflicts > 0 ? 'warning' : 'default'} />
                    </div>
                    {s.lastJob.message && (
                      <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                        {s.lastJob.message}
                      </div>
                    )}
                  </>
                )}
              </CardBody>
            </Card>
          </div>

          {s.unresolvedConflicts > 0 && (
            <Card style={{ marginBottom: 'var(--sp-4)', borderColor: 'var(--warning-100)' }}>
              <CardBody style={{ padding: 'var(--sp-4)' }}>
                <div className="row" style={{ gap: 11 }}>
                  <AlertTriangle size={17} style={{ color: 'var(--warning-600)', flexShrink: 0 }} />
                  <span className="grow" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)' }}>
                    <strong>{s.unresolvedConflicts} unresolved conflict(s).</strong> The sheet disagrees with
                    an ERP record. Nothing was overwritten — review each one and decide deliberately.
                  </span>
                  <Button variant="secondary" size="sm" iconRight={<ArrowRight size={13} />} onClick={() => setTab('issues')}>
                    Review conflicts
                  </Button>
                </div>
              </CardBody>
            </Card>
          )}

          <div style={{ marginBottom: 'var(--sp-4)' }}>
            <Tabs
              tabs={[
                { key: 'overview', label: 'Sheet mapping' },
                { key: 'issues', label: 'Conflicts & errors', count: s.unresolvedIssues },
                { key: 'history', label: 'Sync history' },
              ]}
              active={tab}
              onChange={(k) => setTab(k as 'overview' | 'issues' | 'history')}
            />
          </div>

          {/* ── Mapping ─────────────────────────────────────────────────── */}
          {tab === 'overview' && (
            <>
              <Card style={{ marginBottom: 'var(--sp-4)' }}>
                <CardBody style={{ padding: 'var(--sp-4)' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <Info size={15} style={{ color: 'var(--brand-500)', flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                      {s.note}
                    </span>
                  </div>
                </CardBody>
              </Card>

              <Card>
                <CardHeader
                  icon={<FileSpreadsheet size={16} />}
                  title="Sheet to entity mapping"
                  subtitle="Masters synchronise first, so transactional rows can resolve their references"
                />
                <CardBody flush>
                  <div className="table-wrap">
                    <table className="table table-compact">
                      <thead>
                        <tr><th style={{ width: 60 }}>Order</th><th>Sheet</th><th>Target</th><th className="center">Enabled</th><th>Notes</th></tr>
                      </thead>
                      <tbody>
                        {s.mappings.map((m) => {
                          const isTransactional = ['purchase_indents', 'purchase_orders', 'grns'].includes(m.target_entity);
                          return (
                            <tr key={m.sheet_name}>
                              <td className="num cell-muted">{m.sync_order}</td>
                              <td className="cell-strong">{m.sheet_name}</td>
                              <td>
                                <span className="cell-code">{m.target_entity}</span>
                                {isTransactional && (
                                  <div style={{ marginTop: 3 }}>
                                    <Badge tone="warning" plain>Reconcile only — never written</Badge>
                                  </div>
                                )}
                              </td>
                              <td className="center">
                                <Badge tone={m.is_enabled ? 'success' : 'neutral'}>{m.is_enabled ? 'Yes' : 'No'}</Badge>
                              </td>
                              <td className="cell-muted" style={{ fontSize: 'var(--text-2xs)', maxWidth: 420, lineHeight: 1.5 }}>
                                {text(m.notes)}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </CardBody>
              </Card>
            </>
          )}

          {/* ── Issues ──────────────────────────────────────────────────── */}
          {tab === 'issues' && (
            <DataTable
              columns={issueColumns}
              rows={issues.data?.data ?? []}
              rowKey={(i) => i.id}
              loading={issues.isLoading}
              error={issues.error}
              onRetry={() => void issues.refetch()}
              emptyTitle={showResolved ? 'No resolved issues' : 'No outstanding issues'}
              emptyMessage={showResolved ? 'Nothing has been marked resolved yet.' : 'Every sheet row either applied cleanly or matched the ERP.'}
              compact
              toolbar={
                <Button variant={showResolved ? 'primary' : 'secondary'} size="sm" onClick={() => setShowResolved((v) => !v)}>
                  {showResolved ? 'Showing resolved' : 'Showing outstanding'}
                </Button>
              }
            />
          )}

          {/* ── History ─────────────────────────────────────────────────── */}
          {tab === 'history' && (
            <Card>
              <CardHeader title="Synchronisation history" />
              <CardBody flush>
                {jobs.isLoading ? <LoadingBlock height={180} /> : (jobs.data?.data ?? []).length === 0 ? (
                  <div style={{ padding: 'var(--sp-8)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                    No sync jobs have run yet.
                  </div>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 480 }}>
                    <table className="table table-compact">
                      <thead>
                        <tr>
                          <th>Started</th><th className="center">Status</th><th>Trigger</th>
                          <th className="right">Sheets</th><th className="right">Read</th>
                          <th className="right">Created</th><th className="right">Updated</th>
                          <th className="right">Rejected</th><th className="right">Conflicts</th>
                          <th className="right">Duration</th><th>By</th>
                        </tr>
                      </thead>
                      <tbody>
                        {(jobs.data?.data ?? []).map((j) => (
                          <tr key={j.id}>
                            <td>{formatDateTime(j.started_at)}</td>
                            <td className="center"><StatusBadge status={j.status} /></td>
                            <td className="cell-muted">{j.trigger_source}</td>
                            <td className="right num">{count(j.sheets_processed)}</td>
                            <td className="right num">{count(j.rows_read)}</td>
                            <td className="right num" style={{ color: 'var(--success-600)' }}>{count(j.rows_inserted)}</td>
                            <td className="right num" style={{ color: 'var(--info-600)' }}>{count(j.rows_updated)}</td>
                            <td className="right num" style={{ color: j.rows_rejected > 0 ? 'var(--danger-600)' : undefined }}>{count(j.rows_rejected)}</td>
                            <td className="right num" style={{ color: j.conflicts > 0 ? 'var(--warning-600)' : undefined }}>{count(j.conflicts)}</td>
                            <td className="right num cell-muted">{j.duration_ms ? `${(j.duration_ms / 1000).toFixed(1)}s` : '—'}</td>
                            <td className="cell-muted truncate" style={{ maxWidth: 140 }}>{text(j.actor_name)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </CardBody>
            </Card>
          )}
        </>
      ) : null}

      {/* ── Resolve issue ─────────────────────────────────────────────────── */}
      <Modal
        open={resolving !== null}
        onClose={() => { setResolving(null); setResolution(''); }}
        title="Resolve sync issue"
        subtitle={resolving ? `${resolving.sheet_name} · ${resolving.business_key ?? `row ${resolving.row_number}`}` : undefined}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setResolving(null); setResolution(''); }}>Cancel</Button>
            <Button variant="primary" loading={resolve.isPending} disabled={!resolution.trim()}
                    onClick={() => resolving && resolve.mutate(resolving)}>
              Mark resolved
            </Button>
          </>
        }
      >
        {resolving && (
          <>
            <div
              style={{
                padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-4)',
                background: 'var(--warning-50)', border: '1px solid var(--warning-100)',
                borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)',
                color: 'var(--ink-800)', lineHeight: 1.6,
              }}
            >
              {resolving.error_message}
            </div>

            {(resolving.existing_value || resolving.incoming_value) && (
              <div style={{ marginBottom: 'var(--sp-4)' }}>
                <SectionTitle>Values compared</SectionTitle>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--sp-3)' }}>
                  <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--brand-700)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
                      In the ERP (kept)
                    </div>
                    <pre style={{ fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--ink-700)', margin: 0 }}>
                      {JSON.stringify(resolving.existing_value, null, 1)}
                    </pre>
                  </div>
                  <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 700, color: 'var(--warning-700)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 5 }}>
                      In the sheet (ignored)
                    </div>
                    <pre style={{ fontSize: 'var(--text-2xs)', fontFamily: 'var(--font-mono)', whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: 'var(--ink-700)', margin: 0 }}>
                      {JSON.stringify(resolving.incoming_value, null, 1)}
                    </pre>
                  </div>
                </div>
              </div>
            )}

            <Field label="How was this resolved?" required
                   hint="Recorded against the issue and in the audit trail">
              <Textarea value={resolution} onChange={(e) => setResolution(e.target.value)} rows={3}
                        placeholder="e.g. Sheet row was a duplicate entry and has been deleted upstream." autoFocus />
            </Field>
          </>
        )}
      </Modal>
    </>
  );
}
