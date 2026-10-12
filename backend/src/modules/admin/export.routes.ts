/**
 * Portable database export — MySQL-compatible SQL, Excel, and a Google Sheets
 * archive, all written into the project-local DATABASE/ folder (see
 * DATABASE/README.md).
 *
 * This is deliberately NOT the same mechanism as backup.routes.ts: that one
 * writes an operational, checksum-verified JSON dump OUTSIDE the repository
 * and is the only thing db:restore / POST /backup/:id/restore ever reads.
 * This module only ever produces read-only, human-inspectable exports for
 * MySQL Workbench, spreadsheet review and offline archival — restoring the
 * ERP from these files is intentionally unsupported, so a hand-edited SQL or
 * Excel export can never silently become live data.
 *
 * Runs IN-PROCESS inside the already-running backend, reusing its one open
 * database connection — PGlite allows only a single writer/reader process
 * against its data directory (see db/driver.ts), so a separate export CLI
 * would either conflict with `npm run dev` or require stopping it.
 */
import { Router } from 'express';
import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { query, queryOne } from '../../db/index.js';
import { asyncHandler, sendOk, sendCreated } from '../../core/http.js';
import { requirePermission } from '../../auth/middleware.js';
import { audit, actorFrom } from '../../core/audit.js';
import { databasePaths } from '../../config/env.js';
import { logger } from '../../core/logger.js';
import { BACKUP_TABLES, collectBackupData } from '../../db/restore.js';
import { readSheet, syncConfig } from '../google-sync/engine.js';

const router = Router();

/** Columns MySQL (like Postgres) computes itself — never present in an INSERT. */
const GENERATED_COLUMNS: Record<string, string[]> = {
  purchase_order_lines: ['final_rate', 'amount'],
  grn_lines: ['amount'],
};

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Columns that never leave the database in a portable export.
 *
 * These exports are plain files written into the project's DATABASE folder for
 * reading in MySQL Workbench or Excel — they are not the operational backup
 * and are never used to restore the ERP (config/env.ts). They used to carry
 * every `users` column, so each export left a copy of every account's password
 * hash lying in the project folder. The value is replaced by '!' — the same
 * "no usable password" marker the sheet sync gives a new account — so the
 * column still exists for anyone loading the file into a schema.
 */
const EXPORT_REDACTED: Record<string, Record<string, string>> = {
  users: { password_hash: '!' },
};

export function redactForExport(
  data: Record<string, Record<string, unknown>[]>,
): Record<string, Record<string, unknown>[]> {
  const out: Record<string, Record<string, unknown>[]> = { ...data };
  for (const [table, replacements] of Object.entries(EXPORT_REDACTED)) {
    const rows = data[table];
    if (!rows) continue;
    out[table] = rows.map((row) => {
      const copy = { ...row };
      for (const [column, value] of Object.entries(replacements)) {
        if (column in copy) copy[column] = value;
      }
      return copy;
    });
  }
  return out;
}

function totalRows(counts: Record<string, number>): number {
  return Object.values(counts).reduce((a, b) => a + b, 0);
}

/* ── MySQL value + dump formatting ───────────────────────────────────────── */

function escapeMysqlString(s: string): string {
  return s.replace(/[\0\n\r\x1a\\']/g, (c) => {
    switch (c) {
      case '\0': return '\\0';
      case '\n': return '\\n';
      case '\r': return '\\r';
      case '\x1a': return '\\Z';
      case '\\': return '\\\\';
      case "'": return "\\'";
      default: return c;
    }
  });
}

/** ISO-8601 timestamp/date → MySQL DATETIME(6) literal body (no surrounding quotes). */
const ISO_RE = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;

function formatMysqlValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (v instanceof Date) {
    const iso = v.toISOString();
    return `'${iso.slice(0, 10)} ${iso.slice(11, 23)}'`;
  }
  if (typeof v === 'object') return `'${escapeMysqlString(JSON.stringify(v))}'`;

  const s = String(v);
  const m = ISO_RE.exec(s);
  if (m) {
    const micros = (m[3] ?? '.000000').padEnd(7, '0').slice(0, 7);
    return `'${m[1]} ${m[2]}${micros}'`;
  }
  return `'${escapeMysqlString(s)}'`;
}

