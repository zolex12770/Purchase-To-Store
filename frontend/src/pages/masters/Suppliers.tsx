/**
 * Supplier Master (SRS §7.2).
 *
 * List → detail drawer → purchase history, with create/edit and a delete that
 * degrades to deactivation when the supplier has transaction history (SRS §20).
 */
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Download, ExternalLink, MapPin, Receipt } from 'lucide-react';
import { api, qs, downloadFile, ApiError, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters, drilldownLink } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { useLookupOptions } from '../../lib/masters';
import { PageHeader } from '../../layout/AppShell';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Card, CardBody, Drawer, Modal, Field, Input, Select, Textarea, Checkbox,
  Badge, ConfirmDialog, DetailItem, DetailGrid, SectionTitle, LoadingBlock, StatusBadge,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { money, count, formatDate, text } from '../../lib/format';

interface Supplier {
  id: number;
  supplier_code: string;
  supplier_name: string;
  address: string;
  state: string;
  city: string;
  country: string;
  mobile_no: string;
  email: string;
  gst_no: string;
  payment_terms: string;
  currency_code: string;
  contact_person: string;
  pin_code: string;
  notes: string;
  is_active: boolean;
  po_count?: number;
  total_purchase_value?: string;
  last_po_date?: string | null;
}

interface SupplierDetail extends Supplier {
  summary: { po_count: number; total_value: string; received_value: string; pending_value: string; last_po_date: string | null; first_po_date: string | null };
  recentPurchaseOrders: { po_id: number; po_no: string; po_date: string; status: string; total_amount: string; received_amount: string; pending_amount: string }[];
  topItems: { item_id: number; item_code: string; item_description: string; total_qty: string; total_value: string }[];
}

const EMPTY: Partial<Supplier> = {
  supplier_name: '', address: '', state: '', city: '', country: 'India',
  mobile_no: '', email: '', gst_no: '', payment_terms: '', currency_code: 'INR',
  contact_person: '', pin_code: '', notes: '', is_active: true,
};

