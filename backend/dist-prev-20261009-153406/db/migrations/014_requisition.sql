-- ============================================================================
-- 014 — Requisition (4th Purchase Module tab): User → HOD approval → Store
-- issue → stock deduction → issue slip.
--
-- Deliberately independent of Purchase Indent/PO/GRN (SRS distinction:
-- "Purchase workflow" orders material IN via a supplier; "Requisition"
-- moves already-in-stock material OUT to an internal requester). It reuses
-- every piece of existing infrastructure it can:
--   - document_sequences  → REQ-/ISS- numbering (doc_type has no CHECK, so
--     no migration needed there)
--   - lookups.extra JSONB → per-department HOD mapping (extra->>'hodUserId'
--     on a DEPARTMENT row), and a new MACHINE category cascading from
--     DEPARTMENT via the existing self-referencing parent_id column
--   - stock_ledger        → its own header comment already anticipated
--     "future: ISSUE, ... OUTWARD" — this just widens its CHECK constraint
--   - items.live_stock_qty → the same stored running balance GRN already
--     posts to; requisition issue subtracts from the SAME column through
--     the SAME ledger, so GRN inward and requisition outward always
--     reconcile against one number, never two.
--   - audit_logs, requirePermission/requireAnyPermission, isSuperAdmin
-- ============================================================================

-- ── MACHINE master, cascading from DEPARTMENT ───────────────────────────────
ALTER TABLE lookups DROP CONSTRAINT chk_lookups_category;
ALTER TABLE lookups ADD CONSTRAINT chk_lookups_category CHECK (category IN (
  'DEPARTMENT', 'COST_CENTRE', 'ITEM_TYPE', 'MAIN_GROUP', 'SUB_MAIN_GROUP',
  'UOM', 'INDENT_TYPE', 'PO_TYPE', 'CURRENCY', 'PAYMENT_TERMS',
  'GRN_TYPE', 'PACKING_TYPE', 'LOCATION', 'STATE', 'CITY',
  'MACHINE'
));

-- ── Stock ledger: widen for requisition issue/reversal ──────────────────────
ALTER TABLE stock_ledger DROP CONSTRAINT chk_stock_ledger_type;
ALTER TABLE stock_ledger ADD CONSTRAINT chk_stock_ledger_type CHECK (txn_type IN (
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL'
));
-- A requisition-issue row has no GRN/PO line and no MLN — those columns
-- simply stay NULL/blank for these rows, exactly as they already do for any
-- future non-GRN movement the original design comment anticipated.

-- ── Requisition header ───────────────────────────────────────────────────────
CREATE TABLE requisition_headers (
  id                   BIGSERIAL PRIMARY KEY,
  requisition_no       TEXT        NOT NULL,          -- REQ-YYYYMMDD-#### (ADR-002 pattern)
  requisition_date     DATE        NOT NULL,
  requisition_time     TEXT        NOT NULL DEFAULT '',
  requester_user_id    BIGINT      NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  -- Snapshots: a later change to the requester's own department/name must
  -- never rewrite a submitted document's history (SRS §34 pattern).
  employee_code        TEXT        NOT NULL DEFAULT '',
  employee_name         TEXT        NOT NULL DEFAULT '',
  department_id        BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  department_name       TEXT        NOT NULL DEFAULT '',
  -- The HOD who actually owns this document's approval — resolved from the
  -- department's mapping AT SUBMIT TIME and then frozen, so a later change
  -- to who is HOD of a department never retargets an in-flight requisition.
  hod_user_id          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  hod_name              TEXT        NOT NULL DEFAULT '',
  machine_id            BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  cost_centre_id        BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  remarks               TEXT        NOT NULL DEFAULT '',
  status                 TEXT        NOT NULL DEFAULT 'DRAFT',
  submitted_at          TIMESTAMPTZ,
  submitted_by          BIGINT REFERENCES users (id) ON DELETE SET NULL,
  hod_decided_at        TIMESTAMPTZ,
  hod_decided_by        BIGINT REFERENCES users (id) ON DELETE SET NULL,
  hod_decision_reason   TEXT,
  closed_at             TIMESTAMPTZ,
  closed_by             BIGINT REFERENCES users (id) ON DELETE SET NULL,
  close_reason          TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by            BIGINT REFERENCES users (id) ON DELETE SET NULL,
  updated_by            BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_requisition_no UNIQUE (requisition_no),
  CONSTRAINT chk_requisition_status CHECK (status IN (
    'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED',
    'PARTIALLY_ISSUED', 'FULLY_ISSUED', 'CANCELLED'
  )),
  CONSTRAINT chk_requisition_rejection_reason CHECK (
    status NOT IN ('REJECTED', 'RETURNED') OR
    (hod_decision_reason IS NOT NULL AND length(trim(hod_decision_reason)) > 0)
  ),
  CONSTRAINT chk_requisition_cancel_reason CHECK (
    status <> 'CANCELLED' OR (close_reason IS NOT NULL AND length(trim(close_reason)) > 0)
  )
);
CREATE INDEX idx_requisition_status ON requisition_headers (status);
CREATE INDEX idx_requisition_date ON requisition_headers (requisition_date DESC);
CREATE INDEX idx_requisition_requester ON requisition_headers (requester_user_id);
CREATE INDEX idx_requisition_hod ON requisition_headers (hod_user_id);
CREATE INDEX idx_requisition_department ON requisition_headers (department_id);
CREATE INDEX idx_requisition_status_date ON requisition_headers (status, requisition_date DESC);

