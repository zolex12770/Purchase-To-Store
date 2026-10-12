-- ============================================================================
-- 013 — CORRECTION: PO Type is restored as a real, separate, user-facing
-- field. Migration 011's own header comment says PO Type was being retired —
-- that decision was reversed by an explicit later business decision before
-- it ever reached this environment's live use, so 011's prose is superseded
-- by this file, not edited (editing an already-applied migration's checksum
-- is refused by the migration runner by design — see db/migrate.ts).
--
-- Final architecture: THREE separate classification fields —
--   purchase_indent_headers.indent_type_id
--   purchase_order_headers.po_type_id      (never dropped — 011 only stopped
--                                            the application layer from
--                                            reading/writing it; the column
--                                            itself was always intact)
--   grn_headers.grn_type_id                (added in 012)
-- — each independently selectable per document, but all three now draw their
-- dropdown OPTIONS from the SAME lookup category (INDENT_TYPE — already
-- real, already populated, already working for Indent) instead of three
-- separate lists that could silently drift apart. No new category, no data
-- copy, no risk to the Indent module, which is untouched: the application
-- layer simply points the PO Type and GRN Type selectors at the same
-- category Indent Type already uses, while each document keeps storing its
-- own choice in its own column.
--
-- This migration itself only re-applies the balance-view column addition
-- that 011 originally carried (indent_type_id on v_po_line_balance /
-- v_po_header_balance) — that addition is still correct and still wanted.
-- po_type_id was already present on both views before 011 and needs no
-- change. No new lookup category or seed data is introduced.
-- ============================================================================

CREATE OR REPLACE VIEW v_po_line_balance AS
SELECT
    pol.id                              AS po_line_id,
    pol.po_id,
    poh.po_no,
    poh.po_date,
    poh.status                          AS po_status,
    poh.po_type_id,
    poh.supplier_id,
    poh.currency_code,
    poh.source_mode,
    pol.line_no,
    pol.item_id,
    pol.item_code,
    pol.item_description,
    pol.uom_id,
    pol.item_specification,
    pol.rate,
    pol.discount_pct,
    pol.final_rate,
    pol.amount,
    pol.po_qty,
    pol.is_closed,
    pol.delivery_date,
    COALESCE(g.received_qty, 0)::NUMERIC(18, 4)                            AS received_qty,
    GREATEST(pol.po_qty - COALESCE(g.received_qty, 0), 0)::NUMERIC(18, 4)  AS pending_grn_qty,
    round(COALESCE(g.received_qty, 0) * pol.final_rate, 2)::NUMERIC(18, 2) AS received_amount,
    round(GREATEST(pol.po_qty - COALESCE(g.received_qty, 0), 0) * pol.final_rate, 2)::NUMERIC(18, 2)
                                                                           AS pending_amount,
    (poh.status NOT IN ('CANCELLED', 'SHORT_CLOSED')
       AND pol.is_closed = FALSE
       AND (pol.po_qty - COALESCE(g.received_qty, 0)) > 0)                 AS is_receivable,
    CASE
      WHEN pol.is_closed                                          THEN 'CLOSED'
      WHEN COALESCE(g.received_qty, 0) <= 0                       THEN 'AWAITING_RECEIPT'
      WHEN COALESCE(g.received_qty, 0) >= pol.po_qty              THEN 'COMPLETED'
      ELSE 'PARTIALLY_RECEIVED'
    END                                                                    AS line_status,
    (poh.po_date + INTERVAL '0 day')                                       AS ordered_on,
    (CURRENT_DATE - poh.po_date)::INT                                      AS age_days,
    pol.gst_pct,
    pol.gst_amount,
    poh.indent_type_id
FROM purchase_order_lines pol
JOIN purchase_order_headers poh ON poh.id = pol.po_id
LEFT JOIN (
    SELECT gl.po_line_id, SUM(gl.grn_qty) AS received_qty
    FROM grn_lines gl
    JOIN grn_headers gh ON gh.id = gl.grn_id
    WHERE gh.status = 'POSTED'
    GROUP BY gl.po_line_id
) g ON g.po_line_id = pol.id;

