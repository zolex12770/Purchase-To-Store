/**
 * Purchase Order — create / edit (SRS §11.1).
 *
 * ONE entry point ("Create Purchase Order") that first asks which of two ways
 * the user wants, each explained in a sentence, then drives the same simple
 * pattern as the Indent form (header once, item rows below, check, save):
 *
 *   FROM INDENT — tick what to order. A tick on an indent takes all of its
 *   waiting items; a tick on a single item takes just that item. So all three
 *   cases are the same screen:
 *       one indent            -> one PO
 *       several indents       -> one PO
 *       some items of several -> one PO
 *   The same item ticked on two indents becomes ONE PO line whose quantity is
 *   traceable back to each indent (lib/consolidateIndentLines.ts). Which lines
 *   are eligible, and how much of each is left, is decided by the server and
 *   re-checked there under a lock when the PO is saved.
 *
 *   DIRECT PO — no source indent; items are searched and added directly.
 *
 * Both ways share this one form, one set of calculations and one save call.
 *
 * Fields are scoped exactly to the Purchase Order reference contract.
 * Indent To PO header: Indent No, Indent Type, PO Type, PO Date/Time, PO No,
 * Supplier. Direct PO header: PO Type, PO Date/Time, PO No, Supplier (no
 * indent fields). Line (Indent To PO adds Indent Qty): PO Qty, Item Code,
 * Item Description, Item Specification, Live Qty, Pending GRN Qty, Rate/pc,
 * Discount %, Final Rate/pc, Amount. Item Specification / Live Qty / Pending
 * GRN Qty are always-visible columns (not conditional sub-text) so they read
 * as real fields even before an item is picked.
 */
import { useState, useEffect, useMemo, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Plus, Trash2, Save, Send, ArrowLeft, ArrowRight, Info, GitMerge, ShoppingCart, Package, History, Search, X,
} from 'lucide-react';
import { api, qs, ApiError, type PageMeta } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { useLookupOptions, fetchItemProfile, type SupplierOption } from '../../lib/masters';
import { ItemSelect, SupplierSelect } from '../../components/MasterSelect';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Select, EmptyState, ErrorState, LoadingBlock, Modal,
} from '../../components/ui';
import { ItemHistoryModal } from '../../components/ItemHistoryModal';
import { StatTile } from '../../components/KpiCard';
import {
  ChoiceCards, StepBar, HelpStrip, SelectionBar, ReviewGrid, TriCheck, useDebounced,
} from '../../components/simple';
import { money, qty, today, text, count, formatDate } from '../../lib/format';
import { type Charge, type ChargeMode, emptyCharge, chargePercentOf, computePoTotals, lineGstAmount } from '../../lib/poCalc';
import { consolidateEligibleLines, reallocateSources } from '../../lib/consolidateIndentLines';
import { groupRows, groupState, toggleOne, toggleGroup, documentCount } from '../../lib/pickSelection';

interface SourceRef {
  indentLineId: number;
  indentId: number;
  indentNo: string;
  indentLineNo: number;
  consumedQty: string;
}

interface PoLineDraft {
  uid: string;
  /** Set only when this line already exists on an already-issued PO being edited — tells the
   *  server to UPDATE this exact row (preserving GRN traceability) instead of inserting a new one. */
  id: number | null;
  /** Quantity already received against this EXISTING line (0 for a brand-new line). poQty can
   *  never drop below this — the server enforces it too, this is just the up-front UI guard. */
  receivedQty: string;
  itemId: number | null;
  itemCode: string;
  itemDescription: string;
  itemSpecification: string;
  indentQty: string | null;
  poQty: string;
  uomId: number | null;
  rate: string;
  discountPct: string;
  gstPct: string;
  liveQty: string | null;
  pendingGrnQty: string | null;
  sources: SourceRef[];
  /** The full consolidated source breakdown at its original (un-trimmed) available quantity — the
   *  basis `sources` is recomputed from whenever PO Qty is edited down for a partial order. */
  fullSources: SourceRef[];
}

/** One approved indent line that still has quantity waiting for a purchase order. */
interface EligibleLine {
  indent_line_id: number;
  indent_id: number;
  indent_no: string;
  indent_date: string;
  line_no: number;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  indent_qty: string;
  ordered_qty: string;
  pending_qty: string;
  estimated_rate: string | null;
  uom_id: number | null;
  uom_code: string | null;
  department_name: string | null;
  cost_centre_name: string | null;
  indent_type_name: string | null;
  suggested_supplier_name: string | null;
}

type Mode = 'choose' | 'indent' | 'direct';

const lineIdOf = (l: EligibleLine) => l.indent_line_id;
const indentIdOf = (l: EligibleLine) => l.indent_id;

/** Oldest indent first, so a part-order is drawn from the earliest request. */
const byIndentAge = (a: EligibleLine, b: EligibleLine) =>
  a.indent_date.localeCompare(b.indent_date) || a.indent_no.localeCompare(b.indent_no) || a.line_no - b.line_no;

const newLine = (): PoLineDraft => ({
  uid: `L${Date.now()}${Math.round(performance.now() * 1000) % 1000}`,
  id: null, receivedQty: '0',
  itemId: null, itemCode: '', itemDescription: '', itemSpecification: '',
  indentQty: null, poQty: '', uomId: null, rate: '', discountPct: '0', gstPct: '0',
  liveQty: null, pendingGrnQty: null,
  sources: [], fullSources: [],
});

/** Mirrors the database's generated columns exactly (ADR-004). */
const finalRateOf = (rate: string, disc: string) =>
  Number(rate || 0) * (1 - Number(disc || 0) / 100);
const amountOf = (q: string, rate: string, disc: string) =>
  Math.round(Number(q || 0) * Number(finalRateOf(rate, disc).toFixed(4)) * 100) / 100;

/**
 * One charge's two-way %/₹ input. `charge.mode` is the source of truth for
 * which field the user is editing; the other side is always a read-only,
 * derived display (never a second input) — this is what rules out the
 * percentage-writes-amount-writes-percentage update loop.
 */
function ChargeRow({
  label, charge, onChange, base, amount, negative,
}: {
  label: string; charge: Charge; onChange: (c: Charge) => void; base: number; amount: number; negative?: boolean;
}) {
  const pct = chargePercentOf(charge, base);
  return (
    <div className="po-charges-row">
      <span>{label}</span>
      <div className="row" style={{ gap: 2 }}>
        <button type="button" className={`chip-toggle ${charge.mode === 'PERCENTAGE' ? 'active' : ''}`}
                onClick={() => onChange({ mode: 'PERCENTAGE', value: pct ? String(pct) : '' })}>%</button>
        <button type="button" className={`chip-toggle ${charge.mode === 'AMOUNT' ? 'active' : ''}`}
                onClick={() => onChange({ mode: 'AMOUNT', value: amount ? String(amount) : '' })}>₹</button>
      </div>
      <Input
        numeric type="number" step="0.01" min="0" className="input-sm"
        value={charge.value}
        placeholder="0"
        onChange={(e) => onChange({ ...charge, value: e.target.value })}
      />
      <span className="cell-muted" style={{ fontSize: 'var(--text-xs)' }}>
        {charge.mode === 'PERCENTAGE'
          ? `= ${negative ? '−' : ''}${money(amount)}`
          : `= ${pct.toFixed(2)}%`}
      </span>
    </div>
  );
}

