-- ============================================================================
-- 029 — A cancelled GRN closes its open quality inspections
--
-- Cancelling a posted GRN now closes every inspection still waiting for a
-- decision (PENDING_QC, QC_IN_PROGRESS, ON_HOLD). Its material never entered
-- stock, so there is nothing left to release, and the QC queue must stop
-- offering it: before this, passing such an inspection added the stock of a
-- cancelled receipt (audit A7 F04). None of the six statuses of 021 means
-- "closed without a decision", and QC_FAILED would count as a supplier's
-- rejection, so the state is new:
--
-- 1. qc_inspections.status gains CANCELLED.
-- 2. grn_headers.qc_status gains CANCELLED, for a cancelled GRN none of whose
--    inspections had been decided.
-- 3. An open inspection already sitting on a cancelled GRN is closed the same
--    way, and that GRN's qc_status re-derived. Production had no inspections on
--    2026-10-17; this only tidies databases where QC was tried out.
-- ============================================================================

ALTER TABLE qc_inspections DROP CONSTRAINT IF EXISTS chk_qc_status;
ALTER TABLE qc_inspections ADD CONSTRAINT chk_qc_status CHECK (
  status IN ('PENDING_QC', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD', 'CANCELLED')
);

ALTER TABLE grn_headers DROP CONSTRAINT IF EXISTS chk_grn_qc_status;
ALTER TABLE grn_headers ADD CONSTRAINT chk_grn_qc_status CHECK (
  qc_status IN ('NOT_APPLICABLE', 'PENDING_QC', 'QC_IN_PROGRESS', 'QC_PASSED', 'QC_FAILED', 'ACCEPTED_WITH_DEVIATION', 'ON_HOLD', 'CANCELLED')
);

UPDATE qc_inspections qi
   SET status = 'CANCELLED',
       next_action = 'Closed: GRN cancelled',
       updated_at = now()
  FROM grn_headers g
 WHERE g.id = qi.grn_id
   AND g.status = 'CANCELLED'
   AND qi.status IN ('PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD');

-- The same derivation as domain/qc.ts overallQcStatus: with no open inspection
-- left, a failed one makes the GRN QC_FAILED, any other decided one QC_PASSED.
UPDATE grn_headers g
   SET qc_status = CASE
         WHEN NOT EXISTS (SELECT 1 FROM qc_inspections qi WHERE qi.grn_id = g.id AND qi.status <> 'CANCELLED')
           THEN 'CANCELLED'
         WHEN EXISTS (SELECT 1 FROM qc_inspections qi WHERE qi.grn_id = g.id AND qi.status = 'QC_FAILED')
           THEN 'QC_FAILED'
         ELSE 'QC_PASSED'
       END,
       updated_at = now()
 WHERE g.status = 'CANCELLED'
   AND g.qc_status IN ('PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD')
   AND EXISTS (SELECT 1 FROM qc_inspections qi WHERE qi.grn_id = g.id);
