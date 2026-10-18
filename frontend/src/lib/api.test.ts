import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, api } from './api';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The fields a screen shows, as a plain object (a mismatch then diffs plainly). */
const shown = (err: unknown) => {
  const e = err as ApiError;
  return { isApiError: err instanceof ApiError, status: e?.status, code: e?.code };
};

/** A fetch that answers nothing until its signal aborts, then rejects with `reject(signal)`. */
const neverAnswers = (reject: (signal: AbortSignal) => unknown) =>
  vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, fail) => {
    init.signal!.addEventListener('abort', () => fail(reject(init.signal!)));
  }));

// C12 follow-up (review of 2026-10-18): which failure a request ended with is read from its
// time limit and its caller's signal, never from the error's type. An AbortError was taken
// for the caller's own abort, so a timeout the browser reported that way went unreported.
describe('a request that gets no answer', () => {
  it('is TIMEOUT when the limit fired, though the browser rejects with a plain AbortError', async () => {
    vi.useFakeTimers();
    // A browser without abort reasons does not reject with the limit's TimeoutError.
    vi.stubGlobal('fetch', neverAnswers(() => new DOMException('The user aborted a request.', 'AbortError')));
    const list = api.getWithMeta('/purchase-orders?page=1').catch((e: unknown) => e);
    const kpis = api.get('/analytics/kpis').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    // TIMEOUT is what main.tsx never re-sends (C01): an AbortError was retried like any error.
    expect(shown(await list)).toEqual({ isApiError: true, status: 0, code: 'TIMEOUT' });
    expect(shown(await kpis)).toEqual({ isApiError: true, status: 0, code: 'TIMEOUT' });
  });

  it("passes the caller's own abort on as it was (a query React Query cancelled)", async () => {
    vi.stubGlobal('fetch', neverAnswers((signal) => signal.reason));
    const ctl = new AbortController();
    const pending = api.get('/purchase-orders', ctl.signal).catch((e: unknown) => e);
    ctl.abort();
    const err = await pending;
    expect(err).toBeInstanceOf(DOMException);
    expect((err as DOMException).name).toBe('AbortError');
  });

  it('is NETWORK_ERROR when aborted by nobody who asked', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('The user aborted a request.', 'AbortError'); }));
    expect(shown(await api.post('/requisitions', {}).catch((e: unknown) => e))).toEqual({ isApiError: true, status: 0, code: 'NETWORK_ERROR' });
  });
});
