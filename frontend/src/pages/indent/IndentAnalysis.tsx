/**
 * Purchase Indent — Analysis (SRS §10).
 * Configures the shared analysis engine for indent-side questions.
 */
import { ModuleAnalysis } from '../../components/ModuleAnalysis';
import { money, qty, count } from '../../lib/format';

export default function IndentAnalysis() {
  return (
    <ModuleAnalysis
      title="Purchase Indent Analysis"
      subtitle="Demand raised, approval throughput and the order book still awaiting purchase orders"
      breadcrumbs={[{ label: 'Purchase Indent', to: '/indents' }, { label: 'Analysis' }]}
      metricKeys={[
        'indent_count',
        'indent_pending_approval',
        'indent_pending_value',
        'indent_approved_open_qty',
        'indent_avg_approval_days',
        'indent_rejection_rate',
      ]}
      trendSeries={[
        { key: 'indentCount', name: 'Indents raised', type: 'bar', color: '#1a4d80' },
        { key: 'approvedCount', name: 'Approved', type: 'line', color: '#1f9d5f' },
        { key: 'rejectedCount', name: 'Rejected', type: 'line', color: '#db3434' },
        { key: 'pendingCount', name: 'Awaiting approval', type: 'line', color: '#e0940f' },
      ]}
      trendValueKind="count"
      // Filters the indent list applies, as it applies them: the department and cost
      // centre are the indent's own. Item group and item type, which the list cannot
      // filter, are left out: their bars opened every indent.
      dimensions={[
        { key: 'department', label: 'Department', param: 'departmentId' },
        { key: 'costCentre', label: 'Cost Centre', param: 'costCentreId' },
        { key: 'item', label: 'Item', param: 'itemId' },
        { key: 'indentType', label: 'Indent Type', param: 'indentTypeId' },
        { key: 'status', label: 'Status', param: 'status' },
        { key: 'supplier', label: 'Suggested Supplier', param: 'supplierId' },
        { key: 'user', label: 'Requested By / User', param: 'userId' },
        { key: 'hod', label: 'HOD', param: 'hodId' },
      ]}
      // The trend leaves cancelled indents out, and so does the list a period opens.
      drilldownRoute="/indents?excludeCancelled=true"
      // The indents' own lines (/analytics/indent-breakdown): it drew purchase order lines.
      breakdown={{
        path: '/analytics/indent-breakdown',
        documents: 'Indents',
        columns: [
          { header: 'Indents', cell: (r) => count(r.documentCount ?? 0), total: 'documents' },
          { header: 'Indent qty', cell: (r) => qty(r.totalQty), total: 'qty' },
          { header: 'Estimated value', cell: (r) => <span className="cell-strong">{money(r.totalValue)}</span>, total: 'value' },
          { header: 'Ordered qty', cell: (r) => qty(r.orderedQty ?? 0) },
          {
            header: 'Not yet ordered',
            cell: (r) => <span style={{ color: Number(r.pendingQty) > 0 ? 'var(--warning-600)' : 'var(--text-faint)' }}>{qty(r.pendingQty ?? 0)}</span>,
          },
        ],
      }}
      filterKeys={['dateRange', 'user', 'hod', 'department', 'costCentre', 'indentType', 'supplier', 'status', 'item']}
      statusOptions={[
        { value: 'DRAFT', label: 'Draft' },
        { value: 'PENDING_APPROVAL', label: 'Pending Approval' },
        { value: 'APPROVED', label: 'Approved' },
        { value: 'REJECTED', label: 'Rejected' },
        { value: 'CLOSED', label: 'Closed' },
      ]}
      ageingBasis="indent"
      ageingTitle="Approved demand awaiting a purchase order"
      exportDataset="indents"
    />
  );
}
