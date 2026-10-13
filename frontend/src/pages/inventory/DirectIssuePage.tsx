/**
 * Direct Issue from Store Page (Priority 4).
 *
 * Dedicated store issue screen distinct from requisition-linked issues:
 *  - Authorized recipient employee selection.
 *  - Live item lookup with real-time stock balance validation.
 *  - Prevents issuing more than physical available stock.
 *  - Exactly-once deduction from inventory ledger.
 *  - Printable issue slip generation and audit history.
 */
import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Printer, Eye, Search, Trash2,
} from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { DataTable, type Column } from '../../components/DataTable';
import { StatTile } from '../../components/KpiCard';
import {
  Button, Card, CardBody, Badge, Modal,
} from '../../components/ui';
import { qty, formatDate, count, toShortUom } from '../../lib/format';

interface DirectIssueHeader {
  id: number;
  issue_no: string;
  issue_date: string;
  issue_time: string;
  recipient_user_id: number;
  recipient_name: string;
  recipient_employee_code: string;
  department_id: number | null;
  department_name: string;
  cost_centre_id: number | null;
  cost_centre_name: string;
  purpose: string;
  remarks: string;
  total_qty: string;
  item_count: number;
  created_by_name: string;
  created_at: string;
}

interface DirectIssueDetail extends DirectIssueHeader {
  lines: {
    id: number;
    line_no: number;
    item_id: number;
    item_code: string;
    item_description: string;
    issue_qty: string;
    uom_code: string;
    remarks: string;
  }[];
}

interface ItemOption {
  id: number;
  item_code: string;
  item_description: string;
  uom_code: string;
  live_stock_qty: string;
  department_id: number | null;
  cost_centre_id: number | null;
}

interface UserOption {
  id: number;
  employee_id: string;
  employee_name: string;
  department_id: number | null;
}

interface LineDraft {
  itemId: number | null;
  itemCode: string;
  itemDescription: string;
  uomCode: string;
  availableStock: number;
  issueQty: string;
  remarks: string;
}

