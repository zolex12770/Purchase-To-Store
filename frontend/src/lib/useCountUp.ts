/**
 * Count-up animation for headline figures (SRS §15 — micro-interactions).
 *
 * Deliberately conservative about when it animates, because a KPI is a factual
 * claim before it is decoration:
 *
 *   • It respects `prefers-reduced-motion` and renders the final value at once.
 *   • It only animates the FIRST time a value appears. Later updates (a filter
 *     change, a refetch) snap, so a number never appears to be "counting" when
 *     the user is actually reading a fresh figure.
 *   • Non-finite input is passed straight through.
 *
 * Uses requestAnimationFrame, so it pauses in a background tab rather than
 * burning CPU there.
 */
import { useEffect, useRef, useState } from 'react';

const DURATION_MS = 900;

/** Decelerating curve — fast start, gentle landing. */
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useCountUp(target: number, enabled = true): number {
  const [display, setDisplay] = useState(() => (enabled ? 0 : target));
  const hasAnimated = useRef(false);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    if (!Number.isFinite(target)) { setDisplay(target); return; }

    // Snap on re-renders and on any update after the first animation.
    if (!enabled || hasAnimated.current || prefersReducedMotion()) {
      setDisplay(target);
      hasAnimated.current = true;
      return;
    }

    hasAnimated.current = true;
    const from = 0;
    const start = performance.now();

    const step = (now: number) => {
      const t = Math.min(1, (now - start) / DURATION_MS);
      setDisplay(from + (target - from) * easeOutCubic(t));
      if (t < 1) frame.current = requestAnimationFrame(step);
    };

    frame.current = requestAnimationFrame(step);
    return () => { if (frame.current !== null) cancelAnimationFrame(frame.current); };
  }, [target, enabled]);

  return display;
}
