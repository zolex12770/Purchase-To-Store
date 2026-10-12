# DATABASE/ — ZOLEX Purchase-to-Store ERP data & backup architecture

This folder is the project-local **export and archive area**. It is not a database
server and it is not what the running application reads from — the live ERP always
runs on its own embedded PostgreSQL (PGlite) or a real PostgreSQL server, exactly as
before. What lives here is a set of human-inspectable, portable copies of that data,
generated on demand from the live application.

```
DATABASE/
├── README.md              — this file
├── SQL/
│   ├── schema_mysql.sql        — canonical MySQL-compatible schema (versioned, hand-authored)
│   └── zolex_data_<ts>.sql     — generated INSERT statements, from the CURRENT REAL data
├── EXCEL/
│   └── zolex_export_<ts>.xlsx  — one workbook, one sheet per table, current real data
├── GOOGLE_SHEET/
│   ├── _manifest.json          — spreadsheet ID, export time, per-sheet summary
│   └── <sheet name>.json       — worksheet name, headers, rows, export timestamp
└── BACKUPS/
    └── <timestamp>/            — bundled snapshot: that export cycle's SQL + Excel + Sheet archive
```

## 1. Source-of-truth rule

| Store | Role |
|---|---|
| **SQL** (the live PGlite/PostgreSQL database, and `SQL/schema_mysql.sql` + `zolex_data_*.sql` as its portable mirror) | **PRIMARY / CANONICAL.** Every screen in the ERP reads and writes here. Nothing else can create, approve or post a document. |
| **Google Sheet** | **EXTERNAL SYNCHRONISATION SOURCE**, one-way (Sheets → SQL) for master data only. Transactional documents (Indent/PO/GRN) are reconciled, never imported — a divergence is recorded as a CONFLICT for a human to resolve (see `backend/src/modules/google-sync/engine.ts`). |
| **Excel** | **BACKUP / EXPORT** only. Never read by the application. |

Consequences, by design:
- **Google Sheets goes offline** → the ERP is unaffected. `google_sync.enabled` can be
  switched off from Admin → Settings and every screen keeps working from SQL alone
  (this was true before this change and remains true).
- **The Excel file is lost or deleted** → SQL is untouched; regenerate the Excel file
  at any time from the button described below.
- **The Google Sheet or Excel data is damaged** → SQL is the system of record and is
  never overwritten by either; re-run the export to get a fresh, correct copy.
- **Sync is deliberately one-way and additive for masters, and never destructive** —
  it does not delete rows and never silently overwrites an approved transactional
  document. This was already true of the sync engine before this change.

## 2. Where the real database is, and how to open it in MySQL Workbench

