/**
 * Quality inspection as the GRN and QC screens tell it (backend domain/qc.ts,
 * grn/routes.ts receiveLines, qc/routes.ts).
 *
 * A line whose item needs inspection is held when its GRN is posted: it gets no stock
 * and no lot number (MLN) until QC passes it, and then only what QC accepts. The GRN
 * screen said 'It is posted and the material is added to stock' for such a GRN, never
 * showed its QC status, and offered Print Labels with no lot to print; 'Save changes'
 * on a posted GRN said 'GRN posted'; every QC decision said 'stock updated' (2026-10-17
 * E2E run, S3-D1, S3-D6, S3-D7). These are the screens' words for each state.
 */

/** Waiting for a decision: held out of stock (backend OPEN_QC_STATUSES). */
export const OPEN_QC_STATUSES: readonly string[] = ['PENDING_QC', 'QC_IN_PROGRESS', 'ON_HOLD'];
export const isQcOpen = (status: string | null | undefined): boolean => OPEN_QC_STATUSES.includes(status ?? '');

const QC_BADGE: Record<string, string> = {
  PENDING_QC: 'QC pending',
  QC_IN_PROGRESS: 'QC in progress',
  ON_HOLD: 'QC on hold',
  QC_PASSED: 'QC passed',
  ACCEPTED_WITH_DEVIATION: 'QC passed with deviation',
  QC_FAILED: 'QC failed',
  CANCELLED: 'QC closed',
};

/** The GRN's QC status in words, beside its own status; null when none of its items is inspected. */
export function qcBadgeLabel(qcStatus: string | null | undefined): string | null {
  if (!qcStatus || qcStatus === 'NOT_APPLICABLE') return null;
  return QC_BADGE[qcStatus] ?? qcStatus;
}

/** What GET /grn/:id returns about one line and its inspection. */
export interface GrnLineQcFields {
  /** The line's latest inspection status; null when its item needs none. */
  qc_inspection_status?: string | null;
  accepted_qty: string | null;
  rejected_qty: string | null;
  mln_no: string | null;
}

export type LineQc =
  /** Not inspected: received into stock with its lot when the GRN was posted. */
  | { kind: 'none' }
  /** Waiting for QC: not in stock, no lot yet. */
  | { kind: 'held'; status: string }
  /** QC decided: what it accepted went into stock with a lot, the rest is rejected. */
  | { kind: 'decided'; status: string; accepted: string; rejected: string }
  /** Closed without a decision because the GRN was cancelled. */
  | { kind: 'closed' };

export function lineQc(line: GrnLineQcFields): LineQc {
  const status = line.qc_inspection_status ?? null;
  if (!status) return { kind: 'none' };
  if (isQcOpen(status)) return { kind: 'held', status };
  if (status === 'CANCELLED') return { kind: 'closed' };
  return { kind: 'decided', status, accepted: line.accepted_qty ?? '0', rejected: line.rejected_qty ?? '0' };
}

/** Labels exist once some line has its lot: a held line gets one only when QC passes it. */
export const hasLots = (lines: readonly GrnLineQcFields[]): boolean => lines.some((l) => Boolean(l.mln_no));

/** How the GRN screen was reached from the GRN form (router state). */
export type JustSaved = 'draft' | 'posted' | 'updated';

