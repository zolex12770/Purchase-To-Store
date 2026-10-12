/**
 * Selection logic for the two "pick lines from documents" screens:
 *
 *   Purchase Order from Indent — pick whole indents, or only some items of
 *     several indents, onto ONE purchase order.
 *   GRN from Purchase Order    — pick whole POs, or only some items of several
 *     POs, onto ONE goods receipt.
 *
 * Both are the same three cases, and both screens share this one
 * implementation so they cannot drift apart:
 *
 *   1. one document, all of its lines        (tick the document)
 *   2. several documents, all of their lines (tick several documents)
 *   3. some lines of several documents       (tick individual lines)
 *
 * This is purely about WHICH lines are ticked. What may be ordered or received,
 * and how much, is decided by the server (`v_indent_line_balance`,
 * `v_po_line_balance`) and re-validated there on save.
 */

export type GroupState = 'none' | 'some' | 'all';

export interface RowGroup<T> {
  key: number;
  rows: T[];
}

/** Groups rows by their document, keeping the order the server returned them in. */
export function groupRows<T>(rows: readonly T[], keyOf: (row: T) => number): RowGroup<T>[] {
  const byKey = new Map<number, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = byKey.get(key);
    if (list) list.push(row); else byKey.set(key, [row]);
  }
  return [...byKey.entries()].map(([key, list]) => ({ key, rows: list }));
}

/**
 * Whether none, some or all of a document's PICKABLE lines are ticked.
 * A line that cannot be picked (see `canPick`) is ignored, so a document whose
 * only remaining lines are blocked never reads as "partly selected".
 */
export function groupState<T>(
  picked: ReadonlyMap<number, T>,
  rows: readonly T[],
  idOf: (row: T) => number,
  canPick: (row: T) => boolean = () => true,
): GroupState {
  const pickable = rows.filter((r) => canPick(r) || picked.has(idOf(r)));
  if (pickable.length === 0) return 'none';
  const n = pickable.filter((r) => picked.has(idOf(r))).length;
  return n === 0 ? 'none' : n === pickable.length ? 'all' : 'some';
}

/** Ticks or unticks ONE line. Returns a new map; the input is never mutated. */
export function toggleOne<T>(
  picked: ReadonlyMap<number, T>,
  row: T,
  idOf: (row: T) => number,
): Map<number, T> {
  const next = new Map(picked);
  const id = idOf(row);
  if (next.has(id)) next.delete(id); else next.set(id, row);
  return next;
}

/**
 * Ticks every pickable line of a document — or, if they are all ticked
 * already, unticks them. Lines of OTHER documents are left exactly as they are,
 * which is what lets several documents be combined.
 */
export function toggleGroup<T>(
  picked: ReadonlyMap<number, T>,
  rows: readonly T[],
  idOf: (row: T) => number,
  canPick: (row: T) => boolean = () => true,
): Map<number, T> {
  const next = new Map(picked);
  if (groupState(picked, rows, idOf, canPick) === 'all') {
    for (const r of rows) next.delete(idOf(r));
    return next;
  }
  for (const r of rows) if (canPick(r)) next.set(idOf(r), r);
  return next;
}

/** How many distinct documents the ticked lines come from. */
export function documentCount<T>(picked: ReadonlyMap<number, T>, keyOf: (row: T) => number): number {
  return new Set([...picked.values()].map(keyOf)).size;
}

/**
 * The one supplier a GRN is locked to once any line is ticked, or `null` while
 * nothing is ticked. A goods receipt is always for a single supplier — the
 * server refuses a mixed one — so the picker blocks the other suppliers' lines
 * up front and says why, rather than letting the user find out on save.
 */
export function lockedSupplier<T>(
  picked: ReadonlyMap<number, T>,
  supplierOf: (row: T) => number,
): number | null {
  for (const row of picked.values()) return supplierOf(row);
  return null;
}