The live database itself is **not** MySQL — it is PostgreSQL (embedded PGlite by
default, or a real PostgreSQL server when `DB_DRIVER=pg`). `SQL/schema_mysql.sql` is
a hand-translated, MySQL-compatible mirror of that same schema, and
`SQL/zolex_data_<timestamp>.sql` is a matching dump of the **current real data**,
generated on demand (never automatically, never on a schedule you didn't ask for).

To open the data in MySQL Workbench:

1. Create an empty schema:
   ```sql
   CREATE DATABASE zolex_erp DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_0900_ai_ci;
   ```
2. Open `DATABASE/SQL/schema_mysql.sql` in Workbench, select `zolex_erp`, execute the
   whole script. It is dependency-ordered, so every `FOREIGN KEY` target already
   exists by the time it's referenced.
3. Open the **newest** `DATABASE/SQL/zolex_data_*.sql` file, execute it. It only
   contains `INSERT` statements — no `DROP`/`CREATE` — built from a live read of the
   application database (never sample or demo rows).
4. Requires MySQL 8.0.16+ for the `CHECK` constraints to be enforced by the server
   itself (they are still enforced by the Node/Zod layer regardless of MySQL version
   — see `schema_mysql.sql`'s header for the full list of conversion notes).

### Generating a fresh export

Admin → Backup & Restore → **"Export to DATABASE/"** (requires the `backup.create`
permission — the same permission that already gates the operational backup button
next to it). This calls `POST /api/v1/backup/export/all`, which:

- reads every business/audit table live from the running database,
- writes a new `zolex_data_<timestamp>.sql` and `zolex_export_<timestamp>.xlsx`,
- re-archives every enabled Google Sheet into `GOOGLE_SHEET/`,
- **independently re-counts every table with `SELECT COUNT(*)` after the export**
  and compares it against what was actually written out, reporting any mismatch
  (a mismatch would only happen if live data changed mid-export — re-run it),
- bundles copies of all three into `BACKUPS/<timestamp>/` with a `manifest.json`.

The individual exports (`POST /backup/export/sql`, `/excel`, `/google-sheet`) are
also available if you only need one of the three.

This runs **inside the already-running backend process**, not as a separate CLI —
PGlite allows only one process to hold its data directory at a time (see
`backend/src/db/driver.ts`), so a second process attempting the same read would
either fail or force you to stop the live server. Running it in-process means the
export never requires downtime.

## 3. How to restore

**`DATABASE/SQL`, `DATABASE/EXCEL` and `DATABASE/GOOGLE_SHEET` are read-only exports.
None of them can be fed back into the ERP.** This is intentional: a hand-edited SQL
file or spreadsheet must never be able to silently become live production data.

The ERP's actual restore path is the **operational backup**, already built and
working before this change (Admin → Backup & Restore, top of the same screen; or
`npm run db:restore -- <filename>` from `backend/`):

1. It writes a checksum-verified JSON snapshot to `$ZOLEX_DATA_ROOT/backups`
   (**outside** the project folder — survives a redeploy, is never committed to
   source control).
2. Restore re-verifies the SHA-256 checksum before touching anything, and the whole
   restore runs inside one transaction: either every table ends up exactly as the
   backup describes, or nothing changes.
3. `POST /api/v1/backup/:id/restore` (typed `RESTORE` confirmation required) or the
   `db:restore` CLI, which is also the documented recovery path if the database's
   data directory fails to open after an unclean shutdown (see the diagnostic
   message in `backend/src/db/driver.ts`).

If you need to restore from a `DATABASE/BACKUPS/<timestamp>/` bundle, use the JSON
backup that was current at that time from `$ZOLEX_DATA_ROOT/backups`, or restore the
SQL dump into a MySQL/PostgreSQL server directly with a client and treat that server
as a read replica for reporting — not as a way to push data back into the live ERP.

## 4. Pre-migration / recurring backup practice

- **Before any destructive database operation** (a schema migration, `db:purify`,
  a bulk import commit): take an operational backup first (button described in §3).
  This was already the project's standing rule; nothing about it changed here.
- **Recurring**: `npm run db:backup` (from `backend/`) is the same mechanism, runnable
  from cron/Task Scheduler; retention is controlled by the `backup.retention_days`
  / `backup.retention_count` settings in Admin → Settings.
- **Recovery drill**: periodically confirm a real restore works — most conveniently
  in a copy of the data directory, not the live one, given restore replaces every
  table.

## 5. Where Excel backups are

`DATABASE/EXCEL/zolex_export_<timestamp>.xlsx` — one workbook per export, one sheet
per table (the same 25 tables as the SQL data export; see §7). Generated by the same
"Export to DATABASE/" action described in §2.

## 6. Where Google Sheet backups are

`DATABASE/GOOGLE_SHEET/` — one JSON file per enabled sheet mapping
(`google_sheet_mappings` in the database), plus `_manifest.json` summarising the
whole run. Each file records exactly what was asked for: worksheet name, headers,
rows, export timestamp, and the source spreadsheet ID. **No credentials are ever
written here** — the service-account key file referenced by
`GOOGLE_SERVICE_ACCOUNT_KEY_FILE` stays wherever it already lives outside the repo,
and this export only ever reads spreadsheet *values*, the same read-only scope the
live sync already uses.

If Google Sheets isn't configured (no credentials set), this export is skipped and
reported as such — it does not fail the rest of the export.

## 7. Tables included

The SQL and Excel exports cover the same 25 tables (`backend/src/db/restore.ts`,
`BACKUP_TABLES`) as the existing operational JSON backup — every master, transaction,
approval, sync-history, import-history and audit table:

`permissions`, `roles`, `role_permissions`, `lookups`, `users`, `user_roles`,
`suppliers`, `items`, `purchase_indent_headers`, `purchase_indent_lines`,
`indent_approvals`, `purchase_order_headers`, `purchase_order_lines`,
`po_indent_sources`, `grn_headers`, `grn_lines`, `document_sequences`,
`app_settings`, `google_sheet_mappings`, `google_sync_jobs`, `google_sync_errors`,
`import_jobs`, `import_rows`, `audit_logs`, `backup_metadata`.

`schema_mysql.sql` additionally defines (schema only, deliberately excluded from the
data export) `user_sessions` and `schema_migrations` — the first is live
refresh-token state that has no meaning outside the server process that issued it,
the second is migration-tool bookkeeping, not business data. Both are documented in
`schema_mysql.sql` itself.

## 8. Future migration considerations

`SQL/schema_mysql.sql` carries the full, itemised list of every PostgreSQL → MySQL
conversion point applied (BIGSERIAL → AUTO_INCREMENT, TIMESTAMPTZ → DATETIME(6),
JSONB → JSON, generated columns, partial-index and case-insensitive-index
differences, etc.) in its header — read that file for the authoritative list rather
than duplicating it here.

The same header also documents what changes on a **future MySQL → Microsoft SQL
Server** migration (IDENTITY vs AUTO_INCREMENT, DATETIME2 vs DATETIME, JSON columns
becoming `NVARCHAR(MAX)` + `ISJSON()`, `BIT` vs `BOOLEAN`, `PERSISTED` vs `STORED`
computed columns, bracket vs backtick identifier quoting). That migration is not
implemented here — only documented, per the requirement that the schema stay
portable "without redesigning the ERP business model."