export function buildMysqlDataDump(
  rawData: Record<string, Record<string, unknown>[]>,
  counts: Record<string, number>,
): string {
  const data = redactForExport(rawData);
  const lines: string[] = [
    '-- ============================================================================',
    '-- ZOLEX Purchase-to-Store ERP — live data export (MySQL-compatible)',
    `-- Generated:  ${new Date().toISOString()}`,
    '-- Source:     the live application database (real data — never sample/demo rows)',
    '-- Import:     run DATABASE/SQL/schema_mysql.sql FIRST on an empty schema, then this file.',
    "-- Passwords:  NOT exported. users.password_hash is written as '!' for every account.",
    '-- ============================================================================',
    '',
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS = 0;',
    'START TRANSACTION;',
    '',
  ];

  for (const table of BACKUP_TABLES) {
    const rows = data[table] ?? [];
    lines.push(`-- ${table} (${rows.length} row${rows.length === 1 ? '' : 's'})`);
    if (rows.length === 0) { lines.push(''); continue; }

    const generated = new Set(GENERATED_COLUMNS[table] ?? []);
    const columns = Object.keys(rows[0]!).filter((c) => !generated.has(c));
    const columnList = columns.map((c) => `\`${c}\``).join(', ');

    for (const row of rows) {
      const values = columns.map((c) => formatMysqlValue((row as Record<string, unknown>)[c])).join(', ');
      lines.push(`INSERT INTO \`${table}\` (${columnList}) VALUES (${values});`);
    }
    lines.push('');
  }

  lines.push('COMMIT;', 'SET FOREIGN_KEY_CHECKS = 1;', '', '-- Row counts at export time:');
  for (const table of BACKUP_TABLES) lines.push(`--   ${table}: ${counts[table] ?? 0}`);

  return lines.join('\n');
}

/* ── Excel workbook ───────────────────────────────────────────────────────── */

export async function buildExcelWorkbook(rawData: Record<string, Record<string, unknown>[]>): Promise<Buffer> {
  const data = redactForExport(rawData);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'ZOLEX Purchase-to-Store ERP';
  wb.created = new Date();

  for (const table of BACKUP_TABLES) {
    const rows = data[table] ?? [];
    const sheetName = table.replace(/[:\\/?*[\]]/g, '_').slice(0, 31);
    const sheet = wb.addWorksheet(sheetName);

    if (rows.length === 0) {
      sheet.addRow(['(no rows)']);
      continue;
    }

    const columns = Object.keys(rows[0]!);
    sheet.columns = columns.map((c) => ({ header: c, key: c, width: Math.min(Math.max(c.length + 2, 12), 40) }));
    sheet.getRow(1).font = { bold: true };

    for (const row of rows) {
      const flat: Record<string, unknown> = {};
      for (const c of columns) {
        const v = (row as Record<string, unknown>)[c];
        flat[c] = v === null || v === undefined ? '' : typeof v === 'object' ? JSON.stringify(v) : v;
      }
      sheet.addRow(flat);
    }
  }

  return Buffer.from(await wb.xlsx.writeBuffer());
}

/* ── Google Sheets archive ───────────────────────────────────────────────── */

interface SheetExportResult {
  sheetName: string;
  targetEntity: string;
  headers: string[];
  rowCount: number;
}

