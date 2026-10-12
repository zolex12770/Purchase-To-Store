/**
 * Purchase Order charge calculations — mirrors, field for field,
 * `backend/src/db/migrations/008_po_charges.sql`'s v_po_header_balance
 * formula (the backend is authoritative; this is the live-preview copy a
 * form needs before anything is saved — same relationship `amountOf()` /
 * `finalRateOf()` already have with the `purchase_order_lines` generated
 * columns).
 *
 * Sequence: line amount -> line GST -> subtotal -> PO-level charges
 * (Discount/Freight/Packing/Insurance, each % of subtotal or a fixed ₹) ->
 * grand total. GST is per line (not one PO-wide %) because different items
 * legitimately carry different GST rates.
 */
export type ChargeMode = 'PERCENTAGE' | 'AMOUNT';

export interface Charge {
  mode: ChargeMode;
  value: string;
}

export const emptyCharge = (): Charge => ({ mode: 'PERCENTAGE', value: '' });

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The charge's ₹ amount, regardless of which mode the user is currently editing. */
export function chargeAmount(charge: Charge, base: number): number {
  const v = Number(charge.value || 0);
  if (!Number.isFinite(v)) return 0;
  return charge.mode === 'PERCENTAGE' ? round2((base * v) / 100) : round2(v);
}

/** The charge's equivalent %, for the READ-ONLY side of the two-way display. */
export function chargePercentOf(charge: Charge, base: number): number {
  const v = Number(charge.value || 0);
  if (!Number.isFinite(v)) return 0;
  if (charge.mode === 'PERCENTAGE') return v;
  if (base <= 0) return 0;
  return round2((v / base) * 100);
}

export function lineGstAmount(amount: number, gstPct: number): number {
  const g = Number(gstPct || 0);
  if (!Number.isFinite(g)) return 0;
  return round2((amount * g) / 100);
}

export interface PoTotalsLine {
  amount: number;
  gstPct: number;
}

export interface PoTotalsInput {
  lines: PoTotalsLine[];
  discount: Charge;
  freight: Charge;
  packing: Charge;
  insurance: Charge;
}

export interface PoTotals {
  subtotal: number;
  totalGst: number;
  discountAmount: number;
  freightAmount: number;
  packingAmount: number;
  insuranceAmount: number;
  grandTotal: number;
}

export function computePoTotals(input: PoTotalsInput): PoTotals {
  const subtotal = round2(input.lines.reduce((acc, l) => acc + l.amount, 0));
  const totalGst = round2(input.lines.reduce((acc, l) => acc + lineGstAmount(l.amount, l.gstPct), 0));
  const discountAmount = chargeAmount(input.discount, subtotal);
  const freightAmount = chargeAmount(input.freight, subtotal);
  const packingAmount = chargeAmount(input.packing, subtotal);
  const insuranceAmount = chargeAmount(input.insurance, subtotal);
  const grandTotal = round2(
    subtotal + totalGst - discountAmount + freightAmount + packingAmount + insuranceAmount,
  );
  return { subtotal, totalGst, discountAmount, freightAmount, packingAmount, insuranceAmount, grandTotal };
}