export default function PoForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { can } = useAuth();
  const qc = useQueryClient();

  // Deep links: `?from=indent|direct` skips the choice, and `?indentId=…` /
  // `?lines=…` (from an indent, or from the Awaiting PO list) arrive with those
  // items already ticked.
  const presetIndentIds = (params.get('indentId') ?? '').split(',').map(Number).filter((n) => n > 0);
  const presetLineIds = (params.get('lines') ?? '').split(',').map(Number).filter((n) => n > 0);
  const hasPreset = presetIndentIds.length > 0 || presetLineIds.length > 0;

  const [mode, setMode] = useState<Mode>(
    isEdit || params.get('from') === 'direct' ? 'direct'
      : params.get('from') === 'indent' || hasPreset ? 'indent'
        : 'choose',
  );
  // What is ticked, keyed by indent LINE — not by indent — so a tick can mean a
  // whole indent or one item of it. The row itself is kept, so a tick survives
  // the list being searched or re-fetched.
  const [picked, setPicked] = useState<Map<number, EligibleLine>>(new Map());
  // The item list can run to hundreds of rows — keeping it as its own step
  // means it never pushes the PO-building area down the page.
  const [indentSubTab, setIndentSubTab] = useState<'select' | 'build'>('select');
  const [pickSearch, setPickSearch] = useState('');
  const pickTerm = useDebounced(pickSearch.trim());
  const [review, setReview] = useState<{ issue: boolean } | null>(null);
  // A second click can land before React has re-rendered the button as disabled,
  // so 'loading' alone does not stop a double submit. This flag is set
  // synchronously, the moment the first click is handled.
  const submitting = useRef(false);
  const [expectedDate, setExpectedDate] = useState('');
  const [poDate, setPoDate] = useState(today());
  // PO Type is its own field, stored in its own column (purchase_order_headers.po_type_id).
  const [poTypeId, setPoTypeId] = useState<number | null>(null);
  const [supplierId, setSupplierId] = useState<number | null>(null);
  const [paymentTerms, setPaymentTerms] = useState('');
  // True once the user has explicitly chosen Payment Terms themselves — until
  // then, picking a supplier keeps it defaulted from the supplier master
  // (same auto-fill/override pattern as Department -> Cost Centre on Indent).
  const paymentTermsManualRef = useRef(false);
  const [lines, setLines] = useState<PoLineDraft[]>([]);
  const [discount, setDiscount] = useState<Charge>(emptyCharge());
  const [freight, setFreight] = useState<Charge>(emptyCharge());
  const [packing, setPacking] = useState<Charge>(emptyCharge());
  const [insurance, setInsurance] = useState<Charge>(emptyCharge());
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [historyItemId, setHistoryItemId] = useState<number | null>(null);

  // PO Type's options come from the "PO Type" column of the sheet's combined
  // `Indent / PO / GRN Type` tab (the PO_TYPE list). Until that list has been
  // synced it falls back to the Indent Type list this field used before, so
  // the dropdown is never empty.
  const poTypeList = useLookupOptions('PO_TYPE');
  const indentTypeList = useLookupOptions('INDENT_TYPE');
  const poTypeBase = poTypeList.options.length > 0 ? poTypeList.options : indentTypeList.options;
  const { options: paymentTermsOptions } = useLookupOptions('PAYMENT_TERMS');
  // The chosen supplier's own record, kept from the moment it is picked. It used
  // to be looked up in a preloaded list of the first 50 suppliers, so the
  // address/GST panel and the payment-terms default only ever worked for those.
  const [selectedSupplier, setSelectedSupplier] = useState<SupplierOption | null>(null);

  // Picking a supplier defaults Payment Terms from the supplier master —
  // exactly what the backend already did silently; this just lets the user
  // see and, if needed, override it before the PO is saved.
  function chooseSupplier(supplierIdNext: number | null, supplier: SupplierOption | null) {
    setSupplierId(supplierIdNext);
    setSelectedSupplier(supplier);
    if (supplier && !paymentTermsManualRef.current) setPaymentTerms(supplier.payment_terms || '');
  }

  /* Every approved-indent LINE that still has quantity waiting for a PO — the
     server's own definition of eligible (v_indent_line_balance), so this list
     can never offer something the save would then refuse. Searched on the
     server, so it stays usable however long it grows. */
  const eligible = useQuery({
    queryKey: ['indents', 'eligible-lines', 'picker', pickTerm],
    queryFn: () => api.getWithMeta<EligibleLine[], PageMeta>(
      `/indents/eligible-lines${qs({ search: pickTerm || undefined, pageSize: 500 })}`,
    ),
    enabled: !isEdit && mode !== 'direct',
    staleTime: 0,
  });
  const eligibleRows = eligible.data?.data ?? [];
  const eligibleTotal = eligible.data?.meta.total ?? eligibleRows.length;
  const indentGroups = useMemo(() => groupRows(eligibleRows, indentIdOf), [eligibleRows]);

  /* Arriving from an indent, or from the Awaiting PO list: tick those items and
     go straight to the PO details. Fetched by indent so it works even when the
     item would be past the first page of the general list. */
  const presetDone = useRef(false);
  useEffect(() => {
    if (presetDone.current || isEdit || mode !== 'indent' || !hasPreset) return;
    presetDone.current = true;
    const wanted = new Set(presetLineIds);
    void api.get<EligibleLine[]>(
      `/indents/eligible-lines${qs({ indentId: presetIndentIds.length > 0 ? presetIndentIds.map(String) : undefined, pageSize: 500 })}`,
    ).then((rows) => {
      const take = rows.filter((r) => (wanted.size > 0 ? wanted.has(r.indent_line_id) : presetIndentIds.includes(r.indent_id)));
      if (take.length === 0) {
        toast.error('Nothing left to order', 'Those items already have a purchase order. Pick other items below.');
        return;
      }
      setPicked(new Map(take.map((r) => [r.indent_line_id, r])));
      setIndentSubTab('build');
    }).catch((err) => toast.fromError(err, 'Could not load the indent items'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isEdit]);

  const pickedKey = [...picked.keys()].sort((a, b) => a - b).join(',');
  const pickedIndentNos = useMemo(
    () => [...new Set([...picked.values()].sort(byIndentAge).map((l) => l.indent_no))],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickedKey],
  );
  const pickedIndentTypes = useMemo(
    () => [...new Set([...picked.values()].map((l) => l.indent_type_name).filter(Boolean))] as string[],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pickedKey],
  );

  /* The ticked indent lines ARE the PO lines. Item ID is the consolidation key
     (not description text) — the same item ticked on several indents becomes
     ONE PO line with a summed quantity and every contributing indent kept as a
     traceable source; different item IDs never merge even if their
     descriptions look alike. See lib/consolidateIndentLines.ts for the
     (unit-tested) algorithm.

     Rebuilt whenever the ticks change, but anything the user has already typed
     for an item that is still ticked — rate, discount, GST, specification — is
     carried over. Only a changed set of source lines resets that item's
     quantity, because the old quantity no longer describes what is ticked. */
  useEffect(() => {
    if (isEdit || mode !== 'indent') return;
    const consolidated = consolidateEligibleLines([...picked.values()].sort(byIndentAge));
    setLines((prev) => {
      const before = new Map(prev.map((l) => [l.itemId, l]));
      return consolidated.map((c) => {
        const old = before.get(c.itemId);
        const sameSources = old != null
          && old.fullSources.length === c.sources.length
          && old.fullSources.every((s, i) =>
            s.indentLineId === c.sources[i]!.indentLineId && s.consumedQty === c.sources[i]!.consumedQty);
        return {
          uid: `S${c.itemId}`,
          id: null, receivedQty: '0',
          itemId: c.itemId,
          itemCode: c.itemCode,
          itemDescription: c.itemDescription,
          itemSpecification: old?.itemSpecification ?? c.itemSpecification,
          indentQty: c.indentQty,
          poQty: sameSources ? old!.poQty : c.poQty,
          uomId: c.uomId,
          rate: old?.rate ?? c.estimatedRate ?? '',
          discountPct: old?.discountPct ?? '0',
          gstPct: old?.gstPct ?? '0',
          liveQty: old?.liveQty ?? null,
          pendingGrnQty: old?.pendingGrnQty ?? null,
          sources: sameSources ? old!.sources : c.sources,
          fullSources: c.sources,
        };
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEdit, mode, pickedKey]);

  /* Live Qty / Pending GRN Qty are item-wide figures, not part of the
     eligible-lines response — fetched once per distinct item whenever the set
     of items still needing one CHANGES.

     The dependency is that set, expressed as a string, and NOT the `lines`
     array. `lines` is replaced wholesale by `updateLine`, so keying on it made
     this effect re-run on every keystroke in every cell: each run issued one
     uncancellable request per distinct item (up to 300 lines are loaded here),
     the cleanup only discarded the RESULT, and the next keystroke fired the
     whole burst again on top of the abandoned one. That is the request storm
     behind "Page Unresponsive" while editing a PO. */
  const pendingProfileIds = useMemo(
    () => [...new Set(lines.filter((l) => l.itemId && l.liveQty === null).map((l) => l.itemId!))].sort((a, b) => a - b),
    [lines],
  );
  const pendingProfileKey = pendingProfileIds.join(',');

  useEffect(() => {
    if (pendingProfileIds.length === 0) return;
    const wanted = pendingProfileIds;
    let cancelled = false;
    void Promise.allSettled(
      wanted.map((itemId) => fetchItemProfile(itemId)
        .then((p) => [itemId, p.live.liveStockQty, p.live.pendingGrnQty] as const)),
    ).then((results) => {
      if (cancelled) return;
      const byItem = new Map<number, { live: string; pending: string }>();
      for (const r of results) {
        if (r.status !== 'fulfilled') continue;
        const [itemId, live, pending] = r.value;
        byItem.set(itemId, { live, pending });
      }
      const attempted = new Set(wanted);
      setLines((ls) => ls.map((l) => {
        if (!l.itemId) return l;
        const got = byItem.get(l.itemId);
        if (got) return { ...l, liveQty: got.live, pendingGrnQty: got.pending };
        // Asked for and did not get. Recording the attempt as an empty value
        // rather than leaving it null matters: null means "still to fetch", so
        // one failed request would otherwise be retried forever.
        if (attempted.has(l.itemId) && l.liveQty === null) return { ...l, liveQty: '', pendingGrnQty: '' };
        return l;
      }));
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingProfileKey]);

  /* One item of an indent, or the whole indent — the same map either way. */
  const pickLine = (row: EligibleLine) => setPicked((prev) => toggleOne(prev, row, lineIdOf));
  const pickIndent = (rows: EligibleLine[]) => setPicked((prev) => toggleGroup(prev, rows, lineIdOf));

  function chooseMode(next: Mode) {
    setMode(next);
    setLines([]);
    setPicked(new Map());
    setErrors({});
    setIndentSubTab('select');
  }

  async function selectDirectItem(uid: string, itemId: number | null) {
    if (itemId === null) {
      setLines((ls) => ls.map((l) => (l.uid === uid ? { ...newLine(), uid: l.uid } : l)));
      return;
    }
    try {
      const p = await fetchItemProfile(itemId);
      setLines((ls) =>
        ls.map((l) =>
          l.uid === uid
            ? {
                ...l,
                itemId: p.id, itemCode: p.itemCode, itemDescription: p.itemDescription,
                itemSpecification: p.itemSpecification, uomId: p.uomId,
                rate: p.live.lastPurchaseRate ?? p.standardRate ?? '',
                liveQty: p.live.liveStockQty,
                pendingGrnQty: p.live.pendingGrnQty,
              }
            : l,
        ),
      );
    } catch (err) {
      toast.fromError(err, 'Could not load item details');
    }
  }

  /* Editing an existing draft — always read-only item identity, whichever mode created it. */
  const existing = useQuery({
    queryKey: ['purchase-order', id],
    queryFn: () => api.get<Record<string, unknown>>(`/purchase-orders/${id}`),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data as {
      po_date: string; po_type_id: number | null; supplier_id: number; source_mode: string;
      payment_terms?: string; delivery_date?: string | null; currency_code?: string;
      supplier_name?: string; supplier_code?: string; supplier_address?: string; supplier_city?: string;
      supplier_state?: string; supplier_gst?: string; supplier_mobile?: string; supplier_email?: string;
      discount_mode?: ChargeMode; discount_value?: string; freight_mode?: ChargeMode; freight_value?: string;
      packing_mode?: ChargeMode; packing_value?: string; insurance_mode?: ChargeMode; insurance_value?: string;
      lines: (Record<string, unknown> & { sources?: Record<string, unknown>[]; po_line_id: number; received_qty?: string })[];
    };
    setPoDate(String(d.po_date).slice(0, 10));
    setExpectedDate(d.delivery_date ? String(d.delivery_date).slice(0, 10) : '');
    setPoTypeId(d.po_type_id);
    setSupplierId(d.supplier_id);
    setSelectedSupplier({
      id: d.supplier_id, supplier_code: d.supplier_code ?? '', supplier_name: d.supplier_name ?? '',
      address: d.supplier_address ?? '', city: d.supplier_city ?? '', state: d.supplier_state ?? '',
      payment_terms: d.payment_terms ?? '', currency_code: d.currency_code ?? '',
      gst_no: d.supplier_gst ?? '', mobile_no: d.supplier_mobile ?? '', email: d.supplier_email ?? '',
    });
    // A loaded PO's saved terms are authoritative — never auto-overwrite them.
    paymentTermsManualRef.current = true;
    setPaymentTerms(d.payment_terms ?? '');
    setMode(d.source_mode === 'INDENT' ? 'indent' : 'direct');
    setDiscount({ mode: d.discount_mode ?? 'PERCENTAGE', value: String(d.discount_value ?? '0') });
    setFreight({ mode: d.freight_mode ?? 'PERCENTAGE', value: String(d.freight_value ?? '0') });
    setPacking({ mode: d.packing_mode ?? 'PERCENTAGE', value: String(d.packing_value ?? '0') });
    setInsurance({ mode: d.insurance_mode ?? 'PERCENTAGE', value: String(d.insurance_value ?? '0') });
    setLines(
      (d.lines ?? []).map((l, i) => ({
        uid: `E${i}`,
        id: Number(l.po_line_id),
        receivedQty: String(l.received_qty ?? '0'),
        itemId: Number(l.item_id),
        itemCode: String(l.item_code ?? ''),
        itemDescription: String(l.item_description ?? ''),
        itemSpecification: String(l.item_specification ?? ''),
        indentQty: null,
        poQty: String(l.po_qty ?? ''),
        uomId: l.uom_id ? Number(l.uom_id) : null,
        rate: String(l.rate ?? ''),
        discountPct: String(l.discount_pct ?? '0'),
        gstPct: String(l.gst_pct ?? '0'),
        liveQty: null,
        pendingGrnQty: null,
        sources: (l.sources ?? []).map((s) => ({
          indentLineId: Number(s.indent_line_id),
          indentId: Number(s.indent_id),
          indentNo: String(s.indent_no ?? ''),
          indentLineNo: Number(s.indent_line_no ?? 0),
          consumedQty: String(s.consumed_qty ?? ''),
        })),
        fullSources: (l.sources ?? []).map((s) => ({
          indentLineId: Number(s.indent_line_id),
          indentId: Number(s.indent_id),
          indentNo: String(s.indent_no ?? ''),
          indentLineNo: Number(s.indent_line_no ?? 0),
          consumedQty: String(s.consumed_qty ?? ''),
        })),
      })),
    );
  }, [existing.data]);

  const updateLine = (uid: string, patch: Partial<PoLineDraft>) =>
    setLines((ls) => ls.map((l) => {
      if (l.uid !== uid) return l;
      const next = { ...l, ...patch };
      // Ordering less than the full consolidated amount must still name exactly
      // which indent(s) it came from — re-split against the original full
      // breakdown every time PO Qty changes, never against an already-trimmed one.
      if ('poQty' in patch && l.fullSources.length > 0) {
        next.sources = reallocateSources(l.fullSources, Number(patch.poQty || 0));
      }
      return next;
    }));

  const removeLine = (uid: string) => {
    // On a new PO from indents the lines are derived from the ticks, so removing
    // a line means unticking what it was built from — otherwise it would come
    // straight back, and the item list would still show it as chosen.
    const target = lines.find((l) => l.uid === uid);
    if (!isEdit && mode === 'indent' && target) {
      setPicked((prev) => {
        const next = new Map(prev);
        for (const s of target.fullSources) next.delete(s.indentLineId);
        return next;
      });
      return;
    }
    setLines((ls) => ls.filter((l) => l.uid !== uid));
  };

  const totals = useMemo(() => {
    let gross = 0, quantity = 0;
    for (const l of lines) {
      gross += Number(l.poQty || 0) * Number(l.rate || 0);
      quantity += Number(l.poQty || 0);
    }
    const charges = computePoTotals({
      lines: lines.map((l) => ({ amount: amountOf(l.poQty, l.rate, l.discountPct), gstPct: Number(l.gstPct || 0) })),
      discount, freight, packing, insurance,
    });
    return { gross, quantity, lineDiscount: gross - charges.subtotal, ...charges };
  }, [lines, discount, freight, packing, insurance]);

  const validLines = lines.filter((l) => l.itemId && Number(l.poQty) > 0 && l.rate !== '');
  const distinctIndents = new Set(lines.flatMap((l) => l.sources.map((s) => s.indentNo)));
  // Editing an already-issued PO (OPEN / PARTIALLY_RECEIVED) never re-issues
  // it — "Issue purchase order" only makes sense for a DRAFT being issued
  // for the first time.
  const existingStatus = (existing.data as { status?: string } | undefined)?.status;
  const editingIssued = isEdit && existingStatus != null && existingStatus !== 'DRAFT';

  const save = useMutation({
    mutationFn: ({ issue }: { issue: boolean }) => {
      const payload = {
        poDate, poTypeId, supplierId, paymentTerms, issue,
        // The expected date is one date for the order; it is also stamped on
        // each line, which is what the "overdue" lists read.
        deliveryDate: expectedDate || null,
        lines: validLines.map((l) => ({
          ...(l.id != null ? { id: l.id } : {}),
          itemId: l.itemId, poQty: l.poQty, uomId: l.uomId,
          rate: l.rate, discountPct: l.discountPct || '0', gstPct: l.gstPct || '0',
          itemSpecification: l.itemSpecification,
          deliveryDate: expectedDate || null,
          sources: l.sources.map((s) => ({ indentLineId: s.indentLineId, consumedQty: s.consumedQty })),
        })),
        discount, freight, packing, insurance,
      };
      return isEdit
        ? api.put<{ id: number; po_no: string }>(`/purchase-orders/${id}`, payload)
        : api.post<{ id: number; po_no: string }>('/purchase-orders', payload);
    },
    onSuccess: (res, vars) => {
      setReview(null);
      toast.success(vars.issue ? 'Purchase order issued' : 'Purchase order saved', res.po_no);
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['indents'] });
      void qc.invalidateQueries({ queryKey: ['home-work'] });
      // The PO screen opens with its number and what can be done next.
      navigate(`/purchase-orders/${res.id}`, { state: { justSaved: vars.issue ? 'issued' : 'draft' } });
    },
    onError: (err) => {
      setReview(null);
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  /** Checks the form, then shows the "check before saving" summary. Nothing is saved here. */
  function attemptSave(issue: boolean) {
    const issues: Record<string, string> = {};
    if (!supplierId) issues.supplierId = 'Choose the supplier.';
    if (validLines.length === 0) issues.lines = mode === 'indent'
      ? 'Tick at least one indent item, then enter its rate.'
      : 'Add at least one item with a quantity and a rate.';
    const noRate = lines.find((l) => l.itemId && Number(l.poQty) > 0 && l.rate === '');
    if (noRate) issues.lines = `Enter the rate for ${noRate.itemCode}.`;
    const noQty = lines.find((l) => l.itemId && !(Number(l.poQty) > 0));
    if (noQty) issues.lines = `Enter the quantity for ${noQty.itemCode}. To leave this item out, remove it.`;
    // More than the indents still have waiting is refused by the server; say so
    // here, next to the number, instead of after the round trip.
    const overIndent = lines.find((l) => l.fullSources.length > 0 && !isEdit
      && Number(l.poQty) > l.fullSources.reduce((s, x) => s + Number(x.consumedQty), 0) + 0.00005);
    if (overIndent) {
      const max = overIndent.fullSources.reduce((s, x) => s + Number(x.consumedQty), 0);
      issues.lines = `${overIndent.itemCode}: the indents have only ${qty(max)} waiting. Enter ${qty(max)} or less.`;
    }
    const belowReceived = lines.find((l) => Number(l.poQty) < Number(l.receivedQty));
    if (belowReceived) {
      issues.lines = `${belowReceived.itemCode || 'A line'} already has ${qty(belowReceived.receivedQty)} received — quantity cannot go below that.`;
    }
    setErrors(issues);
    if (Object.keys(issues).length > 0) {
      toast.error('Please complete the purchase order', Object.values(issues)[0]);
      return;
    }
    setReview({ issue });
  }

  if (isEdit && existing.isLoading) return <LoadingBlock label="Loading purchase order…" />;

  // A PO being edited may carry a type that is no longer offered (an older
  // value since switched off). It must still show, and survive the save.
  const existingTypeName = (existing.data as { po_type_name?: string | null } | undefined)?.po_type_name ?? null;
  const poTypes = poTypeId != null && existingTypeName && !poTypeBase.some((o) => o.value === poTypeId)
    ? [{ value: poTypeId, label: existingTypeName }, ...poTypeBase]
    : poTypeBase;

  const indentTypeDisplay = pickedIndentTypes.length === 0 ? ''
    : pickedIndentTypes.length === 1 ? pickedIndentTypes[0]!
      : 'Multiple';

  const pickedIndentCount = documentCount(picked, indentIdOf);
  const onSelectStep = !isEdit && mode === 'indent' && indentSubTab === 'select';
  const showForm = isEdit || mode === 'direct' || (mode === 'indent' && indentSubTab === 'build');
  const stepIndex = review ? 2 : onSelectStep ? 0 : 1;

  const backToList = () => navigate('/purchase-orders');

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit Purchase Order' : 'Create Purchase Order'}
        subtitle={
          isEdit ? 'Change what is needed, then save.'
            : mode === 'choose' ? 'First choose how you want to make this purchase order.'
              : mode === 'indent' ? 'From Indent — order material that was asked for in an approved indent.'
                : 'Direct PO — order material without an indent.'
        }
        breadcrumbs={[{ label: 'Purchase Order', to: '/purchase-orders' }, { label: isEdit ? 'Edit' : 'Create' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={backToList}>Cancel</Button>
            {showForm && (
              <>
                <Button variant={editingIssued ? 'primary' : 'secondary'} size="sm" icon={<Save size={13} />}
                        disabled={save.isPending}
                        onClick={() => attemptSave(false)}>
                  {editingIssued ? 'Save changes' : 'Save draft'}
                </Button>
                {!editingIssued && can('po.approve') && (
                  <Button variant="primary" size="sm" icon={<Send size={13} />}
                          disabled={save.isPending}
                          onClick={() => attemptSave(true)}>
                    Issue purchase order
                  </Button>
                )}
              </>
            )}
          </>
        }
      />

      {/* ── One entry point, two clearly explained ways ───────────────────────── */}
      {!isEdit && mode === 'choose' && (
        <>
          <HelpStrip>
            <strong>How do you want to make this purchase order?</strong> Choose one. You can come back and choose the other.
          </HelpStrip>
          <ChoiceCards
            onChoose={(k) => chooseMode(k as Mode)}
            choices={[
              {
                key: 'indent',
                title: 'From Indent',
                text: 'Use this when the material was already asked for in an approved indent. You can take one indent, many indents, or only some items.',
                icon: <GitMerge size={28} />,
                go: 'Choose indent items',
                note: eligible.isLoading ? 'Checking what is waiting…'
                  : eligible.error ? 'Could not check what is waiting.'
                    : eligibleTotal === 0 ? 'No indent items are waiting for a purchase order right now.'
                      : `${count(eligibleTotal)} item(s) from ${count(indentGroups.length)} indent(s) are waiting.`,
              },
              {
                key: 'direct',
                title: 'Direct PO',
                text: 'Use this when there is no indent for this material. You search the item and enter the quantity yourself.',
                icon: <ShoppingCart size={28} />,
                go: 'Add items',
              },
            ]}
          />
        </>
      )}

      {!isEdit && mode !== 'choose' && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-3)', marginBottom: 'var(--sp-2)' }}>
          <div className="grow">
            {mode === 'indent'
              ? <StepBar steps={['Choose items', 'Fill PO details', 'Check and save']} current={stepIndex} />
              : <StepBar steps={['Fill PO details', 'Check and save']} current={review ? 1 : 0} />}
          </div>
          <Button variant="ghost" size="sm" onClick={() => chooseMode('choose')} style={{ marginBottom: 'var(--sp-4)' }}>
            {mode === 'indent' ? 'Switch to Direct PO or go back' : 'Switch to From Indent or go back'}
          </Button>
        </div>
      )}

      {/* ── Step 1 (From Indent): tick what to order ──────────────────────────────
          A long list must never push the PO details down the page, so choosing
          items is its own step rather than a block stacked above the form. */}
      {onSelectStep && (
        <>
          <HelpStrip>
            <strong>Tick what you want to order.</strong> Tick an <strong>indent</strong> to take all of its items,
            or tick single <strong>items</strong>. You can mix items from many indents — they all go on
            <strong> one</strong> purchase order.
          </HelpStrip>

          <Card>
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', position: 'relative', maxWidth: 460 }}>
              <Search size={15} style={{ position: 'absolute', left: 28, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)' }} aria-hidden />
              <Input
                value={pickSearch}
                onChange={(e) => setPickSearch(e.target.value)}
                placeholder="Search by indent no. or item…"
                style={{ paddingLeft: 36, height: 42, fontSize: 'var(--text-md)' }}
                aria-label="Search indent items"
              />
            </div>

            {eligible.isLoading ? (
              <LoadingBlock height={200} label="Loading indent items…" />
            ) : eligible.error ? (
              <ErrorState error={eligible.error} onRetry={() => void eligible.refetch()} />
            ) : eligibleRows.length === 0 ? (
              <EmptyState
                icon={<GitMerge />}
                title={pickTerm ? 'Nothing matches your search' : 'No indent items are waiting'}
                message={pickTerm
                  ? 'Try a different indent number or item name.'
                  : 'An indent must be approved before it can be ordered. If there is no indent for this material, use Direct PO.'}
                action={pickTerm
                  ? <Button variant="secondary" onClick={() => setPickSearch('')}>Clear search</Button>
                  : <Button variant="primary" onClick={() => chooseMode('direct')}>Use Direct PO</Button>}
              />
            ) : (
              <div className="pick-wrap">
                <table className="pick-table">
                  <thead>
                    <tr>
                      <th style={{ width: 46 }} />
                      <th>Indent / Item</th>
                      <th>Department</th>
                      <th className="right">Asked</th>
                      <th className="right">Already ordered</th>
                      <th className="right">Waiting to order</th>
                    </tr>
                  </thead>
                  <tbody>
                    {indentGroups.map((g) => {
                      const head = g.rows[0]!;
                      const state = groupState(picked, g.rows, lineIdOf);
                      return [
                        <tr key={`g${g.key}`} className="pick-group" onClick={() => pickIndent(g.rows)}>
                          <td>
                            <TriCheck state={state} onChange={() => pickIndent(g.rows)}
                                      label={`Select all items of indent ${head.indent_no}`} />
                          </td>
                          <td colSpan={2}>
                            <span className="cell-code" style={{ fontSize: 'var(--text-md)' }}>{head.indent_no}</span>
                            <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
                              {formatDate(head.indent_date)}
                              {head.indent_type_name ? ` · ${head.indent_type_name}` : ''}
                              {head.suggested_supplier_name ? ` · Supplier: ${head.suggested_supplier_name}` : ''}
                            </span>
                          </td>
                          <td colSpan={3} className="right" style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                            {state === 'all' ? 'All items selected'
                              : state === 'some' ? 'Some items selected'
                                : `${count(g.rows.length)} item(s) — tick to take all`}
                          </td>
                        </tr>,
                        ...g.rows.map((r) => {
                          const on = picked.has(r.indent_line_id);
                          return (
                            <tr key={r.indent_line_id} className={`pick-line ${on ? 'is-picked' : ''}`} onClick={() => pickLine(r)}>
                              <td style={{ paddingLeft: 26 }}>
                                <input type="checkbox" className="pick-check" checked={on}
                                       aria-label={`Select ${r.item_code} from indent ${r.indent_no}`}
                                       onChange={() => pickLine(r)} onClick={(e) => e.stopPropagation()} />
                              </td>
                              <td>
                                <div className="cell-code">{r.item_code}</div>
                                <div style={{ fontWeight: 600 }}>{r.item_description}</div>
                                {r.item_specification && (
                                  <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.item_specification}</div>
                                )}
                              </td>
                              <td style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                                {[r.department_name, r.cost_centre_name].filter(Boolean).join(' · ') || '—'}
                              </td>
                              <td className="right num">{qty(r.indent_qty)} {text(r.uom_code)}</td>
                              <td className="right num" style={{ color: 'var(--text-muted)' }}>{qty(r.ordered_qty)}</td>
                              <td className="right num" style={{ fontWeight: 700, color: 'var(--warning-700)' }}>
                                {qty(r.pending_qty)} {text(r.uom_code)}
                              </td>
                            </tr>
                          );
                        }),
                      ];
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {eligibleTotal > eligibleRows.length && (
              <div style={{ padding: 'var(--sp-3) var(--sp-4)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
                Showing the first {count(eligibleRows.length)} of {count(eligibleTotal)} waiting items. Use the search box to find the others.
              </div>
            )}
          </Card>

          <SelectionBar
            empty={picked.size === 0}
            text={picked.size === 0
              ? 'Nothing selected yet'
              : `${count(picked.size)} item(s) selected from ${count(pickedIndentCount)} indent(s)`}
            sub={picked.size === 0
              ? 'Tick an indent, or tick items, to continue.'
              : `Indents: ${pickedIndentNos.join(', ')}`}
          >
            {picked.size > 0 && (
              <Button variant="ghost" icon={<X size={14} />} onClick={() => setPicked(new Map())}>Clear</Button>
            )}
            <Button variant="primary" size="lg" disabled={picked.size === 0} iconRight={<ArrowRight size={16} />}
                    onClick={() => setIndentSubTab('build')}>
              Continue
            </Button>
          </SelectionBar>
        </>
      )}

      {/* ── PO details: step 2 (From Indent) / the only form (Direct PO, Edit) ── */}
      {showForm && (
        <>
      {!isEdit && mode === 'indent' && (
        <div className="row" style={{ gap: 8, marginBottom: 'var(--sp-4)', padding: 'var(--sp-3) var(--sp-4)', background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
          <GitMerge size={16} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--text-md)' }}>
            <strong>{count(picked.size)}</strong> item(s) from <strong>{count(pickedIndentCount)}</strong> indent(s):{' '}
            {pickedIndentNos.join(', ') || '—'}
          </span>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={13} />} onClick={() => setIndentSubTab('select')} style={{ marginLeft: 'auto' }}>
            Change items
          </Button>
        </div>
      )}

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Purchase order header" subtitle="The PO number is issued by the system when you save" />
        <CardBody>
          <div className="form-grid">
            {mode === 'indent' && (
              <>
                <Field label="Indent no.">
                  <Input value={isEdit ? [...distinctIndents].join(', ') || 'Direct' : pickedIndentNos.join(', ')} disabled
                         title={isEdit ? [...distinctIndents].join(', ') : pickedIndentNos.join(', ')} />
                </Field>
                <Field label="Indent type">
                  <Input value={text(indentTypeDisplay || null)} disabled />
                </Field>
              </>
            )}
            <Field label="PO type" error={errors.poTypeId}>
              <Select value={poTypeId ?? ''} placeholder="Select type"
                      onChange={(e) => setPoTypeId(e.target.value ? Number(e.target.value) : null)}
                      options={poTypes} />
            </Field>
            <Field label="PO date" required>
              <Input type="date" value={poDate} onChange={(e) => setPoDate(e.target.value)} />
            </Field>
            <Field label="PO no.">
              <Input value={isEdit ? String((existing.data as { po_no?: string })?.po_no ?? '') : 'Auto-generated'} disabled />
            </Field>
            <Field label="Expected date" hint="When the material should arrive">
              <Input type="date" value={expectedDate} min={poDate} onChange={(e) => setExpectedDate(e.target.value)} />
            </Field>
            <Field label="Supplier" required error={errors.supplierId} span={2}>
              <SupplierSelect
                value={supplierId}
                selectedName={selectedSupplier?.supplier_name}
                invalid={Boolean(errors.supplierId)}
                onChange={chooseSupplier}
              />
            </Field>
            <Field label="Payment terms" hint="Defaults from the supplier — change anytime">
              <Select
                value={paymentTerms}
                onChange={(e) => { paymentTermsManualRef.current = true; setPaymentTerms(e.target.value); }}
                placeholder="Select terms"
              >
                {paymentTermsOptions.map((o) => <option key={o.value} value={o.label}>{o.label}</option>)}
              </Select>
            </Field>
            {selectedSupplier && (
              <div className="field-span-full" style={{
                display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--sp-2) var(--sp-4)',
                padding: 'var(--sp-3)', background: 'var(--surface-2)', borderRadius: 'var(--radius-sm)',
                fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
              }}>
                <div><strong style={{ color: 'var(--text)' }}>Address:</strong> {text([selectedSupplier.address, selectedSupplier.city, selectedSupplier.state].filter(Boolean).join(', '))}</div>
                <div><strong style={{ color: 'var(--text)' }}>GSTIN:</strong> {text(selectedSupplier.gst_no)}</div>
                <div><strong style={{ color: 'var(--text)' }}>Mobile:</strong> {text(selectedSupplier.mobile_no)}</div>
                <div><strong style={{ color: 'var(--text)' }}>Email:</strong> {text(selectedSupplier.email)}</div>
              </div>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── Lines ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Purchase order lines"
          subtitle={`${validLines.length} line(s)`}
          actions={
            mode === 'direct' ? (
              <Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setLines((ls) => [...ls, newLine()])}>
                Add line
              </Button>
            ) : undefined
          }
        />
        <CardBody flush>
          {errors.lines && (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--danger-50)', color: 'var(--danger-700)', fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--danger-100)' }}>
              {errors.lines}
            </div>
          )}

          {lines.length === 0 ? (
            <EmptyState
              icon={mode === 'indent' ? <GitMerge /> : <Package />}
              title="No items yet"
              message={
                mode === 'indent'
                  ? 'Go back and tick the indent items you want to order.'
                  : 'Add an item, then enter its quantity and rate.'
              }
              action={mode === 'direct'
                ? <Button variant="primary" icon={<Plus size={14} />} onClick={() => setLines([newLine()])}>Add item</Button>
                : !isEdit ? <Button variant="primary" icon={<ArrowLeft size={14} />} onClick={() => setIndentSubTab('select')}>Choose items</Button> : undefined}
            />
          ) : (
            <div className="table-with-actions-rail">
              <div className="table-wrap">
                <table className="table table-compact table-fixed">
                  <thead>
                    <tr>
                      <th style={{ width: 34 }}>#</th>
                      {mode === 'indent' && <th className="right" style={{ width: 90 }}>Indent Qty</th>}
                      <th style={{ width: 190 }}>Item Code</th>
                      <th style={{ width: 220 }}>Item Description</th>
                      <th style={{ width: 190 }}>Item Specification</th>
                      <th className="right" style={{ width: 120 }}>PO Qty</th>
                      <th className="right" style={{ width: 85 }}>Live Qty</th>
                      <th className="right" style={{ width: 110 }}>Pending GRN Qty</th>
                      <th className="right" style={{ width: 115 }}>Rate/pc</th>
                      <th className="right" style={{ width: 95 }}>Discount %</th>
                      <th className="right" style={{ width: 115 }}>Final Rate/pc</th>
                      <th className="right" style={{ width: 120 }}>Amount</th>
                      <th className="right" style={{ width: 85 }}>GST %</th>
                      <th className="right" style={{ width: 115 }}>GST Amt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((l, i) => (
                      <tr key={l.uid}>
                        <td className="cell-muted num">{i + 1}</td>
                        {mode === 'indent' && <td className="right num cell-muted">{l.indentQty ? qty(l.indentQty) : '—'}</td>}
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <div className="grow" style={{ minWidth: 0 }}>
                              {mode === 'indent' ? (
                                <span className="cell-code">{l.itemCode}</span>
                              ) : (
                                // Searches the whole Item Master on the server; the
                                // line's own code/description keep an already-chosen
                                // item showing whatever the latest results are.
                                <ItemSelect
                                  value={l.itemId}
                                  selectedCode={l.itemCode}
                                  selectedDescription={l.itemDescription}
                                  onChange={(itemId) => void selectDirectItem(l.uid, itemId)}
                                />
                              )}
                            </div>
                            {l.itemId != null && (
                              <Button variant="ghost" size="sm" title="Item history" icon={<History size={13} />}
                                      onClick={() => setHistoryItemId(l.itemId)} />
                            )}
                          </div>
                        </td>
                        <td className="cell-wrap cell-strong">
                          {text(l.itemDescription)}
                          {mode === 'indent' && l.sources.length > 0 && (
                            <div className="cell-muted" style={{ fontSize: 'var(--text-2xs)', fontWeight: 400, marginTop: 2 }}>
                              {l.sources.map((s) => `${s.indentNo}→${qty(s.consumedQty)}`).join(', ')}
                            </div>
                          )}
                        </td>
                        <td>
                          <Input
                            value={l.itemSpecification}
                            onChange={(e) => updateLine(l.uid, { itemSpecification: e.target.value })}
                            placeholder="Specification for this PO"
                            title="Specific to this purchase order — does not change the Item Master"
                          />
                        </td>
                        <td>
                          <Input
                            numeric type="number" step="0.0001" min={Number(l.receivedQty) > 0 ? l.receivedQty : '0'}
                            className="input-sm"
                            value={l.poQty}
                            onChange={(e) => updateLine(l.uid, { poQty: e.target.value })}
                            invalid={
                              (Boolean(l.itemId) && !(Number(l.poQty) > 0))
                              || Number(l.poQty) < Number(l.receivedQty)
                            }
                            title={Number(l.receivedQty) > 0 ? `${qty(l.receivedQty)} already received — cannot go below this` : undefined}
                          />
                          {Number(l.receivedQty) > 0 && (
                            <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', marginTop: 2 }}>
                              {qty(l.receivedQty)} received
                            </div>
                          )}
                        </td>
                        <td className="right num cell-muted">{l.liveQty != null ? qty(l.liveQty) : '—'}</td>
                        <td className="right num cell-muted">{l.pendingGrnQty != null ? qty(l.pendingGrnQty) : '—'}</td>
                        <td>
                          <Input numeric type="number" step="0.0001" min="0" className="input-sm"
                                 value={l.rate} placeholder="0.0000"
                                 onChange={(e) => updateLine(l.uid, { rate: e.target.value })}
                                 invalid={Boolean(l.itemId) && l.rate === ''} />
                        </td>
                        <td>
                          <Input numeric type="number" step="0.01" min="0" max="100" className="input-sm"
                                 value={l.discountPct}
                                 onChange={(e) => updateLine(l.uid, { discountPct: e.target.value })} />
                        </td>
                        <td className="right num cell-muted">{money(finalRateOf(l.rate, l.discountPct), 4)}</td>
                        <td className="right num cell-strong">{money(amountOf(l.poQty, l.rate, l.discountPct))}</td>
                        <td>
                          <Input numeric type="number" step="0.01" min="0" max="100" className="input-sm"
                                 value={l.gstPct}
                                 onChange={(e) => updateLine(l.uid, { gstPct: e.target.value })} />
                        </td>
                        <td className="right num cell-muted">
                          {money(lineGstAmount(amountOf(l.poQty, l.rate, l.discountPct), Number(l.gstPct || 0)))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td colSpan={mode === 'indent' ? 5 : 4}>Totals</td>
                      <td className="right num">{qty(totals.quantity)}</td>
                      <td colSpan={2} className="right cell-muted" style={{ fontWeight: 400 }}>
                        Gross {money(totals.gross)} · Line discount {money(totals.lineDiscount)}
                      </td>
                      <td className="right num" style={{ fontSize: 'var(--text-md)' }}>{money(totals.subtotal)}</td>
                      <td />
                      <td className="right num cell-strong">{money(totals.totalGst)}</td>
                    </tr>
                  </tfoot>
                </table>
              </div>
              {lines.length > 0 && (
                <div className="actions-rail">
                  <table className="table table-compact">
                    <thead><tr><th style={{ width: 44 }} /></tr></thead>
                    <tbody>
                      {lines.map((l) => {
                        const hasReceipts = Number(l.receivedQty) > 0;
                        return (
                          <tr key={l.uid}>
                            <td className="right">
                              <Button
                                variant="ghost" size="sm" onClick={() => removeLine(l.uid)}
                                disabled={hasReceipts}
                                title={hasReceipts ? `${qty(l.receivedQty)} already received against this line — cannot be removed` : 'Remove line'}
                                icon={<Trash2 size={13} style={hasReceipts ? { opacity: 0.35 } : undefined} />}
                              />
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot><tr><td style={{ height: 1 }} /></tr></tfoot>
                  </table>
                </div>
              )}
            </div>
          )}
        </CardBody>
      </Card>

      {lines.length > 0 && (
        <Card style={{ marginTop: 'var(--sp-4)' }}>
          <CardHeader title="Charges" subtitle="Discount, Freight, Packing and Insurance — enter either % or ₹, the other side calculates automatically" />
          <CardBody>
            <div className="po-charges-grid">
              <div className="po-charges-head">
                <span>Charge</span><span>Mode</span><span>Value</span><span>Calculated</span>
              </div>
              <ChargeRow label="Discount" charge={discount} onChange={setDiscount} base={totals.subtotal} amount={totals.discountAmount} negative />
              <ChargeRow label="Freight" charge={freight} onChange={setFreight} base={totals.subtotal} amount={totals.freightAmount} />
              <ChargeRow label="Packing" charge={packing} onChange={setPacking} base={totals.subtotal} amount={totals.packingAmount} />
              <ChargeRow label="Insurance" charge={insurance} onChange={setInsurance} base={totals.subtotal} amount={totals.insuranceAmount} />
            </div>

            <div className="po-grand-total">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="cell-muted">Subtotal (line amounts)</span>
                <span className="num">{money(totals.subtotal)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="cell-muted">GST (per line)</span>
                <span className="num">{money(totals.totalGst)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="cell-muted">Discount</span>
                <span className="num">− {money(totals.discountAmount)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <span className="cell-muted">Freight + Packing + Insurance</span>
                <span className="num">+ {money(totals.freightAmount + totals.packingAmount + totals.insuranceAmount)}</span>
              </div>
              <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--border)', paddingTop: 'var(--sp-2)', marginTop: 'var(--sp-1)' }}>
                <strong>Grand Total</strong>
                <strong className="num" style={{ fontSize: 'var(--text-lg)' }}>{money(totals.grandTotal)}</strong>
              </div>
            </div>
          </CardBody>
        </Card>
      )}

      {lines.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(175px, 1fr))', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)' }}>
          <StatTile label="Total quantity" value={qty(totals.quantity)} />
          <StatTile label="Subtotal" value={money(totals.subtotal)} />
          <StatTile label="GST" value={money(totals.totalGst)} />
          <StatTile label="Grand total" value={money(totals.grandTotal)} tone="info" />
          {distinctIndents.size > 0 && (
            <StatTile label="Source indents" value={count(distinctIndents.size)} sub="Traceability retained per line" />
          )}
        </div>
      )}

      <div
        className="row"
        style={{
          gap: 8, marginTop: 'var(--sp-3)', padding: 'var(--sp-3) var(--sp-4)',
          background: 'var(--info-50)', border: '1px solid var(--info-100)',
          borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--info-700)',
        }}
      >
        <Info size={14} style={{ flexShrink: 0 }} />
        <span>
          Final rate and amount are computed by the database from quantity, rate and discount, so the
          figures above are exactly what will be stored. Quantities drawn from indents are validated
          against the remaining eligible quantity when you save.
        </span>
      </div>

      {/* The same two actions as the top of the page, where the user ends up
          after filling the lines — nobody should have to scroll back up to save. */}
      <SelectionBar
        empty={validLines.length === 0}
        text={validLines.length === 0 ? 'Add an item to continue' : `${count(validLines.length)} item(s) · ${money(totals.grandTotal)}`}
        sub="Nothing is saved until you check and confirm."
      >
        <Button variant="secondary" size="lg" icon={<Save size={16} />} disabled={save.isPending} onClick={() => attemptSave(false)}>
          {editingIssued ? 'Save changes' : 'Save draft'}
        </Button>
        {/* Issuing is the approval step: offered only to a user who holds that right
            (the server refuses it otherwise). Everyone else saves a draft and the
            order's own page tells them a person who can issue must issue it. */}
        {!editingIssued && can('po.approve') && (
          <Button variant="primary" size="lg" icon={<Send size={16} />} disabled={save.isPending} onClick={() => attemptSave(true)}>
            Issue purchase order
          </Button>
        )}
      </SelectionBar>
        </>
      )}

      {/* ── Final check before anything is saved ───────────────────────────── */}
      <Modal
        open={review !== null}
        onClose={() => { if (!save.isPending) setReview(null); }}
        closeOnOverlay={!save.isPending}
        size="lg"
        title="Check before you save"
        subtitle={review?.issue
          ? 'If this is correct, the purchase order will be issued and the store can receive material against it.'
          : editingIssued ? 'If this is correct, your changes will be saved.'
            : 'If this is correct, it will be saved as a draft. A draft is not sent to the supplier until it is issued.'}
        footer={
          <>
            <Button variant="ghost" disabled={save.isPending} onClick={() => setReview(null)}>Go back and change</Button>
            <Button variant="primary" size="lg" loading={save.isPending}
                    icon={review?.issue ? <Send size={16} /> : <Save size={16} />}
                    onClick={() => {
                      if (!review || submitting.current) return;
                      submitting.current = true;
                      save.mutate({ issue: review.issue }, { onSettled: () => { submitting.current = false; } });
                    }}>
              {review?.issue ? 'Yes, issue purchase order' : editingIssued ? 'Yes, save changes' : 'Yes, save draft'}
            </Button>
          </>
        }
      >
        <ReviewGrid cells={[
          { label: 'Supplier', value: text(selectedSupplier?.supplier_name) },
          { label: 'PO date', value: formatDate(poDate) },
          { label: 'Expected date', value: expectedDate ? formatDate(expectedDate) : 'Not given' },
          { label: 'PO type', value: text(poTypes.find((o) => o.value === poTypeId)?.label) },
          { label: 'Items', value: count(validLines.length) },
          { label: 'Grand total', value: money(totals.grandTotal) },
        ]} />
        {distinctIndents.size > 0 && (
          <HelpStrip>
            Made from indent(s): <strong>{[...distinctIndents].join(', ')}</strong>.
            The quantity ordered here will be taken off those indents.
          </HelpStrip>
        )}
        <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="table table-compact">
            <thead>
              <tr>
                <th>Item</th>
                <th className="right">Qty</th>
                <th className="right">Rate</th>
                <th className="right">Disc %</th>
                <th className="right">GST %</th>
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {validLines.map((l) => (
                <tr key={l.uid}>
                  <td>
                    <div className="cell-code">{l.itemCode}</div>
                    <div className="cell-wrap">{l.itemDescription}</div>
                    {l.sources.length > 0 && (
                      <div className="cell-muted" style={{ fontSize: 'var(--text-2xs)' }}>
                        {l.sources.map((s) => `${s.indentNo}: ${qty(s.consumedQty)}`).join(' · ')}
                      </div>
                    )}
                  </td>
                  <td className="right num">{qty(l.poQty)}</td>
                  <td className="right num">{money(l.rate, 4)}</td>
                  <td className="right num">{qty(l.discountPct || 0)}</td>
                  <td className="right num">{qty(l.gstPct || 0)}</td>
                  <td className="right num cell-strong">{money(amountOf(l.poQty, l.rate, l.discountPct))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={5} className="right">Subtotal</td>
                <td className="right num">{money(totals.subtotal)}</td>
              </tr>
              <tr>
                <td colSpan={5} className="right">GST</td>
                <td className="right num">{money(totals.totalGst)}</td>
              </tr>
              <tr>
                <td colSpan={5} className="right">Discount / Freight / Packing / Insurance</td>
                <td className="right num">
                  {money(totals.freightAmount + totals.packingAmount + totals.insuranceAmount - totals.discountAmount)}
                </td>
              </tr>
              <tr>
                <td colSpan={5} className="right">Grand total</td>
                <td className="right num" style={{ fontSize: 'var(--text-md)' }}>{money(totals.grandTotal)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Modal>

      <ItemHistoryModal itemId={historyItemId} onClose={() => setHistoryItemId(null)} />
    </>
  );
}
