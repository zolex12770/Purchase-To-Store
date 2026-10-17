/**
 * Google Sheets credentials: the service-account key named by
 * GOOGLE_SERVICE_ACCOUNT_KEY_FILE, and nothing else.
 *
 * The inventory sync and the Live Data Verify used to fall back to a fixed key path
 * when the variable was unset, and that file exists on the production host. An
 * isolated staging copy, started without the variable precisely to keep it away from
 * Google, therefore still read the live sheets and rewrote its own stock from them
 * (2026-10-16 audit, F02). An unset variable now means "not configured", said plainly.
 */
import { env } from './env.js';
import { IntegrationError } from '../core/errors.js';

export const GOOGLE_NOT_CONFIGURED =
  'Google Sheets access is not configured on this server (GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set in backend/.env).';

/** The configured key file, or null when Google access is not configured. */
export function googleKeyFile(): string | null {
  const file = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();
  return file ? file : null;
}

/**
 * The configured key file; refuses with a clear "not configured" error otherwise.
 * `consequence` says what therefore did not happen, e.g. "The inventory was not synced."
 * The path itself is never put into a message.
 */
export function requireGoogleKeyFile(consequence: string): string {
  const file = googleKeyFile();
  if (!file) throw IntegrationError(`${GOOGLE_NOT_CONFIGURED} ${consequence}`);
  return file;
}
