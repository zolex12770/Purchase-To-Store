/**
 * Who may act on a requisition, asked the way the server asks it
 * (backend requisition/routes.ts), so a screen offers only what will be accepted.
 *
 * The detail screen checked permissions alone. Everybody who may raise a
 * requisition holds requisition.edit, so Edit and Cancel showed on a colleague's
 * requisition and answered 403 (2026-10-17 E2E S1-06; a wrong HOD saw Edit, S4).
 * The server's assertOwnRequisition also wants the person who raised it, the HOD
 * it is routed to, or a Super Admin.
 *
 * Like `can()`, this is a convenience: the server re-checks every action.
 */

export interface RequisitionParties {
  requester_user_id: number | string | null | undefined;
  hod_user_id: number | string | null | undefined;
}

export interface RequisitionViewer {
  id: number | null | undefined;
  isSuperAdmin: boolean;
}

const same = (a: number | string | null | undefined, b: number | string | null | undefined): boolean =>
  a != null && b != null && Number(a) === Number(b);

export const isRaiser = (doc: RequisitionParties, viewer: RequisitionViewer): boolean => same(doc.requester_user_id, viewer.id);

export const isRequisitionHod = (doc: RequisitionParties, viewer: RequisitionViewer): boolean => same(doc.hod_user_id, viewer.id);

/** Edit, delete, reopen and cancel (assertOwnRequisition): the raiser, its HOD or a Super Admin. */
export const mayChangeRequisition = (doc: RequisitionParties, viewer: RequisitionViewer): boolean =>
  viewer.isSuperAdmin || isRaiser(doc, viewer) || isRequisitionHod(doc, viewer);

/**
 * Submit and resubmit: the raiser's own act, or a Super Admin's. The server lets
 * the HOD do it too, but the HOD who returned a requisition is waiting for the
 * raiser's correction, not resubmitting it to themselves.
 */
export const maySubmitRequisition = (doc: RequisitionParties, viewer: RequisitionViewer): boolean =>
  viewer.isSuperAdmin || isRaiser(doc, viewer);

/** Approve, return and reject (hodOnly): only the HOD it is routed to, or a Super Admin. */
export const mayDecideRequisition = (doc: RequisitionParties, viewer: RequisitionViewer): boolean =>
  viewer.isSuperAdmin || isRequisitionHod(doc, viewer);

/** Approving one's own requisition is for a Super Admin only (self-approval rule). */
export const mayApproveRequisition = (doc: RequisitionParties, viewer: RequisitionViewer): boolean =>
  mayDecideRequisition(doc, viewer) && (viewer.isSuperAdmin || !isRaiser(doc, viewer));

/* ── The create / edit form ─────────────────────────────────────────────────── */

/**
 * new and draft: a draft may be saved or submitted. pending: with the HOD, who may
 * review and correct it; saving keeps it there. returned: back with the raiser
 * for correction, then resubmitted. locked: approved, rejected, issued or
 * cancelled; the server refuses an edit (assertRequisitionEditable).
 */
export type RequisitionFormMode = 'new' | 'draft' | 'pending' | 'returned' | 'locked';

export function requisitionFormMode(isEdit: boolean, status: string | undefined): RequisitionFormMode {
  if (!isEdit) return 'new';
  switch (status) {
    case 'DRAFT': return 'draft';
    case 'PENDING_APPROVAL': return 'pending';
    case 'RETURNED': return 'returned';
    default: return 'locked';
  }
}

export interface RequisitionFormActions {
  /** Saves without submitting; null when the form may not be saved. */
  save: string | null;
  /** Saves and sends it to the HOD (submit: true); null when not offered. */
  submit: string | null;
}

/**
 * A RETURNED requisition had only "Save changes", which kept it RETURNED: it was
 * treated like one awaiting approval, and Submit was hidden for both (2026-10-17
 * E2E S4-05). The server takes RETURNED -> PENDING_APPROVAL.
 */
export function requisitionFormActions(
  mode: RequisitionFormMode,
  who: { mayChange: boolean; maySubmit: boolean },
): RequisitionFormActions {
  if (mode === 'locked' || (mode !== 'new' && !who.mayChange)) return { save: null, submit: null };
  switch (mode) {
    case 'pending': return { save: 'Save changes', submit: null };
    case 'returned': return { save: 'Save changes', submit: who.maySubmit ? 'Resubmit for HOD approval' : null };
    default: return { save: 'Save draft', submit: mode === 'new' || who.maySubmit ? 'Submit for HOD approval' : null };
  }
}
