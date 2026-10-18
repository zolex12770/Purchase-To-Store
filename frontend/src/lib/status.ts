/**
 * Status presentation — the ONE map from a status value to its tone, icon and
 * label (redesign spec §3.6.1). StatusBadge reads it on every screen.
 *
 * Before this file the same value took different colours on different
 * screens: CANCELLED looked like REJECTED, CLOSED like DRAFT, AWAITING_RECEIPT
 * was info in one map and neutral in another, and the stock register showed a
 * green "NORMAL" on items with −0.05 Kg (audit UI-015). Every status declared
 * by the backend (domain/status.ts and the CHECK constraints) is listed here,
 * and status is never colour alone: each one also carries an icon and a
 * sentence-case label.
 */
import {
  PencilLine, Clock3, CheckCircle2, XCircle, Undo2, Ban, Lock, Send, CircleDashed,
  CheckCheck, LockKeyhole, Stamp, PackageCheck, Hourglass, Circle, TriangleAlert,
  Link2, LoaderCircle, RotateCcw, ShieldCheck, ShieldAlert, FileX2, Trash2, Eye,
  CircleSlash, CircleAlert, CircleCheck, ArrowDownLeft, ArrowUpRight, ArrowUpDown,
  Lightbulb, ShoppingCart, ListChecks, Archive, Info, OctagonAlert, TrendingDown,
  type LucideIcon,
} from 'lucide-react';

/**
 * The visual tones (tokens.css §4). `warning` is the v2 name for `pending`,
 * kept so existing `tone="warning"` callers compile and render the same.
 */
export type Tone =
  | 'neutral' | 'pending' | 'attention' | 'info' | 'progress'
  | 'success' | 'danger' | 'closed' | 'void' | 'warning';

export interface StatusMeta {
  tone: Tone;
  /** Sentence case, the same words on every screen. */
  label: string;
  icon: LucideIcon;
  /** Optional one-line explanation (badge tooltip). */
  description?: string;
  /** Void states (cancelled, reversed) strike the label through. */
  strike?: boolean;
  /** A second, attention-tone cue: accepted with deviation, short-closed. */
  attention?: boolean;
  /** In-flight states spin their icon. */
  spin?: boolean;
}

const m = (tone: Tone, label: string, icon: LucideIcon, extra: Partial<StatusMeta> = {}): StatusMeta =>
  ({ tone, label, icon, ...extra });

