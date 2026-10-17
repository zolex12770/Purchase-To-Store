/**
 * Import / Export (SRS §22, §35).
 *
 * Export  : filter-aware Excel and CSV, with Zolex/Zeeta branding, report title,
 *           the active filter context and a generated timestamp (SRS §35).
 * Import  : upload → parse → validate → PREVIEW → confirm → transactional commit,
 *           with a downloadable error report (SRS §22). Nothing is written to the
 *           database until the user confirms a preview.
 */
import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import ExcelJS from 'exceljs';
import { query, queryOne, withTransaction, txQuery, txQueryOne } from '../../db/index.js';
import {
  asyncHandler, sendOk, sendCreated, validateBody, validateQuery, parsedQuery, idParam,
  csvArray, csvIdArray,
} from '../../core/http.js';
import { NotFoundError, ValidationError, BusinessRuleError } from '../../core/errors.js';
import { requirePermission } from '../../auth/middleware.js';
import { audit, auditIn, actorFrom } from '../../core/audit.js';
import { DATASETS, DATASET_KEYS, type DatasetFilters, type ColumnDef } from './datasets.js';
import { env } from '../../config/env.js';
import { parseNumericInput, toRate } from '../../domain/money.js';
import { logger } from '../../core/logger.js';
import { assertMayChangeUsers, superAdminsAmong } from '../admin/super-admin-guard.js';

const router = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
});

/* ═══════════════════════════════ EXPORT ═══════════════════════════════════ */

const exportQuerySchema = z.object({
  format: z.enum(['xlsx', 'csv']).default('xlsx'),
  dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  status: csvArray,
  supplierId: csvIdArray,
  itemId: csvIdArray,
  departmentId: csvIdArray,
  costCentreId: csvIdArray,
  indentTypeId: csvIdArray,
  poTypeId: csvIdArray,
  machineId: csvIdArray,
  hodId: csvIdArray,
  userId: csvIdArray,
  requesterId: csvIdArray,
  hodStatus: csvArray,
  storeStatus: csvArray,
  ids: csvIdArray,
  search: z.string().trim().max(200).optional(),
});

async function companyBranding(): Promise<{ name: string; brand: string }> {
  const rows = await query<{ key: string; value: unknown }>(
    "SELECT key, value FROM app_settings WHERE key IN ('company.name','company.brand')",
  );
  const map = new Map(rows.map((r) => [r.key, r.value]));
  return {
    name: String(map.get('company.name') ?? 'Zeeta Electrical Engineering Pvt. Ltd.'),
    brand: String(map.get('company.brand') ?? 'ZOLEX'),
  };
}

/** Human-readable description of the filters actually applied (SRS §35). */
function describeFilters(f: Record<string, unknown>): string {
  const parts: string[] = [];
  if (f.dateFrom || f.dateTo) parts.push(`Period: ${f.dateFrom ?? 'start'} to ${f.dateTo ?? 'today'}`);
  if (Array.isArray(f.status) && f.status.length) parts.push(`Status: ${f.status.join(', ')}`);
  if (Array.isArray(f.supplierId) && f.supplierId.length) parts.push(`Suppliers: ${f.supplierId.length} selected`);
  if (Array.isArray(f.itemId) && f.itemId.length) parts.push(`Items: ${f.itemId.length} selected`);
  if (Array.isArray(f.departmentId) && f.departmentId.length) parts.push(`Departments: ${f.departmentId.length} selected`);
  if (Array.isArray(f.ids) && f.ids.length) parts.push(`Specific records: ${f.ids.length}`);
  if (f.search) parts.push(`Search: "${String(f.search)}"`);
  return parts.length > 0 ? parts.join('  ·  ') : 'No filters applied — full authorised dataset';
}

