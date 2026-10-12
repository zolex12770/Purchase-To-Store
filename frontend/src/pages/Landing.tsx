/**
 * Landing page (SRS §16).
 *
 * Hero → procurement value proposition → workflow → analytics → control &
 * security → operational intelligence → call to action. Presents Zolex as a
 * serious enterprise product without overselling: every capability named here is
 * one the system actually implements.
 */
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Zap, ArrowRight, FileText, CheckCircle2, ShoppingCart, Truck,
  BarChart3, ShieldCheck, Database, Layers, GitMerge, Filter,
  RefreshCw, ScrollText, HardDriveDownload, Lock, Gauge, Boxes,
} from 'lucide-react';
import { useCountUp } from '../lib/useCountUp';

const MODULES = [
  {
    icon: <Database size={20} />, grad: 'var(--grad-sky)', tint: 'var(--sky-500)',
    title: 'Master Data',
    text: 'Supplier and Item Masters drive every dropdown and auto-populate every form, so information is entered once and reused everywhere.',
  },
  {
    icon: <FileText size={20} />, grad: 'var(--grad-brand)', tint: 'var(--indigo-500)',
    title: 'Purchase Indent',
    text: 'Header/detail requisitions with searchable item selection, live quantity visibility and a controlled approval workflow.',
  },
  {
    icon: <ShoppingCart size={20} />, grad: 'var(--grad-accent)', tint: 'var(--gold-500)',
    title: 'Purchase Order',
    text: 'Direct orders, indent-based orders, and consolidation of several approved indents into a single PO with full source traceability.',
  },
  {
    icon: <Truck size={20} />, grad: 'var(--grad-teal)', tint: 'var(--teal-500)',
    title: 'Goods Receipt',
    text: 'PO-driven receipts supporting partial and final delivery, with outstanding balances that stay mathematically correct.',
  },
  {
    icon: <BarChart3 size={20} />, grad: 'var(--grad-violet)', tint: 'var(--violet-500)',
    title: 'Management Analysis',
    text: 'KPIs, trends, supplier and item analysis, ageing and exceptions — every figure clickable through to the underlying transaction.',
  },
  {
    icon: <ShieldCheck size={20} />, grad: 'var(--grad-rose)', tint: 'var(--rose-500)',
    title: 'Administration',
    text: 'Users, roles, granular permissions, import/export, backup and a complete audit trail of every critical change.',
  },
];

const WORKFLOW = [
  { icon: <FileText size={17} />, title: 'Indent', text: 'Department raises a requisition from the Item Master.' },
  { icon: <CheckCircle2 size={17} />, title: 'Approval', text: 'Purchase Head approves or rejects with a recorded reason.' },
  { icon: <ShoppingCart size={17} />, title: 'Purchase Order', text: 'Approved demand becomes one or more supplier orders.' },
  { icon: <Truck size={17} />, title: 'Goods Receipt', text: 'Store receives against the PO, in full or in part.' },
  { icon: <BarChart3 size={17} />, title: 'Analysis', text: 'Management sees value, exposure and cycle time in real time.' },
];

const CONTROLS = [
  { icon: <Lock size={17} />, title: 'Role-based access', text: 'Eleven permission types across every module, enforced on the server for every single request — never by hiding buttons alone.' },
  { icon: <GitMerge size={17} />, title: 'Quantity integrity', text: 'Ordering and receipt quantities are validated under a row lock inside one transaction, so a quantity can never be consumed twice.' },
  { icon: <ScrollText size={17} />, title: 'Complete audit trail', text: 'Who did what, when, and what changed — for every approval, order, receipt, import, export and configuration change.' },
  { icon: <HardDriveDownload size={17} />, title: 'Backup & recovery', text: 'Checksum-verified backups stored outside the application, with a protected and fully audited restore path.' },
];

const INTELLIGENCE = [
  { icon: <Filter size={16} />, label: 'Universal filters', text: 'Date, supplier, item, department, cost centre, type and status — combinable across every screen.' },
  { icon: <Layers size={16} />, label: 'True drill-down', text: 'KPI → document → line → item → supplier → originating indent, with filters preserved.' },
  { icon: <Gauge size={16} />, label: 'Exception analysis', text: 'Overdue deliveries, ageing approvals and rate variance surfaced before they become problems.' },
  { icon: <RefreshCw size={16} />, label: 'Google Sheets bridge', text: 'A controlled one-way sync during transition, with conflicts recorded rather than silently overwritten.' },
];

