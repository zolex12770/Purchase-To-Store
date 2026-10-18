/**
 * The figures behind the store issue dialog (RequisitionDetail, StoreIssueModal).
 *
 * The quantities it suggests and its over-issue tick are given for the issued
 * quantities it shows. After a 409 (another issue was posted or reversed
 * meanwhile) it refreshed those figures but kept what was typed and ticked: a
 * tick given for "Extra 1" still stood when the same quantity now meant
 * "Extra 3", and one more click issued 5 against 2 requested (review case
 * RV-C02c, 2026-10-18). So whenever the figures move, the dialog starts again
 * from them, as it does when it opens.
 */

export interface IssueLineFigures {
  requisition_line_id: number;
  requested_qty: string;
  issued_qty: string;
  pending_qty: string;
}

/** What the dialog starts from: each line's pending balance. Store may change it either way (Rule 24). */
export function defaultIssueQuantities(lines: IssueLineFigures[]): Record<number, string> {
  return Object.fromEntries(
    lines.filter((l) => Number(l.pending_qty) > 0).map((l) => [l.requisition_line_id, l.pending_qty]),
  );
}

/**
 * Changes when a figure the quantities and the tick were given for changes, and
 * only then: a refetch that brings the same figures keeps what was typed.
 */
export function issueFiguresKey(lines: IssueLineFigures[]): string {
  return lines.map((l) => `${l.requisition_line_id}:${Number(l.requested_qty)}:${Number(l.issued_qty)}`).join('|');
}

export interface IssueRow<L> {
  line: L;
  enteredQty: number;
  /** How much of the entered quantity goes beyond what is still pending. */
  excess: number;
}

export function issueRows<L extends IssueLineFigures>(lines: L[], qtyByLine: Record<number, string>): IssueRow<L>[] {
  return lines.map((l) => {
    const enteredQty = Number(qtyByLine[l.requisition_line_id] ?? 0);
    const pending = Math.max(0, Number(l.requested_qty) - Number(l.issued_qty));
    return { line: l, enteredQty, excess: enteredQty > pending ? enteredQty - pending : 0 };
  });
}

/** Issue needs a quantity, and an over-issue needs its tick: warned, never blocked (Rule 23). */
export function summariseIssue(rows: IssueRow<unknown>[], confirmedExcess: boolean) {
  const anyEntered = rows.some((r) => r.enteredQty > 0);
  const anyExcess = rows.some((r) => r.excess > 0);
  return { anyEntered, anyExcess, canSubmit: anyEntered && (!anyExcess || confirmedExcess) };
}
