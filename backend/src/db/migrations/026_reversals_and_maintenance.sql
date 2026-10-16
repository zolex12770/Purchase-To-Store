-- ============================================================================
-- 026 — Supported reversals, and reclaiming dead space
--
-- Additive only. No business record is changed or deleted.
--
-- 1. Direct issues can be CANCELLED (stock returned with DIRECT_ISSUE_REVERSAL —
--    a ledger type that existed since 022 with nothing able to post it).
-- 2. Physical-count adjustments can be REVERSED (STOCK_ADJUSTMENT_REVERSAL).
-- 3. Movements entered in the ERP inventory screens can be REVERSED
--    (INVENTORY_REVERSAL); who reversed them is recorded.
--    In every case the original row stays, marked with when/who/why, and the
--    stock change is a new ledger entry — history is never edited.
-- 4. After this migration commits, migrate.ts runs VACUUM (FULL, ANALYZE) on the
--    tables the old inventory sync bloated (items 95 MB for 17k rows; on a copy
--    of production 418 MB of tables shrank to 89 MB in 3.5 s).
-- ============================================================================

-- ── 1. Direct issue cancellation ────────────────────────────────────────────
ALTER TABLE direct_issue_headers ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'ISSUED';
ALTER TABLE direct_issue_headers DROP CONSTRAINT IF EXISTS chk_direct_issue_status;
ALTER TABLE direct_issue_headers ADD CONSTRAINT chk_direct_issue_status CHECK (status IN ('ISSUED', 'CANCELLED'));
ALTER TABLE direct_issue_headers ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE direct_issue_headers ADD COLUMN IF NOT EXISTS cancelled_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE direct_issue_headers ADD COLUMN IF NOT EXISTS cancel_reason TEXT NOT NULL DEFAULT '';

-- ── 2. Physical-count adjustment reversal ───────────────────────────────────
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS reversed_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE stock_adjustments ADD COLUMN IF NOT EXISTS reversal_reason TEXT NOT NULL DEFAULT '';

-- ── 3. ERP inventory movement reversal ──────────────────────────────────────
ALTER TABLE inventory_transactions ADD COLUMN IF NOT EXISTS reversed_by BIGINT REFERENCES users (id) ON DELETE SET NULL;

-- ── Ledger entry types ──────────────────────────────────────────────────────
ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS chk_stock_ledger_type;
ALTER TABLE stock_ledger ADD CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN (
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
  'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT', 'STOCK_ADJUSTMENT_REVERSAL',
  'INVENTORY_IN', 'INVENTORY_OUT', 'INVENTORY_ADJUST', 'INVENTORY_REVERSAL', 'SHEET_SYNC'
));