const STATUS: Record<string, StatusMeta> = {
  /* Documents: indent, PO, requisition, GRN (backend domain/status.ts) */
  DRAFT: m('neutral', 'Draft', PencilLine),
  PENDING_APPROVAL: m('pending', 'Pending approval', Clock3),
  APPROVED: m('success', 'Approved', CheckCircle2),
  REJECTED: m('danger', 'Rejected', XCircle),
  RETURNED: m('attention', 'Returned for correction', Undo2),
  CANCELLED: m('void', 'Cancelled', Ban, { strike: true }),
  CLOSED: m('closed', 'Closed', Lock),
  OPEN: m('info', 'Open', Send, { description: 'Issued to the supplier, awaiting receipt' }),
  PARTIALLY_RECEIVED: m('progress', 'Partially received', CircleDashed),
  COMPLETED: m('success', 'Completed', CheckCheck),
  SHORT_CLOSED: m('closed', 'Short-closed', LockKeyhole, { attention: true, description: 'Closed with quantity still unreceived' }),
  POSTED: m('success', 'Posted', Stamp),
  PARTIALLY_ISSUED: m('progress', 'Partially issued', CircleDashed),
  FULLY_ISSUED: m('success', 'Fully issued', PackageCheck),

  /* Line and derived states */
  AWAITING_RECEIPT: m('info', 'Awaiting receipt', Hourglass),
  FULLY_ORDERED: m('success', 'Fully ordered', CheckCheck),
  PARTIALLY_ORDERED: m('progress', 'Partially ordered', CircleDashed),
  NOT_ORDERED: m('neutral', 'Not ordered', Circle),

  /* HOD and Store bare statuses (requisition table) */
  PENDING: m('pending', 'Pending', Clock3),
  ISSUED: m('success', 'Issued', PackageCheck),

  /* Store issues, direct issues and count adjustments */
  REVERSED: m('void', 'Reversed', RotateCcw, { strike: true, description: 'Undone by a reversal entry; kept on record' }),

  /* Quality control */
  PENDING_QC: m('pending', 'Pending QC', Clock3),
  QC_IN_PROGRESS: m('info', 'QC in progress', Eye),
  QC_PASSED: m('success', 'QC passed', ShieldCheck),
  ACCEPTED_WITH_DEVIATION: m('success', 'Accepted with deviation', TriangleAlert, { attention: true }),
  QC_FAILED: m('danger', 'QC failed', ShieldAlert),
  ON_HOLD: m('attention', 'On hold', CircleAlert),
  NOT_APPLICABLE: m('neutral', 'Not applicable', CircleSlash),

  /* Stock health (inventory). Never "Healthy" for live stock ≤ 0: see stockStatusKey(). */
  CRITICAL: m('danger', 'Critical', OctagonAlert),
  OUT_OF_STOCK: m('danger', 'Out of stock', CircleSlash),
  ZERO: m('danger', 'Out of stock', CircleSlash),
  NEGATIVE: m('danger', 'Negative stock', TrendingDown),
  BELOW_REORDER: m('attention', 'Below reorder', TriangleAlert),
  NORMAL: m('success', 'Healthy', CircleCheck),
  EXCESS: m('info', 'Excess', Info),

  /* Auto-indent suggestions */
  SUGGESTED: m('neutral', 'Suggested', Lightbulb),
  STORE_APPROVED: m('info', 'Store approved', ListChecks),
  PURCHASE_APPROVED: m('info', 'Purchase approved', ListChecks),
  CONVERTED: m('success', 'Converted', Link2),
  ORDERED: m('success', 'Ordered', ShoppingCart),

  /* Sync, import, backup and verification jobs */
  QUEUED: m('pending', 'Queued', Hourglass),
  RUNNING: m('info', 'Running', LoaderCircle, { spin: true }),
  DONE: m('success', 'Done', CheckCircle2),
  SUCCESS: m('success', 'Succeeded', CheckCircle2),
  PARTIAL: m('attention', 'Partial', TriangleAlert),
  WARNING: m('attention', 'Warning', TriangleAlert),
  CONFLICT: m('attention', 'Conflict', TriangleAlert),
  FAILED: m('danger', 'Failed', XCircle),
  ERROR: m('danger', 'Error', XCircle),
  VALID: m('success', 'Valid', CheckCircle2),
  INVALID: m('danger', 'Invalid', XCircle),
  IMPORTED: m('success', 'Imported', CheckCircle2),
  SKIPPED: m('neutral', 'Skipped', CircleSlash),
  PREVIEW: m('info', 'Preview', Eye),
  COMMITTED: m('success', 'Committed', CheckCircle2),
  CREATED: m('info', 'Created', Archive),
  VERIFIED: m('success', 'Verified', ShieldCheck),
  CORRUPT: m('danger', 'Corrupt', FileX2),
  DELETED: m('void', 'Deleted', Trash2, { strike: true }),
  FILE_MISSING: m('danger', 'File missing', FileX2),
  RESOLVED: m('success', 'Resolved', CheckCircle2),
  IGNORED: m('void', 'Ignored', CircleSlash),

  /* Sheet reconciliation and the live verify report */
  MATCHED: m('success', 'Matches sheet', CheckCheck),
  MISMATCH: m('attention', 'Mismatch', TriangleAlert),
  NOT_IN_SHEET: m('attention', 'Not in sheet', CircleAlert),
  ERP_ONLY: m('attention', 'Only in ERP', CircleAlert),
  DISCREPANCY: m('attention', 'Discrepancy', TriangleAlert),
  DISCREPANCIES_FOUND: m('attention', 'Discrepancies found', TriangleAlert),
  INFO: m('neutral', 'Verified', Info),

  /* Exception and discrepancy severity (analytics, live verify) */
  HIGH: m('danger', 'High', OctagonAlert),
  MEDIUM: m('attention', 'Medium', TriangleAlert),
  LOW: m('info', 'Low', Info),
};

