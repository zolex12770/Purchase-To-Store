/**
 * Document lifecycle state machines (SRS §10, §11.4, §12; ADR-003).
 *
 * Status transitions are declared here once and enforced by every service. There
 * are no free-text status strings anywhere in the application: a transition that
 * is not in these tables cannot happen, and the database CHECK constraints refuse
 * any value outside the declared sets.
 */
import { BusinessRuleError } from '../core/errors.js';

/* ── Purchase Indent ────────────────────────────────────────────────────────── */

export const INDENT_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED',
] as const;
export type IndentStatus = (typeof INDENT_STATUSES)[number];

const INDENT_TRANSITIONS: Record<IndentStatus, IndentStatus[]> = {
  DRAFT:            ['PENDING_APPROVAL', 'CANCELLED'],
  // A submitted indent may be pulled back to draft by its owner before a decision.
  PENDING_APPROVAL: ['APPROVED', 'REJECTED', 'DRAFT', 'CANCELLED'],
  // Approved indents feed POs, and close when fully ordered or short-closed.
  // Two distinct reversals are reachable directly from APPROVED, and they are
  // NOT the same action (indent/routes.ts):
  //   - REJECTED: a genuine, permanent rejection of an approved indent.
  //   - DRAFT: UNAPPROVE — an authorised approver pulling their decision back
  //     for correction (mirrors REOPEN's REJECTED -> DRAFT, just starting one
  //     status earlier). Never produces a fake REJECTED record.
  // Both are guarded server-side so this is refused once any quantity has
  // actually been consumed by a purchase order — reverse the PO first.
  APPROVED:         ['CLOSED', 'CANCELLED', 'REJECTED', 'DRAFT'],
  // A rejection — whether from PENDING_APPROVAL or an unapproved APPROVED
  // indent — can be reopened for correction and resubmission.
  REJECTED:         ['DRAFT', 'CANCELLED'],
  CANCELLED:        [],
  CLOSED:           ['APPROVED'],
};

/**
 * Statuses whose documents may no longer be edited.
 *
 * PENDING_APPROVAL is deliberately editable — the raiser can still fix a
 * mistake, and an authorised approver (indent.approve) can adjust it while
 * reviewing, without a full reject→reopen→resubmit round trip. The route
 * itself (indent/routes.ts) gates WHO may reach this: indent.edit or
 * indent.approve. Only a genuine decision (APPROVED/REJECTED) or a terminal
 * state locks the document.
 */
export const INDENT_LOCKED: ReadonlySet<IndentStatus> = new Set<IndentStatus>([
  'APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED',
]);

/* ── Purchase Order ─────────────────────────────────────────────────────────── */

export const PO_STATUSES = [
  'DRAFT', 'OPEN', 'PARTIALLY_RECEIVED', 'COMPLETED', 'SHORT_CLOSED', 'CANCELLED',
] as const;
export type PoStatus = (typeof PO_STATUSES)[number];

const PO_TRANSITIONS: Record<PoStatus, PoStatus[]> = {
  DRAFT:              ['OPEN', 'CANCELLED'],
  OPEN:               ['PARTIALLY_RECEIVED', 'COMPLETED', 'SHORT_CLOSED', 'CANCELLED'],
  PARTIALLY_RECEIVED: ['COMPLETED', 'SHORT_CLOSED', 'PARTIALLY_RECEIVED', 'OPEN'],
  // Reachable again when a GRN is cancelled and receipts fall back below the ordered qty.
  COMPLETED:          ['PARTIALLY_RECEIVED', 'OPEN', 'SHORT_CLOSED'],
  SHORT_CLOSED:       ['OPEN'],
  CANCELLED:          [],
};

export const PO_LOCKED: ReadonlySet<PoStatus> = new Set<PoStatus>([
  'COMPLETED', 'SHORT_CLOSED', 'CANCELLED',
]);

/** A PO must be issued before it can receive goods. */
export const PO_RECEIVABLE: ReadonlySet<PoStatus> = new Set<PoStatus>([
  'OPEN', 'PARTIALLY_RECEIVED',
]);

/* ── Requisition (Purchase Module tab 4: internal material request) ─────────── */