CREATE TABLE requisition_lines (
  id                 BIGSERIAL PRIMARY KEY,
  requisition_id     BIGINT      NOT NULL REFERENCES requisition_headers (id) ON DELETE CASCADE,
  line_no            INTEGER     NOT NULL,
  item_id            BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  -- Snapshots: a later Item Master edit must never rewrite history.
  item_code          TEXT        NOT NULL,
  item_description   TEXT        NOT NULL,
  main_group_name    TEXT        NOT NULL DEFAULT '',
  uom_id             BIGINT REFERENCES lookups (id) ON DELETE RESTRICT,
  -- The requester's own request — NEVER mutated by any issue transaction
  -- (Rule 10). Actual issued quantity is always the derived SUM of
  -- requisition_issue_lines, exactly as v_po_line_balance derives
  -- received_qty from posted GRN lines rather than storing it directly.
  requested_qty      NUMERIC(18, 4) NOT NULL,
  remarks            TEXT        NOT NULL DEFAULT '',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_requisition_line_no UNIQUE (requisition_id, line_no),
  CONSTRAINT chk_requisition_qty CHECK (requested_qty > 0)
);
CREATE INDEX idx_requisition_lines_requisition ON requisition_lines (requisition_id);
CREATE INDEX idx_requisition_lines_item ON requisition_lines (item_id);

-- Approval/state-transition history — mirrors indent_approvals exactly.
CREATE TABLE requisition_approvals (
  id            BIGSERIAL PRIMARY KEY,
  requisition_id BIGINT     NOT NULL REFERENCES requisition_headers (id) ON DELETE CASCADE,
  action        TEXT        NOT NULL,   -- SUBMIT | APPROVE | REJECT | RETURN | REOPEN | CANCEL
  actor_user_id BIGINT REFERENCES users (id) ON DELETE SET NULL,
  reason        TEXT,
  from_status   TEXT,
  to_status     TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_requisition_approval_action CHECK (action IN
    ('SUBMIT', 'APPROVE', 'REJECT', 'RETURN', 'REOPEN', 'CANCEL'))
);
CREATE INDEX idx_requisition_approvals_requisition ON requisition_approvals (requisition_id, created_at DESC);

-- ── Store issue: one row per issue SLIP (a store visit), each covering one
-- or more requisition lines. A requisition can have MANY issue slips over
-- time (Rule 11/27) — this is the transaction history "issued_qty" alone
-- could never give you. ─────────────────────────────────────────────────────
CREATE TABLE requisition_issues (
  id               BIGSERIAL PRIMARY KEY,
  issue_slip_no    TEXT        NOT NULL,      -- ISS-YYYYMMDD-####
  requisition_id   BIGINT      NOT NULL REFERENCES requisition_headers (id) ON DELETE RESTRICT,
  issue_date       DATE        NOT NULL,
  issue_time       TEXT        NOT NULL DEFAULT '',
  store_user_id    BIGINT REFERENCES users (id) ON DELETE SET NULL,
  remarks          TEXT        NOT NULL DEFAULT '',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by       BIGINT REFERENCES users (id) ON DELETE SET NULL,
  CONSTRAINT uq_issue_slip_no UNIQUE (issue_slip_no)
);
CREATE INDEX idx_requisition_issues_requisition ON requisition_issues (requisition_id);
CREATE INDEX idx_requisition_issues_date ON requisition_issues (issue_date DESC);