/** `PENDING_APPROVAL` → `Pending approval` (for values not in the map). */
export function sentenceCase(code: string): string {
  const s = code.replace(/[_-]+/g, ' ').trim().toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Tone, icon and label for any status value. Unknown values render neutral, never blank. */
export function statusMeta(status: string | null | undefined): StatusMeta {
  if (!status) return m('neutral', '—', Circle);
  const key = status.trim().toUpperCase().replace(/[\s-]+/g, '_');
  return STATUS[key] ?? m('neutral', sentenceCase(status), Circle);
}

/** Every status key this map knows (for tests and the status legend). */
export const KNOWN_STATUSES: readonly string[] = Object.keys(STATUS);

/**
 * The stock status to SHOW for an item. The backend classifies by reorder
 * levels only, so an item at −0.05 Kg came back NORMAL and the register showed
 * a green "Healthy" (audit UI-015). Live stock decides first.
 */
export function stockStatusKey(status: string | null | undefined, liveQty: number | string | null | undefined): string {
  const qty = liveQty === null || liveQty === undefined || liveQty === '' ? NaN : Number(liveQty);
  if (Number.isFinite(qty)) {
    if (qty < 0) return 'NEGATIVE';
    if (qty === 0) return 'OUT_OF_STOCK';
  }
  return status ?? 'NORMAL';
}

/* ── Exception severity ──────────────────────────────────────────────────── */

export function severityTone(severity: string | null | undefined): Tone {
  const s = (severity ?? '').toLowerCase();
  return s === 'high' ? 'danger' : s === 'medium' ? 'attention' : 'info';
}

/* ── Stock movements (spec §3.6): direction carries the icon, text stays ink ─ */

export interface MovementMeta {
  label: string;
  direction: 'in' | 'out' | 'adjust';
  icon: LucideIcon;
  /** CSS colour for the ICON only; the label is never coloured. */
  iconColor: string;
}

const MOVEMENT_LABEL: Record<string, string> = {
  GRN_INWARD: 'GRN receipt',
  GRN_RECEIPT: 'GRN receipt',
  GRN_REVERSAL: 'GRN reversal',
  REQUISITION_ISSUE: 'Requisition issue',
  REQUISITION_REVERSAL: 'Requisition issue reversal',
  DIRECT_ISSUE: 'Direct issue',
  DIRECT_ISSUE_REVERSAL: 'Direct issue reversal',
  STOCK_ADJUSTMENT: 'Count adjustment',
  STOCK_ADJUSTMENT_REVERSAL: 'Count adjustment reversal',
  // Movements entered on the category workspaces (backend domain/inventory.ts).
  INVENTORY_IN: 'Receipt entered in ERP',
  INVENTORY_OUT: 'Issue entered in ERP',
  INVENTORY_ADJUST: 'Stock set in ERP',
  INVENTORY_REVERSAL: 'ERP entry reversal',
  STOCK_ALIGNMENT: 'Stock alignment',
  ADJUSTMENT: 'Adjustment',
  SHEET_SYNC: 'Sheet sync',
  RETURN: 'Return',
  REVERSAL: 'Reversal',
  OPENING: 'Opening balance',
};

/**
 * Every entry type the stock ledger records (its CHECK, backend migration 028), in the order
 * the Movement Ledger's type filter offers them. The filter offered four, so the receipts and
 * issues entered on the inventory screens and every reversal could not be chosen, and their
 * rows showed raw codes (E2E S5-15b).
 */
export const LEDGER_TXN_TYPES = [
  'GRN_INWARD', 'GRN_REVERSAL', 'REQUISITION_ISSUE', 'REQUISITION_REVERSAL',
  'DIRECT_ISSUE', 'DIRECT_ISSUE_REVERSAL', 'STOCK_ADJUSTMENT', 'STOCK_ADJUSTMENT_REVERSAL',
  'INVENTORY_IN', 'INVENTORY_OUT', 'INVENTORY_ADJUST', 'INVENTORY_REVERSAL',
  'SHEET_SYNC', 'STOCK_ALIGNMENT',
] as const;

/** Inward = ↓ emerald icon, outward = ↑ stone icon, adjustment = ± plum icon. */
export function movementMeta(type: string | null | undefined, direction?: string | null): MovementMeta {
  const key = (type ?? '').toUpperCase();
  const label = MOVEMENT_LABEL[key] ?? (type ? sentenceCase(type) : '—');
  const isAdjust = /ADJUST/.test(key);
  const dir = isAdjust ? 'adjust' : (direction ?? '').toUpperCase() === 'IN' || key === 'GRN_INWARD' || key === 'GRN_RECEIPT' || key === 'RETURN' ? 'in' : 'out';
  if (dir === 'in') return { label, direction: 'in', icon: ArrowDownLeft, iconColor: 'var(--tone-success-solid)' };
  if (dir === 'adjust') return { label, direction: 'adjust', icon: ArrowUpDown, iconColor: 'var(--tone-progress-solid)' };
  return { label, direction: 'out', icon: ArrowUpRight, iconColor: 'var(--text-3)' };
}

/* ── Inventory category identity (not a status) ──────────────────────────── */

export interface CategoryIdentity { code: string; label: string; swatch: string }

/** Neutral chip + a swatch from the categorical chart palette, the same on every screen. */
const CATEGORY: Record<string, CategoryIdentity> = {
  RM: { code: 'RM', label: 'Raw material', swatch: 'var(--chart-1)' },
  FG: { code: 'FG', label: 'Finished goods', swatch: 'var(--chart-3)' },
  WIP: { code: 'WIP', label: 'Work in progress', swatch: 'var(--chart-2)' },
  TRADING: { code: 'Trading', label: 'Trading', swatch: 'var(--chart-5)' },
  GENERAL: { code: 'General', label: 'General stores', swatch: 'var(--chart-7)' },
};

export function categoryIdentity(category: string | null | undefined): CategoryIdentity {
  const key = (category ?? '').trim().toUpperCase();
  return CATEGORY[key] ?? { code: category ? sentenceCase(category) : '—', label: category ?? '—', swatch: 'var(--tone-neutral-solid)' };
}
