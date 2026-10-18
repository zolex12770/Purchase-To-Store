import { describe, it, expect } from 'vitest';
import { latestOnly } from './latestOnly';

/** A load that answers only when told to, as a busy server would. */
function heldBack<T>() {
  let answer!: (v: T) => void;
  let fail!: (e: unknown) => void;
  const promise = new Promise<T>((resolve, reject) => { answer = resolve; fail = reject; });
  return { load: () => promise, answer, fail };
}

function recorder() {
  const seen: string[] = [];
  return {
    seen,
    on: {
      done: (html: string) => { seen.push(`shown: ${html}`); },
      failed: (err: unknown) => { seen.push(`failed: ${String(err)}`); },
      settled: () => { seen.push('settled'); },
    },
  };
}

describe('only the latest load reaches the preview (review of track T1: a late slip replaced another)', () => {
  it('drops the late answer for a slip whose preview was closed and replaced by another', async () => {
    const gate = latestOnly();
    const { seen, on } = recorder();
    const slipA = heldBack<string>();
    const a = gate.run(slipA.load, on);
    gate.cancel(); // the user closes A's preview at once
    await gate.run(async () => 'slip B', on); // and opens B's, which answers first
    slipA.answer('slip A'); // A's answer lands late
    await a;
    expect(seen).toEqual(['shown: slip B', 'settled']);
  });

  it('a newer run supersedes an older one even without a close in between', async () => {
    const gate = latestOnly();
    const { seen, on } = recorder();
    const slipA = heldBack<string>();
    const a = gate.run(slipA.load, on);
    const b = gate.run(async () => 'slip B', on);
    slipA.answer('slip A');
    await Promise.all([a, b]);
    expect(seen).toEqual(['shown: slip B', 'settled']);
  });

  it('drops a late failure too, so it cannot close the preview that is open now', async () => {
    const gate = latestOnly();
    const { seen, on } = recorder();
    const slipA = heldBack<string>();
    const a = gate.run(slipA.load, on);
    const slipB = heldBack<string>();
    const b = gate.run(slipB.load, on);
    slipA.fail('401');
    await a;
    expect(seen).toEqual([]); // B is still loading: nothing closed it, nothing marked it loaded
    slipB.answer('slip B');
    await b;
    expect(seen).toEqual(['shown: slip B', 'settled']);
  });

  it('a preview closed while loading shows nothing when its answer lands', async () => {
    const gate = latestOnly();
    const { seen, on } = recorder();
    const slipA = heldBack<string>();
    const a = gate.run(slipA.load, on);
    gate.cancel();
    slipA.answer('slip A');
    await a;
    expect(seen).toEqual([]);
  });

  it('a single load is shown, or reported, as before', async () => {
    const gate = latestOnly();
    const { seen, on } = recorder();
    await gate.run(async () => 'slip A', on);
    await gate.run(() => Promise.reject(new Error('Could not load')), on);
    expect(seen).toEqual(['shown: slip A', 'settled', 'failed: Error: Could not load', 'settled']);
  });
});
