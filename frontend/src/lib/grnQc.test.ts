import { describe, it, expect } from 'vitest';
import {
  qcBadgeLabel, lineQc, hasLots, savedNote, grnSaveOutcome, qcDecisionToast, qcDecisionSplit, qcSplitProblem, qcRemainder,
  qcSplitOnDecisionChange, qcDecisionProblem, QC_PASS_DECISIONS, QC_PASS_NOTHING_ACCEPTED,
  type GrnLineQcFields, type QcFormSplit,
} from './grnQc';

const held: GrnLineQcFields = { qc_inspection_status: 'PENDING_QC', accepted_qty: null, rejected_qty: null, mln_no: null };
const plain: GrnLineQcFields = { qc_inspection_status: null, accepted_qty: null, rejected_qty: null, mln_no: 'P000000000123' };
const passed: GrnLineQcFields = { qc_inspection_status: 'QC_PASSED', accepted_qty: '8.0000', rejected_qty: '2.0000', mln_no: 'P000000000124' };

// 2026-10-17 E2E run, S3-D1: a GRN whose only line was held for inspection said 'It is
// posted and the material is added to stock' and offered Print Labels with no lot.
describe('the GRN screen and quality inspection', () => {
  it('says a held line is held and not in stock, and offers labels only once a line has its lot', () => {
    const note = savedNote({ justSaved: 'posted', grnNo: 'GRN-1', status: 'POSTED', lines: [held], canPost: true });
    expect(note.text).not.toMatch(/added to stock/);
    expect(note.text).toMatch(/1 of 1 line\(s\) are held for quality inspection and are not in stock/);
    expect(note.text).not.toMatch(/labels/);
    expect(hasLots([held])).toBe(false);
    expect(hasLots([held, plain])).toBe(true);
  });

  it('a GRN with held and received lines says which went into stock', () => {
    const note = savedNote({ justSaved: 'posted', grnNo: 'GRN-2', status: 'POSTED', lines: [held, plain], canPost: true });
    expect(note.text).toMatch(/1 of 2 line\(s\) are held/);
    expect(note.text).toMatch(/The other 1 line\(s\) are in stock/);
    expect(note.text).toMatch(/Print the labels of the lines in stock/);
  });

  it('a GRN with nothing to inspect is in stock, as before', () => {
    expect(savedNote({ justSaved: 'posted', grnNo: 'GRN-3', status: 'POSTED', lines: [plain], canPost: true }).text)
      .toBe('It is posted and the material is added to stock. Next step: print the labels if you need them.');
  });

  it('each line says whether it is held, decided or not inspected; the GRN its QC status', () => {
    expect(lineQc(held)).toEqual({ kind: 'held', status: 'PENDING_QC' });
    expect(lineQc(passed)).toEqual({ kind: 'decided', status: 'QC_PASSED', accepted: '8.0000', rejected: '2.0000' });
    expect(lineQc({ ...held, qc_inspection_status: 'CANCELLED' })).toEqual({ kind: 'closed' });
    expect(lineQc(plain)).toEqual({ kind: 'none' });
    expect(qcBadgeLabel('PENDING_QC')).toBe('QC pending');
    expect(qcBadgeLabel('ON_HOLD')).toBe('QC on hold');
    expect(qcBadgeLabel('NOT_APPLICABLE')).toBeNull();
  });
});

// S3-D6: 'Save changes' on a posted GRN sends post: true and was announced as 'GRN posted'.
describe('the GRN form toast', () => {
  it('says updated for a posted GRN saved again, posted for a first post, draft otherwise', () => {
    expect(grnSaveOutcome({ postedEdit: true, post: true, grnNo: 'GRN-4' })).toEqual({ title: 'GRN updated', detail: 'GRN-4', justSaved: 'updated' });
    expect(grnSaveOutcome({ postedEdit: false, post: true, grnNo: 'GRN-5', qcStatus: 'PENDING_QC' }))
      .toEqual({ title: 'GRN posted', detail: 'GRN-5 — items that need quality inspection are held until QC passes them.', justSaved: 'posted' });
    expect(grnSaveOutcome({ postedEdit: false, post: false, grnNo: 'GRN-6' }).title).toBe('GRN saved as draft');
    expect(savedNote({ justSaved: 'updated', grnNo: 'GRN-4', status: 'POSTED', lines: [plain], canPost: true }).title)
      .toBe('Changes saved to GRN GRN-4.');
  });
});

