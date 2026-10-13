/**
 * Purchase Order — Indents Ready for PO ("Awaiting PO").
 *
 * Every approved-indent line that still has quantity eligible for a purchase
 * order — the exact same authoritative data the Create Purchase Order item list
 * uses (GET /indents/eligible-lines, backed by v_indent_line_balance) — shown
 * indent by indent, each with ONE obvious action: Create PO.
 *
 * That action opens Create Purchase Order with the indent's waiting items
 * already ticked; more indents, or only some items, can still be chosen there.
 * A line drops off this list the moment its remaining quantity is fully
 * consumed by a PO — the source indent itself stays visible in Purchase Indent
 * history either way.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ClipboardList, ShoppingCart, ExternalLink } from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import {
  Button, Card, LoadingBlock, EmptyState, ErrorState, Badge,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { HelpStrip } from '../../components/simple';
import { groupRows } from '../../lib/pickSelection';
import { qty, formatDate, text } from '../../lib/format';

interface EligibleLine {
  indent_line_id: number;
  indent_id: number;
  indent_no: string;
  indent_date: string;
  item_code: string;
  item_description: string;
  item_specification: string | null;
  uom_code: string | null;
  indent_qty: string;
  ordered_qty: string;
  pending_qty: string;
  department_name: string | null;
  cost_centre_name: string | null;
  indent_type_name: string | null;
  suggested_supplier_name: string | null;
  age_days: number;
}

export default function PoAwaitingIndent() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const query = qs({
    search: filters.search,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    indentTypeId: filters.indentTypeId,
    supplierId: filters.supplierId,
    itemId: filters.itemId,
    userId: filters.userId,
    hodId: filters.hodId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    page: filters.page ?? 1,
    pageSize: 100,
  });

  const list = useQuery({
    queryKey: ['indents-eligible-lines', query],
    queryFn: () => api.getWithMeta<EligibleLine[], PageMeta & {
      totals?: { totalLines: number; distinctIndents: number; totalPendingQty: number };
    }>(`/indents/eligible-lines${query}`),
    staleTime: 0,
  });

  const rows = list.data?.data ?? [];
  const groups = useMemo(() => groupRows(rows, (r) => r.indent_id), [rows]);
  const totalPendingQty = rows.reduce((s, r) => s + Number(r.pending_qty), 0);

  return (
    <>
      <PageHeader
        title="Indents Ready for PO"
        subtitle="Approved indent items that do not have a purchase order yet"
        breadcrumbs={[{ label: 'Purchase Order', to: '/purchase-orders' }, { label: 'Ready for PO' }]}
        actions={
          can('po.create') ? (
            <Button variant="primary" size="sm" icon={<ShoppingCart size={14} />} onClick={() => navigate('/purchase-orders/new')}>
              Create Purchase Order
            </Button>
          ) : undefined
        }
      />

      <HelpStrip>
        Press <strong>Create PO</strong> on an indent to order its items. To put <strong>many indents</strong>, or only
        <strong> some items</strong>, on one purchase order, use <strong>Create Purchase Order</strong> and tick what you need.
      </HelpStrip>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Items waiting for PO" value={String(list.data?.meta.totals?.totalLines ?? list.data?.meta.total ?? rows.length)} tone={rows.length > 0 ? 'warning' : undefined} />
        <StatTile label="Distinct Indents" value={String(list.data?.meta.totals?.distinctIndents ?? groups.length)} />
        <StatTile label="Waiting quantity" value={qty(list.data?.meta.totals?.totalPendingQty ?? totalPendingQty)} />
      </div>

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'indentType', 'item']}
      />

      <Card>
        {list.isLoading ? (
          <LoadingBlock height={260} label="Loading indents…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<ClipboardList />}
            title={activeCount > 0 ? 'Nothing matches' : 'No indent is waiting for a purchase order'}
            message={activeCount > 0
              ? 'Try a different indent number or item, or clear the filters.'
              : 'Every approved indent already has its purchase order. A new indent appears here once it is approved.'}
          />
        ) : (
          <div className="pick-wrap" style={{ maxHeight: 'none' }}>
            <table className="pick-table">
              <thead>
                <tr>
                  <th>Indent / Item</th>
                  <th>Department</th>
                  <th className="right">Asked</th>
                  <th className="right">Already ordered</th>
                  <th className="right">Waiting to order</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const head = g.rows[0]!;
                  return [
                    <tr key={`g${g.key}`} className="pick-group" style={{ cursor: 'default' }}>
                      <td colSpan={3}>
                        <span className="cell-code" style={{ fontSize: 'var(--text-md)' }}>{head.indent_no}</span>
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
                          {formatDate(head.indent_date)} · {head.age_days} day(s) ago
                          {head.indent_type_name ? ` · ${head.indent_type_name}` : ''}
                          {head.suggested_supplier_name ? ` · Supplier: ${head.suggested_supplier_name}` : ''}
                        </span>
                      </td>
                      <td colSpan={3} className="right">
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />}
                                  onClick={() => navigate(`/indents/${head.indent_id}`)}>
                            Open indent
                          </Button>
                          {can('po.create') && (
                            <Button variant="primary" icon={<ShoppingCart size={15} />}
                                    onClick={() => navigate(`/purchase-orders/new?indentId=${head.indent_id}`)}>
                              Create PO
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>,
                    ...g.rows.map((r) => (
                      <tr key={r.indent_line_id}>
                        <td style={{ paddingLeft: 26 }}>
                          <div className="cell-code">{r.item_code}</div>
                          <div style={{ fontWeight: 600 }}>{r.item_description}</div>
                          {r.item_specification && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.item_specification}</div>
                          )}
                        </td>
                        <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                          {[r.department_name, r.cost_centre_name].filter(Boolean).join(' · ') || '—'}
                        </td>
                        <td className="right num">{qty(r.indent_qty)} {text(r.uom_code)}</td>
                        <td className="right num" style={{ color: 'var(--text-muted)' }}>{qty(r.ordered_qty)}</td>
                        <td className="right num" style={{ fontWeight: 700, color: 'var(--warning-700)' }}>
                          {qty(r.pending_qty)} {text(r.uom_code)}
                        </td>
                        <td>
                          <Badge tone={Number(r.ordered_qty) > 0 ? 'progress' : 'neutral'} plain>
                            {Number(r.ordered_qty) > 0 ? 'Part ordered' : 'Not ordered yet'}
                          </Badge>
                        </td>
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
        {list.data?.meta && list.data.meta.totalPages > 1 && (
          <div className="row" style={{ justifyContent: 'space-between', padding: 'var(--sp-3) var(--sp-4)', borderTop: '1px solid var(--border)' }}>
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Page {list.data.meta.page} of {list.data.meta.totalPages} · {list.data.meta.total} item(s)
            </span>
            <div className="row" style={{ gap: 6 }}>
              <Button variant="secondary" size="sm" disabled={!list.data.meta.hasPrev} onClick={() => setFilters({ page: (filters.page ?? 1) - 1 }, { resetPage: false })}>Previous</Button>
              <Button variant="secondary" size="sm" disabled={!list.data.meta.hasNext} onClick={() => setFilters({ page: (filters.page ?? 1) + 1 }, { resetPage: false })}>Next</Button>
            </div>
          </div>
        )}
      </Card>
    </>
  );
}