async function exportGoogleSheets(): Promise<{
  spreadsheetId: string;
  configured: boolean;
  exportedAt: string;
  sheets: SheetExportResult[];
  skipped: string[];
}> {
  const cfg = syncConfig();
  const exportedAt = new Date().toISOString();
  fs.mkdirSync(databasePaths.googleSheet, { recursive: true });

  const mappings = await query<{ sheet_name: string; target_entity: string; is_enabled: boolean }>(
    'SELECT sheet_name, target_entity, is_enabled FROM google_sheet_mappings ORDER BY sync_order, sheet_name',
  );

  if (!cfg.configured) {
    return { spreadsheetId: cfg.sheetId, configured: false, exportedAt, sheets: [], skipped: mappings.map((m) => m.sheet_name) };
  }

  const results: SheetExportResult[] = [];
  const skipped: string[] = [];

  for (const m of mappings) {
    if (!m.is_enabled) { skipped.push(m.sheet_name); continue; }
    try {
      const grid = await readSheet(m.sheet_name);
      const [headers, ...rows] = grid;
      const payload = {
        worksheetName: m.sheet_name,
        targetEntity: m.target_entity,
        sourceSpreadsheetId: cfg.sheetId,
        exportedAt,
        headers: headers ?? [],
        rows,
      };
      const safeName = m.sheet_name.replace(/[^a-z0-9-_]+/gi, '_');
      fs.writeFileSync(path.join(databasePaths.googleSheet, `${safeName}.json`), JSON.stringify(payload, null, 2), 'utf8');
      results.push({ sheetName: m.sheet_name, targetEntity: m.target_entity, headers: headers ?? [], rowCount: rows.length });
    } catch (err) {
      skipped.push(m.sheet_name);
      logger.warn(`Google Sheet export skipped "${m.sheet_name}"`, { error: err instanceof Error ? err.message : String(err) });
    }
  }

  const manifest = { spreadsheetId: cfg.sheetId, exportedAt, sheets: results, skipped };
  fs.writeFileSync(path.join(databasePaths.googleSheet, '_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  return { spreadsheetId: cfg.sheetId, configured: true, exportedAt, sheets: results, skipped };
}

/* ── Routes ───────────────────────────────────────────────────────────────── */

router.get(
  '/status',
  requirePermission('backup.view'),
  asyncHandler(async (_req, res) => {
    const list = (dir: string) => (fs.existsSync(dir) ? fs.readdirSync(dir) : []);
    sendOk(res, {
      root: databasePaths.root,
      sql: list(databasePaths.sql),
      excel: list(databasePaths.excel),
      googleSheet: list(databasePaths.googleSheet),
      backups: list(databasePaths.backups),
    });
  }),
);

router.post(
  '/sql',
  requirePermission('backup.create'),
  asyncHandler(async (req, res) => {
    fs.mkdirSync(databasePaths.sql, { recursive: true });
    const { data, counts } = await collectBackupData((sql) => query(sql));
    const dump = buildMysqlDataDump(data, counts);
    const filename = `zolex_data_${stamp()}.sql`;
    const filePath = path.join(databasePaths.sql, filename);
    fs.writeFileSync(filePath, dump, 'utf8');

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: 'database_export', entityLabel: filename,
      after: { tableCounts: counts, totalRows: totalRows(counts) },
      message: `MySQL-compatible SQL data export written to ${filePath}`,
    });

    logger.info(`SQL export written: ${filename} (${totalRows(counts)} rows across ${BACKUP_TABLES.length} tables)`);
    sendCreated(res, { filename, filePath, tableCounts: counts, totalRows: totalRows(counts) });
  }),
);

router.post(
  '/excel',
  requirePermission('backup.create'),
  asyncHandler(async (req, res) => {
    fs.mkdirSync(databasePaths.excel, { recursive: true });
    const { data, counts } = await collectBackupData((sql) => query(sql));
    const buffer = await buildExcelWorkbook(data);
    const filename = `zolex_export_${stamp()}.xlsx`;
    const filePath = path.join(databasePaths.excel, filename);
    fs.writeFileSync(filePath, buffer);

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: 'database_export', entityLabel: filename,
      after: { tableCounts: counts, totalRows: totalRows(counts) },
      message: `Excel backup written to ${filePath}`,
    });

    logger.info(`Excel export written: ${filename} (${totalRows(counts)} rows across ${BACKUP_TABLES.length} sheets)`);
    sendCreated(res, { filename, filePath, tableCounts: counts, totalRows: totalRows(counts) });
  }),
);

