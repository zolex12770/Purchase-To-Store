/**
 * The contract a Google business tab is declared against.
 *
 * A header and its SQL expression are declared as ONE pair, so the sheet's
 * column titles and the query that fills them cannot drift apart.
 *
 * Two things carry the redesign:
 *
 *  • `columns[].cls` records WHY a column is exported (business / reporting /
 *    import / traceability). A column that cannot be justified as one of those
 *    is technical-only and does not belong in Google at all — the classification
 *    is part of the declaration rather than a document that rots beside it.
 *
 *  • `sources[]` says, for every SQL table that can affect this tab, exactly
 *    which sheet rows a change to it touches. That is what removes whole-tab
 *    rewrites: previously any table without an explicit row mapping fell back
 *    to re-exporting the entire sheet, so editing one unit-of-measure rewrote
 *    all 12,461 rows of Item Master.
 */

/** Why a column earns its place in Google (see the brief's A/B/C/D/E rule). */
export type ColumnClass =
  | 'A'   // business-critical — a purchaser needs it to do the job
  | 'B'   // useful for reporting / filtering
  | 'C'   // required to re-create the row on a controlled historical import
  | 'D';  // stable identifier or relationship needed for traceability
// There is deliberately no 'E': technical-only columns stay in SQL.

export interface BusinessColumn {
  header: string;
  expr: string;
  cls: ColumnClass;
}

/**
 * How a change to one SQL table maps onto rows of this tab.
 *
 * `restrict` is a predicate written against the view's OWN base-table aliases
 * (`pol.id`, `poh.supplier_id`, ...), with the changed rows' primary keys bound
 * to `$1` as a text[]. Two reasons it is not a comparison against sheet headers:
 *
 *  • It is spliced into the view's WHERE clause, so Postgres restricts the base
 *    tables through their indexes instead of building the whole tab and
 *    filtering afterwards.
 *
 *  • A tab therefore does not need to carry an id column purely to stay
 *    refreshable — the slimmed Purchase Order tab has no `Item ID`, yet an item
 *    rename still finds exactly the PO lines that show that item.
 *
 * Keys arrive as text because an outbox row_key is text (composite keys are
 * joined with chr(31)); cast explicitly, e.g. `pol.id::text = ANY($1)`.
 */
export interface SourceBinding {
  table: string;
  restrict: string;
  /**
   * Largest number of sheet rows one change to this table may rewrite inline.
   * Beyond it the tab is queued for a background resync instead: renaming a UOM
   * legitimately touches thousands of item rows, and that belongs in a paced
   * background job, not in a 60-second drain tick.
   */
  fanoutLimit?: number;
}

/**
 * Where a sheet column is written back to on a controlled Google -> SQL import.
 *
 * A field is either a plain column name, or a lookup reference. The reference
 * form exists because the business tabs deliberately show HUMAN values —
 * "Department: Maintenance", not "department_id: 42" — so re-creating the row
 * means resolving that name back to its lookup id in the named category.
 */
export type ImportField = string | { column: string; lookup: string };

export interface ImportTarget {
  table: string;
  pk: string[];
  fields: Record<string, ImportField>;
}

export function fieldColumn(f: ImportField): string {
  return typeof f === 'string' ? f : f.column;
}

export function fieldLookup(f: ImportField): string | null {
  return typeof f === 'string' ? null : f.lookup;
}

export interface BusinessView {
  sheet: string;
  description: string;
  /** FROM clause body — base table first, then joins. `FROM` is supplied here. */
  from: string;
  where?: string;
  /**
   * Ascending, and stable. Ascending matters: a newly created record then sorts
   * to the END, so it can be APPENDED to the tab rather than forcing every row
   * below it to shift down.
   */
  orderBy: string;
  columns: BusinessColumn[];
  primaryKey: string[];
  sources: SourceBinding[];
  /**
   * An immutable ledger (stock movements, audit trail). Existing rows are never
   * rewritten, so the drain can append without reading or diffing anything.
   */
  appendOnly?: boolean;
  importTargets?: ImportTarget[];
}

/** Double-quotes an identifier for use as a SQL alias. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** The full SELECT for a tab. */
export function buildViewSql(view: BusinessView): string {
  const select = view.columns.map((c) => `${c.expr} AS ${quoteIdent(c.header)}`).join(',\n       ');
  return [
    `SELECT ${select}`,
    `  FROM ${view.from}`,
    view.where ? ` WHERE ${view.where}` : '',
    ` ORDER BY ${view.orderBy}`,
  ].filter(Boolean).join('\n');
}

/**
 * One page of a tab, by ascending order.
 *
 * Paging is not a nicety here: PGlite runs inside the ERP's own process, so
 * materialising 100,000 rows would stall every concurrent HTTP request. The
 * export walks a tab in slices and yields between them.
 */
export function buildPagedSql(view: BusinessView, limit: number, offset: number): string {
  return `${buildViewSql(view)}\n LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}

/**
 * Rows of a tab affected by a change, per a source binding's predicate.
 *
 * The predicate is spliced into the view's own WHERE — not wrapped around the
 * finished view — so the database restricts the base tables first. Wrapping
 * instead would leave the planner free to materialise all 12,461 item rows and
 * discard 12,460 of them, which is precisely the cost this redesign removes.
 *
 * No ORDER BY: a targeted refresh addresses rows by their recorded sheet
 * position, so sorting them would be work with no effect.
 */
export function buildRestrictedSql(view: BusinessView, restrict: string, limit: number): string {
  const select = view.columns.map((c) => `${c.expr} AS ${quoteIdent(c.header)}`).join(',\n       ');
  const where = [view.where, restrict].filter(Boolean).map((w) => `(${w})`).join(' AND ');
  return `SELECT ${select}\n  FROM ${view.from}\n WHERE ${where}\n LIMIT ${Number(limit)}`;
}

/** COUNT of the rows a change would touch — used only to detect a large fan-out. */
export function buildRestrictedCountSql(view: BusinessView, restrict: string): string {
  const where = [view.where, restrict].filter(Boolean).map((w) => `(${w})`).join(' AND ');
  return `SELECT COUNT(*)::int AS n FROM ${view.from} WHERE ${where}`;
}

/** COUNT(*) for a tab, used for progress and for reconciliation. */
export function buildCountSql(view: BusinessView): string {
  return `SELECT COUNT(*)::int AS n FROM ${view.from}${view.where ? ` WHERE ${view.where}` : ''}`;
}

export function headersOf(view: BusinessView): string[] {
  return view.columns.map((c) => c.header);
}
