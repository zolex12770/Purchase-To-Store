/**
 * Requisition/GRN bug-fix task, item 3: Requisition's Cost Centre must
 * auto-populate exactly like Purchase Indent — by reusing this same utility,
 * not a second mapping. These exercise the real department names involved
 * in that bug report against the utility Purchase Indent already relies on.
 */
import { describe, it, expect } from 'vitest';
import { matchCostCentre, type MatchOption } from './costCentreMatch';

const costCentres: MatchOption[] = [
  { value: 105, label: 'Power Press Department' },
  { value: 93, label: 'power press cost centre' },
  { value: 41, label: 'Tool Room Cost Centre' },
  { value: 61, label: 'Bi-Metallic Cost Centre' },
  { value: 71, label: 'Admin Cost Centre' },
  { value: 72, label: 'Admin Department' },
  { value: 80, label: 'Sales & Marketing Cost Centre' },
];

describe('matchCostCentre (Requisition reuses Purchase Indent\'s exact utility)', () => {
  it('prefers a candidate literally named "cost centre" over a same-coverage "...Department" one', () => {
    expect(matchCostCentre('Power Press', costCentres)).toBe(93);
  });

  it('resolves a single, unambiguous mapping (Tool Room)', () => {
    expect(matchCostCentre('Tool Room', costCentres)).toBe(41);
  });

  it('resolves a single, unambiguous mapping (Bi-Metallic)', () => {
    expect(matchCostCentre('Bi-Metallic', costCentres)).toBe(61);
  });

  it('trusts a stem/abbreviation match for a single-token department ("Admin" vs "Administration")', () => {
    expect(matchCostCentre('Administration', costCentres)).toBe(71);
  });

  it('matches on token overlap even with an "&" in the department name', () => {
    expect(matchCostCentre('Sales & Marketing', costCentres)).toBe(80);
  });

  it('returns null (never guesses) when nothing clears the confidence floor', () => {
    expect(matchCostCentre('Deburring', costCentres)).toBeNull();
    expect(matchCostCentre('Re-Draw', costCentres)).toBeNull();
  });

  it('returns null for an empty department label or an empty cost centre list', () => {
    expect(matchCostCentre('', costCentres)).toBeNull();
    expect(matchCostCentre('Tool Room', [])).toBeNull();
  });

  it('never invents a Cost Centre id that is not in the supplied list', () => {
    const result = matchCostCentre('Power Press', costCentres);
    expect(costCentres.some((c) => c.value === result)).toBe(true);
  });
});
