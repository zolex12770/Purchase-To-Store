/**
 * Google Sheets transport for the SQL -> Sheets business replica.
 *
 * Deliberately separate from google-sync/engine.ts's `readSheet`: that one
 * authorises read-only against the inbound master-data spreadsheet, and
 * widening its scope would hand write access to a path that has no business
 * writing. This client authorises read/write against the REPLICA spreadsheet.
 *
 * The redesign's transport rules, all of them cost rules:
 *
 *  • ONE write call per flush. Row updates and appends are addressed by
 *    explicit A1 ranges and sent through a single `values.batchUpdate`, so 100
 *    changed records cost one request rather than a request per record — and
 *    nothing has to be downloaded first to find out where they go.
 *
 *  • Reads fetch COLUMNS, not tabs. Rebuilding a row index needs the key
 *    column, not all sixty, so it asks for exactly that.
 *
 *  • Retrying never blocks the ERP, and never fights a per-minute quota. A 429
 *    means the minute is spent: the call fails, the caller stops, and the
 *    scheduler tries again later on its own backoff. Only genuinely transient
 *    5xx errors are retried in place, briefly.
 *
 *  • Every request is counted, so the cost of an export or a drain is a
 *    reported number rather than an assurance.
 */
import { env } from '../../config/env.js';
import { googleKeyFile, googleKeyFileProblem, keyFileReadFailure } from '../../config/google.js';
import { logger } from '../../core/logger.js';
import { IntegrationError, NotConfiguredError } from '../../core/errors.js';

const SCOPE = 'https://www.googleapis.com/auth/spreadsheets';

export interface GoogleDbConfig {
  configured: boolean;
  spreadsheetId: string;
  enabled: boolean;
  reason?: string;
}

/**
 * Reports configuration WITHOUT throwing — absent config must degrade, never crash.
 * A named key file that is not on disk is not configured either (the check every Google
 * reader shares, config/google.ts): it used to count as configured, so every drain and
 * export handed the missing path to GoogleAuth, failed on its ENOENT and stored a
 * message naming the path as the replica's last error (C37 follow-up).
 */
