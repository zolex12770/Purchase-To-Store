-- ============================================================================
-- 010_grn_reconstruction — GRN becomes a real Store/Goods-Receipt module
--
-- Until now every GRN was forced through exactly one PO (`grn_headers.po_id`
-- NOT NULL, every `grn_lines.po_line_id` NOT NULL). This migration makes both
-- columns NULLABLE so a single GRN can:
--   • span MULTIPLE purchase orders (one line per po_line_id, each line still
--     traceable to its own PO — no new junction table needed, po_line_id
--     already carries that trace),
--   • or receive goods with NO purchase order at all ("Direct GRN": po_line_id
--     stays NULL, item_id carries the receipt instead).
--
-- `grn_headers.po_id` is KEPT as a convenience column — populated with the
-- single PO when a GRN's lines all belong to one PO (still the common case),
-- left NULL when a GRN spans several POs or is a Direct GRN. No query may
-- treat it as the complete picture of what a GRN received; the authoritative
-- trace is always grn_lines.po_line_id -> purchase_order_lines.po_id.
--
-- Additive and backward-compatible: every existing GRN already has exactly
-- one po_id and every line already has a po_line_id, so nothing already
-- stored changes meaning.
-- ============================================================================

-- ── Relax the single-PO constraint ──────────────────────────────────────────
ALTER TABLE grn_headers ALTER COLUMN po_id DROP NOT NULL;
ALTER TABLE grn_lines   ALTER COLUMN po_line_id DROP NOT NULL;

-- ── New lookup categories: GRN Type, Packing Type, Location ────────────────
-- Same one-table-many-categories pattern as PO_TYPE/INDENT_TYPE (ADR-014) —
-- admin-manageable via the existing generic Lookups screen, and Google-Sheet
-- syncable via the existing lookups:<CATEGORY> mapping mechanism if a sheet
-- for them is ever supplied. No values are seeded here (SRS: never fabricate
-- master data) — an administrator or the sheet sync populates them.
ALTER TABLE lookups DROP CONSTRAINT chk_lookups_category;
ALTER TABLE lookups ADD CONSTRAINT chk_lookups_category CHECK (category IN (
  'DEPARTMENT', 'COST_CENTRE', 'ITEM_TYPE', 'MAIN_GROUP', 'SUB_MAIN_GROUP',
  'UOM', 'INDENT_TYPE', 'PO_TYPE', 'CURRENCY', 'PAYMENT_TERMS', 'STATE', 'CITY',
  'GRN_TYPE', 'PACKING_TYPE', 'LOCATION'
));

-- ── GRN header: transport / invoice / classification fields ────────────────
-- challan_no, challan_date and vehicle_no already exist (003_transactions.sql)
-- and keep their meaning unchanged.
ALTER TABLE grn_headers
  ADD COLUMN IF NOT EXISTS grn_type_id      BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  ADD COLUMN IF NOT EXISTS invoice_no       TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invoice_date     DATE,
  ADD COLUMN IF NOT EXISTS transporter_name TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS driver_name      TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lr_no            TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS lr_date          DATE;

CREATE INDEX IF NOT EXISTS idx_grn_type ON grn_headers (grn_type_id);

-- ── GRN lines: item snapshot + store/receiving detail ───────────────────────
-- receipt_location (Set B, migration 007) is reused as "Location" — fed by
-- the new LOCATION lookup in the UI, stored as free text exactly like
-- suppliers.payment_terms/currency_code already are (ADR-006 pattern: a
-- lookup-driven picker over a plain text column, not a new FK per line).
ALTER TABLE grn_lines
  ADD COLUMN IF NOT EXISTS item_specification TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS invoice_qty         NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS batch_no            TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS package_count       NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS packing_type        TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS expiry_date         DATE,
  ADD COLUMN IF NOT EXISTS label_count         NUMERIC(18, 4),
  ADD COLUMN IF NOT EXISTS label_qty           NUMERIC(18, 4);

ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_invoice_qty_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_invoice_qty_nonneg CHECK (invoice_qty IS NULL OR invoice_qty >= 0);
ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_package_count_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_package_count_nonneg CHECK (package_count IS NULL OR package_count >= 0);
ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_label_count_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_label_count_nonneg CHECK (label_count IS NULL OR label_count >= 0);
ALTER TABLE grn_lines DROP CONSTRAINT IF EXISTS chk_grn_label_qty_nonneg;
ALTER TABLE grn_lines ADD CONSTRAINT chk_grn_label_qty_nonneg CHECK (label_qty IS NULL OR label_qty >= 0);

-- Backfill the new item_specification snapshot for existing rows from the
-- current Item Master, so history already has a value rather than starting
-- blank (future GRNs snapshot it at insert time, same discipline as
-- item_code/item_description already follow — SRS §34: an edit to the Item
-- Master must never rewrite a past document, so this is a one-time backfill,
-- not a live join).
UPDATE grn_lines gl
   SET item_specification = COALESCE(i.item_specification, '')
  FROM items i
 WHERE i.id = gl.item_id AND gl.item_specification = '';

CREATE INDEX IF NOT EXISTS idx_grn_lines_batch ON grn_lines (batch_no) WHERE batch_no <> '';

-- ============================================================================
-- Balance views are UNCHANGED by this migration. v_po_line_balance's
-- "received_qty" subquery already groups by grn_lines.po_line_id; a Direct
-- GRN's lines simply carry NULL there and are naturally excluded (NULL never
-- matches a real purchase_order_lines.id), so no view edit is needed for
-- Direct GRN to be safe. Multi-PO GRN needs no view change either — each line
-- still resolves its own po_line_id independently.
-- ============================================================================
