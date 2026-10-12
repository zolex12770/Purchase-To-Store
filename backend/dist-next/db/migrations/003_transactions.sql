-- ============================================================================
-- 003_transactions — Purchase Indent, Purchase Order, GRN
-- SRS §10, §11, §12, §19, §20, §37  |  ADR-002, ADR-003, ADR-004, ADR-005, ADR-008
-- ============================================================================

-- ─────────────────────────────── PURCHASE INDENT ────────────────────────────
CREATE TABLE purchase_indent_headers (
  id                   BIGSERIAL PRIMARY KEY,
  indent_no            TEXT        NOT NULL,          -- IND-YYYYMMDD-#### (ADR-002)
  indent_date          DATE        NOT NULL,
  indent_time          TEXT        NOT NULL DEFAULT '',
  indent_type_id       BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  department_id        BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  cost_centre_id       BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  -- Optional supplier preference. Nullable by design: the source sheet has no supplier
  -- on the indent. It is what makes "supplier-wise consolidation" (SRS §11.1) meaningful,
  -- and never constrains which supplier the resulting PO is actually raised on.
  suggested_supplier_id BIGINT REFERENCES suppliers (id) ON DELETE SET NULL,
  requested_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  required_by_date     DATE,
  remarks              TEXT        NOT NULL DEFAULT '',
  status               TEXT        NOT NULL DEFAULT 'DRAFT',
  submitted_at         TIMESTAMPTZ,
  submitted_by         BIGINT REFERENCES users (id) ON DELETE SET NULL,
  approved_at          TIMESTAMPTZ,
  approved_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  rejected_at          TIMESTAMPTZ,
  rejected_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  rejection_reason     TEXT,
  closed_at            TIMESTAMPTZ,
  closed_by            BIGINT REFERENCES users (id) ON DELETE SET NULL,
  close_reason         TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by           BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by           BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_indent_no UNIQUE (indent_no),
  CONSTRAINT chk_indent_status CHECK (status IN
    ('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED')),
  -- A rejection is worthless without its reason (SRS §10, §18)
  CONSTRAINT chk_indent_rejection_reason CHECK (
    status <> 'REJECTED' OR (rejection_reason IS NOT NULL AND length(trim(rejection_reason)) > 0))
);
CREATE INDEX idx_indent_status ON purchase_indent_headers (status);
CREATE INDEX idx_indent_date ON purchase_indent_headers (indent_date DESC);
CREATE INDEX idx_indent_dept ON purchase_indent_headers (department_id);
CREATE INDEX idx_indent_cost_centre ON purchase_indent_headers (cost_centre_id);
CREATE INDEX idx_indent_type ON purchase_indent_headers (indent_type_id);
CREATE INDEX idx_indent_requester ON purchase_indent_headers (requested_by_user_id);
CREATE INDEX idx_indent_supplier ON purchase_indent_headers (suggested_supplier_id);
CREATE INDEX idx_indent_status_date ON purchase_indent_headers (status, indent_date DESC);

CREATE TABLE purchase_indent_lines (
  id                 BIGSERIAL PRIMARY KEY,
  indent_id          BIGINT      NOT NULL REFERENCES purchase_indent_headers (id) ON DELETE CASCADE,
  line_no            INTEGER     NOT NULL,
  item_id            BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  -- Snapshots: a later edit to the Item Master must never rewrite history (SRS §34)
  item_code          TEXT        NOT NULL,
  item_description   TEXT        NOT NULL,
  indent_qty         NUMERIC(18, 4) NOT NULL,
  uom_id             BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  item_specification TEXT        NOT NULL DEFAULT '',
  department_id      BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  cost_centre_id     BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  estimated_rate     NUMERIC(18, 4),
  required_by_date   DATE,
  remarks            TEXT        NOT NULL DEFAULT '',
  -- Manual short-close: releases the remaining quantity from "pending" analytics
  is_closed          BOOLEAN     NOT NULL DEFAULT FALSE,
  closed_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_indent_line_no UNIQUE (indent_id, line_no),
  CONSTRAINT chk_indent_qty CHECK (indent_qty > 0),
  CONSTRAINT chk_indent_est_rate CHECK (estimated_rate IS NULL OR estimated_rate >= 0)
);
CREATE INDEX idx_indent_lines_indent ON purchase_indent_lines (indent_id);
CREATE INDEX idx_indent_lines_item ON purchase_indent_lines (item_id);
CREATE INDEX idx_indent_lines_open ON purchase_indent_lines (is_closed) WHERE is_closed = FALSE;

