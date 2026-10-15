-- ============================================================================
-- 023 — Complete Inventory Module
--
-- 1. Adds `inventory_category` & `opening_stock_qty` to items table.
-- 2. Creates `stock_adjustments` table for physical count audit & reconciliation.
-- 3. Categorizes items into FG, RM, TRADING, GENERAL based on business groups.
-- 4. Adds inventory permissions and grants them to system roles.
-- ============================================================================

-- ── 1. Items: Inventory Category & Opening Stock ─────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS inventory_category TEXT NOT NULL DEFAULT 'GENERAL';
ALTER TABLE items ADD COLUMN IF NOT EXISTS opening_stock_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_inventory_category;
ALTER TABLE items ADD CONSTRAINT chk_items_inventory_category CHECK (
  inventory_category IN ('GENERAL', 'RM', 'FG', 'TRADING', 'WIP')
);

CREATE INDEX IF NOT EXISTS idx_items_inventory_category ON items (inventory_category) WHERE deleted_at IS NULL;

-- Initial Category Classification based on item code and main group
UPDATE items
   SET inventory_category = 'FG'
 WHERE inventory_category = 'GENERAL'
   AND (
     item_code LIKE 'FG%'
     OR item_description ILIKE '%Finished%'
     OR item_description ILIKE '%FG Material%'
   );

UPDATE items
   SET inventory_category = 'RM'
 WHERE inventory_category = 'GENERAL'
   AND (
     item_code LIKE 'RM%'
     OR item_description ILIKE '%Raw Material%'
     OR item_description ILIKE '%Mother Tube%'
     OR main_group_id IN (SELECT id FROM lookups WHERE category = 'MAIN_GROUP' AND (name ILIKE '%Mother Tube%' OR name ILIKE '%Rod%' OR name ILIKE '%Bar%' OR name ILIKE '%Strip%'))
   );

UPDATE items
   SET inventory_category = 'TRADING'
 WHERE inventory_category = 'GENERAL'
   AND (
     item_code LIKE 'TR%'
     OR item_description ILIKE '%Trading%'
   );

-- ── 2. Stock Adjustments Table ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_adjustments (
  id                 BIGSERIAL PRIMARY KEY,
  adjustment_no      TEXT        NOT NULL,
  adjustment_date    DATE        NOT NULL,
  item_id            BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code          TEXT        NOT NULL,
  item_description   TEXT        NOT NULL,
  category           TEXT        NOT NULL DEFAULT 'GENERAL',
  system_stock_qty   NUMERIC(18, 4) NOT NULL,
  actual_stock_qty   NUMERIC(18, 4) NOT NULL,
  adjustment_qty     NUMERIC(18, 4) NOT NULL,
  reason             TEXT        NOT NULL,
  findings           TEXT        NOT NULL DEFAULT '',
  approved_by        BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  approver_name      TEXT        NOT NULL DEFAULT '',
  remarks            TEXT        NOT NULL DEFAULT '',
  created_by         BIGINT      REFERENCES users (id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_stock_adjustment_no UNIQUE (adjustment_no)
);

CREATE INDEX IF NOT EXISTS idx_stock_adj_date ON stock_adjustments (adjustment_date DESC);
CREATE INDEX IF NOT EXISTS idx_stock_adj_item ON stock_adjustments (item_id);
CREATE INDEX IF NOT EXISTS idx_stock_adj_category ON stock_adjustments (category);

-- ── 3. Permissions for Inventory Management ──────────────────────────────────
INSERT INTO permissions (code, module, action, label, description, sort_order)
VALUES
  ('inventory.view', 'inventory', 'view', 'View Inventory', 'View inventory dashboard, stock register, and movement history', 60),
  ('inventory.adjust', 'inventory', 'adjust', 'Adjust Stock', 'Create physical stock audit adjustments and update book stock', 61),
  ('inventory.export', 'inventory', 'export', 'Export Inventory', 'Export stock register and inventory reports to CSV', 62)
ON CONFLICT (code) DO NOTHING;

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.name IN ('SUPER_ADMIN', 'STORE_INCHARGE', 'STORE_USER', 'MANAGEMENT')
   AND p.code IN ('inventory.view', 'inventory.adjust', 'inventory.export')
ON CONFLICT DO NOTHING;
