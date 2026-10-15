-- ============================================================================
-- 024 — Dedicated Inventory Database Model & Synchronisation Schema
--
-- 1. Creates dedicated `inventory_items` table with category-specific attributes,
--    dual UOM / weight conversion, and stock availability cache.
-- 2. Creates immutable `inventory_transactions` ledger for all category movements.
-- 3. Creates `inventory_sync_checkpoints` to track live sync state per sheet & tab.
-- 4. Creates `inventory_quarantine` for traceable isolation of malformed records.
-- 5. Seeds `inventory_items` from active ERP items with existing stock balances.
-- ============================================================================

-- ── 1. Dedicated Inventory Items ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_items (
  id                     BIGSERIAL PRIMARY KEY,
  item_id                BIGINT NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code              TEXT NOT NULL,
  item_description       TEXT NOT NULL,
  category               TEXT NOT NULL CHECK (category IN ('RM', 'FG', 'TRADING', 'WIP', 'GENERAL')),
  primary_uom            TEXT NOT NULL DEFAULT 'Nos',
  secondary_uom          TEXT,
  conversion_factor      NUMERIC(18, 6) DEFAULT 1,
  weight_per_1000pc_kg   NUMERIC(18, 6) DEFAULT 0,
  opening_stock_qty      NUMERIC(18, 4) NOT NULL DEFAULT 0,
  opening_weight_kg      NUMERIC(18, 4) DEFAULT 0,
  opening_effective_date DATE DEFAULT '2026-04-01',
  live_stock_qty         NUMERIC(18, 4) NOT NULL DEFAULT 0,
  live_weight_kg         NUMERIC(18, 4) DEFAULT 0,
  allocated_qty          NUMERIC(18, 4) NOT NULL DEFAULT 0,
  available_qty          NUMERIC(18, 4) NOT NULL DEFAULT 0,
  qc_hold_qty            NUMERIC(18, 4) NOT NULL DEFAULT 0,
  min_stock_level        NUMERIC(18, 4) DEFAULT 0,
  reorder_point          NUMERIC(18, 4) DEFAULT 0,
  rack_id                TEXT,
  main_group             TEXT,
  unit_price             NUMERIC(18, 4) DEFAULT 0,
  source_spreadsheet_id  TEXT,
  source_tab             TEXT,
  source_row_index       INTEGER,
  last_sync_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at             TIMESTAMPTZ,
  CONSTRAINT uq_inv_items_code_cat UNIQUE (item_code, category)
);

CREATE INDEX IF NOT EXISTS idx_inv_items_category ON inventory_items (category) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inv_items_item_code ON inventory_items (item_code) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_inv_items_item_id ON inventory_items (item_id) WHERE deleted_at IS NULL;

-- ── 2. Dedicated Inventory Transactions Ledger ──────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_transactions (
  id                     BIGSERIAL PRIMARY KEY,
  txn_no                 TEXT NOT NULL UNIQUE,
  category               TEXT NOT NULL CHECK (category IN ('RM', 'FG', 'TRADING', 'WIP', 'GENERAL')),
  item_id                BIGINT NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  item_code              TEXT NOT NULL,
  txn_type               TEXT NOT NULL,
  direction              TEXT NOT NULL CHECK (direction IN ('IN', 'OUT', 'ADJUST')),
  quantity               NUMERIC(18, 4) NOT NULL,
  weight_kg              NUMERIC(18, 4),
  uom                    TEXT NOT NULL,
  rate                   NUMERIC(18, 4) DEFAULT 0,
  amount                 NUMERIC(18, 4) DEFAULT 0,
  balance_qty_after      NUMERIC(18, 4) NOT NULL,
  balance_weight_after   NUMERIC(18, 4),
  reference_doc_type     TEXT,
  reference_doc_no       TEXT,
  from_location          TEXT,
  to_location            TEXT,
  department             TEXT,
  source_spreadsheet_id  TEXT,
  source_tab             TEXT,
  source_row_index       INTEGER,
  status                 TEXT NOT NULL DEFAULT 'POSTED' CHECK (status IN ('DRAFT', 'POSTED', 'REVERSED', 'CANCELLED')),
  notes                  TEXT,
  created_by             BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_by_name        TEXT,
  txn_date               DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_txns_category ON inventory_transactions (category);
CREATE INDEX IF NOT EXISTS idx_inv_txns_item_id ON inventory_transactions (item_id);
CREATE INDEX IF NOT EXISTS idx_inv_txns_item_code ON inventory_transactions (item_code);
CREATE INDEX IF NOT EXISTS idx_inv_txns_created_at ON inventory_transactions (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_inv_txns_ref ON inventory_transactions (reference_doc_type, reference_doc_no);

-- ── 3. Inventory Sync Checkpoints ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_sync_checkpoints (
  id                     BIGSERIAL PRIMARY KEY,
  category               TEXT NOT NULL,
  spreadsheet_id         TEXT NOT NULL,
  tab_name               TEXT NOT NULL,
  total_rows_read        INTEGER NOT NULL DEFAULT 0,
  valid_records_imported INTEGER NOT NULL DEFAULT 0,
  quarantined_records    INTEGER NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'SUCCESS',
  error_message          TEXT,
  sync_mode              TEXT NOT NULL DEFAULT 'POLL',
  sync_duration_ms       INTEGER DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_inv_sync_category ON inventory_sync_checkpoints (category, tab_name);

-- ── 4. Inventory Quarantine ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS inventory_quarantine (
  id                     BIGSERIAL PRIMARY KEY,
  category               TEXT NOT NULL,
  source_tab             TEXT NOT NULL,
  source_row_index       INTEGER NOT NULL,
  raw_data               JSONB NOT NULL,
  quarantine_reason      TEXT NOT NULL,
  resolution_status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (resolution_status IN ('PENDING', 'RESOLVED', 'IGNORED')),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── 5. Populate initial inventory_items from active items ───────────────────
INSERT INTO inventory_items (
  item_id, item_code, item_description, category, primary_uom,
  opening_stock_qty, live_stock_qty, allocated_qty, available_qty,
  min_stock_level, reorder_point, unit_price
)
SELECT
  i.id,
  i.item_code,
  i.item_description,
  COALESCE(i.inventory_category, 'GENERAL'),
  COALESCE(u.code, 'Nos'),
  COALESCE(i.opening_stock_qty, 0),
  COALESCE(i.live_stock_qty, 0),
  0,
  COALESCE(i.live_stock_qty, 0),
  COALESCE(i.min_stock, 0),
  COALESCE(i.reorder_level, 0),
  COALESCE(i.standard_rate, 0)
FROM items i
LEFT JOIN lookups u ON u.id = i.uom_id
WHERE i.deleted_at IS NULL
ON CONFLICT (item_code, category) DO NOTHING;