export default function Suppliers() {
  const { id: routeId } = useParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();

  const [detailId, setDetailId] = useState<number | null>(routeId ? Number(routeId) : null);
  const [editing, setEditing] = useState<Partial<Supplier> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // State -> City dependent dropdown (SRS §7.2). The underlying columns stay
  // plain text (existing suppliers keep working unmodified) — the master data
  // just drives the picker, matched on name rather than a foreign key.
  const { raw: stateRaw, isLoading: statesLoading } = useLookupOptions('STATE');
  const { raw: cityRaw, isLoading: citiesLoading } = useLookupOptions('CITY');
  const stateOptions = stateRaw.map((s) => ({ value: s.name, label: s.name }));
  const selectedStateLookup = stateRaw.find((s) => s.name === editing?.state);
  const cityOptions = selectedStateLookup
    ? cityRaw.filter((c) => c.parentId === selectedStateLookup.id).map((c) => ({ value: c.name, label: c.name }))
    : [];
  // An existing supplier's free-text value may not match the reference list
  // (a spelling variant, a town not on it) — surface it rather than let the
  // dropdown silently render blank and risk it being lost on save.
  const stateOptionsWithCurrent = editing?.state && !stateOptions.some((o) => o.value === editing.state)
    ? [{ value: editing.state, label: `${editing.state} (current)` }, ...stateOptions]
    : stateOptions;
  const cityOptionsWithCurrent = editing?.city && !cityOptions.some((o) => o.value === editing.city)
    ? [{ value: editing.city, label: `${editing.city} (current)` }, ...cityOptions]
    : cityOptions;
  const [confirmDelete, setConfirmDelete] = useState<Supplier | null>(null);

  useEffect(() => { if (routeId) setDetailId(Number(routeId)); }, [routeId]);

  const { options: paymentTerms } = useLookupOptions('PAYMENT_TERMS');

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir, isActive: filters.isActive,
  });

  const list = useQuery({
    queryKey: ['suppliers', query],
    queryFn: () => api.getWithMeta<Supplier[], PageMeta & {
      totals?: {
        totalSuppliers: number;
        activeSuppliers: number;
        inactiveSuppliers: number;
      };
    }>(`/suppliers${query}`),
  });

  const detail = useQuery({
    queryKey: ['supplier', detailId],
    queryFn: () => api.get<SupplierDetail>(`/suppliers/${detailId}`),
    enabled: detailId !== null,
  });

  const save = useMutation({
    mutationFn: (body: Partial<Supplier>) => {
      const payload = {
        supplierCode: body.supplier_code, supplierName: body.supplier_name,
        address: body.address, state: body.state, city: body.city, country: body.country,
        mobileNo: body.mobile_no, email: body.email, gstNo: body.gst_no,
        paymentTerms: body.payment_terms, currencyCode: body.currency_code,
        contactPerson: body.contact_person, pinCode: body.pin_code,
        notes: body.notes, isActive: body.is_active ?? true,
      };
      return body.id
        ? api.put<Supplier>(`/suppliers/${body.id}`, payload)
        : api.post<Supplier>('/suppliers', payload);
    },
    onSuccess: (_, body) => {
      toast.success(body.id ? 'Supplier updated' : 'Supplier created', body.supplier_name);
      setEditing(null);
      setErrors({});
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      void qc.invalidateQueries({ queryKey: ['supplier'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  const remove = useMutation({
    mutationFn: (s: Supplier) => api.del<{ deleted: boolean; message: string }>(`/suppliers/${s.id}`),
    onSuccess: (res) => {
      // The backend deactivates rather than deletes when history exists — surface which happened.
      if (res.deleted) toast.success('Supplier deleted', res.message);
      else toast.warning('Supplier deactivated', res.message);
      setConfirmDelete(null);
      setDetailId(null);
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
    },
    onError: (err) => { toast.fromError(err); setConfirmDelete(null); },
  });

  const columns: Column<Supplier>[] = [
    {
      key: 'code', header: 'Code', sortKey: 'supplierCode', width: '110px',
      render: (s) => <span className="cell-code">{s.supplier_code}</span>,
    },
    {
      key: 'name', header: 'Supplier Name', sortKey: 'supplierName',
      render: (s) => <div className="cell-strong">{s.supplier_name}</div>,
    },
    { key: 'city', header: 'City', sortKey: 'city', render: (s) => text(s.city) },
    { key: 'state', header: 'State', sortKey: 'state', render: (s) => text(s.state) },
    { key: 'gst', header: 'GST No', optional: true, render: (s) => <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{text(s.gst_no)}</span> },
    { key: 'mobile', header: 'Mobile', optional: true, render: (s) => text(s.mobile_no) },
    { key: 'email', header: 'Email', optional: true, render: (s) => text(s.email) },
    { key: 'terms', header: 'Payment Terms', render: (s) => text(s.payment_terms) },
    {
      key: 'poCount', header: 'POs', align: 'right',
      render: (s) => <span className="num">{count(s.po_count ?? 0)}</span>,
    },
    {
      key: 'value', header: 'Purchase Value', align: 'right',
      render: (s) => <span className="num cell-strong">{money(s.total_purchase_value ?? 0)}</span>,
    },
    {
      key: 'lastPo', header: 'Last PO', optional: true, align: 'right',
      render: (s) => <span className="cell-muted">{s.last_po_date ? formatDate(s.last_po_date) : '—'}</span>,
    },
    {
      key: 'status', header: 'Status', align: 'center',
      render: (s) => <Badge tone={s.is_active ? 'success' : 'neutral'}>{s.is_active ? 'Active' : 'Inactive'}</Badge>,
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '90px',
      render: (s) => (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {can('supplier.edit') && (
            <Button variant="ghost" size="sm" onClick={() => setEditing(s)} title="Edit"><Pencil size={13} /></Button>
          )}
          {can('supplier.delete') && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(s)} title="Delete"><Trash2 size={13} /></Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Supplier Master"
        subtitle="Suppliers, commercial terms and purchase history"
        breadcrumbs={[{ label: 'Master', to: '/masters/suppliers' }, { label: 'Supplier Master' }]}
        actions={
          <>
            {can('supplier.export') && (
              <Button
                variant="secondary" size="sm" icon={<Download size={13} />}
                onClick={() => void downloadFile(`/io/export/suppliers?format=xlsx${query.replace('?', '&')}`, 'suppliers.xlsx')}
              >
                Export
              </Button>
            )}
            {can('supplier.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />} onClick={() => { setEditing({ ...EMPTY }); setErrors({}); }}>
                New Supplier
              </Button>
            )}
          </>
        }
      />

      {list.data?.meta && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Total Suppliers" value={count(list.data.meta.totals?.totalSuppliers ?? list.data.meta.total ?? 0)} />
          <StatTile label="Active Suppliers" value={count(list.data.meta.totals?.activeSuppliers ?? 0)} tone="success" />
          <StatTile label="Inactive Suppliers" value={count(list.data.meta.totals?.inactiveSuppliers ?? 0)} tone="default" />
        </div>
      )}

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(s) => s.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="suppliers"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search name, code, city, GST…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(page) => setFilters({ page }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(s) => setDetailId(s.id)}
        selectedKey={detailId}
        onExport={can('supplier.export') ? (format) => void downloadFile(`/io/export/suppliers?format=${format}${query.replace('?', '&')}`, `suppliers.${format}`) : undefined}
        onPrint={() => window.print()}
        emptyTitle="No suppliers yet"
        emptyMessage="Add your first supplier, or import the Supplier Master from Excel."
        emptyAction={can('supplier.create') ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ ...EMPTY })}>New Supplier</Button> : undefined}
        toolbar={
          <Select
            className="input-sm" style={{ width: 130, height: 30 }}
            value={(filters.isActive as string) ?? ''}
            onChange={(e) => setFilters({ isActive: e.target.value || undefined })}
            aria-label="Status filter"
          >
            <option value="">All status</option>
            <option value="true">Active only</option>
            <option value="false">Inactive only</option>
          </Select>
        }
      />

      {activeCount > 0 && (
        <div style={{ marginTop: 8, textAlign: 'right' }}>
          <Button variant="ghost" size="sm" onClick={() => clearFilters()}>Clear filters</Button>
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      <Drawer
        open={detailId !== null}
        onClose={() => { setDetailId(null); if (routeId) navigate('/masters/suppliers'); }}
        wide
        title={detail.data?.supplier_name ?? 'Supplier'}
        subtitle={detail.data ? `${detail.data.supplier_code} · ${[detail.data.city, detail.data.state].filter(Boolean).join(', ')}` : undefined}
        actions={
          detail.data && can('supplier.edit') ? (
            <Button variant="secondary" size="sm" icon={<Pencil size={13} />} onClick={() => setEditing(detail.data!)}>Edit</Button>
          ) : undefined
        }
      >
        {detail.isLoading ? (
          <LoadingBlock />
        ) : detail.data ? (
          <div className="stack" style={{ gap: 'var(--sp-6)' }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 'var(--sp-3)' }}>
              <StatTile label="Purchase orders" value={count(detail.data.summary.po_count)} />
              <StatTile label="Total value" value={money(detail.data.summary.total_value)} />
              <StatTile label="Received" value={money(detail.data.summary.received_value)} tone="success" />
              <StatTile label="Pending" value={money(detail.data.summary.pending_value)} tone={Number(detail.data.summary.pending_value) > 0 ? 'warning' : 'default'} />
            </div>

            <div>
              <SectionTitle>Supplier details</SectionTitle>
              <DetailGrid cols={3}>
                <DetailItem label="Supplier code" mono>{detail.data.supplier_code}</DetailItem>
                <DetailItem label="Status">
                  <Badge tone={detail.data.is_active ? 'success' : 'neutral'}>{detail.data.is_active ? 'Active' : 'Inactive'}</Badge>
                </DetailItem>
                <DetailItem label="GST no." mono><span className="row" style={{ gap: 5 }}><Receipt size={12} />{text(detail.data.gst_no)}</span></DetailItem>
                <DetailItem label="Mobile number">{text(detail.data.mobile_no)}</DetailItem>
                <DetailItem label="Email address">{text(detail.data.email)}</DetailItem>
                <DetailItem label="Payment terms">{text(detail.data.payment_terms)}</DetailItem>
                <DetailItem label="Country">{text(detail.data.country)}</DetailItem>
                <div style={{ gridColumn: '1 / -1' }}>
                  <DetailItem label="Address">
                    <span className="row" style={{ gap: 5, alignItems: 'flex-start' }}>
                      <MapPin size={12} style={{ marginTop: 3, flexShrink: 0 }} />
                      {text([detail.data.address, detail.data.city, detail.data.state, detail.data.country].filter(Boolean).join(', '))}
                    </span>
                  </DetailItem>
                </div>
              </DetailGrid>
            </div>

            {detail.data.topItems.length > 0 && (
              <div>
                <SectionTitle>Most purchased items</SectionTitle>
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead>
                      <tr><th>Item</th><th className="right">Quantity</th><th className="right">Value</th></tr>
                    </thead>
                    <tbody>
                      {detail.data.topItems.map((i) => (
                        <tr key={i.item_id} className="clickable" onClick={() => navigate(`/masters/items/${i.item_id}`)}>
                          <td>
                            <div className="cell-code">{i.item_code}</div>
                            <div className="cell-wrap" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', minWidth: 200, maxWidth: 380 }}>
                              {i.item_description}
                            </div>
                          </td>
                          <td className="right num">{i.total_qty}</td>
                          <td className="right num cell-strong">{money(i.total_value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            <div>
              <SectionTitle
                action={
                  <Button
                    variant="ghost" size="sm" iconRight={<ExternalLink size={12} />}
                    onClick={() => navigate(drilldownLink('/purchase-orders', { supplierId: [String(detail.data!.id)] }))}
                  >
                    All purchase orders
                  </Button>
                }
              >
                Recent purchase orders
              </SectionTitle>
              {detail.data.recentPurchaseOrders.length === 0 ? (
                <Card><CardBody><div style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: 'var(--text-sm)', padding: 'var(--sp-4)' }}>
                  No purchase orders raised on this supplier yet.
                </div></CardBody></Card>
              ) : (
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead>
                      <tr><th>PO No</th><th>Date</th><th>Status</th><th className="right">Value</th><th className="right">Pending</th></tr>
                    </thead>
                    <tbody>
                      {detail.data.recentPurchaseOrders.map((p) => (
                        <tr key={p.po_id} className="clickable" onClick={() => navigate(`/purchase-orders/${p.po_id}`)}>
                          <td className="cell-code">{p.po_no}</td>
                          <td>{formatDate(p.po_date)}</td>
                          <td><StatusBadge status={p.status} /></td>
                          <td className="right num cell-strong">{money(p.total_amount)}</td>
                          <td className="right num">{money(p.pending_amount)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        ) : null}
      </Drawer>

      {/* ── Create / edit ─────────────────────────────────────────────────── */}
      <Modal
        open={editing !== null}
        onClose={() => { setEditing(null); setErrors({}); }}
        title={editing?.id ? 'Edit supplier' : 'New supplier'}
        subtitle={editing?.id ? editing.supplier_code : 'A supplier code is generated automatically'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditing(null); setErrors({}); }}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              {editing?.id ? 'Save changes' : 'Create supplier'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="form-grid">
            <Field label="Supplier name" required error={errors.supplierName} span="full">
              <Input
                value={editing.supplier_name ?? ''}
                onChange={(e) => setEditing({ ...editing, supplier_name: e.target.value })}
                invalid={Boolean(errors.supplierName)}
                autoFocus
                placeholder="Registered business name"
              />
            </Field>
            <Field label="GST no." error={errors.gstNo} hint="15-character GSTIN">
              <Input
                value={editing.gst_no ?? ''}
                onChange={(e) => setEditing({ ...editing, gst_no: e.target.value.toUpperCase() })}
                invalid={Boolean(errors.gstNo)}
                placeholder="27AAACP1234F1Z5"
                style={{ fontFamily: 'var(--font-mono)' }}
                maxLength={15}
              />
            </Field>
            <Field label="Mobile number" error={errors.mobileNo}>
              <Input
                value={editing.mobile_no ?? ''}
                onChange={(e) => setEditing({ ...editing, mobile_no: e.target.value })}
                invalid={Boolean(errors.mobileNo)}
                placeholder="98765 43210"
                type="tel"
                maxLength={30}
              />
            </Field>
            <Field label="Email address" error={errors.email}>
              <Input
                value={editing.email ?? ''}
                onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                invalid={Boolean(errors.email)}
                placeholder="purchase@supplier.com"
                type="email"
                maxLength={200}
              />
            </Field>
            <Field label="Address" error={errors.address} span="full">
              <Textarea value={editing.address ?? ''} onChange={(e) => setEditing({ ...editing, address: e.target.value })} rows={2} />
            </Field>
            <Field label="State" error={errors.state} hint={statesLoading ? 'Loading…' : undefined}>
              <Select
                value={editing.state ?? ''}
                placeholder="Select state"
                disabled={statesLoading}
                onChange={(e) => {
                  // Changing State clears a City that no longer belongs to it —
                  // never leave a stale, mismatched City selected.
                  const newState = e.target.value;
                  const stillValid = newState && cityRaw.some((c) => {
                    const st = stateRaw.find((s) => s.name === newState);
                    return st && c.parentId === st.id && c.name === editing.city;
                  });
                  setEditing({ ...editing, state: newState, city: stillValid ? editing.city : '' });
                }}
                options={stateOptionsWithCurrent}
              />
            </Field>
            <Field
              label="City"
              error={errors.city}
              hint={citiesLoading ? 'Loading…' : !editing.state ? 'Select a state first' : cityOptionsWithCurrent.length === 0 ? 'No cities listed for this state' : undefined}
            >
              <Select
                value={editing.city ?? ''}
                placeholder={editing.state ? 'Select city' : 'Select a state first'}
                disabled={citiesLoading || !editing.state || cityOptionsWithCurrent.length === 0}
                onChange={(e) => setEditing({ ...editing, city: e.target.value })}
                options={cityOptionsWithCurrent}
              />
            </Field>
            <Field label="Country" error={errors.country}>
              <Input value={editing.country ?? 'India'} onChange={(e) => setEditing({ ...editing, country: e.target.value })} />
            </Field>
            <Field label="Payment terms" error={errors.paymentTerms} hint="Defaults onto every PO for this supplier">
              <Select
                value={editing.payment_terms ?? ''}
                onChange={(e) => setEditing({ ...editing, payment_terms: e.target.value })}
                placeholder="Select terms"
              >
                {paymentTerms.map((o) => <option key={o.value} value={o.label}>{o.label}</option>)}
              </Select>
            </Field>
            <div className="field-span-full">
              <Checkbox
                label="Active — appears in supplier dropdowns"
                checked={editing.is_active ?? true}
                onChange={(v) => setEditing({ ...editing, is_active: v })}
              />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
        title="Delete supplier?"
        confirmLabel="Delete"
        loading={remove.isPending}
        message={
          <>
            <strong>{confirmDelete?.supplier_name}</strong> will be removed.
            <br /><br />
            If the supplier has purchase orders or GRNs, it will be <strong>deactivated instead of
            deleted</strong> so the purchase history stays intact.
          </>
        }
      />
    </>
  );
}
