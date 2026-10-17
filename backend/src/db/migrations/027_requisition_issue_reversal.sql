-- ============================================================================
-- 027 — Requisition issue slips can be REVERSED
--
-- Additive only. No business record is changed or deleted.
--
-- Until now an issue slip could only be posted. REQUISITION_REVERSAL has been an
-- allowed ledger type since 014 with nothing able to post it, and a requisition
-- with any slip against it could never be cancelled — so the 5-unit test issue
-- ISS-20261014-0001 left on production had no supported way back.
--
-- 1. requisition_issues gets status (POSTED / REVERSED) and who/when/why of the
--    reversal. The slip and its lines are kept exactly as issued; the stock comes
--    back through a REQUISITION_REVERSAL ledger entry naming the slip.
-- 2. v_requisition_line_balance (014) counts POSTED slips only, so issued,
--    pending, excess, line status, issue count and last issue date ignore a
--    reversed slip — and with them v_requisition_header_balance (015) and every
--    screen, queue, analytics figure, export and Google tab read from the two.
--    The column list is unchanged, so the header view built on it stays valid.
--
-- The stock_ledger type CHECK is NOT redefined: 026 already allows
-- REQUISITION_REVERSAL, GRN_REVERSAL and DIRECT_ISSUE_REVERSAL.
-- ============================================================================

ALTER TABLE requisition_issues ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'POSTED';
ALTER TABLE requisition_issues DROP CONSTRAINT IF EXISTS chk_requisition_issue_status;
ALTER TABLE requisition_issues ADD CONSTRAINT chk_requisition_issue_status CHECK (status IN ('POSTED', 'REVERSED'));
ALTER TABLE requisition_issues ADD COLUMN IF NOT EXISTS reversed_at TIMESTAMPTZ;
ALTER TABLE requisition_issues ADD COLUMN IF NOT EXISTS reversed_by BIGINT REFERENCES users (id) ON DELETE SET NULL;
ALTER TABLE requisition_issues ADD COLUMN IF NOT EXISTS reversal_reason TEXT NOT NULL DEFAULT '';
-- A reversal is always explained, like a cancelled requisition (chk_requisition_cancel_reason).
ALTER TABLE requisition_issues DROP CONSTRAINT IF EXISTS chk_requisition_issue_reversal_reason;
ALTER TABLE requisition_issues ADD CONSTRAINT chk_requisition_issue_reversal_reason CHECK (
  status <> 'REVERSED' OR length(trim(reversal_reason)) > 0
);

CREATE OR REPLACE VIEW v_requisition_line_balance AS
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
  SELECT ril.requisition_line_id, SUM(ril.issue_qty) AS issued_qty,
         COUNT(*) AS issue_count, MAX(ril.created_at) AS last_issue_date
    FROM requisition_issue_lines ril
    JOIN requisition_issues ri ON ri.id = ril.requisition_issue_id
   WHERE ri.status = 'POSTED'
   GROUP BY ril.requisition_line_id
) iss ON iss.requisition_line_id = rl.id;
