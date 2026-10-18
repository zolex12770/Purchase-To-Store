import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, downloadFile } from './api';
import { runDownload } from './useDownload';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

/** The fields a screen shows, as a plain object (a mismatch then diffs plainly). */
const shown = (err: unknown) => {
  const e = err as ApiError;
  return { isApiError: err instanceof ApiError, status: e?.status, code: e?.code, message: e?.message };
};

/** A document just big enough for saveBlob: records the file it was asked to save. */
function fakeDocument() {
  const saved: string[] = [];
  vi.stubGlobal('document', {
    createElement: () => {
      const a = { href: '', download: '', click: () => saved.push(a.download), remove: () => undefined };
      return a;
    },
    body: { appendChild: () => undefined },
  });
  return saved;
}

/**
 * A body whose parts arrive `at` ms after the answer and that ends at `endAt` (never, if
 * not given). As Chromium does, a read the request's abort cuts off rejects with a plain
 * AbortError, not with the abort's reason.
 */
function arrivingBody(signal: AbortSignal, parts: { at: number; text: string }[], endAt?: number): ReadableStream<Uint8Array> {
  const timers: ReturnType<typeof setTimeout>[] = [];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      const bytes = new TextEncoder();
      for (const { at, text } of parts) timers.push(setTimeout(() => controller.enqueue(bytes.encode(text)), at));
      if (endAt !== undefined) timers.push(setTimeout(() => controller.close(), endAt));
      signal.addEventListener('abort', () => {
        timers.forEach(clearTimeout);
        controller.error(new DOMException('The user aborted a request.', 'AbortError'));
      }, { once: true });
    },
  });
}

// C12 (F15; S1-D5, S1-D6, S1-D7, S3-D2, S4-D7): a failed download showed nothing and left
// "TypeError: Failed to fetch" uncaught.
describe('downloadFile', () => {
  it('turns a connection that fails into NETWORK_ERROR, not a raw TypeError', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    const err = shown(await downloadFile('/io/export/indents?format=csv', 'indents.csv').catch((e: unknown) => e));
    expect({ ...err, message: undefined }).toEqual({ isApiError: true, status: 0, code: 'NETWORK_ERROR', message: undefined });
    expect(err.message).toMatch(/^Cannot reach the server/);
  });

  it('gives up after the request time limit with TIMEOUT (it had none: a stuck download never ended)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason));
    })));
    const pending = downloadFile('/io/export/purchase-orders?format=xlsx', 'po.xlsx').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    const err = shown(await pending);
    expect([err.isApiError, err.status, err.code]).toEqual([true, 0, 'TIMEOUT']);
  });

  it('is TIMEOUT when the limit fired, though the browser rejects the fetch with a plain AbortError', async () => {
    vi.useFakeTimers();
    // A browser without abort reasons rejects with "The user aborted a request.", not with the
    // limit's TimeoutError; it was passed on as the caller's own abort, which nobody reports.
    vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('The user aborted a request.', 'AbortError')));
    })));
    const pending = downloadFile('/io/export/indents?format=csv', 'indents.csv').catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(90_000);
    const err = shown(await pending);
    expect([err.isApiError, err.status, err.code]).toEqual([true, 0, 'TIMEOUT']);
  });

  // C12 follow-up (review of 2026-10-18): the 90-s limit also covered the body, so a ~100 MB
  // backup over a link slower than about 1.1 MB/s was cut off at 90 s; Chromium rejected the
  // read with a plain AbortError, taken for the caller's own abort, and nothing was said.
  it('saves a large file over a slow link however long it takes, while its parts keep arriving', async () => {
    vi.useFakeTimers();
    const saved = fakeDocument();
    const files: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((file) => { files.push(file as Blob); return 'blob:test'; });
    // A part every 40 s and the end at 170 s: no wait for one part reaches 90 s, the transfer does.
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(
      arrivingBody(init.signal!, [40_000, 80_000, 120_000, 160_000].map((at, i) => ({ at, text: `part${i + 1};` })), 170_000),
      { status: 200, headers: { 'content-disposition': 'attachment; filename="zolex-backup-803.json"', 'content-type': 'application/json' } },
    )));
    const outcome = downloadFile('/backup/803/download', 'backup.json').then(() => 'saved', (e: unknown) => e);
    await vi.advanceTimersByTimeAsync(170_000);
    expect(await outcome).toBe('saved');
    expect(saved).toEqual(['zolex-backup-803.json']);
    expect(files.map((f) => f.type)).toEqual(['application/json']);
    expect(await files[0]!.text()).toBe('part1;part2;part3;part4;');
  });

  it('ends a body that stops arriving for the whole limit with TIMEOUT, though the read rejects with a plain AbortError', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => new Response(
      arrivingBody(init.signal!, [{ at: 10_000, text: 'part1;' }]),
      { status: 200 },
    )));
    let settled = false;
    const pending = downloadFile('/backup/803/download', 'backup.json').catch((e: unknown) => e).finally(() => { settled = true; });
    // 99 s in, 89 s since the last part: still waiting.
    await vi.advanceTimersByTimeAsync(99_000);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    const err = shown(await pending);
    expect([err.isApiError, err.status, err.code]).toEqual([true, 0, 'TIMEOUT']);
    expect(err.message).toBe('The file stopped arriving: nothing came for 90 seconds. Check the network connection and try again.');
  });

  it('a connection lost while the file arrives is NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      new ReadableStream<Uint8Array>({ pull(controller) { controller.error(new TypeError('network error')); } }),
      { status: 200 },
    )));
    const err = shown(await downloadFile('/backup/803/download', 'backup.json').catch((e: unknown) => e));
    expect([err.isApiError, err.status, err.code]).toEqual([true, 0, 'NETWORK_ERROR']);
  });

  it('a refusal keeps the server\'s code and words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: { code: 'AUTHORIZATION_ERROR', message: 'You do not have permission to export Audit Log (audit.export).' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    expect(shown(await downloadFile('/io/export/audit?format=csv', 'audit.csv').catch((e: unknown) => e))).toEqual({
      isApiError: true, status: 403, code: 'AUTHORIZATION_ERROR', message: 'You do not have permission to export Audit Log (audit.export).',
    });
  });

  it('on 401 refreshes once and asks once more — never in a loop', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      calls.push(url);
      if (url.endsWith('/auth/refresh')) {
        return new Response(JSON.stringify({ data: { accessToken: 'renewed', user: {} } }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: { code: 'AUTHENTICATION_ERROR', message: 'Authentication required.' } }), { status: 401 });
    }));
    const err = shown(await downloadFile('/grn/7/pdf', 'grn.pdf').catch((e: unknown) => e));
    expect([err.status, err.code]).toEqual([401, 'AUTHENTICATION_ERROR']);
    expect(calls.map((u) => u.replace('/api/v1', ''))).toEqual(['/grn/7/pdf', '/auth/refresh', '/grn/7/pdf']);
  });

  it('saves the file under the name the server gives', async () => {
    const saved = fakeDocument();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('a,b', {
      status: 200, headers: { 'content-disposition': 'attachment; filename="zolex-indents-2026-10-18.csv"' },
    })));
    await downloadFile('/io/export/indents?format=csv', 'indents.csv');
    expect(saved).toEqual(['zolex-indents-2026-10-18.csv']);
  });
});

