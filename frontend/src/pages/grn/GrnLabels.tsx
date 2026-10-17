/**
 * GRN — Labels (GRN reconstruction Part 3/4/5).
 *
 * Store-facing screen: finds MLNs already issued when a GRN was posted and
 * prints their physical labels. It never creates a new MLN — MLN generation
 * happens exactly once, server-side, at GRN post time (domain/stock.ts). This
 * screen only renders/prints/reprints the label for an MLN that already
 * exists, and records every print as an audit event via POST /grn/labels/print.
 */
import { useState } from 'react';
import { useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation } from '@tanstack/react-query';
import { Tag, Printer, Download, Eye, X, RotateCw } from 'lucide-react';
import { api, qs, downloadFile, fetchHtml, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, Field, Input, SearchSelect, Modal,
  LoadingBlock, EmptyState, ErrorState, Badge,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { useSupplierSearch } from '../../lib/masters';
import { qty, formatDate, formatDateTime, text } from '../../lib/format';

interface LabelRow {
  id: number;
  mln_no: string;
  sr_no: number;
  qty: string;
  batch_no: string | null;
  location: string | null;
  issued_at: string;
  print_count: number;
  last_printed_at: string | null;
  grn_id: number;
  grn_no: string;
  grn_date: string;
  grn_status: string;
  item_id: number;
  item_code: string;
  item_description: string;
  label_count: string | null;
  uom_code: string | null;
  supplier_name: string;
  po_no: string | null;
}

type StatusFilter = '' | 'PENDING' | 'PRINTED' | 'CANCELLED';

function labelStatus(r: LabelRow): { label: string; tone: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (r.grn_status === 'CANCELLED') return { label: 'Cancelled', tone: 'danger' };
  if (r.print_count > 0) return { label: 'Printed', tone: 'success' };
  return { label: 'Pending', tone: 'warning' };
}

export default function GrnLabels() {
  const toast = useToast();
  const { can } = useAuth();
  // Printing and the PDF need grn.print, and both record the print (the lot's
  // print count moves) through POST /grn/labels/print; previewing needs only
  // the view right.
  const canPrint = can('grn.print');
  const [searchParams, setSearchParams] = useSearchParams();

  const [search, setSearch] = useState('');
  const [mlnNo, setMlnNo] = useState('');
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');
  const [grnId, setGrnId] = useState<number | null>(() => {
    const v = searchParams.get('grnId');
    return v ? Number(v) : null;
  });
  const [page, setPage] = useState(1);
  const pageSize = 50;

  const [checked, setChecked] = useState<Set<number>>(new Set());

  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const previewFrameRef = useRef<HTMLIFrameElement>(null);
  const [downloading, setDownloading] = useState(false);

  const supplierResults = useSupplierSearch('');

  const resetSelection = () => setChecked(new Set());

  const clearGrnFilter = () => {
    setGrnId(null);
    setPage(1);
    resetSelection();
    if (searchParams.has('grnId')) {
      const next = new URLSearchParams(searchParams);
      next.delete('grnId');
      setSearchParams(next, { replace: true });
    }
  };

  const query = qs({
    search: search || undefined, mlnNo: mlnNo || undefined,
    grnId: grnId ?? undefined, supplierId: supplierId ?? undefined,
    dateFrom: dateFrom || undefined, dateTo: dateTo || undefined,
    status: status || undefined, page, pageSize,
  });

  const list = useQuery({
    queryKey: ['grn-labels', query],
    queryFn: () => api.getWithMeta<LabelRow[], PageMeta>(`/grn/labels${query}`),
  });

  const rows = list.data?.data ?? [];
  const meta = list.data?.meta;
  const allChecked = rows.length > 0 && rows.every((r) => checked.has(r.id));

  const toggleAll = () => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (allChecked) rows.forEach((r) => next.delete(r.id));
      else rows.forEach((r) => next.add(r.id));
      return next;
    });
  };
  const toggleOne = (id: number) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const selectedIds = [...checked];
  const selectedRows = rows.filter((r) => checked.has(r.id));
  const selectedAlreadyPrinted = selectedIds.length > 0 && selectedRows.every((r) => r.print_count > 0);
  const hasCancelledSelected = selectedRows.some((r) => r.grn_status === 'CANCELLED');
  const selectedPhysicalLabels = selectedRows.reduce(
    (n, r) => n + Math.max(1, Math.trunc(Number(r.label_count ?? 1)) || 1), 0,
  );

  const openPreview = async () => {
    if (selectedIds.length === 0) return;
    setPreviewOpen(true);
    setPreviewLoading(true);
    try {
      const html = await fetchHtml(`/grn/labels/print-view?ids=${selectedIds.join(',')}`);
      setPreviewHtml(html);
    } catch (err) {
      toast.fromError(err, 'Could not build the label preview');
      setPreviewOpen(false);
    } finally {
      setPreviewLoading(false);
    }
  };

  const registerPrint = useMutation({
    mutationFn: (ids: number[]) => api.post<{ printed: number }>('/grn/labels/print', { ids }),
    onSuccess: () => void list.refetch(),
    onError: (err) => toast.fromError(err, 'Could not record the print event'),
  });

  const printFromPreview = () => {
    const win = previewFrameRef.current?.contentWindow;
    if (!win || selectedIds.length === 0) return;
    registerPrint.mutate(selectedIds);
    win.focus();
    win.print();
  };

  const downloadPdf = async () => {
    if (selectedIds.length === 0) return;
    const ids = [...selectedIds];
    setDownloading(true);
    try {
      await downloadFile(`/grn/labels/pdf?ids=${ids.join(',')}`, `grn-labels-${Date.now()}.pdf`);
    } catch (err) {
      toast.fromError(err, 'Could not download the label PDF');
      setDownloading(false);
      return;
    }
    // The PDF itself no longer counts as a print (a GET must not change data):
    // the print is recorded here, once the file has arrived, like the browser print.
    try {
      await registerPrint.mutateAsync(ids);
    } catch {
      // registerPrint's own onError has told the user.
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <PageHeader
        title="GRN Labels"
        subtitle="Print or reprint the material lot label for material already received on a posted GRN"
        breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: 'Labels' }]}
      />

      {grnId != null && (
        <div className="row" style={{
          gap: 8, marginBottom: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)',
          background: 'var(--info-50)', border: '1px solid var(--info-100)',
          borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-sm)', color: 'var(--info-700)',
        }}>
          <Tag size={14} style={{ flexShrink: 0 }} />
          <span className="grow">Showing labels for GRN #{grnId} only.</span>
          <Button variant="ghost" size="sm" icon={<X size={13} />} onClick={clearGrnFilter}>Clear</Button>
        </div>
      )}

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <div className="form-grid">
            <Field label="Search">
              <Input value={search} placeholder="MLN, GRN no, item, supplier…"
                     onChange={(e) => { setSearch(e.target.value); setPage(1); resetSelection(); }} />
            </Field>
            <Field label="MLN No.">
              <Input value={mlnNo} placeholder="P000000050963"
                     onChange={(e) => { setMlnNo(e.target.value); setPage(1); resetSelection(); }} />
            </Field>
            <Field label="Supplier">
              <SearchSelect
                value={supplierId} onChange={(v) => { setSupplierId(v === null ? null : Number(v)); setPage(1); resetSelection(); }}
                options={(supplierResults.data ?? []).map((s) => ({ value: s.id, label: s.supplier_name }))}
                placeholder="Any supplier" emptyText="No suppliers found"
              />
            </Field>
            <Field label="Status">
              <SearchSelect
                value={status || null}
                onChange={(v) => { setStatus((v as StatusFilter) ?? ''); setPage(1); resetSelection(); }}
                options={[
                  { value: 'PENDING', label: 'Pending (not printed)' },
                  { value: 'PRINTED', label: 'Printed' },
                  { value: 'CANCELLED', label: 'Cancelled' },
                ]}
                placeholder="All"
              />
            </Field>
            <Field label="Date from">
              <Input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); resetSelection(); }} />
            </Field>
            <Field label="Date to">
              <Input type="date" value={dateTo} onChange={(e) => { setDateTo(e.target.value); setPage(1); resetSelection(); }} />
            </Field>
          </div>
        </CardBody>
      </Card>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Labels on this page" value={String(rows.length)} />
        <StatTile label="Total matching" value={String(meta?.total ?? 0)} />
        <StatTile label="Selected" value={String(selectedIds.length)} tone={selectedIds.length > 0 ? 'success' : undefined} />
      </div>

      <Card>
        <CardBody flush>
          <div className="row" style={{
            gap: 8, padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border)',
            flexWrap: 'wrap', alignItems: 'center',
          }}>
            <span className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {selectedIds.length > 0
                ? `${selectedIds.length} receipt line(s) selected · ${selectedPhysicalLabels} physical label(s) will print`
                : 'Select one or more received items to generate labels'}
            </span>
            {hasCancelledSelected && (
              <Badge tone="danger" plain>Selection includes a cancelled GRN — its label is void</Badge>
            )}
            <Button variant="secondary" size="sm" icon={<Eye size={13} />} disabled={selectedIds.length === 0} onClick={() => void openPreview()}>
              Generate / Preview
            </Button>
            {canPrint && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />} loading={downloading} disabled={selectedIds.length === 0} onClick={() => void downloadPdf()}>
                Download PDF
              </Button>
            )}
          </div>

          {list.isLoading ? (
            <LoadingBlock height={260} />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.refetch()} />
          ) : rows.length === 0 ? (
            <EmptyState
              icon={<Tag />}
              title="No labels found"
              message="Labels appear here automatically once a GRN is posted — nothing needs to be created manually."
            />
          ) : (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 36 }}>
                      <input type="checkbox" className="checkbox" checked={allChecked} onChange={toggleAll} title="Select all on this page" />
                    </th>
                    <th>MLN No.</th>
                    <th>Item</th>
                    <th>GRN No.</th>
                    <th>Supplier</th>
                    <th className="right">Qty</th>
                    <th className="right">Labels</th>
                    <th>Batch / Location</th>
                    <th>GRN Date</th>
                    <th>Status</th>
                    <th>Print history</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => {
                    const st = labelStatus(r);
                    const isChecked = checked.has(r.id);
                    return (
                      <tr key={r.id} className="clickable" onClick={() => toggleOne(r.id)}>
                        <td onClick={(e) => e.stopPropagation()}>
                          <input type="checkbox" className="checkbox" checked={isChecked} onChange={() => toggleOne(r.id)} />
                        </td>
                        <td><span className="cell-code">{r.mln_no}</span></td>
                        <td style={{ maxWidth: 240 }}>
                          <div className="cell-code">{r.item_code}</div>
                          <div className="cell-wrap cell-strong">{r.item_description}</div>
                        </td>
                        <td className="cell-muted">{r.grn_no}{r.po_no ? <div style={{ fontSize: 'var(--text-2xs)' }} className="cell-muted">{r.po_no}</div> : null}</td>
                        <td className="cell-wrap" style={{ minWidth: 130, maxWidth: 200 }}>{r.supplier_name}</td>
                        <td className="right num cell-strong">{qty(r.qty)} {text(r.uom_code)}</td>
                        <td className="right num cell-muted">{Math.max(1, Math.trunc(Number(r.label_count ?? 1)) || 1)}</td>
                        <td style={{ fontSize: 'var(--text-2xs)' }} className="cell-muted">
                          {[r.batch_no, r.location].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="cell-muted">{formatDate(r.grn_date)}</td>
                        <td><Badge tone={st.tone} plain>{st.label}</Badge></td>
                        <td style={{ fontSize: 'var(--text-2xs)' }} className="cell-muted">
                          {r.print_count > 0
                            ? <>Printed {r.print_count}× · last {r.last_printed_at ? formatDateTime(r.last_printed_at) : '—'}</>
                            : 'Never printed'}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {meta && meta.totalPages > 1 && (
            <div className="row" style={{ justifyContent: 'space-between', padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--border)' }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Page {meta.page} of {meta.totalPages} · {meta.total} label(s)
              </span>
              <div className="row" style={{ gap: 6 }}>
                <Button variant="ghost" size="sm" disabled={!meta.hasPrev} onClick={() => { setPage((p) => p - 1); resetSelection(); }}>Previous</Button>
                <Button variant="ghost" size="sm" disabled={!meta.hasNext} onClick={() => { setPage((p) => p + 1); resetSelection(); }}>Next</Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      <Modal
        open={previewOpen}
        onClose={() => { setPreviewOpen(false); setPreviewHtml(null); }}
        title={`Label preview — ${selectedPhysicalLabels} label(s) from ${selectedIds.length} receipt line(s)`}
        subtitle="Compact printable label sheet. Printing records who printed each label and when."
        size="xl"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setPreviewOpen(false); setPreviewHtml(null); }}>Close</Button>
            {canPrint && (
              <Button variant="primary" icon={selectedAlreadyPrinted ? <RotateCw size={14} /> : <Printer size={14} />}
                      disabled={!previewHtml} onClick={printFromPreview}>
                {selectedAlreadyPrinted ? 'Reprint' : 'Print'}
              </Button>
            )}
          </>
        }
      >
        {previewLoading ? (
          <LoadingBlock height={400} />
        ) : (
          <iframe
            ref={previewFrameRef}
            title="Label sheet preview"
            srcDoc={previewHtml ?? ''}
            style={{ width: '100%', height: '68vh', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: '#fff' }}
          />
        )}
      </Modal>
    </>
  );
}
