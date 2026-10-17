/**
 * Sign-in (SRS §6, §28 of the brief).
 *
 * Employee ID + password, show/hide, validation, loading and error states.
 * No credential is ever hard-coded into this bundle — the hint shown in
 * development is a pointer to the seeded bootstrap account, and it is suppressed
 * in a production build.
 *
 * A signed-in user who owes a password change — a first-sign-in password, or one
 * an administrator has just set — sees the change-password step here instead of
 * the form, and nothing else: the API refuses every other request until the
 * password is changed (403 PASSWORD_CHANGE_REQUIRED), and App.tsx sends such a
 * user back to this screen from any other address.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Zap, Eye, EyeOff, ArrowRight, ShieldCheck, AlertCircle, KeyRound, Check, X, LogOut } from 'lucide-react';
import { useAuth, type CurrentUser } from '../lib/auth';
import { ApiError } from '../lib/api';
import { Button, Field, Input } from '../components/ui';

/** The error (or, once a password has been changed, the notice) above a form. */
function FormAlert({ tone = 'danger', children }: { tone?: 'danger' | 'success'; children: ReactNode }) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className="row"
      style={{
        gap: 9, padding: 'var(--sp-3) var(--sp-4)', marginBottom: 'var(--sp-5)',
        borderRadius: 'var(--radius-sm)', background: `var(--${tone}-50)`,
        border: `1px solid var(--${tone}-100)`, color: `var(--${tone}-700)`,
        fontSize: 'var(--text-sm)', alignItems: 'flex-start',
        animation: 'zx-rise var(--dur) var(--ease-out)',
      }}
    >
      {tone === 'danger'
        ? <AlertCircle size={16} style={{ flexShrink: 0, marginTop: 1 }} />
        : <Check size={16} style={{ flexShrink: 0, marginTop: 1 }} />}
      <span>{children}</span>
    </div>
  );
}

/**
 * Sets the password a signed-in user owes, then continues into the application
 * on a new session (the change ends every session). The published-password
 * check is the server's; the rules shown here are the ones it states.
 */
