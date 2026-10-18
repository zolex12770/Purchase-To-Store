import { describe, it, expect } from 'vitest';
import { ApiError } from './api';
import { shouldRetryQuery } from './queryRetry';

const timeout = () => new ApiError(0, 'TIMEOUT', 'The server took too long to answer. Please try again.');
const network = () => new ApiError(0, 'NETWORK_ERROR', 'Cannot reach the server.');

describe('shouldRetryQuery', () => {
  // C01 / S1-D1: each re-send of a timed-out KPI started another 100-200 s statement on the server.
  it('never sends a request that timed out again', () => {
    expect(shouldRetryQuery(0, timeout())).toBe(false);
    expect(shouldRetryQuery(1, timeout())).toBe(false);
    expect(shouldRetryQuery(0, new ApiError(504, 'SERVER_ERROR', 'Gateway Timeout'))).toBe(false);
  });

  it('never retries what will not fix itself: 4xx, and a server not set up for Google', () => {
    for (const status of [400, 401, 403, 404, 409, 422, 429]) {
      expect(shouldRetryQuery(0, new ApiError(status, 'X', 'refused')), String(status)).toBe(false);
    }
    expect(shouldRetryQuery(0, new ApiError(503, 'SYNC_NOT_CONFIGURED', 'Google Sheets access is not configured'))).toBe(false);
  });

  it('tries twice more when the request never reached the server, or the server failed', () => {
    expect([0, 1, 2].map((n) => shouldRetryQuery(n, network()))).toEqual([true, true, false]);
    expect([0, 1, 2].map((n) => shouldRetryQuery(n, new ApiError(500, 'SERVER_ERROR', 'x')))).toEqual([true, true, false]);
    expect(shouldRetryQuery(0, new ApiError(502, 'INTEGRATION_ERROR', 'x'))).toBe(true);
    expect(shouldRetryQuery(0, new Error('not an ApiError'))).toBe(true);
  });
});
