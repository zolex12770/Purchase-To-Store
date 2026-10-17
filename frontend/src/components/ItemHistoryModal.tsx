/**
 * Item history (Purchase Module pin-point, Point 2/3; spec §3.9).
 *
 * A quick look from Indent/PO/GRN — "when did this item last come in, on
 * which indent/PO/supplier, how much GRN, how much requisitioned/issued" —
 * without leaving the document being worked on: it opens as a side drawer.
 * Reuses `GET /items/:id` verbatim (the call the Item Master detail page
 * already makes) rather than inventing a second traceability model; only the
 * `historyLimit` query param and two extra sections (indentHistory,
 * grnHistory with line-level multi-PO attribution) were added there for this.
 */
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { History } from 'lucide-react';
import { api, qs } from '../lib/api';
import { Drawer, Select, LoadingBlock, ErrorState, EmptyState, StatusBadge } from './ui';
import { StatStrip } from './KpiCard';
import { qty, money, formatDate, text } from '../lib/format';

interface ItemHistoryData {
  id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  uom_code: string | null;
  live_stock_qty: string;
  summary: {
    total_ordered_qty: string; total_received_qty: string; pending_qty: string;
  };
  indentHistory: {
    indent_line_id: number; indent_id: number; indent_no: string; indent_date: string;
    indent_qty: string; ordered_qty: string; pending_qty: string; indent_status: string;
  }[];
  rateHistory: {
    po_id: number; po_no: string; po_date: string; supplier_name: string;
    po_qty: string; final_rate: string; received_qty: string; pending_grn_qty: string; po_status: string;
  }[];
  grnHistory: {
    grn_line_id: number; grn_id: number; grn_no: string; grn_date: string; grn_status: string;
    grn_qty: string; po_id: number; po_no: string; supplier_name: string;
  }[];
  requisitions: {
    requisition_line_id: number; requisition_id: number; requisition_no: string; requisition_date: string;
    requested_qty: string; issued_qty: string; pending_qty: string; hod_status: string; store_status: string;
  }[];
  issueHistory: {
    id: number; issue_slip_no: string; issue_date: string; requisition_id: number; requisition_no: string;
    issue_qty: string; store_user_name: string | null;
  }[];
}

const LIMIT_OPTIONS = [
  { value: 5, label: 'Latest 5' },
  { value: 10, label: 'Latest 10' },
  { value: 20, label: 'Latest 20' },
  { value: 50, label: 'Latest 50' },
  { value: 500, label: 'All' },
];

/** Pending quantities read amber; zero reads quiet, never coloured. */
const pendingStyle = (v: string | number) => ({ color: Number(v) > 0 ? 'var(--value-pending)' : 'var(--value-zero)' });

