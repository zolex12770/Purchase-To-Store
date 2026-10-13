/**
 * GRN — Pending Receipt ("Material Pending to Receive").
 *
 * Every PO line still awaiting receipt — the exact same authoritative data the
 * item list inside Receive Material uses (GET /grn/po-items) — shown purchase
 * order by purchase order, each with ONE obvious action: Receive Material.
 *
 * That action opens Receive Material with the PO's pending items already
 * ticked. The supplier-consistency and quantity rules are enforced there and on
 * the server; this page only decides where the user starts.
 */
import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { PackageSearch, Truck, ExternalLink } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { PageHeader } from '../../layout/AppShell';
import { FilterBar } from '../../components/FilterBar';
import {
  Button, Card, LoadingBlock, EmptyState, ErrorState,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { HelpStrip, ReceiptBadge } from '../../components/simple';
import { groupRows } from '../../lib/pickSelection';
import { qty, money, formatDate, text, count } from '../../lib/format';

interface PendingLine {
  po_line_id: number;
  po_id: number;
  po_no: string;
  po_date: string;
  supplier_id: number;
  supplier_name: string;
  po_type_name: string | null;
  item_code: string;
  item_description: string;
  item_specification: string | null;
  uom_code: string | null;
  po_qty: string;
  received_qty: string;
  pending_grn_qty: string;
  amount: string;
  line_status: string;
  indent_no: string | null;
  age_days: number;
}

export default function GrnPending() {
  const navigate = useNavigate();
  const { can } = useAuth();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const query = qs({
    search: filters.search,
    supplierId: filters.supplierId,
    poTypeId: filters.poTypeId,
    departmentId: filters.departmentId,
    costCentreId: filters.costCentreId,
    itemId: filters.itemId,
    userId: filters.userId,
    hodId: filters.hodId,
    dateFrom: filters.dateFrom,
    dateTo: filters.dateTo,
    view: 'pending',
    limit: 500,
  });

  const list = useQuery({
    queryKey: ['grn-po-items-pending', query],
    queryFn: () => api.get<PendingLine[]>(`/grn/po-items${query}`),
    staleTime: 0,
  });

  const rows = list.data ?? [];
  const groups = useMemo(() => groupRows(rows, (r) => r.po_id), [rows]);
  const totalPendingQty = rows.reduce((s, r) => s + Number(r.pending_grn_qty), 0);
  const totalPendingValue = rows.reduce((s, r) => s + (Number(r.pending_grn_qty) * (Number(r.amount) / Number(r.po_qty || 1))), 0);
  const distinctSuppliers = new Set(rows.map((r) => r.supplier_id)).size;

  const receive = (poId: number) => navigate(`/grn/new?poId=${poId}`);

  return (
    <>
      <PageHeader
        title="Material Pending to Receive"
        subtitle="Purchase orders where material has not fully come yet"
        breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: 'Pending' }]}
        actions={
          can('grn.create') ? (
            <Button variant="primary" size="sm" icon={<Truck size={14} />} onClick={() => navigate('/grn/new')}>
              Receive Material
            </Button>
          ) : undefined
        }
      />

      <HelpStrip>
        When material comes, find its purchase order below and press <strong>Receive Material</strong>.
        Its pending items will be ready for you — you only enter the quantity that actually came.
      </HelpStrip>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile label="Purchase orders pending" value={String(groups.length)} tone={groups.length > 0 ? 'warning' : undefined} />
        <StatTile label="Items pending" value={String(rows.length)} />
        <StatTile label="Pending quantity" value={qty(totalPendingQty)} />
        <StatTile label="Pending value (est.)" value={money(totalPendingValue)} />
        <StatTile label="Suppliers" value={String(distinctSuppliers)} />
      </div>

      <FilterBar
        filters={filters} setFilters={setFilters} clearFilters={clearFilters} activeCount={activeCount}
        show={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'poType', 'item']}
      />

      <Card>
        {list.isLoading ? (
          <LoadingBlock height={260} label="Loading pending purchase orders…" />
        ) : list.error ? (
          <ErrorState error={list.error} onRetry={() => void list.refetch()} />
        ) : rows.length === 0 ? (
          <EmptyState
            icon={<PackageSearch />}
            title={activeCount > 0 ? 'Nothing matches' : 'Nothing is pending'}
            message={activeCount > 0
              ? 'Try a different PO number, supplier or item, or clear the filters.'
              : 'Every issued purchase order has been fully received.'}
          />
        ) : (
          <div className="pick-wrap" style={{ maxHeight: 'none' }}>
            <table className="pick-table">
              <thead>
                <tr>
                  <th>Purchase order / Item</th>
                  <th className="right">Ordered</th>
                  <th className="right">Already received</th>
                  <th className="right">Pending to receive</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {groups.map((g) => {
                  const head = g.rows[0]!;
                  return [
                    <tr key={`g${g.key}`} className="pick-group" style={{ cursor: 'default' }}>
                      <td colSpan={3}>
                        <span className="cell-code" style={{ fontSize: 'var(--text-md)' }}>{head.po_no}</span>
                        <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
                          {formatDate(head.po_date)} · {head.age_days} day(s) ago · {head.supplier_name}
                          {head.po_type_name ? ` · ${head.po_type_name}` : ''}
                        </span>
                      </td>
                      <td colSpan={2} className="right">
                        <div className="row" style={{ gap: 6, justifyContent: 'flex-end', flexWrap: 'wrap' }}>
                          <Button variant="ghost" size="sm" icon={<ExternalLink size={13} />}
                                  onClick={() => navigate(`/purchase-orders/${head.po_id}`)}>
                            Open PO
                          </Button>
                          {can('grn.create') && (
                            <Button variant="primary" icon={<Truck size={15} />} onClick={() => receive(head.po_id)}>
                              Receive Material
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>,
                    ...g.rows.map((r) => (
                      <tr key={r.po_line_id}>
                        <td style={{ paddingLeft: 26 }}>
                          <div className="cell-code">{r.item_code}</div>
                          <div style={{ fontWeight: 600 }}>{r.item_description}</div>
                          {r.item_specification && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.item_specification}</div>
                          )}
                          {r.indent_no && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Indent {r.indent_no}</div>
                          )}
                        </td>
                        <td className="right num">{qty(r.po_qty)} {text(r.uom_code)}</td>
                        <td className="right num" style={{ color: 'var(--text-muted)' }}>{qty(r.received_qty)}</td>
                        <td className="right num" style={{ fontWeight: 700, color: 'var(--warning-700)' }}>
                          {qty(r.pending_grn_qty)} {text(r.uom_code)}
                        </td>
                        <td><ReceiptBadge status={r.line_status} /></td>
                      </tr>
                    )),
                  ];
                })}
              </tbody>
            </table>
          </div>
        )}
        {rows.length >= 500 && (
          <div style={{ padding: 'var(--sp-3) var(--sp-4)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
            Showing the first {count(500)} pending items. Use the search box to find others.
          </div>
        )}
      </Card>
    </>
  );
}
