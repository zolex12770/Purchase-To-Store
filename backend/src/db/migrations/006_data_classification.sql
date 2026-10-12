-- ============================================================================
-- 006 — Data classification
--
-- Production hardening requires that every business row can be classified as
-- real, demo, test or imported BEFORE anything is deleted. Until now demo rows
-- were identifiable only by convention (a '[DEMO]' prefix in a free-text field),
-- which is fragile: a user may legitimately type "[DEMO]" into remarks, and
-- `items` / `users` carried no marker at all.
--
-- This migration replaces the convention with an explicit, indexed column.
--
-- `seed_tag` values:
--   NULL     — ordinary data entered through the application (treated as REAL)
--   'demo'   — created by `seedDemoData()`; safe to purge
--   'test'   — created by an automated test fixture; safe to purge
--   'import' — created by a bulk import or Google Sheets sync
--
-- Additive and non-destructive: no existing column, constraint or row value is
-- changed, so the migration is safe to apply to a populated database.
-- ============================================================================

ALTER TABLE items                    ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE suppliers                ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE users                    ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE lookups                  ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE purchase_indent_headers  ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE purchase_order_headers   ADD COLUMN IF NOT EXISTS seed_tag TEXT;
ALTER TABLE grn_headers              ADD COLUMN IF NOT EXISTS seed_tag TEXT;

-- Only non-real rows are ever filtered on, so partial indexes stay tiny and the
-- common case (seed_tag IS NULL) costs nothing.
CREATE INDEX IF NOT EXISTS ix_items_seed_tag     ON items (seed_tag)                   WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_suppliers_seed_tag ON suppliers (seed_tag)               WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_users_seed_tag     ON users (seed_tag)                   WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_lookups_seed_tag   ON lookups (seed_tag)                 WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_indent_seed_tag    ON purchase_indent_headers (seed_tag) WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_po_seed_tag        ON purchase_order_headers (seed_tag)  WHERE seed_tag IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_grn_seed_tag       ON grn_headers (seed_tag)             WHERE seed_tag IS NOT NULL;

-- ── Backfill from the markers that already exist ────────────────────────────
-- Applied only where a marker is genuinely reliable. Rows that cannot be proven
-- to be demo data are deliberately left NULL: the purification tool reports them
-- as UNKNOWN for a human decision rather than guessing and deleting real data.

UPDATE purchase_indent_headers SET seed_tag = 'demo' WHERE seed_tag IS NULL AND remarks LIKE '[DEMO]%';
UPDATE purchase_order_headers  SET seed_tag = 'demo' WHERE seed_tag IS NULL AND remarks LIKE '[DEMO]%';
UPDATE grn_headers             SET seed_tag = 'demo' WHERE seed_tag IS NULL AND remarks LIKE '[DEMO]%';
UPDATE suppliers               SET seed_tag = 'demo' WHERE seed_tag IS NULL AND notes   LIKE '[DEMO]%';
UPDATE lookups                 SET seed_tag = 'demo' WHERE seed_tag IS NULL AND extra->>'seed' = 'demo';

-- An item or user that only ever appears on demo documents was created by the
-- demo seed. This is provable from the data itself rather than assumed: the row
-- must be referenced by at least one demo document and by no other document.

UPDATE items i SET seed_tag = 'demo'
 WHERE i.seed_tag IS NULL
   AND EXISTS (
     SELECT 1 FROM purchase_indent_lines l
       JOIN purchase_indent_headers h ON h.id = l.indent_id
      WHERE l.item_id = i.id AND h.seed_tag = 'demo')
   AND NOT EXISTS (
     SELECT 1 FROM purchase_indent_lines l
       JOIN purchase_indent_headers h ON h.id = l.indent_id
      WHERE l.item_id = i.id AND h.seed_tag IS DISTINCT FROM 'demo')
   AND NOT EXISTS (
     SELECT 1 FROM purchase_order_lines l
       JOIN purchase_order_headers h ON h.id = l.po_id
      WHERE l.item_id = i.id AND h.seed_tag IS DISTINCT FROM 'demo');

UPDATE users u SET seed_tag = 'demo'
 WHERE u.seed_tag IS NULL
   AND u.employee_id NOT IN ('10221', '10422')   -- bootstrap admins are never demo
   AND EXISTS (
     SELECT 1 FROM purchase_indent_headers h
      WHERE h.seed_tag = 'demo' AND (h.created_by = u.id OR h.requested_by_user_id = u.id))
   AND NOT EXISTS (
     SELECT 1 FROM purchase_indent_headers h
      WHERE h.seed_tag IS DISTINCT FROM 'demo' AND (h.created_by = u.id OR h.requested_by_user_id = u.id))
   AND NOT EXISTS (
     SELECT 1 FROM purchase_order_headers h
      WHERE h.seed_tag IS DISTINCT FROM 'demo' AND h.created_by = u.id);