export const REQUISITION_STATUSES = [
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'RETURNED',
  'PARTIALLY_ISSUED', 'FULLY_ISSUED', 'CANCELLED',
] as const;
export type RequisitionStatus = (typeof REQUISITION_STATUSES)[number];

const REQUISITION_TRANSITIONS: Record<RequisitionStatus, RequisitionStatus[]> = {
  DRAFT:             ['PENDING_APPROVAL', 'CANCELLED'],
  PENDING_APPROVAL:  ['APPROVED', 'REJECTED', 'RETURNED', 'DRAFT', 'CANCELLED'],
  // REJECTED reachable directly from APPROVED too — an authorised HOD
  // "unapproving" their own or another HOD's decision, guarded server-side
  // (requisition/routes.ts) exactly like Indent: refused once anything has
  // actually been issued against it.
  APPROVED:          ['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'REJECTED', 'CANCELLED'],
  // Rejected needs a conscious REOPEN before it becomes editable again
  // (mirrors Indent). Returned is a lighter "just fix these details" HOD
  // action and is directly editable without a separate reopen step.
  REJECTED:          ['DRAFT', 'CANCELLED'],
  RETURNED:          ['DRAFT', 'PENDING_APPROVAL', 'CANCELLED'],
  // Over-issue is a deliberately supported business rule (Rule 7/26) — more
  // issue transactions may land against an already-FULLY_ISSUED requisition,
  // and a reversal can fall a requisition back from FULLY to PARTIALLY. Once
  // every slip is reversed nothing is issued any more, so it returns to
  // APPROVED (awaiting store issue) and can then be cancelled.
  PARTIALLY_ISSUED:  ['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'APPROVED', 'CANCELLED'],
  FULLY_ISSUED:      ['PARTIALLY_ISSUED', 'FULLY_ISSUED', 'APPROVED', 'CANCELLED'],
  CANCELLED:         [],
};

/** DRAFT, PENDING_APPROVAL (mirrors Indent — HOD can review-and-edit before
 *  deciding) and RETURNED are all directly editable. */
export const REQUISITION_LOCKED: ReadonlySet<RequisitionStatus> = new Set<RequisitionStatus>([
  'APPROVED', 'REJECTED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED', 'CANCELLED',
]);

/** A requisition must be HOD-approved (and not yet fully issued beyond recall) before Store can act on it. */
export const REQUISITION_ISSUABLE: ReadonlySet<RequisitionStatus> = new Set<RequisitionStatus>([
  'APPROVED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED',
]);

/* ── GRN ────────────────────────────────────────────────────────────────────── */

export const GRN_STATUSES = ['DRAFT', 'POSTED', 'CANCELLED'] as const;
export type GrnStatus = (typeof GRN_STATUSES)[number];

const GRN_TRANSITIONS: Record<GrnStatus, GrnStatus[]> = {
  DRAFT:     ['POSTED', 'CANCELLED'],
  POSTED:    ['CANCELLED'],
  CANCELLED: [],
};

/* ── Transition checking ────────────────────────────────────────────────────── */

const LABELS: Record<string, string> = {
  DRAFT: 'Draft',
  PENDING_APPROVAL: 'Pending Approval',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  RETURNED: 'Returned',
  CANCELLED: 'Cancelled',
  CLOSED: 'Closed',
  OPEN: 'Open',
  PARTIALLY_RECEIVED: 'Partially Received',
  COMPLETED: 'Completed',
  SHORT_CLOSED: 'Short Closed',
  POSTED: 'Posted',
  PARTIALLY_ISSUED: 'Partially Issued',
  FULLY_ISSUED: 'Fully Issued',
};

export function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

function assertTransition<S extends string>(
  table: Record<S, S[]>,
  document: string,
  from: S,
  to: S,
): void {
  const allowed = table[from];
  if (!allowed) {
    throw BusinessRuleError(`${document} is in an unrecognised state (${from}).`);
  }
  if (from === to) return;
  if (!allowed.includes(to)) {
    throw BusinessRuleError(
      `A ${document} that is ${statusLabel(from)} cannot become ${statusLabel(to)}.`,
      { from, to, allowed },
    );
  }
}

/**
 * Refuses an explicit workflow ACTION (submit, approve, reject, cancel, issue,
 * post, short-close …) on a document that is already in the state that action
 * leads to.
 *
 * `assertTransition` deliberately lets `from === to` through, because a SAVE
 * may legitimately re-assert the current state (editing a pending indent and
 * pressing "save and submit" again). An ACTION is different: repeating it —
 * a double click, a stale screen, a second approver a moment later — used to
 * write a second history row and overwrite who decided, when and why on the
 * document itself. Call this BEFORE the transition check in action routes.
 */
export function assertNotAlready(document: string, documentNo: string, from: string, to: string): void {
  if (from === to) {
    throw BusinessRuleError(
      `${document} ${documentNo} is already ${statusLabel(to).toLowerCase()}.`,
      { status: from },
    );
  }
}

export const assertIndentTransition = (from: IndentStatus, to: IndentStatus) =>
  assertTransition(INDENT_TRANSITIONS, 'purchase indent', from, to);

export const assertPoTransition = (from: PoStatus, to: PoStatus) =>
  assertTransition(PO_TRANSITIONS, 'purchase order', from, to);

export const assertGrnTransition = (from: GrnStatus, to: GrnStatus) =>
  assertTransition(GRN_TRANSITIONS, 'GRN', from, to);

export const assertRequisitionTransition = (from: RequisitionStatus, to: RequisitionStatus) =>
  assertTransition(REQUISITION_TRANSITIONS, 'requisition', from, to);

/** Guards editing of a document body (lines, quantities, header fields). */
export function assertIndentEditable(status: IndentStatus, documentNo: string): void {
  if (INDENT_LOCKED.has(status)) {
    throw BusinessRuleError(
      `Indent ${documentNo} is ${statusLabel(status)} and can no longer be edited.`,
      { status },
    );
  }
}

/**
 * DRAFT and issued-but-still-open (OPEN / PARTIALLY_RECEIVED) purchase orders
 * are editable — an issued PO is not permanently read-only, but any line that
 * already has a posted GRN receipt against it can only have its quantity
 * increased or its non-quantity fields changed, never be removed or reduced
 * below what was received (enforced in purchase-order/routes.ts, which is
 * the only place with the per-line receipt history to check). A FULLY
 * received/short-closed/cancelled order is genuinely final.
 */
export function assertPoEditable(status: PoStatus, documentNo: string): void {
  if (status !== 'DRAFT' && status !== 'OPEN' && status !== 'PARTIALLY_RECEIVED') {
    throw BusinessRuleError(
      `Purchase order ${documentNo} is ${statusLabel(status)} and can no longer be edited.`,
      { status },
    );
  }
}

/** DRAFT, PENDING_APPROVAL and RETURNED are all directly editable (see REQUISITION_LOCKED). */
export function assertRequisitionEditable(status: RequisitionStatus, documentNo: string): void {
  if (REQUISITION_LOCKED.has(status)) {
    throw BusinessRuleError(
      `Requisition ${documentNo} is ${statusLabel(status)} and can no longer be edited.`,
      { status },
    );
  }
}

/**
 * A DRAFT GRN is always fully editable (nothing has moved yet). A POSTED GRN
 * remains editable too — it must not be locked merely for being posted/
 * approved — right up until a Requisition has actually issued stock against
 * one of its items; from that point the caller (grn/routes.ts) locks only the
 * quantity fields of the affected lines via `hasRequisitionConsumption`,
 * never the whole document. Only a CANCELLED GRN is closed to editing outright.
 */
export function assertGrnEditable(status: GrnStatus, documentNo: string): void {
  if (status === 'CANCELLED') {
    throw BusinessRuleError(
      `GRN ${documentNo} is ${statusLabel(status)} and can no longer be edited.`,
      { status },
    );
  }
}

/* ── Presentation tone (shared with the frontend badge palette) ─────────────── */

export type StatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'progress';

export const STATUS_TONES: Record<string, StatusTone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  RETURNED: 'warning',
  CANCELLED: 'danger',
  CLOSED: 'neutral',
  OPEN: 'info',
  PARTIALLY_RECEIVED: 'progress',
  COMPLETED: 'success',
  SHORT_CLOSED: 'warning',
  POSTED: 'success',
  PARTIALLY_ISSUED: 'progress',
  FULLY_ISSUED: 'success',
  AWAITING_RECEIPT: 'info',
  FULLY_ORDERED: 'success',
  PARTIALLY_ORDERED: 'progress',
};