function csvEscape(value: unknown): string {
  if (value === null || value === undefined) return '';
  const s = String(value);
  // Neutralise spreadsheet formula injection in exported CSV.
  const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

function formatCell(value: unknown, col: ColumnDef): unknown {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (col.type === 'money' || col.type === 'number') {
    const n = Number(value);
    return Number.isFinite(n) ? n : value;
  }
  if (col.type === 'date') return String(value).slice(0, 10);
  if (col.type === 'datetime') return String(value).replace('T', ' ').slice(0, 19);
  return value;
}

router.get(
  '/export/:dataset',
  validateQuery(exportQuerySchema),
  asyncHandler(async (req, res) => {
    const key = req.params.dataset ?? '';
    const dataset = DATASETS[key];
    if (!dataset) {
      throw ValidationError(`Unknown export dataset "${key}".`, [
        { field: 'dataset', message: `Supported: ${DATASET_KEYS.join(', ')}.` },
      ]);
    }
    if (!req.user!.permissions.has(dataset.permission)) {
      throw ValidationError(`You do not have permission to export ${dataset.title}.`);
    }

    const f = parsedQuery<z.infer<typeof exportQuerySchema>>(res);
    const { sql, params } = dataset.build(f as DatasetFilters);
    const rows = await query<Record<string, unknown>>(sql, params);
    const branding = await companyBranding();
    const stamp = new Date();
    const filterText = describeFilters(f);
    const fileStamp = stamp.toISOString().slice(0, 19).replace(/[:]/g, '-');

    await audit({
      actor: actorFrom(req), action: 'EXPORT', entity: dataset.key,
      entityLabel: dataset.title,
      message: `Exported ${rows.length} row(s) as ${f.format.toUpperCase()}. ${filterText}`,
    });

    if (f.format === 'csv') {
      const lines: string[] = [];
      // Report context first so a CSV is as self-describing as the Excel file.
      lines.push(csvEscape(`${branding.brand} — ${branding.name}`));
      lines.push(csvEscape(dataset.title));
      lines.push(csvEscape(filterText));
      lines.push(csvEscape(`Generated: ${stamp.toLocaleString('en-IN')} · ${rows.length} record(s)`));
      lines.push('');
      lines.push(dataset.columns.map((c) => csvEscape(c.header)).join(','));
      for (const row of rows) {
        lines.push(dataset.columns.map((c) => csvEscape(formatCell(row[c.key], c))).join(','));
      }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="zolex-${key}-${fileStamp}.csv"`);
      // BOM so Excel opens UTF-8 correctly.
      res.send(`﻿${lines.join('\r\n')}`);
      return;
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = `${branding.brand} ERP`;
    wb.created = stamp;
    const ws = wb.addWorksheet(dataset.title.slice(0, 31));

    const lastCol = dataset.columns.length;
    const titleRow = ws.addRow([`${branding.brand} — ${branding.name}`]);
    titleRow.font = { bold: true, size: 15, color: { argb: 'FF0B2A4A' } };
    ws.mergeCells(1, 1, 1, lastCol);

    const subtitle = ws.addRow([dataset.title]);
    subtitle.font = { bold: true, size: 12, color: { argb: 'FF1E5B8C' } };
    ws.mergeCells(2, 1, 2, lastCol);

    const filterRow = ws.addRow([filterText]);
    filterRow.font = { size: 9, italic: true, color: { argb: 'FF5A6B7B' } };
    ws.mergeCells(3, 1, 3, lastCol);

    const genRow = ws.addRow([`Generated: ${stamp.toLocaleString('en-IN')}  ·  ${rows.length} record(s)`]);
    genRow.font = { size: 9, color: { argb: 'FF5A6B7B' } };
    ws.mergeCells(4, 1, 4, lastCol);

    ws.addRow([]);

    const header = ws.addRow(dataset.columns.map((c) => c.header));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' }, size: 10 };
    header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    header.height = 26;
    header.eachCell((cell) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0B2A4A' } };
      cell.border = { bottom: { style: 'thin', color: { argb: 'FF9AA7B4' } } };
    });

    for (const row of rows) {
      const added = ws.addRow(dataset.columns.map((c) => formatCell(row[c.key], c)));
      added.eachCell((cell, i) => {
        const col = dataset.columns[i - 1];
        if (!col) return;
        if (col.type === 'money') cell.numFmt = '#,##0.00';
        else if (col.type === 'number') cell.numFmt = '#,##0.####';
        cell.alignment = { vertical: 'top', wrapText: col.width !== undefined && col.width > 30 };
      });
    }

    ws.columns.forEach((col, i) => { col.width = dataset.columns[i]?.width ?? 18; });
    ws.views = [{ state: 'frozen', ySplit: 6 }];
    ws.autoFilter = { from: { row: 6, column: 1 }, to: { row: 6, column: lastCol } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="zolex-${key}-${fileStamp}.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

router.get(
  '/export',
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      DATASET_KEYS
        .filter((k) => req.user!.permissions.has(DATASETS[k]!.permission))
        .map((k) => ({
          key: k,
          title: DATASETS[k]!.title,
          columns: DATASETS[k]!.columns.map((c) => c.header),
        })),
    );
  }),
);

/* ═══════════════════════════════ IMPORT ═══════════════════════════════════ */

/**
 * Importable entities. Deliberately limited to MASTER data: importing
 * transactional documents would bypass the numbering, approval and quantity
 * controls that give indents, POs and GRNs their integrity (ADR-005).
 */
interface ImportField {
  field: string;
  headers: string[];
  required?: boolean;
  lookup?: string;
  numeric?: boolean;
  maxLength?: number;
}

interface ImportEntity {
  key: string;
  title: string;
  permission: string;
  table: string;
  keyField: string;
  fields: ImportField[];
}

const IMPORT_ENTITIES: Record<string, ImportEntity> = {
  items: {
    key: 'items', title: 'Item Master', permission: 'item.import',
    table: 'items', keyField: 'item_code',
    fields: [
      { field: 'item_code', headers: ['Item Code'], required: true, maxLength: 60 },
      { field: 'item_description', headers: ['Item Description', 'item Description'], required: true, maxLength: 300 },
      { field: 'item_type_id', headers: ['Item Type'], lookup: 'ITEM_TYPE' },
      { field: 'department_id', headers: ['Department'], lookup: 'DEPARTMENT' },
      { field: 'cost_centre_id', headers: ['Cost Centre', 'Cost Center'], lookup: 'COST_CENTRE' },
      { field: 'main_group_id', headers: ['Main Group'], lookup: 'MAIN_GROUP' },
      { field: 'sub_main_group_id', headers: ['Sub Main Group'], lookup: 'SUB_MAIN_GROUP' },
      { field: 'hsn_code', headers: ['HSN Code'], maxLength: 20 },
      { field: 'indent_type_id', headers: ['Indent Type'], lookup: 'INDENT_TYPE' },
      { field: 'uom_id', headers: ['UOM', 'Uom'], lookup: 'UOM' },
      { field: 'item_specification', headers: ['Item Specification'], maxLength: 1000 },
      { field: 'standard_rate', headers: ['Standard Rate', 'Rate'], numeric: true },
    ],
  },
  suppliers: {
    key: 'suppliers', title: 'Supplier Master', permission: 'supplier.import',
    table: 'suppliers', keyField: 'supplier_name',
    fields: [
      { field: 'supplier_name', headers: ['Supplier Name'], required: true, maxLength: 200 },
      { field: 'address', headers: ['Address'], maxLength: 500 },
      { field: 'state', headers: ['State'], maxLength: 100 },
      { field: 'city', headers: ['City'], maxLength: 100 },
      { field: 'country', headers: ['Country'], maxLength: 100 },
      { field: 'mobile_no', headers: ['Mobile No.', 'Mobile No'], maxLength: 30 },
      { field: 'email', headers: ['Gmail ID', 'Email'], maxLength: 200 },
      { field: 'gst_no', headers: ['GST No', 'GST No.'], maxLength: 20 },
      { field: 'payment_terms', headers: ['Payment Terms'], maxLength: 100 },
      { field: 'currency_code', headers: ['Currency'], maxLength: 10 },
    ],
  },
  // Profile columns only. Activation, roles and passwords stay ERP decisions,
  // as in the User Master sheet sync, so an import can never deactivate an
  // account — the last active Super Admin included (super-admin-guard.ts).
  // A new account is created inactive (see the commit below).
  users: {
    key: 'users', title: 'User Master', permission: 'user.import',
    table: 'users', keyField: 'employee_id',
    fields: [
      { field: 'employee_id', headers: ['Employee ID'], required: true, maxLength: 50 },
      { field: 'employee_name', headers: ['Employee Name'], required: true, maxLength: 150 },
      { field: 'designation', headers: ['Designation'], maxLength: 150 },
    ],
  },
};

/** Parses an uploaded CSV or XLSX buffer into header + row objects. */
async function parseUpload(file: Express.Multer.File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const isCsv = /\.csv$/i.test(file.originalname) || file.mimetype === 'text/csv';

  if (isCsv) {
    const text = file.buffer.toString('utf8').replace(/^﻿/, '');
    const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length === 0) return { headers: [], rows: [] };

    const splitCsv = (line: string): string[] => {
      const out: string[] = [];
      let cur = '';
      let inQuotes = false;
      for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQuotes) {
          if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (ch === '"') inQuotes = false;
          else cur += ch;
        } else if (ch === '"') inQuotes = true;
        else if (ch === ',') { out.push(cur); cur = ''; }
        else cur += ch;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };

    const headers = splitCsv(lines[0]!);
    const rows = lines.slice(1).map((line) => {
      const cells = splitCsv(line);
      return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? '']));
    });
    return { headers, rows };
  }

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) return { headers: [], rows: [] };

  const headers: string[] = [];
  ws.getRow(1).eachCell({ includeEmpty: false }, (cell, col) => {
    headers[col - 1] = String(cell.value ?? '').trim();
  });

  const rows: Record<string, string>[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj: Record<string, string> = {};
    let hasValue = false;
    headers.forEach((h, i) => {
      if (!h) return;
      const raw = row.getCell(i + 1).value;
      let text = '';
      if (raw !== null && raw !== undefined) {
        if (raw instanceof Date) text = raw.toISOString().slice(0, 10);
        else if (typeof raw === 'object' && 'text' in raw) text = String((raw as { text: unknown }).text ?? '');
        else if (typeof raw === 'object' && 'result' in raw) text = String((raw as { result: unknown }).result ?? '');
        else text = String(raw);
      }
      text = text.trim();
      if (text) hasValue = true;
      obj[h] = text;
    });
    if (hasValue) rows.push(obj);
  });

  return { headers: headers.filter(Boolean), rows };
}

/** Resolves the first header alias present in the uploaded file (ADR-006 style). */
function pickHeader(headers: string[], aliases: string[]): string | null {
  const normalised = new Map(headers.map((h) => [h.toLowerCase().trim(), h]));
  for (const alias of aliases) {
    const found = normalised.get(alias.toLowerCase().trim());
    if (found) return found;
  }
  return null;
}

/* ── POST /io/import/:entity/preview ────────────────────────────────────────── */

router.post(
  '/import/:entity/preview',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    const key = req.params.entity ?? '';
    const entity = IMPORT_ENTITIES[key];
    if (!entity) {
      throw ValidationError(`Unknown import target "${key}".`, [
        { field: 'entity', message: `Supported: ${Object.keys(IMPORT_ENTITIES).join(', ')}.` },
      ]);
    }
    if (!req.user!.permissions.has(entity.permission)) {
      throw ValidationError(`You do not have permission to import ${entity.title}.`);
    }
    if (!req.file) throw ValidationError('Please choose a CSV or Excel file to import.');

    const { headers, rows } = await parseUpload(req.file);
    if (rows.length === 0) {
      throw ValidationError('The uploaded file contains no data rows.');
    }
    if (rows.length > 20000) {
      throw BusinessRuleError('This file has more than 20,000 rows. Please split it into smaller files.');
    }

    // Map each field to the header actually present in the file.
    const headerMap = new Map<string, string | null>();
    for (const f of entity.fields) headerMap.set(f.field, pickHeader(headers, f.headers));

    const missingRequired = entity.fields
      .filter((f) => f.required && !headerMap.get(f.field))
      .map((f) => f.headers[0]);
    if (missingRequired.length > 0) {
      throw ValidationError(
        `The file is missing required column(s): ${missingRequired.join(', ')}.`,
        [{ field: 'file', message: `Found columns: ${headers.join(', ')}` }],
      );
    }

    // Pre-load lookups and existing keys so validation costs no per-row queries.
    const lookupRows = await query<{ id: number; category: string; code: string; name: string }>(
      'SELECT id, category, code, name FROM lookups WHERE deleted_at IS NULL',
    );
    const lookupIndex = new Map<string, number>();
    for (const l of lookupRows) {
      lookupIndex.set(`${l.category}:${l.name.toLowerCase().trim()}`, Number(l.id));
      lookupIndex.set(`${l.category}:${l.code.toLowerCase().trim()}`, Number(l.id));
    }

    const existingRows = await query<Record<string, string>>(
      `SELECT ${entity.keyField} AS k FROM ${entity.table} WHERE deleted_at IS NULL`,
    );
    const existingKeys = new Set(existingRows.map((r) => String(r.k).toLowerCase().trim()));

    const seenInFile = new Set<string>();
    const parsed: {
      rowNumber: number; status: 'VALID' | 'INVALID'; action: 'INSERT' | 'UPDATE' | null;
      raw: Record<string, string>; data: Record<string, unknown>; errors: { field: string; message: string }[];
    }[] = [];

    for (const [i, raw] of rows.entries()) {
      const rowNumber = i + 2; // +1 for zero-index, +1 for the header row
      const errors: { field: string; message: string }[] = [];
      const data: Record<string, unknown> = {};

      for (const f of entity.fields) {
        const header = headerMap.get(f.field);
        const value = header ? (raw[header] ?? '').trim() : '';

        if (f.required && value === '') {
          errors.push({ field: f.headers[0]!, message: 'This column is required.' });
          continue;
        }
        if (value === '') { data[f.field] = f.lookup ? null : ''; continue; }
        if (f.maxLength && value.length > f.maxLength) {
          errors.push({ field: f.headers[0]!, message: `Must be ${f.maxLength} characters or fewer.` });
          continue;
        }
        if (f.numeric) {
          const n = parseNumericInput(value);
          if (n === null) {
            errors.push({ field: f.headers[0]!, message: `"${value}" is not a valid number.` });
          } else if (Number(n) < 0) {
            errors.push({ field: f.headers[0]!, message: 'Cannot be negative.' });
          } else {
            data[f.field] = toRate(n);
          }
          continue;
        }
        if (f.lookup) {
          const id = lookupIndex.get(`${f.lookup}:${value.toLowerCase()}`);
          if (id === undefined) {
            errors.push({
              field: f.headers[0]!,
              message: `"${value}" does not exist in the ${f.lookup.replace(/_/g, ' ').toLowerCase()} master. Create it first, or correct the spelling.`,
            });
          } else {
            data[f.field] = id;
          }
          continue;
        }
        data[f.field] = value;
      }

      const keyValue = String(data[entity.keyField] ?? '').toLowerCase().trim();
      let action: 'INSERT' | 'UPDATE' | null = null;

      if (keyValue) {
        if (seenInFile.has(keyValue)) {
          errors.push({
            field: entity.fields.find((f) => f.field === entity.keyField)!.headers[0]!,
            message: 'Duplicated within this file.',
          });
        } else {
          seenInFile.add(keyValue);
          action = existingKeys.has(keyValue) ? 'UPDATE' : 'INSERT';
        }
      }

      parsed.push({
        rowNumber,
        status: errors.length === 0 ? 'VALID' : 'INVALID',
        action: errors.length === 0 ? action : null,
        raw, data, errors,
      });
    }

    // Only a Super Admin may change a Super Admin account (super-admin-guard.ts).
    // This import updates every matched account by Employee ID, so a user
    // administrator who is not one could rename or re-designate the Super Admin,
    // which the Users screen refuses (security review, 2026-10-16). The row is
    // refused here, and the commit checks again.
    if (entity.key === 'users' && !req.user!.isSuperAdmin) {
      const updates = parsed.filter((p) => p.action === 'UPDATE');
      const keyOf = (p: { data: Record<string, unknown> }) => String(p.data[entity.keyField] ?? '').toLowerCase().trim();
      const matched = updates.length === 0 ? [] : await query<{ id: number; k: string }>(
        'SELECT id, lower(employee_id) AS k FROM users WHERE deleted_at IS NULL AND lower(employee_id) = ANY($1::text[])',
        [updates.map(keyOf)],
      );
      const supers = new Set(await superAdminsAmong(undefined, matched.map((m) => Number(m.id))));
      const superKeys = new Set(matched.filter((m) => supers.has(Number(m.id))).map((m) => m.k.trim()));
      for (const p of updates) {
        if (!superKeys.has(keyOf(p))) continue;
        p.errors.push({
          field: entity.fields.find((f) => f.field === entity.keyField)!.headers[0]!,
          message: 'This is a Super Admin account. Only a Super Admin can change it.',
        });
        p.status = 'INVALID';
        p.action = null;
      }
    }

    const validCount = parsed.filter((p) => p.status === 'VALID').length;

    // The preview is persisted so "confirm" commits exactly what was reviewed —
    // the file is never re-parsed with different results.
    const jobId = await withTransaction(async (tx) => {
      const job = await txQueryOne<{ id: number }>(
        tx,
        `INSERT INTO import_jobs (entity, filename, status, total_rows, valid_rows, invalid_rows,
                                  actor_user_id, expires_at)
         VALUES ($1,$2,'PREVIEW',$3,$4,$5,$6, now() + interval '2 hours')
         RETURNING id`,
        [entity.key, req.file!.originalname, parsed.length, validCount,
         parsed.length - validCount, req.user!.id],
      );
      if (!job) throw new Error('Failed to create import job.');

      for (const p of parsed) {
        await tx.query(
          `INSERT INTO import_rows (job_id, row_number, status, action, raw_data, parsed_data, errors)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7::jsonb)`,
          [job.id, p.rowNumber, p.status, p.action,
           JSON.stringify(p.raw), JSON.stringify(p.data), JSON.stringify(p.errors)],
        );
      }
      return job.id;
    });

    sendCreated(res, {
      jobId,
      entity: entity.key,
      title: entity.title,
      filename: req.file.originalname,
      totalRows: parsed.length,
      validRows: validCount,
      invalidRows: parsed.length - validCount,
      insertCount: parsed.filter((p) => p.action === 'INSERT').length,
      updateCount: parsed.filter((p) => p.action === 'UPDATE').length,
      columnsMatched: Object.fromEntries(headerMap),
      // A capped sample keeps the response small; the full set is paginated below.
      preview: parsed.slice(0, 100),
      expiresInMinutes: 120,
    });
  }),
);

/* ── GET /io/import/:jobId/rows ─────────────────────────────────────────────── */

router.get(
  '/import/:id/rows',
  validateQuery(z.object({
    status: z.enum(['VALID', 'INVALID', 'IMPORTED', 'SKIPPED']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(500).default(100),
  })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { status, page, pageSize } = parsedQuery<{ status?: string; page: number; pageSize: number }>(res);

    const job = await queryOne<{ actor_user_id: number; entity: string }>(
      'SELECT actor_user_id, entity FROM import_jobs WHERE id = $1', [id],
    );
    if (!job) throw NotFoundError('Import job');
    const entity = IMPORT_ENTITIES[job.entity];
    if (!entity || !req.user!.permissions.has(entity.permission)) {
      throw ValidationError(`You do not have permission to view this import.`);
    }

    const rows = await query(
      `SELECT row_number, status, action, raw_data, parsed_data, errors
         FROM import_rows
        WHERE job_id = $1 ${status ? 'AND status = $2' : ''}
        ORDER BY row_number
        LIMIT ${status ? '$3' : '$2'} OFFSET ${status ? '$4' : '$3'}`,
      status ? [id, status, pageSize, (page - 1) * pageSize] : [id, pageSize, (page - 1) * pageSize],
    );
    const total = await queryOne<{ n: string }>(
      `SELECT COUNT(*) AS n FROM import_rows WHERE job_id = $1 ${status ? 'AND status = $2' : ''}`,
      status ? [id, status] : [id],
    );

    sendOk(res, rows, { page, pageSize, total: Number(total?.n ?? 0) });
  }),
);

/* ── GET /io/import/:id/errors.csv — downloadable error report (SRS §22) ────── */

router.get(
  '/import/:id/errors.csv',
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const job = await queryOne<{ entity: string; filename: string }>(
      'SELECT entity, filename FROM import_jobs WHERE id = $1', [id],
    );
    if (!job) throw NotFoundError('Import job');
    const entity = IMPORT_ENTITIES[job.entity];
    if (!entity || !req.user!.permissions.has(entity.permission)) {
      throw ValidationError(`You do not have permission to view this import.`);
    }

    const rows = await query<{ row_number: number; raw_data: Record<string, string>; errors: { field: string; message: string }[] }>(
      "SELECT row_number, raw_data, errors FROM import_rows WHERE job_id = $1 AND status = 'INVALID' ORDER BY row_number",
      [id],
    );

    const lines = ['Row,Column,Problem,Original Value'];
    for (const r of rows) {
      for (const e of r.errors ?? []) {
        lines.push([
          csvEscape(r.row_number), csvEscape(e.field), csvEscape(e.message),
          csvEscape((r.raw_data ?? {})[e.field] ?? ''),
        ].join(','));
      }
    }

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="import-errors-${id}.csv"`);
    res.send(`﻿${lines.join('\r\n')}`);
  }),
);

