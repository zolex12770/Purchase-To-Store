-- ============================================================================
-- 025 — Inventory sync integrity, role grants and stock-ledger coverage
--
-- Additive only: no table is dropped, truncated or recreated, and no business
-- record is deleted. Each step names the defect it closes.
--
-- 1. Role grants. 021–023 added permission codes and 023 tried to grant them,
--    but compared roles.name ('Store User') with role codes ('STORE_USER'), so
--    nothing was granted; and because those codes already existed when the
--    seeder ran, it never applied the catalogue defaults either. The pairs
--    below are exactly the auth/permissions.ts defaults that were never
--    applied for the operational roles. VIEWER is left for the owner to decide
--    (it covers every imported employee). On a fresh database the roles do not
--    exist yet, nothing is inserted here, and the seeder grants the full
--    catalogue to the new roles as before.
-- 2. Inventory rows no longer require a Purchase item-master row. The sheet
--    sync used to insert every sheet code into `items`; the Purchase Item
--    Master sync then soft-deleted the codes its own sheet does not list, and
--    the next inventory sync created them again (about 4,200 dead rows per
--    run). Links are re-pointed at the live Purchase item with the same code,
--    or cleared when there is none.
-- 3. Sheet-imported movements get a stable content identity (source_key) in
--    place of the row number, so inserting or deleting a sheet row can no
--    longer duplicate or orphan a movement; a movement that disappears from
--    the sheet is REVERSED with a reason, never deleted.
-- 4. Quarantine keeps one open entry per problem row (it used to add a new row
--    on every sync) and closes entries once the sheet is corrected.
-- 5. Each sync run records a per-tab reconciliation report.
-- 6. Inventory items carry the sheet's own opening/adjustment figures and the
--    per-item proof: opening + inward − outward + adjustments = live stock.
-- 7. The stock ledger accepts the inventory-module and sheet-alignment entry
--    types, so every change to items.live_stock_qty can be ledgered under its
--    real name instead of being mislabelled GRN_INWARD / DIRECT_ISSUE.
-- ============================================================================

-- ── 1. Role grants ──────────────────────────────────────────────────────────
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r
  JOIN permissions p ON (r.code, p.code) IN (VALUES
    ('PURCHASE_HEAD', 'inventory.view'), ('PURCHASE_HEAD', 'inventory.export'),
    ('PURCHASE_USER', 'inventory.view'),
    ('STORE_USER', 'inventory.view'), ('STORE_USER', 'inventory.adjust'), ('STORE_USER', 'inventory.export'),
    ('STORE_USER', 'direct_issue.view'), ('STORE_USER', 'direct_issue.create'),
    ('STORE_USER', 'direct_issue.print'), ('STORE_USER', 'direct_issue.export'),
    ('MANAGEMENT', 'inventory.view'), ('MANAGEMENT', 'inventory.export'),
    ('MANAGEMENT', 'direct_issue.view'), ('MANAGEMENT', 'direct_issue.print'), ('MANAGEMENT', 'direct_issue.export')
  )
ON CONFLICT DO NOTHING;

-- ── 2. Inventory no longer writes into the Purchase item master ─────────────
ALTER TABLE inventory_items ALTER COLUMN item_id DROP NOT NULL;
ALTER TABLE inventory_transactions ALTER COLUMN item_id DROP NOT NULL;

UPDATE inventory_items ii
   SET item_id = (SELECT i.id FROM items i
                   WHERE upper(i.item_code) = upper(ii.item_code) AND i.deleted_at IS NULL
                   ORDER BY i.id LIMIT 1)
 WHERE ii.item_id IS NULL
    OR EXISTS (SELECT 1 FROM items d WHERE d.id = ii.item_id AND d.deleted_at IS NOT NULL);

UPDATE inventory_transactions t
   SET item_id = (SELECT i.id FROM items i
                   WHERE upper(i.item_code) = upper(t.item_code) AND i.deleted_at IS NULL
                   ORDER BY i.id LIMIT 1)
 WHERE t.item_id IS NULL
    OR EXISTS (SELECT 1 FROM items d WHERE d.id = t.item_id AND d.deleted_at IS NOT NULL);