/** The 'just saved' note on the GRN screen: what was saved, where the material is, the next step. */
export function savedNote(args: {
  justSaved: JustSaved;
  grnNo: string;
  status: string;
  lines: readonly GrnLineQcFields[];
  canPost: boolean;
}): { title: string; text: string } {
  const { justSaved, grnNo, status, lines, canPost } = args;
  const title = justSaved === 'updated' ? `Changes saved to GRN ${grnNo}.` : `Saved. GRN number: ${grnNo}.`;
  if (status === 'DRAFT') {
    return {
      title,
      text: canPost
        ? 'It is a draft. Next step: press “Post GRN” to receive this material.'
        : 'It is a draft. Next step: a person who can post GRNs must post it.',
    };
  }
  if (status !== 'POSTED') return { title, text: 'Nothing more is needed here.' };
  const held = lines.filter((l) => lineQc(l).kind === 'held').length;
  const lots = hasLots(lines);
  if (held > 0) {
    const others = lines.length - held;
    return {
      title,
      text: `${justSaved === 'updated' ? 'It stays posted.' : 'It is posted.'} ${held} of ${lines.length} line(s) are held for quality `
        + 'inspection and are not in stock: they go into stock when QC passes them.'
        + (others > 0 ? ` The other ${others} line(s) are in stock.` : '')
        + ' Next step: QC inspects them on the Quality Control screen.'
        + (lots ? ' Print the labels of the lines in stock if you need them.' : ''),
    };
  }
  if (justSaved === 'updated') return { title, text: 'It stays posted, with your changes.' };
  return {
    title,
    text: lots
      ? 'It is posted and the material is added to stock. Next step: print the labels if you need them.'
      : 'It is posted.',
  };
}

/** The toast after the GRN form saves, and the note the GRN screen then shows. */
export function grnSaveOutcome(args: { postedEdit: boolean; post: boolean; qcStatus?: string | null; grnNo: string }): {
  title: string; detail: string; justSaved: JustSaved;
} {
  const held = isQcOpen(args.qcStatus);
  // 'Save changes' on a posted GRN sends post: true, and was announced as 'GRN posted'.
  if (args.postedEdit) {
    return {
      title: 'GRN updated',
      detail: held ? `${args.grnNo} — lines that need quality inspection stay out of stock until QC passes them.` : args.grnNo,
      justSaved: 'updated',
    };
  }
  if (args.post) {
    return {
      title: 'GRN posted',
      detail: held ? `${args.grnNo} — items that need quality inspection are held until QC passes them.` : args.grnNo,
      justSaved: 'posted',
    };
  }
  return { title: 'GRN saved as draft', detail: args.grnNo, justSaved: 'draft' };
}

/** POST /qc/inspections/:id/decide answers with what happened to the stock. */
export interface QcDecisionResult {
  status: string;
  stockMoved: boolean;
  message: string;
  overallQcStatus?: string;
}

/** The toast after a QC decision: whether stock moved, not always 'stock updated'. */
export function qcDecisionToast(res: QcDecisionResult): { title: string; detail: string } {
  if (res.stockMoved) return { title: 'Decision recorded: accepted quantity added to stock', detail: res.message };
  const why = isQcOpen(res.status)
    ? 'The material stays held out of stock until QC passes or fails it.'
    : 'Nothing was accepted, so nothing went into stock.';
  return { title: 'Decision recorded: stock unchanged', detail: `${res.message} ${why}` };
}

/** Quantities in ten-thousandths, as the database stores them (NUMERIC(18,4)): 0.1 + 0.2 is 0.3. */
const units = (v: string | number | null | undefined): number => Math.round(Number(v || 0) * 10_000);
const shown = (u: number): string => String(u / 10_000);

/** What is left to reject once `accepted` of `received` is accepted, as the form fills it in: 0.3 − 0.1 is 0.2, not 0.19999999999999998. */
export function qcRemainder(received: string | number, accepted: string | number): string | null {
  const left = units(received) - units(accepted);
  return left >= 0 ? shown(left) : null;
}

/** Why a QC split cannot be submitted, or null: compared in stored units, never as floats. */
export function qcSplitProblem(accepted: string | number, rejected: string | number, received: string | number, final: boolean): string | null {
  const sum = units(accepted) + units(rejected);
  const rec = units(received);
  if (sum > rec) return `Total inspected quantity (${shown(sum)}) cannot exceed received quantity (${shown(rec)}).`;
  if (final && sum !== rec) return `A final decision must account for all ${shown(rec)} received: accepted + rejected is ${shown(sum)}.`;
  return null;
}
