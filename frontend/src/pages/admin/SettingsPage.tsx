/**
 * System settings (SRS §17 configuration management).
 *
 * These are database rows, not constants, so company details, defaults and
 * retention can change without a deployment.
 */
import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Save, Settings as SettingsIcon, Building2, Sliders, HardDriveDownload, ShieldAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import { Button, Card, CardBody, CardHeader, Field, Input, Checkbox, LoadingBlock } from '../../components/ui';
import { formatDateTime } from '../../lib/format';

type SettingsMap = Record<string, unknown>;

interface SettingsMeta {
  descriptions: Record<string, string>;
  updatedAt: Record<string, string>;
  canEdit: boolean;
}

const GROUPS: { title: string; icon: React.ReactNode; subtitle: string; keys: string[] }[] = [
  {
    title: 'Company identity',
    icon: <Building2 size={16} />,
    subtitle: 'Appears on the application shell, printed documents and exported files',
    keys: ['company.brand', 'company.name', 'company.address', 'company.gst_no'],
  },
  {
    title: 'Transaction defaults',
    icon: <Sliders size={16} />,
    subtitle: 'Applied to new documents unless overridden',
    keys: ['defaults.currency'],
  },
  {
    title: 'Quantity controls',
    icon: <ShieldAlert size={16} />,
    subtitle: 'Leave both off unless your process genuinely requires an exception',
    keys: ['po.allow_over_order', 'grn.allow_over_receipt'],
  },
  {
    title: 'Form field configuration',
    icon: <Sliders size={16} />,
    subtitle: 'Optional fields beyond the core Purchase Indent / PO / GRN contract — core fields are never affected by this',
    keys: ['form_fields.indent.remarks_visible'],
  },
  {
    title: 'Backup retention',
    icon: <HardDriveDownload size={16} />,
    subtitle: 'Backups older than the retention period are eligible for pruning, but the minimum count is always kept',
    keys: ['backup.retention_days', 'backup.retention_count'],
  },
  {
    title: 'Google Sheets sync',
    icon: <SettingsIcon size={16} />,
    subtitle: 'The spreadsheet ID and credentials are set in the backend environment, not here',
    keys: ['google_sync.enabled', 'google_sync.interval_minutes'],
  },
];

const LABELS: Record<string, string> = {
  'company.brand': 'Brand name',
  'company.name': 'Legal entity name',
  'company.address': 'Registered address',
  'company.gst_no': 'Company GST number',
  'defaults.currency': 'Default currency',
  'backup.retention_days': 'Retention (days)',
  'backup.retention_count': 'Minimum backups retained',
  'po.allow_over_order': 'Allow PO quantity above eligible indent quantity',
  'grn.allow_over_receipt': 'Allow GRN quantity above outstanding PO quantity',
  'google_sync.enabled': 'Live Sync enabled',
  'google_sync.interval_minutes': 'Poll interval (minutes)',
  'form_fields.indent.remarks_visible': 'Show Remarks on Purchase Indent',
};

export default function SettingsPage() {
  const toast = useToast();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SettingsMap>({});
  const [dirty, setDirty] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['settings', 'admin'],
    queryFn: () => api.getWithMeta<SettingsMap, SettingsMeta>('/settings'),
  });

  useEffect(() => {
    if (data?.data) { setDraft(data.data); setDirty(false); }
  }, [data?.data]);

  const save = useMutation({
    mutationFn: (patch: SettingsMap) => api.put<SettingsMap>('/settings', patch),
    onSuccess: () => {
      toast.success('Settings saved', 'The new values take effect immediately.');
      setDirty(false);
      void qc.invalidateQueries({ queryKey: ['settings'] });
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (err) => toast.fromError(err),
  });

  const set = (key: string, value: unknown) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  };

  // Only send what actually changed, so an unrelated concurrent edit is not clobbered.
  const changed = Object.fromEntries(
    Object.entries(draft).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(data?.data[k])),
  );

  if (isLoading) return <LoadingBlock label="Loading settings…" />;

  return (
    <>
      <PageHeader
        title="System Settings"
        subtitle="Company identity, transactional defaults and operational policy"
        breadcrumbs={[{ label: 'Admin' }, { label: 'Settings' }]}
        actions={
          <Button
            variant="primary" size="sm" icon={<Save size={13} />}
            loading={save.isPending}
            disabled={!dirty || Object.keys(changed).length === 0}
            onClick={() => save.mutate(changed)}
          >
            {dirty ? `Save ${Object.keys(changed).length} change(s)` : 'Saved'}
          </Button>
        }
      />

      <div className="stack" style={{ gap: 'var(--sp-4)' }}>
        {GROUPS.map((g) => {
          const keys = g.keys.filter((k) => k in draft);
          if (keys.length === 0) return null;
          return (
            <Card key={g.title}>
              <CardHeader icon={g.icon} title={g.title} subtitle={g.subtitle} />
              <CardBody>
                <div className="form-grid">
                  {keys.map((k) => {
                    const value = draft[k];
                    const description = data?.meta.descriptions?.[k];
                    const updated = data?.meta.updatedAt?.[k];
                    const hint = [description, updated ? `Last changed ${formatDateTime(updated)}` : null]
                      .filter(Boolean).join(' · ');

                    if (typeof value === 'boolean') {
                      return (
                        <div key={k} className="field-span-full">
                          <div
                            style={{
                              padding: 'var(--sp-3) var(--sp-4)',
                              border: `1px solid ${value ? 'var(--warning-100)' : 'var(--border)'}`,
                              background: value ? 'var(--warning-50)' : 'var(--bg-surface)',
                              borderRadius: 'var(--radius-sm)',
                            }}
                          >
                            <Checkbox label={LABELS[k] ?? k} checked={value} onChange={(v) => set(k, v)} />
                            {hint && (
                              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 5, marginLeft: 24, lineHeight: 1.55 }}>
                                {hint}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    }

                    if (typeof value === 'number') {
                      return (
                        <Field key={k} label={LABELS[k] ?? k} hint={hint}>
                          <Input numeric type="number" min="0" value={String(value)}
                                 onChange={(e) => set(k, Number(e.target.value))} />
                        </Field>
                      );
                    }

                    const isLong = k === 'company.address';
                    return (
                      <Field key={k} label={LABELS[k] ?? k} hint={hint} span={isLong ? 'full' : undefined}>
                        <Input value={String(value ?? '')} onChange={(e) => set(k, e.target.value)} />
                      </Field>
                    );
                  })}
                </div>
              </CardBody>
            </Card>
          );
        })}
      </div>

      {dirty && (
        <div
          className="row"
          style={{
            position: 'sticky', bottom: 'var(--sp-4)', marginTop: 'var(--sp-4)',
            gap: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)',
            background: 'var(--bg-surface)', border: '1px solid var(--brand-200)',
            borderRadius: 'var(--radius-md)', boxShadow: 'var(--shadow-lg)',
          }}
        >
          <span className="grow" style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-700)' }}>
            You have {Object.keys(changed).length} unsaved change(s).
          </span>
          <Button variant="ghost" onClick={() => { setDraft(data?.data ?? {}); setDirty(false); }}>
            Discard
          </Button>
          <Button variant="primary" icon={<Save size={13} />} loading={save.isPending} onClick={() => save.mutate(changed)}>
            Save changes
          </Button>
        </div>
      )}
    </>
  );
}
