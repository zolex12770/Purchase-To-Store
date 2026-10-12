/**
 * State machine tests (SRS §10, §11.4, §12).
 *
 * These pin down which transitions are legal. A change here should be a
 * deliberate business decision, not an accident.
 */
import { describe, it, expect } from 'vitest';
import {
  assertIndentTransition, assertPoTransition, assertGrnTransition,
  assertIndentEditable, assertPoEditable, assertGrnEditable,
  statusLabel, STATUS_TONES, INDENT_STATUSES, PO_STATUSES, GRN_STATUSES,
} from './status.js';
import { AppError } from '../core/errors.js';

const throwsBusinessRule = (fn: () => void) => {
  try {
    fn();
    return false;
  } catch (err) {
    return err instanceof AppError && err.code === 'BUSINESS_RULE_VIOLATION';
  }
};

describe('purchase indent lifecycle', () => {
  it('allows the happy path', () => {
    expect(() => assertIndentTransition('DRAFT', 'PENDING_APPROVAL')).not.toThrow();
    expect(() => assertIndentTransition('PENDING_APPROVAL', 'APPROVED')).not.toThrow();
    expect(() => assertIndentTransition('APPROVED', 'CLOSED')).not.toThrow();
  });

  it('allows rejection and correction', () => {
    expect(() => assertIndentTransition('PENDING_APPROVAL', 'REJECTED')).not.toThrow();
    expect(() => assertIndentTransition('REJECTED', 'DRAFT')).not.toThrow();
  });

  it('refuses approval straight from draft', () => {
    expect(throwsBusinessRule(() => assertIndentTransition('DRAFT', 'APPROVED'))).toBe(true);
  });

  it('refuses to revive a cancelled indent', () => {
    for (const to of INDENT_STATUSES) {
      if (to === 'CANCELLED') continue;
      expect(throwsBusinessRule(() => assertIndentTransition('CANCELLED', to))).toBe(true);
    }
  });

  it('allows unapproving an APPROVED indent back to REJECTED (the state-machine half of "unapprove")', () => {
    // The FULL business rule — refused once any quantity has actually been
    // drawn into a purchase order — is enforced in indent/routes.ts, not
    // here; the state machine only decides which transitions are legal at all.
    expect(() => assertIndentTransition('APPROVED', 'REJECTED')).not.toThrow();
  });

  it('treats a no-op transition as harmless', () => {
    expect(() => assertIndentTransition('APPROVED', 'APPROVED')).not.toThrow();
  });
});

describe('purchase order lifecycle (ADR-003)', () => {
  it('allows draft → open → received → completed', () => {
    expect(() => assertPoTransition('DRAFT', 'OPEN')).not.toThrow();
    expect(() => assertPoTransition('OPEN', 'PARTIALLY_RECEIVED')).not.toThrow();
    expect(() => assertPoTransition('PARTIALLY_RECEIVED', 'COMPLETED')).not.toThrow();
  });

  it('allows a completed PO to fall back when a receipt is cancelled', () => {
    expect(() => assertPoTransition('COMPLETED', 'PARTIALLY_RECEIVED')).not.toThrow();
    expect(() => assertPoTransition('COMPLETED', 'OPEN')).not.toThrow();
  });

  it('allows short closing from open or partially received', () => {
    expect(() => assertPoTransition('OPEN', 'SHORT_CLOSED')).not.toThrow();
    expect(() => assertPoTransition('PARTIALLY_RECEIVED', 'SHORT_CLOSED')).not.toThrow();
  });

  it('refuses to cancel a PO that has receipts against it', () => {
    // Cancellation is only legal from DRAFT or OPEN; the service additionally
    // blocks OPEN once anything has been received.
    expect(throwsBusinessRule(() => assertPoTransition('PARTIALLY_RECEIVED', 'CANCELLED'))).toBe(true);
    expect(throwsBusinessRule(() => assertPoTransition('COMPLETED', 'CANCELLED'))).toBe(true);
  });

  it('refuses to revive a cancelled PO', () => {
    for (const to of PO_STATUSES) {
      if (to === 'CANCELLED') continue;
      expect(throwsBusinessRule(() => assertPoTransition('CANCELLED', to))).toBe(true);
    }
  });

  it('refuses to receive against a draft', () => {
    expect(throwsBusinessRule(() => assertPoTransition('DRAFT', 'PARTIALLY_RECEIVED'))).toBe(true);
    expect(throwsBusinessRule(() => assertPoTransition('DRAFT', 'COMPLETED'))).toBe(true);
  });
});

describe('GRN lifecycle', () => {
  it('allows draft → posted → cancelled', () => {
    expect(() => assertGrnTransition('DRAFT', 'POSTED')).not.toThrow();
    expect(() => assertGrnTransition('POSTED', 'CANCELLED')).not.toThrow();
    expect(() => assertGrnTransition('DRAFT', 'CANCELLED')).not.toThrow();
  });

  it('refuses to un-cancel a receipt', () => {
    for (const to of GRN_STATUSES) {
      if (to === 'CANCELLED') continue;
      expect(throwsBusinessRule(() => assertGrnTransition('CANCELLED', to))).toBe(true);
    }
  });
});

describe('edit locks (SRS §10 — approved documents are protected)', () => {
  it('keeps a DRAFT or PENDING_APPROVAL indent editable, and locks it once decided', () => {
    expect(() => assertIndentEditable('DRAFT', 'IND-1')).not.toThrow();
    expect(() => assertIndentEditable('PENDING_APPROVAL', 'IND-1')).not.toThrow();
    for (const s of ['APPROVED', 'REJECTED', 'CANCELLED', 'CLOSED'] as const) {
      expect(throwsBusinessRule(() => assertIndentEditable(s, 'IND-1'))).toBe(true);
    }
  });

  it('keeps a DRAFT, OPEN or PARTIALLY_RECEIVED PO editable, and locks it once genuinely final', () => {
    for (const s of ['DRAFT', 'OPEN', 'PARTIALLY_RECEIVED'] as const) {
      expect(() => assertPoEditable(s, 'PO-1')).not.toThrow();
    }
    for (const s of ['COMPLETED', 'SHORT_CLOSED', 'CANCELLED'] as const) {
      expect(throwsBusinessRule(() => assertPoEditable(s, 'PO-1'))).toBe(true);
    }
  });

  it('explains why a completed PO cannot be edited', () => {
    expect(() => assertPoEditable('COMPLETED', 'PO-20260824-0001')).toThrow();
    try {
      assertPoEditable('COMPLETED', 'PO-20260824-0001');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).message).toMatch(/completed/i);
      expect((err as AppError).message).toContain('PO-20260824-0001');
    }
  });

  it('leaves a GRN editable while DRAFT or POSTED, and locks it only once cancelled', () => {
    expect(() => assertGrnEditable('DRAFT', 'GRN-1')).not.toThrow();
    expect(() => assertGrnEditable('POSTED', 'GRN-1')).not.toThrow();
    expect(throwsBusinessRule(() => assertGrnEditable('CANCELLED', 'GRN-1'))).toBe(true);
  });
});

describe('presentation', () => {
  it('renders readable labels', () => {
    expect(statusLabel('PENDING_APPROVAL')).toBe('Pending Approval');
    expect(statusLabel('SHORT_CLOSED')).toBe('Short Closed');
  });

  it('assigns a tone to every declared status', () => {
    for (const s of [...INDENT_STATUSES, ...PO_STATUSES, ...GRN_STATUSES]) {
      expect(STATUS_TONES[s], `missing tone for ${s}`).toBeDefined();
    }
  });
});
