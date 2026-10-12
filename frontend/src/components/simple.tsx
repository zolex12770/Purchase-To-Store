/**
 * Building blocks for the simple, guided screens (Home, Create PO, Receive
 * Material).
 *
 * These exist so every guided screen answers the same three questions the same
 * way — what is waiting, what do I do now, what happens next — with large
 * targets and plain words. They carry no business logic: selection rules,
 * quantities and validation stay in the pages (and on the server).
 */
import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { ArrowRight, Check, Info, AlertTriangle, CircleCheck } from 'lucide-react';
import { Badge } from './ui';

/** A value that only settles once typing pauses — keeps a search from firing per keystroke. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return settled;
}

/** A checkbox that can also show "some, not all" — which a plain `checked` cannot. */
export function TriCheck({
  state, onChange, disabled, label,
}: { state: 'none' | 'some' | 'all'; onChange: () => void; disabled?: boolean; label: string }) {
  return (
    <input
      type="checkbox" className="pick-check" aria-label={label}
      checked={state === 'all'} disabled={disabled}
      ref={(el) => { if (el) el.indeterminate = state === 'some'; }}
      onChange={onChange}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

/* ── Home work card ──────────────────────────────────────────────────────── */

export function WorkCard({
  title, hint, count, loading, failed, action, accent, onClick,
}: {
  title: string;
  /** One short sentence: what this number means. */
  hint: string;
  count: number | null;
  loading?: boolean;
  /** The count could not be loaded — say so rather than show a misleading 0. */
  failed?: boolean;
  /** The verb on the card, e.g. "Approve", "Receive Material". */
  action: string;
  accent?: string;
  onClick: () => void;
}) {
  const shown = loading ? '…' : failed || count === null ? '!' : String(count);
  return (
    <button
      type="button" className="work-card" onClick={onClick}
      style={accent ? ({ '--work-accent': accent } as CSSProperties) : undefined}
    >
      <span className={`work-card-count ${!loading && !failed && count === 0 ? 'is-zero' : ''}`}>{shown}</span>
      <span className="work-card-title">{title}</span>
      <span className="work-card-hint">{failed ? 'Could not load this number. Tap to open the list.' : hint}</span>
      <span className="work-card-action">{action} <ArrowRight size={16} /></span>
    </button>
  );
}

/* ── Choice cards ────────────────────────────────────────────────────────── */

export interface Choice {
  key: string;
  title: string;
  /** One short sentence that says when to use this choice. */
  text: string;
  icon: ReactNode;
  go?: string;
  /** Optional small note under the text, e.g. "3 items are waiting". */
  note?: ReactNode;
}

export function ChoiceCards({ choices, onChoose }: { choices: Choice[]; onChoose: (key: string) => void }) {
  return (
    <div className="choice-grid">
      {choices.map((c) => (
        <button key={c.key} type="button" className="choice-card" onClick={() => onChoose(c.key)}>
          <span className="choice-card-icon">{c.icon}</span>
          <span>
            <span className="choice-card-title" style={{ display: 'block' }}>{c.title}</span>
            <span className="choice-card-text" style={{ display: 'block' }}>{c.text}</span>
            {c.note && <span className="choice-card-text" style={{ display: 'block', marginTop: 6, fontWeight: 600 }}>{c.note}</span>}
            <span className="choice-card-go">{c.go ?? 'Start'} <ArrowRight size={16} /></span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ── Step bar ────────────────────────────────────────────────────────────── */

export function StepBar({ steps, current }: { steps: string[]; current: number }) {
  return (
    <div className="step-bar" aria-label="Steps">
      {steps.map((label, i) => {
        const state = i < current ? 'is-done' : i === current ? 'is-current' : '';
        return (
          <span key={label} className="row" style={{ gap: 'var(--sp-2)' }}>
            {i > 0 && <ArrowRight size={14} className="step-bar-sep" aria-hidden />}
            <span className={`step-bar-item ${state}`} aria-current={i === current ? 'step' : undefined}>
              <span className="step-no">{i < current ? <Check size={14} /> : i + 1}</span>
              {label}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/* ── Help strip ──────────────────────────────────────────────────────────── */

export function HelpStrip({
  children, tone = 'info',
}: { children: ReactNode; tone?: 'info' | 'warning' | 'danger' | 'success' }) {
  const Icon = tone === 'info' ? Info : tone === 'success' ? CircleCheck : AlertTriangle;
  return (
    <div className={`help-strip ${tone === 'info' ? '' : `is-${tone}`}`} role={tone === 'danger' ? 'alert' : undefined}>
      <Icon size={18} style={{ flexShrink: 0, marginTop: 2 }} />
      <div>{children}</div>
    </div>
  );
}

/* ── Selection bar ───────────────────────────────────────────────────────── */

export function SelectionBar({
  text, sub, empty, children,
}: { text: ReactNode; sub?: ReactNode; empty?: boolean; children: ReactNode }) {
  return (
    <div className={`select-bar ${empty ? 'is-empty' : ''}`}>
      <div className="grow">
        <div className="select-bar-text">{text}</div>
        {sub && <div className="select-bar-sub">{sub}</div>}
      </div>
      {children}
    </div>
  );
}

/* ── Plain-word receipt status ───────────────────────────────────────────── */

/** A status word is only useful to the reader if it is one they would say. */
export function receiptStatusLabel(lineStatus: string): string {
  if (lineStatus === 'AWAITING_RECEIPT') return 'Nothing received yet';
  if (lineStatus === 'PARTIALLY_RECEIVED') return 'Part received';
  if (lineStatus === 'COMPLETED') return 'Fully received';
  if (lineStatus === 'CLOSED') return 'Closed';
  return lineStatus.replace(/_/g, ' ').toLowerCase();
}

/** A PO line's receipt state, in the same words on every screen that shows it. */
export function ReceiptBadge({ status }: { status: string }) {
  const tone = status === 'PARTIALLY_RECEIVED' ? 'progress' : status === 'COMPLETED' ? 'success' : 'neutral';
  return <Badge tone={tone} plain>{receiptStatusLabel(status)}</Badge>;
}

/* ── Review cells ────────────────────────────────────────────────────────── */

export function ReviewGrid({ cells }: { cells: { label: string; value: ReactNode }[] }) {
  return (
    <div className="review-grid">
      {cells.map((c) => (
        <div key={c.label} className="review-cell">
          <div className="review-cell-label">{c.label}</div>
          <div className="review-cell-value">{c.value}</div>
        </div>
      ))}
    </div>
  );
}