function Section({ title, count: n, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section style={{ marginBottom: 'var(--space-5)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <h3 style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--text-1)', letterSpacing: 0 }}>{title}</h3>
        <span className="cell-muted">{n} record{n === 1 ? '' : 's'}</span>
      </div>
      {n === 0 ? (
        <div className="cell-muted" style={{ padding: 'var(--space-2) 0' }}>None.</div>
      ) : (
        <div className="table-wrap" style={{ border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-md)' }}>
          <table className="table table-compact">{children}</table>
        </div>
      )}
    </section>
  );
}

export function ItemHistoryModal({ itemId, onClose }: { itemId: number | null; onClose: () => void }) {
  const [historyLimit, setHistoryLimit] = useState(10);

  const detail = useQuery({
    queryKey: ['item-history', itemId, historyLimit],
    queryFn: () => api.get<ItemHistoryData>(`/items/${itemId}${qs({ historyLimit })}`),
    enabled: itemId !== null,
  });

  const d = detail.data;

  return (
    <Drawer
      open={itemId !== null}
      onClose={onClose}
      wide
      title={
        <span className="row" style={{ gap: 8 }}>
          <History size={18} aria-hidden style={{ color: 'var(--text-3)' }} />
          {d ? `${d.item_code} — item history` : 'Item history'}
        </span>
      }
      subtitle={d ? d.item_description : undefined}
    >
      {detail.isLoading ? (
        <LoadingBlock label="Loading item history…" />
      ) : detail.error ? (
        <ErrorState error={detail.error} onRetry={() => void detail.refetch()} title="Could not load this item's history" />
      ) : !d ? null : (
        <>
          <StatStrip
            label="Item summary"
            items={[
              { label: 'Live stock', value: qty(d.live_stock_qty), tone: Number(d.live_stock_qty) < 0 ? 'danger' : 'default' },
              { label: 'Total PO qty', value: qty(d.summary.total_ordered_qty) },
              { label: 'Total GRN qty', value: qty(d.summary.total_received_qty) },
              { label: 'Pending GRN qty', value: qty(d.summary.pending_qty), tone: Number(d.summary.pending_qty) > 0 ? 'warning' : 'default' },
            ]}
          />

          <div className="row" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-4)', flexWrap: 'wrap', gap: 8 }}>
            <span className="cell-muted">
              Showing {LIMIT_OPTIONS.find((o) => o.value === historyLimit)?.label.toLowerCase() ?? `latest ${historyLimit}`} of each record type
            </span>
            <Select
              className="input-sm" style={{ width: 150 }}
              value={historyLimit}
              onChange={(e) => setHistoryLimit(Number(e.target.value))}
              aria-label="History range"
            >
              {LIMIT_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </Select>
          </div>

          <Section title="Indent history" count={d.indentHistory.length}>
            <thead><tr><th>Date</th><th>Indent no</th><th className="right">Qty</th><th className="right">Ordered</th><th className="right">Pending</th><th>Status</th></tr></thead>
            <tbody>
              {d.indentHistory.map((r) => (
                <tr key={r.indent_line_id}>
                  <td>{formatDate(r.indent_date)}</td>
                  <td className="cell-code">{r.indent_no}</td>
                  <td className="right num">{qty(r.indent_qty)}</td>
                  <td className="right num">{qty(r.ordered_qty)}</td>
                  <td className="right num" style={pendingStyle(r.pending_qty)}>{qty(r.pending_qty)}</td>
                  <td><StatusBadge status={r.indent_status} plain /></td>
                </tr>
              ))}
            </tbody>
          </Section>

          <Section title="Purchase order history" count={d.rateHistory.length}>
            <thead><tr><th>Date</th><th>PO no</th><th>Supplier</th><th className="right">PO qty</th><th className="right">Rate</th><th className="right">Received</th><th>Status</th></tr></thead>
            <tbody>
              {d.rateHistory.map((r) => (
                <tr key={r.po_id}>
                  <td>{formatDate(r.po_date)}</td>
                  <td className="cell-code">{r.po_no}</td>
                  <td className="cell-wrap" style={{ minWidth: 160, maxWidth: 240 }}>{r.supplier_name}</td>
                  <td className="right num">{qty(r.po_qty)}</td>
                  <td className="right num">{money(r.final_rate)}</td>
                  <td className="right num cell-strong">{qty(r.received_qty)}</td>
                  <td><StatusBadge status={r.po_status} plain /></td>
                </tr>
              ))}
            </tbody>
          </Section>

          <Section title="GRN history (line-level PO attribution)" count={d.grnHistory.length}>
            <thead><tr><th>Date</th><th>GRN no</th><th>PO no</th><th>Supplier</th><th className="right">GRN qty</th><th>Status</th></tr></thead>
            <tbody>
              {d.grnHistory.map((r) => (
                <tr key={r.grn_line_id}>
                  <td>{formatDate(r.grn_date)}</td>
                  <td className="cell-code">{r.grn_no}</td>
                  <td className="cell-code">{r.po_no}</td>
                  <td className="cell-wrap" style={{ minWidth: 160, maxWidth: 240 }}>{r.supplier_name}</td>
                  <td className="right num cell-strong">{qty(r.grn_qty)}</td>
                  <td><StatusBadge status={r.grn_status} plain /></td>
                </tr>
              ))}
            </tbody>
          </Section>

          <Section title="Requisition history" count={d.requisitions.length}>
            <thead><tr><th>Date</th><th>Requisition no</th><th className="right">Requested</th><th className="right">Issued</th><th className="right">Pending</th><th>HOD</th><th>Store</th></tr></thead>
            <tbody>
              {d.requisitions.map((r) => (
                <tr key={r.requisition_line_id}>
                  <td>{formatDate(r.requisition_date)}</td>
                  <td className="cell-code">{r.requisition_no}</td>
                  <td className="right num">{qty(r.requested_qty)}</td>
                  <td className="right num cell-strong">{qty(r.issued_qty)}</td>
                  <td className="right num" style={pendingStyle(r.pending_qty)}>{qty(r.pending_qty)}</td>
                  <td><StatusBadge status={r.hod_status} plain /></td>
                  <td><StatusBadge status={r.store_status} plain /></td>
                </tr>
              ))}
            </tbody>
          </Section>

          <Section title="Issue history" count={d.issueHistory.length}>
            <thead><tr><th>Date</th><th>Issue slip</th><th>Requisition no</th><th className="right">Issued qty</th><th>Issued by</th></tr></thead>
            <tbody>
              {d.issueHistory.map((r) => (
                <tr key={r.id}>
                  <td>{formatDate(r.issue_date)}</td>
                  <td className="cell-code">{r.issue_slip_no}</td>
                  <td className="cell-code">{r.requisition_no}</td>
                  <td className="right num cell-strong">{qty(r.issue_qty)}</td>
                  <td>{text(r.store_user_name)}</td>
                </tr>
              ))}
            </tbody>
          </Section>

          {d.indentHistory.length === 0 && d.rateHistory.length === 0 && d.grnHistory.length === 0
            && d.requisitions.length === 0 && d.issueHistory.length === 0 && (
            <EmptyState title="No transactional history yet" message="This item has not appeared on any indent, PO, GRN or requisition." />
          )}
        </>
      )}
    </Drawer>
  );
}
