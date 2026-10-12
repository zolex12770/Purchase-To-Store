-- ============================================================================
-- 002_masters — lookups, Supplier Master, Item Master
-- SRS §7 (Master Data), §19, §20, §44  |  ADR-006, ADR-010, ADR-014
-- ============================================================================

-- ── Lookups (ADR-014) ───────────────────────────────────────────────────────
-- One table with a `category` discriminator backs every master-driven dropdown
-- required by the SRS: PO Type, Indent Type, Cost Centre, Department, Item Type,
-- Main Group, Sub Main Group, UOM, Currency, Payment Terms.
--
-- `parent_id` gives Sub Main Group its cascade from Main Group. A single table
-- means one CRUD service, one API shape and one admin screen instead of ten
-- near-identical copies (SRS §54: no duplicate business logic).
CREATE TABLE lookups (
  id          BIGSERIAL PRIMARY KEY,
  category    TEXT        NOT NULL,
  code        TEXT        NOT NULL,
  name        TEXT        NOT NULL,
  description TEXT        NOT NULL DEFAULT '',
  parent_id   BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  sort_order  INTEGER     NOT NULL DEFAULT 0,
  is_active   BOOLEAN     NOT NULL DEFAULT TRUE,
  is_system   BOOLEAN     NOT NULL DEFAULT FALSE,
  extra       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by  BIGINT REFERENCES users (id) ON DELETE SET NULL,
  deleted_at  TIMESTAMPTZ,
  CONSTRAINT chk_lookups_category CHECK (category IN (
    'DEPARTMENT', 'COST_CENTRE', 'ITEM_TYPE', 'MAIN_GROUP', 'SUB_MAIN_GROUP',
    'UOM', 'INDENT_TYPE', 'PO_TYPE', 'CURRENCY', 'PAYMENT_TERMS'
  )),
  CONSTRAINT chk_lookups_name CHECK (length(trim(name)) > 0),
  CONSTRAINT chk_lookups_not_self_parent CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE UNIQUE INDEX uq_lookups_category_code ON lookups (category, upper(code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_lookups_category_name ON lookups (category, lower(name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_lookups_category_active ON lookups (category, is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_lookups_parent ON lookups (parent_id);

-- users.department_id references a DEPARTMENT lookup (declared here now that the table exists)
ALTER TABLE users
  ADD CONSTRAINT fk_users_department FOREIGN KEY (department_id) REFERENCES lookups (id) ON DELETE SET NULL;

-- ── Supplier Master (SRS §7.2) ──────────────────────────────────────────────
CREATE TABLE suppliers (
  id             BIGSERIAL PRIMARY KEY,
  supplier_code  TEXT        NOT NULL,               -- ADR-010: stable key, auto 'SUP-####'
  supplier_name  TEXT        NOT NULL,
  address        TEXT        NOT NULL DEFAULT '',
  state          TEXT        NOT NULL DEFAULT '',
  city           TEXT        NOT NULL DEFAULT '',
  country        TEXT        NOT NULL DEFAULT 'India',
  mobile_no      TEXT        NOT NULL DEFAULT '',
  email          TEXT        NOT NULL DEFAULT '',    -- "Gmail ID" in the source sheet
  gst_no         TEXT        NOT NULL DEFAULT '',
  payment_terms  TEXT        NOT NULL DEFAULT '',
  currency_code  TEXT        NOT NULL DEFAULT 'INR',
  contact_person TEXT        NOT NULL DEFAULT '',
  notes          TEXT        NOT NULL DEFAULT '',
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  deleted_at     TIMESTAMPTZ,
  CONSTRAINT chk_suppliers_name CHECK (length(trim(supplier_name)) > 0)
);
CREATE UNIQUE INDEX uq_suppliers_code ON suppliers (upper(supplier_code)) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX uq_suppliers_name ON suppliers (lower(supplier_name)) WHERE deleted_at IS NULL;
CREATE INDEX idx_suppliers_active ON suppliers (is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_suppliers_state ON suppliers (state) WHERE deleted_at IS NULL;
CREATE INDEX idx_suppliers_city ON suppliers (city) WHERE deleted_at IS NULL;

-- ── Item Master (SRS §7.1) ──────────────────────────────────────────────────
CREATE TABLE items (
  id                 BIGSERIAL PRIMARY KEY,
  item_code          TEXT        NOT NULL,
  item_description   TEXT        NOT NULL,
  item_type_id       BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  department_id      BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  cost_centre_id     BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  main_group_id      BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  sub_main_group_id  BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  indent_type_id     BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  uom_id             BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  hsn_code           TEXT        NOT NULL DEFAULT '',
  item_specification TEXT        NOT NULL DEFAULT '',
  standard_rate      NUMERIC(18, 4),                 -- indicative rate for PO defaulting
  reorder_level      NUMERIC(18, 4),
  is_active          BOOLEAN     NOT NULL DEFAULT TRUE,
  -- "date" / "time" columns of the source sheet are creation metadata (SRS §7.1)
  source_date        DATE,
  source_time        TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT chk_items_code CHECK (length(trim(item_code)) > 0),
  CONSTRAINT chk_items_desc CHECK (length(trim(item_description)) > 0),
  CONSTRAINT chk_items_rate CHECK (standard_rate IS NULL OR standard_rate >= 0)
);
CREATE UNIQUE INDEX uq_items_code ON items (upper(item_code)) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_active ON items (is_active) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_department ON items (department_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_cost_centre ON items (cost_centre_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_main_group ON items (main_group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_sub_group ON items (sub_main_group_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_type ON items (item_type_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_items_desc ON items (lower(item_description));
CREATE INDEX idx_items_hsn ON items (hsn_code) WHERE deleted_at IS NULL;
