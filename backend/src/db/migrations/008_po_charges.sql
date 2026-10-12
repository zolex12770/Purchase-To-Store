-- Purchase Order charges (SRS extension): per-line GST, and PO-level Discount /
-- Freight / Packing / Insurance, each entered as EITHER a percentage OR a fixed
-- amount (mode + value), with the other side always DERIVED, never stored —
-- same "the database computes it, nothing can drift" discipline as
-- final_rate/amount in 003_transactions.sql.
--
-- GST stays PER LINE ITEM (not one PO-wide %): different items legitimately
-- carry different GST rates (HSN-dependent), so a single PO-level GST would be
-- less correct than what this migration adds, not more.
--
-- Calculation sequence (mirrored exactly in backend/src/domain/money.ts and
-- frontend/src/lib/poCalc.ts — see those files before changing this one):
--   1. line amount      = po_qty * rate * (1 - discount_pct/100)   [unchanged, 003]
--   2. line gst_amount  = round(amount * gst_pct / 100, 2)         [new]
--   3. subtotal         = SUM(line amount)
--   4. total_gst        = SUM(line gst_amount)
--   5. each PO-level charge amount:
--        mode = 'PERCENTAGE' -> round(subtotal * value / 100, 2)
--        mode = 'AMOUNT'     -> value
--   6. grand_total = subtotal + total_gst - discount_amount
--                    + freight_amount + packing_amount + insurance_amount
-- Discount reduces the settlement total (applied after tax, not the taxable
-- base) — this avoids a circular dependency where a PO-level discount would
-- change the base that per-line GST was already computed against.

ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS gst_pct NUMERIC(6, 2) NOT NULL DEFAULT 0;
ALTER TABLE purchase_order_lines
  ADD CONSTRAINT chk_po_line_gst_pct CHECK (gst_pct >= 0 AND gst_pct <= 100);
-- A generated column may not reference another generated column (`amount`),
-- so the formula is repeated in full — same reason final_rate/amount repeat
-- each other's inputs in 003_transactions.sql.
ALTER TABLE purchase_order_lines
  ADD COLUMN IF NOT EXISTS gst_amount NUMERIC(18, 2) GENERATED ALWAYS AS
    (round(po_qty * round(rate * (1 - discount_pct / 100), 4) * gst_pct / 100, 2)) STORED;

ALTER TABLE purchase_order_headers
  ADD COLUMN IF NOT EXISTS discount_mode  TEXT NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS discount_value NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS freight_mode   TEXT NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS freight_value  NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS packing_mode   TEXT NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS packing_value  NUMERIC(18, 4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS insurance_mode TEXT NOT NULL DEFAULT 'PERCENTAGE',
  ADD COLUMN IF NOT EXISTS insurance_value NUMERIC(18, 4) NOT NULL DEFAULT 0;

ALTER TABLE purchase_order_headers
  ADD CONSTRAINT chk_po_discount_mode  CHECK (discount_mode  IN ('PERCENTAGE', 'AMOUNT')),
  ADD CONSTRAINT chk_po_freight_mode   CHECK (freight_mode   IN ('PERCENTAGE', 'AMOUNT')),
  ADD CONSTRAINT chk_po_packing_mode   CHECK (packing_mode   IN ('PERCENTAGE', 'AMOUNT')),
  ADD CONSTRAINT chk_po_insurance_mode CHECK (insurance_mode IN ('PERCENTAGE', 'AMOUNT')),
  ADD CONSTRAINT chk_po_discount_value  CHECK (discount_value  >= 0),
  ADD CONSTRAINT chk_po_freight_value   CHECK (freight_value   >= 0),
  ADD CONSTRAINT chk_po_packing_value   CHECK (packing_value   >= 0),
  ADD CONSTRAINT chk_po_insurance_value CHECK (insurance_value >= 0);

-- Existing rows: default mode PERCENTAGE, value 0 -> every derived amount below
-- computes to 0, so an existing PO's grand_total equals its old total_amount
-- exactly (plus total_gst, which is also 0 for existing lines). No PO's stored
-- financial meaning changes as a result of this migration.

-- v_po_line_balance: identical to 005_balance_views.sql, only appending
-- gst_pct/gst_amount at the very end (CREATE OR REPLACE VIEW may only ever
-- append columns — every original column stays in its original position).
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
    pol.gst_amount
FROM purchase_order_lines pol
JOIN purchase_order_headers poh ON poh.id = pol.po_id
LEFT JOIN (
    SELECT gl.po_line_id, SUM(gl.grn_qty) AS received_qty
    FROM grn_lines gl
    JOIN grn_headers gh ON gh.id = gl.grn_id
    WHERE gh.status = 'POSTED'
    GROUP BY gl.po_line_id
) g ON g.po_line_id = pol.id;

-- v_po_header_balance: append the charge breakdown + grand_total.
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
    )::NUMERIC(18, 2)                                   AS grand_total
FROM purchase_order_headers poh
LEFT JOIN v_po_line_balance b ON b.po_id = poh.id
GROUP BY poh.id, poh.po_no, poh.po_date, poh.status, poh.supplier_id,
         poh.po_type_id, poh.source_mode, poh.currency_code,
         poh.discount_mode, poh.discount_value, poh.freight_mode, poh.freight_value,
         poh.packing_mode, poh.packing_value, poh.insurance_mode, poh.insurance_value;
