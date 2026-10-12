/**
 * Presentation formatting.
 *
 * Money and quantities arrive from the API as STRINGS (exact NUMERIC values —
 * ADR-004). These helpers format for display only; no value is ever converted to
 * a float and sent back to the server.
 */

export type Numeric = string | number | null | undefined;

const toNum = (v: Numeric): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Indian digit grouping (12,34,567.89) — the convention this business uses. */
export function formatIndian(value: Numeric, decimals = 2): string {
  const n = toNum(value);
  const negative = n < 0;
  const [intPart, fracPart] = Math.abs(n).toFixed(decimals).split('.');
  const digits = intPart ?? '0';
  let grouped: string;
  if (digits.length <= 3) {
    grouped = digits;
  } else {
    const last3 = digits.slice(-3);
    const rest = digits.slice(0, -3);
    grouped = `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ',')},${last3}`;
  }
  const out = fracPart ? `${grouped}.${fracPart}` : grouped;
  return negative ? `-${out}` : out;
}

export const money = (value: Numeric, decimals = 2): string => `₹${formatIndian(value, decimals)}`;

/**
 * Compact currency for KPI tiles: ₹1.24 Cr / ₹8.40 L / ₹12.5 K.
 * Uses Indian scale words because that is how this business reads large numbers.
 */
export function moneyCompact(value: Numeric): string {
  const n = toNum(value);
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${sign}₹${(abs / 1e3).toFixed(1)} K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** Quantities: trims trailing zeros so 10.0000 reads as 10. */
export function qty(value: Numeric, maxDecimals = 4): string {
  const n = toNum(value);
  const fixed = n.toFixed(maxDecimals);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return formatIndian(trimmed === '' || trimmed === '-' ? 0 : Number(trimmed), countDecimals(trimmed));
}

function countDecimals(s: string): number {
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

export function numberCompact(value: Numeric): string {
  const n = toNum(value);
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)} L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)} K`;
  return formatIndian(n, 0);
}

export const percent = (value: Numeric, decimals = 1): string => `${toNum(value).toFixed(decimals)}%`;

export const count = (value: Numeric): string => formatIndian(toNum(value), 0);

/* ── Dates ───────────────────────────────────────────────────────────────── */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `24 Aug 2026` */
export function formatDate(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

/** `24 Aug 2026, 21:30` */
export function formatDateTime(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${formatDate(d)}, ${hh}:${mm}`;
}

/** `2026-08-24` — the wire format for date inputs and API filters. */
export function toDateInput(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '';
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

export function today(): string {
  return toDateInput(new Date());
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return toDateInput(d);
}

export function startOfMonth(monthsBack = 0): string {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack, 1);
  return toDateInput(d);
}

