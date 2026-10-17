/**
 * The one-line result of an inventory sheet sync, for a toast (see backend sync-engine.ts).
 */
import { count } from './format';

/** What one sync run reports back. */
export interface SyncResult {
  category: string;
  status: 'SUCCESS' | 'PARTIAL' | 'FAILED';
  durationMs: number;
  transactionsImported: number;
  quarantinedRecords: number;
  tabs: Array<{ tab: string; reversed: number; status: string; message?: string }>;
  reconciliation: { checked: number; matched: number; mismatched: number };
  /** Codes whose sheet counts another unit than the Item Master: that figure is not in the Purchase stock. */
  purchaseStock?: { unitMismatches: Array<{ itemCode: string; itemUom: string | null; leftOut: string; aligned: boolean }> };
  errorMessage?: string;
}

export function describeSync(r: SyncResult): string {
  const reversed = r.tabs.reduce((a, t) => a + t.reversed, 0);
  // Said in the result, not only in a row tooltip: an item whose sheet counts another unit
  // stops following the sheet, and its Purchase stock goes stale unnoticed (2026-10-17 review).
  const units = r.purchaseStock?.unitMismatches ?? [];
  const unitNote = units.length === 0 ? '' :
    ` ${count(units.length)} item(s) not updated from a sheet that counts another unit than the Item Master: ` +
    `${units.slice(0, 5).map((u) => u.itemCode).join(', ')}${units.length > 5 ? ', …' : ''}.`;
  return `${r.category}: ${count(r.transactionsImported)} new entries, ${count(reversed)} removed, ` +
    `${count(r.quarantinedRecords)} rows not counted. ${count(r.reconciliation.matched)} of ${count(r.reconciliation.checked)} items match the sheet.` +
    unitNote;
}