function PasswordChangeStep({ user, knownPassword, onChanged }: {
  user: CurrentUser;
  /** The password just used to sign in on this screen, if any — not asked for again. */
  knownPassword: string;
  onChanged: (message: string) => void;
}) {
  const { changePassword, signOut } = useAuth();
  const [typedCurrent, setTypedCurrent] = useState('');
  // Asked for only when this screen did not just verify it (a restored session).
  const askCurrent = !knownPassword;
  const currentPassword = knownPassword || typedCurrent;
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [show, setShow] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const employeeId = user.employeeId.trim().toLowerCase();
  const rules = [
    { label: 'At least 8 characters', ok: newPassword.length >= 8 },
    { label: 'Upper and lower case letters', ok: /[a-z]/.test(newPassword) && /[A-Z]/.test(newPassword) },
    { label: 'A digit and a symbol', ok: /[0-9]/.test(newPassword) && /[^A-Za-z0-9]/.test(newPassword) },
    {
      label: 'Does not contain your Employee ID',
      // The server ignores an Employee ID shorter than three characters.
      ok: newPassword.length > 0 && (employeeId.length < 3 || !newPassword.toLowerCase().includes(employeeId)),
    },
  ];
  const matches = newPassword.length > 0 && newPassword === confirmPassword;

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setFieldErrors({});

    const issues: Record<string, string> = {};
    if (!currentPassword) issues.currentPassword = 'Enter the password you signed in with.';
    if (!rules.every((r) => r.ok)) issues.newPassword = 'Your new password does not meet every requirement.';
    if (!matches) issues.confirmPassword = 'The two passwords do not match.';
    if (Object.keys(issues).length > 0) { setFieldErrors(issues); return; }

    setSubmitting(true);
    try {
      onChanged(await changePassword(currentPassword, newPassword, { continueAs: user.employeeId }));
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Cannot reach the Zolex server. Check that the backend is running.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div style={{ marginBottom: 'var(--sp-6)' }}>
        <h2 style={{ fontSize: 'var(--text-2xl)', color: 'var(--ink-900)', letterSpacing: '-0.02em' }}>Set a new password</h2>
        <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 5, lineHeight: 1.6 }}>
          Signed in as <strong>{user.employeeName}</strong> ({user.employeeId}). Your password was set for
          you — a first-sign-in password or an administrator's reset — so choose one of your own before
          you continue. Nothing else opens until you do.
        </p>
      </div>

      {error && <FormAlert>{error}</FormAlert>}

      <form onSubmit={onSubmit} className="stack" style={{ gap: 'var(--sp-4)' }} noValidate>
        {askCurrent && (
          <Field label="Current password" required error={fieldErrors.currentPassword}>
            <Input
              type={show ? 'text' : 'password'}
              value={typedCurrent}
              onChange={(e) => setTypedCurrent(e.target.value)}
              autoComplete="current-password"
              invalid={Boolean(fieldErrors.currentPassword)}
              disabled={submitting}
              autoFocus
            />
          </Field>
        )}

        <Field label="New password" required error={fieldErrors.newPassword}>
          <div style={{ position: 'relative' }}>
            <Input
              type={show ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              autoComplete="new-password"
              invalid={Boolean(fieldErrors.newPassword)}
              disabled={submitting}
              autoFocus={!askCurrent}
              style={{ paddingRight: 38 }}
            />
            <button
              type="button"
              onClick={() => setShow((v) => !v)}
              aria-label={show ? 'Hide passwords' : 'Show passwords'}
              style={{
                position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                color: 'var(--ink-400)', display: 'grid', placeItems: 'center',
              }}
            >
              {show ? <EyeOff size={15} /> : <Eye size={15} />}
            </button>
          </div>
        </Field>

        <div className="stack" style={{ gap: 3 }}>
          {rules.map((r) => (
            <div key={r.label} className="row" style={{ gap: 6, fontSize: 'var(--text-2xs)', color: r.ok ? 'var(--success-700)' : 'var(--text-muted)' }}>
              {r.ok ? <Check size={11} /> : <X size={11} style={{ opacity: 0.5 }} />}
              {r.label}
            </div>
          ))}
          <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
            A password that has been published or used as an example is refused.
          </div>
        </div>

        <Field
          label="Confirm new password" required
          error={fieldErrors.confirmPassword ?? (confirmPassword.length > 0 && !matches ? 'The two passwords do not match.' : undefined)}
        >
          <Input
            type={show ? 'text' : 'password'}
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            autoComplete="new-password"
            invalid={confirmPassword.length > 0 && !matches}
            disabled={submitting}
          />
        </Field>

        <Button type="submit" variant="primary" size="lg" block loading={submitting} icon={<KeyRound size={16} />}>
          {submitting ? 'Changing password…' : 'Change password and continue'}
        </Button>
      </form>

      <div style={{ marginTop: 'var(--sp-6)', textAlign: 'center' }}>
        <button
          type="button"
          onClick={() => void signOut()}
          disabled={submitting}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}
        >
          <LogOut size={13} /> Sign out instead
        </button>
      </div>
    </>
  );
}

