/**
 * My profile & password (SRS §6, §25).
 *
 * When a user is on a bootstrap credential, this screen is the ONLY one they can
 * reach until they rotate it — the API refuses everything else for them.
 */
import { useState, type FormEvent } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { KeyRound, User as UserIcon, ShieldCheck, AlertTriangle, Eye, EyeOff, Check, X } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { ApiError } from '../lib/api';
import { useToast } from '../components/Toast';
import { PageHeader } from '../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Badge, Tabs,
  DetailItem, DetailGrid, SectionTitle,
} from '../components/ui';
import { formatDateTime, initials, text } from '../lib/format';

const RULES: { label: string; test: (p: string) => boolean }[] = [
  { label: 'At least 8 characters', test: (p) => p.length >= 8 },
  { label: 'A lowercase letter', test: (p) => /[a-z]/.test(p) },
  { label: 'An uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { label: 'A digit', test: (p) => /[0-9]/.test(p) },
  { label: 'A special character', test: (p) => /[^A-Za-z0-9]/.test(p) },
];

export default function Profile() {
  const { user, changePassword } = useAuth();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const forced = false;
  const [tab, setTab] = useState(params.get('tab') === 'password' || forced ? 'password' : 'profile');

  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState(false);

  const strength = RULES.filter((r) => r.test(newPassword)).length;
  const strong = strength === RULES.length;
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErrors({});

    const issues: Record<string, string> = {};
    if (!currentPassword) issues.currentPassword = 'Enter your current password.';
    if (!strong) issues.newPassword = 'Your new password does not meet all the requirements.';
    if (!matches) issues.confirmPassword = 'The two passwords do not match.';
    if (newPassword === currentPassword && newPassword) {
      issues.newPassword = 'Your new password must be different from the current one.';
    }
    if (Object.keys(issues).length > 0) { setErrors(issues); return; }

    setSubmitting(true);
    try {
      const message = await changePassword(currentPassword, newPassword);
      setDone(true);
      toast.success('Password changed', message);
      // Every session was revoked server-side, so return to sign-in.
      setTimeout(() => navigate('/login', { replace: true }), 1600);
    } catch (err) {
      if (err instanceof ApiError) {
        setErrors(err.fieldErrors);
        toast.fromError(err);
      } else {
        toast.error('Could not change password');
      }
    } finally {
      setSubmitting(false);
    }
  }

  if (!user) return null;

  return (
    <>
      <PageHeader
        title="My Profile"
        subtitle="Your identity, roles and account security"
        breadcrumbs={[{ label: 'Profile' }]}
      />

      {forced && (
        <Card style={{ marginBottom: 'var(--sp-4)', borderColor: 'var(--warning-200, var(--warning-100))' }}>
          <CardBody>
            <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
              <AlertTriangle size={20} style={{ color: 'var(--warning-600)', flexShrink: 0, marginTop: 2 }} />
              <div>
                <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--ink-900)', marginBottom: 4 }}>
                  You must change your password before continuing
                </div>
                <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>
                  This account is still on the credential it was created with. The rest of the
                  application stays locked until you set a password of your own.
                </div>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {!forced && (
        <div style={{ marginBottom: 'var(--sp-4)' }}>
          <Tabs
            tabs={[
              { key: 'profile', label: 'Profile', icon: <UserIcon size={14} /> },
              { key: 'password', label: 'Password', icon: <KeyRound size={14} /> },
            ]}
            active={tab}
            onChange={(k) => { setTab(k); setParams(k === 'password' ? { tab: 'password' } : {}, { replace: true }); }}
          />
        </div>
      )}

      {tab === 'profile' && !forced && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))', gap: 'var(--sp-4)' }}>
          <Card>
            <CardBody>
              <div className="row" style={{ gap: 'var(--sp-4)', marginBottom: 'var(--sp-5)' }}>
                <span
                  style={{
                    width: 58, height: 58, borderRadius: '50%', flexShrink: 0,
                    background: 'var(--grad-brand)', color: '#fff',
                    display: 'grid', placeItems: 'center',
                    fontSize: 'var(--text-xl)', fontWeight: 700,
                    boxShadow: 'var(--shadow-brand)',
                  }}
                >
                  {initials(user.employeeName)}
                </span>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 'var(--text-xl)', fontWeight: 700, color: 'var(--ink-900)' }}>
                    {user.employeeName}
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                    {text(user.designation)}
                  </div>
                </div>
              </div>

              <DetailGrid cols={2}>
                <DetailItem label="Employee ID" mono>{user.employeeId}</DetailItem>
                <DetailItem label="Department">{text(user.department)}</DetailItem>
                <DetailItem label="Email">{text(user.email)}</DetailItem>
                <DetailItem label="Mobile">{text(user.mobileNo)}</DetailItem>
                <div style={{ gridColumn: '1 / -1' }}>
                  <DetailItem label="Last sign-in">
                    {user.lastLoginAt ? formatDateTime(user.lastLoginAt) : 'This is your first session'}
                  </DetailItem>
                </div>
              </DetailGrid>

              <div style={{ marginTop: 'var(--sp-5)' }}>
                <SectionTitle>Roles</SectionTitle>
                <div className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  {user.roles.map((r) => (
                    <span key={r} className="row" style={{ gap: 6, padding: '6px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--brand-50)', border: '1px solid var(--brand-100)', fontSize: 'var(--text-xs)', fontWeight: 500, color: 'var(--brand-700)' }}>
                      <ShieldCheck size={13} /> {r.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              </div>

              <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                Your details and roles are maintained by an administrator in User Management.
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader
              icon={<ShieldCheck size={16} />}
              title="What you can do"
              subtitle={`${user.permissions.length} permission(s) across the system`}
            />
            <CardBody>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--sp-3)' }}>
                {Object.entries(
                  user.permissions.reduce<Record<string, string[]>>((acc, p) => {
                    const [module, action] = p.split('.');
                    if (!module || !action) return acc;
                    (acc[module] ??= []).push(action);
                    return acc;
                  }, {}),
                ).map(([module, actions]) => (
                  <div key={module} style={{ padding: 'var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                    <div style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-700)', textTransform: 'capitalize', marginBottom: 5 }}>
                      {module.replace(/_/g, ' ')}
                    </div>
                    <div className="row" style={{ gap: 4, flexWrap: 'wrap' }}>
                      {actions.sort().map((a) => <Badge key={a} tone="info" plain>{a}</Badge>)}
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>
        </div>
      )}

      {(tab === 'password' || forced) && (
        <div style={{ maxWidth: 520 }}>
          <Card>
            <CardHeader icon={<KeyRound size={16} />} title="Change password"
                        subtitle="All your other sessions will be signed out" />
            <CardBody>
              {done ? (
                <div style={{ textAlign: 'center', padding: 'var(--sp-6) 0' }}>
                  <div style={{ width: 48, height: 48, borderRadius: '50%', background: 'var(--success-50)', color: 'var(--success-600)', display: 'grid', placeItems: 'center', margin: '0 auto var(--sp-3)', border: '1px solid var(--success-100)' }}>
                    <Check size={24} />
                  </div>
                  <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--ink-900)' }}>
                    Password changed
                  </div>
                  <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 5 }}>
                    Taking you to the sign-in screen…
                  </div>
                </div>
              ) : (
                <form onSubmit={onSubmit} className="stack" style={{ gap: 'var(--sp-4)' }} noValidate>
                  <Field label="Current password" required error={errors.currentPassword}>
                    <Input
                      type={show ? 'text' : 'password'}
                      value={currentPassword}
                      onChange={(e) => setCurrentPassword(e.target.value)}
                      autoComplete="current-password"
                      invalid={Boolean(errors.currentPassword)}
                      autoFocus
                    />
                  </Field>

                  <Field label="New password" required error={errors.newPassword}>
                    <div style={{ position: 'relative' }}>
                      <Input
                        type={show ? 'text' : 'password'}
                        value={newPassword}
                        onChange={(e) => setNewPassword(e.target.value)}
                        autoComplete="new-password"
                        invalid={Boolean(errors.newPassword)}
                        style={{ paddingRight: 38 }}
                      />
                      <button
                        type="button"
                        onClick={() => setShow((v) => !v)}
                        aria-label={show ? 'Hide passwords' : 'Show passwords'}
                        style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'grid', placeItems: 'center' }}
                      >
                        {show ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </Field>

                  {newPassword.length > 0 && (
                    <div style={{ padding: 'var(--sp-3)', background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)' }}>
                      <div className="row" style={{ gap: 4, marginBottom: 8 }}>
                        {RULES.map((_, i) => (
                          <span
                            key={i}
                            style={{
                              flex: 1, height: 3, borderRadius: 2,
                              background: i < strength
                                ? strength === RULES.length ? 'var(--success-500)' : strength >= 3 ? 'var(--warning-500)' : 'var(--danger-500)'
                                : 'var(--ink-200)',
                              transition: 'background var(--dur) var(--ease)',
                            }}
                          />
                        ))}
                      </div>
                      <div className="stack" style={{ gap: 3 }}>
                        {RULES.map((r) => {
                          const ok = r.test(newPassword);
                          return (
                            <div key={r.label} className="row" style={{ gap: 6, fontSize: 'var(--text-2xs)', color: ok ? 'var(--success-700)' : 'var(--text-muted)' }}>
                              {ok ? <Check size={11} /> : <X size={11} style={{ opacity: 0.5 }} />}
                              {r.label}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  <Field
                    label="Confirm new password" required
                    error={errors.confirmPassword ?? (confirmPassword.length > 0 && !matches ? 'The two passwords do not match.' : undefined)}
                  >
                    <Input
                      type={show ? 'text' : 'password'}
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      autoComplete="new-password"
                      invalid={confirmPassword.length > 0 && !matches}
                    />
                  </Field>

                  <Button
                    type="submit" variant="primary" size="lg" block
                    loading={submitting}
                    disabled={!strong || !matches || !currentPassword}
                    icon={<KeyRound size={16} />}
                  >
                    Change password
                  </Button>
                </form>
              )}
            </CardBody>
          </Card>
        </div>
      )}
    </>
  );
}
