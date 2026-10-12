/**
 * Design-system primitives (SRS §15, §36).
 *
 * Every interactive element here ships its hover, focus, disabled, loading and
 * pressed states, so no screen has to reinvent them and the product feels like
 * one system rather than a set of pages.
 */
import {
  useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode, type CSSProperties, type ButtonHTMLAttributes,
  type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes,
} from 'react';
import { createPortal } from 'react-dom';
import { X, AlertCircle, ChevronDown, Inbox, Search, Check } from 'lucide-react';
import { statusLabel, statusTone, type Tone } from '../lib/format';

/* ═══════════════════════════ BUTTON ═══════════════════════════════════ */

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success' | 'accent';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: 'sm' | 'md' | 'lg';
  loading?: boolean;
  icon?: ReactNode;
  iconRight?: ReactNode;
  block?: boolean;
}

export function Button({
  variant = 'secondary', size = 'md', loading = false, icon, iconRight,
  block, children, className = '', disabled, ...rest
}: ButtonProps) {
  const classes = [
    'btn', `btn-${variant}`,
    size === 'sm' ? 'btn-sm' : size === 'lg' ? 'btn-lg' : '',
    !children ? 'btn-icon' : '',
    block ? 'btn-block' : '',
    className,
  ].filter(Boolean).join(' ');

  return (
    <button className={classes} disabled={disabled || loading} {...rest}>
      {/* A loading button is disabled, which is what stops duplicate submission (SRS §36). */}
      {loading ? <span className="spinner" aria-hidden /> : icon}
      {children}
      {!loading && iconRight}
    </button>
  );
}

/* ═══════════════════════════ CARD ═════════════════════════════════════ */

export function Card({
  children, className = '', onClick, ...rest
}: { children: ReactNode; className?: string; onClick?: () => void } & Record<string, unknown>) {
  const clickable = Boolean(onClick);
  return (
    <div
      className={`card ${clickable ? 'card-clickable' : ''} ${className}`}
      onClick={onClick}
      onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick?.(); } } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title, subtitle, actions, icon,
}: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="card-header">
      {icon && <span style={{ color: 'var(--brand-500)', display: 'grid', placeItems: 'center' }}>{icon}</span>}
      <div className="grow">
        <div className="card-title">{title}</div>
        {subtitle && <div className="card-subtitle">{subtitle}</div>}
      </div>
      {actions && <div className="row" style={{ gap: 'var(--sp-2)' }}>{actions}</div>}
    </div>
  );
}

export const CardBody = ({
  children, flush, className = '', style,
}: {
  children: ReactNode; flush?: boolean; className?: string; style?: CSSProperties;
}) => (
  <div className={`${flush ? 'card-body-flush' : 'card-body'} ${className}`} style={style}>
    {children}
  </div>
);

/* ═══════════════════════════ BADGE ════════════════════════════════════ */

export function Badge({
  children, tone = 'neutral', plain,
}: { children: ReactNode; tone?: Tone; plain?: boolean }) {
  return <span className={`badge badge-${tone} ${plain ? 'badge-plain' : ''}`}>{children}</span>;
}

/** Status badge driven by the shared status→tone map, so colour never disagrees. */
export const StatusBadge = ({ status }: { status: string | null | undefined }) => (
  <Badge tone={statusTone(status)}>{statusLabel(status)}</Badge>
);

/* ═══════════════════════════ FORM ═════════════════════════════════════ */

export function Field({
  label, required, hint, error, children, className = '', span,
}: {
  label?: ReactNode; required?: boolean; hint?: ReactNode; error?: string;
  children: ReactNode; className?: string; span?: 2 | 'full';
}) {
  const spanClass = span === 2 ? 'field-span-2' : span === 'full' ? 'field-span-full' : '';
  return (
    <div className={`field ${spanClass} ${className}`}>
      {label && (
        <label className="field-label">
          {label}
          {required && <span className="req" aria-hidden>*</span>}
        </label>
      )}
      {children}
      {/* The error replaces the hint so the two never compete for the same slot. */}
      {error ? (
        <span className="field-error"><AlertCircle size={12} aria-hidden /> {error}</span>
      ) : hint ? (
        <span className="field-hint">{hint}</span>
      ) : null}
    </div>
  );
}

interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  invalid?: boolean;
  numeric?: boolean;
}
export function Input({ invalid, numeric, className = '', ...rest }: InputProps) {
  return (
    <input
      className={`input ${invalid ? 'input-error' : ''} ${numeric ? 'input-num' : ''} ${className}`}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
}

interface SelectProps extends SelectHTMLAttributes<HTMLSelectElement> {
  invalid?: boolean;
  placeholder?: string;
  options?: { value: string | number; label: string }[];
}
export function Select({ invalid, placeholder, options, children, className = '', ...rest }: SelectProps) {
  return (
    <select className={`select ${invalid ? 'select-error' : ''} ${className}`} aria-invalid={invalid || undefined} {...rest}>
      {placeholder && <option value="">{placeholder}</option>}
      {options?.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      {children}
    </select>
  );
}

export function Textarea({ invalid, className = '', ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { invalid?: boolean }) {
  return <textarea className={`textarea ${invalid ? 'input-error' : ''} ${className}`} aria-invalid={invalid || undefined} {...rest} />;
}

export function Checkbox({
  label, checked, onChange, disabled,
}: { label: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="check-row" style={disabled ? { opacity: 0.55, cursor: 'not-allowed' } : undefined}>
      <input type="checkbox" className="checkbox" checked={checked} disabled={disabled}
             onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/* ═══════════════════════════ SEARCHABLE SELECT ════════════════════════
   Used wherever the SRS calls for a "searchable dropdown" (item / supplier
   selection, §10). Keyboard-navigable and closes on outside click.          */

export interface Option {
  value: number | string;
  label: string;
  sublabel?: string;
  meta?: string;
}

export function SearchSelect({
  value, onChange, options, placeholder = 'Search…', disabled, invalid, emptyText = 'No matches',
  onSearch, searching, selectedOption,
}: {
  value: number | string | null;
  onChange: (value: number | string | null, option: Option | null) => void;
  options: Option[];
  placeholder?: string;
  disabled?: boolean;
  invalid?: boolean;
  emptyText?: string;
  /**
   * Makes the search run on the SERVER. Without it the box only filters the
   * `options` it was handed, which is right for a short master list and badly
   * wrong for a long one: handed the first 50 of 12,000 items, it can never
   * find the other 11,950 however exactly the code is typed. With it, every
   * keystroke is passed up, the caller fetches matching rows, and `options` is
   * shown as given.
   */
  onSearch?: (term: string) => void;
  /** A server search is in flight — shown instead of a premature "no matches". */
  searching?: boolean;
  /** The chosen value's own label, for when it is not among the current `options`. */
  selectedOption?: Option | null;
}) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const [highlight, setHighlight] = useState(0);
  // Computed fresh every time the panel opens (and kept in sync while open) so
  // it is never clipped by an ancestor's overflow (a card, modal, drawer, or a
  // horizontally-scrolling table wrapper) — the panel is portaled to <body>
  // and positioned in viewport coordinates, the same escape hatch Modal/Drawer
  // already use for the same reason.
  const [rect, setRect] = useState<{ top: number; left: number; width: number; openUp: boolean } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => String(o.value) === String(value))
    ?? (selectedOption && String(selectedOption.value) === String(value) ? selectedOption : null);

  // With a server search the rows handed in ARE the matches; filtering them
  // again here would hide a hit the server found on a field this box cannot see.
  const filtered = onSearch
    ? options.slice(0, 60)
    : term.trim()
      ? options.filter((o) => {
          const t = term.toLowerCase();
          return o.label.toLowerCase().includes(t) || (o.sublabel ?? '').toLowerCase().includes(t);
        }).slice(0, 60)
      : options.slice(0, 60);

  // Kept in a ref so the effect below depends on the typed term alone — a
  // caller passing a fresh inline function must not re-trigger the search.
  const onSearchRef = useRef(onSearch);
  onSearchRef.current = onSearch;
  useEffect(() => { onSearchRef.current?.(term); }, [term]);

  const reposition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const PANEL_MAX = 300;
    const spaceBelow = window.innerHeight - r.bottom;
    const openUp = spaceBelow < PANEL_MAX + 12 && r.top > spaceBelow;
    setRect({
      top: openUp ? r.top - 4 : r.bottom + 4,
      left: r.left,
      width: r.width,
      openUp,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    reposition();
    // Capture phase so a scroll on ANY ancestor (a .table-wrap, modal body,
    // drawer, the page itself) repositions the panel instead of leaving it
    // stranded relative to a trigger that has moved under it.
    window.addEventListener('scroll', reposition, true);
    window.addEventListener('resize', reposition);
    return () => {
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('resize', reposition);
    };
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t)) return;
      if (panelRef.current?.contains(t)) return;
      setOpen(false);
      setTerm('');
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  useEffect(() => { if (open) inputRef.current?.focus(); }, [open]);
  useEffect(() => { setHighlight(0); }, [term]);

  const choose = (o: Option) => {
    onChange(o.value, o);
    setOpen(false);
    setTerm('');
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <button
        ref={triggerRef}
        type="button"
        className={`input ${invalid ? 'input-error' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, textAlign: 'left', width: '100%' }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="truncate" style={{ color: selected ? 'var(--text-primary)' : 'var(--text-faint)', minWidth: 0 }}>
          {selected ? selected.label : placeholder}
        </span>
        <ChevronDown size={14} style={{ flexShrink: 0, color: 'var(--ink-400)' }} aria-hidden />
      </button>

      {open && rect && createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={{
            position: 'fixed',
            top: rect.openUp ? undefined : rect.top,
            bottom: rect.openUp ? window.innerHeight - rect.top : undefined,
            left: rect.left, width: Math.max(rect.width, 220),
            background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
            zIndex: 'var(--z-dropdown)' as unknown as number,
            maxHeight: 300, display: 'flex', flexDirection: 'column',
            animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
          }}
        >
          <div style={{ padding: 8, borderBottom: '1px solid var(--border-subtle)', position: 'relative' }}>
            <Search size={13} style={{ position: 'absolute', left: 18, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)' }} aria-hidden />
            <input
              ref={inputRef}
              className="input input-sm"
              style={{ paddingLeft: 30 }}
              value={term}
              placeholder={onSearch ? 'Type to search…' : 'Type to filter…'}
              onChange={(e) => setTerm(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, filtered.length - 1)); }
                else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
                else if (e.key === 'Enter') { e.preventDefault(); const o = filtered[highlight]; if (o) choose(o); }
                else if (e.key === 'Escape') { setOpen(false); setTerm(''); }
              }}
            />
          </div>

          <div style={{ overflowY: 'auto', flex: 1 }}>
            {filtered.length === 0 && (
              <div style={{ padding: '16px 12px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', textAlign: 'center' }}>
                {searching ? 'Searching…' : emptyText}
              </div>
            )}
            {filtered.map((o, i) => {
              const isSelected = String(o.value) === String(value);
              return (
                <button
                  key={o.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(o)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 8, width: '100%',
                    padding: '7px 10px', textAlign: 'left',
                    background: i === highlight ? 'var(--brand-50)' : 'transparent',
                    borderLeft: isSelected ? '2px solid var(--brand-500)' : '2px solid transparent',
                  }}
                >
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="truncate" style={{ display: 'block', fontSize: 'var(--text-sm)', fontWeight: 500, color: 'var(--ink-800)' }}>
                      {o.label}
                    </span>
                    {o.sublabel && (
                      <span className="truncate" style={{ display: 'block', fontSize: 'var(--text-2xs)', color: 'var(--text-muted)' }}>
                        {o.sublabel}
                      </span>
                    )}
                  </span>
                  {o.meta && <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', flexShrink: 0 }}>{o.meta}</span>}
                  {isSelected && <Check size={13} style={{ color: 'var(--brand-600)', flexShrink: 0 }} aria-hidden />}
                </button>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

/* ═══════════════════════════ MODAL ════════════════════════════════════ */

export function Modal({
  open, onClose, title, subtitle, children, footer, size = 'md', closeOnOverlay = true,
}: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; size?: 'sm' | 'md' | 'lg' | 'xl';
  closeOnOverlay?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    // Prevent the page behind the modal from scrolling.
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="overlay" onMouseDown={(e) => { if (closeOnOverlay && e.target === e.currentTarget) onClose(); }}>
      <div className={`modal modal-${size}`} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        <div className="modal-header">
          <div className="grow">
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X size={15} /></Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

/* ═══════════════════════════ DRAWER ═══════════════════════════════════
   Used for drill-down where a modal would feel cramped (SRS §14).          */

export function Drawer({
  open, onClose, title, subtitle, children, footer, wide, actions,
}: {
  open: boolean; onClose: () => void; title: ReactNode; subtitle?: ReactNode;
  children: ReactNode; footer?: ReactNode; wide?: boolean; actions?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('keydown', onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="drawer-overlay" onClick={onClose} />
      <aside className={`drawer ${wide ? 'drawer-wide' : ''}`} role="dialog" aria-modal="true">
        <div className="modal-header">
          <div className="grow">
            <div className="modal-title">{title}</div>
            {subtitle && <div className="modal-subtitle">{subtitle}</div>}
          </div>
          {actions}
          <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close"><X size={15} /></Button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </aside>
    </>,
    document.body,
  );
}

/** Confirmation for destructive or irreversible actions (SRS §36). */
export function ConfirmDialog({
  open, onClose, onConfirm, title, message, confirmLabel = 'Confirm',
  variant = 'danger', loading, requireReason, reasonLabel = 'Reason', reasonValue, onReasonChange,
}: {
  open: boolean; onClose: () => void; onConfirm: () => void;
  title: string; message: ReactNode; confirmLabel?: string;
  variant?: Variant; loading?: boolean;
  requireReason?: boolean; reasonLabel?: string;
  reasonValue?: string; onReasonChange?: (v: string) => void;
}) {
  const blocked = requireReason && !(reasonValue ?? '').trim();
  return (
    <Modal
      open={open} onClose={onClose} title={title} size="sm"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={loading}>Cancel</Button>
          <Button variant={variant} onClick={onConfirm} loading={loading} disabled={blocked}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div style={{ fontSize: 'var(--text-sm)', color: 'var(--text-secondary)', lineHeight: 1.6 }}>{message}</div>
      {requireReason && (
        <div style={{ marginTop: 'var(--sp-4)' }}>
          <Field label={reasonLabel} required error={blocked ? 'A reason is required.' : undefined}>
            <Textarea
              value={reasonValue ?? ''}
              onChange={(e) => onReasonChange?.(e.target.value)}
              placeholder="State the reason — this is recorded in the audit trail."
              rows={3}
              autoFocus
            />
          </Field>
        </div>
      )}
    </Modal>
  );
}

/* ═══════════════════════════ TABS ═════════════════════════════════════ */

export interface TabDef {
  key: string;
  label: string;
  icon?: ReactNode;
  count?: number;
}

export function Tabs({
  tabs, active, onChange,
}: { tabs: TabDef[]; active: string; onChange: (key: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.key}
          role="tab"
          aria-selected={active === t.key}
          className={`tab ${active === t.key ? 'active' : ''}`}
          onClick={() => onChange(t.key)}
        >
          {t.icon}
          {t.label}
          {t.count !== undefined && <span className="tab-count">{t.count}</span>}
        </button>
      ))}
    </div>
  );
}

/* ═══════════════════════════ STATES ═══════════════════════════════════ */

export const Spinner = ({ large }: { large?: boolean }) => (
  <span className={`spinner ${large ? 'spinner-lg' : ''}`} role="status" aria-label="Loading" />
);

export function LoadingBlock({ label = 'Loading…', height = 220 }: { label?: string; height?: number }) {
  return (
    <div style={{ display: 'grid', placeItems: 'center', minHeight: height, gap: 'var(--sp-3)', color: 'var(--ink-400)' }}>
      <Spinner large />
      <span style={{ fontSize: 'var(--text-sm)' }}>{label}</span>
    </div>
  );
}

export function EmptyState({
  icon, title, message, action,
}: { icon?: ReactNode; title: string; message?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">{icon ?? <Inbox />}</div>
      <div className="empty-title">{title}</div>
      {message && <div className="empty-text">{message}</div>}
      {action && <div style={{ marginTop: 'var(--sp-2)' }}>{action}</div>}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'An unexpected error occurred.';
  return (
    <div className="empty-state">
      <div className="empty-icon" style={{ background: 'var(--danger-50)', color: 'var(--danger-500)', borderColor: 'var(--danger-100)' }}>
        <AlertCircle />
      </div>
      <div className="empty-title">Could not load this information</div>
      <div className="empty-text">{message}</div>
      {onRetry && <Button variant="secondary" size="sm" onClick={onRetry} style={{ marginTop: 'var(--sp-2)' }}>Try again</Button>}
    </div>
  );
}

export const Skeleton = ({ w = '100%', h = 14, r }: { w?: string | number; h?: number; r?: number }) => (
  <div className="skeleton" style={{ width: w, height: h, borderRadius: r ?? 'var(--radius-xs)' }} />
);

export function SkeletonTable({ rows = 6, cols = 5 }: { rows?: number; cols?: number }) {
  return (
    <div style={{ padding: 'var(--sp-4)' }}>
      <div style={{ display: 'flex', gap: 'var(--sp-4)', marginBottom: 'var(--sp-4)' }}>
        {Array.from({ length: cols }).map((_, i) => <Skeleton key={i} h={11} w={i === 0 ? 100 : 70} />)}
      </div>
      {Array.from({ length: rows }).map((_, r) => (
        <div key={r} style={{ display: 'flex', gap: 'var(--sp-4)', marginBottom: 'var(--sp-3)' }}>
          {Array.from({ length: cols }).map((_, c) => (
            <Skeleton key={c} h={15} w={c === 0 ? 130 : `${50 + ((r + c) % 4) * 12}px`} />
          ))}
        </div>
      ))}
    </div>
  );
}

/* ═══════════════════════════ MISC ═════════════════════════════════════ */

export function ProgressBar({ value, tone = 'info' }: { value: number; tone?: Tone }) {
  const colors: Record<Tone, string> = {
    neutral: 'var(--ink-400)',
    info: 'var(--info-500)',
    success: 'var(--success-500)',
    warning: 'var(--warning-500)',
    danger: 'var(--danger-500)',
    progress: 'var(--progress-500)',
  };
  const pct = Math.max(0, Math.min(100, value));
  return (
    <div className="progress-track" role="progressbar" aria-valuenow={Math.round(pct)} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress-fill" style={{ width: `${pct}%`, background: colors[tone] }} />
    </div>
  );
}

export const Chip = ({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) => (
  <span className="chip">
    {children}
    {onRemove && <button type="button" onClick={onRemove} aria-label="Remove filter"><X size={11} /></button>}
  </span>
);

/** Label/value pair used throughout detail views and print layouts. */
export function DetailItem({ label, children, mono }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div>
      <div style={{ fontSize: 'var(--text-2xs)', fontWeight: 600, color: 'var(--text-faint)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 3 }}>
        {label}
      </div>
      <div className={mono ? 'mono' : ''} style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-800)', fontWeight: 500 }}>
        {children}
      </div>
    </div>
  );
}

/**
 * Label/value grid.
 *
 * `cols` is the target at full width; the track minimum is sized so the grid
 * genuinely reaches that many columns inside a normal card, and degrades one
 * column at a time as the container narrows.
 */
export const DetailGrid = ({ children, cols = 4 }: { children: ReactNode; cols?: number }) => {
  const min = cols >= 4 ? 165 : cols === 3 ? 180 : 220;
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(auto-fit, minmax(min(${min}px, 100%), 1fr))`,
        gap: 'var(--sp-4) var(--sp-5)',
      }}
    >
      {children}
    </div>
  );
};

/** Section heading inside a page or drawer. */
export function SectionTitle({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="row" style={{ gap: 'var(--sp-3)', marginBottom: 'var(--sp-3)' }}>
      <h3 style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-700)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
        {children}
      </h3>
      <div className="divider grow" style={{ height: 1 }} />
      {action}
    </div>
  );
}

/** Copies text to the clipboard with transient feedback. */
export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = useCallback(() => {
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    });
  }, [value]);
  return (
    <Button variant="ghost" size="sm" onClick={copy}>
      {copied ? <><Check size={12} /> Copied</> : label}
    </Button>
  );
}
