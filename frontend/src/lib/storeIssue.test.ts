import { describe, it, expect } from 'vitest';
import { defaultIssueQuantities, issueFiguresKey, issueRows, summariseIssue } from './storeIssue';

// Review case RV-C02c: a line asks for 2. Store user A opens the dialog on these figures…
const asOpened = [{ requisition_line_id: 41, requested_qty: '2.0000', issued_qty: '0.0000', pending_qty: '2.0000' }];
// …and store user B issues the 2 before A clicks Issue.
const afterB = [{ requisition_line_id: 41, requested_qty: '2.0000', issued_qty: '2.0000', pending_qty: '0.0000' }];

describe('the store issue dialog starts again when its figures move (review case RV-C02c)', () => {
  it('opens on each line\'s pending balance, and offers nothing for a line with none left', () => {
    expect(defaultIssueQuantities(asOpened)).toEqual({ 41: '2.0000' });
    expect(defaultIssueQuantities(afterB)).toEqual({});
  });

  it('the tick A gave was for an extra of 1; on the new figures the same quantity is an extra of 3', () => {
    const typedByA = { 41: '3' };
    expect(issueRows(asOpened, typedByA)[0]!.excess).toBe(1);
    expect(issueRows(afterB, typedByA)[0]!.excess).toBe(3);
    // Kept with the old tick, one more click would issue it (the defect).
    expect(summariseIssue(issueRows(afterB, typedByA), true).canSubmit).toBe(true);
  });

  it('B\'s issue moves the figures, so the dialog starts again from them: nothing to issue, Issue disabled', () => {
    expect(issueFiguresKey(afterB)).not.toBe(issueFiguresKey(asOpened));
    const restarted = issueRows(afterB, defaultIssueQuantities(afterB));
    expect(summariseIssue(restarted, false)).toEqual({ anyEntered: false, anyExcess: false, canSubmit: false });
  });

  it('a reversal moves them too', () => {
    const reversed = [{ ...afterB[0]!, issued_qty: '0.0000', pending_qty: '2.0000' }];
    expect(issueFiguresKey(reversed)).not.toBe(issueFiguresKey(afterB));
  });

  it('a refetch that brings the same figures, however they are written, keeps what was typed', () => {
    expect(issueFiguresKey([{ ...asOpened[0]!, requested_qty: '2', issued_qty: '0' }])).toBe(issueFiguresKey(asOpened));
  });

  it('an over-issue needs the tick; a quantity within the balance does not', () => {
    expect(summariseIssue(issueRows(asOpened, { 41: '3' }), false)).toEqual({ anyEntered: true, anyExcess: true, canSubmit: false });
    expect(summariseIssue(issueRows(asOpened, { 41: '3' }), true).canSubmit).toBe(true);
    expect(summariseIssue(issueRows(asOpened, { 41: '2' }), false)).toEqual({ anyEntered: true, anyExcess: false, canSubmit: true });
  });

  it('a line issued beyond its request counts any further quantity as extra', () => {
    const overIssued = [{ requisition_line_id: 7, requested_qty: '2', issued_qty: '3', pending_qty: '0' }];
    expect(issueRows(overIssued, { 7: '1' })[0]!.excess).toBe(1);
    expect(issueRows(overIssued, {})[0]!.excess).toBe(0);
  });
});