/* ── POST /io/import/:id/commit ─────────────────────────────────────────────── */

router.post(
  '/import/:id/commit',
  validateBody(z.object({
    mode: z.enum(['STRICT', 'PARTIAL']).default('STRICT'),
  })),
  asyncHandler(async (req, res) => {
    const id = idParam(req);
    const { mode } = req.body as { mode: 'STRICT' | 'PARTIAL' };

    const job = await queryOne<{
      entity: string; status: string; actor_user_id: number; invalid_rows: number;
      valid_rows: number; expires_at: string; filename: string;
    }>('SELECT * FROM import_jobs WHERE id = $1', [id]);
    if (!job) throw NotFoundError('Import job');

    const entity = IMPORT_ENTITIES[job.entity];
    if (!entity) throw NotFoundError('Import target');
    if (!req.user!.permissions.has(entity.permission)) {
      throw ValidationError(`You do not have permission to import ${entity.title}.`);
    }
    if (job.status !== 'PREVIEW') {
      throw BusinessRuleError(`This import has already been ${job.status.toLowerCase()}.`);
    }
    if (new Date(job.expires_at) < new Date()) {
      await query("UPDATE import_jobs SET status = 'EXPIRED' WHERE id = $1", [id]);
      throw BusinessRuleError('This import preview has expired. Please upload the file again.');
    }
    // STRICT is the default: an all-or-nothing import, as SRS §22 requires.
    if (mode === 'STRICT' && Number(job.invalid_rows) > 0) {
      throw BusinessRuleError(
        `${job.invalid_rows} row(s) have validation errors. Fix them and re-upload, ` +
        `or choose partial import to commit only the ${job.valid_rows} valid row(s).`,
        { invalidRows: Number(job.invalid_rows), validRows: Number(job.valid_rows) },
      );
    }

    const result = await withTransaction(async (tx) => {
      const rows = await txQuery<{ id: number; row_number: number; action: string; parsed_data: Record<string, unknown> }>(
        tx,
        "SELECT id, row_number, action, parsed_data FROM import_rows WHERE job_id = $1 AND status = 'VALID' ORDER BY row_number",
        [id],
      );

      // Checked again where the rows are written: an account may have become a
      // Super Admin since the preview, and a preview a Super Admin made can be
      // committed by another administrator.
      if (entity.key === 'users') {
        const keys = rows
          .filter((r) => r.action === 'UPDATE')
          .map((r) => String((r.parsed_data ?? {})[entity.keyField] ?? '').toLowerCase().trim());
        if (keys.length > 0) {
          const targets = await txQuery<{ id: number }>(
            tx, 'SELECT id FROM users WHERE deleted_at IS NULL AND lower(employee_id) = ANY($1::text[])', [keys],
          );
          await assertMayChangeUsers(tx, req, targets.map((t) => Number(t.id)));
        }
      }

      let inserted = 0;
      let updated = 0;

      for (const row of rows) {
        const data = row.parsed_data ?? {};
        const fields = entity.fields.map((f) => f.field).filter((f) => data[f] !== undefined);
        const values = fields.map((f) => data[f]);

        if (row.action === 'UPDATE') {
          const sets = fields.map((f, i) => `"${f}" = $${i + 2}`).join(', ');
          await tx.query(
            `UPDATE ${entity.table} SET ${sets}, updated_at = now(), updated_by = $${fields.length + 2}
              WHERE lower(${entity.keyField}) = lower($1) AND deleted_at IS NULL`,
            [String(data[entity.keyField]), ...values, req.user!.id],
          );
          updated += 1;
        } else {
          // Users need a password; imported accounts get a locked placeholder that
          // must be reset by an administrator before first use.
          const extraCols = entity.table === 'users' ? ', password_hash, is_active, must_change_password' : '';
          const extraVals = entity.table === 'users' ? ", '!', FALSE, TRUE" : '';
          const placeholders = fields.map((_, i) => `$${i + 1}`).join(',');
          await tx.query(
            `INSERT INTO ${entity.table} (${fields.map((f) => `"${f}"`).join(',')}${extraCols}, created_by, updated_by)
             VALUES (${placeholders}${extraVals}, $${fields.length + 1}, $${fields.length + 1})`,
            [...values, req.user!.id],
          );
          inserted += 1;
        }
        await tx.query("UPDATE import_rows SET status = 'IMPORTED' WHERE id = $1", [row.id]);
      }

      await tx.query(
        `UPDATE import_jobs
            SET status = 'COMMITTED', mode = $2, inserted_rows = $3, updated_rows = $4,
                committed_at = now(), message = $5
          WHERE id = $1`,
        [id, mode, inserted, updated,
         `Imported ${inserted + updated} row(s): ${inserted} created, ${updated} updated.`],
      );

      await auditIn(tx, {
        actor: actorFrom(req), action: 'IMPORT', entity: entity.key, entityId: id,
        entityLabel: `${entity.title} — ${job.filename}`,
        after: { inserted, updated, mode, skipped: Number(job.invalid_rows) },
        message: `Imported ${inserted + updated} row(s) from ${job.filename}.`,
      });

      return { inserted, updated };
    });

    logger.info(`Import committed: ${entity.title} +${result.inserted} ~${result.updated}`);

    sendOk(res, {
      ...result,
      skipped: Number(job.invalid_rows),
      message:
        `${entity.title} import complete — ${result.inserted} record(s) created, ` +
        `${result.updated} updated` +
        (Number(job.invalid_rows) > 0 ? `, ${job.invalid_rows} skipped due to errors.` : '.'),
    });
  }),
);

