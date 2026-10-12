-- ============================================================================
-- 015 — Requisition: two independent, user-facing status columns.
--
-- The Requisition Data Table must expose HOD STATUS (PENDING/APPROVED/REJECTED)
-- and STORE STATUS (PENDING/ISSUED) as two SEPARATE columns — never merged into
-- one generic status. Both are DERIVED, computed once here in
-- v_requisition_header_balance (mirroring the balance-view discipline already
-- used for issued_qty/pending_qty — never a second mutable status column), so
-- every consumer (list, detail, print documents, search, analysis) reads the
-- exact same derivation and can never disagree.
--
-- hod_status derivation:
--   APPROVED/PARTIALLY_ISSUED/FULLY_ISSUED -> APPROVED
--   REJECTED                               -> REJECTED
--   DRAFT/PENDING_APPROVAL/RETURNED        -> PENDING (RETURNED is a "send
--     back for correction", not a final HOD verdict — still awaiting HOD)
--   CANCELLED -> falls back to the HOD decision already recorded before the
--     cancellation (hod_decided_at/hod_decision_reason are never cleared by
--     CANCEL), so a cancelled-after-approval requisition still shows APPROVED.
--
-- store_status derivation:
--   issued_qty >= requested_qty -> ISSUED (fulfilment, NOT equality — an
--     over-issued line still reads ISSUED, exactly per the business rule that
--     issue qty may legitimately exceed requested qty)
--   otherwise                   -> PENDING
-- Store must never be allowed to act on a requisition whose hod_status is not
-- APPROVED — enforced server-side in requisition/routes.ts (REQUISITION_ISSUABLE),
-- this view only presents the fact for display.
-- ============================================================================

DROP VIEW v_requisition_header_balance;

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
    COALESCE(SUM(b.excess_qty), 0)::NUMERIC(18, 4)     AS total_excess_qty,
    CASE
      WHEN rh.status IN ('APPROVED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED') THEN 'APPROVED'
      WHEN rh.status = 'REJECTED' THEN 'REJECTED'
      WHEN rh.status IN ('DRAFT', 'PENDING_APPROVAL', 'RETURNED') THEN 'PENDING'
      WHEN rh.status = 'CANCELLED' THEN
        CASE
          WHEN rh.hod_decided_at IS NULL THEN 'PENDING'
          WHEN rh.hod_decision_reason IS NULL THEN 'APPROVED'
          ELSE 'REJECTED'
        END
      ELSE 'PENDING'
    END                                                                        AS hod_status,
    CASE
      WHEN COALESCE(SUM(b.requested_qty), 0) > 0
           AND COALESCE(SUM(b.issued_qty), 0) >= COALESCE(SUM(b.requested_qty), 0)
        THEN 'ISSUED'
      ELSE 'PENDING'
    END                                                                        AS store_status
FROM requisition_headers rh
LEFT JOIN v_requisition_line_balance b ON b.requisition_id = rh.id
GROUP BY rh.id, rh.requisition_no, rh.status, rh.requisition_date,
         rh.hod_decided_at, rh.hod_decision_reason;
