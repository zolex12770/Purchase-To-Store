-- ============================================================================
-- ZOLEX Purchase-to-Store ERP — MySQL-compatible canonical schema
--
-- This is a hand-translated, MySQL 8.0-compatible mirror of the application's
-- real schema, whose SOURCE OF TRUTH remains the PostgreSQL migrations at
-- backend/src/db/migrations/001_core.sql … 007_sheet_set_b.sql. This file
-- exists so the live business data can be opened, browsed and queried in
-- MySQL Workbench (or any MySQL/MariaDB server) without redesigning the ERP's
-- relational model.
--
-- USAGE (MySQL Workbench):
--   1. Create an empty schema, e.g.  CREATE DATABASE zolex_erp
--      DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_0900_ai_ci;
--   2. Open this file, select the `zolex_erp` schema, execute it top-to-bottom
--      (it is dependency-ordered — every FOREIGN KEY target already exists by
--      the time it is referenced).
--   3. Open the newest DATABASE/SQL/zolex_data_*.sql file and execute it — it
--      contains only INSERT statements built from the CURRENT REAL data in the
--      live application database (never sample/demo rows — see that file's
--      own header for the export timestamp and row counts).
--
-- REQUIRES MySQL 8.0.16+ (for native CHECK constraint enforcement and JSON /
-- functional-index features used below). On MySQL 5.7 the CHECK constraints
-- are silently accepted but NOT enforced by the server — application-level
-- validation (already present in the Node/Zod layer) is then the only guard,
-- exactly as it already is for PGlite/PostgreSQL edge cases today.
--
-- ── POSTGRES → MYSQL CONVERSION POINTS (documented once, applied throughout) ──
--
--  1. BIGSERIAL PRIMARY KEY        → BIGINT AUTO_INCREMENT PRIMARY KEY
--  2. TIMESTAMPTZ                  → DATETIME(6). MySQL has no timezone-aware
--     storage type equivalent to Postgres TIMESTAMPTZ; the application already
--     reads/writes UTC ISO-8601 strings, so DATETIME(6) storing naive UTC is
--     the faithful equivalent (TIMESTAMP was rejected: it has a year-2038
--     range limit and MySQL auto-updates the first TIMESTAMP column on every
--     UPDATE unless explicitly disabled — a divergent behaviour DATETIME does
--     not have).
--  3. DATE                         → DATE (identical).
--  4. BOOLEAN                      → BOOLEAN (a native alias for TINYINT(1) in
--     MySQL — fully compatible; the data export writes 1 / 0).
--  5. NUMERIC(p,s)                 → DECIMAL(p,s) (identical semantics).
--  6. JSONB                        → JSON (MySQL's native JSON type, 5.7.8+).
--     Postgres-only jsonb operators/indexing (@>, GIN indexes) have no
--     equivalent here; every jsonb column in this schema is read/written
--     wholesale by the application, never queried by jsonb operators, so
--     nothing functional is lost.
--  7. Free-text columns with a NOT NULL DEFAULT '' (remarks, notes, address,
--     item_specification, etc.) → VARCHAR(n) rather than TEXT, because MySQL
--     versions before 8.0.13 cannot give a TEXT/BLOB column a literal DEFAULT.
--     Genuinely unbounded, rarely-defaulted fields (rejection_reason,
--     close_reason, cancel_reason, error/resolution messages) stay TEXT.
--  8. Partial / filtered unique indexes (Postgres `WHERE deleted_at IS NULL`,
--     used so a soft-deleted item_code/employee_id/supplier_code/indent_no
--     etc. can be reused) → MySQL has no partial index, so these become plain
--     UNIQUE indexes below. This is STRICTER than the live app: MySQL will
--     reject reusing a code that belongs to a soft-deleted row, where
--     PostgreSQL allows it. If that reuse pattern matters after a migration,
--     enforce it in the application layer instead (check for a live
--     duplicate before insert) rather than relying on the unique index.
--  9. Case-insensitive uniqueness (Postgres functional indexes on lower()/
--     upper()) → not recreated as MySQL functional indexes; MySQL's default
--     collation for this schema (utf8mb4_0900_ai_ci, "ai" = accent
--     insensitive, "ci" = CASE insensitive) already makes a plain unique
--     index behave case-insensitively, so the Postgres behaviour is preserved
--     with less schema, not more.
-- 10. GENERATED ALWAYS AS (...) STORED (purchase_order_lines.final_rate /
--     .amount, grn_lines.amount) → MySQL 5.7.6+ supports the identical
--     GENERATED ALWAYS AS (...) STORED syntax; the ROUND()/arithmetic
--     expressions below are byte-for-byte the same as the Postgres source.
--     IMPORTANT: like Postgres, MySQL computes these columns itself — never
--     supply them in an INSERT. The paired data-export file already omits
--     them (see backend/src/db/restore.ts GENERATED_COLUMNS).
-- 11. now()                        → CURRENT_TIMESTAMP(6).
-- 12. Reserved word `key`          → app_settings.key is backtick-quoted
--     throughout (`key` is reserved in MySQL, is not in Postgres).
-- 13. ENGINE=InnoDB is stated explicitly on every table — InnoDB is required
--     for foreign keys and transactions; without it these constraints are
--     silently ignored by MySQL's MyISAM engine.
--
-- ── FUTURE MICROSOFT SQL SERVER MIGRATION (documented, not implemented here) ──
--   • BIGINT AUTO_INCREMENT / BIGSERIAL → BIGINT IDENTITY(1,1)
--   • DATETIME(6)                       → DATETIME2(6)  (SQL Server DATETIME
--     has ~3ms rounding; DATETIME2 is the correct target)
--   • JSON columns                      → NVARCHAR(MAX) with a CHECK
--     (ISJSON(col) = 1); SQL Server has no native JSON column type, only
--     JSON-shaped text + the ISJSON()/JSON_VALUE()/OPENJSON() functions.
--   • BOOLEAN                           → BIT
--   • GENERATED ALWAYS AS (...) STORED  → computed column: AS (expression)
--     PERSISTED (same idea, different keyword — PERSISTED replaces STORED)
--   • ENGINE=InnoDB / DEFAULT CHARSET=utf8mb4 clauses are dropped entirely;
--     SQL Server has no storage-engine concept and NVARCHAR is UTF-16 natively.
--   • Backtick identifier quoting (`key`) → square brackets ([key]).
--   • CHECK (status IN (...)) constraints port unchanged — SQL Server has
--     supported table CHECK constraints since SQL Server 2008.
--
-- This file does not perform a SQL Server translation — only documents what
-- changes when that migration becomes real work, per the requirement that the
-- schema stay "portable enough... without redesigning the ERP business model."
-- ============================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ── Identity / RBAC ─────────────────────────────────────────────────────────

CREATE TABLE permissions (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(120)  NOT NULL,
  module      VARCHAR(60)   NOT NULL,
  action      VARCHAR(60)   NOT NULL,
  label       VARCHAR(200)  NOT NULL,
  description VARCHAR(500)  NOT NULL DEFAULT '',
  sort_order  INT           NOT NULL DEFAULT 0,
  created_at  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_permissions_code UNIQUE (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_permissions_module ON permissions (module);

CREATE TABLE roles (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  code        VARCHAR(60)   NOT NULL,
  name        VARCHAR(120)  NOT NULL,
  description VARCHAR(500)  NOT NULL DEFAULT '',
  is_system   BOOLEAN       NOT NULL DEFAULT FALSE,
  is_active   BOOLEAN       NOT NULL DEFAULT TRUE,
  created_at  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  DATETIME(6)   NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  -- No FK on created_by/updated_by here — the Postgres source declares none
  -- either (roles is seeded before users can safely reference it).
  created_by  BIGINT NULL,
  updated_by  BIGINT NULL,
  CONSTRAINT uq_roles_code UNIQUE (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE role_permissions (
  role_id       BIGINT NOT NULL,
  permission_id BIGINT NOT NULL,
  granted_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (role_id, permission_id),
  CONSTRAINT fk_role_permissions_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE,
  CONSTRAINT fk_role_permissions_permission FOREIGN KEY (permission_id) REFERENCES permissions (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_role_permissions_permission ON role_permissions (permission_id);

CREATE TABLE users (
  id                   BIGINT AUTO_INCREMENT PRIMARY KEY,
  employee_id          VARCHAR(60)   NOT NULL,
  employee_name        VARCHAR(200)  NOT NULL,
  designation          VARCHAR(120)  NOT NULL DEFAULT '',
  email                VARCHAR(200)  NULL,
  mobile_no            VARCHAR(30)   NULL,
  department_id        BIGINT NULL,  -- FK to lookups added below, after lookups exists
  password_hash        VARCHAR(255)  NOT NULL,
  is_active             BOOLEAN      NOT NULL DEFAULT TRUE,
  must_change_password  BOOLEAN      NOT NULL DEFAULT FALSE,
  failed_login_count    INT          NOT NULL DEFAULT 0,
  locked_until          DATETIME(6)  NULL,
  last_login_at         DATETIME(6)  NULL,
  password_changed_at   DATETIME(6)  NULL,
  created_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at            DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BIGINT NULL,
  updated_by            BIGINT NULL,
  deleted_at             DATETIME(6) NULL,
  seed_tag               VARCHAR(20) NULL,  -- NULL=real, 'demo'|'test'|'import' (data-classification, migration 006)
  CONSTRAINT chk_users_employee_id CHECK (CHAR_LENGTH(TRIM(employee_id)) > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- See conversion point #8: stricter than Postgres (blocks employee_id reuse after soft-delete).
CREATE UNIQUE INDEX uq_users_employee_id ON users (employee_id);
CREATE INDEX idx_users_active ON users (is_active);
CREATE INDEX idx_users_name ON users (employee_name);
CREATE INDEX idx_users_department ON users (department_id);
CREATE INDEX ix_users_seed_tag ON users (seed_tag);

CREATE TABLE user_roles (
  user_id     BIGINT NOT NULL,
  role_id     BIGINT NOT NULL,
  assigned_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  assigned_by BIGINT NULL,
  PRIMARY KEY (user_id, role_id),
  CONSTRAINT fk_user_roles_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT fk_user_roles_role FOREIGN KEY (role_id) REFERENCES roles (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_user_roles_role ON user_roles (role_id);

-- Session/refresh-token store. Included for schema completeness only — this
-- table is intentionally EXCLUDED from the data export (see zolex_data_*.sql
-- header): a refresh token is only meaningful to the server process that
-- issued it, and carrying live session hashes into an offline archive would
-- be a needless security exposure with zero recovery value.
CREATE TABLE user_sessions (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  user_id            BIGINT NOT NULL,
  refresh_token_hash VARCHAR(255) NOT NULL,
  issued_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  expires_at         DATETIME(6) NOT NULL,
  revoked_at         DATETIME(6) NULL,
  ip_address         VARCHAR(64) NULL,
  user_agent         VARCHAR(500) NULL,
  CONSTRAINT uq_user_sessions_refresh_hash UNIQUE (refresh_token_hash),
  CONSTRAINT fk_user_sessions_user FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_user_sessions_user ON user_sessions (user_id);
CREATE INDEX idx_user_sessions_expiry ON user_sessions (expires_at);

CREATE TABLE audit_logs (
  id                BIGINT AUTO_INCREMENT PRIMARY KEY,
  actor_user_id     BIGINT NULL,
  actor_employee_id VARCHAR(60)  NULL,
  actor_name        VARCHAR(200) NULL,
  action            VARCHAR(60)  NOT NULL,
  entity            VARCHAR(60)  NOT NULL,
  entity_id         VARCHAR(60)  NULL,
  entity_label      VARCHAR(255) NULL,
  before_data       JSON NULL,
  after_data        JSON NULL,
  source            VARCHAR(30)  NOT NULL DEFAULT 'API',
  result            VARCHAR(30)  NOT NULL DEFAULT 'SUCCESS',
  message           TEXT NULL,
  ip_address        VARCHAR(64)  NULL,
  user_agent        VARCHAR(500) NULL,
  request_id        VARCHAR(100) NULL,
  created_at        DATETIME(6)  NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT fk_audit_logs_user FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_audit_created ON audit_logs (created_at DESC);
CREATE INDEX idx_audit_entity ON audit_logs (entity, entity_id);
CREATE INDEX idx_audit_actor ON audit_logs (actor_user_id, created_at DESC);
CREATE INDEX idx_audit_action ON audit_logs (action);

CREATE TABLE app_settings (
  `key`       VARCHAR(120) PRIMARY KEY,   -- reserved word — see conversion point #12
  value       JSON NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  updated_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_by  BIGINT NULL,
  CONSTRAINT fk_app_settings_user FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE document_sequences (
  doc_type   VARCHAR(30) NOT NULL,
  period_key VARCHAR(20) NOT NULL,
  prefix     VARCHAR(20) NOT NULL,
  padding    INT NOT NULL DEFAULT 4,
  next_value INT NOT NULL DEFAULT 1,
  updated_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (doc_type, period_key),
  CONSTRAINT chk_seq_padding CHECK (padding BETWEEN 1 AND 10),
  CONSTRAINT chk_seq_next CHECK (next_value >= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Migration-tool bookkeeping (backend/src/db/migrate.ts). Not business data —
-- excluded from the data export for the same reason user_sessions is.
CREATE TABLE schema_migrations (
  version     VARCHAR(20) PRIMARY KEY,
  checksum    VARCHAR(64) NOT NULL,
  applied_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  duration_ms INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ── Masters ─────────────────────────────────────────────────────────────────

CREATE TABLE lookups (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  category    VARCHAR(30)  NOT NULL,
  code        VARCHAR(60)  NOT NULL,
  name        VARCHAR(200) NOT NULL,
  description VARCHAR(500) NOT NULL DEFAULT '',
  parent_id   BIGINT NULL,
  sort_order  INT NOT NULL DEFAULT 0,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN NOT NULL DEFAULT FALSE,
  extra       JSON NOT NULL DEFAULT (JSON_OBJECT()),
  created_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at  DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by  BIGINT NULL,
  updated_by  BIGINT NULL,
  deleted_at  DATETIME(6) NULL,
  seed_tag    VARCHAR(20) NULL,
  CONSTRAINT chk_lookups_category CHECK (category IN (
    'DEPARTMENT','COST_CENTRE','ITEM_TYPE','MAIN_GROUP','SUB_MAIN_GROUP',
    'UOM','INDENT_TYPE','PO_TYPE','CURRENCY','PAYMENT_TERMS'
  )),
  CONSTRAINT chk_lookups_name CHECK (CHAR_LENGTH(TRIM(name)) > 0),
  CONSTRAINT chk_lookups_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT fk_lookups_parent FOREIGN KEY (parent_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_lookups_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_lookups_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- See conversion points #8 and #9.
CREATE UNIQUE INDEX uq_lookups_category_code ON lookups (category, code);
CREATE UNIQUE INDEX uq_lookups_category_name ON lookups (category, name);
CREATE INDEX idx_lookups_category_active ON lookups (category, is_active);
CREATE INDEX idx_lookups_parent ON lookups (parent_id);
CREATE INDEX ix_lookups_seed_tag ON lookups (seed_tag);

-- users.department_id → lookups, declared now that lookups exists (mirrors
-- the Postgres source, which adds this same FK in migration 002 for the
-- identical reason).
ALTER TABLE users
  ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES lookups (id) ON DELETE SET NULL;

CREATE TABLE suppliers (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  supplier_code  VARCHAR(30)  NOT NULL,
  supplier_name  VARCHAR(200) NOT NULL,
  address        VARCHAR(500) NOT NULL DEFAULT '',
  state          VARCHAR(100) NOT NULL DEFAULT '',
  city           VARCHAR(100) NOT NULL DEFAULT '',
  country        VARCHAR(100) NOT NULL DEFAULT 'India',
  mobile_no      VARCHAR(30)  NOT NULL DEFAULT '',
  email          VARCHAR(200) NOT NULL DEFAULT '',
  gst_no         VARCHAR(30)  NOT NULL DEFAULT '',
  payment_terms  VARCHAR(120) NOT NULL DEFAULT '',
  currency_code  VARCHAR(10)  NOT NULL DEFAULT 'INR',
  contact_person VARCHAR(200) NOT NULL DEFAULT '',
  notes          VARCHAR(500) NOT NULL DEFAULT '',
  pin_code       VARCHAR(20)  NOT NULL DEFAULT '',
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by     BIGINT NULL,
  updated_by     BIGINT NULL,
  deleted_at     DATETIME(6) NULL,
  seed_tag       VARCHAR(20) NULL,
  CONSTRAINT chk_suppliers_name CHECK (CHAR_LENGTH(TRIM(supplier_name)) > 0),
  CONSTRAINT fk_suppliers_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_suppliers_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX uq_suppliers_code ON suppliers (supplier_code);
CREATE UNIQUE INDEX uq_suppliers_name ON suppliers (supplier_name);
CREATE INDEX idx_suppliers_active ON suppliers (is_active);
CREATE INDEX idx_suppliers_state ON suppliers (state);
CREATE INDEX idx_suppliers_city ON suppliers (city);
CREATE INDEX ix_suppliers_seed_tag ON suppliers (seed_tag);

CREATE TABLE items (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  item_code          VARCHAR(60)  NOT NULL,
  item_description   VARCHAR(500) NOT NULL,
  item_type_id       BIGINT NULL,
  department_id      BIGINT NULL,
  cost_centre_id     BIGINT NULL,
  main_group_id      BIGINT NULL,
  sub_main_group_id  BIGINT NULL,
  indent_type_id     BIGINT NULL,
  uom_id             BIGINT NULL,
  hsn_code           VARCHAR(30)  NOT NULL DEFAULT '',
  item_specification VARCHAR(500) NOT NULL DEFAULT '',
  standard_rate      DECIMAL(18,4) NULL,
  reorder_level      DECIMAL(18,4) NULL,
  min_stock          DECIMAL(18,4) NULL,
  max_stock          DECIMAL(18,4) NULL,
  reorder_qty        DECIMAL(18,4) NULL,
  gst_rate           DECIMAL(6,2)  NULL,
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  source_date        DATE NULL,
  source_time        VARCHAR(20) NOT NULL DEFAULT '',
  created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by         BIGINT NULL,
  updated_by         BIGINT NULL,
  deleted_at         DATETIME(6) NULL,
  seed_tag           VARCHAR(20) NULL,
  CONSTRAINT chk_items_code CHECK (CHAR_LENGTH(TRIM(item_code)) > 0),
  CONSTRAINT chk_items_desc CHECK (CHAR_LENGTH(TRIM(item_description)) > 0),
  CONSTRAINT chk_items_rate CHECK (standard_rate IS NULL OR standard_rate >= 0),
  CONSTRAINT chk_items_min_stock CHECK (min_stock IS NULL OR min_stock >= 0),
  CONSTRAINT chk_items_max_stock CHECK (max_stock IS NULL OR max_stock >= 0),
  CONSTRAINT chk_items_reorder_qty CHECK (reorder_qty IS NULL OR reorder_qty >= 0),
  CONSTRAINT chk_items_gst_rate CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100)),
  CONSTRAINT fk_items_item_type FOREIGN KEY (item_type_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_department FOREIGN KEY (department_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_cost_centre FOREIGN KEY (cost_centre_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_main_group FOREIGN KEY (main_group_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_sub_group FOREIGN KEY (sub_main_group_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_indent_type FOREIGN KEY (indent_type_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_uom FOREIGN KEY (uom_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_items_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_items_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE UNIQUE INDEX uq_items_code ON items (item_code);
CREATE INDEX idx_items_active ON items (is_active);
CREATE INDEX idx_items_department ON items (department_id);
CREATE INDEX idx_items_cost_centre ON items (cost_centre_id);
CREATE INDEX idx_items_main_group ON items (main_group_id);
CREATE INDEX idx_items_sub_group ON items (sub_main_group_id);
CREATE INDEX idx_items_type ON items (item_type_id);
CREATE INDEX idx_items_desc ON items (item_description);
CREATE INDEX idx_items_hsn ON items (hsn_code);
CREATE INDEX ix_items_seed_tag ON items (seed_tag);

-- ── Transactions: Purchase Indent ───────────────────────────────────────────

CREATE TABLE purchase_indent_headers (
  id                    BIGINT AUTO_INCREMENT PRIMARY KEY,
  indent_no             VARCHAR(40) NOT NULL,
  indent_date           DATE NOT NULL,
  indent_time           VARCHAR(20) NOT NULL DEFAULT '',
  indent_type_id        BIGINT NULL,
  department_id         BIGINT NULL,
  cost_centre_id        BIGINT NULL,
  suggested_supplier_id BIGINT NULL,
  requested_by_user_id  BIGINT NULL,
  required_by_date      DATE NULL,
  remarks               VARCHAR(1000) NOT NULL DEFAULT '',
  status                VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  submitted_at          DATETIME(6) NULL,
  submitted_by          BIGINT NULL,
  approved_at           DATETIME(6) NULL,
  approved_by           BIGINT NULL,
  rejected_at           DATETIME(6) NULL,
  rejected_by           BIGINT NULL,
  rejection_reason      TEXT NULL,
  closed_at             DATETIME(6) NULL,
  closed_by             BIGINT NULL,
  close_reason          TEXT NULL,
  created_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at            DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by            BIGINT NULL,
  updated_by            BIGINT NULL,
  seed_tag              VARCHAR(20) NULL,
  CONSTRAINT uq_indent_no UNIQUE (indent_no),
  CONSTRAINT chk_indent_status CHECK (status IN ('DRAFT','PENDING_APPROVAL','APPROVED','REJECTED','CANCELLED','CLOSED')),
  CONSTRAINT chk_indent_rejection_reason CHECK (status <> 'REJECTED' OR (rejection_reason IS NOT NULL AND CHAR_LENGTH(TRIM(rejection_reason)) > 0)),
  CONSTRAINT fk_indent_type FOREIGN KEY (indent_type_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_dept FOREIGN KEY (department_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_cost_centre FOREIGN KEY (cost_centre_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_supplier FOREIGN KEY (suggested_supplier_id) REFERENCES suppliers (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_requester FOREIGN KEY (requested_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_submitted_by FOREIGN KEY (submitted_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_approved_by FOREIGN KEY (approved_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_rejected_by FOREIGN KEY (rejected_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_closed_by FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_indent_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_indent_status ON purchase_indent_headers (status);
CREATE INDEX idx_indent_date ON purchase_indent_headers (indent_date DESC);
CREATE INDEX idx_indent_dept ON purchase_indent_headers (department_id);
CREATE INDEX idx_indent_cost_centre ON purchase_indent_headers (cost_centre_id);
CREATE INDEX idx_indent_type ON purchase_indent_headers (indent_type_id);
CREATE INDEX idx_indent_requester ON purchase_indent_headers (requested_by_user_id);
CREATE INDEX idx_indent_supplier ON purchase_indent_headers (suggested_supplier_id);
CREATE INDEX idx_indent_status_date ON purchase_indent_headers (status, indent_date DESC);
CREATE INDEX ix_indent_seed_tag ON purchase_indent_headers (seed_tag);

CREATE TABLE purchase_indent_lines (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  indent_id          BIGINT NOT NULL,
  line_no            INT NOT NULL,
  item_id            BIGINT NOT NULL,
  item_code          VARCHAR(60)  NOT NULL,
  item_description   VARCHAR(500) NOT NULL,
  indent_qty         DECIMAL(18,4) NOT NULL,
  uom_id             BIGINT NULL,
  item_specification VARCHAR(500) NOT NULL DEFAULT '',
  department_id      BIGINT NULL,
  cost_centre_id     BIGINT NULL,
  estimated_rate     DECIMAL(18,4) NULL,
  required_by_date   DATE NULL,
  remarks            VARCHAR(1000) NOT NULL DEFAULT '',
  is_closed          BOOLEAN NOT NULL DEFAULT FALSE,
  closed_reason      TEXT NULL,
  created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no),
  CONSTRAINT chk_indent_qty CHECK (indent_qty > 0),
  CONSTRAINT chk_indent_est_rate CHECK (estimated_rate IS NULL OR estimated_rate >= 0),
  CONSTRAINT fk_indent_lines_header FOREIGN KEY (indent_id) REFERENCES purchase_indent_headers (id) ON DELETE CASCADE,
  CONSTRAINT fk_indent_lines_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_lines_uom FOREIGN KEY (uom_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_lines_dept FOREIGN KEY (department_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_indent_lines_cost_centre FOREIGN KEY (cost_centre_id) REFERENCES lookups (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_indent_lines_indent ON purchase_indent_lines (indent_id);
CREATE INDEX idx_indent_lines_item ON purchase_indent_lines (item_id);
CREATE INDEX idx_indent_lines_open ON purchase_indent_lines (is_closed);

CREATE TABLE indent_approvals (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  indent_id     BIGINT NOT NULL,
  level         INT NOT NULL DEFAULT 1,
  action        VARCHAR(20) NOT NULL,
  actor_user_id BIGINT NULL,
  reason        TEXT NULL,
  from_status   VARCHAR(30) NULL,
  to_status     VARCHAR(30) NULL,
  created_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_indent_approval_action CHECK (action IN ('SUBMIT','APPROVE','REJECT','CANCEL','REOPEN','CLOSE')),
  CONSTRAINT fk_indent_approvals_header FOREIGN KEY (indent_id) REFERENCES purchase_indent_headers (id) ON DELETE CASCADE,
  CONSTRAINT fk_indent_approvals_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_indent_approvals_indent ON indent_approvals (indent_id, created_at DESC);

-- ── Transactions: Purchase Order ────────────────────────────────────────────

CREATE TABLE purchase_order_headers (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  po_no            VARCHAR(40) NOT NULL,
  po_date          DATE NOT NULL,
  po_time          VARCHAR(20) NOT NULL DEFAULT '',
  po_type_id       BIGINT NULL,
  supplier_id      BIGINT NOT NULL,
  currency_code    VARCHAR(10) NOT NULL DEFAULT 'INR',
  payment_terms    VARCHAR(120) NOT NULL DEFAULT '',
  delivery_date    DATE NULL,
  delivery_address VARCHAR(500) NOT NULL DEFAULT '',
  remarks          VARCHAR(1000) NOT NULL DEFAULT '',
  source_mode      VARCHAR(20) NOT NULL DEFAULT 'DIRECT',
  status           VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  issued_at        DATETIME(6) NULL,
  issued_by        BIGINT NULL,
  closed_at        DATETIME(6) NULL,
  closed_by        BIGINT NULL,
  close_reason     TEXT NULL,
  created_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by       BIGINT NULL,
  updated_by       BIGINT NULL,
  seed_tag         VARCHAR(20) NULL,
  CONSTRAINT uq_po_no UNIQUE (po_no),
  CONSTRAINT chk_po_source_mode CHECK (source_mode IN ('DIRECT','INDENT')),
  CONSTRAINT chk_po_status CHECK (status IN ('DRAFT','OPEN','PARTIALLY_RECEIVED','COMPLETED','SHORT_CLOSED','CANCELLED')),
  CONSTRAINT chk_po_close_reason CHECK (status <> 'SHORT_CLOSED' OR (close_reason IS NOT NULL AND CHAR_LENGTH(TRIM(close_reason)) > 0)),
  CONSTRAINT fk_po_type FOREIGN KEY (po_type_id) REFERENCES lookups (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_issued_by FOREIGN KEY (issued_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_po_closed_by FOREIGN KEY (closed_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_po_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_po_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_po_status ON purchase_order_headers (status);
CREATE INDEX idx_po_date ON purchase_order_headers (po_date DESC);
CREATE INDEX idx_po_supplier ON purchase_order_headers (supplier_id);
CREATE INDEX idx_po_type ON purchase_order_headers (po_type_id);
CREATE INDEX idx_po_status_date ON purchase_order_headers (status, po_date DESC);
CREATE INDEX idx_po_supplier_date ON purchase_order_headers (supplier_id, po_date DESC);
CREATE INDEX ix_po_seed_tag ON purchase_order_headers (seed_tag);

CREATE TABLE purchase_order_lines (
  id                 BIGINT AUTO_INCREMENT PRIMARY KEY,
  po_id              BIGINT NOT NULL,
  line_no            INT NOT NULL,
  item_id            BIGINT NOT NULL,
  item_code          VARCHAR(60)  NOT NULL,
  item_description   VARCHAR(500) NOT NULL,
  po_qty             DECIMAL(18,4) NOT NULL,
  uom_id             BIGINT NULL,
  rate               DECIMAL(18,4) NOT NULL,
  discount_pct       DECIMAL(9,4)  NOT NULL DEFAULT 0,
  -- Database-computed, never inserted directly — see conversion point #10.
  final_rate         DECIMAL(18,4) GENERATED ALWAYS AS (ROUND(rate * (1 - discount_pct / 100), 4)) STORED,
  amount             DECIMAL(18,2) GENERATED ALWAYS AS (ROUND(po_qty * ROUND(rate * (1 - discount_pct / 100), 4), 2)) STORED,
  item_specification VARCHAR(500) NOT NULL DEFAULT '',
  delivery_date      DATE NULL,
  remarks            VARCHAR(1000) NOT NULL DEFAULT '',
  is_closed          BOOLEAN NOT NULL DEFAULT FALSE,
  closed_reason      TEXT NULL,
  created_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at         DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no),
  CONSTRAINT chk_po_qty CHECK (po_qty > 0),
  CONSTRAINT chk_po_rate CHECK (rate >= 0),
  CONSTRAINT chk_po_discount CHECK (discount_pct >= 0 AND discount_pct <= 100),
  CONSTRAINT fk_po_lines_header FOREIGN KEY (po_id) REFERENCES purchase_order_headers (id) ON DELETE CASCADE,
  CONSTRAINT fk_po_lines_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_lines_uom FOREIGN KEY (uom_id) REFERENCES lookups (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);
CREATE INDEX idx_po_lines_item ON purchase_order_lines (item_id);
CREATE INDEX idx_po_lines_open ON purchase_order_lines (is_closed);

CREATE TABLE po_indent_sources (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  po_line_id     BIGINT NOT NULL,
  indent_line_id BIGINT NOT NULL,
  indent_id      BIGINT NOT NULL,
  consumed_qty   DECIMAL(18,4) NOT NULL,
  created_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_po_source UNIQUE (po_line_id, indent_line_id),
  CONSTRAINT chk_po_source_qty CHECK (consumed_qty > 0),
  CONSTRAINT fk_po_sources_line FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines (id) ON DELETE CASCADE,
  CONSTRAINT fk_po_sources_indent_line FOREIGN KEY (indent_line_id) REFERENCES purchase_indent_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_po_sources_indent FOREIGN KEY (indent_id) REFERENCES purchase_indent_headers (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_po_sources_indent_line ON po_indent_sources (indent_line_id);
CREATE INDEX idx_po_sources_indent ON po_indent_sources (indent_id);
CREATE INDEX idx_po_sources_po_line ON po_indent_sources (po_line_id);

-- ── Transactions: GRN ───────────────────────────────────────────────────────

CREATE TABLE grn_headers (
  id                  BIGINT AUTO_INCREMENT PRIMARY KEY,
  grn_no              VARCHAR(40) NOT NULL,
  grn_date            DATE NOT NULL,
  grn_time            VARCHAR(20) NOT NULL DEFAULT '',
  po_id               BIGINT NOT NULL,
  supplier_id         BIGINT NOT NULL,
  challan_no          VARCHAR(60) NOT NULL DEFAULT '',
  challan_date        DATE NULL,
  vehicle_no          VARCHAR(30) NOT NULL DEFAULT '',
  received_by_user_id BIGINT NULL,
  remarks             VARCHAR(1000) NOT NULL DEFAULT '',
  status              VARCHAR(30) NOT NULL DEFAULT 'DRAFT',
  posted_at           DATETIME(6) NULL,
  posted_by           BIGINT NULL,
  cancelled_at        DATETIME(6) NULL,
  cancelled_by        BIGINT NULL,
  cancel_reason       TEXT NULL,
  created_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at          DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by          BIGINT NULL,
  updated_by          BIGINT NULL,
  seed_tag            VARCHAR(20) NULL,
  CONSTRAINT uq_grn_no UNIQUE (grn_no),
  CONSTRAINT chk_grn_status CHECK (status IN ('DRAFT','POSTED','CANCELLED')),
  CONSTRAINT chk_grn_cancel_reason CHECK (status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND CHAR_LENGTH(TRIM(cancel_reason)) > 0)),
  CONSTRAINT fk_grn_po FOREIGN KEY (po_id) REFERENCES purchase_order_headers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_supplier FOREIGN KEY (supplier_id) REFERENCES suppliers (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_received_by FOREIGN KEY (received_by_user_id) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_grn_posted_by FOREIGN KEY (posted_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_grn_cancelled_by FOREIGN KEY (cancelled_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_grn_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_grn_updated_by FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_grn_status ON grn_headers (status);
CREATE INDEX idx_grn_date ON grn_headers (grn_date DESC);
CREATE INDEX idx_grn_po ON grn_headers (po_id);
CREATE INDEX idx_grn_supplier ON grn_headers (supplier_id);
CREATE INDEX idx_grn_status_date ON grn_headers (status, grn_date DESC);
CREATE INDEX ix_grn_seed_tag ON grn_headers (seed_tag);

CREATE TABLE grn_lines (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  grn_id           BIGINT NOT NULL,
  line_no          INT NOT NULL,
  po_line_id       BIGINT NOT NULL,
  item_id          BIGINT NOT NULL,
  item_code        VARCHAR(60)  NOT NULL,
  item_description VARCHAR(500) NOT NULL,
  grn_qty          DECIMAL(18,4) NOT NULL,
  uom_id           BIGINT NULL,
  rate             DECIMAL(18,4) NOT NULL DEFAULT 0,
  -- Database-computed, never inserted directly — see conversion point #10.
  amount           DECIMAL(18,2) GENERATED ALWAYS AS (ROUND(grn_qty * rate, 2)) STORED,
  accepted_qty     DECIMAL(18,4) NULL,
  rejected_qty     DECIMAL(18,4) NULL,
  receipt_location VARCHAR(200) NOT NULL DEFAULT '',
  remarks          VARCHAR(1000) NOT NULL DEFAULT '',
  created_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  updated_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_grn_line_no UNIQUE (grn_id, line_no),
  CONSTRAINT chk_grn_qty CHECK (grn_qty > 0),
  CONSTRAINT chk_grn_rate CHECK (rate >= 0),
  CONSTRAINT chk_grn_accepted_rejected CHECK (accepted_qty IS NULL OR rejected_qty IS NULL OR ROUND(accepted_qty + rejected_qty, 4) = ROUND(grn_qty, 4)),
  CONSTRAINT chk_grn_accepted_nonneg CHECK (accepted_qty IS NULL OR accepted_qty >= 0),
  CONSTRAINT chk_grn_rejected_nonneg CHECK (rejected_qty IS NULL OR rejected_qty >= 0),
  CONSTRAINT fk_grn_lines_header FOREIGN KEY (grn_id) REFERENCES grn_headers (id) ON DELETE CASCADE,
  CONSTRAINT fk_grn_lines_po_line FOREIGN KEY (po_line_id) REFERENCES purchase_order_lines (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_lines_item FOREIGN KEY (item_id) REFERENCES items (id) ON DELETE RESTRICT,
  CONSTRAINT fk_grn_lines_uom FOREIGN KEY (uom_id) REFERENCES lookups (id) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_grn_lines_grn ON grn_lines (grn_id);
CREATE INDEX idx_grn_lines_po_line ON grn_lines (po_line_id);
CREATE INDEX idx_grn_lines_item ON grn_lines (item_id);

-- ── Operations: Google Sheets sync, bulk import, backup metadata ───────────

CREATE TABLE google_sync_jobs (
  id               BIGINT AUTO_INCREMENT PRIMARY KEY,
  status           VARCHAR(20) NOT NULL DEFAULT 'RUNNING',
  trigger_source   VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  sheet_id         VARCHAR(200) NOT NULL DEFAULT '',
  started_at       DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  finished_at      DATETIME(6) NULL,
  duration_ms      INT NULL,
  sheets_processed INT NOT NULL DEFAULT 0,
  rows_read        INT NOT NULL DEFAULT 0,
  rows_inserted    INT NOT NULL DEFAULT 0,
  rows_updated     INT NOT NULL DEFAULT 0,
  rows_skipped     INT NOT NULL DEFAULT 0,
  rows_rejected    INT NOT NULL DEFAULT 0,
  conflicts        INT NOT NULL DEFAULT 0,
  message          TEXT NULL,
  detail           JSON NOT NULL DEFAULT (JSON_OBJECT()),
  actor_user_id    BIGINT NULL,
  CONSTRAINT chk_sync_status CHECK (status IN ('RUNNING','SUCCESS','PARTIAL','FAILED','CANCELLED')),
  CONSTRAINT chk_sync_trigger CHECK (trigger_source IN ('MANUAL','SCHEDULED','STARTUP')),
  CONSTRAINT fk_sync_jobs_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_sync_jobs_started ON google_sync_jobs (started_at DESC);
CREATE INDEX idx_sync_jobs_status ON google_sync_jobs (status);

CREATE TABLE google_sync_errors (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_id         BIGINT NOT NULL,
  sheet_name     VARCHAR(120) NOT NULL,
  row_number     INT NULL,
  column_name    VARCHAR(120) NULL,
  business_key   VARCHAR(200) NULL,
  severity       VARCHAR(20) NOT NULL DEFAULT 'ERROR',
  error_code     VARCHAR(60)  NOT NULL DEFAULT 'VALIDATION',
  error_message  VARCHAR(1000) NOT NULL,
  raw_value      VARCHAR(500) NULL,
  existing_value JSON NULL,
  incoming_value JSON NULL,
  resolved_at    DATETIME(6) NULL,
  resolved_by    BIGINT NULL,
  resolution     TEXT NULL,
  created_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT chk_sync_error_severity CHECK (severity IN ('ERROR','WARNING','CONFLICT')),
  CONSTRAINT fk_sync_errors_job FOREIGN KEY (job_id) REFERENCES google_sync_jobs (id) ON DELETE CASCADE,
  CONSTRAINT fk_sync_errors_resolved_by FOREIGN KEY (resolved_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_sync_errors_job ON google_sync_errors (job_id);
CREATE INDEX idx_sync_errors_unresolved ON google_sync_errors (created_at DESC);

CREATE TABLE google_sheet_mappings (
  id            BIGINT AUTO_INCREMENT PRIMARY KEY,
  sheet_name    VARCHAR(120) NOT NULL,
  target_entity VARCHAR(60) NOT NULL,
  is_enabled    BOOLEAN NOT NULL DEFAULT TRUE,
  sync_order    INT NOT NULL DEFAULT 0,
  key_fields    JSON NOT NULL DEFAULT (JSON_ARRAY()),
  column_map    JSON NOT NULL DEFAULT (JSON_ARRAY()),
  notes         VARCHAR(500) NOT NULL DEFAULT '',
  updated_at    DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  CONSTRAINT uq_sheet_mappings_name UNIQUE (sheet_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE import_jobs (
  id             BIGINT AUTO_INCREMENT PRIMARY KEY,
  entity         VARCHAR(60) NOT NULL,
  filename       VARCHAR(255) NOT NULL DEFAULT '',
  status         VARCHAR(20) NOT NULL DEFAULT 'PREVIEW',
  mode           VARCHAR(20) NOT NULL DEFAULT 'STRICT',
  total_rows     INT NOT NULL DEFAULT 0,
  valid_rows     INT NOT NULL DEFAULT 0,
  invalid_rows   INT NOT NULL DEFAULT 0,
  inserted_rows  INT NOT NULL DEFAULT 0,
  updated_rows   INT NOT NULL DEFAULT 0,
  message        TEXT NULL,
  actor_user_id  BIGINT NULL,
  created_at     DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  committed_at   DATETIME(6) NULL,
  expires_at     DATETIME(6) NULL,
  CONSTRAINT chk_import_status CHECK (status IN ('PREVIEW','COMMITTING','COMMITTED','FAILED','CANCELLED','EXPIRED')),
  CONSTRAINT chk_import_mode CHECK (mode IN ('STRICT','PARTIAL')),
  CONSTRAINT fk_import_jobs_actor FOREIGN KEY (actor_user_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_import_jobs_created ON import_jobs (created_at DESC);
CREATE INDEX idx_import_jobs_actor ON import_jobs (actor_user_id);

CREATE TABLE import_rows (
  id          BIGINT AUTO_INCREMENT PRIMARY KEY,
  job_id      BIGINT NOT NULL,
  row_number  INT NOT NULL,
  status      VARCHAR(20) NOT NULL DEFAULT 'VALID',
  action      VARCHAR(10) NULL,
  raw_data    JSON NOT NULL DEFAULT (JSON_OBJECT()),
  parsed_data JSON NULL,
  errors      JSON NOT NULL DEFAULT (JSON_ARRAY()),
  CONSTRAINT uq_import_row UNIQUE (job_id, row_number),
  CONSTRAINT chk_import_row_status CHECK (status IN ('VALID','INVALID','IMPORTED','SKIPPED')),
  CONSTRAINT fk_import_rows_job FOREIGN KEY (job_id) REFERENCES import_jobs (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_import_rows_job ON import_rows (job_id, row_number);

CREATE TABLE backup_metadata (
  id              BIGINT AUTO_INCREMENT PRIMARY KEY,
  filename        VARCHAR(255) NOT NULL,
  file_path       VARCHAR(1000) NOT NULL,
  kind            VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
  status          VARCHAR(20) NOT NULL DEFAULT 'CREATED',
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  checksum_sha256 VARCHAR(64) NOT NULL DEFAULT '',
  table_counts    JSON NOT NULL DEFAULT (JSON_OBJECT()),
  schema_version  VARCHAR(20) NOT NULL DEFAULT '',
  notes           VARCHAR(500) NOT NULL DEFAULT '',
  created_at      DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  created_by      BIGINT NULL,
  verified_at     DATETIME(6) NULL,
  restored_at     DATETIME(6) NULL,
  restored_by     BIGINT NULL,
  CONSTRAINT uq_backup_filename UNIQUE (filename),
  CONSTRAINT chk_backup_kind CHECK (kind IN ('MANUAL','SCHEDULED')),
  CONSTRAINT chk_backup_status CHECK (status IN ('CREATED','VERIFIED','CORRUPT','DELETED')),
  CONSTRAINT fk_backup_created_by FOREIGN KEY (created_by) REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT fk_backup_restored_by FOREIGN KEY (restored_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE INDEX idx_backup_created ON backup_metadata (created_at DESC);

SET FOREIGN_KEY_CHECKS = 1;

-- ============================================================================
-- End of schema. 27 tables total; 25 carry business/audit data, and
-- user_sessions + schema_migrations are intentionally tool-internal (see their
-- comments above) and excluded from the paired data export.
-- ============================================================================