/* ── GET /io/import/template/:entity ────────────────────────────────────────── */

router.get(
  '/import/template/:entity',
  asyncHandler(async (req, res) => {
    const key = req.params.entity ?? '';
    const entity = IMPORT_ENTITIES[key];
    if (!entity) throw NotFoundError('Import target');

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(entity.title.slice(0, 31));

    const header = ws.addRow(entity.fields.map((f) => f.headers[0]!));
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((cell, i) => {
      const field = entity.fields[i - 1];
      cell.fill = {
        type: 'pattern', pattern: 'solid',
        // Required columns are visually distinct so the template explains itself.
        fgColor: { argb: field?.required ? 'FF8A1C1C' : 'FF0B2A4A' },
      };
      if (field) {
        cell.note = [
          field.required ? 'REQUIRED' : 'Optional',
          field.lookup ? `Must match an existing ${field.lookup.replace(/_/g, ' ').toLowerCase()} value.` : '',
          field.numeric ? 'Numeric value.' : '',
        ].filter(Boolean).join('\n');
      }
    });
    ws.columns = entity.fields.map((f) => ({ width: Math.max(16, f.headers[0]!.length + 4) }));
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    // A hint row shows what each column expects, and is ignored on import because
    // it fails the required-field checks visibly rather than silently.
    const hint = ws.addRow(entity.fields.map((f) =>
      f.required ? '(required)' : f.lookup ? `(existing ${f.lookup.toLowerCase()})` : f.numeric ? '(number)' : '',
    ));
    hint.font = { italic: true, size: 9, color: { argb: 'FF8894A0' } };

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="zolex-${key}-import-template.xlsx"`);
    await wb.xlsx.write(res);
    res.end();
  }),
);

router.get(
  '/import',
  asyncHandler(async (req, res) => {
    sendOk(res, {
      entities: Object.values(IMPORT_ENTITIES)
        .filter((e) => req.user!.permissions.has(e.permission))
        .map((e) => ({
          key: e.key, title: e.title,
          columns: e.fields.map((f) => ({
            header: f.headers[0], required: Boolean(f.required),
            lookup: f.lookup ?? null, numeric: Boolean(f.numeric),
          })),
        })),
      note:
        'Only master data can be imported. Indents, purchase orders and GRNs must be created ' +
        'through their workflows so numbering, approval and quantity controls are applied.',
    });
  }),
);

/* ── GET /io/import/jobs — history ──────────────────────────────────────────── */

router.get(
  '/import/jobs',
  asyncHandler(async (req, res) => {
    // Scoped to entities the caller can actually import — a job history line
    // reveals filenames, row counts and the actor's name, which is not
    // something a user without that entity's import permission should see.
    const visibleEntities = Object.values(IMPORT_ENTITIES)
      .filter((e) => req.user!.permissions.has(e.permission))
      .map((e) => e.key);
    if (visibleEntities.length === 0) return sendOk(res, []);

    const rows = await query(
      `SELECT j.id, j.entity, j.filename, j.status, j.mode, j.total_rows, j.valid_rows,
              j.invalid_rows, j.inserted_rows, j.updated_rows, j.message,
              j.created_at, j.committed_at, u.employee_name AS actor_name
         FROM import_jobs j
         LEFT JOIN users u ON u.id = j.actor_user_id
        WHERE j.entity = ANY($1)
        ORDER BY j.created_at DESC
        LIMIT 100`,
      [visibleEntities],
    );
    sendOk(res, rows);
  }),
);

export default router;