export function googleDbConfig(): GoogleDbConfig {
  const spreadsheetId = env.GOOGLE_DB_SPREADSHEET_ID;
  const enabled = env.GOOGLE_DB_SYNC_ENABLED;
  if (!spreadsheetId) {
    return {
      configured: false, spreadsheetId: '', enabled,
      reason: 'GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID is not set in backend/.env. '
        + 'The ERP runs normally without it; the Google replica is simply inactive.',
    };
  }
  if (!googleKeyFile()) {
    return {
      configured: false, spreadsheetId, enabled,
      reason: 'The replica needs a service account (GOOGLE_SERVICE_ACCOUNT_KEY_FILE); '
        + 'an API key cannot write to a spreadsheet.',
    };
  }
  const keyProblem = googleKeyFileProblem();
  if (keyProblem) {
    return {
      configured: false, spreadsheetId, enabled,
      reason: `${keyProblem} The ERP runs normally without it; the Google replica is inactive.`,
    };
  }
  return { configured: true, spreadsheetId, enabled };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type SheetsApi = any;

let cached: SheetsApi | null = null;

async function client(): Promise<SheetsApi> {
  if (cached) return cached;
  const cfg = googleDbConfig();
  // A state of this server, not a failed call to Google: 503 SYNC_NOT_CONFIGURED, logged
  // as a warning, like every other Google refusal of that kind (S6-D1, C37). It answered
  // 502 INTEGRATION_ERROR.
  if (!cfg.configured) throw NotConfiguredError(cfg.reason ?? 'Google replica is not configured.');

  const { google } = await import('googleapis');
  const { GoogleAuth } = await import('google-auth-library');
  const auth = new GoogleAuth({ keyFile: googleKeyFile()!, scopes: [SCOPE] });
  cached = google.sheets({ version: 'v4', auth: auth as never });
  return cached;
}

/** Test seam — lets the suite inject a fake Sheets API without any network. */
export function __setClientForTests(fake: SheetsApi | null): void {
  cached = fake;
}

/* ── Request accounting ─────────────────────────────────────────────────────
   Every Google call increments this. The brief asks for the API cost of an
   initial export and of a 1,000-record update; that is only answerable if the
   number is measured rather than estimated.                                  */

let apiCalls = 0;
export function apiCallCount(): number { return apiCalls; }
export function resetApiCallCount(): void { apiCalls = 0; }

function statusOf(err: unknown): number {
  const e = err as { code?: number; status?: number; response?: { status?: number } };
  return e?.code ?? e?.status ?? e?.response?.status ?? 0;
}

/** True when the failure is Google being busy/unavailable rather than us being wrong. */
export function isTransient(err: unknown): boolean {
  const s = statusOf(err);
  if (s === 429 || (s >= 500 && s < 600)) return true;
  const message = err instanceof Error ? err.message : String(err);
  return /ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|network/i.test(message);
}

/* ── Write pacing ───────────────────────────────────────────────────────────
   Sheets allows 60 write requests per minute per user. Batching already keeps a
   drain to one or two, but a background full export of many tabs can still
   approach the limit, so writes are paced BEFORE they are sent. Awaiting a
   timer does not hold the event loop — the ERP serves requests throughout.   */

const WRITE_WINDOW_MS = 60_000;
const WRITE_LIMIT = 40;                  // headroom under Google's 60/min
const writeTimes: number[] = [];

async function pace(what: string): Promise<void> {
  if (env.isTest) return;                // the fake API has no quota
  for (;;) {
    const cutoff = Date.now() - WRITE_WINDOW_MS;
    while (writeTimes.length > 0 && writeTimes[0]! < cutoff) writeTimes.shift();
    if (writeTimes.length < WRITE_LIMIT) { writeTimes.push(Date.now()); return; }
    const waitMs = Math.max(writeTimes[0]! + WRITE_WINDOW_MS - Date.now() + 250, 500);
    logger.debug(`Google replica: pacing ${what} for ${Math.ceil(waitMs / 1000)}s (write quota is 60/min).`);
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

/**
 * Retries only what a retry can actually fix.
 *
 * A 429 is NOT retried here. The quota it reports is per minute, so sleeping
 * inside the call either fails again in the same window or parks the worker for
 * over a minute — which is what previously turned a busy period into a stalled
 * replica. It is surfaced to the caller, which stops, and the scheduler retries
 * later under its own exponential backoff.
 */
async function call<T>(what: string, fn: () => Promise<T>, attempts = 3): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i += 1) {
    try {
      apiCalls += 1;
      return await fn();
    } catch (err) {
      lastErr = err;
      const status = statusOf(err);
      const retryable = status >= 500 && status < 600;
      if (!retryable || i === attempts - 1) break;
      const delay = Math.min(2 ** i * 400, 3_000);
      logger.warn(`Google replica: ${what} failed (${status}) — retrying in ${delay}ms`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // A key file that went missing after the check above fails at GoogleAuth's first read,
  // with the path in its message — kept out of the replica's stored last error.
  const unreadable = keyFileReadFailure(lastErr);
  if (unreadable) throw NotConfiguredError(`Google replica: ${what} failed — the Google key file could not be read (${unreadable}).`);
  const message = lastErr instanceof Error ? lastErr.message : String(lastErr);
  const status = statusOf(lastErr);
  if (status === 403) {
    throw IntegrationError(
      `Google denied access to the replica spreadsheet. Share it as an EDITOR with the service account, then retry. (${message})`,
    );
  }
  if (status === 404) {
    throw IntegrationError(`The replica spreadsheet was not found — check GOOGLE_SHEETS_DATABASE_SPREADSHEET_ID. (${message})`);
  }
  if (status === 429) {
    throw IntegrationError(`Google write quota reached (60/min) during ${what}; the remaining changes stay queued. (${message})`);
  }
  throw IntegrationError(`Google replica: ${what} failed — ${message}`);
}

/* ── Operations ─────────────────────────────────────────────────────────────── */

export interface TabInfo { title: string; sheetId: number; rowCount: number; columnCount: number }

export async function listTabs(): Promise<TabInfo[]> {
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  // `fields` keeps the response to tab metadata; without it Google returns the
  // entire spreadsheet structure.
  const res = await call<any>('list tabs', () => sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
  }));
  return (res.data.sheets ?? []).map((s: any) => ({
    title: String(s.properties?.title ?? ''),
    sheetId: Number(s.properties?.sheetId ?? 0),
    rowCount: Number(s.properties?.gridProperties?.rowCount ?? 0),
    columnCount: Number(s.properties?.gridProperties?.columnCount ?? 0),
  }));
}

/** Creates any missing tab in ONE batch; existing tabs are left untouched. */
export async function ensureTabs(titles: string[], columns = 60): Promise<TabInfo[]> {
  const existing = await listTabs();
  const have = new Set(existing.map((t) => t.title));
  const missing = titles.filter((t) => !have.has(t));
  if (missing.length === 0) return existing;

  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  await pace('create tabs');
  await call('create tabs', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: missing.map((title) => ({
        addSheet: {
          properties: { title, gridProperties: { rowCount: 1000, columnCount: columns, frozenRowCount: 1 } },
        },
      })),
    },
  }));
  logger.info(`Google replica: created ${missing.length} tab(s): ${missing.join(', ')}`);
  return listTabs();
}

/** Removes tabs by sheetId — used to retire the previous layout's tabs. */
export async function deleteTabs(sheetIds: number[]): Promise<void> {
  if (sheetIds.length === 0) return;
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  await pace('delete tabs');
  await call('delete tabs', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: sheetIds.map((sheetId) => ({ deleteSheet: { sheetId } })) },
  }));
}

