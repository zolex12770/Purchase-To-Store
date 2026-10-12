-- ============================================================================
-- 004_ops — Google sync, import jobs, backup metadata
-- SRS §8, §9, §22, §23  |  ADR-006, ADR-007, ADR-011
-- ============================================================================

-- ── Google Sheets sync (SRS §8) ─────────────────────────────────────────────
CREATE TABLE google_sync_jobs (
  id               BIGSERIAL PRIMARY KEY,
  status           TEXT        NOT NULL DEFAULT 'RUNNING',
  trigger_source   TEXT        NOT NULL DEFAULT 'MANUAL',  -- MANUAL | SCHEDULED | STARTUP
  sheet_id         TEXT        NOT NULL DEFAULT '',
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  duration_ms      INTEGER,
  sheets_processed INTEGER     NOT NULL DEFAULT 0,
  rows_read        INTEGER     NOT NULL DEFAULT 0,
  rows_inserted    INTEGER     NOT NULL DEFAULT 0,
  rows_updated     INTEGER     NOT NULL DEFAULT 0,
  rows_skipped     INTEGER     NOT NULL DEFAULT 0,
  rows_rejected    INTEGER     NOT NULL DEFAULT 0,
  conflicts        INTEGER     NOT NULL DEFAULT 0,
  message          TEXT,
  detail           JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- per-sheet breakdown
  actor_user_id    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_sync_status CHECK (status IN ('RUNNING', 'SUCCESS', 'PARTIAL', 'FAILED', 'CANCELLED')),
  CONSTRAINT chk_sync_trigger CHECK (trigger_source IN ('MANUAL', 'SCHEDULED', 'STARTUP'))
);
CREATE INDEX idx_sync_jobs_started ON google_sync_jobs (started_at DESC);
CREATE INDEX idx_sync_jobs_status ON google_sync_jobs (status);

-- Validation failures AND conflicts. A conflict is never auto-resolved (SRS §8, ADR-007):
-- it is recorded with both values and surfaced to an administrator.
CREATE TABLE google_sync_errors (
  id             BIGSERIAL PRIMARY KEY,
  job_id         BIGINT      NOT NULL REFERENCES google_sync_jobs (id) ON DELETE CASCADE,
  sheet_name     TEXT        NOT NULL,
  row_number     INTEGER,
  column_name    TEXT,
  business_key   TEXT,
  severity       TEXT        NOT NULL DEFAULT 'ERROR',   -- ERROR | WARNING | CONFLICT
  error_code     TEXT        NOT NULL DEFAULT 'VALIDATION',
  error_message  TEXT        NOT NULL,
  raw_value      TEXT,
  existing_value JSONB,
  incoming_value JSONB,
  resolved_at    TIMESTAMPTZ,
  resolved_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  resolution     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_sync_error_severity CHECK (severity IN ('ERROR', 'WARNING', 'CONFLICT'))
);
CREATE INDEX idx_sync_errors_job ON google_sync_errors (job_id);
CREATE INDEX idx_sync_errors_unresolved ON google_sync_errors (created_at DESC) WHERE resolved_at IS NULL;

-- Declarative sheet → entity mapping with header ALIASES (ADR-006).
-- This is data, not code: the `Cost Center` sheet's mis-named header is absorbed by
-- an alias rather than by a special case somewhere in the sync engine.
CREATE TABLE google_sheet_mappings (
  id            BIGSERIAL PRIMARY KEY,
  sheet_name    TEXT        NOT NULL UNIQUE,
  target_entity TEXT        NOT NULL,
  is_enabled    BOOLEAN     NOT NULL DEFAULT TRUE,
  sync_order    INTEGER     NOT NULL DEFAULT 0,   -- masters first, then transactions
  key_fields    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  column_map    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  notes         TEXT        NOT NULL DEFAULT '',
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Import jobs (SRS §22) ───────────────────────────────────────────────────
CREATE TABLE import_jobs (
  id             BIGSERIAL PRIMARY KEY,
  entity         TEXT        NOT NULL,
  filename       TEXT        NOT NULL DEFAULT '',
  status         TEXT        NOT NULL DEFAULT 'PREVIEW',
  mode           TEXT        NOT NULL DEFAULT 'STRICT',  -- STRICT = all-or-nothing | PARTIAL
  total_rows     INTEGER     NOT NULL DEFAULT 0,
  valid_rows     INTEGER     NOT NULL DEFAULT 0,
  invalid_rows   INTEGER     NOT NULL DEFAULT 0,
  inserted_rows  INTEGER     NOT NULL DEFAULT 0,
  updated_rows   INTEGER     NOT NULL DEFAULT 0,
  message        TEXT,
  actor_user_id  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  committed_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ,
  CONSTRAINT chk_import_status CHECK (status IN
    ('PREVIEW', 'COMMITTING', 'COMMITTED', 'FAILED', 'CANCELLED', 'EXPIRED')),
  CONSTRAINT chk_import_mode CHECK (mode IN ('STRICT', 'PARTIAL'))
);
CREATE INDEX idx_import_jobs_created ON import_jobs (created_at DESC);
CREATE INDEX idx_import_jobs_actor ON import_jobs (actor_user_id);

CREATE TABLE import_rows (
  id          BIGSERIAL PRIMARY KEY,
  job_id      BIGINT      NOT NULL REFERENCES import_jobs (id) ON DELETE CASCADE,
  row_number  INTEGER     NOT NULL,
  status      TEXT        NOT NULL DEFAULT 'VALID',   -- VALID | INVALID | IMPORTED | SKIPPED
  action      TEXT,                                    -- INSERT | UPDATE
  raw_data    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  parsed_data JSONB,
  errors      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT uq_import_row UNIQUE (job_id, row_number),
  CONSTRAINT chk_import_row_status CHECK (status IN ('VALID', 'INVALID', 'IMPORTED', 'SKIPPED'))
);
CREATE INDEX idx_import_rows_job ON import_rows (job_id, row_number);

-- ── Backup metadata (SRS §23, ADR-011) ──────────────────────────────────────
-- Backup FILES live outside the repository under $ZOLEX_DATA_ROOT/backups.
CREATE TABLE backup_metadata (
  id              BIGSERIAL PRIMARY KEY,
  filename        TEXT        NOT NULL UNIQUE,
  file_path       TEXT        NOT NULL,
  kind            TEXT        NOT NULL DEFAULT 'MANUAL',  -- MANUAL | SCHEDULED
  status          TEXT        NOT NULL DEFAULT 'CREATED',
  size_bytes      BIGINT      NOT NULL DEFAULT 0,
  checksum_sha256 TEXT        NOT NULL DEFAULT '',
  table_counts    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  schema_version  TEXT        NOT NULL DEFAULT '',
  notes           TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  verified_at     TIMESTAMPTZ,
  restored_at     TIMESTAMPTZ,
  restored_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT chk_backup_kind CHECK (kind IN ('MANUAL', 'SCHEDULED')),
  CONSTRAINT chk_backup_status CHECK (status IN ('CREATED', 'VERIFIED', 'CORRUPT', 'DELETED'))
);
CREATE INDEX idx_backup_created ON backup_metadata (created_at DESC);
