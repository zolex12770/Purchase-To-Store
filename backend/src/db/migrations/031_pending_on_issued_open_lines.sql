-- ============================================================================
-- 031 — Pending is what is still to be received on an issued, open order
--
-- Views and a backfill only. No document row is changed.
--
-- v_po_line_balance computes pending_grn_qty and pending_amount as
-- po_qty - received for EVERY order, and v_po_header_balance summed them
-- unfiltered, so a short-closed order kept its outstanding quantity and value
-- on the PO screen tiles, the PO list rows, footer and tiles and the supplier
-- summary, a cancelled order its whole quantity, and a closed line its balance
-- (2026-10-17 E2E run, S2-D1). Short-closing says "Its outstanding quantity no
-- longer appears as pending". The pending KPIs, the Pending PO list and the
-- GRN picker already counted only a line still to be received on an issued,
-- open order (purchase-order/routes.ts pendingLineSql): a draft was never sent
-- to the supplier.
--
-- 1. v_po_line_balance gains open_pending_qty and open_pending_amount: the
--    line's pending_grn_qty / pending_amount while that rule holds, else 0.
--    pending_grn_qty itself stays the raw balance: the GRN quantity guards
--    (domain/quantities.ts assertGrnReceiptAllowed) check the order's status
--    and the line's closed flag first and then measure against it. The view is
--    restated from 013 with the two columns added at the end.
-- 2. v_po_header_balance totals the open figures as total_pending_qty and
--    pending_amount. derived_status keeps the raw sum, so no stored status
--    changes (recomputePoStatus, recomputePoStatuses).
-- 3. QC inspections raised before 2026-10-18 stored a blank unit; they take
--    the code of the unit they carry (grn/routes.ts receiveLines now writes it).
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
    poh.indent_type_id,
    -- Still to be received: an issued, open order (OPEN or PARTIALLY_RECEIVED), a
    -- line not closed, quantity outstanding. The same rule as pendingLineSql.
    (CASE WHEN poh.status IN ('OPEN', 'PARTIALLY_RECEIVED')
               AND pol.is_closed = FALSE
               AND (pol.po_qty - COALESCE(g.received_qty, 0)) > 0
          THEN pol.po_qty - COALESCE(g.received_qty, 0)
          ELSE 0 END)::NUMERIC(18, 4)                                      AS open_pending_qty,
    (CASE WHEN poh.status IN ('OPEN', 'PARTIALLY_RECEIVED')
               AND pol.is_closed = FALSE
               AND (pol.po_qty - COALESCE(g.received_qty, 0)) > 0
          THEN round((pol.po_qty - COALESCE(g.received_qty, 0)) * pol.final_rate, 2)
          ELSE 0 END)::NUMERIC(18, 2)                                      AS open_pending_amount
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
    COALESCE(SUM(b.open_pending_qty), 0)::NUMERIC(18, 4) AS total_pending_qty,
    COALESCE(SUM(b.amount), 0)::NUMERIC(18, 2)          AS total_amount,
    COALESCE(SUM(b.received_amount), 0)::NUMERIC(18, 2) AS received_amount,
    COALESCE(SUM(b.open_pending_amount), 0)::NUMERIC(18, 2) AS pending_amount,
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

UPDATE qc_inspections qi
   SET uom_code = u.code
  FROM lookups u
 WHERE u.id = qi.uom_id
   AND qi.uom_code = ''
   AND COALESCE(u.code, '') <> '';