export default function DirectIssuePage() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  // Filters
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [recipientFilter, setRecipientFilter] = useState('');
  const [deptFilter, setDeptFilter] = useState('');
  const [costCentreFilter, setCostCentreFilter] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const pageSize = 20;

  // Modals
  const [newModalOpen, setNewModalOpen] = useState(false);
  const [viewDetailId, setViewDetailId] = useState<number | null>(null);

  // New Issue Draft Form
  const [recipientUserId, setRecipientUserId] = useState<number | null>(null);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [costCentreId, setCostCentreId] = useState<number | null>(null);
  const [issueDate, setIssueDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [purpose, setPurpose] = useState('Machine maintenance & internal store issue');
  const [formRemarks, setFormRemarks] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([
    { itemId: null, itemCode: '', itemDescription: '', uomCode: '', availableStock: 0, issueQty: '1', remarks: '' },
  ]);

  // Query: Direct Issues Register
  const queryParams = useMemo(() => ({
    page,
    pageSize,
    search: search.trim() || undefined,
    fromDate: fromDate || undefined,
    toDate: toDate || undefined,
    recipientId: recipientFilter || undefined,
    departmentId: deptFilter || undefined,
    costCentreId: costCentreFilter || undefined,
  }), [page, pageSize, search, fromDate, toDate, recipientFilter, deptFilter, costCentreFilter]);

  const { data: res, isLoading, refetch } = useQuery({
    queryKey: ['direct-issues', queryParams],
    queryFn: () => api.getWithMeta<DirectIssueHeader[], PageMeta & { summary?: { totalIssues: number; totalQuantity: number; totalItemsCount: number } }>(`/inventory/direct-issues${qs(queryParams)}`),
    staleTime: 30_000,
  });

  const items = res?.data ?? [];
  const meta = res?.meta;

  // Query: Users for Recipient picker
  const { data: usersData } = useQuery({
    queryKey: ['users-picker'],
    queryFn: () => api.get<UserOption[]>('/users?pageSize=200'),
    staleTime: 300_000,
  });
  const users = usersData ?? [];

  // Query: Supporting lookups
  const { data: deptsData } = useQuery({
    queryKey: ['lookups-dept'],
    queryFn: () => api.get<{ id: number; name: string }[]>('/lookups/DEPARTMENT'),
    staleTime: 300_000,
  });
  const departments = deptsData ?? [];

  const { data: costCentresData } = useQuery({
    queryKey: ['lookups-cc'],
    queryFn: () => api.get<{ id: number; name: string }[]>('/lookups/COST_CENTRE'),
    staleTime: 300_000,
  });
  const costCentres = costCentresData ?? [];

  // Query: Items with live stock for line builder
  const { data: itemsData } = useQuery({
    queryKey: ['items-picker-with-stock'],
    queryFn: () => api.get<ItemOption[]>('/items?pageSize=1000'),
    staleTime: 60_000,
  });
  const allItems = itemsData ?? [];

  // Detail Modal Query
  const { data: detailData, isLoading: detailLoading } = useQuery({
    queryKey: ['direct-issue-detail', viewDetailId],
    queryFn: () => api.get<DirectIssueDetail>(`/inventory/direct-issues/${viewDetailId}`),
    enabled: viewDetailId != null,
  });

  // Mutation: Create Direct Issue
  const createMutation = useMutation({
    mutationFn: (payload: any) => api.post<{ id: number; issueNo: string; message: string }>('/inventory/direct-issues', payload),
    onSuccess: (res) => {
      toast.success(res.message);
      setNewModalOpen(false);
      resetDraftForm();
      void refetch();
      void qc.invalidateQueries({ queryKey: ['inventory-stock'] });
      void qc.invalidateQueries({ queryKey: ['direct-issues'] });
    },
    onError: (err) => toast.fromError(err, 'Failed to post direct issue'),
  });

  const resetDraftForm = () => {
    setRecipientUserId(null);
    setDepartmentId(null);
    setCostCentreId(null);
    setIssueDate(new Date().toISOString().slice(0, 10));
    setPurpose('Machine maintenance & internal store issue');
    setFormRemarks('');
    setLines([{ itemId: null, itemCode: '', itemDescription: '', uomCode: '', availableStock: 0, issueQty: '1', remarks: '' }]);
  };

  const handleLineItemSelect = (index: number, itemIdStr: string) => {
    const itId = Number(itemIdStr);
    const selected = allItems.find((i) => i.id === itId);
    if (!selected) return;

    setLines((prev) => {
      const copy = [...prev];
      copy[index] = {
        ...copy[index]!,
        itemId: selected.id,
        itemCode: selected.item_code,
        itemDescription: selected.item_description,
        uomCode: selected.uom_code || 'NOS',
        availableStock: Number(selected.live_stock_qty),
        issueQty: '1',
      };
      return copy;
    });

    if (selected.department_id && !departmentId) {
      setDepartmentId(selected.department_id);
    }
    if (selected.cost_centre_id && !costCentreId) {
      setCostCentreId(selected.cost_centre_id);
    }
  };

  const handleLineQtyChange = (index: number, val: string) => {
    setLines((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index]!, issueQty: val };
      return copy;
    });
  };

  const handleAddLine = () => {
    setLines((prev) => [
      ...prev,
      { itemId: null, itemCode: '', itemDescription: '', uomCode: '', availableStock: 0, issueQty: '1', remarks: '' },
    ]);
  };

  const handleRemoveLine = (index: number) => {
    if (lines.length <= 1) return;
    setLines((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmitNewIssue = () => {
    if (!recipientUserId) {
      toast.error('Recipient is required', 'Please select an authorized employee recipient.');
      return;
    }

    const validLines = lines.filter((l) => l.itemId != null && Number(l.issueQty) > 0);
    if (validLines.length === 0) {
      toast.error('At least one item is required', 'Please choose an item and specify issue quantity.');
      return;
    }

    // Check insufficient stock
    for (const l of validLines) {
      if (Number(l.issueQty) > l.availableStock) {
        toast.error(
          'Insufficient Stock',
          `Cannot issue ${l.issueQty} of ${l.itemCode}. Available physical stock is only ${l.availableStock}.`,
        );
        return;
      }
    }

    createMutation.mutate({
      recipientUserId,
      departmentId,
      costCentreId,
      issueDate,
      purpose,
      remarks: formRemarks,
      lines: validLines.map((l) => ({
        itemId: l.itemId,
        issueQty: Number(l.issueQty),
        remarks: l.remarks,
      })),
    });
  };

  const clearFilters = () => {
    setFromDate('');
    setToDate('');
    setRecipientFilter('');
    setDeptFilter('');
    setCostCentreFilter('');
    setSearch('');
    setPage(1);
  };

  const hasActiveFilters = Boolean(
    fromDate || toDate || recipientFilter || deptFilter || costCentreFilter || search,
  );

  /* ── Register Columns ───────────────────────────────────────────────────── */
  const columns: Column<DirectIssueHeader>[] = [
    {
      key: 'issue_no',
      header: 'Issue Slip No',
      width: '150px',
      render: (r) => (
        <button
          className="cell-code font-medium hover:underline text-left text-brand-600"
          onClick={() => setViewDetailId(r.id)}
        >
          {r.issue_no}
        </button>
      ),
    },
    {
      key: 'issue_date',
      header: 'Date & Time',
      width: '130px',
      render: (r) => (
        <div>
          <div className="cell-strong">{formatDate(r.issue_date)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{r.issue_time}</div>
        </div>
      ),
    },
    {
      key: 'recipient',
      header: 'Recipient Employee',
      render: (r) => (
        <div>
          <div className="cell-strong">{r.recipient_name}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>ID: {r.recipient_employee_code || '—'}</div>
        </div>
      ),
    },
    {
      key: 'department',
      header: 'Department / Cost Centre',
      render: (r) => (
        <div style={{ fontSize: 'var(--text-xs)' }}>
          <div>{r.department_name || '—'}</div>
          <div style={{ color: 'var(--text-muted)', fontSize: 'var(--text-2xs)' }}>{r.cost_centre_name}</div>
        </div>
      ),
    },
    {
      key: 'item_count',
      header: 'Items',
      align: 'center',
      width: '80px',
      render: (r) => <Badge tone="neutral">{r.item_count} items</Badge>,
    },
    {
      key: 'total_qty',
      header: 'Total Qty',
      align: 'right',
      width: '110px',
      render: (r) => <span className="num cell-strong">{qty(r.total_qty)}</span>,
    },
    {
      key: 'purpose',
      header: 'Purpose / Remarks',
      render: (r) => (
        <div className="truncate" style={{ maxWidth: 220, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
          {r.purpose || r.remarks || '—'}
        </div>
      ),
    },
    {
      key: 'actions',
      header: 'Actions',
      align: 'right',
      width: '140px',
      render: (r) => (
        <div style={{ display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
          <Button
            size="sm"
            variant="ghost"
            icon={<Eye size={13} />}
            onClick={() => setViewDetailId(r.id)}
          >
            View
          </Button>
          <Button
            size="sm"
            variant="secondary"
            icon={<Printer size={13} />}
            onClick={() => window.open(`/api/v1/inventory/direct-issues/${r.id}/print`, '_blank')}
          >
            Slip
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="page-shell">
      <PageHeader
        title="Direct Issue from Store"
        subtitle="Issue materials directly from store with instant stock deduction and ledger audit."
        actions={
          (can('direct_issue.create') || can('store.issue') || can('requisition.issue') || can('system.admin')) ? (
            <Button
              variant="primary"
              icon={<Plus size={15} />}
              onClick={() => setNewModalOpen(true)}
            >
              New Direct Issue
            </Button>
          ) : undefined
        }
      />

      {/* KPI Tiles */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
        <StatTile
          label="Total Direct Issues"
          value={String(meta?.summary?.totalIssues ?? 0)}
          tone="default"
        />
        <StatTile
          label="Total Quantity Issued"
          value={qty(meta?.summary?.totalQuantity ?? 0)}
          tone="success"
        />
        <StatTile
          label="Total Items Dispatched"
          value={count(meta?.summary?.totalItemsCount ?? 0)}
          tone="info"
        />
      </div>

      {/* Filter Toolbar */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
            {/* Search */}
            <div style={{ position: 'relative', minWidth: 200, flex: '1 1 200px' }}>
              <Search size={14} style={{ position: 'absolute', left: 9, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
              <input
                className="input"
                style={{ paddingLeft: 28, height: 32, fontSize: 'var(--text-xs)' }}
                placeholder="Search Issue No, recipient, purpose…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>

            {/* Date Range */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>From:</span>
              <input
                type="date"
                className="input"
                style={{ height: 32, fontSize: 'var(--text-xs)', width: 130 }}
                value={fromDate}
                onChange={(e) => setFromDate(e.target.value)}
              />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>To:</span>
              <input
                type="date"
                className="input"
                style={{ height: 32, fontSize: 'var(--text-xs)', width: 130 }}
                value={toDate}
                onChange={(e) => setToDate(e.target.value)}
              />
            </div>

            {/* Recipient User Filter */}
            <select
              className="select"
              style={{ height: 32, fontSize: 'var(--text-xs)', width: 160 }}
              value={recipientFilter}
              onChange={(e) => setRecipientFilter(e.target.value)}
            >
              <option value="">All Recipients</option>
              {users.map((u) => (
                <option key={u.id} value={u.id}>{u.employee_name} ({u.employee_id})</option>
              ))}
            </select>

            {/* Department Filter */}
            <select
              className="select"
              style={{ height: 32, fontSize: 'var(--text-xs)', width: 150 }}
              value={deptFilter}
              onChange={(e) => setDeptFilter(e.target.value)}
            >
              <option value="">All Departments</option>
              {departments.map((d) => (
                <option key={d.id} value={d.id}>{d.name}</option>
              ))}
            </select>

            {/* Cost Centre Filter */}
            <select
              className="select"
              style={{ height: 32, fontSize: 'var(--text-xs)', width: 150 }}
              value={costCentreFilter}
              onChange={(e) => setCostCentreFilter(e.target.value)}
            >
              <option value="">All Cost Centres</option>
              {costCentres.map((cc) => (
                <option key={cc.id} value={cc.id}>{cc.name}</option>
              ))}
            </select>

            {hasActiveFilters && (
              <Button size="sm" variant="ghost" onClick={clearFilters}>
                Clear Filters
              </Button>
            )}
          </div>
        </CardBody>
      </Card>

      {/* History Table */}
      <Card>
        <CardBody style={{ padding: 0 }}>
          <DataTable<DirectIssueHeader>
            columns={columns}
            rows={items}
            rowKey={(r) => r.id}
            loading={isLoading}
            meta={meta}
            onPageChange={setPage}
          />
        </CardBody>
      </Card>

      {/* ── Modal: New Direct Issue ────────────────────────────────────────── */}
      <Modal
        open={newModalOpen}
        onClose={() => setNewModalOpen(false)}
        title="New Direct Issue from Store"
        size="lg"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
            {/* Recipient */}
            <div>
              <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Recipient Employee <span style={{ color: 'var(--danger-500)' }}>*</span>
              </label>
              <select
                className="select"
                style={{ width: '100%', height: 34 }}
                value={recipientUserId ?? ''}
                onChange={(e) => {
                  const id = e.target.value ? Number(e.target.value) : null;
                  setRecipientUserId(id);
                  const sel = users.find((u) => u.id === id);
                  if (sel?.department_id && !departmentId) setDepartmentId(sel.department_id);
                }}
              >
                <option value="">Select recipient employee…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.employee_name} ({u.employee_id})</option>
                ))}
              </select>
            </div>

            {/* Department */}
            <div>
              <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Department
              </label>
              <select
                className="select"
                style={{ width: '100%', height: 34 }}
                value={departmentId ?? ''}
                onChange={(e) => setDepartmentId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select department…</option>
                {departments.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            </div>

            {/* Cost Centre */}
            <div>
              <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Cost Centre
              </label>
              <select
                className="select"
                style={{ width: '100%', height: 34 }}
                value={costCentreId ?? ''}
                onChange={(e) => setCostCentreId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="">Select cost centre…</option>
                {costCentres.map((cc) => (
                  <option key={cc.id} value={cc.id}>{cc.name}</option>
                ))}
              </select>
            </div>

            {/* Issue Date */}
            <div>
              <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
                Issue Date <span style={{ color: 'var(--danger-500)' }}>*</span>
              </label>
              <input
                type="date"
                className="input"
                style={{ width: '100%', height: 34 }}
                value={issueDate}
                onChange={(e) => setIssueDate(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
              Purpose / Reason
            </label>
            <input
              className="input"
              style={{ width: '100%', height: 34 }}
              placeholder="e.g. Machine maintenance, plant consumption, urgent replacement"
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
            />
          </div>

          {/* Line items table */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
              <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Material to Issue</span>
              <Button size="sm" variant="secondary" icon={<Plus size={12} />} onClick={handleAddLine}>
                Add Item
              </Button>
            </div>

            <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
              <table className="table" style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
                <thead>
                  <tr>
                    <th style={{ width: '40%' }}>Select Item</th>
                    <th style={{ width: '15%', textAlign: 'right' }}>Available</th>
                    <th style={{ width: '18%', textAlign: 'right' }}>Issue Qty</th>
                    <th>Line Remarks</th>
                    <th style={{ width: '40px' }}></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => (
                    <tr key={idx}>
                      <td>
                        <select
                          className="select"
                          style={{ width: '100%', height: 30, fontSize: '11px' }}
                          value={l.itemId ?? ''}
                          onChange={(e) => handleLineItemSelect(idx, e.target.value)}
                        >
                          <option value="">Select item from store…</option>
                          {allItems.map((it) => (
                            <option key={it.id} value={it.id}>
                              {it.item_code} - {it.item_description} (Stock: {Number(it.live_stock_qty).toFixed(1)} {it.uom_code || 'NOS'})
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        {l.itemId != null ? (
                          <Badge tone={l.availableStock > 0 ? 'success' : 'danger'}>
                            {qty(l.availableStock)} {toShortUom(l.uomCode)}
                          </Badge>
                        ) : '—'}
                      </td>
                      <td style={{ textAlign: 'right' }}>
                        <input
                          type="number"
                          step="0.01"
                          min="0.01"
                          max={l.availableStock > 0 ? l.availableStock : undefined}
                          className="input"
                          style={{
                            width: '100%', height: 30, textAlign: 'right', fontSize: '12px',
                            borderColor: Number(l.issueQty) > l.availableStock ? 'var(--danger-500)' : undefined,
                          }}
                          value={l.issueQty}
                          onChange={(e) => handleLineQtyChange(idx, e.target.value)}
                        />
                      </td>
                      <td>
                        <input
                          className="input"
                          style={{ width: '100%', height: 30, fontSize: '11px' }}
                          placeholder="Optional remarks"
                          value={l.remarks}
                          onChange={(e) => {
                            const val = e.target.value;
                            setLines((prev) => {
                              const c = [...prev];
                              c[idx] = { ...c[idx]!, remarks: val };
                              return c;
                            });
                          }}
                        />
                      </td>
                      <td style={{ textAlign: 'center' }}>
                        <button
                          onClick={() => handleRemoveLine(idx)}
                          disabled={lines.length <= 1}
                          style={{ color: 'var(--danger-500)', opacity: lines.length <= 1 ? 0.3 : 1 }}
                        >
                          <Trash2 size={13} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div>
            <label style={{ fontSize: 'var(--text-xs)', fontWeight: 600, display: 'block', marginBottom: 4 }}>
              General Remarks
            </label>
            <input
              className="input"
              style={{ width: '100%', height: 32 }}
              placeholder="Additional internal notes"
              value={formRemarks}
              onChange={(e) => setFormRemarks(e.target.value)}
            />
          </div>

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 8 }}>
            <Button variant="ghost" onClick={() => setNewModalOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleSubmitNewIssue}
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? 'Posting Issue…' : 'Issue Material & Deduct Stock'}
            </Button>
          </div>
        </div>
      </Modal>

      {/* ── Modal: View Issue Slip ─────────────────────────────────────────── */}
      <Modal
        open={viewDetailId != null}
        onClose={() => setViewDetailId(null)}
        title={`Store Direct Issue Slip — ${detailData?.issue_no ?? 'Loading…'}`}
        size="lg"
      >
        {detailLoading ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted)' }}>Loading slip details…</div>
        ) : detailData ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 10, background: 'var(--bg-inset)', padding: 12, borderRadius: 'var(--radius)' }}>
              <div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Issue Slip No</div>
                <div style={{ fontWeight: 700, fontFamily: 'var(--font-mono)' }}>{detailData.issue_no}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Date & Time</div>
                <div>{formatDate(detailData.issue_date)} {detailData.issue_time}</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Recipient</div>
                <div style={{ fontWeight: 600 }}>{detailData.recipient_name} ({detailData.recipient_employee_code || '—'})</div>
              </div>
              <div>
                <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>Department / Cost Centre</div>
                <div>{detailData.department_name || '—'} / {detailData.cost_centre_name || '—'}</div>
              </div>
            </div>

            {detailData.purpose && (
              <div style={{ fontSize: 'var(--text-xs)' }}>
                <strong>Purpose:</strong> {detailData.purpose}
              </div>
            )}

            <table className="table" style={{ width: '100%', fontSize: 'var(--text-xs)' }}>
              <thead>
                <tr>
                  <th style={{ width: '40px', textAlign: 'center' }}>#</th>
                  <th>Item Code</th>
                  <th>Description</th>
                  <th style={{ textAlign: 'center', width: '70px' }}>UOM</th>
                  <th style={{ textAlign: 'right', width: '100px' }}>Issued Qty</th>
                  <th>Line Remarks</th>
                </tr>
              </thead>
              <tbody>
                {detailData.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ textAlign: 'center' }}>{l.line_no}</td>
                    <td style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{l.item_code}</td>
                    <td>{l.item_description}</td>
                    <td style={{ textAlign: 'center' }}>{toShortUom(l.uom_code)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 700 }} className="num">{qty(l.issue_qty)}</td>
                    <td style={{ color: 'var(--text-muted)' }}>{l.remarks || '—'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ background: 'var(--bg-inset)', fontWeight: 700 }}>
                  <td colSpan={4} style={{ textAlign: 'right' }}>Total Quantity Issued:</td>
                  <td style={{ textAlign: 'right' }} className="num">{qty(detailData.total_qty)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>

            <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
              <Button
                variant="secondary"
                icon={<Printer size={14} />}
                onClick={() => window.open(`/api/v1/inventory/direct-issues/${detailData.id}/print`, '_blank')}
              >
                Print Slip
              </Button>
              <Button variant="ghost" onClick={() => setViewDetailId(null)}>
                Close
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}