CREATE TABLE requisition_issue_lines (
  id                     BIGSERIAL PRIMARY KEY,
  requisition_issue_id   BIGINT      NOT NULL REFERENCES requisition_issues (id) ON DELETE CASCADE,
  requisition_line_id    BIGINT      NOT NULL REFERENCES requisition_lines (id) ON DELETE RESTRICT,
  item_id                BIGINT      NOT NULL REFERENCES items (id) ON DELETE RESTRICT,
  -- Snapshots taken AT THIS ISSUE, so a printed/historical issue slip never
  -- silently changes if the requisition or item master changes later.
  requested_qty_snapshot NUMERIC(18, 4) NOT NULL,
  previously_issued_qty  NUMERIC(18, 4) NOT NULL DEFAULT 0,
  issue_qty              NUMERIC(18, 4) NOT NULL,
  uom_id                 BIGINT REFERENCES lookups (id) ON DELETE SET NULL,
  remarks                TEXT        NOT NULL DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT chk_requisition_issue_qty CHECK (issue_qty > 0)
);
CREATE INDEX idx_requisition_issue_lines_issue ON requisition_issue_lines (requisition_issue_id);
CREATE INDEX idx_requisition_issue_lines_line ON requisition_issue_lines (requisition_line_id);

-- ── Balance views (ADR-005 pattern) ──────────────────────────────────────────
-- issued_qty is ALWAYS the derived sum of issue lines — never a stored,
-- independently-mutable column (Rule 10, Rule 27).
CREATE VIEW v_requisition_line_balance AS
SELECT
    rl.id                                AS requisition_line_id,
    rl.requisition_id,
    rh.requisition_no,
    rh.requisition_date,
    rh.status                            AS requisition_status,
    rh.department_id,
    rh.hod_user_id,
    rh.requester_user_id,
    rl.line_no,
    rl.item_id,
    rl.item_code,
    rl.item_description,
    rl.main_group_name,
    rl.uom_id,
    rl.requested_qty,
    COALESCE(iss.issued_qty, 0)::NUMERIC(18, 4)  AS issued_qty,
    GREATEST(rl.requested_qty - COALESCE(iss.issued_qty, 0), 0)::NUMERIC(18, 4) AS pending_qty,
    GREATEST(COALESCE(iss.issued_qty, 0) - rl.requested_qty, 0)::NUMERIC(18, 4) AS excess_qty,
    CASE
      WHEN COALESCE(iss.issued_qty, 0) <= 0                    THEN 'PENDING'
      WHEN COALESCE(iss.issued_qty, 0) >= rl.requested_qty     THEN 'FULLY_ISSUED'
      ELSE 'PARTIALLY_ISSUED'
    END                                                                        AS line_status,
    iss.issue_count::INT                                                       AS issue_count,
    iss.last_issue_date
FROM requisition_lines rl
JOIN requisition_headers rh ON rh.id = rl.requisition_id
LEFT JOIN (
  SELECT requisition_line_id, SUM(issue_qty) AS issued_qty,
         COUNT(*) AS issue_count, MAX(created_at) AS last_issue_date
    FROM requisition_issue_lines
   GROUP BY requisition_line_id
) iss ON iss.requisition_line_id = rl.id;

CREATE VIEW v_requisition_header_balance AS
SELECT
    rh.id                                              AS requisition_id,
    rh.requisition_no,
    rh.status,
    rh.requisition_date,
    COUNT(b.requisition_line_id)::INT                  AS line_count,
    COALESCE(SUM(b.requested_qty), 0)::NUMERIC(18, 4)  AS total_requested_qty,
    COALESCE(SUM(b.issued_qty), 0)::NUMERIC(18, 4)     AS total_issued_qty,
    COALESCE(SUM(b.pending_qty), 0)::NUMERIC(18, 4)    AS total_pending_qty,
    COALESCE(SUM(b.excess_qty), 0)::NUMERIC(18, 4)     AS total_excess_qty
FROM requisition_headers rh
LEFT JOIN v_requisition_line_balance b ON b.requisition_id = rh.id
GROUP BY rh.id, rh.requisition_no, rh.status, rh.requisition_date;