-- Approval history — `level` present so a multi-level chain needs no migration (ADR-011)
CREATE TABLE indent_approvals (
  id            BIGSERIAL PRIMARY KEY,
  indent_id     BIGINT      NOT NULL REFERENCES purchase_indent_headers (id) ON DELETE CASCADE,
  level         INTEGER     NOT NULL DEFAULT 1,
  action        TEXT        NOT NULL,   -- SUBMIT | APPROVE | REJECT | CANCEL | REOPEN | CLOSE
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  reason        TEXT,
  from_status   TEXT,
  to_status     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_indent_approval_action CHECK (action IN
    ('SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'REOPEN', 'CLOSE'))
);
CREATE INDEX idx_indent_approvals_indent ON indent_approvals (indent_id, created_at DESC);

-- ─────────────────────────────── PURCHASE ORDER ─────────────────────────────
CREATE TABLE purchase_order_headers (
  id             BIGSERIAL PRIMARY KEY,
  po_no          TEXT        NOT NULL,               -- PO-YYYYMMDD-#### (ADR-002)
  po_date        DATE        NOT NULL,
  po_time        TEXT        NOT NULL DEFAULT '',
  po_type_id     BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  supplier_id    BIGINT      NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  -- Commercial snapshot taken from the supplier at PO time (SRS §11.2)
  currency_code  TEXT        NOT NULL DEFAULT 'INR',
  payment_terms  TEXT        NOT NULL DEFAULT '',
  delivery_date  DATE,
  delivery_address TEXT      NOT NULL DEFAULT '',
  remarks        TEXT        NOT NULL DEFAULT '',
  -- DIRECT = no originating indent; INDENT = built from one or more indent lines
  source_mode    TEXT        NOT NULL DEFAULT 'DIRECT',
  status         TEXT        NOT NULL DEFAULT 'DRAFT',
  issued_at      TIMESTAMPTZ,
  issued_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  closed_at      TIMESTAMPTZ,
  closed_by      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  close_reason   TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_po_no UNIQUE (po_no),
  CONSTRAINT chk_po_source_mode CHECK (source_mode IN ('DIRECT', 'INDENT')),
  CONSTRAINT chk_po_status CHECK (status IN
    ('DRAFT', 'OPEN', 'PARTIALLY_RECEIVED', 'COMPLETED', 'SHORT_CLOSED', 'CANCELLED')),
  CONSTRAINT chk_po_close_reason CHECK (
    status <> 'SHORT_CLOSED' OR (close_reason IS NOT NULL AND length(trim(close_reason)) > 0))
);
CREATE INDEX idx_po_status ON purchase_order_headers (status);
CREATE INDEX idx_po_date ON purchase_order_headers (po_date DESC);
CREATE INDEX idx_po_supplier ON purchase_order_headers (supplier_id);
CREATE INDEX idx_po_type ON purchase_order_headers (po_type_id);
CREATE INDEX idx_po_status_date ON purchase_order_headers (status, po_date DESC);
CREATE INDEX idx_po_supplier_date ON purchase_order_headers (supplier_id, po_date DESC);

CREATE TABLE purchase_order_lines (
  id                 BIGSERIAL PRIMARY KEY,
  po_id              BIGINT      NOT NULL REFERENCES purchase_order_headers (id) ON DELETE CASCADE,
  line_no            INTEGER     NOT NULL,
  item_id            BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code          TEXT        NOT NULL,
  item_description   TEXT        NOT NULL,
  po_qty             NUMERIC(18, 4) NOT NULL,
  uom_id             BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  rate               NUMERIC(18, 4) NOT NULL,
  discount_pct       NUMERIC(9, 4)  NOT NULL DEFAULT 0,
  -- ADR-004: derived money is computed BY THE DATABASE and cannot drift or be forged.
  -- A generated column may not reference another generated column, hence the repetition.
  final_rate         NUMERIC(18, 4) GENERATED ALWAYS AS
                       (round(rate * (1 - discount_pct / 100), 4)) STORED,
  amount             NUMERIC(18, 2) GENERATED ALWAYS AS
                       (round(po_qty * round(rate * (1 - discount_pct / 100), 4), 2)) STORED,
  item_specification TEXT        NOT NULL DEFAULT '',
  delivery_date      DATE,
  remarks            TEXT        NOT NULL DEFAULT '',
  is_closed          BOOLEAN     NOT NULL DEFAULT FALSE,   -- line-level short close
  closed_reason      TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_po_line_no UNIQUE (po_id, line_no),
  CONSTRAINT chk_po_qty CHECK (po_qty > 0),
  CONSTRAINT chk_po_rate CHECK (rate >= 0),
  CONSTRAINT chk_po_discount CHECK (discount_pct >= 0 AND discount_pct <= 100)
);
CREATE INDEX idx_po_lines_po ON purchase_order_lines (po_id);
CREATE INDEX idx_po_lines_item ON purchase_order_lines (item_id);
CREATE INDEX idx_po_lines_open ON purchase_order_lines (is_closed) WHERE is_closed = FALSE;

-- Source traceability (SRS §11.3, §34): every consolidated PO line can answer
-- "which indent line did this quantity come from, and how much did it consume?"
CREATE TABLE po_indent_sources (
  id             BIGSERIAL PRIMARY KEY,
  po_line_id     BIGINT      NOT NULL REFERENCES purchase_order_lines (id) ON DELETE CASCADE,
  indent_line_id BIGINT      NOT NULL REFERENCES purchase_indent_lines (id) ON DELETE RESTRICT,
  indent_id      BIGINT      NOT NULL REFERENCES purchase_indent_headers (id) ON DELETE RESTRICT,
  consumed_qty   NUMERIC(18, 4) NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_po_source UNIQUE (po_line_id, indent_line_id),
  CONSTRAINT chk_po_source_qty CHECK (consumed_qty > 0)
);
CREATE INDEX idx_po_sources_indent_line ON po_indent_sources (indent_line_id);
CREATE INDEX idx_po_sources_indent ON po_indent_sources (indent_id);
CREATE INDEX idx_po_sources_po_line ON po_indent_sources (po_line_id);

-- ────────────────────────────────── GRN ─────────────────────────────────────
CREATE TABLE grn_headers (
  id                  BIGSERIAL PRIMARY KEY,
  grn_no              TEXT        NOT NULL,          -- ADR-008: GRN gets its own identity
  grn_date            DATE        NOT NULL,
  grn_time            TEXT        NOT NULL DEFAULT '',
  po_id               BIGINT      NOT NULL REFERENCES purchase_order_headers (id) ON DELETE RESTRICT,
  supplier_id         BIGINT      NOT NULL REFERENCES suppliers (id) ON DELETE RESTRICT,
  challan_no          TEXT        NOT NULL DEFAULT '',
  challan_date        DATE,
  vehicle_no          TEXT        NOT NULL DEFAULT '',
  received_by_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  remarks             TEXT        NOT NULL DEFAULT '',
  status              TEXT        NOT NULL DEFAULT 'DRAFT',
  posted_at           TIMESTAMPTZ,
  posted_by           BIGINT REFERENCES users (id) ON DELETE SET NULL,
  cancelled_at        TIMESTAMPTZ,
  cancelled_by        BIGINT REFERENCES users (id) ON DELETE SET NULL,
  cancel_reason       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_grn_no UNIQUE (grn_no),
  CONSTRAINT chk_grn_status CHECK (status IN ('DRAFT', 'POSTED', 'CANCELLED')),
  CONSTRAINT chk_grn_cancel_reason CHECK (
    status <> 'CANCELLED' OR (cancel_reason IS NOT NULL AND length(trim(cancel_reason)) > 0))
);
CREATE INDEX idx_grn_status ON grn_headers (status);
CREATE INDEX idx_grn_date ON grn_headers (grn_date DESC);
CREATE INDEX idx_grn_po ON grn_headers (po_id);
CREATE INDEX idx_grn_supplier ON grn_headers (supplier_id);
CREATE INDEX idx_grn_status_date ON grn_headers (status, grn_date DESC);

CREATE TABLE grn_lines (
  id               BIGSERIAL PRIMARY KEY,
  grn_id           BIGINT      NOT NULL REFERENCES grn_headers (id) ON DELETE CASCADE,
  line_no          INTEGER     NOT NULL,
  po_line_id       BIGINT      NOT NULL REFERENCES purchase_order_lines (id) ON DELETE RESTRICT,
  item_id          BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code        TEXT        NOT NULL,
  item_description TEXT        NOT NULL,
  grn_qty          NUMERIC(18, 4) NOT NULL,
  uom_id           BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  -- Rate snapshot from the PO line, so GRN value analytics need no join to price history
  rate             NUMERIC(18, 4) NOT NULL DEFAULT 0,
  amount           NUMERIC(18, 2) GENERATED ALWAYS AS (round(grn_qty * rate, 2)) STORED,
  remarks          TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_grn_line_no UNIQUE (grn_id, line_no),
  CONSTRAINT chk_grn_qty CHECK (grn_qty > 0),
  CONSTRAINT chk_grn_rate CHECK (rate >= 0)
);
CREATE INDEX idx_grn_lines_grn ON grn_lines (grn_id);
CREATE INDEX idx_grn_lines_po_line ON grn_lines (po_line_id);
CREATE INDEX idx_grn_lines_item ON grn_lines (item_id);
