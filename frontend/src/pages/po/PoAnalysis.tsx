/**
 * Purchase Order — Analysis (SRS §11).
 */
import { ModuleAnalysis } from '../../components/ModuleAnalysis';

export default function PoAnalysis() {
  return (
    <ModuleAnalysis
      title="Purchase Order Analysis"
      subtitle="Committed value, supplier concentration, discount performance and outstanding exposure"
      breadcrumbs={[{ label: 'Purchase Order', to: '/purchase-orders' }, { label: 'Analysis' }]}
      metricKeys={[
        'po_value_total',
        'po_count',
        'po_pending_value',
        'po_avg_value',
        'avg_discount_pct',
        'discount_savings',
      ]}
      trendSeries={[
        { key: 'poValue', name: 'PO value', type: 'bar', color: '#1a4d80' },
        { key: 'receivedValue', name: 'Received value', type: 'area', color: '#1f9d5f' },
        { key: 'pendingValue', name: 'Pending value', type: 'line', color: '#d97a28' },
      ]}
      trendValueKind="currency"
      dimensions={[
        { key: 'supplier', label: 'Supplier', param: 'supplierId' },
        { key: 'item', label: 'Item', param: 'itemId' },
        { key: 'poType', label: 'PO Type', param: 'poTypeId' },
        { key: 'department', label: 'Department', param: 'departmentId' },
        { key: 'costCentre', label: 'Cost Centre', param: 'costCentreId' },
        { key: 'mainGroup', label: 'Item Group', param: 'mainGroupId' },
        { key: 'status', label: 'Status', param: 'status' },
        { key: 'user', label: 'Created By / User', param: 'userId' },
        { key: 'hod', label: 'HOD', param: 'hodId' },
      ]}
      drilldownRoute="/purchase-orders"
      filterKeys={['dateRange', 'user', 'hod', 'department', 'costCentre', 'supplier', 'poType', 'mainGroup', 'status', 'item']}
      statusOptions={[
        { value: 'DRAFT', label: 'Draft' },
        { value: 'OPEN', label: 'Open' },
        { value: 'PARTIALLY_RECEIVED', label: 'Partially Received' },
        { value: 'COMPLETED', label: 'Completed' },
        { value: 'SHORT_CLOSED', label: 'Short Closed' },
        { value: 'CANCELLED', label: 'Cancelled' },
      ]}
      ageingBasis="po"
      ageingTitle="Ordered value awaiting goods receipt"
      exportDataset="purchase-orders"
    />
  );
}
