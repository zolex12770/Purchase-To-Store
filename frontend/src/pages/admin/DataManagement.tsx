/**
 * Admin Data Management & Audit Control (SRS §17, §18, §20, §24).
 *
 * Dedicated administration console for Super Admins and authorized Administrators:
 * - Search & inspect Master Data and Transaction Documents.
 * - Deep dependency inspection across tables before any deletion.
 * - Single & Bulk Deactivation / Reactivation (is_active).
 * - Single & Bulk Soft-Delete & Restore (deleted_at).
 * - Safe Hard-Delete (Permanent Purge) strictly guarded by zero blocking dependencies.
 * - Guaranteed protection for system super admins (10221, 10422).
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Database, Users, Building2, Package, Tags, FileText, ShoppingCart, Truck,
  PackageCheck, PackageMinus, Search, Eye, Power, Trash2, RotateCcw,
  CheckCircle2, XCircle, ShieldAlert, ArrowLeftRight
} from 'lucide-react';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { LinkStoreGrnsPanel } from './LinkStoreGrnsPanel';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Input, Select, Badge, LoadingBlock,
  EmptyState, Drawer, Modal, Field
} from '../../components/ui';
import { formatDate } from '../../lib/format';

type EntityKey =
  | 'users'
  | 'suppliers'
  | 'items'
  | 'lookups'
  | 'indents'
  | 'purchase_orders'
  | 'grn'
  | 'requisitions'
  | 'direct_issues';

interface SummaryData {
  masters: {
    users: { total: number; active: number; inactive: number; deleted: number };
    suppliers: { total: number; active: number; inactive: number; deleted: number };
    items: { total: number; active: number; inactive: number; deleted: number };
    lookups: { total: number; active: number; inactive: number; deleted: number };
  };
  transactions: {
    indents: { total: number; draft: number; open: number; closed: number; cancelled: number };
    purchaseOrders: { total: number; draft: number; open: number; closed: number; cancelled: number };
    grn: { total: number; completed: number; cancelled: number };
    requisitions: { total: number; draft: number; pending: number; issued: number; cancelled: number };
    directIssues: { total: number };
  };
}

interface RecordItem {
  id: number;
  code: string;
  title: string;
  subtitle: string;
  extraInfo: string;
  status: string;
  isActive: boolean;
  deletedAt: string | null;
  createdAt: string;
  isProtected: boolean;
}

interface InspectData {
  entity: string;
  id: number;
  record: Record<string, unknown>;
  dependencies: Array<{ table: string; label: string; count: number }>;
  canHardDelete: boolean;
  blockingReasons: string[];
  auditLogs: Array<{
    id: number;
    action: string;
    actor_name: string;
    actor_employee_id: string;
    message: string;
    created_at: string;
  }>;
}

const ENTITY_CONFIG: Record<EntityKey, { label: string; icon: typeof Database; isMaster: boolean }> = {
  users: { label: 'Employees & Users', icon: Users, isMaster: true },
  suppliers: { label: 'Suppliers', icon: Building2, isMaster: true },
  items: { label: 'Item Master', icon: Package, isMaster: true },
  lookups: { label: 'Lookups & Depts', icon: Tags, isMaster: true },
  indents: { label: 'Purchase Indents', icon: FileText, isMaster: false },
  purchase_orders: { label: 'Purchase Orders', icon: ShoppingCart, isMaster: false },
  grn: { label: 'GRNs', icon: Truck, isMaster: false },
  requisitions: { label: 'Requisitions', icon: PackageCheck, isMaster: false },
  direct_issues: { label: 'Direct Issues', icon: PackageMinus, isMaster: false },
};

export default function DataManagement() {
  const toast = useToast();
  const qc = useQueryClient();
  const { isSuperAdmin } = useAuth();

  const [activeEntity, setActiveEntity] = useState<EntityKey>('users');
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'inactive' | 'deleted'>('all');
  const [page, setPage] = useState(1);
  const pageSize = 25;

  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [inspectTarget, setInspectTarget] = useState<{ entity: EntityKey; id: number } | null>(null);
  const [hardDeleteTarget, setHardDeleteTarget] = useState<RecordItem | null>(null);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  // 1. Summary Query
  const summary = useQuery<SummaryData>({
    queryKey: ['admin', 'data-management', 'summary'],
    queryFn: () => api.get<SummaryData>('/admin/data-management/summary'),
  });

  // 2. Records Query
  const records = useQuery<{ items: RecordItem[]; total: number; totalPages: number }>({
    queryKey: ['admin', 'data-management', 'records', activeEntity, searchTerm, statusFilter, page],
    queryFn: () =>
      api.get<{ items: RecordItem[]; total: number; totalPages: number }>(
        `/admin/data-management/records?entity=${activeEntity}&search=${encodeURIComponent(searchTerm)}&status=${statusFilter}&page=${page}&pageSize=${pageSize}`,
      ),
  });

  // 3. Inspect Query
  const inspect = useQuery<InspectData>({
    queryKey: ['admin', 'data-management', 'inspect', inspectTarget?.entity, inspectTarget?.id],
    queryFn: () =>
      api.get<InspectData>(`/admin/data-management/inspect/${inspectTarget!.entity}/${inspectTarget!.id}`),
    enabled: Boolean(inspectTarget),
  });

  // Bulk Actions Mutations
  const toggleActive = useMutation({
    mutationFn: ({ ids, isActive }: { ids: number[]; isActive: boolean }) =>
      api.post<{ message?: string }>('/admin/data-management/bulk-toggle-active', { entity: activeEntity, ids, isActive }),
    onSuccess: (data) => {
      toast.success(data?.message || 'Status updated successfully');
      setSelectedIds([]);
      void qc.invalidateQueries({ queryKey: ['admin', 'data-management'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const softDelete = useMutation({
    mutationFn: ({ ids, restore }: { ids: number[]; restore?: boolean }) =>
      api.post<{ message?: string }>('/admin/data-management/bulk-soft-delete', { entity: activeEntity, ids, restore }),
    onSuccess: (data) => {
      toast.success(data?.message || 'Updated successfully');
      setSelectedIds([]);
      void qc.invalidateQueries({ queryKey: ['admin', 'data-management'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const hardDelete = useMutation({
    mutationFn: ({ id, confirm }: { id: number; confirm: string }) =>
      api.post<{ message?: string }>('/admin/data-management/hard-delete', { entity: activeEntity, id, confirm }),
    onSuccess: (data) => {
      toast.success(data?.message || 'Permanently deleted');
      setHardDeleteTarget(null);
      setDeleteConfirmText('');
      void qc.invalidateQueries({ queryKey: ['admin', 'data-management'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const allIds = useMemo(() => (records.data?.items ?? []).map((i) => i.id), [records.data?.items]);
  const isAllSelected = allIds.length > 0 && allIds.every((id) => selectedIds.includes(id));

  const toggleSelectAll = () => {
    if (isAllSelected) {
      setSelectedIds([]);
    } else {
      setSelectedIds(allIds);
    }
  };

  const toggleSelectOne = (id: number) => {
    setSelectedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };

  const activeConf = ENTITY_CONFIG[activeEntity];

  return (
    <>
      <PageHeader
        title="Admin Data Management & Audit"
        subtitle="Audit, inspect, deactivate, soft-delete, restore, or permanently purge master profiles and documents with zero-silent-mismatch safeguards"
        breadcrumbs={[{ label: 'Admin', to: '/admin/settings' }, { label: 'Data Management' }]}
        actions={
          <Button
            variant="secondary"
            size="sm"
            icon={<ArrowLeftRight size={14} />}
            onClick={() => void qc.invalidateQueries({ queryKey: ['admin', 'data-management'] })}
          >
            Refresh Records
          </Button>
        }
      />

      {/* KPI Tiles / Summary Bar */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 'var(--sp-3)',
          marginBottom: 'var(--sp-4)',
        }}
      >
        <Card style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <Users size={18} style={{ color: 'var(--brand-600)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Employees / Users</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                {summary.data?.masters.users.total.toLocaleString() ?? '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                {summary.data?.masters.users.active} active · {summary.data?.masters.users.inactive} inactive
              </div>
            </div>
          </div>
        </Card>

        <Card style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <Building2 size={18} style={{ color: 'var(--brand-600)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Suppliers</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                {summary.data?.masters.suppliers.total.toLocaleString() ?? '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                {summary.data?.masters.suppliers.active} active
              </div>
            </div>
          </div>
        </Card>

        <Card style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <Package size={18} style={{ color: 'var(--brand-600)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Item Master</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                {summary.data?.masters.items.total.toLocaleString() ?? '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                {summary.data?.masters.items.active} active
              </div>
            </div>
          </div>
        </Card>

        <Card style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <Truck size={18} style={{ color: 'var(--brand-600)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>GRN Documents</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                {summary.data?.transactions.grn.total.toLocaleString() ?? '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                {summary.data?.transactions.grn.completed} completed
              </div>
            </div>
          </div>
        </Card>

        <Card style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
            <PackageCheck size={18} style={{ color: 'var(--brand-600)' }} />
            <div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>Requisitions</div>
              <div style={{ fontSize: 'var(--text-lg)', fontWeight: 700 }}>
                {summary.data?.transactions.requisitions.total.toLocaleString() ?? '—'}
              </div>
              <div style={{ fontSize: '11px', color: 'var(--text-faint)' }}>
                {summary.data?.transactions.requisitions.issued} issued · {summary.data?.transactions.requisitions.pending} pending
              </div>
            </div>
          </div>
        </Card>
      </div>

      {/* Entity Navigation Tabs */}
      <div className="card" style={{ marginBottom: 'var(--sp-4)', padding: 'var(--sp-2)' }}>
        <div
          className="row"
          style={{
            gap: 'var(--sp-1)',
            overflowX: 'auto',
            scrollbarWidth: 'thin',
            paddingBottom: '2px',
          }}
        >
          {(Object.keys(ENTITY_CONFIG) as EntityKey[]).map((key) => {
            const conf = ENTITY_CONFIG[key];
            const Icon = conf.icon;
            const isSelected = activeEntity === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setActiveEntity(key);
                  setPage(1);
                  setSelectedIds([]);
                  setSearchTerm('');
                }}
                className={`btn btn-sm ${isSelected ? 'btn-primary' : 'btn-ghost'}`}
                style={{ whiteSpace: 'nowrap', gap: 6 }}
              >
                <Icon size={14} />
                {conf.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Search, Filter & Bulk Actions Bar */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
          <div
            className="row"
            style={{
              justifyContent: 'space-between',
              alignItems: 'center',
              flexWrap: 'wrap',
              gap: 'var(--sp-3)',
            }}
          >
            {/* Search Input & Status Filter */}
            <div className="row" style={{ gap: 'var(--sp-2)', flex: 1, minWidth: 280 }}>
              <div style={{ position: 'relative', flex: 1, maxWidth: 360 }}>
                <Search
                  size={14}
                  style={{
                    position: 'absolute',
                    left: 10,
                    top: '50%',
                    transform: 'translateY(-50%)',
                    color: 'var(--text-muted)',
                  }}
                />
                <Input
                  value={searchTerm}
                  onChange={(e) => {
                    setSearchTerm(e.target.value);
                    setPage(1);
                  }}
                  placeholder={`Search ${activeConf.label}…`}
                  style={{ paddingLeft: 30 }}
                />
              </div>

              {activeConf.isMaster && (
                <div style={{ width: 140 }}>
                  <Select
                    value={statusFilter}
                    onChange={(e) => {
                      setStatusFilter(e.target.value as any);
                      setPage(1);
                    }}
                    options={[
                      { value: 'all', label: 'All Statuses' },
                      { value: 'active', label: 'Active Only' },
                      { value: 'inactive', label: 'Inactive Only' },
                      { value: 'deleted', label: 'Soft-Deleted' },
                    ]}
                  />
                </div>
              )}
            </div>

            {/* Bulk Action Controls */}
            {selectedIds.length > 0 && activeConf.isMaster && (
              <div className="row" style={{ gap: 'var(--sp-2)', alignItems: 'center' }}>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  {selectedIds.length} selected:
                </span>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Power size={13} />}
                  loading={toggleActive.isPending}
                  onClick={() => toggleActive.mutate({ ids: selectedIds, isActive: false })}
                >
                  Deactivate
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<CheckCircle2 size={13} />}
                  loading={toggleActive.isPending}
                  onClick={() => toggleActive.mutate({ ids: selectedIds, isActive: true })}
                >
                  Activate
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<Trash2 size={13} />}
                  loading={softDelete.isPending}
                  onClick={() => softDelete.mutate({ ids: selectedIds, restore: false })}
                >
                  Soft-Delete
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  icon={<RotateCcw size={13} />}
                  loading={softDelete.isPending}
                  onClick={() => softDelete.mutate({ ids: selectedIds, restore: true })}
                >
                  Restore
                </Button>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {/* Main Records Table */}
      <Card>
        <CardHeader
          title={`${activeConf.label} Records`}
          subtitle={`${records.data?.total ?? 0} total records found`}
        />
        <CardBody flush>
          {records.isLoading ? (
            <LoadingBlock label="Loading records…" />
          ) : (records.data?.items.length ?? 0) === 0 ? (
            <EmptyState
              icon={<Database size={32} />}
              title="No records found"
              message="No records match your search and filter criteria."
            />
          ) : (
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    {activeConf.isMaster && (
                      <th style={{ width: 34 }}>
                        <input
                          type="checkbox"
                          checked={isAllSelected}
                          onChange={toggleSelectAll}
                          aria-label="Select all"
                        />
                      </th>
                    )}
                    <th style={{ width: 70 }}>ID</th>
                    <th style={{ minWidth: 140 }}>Code / Key</th>
                    <th style={{ minWidth: 220 }}>Name / Description</th>
                    <th style={{ minWidth: 180 }}>Department / Metadata</th>
                    <th style={{ minWidth: 140 }}>Extra Info</th>
                    <th style={{ width: 100 }}>Status</th>
                    <th className="right" style={{ width: 160 }}>
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {records.data?.items.map((row) => {
                    const isSelected = selectedIds.includes(row.id);
                    return (
                      <tr key={row.id} className={isSelected ? 'row-selected' : undefined}>
                        {activeConf.isMaster && (
                          <td>
                            <input
                              type="checkbox"
                              checked={isSelected}
                              disabled={row.isProtected}
                              onChange={() => toggleSelectOne(row.id)}
                            />
                          </td>
                        )}
                        <td className="cell-muted num">#{row.id}</td>
                        <td style={{ fontWeight: 600 }}>
                          <span className="truncate">{row.code}</span>
                        </td>
                        <td>
                          <div style={{ fontWeight: 500 }}>{row.title}</div>
                        </td>
                        <td className="cell-muted">
                          <span className="truncate">{row.subtitle || '—'}</span>
                        </td>
                        <td className="cell-muted">
                          <span className="truncate">{row.extraInfo || '—'}</span>
                        </td>
                        <td>
                          {row.deletedAt ? (
                            <Badge tone="danger">Deleted</Badge>
                          ) : row.isActive ? (
                            <Badge tone="success">{row.status}</Badge>
                          ) : (
                            <Badge tone="neutral">{row.status}</Badge>
                          )}
                        </td>
                        <td className="right">
                          <div className="row" style={{ justifyContent: 'flex-end', gap: 4 }}>
                            {/* Inspect */}
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Eye size={13} />}
                              title="Inspect record & dependencies"
                              onClick={() => setInspectTarget({ entity: activeEntity, id: row.id })}
                            />

                            {/* Toggle Active (Masters only) */}
                            {activeConf.isMaster && !row.isProtected && (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={<Power size={13} />}
                                title={row.isActive ? 'Deactivate record' : 'Activate record'}
                                onClick={() =>
                                  toggleActive.mutate({ ids: [row.id], isActive: !row.isActive })
                                }
                              />
                            )}

                            {/* Soft Delete / Restore (Masters only) */}
                            {activeConf.isMaster && !row.isProtected && (
                              <Button
                                size="sm"
                                variant="ghost"
                                icon={row.deletedAt ? <RotateCcw size={13} /> : <Trash2 size={13} />}
                                title={row.deletedAt ? 'Restore record' : 'Soft delete record'}
                                onClick={() =>
                                  softDelete.mutate({ ids: [row.id], restore: Boolean(row.deletedAt) })
                                }
                              />
                            )}

                            {/* Hard Delete Trigger */}
                            {!row.isProtected && (
                              <Button
                                size="sm"
                                variant="danger"
                                icon={<Trash2 size={13} />}
                                title="Check dependencies & safe hard-delete"
                                onClick={() => setHardDeleteTarget(row)}
                              />
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination */}
          {(records.data?.totalPages ?? 0) > 1 && (
            <div
              className="row"
              style={{
                justifyContent: 'space-between',
                alignItems: 'center',
                padding: 'var(--sp-3) var(--sp-4)',
                borderTop: '1px solid var(--border-subtle)',
              }}
            >
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                Page {page} of {records.data?.totalPages} ({records.data?.total} items)
              </div>
              <div className="row" style={{ gap: 'var(--sp-2)' }}>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={page >= (records.data?.totalPages ?? 1)}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </CardBody>
      </Card>

      {/* Repair: link the store's imported GRNs to their POs (the API is Super Admin only). */}
      {isSuperAdmin && <LinkStoreGrnsPanel />}

      {/* Record Deep Inspection Drawer */}
      <Drawer
        open={Boolean(inspectTarget)}
        onClose={() => setInspectTarget(null)}
        title={`Inspection: ${inspectTarget?.entity} #${inspectTarget?.id}`}
        subtitle="Deep audit of record fields, dependent relations, and audit trail"
        wide
      >
        {inspect.isLoading ? (
          <LoadingBlock label="Inspecting record and checking dependencies…" />
        ) : !inspect.data ? (
          <EmptyState title="Not found" message="Could not load record inspection details." />
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-4)' }}>
            {/* Dependency & Safety Status Banner */}
            <div
              style={{
                padding: 'var(--sp-3) var(--sp-4)',
                borderRadius: 'var(--radius)',
                background: inspect.data.canHardDelete ? 'var(--success-50)' : 'var(--danger-50)',
                border: `1px solid ${inspect.data.canHardDelete ? 'var(--success-200)' : 'var(--danger-200)'}`,
                color: inspect.data.canHardDelete ? 'var(--success-800)' : 'var(--danger-800)',
              }}
            >
              <div className="row" style={{ gap: 8, alignItems: 'center', fontWeight: 600 }}>
                {inspect.data.canHardDelete ? (
                  <>
                    <CheckCircle2 size={16} color="var(--success-600)" />
                    Zero Blocking Dependencies — Safe for Permanent Deletion
                  </>
                ) : (
                  <>
                    <XCircle size={16} color="var(--danger-600)" />
                    Deletion Blocked by Dependent Records
                  </>
                )}
              </div>
              {!inspect.data.canHardDelete && inspect.data.blockingReasons.length > 0 && (
                <ul style={{ margin: '6px 0 0 18px', fontSize: 'var(--text-xs)', lineHeight: 1.5 }}>
                  {inspect.data.blockingReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              )}
            </div>

            {/* Dependency Reference Table */}
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>
                Downstream Dependency Counts
              </div>
              <div className="table-wrap">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      <th>Relation / Table</th>
                      <th className="right" style={{ width: 100 }}>
                        References
                      </th>
                      <th style={{ width: 120 }}>Impact</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inspect.data.dependencies.map((d, i) => (
                      <tr key={i}>
                        <td>{d.label}</td>
                        <td className="right num" style={{ fontWeight: d.count > 0 ? 700 : 400 }}>
                          {d.count}
                        </td>
                        <td>
                          {d.count > 0 ? (
                            <Badge tone="danger">Blocks Purge</Badge>
                          ) : (
                            <Badge tone="neutral">None</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Raw Record Data */}
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>
                Record Details
              </div>
              <pre
                style={{
                  background: 'var(--bg-app)',
                  padding: 'var(--sp-3)',
                  borderRadius: 'var(--radius)',
                  fontSize: '11px',
                  fontFamily: 'var(--font-mono)',
                  overflowX: 'auto',
                  maxHeight: 280,
                }}
              >
                {JSON.stringify(inspect.data.record, null, 2)}
              </pre>
            </div>

            {/* Audit History */}
            <div>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, marginBottom: 'var(--sp-2)' }}>
                Recent Audit Trail ({inspect.data.auditLogs.length})
              </div>
              {inspect.data.auditLogs.length === 0 ? (
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                  No explicit audit trail recorded for this record.
                </div>
              ) : (
                <div className="table-wrap">
                  <table className="table table-compact">
                    <thead>
                      <tr>
                        <th style={{ width: 130 }}>Date</th>
                        <th style={{ width: 80 }}>Action</th>
                        <th style={{ width: 120 }}>Actor</th>
                        <th>Details</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inspect.data.auditLogs.map((a) => (
                        <tr key={a.id}>
                          <td className="cell-muted" style={{ fontSize: '11px' }}>
                            {formatDate(a.created_at)}
                          </td>
                          <td>
                            <Badge tone="info">{a.action}</Badge>
                          </td>
                          <td style={{ fontSize: '12px' }}>{a.actor_name || a.actor_employee_id || 'System'}</td>
                          <td style={{ fontSize: '12px' }}>{a.message || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </Drawer>

      {/* Safe Hard-Delete Modal */}
      {hardDeleteTarget && (
        <Modal
          open={Boolean(hardDeleteTarget)}
          onClose={() => {
            setHardDeleteTarget(null);
            setDeleteConfirmText('');
          }}
          title={`Permanent Deletion: ${activeConf.label} #${hardDeleteTarget.id}`}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }}>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <ShieldAlert size={28} color="var(--danger-600)" style={{ flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 600, color: 'var(--danger-700)' }}>
                  Permanent Record Purge Gate
                </div>
                <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', marginTop: 4, lineHeight: 1.5 }}>
                  You are authorizing permanent removal of <strong>{hardDeleteTarget.code}</strong> (
                  {hardDeleteTarget.title}).
                  <br />
                  The database will verify that <strong>zero foreign key references</strong> exist across all
                  downstream documents, ledgers, and transactions. If any references exist, the deletion will
                  be cleanly rejected.
                </div>
              </div>
            </div>

            <Field
              label='Type "DELETE" to confirm permanent deletion:'
              required
              hint="This action permanently purges the row from the database."
            >
              <Input
                value={deleteConfirmText}
                onChange={(e) => setDeleteConfirmText(e.target.value)}
                placeholder="DELETE"
              />
            </Field>

            <div className="row" style={{ justifyContent: 'flex-end', gap: 'var(--sp-2)', marginTop: 'var(--sp-2)' }}>
              <Button
                variant="ghost"
                onClick={() => {
                  setHardDeleteTarget(null);
                  setDeleteConfirmText('');
                }}
              >
                Cancel
              </Button>
              <Button
                variant="danger"
                disabled={deleteConfirmText !== 'DELETE'}
                loading={hardDelete.isPending}
                onClick={() =>
                  hardDelete.mutate({ id: hardDeleteTarget.id, confirm: deleteConfirmText })
                }
              >
                Permanently Delete
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
