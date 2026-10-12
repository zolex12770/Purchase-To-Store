/**
 * GRN — Analysis (SRS §12).
 */
import { ModuleAnalysis } from '../../components/ModuleAnalysis';

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
      drilldownRoute="/grn"
      filterKeys={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'mainGroup', 'item']}
      ageingBasis="po"
      ageingTitle="Ordered value awaiting goods receipt"
      exportDataset="grn"
    />
  );
}
