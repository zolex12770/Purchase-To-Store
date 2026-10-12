-- ============================================================================
-- 021 — Master Data Accuracy, QC Workflow, and Auto-Indent Module
--
-- Safe, additive migration:
-- 1. Adds `qc_required` to items table.
-- 2. Adds `qc_status` to grn_headers table.
-- 3. Creates `qc_inspections` table for post-GRN inspection lifecycle.
-- 4. Creates `auto_indents` table for stock replenishment suggestions & approval.
-- 5. Adds QC and Auto-Indent permissions to permissions and system roles.
-- 6. Adds auto_indent and sync settings to app_settings.
-- ============================================================================

-- ── 1. Items: QC Required flag ───────────────────────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS qc_required BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS idx_items_qc_required ON items (qc_required) WHERE deleted_at IS NULL;

-- ── 2. GRN Headers: QC Status ───────────────────────────────────────────────
ALTER TABLE grn_headers ADD COLUMN IF NOT EXISTS qc_status TEXT NOT NULL DEFAULT 'NOT_APPLICABLE';
ALTER TABLE grn_headers DROP CONSTRAINT IF EXISTS chk_grn_qc_status;
ALTER TABLE grn_headers ADD CONSTRAINT chk_grn_qc_status CHECK (
  qc_status IN ('NOT_APPLICABLE', 'PENDING_QC', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD')
);
CREATE INDEX IF NOT EXISTS idx_grn_headers_qc_status ON grn_headers (qc_status);

-- ── 3. QC Inspections Table ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qc_inspections (
  id                BIGSERIAL PRIMARY KEY,
  grn_id            BIGINT NOT NULL REFERENCES grn_headers (id) ON DELETE RESTRICT,
  grn_line_id       BIGINT REFERENCES grn_lines (id) ON DELETE RESTRICT,
  grn_no            TEXT NOT NULL,
  item_id           BIGINT NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code         TEXT NOT NULL,
  item_name         TEXT NOT NULL,
  supplier_id       BIGINT REFERENCES suppliers (id) ON DELETE SET NULL,
  supplier_name     TEXT NOT NULL DEFAULT '',
  received_qty      NUMERIC(18, 4) NOT NULL,
  accepted_qty      NUMERIC(18, 4) NOT NULL DEFAULT 0,
  rejected_qty      NUMERIC(18, 4) NOT NULL DEFAULT 0,
  uom_id            BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  uom_code          TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'PENDING_QC',
  inspector_id      BIGINT REFERENCES users (id) ON DELETE SET NULL,
  inspector_name    TEXT NOT NULL DEFAULT '',
  inspection_date   TIMESTAMPTZ,
  remarks           TEXT NOT NULL DEFAULT '',
  rejection_reason  TEXT NOT NULL DEFAULT '',
  next_action       TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_qc_status CHECK (
    status IN ('PENDING_QC', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD')
  ),
  CONSTRAINT chk_qc_quantities CHECK (
    accepted_qty >= 0 AND rejected_qty >= 0 AND (accepted_qty + rejected_qty <= received_qty)
  )
);

CREATE INDEX IF NOT EXISTS idx_qc_inspections_grn ON qc_inspections (grn_id);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_status ON qc_inspections (status);
CREATE INDEX IF NOT EXISTS idx_qc_inspections_item ON qc_inspections (item_id);

-- ── 4. Auto Indent Suggestions & Queue ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS auto_indents (
  id                BIGSERIAL PRIMARY KEY,
  item_id           BIGINT NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code         TEXT NOT NULL,
  item_name         TEXT NOT NULL,
  eligible_stock    NUMERIC(18, 4) NOT NULL,
  min_stock         NUMERIC(18, 4) NOT NULL,
  max_stock         NUMERIC(18, 4),
  reorder_level     NUMERIC(18, 4) NOT NULL,
  suggested_qty     NUMERIC(18, 4) NOT NULL,
  uom_id            BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  uom_code          TEXT NOT NULL DEFAULT '',
  department_id     BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  department_name   TEXT NOT NULL DEFAULT '',
  cost_centre_id    BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  cost_centre_name  TEXT NOT NULL DEFAULT '',
  reason            TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'PENDING_APPROVAL',
  approver_id       BIGINT REFERENCES users (id) ON DELETE SET NULL,
  approver_name     TEXT NOT NULL DEFAULT '',
  approved_at       TIMESTAMPTZ,
  rejection_reason  TEXT NOT NULL DEFAULT '',
  indent_id         BIGINT REFERENCES purchase_indent_headers (id) ON DELETE SET NULL,
  indent_no         TEXT NOT NULL DEFAULT '',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_auto_indent_status CHECK (
    status IN ('SUGGESTED', 'PENDING_APPROVAL', 'STORE_APPROVED', 'PURCHASE_APPROVED', 'APPROVED', 'REJECTED', 'ORDERED', 'CONVERTED')
  ),
  CONSTRAINT chk_auto_indent_suggested_qty CHECK (suggested_qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_auto_indents_status ON auto_indents (status);
CREATE INDEX IF NOT EXISTS idx_auto_indents_item ON auto_indents (item_id);

-- ── 5. System Permissions for QC and Auto Indent ────────────────────────────
INSERT INTO permissions (code, module, action, label, description, sort_order)
VALUES
  ('qc.view', 'qc', 'view', 'View QC Records', 'View quality inspection queues and reports.', 60),
  ('qc.inspect', 'qc', 'inspect', 'Inspect Material', 'Perform quality inspection and record test results.', 61),
  ('qc.approve', 'qc', 'approve', 'Approve/Reject QC', 'Finalise QC decision (Pass/Fail/Hold) for GRN release.', 62),
  ('auto_indent.view', 'inventory', 'view', 'View Auto Indents', 'View stock reorder levels and auto indent suggestions.', 70),
  ('auto_indent.approve', 'inventory', 'approve', 'Approve Auto Indents', 'Approve or reject automatic indent suggestions.', 71),
  ('auto_indent.config', 'inventory', 'config', 'Configure Auto Indent', 'Configure auto-indent rules and stock replenishment thresholds.', 72)
ON CONFLICT (code) DO UPDATE
  SET module = EXCLUDED.module, action = EXCLUDED.action,
      label = EXCLUDED.label, description = EXCLUDED.description,
      sort_order = EXCLUDED.sort_order;

-- Grant QC & Auto Indent permissions to roles
-- SUPER_ADMIN gets all (via code = '*')
-- STORE_USER gets qc.view, qc.inspect, qc.approve, auto_indent.view, auto_indent.approve
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'STORE_USER' AND p.code IN ('qc.view', 'qc.inspect', 'qc.approve', 'auto_indent.view', 'auto_indent.approve')
ON CONFLICT DO NOTHING;

-- PURCHASE_HEAD gets qc.view, auto_indent.view, auto_indent.approve
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'PURCHASE_HEAD' AND p.code IN ('qc.view', 'auto_indent.view', 'auto_indent.approve')
ON CONFLICT DO NOTHING;

-- PURCHASE_USER gets auto_indent.view
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'PURCHASE_USER' AND p.code IN ('auto_indent.view')
ON CONFLICT DO NOTHING;

-- MANAGEMENT gets qc.view, auto_indent.view
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id FROM roles r, permissions p
WHERE r.code = 'MANAGEMENT' AND p.code IN ('qc.view', 'auto_indent.view')
ON CONFLICT DO NOTHING;

-- ── 6. Default App Settings ─────────────────────────────────────────────────
INSERT INTO app_settings (key, value, description)
VALUES
  ('auto_indent.enabled', 'true'::jsonb, 'Automatic Indent Suggestion master switch.'),
  ('auto_indent.approval_required', 'true'::jsonb, 'Requires Store or Purchase approval before promoting to Indent.'),
  ('sync.mode', '"SOURCE_SHEET_AUTHORITATIVE"'::jsonb, 'Current sync authority mode (SOURCE_SHEET_AUTHORITATIVE or ERP_AUTHORITATIVE).')
ON CONFLICT (key) DO NOTHING;