router.post(
  '/google-sheet',
  requirePermission('backup.create'),
  asyncHandler(async (req, res) => {
    const result = await exportGoogleSheets();

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: 'database_export', entityLabel: 'google-sheet-archive',
      after: { sheets: result.sheets.map((s) => s.sheetName), skipped: result.skipped },
      message: result.configured
        ? `Google Sheets archive written to ${databasePaths.googleSheet}`
        : 'Google Sheets is not configured — archive skipped (see google_sync.configured).',
    });

    sendCreated(res, result);
  }),
);

router.post(
  '/all',
  requirePermission('backup.create'),
  asyncHandler(async (req, res) => {
    fs.mkdirSync(databasePaths.sql, { recursive: true });
    fs.mkdirSync(databasePaths.excel, { recursive: true });
    fs.mkdirSync(databasePaths.googleSheet, { recursive: true });
    fs.mkdirSync(databasePaths.backups, { recursive: true });

    const ts = stamp();
    const { data, counts } = await collectBackupData((sql) => query(sql));

    // Independent verification: re-COUNT(*) every table AFTER the export read
    // and compare against what was actually exported (the user's explicit ask
    // — "verify row counts... and report any mismatch").
    const rowCountVerification: Record<string, { exported: number; live: number; match: boolean }> = {};
    let rowCountMismatch = false;
    for (const table of BACKUP_TABLES) {
      const row = await queryOne<{ n: string }>(`SELECT COUNT(*) AS n FROM ${table}`);
      const live = Number(row?.n ?? 0);
      const exported = counts[table] ?? 0;
      const match = live === exported;
      if (!match) rowCountMismatch = true;
      rowCountVerification[table] = { exported, live, match };
    }

    const sqlFilename = `zolex_data_${ts}.sql`;
    fs.writeFileSync(path.join(databasePaths.sql, sqlFilename), buildMysqlDataDump(data, counts), 'utf8');

    const excelFilename = `zolex_export_${ts}.xlsx`;
    fs.writeFileSync(path.join(databasePaths.excel, excelFilename), await buildExcelWorkbook(data));

    const sheetResult = await exportGoogleSheets();

    // Bundle a timestamped recovery snapshot. This is DATABASE/BACKUPS — a
    // project-local archive of what was just exported, distinct from the
    // operational $ZOLEX_DATA_ROOT/backups JSON backup that db:restore reads
    // (see this file's header and DATABASE/README.md).
    const bundleDir = path.join(databasePaths.backups, ts);
    fs.mkdirSync(bundleDir, { recursive: true });
    fs.copyFileSync(path.join(databasePaths.sql, sqlFilename), path.join(bundleDir, sqlFilename));
    fs.copyFileSync(path.join(databasePaths.excel, excelFilename), path.join(bundleDir, excelFilename));
    if (fs.existsSync(databasePaths.googleSheet)) {
      fs.cpSync(databasePaths.googleSheet, path.join(bundleDir, 'GOOGLE_SHEET'), { recursive: true });
    }

    const manifest = {
      exportedAt: new Date().toISOString(),
      schemaFile: 'DATABASE/SQL/schema_mysql.sql',
      dataFile: `DATABASE/SQL/${sqlFilename}`,
      excelFile: `DATABASE/EXCEL/${excelFilename}`,
      googleSheetManifest: 'DATABASE/GOOGLE_SHEET/_manifest.json',
      googleSheetsConfigured: sheetResult.configured,
      googleSheetsExported: sheetResult.sheets.map((s) => s.sheetName),
      googleSheetsSkipped: sheetResult.skipped,
      tableCounts: counts,
      totalRows: totalRows(counts),
      rowCountVerification,
      rowCountMismatch,
    };
    fs.writeFileSync(path.join(bundleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: 'database_export', entityLabel: ts,
      after: { totalRows: totalRows(counts), rowCountMismatch },
      message: `Full DATABASE export (SQL + Excel + Google Sheet archive) written to DATABASE/BACKUPS/${ts}`,
    });

    logger.info(`Full database export complete: ${ts} (${totalRows(counts)} rows, mismatch=${rowCountMismatch})`);
    sendCreated(res, manifest);
  }),
);

export default router;
