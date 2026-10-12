/**
 * Supporting Masters (SRS §7.3, ADR-014).
 *
 * PO Type, Indent Type, Cost Centre, Department, Item Type, Main/Sub Group, UOM,
 * Currency and Payment Terms — every dropdown source in the product, maintained
 * through one screen because they share one table and one CRUD contract.
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, Tags, Info } from 'lucide-react';
import { api, qs, ApiError, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Modal, Field, Input, Select, Textarea, Checkbox, Badge, ConfirmDialog, Card, CardBody,
} from '../../components/ui';
import { text } from '../../lib/format';

interface CategoryInfo {
  category: string;
  label: string;
  singular: string;
  parentCategory: string | null;
  total: number;
  active: number;
}

interface LookupRow {
  id: number;
  category: string;
  code: string;
  name: string;
  description: string;
  parent_id: number | null;
  parent_name: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

const EMPTY: Partial<LookupRow> = { code: '', name: '', description: '', sort_order: 0, is_active: true };

export default function Lookups() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const { filters, setFilters } = useFilters();

  const category = (filters.category as string) ?? 'PO_TYPE';
  const [editing, setEditing] = useState<Partial<LookupRow> | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [confirmDelete, setConfirmDelete] = useState<LookupRow | null>(null);

  const categories = useQuery({
    queryKey: ['lookups', 'categories'],
    queryFn: () => api.get<CategoryInfo[]>('/lookups/categories'),
  });

  const active = categories.data?.find((c) => c.category === category);

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir, isActive: filters.isActive,
  });

  const list = useQuery({
    queryKey: ['lookups', category, query],
    queryFn: () => api.getWithMeta<LookupRow[], PageMeta>(`/lookups/${category}${query}`),
  });

  // Parent options for a cascading category (Sub Main Group → Main Group).
  const parents = useQuery({
    queryKey: ['lookups', 'parents', active?.parentCategory],
    queryFn: () => api.getWithMeta<LookupRow[], PageMeta>(`/lookups/${active!.parentCategory}?pageSize=200&isActive=true`),
    enabled: Boolean(active?.parentCategory),
  });

  const save = useMutation({
    mutationFn: (b: Partial<LookupRow>) => {
      const payload = {
        code: b.code, name: b.name, description: b.description ?? '',
        parentId: b.parent_id ?? null, sortOrder: b.sort_order ?? 0, isActive: b.is_active ?? true,
      };
      return b.id
        ? api.put<LookupRow>(`/lookups/${category}/${b.id}`, payload)
        : api.post<LookupRow>(`/lookups/${category}`, payload);
    },
    onSuccess: (_, b) => {
      toast.success(b.id ? 'Value updated' : 'Value created', b.name);
      setEditing(null); setErrors({});
      void qc.invalidateQueries({ queryKey: ['lookups'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  const remove = useMutation({
    mutationFn: (r: LookupRow) => api.del<{ deleted: boolean; message: string }>(`/lookups/${category}/${r.id}`),
    onSuccess: (res) => {
      if (res.deleted) toast.success('Value deleted', res.message);
      else toast.warning('Value deactivated', res.message);
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey: ['lookups'] });
    },
    onError: (err) => { toast.fromError(err); setConfirmDelete(null); },
  });

  const columns: Column<LookupRow>[] = [
    { key: 'code', header: 'Code', sortKey: 'code', width: '160px', render: (r) => <span className="cell-code">{r.code}</span> },
    { key: 'name', header: 'Name', sortKey: 'name', render: (r) => <span className="cell-strong">{r.name}</span> },
    ...(active?.parentCategory
      ? [{ key: 'parent', header: 'Parent', render: (r: LookupRow) => text(r.parent_name) } as Column<LookupRow>]
      : []),
    { key: 'desc', header: 'Description', render: (r) => <span className="cell-muted truncate" style={{ maxWidth: 320, display: 'block' }}>{text(r.description)}</span> },
    { key: 'order', header: 'Sort', sortKey: 'sortOrder', align: 'right', optional: true, render: (r) => <span className="num">{r.sort_order}</span> },
    {
      key: 'status', header: 'Status', align: 'center',
      render: (r) => (
        <div className="row" style={{ gap: 4, justifyContent: 'center' }}>
          <Badge tone={r.is_active ? 'success' : 'neutral'}>{r.is_active ? 'Active' : 'Inactive'}</Badge>
          {r.is_system && <Badge tone="info" plain>System</Badge>}
        </div>
      ),
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '90px',
      render: (r) => (
        <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
          {can('lookup.edit') && <Button variant="ghost" size="sm" onClick={() => setEditing(r)} title="Edit"><Pencil size={13} /></Button>}
          {can('lookup.delete') && !r.is_system && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(r)} title="Delete"><Trash2 size={13} /></Button>
          )}
        </div>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Supporting Masters"
        subtitle="The dropdown sources used across indents, purchase orders and GRNs"
        breadcrumbs={[{ label: 'Master', to: '/masters/items' }, { label: 'Supporting Masters' }]}
        actions={
          can('lookup.create') ? (
            <Button
              variant="primary" size="sm" icon={<Plus size={14} />}
              onClick={() => { setEditing({ ...EMPTY }); setErrors({}); }}
            >
              New {active?.singular ?? 'Value'}
            </Button>
          ) : undefined
        }
      />

      {/* Category selector — each is a distinct master, one screen maintains them all. */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardBody style={{ padding: 'var(--sp-3)' }}>
          <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
            {(categories.data ?? []).map((c) => {
              const isActive = c.category === category;
              return (
                <button
                  key={c.category}
                  onClick={() => setFilters({ category: c.category, page: undefined, search: undefined })}
                  className="row"
                  style={{
                    gap: 7, padding: '7px 12px', borderRadius: 'var(--radius-sm)',
                    border: `1px solid ${isActive ? 'var(--brand-400)' : 'var(--border)'}`,
                    background: isActive ? 'var(--brand-50)' : 'var(--bg-surface)',
                    color: isActive ? 'var(--brand-700)' : 'var(--ink-600)',
                    fontSize: 'var(--text-xs)', fontWeight: isActive ? 600 : 400,
                    transition: 'all var(--dur-fast) var(--ease)',
                  }}
                >
                  <Tags size={13} />
                  {c.label}
                  <span
                    className="num"
                    style={{
                      padding: '1px 6px', borderRadius: 'var(--radius-full)',
                      background: isActive ? 'var(--brand-100)' : 'var(--ink-100)',
                      fontSize: '10px', fontWeight: 700,
                    }}
                  >
                    {c.active}
                  </span>
                </button>
              );
            })}
          </div>
        </CardBody>
      </Card>

      {active?.parentCategory && (
        <div
          className="row"
          style={{
            gap: 8, padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-3)',
            background: 'var(--info-50)', border: '1px solid var(--info-100)',
            borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--info-700)',
          }}
        >
          <Info size={14} style={{ flexShrink: 0 }} />
          Each {active.singular} belongs to a {categories.data?.find((c) => c.category === active.parentCategory)?.singular},
          which is what makes the two dropdowns cascade on the Item Master form.
        </div>
      )}

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="lookups"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder={`Search ${active?.label.toLowerCase() ?? 'values'}…`}
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(page) => setFilters({ page }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={can('lookup.edit') ? (r) => setEditing(r) : undefined}
        onPrint={() => window.print()}
        emptyTitle={`No ${active?.label.toLowerCase() ?? 'values'} yet`}
        emptyMessage="Add the values your business uses — they will appear in every relevant dropdown."
        emptyAction={can('lookup.create') ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setEditing({ ...EMPTY })}>Add value</Button> : undefined}
        compact
      />

      <Modal
        open={editing !== null}
        onClose={() => { setEditing(null); setErrors({}); }}
        title={editing?.id ? `Edit ${active?.singular}` : `New ${active?.singular}`}
        subtitle={active?.label}
        size="md"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditing(null); setErrors({}); }}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              {editing?.id ? 'Save changes' : 'Create'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="form-grid">
            <Field label="Code" required error={errors.code} hint={editing.is_system ? 'System values keep their code' : 'Short unique key'}>
              <Input
                value={editing.code ?? ''}
                onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase() })}
                invalid={Boolean(errors.code)}
                disabled={editing.is_system}
                style={{ fontFamily: 'var(--font-mono)' }}
                autoFocus
              />
            </Field>
            <Field label="Name" required error={errors.name} hint="Shown in dropdowns">
              <Input value={editing.name ?? ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} invalid={Boolean(errors.name)} />
            </Field>
            {active?.parentCategory && (
              <Field
                label={categories.data?.find((c) => c.category === active.parentCategory)?.singular ?? 'Parent'}
                error={errors.parentId}
                span="full"
              >
                <Select
                  value={editing.parent_id ?? ''}
                  placeholder="Select parent"
                  onChange={(e) => setEditing({ ...editing, parent_id: e.target.value ? Number(e.target.value) : null })}
                  options={(parents.data?.data ?? []).map((p) => ({ value: p.id, label: p.name }))}
                />
              </Field>
            )}
            <Field label="Description" span="full" error={errors.description}>
              <Textarea value={editing.description ?? ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={2} />
            </Field>
            <Field label="Sort order" error={errors.sortOrder} hint="Lower values appear first">
              <Input numeric type="number" min="0" value={editing.sort_order ?? 0}
                     onChange={(e) => setEditing({ ...editing, sort_order: Number(e.target.value) })} />
            </Field>
            <div style={{ display: 'flex', alignItems: 'flex-end', paddingBottom: 8 }}>
              <Checkbox label="Active" checked={editing.is_active ?? true} onChange={(v) => setEditing({ ...editing, is_active: v })} />
            </div>
          </div>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
        title={`Delete ${active?.singular.toLowerCase()}?`}
        confirmLabel="Delete"
        loading={remove.isPending}
        message={
          <>
            <strong>{confirmDelete?.name}</strong> will be removed.
            <br /><br />
            If it is referenced by any item or transaction it will be{' '}
            <strong>deactivated instead of deleted</strong>, so existing records keep their history
            while the value stops appearing in dropdowns.
          </>
        }
      />
    </>
  );
}
