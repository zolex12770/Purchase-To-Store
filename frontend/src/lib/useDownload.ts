/**
 * The one way a click starts a download (C12).
 *
 * 25 Export, PDF and template buttons started `void downloadFile(...)` and forgot it: a
 * failed download showed nothing and left an unhandled promise rejection (F15; S1-D5,
 * S1-D6, S1-D7, S3-D2, S4-D7). The function this hook returns reports a failure as a
 * toast and never rejects, so `onClick={() => void download(...)}` is safe.
 */
import { useCallback } from 'react';
import { downloadFile } from './api';
import { useToast } from '../components/Toast';

/**
 * Runs `fetchFile`; a failure goes to `report` and the result is false. Never rejects.
 * Every failure is reported, an AbortError too: no caller can abort a download, and this
 * let pass in silence the plain AbortError of a body read the time limit had cut off (a
 * backup over a slow link ended with no file and no word, C12 follow-up). Apart from the
 * hook so it is unit-tested (useDownload.test.ts).
 */
export async function runDownload(fetchFile: () => Promise<void>, report: (err: unknown) => void): Promise<boolean> {
  try {
    await fetchFile();
    return true;
  } catch (err) {
    report(err);
    return false;
  }
}

export type Download = (path: string, fallbackName: string, failureTitle?: string) => Promise<boolean>;

/**
 * `download(path, name)` saves the file the authenticated GET returns, or shows why it
 * could not (a refusal as a warning, anything else as an error), and resolves to whether
 * the file was saved.
 */
export function useDownload(): Download {
  const toast = useToast();
  return useCallback<Download>(
    (path, fallbackName, failureTitle = 'Could not download the file') =>
      runDownload(() => downloadFile(path, fallbackName), (err) => toast.fromError(err, failureTitle)),
    [toast],
  );
}
