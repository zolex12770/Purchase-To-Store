/**
 * Item-wise Indent -> PO consolidation.
 *
 * When several APPROVED indents are checked for one purchase order, the same
 * item can appear on more than one of them (e.g. Pen requested on IND-001,
 * IND-002 and IND-004). The PO must carry that item as ONE line with a
 * summed quantity — never one PO line per source indent — while still
 * keeping every contributing indent traceable via `sources`.
 *
 * The item ID is the consolidation key, not the description text: two
 * different items that happen to read the same in free text must never
 * merge, and the same item ID always merges regardless of wording.
 */

export interface EligibleIndentLine {
  indent_line_id: number;
  indent_id: number;
  indent_no: string;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  /** Originally requested quantity on this one indent line. */
  indent_qty: string;
  /** Still-available-to-order quantity on this one indent line (already nets out prior POs). */
  pending_qty: string;
  estimated_rate: string | null;
  uom_id: number | null;
}

export interface ConsolidatedSource {
  indentLineId: number;
  indentId: number;
  indentNo: string;
  indentLineNo: number;
  consumedQty: string;
}

export interface ConsolidatedLine {
  itemId: number;
  itemCode: string;
  itemDescription: string;
  itemSpecification: string;
  /** Sum of `indent_qty` across every contributing indent line. */
  indentQty: string;
  /** Sum of `pending_qty` across every contributing indent line — the default PO quantity. */
  poQty: string;
  uomId: number | null;
  estimatedRate: string | null;
  sources: ConsolidatedSource[];
}

const addQty = (a: string, b: string): string => (Number(a) + Number(b)).toString();

/**
 * Ordering a PART of a consolidated line's available quantity (e.g. 4 of a
 * possible 6) still has to say exactly which indents that 4 came from — the
 * backend rejects any line whose sources don't sum to precisely its PO Qty
 * (every ordered unit must be traceable). Consumes each source in order up
 * to the new quantity, dropping any left at zero. Always call this against
 * the ORIGINAL full source breakdown, never against an already-trimmed one,
 * so repeated edits never compound a rounding/ordering error.
 */
export function reallocateSources(fullSources: ConsolidatedSource[], newQty: number): ConsolidatedSource[] {
  let remaining = newQty;
  const result: ConsolidatedSource[] = [];
  for (const s of fullSources) {
    if (remaining <= 0) break;
    const take = Math.min(Number(s.consumedQty), remaining);
    if (take > 0) {
      result.push({ ...s, consumedQty: String(take) });
      remaining -= take;
    }
  }
  return result;
}

/** A saved PO line's source as GET /purchase-orders/:id returns it (v_po_line_sources). */
export interface SavedSource {
  indent_line_id: number | string;
  indent_qty: number | string | null;
}

/**
 * The indent quantity behind a saved PO line: the indent quantity of each indent line it
 * draws from, each counted once, as consolidateEligibleLines adds it up when the PO is
 * made. Null for a line no indent is behind. The edit form showed '—' for every line,
 * though the PO carries its sources (2026-10-17 E2E run, S2-D4). Summed in
 * ten-thousandths, as stored, so 0.1 + 0.2 stays 0.3.
 */
export function indentQtyOfSources(sources: readonly SavedSource[]): string | null {
  if (sources.length === 0) return null;
  const byLine = new Map<string, number>();
  for (const s of sources) byLine.set(String(s.indent_line_id), Math.round(Number(s.indent_qty ?? 0) * 10_000));
  return String([...byLine.values()].reduce((a, b) => a + b, 0) / 10_000);
}

export function consolidateEligibleLines(rows: EligibleIndentLine[]): ConsolidatedLine[] {
  const byItem = new Map<number, ConsolidatedLine>();
  for (const e of rows) {
    const source: ConsolidatedSource = {
      indentLineId: e.indent_line_id, indentId: e.indent_id, indentNo: e.indent_no,
      indentLineNo: e.line_no, consumedQty: e.pending_qty,
    };
    const line = byItem.get(e.item_id);
    if (line) {
      line.indentQty = addQty(line.indentQty, e.indent_qty);
      line.poQty = addQty(line.poQty, e.pending_qty);
      line.sources.push(source);
    } else {
      byItem.set(e.item_id, {
        itemId: e.item_id,
        itemCode: e.item_code,
        itemDescription: e.item_description,
        itemSpecification: e.item_specification,
        indentQty: e.indent_qty,
        poQty: e.pending_qty,
        uomId: e.uom_id,
        estimatedRate: e.estimated_rate,
        sources: [source],
      });
    }
  }
  return [...byItem.values()];
}
