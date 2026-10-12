-- ============================================================================
-- 019 — Only enqueue a change when something actually changed
--
-- Measured on the live database before this migration: 14,477 queued changes,
-- of which 12,419 were `items`, 1,392 `suppliers` and 490 `users` — on a system
-- with 30 indents, 24 PO lines and 21 GRN lines. None of them represented an
-- edit anybody made.
--
-- They come from the INBOUND master-data sync, which re-writes every row of the
-- master sheet every 15 minutes whether or not the values differ:
--
--     UPDATE items SET item_description = $2, ..., updated_at = now() WHERE id = $1
--
-- `updated_at = now()` makes every one of those a real UPDATE, the AFTER
-- trigger fires, and 12,461 rows land in the outbox. The drain then did one
-- full Item Master query PER queued key — which is what stalled the ERP for
-- 5-20 seconds every 60 seconds and eventually killed the process.
--
-- The guard below is the general fix, at the layer that owns the problem: if
-- the only difference between OLD and NEW is bookkeeping, there is nothing a
-- business tab could display differently, so nothing is queued. (The wasteful
-- UPDATE itself is narrowed separately, in the sync engine.)
-- ============================================================================

-- Remembering the tab's numeric id and its grid height means an append does not
-- have to ask Google how big the tab is before every write; the answer is only
-- fetched when the grid actually needs to grow, roughly once per 1,000 rows.
ALTER TABLE google_db_state ADD COLUMN IF NOT EXISTS sheet_id  INTEGER;
ALTER TABLE google_db_state ADD COLUMN IF NOT EXISTS grid_rows INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION google_db_enqueue() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  rec      jsonb;
  key_text text := '';
  col      text;
  first    boolean := TRUE;
BEGIN
  -- An UPDATE whose only difference is bookkeeping is not a business change.
  -- Just `updated_at` and `updated_by` are ignored, and nothing else: they are
  -- stamped by practically every write path and appear on no business tab as a
  -- value anyone acts on. Everything else still enqueues — `live_stock_qty` in
  -- particular is business data shown on Item Master, so a stock movement is a
  -- change even though no human typed it.
  IF TG_OP = 'UPDATE' THEN
    IF (to_jsonb(OLD) - 'updated_at' - 'updated_by')
     = (to_jsonb(NEW) - 'updated_at' - 'updated_by') THEN
      RETURN NULL;
    END IF;
  END IF;

  IF TG_OP = 'DELETE' THEN rec := to_jsonb(OLD); ELSE rec := to_jsonb(NEW); END IF;

  FOREACH col IN ARRAY TG_ARGV LOOP
    IF NOT first THEN key_text := key_text || chr(31); END IF;
    key_text := key_text || COALESCE(rec ->> col, '');
    first := FALSE;
  END LOOP;

  INSERT INTO google_db_outbox (table_name, row_key, operation, source)
  VALUES (
    TG_TABLE_NAME,
    key_text,
    CASE WHEN TG_OP = 'DELETE' THEN 'DELETE' ELSE 'UPSERT' END,
    COALESCE(NULLIF(current_setting('zolex.sync_source', TRUE), ''), 'SQL')
  )
  ON CONFLICT (table_name, row_key) WHERE processed_at IS NULL DO NOTHING;

  RETURN NULL;
END $fn$;
