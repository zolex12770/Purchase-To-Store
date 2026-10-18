import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, downloadFile } from './api';
import { runDownload } from './useDownload';

afterEach(() => {
  vi.unstubAllGlobals();
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

  it('a refusal keeps the server\'s code and words', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ success: false, error: { code: 'AUTHORIZATION_ERROR', message: 'You do not have permission to export Audit Log (audit.export).' } }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )));
    expect(shown(await downloadFile('/io/export/audit?format=csv', 'audit.csv').catch((e: unknown) => e))).toEqual({
      isApiError: true, status: 403, code: 'AUTHORIZATION_ERROR', message: 'You do not have permission to export Audit Log (audit.export).',
    });
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

  it('resolves true and reports nothing when the file was saved, or when the caller aborted', async () => {
    const report = vi.fn();
    await expect(runDownload(async () => undefined, report)).resolves.toBe(true);
    await expect(runDownload(async () => { throw new DOMException('aborted', 'AbortError'); }, report)).resolves.toBe(false);
    expect(report).not.toHaveBeenCalled();
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
