/**
 * What a GRN save, post, cancel or QC decision makes stale, refreshed in one place.
 *
 * A query key matches by its leading elements, so ['grn'] does not cover ['grn-doc', id],
 * the GRN screen's own key, nor ['purchase-orders'] the ['purchase-order', id] of the PO
 * screen: after a save or a post both kept showing the old copy for up to 30 s (the
 * cache's staleTime, main.tsx) (2026-10-17 E2E run, S3-D8). Each key here is a prefix
 * and covers every id.
 */
import type { QueryClient } from '@tanstack/react-query';

export const GRN_CHANGE_KEYS: readonly (readonly string[])[] = [
  ['grn'],                   // the GRN list and the GRN form's PO item picker
  ['grn-doc'],               // the GRN screen and the GRN form, every id
  ['grn-po-items-pending'],  // the Pending Receipt list
  ['grn-labels'],            // lots a posting or a QC pass created
  ['purchase-orders'],       // the PO lists and their receipt evidence
  ['purchase-order'],        // the PO screen and the PO form, every id
  ['qc-inspections'],        // inspections a posting raised or a cancel closed
  ['qc-stats'],
  ['inventory-stock'],
  ['doc-quick-view'],        // the list drawers' copies of a GRN or a PO
  ['home-work'],
];

export function refreshAfterGrnChange(qc: QueryClient): Promise<void> {
  return Promise.all(GRN_CHANGE_KEYS.map((queryKey) => qc.invalidateQueries({ queryKey: [...queryKey] }))).then(() => undefined);
}
