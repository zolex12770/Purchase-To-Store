/**
 * DataTable's pure rules: header case, which trailing columns freeze, and how a
 * hand-built totals row is laid under the visible columns. Kept free of React
 * so the rules are unit-tested (dataTableModel.test.ts).
 */

/**
 * Sentence case for headers (spec §2.4): "Pending GRN Qty" → "Pending GRN qty".
 * Acronyms (two or more capitals, no lower case) and words with digits keep
 * their spelling.
 */
export function sentenceCaseHeader(header: string): string {
  return header.split(' ').map((word, i) => {
    if (i === 0 || !word) return word;
    const letters = word.replace(/[^A-Za-z]/g, '');
    if (/\d/.test(word) || (letters.length >= 2 && letters === letters.toUpperCase())) return word;
    return word.toLowerCase();
  }).join(' ');
}

export type ColumnKind = 'status' | 'actions' | 'data';

/** What a column is, as far as freezing goes: its status, its row actions, or data. */
export function columnKind(c: { key: string; header: string; locked?: boolean }): ColumnKind {
  if (/status$/i.test(c.key) || /\bstatus$/i.test(c.header.trim())) return 'status';
  if (c.locked || /^(actions?|view|ops)$/i.test(c.key) || c.header.trim() === '') return 'actions';
  return 'data';
}

export interface MeasuredColumn { key: string; kind: ColumnKind; width: number }

/* A status badge column is 110–160 px; a row-action column of two or three
   28 px icon buttons is under 130. Anything wider is a column of labelled
   buttons, and freezing it hides more than it shows. */
export const FREEZE_STATUS_MAX = 200;
export const FREEZE_ACTIONS_MAX = 160;
/** The right-frozen group may cover at most this share of the visible table. */
export const FREEZE_RIGHT_SHARE = 0.35;

/**
 * Which trailing columns `freezeLastColumn="auto"` freezes on the right, from
 * their measured widths (`visible` in display order).
 *
 * Status must never be hidden (spec §3.7). The first cut froze any trailing
 * status or actions column whatever its width, and on the RM workspace a
 * 263 px column of Receive/Issue/Adjust buttons sat on top of the Status
 * column at 1366 and 1440 (review 2026-10-16). So:
 *   • a trailing status column freezes;
 *   • a narrow trailing actions column freezes, and takes a status column
 *     just before it along, so actions never cover status — if that status
 *     column is too wide to freeze, neither freezes;
 *   • a wide actions column stays in the scroll; a status column just before
 *     it freezes alone and the actions come into view at the end of the row;
 *   • a group wider than FREEZE_RIGHT_SHARE of the table shrinks to its status
 *     column, or to nothing.
 */
export function autoFrozenRight(visible: MeasuredColumn[], tableWidth: number): string[] {
  const last = visible[visible.length - 1];
  const prev = visible[visible.length - 2];
  if (!last) return [];
  const narrowStatus = (c: MeasuredColumn | undefined): boolean =>
    Boolean(c && c.kind === 'status' && c.width > 0 && c.width <= FREEZE_STATUS_MAX);

  let group: MeasuredColumn[] = [];
  if (narrowStatus(last)) group = [last];
  else if (last.kind === 'actions') {
    const narrowActions = last.width > 0 && last.width <= FREEZE_ACTIONS_MAX;
    if (prev?.kind === 'status') {
      // Pinned alone, the actions would slide over this status column.
      if (narrowStatus(prev)) group = narrowActions ? [prev, last] : [prev];
    } else if (narrowActions) group = [last];
  }

  const fits = (g: MeasuredColumn[]) => tableWidth <= 0 || g.reduce((s, c) => s + c.width, 0) <= tableWidth * FREEZE_RIGHT_SHARE;
  if (!fits(group)) {
    const status = group.find((c) => c.kind === 'status');
    group = status && fits([status]) ? [status] : [];
  }
  return group.map((c) => c.key);
}

/** One cell of a re-laid legacy footer row. */
export interface FooterSlot {
  /** Index of the original cell, or null for a blank cell. */
  cell: number | null;
  /** Visible columns it spans. */
  span: number;
  /** Visible column it starts at. */
  start: number;
}

/**
 * Lays a hand-built `<tr>` totals row (cells with these colSpans) under the
 * visible columns.
 *
 * The row was written for the page's DEFAULT columns (every column that is not
 * `optional`), so each of its cells belongs to particular default columns, read
 * left to right. A row wider than the defaults is right-aligned, its leading
 * label absorbing the excess: v2 PoList wrote colSpan 7 + 5 cells over 10
 * columns, and the totals sat under the right-most ones. Each cell is then
 * placed under the column it belongs to, wherever that column now is: a shown
 * optional column gets a blank cell, a hidden column takes its cell with it.
 * The first cut re-spanned by position, so showing the optional "GRNs" column
 * put the PO amount under "Pending value" (review 2026-10-16).
 *
 * The leading cell, when it spans several columns, is the label: it widens
 * over everything before the first column with a total. Returns null when the
 * row cannot be matched to the defaults (the caller shows the label alone).
 */
export function planLegacyFooter(spans: number[], defaultKeys: string[], visibleKeys: string[]): FooterSlot[] | null {
  if (spans.length === 0 || visibleKeys.length === 0 || spans.some((s) => !Number.isInteger(s) || s < 1)) return null;
  const fitted = [...spans];
  const excess = fitted.reduce((s, n) => s + n, 0) - defaultKeys.length;
  if (excess > 0) {
    if (fitted[0]! - excess < 1) return null;
    fitted[0] = fitted[0]! - excess;
  }

  // Which original cell each default column belongs to.
  const owner = new Map<string, number>();
  let at = 0;
  fitted.forEach((span, cell) => {
    for (let k = 0; k < span; k++) {
      const key = defaultKeys[at + k];
      if (key !== undefined) owner.set(key, cell);
    }
    at += span;
  });

  const isLabel = fitted[0]! > 1;
  const firstTotal = visibleKeys.findIndex((k) => {
    const o = owner.get(k);
    return o !== undefined && (o > 0 || !isLabel);
  });
  const leadEnd = isLabel ? (firstTotal < 0 ? visibleKeys.length : firstTotal) : 0;

  const slots: FooterSlot[] = [];
  if (leadEnd > 0) slots.push({ cell: 0, span: leadEnd, start: 0 });
  const placed = new Set<number>();
  for (let i = leadEnd; i < visibleKeys.length;) {
    const o = owner.get(visibleKeys[i]!);
    if (o === undefined || (isLabel && o === 0)) {
      slots.push({ cell: null, span: 1, start: i });
      i++;
      continue;
    }
    // A cell over several columns must find them side by side.
    if (placed.has(o)) return null;
    let j = i + 1;
    while (j < visibleKeys.length && owner.get(visibleKeys[j]!) === o) j++;
    slots.push({ cell: o, span: j - i, start: i });
    placed.add(o);
    i = j;
  }
  return slots;
}
