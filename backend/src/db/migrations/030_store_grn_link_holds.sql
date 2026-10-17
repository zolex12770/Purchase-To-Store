-- ============================================================================
-- 030 — Store receipts the GRN link repair held back
--
-- Additive only. No row is changed or deleted.
--
-- The store's GRNs were imported on 2026-10-14 from the business sheet's GRN
-- tab before their POs existed; the PO register followed on 2026-10-16 (1,823
-- POs, 5,147 lines) and 2,000 of 2,003 POs showed OPEN with Rs 79.50 Cr
-- pending. The link repair (POST /admin/data-management/repair/link-store-grns,
-- store-grn-links.ts) links a POSTED store GRN line to a PO line only on
-- unambiguous tab evidence. On the 2026-10-17 copy it links 3,752 lines and
-- holds 2,642, each with its reason, but nothing kept the held lines: once
-- applied, a PO whose store receipt was held looked exactly like a PO nothing
-- was received against.
--
-- store_grn_link_holds is that list, as the last apply recorded it (each apply
-- replaces it whole) plus the links an undo took back since (reason UNDONE).
-- One row per PO the tab names for the receipt, so a line whose rows name two
-- POs gives two rows; po_id is the ERP PO when the number is in the ERP, and
-- po_line_id the PO line when the plan settled on one. It is evidence only:
-- nothing here links anything. A PO has a store receipt awaiting link while a
-- row names it whose GRN line still has no PO line and whose GRN is POSTED
-- (purchase-order/receipt-evidence.ts).
--
-- A PO deleted from the ERP leaves its rows in place with po_id cleared: the row
-- keeps the PO number the tab names, so the receipt then counts as one naming a
-- PO the ERP does not hold, instead of silently dropping out of every count.
--
-- The reasons are store-grn-links.ts HOLD_REASONS, plus UNDONE.
-- ============================================================================

CREATE TABLE IF NOT EXISTS store_grn_link_holds (
  id           BIGSERIAL      PRIMARY KEY,
  run_id       TEXT           NOT NULL,
  recorded_at  TIMESTAMPTZ    NOT NULL DEFAULT now(),
  grn_line_id  BIGINT         NOT NULL REFERENCES grn_lines (id) ON DELETE CASCADE,
  grn_id       BIGINT         NOT NULL REFERENCES grn_headers (id) ON DELETE CASCADE,
  grn_no       TEXT           NOT NULL,
  item_code    TEXT           NOT NULL,
  grn_qty      NUMERIC(18, 4) NOT NULL,
  po_id        BIGINT         REFERENCES purchase_order_headers (id) ON DELETE SET NULL,
  po_line_id   BIGINT         REFERENCES purchase_order_lines (id) ON DELETE SET NULL,
  po_no        TEXT,
  reason       TEXT           NOT NULL,
  detail       TEXT           NOT NULL DEFAULT '',
  CONSTRAINT chk_store_grn_link_hold_reason CHECK (reason IN (
    'EXCLUDED', 'NOT_ON_TAB', 'NO_PO_NAMED', 'SEVERAL_POS', 'PO_NOT_IN_ERP', 'PO_NOT_RECEIVABLE',
    'ITEM_NOT_ON_PO', 'SEVERAL_PO_LINES', 'SUPPLIER_MISMATCH', 'PO_AFTER_RECEIPT', 'OVER_RECEIPT',
    'GRN_PARTLY_HELD', 'UNDONE'
  ))
);

CREATE INDEX IF NOT EXISTS idx_store_grn_link_holds_po ON store_grn_link_holds (po_id);
CREATE INDEX IF NOT EXISTS idx_store_grn_link_holds_grn_line ON store_grn_link_holds (grn_line_id);
-- The other two foreign keys act on delete: a GRN or a PO line deleted must not scan the table.
CREATE INDEX IF NOT EXISTS idx_store_grn_link_holds_grn ON store_grn_link_holds (grn_id);
CREATE INDEX IF NOT EXISTS idx_store_grn_link_holds_po_line ON store_grn_link_holds (po_line_id);
