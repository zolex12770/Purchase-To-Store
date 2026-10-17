/**
 * Unit tests — a GRN's QC status, derived from its inspections (domain/qc.ts).
 */
import { describe, it, expect } from 'vitest';
import { overallQcStatus, isOpenQcStatus } from './qc.js';

describe('a GRN\'s QC status from its inspections', () => {
  it('is the least advanced inspection', () => {
    expect(overallQcStatus([])).toBe('NOT_APPLICABLE');
    expect(overallQcStatus(['QC_PASSED', 'PENDING_QC'])).toBe('PENDING_QC');
    expect(overallQcStatus(['QC_PASSED', 'ON_HOLD', 'QC_IN_PROGRESS'])).toBe('QC_IN_PROGRESS');
    expect(overallQcStatus(['QC_FAILED', 'ON_HOLD'])).toBe('ON_HOLD');
    expect(overallQcStatus(['QC_PASSED', 'QC_FAILED'])).toBe('QC_FAILED');
    expect(overallQcStatus(['ACCEPTED_WITH_DEVIATION', 'QC_PASSED'])).toBe('QC_PASSED');
  });

  it('leaves out inspections closed by a cancel', () => {
    expect(overallQcStatus(['CANCELLED', 'CANCELLED'])).toBe('CANCELLED');
    expect(overallQcStatus(['CANCELLED', 'QC_PASSED'])).toBe('QC_PASSED');
    expect(overallQcStatus(['CANCELLED', 'QC_FAILED'])).toBe('QC_FAILED');
  });

  it('counts only undecided inspections as open', () => {
    expect(['PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD'].every(isOpenQcStatus)).toBe(true);
    expect(['QC_PASSED', 'ACCEPTED_WITH_DEVIATION', 'QC_FAILED', 'CANCELLED'].some(isOpenQcStatus)).toBe(false);
  });
});
