import { describe, it, expect } from 'vitest';
import {
  mayChangeRequisition, maySubmitRequisition, mayDecideRequisition, mayApproveRequisition,
  requisitionFormMode, requisitionFormActions, type RequisitionViewer,
} from './requisitionAccess';

// Raised by user 7; its department's HOD is user 9.
const doc = { requester_user_id: 7, hod_user_id: 9 };
const raiser: RequisitionViewer = { id: 7, isSuperAdmin: false };
const hod: RequisitionViewer = { id: 9, isSuperAdmin: false };
const colleague: RequisitionViewer = { id: 12, isSuperAdmin: false };
const superAdmin: RequisitionViewer = { id: 1, isSuperAdmin: true };

describe('who may act on a requisition (the server\'s assertOwnRequisition and HOD checks)', () => {
  it('a colleague holding requisition.edit may not edit, delete, reopen or cancel it (E2E S1-06)', () => {
    expect(mayChangeRequisition(doc, colleague)).toBe(false);
    expect(maySubmitRequisition(doc, colleague)).toBe(false);
    expect(mayDecideRequisition(doc, colleague)).toBe(false);
  });

  it('the raiser, its HOD and a Super Admin may change it', () => {
    expect(mayChangeRequisition(doc, raiser)).toBe(true);
    expect(mayChangeRequisition(doc, hod)).toBe(true);
    expect(mayChangeRequisition(doc, superAdmin)).toBe(true);
  });

  it('submitting is the raiser\'s (or a Super Admin\'s); deciding is the HOD\'s (or a Super Admin\'s)', () => {
    expect(maySubmitRequisition(doc, raiser)).toBe(true);
    expect(maySubmitRequisition(doc, hod)).toBe(false);
    expect(maySubmitRequisition(doc, superAdmin)).toBe(true);
    expect(mayDecideRequisition(doc, hod)).toBe(true);
    expect(mayDecideRequisition(doc, raiser)).toBe(false);
    expect(mayDecideRequisition(doc, superAdmin)).toBe(true);
  });

  it('an HOD may not approve a requisition they raised; a Super Admin may', () => {
    const own = { requester_user_id: 9, hod_user_id: 9 };
    expect(mayDecideRequisition(own, hod)).toBe(true);
    expect(mayApproveRequisition(own, hod)).toBe(false);
    expect(mayApproveRequisition({ requester_user_id: 1, hod_user_id: 9 }, superAdmin)).toBe(true);
    expect(mayApproveRequisition(doc, hod)).toBe(true);
  });

  it('compares ids as numbers, and matches nobody against a missing HOD or user', () => {
    expect(mayChangeRequisition({ requester_user_id: '7', hod_user_id: null }, raiser)).toBe(true);
    expect(mayDecideRequisition({ requester_user_id: 7, hod_user_id: null }, { id: null, isSuperAdmin: false })).toBe(false);
    expect(mayChangeRequisition({ requester_user_id: null, hod_user_id: null }, { id: undefined, isSuperAdmin: false })).toBe(false);
  });
});

describe('the requisition form', () => {
  const owner = { mayChange: true, maySubmit: true };

  it('offers a RETURNED requisition back to the HOD (E2E S4-05: it offered only "Save changes")', () => {
    const mode = requisitionFormMode(true, 'RETURNED');
    expect(mode).toBe('returned');
    expect(requisitionFormActions(mode, owner)).toEqual({ save: 'Save changes', submit: 'Resubmit for HOD approval' });
  });

  it('keeps a requisition awaiting approval with the HOD: save only', () => {
    expect(requisitionFormActions(requisitionFormMode(true, 'PENDING_APPROVAL'), owner)).toEqual({ save: 'Save changes', submit: null });
  });

  it('a new requisition or a draft is saved as a draft or submitted', () => {
    const both = { save: 'Save draft', submit: 'Submit for HOD approval' };
    expect(requisitionFormActions(requisitionFormMode(false, undefined), { mayChange: false, maySubmit: false })).toEqual(both);
    expect(requisitionFormActions(requisitionFormMode(true, 'DRAFT'), owner)).toEqual(both);
  });

  it('the HOD correcting a returned requisition saves it but leaves the resubmitting to the raiser', () => {
    expect(requisitionFormActions('returned', { mayChange: true, maySubmit: false })).toEqual({ save: 'Save changes', submit: null });
  });

  it('offers nothing to a colleague, or on a requisition the server no longer lets anyone edit', () => {
    expect(requisitionFormActions('returned', { mayChange: false, maySubmit: false })).toEqual({ save: null, submit: null });
    for (const status of ['APPROVED', 'REJECTED', 'PARTIALLY_ISSUED', 'FULLY_ISSUED', 'CANCELLED']) {
      expect(requisitionFormMode(true, status), status).toBe('locked');
      expect(requisitionFormActions('locked', owner), status).toEqual({ save: null, submit: null });
    }
  });
});
