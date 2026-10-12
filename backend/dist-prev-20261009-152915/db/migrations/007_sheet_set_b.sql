-- ============================================================================
-- 007 — Google Sheets "Set B" column support
--
-- A second Google Sheets specification (business-supplied, distinct from the
-- SRS-aligned "Set A" this schema originally implemented — see
-- docs/FINAL_GAP_AUDIT.md §4) asks for stock-planning fields on Item Master, a
-- Pin Code on Supplier Master, and separate accepted/rejected quantities on
-- GRN. The business decision to adopt Set B was made explicitly; this
-- migration adds the columns Set B needs without removing or renaming
-- anything Set A already relies on (both specs' fields now coexist).
--
-- Additive and non-destructive: no existing column, constraint or row value
-- is changed, so this is safe to apply to a populated database.
-- ============================================================================

-- ── Item Master: stock-planning fields (Set B) ──────────────────────────────
ALTER TABLE items ADD COLUMN IF NOT EXISTS min_stock   NUMERIC(18, 4);
ALTER TABLE items ADD COLUMN IF NOT EXISTS max_stock   NUMERIC(18, 4);
ALTER TABLE items ADD COLUMN IF NOT EXISTS reorder_qty NUMERIC(18, 4);
ALTER TABLE items ADD COLUMN IF NOT EXISTS gst_rate    NUMERIC(6, 2);

ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_min_stock;
ALTER TABLE items ADD CONSTRAINT chk_items_min_stock CHECK (min_stock IS NULL OR min_stock >= 0);
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_max_stock;
ALTER TABLE items ADD CONSTRAINT chk_items_max_stock CHECK (max_stock IS NULL OR max_stock >= 0);
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_reorder_qty;
ALTER TABLE items ADD CONSTRAINT chk_items_reorder_qty CHECK (reorder_qty IS NULL OR reorder_qty >= 0);
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_gst_rate;
ALTER TABLE items ADD CONSTRAINT chk_items_gst_rate CHECK (gst_rate IS NULL OR (gst_rate >= 0 AND gst_rate <= 100));

-- ── Supplier Master: Pin Code (Set B) ────────────────────────────────────────
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS pin_code TEXT NOT NULL DEFAULT '';

-- ── GRN lines: accepted / rejected split + receipt location (Set B) ─────────
-- `grn_qty` keeps its existing meaning everywhere it is already read (stock
-- balance, pending-PO, analytics) — changing that meaning is a business-rule
-- decision this migration does not make. `accepted_qty` / `rejected_qty` are
-- new, purely additive detail: when both are supplied they must sum to
-- `grn_qty`. Unset (NULL) means "not split" and is fully backward compatible.
ALTER TABLE grn_lines ADD COLUMN IF NOT EXISTS accepted_qty     NUMERIC(18, 4);
ALTER TABLE grn_lines ADD COLUMN IF NOT EXISTS rejected_qty     NUMERIC(18, 4);
ALTER TABLE grn_lines ADD COLUMN IF NOT EXISTS receipt_location TEXT NOT NULL DEFAULT '';

ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_accepted_rejected;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_accepted_rejected CHECK (
  accepted_qty IS NULL OR rejected_qty IS NULL
  OR round(accepted_qty + rejected_qty, 4) = round(grn_qty, 4)
);
ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_accepted_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_accepted_nonneg CHECK (accepted_qty IS NULL OR accepted_qty >= 0);
ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_rejected_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_rejected_nonneg CHECK (rejected_qty IS NULL OR rejected_qty >= 0);
