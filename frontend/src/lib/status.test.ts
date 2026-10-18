import { describe, it, expect } from 'vitest';
import {
  KNOWN_STATUSES, statusMeta, stockStatusKey, movementMeta, categoryIdentity, severityTone, sentenceCase,
  LEDGER_TXN_TYPES,
} from './status';

const TONES = ['neutral', 'pending', 'attention', 'info', 'progress', 'success', 'danger', 'closed', 'void', 'warning'];

describe('statusMeta', () => {
  it('gives every known status a tone the stylesheet defines, an icon and a sentence-case label', () => {
    for (const s of KNOWN_STATUSES) {
      const m = statusMeta(s);
      expect(TONES, s).toContain(m.tone);
      expect(m.icon, s).toBeTruthy();
      expect(m.label.length, s).toBeGreaterThan(0);
      expect(m.label[0], s).toBe(m.label[0]!.toUpperCase());
      // Sentence case: no shouting labels (spec §3.6).
      expect(m.label, s).not.toBe(m.label.toUpperCase());
    }
  });

  it('keeps the distinctions the audit found blurred: cancelled is not rejected, closed is not draft', () => {
    expect(statusMeta('CANCELLED').tone).toBe('void');
    expect(statusMeta('CANCELLED').strike).toBe(true);
    expect(statusMeta('REJECTED').tone).toBe('danger');
    expect(statusMeta('CLOSED').tone).toBe('closed');
    expect(statusMeta('DRAFT').tone).toBe('neutral');
    expect(statusMeta('AWAITING_RECEIPT').tone).toBe('info');
    expect(statusMeta('SHORT_CLOSED').attention).toBe(true);
  });

  it('reads values the way the screens send them: any case, spaces or hyphens', () => {
    expect(statusMeta('pending approval').label).toBe('Pending approval');
    expect(statusMeta('Partially-Received').tone).toBe('progress');
    expect(statusMeta('  posted ').label).toBe('Posted');
  });

  it('renders an unknown status neutral with its own words, never blank', () => {
    const m = statusMeta('AWAITING_GATE_PASS');
    expect(m.tone).toBe('neutral');
    expect(m.label).toBe('Awaiting gate pass');
  });

  it('shows a dash for a missing status', () => {
    expect(statusMeta(null).label).toBe('—');
    expect(statusMeta(undefined).label).toBe('—');
    expect(statusMeta('').label).toBe('—');
  });
});

describe('stockStatusKey', () => {
  // The RM register showed a green "NORMAL" on items at −0.05 Kg (audit UI-015).
  it('never shows Healthy for live stock below zero', () => {
    expect(stockStatusKey('NORMAL', -0.05)).toBe('NEGATIVE');
    expect(stockStatusKey('NORMAL', '-0.0500')).toBe('NEGATIVE');
    expect(statusMeta(stockStatusKey('NORMAL', -0.05)).label).toBe('Negative stock');
    expect(statusMeta(stockStatusKey('EXCESS', -3)).tone).toBe('danger');
  });

  it('calls zero out of stock, however the zero is written', () => {
    expect(stockStatusKey('NORMAL', 0)).toBe('OUT_OF_STOCK');
    expect(stockStatusKey('NORMAL', '0.0000')).toBe('OUT_OF_STOCK');
    expect(stockStatusKey('NORMAL', -0)).toBe('OUT_OF_STOCK');
  });

  it('keeps the reorder classification while stock is above zero', () => {
    expect(stockStatusKey('CRITICAL', 2)).toBe('CRITICAL');
    expect(stockStatusKey('BELOW_REORDER', '15.5')).toBe('BELOW_REORDER');
    expect(stockStatusKey('NORMAL', 120)).toBe('NORMAL');
    expect(statusMeta('NORMAL').label).toBe('Healthy');
  });

  it('falls back to the classification when the quantity is missing or unreadable', () => {
    expect(stockStatusKey('CRITICAL', null)).toBe('CRITICAL');
    expect(stockStatusKey('EXCESS', undefined)).toBe('EXCESS');
    expect(stockStatusKey('BELOW_REORDER', '')).toBe('BELOW_REORDER');
    expect(stockStatusKey('CRITICAL', 'n/a')).toBe('CRITICAL');
    expect(stockStatusKey(null, 5)).toBe('NORMAL');
  });
});

