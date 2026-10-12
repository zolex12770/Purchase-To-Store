/**
 * Toast notifications (SRS §36: provide success/error feedback).
 *
 * Errors from the API carry field issues; the toast shows the headline message
 * and leaves field-level detail to the form that raised it.
 */
import { createContext, useContext, useState, useCallback, useMemo, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckCircle2, AlertCircle, AlertTriangle, Info, X } from 'lucide-react';
import { ApiError } from '../lib/api';

type ToastKind = 'success' | 'error' | 'warning' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  title: string;
  message?: string;
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

let nextId = 1;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((kind: ToastKind, title: string, message?: string) => {
    const id = nextId++;
    setItems((list) => [...list.slice(-4), { id, kind, title, message }]);
    // Errors linger longer — they usually need reading.
    const ttl = kind === 'error' ? 8000 : kind === 'warning' ? 6000 : 4200;
    setTimeout(() => dismiss(id), ttl);
  }, [dismiss]);

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
        push(err.status === 403 ? 'warning' : 'error', err.message, detail);
        return;
      }
      push('error', fallback, err instanceof Error ? err.message : undefined);
    },
  }), [push]);

  return (
    <ToastContext.Provider value={api}>
      {children}
      {createPortal(
        <div className="toast-region" role="region" aria-live="polite" aria-label="Notifications">
          {items.map((t) => (
            <div key={t.id} className={`toast toast-${t.kind}`}>
              <span className="toast-icon" aria-hidden>{ICONS[t.kind]}</span>
              <div className="grow">
                <div className="toast-title">{t.title}</div>
                {t.message && <div className="toast-text">{t.message}</div>}
              </div>
              <button
                onClick={() => dismiss(t.id)}
                aria-label="Dismiss"
                style={{ color: 'var(--ink-400)', display: 'grid', placeItems: 'center', flexShrink: 0 }}
              >
                <X size={13} />
              </button>
            </div>
          ))}
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
