/**
 * API client.
 *
 * One place that knows how to talk to the backend: token handling, the response
 * envelope, transparent refresh on 401, and error objects the UI can render as
 * field-level messages (SRS §36 "show actionable validation errors next to fields").
 */

const BASE = '/api/v1';

export interface FieldIssue {
  field: string;
  message: string;
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly issues: FieldIssue[];
  readonly details?: Record<string, unknown>;
  readonly requestId?: string;

  constructor(
    status: number,
    code: string,
    message: string,
    issues: FieldIssue[] = [],
    details?: Record<string, unknown>,
    requestId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.issues = issues;
    this.details = details;
    this.requestId = requestId;
  }

  /** Field-keyed map for inline form errors. */
  get fieldErrors(): Record<string, string> {
    return Object.fromEntries(this.issues.map((i) => [i.field, i.message]));
  }

  get isAuth(): boolean {
    return this.status === 401;
  }
  get isForbidden(): boolean {
    return this.status === 403;
  }
}

/* ── Token store ─────────────────────────────────────────────────────────────
   The access token lives in memory, not localStorage, so an XSS payload cannot
   read it back out of storage. Continuity across reloads comes from the
   httpOnly refresh cookie instead.                                            */

let accessToken: string | null = null;
let onUnauthenticated: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}

/* ── Refresh coordination ────────────────────────────────────────────────────
   Many queries can 401 at once; they must all wait on ONE refresh rather than
   stampeding the endpoint.                                                    */

export interface RefreshOutcome {
  ok: boolean;
  user?: unknown;
}

let refreshPromise: Promise<RefreshOutcome> | null = null;

/**
 * Latched once a refresh has definitively failed.
 *
 * Without this, every subsequent request — and every page navigation — would try
 * to refresh again. A genuinely expired session then produces a burst of failed
 * auth calls that trips server-side rate limiting and locks the user out of the
 * very sign-in screen that would fix it. The latch clears on a successful login.
 */
let refreshFailed = false;

/**
 * How long a completed refresh is shared with later callers.
 *
 * The server ROTATES the refresh token — presenting it a second time is correctly
 * rejected. So every concurrent caller must share ONE network call: React's
 * StrictMode double-invokes effects, and a page load fires several queries at
 * once, all of which would otherwise race and invalidate each other's token.
 */
const REFRESH_SHARE_MS = 3000;

/** Called by the auth layer after a successful sign-in. */
export function resetRefreshState(): void {
  refreshFailed = false;
  refreshPromise = null;
}

export async function refreshSession(): Promise<RefreshOutcome> {
  if (refreshFailed) return { ok: false };

  if (!refreshPromise) {
    refreshPromise = (async (): Promise<RefreshOutcome> => {
      try {
        const res = await fetch(`${BASE}/auth/refresh`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
        });
        if (!res.ok) {
          refreshFailed = true;
          return { ok: false };
        }
        // A 200 with no access token means "no session" — a normal state for an
        // anonymous visitor, not a failure worth latching or logging.
        const json = (await res.json()) as {
          data?: { accessToken?: string; user?: unknown; authenticated?: boolean };
        };
        if (json.data?.accessToken) {
          accessToken = json.data.accessToken;
          return { ok: true, user: json.data.user };
        }
        refreshFailed = true;
        return { ok: false };
      } catch {
        // A network blip must not latch — only a definitive server refusal does.
        return { ok: false };
      } finally {
        // Hold the result briefly so duplicate callers coalesce onto this one call.
        setTimeout(() => { refreshPromise = null; }, REFRESH_SHARE_MS);
      }
    })();
  }
  return refreshPromise;
}

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
  /** Internal: prevents infinite refresh recursion. */
  _retried?: boolean;
}

async function toApiError(res: Response): Promise<ApiError> {
  let payload: {
    error?: { code?: string; message?: string; issues?: FieldIssue[]; details?: Record<string, unknown>; requestId?: string };
  } = {};
  try {
    payload = await res.json();
  } catch {
    /* non-JSON error body */
  }
  const e = payload.error;
  return new ApiError(
    res.status,
    e?.code ?? 'SERVER_ERROR',
    e?.message ??
      (res.status === 404
        ? 'That record could not be found.'
        : res.status >= 500
          ? 'The server could not complete this request. Please try again.'
          : 'Something went wrong.'),
    e?.issues ?? [],
    e?.details,
    e?.requestId,
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, _retried } = options;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(
      0,
      'NETWORK_ERROR',
      'Cannot reach the Zolex server. Check that the backend is running on port 4000.',
    );
  }

  if (res.status === 401 && !_retried && !path.startsWith('/auth/')) {
    if ((await refreshSession()).ok) {
      return request<T>(path, { ...options, _retried: true });
    }
    accessToken = null;
    onUnauthenticated?.();
    throw await toApiError(res);
  }

  if (!res.ok) throw await toApiError(res);
  if (res.status === 204) return undefined as T;

  const json = (await res.json()) as { data: T };
  return json.data;
}

/** Like `request`, but also returns the response envelope's `meta`. */
export async function requestWithMeta<T, M = Record<string, unknown>>(
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; meta: M }> {
  const { method = 'GET', body, signal, _retried } = options;

  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the Zolex server. Check that the backend is running on port 4000.');
  }

  if (res.status === 401 && !_retried && !path.startsWith('/auth/')) {
    if ((await refreshSession()).ok) return requestWithMeta<T, M>(path, { ...options, _retried: true });
    accessToken = null;
    onUnauthenticated?.();
    throw await toApiError(res);
  }
  if (!res.ok) throw await toApiError(res);

  const json = (await res.json()) as { data: T; meta?: M };
  return { data: json.data, meta: (json.meta ?? {}) as M };
}

export const api = {
  get: <T>(path: string, signal?: AbortSignal) => request<T>(path, { signal }),
  getWithMeta: <T, M = Record<string, unknown>>(path: string, signal?: AbortSignal) =>
    requestWithMeta<T, M>(path, { signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  put: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PUT', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/**
 * Triggers a file download through an authenticated request.
 * A plain <a href> cannot carry the bearer token, so the file is fetched as a
 * blob and handed to the browser.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });

  if (res.status === 401 && (await refreshSession()).ok) {
    return downloadFile(path, fallbackName);
  }
  if (!res.ok) throw await toApiError(res);

  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  const filename = match?.[1] ?? fallbackName;

  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/**
 * Fetches an authenticated endpoint's raw HTML body (e.g. a document preview) —
 * same bearer-token-attached, refresh-on-401 pattern as downloadFile, but
 * returns the text instead of triggering a save.
 */
export async function fetchHtml(path: string): Promise<string> {
  const res = await fetch(`${BASE}${path}`, {
    credentials: 'include',
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
  });
  if (res.status === 401 && (await refreshSession()).ok) {
    return fetchHtml(path);
  }
  if (!res.ok) throw await toApiError(res);
  return res.text();
}

/** Uploads a file (import preview) with the bearer token attached. */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);

  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    // Content-Type is intentionally omitted so the browser sets the multipart boundary.
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
    body: form,
  });

  if (!res.ok) throw await toApiError(res);
  const json = (await res.json()) as { data: T };
  return json.data;
}

/** Builds a query string from a filter object, dropping empty values. */
export function qs(params: Record<string, unknown>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      sp.set(key, value.join(','));
    } else if (typeof value === 'boolean') {
      sp.set(key, value ? 'true' : 'false');
    } else {
      sp.set(key, String(value));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export interface PageMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
  hasNext: boolean;
  hasPrev: boolean;
  [key: string]: unknown;
}