export default function Login() {
  const { user, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [employeeId, setEmployeeId] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // The password just used here, so the change-password step need not ask for it again.
  const [signedInWith, setSignedInWith] = useState('');

  const from = (location.state as { from?: string } | null)?.from ?? '/home';

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setFieldErrors({});

    const issues: Record<string, string> = {};
    if (!employeeId.trim()) issues.employeeId = 'Enter your Employee ID.';
    if (!password) issues.password = 'Enter your password.';
    if (Object.keys(issues).length > 0) { setFieldErrors(issues); return; }

    setSubmitting(true);
    try {
      const signedIn = await signIn(employeeId.trim(), password);
      if (signedIn.mustChangePassword) {
        // Stay here: the change-password step replaces this form.
        setSignedInWith(password);
        setPassword('');
        return;
      }
      navigate(from, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        setFieldErrors(err.fieldErrors);
      } else {
        setError('Cannot reach the Zolex server. Check that the backend is running.');
      }
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', background: 'var(--bg-app)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(460px, 100%), 1fr))', minHeight: '100vh' }}>
        {/* ── Brand panel ───────────────────────────────────────────────── */}
        <div
          style={{
            background: 'var(--grad-brand-deep)', color: '#fff',
            padding: 'var(--sp-12) var(--sp-10)',
            display: 'flex', flexDirection: 'column', justifyContent: 'space-between',
            position: 'relative', overflow: 'hidden',
          }}
        >
          {/* Slow-drifting colour mesh. Purely decorative, and it stops entirely
              under prefers-reduced-motion via the global rule in base.css. */}
          <div
            aria-hidden
            style={{
              position: 'absolute', inset: '-25%',
              background:
                'radial-gradient(46% 40% at 22% 18%, rgba(139,92,246,0.42), transparent 62%),' +
                'radial-gradient(42% 36% at 82% 30%, rgba(31,160,224,0.34), transparent 62%),' +
                'radial-gradient(48% 42% at 62% 88%, rgba(238,176,42,0.26), transparent 62%)',
              backgroundSize: '200% 200%',
              animation: 'zx-gradient-drift 26s var(--ease) infinite',
            }}
          />
          {/* Fine grid, so the panel reads as engineered rather than merely coloured. */}
          <div
            aria-hidden
            style={{
              position: 'absolute', inset: 0, opacity: 0.5,
              backgroundImage:
                'linear-gradient(rgba(255,255,255,0.05) 1px, transparent 1px),' +
                'linear-gradient(90deg, rgba(255,255,255,0.05) 1px, transparent 1px)',
              backgroundSize: '52px 52px',
              maskImage: 'radial-gradient(120% 90% at 50% 40%, #000 30%, transparent 78%)',
              WebkitMaskImage: 'radial-gradient(120% 90% at 50% 40%, #000 30%, transparent 78%)',
            }}
          />

          <Link to="/" className="row" style={{ gap: 11, textDecoration: 'none', position: 'relative' }}>
            <span style={{ width: 36, height: 36, borderRadius: 10, background: 'var(--grad-accent)', display: 'grid', placeItems: 'center', boxShadow: '0 3px 14px rgba(238,176,42,0.5)' }}>
              <Zap size={20} color="#fff" strokeWidth={2.5} />
            </span>
            <span>
              <div style={{ color: '#fff', fontWeight: 700, fontSize: 'var(--text-xl)', letterSpacing: '0.09em', lineHeight: 1 }}>ZOLEX</div>
              <div style={{ color: 'rgba(255,255,255,0.6)', fontSize: '11px', marginTop: 3 }}>Purchase-to-Store Enterprise ERP</div>
            </span>
          </Link>

          <div style={{ position: 'relative', maxWidth: 460 }}>
            <h1
              style={{
                fontSize: 'clamp(1.7rem, 3.6vw, 2.6rem)', lineHeight: 1.15,
                letterSpacing: '-0.028em', marginBottom: 'var(--sp-4)', color: '#fff',
              }}
            >
              Every quantity balances.<br />
              <span
                style={{
                  background: 'linear-gradient(100deg, var(--gold-300), var(--violet-300) 60%, var(--sky-300))',
                  WebkitBackgroundClip: 'text', backgroundClip: 'text',
                  WebkitTextFillColor: 'transparent', color: 'transparent',
                }}
              >
                Every number traces back.
              </span>
            </h1>
            <p style={{ fontSize: 'var(--text-md)', color: 'rgba(255,255,255,0.72)', lineHeight: 1.65 }}>
              Indent, approval, purchase order and goods receipt on one auditable ledger for
              Zeeta Electrical Engineering.
            </p>

            <div className="stack" style={{ gap: 'var(--sp-3)', marginTop: 'var(--sp-8)' }}>
              {[
                'Master-driven forms that fill themselves',
                'Consolidate several indents into one purchase order',
                'Partial and final receipt with correct balances',
                'Drill from any KPI to the source transaction',
              ].map((t) => (
                <div key={t} className="row" style={{ gap: 10, fontSize: 'var(--text-sm)', color: 'rgba(255,255,255,0.8)' }}>
                  <ShieldCheck size={15} style={{ color: 'var(--accent-300)', flexShrink: 0 }} />
                  {t}
                </div>
              ))}
            </div>
          </div>

          <div style={{ position: 'relative', fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.45)' }}>
            Zeeta Electrical Engineering Pvt. Ltd. · Purchase-to-Store ERP v1.0
          </div>
        </div>

        {/* ── Form panel ────────────────────────────────────────────────── */}
        <div
          style={{
            display: 'grid', placeItems: 'center', padding: 'var(--sp-8) var(--sp-6)',
            background: 'var(--bg-app)', backgroundImage: 'var(--bg-app-accent)',
          }}
        >
          <div
            className="card"
            style={{
              width: '100%', maxWidth: 424,
              padding: 'var(--sp-8) var(--sp-7)',
              boxShadow: 'var(--shadow-xl)',
              borderRadius: 'var(--radius-lg)',
              animation: 'zx-fade-up var(--dur-slow) var(--ease-out)',
              overflow: 'visible',
            }}
          >
            {user?.mustChangePassword ? (
              <PasswordChangeStep
                user={user}
                knownPassword={signedInWith}
                onChanged={(message) => { setNotice(message); setSignedInWith(''); }}
              />
            ) : (
              <>
                <div style={{ marginBottom: 'var(--sp-7)' }}>
                  <h2 style={{ fontSize: 'var(--text-2xl)', color: 'var(--ink-900)', letterSpacing: '-0.02em' }}>Sign in</h2>
                  <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 5 }}>
                    Use the Employee ID issued by your administrator.
                  </p>
                </div>

                {notice && <FormAlert tone="success">{notice}</FormAlert>}
                {error && <FormAlert>{error}</FormAlert>}

                <form onSubmit={onSubmit} className="stack" style={{ gap: 'var(--sp-4)' }} noValidate>
                  <Field label="Employee ID" required error={fieldErrors.employeeId}>
                    <Input
                      value={employeeId}
                      onChange={(e) => setEmployeeId(e.target.value)}
                      placeholder="e.g. 10221"
                      autoComplete="username"
                      autoFocus
                      invalid={Boolean(fieldErrors.employeeId)}
                      disabled={submitting}
                    />
                  </Field>

                  <Field label="Password" required error={fieldErrors.password}>
                    <div style={{ position: 'relative' }}>
                      <Input
                        type={showPassword ? 'text' : 'password'}
                        value={password}
                        onChange={(e) => setPassword(e.target.value)}
                        placeholder="Your password"
                        autoComplete="current-password"
                        invalid={Boolean(fieldErrors.password)}
                        disabled={submitting}
                        style={{ paddingRight: 38 }}
                      />
                      <button
                        type="button"
                        onClick={() => setShowPassword((v) => !v)}
                        aria-label={showPassword ? 'Hide password' : 'Show password'}
                        style={{
                          position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)',
                          color: 'var(--ink-400)', display: 'grid', placeItems: 'center',
                        }}
                      >
                        {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                      </button>
                    </div>
                  </Field>

                  <Button type="submit" variant="primary" size="lg" block loading={submitting} iconRight={!submitting ? <ArrowRight size={17} /> : undefined}>
                    {submitting ? 'Signing in…' : 'Sign in'}
                  </Button>
                </form>

                {import.meta.env.DEV && (
                  <div
                    style={{
                      marginTop: 'var(--sp-6)', padding: 'var(--sp-3) var(--sp-4)',
                      borderRadius: 'var(--radius-sm)', background: 'var(--warning-50)',
                      border: '1px dashed var(--warning-100)',
                    }}
                  >
                    <div className="row" style={{ gap: 7, marginBottom: 4 }}>
                      <KeyRound size={13} style={{ color: 'var(--warning-600)' }} />
                      <span style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--warning-700)' }}>
                        Development environment
                      </span>
                    </div>
                    <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--ink-600)', lineHeight: 1.6 }}>
                      Bootstrap administrator <strong>10221</strong> or <strong>10422</strong> with the seeded
                      password. You will be required to change it at first sign-in, and this hint does not
                      appear in a production build.
                    </div>
                  </div>
                )}

                <div style={{ marginTop: 'var(--sp-6)', textAlign: 'center' }}>
                  <Link to="/" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
                    ← Back to overview
                  </Link>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
