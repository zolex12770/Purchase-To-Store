/**
 * The last line for a request a click started and nobody awaited (C12).
 *
 * Downloads go through lib/useDownload, which shows a failure; a call site that still
 * fires a request and forgets it (`void downloadFile(...)`, `void mutateAsync(...)`)
 * ended as an unhandled promise rejection that showed the user nothing. An ApiError that
 * reaches the window that way is shown as a toast instead; anything else is left to the
 * browser, so a programming error still surfaces in the console.
 */
import { ApiError } from './api';

/** True when it was an ApiError, now shown and kept out of the console as unhandled. */
export function reportUnhandledApiError(
  event: { reason: unknown; preventDefault: () => void },
  show: (err: ApiError) => void,
): boolean {
  if (!(event.reason instanceof ApiError)) return false;
  event.preventDefault();
  show(event.reason);
  return true;
}
