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
let onPasswordChangeRequired: (() => void) | null = null;

export function setAccessToken(token: string | null): void {
  accessToken = token;
}
export function getAccessToken(): string | null {
  return accessToken;
}
export function setUnauthenticatedHandler(fn: (() => void) | null): void {
  onUnauthenticated = fn;
}
/** Called when the server refuses a request because this account owes a password change. */
export function setPasswordChangeRequiredHandler(fn: (() => void) | null): void {
  onPasswordChangeRequired = fn;
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
  // Until an owed password change is made the server answers nothing but the
  // auth routes, whichever screen asked — so the change-password screen takes
  // over instead of that screen showing the refusal.
  if (res.status === 403 && e?.code === 'PASSWORD_CHANGE_REQUIRED') onPasswordChangeRequired?.();
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

/** Requests had no time limit: a stuck call left a spinner forever. The longest list
    (purchase orders) answers in about 8 s, so 90 s only ever catches a dead connection. */
const REQUEST_TIMEOUT_MS = 90_000;

interface TimeLimit {
  signal: AbortSignal;
  /** The limit fired: whatever the fetch or a read of its body rejects with since is a timeout. */
  readonly timedOut: boolean;
  /** The caller aborted, through its own signal. */
  readonly cancelled: boolean;
  /** Starts the wait again: a body still arriving is not stuck. */
  restart: () => void;
  done: () => void;
}

function withTimeout(signal?: AbortSignal): TimeLimit {
  // Built by hand rather than AbortSignal.any/timeout, which older shop-floor browsers lack.
  const ctl = new AbortController();
  let fired = false;
  let finished = false;
  const fire = () => {
    if (ctl.signal.aborted) return; // the caller's abort came first, and is what it was
    fired = true;
    ctl.abort(new DOMException('Request timed out', 'TimeoutError'));
  };
  let timer = setTimeout(fire, REQUEST_TIMEOUT_MS);
  const forward = () => ctl.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) forward();
    else signal.addEventListener('abort', forward, { once: true });
  }
  return {
    signal: ctl.signal,
    get timedOut() { return fired; },
    get cancelled() { return signal?.aborted === true; },
    restart: () => {
      if (finished || ctl.signal.aborted) return;
      clearTimeout(timer);
      timer = setTimeout(fire, REQUEST_TIMEOUT_MS);
    },
    done: () => { finished = true; clearTimeout(timer); signal?.removeEventListener('abort', forward); },
  };
}

const TOOK_TOO_LONG = 'The server took too long to answer. Please try again.';

/**
 * A fetch that never got an answer, as the error a screen can show: the caller's own
 * abort as it was, the time limit as TIMEOUT, anything else as NETWORK_ERROR. A raw
 * "TypeError: Failed to fetch" reached the screens that download files (C12).
 *
 * Which of the three it was is read from the limit, not from the error's type: Chromium
 * rejects a body read the limit cut off with a plain AbortError ("The user aborted a
 * request."), not with the limit's TimeoutError, and a browser without abort reasons does
 * the same for the fetch itself. Taken for the caller's own abort, such a timeout was
 * passed on, and a download that took over 90 s ended without a file or a word (C12
 * follow-up). No caller can abort a download, so an AbortError there was never one.
 */
function noAnswer(err: unknown, limit?: TimeLimit, tooLong = TOOK_TOO_LONG): unknown {
  if (limit?.timedOut) return new ApiError(0, 'TIMEOUT', tooLong);
  if (limit?.cancelled) return err;
  return new ApiError(
    0,
    'NETWORK_ERROR',
    'Cannot reach the server. Check the network connection; if it persists, ask the administrator to check that the ERP is running.',
  );
}

export async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const { method = 'GET', body, signal, _retried } = options;

  const limit = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      signal: limit.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw noAnswer(err, limit);
  } finally {
    limit.done();
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

  const limit = withTimeout(signal);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      credentials: 'include',
      signal: limit.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch (err) {
    throw noAnswer(err, limit);
  } finally {
    limit.done();
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

const STOPPED_ARRIVING =
  `The file stopped arriving: nothing came for ${REQUEST_TIMEOUT_MS / 1000} seconds. Check the network connection and try again.`;

/**
 * Reads the whole body, as `res.blob()` would, telling `arrived` of every part that comes in.
 */
async function readBody(res: Response, arrived: () => void): Promise<Blob> {
  // No stream to watch (an empty answer): read in one piece.
  if (!res.body) return res.blob();
  const reader = res.body.getReader();
  const parts: BlobPart[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return new Blob(parts, { type: res.headers.get('content-type') ?? '' });
    parts.push(value);
    arrived();
  }
}

/**
 * Fetches an authenticated GET as `request` does — a failure without an answer as an
 * ApiError, one refresh on 401 — and reads its whole body. Downloads and previews had
 * none of it: a lost connection rejected with a raw TypeError, a stuck one never ended
 * (C12).
 *
 * The time limit covers the wait for the answer and then each wait for the next part of
 * the body, never the whole transfer. One limit over the whole read cut a ~100 MB backup
 * off at 90 s on a link slower than about 1.1 MB/s, where the same download had always
 * finished (C12 follow-up); a body that stops arriving for the whole limit still ends.
 */
async function fetchAuthenticated(path: string, retried = false): Promise<{ res: Response; body: Blob }> {
  const limit = withTimeout();
  try {
    let res: Response;
    try {
      res = await fetch(`${BASE}${path}`, {
        credentials: 'include',
        signal: limit.signal,
        headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      });
    } catch (err) {
      throw noAnswer(err, limit);
    }
    if (res.status === 401 && !retried) {
      limit.done();
      // Once more after a refresh, as `request` does — never in a loop.
      if ((await refreshSession()).ok) return await fetchAuthenticated(path, true);
      accessToken = null;
      onUnauthenticated?.();
      throw await toApiError(res);
    }
    if (!res.ok) throw await toApiError(res);
    try {
      return { res, body: await readBody(res, limit.restart) };
    } catch (err) {
      throw noAnswer(err, limit, STOPPED_ARRIVING);
    }
  } finally {
    limit.done();
  }
}

/**
 * Triggers a file download through an authenticated request.
 * A plain <a href> cannot carry the bearer token, so the file is fetched as a
 * blob and handed to the browser. Rejects with an ApiError the screen can show;
 * a click handler uses lib/useDownload, which shows it.
 */
export async function downloadFile(path: string, fallbackName: string): Promise<void> {
  const { res, body } = await fetchAuthenticated(path);
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename="?([^"]+)"?/.exec(disposition);
  saveBlob(body, match?.[1] ?? fallbackName);
}

/** Hands a file built in the browser (or fetched) to the browser's download. */
export function saveBlob(blob: Blob, filename: string): void {
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
  return (await fetchAuthenticated(path)).body.text();
}

/** Uploads a file (import preview) with the bearer token attached. */
export async function uploadFile<T>(path: string, file: File): Promise<T> {
  const form = new FormData();
  form.append('file', file);

  // No time limit: a large file over a slow link may take longer than any answer
  // should, but a connection that fails is still said so, not a raw TypeError.
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      credentials: 'include',
      // Content-Type is intentionally omitted so the browser sets the multipart boundary.
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
      body: form,
    });
  } catch (err) {
    throw noAnswer(err);
  }

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
