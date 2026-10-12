-- ============================================================================
-- 012 — Material Lot Number (MLN), Stock Ledger, and Item Live Stock.
--
-- MLN: one immutable, globally-unique, server-generated identifier per GRN
-- line, issued ONLY when the GRN is POSTED (never on a draft — a draft moves
-- no stock, so it earns no lot number). Generated from a native PostgreSQL
-- SEQUENCE, which is lock-free and safe under concurrent posting by design —
-- no two transactions can ever be handed the same value, without needing a
-- manual FOR UPDATE counter row (unlike document_sequences, which resets per
-- day/doc-type; an MLN is a permanent physical-label identity and must never
-- repeat, so it counts up forever).
--
-- Stock Ledger: every GRN inward (and its reversal on cancellation) is
-- recorded as its own row, so `items.live_stock_qty` is never the only
-- record of how it got there — it is always a computed answer of "the
-- ledger's running balance," and the ledger's own shape already
-- accommodates future ISSUE/TRANSFER/RETURN/ADJUSTMENT/CONSUMPTION/OUTWARD
-- movement types without another migration.
-- ============================================================================

-- ── Item Master: operational on-hand stock ──────────────────────────────────
-- Distinct from the already-existing DERIVED figures (open indent qty,
-- pending GRN qty, lifetime received qty — all computed on the fly from the
-- balance views). live_stock_qty is a genuine STORED balance that only ever
-- moves through a stock_ledger row, exactly like a real inventory system.
ALTER TABLE items ADD COLUMN IF NOT EXISTS live_stock_qty NUMERIC(18, 4) NOT NULL DEFAULT 0;
ALTER TABLE items DROP CONSTRAINT IF EXISTS chk_items_live_stock_nonneg;
ALTER TABLE items ADD CONSTRAINT chk_items_live_stock_nonneg CHECK (live_stock_qty >= 0);

-- ── MLN sequence ─────────────────────────────────────────────────────────────
CREATE SEQUENCE IF NOT EXISTS mln_number_seq START WITH 1 INCREMENT BY 1;

CREATE TABLE IF NOT EXISTS grn_line_mlns (
  id           BIGSERIAL PRIMARY KEY,
  mln_no       TEXT        NOT NULL,
  grn_line_id  BIGINT      NOT NULL REFERENCES grn_lines (id) ON DELETE RESTRICT,
  grn_id       BIGINT      NOT NULL REFERENCES grn_headers (id) ON DELETE RESTRICT,
  item_id      BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  sr_no        INTEGER     NOT NULL,
  qty          NUMERIC(18, 4) NOT NULL,
  uom_id       BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  batch_no     TEXT        NOT NULL DEFAULT '',
  location     TEXT        NOT NULL DEFAULT '',
  issued_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  print_count  INTEGER     NOT NULL DEFAULT 0,
  last_printed_at TIMESTAMPTZ,
  CONSTRAINT uq_grn_line_mln_no UNIQUE (mln_no),
  -- One line is posted exactly once and earns exactly one MLN — a second
  -- attempt to issue one for the same line is a bug, not a valid state, and
  -- this constraint makes it impossible at the database level.
  CONSTRAINT uq_grn_line_mln_line UNIQUE (grn_line_id)
);
CREATE INDEX IF NOT EXISTS idx_grn_line_mlns_grn ON grn_line_mlns (grn_id);
CREATE INDEX IF NOT EXISTS idx_grn_line_mlns_item ON grn_line_mlns (item_id);

-- ── Stock ledger ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS stock_ledger (
  id             BIGSERIAL PRIMARY KEY,
  item_id        BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  txn_type       TEXT        NOT NULL,   -- GRN_INWARD | GRN_REVERSAL (future: ISSUE, TRANSFER, RETURN, ADJUSTMENT, CONSUMPTION, OUTWARD)
  reference_type TEXT        NOT NULL DEFAULT 'GRN',
  reference_id   BIGINT,                 -- grn_headers.id
  reference_no   TEXT        NOT NULL DEFAULT '',   -- grn_no, for a readable ledger without a join
  grn_line_id    BIGINT REFERENCES grn_lines (id) ON DELETE SET NULL,
  mln_no         TEXT        NOT NULL DEFAULT '',
  po_line_id     BIGINT REFERENCES purchase_order_lines (id) ON DELETE SET NULL,
  supplier_id    BIGINT REFERENCES suppliers (id) ON DELETE SET NULL,
  inward_qty     NUMERIC(18, 4) NOT NULL DEFAULT 0,
  outward_qty    NUMERIC(18, 4) NOT NULL DEFAULT 0,
  balance_qty    NUMERIC(18, 4) NOT NULL,   -- running item balance AFTER this movement
  uom_id         BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  location       TEXT        NOT NULL DEFAULT '',
  batch_no       TEXT        NOT NULL DEFAULT '',
  txn_date       DATE        NOT NULL,
  created_by     BIGINT REFERENCES users (id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN ('GRN_INWARD', 'GRN_REVERSAL')),
  CONSTRAINT chk_stock_ledger_inward_nonneg CHECK (inward_qty >= 0),
  CONSTRAINT chk_stock_ledger_outward_nonneg CHECK (outward_qty >= 0)
);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_item ON stock_ledger (item_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_ref ON stock_ledger (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_ledger_grn_line ON stock_ledger (grn_line_id);
