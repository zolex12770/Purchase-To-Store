-- ============================================================================
-- 005_balance_views — THE authoritative quantity definitions (ADR-005)
-- SRS §11.3, §12, §20, §34, §38
--
-- Every consumer reads these views: operational screens, server-side validation,
-- and the analytics engine. That is what makes dashboard figures reconcile with
-- transaction lists by construction rather than by coincidence
-- ("analytics must use the same authoritative transaction definitions as
--  operational screens" — SRS §34).
--
-- No other query in the codebase may re-derive `pending_qty` or `pending_grn_qty`.
-- ============================================================================

-- ── Indent line balance ─────────────────────────────────────────────────────
--   ordered_qty = Σ consumed_qty of every PO source referencing this indent line,
--                 excluding CANCELLED POs (a cancelled PO releases its claim).
--                 DRAFT POs DO hold their claim, so two users cannot draft POs
--                 against the same quantity.
--   pending_qty = indent_qty − ordered_qty, floored at zero.
CREATE VIEW v_indent_line_balance AS
SELECT
    il.id                              AS indent_line_id,
    il.indent_id,
    ih.indent_no,
    ih.indent_date,
    ih.status                          AS indent_status,
    ih.indent_type_id,
    ih.suggested_supplier_id,
    ih.requested_by_user_id,
    il.line_no,
    il.item_id,
    il.item_code,
    il.item_description,
    il.uom_id,
    il.item_specification,
    COALESCE(il.department_id, ih.department_id)   AS department_id,
    COALESCE(il.cost_centre_id, ih.cost_centre_id) AS cost_centre_id,
    il.estimated_rate,
    il.required_by_date,
    il.is_closed,
    il.indent_qty,
    COALESCE(src.ordered_qty, 0)::NUMERIC(18, 4)   AS ordered_qty,
    GREATEST(il.indent_qty - COALESCE(src.ordered_qty, 0), 0)::NUMERIC(18, 4) AS pending_qty,
    -- Eligible to be pulled onto a Purchase Order (SRS §11.1, §11.3)
    (ih.status = 'APPROVED'
       AND il.is_closed = FALSE
       AND (il.indent_qty - COALESCE(src.ordered_qty, 0)) > 0)                AS is_eligible_for_po,
    CASE
      WHEN il.is_closed                                        THEN 'CLOSED'
      WHEN COALESCE(src.ordered_qty, 0) <= 0                   THEN 'OPEN'
      WHEN COALESCE(src.ordered_qty, 0) >= il.indent_qty       THEN 'FULLY_ORDERED'
      ELSE 'PARTIALLY_ORDERED'
    END                                                                       AS line_status,
    (il.indent_qty * COALESCE(il.estimated_rate, 0))::NUMERIC(18, 2)          AS estimated_value
FROM purchase_indent_lines il
JOIN purchase_indent_headers ih ON ih.id = il.indent_id
LEFT JOIN (
    SELECT pis.indent_line_id, SUM(pis.consumed_qty) AS ordered_qty
    FROM po_indent_sources pis
    JOIN purchase_order_lines pol ON pol.id = pis.po_line_id
    JOIN purchase_order_headers poh ON poh.id = pol.po_id
    WHERE poh.status <> 'CANCELLED'
    GROUP BY pis.indent_line_id
) src ON src.indent_line_id = il.id;

-- ── Indent header rollup ────────────────────────────────────────────────────
CREATE VIEW v_indent_header_balance AS
SELECT
    ih.id                                             AS indent_id,
    ih.indent_no,
    ih.status,
    ih.indent_date,
    COUNT(b.indent_line_id)::INT                      AS line_count,
    COALESCE(SUM(b.indent_qty), 0)::NUMERIC(18, 4)    AS total_indent_qty,
    COALESCE(SUM(b.ordered_qty), 0)::NUMERIC(18, 4)   AS total_ordered_qty,
    COALESCE(SUM(b.pending_qty), 0)::NUMERIC(18, 4)   AS total_pending_qty,
    COALESCE(SUM(b.estimated_value), 0)::NUMERIC(18, 2) AS total_estimated_value,
    COUNT(*) FILTER (WHERE b.is_eligible_for_po)::INT AS eligible_line_count
FROM purchase_indent_headers ih
LEFT JOIN v_indent_line_balance b ON b.indent_id = ih.id
GROUP BY ih.id, ih.indent_no, ih.status, ih.indent_date;

-- ── PO line balance ─────────────────────────────────────────────────────────
--   received_qty     = Σ grn_qty of POSTED GRN lines only (a DRAFT GRN receives nothing).
--   pending_grn_qty  = po_qty − received_qty, floored at zero.
CREATE VIEW v_po_line_balance AS
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
    -- Value split so "pending exposure" analytics need no extra arithmetic
    round(COALESCE(g.received_qty, 0) * pol.final_rate, 2)::NUMERIC(18, 2) AS received_amount,
    round(GREATEST(pol.po_qty - COALESCE(g.received_qty, 0), 0) * pol.final_rate, 2)::NUMERIC(18, 2)
                                                                           AS pending_amount,
    -- Receivable right now: a cancelled PO or a closed line accepts no further receipt
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
    (CURRENT_DATE - poh.po_date)::INT                                      AS age_days
FROM purchase_order_lines pol
JOIN purchase_order_headers poh ON poh.id = pol.po_id
LEFT JOIN (
    SELECT gl.po_line_id, SUM(gl.grn_qty) AS received_qty
    FROM grn_lines gl
    JOIN grn_headers gh ON gh.id = gl.grn_id
    WHERE gh.status = 'POSTED'
    GROUP BY gl.po_line_id
) g ON g.po_line_id = pol.id;

-- ── PO header rollup ────────────────────────────────────────────────────────
--   `derived_status` is what ADR-003 says the status OUGHT to be given the receipts.
--   Services recompute and persist header status from this after every GRN post;
--   a mismatch between `status` and `derived_status` is therefore a data-integrity
--   alarm, and the reconciliation test asserts it is always empty.
CREATE VIEW v_po_header_balance AS
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
    (CURRENT_DATE - poh.po_date)::INT                   AS age_days
FROM purchase_order_headers poh
LEFT JOIN v_po_line_balance b ON b.po_id = poh.id
GROUP BY poh.id, poh.po_no, poh.po_date, poh.status, poh.supplier_id,
         poh.po_type_id, poh.source_mode, poh.currency_code;

-- ── Flattened PO-line → source-indent trace (SRS §11.3 drill-down) ──────────
CREATE VIEW v_po_line_sources AS
SELECT
    pis.id            AS source_id,
    pis.po_line_id,
    pol.po_id,
    poh.po_no,
    pol.line_no       AS po_line_no,
    pis.consumed_qty,
    pis.indent_line_id,
    pis.indent_id,
    ih.indent_no,
    ih.indent_date,
    ih.indent_type_id,
    il.line_no        AS indent_line_no,
    il.indent_qty,
    il.item_code,
    il.item_description
FROM po_indent_sources pis
JOIN purchase_order_lines pol   ON pol.id = pis.po_line_id
JOIN purchase_order_headers poh ON poh.id = pol.po_id
JOIN purchase_indent_lines il   ON il.id  = pis.indent_line_id
JOIN purchase_indent_headers ih ON ih.id  = pis.indent_id;