/**
 * Grows a tab so a write can land.
 *
 * Sheets rejects a write past the grid, and a new tab is only 1000 rows, so an
 * export of 12,461 items must extend it first. Done once per slice, not per row.
 */
export async function ensureGrid(sheetId: number, rows: number, columns: number, current: TabInfo): Promise<void> {
  const requests: unknown[] = [];
  if (rows > current.rowCount) {
    requests.push({ appendDimension: { sheetId, dimension: 'ROWS', length: rows - current.rowCount } });
  }
  if (columns > current.columnCount) {
    requests.push({ appendDimension: { sheetId, dimension: 'COLUMNS', length: columns - current.columnCount } });
  }
  if (requests.length === 0) return;
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  await pace('grow grid');
  await call('grow grid', () => sheets.spreadsheets.batchUpdate({ spreadsheetId, requestBody: { requests } }));
  current.rowCount = Math.max(current.rowCount, rows);
  current.columnCount = Math.max(current.columnCount, columns);
}

/**
 * THE write path: many ranges, one request.
 *
 * Both updates to existing rows and appends of new ones arrive here as explicit
 * ranges, because the row index already knows where every record belongs. That
 * is what makes "100 changes -> 1 API call" true rather than aspirational.
 */
export async function batchWrite(updates: { range: string; values: string[][] }[]): Promise<void> {
  if (updates.length === 0) return;
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  await pace(`batch write (${updates.length} range(s))`);
  await call('batch write', () => sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'RAW', data: updates },
  }));
}

/** Empties a tab's data area. Used only by a full export, never by a drain. */
export async function clearTab(title: string): Promise<void> {
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  await pace(`clear ${title}`);
  await call(`clear ${title}`, () => sheets.spreadsheets.values.clear({
    spreadsheetId, range: sheetRange(title, 'A1:ZZ'),
  }));
}

/**
 * Reads whole rows of a tab. Reserved for reconciliation and import, which
 * genuinely need every column — a drain never calls this.
 */
export async function readTab(title: string): Promise<string[][]> {
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  const res = await call<any>(`read ${title}`, () => sheets.spreadsheets.values.get({
    spreadsheetId,
    range: sheetRange(title, 'A1:ZZ'),
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  }));
  return (res.data.values ?? []).map((row: unknown[]) =>
    (row ?? []).map((c) => (c === null || c === undefined ? '' : String(c).trim())));
}

/**
 * Reads SPECIFIC COLUMNS of a tab, top to bottom.
 *
 * Rebuilding a 100,000-row index needs the key column and nothing else, so this
 * asks Google for one column instead of downloading the tab. Returns one array
 * per requested index, including the header cell at position 0.
 */
export async function readColumns(title: string, columnIndexes: number[]): Promise<string[][]> {
  if (columnIndexes.length === 0) return [];
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  const ranges = columnIndexes.map((i) => sheetRange(title, `${columnLetter(i)}:${columnLetter(i)}`));
  const res = await call<any>(`read key columns of ${title}`, () => sheets.spreadsheets.values.batchGet({
    spreadsheetId,
    ranges,
    majorDimension: 'COLUMNS',
    valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'FORMATTED_STRING',
  }));
  return (res.data.valueRanges ?? []).map((vr: any) =>
    ((vr.values ?? [])[0] ?? []).map((c: unknown) => (c === null || c === undefined ? '' : String(c).trim())));
}

/** Freezes and bolds the header row — readability only, done once per export. */
export async function formatTabs(tabs: TabInfo[]): Promise<void> {
  if (tabs.length === 0) return;
  const sheets = await client();
  const { spreadsheetId } = googleDbConfig();
  const requests = tabs.flatMap((t) => [
    {
      updateSheetProperties: {
        properties: { sheetId: t.sheetId, gridProperties: { frozenRowCount: 1 } },
        fields: 'gridProperties.frozenRowCount',
      },
    },
    {
      repeatCell: {
        range: { sheetId: t.sheetId, startRowIndex: 0, endRowIndex: 1 },
        cell: { userEnteredFormat: { textFormat: { bold: true } } },
        fields: 'userEnteredFormat.textFormat.bold',
      },
    },
  ]);
  await pace('format tabs');
  await call('format tabs', () => sheets.spreadsheets.batchUpdate({
    spreadsheetId, requestBody: { requests },
  }));
}

/**
 * A1 notation for a range inside a named tab.
 *
 * Every tab here has a space in its name ("Item Master"), and unquoted spaces in
 * A1 notation are ambiguous — Google resolves some and rejects others. Quoting
 * once, here, removes the whole class of problem.
 */
export function sheetRange(title: string, a1: string): string {
  return `'${title.replace(/'/g, "''")}'!${a1}`;
}

/** Column index (0-based) -> A1 letters. */
export function columnLetter(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** A1 range for one whole data row of `width` columns. */
export function rowRange(sheet: string, rowNo: number, width: number): string {
  return sheetRange(sheet, `A${rowNo}:${columnLetter(width - 1)}${rowNo}`);
}