describe('runDownload (what useDownload runs on a click)', () => {
  it('reports a failure once and resolves false — it never rejects', async () => {
    const report = vi.fn();
    const failure = new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
    await expect(runDownload(async () => { throw failure; }, report)).resolves.toBe(false);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(failure);
    await expect(runDownload(async () => { throw new TypeError('Failed to fetch'); }, report)).resolves.toBe(false);
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('resolves true and reports nothing when the file was saved', async () => {
    const report = vi.fn();
    await expect(runDownload(async () => undefined, report)).resolves.toBe(true);
    expect(report).not.toHaveBeenCalled();
  });

  it('reports an AbortError too: no caller can abort a download (C12 follow-up)', async () => {
    const report = vi.fn();
    const aborted = new DOMException('The user aborted a request.', 'AbortError');
    await expect(runDownload(async () => { throw aborted; }, report)).resolves.toBe(false);
    expect(report).toHaveBeenCalledWith(aborted);
  });
});

describe('every click that downloads goes through useDownload', () => {
  // Raw sources of every page and component, read by Vite at test time.
  const sources = import.meta.glob(['../pages/**/*.tsx', '../components/**/*.tsx'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  // Track T3 owns this file's KPI error state in the same change round; its one Export
  // button moves to useDownload there (see the T4 report).
  const OWNED_ELSEWHERE = new Set(['../components/ModuleAnalysis.tsx']);

  it('no handler starts downloadFile and forgets it', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(40);
    const offenders = Object.entries(sources)
      .filter(([file]) => !OWNED_ELSEWHERE.has(file))
      .flatMap(([file, text]) => text.split('\n').map((line, i) => [file, i + 1, line] as const))
      .filter(([, , line]) => /void\s+downloadFile\(/.test(line))
      .map(([file, line]) => `${file}:${line}`);
    expect(offenders).toEqual([]);
  });
});
