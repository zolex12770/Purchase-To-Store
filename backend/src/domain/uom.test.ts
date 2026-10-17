/**
 * Which sheet listings make up an item's Purchase stock (the inventory sync and the
 * stock-alignment compute script share this rule).
 */
import { describe, it, expect } from 'vitest';
import { sameUnit, countsTowardsStock } from './uom.js';

describe('sameUnit', () => {
  it('ignores case and spelling, treats Nos and Pcs as one unit, and matches no missing unit', () => {
    expect(sameUnit('KG', 'Kgs')).toBe(true);
    expect(sameUnit('Nos', 'PCS')).toBe(true);
    expect(sameUnit('KG', 'Nos')).toBe(false);
    expect(sameUnit(null, 'Kg')).toBe(false);
    expect(sameUnit('', '')).toBe(false);
  });
});

describe('countsTowardsStock', () => {
  it('with an Item Master unit, counts only the listings in that unit', () => {
    expect(countsTowardsStock('KG', 'Kg', ['Kg', 'Nos'])).toBe(true);
    expect(countsTowardsStock('KG', 'Nos', ['Kg', 'Nos'])).toBe(false);
    // PTC4/0 (2026-10-16): 1,472 WIP Nos were added to 264.75 RM Kg.
    expect(countsTowardsStock('KG', 'Nos', ['Nos'])).toBe(false);
  });

  it('without one, follows the sheets when nothing is mixed', () => {
    expect(countsTowardsStock(null, 'Nos', ['Nos'])).toBe(true);
    expect(countsTowardsStock(undefined, 'Kg', ['Kg', 'KGS'])).toBe(true);
    expect(countsTowardsStock('', 'Pcs', ['Pcs', 'Nos'])).toBe(true);
    // A single listing mixes nothing, even when the sheet names no unit either.
    expect(countsTowardsStock(null, null, [null])).toBe(true);
  });

  it('without one, counts none of listings in different or unknown units', () => {
    expect(countsTowardsStock(null, 'Kg', ['Kg', 'Nos'])).toBe(false);
    expect(countsTowardsStock(null, 'Nos', ['Kg', 'Nos'])).toBe(false);
    expect(countsTowardsStock(null, null, [null, null])).toBe(false);
  });
});