-- ── 3. Stable identity for sheet-imported movements ─────────────────────────
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS origin TEXT NOT NULL DEFAULT 'ERP';
UPDATE inventory_transactions SET origin = 'SHEET' WHERE txn_no LIKE 'GS-%';
ALTER TABLE inventory_transactions DROP CONSTRAINT IF EXISTS chk_inv_txn_origin;
ALTER TABLE inventory_transactions ADD CONSTRAINT chk_inv_txn_origin CHECK (origin IN ('SHEET', 'ERP'));
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_attr_hash TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_month TEXT;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS source_seen_at TIMESTAMPTZ;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reversal_reason TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_txn_source_key
  ON inventory_transactions (category, source_tab, source_key)
  WHERE source_key IS NOT NULL AND status = 'POSTED';
CREATE INDEX IF NOT EXISTS idx_inv_txn_cat_tab_status ON inventory_transactions (category, source_tab, status);

-- ── 4. Quarantine: one open entry per problem, closed when fixed ────────────
ALTER TABLE inventory_quarantine ADD COLUMN IF NOT EXISTS source_key TEXT;
ALTER TABLE inventory_quarantine ADD COLUMN IF NOT EXISTS reason_code TEXT;
ALTER TABLE inventory_quarantine ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
ALTER TABLE inventory_quarantine ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE inventory_quarantine ADD COLUMN IF NOT EXISTS resolution_note TEXT;

-- Earlier runs re-inserted the same problem row on every sync. Keep the newest
-- open entry per (category, tab, row, reason); close the copies with a note.
UPDATE inventory_quarantine q
   SET resolution_status = 'RESOLVED',
       resolved_at = now(),
       resolution_note = 'Duplicate of quarantine entry #' || k.keep_id
                         || ' (the same sheet row was quarantined again by a later sync run).'
  FROM (SELECT category, source_tab, source_row_index, quarantine_reason, MAX(id) AS keep_id
          FROM inventory_quarantine
         WHERE resolution_status = 'PENDING'
         GROUP BY category, source_tab, source_row_index, quarantine_reason
        HAVING COUNT(*) > 1) k
 WHERE q.resolution_status = 'PENDING'
   AND q.category = k.category
   AND q.source_tab = k.source_tab
   AND q.source_row_index = k.source_row_index
   AND q.quarantine_reason = k.quarantine_reason
   AND q.id <> k.keep_id;

CREATE UNIQUE INDEX IF NOT EXISTS uq_inv_quarantine_open
  ON inventory_quarantine (category, source_tab, source_key)
  WHERE source_key IS NOT NULL AND resolution_status = 'PENDING';

-- ── 5. Per-run reconciliation report ────────────────────────────────────────
ALTER TABLE inventory_sync_checkpoints ADD COLUMN IF NOT EXISTS run_id TEXT;
ALTER TABLE inventory_sync_checkpoints ADD COLUMN IF NOT EXISTS triggered_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE inventory_sync_checkpoints ADD COLUMN IF NOT EXISTS report JSONB;
CREATE INDEX IF NOT EXISTS idx_inv_sync_run ON inventory_sync_checkpoints (run_id);

-- ── 6. Per-item proof against the sheet ─────────────────────────────────────
-- opening_stock_qty so far held the live stock seen at the first sync, not the
-- sheet's opening balance; the next sync re-reads it from the sheet.
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sheet_adjustment_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS sheet_row_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS computed_stock_qty NUMERIC(18, 4);
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS recon_status TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS recon_note TEXT;
ALTER TABLE inventory_items ADD COLUMN IF NOT EXISTS recon_checked_at TIMESTAMPTZ;

-- ── 7. Stock-ledger entry types ─────────────────────────────────────────────
ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS chk_stock_ledger_type;
ALTER TABLE stock_ledger ADD CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN (
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
  'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT',
  'INVENTORY_IN', 'INVENTORY_OUT', 'INVENTORY_ADJUST', 'SHEET_SYNC'
));
