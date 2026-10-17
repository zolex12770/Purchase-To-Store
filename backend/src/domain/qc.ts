/**
 * Quality inspection states, shared by the GRN and QC modules (Requirement 10).
 *
 * Material of an item marked qc_required is held out of stock from the moment
 * its GRN is posted until QC decides its inspection (qc/routes.ts); only what QC
 * accepts goes into stock. A GRN's own qc_status is derived from the statuses of
 * its inspections, the same way wherever an inspection changes.
 */
import { txQuery, type Queryable } from '../db/index.js';

/** Waiting for a decision: the material is still held out of stock. */
export const OPEN_QC_STATUSES = ['PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD'] as const;

/** Released into stock (all or part of what was received). */
export const PASSED_QC_STATUSES = ['QC_PASSED', 'ACCEPTED_WITH_DEVIATION'] as const;

/** Closed without a decision because its GRN was cancelled (migration 029). */
export const CLOSED_QC_STATUS = 'CANCELLED';

export const isOpenQcStatus = (status: string): boolean =>
  (OPEN_QC_STATUSES as readonly string[]).includes(status);

const QC_LABELS: Record<string, string> = {
  PENDING_QC: 'awaiting inspection',
  QC_IN_PROGRESS: 'under testing',
  ON_HOLD: 'on hold',
  QC_PASSED: 'passed',
  ACCEPTED_WITH_DEVIATION: 'accepted with deviation',
  QC_FAILED: 'failed',
  CANCELLED: 'closed',
};

/** An inspection status in words, for messages: "passed", "on hold". */
export const qcStatusLabel = (status: string): string => QC_LABELS[status] ?? status;

/**
 * A GRN's qc_status from its inspections' statuses. The least advanced one wins,
 * so a GRN reads PENDING_QC while any of its material is still waiting.
 * Inspections closed by a cancel no longer count; a GRN with only those reads
 * CANCELLED, and a GRN with no inspection at all NOT_APPLICABLE.
 */
export function overallQcStatus(statuses: readonly string[]): string {
  if (statuses.length === 0) return 'NOT_APPLICABLE';
  const live = statuses.filter((s) => s !== CLOSED_QC_STATUS);
  if (live.length === 0) return CLOSED_QC_STATUS;
  for (const status of ['PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD', 'QC_FAILED']) {
    if (live.includes(status)) return status;
  }
  return 'QC_PASSED';
}

/** Re-derives and stores a GRN's qc_status from its inspections. */
export async function refreshGrnQcStatus(tx: Queryable, grnId: number): Promise<string> {
  const rows = await txQuery<{ status: string }>(tx, 'SELECT status FROM qc_inspections WHERE grn_id = $1', [grnId]);
  const status = overallQcStatus(rows.map((r) => r.status));
  await tx.query('UPDATE grn_headers SET qc_status = $2, updated_at = now() WHERE id = $1', [grnId, status]);
  return status;
}

/**
 * Closes every inspection of a GRN still waiting for a decision, when the GRN is
 * cancelled: its material never entered stock, so there is nothing to release,
 * and a pass would add the stock of a receipt that no longer exists (A7 F04).
 * Decided inspections stay as they are; they record what QC found.
 */
export async function closeOpenInspections(tx: Queryable, grnId: number, remark: string): Promise<number> {
  const closed = await txQuery<{ id: number }>(
    tx,
    `UPDATE qc_inspections
        SET status = $2, next_action = 'Closed: GRN cancelled',
            remarks = CASE WHEN remarks = '' THEN $3 ELSE remarks || ' | ' || $3 END,
            updated_at = now()
      WHERE grn_id = $1 AND status = ANY($4::text[])
      RETURNING id`,
    [grnId, CLOSED_QC_STATUS, remark, [...OPEN_QC_STATUSES]],
  );
  return closed.length;
}
