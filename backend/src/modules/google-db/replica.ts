/**
 * SQL -> Google Sheets business replica: public surface and control tabs.
 *
 * SQL is the primary database. Nothing in this module runs inside a business
 * transaction: a PO/GRN/Requisition write only appends to `google_db_outbox`
 * (one INSERT, via trigger, in the caller's own transaction), and the replica
 * drains that queue afterwards. With the replica disabled, unconfigured or
 * unreachable, business writes are unaffected.
 *
 * The heavy lifting lives next door and is split by cost:
 *   drain.ts     — incremental, batched, cheap; runs every tick
 *   jobs.ts      — full export / index rebuild / reconcile; resumable, paced
 *   reconcile.ts — SQL vs Google comparison
 *
 * What remains here is the control tabs (all `__`-prefixed, never mixed with
 * business data) and the status a human or an API caller asks for.
 */
import { query, execute } from '../../db/index.js';
import { logger } from '../../core/logger.js';
import { BUSINESS_VIEWS } from './views/index.js';
import { headersOf } from './views/types.js';
import {
  ensureTabs, batchWrite, clearTab, listTabs, deleteTabs, sheetRange, columnLetter, googleDbConfig,
} from './client.js';
import { queueJob, activeJob, recentJobs, expectedRowCounts } from './jobs.js';
import { countRows } from './rowindex.js';

/* ── Control tabs (technical only — never mixed with business data) ─────────── */

export const SHEET_REGISTRY = '__schema';
export const DATABASE_SYNC = '__sync_state';
export const SYNC_ERRORS = '__sync_errors';
export const SYNC_CONFLICTS = '__sync_conflicts';
export const SYNC_METADATA = '__sync_metadata';
export const SYSTEM_SHEETS = [SYNC_METADATA, SHEET_REGISTRY, DATABASE_SYNC, SYNC_ERRORS, SYNC_CONFLICTS];

/** True while a background job is in flight. */
export async function isReplicaRunning(): Promise<boolean> {
  return (await activeJob()) !== null;
}

/* ── Status ─────────────────────────────────────────────────────────────────── */

export interface ReplicaSheetStatus {
  sheet: string;
  description: string;
  columns: number;
  primaryKey: string[];
  importable: boolean;
  sqlRows: number;
  sheetRows: number;
  syncStatus: string;
  lastSuccessAt: string | null;
  lastError: string | null;
}

export interface ReplicaStatus {
  configured: boolean;
  enabled: boolean;
  spreadsheetId: string;
  notConfiguredReason: string | null;
  systemOfRecord: 'SQL';
  health: Record<string, unknown> | null;
  job: Record<string, unknown> | null;
  pendingChanges: number;
  failedChanges: number;
  sheets: ReplicaSheetStatus[];
  controlSheets: string[];
  note: string;
}

/**
 * Everything an admin screen needs, and nothing else.
 *
 * Deliberately a SUMMARY: counts, timestamps and per-tab state. No sheet
 * contents, no row payloads, no Google data of any kind travels to the browser
 * — a 100,000-row tab must never become a 100,000-row JSON response. Every
 * figure here comes from SQL, so the endpoint answers just as fast when Google
 * is unreachable.
 */
