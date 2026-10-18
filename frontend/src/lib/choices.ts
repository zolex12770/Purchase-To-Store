/**
 * A select keeps the value its document already holds visible, though the lookup no
 * longer offers it.
 *
 * Payment terms are stored as text, and a PO's terms (often its supplier's, e.g.
 * '30 days') need not be in the PAYMENT_TERMS lookup: the select then showed 'Select
 * terms' while saving silently kept the value (2026-10-17 E2E run, S2-D3). The PO type
 * and GRN type selects already keep theirs.
 */
export function choicesKeeping(labels: readonly string[], saved: string | null | undefined): string[] {
  return saved && !labels.includes(saved) ? [saved, ...labels] : [...labels];
}
