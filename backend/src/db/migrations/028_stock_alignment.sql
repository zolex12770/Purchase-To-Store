-- ============================================================================
-- 028 — One-time stock-ledger alignment
--
-- Additive only. No row is changed or deleted.
--
-- Until 2026-10-16 the inventory sync wrote the Google Sheet figures into
-- items.live_stock_qty with no ledger row, so on the 07:15 UTC snapshot 2,769
-- items' stock ledgers no longer explained their stock (audit SLR-1/SLR-2). The
-- alignment (POST /admin/data-management/repair/stock-alignment) closes each
-- gap with ledger rows taken from evidence — the sheet's opening cell, sheet
-- movement rows, existing ledger rows — and never changes live_stock_qty.
--
-- 1. STOCK_ALIGNMENT: its own entry type, so an alignment row is never mistaken
--    for a sheet sync, a receipt or an issue. The list is 026's, plus this one.
-- 2. remarks: the evidence a row stands for, e.g.
--    'Opening 2026-04-01 - General Item Live Stock!BI1088'. NULL for every other
--    entry, as before.
-- ============================================================================

ALTER TABLE stock_ledger ADD COLUMN IF NOT EXISTS remarks TEXT;

ALTER TABLE stock_ledger DROP CONSTRAINT IF EXISTS chk_stock_ledger_type;
ALTER TABLE stock_ledger ADD CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN (
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
  'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT', 'STOCK_ADJUSTMENT_REVERSAL',
  'INVENTORY_IN', 'INVENTORY_OUT', 'INVENTORY_ADJUST', 'INVENTORY_REVERSAL', 'SHEET_SYNC',
  'STOCK_ALIGNMENT'
));
