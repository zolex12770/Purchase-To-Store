/**
 * When react-query may send a failed query again (main.tsx), apart from the client so
 * the rule is unit-tested (queryRetry.test.ts).
 */
import { ApiError } from './api';

/** Two more attempts at most, as before. */
const MAX_RETRIES = 2;

/**
 * Never again when sending it again cannot help or can only hurt:
 *   · a request that timed out (TIMEOUT, or a proxy's 504) may still be running on the
 *     server, and each re-send started the same statement once more. A date-filtered
 *     KPI on the copy of production ran about 200 s: the client gave up at 90 s, sent it
 *     twice more, and the single-threaded API answered nobody for over ten minutes (C01,
 *     S1-D1);
 *   · an auth, permission or validation failure (4xx) will not fix itself;
 *   · a server that is not set up for the integration (SYNC_NOT_CONFIGURED, 503) stays so.
 * A request that never reached the server (NETWORK_ERROR) and other server errors are
 * tried again.
 */
export function shouldRetryQuery(failureCount: number, error: unknown): boolean {
  if (error instanceof ApiError) {
    if (error.code === 'TIMEOUT' || error.status === 504) return false;
    if (error.status > 0 && error.status < 500) return false;
    if (error.code === 'SYNC_NOT_CONFIGURED') return false;
  }
  return failureCount < MAX_RETRIES;
}