/**
 * Hero figures.
 *
 * These describe the SOFTWARE (how many modules, KPIs and PO modes it ships),
 * not any customer's business data — so they are legitimately static. No figure
 * here is presented as a live measurement.
 */
const HERO_STATS = [
  { to: 6,   suffix: '',  label: 'Integrated modules' },
  { to: 4,   suffix: '',  label: 'PO creation modes' },
  { to: 24,  suffix: '',  label: 'Management KPIs' },
  { to: 100, suffix: '%', label: 'Audited mutations' },
];

/** A hero figure that counts up once, on entering the viewport. */
function HeroStat({ to, suffix, label }: { to: number; suffix: string; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [visible, setVisible] = useState(false);
  const value = useCountUp(to, visible);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (typeof IntersectionObserver !== 'function') { setVisible(true); return; }
    const io = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) { setVisible(true); io.disconnect(); } },
      { threshold: 0.4 },
    );
    io.observe(node);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} style={{ textAlign: 'center' }}>
      <div
        className="num"
        style={{
          fontFamily: 'var(--font-display)', fontSize: 'var(--text-4xl)', fontWeight: 800,
          color: '#fff', letterSpacing: '-0.03em', lineHeight: 1,
        }}
      >
        {Math.round(value)}{suffix}
      </div>
      <div style={{ fontSize: 'var(--text-xs)', color: 'rgba(255,255,255,0.62)', marginTop: 6 }}>{label}</div>
    </div>
  );
}

