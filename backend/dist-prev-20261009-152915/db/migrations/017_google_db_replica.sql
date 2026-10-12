-- ============================================================================
-- 017 — Google Sheets DATABASE replica: durable outbox + per-table state
--
-- SQL stays the primary, live database. This migration adds only the
-- bookkeeping the SQL -> Sheets replica needs, and nothing that any existing
-- business transaction depends on:
--
--   google_db_outbox  — one durable row per changed record, written inside the
--                       SAME transaction as the business change and drained
--                       later by a background worker. That is what makes the
--                       replica eventual rather than blocking: if Google is
--                       down, disabled, or unreachable, the business
--                       transaction still commits and the row simply waits.
--
--   google_db_state   — per-table replica health (last export, row counts,
--                       last error), the SQL-side mirror of the __database_sync
--                       control tab.
--
--   google_db_imports — one row per Google -> SQL import run, so a historical
--                       import is auditable and can be shown as a preview
--                       before it is committed.
--
-- Nothing here is on the hot path of a PO/GRN/Requisition write beyond a single
-- INSERT into google_db_outbox, which is why sync can be switched off entirely
-- without touching business behaviour.
-- ============================================================================

CREATE TABLE google_db_outbox (
  id            BIGSERIAL PRIMARY KEY,
  table_name    TEXT        NOT NULL,
  -- Composite keys are joined with the same separator the replica uses, so one
  -- text column addresses every table's identity without a per-table schema.
  row_key       TEXT        NOT NULL,
  operation     TEXT        NOT NULL,
  -- Where the change came from. GOOGLE_IMPORT rows are NOT re-exported, which
  -- is what stops the SQL -> Google -> SQL -> Google loop.
  source        TEXT        NOT NULL DEFAULT 'SQL',
  enqueued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  attempts      INTEGER     NOT NULL DEFAULT 0,
  last_error    TEXT,
  CONSTRAINT chk_google_outbox_op     CHECK (operation IN ('UPSERT', 'DELETE')),
  CONSTRAINT chk_google_outbox_source CHECK (source IN ('SQL', 'GOOGLE_IMPORT', 'SYSTEM'))
);

-- The drain reads pending rows oldest-first; the partial index keeps that scan
-- proportional to the backlog rather than to the table's whole history.
CREATE INDEX idx_google_outbox_pending
  ON google_db_outbox (enqueued_at)
  WHERE processed_at IS NULL;

-- One pending row per record is enough: re-queuing the same record before it is
-- drained should collapse, not pile up. Enforced on the un-processed rows only,
-- so history is still kept once processed.
CREATE UNIQUE INDEX uq_google_outbox_pending
  ON google_db_outbox (table_name, row_key)
  WHERE processed_at IS NULL;

CREATE TABLE google_db_state (
  table_name        TEXT        PRIMARY KEY,
  sheet_name        TEXT        NOT NULL,
  primary_key       TEXT        NOT NULL,
  last_full_export  TIMESTAMPTZ,
  last_row_export   TIMESTAMPTZ,
  last_import       TIMESTAMPTZ,
  last_success_at   TIMESTAMPTZ,
  sql_row_count     INTEGER     NOT NULL DEFAULT 0,
  sheet_row_count   INTEGER     NOT NULL DEFAULT 0,
  pending_changes   INTEGER     NOT NULL DEFAULT 0,
  failed_changes    INTEGER     NOT NULL DEFAULT 0,
  conflicts         INTEGER     NOT NULL DEFAULT 0,
  sync_status       TEXT        NOT NULL DEFAULT 'PENDING',
  last_error        TEXT,
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE google_db_imports (
  id             BIGSERIAL PRIMARY KEY,
  status         TEXT        NOT NULL DEFAULT 'PREVIEW',
  dry_run        BOOLEAN     NOT NULL DEFAULT TRUE,
  tables         TEXT[]      NOT NULL DEFAULT '{}',
  rows_read      INTEGER     NOT NULL DEFAULT 0,
  rows_inserted  INTEGER     NOT NULL DEFAULT 0,
  rows_updated   INTEGER     NOT NULL DEFAULT 0,
  rows_unchanged INTEGER     NOT NULL DEFAULT 0,
  rows_rejected  INTEGER     NOT NULL DEFAULT 0,
  conflicts      INTEGER     NOT NULL DEFAULT 0,
  detail         JSONB       NOT NULL DEFAULT '[]'::jsonb,
  message        TEXT,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  actor_user_id  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_google_import_status CHECK (status IN ('PREVIEW', 'COMMITTED', 'FAILED'))
);

CREATE INDEX idx_google_db_imports_started ON google_db_imports (started_at DESC);

-- ── Change capture ──────────────────────────────────────────────────────────
-- The outbox is filled by a trigger rather than by edits scattered through
-- every route. That choice is deliberate:
--   • no business code changes, so no regression surface in PO/GRN/Requisition;
--   • the enqueue is inside the caller's own transaction, so a committed
--     business change can never be missing from the queue, and a rolled-back
--     one can never appear in it;
--   • a table added by a future migration is covered by re-running
--     google_db_attach_triggers(), not by remembering to edit a list.
--
-- `zolex.sync_source` is how the SQL -> Google -> SQL loop is broken: the
-- importer sets it to GOOGLE_IMPORT for its transaction, those rows are tagged
-- as such, and the drain skips them instead of echoing them straight back.
CREATE OR REPLACE FUNCTION google_db_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  rec      jsonb;
  key_text text := '';
  col      text;
  first    boolean := TRUE;
BEGIN
  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;

  FOREACH col IN ARRAY TG_ARGV LOOP
    IF NOT first THEN key_text := key_text || chr(31); END IF;
    key_text := key_text || COALESCE(rec ->> col, '');
    first := FALSE;
  END LOOP;

  INSERT INTO google_db_outbox (table_name, row_key, operation, source)
  VALUES (
    TG_TABLE_NAME,
    key_text,
    CASE WHEN TG_OP = 'DELETE' THEN 'DELETE' ELSE 'UPSERT' END,
    COALESCE(NULLIF(current_setting('zolex.sync_source', TRUE), ''), 'SQL')
  )
  -- Already queued and not yet drained: one pending row per record is enough.
  ON CONFLICT (table_name, row_key) WHERE processed_at IS NULL DO NOTHING;

  RETURN NULL; -- AFTER trigger; return value is ignored
END $fn$;

-- Attaches the capture trigger to every mirrored table. Idempotent, and safe to
-- re-run after a migration adds a table.
CREATE OR REPLACE FUNCTION google_db_attach_triggers() RETURNS integer
LANGUAGE plpgsql AS $fn$
DECLARE
  t         record;
  pk_cols   text;
  attached  integer := 0;
BEGIN
  FOR t IN
    SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind = 'r'
       AND c.relname NOT LIKE 'google_db_%'          -- never mirror the mirror
       AND c.relname NOT IN ('user_sessions', 'schema_migrations')
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

    CONTINUE WHEN pk_cols IS NULL;  -- unkeyed table: cannot be addressed, skip

    EXECUTE format('DROP TRIGGER IF EXISTS trg_google_db_sync ON %I', t.table_name);
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
