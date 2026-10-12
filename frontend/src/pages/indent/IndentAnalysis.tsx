/**
 * Purchase Indent — Analysis (SRS §10).
 * Configures the shared analysis engine for indent-side questions.
 */
import { ModuleAnalysis } from '../../components/ModuleAnalysis';

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
      dimensions={[
        { key: 'department', label: 'Department', param: 'departmentId' },
        { key: 'costCentre', label: 'Cost Centre', param: 'costCentreId' },
        { key: 'item', label: 'Item', param: 'itemId' },
        { key: 'mainGroup', label: 'Item Group', param: 'mainGroupId' },
        { key: 'itemType', label: 'Item Type', param: 'itemTypeId' },
        { key: 'user', label: 'Requested By / User', param: 'userId' },
        { key: 'hod', label: 'HOD', param: 'hodId' },
      ]}
      drilldownRoute="/indents"
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
