/**
 * Toast notifications (SRS §36: success/error feedback; redesign spec §3.12).
 *
 * Errors from the API carry field issues; the toast shows the headline message
 * and leaves field-level detail to the form that raised it.
 *
 * Timing: success and info leave after 5 s, warnings after 8 s, and errors
 * stay until dismissed — v2 dropped them after 8 s, often before anyone had
 * read the reason. Hovering a toast pauses its timer. At most three show at
 * once, newest on top.
 */
import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { ApiError } from '../lib/api';

type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
  /** Server request id, shown (selectable) on errors so support can find the log line. */
  requestId?: string;
}

interface ToastApi {
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
  /** Renders an unknown thrown value as a user-readable error toast. */
  fromError: (err: unknown, fallback?: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

const ICONS: Record<ToastKind, ReactNode> = {
  success: <CheckCircle2 />,
  error: <AlertCircle />,
  warning: <AlertTriangle />,
  info: <Info />,
};

/** null = stays until dismissed. */
const TTL: Record<ToastKind, number | null> = { success: 5000, info: 5000, warning: 8000, error: null };
const MAX_VISIBLE = 3;

let nextId = 1;

function ToastView({ t, onDismiss }: { t: ToastItem; onDismiss: (id: number) => void }) {
  const ttl = TTL[t.kind];
  const remaining = useRef(ttl ?? 0);
  const started = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  const start = useCallback(() => {
    if (ttl === null) return;
    started.current = Date.now();
    timer.current = window.setTimeout(() => onDismiss(t.id), remaining.current);
  }, [ttl, onDismiss, t.id]);

  const pause = useCallback(() => {
    if (ttl === null) return;
    window.clearTimeout(timer.current);
    remaining.current = Math.max(800, remaining.current - (Date.now() - started.current));
  }, [ttl]);

  useEffect(() => {
    start();
    return () => window.clearTimeout(timer.current);
  }, [start]);

  return (
    <div
      className={`toast toast-${t.kind}`}
      role={t.kind === 'error' ? 'alert' : 'status'}
      onMouseEnter={pause}
      onMouseLeave={start}
      onFocus={pause}
      onBlur={start}
    >
      <span className="toast-icon" aria-hidden>{ICONS[t.kind]}</span>
      <div className="toast-text">
        <div className="toast-title">{t.title}</div>
        {t.message && <div className="toast-message">{t.message}</div>}
        {t.requestId && <div className="toast-request">Request {t.requestId}</div>}
      </div>
      <button type="button" className="toast-close" onClick={() => onDismiss(t.id)} aria-label="Dismiss notification">
        <X size={14} />
      </button>
    </div>
  );
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, title: string, message?: string, requestId?: string) => {
    const id = nextId++;
    setItems((list) => [...list, { id, kind, title, message, requestId }].slice(-MAX_VISIBLE));
  }, []);

  const api = useMemo<ToastApi>(() => ({
    success: (t, m) => push('success', t, m),
    error: (t, m) => push('error', t, m),
    warning: (t, m) => push('warning', t, m),
    info: (t, m) => push('info', t, m),
    fromError: (err, fallback = 'Something went wrong') => {
      if (err instanceof ApiError) {
        // Field issues are shown inline by the form; the toast summarises.
        const detail = err.issues.length > 0
          ? err.issues.map((i) => i.message).slice(0, 2).join(' ')
          : undefined;
        push(err.status === 403 ? 'warning' : 'error', err.message, detail, err.requestId);
        return;
      }
      push('error', fallback, err instanceof Error ? err.message : undefined);
    },
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-region" role="region" aria-label="Notifications">
          {items.map((t) => <ToastView key={t.id} t={t} onDismiss={dismiss} />)}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>.');
  return ctx;
}
