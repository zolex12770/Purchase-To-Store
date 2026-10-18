-- ============================================================================
-- 032 — A requisition is fully issued when every line is
--
-- A view and a backfill. No quantity, issue slip or line is changed.
--
-- A requisition's store status compared its issued total with its requested
-- total: v_requisition_header_balance.store_status (015) read ISSUED, and
-- recomputeRequisitionStatus (domain/quantities.ts) stored FULLY_ISSUED, once
-- SUM(issued) >= SUM(requested). Rule 24 lets the store issue more than a line
-- asks for, so an over-issue on one line stood in for another line nothing had
-- been issued against: [X 1, Y 2] with 4 of X issued read ISSUED and
-- FULLY_ISSUED. The stock figures (allocated and available stock, the stock
-- status, the stock scan), the store's requisition queue and the store-queue
-- list count only APPROVED and PARTIALLY_ISSUED requisitions, so they dropped
-- Y's 2 while the detail page still offered them for issue (review of the C06
-- follow-up, 2026-10-18). The 2026-10-17 production copy had no such
-- requisition.
--
-- 1. store_status is ISSUED when no line has anything left to issue:
--    total_pending_qty, each line's pending_qty (zero or more) summed, is 0. An
--    over-issued line still counts as issued in full, as in 015. The view is
--    restated from 015 with only that column changed.
-- 2. A requisition the old rule left FULLY_ISSUED (issued total at least the
--    requested total) with a line still to issue becomes PARTIALLY_ISSUED, as
--    recomputeRequisitionStatus now derives it. One stored FULLY_ISSUED with
--    less issued than requested is not this rule's doing (the old rule did not
--    derive it either; scripts/execute_controlled_reset_and_import.ts set the
--    status from the sheet's issued figures but posted a slip only for rows
--    with a slip number), and is left as it is.
-- ============================================================================

CREATE OR REPLACE VIEW v_requisition_header_balance AS
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
           AND COALESCE(SUM(b.pending_qty), 0) <= 0
        THEN 'ISSUED'
      ELSE 'PENDING'
    END                                                                        AS store_status
FROM requisition_headers rh
LEFT JOIN v_requisition_line_balance b ON b.requisition_id = rh.id
GROUP BY rh.id, rh.requisition_no, rh.status, rh.requisition_date,
         rh.hod_decided_at, rh.hod_decision_reason;

UPDATE requisition_headers rh
   SET status = 'PARTIALLY_ISSUED', updated_at = now()
  FROM v_requisition_header_balance b
 WHERE b.requisition_id = rh.id
   AND rh.status = 'FULLY_ISSUED'
   AND b.total_pending_qty > 0
   AND b.total_issued_qty >= b.total_requested_qty;
