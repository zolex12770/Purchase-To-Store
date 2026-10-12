-- ============================================================================
-- 001_core — identity, RBAC, sessions, audit, settings, document numbering
-- ZOLEX Purchase-to-Store ERP  |  SRS §5, §6, §18, §19, §24, §25
-- ============================================================================

-- ── Permissions (SRS §18) ───────────────────────────────────────────────────
CREATE TABLE permissions (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,          -- e.g. 'indent.approve'
  module      TEXT        NOT NULL,                 -- e.g. 'indent'
  action      TEXT        NOT NULL,                 -- view|create|edit|delete|approve|reject|export|import|analyze|admin
  label       TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_permissions_module ON permissions (module);

-- ── Roles ───────────────────────────────────────────────────────────────────
CREATE TABLE roles (
  id          BIGSERIAL PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  -- System roles cannot be renamed or deleted; their permissions can still be tuned
  -- except for SUPER_ADMIN which always holds every permission.
  is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT,
  updated_by  BIGINT
);

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission_id BIGINT NOT NULL REFERENCES permissions (id) ON DELETE CASCADE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (role_id, permission_id)
);
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

-- ── Users (SRS §7.3 User Master: Employee ID, Employee Name, Designation) ───
CREATE TABLE users (
  id                    BIGSERIAL PRIMARY KEY,
  employee_id           TEXT        NOT NULL,
  employee_name         TEXT        NOT NULL,
  designation           TEXT        NOT NULL DEFAULT '',
  email                 TEXT,
  mobile_no             TEXT,
  department_id         BIGINT,                       -- FK added in 002 (lookups)
  password_hash         TEXT        NOT NULL,
  is_active             BOOLEAN     NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN     NOT NULL DEFAULT FALSE,
  failed_login_count    INTEGER     NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  last_login_at         TIMESTAMPTZ,
  password_changed_at   TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            BIGINT,
  updated_by            BIGINT,
  deleted_at            TIMESTAMPTZ,                  -- soft delete (SRS §20)
  CONSTRAINT chk_users_employee_id CHECK (length(trim(employee_id)) > 0)
);
-- Employee ID is unique among live users; a soft-deleted record must not block reuse.
CREATE UNIQUE INDEX uq_users_employee_id ON users (employee_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_active ON users (is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_name ON users (lower(employee_name));

CREATE TABLE user_roles (
  user_id     BIGINT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role_id     BIGINT NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_by BIGINT,
  PRIMARY KEY (user_id, role_id)
);
CREATE INDEX idx_user_roles_role ON user_roles (role_id);

-- ── Sessions / refresh tokens (ADR-013) ─────────────────────────────────────
-- The refresh token is stored hashed so a database leak cannot mint sessions.
CREATE TABLE user_sessions (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT      NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  refresh_token_hash TEXT        NOT NULL UNIQUE,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  ip_address         TEXT,
  user_agent         TEXT
);
CREATE INDEX idx_user_sessions_user ON user_sessions (user_id) WHERE revoked_at IS NULL;
CREATE INDEX idx_user_sessions_expiry ON user_sessions (expires_at);

-- ── Audit log (SRS §24) ─────────────────────────────────────────────────────
CREATE TABLE audit_logs (
  id                BIGSERIAL PRIMARY KEY,
  actor_user_id     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  actor_employee_id TEXT,
  actor_name        TEXT,
  action            TEXT        NOT NULL,   -- LOGIN, CREATE, UPDATE, APPROVE, SYNC …
  entity            TEXT        NOT NULL,   -- item, supplier, purchase_indent …
  entity_id         TEXT,
  entity_label      TEXT,                   -- human-readable ("PO-20260824-0003")
  before_data       JSONB,
  after_data        JSONB,
  source            TEXT        NOT NULL DEFAULT 'API',  -- API | GOOGLE_SYNC | IMPORT | SYSTEM
  result            TEXT        NOT NULL DEFAULT 'SUCCESS',
  message           TEXT,
  ip_address        TEXT,
  user_agent        TEXT,
  request_id        TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs (action);

-- ── Application settings (Google sync toggle, defaults, retention) ──────────
CREATE TABLE app_settings (
  key         TEXT PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by  BIGINT REFERENCES users (id) ON DELETE SET NULL
);

-- ── Document numbering (ADR-002) ────────────────────────────────────────────
-- Counters are mutated with FOR UPDATE inside the caller's transaction, and the
-- resulting document numbers additionally carry a UNIQUE constraint on their table,
-- so a race can never mint a duplicate.
CREATE TABLE document_sequences (
  doc_type   TEXT    NOT NULL,             -- INDENT | PO | GRN
  period_key TEXT    NOT NULL,             -- 'YYYYMMDD' (daily reset)
  prefix     TEXT    NOT NULL,
  padding    INTEGER NOT NULL DEFAULT 4,
  next_value INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_type, period_key),
  CONSTRAINT chk_seq_padding CHECK (padding BETWEEN 1 AND 10),
  CONSTRAINT chk_seq_next CHECK (next_value >= 1)
);
