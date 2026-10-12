/**
 * Role & Permission Management (SRS §17, §18).
 *
 * Permissions are shown grouped by module with per-module select-all, because a
 * flat list of 64 checkboxes is unusable in practice.
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Pencil, Trash2, ShieldCheck, Users as UsersIcon, Lock, Check, Minus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, Modal, Field, Input, Textarea, Checkbox, Badge, ConfirmDialog, LoadingBlock, EmptyState, Drawer, SectionTitle, DetailItem, DetailGrid,
} from '../../components/ui';
import { count, text } from '../../lib/format';

interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string;
  is_system: boolean;
  is_active: boolean;
  user_count: number;
  permission_count: number;
}

interface PermissionDef { id: number; code: string; module: string; action: string; label: string; description: string }
interface PermissionModule { module: string; label: string; permissions: PermissionDef[] }

interface RoleDetail extends RoleRow {
  permissions: PermissionDef[];
  permissionCodes: string[];
  users: { id: number; employee_id: string; employee_name: string; designation: string; is_active: boolean }[];
}

interface Draft {
  id?: number;
  code: string;
  name: string;
  description: string;
  isActive: boolean;
  permissionIds: number[];
  isSystem?: boolean;
}

const EMPTY: Draft = { code: '', name: '', description: '', isActive: true, permissionIds: [] };

export default function Roles() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  const [editing, setEditing] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [detailId, setDetailId] = useState<number | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<RoleRow | null>(null);

  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<RoleRow[]>('/roles') });
  const modules = useQuery({
    queryKey: ['permissions'],
    queryFn: () => api.get<PermissionModule[]>('/roles/permissions'),
  });
  const detail = useQuery({
    queryKey: ['role', detailId],
    queryFn: () => api.get<RoleDetail>(`/roles/${detailId}`),
    enabled: detailId !== null,
  });

  // When opening the editor for an existing role, seed its current grants.
  const editingRole = useQuery({
    queryKey: ['role', 'edit', editing?.id],
    queryFn: () => api.get<RoleDetail>(`/roles/${editing!.id}`),
    enabled: Boolean(editing?.id),
  });

  useEffect(() => {
    if (editingRole.data && editing?.id === editingRole.data.id && editing.permissionIds.length === 0) {
      setEditing((e) => (e ? { ...e, permissionIds: editingRole.data!.permissions.map((p) => p.id) } : e));
    }
  }, [editingRole.data, editing?.id]);

  const save = useMutation({
    mutationFn: (d: Draft) => {
      const payload = {
        code: d.code, name: d.name, description: d.description,
        isActive: d.isActive, permissionIds: d.permissionIds,
      };
      return d.id ? api.put<RoleRow>(`/roles/${d.id}`, payload) : api.post<RoleRow>('/roles', payload);
    },
    onSuccess: (_, d) => {
      toast.success(d.id ? 'Role updated' : 'Role created', d.name);
      setEditing(null); setErrors({});
      void qc.invalidateQueries({ queryKey: ['roles'] });
      void qc.invalidateQueries({ queryKey: ['role'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  const remove = useMutation({
    mutationFn: (r: RoleRow) => api.del<{ message: string }>(`/roles/${r.id}`),
    onSuccess: (res) => {
      toast.success('Role deleted', res.message);
      setConfirmDelete(null);
      void qc.invalidateQueries({ queryKey: ['roles'] });
    },
    onError: (err) => { toast.fromError(err); setConfirmDelete(null); },
  });

  const toggle = (permissionId: number) => {
    if (!editing) return;
    setEditing({
      ...editing,
      permissionIds: editing.permissionIds.includes(permissionId)
        ? editing.permissionIds.filter((p) => p !== permissionId)
        : [...editing.permissionIds, permissionId],
    });
  };

  const toggleModule = (m: PermissionModule) => {
    if (!editing) return;
    const ids = m.permissions.map((p) => p.id);
    const allOn = ids.every((i) => editing.permissionIds.includes(i));
    setEditing({
      ...editing,
      permissionIds: allOn
        ? editing.permissionIds.filter((i) => !ids.includes(i))
        : [...new Set([...editing.permissionIds, ...ids])],
    });
  };

  return (
    <>
      <PageHeader
        title="Roles & Permissions"
        subtitle="What each role may do — enforced on the server for every request"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Roles & Permissions' }]}
        actions={
          can('role.create') ? (
            <Button variant="primary" size="sm" icon={<Plus size={14} />}
                    onClick={() => { setEditing({ ...EMPTY }); setErrors({}); }}>
              New Role
            </Button>
          ) : undefined
        }
      />

      {roles.isLoading ? (
        <LoadingBlock />
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 'var(--sp-4)' }}>
          {(roles.data ?? []).map((r) => (
            <Card key={r.id} onClick={() => setDetailId(r.id)}>
              <CardBody>
                <div className="row" style={{ gap: 10, marginBottom: 10 }}>
                  <span
                    style={{
                      width: 38, height: 38, borderRadius: 'var(--radius-sm)', flexShrink: 0,
                      background: r.code === 'SUPER_ADMIN' ? 'var(--danger-50)' : 'var(--brand-50)',
                      color: r.code === 'SUPER_ADMIN' ? 'var(--danger-600)' : 'var(--brand-600)',
                      display: 'grid', placeItems: 'center',
                      border: `1px solid ${r.code === 'SUPER_ADMIN' ? 'var(--danger-100)' : 'var(--brand-100)'}`,
                    }}
                  >
                    <ShieldCheck size={18} />
                  </span>
                  <div className="grow" style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 6 }}>
                      <span className="cell-strong truncate" style={{ fontSize: 'var(--text-md)' }}>{r.name}</span>
                      {r.is_system && <Badge tone="info" plain><Lock size={9} /> System</Badge>}
                    </div>
                    <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{r.code}</div>
                  </div>
                </div>

                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.6, minHeight: 34 }}>
                  {text(r.description)}
                </p>

                <div className="row" style={{ gap: 'var(--sp-4)', marginTop: 'var(--sp-3)', paddingTop: 'var(--sp-3)', borderTop: '1px solid var(--border-subtle)' }}>
                  <span className="row" style={{ gap: 5, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    <UsersIcon size={12} /> <strong className="num" style={{ color: 'var(--ink-700)' }}>{count(r.user_count)}</strong> users
                  </span>
                  <span className="row" style={{ gap: 5, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    <ShieldCheck size={12} /> <strong className="num" style={{ color: 'var(--ink-700)' }}>{count(r.permission_count)}</strong> permissions
                  </span>
                  <div className="spacer" />
                  <div className="row" style={{ gap: 1 }} onClick={(e) => e.stopPropagation()}>
                    {can('role.edit') && r.code !== 'SUPER_ADMIN' && (
                      <Button variant="ghost" size="sm" title="Edit"
                              onClick={() => { setEditing({
                                id: r.id, code: r.code, name: r.name, description: r.description,
                                isActive: r.is_active, permissionIds: [], isSystem: r.is_system,
                              }); setErrors({}); }}>
                        <Pencil size={13} />
                      </Button>
                    )}
                    {can('role.delete') && !r.is_system && (
                      <Button variant="ghost" size="sm" title="Delete" onClick={() => setConfirmDelete(r)}>
                        <Trash2 size={13} />
                      </Button>
                    )}
                  </div>
                </div>
              </CardBody>
            </Card>
          ))}
        </div>
      )}

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        wide
        title={detail.data?.name ?? 'Role'}
        subtitle={detail.data?.code}
      >
        {detail.isLoading ? <LoadingBlock /> : detail.data ? (
          <div className="stack" style={{ gap: 'var(--sp-6)' }}>
            <DetailGrid cols={3}>
              <DetailItem label="Code" mono>{detail.data.code}</DetailItem>
              <DetailItem label="Users assigned">{count(detail.data.users.length)}</DetailItem>
              <DetailItem label="Permissions">{count(detail.data.permissions.length)}</DetailItem>
              <div style={{ gridColumn: '1 / -1' }}>
                <DetailItem label="Description">{text(detail.data.description)}</DetailItem>
              </div>
            </DetailGrid>

            <div>
              <SectionTitle>Permissions granted</SectionTitle>
              {detail.data.permissions.length === 0 ? (
                <EmptyState title="No permissions granted" message="This role currently grants no access." />
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 'var(--sp-3)' }}>
                  {(modules.data ?? []).map((m) => {
                    const granted = m.permissions.filter((p) => detail.data!.permissionCodes.includes(p.code));
                    if (granted.length === 0) return null;
                    return (
                      <div key={m.module} style={{ padding: 'var(--sp-3)', border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--bg-inset)' }}>
                        <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-700)', marginBottom: 6 }}>
                          {m.label}
                          <span style={{ color: 'var(--text-faint)', fontWeight: 400 }}> · {granted.length}/{m.permissions.length}</span>
                        </div>
                        <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                          {granted.map((p) => <Badge key={p.id} tone="success" plain>{p.action}</Badge>)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <SectionTitle>Users with this role</SectionTitle>
              {detail.data.users.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No users assigned.</div>
              ) : (
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead><tr><th>Employee ID</th><th>Name</th><th>Designation</th><th className="center">Status</th></tr></thead>
                    <tbody>
                      {detail.data.users.map((u) => (
                        <tr key={u.id}>
                          <td className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{u.employee_id}</td>
                          <td className="cell-strong">{u.employee_name}</td>
                          <td className="cell-muted">{text(u.designation)}</td>
                          <td className="center"><Badge tone={u.is_active ? 'success' : 'neutral'}>{u.is_active ? 'Active' : 'Inactive'}</Badge></td>
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
        title={editing?.id ? 'Edit role' : 'New role'}
        subtitle="Grant only what the role genuinely needs"
        size="xl"
        footer={
          <>
            <span className="grow" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {editing?.permissionIds.length ?? 0} permission(s) selected
            </span>
            <Button variant="ghost" onClick={() => { setEditing(null); setErrors({}); }}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              {editing?.id ? 'Save changes' : 'Create role'}
            </Button>
          </>
        }
      >
        {editing && (
          <>
            <div className="form-grid" style={{ marginBottom: 'var(--sp-5)' }}>
              <Field label="Role code" required error={errors.code}
                     hint={editing.isSystem ? 'System roles keep their code' : 'Uppercase, e.g. SITE_ENGINEER'}>
                <Input value={editing.code}
                       onChange={(e) => setEditing({ ...editing, code: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })}
                       invalid={Boolean(errors.code)} disabled={editing.isSystem}
                       style={{ fontFamily: 'var(--font-mono)' }} />
              </Field>
              <Field label="Role name" required error={errors.name}>
                <Input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                       invalid={Boolean(errors.name)} />
              </Field>
              <Field label="Description" span="full" error={errors.description}>
                <Textarea value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={2} />
              </Field>
              <div className="field-span-full">
                <Checkbox label="Active — the role can be assigned and grants access"
                          checked={editing.isActive} onChange={(v) => setEditing({ ...editing, isActive: v })} />
              </div>
            </div>

            <SectionTitle>Permissions</SectionTitle>
            {editingRole.isLoading ? <LoadingBlock height={200} /> : (
              <div className="stack" style={{ gap: 'var(--sp-3)' }}>
                {(modules.data ?? []).map((m) => {
                  const ids = m.permissions.map((p) => p.id);
                  const on = ids.filter((i) => editing.permissionIds.includes(i)).length;
                  const all = on === ids.length;
                  const some = on > 0 && !all;
                  return (
                    <div key={m.module} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                      <button
                        onClick={() => toggleModule(m)}
                        className="row"
                        style={{
                          gap: 9, width: '100%', padding: 'var(--sp-3) var(--sp-4)',
                          background: all ? 'var(--brand-50)' : 'var(--bg-inset)',
                          borderBottom: '1px solid var(--border-subtle)',
                        }}
                      >
                        <span
                          style={{
                            width: 15, height: 15, borderRadius: 3, flexShrink: 0,
                            border: `1.5px solid ${all || some ? 'var(--brand-500)' : 'var(--ink-300)'}`,
                            background: all ? 'var(--brand-500)' : some ? 'var(--brand-100)' : 'transparent',
                            display: 'grid', placeItems: 'center', color: '#fff',
                          }}
                        >
                          {all ? <Check size={11} strokeWidth={3} /> : some ? <Minus size={11} strokeWidth={3} style={{ color: 'var(--brand-600)' }} /> : null}
                        </span>
                        <span className="grow" style={{ textAlign: 'left', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>
                          {m.label}
                        </span>
                        <span className="num" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                          {on}/{ids.length}
                        </span>
                      </button>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))', gap: 2, padding: 'var(--sp-2)' }}>
                        {m.permissions.map((p) => (
                          <label key={p.id} className="check-row" style={{ padding: '5px 8px', borderRadius: 'var(--radius-xs)', alignItems: 'flex-start' }}
                                 title={p.description}>
                            <input type="checkbox" className="checkbox" style={{ marginTop: 2 }}
                                   checked={editing.permissionIds.includes(p.id)}
                                   onChange={() => toggle(p.id)} />
                            <span style={{ minWidth: 0 }}>
                              <span style={{ display: 'block', fontSize: 'var(--text-xs)', fontWeight: 500, textTransform: 'capitalize', color: 'var(--ink-800)' }}>
                                {p.action}
                              </span>
                              <span className="truncate" style={{ display: 'block', fontSize: '10px', color: 'var(--text-muted)' }}>
                                {p.description}
                              </span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </>
        )}
      </Modal>

      <ConfirmDialog
        open={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        onConfirm={() => confirmDelete && remove.mutate(confirmDelete)}
        title="Delete role?"
        confirmLabel="Delete"
        loading={remove.isPending}
        message={
          <>
            <strong>{confirmDelete?.name}</strong> will be permanently deleted.
            <br /><br />
            A role that is still assigned to users cannot be deleted — reassign them first.
          </>
        }
      />
    </>
  );
}