describe('movementMeta', () => {
  it('puts the direction in the icon and keeps the label in ink', () => {
    const grn = movementMeta('GRN_INWARD');
    expect(grn.direction).toBe('in');
    expect(grn.label).toBe('GRN receipt');
    const issue = movementMeta('REQUISITION_ISSUE', 'OUT');
    expect(issue.direction).toBe('out');
    // An ordinary issue is not a shortage: stone, never coral (spec §3.6).
    expect(issue.iconColor).toBe('var(--text-3)');
    expect(movementMeta('STOCK_ADJUSTMENT', 'IN').direction).toBe('adjust');
  });

  it('follows the ledger direction for types it does not name, and words them', () => {
    const m = movementMeta('OPENING_STOCK', 'in');
    expect(m.direction).toBe('in');
    expect(m.label).toBe('Opening stock');
    expect(movementMeta(null).label).toBe('—');
  });

  // The ledger filter offered four types and its badges named four; INVENTORY_IN, INVENTORY_OUT,
  // INVENTORY_REVERSAL and STOCK_ADJUSTMENT_REVERSAL showed as raw codes (E2E S5-15b).
  it('lists every type the stock ledger records, each with a label of its own', () => {
    expect([...LEDGER_TXN_TYPES].sort()).toEqual([
      'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'GRN_INWARD', 'GRN_REVERSAL', 'INVENTORY_ADJUST', 'INVENTORY_IN',
      'INVENTORY_OUT', 'INVENTORY_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL', 'SHEET_SYNC',
      'STOCK_ADJUSTMENT', 'STOCK_ADJUSTMENT_REVERSAL', 'STOCK_ALIGNMENT',
    ]);
    const labels = LEDGER_TXN_TYPES.map((t) => movementMeta(t).label);
    LEDGER_TXN_TYPES.forEach((t, i) => expect(labels[i], t).not.toMatch(/_|^[A-Z_]+$/));
    // GRN_INWARD and GRN_RECEIPT are one movement; no two ledger types share a label.
    expect(new Set(labels).size).toBe(labels.length);
    expect(movementMeta('INVENTORY_IN', 'IN')).toMatchObject({ label: 'Receipt entered in ERP', direction: 'in' });
    expect(movementMeta('INVENTORY_OUT', 'OUT')).toMatchObject({ label: 'Issue entered in ERP', direction: 'out' });
    expect(movementMeta('INVENTORY_REVERSAL', 'IN')).toMatchObject({ label: 'ERP entry reversal', direction: 'in' });
    expect(movementMeta('REQUISITION_REVERSAL', 'IN')).toMatchObject({ label: 'Requisition issue reversal', direction: 'in' });
    expect(movementMeta('STOCK_ADJUSTMENT_REVERSAL', 'OUT')).toMatchObject({ label: 'Count adjustment reversal', direction: 'adjust' });
  });
});

describe('categoryIdentity and severityTone', () => {
  it('gives each inventory category the same swatch on every screen', () => {
    expect(categoryIdentity('rm')).toEqual({ code: 'RM', label: 'Raw material', swatch: 'var(--chart-1)' });
    expect(categoryIdentity(' FG ').swatch).toBe('var(--chart-3)');
    expect(categoryIdentity('CONSUMABLES')).toMatchObject({ code: 'Consumables', swatch: 'var(--tone-neutral-solid)' });
  });

  it('maps exception severity to danger, attention and info', () => {
    expect(severityTone('HIGH')).toBe('danger');
    expect(severityTone('medium')).toBe('attention');
    expect(severityTone('low')).toBe('info');
    expect(severityTone(undefined)).toBe('info');
  });

  it('sentence-cases codes', () => {
    expect(sentenceCase('QC_IN_PROGRESS')).toBe('Qc in progress');
    expect(sentenceCase('on-hold')).toBe('On hold');
  });
});
