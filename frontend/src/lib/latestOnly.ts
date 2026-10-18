/**
 * Lets only the latest of several loads through, for a preview opened on demand.
 *
 * The direct-issue slip preview fetched a slip each time it opened and showed
 * whatever answer came back. Closed while one slip was still loading and opened
 * on another, it showed the second slip and then the first one's late answer,
 * under the second's title and with Print enabled (review of track T1,
 * 2026-10-18): a storekeeper could print and hand over the wrong slip. A late
 * failure could likewise close the preview open now.
 *
 * Each run supersedes the one before it; cancel() drops the one still loading
 * (the preview was closed).
 */

export interface LatestHandlers<T> {
  done: (value: T) => void;
  failed: (err: unknown) => void;
  /** After done or failed. Like them, for the latest run only. */
  settled?: () => void;
}

export interface LatestOnly {
  run<T>(load: () => Promise<T>, on: LatestHandlers<T>): Promise<void>;
  cancel(): void;
}

export function latestOnly(): LatestOnly {
  let latest = 0;
  return {
    async run<T>(load: () => Promise<T>, on: LatestHandlers<T>): Promise<void> {
      const mine = ++latest;
      let outcome: { ok: true; value: T } | { ok: false; err: unknown };
      try {
        outcome = { ok: true, value: await load() };
      } catch (err) {
        outcome = { ok: false, err };
      }
      if (mine !== latest) return;
      if (outcome.ok) on.done(outcome.value);
      else on.failed(outcome.err);
      on.settled?.();
    },
    cancel() {
      latest += 1;
    },
  };
}
