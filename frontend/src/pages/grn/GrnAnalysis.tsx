/**
 * GRN — Analysis (SRS §12).
 */
import { ModuleAnalysis } from '../../components/ModuleAnalysis';
import { money, qty, count } from '../../lib/format';

export default function GrnAnalysis() {
  return (
    <ModuleAnalysis
      title="GRN Analysis"
      subtitle="Receipt throughput, supplier fulfilment and quantities still to be delivered"
      breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: 'Analysis' }]}
      metricKeys={[
        'grn_count',
        'grn_value_total',
        'grn_qty_total',
        'grn_pending_qty',
        'grn_fulfilment_rate',
        'po_overdue_count',
      ]}
      trendSeries={[
        { key: 'grnValue', name: 'Received value', type: 'bar', color: '#1f9d5f' },
        { key: 'grnCount', name: 'Receipts', type: 'line', color: '#1a4d80' },
      ]}
      trendValueKind="currency"
      dimensions={[
        { key: 'supplier', label: 'Supplier', param: 'supplierId' },
        { key: 'item', label: 'Item', param: 'itemId' },
        { key: 'mainGroup', label: 'Item Group', param: 'mainGroupId' },
        { key: 'department', label: 'Department', param: 'departmentId' },
        { key: 'costCentre', label: 'Cost Centre', param: 'costCentreId' },
        { key: 'user', label: 'Received By / User', param: 'userId' },
        { key: 'hod', label: 'HOD', param: 'hodId' },
      ]}
      // The trend counts posted receipts, direct ones included: the list a period opens.
      drilldownRoute="/grn?status=POSTED"
      // Posted receipt lines, direct ones included (/analytics/grn-breakdown): the PO
      // breakdown it drew left out 2,716 of the 2,718 GRNs.
      breakdown={{
        path: '/analytics/grn-breakdown',
        documents: 'Goods receipts',
        columns: [
          { header: 'GRNs', cell: (r) => count(r.documentCount ?? 0), total: 'documents' },
          { header: 'Lines', cell: (r) => count(r.lineCount) },
          { header: 'Received qty', cell: (r) => qty(r.totalQty), total: 'qty' },
          { header: 'Received value', cell: (r) => <span className="cell-strong">{money(r.totalValue)}</span>, total: 'value' },
        ],
      }}
      filterKeys={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'mainGroup', 'item']}
      ageingBasis="po"
      ageingTitle="Ordered value awaiting goods receipt"
      exportDataset="grn"
    />
  );
}