// S3-D7: every decision said 'stock updated', a hold or a failure included.
describe('the QC decision toast', () => {
  it('says whether stock moved', () => {
    expect(qcDecisionToast({ status: 'QC_PASSED', stockMoved: true, acceptedQty: '5.0000', rejectedQty: '0.0000', message: 'Recorded.' }))
      .toEqual({ title: 'Decision recorded: accepted quantity added to stock', detail: 'Recorded. 5 accepted into stock.' });
    expect(qcDecisionToast({ status: 'ON_HOLD', stockMoved: false, acceptedQty: '0.0000', rejectedQty: '0.0000', message: 'Recorded.' }))
      .toEqual({ title: 'Decision recorded: stock unchanged', detail: 'Recorded. The material stays held out of stock until QC passes or fails it.' });
    expect(qcDecisionToast({ status: 'QC_FAILED', stockMoved: false, acceptedQty: '0.0000', rejectedQty: '5.0000', message: 'Recorded.' }).detail)
      .toMatch(/Nothing was accepted/);
  });

  // T3 review follow-up: 'Nothing was accepted' was said of any final decision that moved
  // no stock, so a failed inspection recorded with 2 accepted was told as accepting nothing.
  it('words a final decision from the split the server recorded', () => {
    expect(qcDecisionToast({ status: 'ACCEPTED_WITH_DEVIATION', stockMoved: true, acceptedQty: '8.0000', rejectedQty: '2.0000', message: 'Recorded.' }).detail)
      .toBe('Recorded. 8 accepted into stock; 2 rejected.');
    expect(qcDecisionToast({ status: 'QC_FAILED', stockMoved: false, acceptedQty: '0.0000', rejectedQty: '5.0000', message: 'Recorded.' }))
      .toEqual({ title: 'Decision recorded: stock unchanged', detail: 'Recorded. Nothing was accepted (5 rejected), so nothing went into stock.' });
    const told = qcDecisionToast({ status: 'QC_FAILED', stockMoved: false, acceptedQty: '2.0000', rejectedQty: '3.0000', message: 'Recorded.' });
    expect(told.detail).not.toMatch(/Nothing was accepted/);
    expect(told).toEqual({
      title: 'Decision recorded: stock unchanged',
      detail: 'Recorded. 2 accepted and 3 rejected were recorded, but nothing went into stock.',
    });
    // In stored units: 0.1 accepted and 0.2 rejected of a 0.3 kg lot.
    expect(qcDecisionToast({ status: 'QC_PASSED', stockMoved: true, acceptedQty: '0.1000', rejectedQty: '0.2000', message: 'Recorded.' }).detail)
      .toBe('Recorded. 0.1 accepted into stock; 0.2 rejected.');
  });

  it("sends a failed inspection as its label says, 'Full Rejection': nothing accepted, all received rejected", () => {
    expect(qcDecisionSplit('QC_FAILED', '2', '3', '5.0000')).toEqual({ accepted: '0', rejected: '5.0000', fixed: true });
    expect(qcDecisionSplit('ACCEPTED_WITH_DEVIATION', '2', '3', '5.0000')).toEqual({ accepted: '2', rejected: '3', fixed: false });
    expect(qcDecisionSplit('QC_IN_PROGRESS', '4', '1', '10')).toEqual({ accepted: '4', rejected: '1', fixed: false });
    // Whatever the form held, what it sends is a whole final split.
    const { accepted, rejected } = qcDecisionSplit('QC_FAILED', '0.3', '0', '0.3000');
    expect(qcSplitProblem(accepted, rejected, '0.3000', true)).toBeNull();
  });

  it('fills in the rejected rest in stored units', () => {
    expect(qcRemainder('0.3000', '0.1')).toBe('0.2');
    expect(qcRemainder('10', '8')).toBe('2');
    expect(qcRemainder('1', '2')).toBeNull();
  });

  it('compares a split in stored units: 0.1 + 0.2 of 0.3 is whole', () => {
    expect(qcSplitProblem('0.1', '0.2', '0.3000', true)).toBeNull();
    expect(qcSplitProblem('0.1', '0.2', '0.3000', false)).toBeNull();
    expect(qcSplitProblem('0.2', '0.2', '0.3', false)).toBe('Total inspected quantity (0.4) cannot exceed received quantity (0.3).');
    expect(qcSplitProblem('0.1', '0.1', '0.3', true)).toBe('A final decision must account for all 0.3 received: accepted + rejected is 0.2.');
  });
});

