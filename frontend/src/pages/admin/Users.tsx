/**
 * User Management (SRS §17).
 */
import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Pencil, KeyRound, Unlock, UserX, Download, ShieldCheck, Clock, Lock,
} from 'lucide-react';
import { api, qs, ApiError, type PageMeta } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { useToast } from '../../components/Toast';
import { useLookupOptions } from '../../lib/masters';
import { PageHeader } from '../../layout/AppShell';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Modal, Field, Input, Select, Checkbox, Badge, ConfirmDialog,
  Drawer, DetailItem, DetailGrid, SectionTitle, LoadingBlock, EmptyState,
} from '../../components/ui';
import { StatTile } from '../../components/KpiCard';
import { formatDateTime, relativeTime, text, initials, count } from '../../lib/format';

interface Role { id: number; code: string; name: string }
interface UserRow {
  id: number;
  employee_id: string;
  employee_name: string;
  designation: string;
  email: string | null;
  mobile_no: string | null;
  department_id: number | null;
  department_name: string | null;
  is_active: boolean;
  must_change_password: boolean;
  last_login_at: string | null;
  locked_until: string | null;
  roles: Role[];
}
interface UserDetail extends UserRow {
  recentActivity: { action: string; entity: string; entity_label: string | null; created_at: string; result: string }[];
  activeSessions: { id: number; issued_at: string; expires_at: string; ip_address: string | null; user_agent: string | null }[];
}

interface Draft {
  id?: number;
  employeeId: string;
  employeeName: string;
  designation: string;
  email: string;
  mobileNo: string;
  departmentId: number | null;
  password: string;
  mustChangePassword: boolean;
  isActive: boolean;
  roleIds: number[];
}

// The administrator knows the first password they type, so by default the user
// must replace it at first sign-in. This was false, and the reset below always
// sent false, so administrator-chosen passwords stayed in use indefinitely.
const EMPTY: Draft = {
  employeeId: '', employeeName: '', designation: '', email: '', mobileNo: '',
  departmentId: null, password: '', mustChangePassword: true, isActive: true, roleIds: [],
};

/**
 * Shown in an empty password field instead of an example: administrators reused
 * the example this field used to show as the real password of live accounts.
 */
const PASSWORD_HINT = 'At least 8 characters with upper and lower case, a digit and a symbol';
const PASSWORD_RULES = 'Choose one for this person alone, never an example or a shared password. It may not contain the Employee ID.';

