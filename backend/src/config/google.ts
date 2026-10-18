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
import fs from 'node:fs';
import { env } from './env.js';
import { NotConfiguredError } from '../core/errors.js';

export const GOOGLE_NOT_CONFIGURED =
  'Google Sheets access is not configured on this server (GOOGLE_SERVICE_ACCOUNT_KEY_FILE is not set in backend/.env).';

/**
 * A key file that is named but not on disk is a configuration fault too, not a Google
 * outage: the inventory sync passed the missing path to GoogleAuth, took the ENOENT for
 * a network blip, read three times and reported the path. The path stays out of it.
 */
export const GOOGLE_KEY_FILE_NOT_FOUND =
  'Google key file not found: GOOGLE_SERVICE_ACCOUNT_KEY_FILE names a file that does not exist on this server.';

/** The configured key file, or null when Google access is not configured. */
export function googleKeyFile(): string | null {
  const file = env.GOOGLE_SERVICE_ACCOUNT_KEY_FILE?.trim();
  return file ? file : null;
}

/**
 * Why the service-account key cannot be used, or null when it can: the one check the
 * business-sheet sync, the inventory sync and the Live Data Verify share.
 */
export function googleKeyFileProblem(): string | null {
  const file = googleKeyFile();
  if (!file) return GOOGLE_NOT_CONFIGURED;
  if (!fs.existsSync(file)) return GOOGLE_KEY_FILE_NOT_FOUND;
  return null;
}

/**
 * The configured key file; refuses with a clear "not configured" error otherwise
 * (variable unset, or naming a file that is not there). `consequence` says what
 * therefore did not happen, e.g. "The inventory was not synced."
 * The path itself is never put into a message.
 */
export function requireGoogleKeyFile(consequence: string): string {
  const problem = googleKeyFileProblem();
  if (problem) throw NotConfiguredError(`${problem} ${consequence}`);
  return googleKeyFile()!;
}

/** Error codes of the local file system, which a retry cannot change. */
const FILE_SYSTEM_CODES = new Set(['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR']);

/**
 * The file-system code when a Google call failed because the key file could not be read,
 * else null. GoogleAuth reads the file at the first call, so a file that went missing
 * after the check above fails there, with an error whose message names the path: callers
 * say "the Google key file could not be read (<code>)" instead, and do not retry.
 * Network errors carry a string code too (ECONNRESET …), HTTP errors a number.
 */
export function keyFileReadFailure(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FILE_SYSTEM_CODES.has(code) ? code : null;
}
