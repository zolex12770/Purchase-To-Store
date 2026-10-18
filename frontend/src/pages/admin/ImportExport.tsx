/**
 * Import / Export (SRS §22).
 *
 * Import is a four-step pipeline — upload → validate → PREVIEW → commit — and
 * nothing reaches the database until the preview is confirmed. Invalid rows can
 * be downloaded as an error report so they can be corrected in the source file.
 */
import { useState, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Upload, Download, FileSpreadsheet, CheckCircle2, AlertTriangle, XCircle,
  ArrowRight, FileDown, Info, RotateCcw, ShieldAlert,
} from 'lucide-react';
import { api, uploadFile, ApiError } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Badge, LoadingBlock, EmptyState,
  Tabs, SectionTitle, ConfirmDialog, Checkbox,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { relativeTime, count, text } from '../../lib/format';

interface ExportDataset { key: string; title: string; columns: string[] }
interface ImportColumn { header: string; required: boolean; lookup: string | null; numeric: boolean }
interface ImportEntity { key: string; title: string; columns: ImportColumn[] }
interface ImportCatalogue { entities: ImportEntity[]; note: string }

interface PreviewRow {
  rowNumber: number;
  status: 'VALID' | 'INVALID';
  action: 'INSERT' | 'UPDATE' | null;
  raw: Record<string, string>;
  errors: { field: string; message: string }[];
}

interface PreviewResult {
  jobId: number;
  entity: string;
  title: string;
  filename: string;
  totalRows: number;
  validRows: number;
  invalidRows: number;
  insertCount: number;
  updateCount: number;
  columnsMatched: Record<string, string | null>;
  preview: PreviewRow[];
}

interface ImportJob {
  id: number; entity: string; filename: string; status: string; mode: string;
  total_rows: number; valid_rows: number; invalid_rows: number;
  inserted_rows: number; updated_rows: number; message: string | null;
  created_at: string; committed_at: string | null; actor_name: string | null;
}