// T3 follow-up review (P2): Update on a failed inspection opens at 0 accepted and all 5
// rejected. Switching the decision to Accepted with Deviation kept that split, which passed
// every check here; the server recorded a 'pass' that released nothing, and a pass is never
// decided again.
describe('changing the QC decision', () => {
  const received = '5.0000';
  const DECISIONS = ['QC_PASSED', 'ACCEPTED_WITH_DEVIATION', 'QC_FAILED', 'ON_HOLD', 'QC_IN_PROGRESS'];
  /** What the form sends for a decision: a failed one is fixed at 0 / all received. */
  const sent = (status: string, form: QcFormSplit): QcFormSplit => {
    const { accepted, rejected } = qcDecisionSplit(status, form.accepted, form.rejected, received);
    return { accepted, rejected };
  };

  it('never carries a failed split into a pass that can be sent', () => {
    const failed: QcFormSplit = { accepted: '0', rejected: received }; // Update on a failed inspection
    const deviation = qcSplitOnDecisionChange('QC_FAILED', 'ACCEPTED_WITH_DEVIATION', failed, received);
    expect(qcDecisionProblem('ACCEPTED_WITH_DEVIATION', sent('ACCEPTED_WITH_DEVIATION', deviation), received))
      .toBe(QC_PASS_NOTHING_ACCEPTED);

    // Every way through the decision list, up to four changes, from a failed inspection
    // (Update) and from a pending one (Inspect, which opens at QC Passed): a pass the form
    // would send accepts something.
    const walk = (from: string, form: QcFormSplit, changes: number, path: string[]): void => {
      if (changes === 0) return;
      for (const to of DECISIONS.filter((d) => d !== from)) {
        const next = qcSplitOnDecisionChange(from, to, form, received);
        const out = sent(to, next);
        if (QC_PASS_DECISIONS.includes(to) && qcDecisionProblem(to, out, received) === null) {
          expect(Number(out.accepted), [...path, to].join(' -> ')).toBeGreaterThan(0);
        }
        walk(to, next, changes - 1, [...path, to]);
      }
    };
    walk('QC_FAILED', failed, 4, ['QC_FAILED']);
    walk('QC_PASSED', { accepted: received, rejected: '0.0000' }, 4, ['QC_PASSED']);
  });

  it('starts the quantities afresh when the decision leaves QC Failed; full acceptance and full rejection set their own', () => {
    const failed: QcFormSplit = { accepted: '0', rejected: received };
    expect(qcSplitOnDecisionChange('QC_FAILED', 'ACCEPTED_WITH_DEVIATION', failed, received)).toEqual({ accepted: '', rejected: '' });
    expect(qcSplitOnDecisionChange('QC_FAILED', 'ON_HOLD', failed, received)).toEqual({ accepted: '', rejected: '' });
    expect(qcSplitOnDecisionChange('QC_FAILED', 'QC_IN_PROGRESS', failed, received)).toEqual({ accepted: '', rejected: '' });
    expect(qcSplitOnDecisionChange('QC_FAILED', 'QC_PASSED', failed, received)).toEqual({ accepted: received, rejected: '0' });
    expect(qcSplitOnDecisionChange('ON_HOLD', 'QC_FAILED', { accepted: '4', rejected: '1' }, received)).toEqual({ accepted: '0', rejected: received });
    // Between the other decisions, what was entered stays.
    expect(qcSplitOnDecisionChange('QC_PASSED', 'ACCEPTED_WITH_DEVIATION', { accepted: received, rejected: '0' }, received))
      .toEqual({ accepted: received, rejected: '0' });
    expect(qcSplitOnDecisionChange('QC_IN_PROGRESS', 'ACCEPTED_WITH_DEVIATION', { accepted: '4', rejected: '1' }, received))
      .toEqual({ accepted: '4', rejected: '1' });
  });

  it('refuses a pass that accepts nothing, however it was entered, as the server does', () => {
    for (const status of ['QC_PASSED', 'ACCEPTED_WITH_DEVIATION']) {
      expect(qcDecisionProblem(status, { accepted: '0', rejected: '5' }, received)).toBe(QC_PASS_NOTHING_ACCEPTED);
      expect(qcDecisionProblem(status, { accepted: '', rejected: '' }, received)).toBe(QC_PASS_NOTHING_ACCEPTED);
      expect(qcDecisionProblem(status, { accepted: '0.00001', rejected: '5' }, received)).toBe(QC_PASS_NOTHING_ACCEPTED);
    }
    expect(QC_PASS_NOTHING_ACCEPTED).toBe('A pass accepts some of the lot. Enter the accepted quantity, or choose QC Failed to reject all of it.');
    expect(qcDecisionProblem('ACCEPTED_WITH_DEVIATION', { accepted: '2', rejected: '3' }, received)).toBeNull();
    expect(qcDecisionProblem('ACCEPTED_WITH_DEVIATION', { accepted: '2', rejected: '' }, received))
      .toBe('A final decision must account for all 5 received: accepted + rejected is 2.');
    expect(qcDecisionProblem('QC_FAILED', sent('QC_FAILED', { accepted: '', rejected: '' }), received)).toBeNull();
    // An interim decision is not a pass: it may hold nothing yet.
    expect(qcDecisionProblem('ON_HOLD', { accepted: '', rejected: '' }, received)).toBeNull();
    expect(qcDecisionProblem('QC_IN_PROGRESS', { accepted: '0', rejected: '1' }, received)).toBeNull();
  });
});