/** `just now` / `3 h ago` / `12 Aug 2026` — for audit and activity feeds. */
export function relativeTime(value: string | Date | null | undefined): string {
  const d = parseDate(value);
  if (!d) return '—';
  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 45) return 'just now';
  if (seconds < 90) return 'a minute ago';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days} d ago`;
  return formatDate(d);
}

/** `0-7` bucket key → readable label used across ageing views. */
export function bucketLabel(key: string): string {
  const map: Record<string, string> = {
    '0-7': '0–7 days',
    '8-15': '8–15 days',
    '16-30': '16–30 days',
    '31-60': '31–60 days',
    '60+': 'Over 60 days',
  };
  return map[key] ?? key;
}

/* ── Status presentation (mirrors backend domain/status.ts) ──────────────── */

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger' | 'progress';

export const STATUS_TONE: Record<string, Tone> = {
  DRAFT: 'neutral',
  PENDING_APPROVAL: 'warning',
  APPROVED: 'success',
  REJECTED: 'danger',
  RETURNED: 'warning',
  PARTIALLY_ISSUED: 'progress',
  FULLY_ISSUED: 'success',
  CANCELLED: 'danger',
  // Bare HOD Status / Store Status values (Requisition Data Table's two
  // independent status columns) — deliberately distinct keys from the
  // underscored workflow statuses above, never merged with them.
  PENDING: 'warning',
  ISSUED: 'success',
  CLOSED: 'neutral',
  OPEN: 'info',
  PARTIALLY_RECEIVED: 'progress',
  COMPLETED: 'success',
  SHORT_CLOSED: 'warning',
  POSTED: 'success',
  AWAITING_RECEIPT: 'info',
  FULLY_ORDERED: 'success',
  PARTIALLY_ORDERED: 'progress',
  VALID: 'success',
  INVALID: 'danger',
  IMPORTED: 'success',
  SKIPPED: 'neutral',
  SUCCESS: 'success',
  PARTIAL: 'warning',
  FAILED: 'danger',
  RUNNING: 'info',
  ERROR: 'danger',
  WARNING: 'warning',
  CONFLICT: 'warning',
  VERIFIED: 'success',
  CORRUPT: 'danger',
  CREATED: 'info',
  PENDING_QC: 'warning',
  QC_IN_PROGRESS: 'info',
  QC_PASSED: 'success',
  ACCEPTED_WITH_DEVIATION: 'success',
  QC_FAILED: 'danger',
  ON_HOLD: 'warning',
  STORE_APPROVED: 'info',
  PURCHASE_APPROVED: 'info',
  CONVERTED: 'success',
  CRITICAL: 'danger',
  BELOW_REORDER: 'warning',
  EXCESS: 'info',
  NORMAL: 'success',
};

export function statusLabel(status: string | null | undefined): string {
  if (!status) return '—';
  return status
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}

export function statusTone(status: string | null | undefined): Tone {
  if (!status) return 'neutral';
  return STATUS_TONE[status] ?? 'neutral';
}

/** Blank-safe text for table cells. */
export const text = (value: unknown): string => {
  if (value === null || value === undefined) return '—';
  const s = String(value).trim();
  return s === '' ? '—' : s;
};

export const initials = (name: string): string =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('');

const UOM_SHORT_MAP: Record<string, string> = {
  NUMBERS: 'Nos', NUMBER: 'Nos', NOS: 'Nos', 'NOS.': 'Nos', 'NO.': 'Nos', NO: 'Nos',
  PIECES: 'Pcs', PIECE: 'Pcs', PCS: 'Pcs', 'PCS.': 'Pcs', PC: 'Pcs', 'PC.': 'Pcs',
  SET: 'Set', SETS: 'Set', PAIR: 'Pair', PAIRS: 'Pair', PR: 'Pair',
  KILOGRAM: 'Kg', KILOGRAMS: 'Kg', KG: 'Kg', KGS: 'Kg', 'KG.': 'Kg',
  GRAM: 'Gm', GRAMS: 'Gm', GM: 'Gm', GMS: 'Gm', 'GM.': 'Gm', G: 'Gm',
  TONNE: 'Ton', TONNES: 'Ton', TON: 'Ton', TONS: 'Ton', MT: 'Ton',
  METER: 'Mtr', METERS: 'Mtr', METRE: 'Mtr', METRES: 'Mtr', MTR: 'Mtr', MTRS: 'Mtr', 'MTR.': 'Mtr', M: 'Mtr',
  CENTIMETER: 'Cm', CENTIMETERS: 'Cm', CENTIMETRE: 'Cm', CENTIMETRES: 'Cm', CM: 'Cm',
  MILLIMETER: 'Mm', MILLIMETERS: 'Mm', MILLIMETRE: 'Mm', MILLIMETRES: 'Mm', MM: 'Mm',
  FEET: 'Ft', FOOT: 'Ft', FT: 'Ft', INCH: 'Inch', INCHES: 'Inch', IN: 'Inch',
  LITRE: 'Ltr', LITRES: 'Ltr', LITER: 'Ltr', LITERS: 'Ltr', LTR: 'Ltr', LTRS: 'Ltr', L: 'Ltr',
  MILLILITRE: 'Ml', MILLILITRES: 'Ml', MILLILITER: 'Ml', MILLILITERS: 'Ml', ML: 'Ml',
  'SQUARE METER': 'Sqm', 'SQUARE METERS': 'Sqm', 'SQUARE METRE': 'Sqm', SQM: 'Sqm', 'SQ.MTR': 'Sqm', 'SQ MTR': 'Sqm', 'SQ. MTR': 'Sqm',
  BOX: 'Box', BOXES: 'Box', ROLL: 'Roll', ROLLS: 'Roll', PACKET: 'Pkt', PACKETS: 'Pkt', PKT: 'Pkt', PKTS: 'Pkt',
  COIL: 'Coil', COILS: 'Coil', BUNDLE: 'Bdl', BUNDLES: 'Bdl', BDL: 'Bdl',
  CAN: 'Can', CANS: 'Can', BAG: 'Bag', BAGS: 'Bag', DRUM: 'Drum', DRUMS: 'Drum',
  BOTTLE: 'Btl', BOTTLES: 'Btl', BTL: 'Btl', TUBE: 'Tube', TUBES: 'Tube', SHEET: 'Sheet', SHEETS: 'Sheet', LOT: 'Lot', LOTS: 'Lot',
};

/** Standard Unit of Measure (UOM) short-form formatter. */
export function toShortUom(raw?: string | null): string {
  if (!raw) return '—';
  const clean = raw.trim();
  if (!clean || clean === '—') return '—';
  const key = clean.toUpperCase().replace(/\s+/g, ' ');
  return UOM_SHORT_MAP[key] ?? clean;
}
