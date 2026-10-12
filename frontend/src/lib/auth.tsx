/**
 * Authentication context (SRS §5, §18).
 *
 * `can()` drives permission-aware UI. It is a CONVENIENCE, not a security
 * boundary — every route it guards is re-checked server-side, so hiding a button
 * here only improves ergonomics; it never grants or withholds actual access.
 */
import { createContext, useContext, useState, useEffect, useCallback, useMemo, type ReactNode } from 'react';
import { api, setAccessToken, setUnauthenticatedHandler, resetRefreshState, refreshSession, ApiError } from './api';

export interface CurrentUser {
  id: number;
  employeeId: string;
  employeeName: string;
  designation: string;
  email: string | null;
  mobileNo?: string | null;
  department?: string | null;
  departmentId?: number | null;
  lastLoginAt?: string | null;
  roles: string[];
  permissions: string[];
  mustChangePassword: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  signIn: (employeeId: string, password: string) => Promise<CurrentUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<string>;
  can: (...permissions: string[]) => boolean;
  canAny: (...permissions: string[]) => boolean;
  isSuperAdmin: boolean;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadUser = useCallback(async () => {
    try {
      const me = await api.get<CurrentUser>('/auth/me');
      setUser(me);
    } catch {
      setUser(null);
    }
  }, []);

  // On boot, restore a session from the httpOnly refresh cookie.
  //
  // This goes through the SHARED `refreshSession()` rather than its own fetch, so
  // that React StrictMode's double-invoked effect and any queries firing at the
  // same moment all coalesce onto one network call. The server rotates the refresh
  // token, so a second concurrent call would present an already-revoked one.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const outcome = await refreshSession();
        if (!cancelled && outcome.ok && outcome.user) {
          setUser(outcome.user as CurrentUser);
        }
      } catch {
        /* no session — land on the public routes */
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // A hard 401 anywhere clears local state so the UI cannot pretend to be signed in.
  useEffect(() => {
    setUnauthenticatedHandler(() => setUser(null));
    return () => setUnauthenticatedHandler(null);
  }, []);

  const signIn = useCallback(async (employeeId: string, password: string) => {
    const res = await api.post<{ accessToken: string; user: CurrentUser }>('/auth/login', {
      employeeId,
      password,
    });
    setAccessToken(res.accessToken);
    // A fresh sign-in re-arms token refresh after any previous failure.
    resetRefreshState();
    setUser(res.user);
    return res.user;
  }, []);

  const signOut = useCallback(async () => {
    try {
      await api.post('/auth/logout');
    } catch {
      /* sign out locally even if the server call fails */
    }
    setAccessToken(null);
    setUser(null);
  }, []);

  const changePassword = useCallback(async (currentPassword: string, newPassword: string) => {
    const res = await api.post<{ message: string }>('/auth/change-password', {
      currentPassword,
      newPassword,
    });
    // The server revokes every session on a password change, so sign out locally.
    setAccessToken(null);
    setUser(null);
    return res.message;
  }, []);

  const permissionSet = useMemo(() => new Set(user?.permissions ?? []), [user]);

  const can = useCallback(
    (...permissions: string[]) => permissions.every((p) => permissionSet.has(p)),
    [permissionSet],
  );
  const canAny = useCallback(
    (...permissions: string[]) => permissions.some((p) => permissionSet.has(p)),
    [permissionSet],
  );

  const value = useMemo<AuthState>(
    () => ({
      user,
      loading,
      signIn,
      signOut,
      refreshUser: loadUser,
      changePassword,
      can,
      canAny,
      isSuperAdmin: (user?.roles ?? []).includes('SUPER_ADMIN'),
    }),
    [user, loading, signIn, signOut, loadUser, changePassword, can, canAny],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>.');
  return ctx;
}

export { ApiError };
