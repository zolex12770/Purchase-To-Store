-- ============================================================================
-- 018 — Google replica, rebuilt for LOW cost
--
-- The previous design was correct but expensive, in three specific ways that
-- this migration removes:
--
--  1. Triggers were attached to EVERY table, so bookkeeping churn
--     (document_sequences, import_rows, google_sync_jobs ...) filled the outbox
--     with changes no business tab could ever show.
--
--  2. Nothing recorded WHERE a business row lives in its tab, so pushing one
--     changed row meant downloading the whole tab to find it. On a 12,461-row
--     Item Master that is a multi-megabyte download every drain — and PGlite
--     runs in-process, so parsing it stalls the ERP's own event loop.
--
--  3. A full export ran inside the HTTP request that asked for it.
--
-- So: fewer triggers, a durable row index, and a resumable background job.
-- None of this is on the hot path of a business write, and all of it may be
-- switched off without changing ERP behaviour.
-- ============================================================================

-- ── Where each business row lives in its tab ────────────────────────────────
-- Keyed by the BUSINESS primary key (e.g. PO ID + PO Line ID), not by a SQL
-- table key, because one sheet row can be assembled from several tables.
--
-- `row_no` is the 1-based sheet row (header is row 1, so data starts at 2).
-- `digest` is a hash of the rendered cells: an unchanged row is skipped
-- entirely rather than rewritten, which is what keeps a 12k-row tab from being
-- re-sent when three cells changed.
CREATE TABLE google_db_rows (
  sheet_name TEXT        NOT NULL,
  row_key    TEXT        NOT NULL,
  row_no     INTEGER     NOT NULL,
  digest     TEXT        NOT NULL DEFAULT '',
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (sheet_name, row_key)
);

-- Two business rows may never claim the same physical sheet row.
CREATE UNIQUE INDEX uq_google_db_rows_position ON google_db_rows (sheet_name, row_no);

-- ── Background job queue (full export, index rebuild, reconciliation) ───────
-- A job carries its own resumable cursor, so a 100k-row export proceeds in
-- slices across scheduler ticks instead of occupying one long call. The ERP
-- stays responsive because no slice is large enough to stall the event loop.
CREATE TABLE google_db_jobs (
  id            BIGSERIAL PRIMARY KEY,
  kind          TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'QUEUED',
  sheets        TEXT[]      NOT NULL DEFAULT '{}',
  cursor_sheet  TEXT,
  cursor_offset INTEGER     NOT NULL DEFAULT 0,
  total_rows    INTEGER     NOT NULL DEFAULT 0,
  done_rows     INTEGER     NOT NULL DEFAULT 0,
  api_calls     INTEGER     NOT NULL DEFAULT 0,
  detail        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  message       TEXT,
  queued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_google_job_kind   CHECK (kind IN ('FULL_EXPORT', 'REBUILD_INDEX', 'RECONCILE')),
  CONSTRAINT chk_google_job_status CHECK (status IN ('QUEUED', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED'))
);

-- At most one job actually in flight; the partial index makes that a database
-- guarantee rather than a convention the worker has to remember.
CREATE UNIQUE INDEX uq_google_db_jobs_active
  ON google_db_jobs ((1)) WHERE status IN ('QUEUED', 'RUNNING');

CREATE INDEX idx_google_db_jobs_queued ON google_db_jobs (queued_at DESC);

-- ── Scheduler health (single row) ──────────────────────────────────────────
-- Backoff lives HERE rather than inside a drain call. Sleeping inside the tick
-- is what turned a Google outage into a stalled worker; instead the tick
-- returns immediately and simply is not run again until `next_attempt_at`.
CREATE TABLE google_db_health (
  id                   INTEGER     PRIMARY KEY DEFAULT 1,
  consecutive_failures INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_attempt_at      TIMESTAMPTZ,
  last_success_at      TIMESTAMPTZ,
  last_error           TEXT,
  reachable            BOOLEAN     NOT NULL DEFAULT TRUE,
  api_calls_today      INTEGER     NOT NULL DEFAULT 0,
  api_calls_date       DATE        NOT NULL DEFAULT CURRENT_DATE,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_google_health_singleton CHECK (id = 1)
);
INSERT INTO google_db_health (id) VALUES (1) ON CONFLICT DO NOTHING;

-- A sheet whose index can no longer be trusted (someone inserted rows by hand,
-- or an import rewrote it) is repaired before the next targeted write.
ALTER TABLE google_db_state ADD COLUMN IF NOT EXISTS index_dirty BOOLEAN NOT NULL DEFAULT TRUE;

-- ── Change capture, narrowed ────────────────────────────────────────────────
-- Only tables that actually feed a business tab are mirrored. Everything else
-- was pure outbox churn: sequence allocations, import staging rows, the inbound
-- sync engine's own bookkeeping, and the session/permission tables.
CREATE OR REPLACE FUNCTION google_db_attach_triggers() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  t        record;
  pk_cols  text;
  attached integer := 0;
  mirrored text[] := ARRAY[
    'items', 'suppliers', 'users', 'lookups', 'roles', 'user_roles',
    'purchase_indent_headers', 'purchase_indent_lines', 'indent_approvals',
    'purchase_order_headers', 'purchase_order_lines', 'po_indent_sources',
    'grn_headers', 'grn_lines', 'grn_line_mlns',
    'requisition_headers', 'requisition_lines', 'requisition_approvals',
    'requisition_issues', 'requisition_issue_lines',
    'stock_ledger', 'audit_logs'
  ];
BEGIN
  -- Drop the trigger everywhere first, so tables that USED to be mirrored stop
  -- enqueuing the moment this migration runs.
  FOR t IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_google_db_sync ON %I', t.table_name);
  END LOOP;

  FOR t IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname = ANY (mirrored)
     ORDER BY c.relname
  LOOP
    SELECT string_agg(quote_literal(kcu.column_name), ',' ORDER BY kcu.ordinal_position)
      INTO pk_cols
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
       AND kcu.table_schema = tc.table_schema
     WHERE tc.table_schema = 'public'
       AND tc.table_name = t.table_name
       AND tc.constraint_type = 'PRIMARY KEY';

    CONTINUE WHEN pk_cols IS NULL;

    EXECUTE format(
      'CREATE TRIGGER trg_google_db_sync AFTER INSERT OR UPDATE OR DELETE ON %I
         FOR EACH ROW EXECUTE FUNCTION google_db_enqueue(%s)',
      t.table_name, pk_cols
    );
    attached := attached + 1;
  END LOOP;

  RETURN attached;
END $fn$;

SELECT google_db_attach_triggers();

-- Rows queued from tables that are no longer mirrored can never be rendered;
-- retiring them keeps the first drain after this migration small.
UPDATE google_db_outbox
   SET processed_at = now(), last_error = 'table no longer mirrored (migration 018)'
 WHERE processed_at IS NULL
   AND table_name NOT IN (
     'items', 'suppliers', 'users', 'lookups', 'roles', 'user_roles',
     'purchase_indent_headers', 'purchase_indent_lines', 'indent_approvals',
     'purchase_order_headers', 'purchase_order_lines', 'po_indent_sources',
     'grn_headers', 'grn_lines', 'grn_line_mlns',
     'requisition_headers', 'requisition_lines', 'requisition_approvals',
     'requisition_issues', 'requisition_issue_lines',
     'stock_ledger', 'audit_logs'
   );

-- The tab set changed shape (27 business tabs -> 11), so per-sheet state from
-- the previous layout no longer describes anything that exists.
DELETE FROM google_db_state;
