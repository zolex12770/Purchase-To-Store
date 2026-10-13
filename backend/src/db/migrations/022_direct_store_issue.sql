-- ============================================================================
-- 022 — Direct Issue from Store & Enhanced Inventory Lifecycle
--
-- 1. Expands stock_ledger txn_type to include DIRECT_ISSUE, DIRECT_ISSUE_REVERSAL,
--    and STOCK_ADJUSTMENT.
-- 2. Creates direct_issue_headers & direct_issue_lines for direct non-requisition issues.
-- 3. Grants direct_issue permissions to store and admin roles.
-- ============================================================================

-- ── 1. Stock ledger: widen for direct issue and adjustments ─────────────────
ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS chk_stock_ledger_type;
ALTER TABLE stock_ledger ADD CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN (
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
  'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT'
));

-- ── 2. Direct Issue Headers ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS direct_issue_headers (
  id                       BIGSERIAL PRIMARY KEY,
  issue_no                 TEXT        NOT NULL,
  issue_date               DATE        NOT NULL,
  issue_time               TEXT        NOT NULL DEFAULT '',
  recipient_user_id        BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  recipient_name           TEXT        NOT NULL DEFAULT '',
  recipient_employee_code  TEXT        NOT NULL DEFAULT '',
  department_id            BIGINT      REFERENCES lookups (id) ON DELETE RESTRICT,
  department_name          TEXT        NOT NULL DEFAULT '',
  cost_centre_id           BIGINT      REFERENCES lookups (id) ON DELETE RESTRICT,
  cost_centre_name         TEXT        NOT NULL DEFAULT '',
  purpose                  TEXT        NOT NULL DEFAULT '',
  remarks                  TEXT        NOT NULL DEFAULT '',
  total_qty                NUMERIC(18, 4) NOT NULL DEFAULT 0,
  item_count               INTEGER     NOT NULL DEFAULT 0,
  created_by               BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_direct_issue_no UNIQUE (issue_no)
);

CREATE INDEX IF NOT EXISTS idx_direct_issue_date ON direct_issue_headers (issue_date DESC);
CREATE INDEX IF NOT EXISTS idx_direct_issue_recipient ON direct_issue_headers (recipient_user_id);
CREATE INDEX IF NOT EXISTS idx_direct_issue_department ON direct_issue_headers (department_id);
CREATE INDEX IF NOT EXISTS idx_direct_issue_cost_centre ON direct_issue_headers (cost_centre_id);

-- ── 3. Direct Issue Lines ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS direct_issue_lines (
  id                BIGSERIAL PRIMARY KEY,
  direct_issue_id   BIGINT         NOT NULL REFERENCES direct_issue_headers (id) ON DELETE CASCADE,
  line_no           INTEGER        NOT NULL,
  item_id           BIGINT         NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code         TEXT           NOT NULL,
  item_description  TEXT           NOT NULL,
  issue_qty         NUMERIC(18, 4) NOT NULL CHECK (issue_qty > 0),
  uom_id            BIGINT         REFERENCES lookups (id) ON DELETE SET NULL,
  uom_code          TEXT           NOT NULL DEFAULT '',
  remarks           TEXT           NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT uq_direct_issue_line UNIQUE (direct_issue_id, line_no)
);

CREATE INDEX IF NOT EXISTS idx_direct_issue_lines_issue ON direct_issue_lines (direct_issue_id);
CREATE INDEX IF NOT EXISTS idx_direct_issue_lines_item ON direct_issue_lines (item_id);

-- ── 4. Permissions for Direct Issue ─────────────────────────────────────────
INSERT INTO permissions (code, module, action, label, description, sort_order)
VALUES
  ('direct_issue.view', 'direct_issue', 'view', 'View Direct Issues', 'View store direct issue register and slips', 65),
  ('direct_issue.create', 'direct_issue', 'create', 'Create Direct Issue', 'Issue items directly from store with stock deduction', 66),
  ('direct_issue.print', 'direct_issue', 'print', 'Print Direct Issue Slip', 'Print direct store issue slips', 67),
  ('direct_issue.export', 'direct_issue', 'export', 'Export Direct Issues', 'Export direct store issues register to CSV/Excel', 68)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name IN ('SUPER_ADMIN', 'STORE_INCHARGE', 'STORE_USER', 'MANAGEMENT')
   AND p.code IN ('direct_issue.view', 'direct_issue.create', 'direct_issue.print', 'direct_issue.export')
ON CONFLICT DO NOTHING;
