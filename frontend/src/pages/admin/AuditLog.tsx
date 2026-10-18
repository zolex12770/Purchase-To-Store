/**
 * Audit Log viewer (SRS §17, §24).
 *
 * The before/after diff is the point of an audit trail — showing only "UPDATE"
 * would tell an auditor nothing.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Download, Eye, Filter } from 'lucide-react';
import { api, qs, type PageMeta } from '../../lib/api';
import { useDownload } from '../../lib/useDownload';
import { useAuth } from '../../lib/auth';
import { useFilters } from '../../lib/useFilters';
import { PageHeader } from '../../layout/AppShell';
import { DataTable, type Column } from '../../components/DataTable';
import {
  Button, Badge, Drawer, DetailItem, DetailGrid, SectionTitle, LoadingBlock, Select,
} from '../../components/ui';
import { formatDateTime, relativeTime, text } from '../../lib/format';

interface AuditRow {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  entity_label: string | null;
  source: string;
  result: string;
  message: string | null;
  ip_address: string | null;
  created_at: string;
  request_id: string | null;
  actor_user_id: number | null;
  actor_employee_id: string | null;
  actor_name: string | null;
  has_detail: boolean;
}

interface AuditDetail extends AuditRow {
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  user_agent: string | null;
}

interface Facets {
  actions: { value: string; count: number }[];
  entities: { value: string; count: number }[];
  sources: { value: string; count: number }[];
  actors: { value: number | null; label: string; count: number }[];
}

const ACTION_TONE: Record<string, 'success' | 'danger' | 'warning' | 'info' | 'neutral' | 'progress'> = {
  LOGIN: 'success', LOGOUT: 'neutral', LOGIN_FAILED: 'danger',
  CREATE: 'success', UPDATE: 'info', DELETE: 'danger',
  APPROVE: 'success', REJECT: 'danger', CANCEL: 'danger',
  SUBMIT: 'info', ISSUE: 'info', POST: 'success', CLOSE: 'warning', REOPEN: 'warning',
  IMPORT: 'progress', EXPORT: 'neutral', SYNC: 'progress', SYNC_TOGGLE: 'warning',
  BACKUP: 'info', RESTORE_BACKUP: 'danger',
  PASSWORD_CHANGE: 'warning', PASSWORD_RESET: 'warning',
  PERMISSION_CHANGE: 'danger', SETTING_CHANGE: 'warning', ROLE_ASSIGN: 'info',
};

export default function AuditLog() {
  const download = useDownload();
  const { can } = useAuth();
  const { filters, setFilters, clearFilters, activeCount } = useFilters();
  const [detailId, setDetailId] = useState<number | null>(null);

  const query = qs({
    page: filters.page, pageSize: filters.pageSize, search: filters.search,
    action: filters.action, entity: filters.entity, source: filters.source,
    actorUserId: filters.actorUserId, dateFrom: filters.dateFrom, dateTo: filters.dateTo,
  });

  const list = useQuery({
    queryKey: ['audit', query],
    queryFn: () => api.getWithMeta<AuditRow[], PageMeta>(`/audit${query}`),
  });

  const facets = useQuery({ queryKey: ['audit', 'facets'], queryFn: () => api.get<Facets>('/audit/facets') });

  const detail = useQuery({
    queryKey: ['audit', detailId],
    queryFn: () => api.get<AuditDetail>(`/audit/${detailId}`),
    enabled: detailId !== null,
  });

  const columns: Column<AuditRow>[] = [
    {
      key: 'time', header: 'When', width: '160px',
      render: (r) => (
        <div>
          <div>{formatDateTime(r.created_at)}</div>
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)' }}>{relativeTime(r.created_at)}</div>
        </div>
      ),
    },
    {
      key: 'actor', header: 'User',
      render: (r) => (
        <div>
          <div className="cell-strong">{text(r.actor_name)}</div>
          {r.actor_employee_id && (
            <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>{r.actor_employee_id}</div>
          )}
        </div>
      ),
    },
    {
      key: 'action', header: 'Action', align: 'center',
      render: (r) => <Badge tone={ACTION_TONE[r.action] ?? 'neutral'}>{r.action.replace(/_/g, ' ')}</Badge>,
    },
    { key: 'entity', header: 'Entity', render: (r) => <span className="cell-muted">{r.entity.replace(/_/g, ' ')}</span> },
    {
      key: 'record', header: 'Record',
      render: (r) => <span className="cell-strong truncate" style={{ maxWidth: 220, display: 'block' }}>{text(r.entity_label)}</span>,
    },
    {
      key: 'message', header: 'Detail',
      render: (r) => <span className="cell-muted truncate" style={{ maxWidth: 340, display: 'block' }}>{text(r.message)}</span>,
    },
    { key: 'source', header: 'Source', align: 'center', optional: true, render: (r) => <Badge tone="neutral" plain>{r.source}</Badge> },
    {
      key: 'result', header: 'Result', align: 'center',
      render: (r) => <Badge tone={r.result === 'SUCCESS' ? 'success' : r.result === 'PARTIAL' ? 'warning' : 'danger'}>{r.result}</Badge>,
    },
    { key: 'ip', header: 'IP', optional: true, render: (r) => <span className="mono" style={{ fontSize: 'var(--text-2xs)' }}>{text(r.ip_address)}</span> },
    {
      key: 'view', header: '', align: 'right', locked: true, width: '48px',
      render: (r) => (
        <Button variant="ghost" size="sm" title="View full record"
                onClick={(e) => { e.stopPropagation(); setDetailId(r.id); }}>
          <Eye size={13} />
        </Button>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Audit Log"
        subtitle="Every critical action — who did it, when, and exactly what changed"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Audit Log' }]}
        actions={
          can('audit.export') ? (
            <Button variant="secondary" size="sm" icon={<Download size={13} />}
                    onClick={() => void download(`/io/export/audit?format=xlsx${query.replace('?', '&')}`, 'audit-log.xlsx')}>
              Export
            </Button>
          ) : undefined
        }
      />

      <DataTable
        columns={columns}
        rows={list.data?.data ?? []}
        rowKey={(r) => r.id}
        loading={list.isLoading}
        error={list.error}
        onRetry={() => void list.refetch()}
        storageKey="audit"
        search={filters.search as string}
        onSearchChange={(v) => setFilters({ search: v || undefined })}
        searchPlaceholder="Search record, user, message…"
        meta={list.data?.meta}
        onPageChange={(p) => setFilters({ page: p }, { resetPage: false })}
        onPageSizeChange={(pageSize) => setFilters({ pageSize })}
        onRowClick={(r) => setDetailId(r.id)}
        selectedKey={detailId}
        onExport={can('audit.export') ? (format) => void download(`/io/export/audit?format=${format}${query.replace('?', '&')}`, `audit-log.${format}`) : undefined}
        emptyTitle="No audit records"
        emptyMessage={activeCount > 0 ? 'No records match the current filters.' : 'Audit records appear as soon as work happens in the system.'}
        compact
        toolbar={
          <>
            <Select className="input-sm" style={{ width: 150, height: 30 }}
                    value={(filters.action as string[])?.[0] ?? ''}
                    onChange={(e) => setFilters({ action: e.target.value ? [e.target.value] : undefined })}
                    aria-label="Action filter">
              <option value="">All actions</option>
              {(facets.data?.actions ?? []).map((a) => (
                <option key={a.value} value={a.value}>{a.value.replace(/_/g, ' ')} ({a.count})</option>
              ))}
            </Select>
            <Select className="input-sm" style={{ width: 155, height: 30 }}
                    value={(filters.entity as string[])?.[0] ?? ''}
                    onChange={(e) => setFilters({ entity: e.target.value ? [e.target.value] : undefined })}
                    aria-label="Entity filter">
              <option value="">All entities</option>
              {(facets.data?.entities ?? []).map((a) => (
                <option key={a.value} value={a.value}>{a.value.replace(/_/g, ' ')} ({a.count})</option>
              ))}
            </Select>
            <Select className="input-sm" style={{ width: 130, height: 30 }}
                    value={(filters.source as string[])?.[0] ?? ''}
                    onChange={(e) => setFilters({ source: e.target.value ? [e.target.value] : undefined })}
                    aria-label="Source filter">
              <option value="">All sources</option>
              {(facets.data?.sources ?? []).map((a) => <option key={a.value} value={a.value}>{a.value}</option>)}
            </Select>
            <Select className="input-sm" style={{ width: 150, height: 30 }}
                    value={(filters.userId as string[])?.[0] ?? (filters.actorUserId as string[])?.[0] ?? ''}
                    onChange={(e) => setFilters({ actorUserId: e.target.value ? [e.target.value] : undefined, userId: e.target.value ? [e.target.value] : undefined })}
                    aria-label="User filter">
              <option value="">All users</option>
              {(facets.data?.actors ?? []).map((a) => (
                <option key={a.value} value={a.value ?? ''}>{a.label} ({a.count})</option>
              ))}
            </Select>
            <input type="date" className="input input-sm" style={{ width: 138 }}
                   value={(filters.dateFrom as string) ?? ''}
                   onChange={(e) => setFilters({ dateFrom: e.target.value || undefined })}
                   aria-label="From date" />
            <input type="date" className="input input-sm" style={{ width: 138 }}
                   value={(filters.dateTo as string) ?? ''}
                   onChange={(e) => setFilters({ dateTo: e.target.value || undefined })}
                   aria-label="To date" />
            {activeCount > 0 && (
              <Button variant="ghost" size="sm" icon={<Filter size={13} />} onClick={() => clearFilters()}>Clear</Button>
            )}
          </>
        }
      />

      <Drawer
        open={detailId !== null}
        onClose={() => setDetailId(null)}
        wide
        title="Audit record"
        subtitle={detail.data ? `${detail.data.action.replace(/_/g, ' ')} · ${detail.data.entity.replace(/_/g, ' ')}` : undefined}
      >
        {detail.isLoading ? <LoadingBlock /> : detail.data ? (
          <div className="stack" style={{ gap: 'var(--sp-6)' }}>
            <DetailGrid cols={2}>
              <DetailItem label="Timestamp">{formatDateTime(detail.data.created_at)}</DetailItem>
              <DetailItem label="Action"><Badge tone={ACTION_TONE[detail.data.action] ?? 'neutral'}>{detail.data.action.replace(/_/g, ' ')}</Badge></DetailItem>
              <DetailItem label="User">{text(detail.data.actor_name)}</DetailItem>
              <DetailItem label="Employee ID" mono>{text(detail.data.actor_employee_id)}</DetailItem>
              <DetailItem label="Entity">{detail.data.entity.replace(/_/g, ' ')}</DetailItem>
              <DetailItem label="Record">{text(detail.data.entity_label)}</DetailItem>
              <DetailItem label="Source"><Badge tone="neutral" plain>{detail.data.source}</Badge></DetailItem>
              <DetailItem label="Result">
                <Badge tone={detail.data.result === 'SUCCESS' ? 'success' : 'danger'}>{detail.data.result}</Badge>
              </DetailItem>
              <DetailItem label="IP address" mono>{text(detail.data.ip_address)}</DetailItem>
              <DetailItem label="Request ID" mono>{text(detail.data.request_id)}</DetailItem>
              {detail.data.message && (
                <div style={{ gridColumn: '1 / -1' }}><DetailItem label="Message">{detail.data.message}</DetailItem></div>
              )}
              {detail.data.user_agent && (
                <div style={{ gridColumn: '1 / -1' }}>
                  <DetailItem label="User agent">
                    <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', wordBreak: 'break-all' }}>
                      {detail.data.user_agent}
                    </span>
                  </DetailItem>
                </div>
              )}
            </DetailGrid>

            {(detail.data.before_data || detail.data.after_data) && (
              <div>
                <SectionTitle>What changed</SectionTitle>
                <DiffView before={detail.data.before_data} after={detail.data.after_data} />
              </div>
            )}
          </div>
        ) : null}
      </Drawer>
    </>
  );
}

/** Side-by-side before/after with changed keys highlighted. */
function DiffView({
  before, after,
}: { before: Record<string, unknown> | null; after: Record<string, unknown> | null }) {
  const keys = [...new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})])].sort();

  const render = (v: unknown): string => {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'object') return JSON.stringify(v);
    if (typeof v === 'boolean') return v ? 'Yes' : 'No';
    return String(v);
  };

  return (
    <div className="table-wrap" style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)' }}>
      <table className="table table-compact">
        <thead>
          <tr>
            <th style={{ width: '26%' }}>Field</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => {
            const b = before?.[k];
            const a = after?.[k];
            const changed = render(b) !== render(a);
            return (
              <tr key={k} style={changed ? { background: 'var(--warning-50)' } : undefined}>
                <td className="cell-strong" style={{ fontSize: 'var(--text-2xs)' }}>{k}</td>
                <td style={{ fontSize: 'var(--text-2xs)', color: changed ? 'var(--danger-700)' : 'var(--text-muted)', wordBreak: 'break-word' }}>
                  {render(b)}
                </td>
                <td style={{ fontSize: 'var(--text-2xs)', color: changed ? 'var(--success-700)' : 'var(--text-muted)', fontWeight: changed ? 600 : 400, wordBreak: 'break-word' }}>
                  {render(a)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
