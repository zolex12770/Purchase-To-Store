/**
 * Stock Reconciliation Report (Purchase Module tab 4 support screen).
 *
 * Opening + GRN Inward − Requisition Outward = Current Stock, computed purely
 * from stock_ledger — the SAME authoritative ledger GRN inward and Requisition
 * issue already post to (items.live_stock_qty). This screen never silently
 * corrects a mismatch; it only ever exposes one, in red, for someone to
 * investigate.
 */
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { TriangleAlert, CheckCircle2 } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { PageHeader } from '../../layout/AppShell';
import { Card, CardBody, Input, Checkbox, Badge, LoadingBlock, ErrorState, EmptyState } from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { qty } from '../../lib/format';

interface ReconciliationRow {
  id: number;
  item_code: string;
  item_description: string;
  uom_code: string | null;
  grn_inward: string;
  grn_reversal: string;
  requisition_issue: string;
  requisition_reversal: string;
  /** Net of the one-time opening alignment rows (reference type OPENING_ALIGNMENT). */
  alignment_net: string;
  computed_balance: string;
  current_stock: string;
  mismatch: boolean;
}

interface ReconciliationMeta {
  total: number;
  mismatchCount: number;
  /** The report covers inactive items too; the split says where the mismatches are. */
  activeMismatchCount: number;
  inactiveMismatchCount: number;
}

export default function StockReconciliation() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState(searchParams.get('search') ?? '');
  const [mismatchOnly, setMismatchOnly] = useState(false);
  const [page, setPage] = useState(1);

  const query = qs({ search: search || undefined, mismatchOnly: mismatchOnly || undefined, page, pageSize: 50 });

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['items', 'stock-reconciliation', query],
    queryFn: () => api.getWithMeta<ReconciliationRow[], ReconciliationMeta>(`/items/analysis/stock-reconciliation${query}`),
  });
  const meta = data?.meta;

  return (
    <>
      <PageHeader
        title="Stock Reconciliation"
        subtitle="Opening + GRN Inward − Requisition Outward = Current Stock — reconciled straight from the stock ledger, never silently corrected"
        breadcrumbs={[{ label: 'Master', to: '/masters/items' }, { label: 'Stock Reconciliation' }]}
      />

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Items reconciled" value={String(meta?.total ?? 0)} />
        <StatTile
          label="Mismatches"
          value={String(meta?.mismatchCount ?? 0)}
          sub={meta ? `${meta.activeMismatchCount} active · ${meta.inactiveMismatchCount} inactive` : undefined}
          tone={(meta?.mismatchCount ?? 0) > 0 ? 'danger' : 'success'}
          onClick={() => setMismatchOnly(true)}
        />
      </div>

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody>
          <div className="row" style={{ gap: 'var(--sp-3)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search item code or name…"
              style={{ maxWidth: 320 }}
            />
            <Checkbox checked={mismatchOnly} onChange={(v) => { setMismatchOnly(v); setPage(1); }} label="Show mismatches only" />
          </div>
        </CardBody>
      </Card>

      <Card>
        <CardBody flush>
          {isLoading ? (
            <LoadingBlock height={300} />
          ) : error ? (
            <ErrorState error={error} onRetry={() => void refetch()} />
          ) : (data?.data ?? []).length === 0 ? (
            <EmptyState
              icon={mismatchOnly ? <CheckCircle2 /> : undefined}
              title={mismatchOnly ? 'No mismatches found' : 'No items found'}
              message={mismatchOnly ? 'Every item\'s stock ledger reconciles exactly with its current balance.' : 'Try a different search term.'}
            />
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th>Item Code</th>
                    <th>Item Name</th>
                    <th className="center">UOM</th>
                    <th className="right">GRN Inward</th>
                    <th className="right">GRN Reversal</th>
                    <th className="right">Requisition Issue</th>
                    <th className="right">Requisition Reversal</th>
                    <th className="right" title="One-time opening alignment from sheet evidence (2026-10)">Opening Alignment</th>
                    <th className="right">Computed Balance</th>
                    <th className="right">Current Stock</th>
                    <th className="center">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data!.data.map((r) => (
                    <tr key={r.id} style={r.mismatch ? { background: 'var(--danger-50)' } : undefined}>
                      <td className="cell-code">{r.item_code}</td>
                      <td className="truncate" style={{ maxWidth: 260 }}>{r.item_description}</td>
                      <td className="center"><Badge tone="neutral" plain>{r.uom_code ?? '—'}</Badge></td>
                      <td className="right num" style={{ color: 'var(--success-600)' }}>{qty(r.grn_inward)}</td>
                      <td className="right num cell-muted">{qty(r.grn_reversal)}</td>
                      <td className="right num" style={{ color: 'var(--danger-600)' }}>{qty(r.requisition_issue)}</td>
                      <td className="right num cell-muted">{qty(r.requisition_reversal)}</td>
                      <td className="right num cell-muted">{qty(r.alignment_net)}</td>
                      <td className="right num cell-strong">{qty(r.computed_balance)}</td>
                      <td className="right num cell-strong">{qty(r.current_stock)}</td>
                      <td className="center">
                        {r.mismatch ? (
                          <span className="row" style={{ gap: 4, color: 'var(--danger-600)', justifyContent: 'center' }}>
                            <TriangleAlert size={13} /> Mismatch
                          </span>
                        ) : (
                          <span className="row" style={{ gap: 4, color: 'var(--success-600)', justifyContent: 'center' }}>
                            <CheckCircle2 size={13} /> OK
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {data && data.meta.total > 50 && (
        <div className="row" style={{ justifyContent: 'center', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)' }}>
          <button className="btn btn-secondary btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>Previous</button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>Page {page} of {Math.ceil(data.meta.total / 50)}</span>
          <button className="btn btn-secondary btn-sm" disabled={page >= Math.ceil(data.meta.total / 50)} onClick={() => setPage((p) => p + 1)}>Next</button>
        </div>
      )}
    </>
  );
}
