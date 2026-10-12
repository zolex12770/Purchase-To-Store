-- ============================================================================
-- 020 — Database simplification: duplicate indexes and duplicate sync-log rows
--
-- Result of the 2026-10 audit of all 40 tables (every table, column, key and
-- index was traced to the code that writes and reads it). The verdict was that
-- the structure is sound: no table is dead, and every primary key, foreign key
-- and unique business key carries a real relationship or document number. Two
-- things were demonstrably redundant, and only those are removed here.
--
-- NO business data is touched: no table, no column, no primary key, no foreign
-- key and no unique constraint is dropped or altered by this migration.
--
-- 1. ELEVEN INDEXES THAT DUPLICATE ANOTHER INDEX
--    Each index below has exactly the leading column(s) of another index on the
--    same table (same order, same sort direction, no extra condition), so the
--    other index answers every lookup this one could. The proof was taken from
--    the database catalogue, not from names. Seven of the eleven are covered by
--    the UNIQUE index that enforces the document's line numbering, which has to
--    exist anyway. Dropping them changes no query result and no constraint; it
--    removes eleven structures that every insert and update had to maintain.
--
--    To put any of them back, run the matching statement:
--      CREATE INDEX idx_grn_status ON grn_headers (status);
--      CREATE INDEX idx_grn_lines_grn ON grn_lines (grn_id);
--      CREATE INDEX idx_import_rows_job ON import_rows (job_id, row_number);
--      CREATE INDEX idx_po_sources_po_line ON po_indent_sources (po_line_id);
--      CREATE INDEX idx_indent_status ON purchase_indent_headers (status);
--      CREATE INDEX idx_indent_lines_indent ON purchase_indent_lines (indent_id);
--      CREATE INDEX idx_po_status ON purchase_order_headers (status);
--      CREATE INDEX idx_po_supplier ON purchase_order_headers (supplier_id);
--      CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);
--      CREATE INDEX idx_requisition_status ON requisition_headers (status);
--      CREATE INDEX idx_requisition_lines_requisition ON requisition_lines (requisition_id);
--
-- 2. DUPLICATE OPEN ISSUES IN THE GOOGLE SHEETS SYNC LOG
--    Until the sync engine learned to record an issue once (onlyNewIssues in
--    modules/google-sync/engine.ts), every 15-minute run logged every issue it
--    found again. Measured on the live data of 2026-10-11: 229,497 rows in
--    google_sync_errors — 92 percent of ALL rows in the database and 79 percent
--    of its size — describing 15,995 distinct open issues. The copies are
--    identical in sheet, row, key, code, severity and message; they differ only
--    in which run noticed the issue again.
--
--    One row is kept per distinct open issue: the FIRST one recorded. "Distinct"
--    is exactly the rule the engine itself uses to decide an issue is already
--    logged (sheet, error code, sheet row, business key), so the engine keeps
--    treating every one of them as known. Rows an administrator has resolved
--    are never touched (they carry a human decision). No other table refers to
--    these rows. This cannot be undone from the database; the verified backup
--    taken before every release holds the removed copies.
--
--    The space the copies occupied is handed back after this migration commits
--    (VACUUM cannot run inside a transaction — see POST_MIGRATION in migrate.ts).
-- ============================================================================

DROP INDEX IF EXISTS idx_grn_status;
DROP INDEX IF EXISTS idx_grn_lines_grn;
DROP INDEX IF EXISTS idx_import_rows_job;
DROP INDEX IF EXISTS idx_po_sources_po_line;
DROP INDEX IF EXISTS idx_indent_status;
DROP INDEX IF EXISTS idx_indent_lines_indent;
DROP INDEX IF EXISTS idx_po_status;
DROP INDEX IF EXISTS idx_po_supplier;
DROP INDEX IF EXISTS idx_po_lines_po;
DROP INDEX IF EXISTS idx_requisition_status;
DROP INDEX IF EXISTS idx_requisition_lines_requisition;

DELETE FROM google_sync_errors e
 USING (
   SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY sheet_name, error_code, COALESCE(row_number::text, ''), COALESCE(business_key, '')
            ORDER BY id
          ) AS rn
     FROM google_sync_errors
    WHERE resolved_at IS NULL
 ) d
 WHERE e.id = d.id
   AND d.rn > 1;
