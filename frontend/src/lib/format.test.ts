import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ageLabel, daysFromToday, formatDate, formatDateWithFuture, relativeTime, statusLabel, statusTone } from './format';

// 17 Oct 2026, 10:00 local time.
const NOW = new Date(2026, 9, 17, 10, 0, 0);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('ageLabel', () => {
  // The requisition list printed "10 Dec 2026 · −55d ago" on 16 Oct 2026 (audit UI-025).
  it('reads a future date as "in N d", never a negative age', () => {
    expect(ageLabel(-55)).toBe('in 55 d');
    expect(ageLabel('-1')).toBe('in 1 d');
  });

  it('reads past ages and today', () => {
    expect(ageLabel(3)).toBe('3 d ago');
    expect(ageLabel('12')).toBe('12 d ago');
    expect(ageLabel(0)).toBe('today');
    expect(ageLabel(-0)).toBe('today');
    expect(ageLabel(-0.4)).toBe('today');
    expect(ageLabel(2.6)).toBe('3 d ago');
  });

  it('shows a dash for a missing or unreadable age', () => {
    expect(ageLabel(null)).toBe('—');
    expect(ageLabel(undefined)).toBe('—');
    expect(ageLabel('')).toBe('—');
    expect(ageLabel('soon')).toBe('—');
  });
});

describe('daysFromToday', () => {
  it('counts whole calendar days, negative in the past and positive ahead', () => {
    expect(daysFromToday('2026-10-17')).toBe(0);
    expect(daysFromToday('2026-10-16')).toBe(-1);
    expect(daysFromToday('2026-12-10')).toBe(54);
    expect(daysFromToday('2025-10-17')).toBe(-365);
  });

  it('ignores the time of day', () => {
    expect(daysFromToday(new Date(2026, 9, 17, 23, 59))).toBe(0);
    expect(daysFromToday(new Date(2026, 9, 18, 0, 1))).toBe(1);
  });

  it('is null for no date', () => {
    expect(daysFromToday(null)).toBeNull();
    expect(daysFromToday('not a date')).toBeNull();
  });
});

describe('formatDateWithFuture', () => {
  it('marks a date still ahead and leaves today and the past plain', () => {
    expect(formatDateWithFuture('2026-12-10')).toBe('10 Dec 2026 (in 54 d)');
    expect(formatDateWithFuture('2026-10-17')).toBe('17 Oct 2026');
    expect(formatDateWithFuture('2026-10-01')).toBe('1 Oct 2026');
    expect(formatDateWithFuture(null)).toBe('—');
  });

  it('formats a calendar date without shifting it across time zones', () => {
    expect(formatDate('2026-03-01')).toBe('1 Mar 2026');
  });
});

describe('relativeTime', () => {
  const at = (ms: number) => new Date(NOW.getTime() + ms);
  const MIN = 60_000;
  const H = 60 * MIN;

  it('reads the past', () => {
    expect(relativeTime(at(-20_000))).toBe('just now');
    expect(relativeTime(at(-70_000))).toBe('a minute ago');
    expect(relativeTime(at(-5 * MIN))).toBe('5 min ago');
    expect(relativeTime(at(-3 * H))).toBe('3 h ago');
    expect(relativeTime(at(-2 * 24 * H))).toBe('2 d ago');
  });

  it('reads the future as "in …", never a negative age', () => {
    expect(relativeTime(at(70_000))).toBe('in a minute');
    expect(relativeTime(at(5 * MIN))).toBe('in 5 min');
    expect(relativeTime(at(3 * H))).toBe('in 3 h');
    expect(relativeTime(at(4 * 24 * H))).toBe('in 4 d');
  });

  it('falls back to the date after a week either way', () => {
    expect(relativeTime(at(-10 * 24 * H))).toBe('7 Oct 2026');
    expect(relativeTime(at(10 * 24 * H))).toBe('27 Oct 2026');
    expect(relativeTime(null)).toBe('—');
  });
});

describe('status helpers', () => {
  it('give the same words and tone as the status map', () => {
    expect(statusLabel('PARTIALLY_RECEIVED')).toBe('Partially received');
    expect(statusTone('SHORT_CLOSED')).toBe('closed');
    expect(statusLabel('SOMETHING_NEW')).toBe('Something new');
  });
});