export async function replicaStatus(): Promise<ReplicaStatus> {
  const cfg = googleDbConfig();

  const [pending] = await query<{ n: string }>(
    'SELECT COUNT(*)::int AS n FROM google_db_outbox WHERE processed_at IS NULL',
  );
  const [failed] = await query<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM google_db_outbox
      WHERE processed_at IS NULL AND last_error IS NOT NULL`,
  );
  const [health] = await query<Record<string, unknown>>('SELECT * FROM google_db_health WHERE id = 1');
  const state = new Map(
    (await query<{ sheet_name: string } & Record<string, unknown>>('SELECT * FROM google_db_state'))
      .map((r) => [r.sheet_name, r]),
  );
  const sqlCounts = await expectedRowCounts();
  const job = await activeJob();

  return {
    configured: cfg.configured,
    enabled: cfg.enabled,
    spreadsheetId: cfg.spreadsheetId,
    notConfiguredReason: cfg.reason ?? null,
    systemOfRecord: 'SQL',
    health: health ?? null,
    job: (job as unknown as Record<string, unknown>) ?? null,
    pendingChanges: Number(pending?.n ?? 0),
    failedChanges: Number(failed?.n ?? 0),
    sheets: BUSINESS_VIEWS.map((v) => {
      const s = state.get(v.sheet);
      return {
        sheet: v.sheet,
        description: v.description,
        columns: v.columns.length,
        primaryKey: v.primaryKey,
        importable: Boolean(v.importTargets?.length),
        sqlRows: sqlCounts[v.sheet] ?? 0,
        sheetRows: Number(s?.sheet_row_count ?? 0),
        syncStatus: String(s?.sync_status ?? 'NOT_EXPORTED'),
        lastSuccessAt: (s?.last_success_at as string | null) ?? null,
        lastError: (s?.last_error as string | null) ?? null,
      };
    }),
    controlSheets: SYSTEM_SHEETS,
    note:
      'SQL is the primary database. Google Sheets is a secondary business replica and a '
      + 'controlled import source for historical data — the ERP runs normally with this off.',
  };
}

export async function jobHistory(limit = 20) { return recentJobs(limit); }

/* ── Full export (queued, never inline) ─────────────────────────────────────── */

export interface FullExportRequest { actorUserId?: number; sheets?: string[]; pruneLegacy?: boolean }

/**
 * Queues a full export and returns immediately.
 *
 * The brief is explicit that a 16,000-row export must never run inside an HTTP
 * request, a login or startup — and at 100,000 rows the point stops being
 * theoretical. The caller gets a job; the scheduler does the work in slices.
 */
export async function requestFullExport(req: FullExportRequest = {}) {
  const cfg = googleDbConfig();
  if (!cfg.configured) return { queued: false, reason: cfg.reason ?? null, pruned: [], job: null };

  const pruned = req.pruneLegacy ? await pruneLegacyTabs() : [];
  const job = await queueJob('FULL_EXPORT', req.sheets ?? [], req.actorUserId, 'requested by an administrator');
  return { queued: true, reason: null, pruned, job };
}

/**
 * Tabs left behind by the previous 27-tab layout.
 *
 * Listed EXPLICITLY rather than inferred. "Delete every tab I do not recognise"
 * is not a safe rule to run against somebody's spreadsheet — it would take a
 * sheet of hand-kept notes with it.
 */
const RETIRED_TABS = [
  // fourteen lookup tabs, all one SQL table, now one "Lookup & Configuration" tab
  'Department Master', 'Cost Centre Master', 'Machine Master', 'Item Type Master',
  'Main Group Master', 'Sub Main Group Master', 'UOM Master', 'Currency Master',
  'Payment Terms Master', 'PO Type Master', 'Indent Type Master', 'GRN Type Master',
  'State Master', 'City Master',
  // three history tabs plus traceability, now one "History & Audit" tab
  'Indent Approval History', 'Requisition Approval History', 'Audit Log',
  'Transaction Traceability',
  // raw table dumps from the first implementation
  'app_settings', 'google_sync_jobs', 'document_sequences', 'backup_metadata',
];

export async function pruneLegacyTabs(): Promise<string[]> {
  const keep = new Set([...BUSINESS_VIEWS.map((v) => v.sheet), ...SYSTEM_SHEETS]);
  const tabs = await listTabs();
  const doomed = tabs.filter((t) => RETIRED_TABS.includes(t.title) && !keep.has(t.title));
  if (doomed.length === 0) return [];
  await deleteTabs(doomed.map((t) => t.sheetId));
  const titles = doomed.map((t) => t.title);
  await execute('DELETE FROM google_db_rows  WHERE sheet_name = ANY($1)', [titles]);
  await execute('DELETE FROM google_db_state WHERE sheet_name = ANY($1)', [titles]);
  logger.info(`Google replica: removed ${doomed.length} retired tab(s): ${titles.join(', ')}`);
  return titles;
}

/* ── Control tabs ───────────────────────────────────────────────────────────── */

async function writeGrid(sheet: string, rows: string[][]): Promise<void> {
  await clearTab(sheet);
  if (rows.length === 0) return;
  const width = Math.max(1, ...rows.map((r) => r.length));
  await batchWrite([{
    range: sheetRange(sheet, `A1:${columnLetter(width - 1)}${rows.length}`),
    values: rows.map((r) => [...r, ...Array(Math.max(0, width - r.length)).fill('')]),
  }]);
}

/**
 * Refreshes the `__`-prefixed control tabs.
 *
 * These are the ONLY place technical metadata appears. Business tabs carry
 * business columns; the schema, the per-sheet sync state and the held-back
 * import rows live here, where a reader can ignore them.
 */
export async function writeControlSheets(): Promise<void> {
  await ensureTabs(SYSTEM_SHEETS, 12);
  const cfg = googleDbConfig();

  await writeGrid(SYNC_METADATA, [
    ['Property', 'Value'],
    ['System of record', 'SQL (PostgreSQL / PGlite). Google Sheets is a secondary copy.'],
    ['Spreadsheet id', cfg.spreadsheetId],
    ['Business tabs', String(BUSINESS_VIEWS.length)],
    ['Control tabs', String(SYSTEM_SHEETS.length)],
    ['SQL -> Google', 'Continuous, incremental: only changed rows, batched into one write.'],
    ['Google -> SQL', 'Only by an explicit, previewed import. Derived values are recomputed, never imported.'],
    ['Never exported', 'passwords, password hashes, tokens, sessions, audit payload snapshots, sync internals'],
    ['Generated at', new Date().toISOString()],
  ]);

  await writeGrid(SHEET_REGISTRY, [
    ['Sheet', 'Description', 'Primary key', 'Columns', 'Importable', 'SQL tables read'],
    ...BUSINESS_VIEWS.map((v) => [
      v.sheet, v.description, v.primaryKey.join(' + '), String(v.columns.length),
      v.importTargets?.length ? 'Yes' : 'No',
      [...new Set(v.sources.map((s) => s.table))].sort().join(', '),
    ]),
  ]);

  const state = await query<Record<string, unknown>>('SELECT * FROM google_db_state ORDER BY sheet_name');
  const [health] = await query<Record<string, unknown>>('SELECT * FROM google_db_health WHERE id = 1');
  await writeGrid(DATABASE_SYNC, [
    ['Sheet', 'Status', 'SQL rows', 'Sheet rows', 'Last full export', 'Last row export', 'Last import', 'Last error'],
    ...state.map((s) => [
      String(s.sheet_name ?? ''), String(s.sync_status ?? ''),
      String(s.sql_row_count ?? 0), String(s.sheet_row_count ?? 0),
      String(s.last_full_export ?? ''), String(s.last_row_export ?? ''),
      String(s.last_import ?? ''), String(s.last_error ?? ''),
    ]),
    [''],
    ['Replica reachable', String(health?.reachable ?? '')],
    ['Consecutive failures', String(health?.consecutive_failures ?? 0)],
    ['Next attempt at', String(health?.next_attempt_at ?? '')],
    ['Last error', String(health?.last_error ?? '')],
  ]);
}

/** Rows an import refused to apply, so a human can see exactly why. */
export async function writeConflictSheet(
  held: { sheet: string; sheetRow: number; rowKey: string; reason: string }[],
): Promise<void> {
  await ensureTabs([SYNC_CONFLICTS], 8);
  await writeGrid(SYNC_CONFLICTS, [
    ['Sheet', 'Row', 'Record key', 'Why it was NOT applied', 'Recorded at'],
    ...held.map((h) => [h.sheet, String(h.sheetRow), h.rowKey, h.reason, new Date().toISOString()]),
  ]);
}

/** Changes the drain could not push — the dead-letter view, on the sheet. */
export async function writeErrorSheet(): Promise<void> {
  const rows = await query<{
    table_name: string; row_key: string; attempts: number; last_error: string; enqueued_at: string;
  }>(
    `SELECT table_name, row_key, attempts, last_error, enqueued_at
       FROM google_db_outbox
      WHERE processed_at IS NULL AND last_error IS NOT NULL
      ORDER BY enqueued_at DESC LIMIT 500`,
  );
  await ensureTabs([SYNC_ERRORS], 8);
  await writeGrid(SYNC_ERRORS, [
    ['Table', 'Record key', 'Attempts', 'Last error', 'Queued at'],
    ...rows.map((r) => [r.table_name, r.row_key, String(r.attempts), r.last_error ?? '', String(r.enqueued_at)]),
  ]);
}

/** Sheet row counts as this process last recorded them — costs no Google call. */
export async function recordedRowCounts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const v of BUSINESS_VIEWS) out[v.sheet] = await countRows(v.sheet);
  return out;
}

export { headersOf, BUSINESS_VIEWS };
export { drainOutbox } from './drain.js';
export type { DrainResult } from './drain.js';
