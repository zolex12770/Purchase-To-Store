import { describe, it, expect, vi } from 'vitest';
import { ApiError } from './api';
import { reportUnhandledApiError } from './unhandledApiErrors';

// C12: a download a click started and forgot rejected with nobody to tell the user.
describe('an ApiError nobody awaited', () => {
  it('is shown, and kept out of the console as an unhandled rejection', () => {
    const show = vi.fn();
    const preventDefault = vi.fn();
    const err = new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');
    expect(reportUnhandledApiError({ reason: err, preventDefault }, show)).toBe(true);
    expect(show).toHaveBeenCalledWith(err);
    expect(preventDefault).toHaveBeenCalledTimes(1);
  });

  it('leaves anything else to the browser, so a programming error still shows in the console', () => {
    const show = vi.fn();
    const preventDefault = vi.fn();
    expect(reportUnhandledApiError({ reason: new TypeError('x is undefined'), preventDefault }, show)).toBe(false);
    expect(reportUnhandledApiError({ reason: 'plain string', preventDefault }, show)).toBe(false);
    expect(show).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
  });
});
