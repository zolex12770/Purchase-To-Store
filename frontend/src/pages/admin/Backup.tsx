/**
 * Backup & Restore (SRS §23).
 *
 * Restore is destructive and irreversible, so it demands typed confirmation and
 * refuses outright if the file's checksum no longer matches.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  HardDriveDownload, Plus, ShieldCheck, Download, Trash2, RotateCcw,
  FolderOpen, AlertTriangle, CheckCircle2, XCircle, DatabaseZap, ScanSearch, Eraser,
} from 'lucide-react';
import { api, downloadFile } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, Modal, Field, Input, Textarea, Badge, ConfirmDialog,
} from '../../components/ui';
import { DataTable, type Column } from '../../components/DataTable';
import { formatDateTime, relativeTime, count, text } from '../../lib/format';

interface TableInventory {
  table: string;
  kind: 'business' | 'system' | 'operational';
  total: number;
  real: number;
  demo: number;
  test: number;
  system: number;
  unknown: number;
  basis: string;
}

interface DataAuditResponse {
  inventory: TableInventory[];
  businessCounts: Record<string, number>;
  totalDemoOrTest: number;
  totalUnknown: number;
  generatedAt: string;
}

interface PurifyResponse {
  mode: 'dry-run' | 'apply';
  message: string;
  totalDemoOrTest?: number;
  before?: Record<string, number>;
  after?: Record<string, number>;
  failures?: number;
  backup?: { filename: string };
}

interface BackupRow {
  id: number;
  filename: string;
  kind: string;
  status: string;
  size_bytes: string;
  checksum_sha256: string;
  table_counts: Record<string, number>;
  schema_version: string;
  notes: string;
  created_at: string;
  created_by_name: string | null;
  verified_at: string | null;
  restored_at: string | null;
  fileExists: boolean;
}

interface BackupSchedule {
  enabled: boolean;
  intervalHours: number;
  lastScheduledAt: string | null;
  nextDueAt: string | null;
  due: boolean;
  running: boolean;
  retention: { policy: { retentionDays: number; retentionCount: number }; scheduledBackups: number; pruned: string[] };
}

const formatBytes = (b: string | number): string => {
  const n = Number(b);
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
};

export default function Backup() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [creating, setCreating] = useState(false);
  const [notes, setNotes] = useState('');
  const [restoring, setRestoring] = useState<BackupRow | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [deleting, setDeleting] = useState<BackupRow | null>(null);
  const [purifying, setPurifying] = useState(false);
  const [purifyConfirmText, setPurifyConfirmText] = useState('');

  const dataAudit = useQuery({
    queryKey: ['data-audit'],
    queryFn: () => api.get<DataAuditResponse>('/backup/data-audit'),
    enabled: can('backup.view'),
  });

  const purify = useMutation({
    mutationFn: () => api.post<PurifyResponse>('/backup/data-audit/purify', { apply: true, confirm: 'PURIFY' }),
    onSuccess: (res) => {
      if (res.failures) {
        toast.error('Purification completed with verification failures', res.message);
      } else {
        toast.success('Data purification complete', res.message);
      }
      setPurifying(false); setPurifyConfirmText('');
      void qc.invalidateQueries({ queryKey: ['data-audit'] });
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const list = useQuery({
    queryKey: ['backups'],
    queryFn: () => api.getWithMeta<BackupRow[], { location: string }>('/backup'),
  });

  const schedule = useQuery({
    queryKey: ['backup-schedule'],
    queryFn: () => api.get<BackupSchedule>('/backup/schedule'),
    enabled: can('backup.view'),
  });

  const create = useMutation({
    mutationFn: () => api.post<{ filename: string; totalRows: number; location: string }>('/backup', { notes }),
    onSuccess: (res) => {
      toast.success('Backup created', `${res.filename} · ${count(res.totalRows)} rows`);
      setCreating(false); setNotes('');
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const verify = useMutation({
    mutationFn: (b: BackupRow) => api.post<{ valid: boolean; message: string }>(`/backup/${b.id}/verify`, {}),
    onSuccess: (res) => {
      if (res.valid) toast.success('Integrity verified', res.message);
      else toast.error('Integrity check FAILED', res.message);
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const restore = useMutation({
    mutationFn: (b: BackupRow) => api.post<{ totalRows: number; message: string }>(`/backup/${b.id}/restore`, { confirm: 'RESTORE' }),
    onSuccess: (res) => {
      toast.success('Database restored', res.message);
      setRestoring(null); setConfirmText('');
      // The whole cache now describes a database that no longer exists.
      void qc.invalidateQueries();
    },
    onError: (err) => toast.fromError(err),
  });

  const remove = useMutation({
    mutationFn: (b: BackupRow) => api.del<{ message: string }>(`/backup/${b.id}`),
    onSuccess: (res) => {
      toast.success('Backup deleted', res.message);
      setDeleting(null);
      void qc.invalidateQueries({ queryKey: ['backups'] });
    },
    onError: (err) => { toast.fromError(err); setDeleting(null); },
  });

  const exportAll = useMutation({
    mutationFn: () => api.post<{
      totalRows: number; rowCountMismatch: boolean; dataFile: string; excelFile: string;
      googleSheetsConfigured: boolean; googleSheetsExported: string[];
    }>('/backup/export/all', {}),
    onSuccess: (res) => {
      if (res.rowCountMismatch) {
        toast.error('Export completed with a row-count mismatch', 'Live data changed while exporting — re-run the export.');
      } else {
        toast.success(
          'DATABASE/ export complete',
          `${count(res.totalRows)} rows → SQL + Excel${res.googleSheetsConfigured ? ` + ${res.googleSheetsExported.length} Google Sheet(s)` : ''}`,
        );
      }
    },
    onError: (err) => toast.fromError(err),
  });

  const columns: Column<BackupRow>[] = [
    {
      key: 'file', header: 'Backup file',
      render: (b) => (
        <div>
          <div className="cell-code truncate" style={{ maxWidth: 320 }}>{b.filename}</div>
          {b.notes && (
            <div className="truncate" style={{ maxWidth: 320, fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{b.notes}</div>
          )}
        </div>
      ),
    },
    {
      key: 'created', header: 'Created',
      render: (b) => (
        <div>
          <div>{formatDateTime(b.created_at)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>
            {relativeTime(b.created_at)} · {text(b.created_by_name)}
          </div>
        </div>
      ),
    },
    { key: 'kind', header: 'Type', align: 'center', render: (b) => <Badge tone="neutral" plain>{b.kind}</Badge> },
    { key: 'size', header: 'Size', align: 'right', render: (b) => <span className="num">{formatBytes(b.size_bytes)}</span> },
    {
      key: 'rows', header: 'Records', align: 'right',
      render: (b) => (
        <span className="num" title={Object.entries(b.table_counts ?? {}).map(([t, n]) => `${t}: ${n}`).join('\n')}>
          {count(Object.values(b.table_counts ?? {}).reduce((a, c) => a + c, 0))}
        </span>
      ),
    },
    { key: 'schema', header: 'Schema', optional: true, render: (b) => <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{text(b.schema_version)}</span> },
    {
      key: 'status', header: 'Integrity', align: 'center',
      render: (b) => {
        if (!b.fileExists) return <Badge tone="danger"><XCircle size={9} /> File missing</Badge>;
        if (b.status === 'CORRUPT') return <Badge tone="danger"><AlertTriangle size={9} /> Corrupt</Badge>;
        if (b.status === 'VERIFIED') return <Badge tone="success"><CheckCircle2 size={9} /> Verified</Badge>;
        return <Badge tone="neutral">{b.status}</Badge>;
      },
    },
    {
      key: 'restored', header: 'Restored', optional: true, align: 'right',
      render: (b) => <span className="cell-muted">{b.restored_at ? relativeTime(b.restored_at) : '—'}</span>,
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '134px',
      render: (b) => (
        <div className="row" style={{ gap: 1, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          <Button variant="ghost" size="sm" title="Verify checksum" loading={verify.isPending && verify.variables?.id === b.id}
                  onClick={() => verify.mutate(b)} disabled={!b.fileExists}>
            <ShieldCheck size={13} />
          </Button>
          <Button variant="ghost" size="sm" title="Download" disabled={!b.fileExists}
                  onClick={() => void downloadFile(`/backup/${b.id}/download`, b.filename)}>
            <Download size={13} />
          </Button>
          {can('backup.admin') && (
            <Button variant="ghost" size="sm" title="Restore from this backup" disabled={!b.fileExists || b.status === 'CORRUPT'}
                    onClick={() => { setRestoring(b); setConfirmText(''); }}>
              <RotateCcw size={13} style={{ color: 'var(--warning-600)' }} />
            </Button>
          )}
          {can('backup.admin') && (
            <Button variant="ghost" size="sm" title="Delete backup" onClick={() => setDeleting(b)}>
              <Trash2 size={13} style={{ color: 'var(--danger-600)' }} />
            </Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Backup & Restore"
        subtitle="Checksum-verified snapshots stored outside the application"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Backup & Restore' }]}
        actions={
          can('backup.create') ? (
            <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => { setCreating(true); setNotes(''); }}>
              Create backup
            </Button>
          ) : undefined
        }
      />

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody style={{ padding: 'var(--sp-4)' }}>
          <div className="row" style={{ gap: 10, flexWrap: 'wrap' }}>
            <FolderOpen size={16} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
            <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
              Backups are written to{' '}
              <code className="mono" style={{ fontSize: 'var(--text-2xs)', background: 'var(--bg-inset)', padding: '2px 6px', borderRadius: 3, border: '1px solid var(--border)' }}>
                {list.data?.meta.location ?? '…'}
              </code>{' '}
              — outside the project folder, so they survive a redeploy and are never committed to source control.
            </span>
          </div>
        </CardBody>
      </Card>

      {schedule.data && (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardBody style={{ padding: 'var(--sp-4)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <ShieldCheck size={16} style={{ color: schedule.data.enabled ? 'var(--success-600)' : 'var(--warning-600)', flexShrink: 0, marginTop: 2 }} />
              <div className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                <div style={{ marginBottom: 4 }}>
                  <strong>Automatic backups {schedule.data.enabled ? 'are on' : 'are OFF'}</strong>
                  {schedule.data.enabled && <> — every {schedule.data.intervalHours} hours, checked every 10 minutes (a missed one is taken soon after the server starts).</>}
                </div>
                <div>
                  Last automatic backup: <strong>{schedule.data.lastScheduledAt ? `${formatDateTime(schedule.data.lastScheduledAt)} (${relativeTime(schedule.data.lastScheduledAt)})` : 'none yet'}</strong>
                  {schedule.data.enabled && <> · next due: <strong>{schedule.data.due ? 'now' : formatDateTime(schedule.data.nextDueAt)}</strong></>}
                </div>
                <div style={{ marginTop: 4 }}>
                  Retention: automatic backups are removed only when older than {schedule.data.retention.policy.retentionDays} days
                  {' '}and not among the newest {schedule.data.retention.policy.retentionCount}. Manual backups are never removed.
                  {' '}({count(schedule.data.retention.scheduledBackups)} automatic backup(s) kept; {count(schedule.data.retention.pruned.length)} due for removal.)
                </div>
              </div>
              {schedule.data.running && <Badge tone="info">Backing up…</Badge>}
            </div>
          </CardBody>
        </Card>
      )}

      {can('backup.create') && (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardBody style={{ padding: 'var(--sp-4)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
              <DatabaseZap size={16} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
              <span className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)' }}>
                Exports the current real data into the project's{' '}
                <code className="mono" style={{ fontSize: 'var(--text-2xs)', background: 'var(--bg-inset)', padding: '2px 6px', borderRadius: 3, border: '1px solid var(--border)' }}>
                  DATABASE/
                </code>{' '}
                folder — a MySQL-compatible SQL dump (open in MySQL Workbench), an Excel workbook, and an
                archive of the synced Google Sheets. Read-only: restoring the ERP always uses the checksum-verified
                backups above, never these files.
              </span>
              <Button variant="secondary" size="sm" icon={<DatabaseZap size={13} />}
                      loading={exportAll.isPending} onClick={() => exportAll.mutate()}>
                Export to DATABASE/
              </Button>
            </div>
          </CardBody>
        </Card>
      )}

      {can('backup.view') && (
        <Card style={{ marginBottom: 'var(--sp-4)' }}>
          <CardBody style={{ padding: 'var(--sp-4)' }}>
            <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <ScanSearch size={16} style={{ color: 'var(--brand-500)', flexShrink: 0, marginTop: 2 }} />
              <div className="grow">
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Every business row is classified <strong>real</strong>, <strong>demo</strong> or <strong>test</strong>
                  {' '}(never guessed — an unclassifiable row is reported as <strong>unknown</strong> and left alone).
                  This reads the live database directly; nothing here is cached.
                </div>
                {dataAudit.isLoading && <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>Scanning…</span>}
                {dataAudit.error && <span style={{ fontSize: 'var(--text-xs)', color: 'var(--danger-600)' }}>Could not load the data audit.</span>}
                {dataAudit.data && (
                  <>
                    <div className="row" style={{ gap: 16, flexWrap: 'wrap', marginBottom: dataAudit.data.totalDemoOrTest > 0 ? 10 : 0 }}>
                      <span style={{ fontSize: 'var(--text-xs)' }}>
                        <strong>{count(dataAudit.data.totalDemoOrTest)}</strong> row(s) classified demo/test
                      </span>
                      {dataAudit.data.totalUnknown > 0 && (
                        <span style={{ fontSize: 'var(--text-xs)', color: 'var(--warning-600)' }}>
                          <strong>{count(dataAudit.data.totalUnknown)}</strong> row(s) UNKNOWN — not deleted, review by hand
                        </span>
                      )}
                    </div>
                    {dataAudit.data.totalDemoOrTest > 0 && (
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginBottom: 10 }}>
                        {dataAudit.data.inventory
                          .filter((t) => t.demo + t.test > 0)
                          .map((t) => `${t.table}: ${t.demo + t.test}`)
                          .join(' · ')}
                      </div>
                    )}
                  </>
                )}
              </div>
              <div className="row" style={{ gap: 8, flexShrink: 0 }}>
                <Button variant="secondary" size="sm" icon={<ScanSearch size={13} />}
                        loading={dataAudit.isFetching} onClick={() => void dataAudit.refetch()}>
                  Re-scan
                </Button>
                {can('backup.admin') && (dataAudit.data?.totalDemoOrTest ?? 0) > 0 && (
                  <Button variant="danger" size="sm" icon={<Eraser size={13} />}
                          onClick={() => { setPurifying(true); setPurifyConfirmText(''); }}>
                    Purify demo/test data
                  </Button>
                )}
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(b) => b.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="backups"
        emptyTitle="No backups yet"
        emptyMessage="Create a backup before any significant data change — restore is only possible from a backup that already exists."
        emptyAction={can('backup.create') ? <Button variant="primary" icon={<HardDriveDownload size={14} />} onClick={() => setCreating(true)}>Create the first backup</Button> : undefined}
        compact
      />

      {/* ── Create ────────────────────────────────────────────────────────── */}
      <Modal
        open={creating}
        onClose={() => setCreating(false)}
        title="Create backup"
        subtitle="A full snapshot of every table, with a SHA-256 checksum"
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => setCreating(false)}>Cancel</Button>
            <Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create backup</Button>
          </>
        }
      >
        <Field label="Notes" hint="Why are you taking this backup? Helpful when choosing what to restore.">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3}
                    placeholder="e.g. Before importing the July supplier master" autoFocus />
        </Field>
      </Modal>

      {/* ── Purify demo/test data ────────────────────────────────────────── */}
      <Modal
        open={purifying}
        onClose={() => { setPurifying(false); setPurifyConfirmText(''); }}
        title="Purify demo/test data"
        subtitle="Permanently removes rows classified demo or test"
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPurifying(false); setPurifyConfirmText(''); }}>Cancel</Button>
            <Button variant="danger" loading={purify.isPending} disabled={purifyConfirmText !== 'PURIFY'}
                    onClick={() => purify.mutate()}>
              Purify data
            </Button>
          </>
        }
      >
        <div
          className="row"
          style={{
            gap: 10, padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--danger-50)', border: '1px solid var(--danger-100)',
            borderRadius: 'var(--radius-sm)', alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--danger-600)', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--danger-700)', lineHeight: 1.6 }}>
            <strong>{count(dataAudit.data?.totalDemoOrTest ?? 0)} row(s)</strong> classified demo/test will be
            permanently deleted. A master (item/supplier/lookup/user) is only removed if no real, surviving
            document still references it — anything still in use is kept and reported, not force-deleted.
            A checksum-verified safety backup is taken automatically first.
          </div>
        </div>

        {dataAudit.data && dataAudit.data.totalDemoOrTest > 0 && (
          <div style={{ marginBottom: 'var(--sp-4)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            {dataAudit.data.inventory.filter((t) => t.demo + t.test > 0).map((t) => (
              <div key={t.table}><strong>{t.table}:</strong> {t.demo + t.test} row(s)</div>
            ))}
          </div>
        )}

        <Field label='Type PURIFY to confirm' required>
          <Input value={purifyConfirmText} onChange={(e) => setPurifyConfirmText(e.target.value.toUpperCase())}
                 placeholder="PURIFY" autoFocus style={{ fontFamily: 'var(--font-mono)' }} />
        </Field>
        <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
          Audit history is retained by default — it is the record that this purge happened.
        </div>
      </Modal>

      {/* ── Restore ───────────────────────────────────────────────────────── */}
      <Modal
        open={restoring !== null}
        onClose={() => { setRestoring(null); setConfirmText(''); }}
        title="Restore database from backup"
        subtitle={restoring?.filename}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setRestoring(null); setConfirmText(''); }}>Cancel</Button>
            <Button variant="danger" loading={restore.isPending} disabled={confirmText !== 'RESTORE'}
                    onClick={() => restoring && restore.mutate(restoring)}>
              Restore database
            </Button>
          </>
        }
      >
        <div
          className="row"
          style={{
            gap: 10, padding: 'var(--sp-4)', marginBottom: 'var(--sp-4)',
            background: 'var(--danger-50)', border: '1px solid var(--danger-100)',
            borderRadius: 'var(--radius-sm)', alignItems: 'flex-start',
          }}
        >
          <AlertTriangle size={18} style={{ color: 'var(--danger-600)', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 'var(--text-sm)', color: 'var(--danger-700)', lineHeight: 1.6 }}>
            <strong>This replaces the entire database.</strong> Every record created since this backup
            was taken — indents, purchase orders, goods receipts, users and audit entries — will be
            permanently lost. All users will be signed out.
          </div>
        </div>

        {restoring && (
          <div style={{ marginBottom: 'var(--sp-4)', fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>
            <div><strong>Taken:</strong> {formatDateTime(restoring.created_at)} ({relativeTime(restoring.created_at)})</div>
            <div><strong>Records:</strong> {count(Object.values(restoring.table_counts ?? {}).reduce((a, c) => a + c, 0))}</div>
            <div><strong>Schema:</strong> {restoring.schema_version}</div>
            <div className="truncate"><strong>Checksum:</strong> <span className="mono">{restoring.checksum_sha256.slice(0, 32)}…</span></div>
          </div>
        )}

        <Field label='Type RESTORE to confirm' required>
          <Input value={confirmText} onChange={(e) => setConfirmText(e.target.value.toUpperCase())}
                 placeholder="RESTORE" autoFocus style={{ fontFamily: 'var(--font-mono)' }} />
        </Field>
        <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
          The checksum is re-verified before anything is written. If the file has changed since it was
          created, the restore is refused.
        </div>
      </Modal>

      <ConfirmDialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting)}
        title="Delete backup?"
        confirmLabel="Delete"
        loading={remove.isPending}
        message={
          <>
            <strong>{deleting?.filename}</strong> will be permanently removed from disk.
            <br /><br />
            This cannot be undone, and you will no longer be able to restore to this point in time.
          </>
        }
      />
    </>
  );
}