export default function ImportExport() {
  const { can } = useAuth();
  const toast = useToast();
  const download = useDownload();
  const qc = useQueryClient();
  const fileInput = useRef<HTMLInputElement>(null);

  // Only offer the Import tab to someone who can actually import something.
  const canImport = can('item.import') || can('supplier.import') || can('user.import');
  const [tab, setTab] = useState<'export' | 'import'>('export');
  const [entity, setEntity] = useState<string>('items');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [partialMode, setPartialMode] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [uploading, setUploading] = useState(false);

  const exports = useQuery({ queryKey: ['io', 'export'], queryFn: () => api.get<ExportDataset[]>('/io/export') });
  const importCatalogue = useQuery({ queryKey: ['io', 'import'], queryFn: () => api.get<ImportCatalogue>('/io/import') });
  const jobs = useQuery({ queryKey: ['io', 'jobs'], queryFn: () => api.get<ImportJob[]>('/io/import/jobs') });

  const activeEntity = importCatalogue.data?.entities.find((e) => e.key === entity)
    ?? importCatalogue.data?.entities[0];

  async function onFileChosen(file: File) {
    if (!activeEntity) return;
    setUploading(true);
    setPreview(null);
    try {
      const res = await uploadFile<PreviewResult>(`/io/import/${activeEntity.key}/preview`, file);
      setPreview(res);
      if (res.invalidRows > 0) {
        toast.warning(
          `${res.validRows} of ${res.totalRows} rows are valid`,
          `${res.invalidRows} row(s) have problems — review them before committing.`,
        );
      } else {
        toast.success(`${res.totalRows} rows validated`, 'Review the preview, then commit the import.');
      }
    } catch (err) {
      if (err instanceof ApiError) toast.fromError(err);
      else toast.error('Could not read that file', 'Upload a .xlsx or .csv file exported from this system.');
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  }

  const commit = useMutation({
    mutationFn: () =>
      api.post<{ inserted: number; updated: number; skipped: number; message: string }>(
        `/io/import/${preview!.jobId}/commit`,
        { mode: partialMode ? 'PARTIAL' : 'STRICT' },
      ),
    onSuccess: (res) => {
      toast.success('Import complete', res.message);
      setPreview(null);
      setConfirming(false);
      void qc.invalidateQueries();
    },
    onError: (err) => { toast.fromError(err); setConfirming(false); },
  });

  return (
    <>
      <PageHeader
        title="Import / Export"
        subtitle="Move master data in and out of Zolex as Excel or CSV"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Import / Export' }]}
      />

      <div style={{ marginBottom: 'var(--sp-4)' }}>
        <Tabs
          tabs={[
            { key: 'export', label: 'Export', icon: <Download size={14} /> },
            ...(canImport ? [{ key: 'import', label: 'Import', icon: <Upload size={14} /> }] : []),
          ]}
          active={tab}
          onChange={(k) => setTab(k as 'export' | 'import')}
        />
      </div>

      {/* ═══════════════════ EXPORT ═══════════════════ */}
      {tab === 'export' && (
        <>
          <Card style={{ marginBottom: 'var(--sp-4)' }}>
            <CardBody style={{ padding: 'var(--sp-4)' }}>
              <div className="row" style={{ gap: 10 }}>
                <Info size={15} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                  Exports here cover the full authorised dataset. To export exactly what you can see on
                  screen — with your filters applied — use the Export button on any list page instead.
                  Every file carries the Zolex heading, the filter context and a generated timestamp.
                </span>
              </div>
            </CardBody>
          </Card>

          {exports.isLoading ? <LoadingBlock /> : (exports.data ?? []).length === 0 ? (
            <Card><CardBody><EmptyState icon={<ShieldAlert />} title="No exports available"
              message="You do not currently hold export permission for any dataset." /></CardBody></Card>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(290px, 1fr))', gap: 'var(--sp-4)' }}>
              {(exports.data ?? []).map((d) => (
                <Card key={d.key}>
                  <CardBody>
                    <div className="row" style={{ gap: 10, marginBottom: 10 }}>
                      <span style={{ width: 36, height: 36, borderRadius: 'var(--radius-sm)', flexShrink: 0, background: 'var(--success-50)', color: 'var(--success-600)', display: 'grid', placeItems: 'center', border: '1px solid var(--success-100)' }}>
                        <FileSpreadsheet size={17} />
                      </span>
                      <div className="grow" style={{ minWidth: 0 }}>
                        <div className="cell-strong" style={{ fontSize: 'var(--text-md)' }}>{d.title}</div>
                        <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                          {d.columns.length} columns
                        </div>
                      </div>
                    </div>
                    <div className="truncate" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginBottom: 'var(--sp-3)' }}
                         title={d.columns.join(', ')}>
                      {d.columns.slice(0, 6).join(' · ')}{d.columns.length > 6 ? ' …' : ''}
                    </div>
                    <div className="row" style={{ gap: 6 }}>
                      <Button variant="primary" size="sm" icon={<Download size={13} />} block
                              onClick={() => void download(`/io/export/${d.key}?format=xlsx`, `${d.key}.xlsx`)}>
                        Excel
                      </Button>
                      <Button variant="secondary" size="sm" block
                              onClick={() => void download(`/io/export/${d.key}?format=csv`, `${d.key}.csv`)}>
                        CSV
                      </Button>
                    </div>
                  </CardBody>
                </Card>
              ))}
            </div>
          )}
        </>
      )}

      {/* ═══════════════════ IMPORT ═══════════════════ */}
      {tab === 'import' && (
        <>
          {importCatalogue.isLoading ? <LoadingBlock /> : (importCatalogue.data?.entities ?? []).length === 0 ? (
            <Card><CardBody><EmptyState icon={<ShieldAlert />} title="No imports available"
              message="You do not currently hold import permission for any master." /></CardBody></Card>
          ) : (
            <>
              <Card style={{ marginBottom: 'var(--sp-4)' }}>
                <CardBody style={{ padding: 'var(--sp-4)' }}>
                  <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                    <ShieldAlert size={15} style={{ color: 'var(--warning-600)', flexShrink: 0, marginTop: 1 }} />
                    <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>
                      {importCatalogue.data?.note}
                    </span>
                  </div>
                </CardBody>
              </Card>

              <Card style={{ marginBottom: 'var(--sp-4)' }}>
                <CardHeader title="1 · Choose what to import" />
                <CardBody>
                  <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                    {(importCatalogue.data?.entities ?? []).map((e) => (
                      <button
                        key={e.key}
                        onClick={() => { setEntity(e.key); setPreview(null); }}
                        className="row"
                        style={{
                          gap: 8, padding: '9px 14px', borderRadius: 'var(--radius-sm)',
                          border: `1px solid ${entity === e.key ? 'var(--brand-400)' : 'var(--border)'}`,
                          background: entity === e.key ? 'var(--brand-50)' : 'var(--bg-surface)',
                          color: entity === e.key ? 'var(--brand-700)' : 'var(--ink-600)',
                          fontSize: 'var(--text-sm)', fontWeight: entity === e.key ? 600 : 400,
                        }}
                      >
                        <FileSpreadsheet size={14} /> {e.title}
                      </button>
                    ))}
                  </div>

                  {activeEntity && (
                    <div style={{ marginTop: 'var(--sp-4)' }}>
                      <SectionTitle
                        action={
                          <Button variant="secondary" size="sm" icon={<FileDown size={13} />}
                                  onClick={() => void download(`/io/import/template/${activeEntity.key}`, `${activeEntity.key}-template.xlsx`)}>
                            Download template
                          </Button>
                        }
                      >
                        Expected columns
                      </SectionTitle>
                      <div className="row" style={{ gap: 5, flexWrap: 'wrap' }}>
                        {activeEntity.columns.map((c) => (
                          <span
                            key={c.header}
                            className="chip"
                            style={c.required
                              ? { background: 'var(--danger-50)', borderColor: 'var(--danger-100)', color: 'var(--danger-700)' }
                              : undefined}
                            title={
                              c.lookup
                                ? `Must match an existing ${c.lookup.replace(/_/g, ' ').toLowerCase()} value`
                                : c.numeric ? 'Numeric value' : c.required ? 'Required' : 'Optional'
                            }
                          >
                            {c.header}{c.required ? ' *' : ''}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                </CardBody>
              </Card>

              <Card style={{ marginBottom: 'var(--sp-4)' }}>
                <CardHeader title="2 · Upload and validate" subtitle="Nothing is written until you confirm the preview" />
                <CardBody>
                  <input
                    ref={fileInput}
                    type="file"
                    accept=".xlsx,.xls,.csv"
                    style={{ display: 'none' }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void onFileChosen(f); }}
                  />
                  <div
                    onClick={() => fileInput.current?.click()}
                    onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = 'var(--brand-400)'; e.currentTarget.style.background = 'var(--brand-50)'; }}
                    onDragLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-strong)'; e.currentTarget.style.background = 'var(--bg-inset)'; }}
                    onDrop={(e) => {
                      e.preventDefault();
                      e.currentTarget.style.borderColor = 'var(--border-strong)';
                      e.currentTarget.style.background = 'var(--bg-inset)';
                      const f = e.dataTransfer.files?.[0];
                      if (f) void onFileChosen(f);
                    }}
                    style={{
                      border: '2px dashed var(--border-strong)', borderRadius: 'var(--radius-md)',
                      background: 'var(--bg-inset)', padding: 'var(--sp-10)', textAlign: 'center',
                      cursor: 'pointer', transition: 'all var(--dur-fast) var(--ease)',
                    }}
                  >
                    {uploading ? (
                      <LoadingBlock label="Reading and validating…" height={100} />
                    ) : (
                      <>
                        <Upload size={30} style={{ color: 'var(--ink-400)', margin: '0 auto var(--sp-3)' }} />
                        <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--ink-700)' }}>
                          Drop your file here, or click to browse
                        </div>
                        <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginTop: 5 }}>
                          Excel (.xlsx) or CSV · first row must be the column headers · up to 20,000 rows
                        </div>
                      </>
                    )}
                  </div>
                </CardBody>
              </Card>

              {/* ── 3 · Preview ─────────────────────────────────────────── */}
              {preview && (
                <Card style={{ marginBottom: 'var(--sp-4)' }}>
                  <CardHeader
                    title="3 · Review before committing"
                    subtitle={`${preview.filename} · ${preview.title}`}
                    actions={
                      <>
                        {preview.invalidRows > 0 && (
                          <Button variant="secondary" size="sm" icon={<FileDown size={13} />}
                                  onClick={() => void download(`/io/import/${preview.jobId}/errors.csv`, `import-errors-${preview.jobId}.csv`)}>
                            Error report
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" icon={<RotateCcw size={13} />} onClick={() => setPreview(null)}>
                          Start over
                        </Button>
                      </>
                    }
                  />
                  <CardBody>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
                      <StatTile label="Rows in file" value={count(preview.totalRows)} />
                      <StatTile label="Valid" value={count(preview.validRows)} tone="success" />
                      <StatTile label="With errors" value={count(preview.invalidRows)} tone={preview.invalidRows > 0 ? 'danger' : 'default'} />
                      <StatTile label="Will create" value={count(preview.insertCount)} tone="info" />
                      <StatTile label="Will update" value={count(preview.updateCount)} tone="warning" />
                    </div>

                    {preview.invalidRows > 0 && (
                      <div
                        className="row"
                        style={{
                          gap: 10, padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-4)',
                          background: 'var(--warning-50)', border: '1px solid var(--warning-100)',
                          borderRadius: 'var(--radius-sm)', alignItems: 'flex-start',
                        }}
                      >
                        <AlertTriangle size={16} style={{ color: 'var(--warning-600)', flexShrink: 0, marginTop: 1 }} />
                        <div style={{ fontSize: 'var(--text-sm)', color: 'var(--warning-700)', lineHeight: 1.6 }}>
                          <strong>{preview.invalidRows} row(s) will not import.</strong> By default the whole
                          import is refused so your file and the database stay consistent. Tick partial
                          import below to commit only the {preview.validRows} valid rows.
                          <div style={{ marginTop: 'var(--sp-3)' }}>
                            <Checkbox
                              label={`Partial import — commit ${preview.validRows} valid row(s) and skip the rest`}
                              checked={partialMode}
                              onChange={setPartialMode}
                            />
                          </div>
                        </div>
                      </div>
                    )}

                    <div className="table-wrap" style={{ maxHeight: 400, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th style={{ width: 52 }}>Row</th>
                            <th style={{ width: 88 }}>Status</th>
                            <th style={{ width: 78 }}>Action</th>
                            {Object.keys(preview.preview[0]?.raw ?? {}).slice(0, 6).map((h) => <th key={h}>{h}</th>)}
                            <th>Problems</th>
                          </tr>
                        </thead>
                        <tbody>
                          {preview.preview.map((r) => (
                            <tr key={r.rowNumber} style={r.status === 'INVALID' ? { background: 'var(--danger-50)' } : undefined}>
                              <td className="num cell-muted">{r.rowNumber}</td>
                              <td>
                                {r.status === 'VALID'
                                  ? <Badge tone="success"><CheckCircle2 size={9} /> Valid</Badge>
                                  : <Badge tone="danger"><XCircle size={9} /> Invalid</Badge>}
                              </td>
                              <td>{r.action ? <Badge tone={r.action === 'INSERT' ? 'info' : 'warning'} plain>{r.action}</Badge> : '—'}</td>
                              {Object.keys(preview.preview[0]?.raw ?? {}).slice(0, 6).map((h) => (
                                <td key={h} className="truncate" style={{ maxWidth: 170 }}>{text(r.raw[h])}</td>
                              ))}
                              <td style={{ fontSize: 'var(--text-2xs)', color: 'var(--danger-700)' }}>
                                {r.errors.map((e, i) => (
                                  <div key={i}><strong>{e.field}:</strong> {e.message}</div>
                                ))}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {preview.totalRows > preview.preview.length && (
                      <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
                        Showing the first {preview.preview.length} of {count(preview.totalRows)} rows.
                        All rows are validated — the counts above cover the whole file.
                      </div>
                    )}
                  </CardBody>
                  <div className="card-footer row" style={{ gap: 'var(--sp-2)' }}>
                    <span className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                      Committing runs as a single transaction — it either applies completely or not at all.
                    </span>
                    <Button variant="ghost" onClick={() => setPreview(null)}>Cancel</Button>
                    <Button
                      variant="primary"
                      icon={<ArrowRight size={14} />}
                      disabled={preview.validRows === 0 || (preview.invalidRows > 0 && !partialMode)}
                      onClick={() => setConfirming(true)}
                    >
                      Commit {partialMode ? preview.validRows : preview.totalRows} row(s)
                    </Button>
                  </div>
                </Card>
              )}

              {/* ── Import history ──────────────────────────────────────── */}
              <Card>
                <CardHeader title="Import history" subtitle="Every import is recorded and audited" />
                <CardBody flush>
                  {jobs.isLoading ? <LoadingBlock height={140} /> : (jobs.data ?? []).length === 0 ? (
                    <div style={{ padding: 'var(--sp-6)', textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                      No imports have been run yet.
                    </div>
                  ) : (
                    <div className="table-wrap" style={{ maxHeight: 360 }}>
                      <table className="table table-compact">
                        <thead>
                          <tr>
                            <th>File</th><th>Target</th><th className="center">Status</th>
                            <th className="right">Rows</th><th className="right">Created</th><th className="right">Updated</th>
                            <th className="right">Skipped</th><th>By</th><th className="right">When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(jobs.data ?? []).map((j) => (
                            <tr key={j.id}>
                              <td className="truncate cell-strong" style={{ maxWidth: 220 }}>{text(j.filename)}</td>
                              <td className="cell-muted">{j.entity}</td>
                              <td className="center">
                                <Badge tone={j.status === 'COMMITTED' ? 'success' : j.status === 'PREVIEW' ? 'info' : j.status === 'FAILED' ? 'danger' : 'neutral'}>
                                  {j.status}
                                </Badge>
                              </td>
                              <td className="right num">{count(j.total_rows)}</td>
                              <td className="right num" style={{ color: 'var(--success-600)' }}>{count(j.inserted_rows)}</td>
                              <td className="right num" style={{ color: 'var(--warning-600)' }}>{count(j.updated_rows)}</td>
                              <td className="right num" style={{ color: j.invalid_rows > 0 ? 'var(--danger-600)' : undefined }}>{count(j.invalid_rows)}</td>
                              <td className="cell-muted truncate" style={{ maxWidth: 150 }}>{text(j.actor_name)}</td>
                              <td className="right cell-muted">{relativeTime(j.created_at)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </CardBody>
              </Card>
            </>
          )}
        </>
      )}

      <ConfirmDialog
        open={confirming}
        onClose={() => setConfirming(false)}
        onConfirm={() => commit.mutate()}
        title="Commit this import?"
        confirmLabel="Commit import"
        variant="primary"
        loading={commit.isPending}
        message={
          preview ? (
            <>
              <strong>{preview.insertCount}</strong> record(s) will be created and{' '}
              <strong>{preview.updateCount}</strong> updated in <strong>{preview.title}</strong>.
              {preview.invalidRows > 0 && partialMode && (
                <>
                  <br /><br />
                  {preview.invalidRows} invalid row(s) will be skipped.
                </>
              )}
              <br /><br />
              Existing records are matched on their business key and updated in place, so re-importing a
              corrected file will not create duplicates.
            </>
          ) : null
        }
      />
    </>
  );
}