export default function Landing() {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg-surface)' }}>
      {/* ── Nav ─────────────────────────────────────────────────────────── */}
      <header
        style={{
          position: 'sticky', top: 0, zIndex: 50,
          background: 'var(--glass-bg)', backdropFilter: 'var(--glass-blur)', WebkitBackdropFilter: 'var(--glass-blur)',
          borderBottom: '1px solid var(--border-subtle)',
        }}
      >
        <div className="row" style={{ maxWidth: 1200, margin: '0 auto', padding: '0 var(--sp-6)', height: 64, gap: 'var(--sp-4)' }}>
          <div className="row" style={{ gap: 10 }}>
            <span style={{ width: 32, height: 32, borderRadius: 9, background: 'var(--grad-brand)', display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-sm)' }}>
              <Zap size={18} color="#fff" strokeWidth={2.5} />
            </span>
            <span>
              <div style={{ fontWeight: 700, fontSize: 'var(--text-lg)', letterSpacing: '0.08em', color: 'var(--brand-800)', lineHeight: 1 }}>
                ZOLEX
              </div>
              <div style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: 2 }}>
                Zeeta Electrical Engineering Pvt. Ltd.
              </div>
            </span>
          </div>
          <div className="spacer" />
          <Link to="/login" className="btn btn-primary">
            Sign in <ArrowRight size={15} />
          </Link>
        </div>
      </header>

      {/* ── Hero ────────────────────────────────────────────────────────── */}
      <section
        style={{
          background: 'var(--grad-brand-deep)',
          color: '#fff',
          padding: 'var(--sp-24) var(--sp-6) var(--sp-20)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Slow-drifting colour mesh — depth without noise, and it freezes under
            prefers-reduced-motion via the global rule in base.css. */}
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: '-20%',
            background:
              'radial-gradient(40% 44% at 16% 8%, rgba(139,92,246,0.44), transparent 62%),' +
              'radial-gradient(38% 40% at 84% 22%, rgba(31,160,224,0.36), transparent 62%),' +
              'radial-gradient(44% 44% at 56% 96%, rgba(238,176,42,0.26), transparent 62%)',
            backgroundSize: '190% 190%',
            animation: 'zx-gradient-drift 30s var(--ease) infinite',
          }}
        />
        {/* Engineering grid, faded at the edges. */}
        <div
          aria-hidden
          style={{
            position: 'absolute', inset: 0, opacity: 0.55,
            backgroundImage:
              'linear-gradient(rgba(255,255,255,0.055) 1px, transparent 1px),' +
              'linear-gradient(90deg, rgba(255,255,255,0.055) 1px, transparent 1px)',
            backgroundSize: '58px 58px',
            maskImage: 'radial-gradient(115% 85% at 50% 30%, #000 25%, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(115% 85% at 50% 30%, #000 25%, transparent 80%)',
          }}
        />
        <div style={{ maxWidth: 1080, margin: '0 auto', position: 'relative', textAlign: 'center' }}>
          <span
            className="row"
            style={{
              display: 'inline-flex', gap: 7, padding: '5px 13px',
              borderRadius: 'var(--radius-full)',
              background: 'rgba(255,255,255,0.1)',
              border: '1px solid rgba(255,255,255,0.2)',
              fontSize: 'var(--text-xs)', fontWeight: 500,
              color: 'rgba(255,255,255,0.92)', marginBottom: 'var(--sp-6)',
            }}
          >
            <Boxes size={13} /> Purchase-to-Store Enterprise ERP
          </span>

          <h1
            style={{
              fontSize: 'clamp(2rem, 5.2vw, 3.4rem)',
              fontWeight: 700, lineHeight: 1.1, letterSpacing: '-0.03em',
              marginBottom: 'var(--sp-5)',
            }}
          >
            Procurement you can<br />
            <span
              style={{
                background: 'linear-gradient(100deg, var(--gold-300) 0%, var(--violet-300) 52%, var(--sky-300) 100%)',
                WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent', backgroundClip: 'text',
                color: 'transparent',
              }}
            >
              actually account for
            </span>
          </h1>

          <p
            style={{
              fontSize: 'var(--text-lg)', color: 'rgba(255,255,255,0.78)',
              maxWidth: 660, margin: '0 auto var(--sp-8)', lineHeight: 1.6,
            }}
          >
            From requisition to store receipt — indents, approvals, purchase orders and goods
            receipts on one auditable ledger, where every quantity balances and every number on a
            dashboard leads back to the transaction that produced it.
          </p>

          <div className="row" style={{ gap: 'var(--sp-3)', justifyContent: 'center', flexWrap: 'wrap' }}>
            <Link to="/login" className="btn btn-accent btn-lg">
              Enter the workspace <ArrowRight size={17} />
            </Link>
            <a href="#workflow" className="btn btn-lg" style={{ background: 'rgba(255,255,255,0.12)', color: '#fff', border: '1px solid rgba(255,255,255,0.24)' }}>
              See how it works
            </a>
          </div>

          <div
            className="row"
            style={{
              gap: 'var(--sp-8)', justifyContent: 'center', flexWrap: 'wrap',
              marginTop: 'var(--sp-12)', paddingTop: 'var(--sp-8)',
              borderTop: '1px solid rgba(255,255,255,0.12)',
            }}
          >
            {HERO_STATS.map((s) => <HeroStat key={s.label} {...s} />)}
          </div>
        </div>
      </section>

      {/* ── Modules ─────────────────────────────────────────────────────── */}
      <Section
        eyebrow="Enterprise procurement"
        title="Every step of purchase-to-store, in one system"
        lead="Six modules that share one data model, one permission system and one definition of the truth."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(310px, 1fr))', gap: 'var(--sp-5)' }}>
          {MODULES.map((m) => (
            <div
              key={m.title}
              className="card"
              data-accent
              style={{
                padding: 'var(--sp-6)',
                // Feeds the shared `.card::before` hairline, so each module card
                // is topped by its own signature gradient.
                ['--card-accent' as string]: m.grad,
                transition: 'transform var(--dur) var(--ease-out), box-shadow var(--dur) var(--ease-out), border-color var(--dur) var(--ease)',
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = 'translateY(-4px)';
                e.currentTarget.style.boxShadow = 'var(--shadow-lg)';
                e.currentTarget.style.borderColor = m.tint;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = 'none';
                e.currentTarget.style.boxShadow = 'var(--shadow-sm)';
                e.currentTarget.style.borderColor = 'var(--border)';
              }}
            >
              <div
                style={{
                  width: 44, height: 44, borderRadius: 'var(--radius-md)',
                  background: m.grad, color: '#fff',
                  display: 'grid', placeItems: 'center', marginBottom: 'var(--sp-4)',
                  boxShadow: `0 6px 18px color-mix(in srgb, ${m.tint} 45%, transparent)`,
                }}
              >
                {m.icon}
              </div>
              <h3 style={{ fontSize: 'var(--text-md)', marginBottom: 6, color: 'var(--ink-900)' }}>{m.title}</h3>
              <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{m.text}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* ── Workflow ────────────────────────────────────────────────────── */}
      <div id="workflow" style={{ background: 'var(--bg-app)' }}>
        <Section
          eyebrow="The workflow"
          title="Controlled from requisition to receipt"
          lead="Each stage has an owner, a permission and an audit record. Nothing moves forward without them."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))', gap: 'var(--sp-4)' }}>
            {WORKFLOW.map((s, i) => (
              <div key={s.title} className="card" style={{ padding: 'var(--sp-5)', position: 'relative' }}>
                <div className="row" style={{ gap: 10, marginBottom: 'var(--sp-3)' }}>
                  <span
                    style={{
                      width: 34, height: 34, borderRadius: '50%', flexShrink: 0,
                      background: 'var(--grad-brand)', color: '#fff',
                      display: 'grid', placeItems: 'center', boxShadow: 'var(--shadow-sm)',
                    }}
                  >
                    {s.icon}
                  </span>
                  <span
                    className="num"
                    style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--ink-100)', lineHeight: 1, marginLeft: 'auto' }}
                  >
                    {String(i + 1).padStart(2, '0')}
                  </span>
                </div>
                <h3 style={{ fontSize: 'var(--text-sm)', marginBottom: 4, color: 'var(--ink-900)' }}>{s.title}</h3>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', lineHeight: 1.6 }}>{s.text}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* ── Analytics ───────────────────────────────────────────────────── */}
      <Section
        eyebrow="Management analysis"
        title="A dashboard that answers the next question"
        lead="Analytics read the same balance definitions as the operational screens, so the dashboard and the transaction list can never disagree."
      >
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(250px, 1fr))', gap: 'var(--sp-4)' }}>
          {INTELLIGENCE.map((f) => (
            <div key={f.label} style={{ padding: 'var(--sp-5)', borderRadius: 'var(--radius-md)', background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)' }}>
              <div className="row" style={{ gap: 8, marginBottom: 8, color: 'var(--brand-600)' }}>
                {f.icon}
                <span style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-900)' }}>{f.label}</span>
              </div>
              <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{f.text}</p>
            </div>
          ))}
        </div>

        <div
          style={{
            marginTop: 'var(--sp-6)', padding: 'var(--sp-6)',
            borderRadius: 'var(--radius-lg)',
            background: 'var(--grad-brand)', color: '#fff',
            display: 'flex', gap: 'var(--sp-6)', flexWrap: 'wrap', alignItems: 'center',
          }}
        >
          <div className="grow" style={{ minWidth: 260 }}>
            <div style={{ fontSize: 'var(--text-lg)', fontWeight: 600, marginBottom: 5 }}>
              From a KPI to the source document in four clicks
            </div>
            <div style={{ fontSize: 'var(--text-sm)', color: 'rgba(255,255,255,0.75)', lineHeight: 1.6 }}>
              Pending PO value → the pending list → a purchase order → its lines → the originating
              indent. Filters travel with you the whole way.
            </div>
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            {['KPI', 'List', 'Document', 'Line', 'Indent'].map((s, i) => (
              <span key={s} className="row" style={{ gap: 8 }}>
                {i > 0 && <ArrowRight size={13} style={{ opacity: 0.5 }} />}
                <span style={{ padding: '5px 11px', borderRadius: 'var(--radius-full)', background: 'rgba(255,255,255,0.16)', fontSize: 'var(--text-xs)', fontWeight: 500 }}>
                  {s}
                </span>
              </span>
            ))}
          </div>
        </div>
      </Section>

      {/* ── Control & security ──────────────────────────────────────────── */}
      <div style={{ background: 'var(--bg-app)' }}>
        <Section
          eyebrow="Control & security"
          title="Trustworthy where it matters"
          lead="A procurement system is only as good as the guarantees underneath it."
        >
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 'var(--sp-4)' }}>
            {CONTROLS.map((c) => (
              <div key={c.title} className="card" style={{ padding: 'var(--sp-5)' }}>
                <div className="row" style={{ gap: 10, marginBottom: 8 }}>
                  <span
                    style={{
                      width: 34, height: 34, borderRadius: 'var(--radius-sm)', flexShrink: 0,
                      background: 'var(--success-50)', color: 'var(--success-600)',
                      display: 'grid', placeItems: 'center', border: '1px solid var(--success-100)',
                    }}
                  >
                    {c.icon}
                  </span>
                  <h3 style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-900)' }}>{c.title}</h3>
                </div>
                <p style={{ fontSize: 'var(--text-xs)', color: 'var(--text-secondary)', lineHeight: 1.7 }}>{c.text}</p>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* ── CTA ─────────────────────────────────────────────────────────── */}
      <section style={{ padding: 'var(--sp-20) var(--sp-6)', textAlign: 'center' }}>
        <div style={{ maxWidth: 620, margin: '0 auto' }}>
          <h2 style={{ fontSize: 'var(--text-3xl)', letterSpacing: '-0.02em', marginBottom: 'var(--sp-3)', color: 'var(--ink-900)' }}>
            Ready when you are
          </h2>
          <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', marginBottom: 'var(--sp-6)', lineHeight: 1.65 }}>
            Sign in with your Employee ID to open the Zolex workspace.
          </p>
          <Link to="/login" className="btn btn-primary btn-lg">
            Sign in to Zolex <ArrowRight size={17} />
          </Link>
        </div>
      </section>

      {/* ── Footer ──────────────────────────────────────────────────────── */}
      <footer style={{ background: 'var(--brand-900)', color: 'rgba(255,255,255,0.6)', padding: 'var(--sp-8) var(--sp-6)' }}>
        <div
          className="row"
          style={{ maxWidth: 1200, margin: '0 auto', gap: 'var(--sp-4)', flexWrap: 'wrap', justifyContent: 'space-between' }}
        >
          <div className="row" style={{ gap: 10 }}>
            <span style={{ width: 26, height: 26, borderRadius: 7, background: 'var(--grad-accent)', display: 'grid', placeItems: 'center' }}>
              <Zap size={14} color="#fff" strokeWidth={2.5} />
            </span>
            <span style={{ fontSize: 'var(--text-sm)' }}>
              <strong style={{ color: '#fff', letterSpacing: '0.06em' }}>ZOLEX</strong>
              {' · Zeeta Electrical Engineering Pvt. Ltd.'}
            </span>
          </div>
          <div style={{ fontSize: 'var(--text-xs)' }}>
            Purchase-to-Store Enterprise ERP · v1.0
          </div>
        </div>
      </footer>
    </div>
  );
}

function Section({
  eyebrow, title, lead, children,
}: { eyebrow: string; title: string; lead?: string; children: React.ReactNode }) {
  return (
    <section style={{ padding: 'var(--sp-20) var(--sp-6)' }}>
      <div style={{ maxWidth: 1160, margin: '0 auto' }}>
        <div style={{ textAlign: 'center', maxWidth: 720, margin: '0 auto var(--sp-10)' }}>
          <div
            style={{
              fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: '0.1em',
              textTransform: 'uppercase', color: 'var(--accent-600)', marginBottom: 10,
            }}
          >
            {eyebrow}
          </div>
          <h2 style={{ fontSize: 'clamp(1.5rem, 3.2vw, 2.1rem)', letterSpacing: '-0.02em', color: 'var(--ink-900)', marginBottom: lead ? 12 : 0 }}>
            {title}
          </h2>
          {lead && (
            <p style={{ fontSize: 'var(--text-md)', color: 'var(--text-secondary)', lineHeight: 1.65 }}>{lead}</p>
          )}
        </div>
        {children}
      </div>
    </section>
  );
}