CREATE OR REPLACE VIEW v_po_header_balance AS
SELECT
    poh.id                                              AS po_id,
    poh.po_no,
    poh.po_date,
    poh.status,
    poh.supplier_id,
    poh.po_type_id,
    poh.source_mode,
    poh.currency_code,
    COUNT(b.po_line_id)::INT                            AS line_count,
    COALESCE(SUM(b.po_qty), 0)::NUMERIC(18, 4)          AS total_po_qty,
    COALESCE(SUM(b.received_qty), 0)::NUMERIC(18, 4)    AS total_received_qty,
    COALESCE(SUM(b.pending_grn_qty), 0)::NUMERIC(18, 4) AS total_pending_qty,
    COALESCE(SUM(b.amount), 0)::NUMERIC(18, 2)          AS total_amount,
    COALESCE(SUM(b.received_amount), 0)::NUMERIC(18, 2) AS received_amount,
    COALESCE(SUM(b.pending_amount), 0)::NUMERIC(18, 2)  AS pending_amount,
    COUNT(*) FILTER (WHERE b.is_receivable)::INT        AS receivable_line_count,
    CASE
      WHEN poh.status IN ('DRAFT', 'CANCELLED', 'SHORT_CLOSED') THEN poh.status
      WHEN COALESCE(SUM(b.pending_grn_qty), 0) <= 0
           AND COUNT(b.po_line_id) > 0                          THEN 'COMPLETED'
      WHEN COALESCE(SUM(b.received_qty), 0) > 0                 THEN 'PARTIALLY_RECEIVED'
      ELSE 'OPEN'
    END                                                 AS derived_status,
    (CURRENT_DATE - poh.po_date)::INT                   AS age_days,
    COALESCE(SUM(b.gst_amount), 0)::NUMERIC(18, 2)      AS total_gst_amount,
    CASE WHEN poh.discount_mode = 'PERCENTAGE'
         THEN round(COALESCE(SUM(b.amount), 0) * poh.discount_value / 100, 2)
         ELSE poh.discount_value END::NUMERIC(18, 2)    AS discount_amount,
    CASE WHEN poh.freight_mode = 'PERCENTAGE'
         THEN round(COALESCE(SUM(b.amount), 0) * poh.freight_value / 100, 2)
         ELSE poh.freight_value END::NUMERIC(18, 2)     AS freight_amount,
    CASE WHEN poh.packing_mode = 'PERCENTAGE'
         THEN round(COALESCE(SUM(b.amount), 0) * poh.packing_value / 100, 2)
         ELSE poh.packing_value END::NUMERIC(18, 2)     AS packing_amount,
    CASE WHEN poh.insurance_mode = 'PERCENTAGE'
         THEN round(COALESCE(SUM(b.amount), 0) * poh.insurance_value / 100, 2)
         ELSE poh.insurance_value END::NUMERIC(18, 2)   AS insurance_amount,
    ( COALESCE(SUM(b.amount), 0)
      + COALESCE(SUM(b.gst_amount), 0)
      - (CASE WHEN poh.discount_mode = 'PERCENTAGE'
              THEN round(COALESCE(SUM(b.amount), 0) * poh.discount_value / 100, 2)
              ELSE poh.discount_value END)
      + (CASE WHEN poh.freight_mode = 'PERCENTAGE'
              THEN round(COALESCE(SUM(b.amount), 0) * poh.freight_value / 100, 2)
              ELSE poh.freight_value END)
      + (CASE WHEN poh.packing_mode = 'PERCENTAGE'
              THEN round(COALESCE(SUM(b.amount), 0) * poh.packing_value / 100, 2)
              ELSE poh.packing_value END)
      + (CASE WHEN poh.insurance_mode = 'PERCENTAGE'
              THEN round(COALESCE(SUM(b.amount), 0) * poh.insurance_value / 100, 2)
              ELSE poh.insurance_value END)
    )::NUMERIC(18, 2)                                   AS grand_total,
    poh.indent_type_id
FROM purchase_order_headers poh
LEFT JOIN v_po_line_balance b ON b.po_id = poh.id
GROUP BY poh.id, poh.po_no, poh.po_date, poh.status, poh.supplier_id,
         poh.po_type_id, poh.source_mode, poh.currency_code,
         poh.discount_mode, poh.discount_value, poh.freight_mode, poh.freight_value,
         poh.packing_mode, poh.packing_value, poh.insurance_mode, poh.insurance_value,
         poh.indent_type_id;