export default function Users() {
  const { can, user: me, isSuperAdmin } = useAuth();
  const toast = useToast();
  const download = useDownload();
  const qc = useQueryClient();
  const { filters, setFilters } = useFilters();

  const [editing, setEditing] = useState<Draft | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [detailId, setDetailId] = useState<number | null>(null);
  const [resetting, setResetting] = useState<UserRow | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [resetMustChange, setResetMustChange] = useState(true);
  const [deactivating, setDeactivating] = useState<UserRow | null>(null);

  const { options: departments } = useLookupOptions('DEPARTMENT');

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    sortBy: filters.sortBy, sortDir: filters.sortDir, isActive: filters.isActive, roleId: filters.roleId,
  });

  const list = useQuery({
    queryKey: ['users', query],
    queryFn: () => api.getWithMeta<UserRow[], PageMeta & {
      totals?: {
        totalUsers: number;
        activeUsers: number;
        inactiveUsers: number;
      };
    }>(`/users${query}`),
  });

  const roles = useQuery({
    queryKey: ['roles'],
    queryFn: () => api.get<{ id: number; code: string; name: string; description: string }[]>('/roles'),
    enabled: can('role.view') || can('user.create'),
  });

  const detail = useQuery({
    queryKey: ['user', detailId],
    queryFn: () => api.get<UserDetail>(`/users/${detailId}`),
    enabled: detailId !== null,
  });

  const save = useMutation({
    mutationFn: (d: Draft) =>
      d.id
        ? api.put<UserRow>(`/users/${d.id}`, {
            employeeId: d.employeeId, employeeName: d.employeeName, designation: d.designation,
            email: d.email, mobileNo: d.mobileNo, departmentId: d.departmentId,
            isActive: d.isActive, roleIds: d.roleIds,
          })
        : api.post<UserRow>('/users', d),
    onSuccess: (_, d) => {
      toast.success(d.id ? 'User updated' : 'User created', `${d.employeeId} — ${d.employeeName}`);
      setEditing(null); setErrors({});
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  const reset = useMutation({
    mutationFn: ({ u, pw, mustChange }: { u: UserRow; pw: string; mustChange: boolean }) =>
      api.post<{ message: string }>(`/users/${u.id}/reset-password`, { newPassword: pw, mustChangePassword: mustChange }),
    onSuccess: (res) => {
      toast.success('Password reset', res.message);
      setResetting(null); setNewPassword('');
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const unlock = useMutation({
    mutationFn: (u: UserRow) => api.post<{ message: string }>(`/users/${u.id}/unlock`, {}),
    onSuccess: (res) => {
      toast.success('Account unlocked', res.message);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const deactivate = useMutation({
    mutationFn: (u: UserRow) => api.del<{ message: string }>(`/users/${u.id}`),
    onSuccess: (res) => {
      toast.warning('User deactivated', res.message);
      setDeactivating(null);
      void qc.invalidateQueries({ queryKey: ['users'] });
    },
    onError: (err) => { toast.fromError(err); setDeactivating(null); },
  });

  const columns: Column<UserRow>[] = [
    {
      key: 'employee', header: 'Employee', sortKey: 'employeeName',
      render: (u) => (
        <div className="row" style={{ gap: 9 }}>
          <span
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: u.is_active ? 'var(--grad-brand)' : 'var(--ink-300)',
              color: '#fff', display: 'grid', placeItems: 'center',
              fontSize: 'var(--text-2xs)', fontWeight: 700,
            }}
          >
            {initials(u.employee_name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="cell-strong truncate">{u.employee_name}</div>
            <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{u.employee_id}</div>
          </div>
        </div>
      ),
    },
    { key: 'designation', header: 'Designation', sortKey: 'designation', render: (u) => text(u.designation) },
    { key: 'department', header: 'Department', render: (u) => text(u.department_name) },
    { key: 'email', header: 'Email', optional: true, render: (u) => <span className="truncate" style={{ maxWidth: 200, display: 'block' }}>{text(u.email)}</span> },
    { key: 'mobile', header: 'Mobile', optional: true, render: (u) => <span className="num">{text(u.mobile_no)}</span> },
    {
      key: 'roles', header: 'Roles',
      render: (u) => (
        <div className="row" style={{ gap: 3, flexWrap: 'wrap' }}>
          {u.roles.length === 0
            ? <span className="cell-muted">—</span>
            : u.roles.map((r) => (
                <Badge key={r.id} tone={r.code === 'SUPER_ADMIN' ? 'danger' : 'info'} plain>{r.name}</Badge>
              ))}
        </div>
      ),
    },
    {
      key: 'lastLogin', header: 'Last Sign-in', sortKey: 'lastLoginAt', align: 'right',
      render: (u) => <span className="cell-muted">{u.last_login_at ? relativeTime(u.last_login_at) : 'Never'}</span>,
    },
    {
      key: 'status', header: 'Status', align: 'center',
      render: (u) => {
        const locked = u.locked_until && new Date(u.locked_until) > new Date();
        return (
          <div className="row" style={{ gap: 3, justifyContent: 'center', flexWrap: 'wrap' }}>
            <Badge tone={u.is_active ? 'success' : 'neutral'}>{u.is_active ? 'Active' : 'Inactive'}</Badge>
            {locked && <Badge tone="danger">Locked</Badge>}
            {u.must_change_password && <Badge tone="warning">Must reset</Badge>}
          </div>
        );
      },
    },
    {
      key: 'actions', header: '', align: 'right', locked: true, width: '124px',
      render: (u) => {
        const locked = u.locked_until && new Date(u.locked_until) > new Date();
        // Only a Super Admin may change a Super Admin's account; the server refuses anyone else.
        const mayChange = isSuperAdmin || !u.roles.some((r) => r.code === 'SUPER_ADMIN');
        if (!mayChange) {
          return (can('user.edit') || can('user.delete')) ? (
            <span className="row" style={{ justifyContent: 'flex-end', color: 'var(--text-muted)' }}
                  title="Only a Super Admin can change a Super Admin account">
              <Lock size={13} />
            </span>
          ) : null;
        }
        return (
          <div className="row" style={{ gap: 1, justifyContent: 'flex-end' }} onClick={(e) => e.stopPropagation()}>
            {can('user.edit') && (
              <Button variant="ghost" size="sm" title="Edit"
                      onClick={() => setEditing({
                        id: u.id, employeeId: u.employee_id, employeeName: u.employee_name,
                        designation: u.designation, email: u.email ?? '', mobileNo: u.mobile_no ?? '',
                        departmentId: u.department_id, password: '', mustChangePassword: false,
                        isActive: u.is_active, roleIds: u.roles.map((r) => r.id),
                      })}>
                <Pencil size={13} />
              </Button>
            )}
            {can('user.edit') && (
              <Button variant="ghost" size="sm" title="Reset password"
                      onClick={() => { setResetting(u); setNewPassword(''); setResetMustChange(true); }}>
                <KeyRound size={13} />
              </Button>
            )}
            {can('user.edit') && locked && (
              <Button variant="ghost" size="sm" title="Unlock account" onClick={() => unlock.mutate(u)}>
                <Unlock size={13} style={{ color: 'var(--warning-600)' }} />
              </Button>
            )}
            {can('user.delete') && u.is_active && u.id !== me?.id && (
              <Button variant="ghost" size="sm" title="Deactivate" onClick={() => setDeactivating(u)}>
                <UserX size={13} style={{ color: 'var(--danger-600)' }} />
              </Button>
            )}
          </div>
        );
      },
    },
  ];

  const toggleRole = (roleId: number) => {
    if (!editing) return;
    setEditing({
      ...editing,
      roleIds: editing.roleIds.includes(roleId)
        ? editing.roleIds.filter((r) => r !== roleId)
        : [...editing.roleIds, roleId],
    });
  };

  return (
    <>
      <PageHeader
        title="User Management"
        subtitle="Employees, their roles and account security"
        breadcrumbs={[{ label: 'Admin' }, { label: 'User Management' }]}
        actions={
          <>
            {can('user.export') && (
              <Button variant="secondary" size="sm" icon={<Download size={13} />}
                      onClick={() => void download(`/io/export/users?format=xlsx${query.replace('?', '&')}`, 'users.xlsx')}>
                Export
              </Button>
            )}
            {can('user.create') && (
              <Button variant="primary" size="sm" icon={<Plus size={14} />}
                      onClick={() => { setEditing({ ...EMPTY }); setErrors({}); }}>
                New User
              </Button>
            )}
          </>
        }
      />

      {list.data?.meta && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 'var(--sp-3)', marginBottom: 'var(--sp-4)' }}>
          <StatTile label="Total Users" value={count(list.data.meta.totals?.totalUsers ?? list.data.meta.total ?? 0)} />
          <StatTile label="Active Users" value={count(list.data.meta.totals?.activeUsers ?? 0)} tone="success" />
          <StatTile label="Inactive Users" value={count(list.data.meta.totals?.inactiveUsers ?? 0)} tone="default" />
        </div>
      )}

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(u) => u.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="users"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search name, employee ID, designation…"
        sortBy={filters.sortBy as string}
        sortDir={filters.sortDir as 'asc' | 'desc'}
        onSortChange={(sortBy, sortDir) => setFilters({ sortBy, sortDir })}
        meta={list.data?.meta}
        onPageChange={(p) => setFilters({ page: p }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(u) => setDetailId(u.id)}
        selectedKey={detailId}
        onExport={can('user.export') ? (format) => void download(`/io/export/users?format=${format}${query.replace('?', '&')}`, `users.${format}`) : undefined}
        emptyTitle="No users found"
        toolbar={
          <>
            <Select className="input-sm" style={{ width: 150, height: 30 }}
                    value={(filters.roleId as string[])?.[0] ?? ''}
                    onChange={(e) => setFilters({ roleId: e.target.value ? [e.target.value] : undefined })}
                    aria-label="Role filter">
              <option value="">All roles</option>
              {(roles.data ?? []).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
            <Select className="input-sm" style={{ width: 120, height: 30 }}
                    value={(filters.isActive as string) ?? ''}
                    onChange={(e) => setFilters({ isActive: e.target.value || undefined })}
                    aria-label="Status filter">
              <option value="">All status</option>
              <option value="true">Active</option>
              <option value="false">Inactive</option>
            </Select>
          </>
        }
      />

      {/* ── Detail drawer ─────────────────────────────────────────────────── */}
      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        title={detail.data?.employee_name ?? 'User'}
        subtitle={detail.data ? `${detail.data.employee_id} · ${detail.data.designation || 'No designation'}` : undefined}
      >
        {detail.isLoading ? <LoadingBlock /> : detail.data ? (
          <div className="stack" style={{ gap: 'var(--sp-6)' }}>
            <div>
              <SectionTitle>Account</SectionTitle>
              <DetailGrid cols={2}>
                <DetailItem label="Employee ID" mono>{detail.data.employee_id}</DetailItem>
                <DetailItem label="Designation">{text(detail.data.designation)}</DetailItem>
                <DetailItem label="Department">{text(detail.data.department_name)}</DetailItem>
                <DetailItem label="Email">{text(detail.data.email)}</DetailItem>
                <DetailItem label="Mobile">{text(detail.data.mobile_no)}</DetailItem>
                <DetailItem label="Last sign-in">
                  {detail.data.last_login_at ? formatDateTime(detail.data.last_login_at) : 'Never signed in'}
                </DetailItem>
                <DetailItem label="Status">
                  <Badge tone={detail.data.is_active ? 'success' : 'neutral'}>
                    {detail.data.is_active ? 'Active' : 'Inactive'}
                  </Badge>
                </DetailItem>
                <DetailItem label="Password">
                  {detail.data.must_change_password
                    ? <Badge tone="warning">Rotation required</Badge>
                    : <Badge tone="success">Set</Badge>}
                </DetailItem>
              </DetailGrid>
            </div>

            <div>
              <SectionTitle>Roles</SectionTitle>
              <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                {detail.data.roles.length === 0
                  ? <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>No roles assigned.</span>
                  : detail.data.roles.map((r) => (
                      <span key={r.id} className="row" style={{ gap: 6, padding: '6px 11px', borderRadius: 'var(--radius-sm)', background: 'var(--brand-50)', border: '1px solid var(--brand-100)', fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--brand-700)' }}>
                        <ShieldCheck size={13} /> {r.name}
                      </span>
                    ))}
              </div>
            </div>

            <div>
              <SectionTitle>Active sessions</SectionTitle>
              {detail.data.activeSessions.length === 0 ? (
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>No active sessions.</div>
              ) : (
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
                  <table className="table table-compact">
                    <thead><tr><th>Signed in</th><th>Expires</th><th>IP address</th></tr></thead>
                    <tbody>
                      {detail.data.activeSessions.map((s) => (
                        <tr key={s.id}>
                          <td>{formatDateTime(s.issued_at)}</td>
                          <td className="cell-muted">{formatDateTime(s.expires_at)}</td>
                          <td className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{text(s.ip_address)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div>
              <SectionTitle>Recent activity</SectionTitle>
              {detail.data.recentActivity.length === 0 ? (
                <EmptyState icon={<Clock />} title="No recorded activity" />
              ) : (
                <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', maxHeight: 320 }}>
                  <table className="table table-compact">
                    <thead><tr><th>Action</th><th>Entity</th><th>Record</th><th className="right">When</th></tr></thead>
                    <tbody>
                      {detail.data.recentActivity.map((a, i) => (
                        <tr key={i}>
                          <td><Badge tone={a.result === 'SUCCESS' ? 'neutral' : 'danger'} plain>{a.action}</Badge></td>
                          <td className="cell-muted">{a.entity}</td>
                          <td className="truncate" style={{ maxWidth: 180 }}>{text(a.entity_label)}</td>
                          <td className="right cell-muted">{relativeTime(a.created_at)}</td>
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
        title={editing?.id ? 'Edit user' : 'New user'}
        subtitle={editing?.id ? editing.employeeId : 'Set credentials for immediate sign-in'}
        size="lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setEditing(null); setErrors({}); }}>Cancel</Button>
            <Button variant="primary" loading={save.isPending} onClick={() => editing && save.mutate(editing)}>
              {editing?.id ? 'Save changes' : 'Create user'}
            </Button>
          </>
        }
      >
        {editing && (
          <div className="form-grid">
            <Field label="Employee ID" required error={errors.employeeId}>
              <Input value={editing.employeeId} onChange={(e) => setEditing({ ...editing, employeeId: e.target.value })}
                     invalid={Boolean(errors.employeeId)} style={{ fontFamily: 'var(--font-mono)' }} autoFocus />
            </Field>
            <Field label="Employee name" required error={errors.employeeName}>
              <Input value={editing.employeeName} onChange={(e) => setEditing({ ...editing, employeeName: e.target.value })}
                     invalid={Boolean(errors.employeeName)} />
            </Field>
            <Field label="Designation" error={errors.designation}>
              <Input value={editing.designation} onChange={(e) => setEditing({ ...editing, designation: e.target.value })} />
            </Field>
            <Field label="Department" error={errors.departmentId}>
              <Select value={editing.departmentId ?? ''} placeholder="Select department"
                      onChange={(e) => setEditing({ ...editing, departmentId: e.target.value ? Number(e.target.value) : null })}
                      options={departments} />
            </Field>
            <Field label="Email" error={errors.email}>
              <Input type="email" value={editing.email} onChange={(e) => setEditing({ ...editing, email: e.target.value })}
                     invalid={Boolean(errors.email)} />
            </Field>
            <Field label="Mobile" error={errors.mobileNo}>
              <Input value={editing.mobileNo} onChange={(e) => setEditing({ ...editing, mobileNo: e.target.value })} />
            </Field>

            {!editing.id && (
              <Field label="Initial password" required error={errors.password} span="full" hint={PASSWORD_RULES}>
                <Input type="text" value={editing.password}
                       onChange={(e) => setEditing({ ...editing, password: e.target.value })}
                       invalid={Boolean(errors.password)} placeholder={PASSWORD_HINT} />
              </Field>
            )}
            {!editing.id && (
              <div className="field-span-full">
                <Checkbox label="Must change this password at first sign-in"
                          checked={editing.mustChangePassword}
                          onChange={(v) => setEditing({ ...editing, mustChangePassword: v })} />
              </div>
            )}

            <div className="field-span-full">
              <label className="field-label" style={{ marginBottom: 6, display: 'block' }}>
                Roles <span className="req">*</span>
              </label>
              {errors.roleIds && <div className="field-error" style={{ marginBottom: 6 }}>{errors.roleIds}</div>}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 6 }}>
                {(roles.data ?? []).map((r) => {
                  const blocked = r.code === 'SUPER_ADMIN' && !isSuperAdmin;
                  return (
                    <label
                      key={r.id}
                      className="row"
                      style={{
                        gap: 9, padding: 'var(--sp-3)', borderRadius: 'var(--radius-sm)',
                        border: `1px solid ${editing.roleIds.includes(r.id) ? 'var(--brand-400)' : 'var(--border)'}`,
                        background: editing.roleIds.includes(r.id) ? 'var(--brand-50)' : 'var(--bg-surface)',
                        cursor: blocked ? 'not-allowed' : 'pointer',
                        opacity: blocked ? 0.55 : 1,
                        alignItems: 'flex-start',
                      }}
                      title={blocked ? 'Only a Super Admin can grant the Super Admin role' : undefined}
                    >
                      <input type="checkbox" className="checkbox" style={{ marginTop: 2 }}
                             disabled={blocked}
                             checked={editing.roleIds.includes(r.id)}
                             onChange={() => toggleRole(r.id)} />
                      <span style={{ minWidth: 0 }}>
                        <span style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>
                          {r.name}
                        </span>
                        <span style={{ display: 'block', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', lineHeight: 1.45 }}>
                          {r.description}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="field-span-full">
              <Checkbox label="Active — the user can sign in"
                        checked={editing.isActive}
                        onChange={(v) => setEditing({ ...editing, isActive: v })}
                        disabled={editing.id === me?.id} />
            </div>
          </div>
        )}
      </Modal>

      {/* ── Reset password ────────────────────────────────────────────────── */}
      <Modal
        open={resetting !== null}
        onClose={() => { setResetting(null); setNewPassword(''); }}
        title="Reset password"
        subtitle={resetting ? `${resetting.employee_id} — ${resetting.employee_name}` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setResetting(null); setNewPassword(''); }}>Cancel</Button>
            <Button variant="primary" loading={reset.isPending} disabled={newPassword.length < 8}
                    onClick={() => resetting && reset.mutate({ u: resetting, pw: newPassword, mustChange: resetMustChange })}>
              Reset password
            </Button>
          </>
        }
      >
        <Field label="New password" required hint={PASSWORD_RULES}>
          <Input type="text" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoFocus placeholder={PASSWORD_HINT} />
        </Field>
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Checkbox label="Must change this password at next sign-in"
                    checked={resetMustChange} onChange={setResetMustChange} />
        </div>
        <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.6 }}>
          {resetMustChange
            ? 'At their next sign-in they must replace it with a password of their own before they can do anything else.'
            : 'They can keep using it until they change it themselves on their profile.'}
          {' '}All of their active sessions are signed out immediately.
        </div>
      </Modal>

      <ConfirmDialog
        open={deactivating !== null}
        onClose={() => setDeactivating(null)}
        onConfirm={() => deactivating && deactivate.mutate(deactivating)}
        title="Deactivate user?"
        confirmLabel="Deactivate"
        loading={deactivate.isPending}
        message={
          <>
            <strong>{deactivating?.employee_name}</strong> will be signed out immediately and can no
            longer sign in.
            <br /><br />
            The account is retained rather than deleted so their indents, approvals and audit history
            remain attributable.
          </>
        }
      />
    </>
  );
}
