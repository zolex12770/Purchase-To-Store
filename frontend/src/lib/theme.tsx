/**
 * Theme control (SRS §15 — visual design system).
 *
 * Three states, deliberately:
 *   'light' / 'dark'  — an explicit user choice, stamped on <html data-theme>
 *   'system'          — no attribute, so the CSS `prefers-color-scheme` media
 *                       query in tokens.css decides
 *
 * The attribute is the single switch the whole design system reads; no component
 * ever branches on the theme in JavaScript.
 *
 * A matching inline script in index.html applies the saved value before first
 * paint. Both must agree on the storage key.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'zolex.theme';

interface ThemeContextValue {
  /** What the user chose. */
  preference: ThemePreference;
  /** What is actually on screen once 'system' is resolved. */
  resolved: ResolvedTheme;
  setPreference: (next: ThemePreference) => void;
  /** Flips between light and dark, resolving 'system' first. */
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function readStoredPreference(): ThemePreference {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'light' || saved === 'dark') return saved;
  } catch {
    // Storage can throw outright in private mode; the OS preference is the fallback.
  }
  return 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState<ThemePreference>(readStoredPreference);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  // Track the OS preference so 'system' stays live rather than sampled once.
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const resolved: ResolvedTheme = preference === 'system'
    ? (systemDark ? 'dark' : 'light')
    : preference;

  useEffect(() => {
    const root = document.documentElement;
    if (preference === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', preference);

    // Keep the browser chrome (mobile address bar) in step with the canvas
    // (--bg-canvas in tokens.css).
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', resolved === 'dark' ? '#141210' : '#f4f1ec');
  }, [preference, resolved]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      if (next === 'system') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // A theme that cannot be persisted still applies for this session.
    }
  }, []);

  const toggle = useCallback(() => {
    setPreference(resolved === 'dark' ? 'light' : 'dark');
  }, [resolved, setPreference]);

  const value = useMemo(
    () => ({ preference, resolved, setPreference, toggle }),
    [preference, resolved, setPreference, toggle],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used inside <ThemeProvider>');
  return ctx;
}
