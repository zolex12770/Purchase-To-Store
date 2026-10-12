-- ============================================================================
-- 011 — Retire "PO Type" as a duplicate classification; "Indent Type" is now
-- the single authoritative classification field across Indent, PO and GRN.
--
-- `purchase_order_headers.po_type_id` and the `PO_TYPE` lookup category are
-- NOT dropped — every existing PO still legitimately references a PO_TYPE row,
-- and dropping either would break historical referential integrity. Instead:
--   • `indent_type_id` is added to purchase_order_headers and grn_headers.
--   • Existing POs are backfilled from their originating indent's
--     indent_type_id where traceable (SRS §11.3 — po_indent_sources already
--     gives this for free); a Direct PO with no indent source is backfilled
--     by matching its po_type's NAME against an existing indent_type NAME
--     (best-effort; left NULL when no honest match exists — never guessed).
--   • The application layer (routes, forms, filters, reports) stops reading
--     or writing po_type_id from here on; only indent_type_id is exposed.
--   • po_type_id becomes a legacy/internal column: still there, still valid,
--     never shown as a second classification field anywhere in the product.
-- ============================================================================

ALTER TABLE purchase_order_headers
  ADD COLUMN IF NOT EXISTS indent_type_id BIGINT REFERENCES lookups (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_po_indent_type ON purchase_order_headers (indent_type_id);

ALTER TABLE grn_headers
  ADD COLUMN IF NOT EXISTS indent_type_id BIGINT REFERENCES lookups (id) ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS idx_grn_indent_type ON grn_headers (indent_type_id);

-- Backfill 1: PO built from indent line(s) — take the FIRST source indent's
-- type (a multi-indent PO's lines may technically carry different indent
-- types; the header field is a single classification, so the earliest source
-- wins deterministically rather than guessing a "combined" value).
UPDATE purchase_order_headers h
   SET indent_type_id = src.indent_type_id
  FROM (
    SELECT DISTINCT ON (pol.po_id) pol.po_id, ih.indent_type_id
      FROM po_indent_sources pis
      JOIN purchase_order_lines pol ON pol.id = pis.po_line_id
      JOIN purchase_indent_headers ih ON ih.id = pis.indent_id
     WHERE ih.indent_type_id IS NOT NULL
     ORDER BY pol.po_id, ih.indent_date, ih.id
  ) src
 WHERE src.po_id = h.id AND h.indent_type_id IS NULL;

-- Backfill 2: remaining Direct POs — match the legacy po_type's NAME against
-- an existing INDENT_TYPE lookup by name (case-insensitive). Left NULL, never
-- fabricated, when no honest match exists.
UPDATE purchase_order_headers h
   SET indent_type_id = it.id
  FROM lookups pt
  JOIN lookups it ON it.category = 'INDENT_TYPE' AND lower(it.name) = lower(pt.name) AND it.deleted_at IS NULL
 WHERE h.po_type_id = pt.id AND h.indent_type_id IS NULL;

-- GRN: PO-based GRNs inherit their PO's indent_type_id (via each line's own
-- po_line_id, same reasoning as every other multi-PO-safe join added in the
-- GRN reconstruction — the header value is a convenience for the single-PO
-- case, matching how po_id itself already behaves on this table).
UPDATE grn_headers g
   SET indent_type_id = src.indent_type_id
  FROM (
    SELECT DISTINCT ON (gl.grn_id) gl.grn_id, poh.indent_type_id
      FROM grn_lines gl
      JOIN purchase_order_lines pol ON pol.id = gl.po_line_id
      JOIN purchase_order_headers poh ON poh.id = pol.po_id
     WHERE poh.indent_type_id IS NOT NULL
     ORDER BY gl.grn_id, gl.line_no
  ) src
 WHERE src.grn_id = g.id AND g.indent_type_id IS NULL;
