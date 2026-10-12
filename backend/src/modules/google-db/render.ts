/**
 * Turning a SQL row into sheet cells.
 *
 * Two deliberate omissions relative to the previous design:
 *
 *  • No `_synced_at` / `_source` metadata columns on business tabs. They were
 *    sync bookkeeping sitting in the middle of business data, on every tab, and
 *    the same facts are already recorded per sheet in the `__sync_state`
 *    control tab. Business tabs now carry business columns only.
 *
 *  • No re-ordering against whatever header the sheet happens to have. The
 *    header IS the contract; a tab whose header has drifted is repaired by the
 *    export, not worked around on every single row.
 */
import type { BusinessView } from './views/types.js';

/**
 * Dates render as ISO so a sheet reads unambiguously regardless of the viewer's
 * locale; objects as JSON; null as an EMPTY cell — never the text "null", which
 * would import back as the four-character string.
 */
export function toCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

export function headerOf(view: BusinessView): string[] {
  return view.columns.map((c) => c.header);
}

export function cellsOf(view: BusinessView, row: Record<string, unknown>): string[] {
  return view.columns.map((c) => toCell(row[c.header]));
}
