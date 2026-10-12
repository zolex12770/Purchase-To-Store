/**
 * GRN — create / edit (SRS §12; GRN module reconstruction).
 *
 * ONE entry point ("Receive Material") that first asks which of two ways the
 * user wants, each explained in a sentence, matching the backend's two modes:
 *
 *   AGAINST PURCHASE ORDER — tick what arrived. A tick on a PO takes all of its
 *     pending items; a tick on a single item takes just that item. So all three
 *     cases are the same screen, exactly as on Create Purchase Order:
 *         one PO                -> one GRN
 *         several POs           -> one GRN
 *         some items of several -> one GRN
 *     Every line still carries its own po_line_id, so the server traces and
 *     locks each one independently even when several POs are combined. A GRN
 *     is always for ONE supplier (the server refuses a mixed one), so once
 *     something is ticked the other suppliers' POs are blocked here, with the
 *     reason shown, instead of failing on save.
 *
 *   DIRECT GRN — no purchase order; items are added straight from Item Master.
 *
 * All auto-fillable data (item description/specification/UOM, PO qty,
 * previously-received qty, pending qty, rate, supplier) is fetched from the
 * server and never re-typed. Save is refused client-side the same way the
 * server refuses it — over-receipt, mixed suppliers, zero quantity — so a
 * mistake is caught before the round trip, not just after it.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Save, Send, ArrowLeft, ArrowRight, AlertTriangle, X, ListPlus, PackagePlus,
  Truck, Info, FileText, Lock, History, Search, ChevronDown, ChevronUp, SlidersHorizontal, ClipboardCheck,
} from 'lucide-react';
import { api, qs, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Textarea, SearchSelect,
  Modal, EmptyState, ErrorState, LoadingBlock,
} from '../../components/ui';
import { ItemHistoryModal } from '../../components/ItemHistoryModal';
import { StatTile } from '../../components/KpiCard';
import {
  ChoiceCards, StepBar, HelpStrip, SelectionBar, ReviewGrid, TriCheck, useDebounced,
} from '../../components/simple';
import { ItemSelect, SupplierSelect } from '../../components/MasterSelect';
import { useLookupOptions, fetchItemProfile, type SupplierOption } from '../../lib/masters';
import { qty, money, today, text, formatDate, count } from '../../lib/format';
import {
  groupRows, groupState, toggleOne, toggleGroup, documentCount, lockedSupplier,
} from '../../lib/pickSelection';

type Mode = 'choose' | 'PO' | 'DIRECT';

interface PoItemRow {
  po_line_id: number;
  po_id: number;
  po_no: string;
  po_date: string;
  supplier_id: number;
  supplier_name: string;
  po_type_id: number | null;
  po_type_name: string | null;
  item_id: number;
  item_code: string;
  item_description: string;
  item_specification: string;
  uom_id: number | null;
  uom_code: string | null;
  po_qty: string;
  received_qty: string;
  pending_grn_qty: string;
  rate: string;
  final_rate: string;
  amount: string;
  line_status: string;
  is_receivable: boolean;
  indent_no: string | null;
}

interface LineDraft {
  uid: string;
  // Set only when editing an already-POSTED GRN's existing line (its real
  // grn_lines.id) — null for a line just added in this editing session.
  id: number | null;
  mlnNo: string | null;
  // True once a Requisition has issued stock against this item (Section 4) —
  // the received quantity can no longer be corrected; everything else on the
  // line remains editable, and the line itself can never be removed once posted.
  qtyLocked: boolean;
  poLineId: number | null;
  itemId: number | null;
  itemCode: string;
  itemDescription: string;
  itemSpecification: string;
  indentNo: string | null;
  poNo: string | null;
  poTypeName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  orderQty: string | null;
  previouslyReceivedQty: string | null;
  pendingGrnQty: string | null;
  invoiceQty: string;
  grnQty: string;
  rate: string;
  uomId: number | null;
  uomCode: string | null;
  batchNo: string;
  packageCount: string;
  packingType: string;
  expiryDate: string;
  labelCount: string;
  labelQty: string;
  location: string;
  remarks: string;
}

const newUid = () => `l-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const amountOf = (l: LineDraft) => Number(l.grnQty || 0) * Number(l.rate || 0);
const poLineIdOf = (r: PoItemRow) => r.po_line_id;
const poIdOf = (r: PoItemRow) => r.po_id;

/** A fresh GRN line for one PO line — everything known is filled in; only the receipt details are left. */
const draftFromPoRow = (r: PoItemRow): LineDraft => ({
  uid: newUid(), id: null, mlnNo: null, qtyLocked: false, poLineId: r.po_line_id, itemId: r.item_id,
  itemCode: r.item_code, itemDescription: r.item_description, itemSpecification: r.item_specification,
  indentNo: r.indent_no, poNo: r.po_no, poTypeName: r.po_type_name,
  supplierId: r.supplier_id, supplierName: r.supplier_name,
  orderQty: r.po_qty, previouslyReceivedQty: r.received_qty, pendingGrnQty: r.pending_grn_qty,
  invoiceQty: '', grnQty: r.pending_grn_qty, rate: r.final_rate,
  uomId: r.uom_id, uomCode: r.uom_code,
  batchNo: '', packageCount: '', packingType: '', expiryDate: '', labelCount: '', labelQty: '',
  location: '', remarks: '',
});

/** Whether any of the optional per-line details has been filled in. */
const hasDetails = (l: LineDraft) =>
  Boolean(l.batchNo || l.packageCount || l.packingType || l.expiryDate || l.labelCount || l.labelQty || l.location || l.remarks);

export default function GrnForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();

  // Deep links: `?from=po|direct` skips the choice; `?poId=…` / `?poLines=…`
  // (from a purchase order, or from the Pending Receipt list) arrive with those
  // items already ticked.
  const presetPoIds = (params.get('poId') ?? '').split(',').map(Number).filter((n) => n > 0);
  const presetPoLineIds = (params.get('poLines') ?? '').split(',').map(Number).filter((n) => n > 0);
  const hasPreset = presetPoIds.length > 0 || presetPoLineIds.length > 0;

  const [mode, setMode] = useState<Mode>(
    isEdit || params.get('from') === 'po' || hasPreset ? 'PO'
      : params.get('from') === 'direct' ? 'DIRECT'
        : 'choose',
  );
  const [step, setStep] = useState<'select' | 'build'>(isEdit ? 'build' : 'select');
  const [grnDate, setGrnDate] = useState(today());
  const [grnTypeId, setGrnTypeId] = useState<number | null>(null);
  const [invoiceNo, setInvoiceNo] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [challanNo, setChallanNo] = useState('');
  const [challanDate, setChallanDate] = useState('');
  const [transporterName, setTransporterName] = useState('');
  const [vehicleNo, setVehicleNo] = useState('');
  const [driverName, setDriverName] = useState('');
  const [lrNo, setLrNo] = useState('');
  const [lrDate, setLrDate] = useState('');
  const [remarks, setRemarks] = useState('');
  const [directSupplierId, setDirectSupplierId] = useState<number | null>(null);
  const [directSupplier, setDirectSupplier] = useState<SupplierOption | null>(null);
  // Only meaningful while isEdit — a POSTED GRN stays genuinely editable
  // (Section 4), but its Save action is a plain correction, not a post/draft
  // transition, so the header actions and supplier field adapt accordingly.
  const [existingStatus, setExistingStatus] = useState<string | null>(null);
  const isPostedEdit = isEdit && existingStatus === 'POSTED';

  const [lines, setLines] = useState<LineDraft[]>([]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [historyItemId, setHistoryItemId] = useState<number | null>(null);
  const [review, setReview] = useState<{ post: boolean } | null>(null);
  // A second click can land before React has re-rendered the button as disabled,
  // so 'loading' alone does not stop a double submit. This flag is set
  // synchronously, the moment the first click is handled.
  const submitting = useRef(false);
  // Optional per-line details (batch, packing, labels, location, remark) are
  // tucked under each line so the table shows what must be entered first.
  const [openDetails, setOpenDetails] = useState<Set<string>>(new Set());
  const [transportOpen, setTransportOpen] = useState(false);

  /* ── PO item picker ────────────────────────────────────────────────────── */
  // What is ticked, keyed by PO LINE — not by PO — so a tick can mean a whole
  // purchase order or one item of it. The row itself is kept, so a tick
  // survives the list being searched, filtered or re-fetched.
  const [picked, setPicked] = useState<Map<number, PoItemRow>>(new Map());
  const [pickerOpen, setPickerOpen] = useState(false);     // "add more PO items" while editing
  const [pSearch, setPSearch] = useState('');
  const pTerm = useDebounced(pSearch.trim());
  const [moreFilters, setMoreFilters] = useState(false);
  const [pSupplierId, setPSupplierId] = useState<number | null>(null);
  const [pSupplierName, setPSupplierName] = useState('');
  const [pPoTypeId, setPPoTypeId] = useState<number | null>(null);
  const [pDateFrom, setPDateFrom] = useState('');
  const [pDateTo, setPDateTo] = useState('');
  const [pView, setPView] = useState<'pending' | 'all'>('pending');

  const onSelectStep = !isEdit && mode === 'PO' && step === 'select';

  /* Every receivable PO line — the server's own definition (v_po_line_balance),
     so this list can never offer something the save would then refuse. */
  const poItems = useQuery({
    queryKey: ['grn', 'po-items', pTerm, pSupplierId, pPoTypeId, pDateFrom, pDateTo, pView],
    queryFn: () => api.get<PoItemRow[]>(`/grn/po-items${qs({
      search: pTerm || undefined, supplierId: pSupplierId ?? undefined, poTypeId: pPoTypeId ?? undefined,
      dateFrom: pDateFrom || undefined, dateTo: pDateTo || undefined, view: pView, limit: 500,
    })}`),
    enabled: (!isEdit && mode !== 'DIRECT') || pickerOpen,
    staleTime: 0,
  });
  const poRows = poItems.data ?? [];
  const poGroups = useMemo(() => groupRows(poRows, poIdOf), [poRows]);
  const activeFilters = [pSupplierId, pPoTypeId, pDateFrom, pDateTo, pView === 'all' ? 1 : null].filter(Boolean).length;

  // PO Type options: the sheet's "PO Type" column (falls back to the Indent
  // Type list this filter used before, until that column has been synced).
  const poTypeList = useLookupOptions('PO_TYPE');
  const indentTypeList = useLookupOptions('INDENT_TYPE');
  const poTypeOptions = poTypeList.options.length > 0 ? poTypeList : indentTypeList;
  const grnTypeOptions = useLookupOptions('GRN_TYPE');
  const packingTypeOptions = useLookupOptions('PACKING_TYPE');
  const locationOptions = useLookupOptions('LOCATION');

  // Built ONCE, not once per row per render. These two lists are identical for
  // every line, and rebuilding them inside the row map meant a fresh array plus
  // a full filter pass per control per keystroke across up to 200 lines.
  const packingTypeChoices = useMemo(
    () => packingTypeOptions.raw.map((x) => ({ value: x.name, label: x.name })),
    [packingTypeOptions.raw],
  );
  const locationChoices = useMemo(
    () => locationOptions.raw.map((x) => ({ value: x.name, label: x.name })),
    [locationOptions.raw],
  );

  /* ── Edit: load existing GRN ──────────────────────────────────────────── */
  const existing = useQuery({
    queryKey: ['grn-doc', id],
    queryFn: () => api.get<Record<string, unknown>>(`/grn/${id}`),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data as {
      mode: Mode; status: string; grn_date: string; grn_type_id: number | null; invoice_no: string; invoice_date: string | null;
      challan_no: string; challan_date: string | null; transporter_name: string; vehicle_no: string;
      driver_name: string; lr_no: string; lr_date: string | null; remarks: string; supplier_id: number;
      supplier_name?: string; supplier_code?: string; supplier_city?: string; supplier_state?: string; supplier_gst?: string;
      lines: Array<Record<string, unknown>>;
    };
    setExistingStatus(d.status);
    setMode(d.mode);
    setStep('build');
    setGrnDate(String(d.grn_date).slice(0, 10));
    setGrnTypeId(d.grn_type_id);
    setInvoiceNo(d.invoice_no ?? '');
    setInvoiceDate(d.invoice_date ? String(d.invoice_date).slice(0, 10) : '');
    setChallanNo(d.challan_no ?? '');
    setChallanDate(d.challan_date ? String(d.challan_date).slice(0, 10) : '');
    setTransporterName(d.transporter_name ?? '');
    setVehicleNo(d.vehicle_no ?? '');
    setDriverName(d.driver_name ?? '');
    setLrNo(d.lr_no ?? '');
    setLrDate(d.lr_date ? String(d.lr_date).slice(0, 10) : '');
    setTransportOpen(Boolean(d.transporter_name || d.vehicle_no || d.driver_name || d.lr_no || d.lr_date));
    setRemarks(d.remarks ?? '');
    setDirectSupplierId(d.supplier_id);
    setDirectSupplier({
      id: d.supplier_id, supplier_code: d.supplier_code ?? '', supplier_name: d.supplier_name ?? '',
      address: '', city: d.supplier_city ?? '', state: d.supplier_state ?? '', payment_terms: '',
      currency_code: '', gst_no: d.supplier_gst ?? '', mobile_no: '', email: '',
    });
    // Is this GRN's own quantity already included in the PO line's posted
    // received/pending figures? Only once it is POSTED.
    const ownQtyCounted = d.status === 'POSTED';
    const loaded = (d.lines ?? []).map((l): LineDraft => ({
      uid: newUid(),
      id: l.id as number,
      mlnNo: (l.mln_no as string | null) ?? null,
      qtyLocked: Boolean(l.qty_locked),
      poLineId: l.po_line_id as number | null,
      itemId: l.item_id as number,
      itemCode: String(l.item_code), itemDescription: String(l.item_description),
      itemSpecification: String(l.item_specification ?? ''),
      indentNo: (l.indent_no as string | null) ?? null, poNo: (l.po_no as string | null) ?? null,
      poTypeName: null, supplierId: d.supplier_id, supplierName: d.supplier_name ?? null,
      orderQty: l.po_qty == null ? null : String(l.po_qty),
      // `received_qty`/`pending_grn_qty` count POSTED receipts only. So when
      // editing a POSTED GRN, this line's own quantity is already inside those
      // figures and has to be credited back — otherwise the user is blocked by
      // their own existing receipt ("Max 0" on a fully-received line, and every
      // line failing "exceeds the outstanding pending quantity" on save). A
      // DRAFT contributes nothing to either figure, so it needs no adjustment.
      // This mirrors the server exactly: assertGrnReceiptAllowed() computes
      // `pending_grn_qty + alreadyOnThisGrn`, and updatePostedGrn() passes the
      // line's existing grn_qty while the draft path passes zero.
      previouslyReceivedQty: l.received_qty == null
        ? null
        : String(ownQtyCounted ? Number(l.received_qty) - Number(l.grn_qty as string) : Number(l.received_qty)),
      pendingGrnQty: l.pending_grn_qty == null
        ? null
        : String(ownQtyCounted ? Number(l.pending_grn_qty) + Number(l.grn_qty as string) : Number(l.pending_grn_qty)),
      invoiceQty: l.invoice_qty == null ? '' : String(l.invoice_qty),
      grnQty: String(l.grn_qty), rate: String(l.rate),
      uomId: l.uom_id as number | null, uomCode: (l.uom_code as string | null) ?? null,
      batchNo: String(l.batch_no ?? ''), packageCount: l.package_count == null ? '' : String(l.package_count),
      packingType: String(l.packing_type ?? ''), expiryDate: l.expiry_date ? String(l.expiry_date).slice(0, 10) : '',
      labelCount: l.label_count == null ? '' : String(l.label_count),
      labelQty: l.label_qty == null ? '' : String(l.label_qty),
      location: String(l.receipt_location ?? ''), remarks: String(l.remarks ?? ''),
    }));
    setLines(loaded);
    // Anything already filled in must be visible, not hidden behind "More details".
    setOpenDetails(new Set(loaded.filter(hasDetails).map((l) => l.uid)));
  }, [existing.data]);

  /* Arriving from a purchase order, or from the Pending Receipt list: tick those
     items and go straight to the receipt details. */
  const presetDone = useRef(false);
  useEffect(() => {
    if (presetDone.current || isEdit || mode !== 'PO' || !hasPreset) return;
    presetDone.current = true;
    const wanted = new Set(presetPoLineIds);
    void api.get<PoItemRow[]>(`/grn/po-items${qs({
      poId: presetPoIds.length > 0 ? presetPoIds.map(String) : undefined, view: 'pending', limit: 500,
    })}`).then((rows) => {
      const take = rows.filter((r) => (wanted.size > 0 ? wanted.has(r.po_line_id) : presetPoIds.includes(r.po_id)));
      if (take.length === 0) {
        toast.error('Nothing left to receive', 'That purchase order has no material pending. Pick another below.');
        return;
      }
      // One GRN is for one supplier — keep only the first supplier's lines.
      const supplier = take[0]!.supplier_id;
      const same = take.filter((r) => r.supplier_id === supplier);
      setPicked(new Map(same.map((r) => [r.po_line_id, r])));
      setLines(same.map(draftFromPoRow));
      setStep('build');
    }).catch((err) => toast.fromError(err, 'Could not load the purchase order items'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, isEdit]);

  /* ── Derived ───────────────────────────────────────────────────────────── */

  const distinctSuppliers = useMemo(() => {
    if (mode !== 'PO') return [];
    const map = new Map<number, string>();
    for (const l of lines) if (l.supplierId) map.set(l.supplierId, l.supplierName ?? '');
    return [...map.entries()];
  }, [lines, mode]);
  const supplierMismatch = distinctSuppliers.length > 1;

  const distinctPoNos = useMemo(() => [...new Set(lines.map((l) => l.poNo).filter(Boolean))] as string[], [lines]);
  const distinctPoTypeNames = useMemo(() => [...new Set(lines.map((l) => l.poTypeName).filter(Boolean))] as string[], [lines]);

  const overEntry = lines.filter(
    (l) => l.pendingGrnQty != null && Number(l.grnQty || 0) > Number(l.pendingGrnQty) + 0.0001,
  );

  const totals = useMemo(() => ({
    qty: lines.reduce((s, l) => s + Number(l.grnQty || 0), 0),
    invoiceQty: lines.reduce((s, l) => s + Number(l.invoiceQty || 0), 0),
    amount: lines.reduce((s, l) => s + amountOf(l), 0),
    pending: lines.reduce((s, l) => s + (l.pendingGrnQty != null ? Math.max(Number(l.pendingGrnQty) - Number(l.grnQty || 0), 0) : 0), 0),
  }), [lines]);

  /* ── Picking ───────────────────────────────────────────────────────────── */

  // The one supplier this GRN is for: what is ticked, or — when adding to a
  // GRN that already has lines — the supplier those lines belong to.
  const lockSupplierId = lockedSupplier(picked, (r) => r.supplier_id)
    ?? (pickerOpen && distinctSuppliers.length > 0 ? distinctSuppliers[0]![0] : null);
  const lockSupplierName = lockSupplierId == null ? ''
    : ([...picked.values()][0]?.supplier_name ?? distinctSuppliers.find(([sid]) => sid === lockSupplierId)?.[1] ?? '');
  const onGrnAlready = useMemo(
    () => new Set(pickerOpen ? lines.map((l) => l.poLineId).filter((v): v is number => v != null) : []),
    [lines, pickerOpen],
  );

  /** Why a PO line cannot be ticked right now, or `null` if it can. */
  const blockReason = (r: PoItemRow): string | null => {
    if (onGrnAlready.has(r.po_line_id)) return 'Already on this GRN';
    if (!r.is_receivable) return 'Nothing pending to receive';
    if (lockSupplierId != null && r.supplier_id !== lockSupplierId) return 'Different supplier';
    return null;
  };
  const canPick = (r: PoItemRow) => blockReason(r) === null;

  const pickLine = (r: PoItemRow) => {
    if (!canPick(r) && !picked.has(r.po_line_id)) return;
    setPicked((prev) => toggleOne(prev, r, poLineIdOf));
  };
  const pickPo = (rows: PoItemRow[]) => setPicked((prev) => toggleGroup(prev, rows, poLineIdOf, canPick));

  const pickedPoCount = documentCount(picked, poIdOf);
  const pickedPoNos = useMemo(() => [...new Set([...picked.values()].map((r) => r.po_no))], [picked]);

  /** Step 1 -> Step 2: the ticked PO lines become the GRN lines. Anything already
      typed for a line that is still ticked is kept. */
  function continueWithPicks() {
    setLines((prev) => {
      const kept = new Map(prev.filter((l) => l.poLineId != null).map((l) => [l.poLineId!, l]));
      return [...picked.values()].map((r) => kept.get(r.po_line_id) ?? draftFromPoRow(r));
    });
    setErrors({});
    setStep('build');
  }

  /** "Add more PO items" while a GRN is being edited. */
  function addSelectedPoLines() {
    const already = new Set(lines.map((l) => l.poLineId));
    const added = [...picked.values()].filter((r) => !already.has(r.po_line_id)).map(draftFromPoRow);
    setLines((ls) => [...ls, ...added]);
    setPicked(new Map());
    setPickerOpen(false);
    if (added.length > 0) toast.success(`${added.length} item(s) added`, 'Check the quantities before saving.');
  }

  async function addDirectItem(itemId: number) {
    if (lines.some((l) => l.itemId === itemId && l.poLineId === null)) {
      toast.error('Already added', 'This item is already on the GRN. Change its quantity instead.');
      return;
    }
    try {
      const p = await fetchItemProfile(itemId);
      setLines((ls) => [...ls, {
        uid: newUid(), id: null, mlnNo: null, qtyLocked: false, poLineId: null, itemId: p.id,
        itemCode: p.itemCode, itemDescription: p.itemDescription, itemSpecification: p.itemSpecification,
        indentNo: null, poNo: null, poTypeName: null, supplierId: null, supplierName: null,
        orderQty: null, previouslyReceivedQty: null, pendingGrnQty: null,
        invoiceQty: '', grnQty: '', rate: p.standardRate ?? '0',
        uomId: p.uomId, uomCode: p.uomCode,
        batchNo: '', packageCount: '', packingType: '', expiryDate: '', labelCount: '', labelQty: '',
        location: '', remarks: '',
      }]);
    } catch (err) {
      toast.fromError(err, 'Could not load item details');
    }
  }

  function updateLine(uid: string, patch: Partial<LineDraft>) {
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));
  }
  function removeLine(uid: string) {
    const target = lines.find((l) => l.uid === uid);
    if (target?.id != null) {
      toast.error('Cannot remove', 'This line has already been posted and assigned a lot number — correct its quantity instead, or cancel the GRN.');
      return;
    }
    setLines((ls) => ls.filter((l) => l.uid !== uid));
    // Keep the item list in step, so "Change items" does not show it still ticked.
    if (target?.poLineId != null) {
      setPicked((prev) => { const next = new Map(prev); next.delete(target.poLineId!); return next; });
    }
  }
  const toggleDetails = (uid: string) => setOpenDetails((s) => {
    const next = new Set(s);
    if (next.has(uid)) next.delete(uid); else next.add(uid);
    return next;
  });

  function chooseMode(next: Mode) {
    setMode(next);
    setLines([]);
    setPicked(new Map());
    setErrors({});
    setStep('select');
  }

  /* ── Save ──────────────────────────────────────────────────────────────── */

  const save = useMutation({
    mutationFn: ({ post }: { post: boolean }) => {
      const payload = {
        mode,
        supplierId: mode === 'DIRECT' ? directSupplierId : undefined,
        grnTypeId, grnDate, invoiceNo, invoiceDate: invoiceDate || null,
        challanNo, challanDate: challanDate || null,
        transporterName, vehicleNo, driverName, lrNo, lrDate: lrDate || null,
        remarks, post,
        lines: lines.map((l) => ({
          id: l.id, poLineId: l.poLineId, itemId: l.itemId,
          grnQty: l.grnQty, invoiceQty: l.invoiceQty || null,
          rate: mode === 'DIRECT' ? l.rate : undefined,
          batchNo: l.batchNo, packageCount: l.packageCount || null, packingType: l.packingType,
          expiryDate: l.expiryDate || null, labelCount: l.labelCount || null, labelQty: l.labelQty || null,
          location: l.location, remarks: l.remarks,
        })),
      };
      return isEdit
        ? api.put<{ id: number; grn_no: string }>(`/grn/${id}`, payload)
        : api.post<{ id: number; grn_no: string }>('/grn', payload);
    },
    onSuccess: (res, vars) => {
      setReview(null);
      toast.success(vars.post ? 'GRN posted' : 'GRN saved as draft', res.grn_no);
      void qc.invalidateQueries({ queryKey: ['grn'] });
      void qc.invalidateQueries({ queryKey: ['grn-po-items-pending'] });
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['home-work'] });
      // The GRN screen opens with its number, its status and what can be done next.
      navigate(`/grn/${res.id}`, { state: { justSaved: vars.post ? 'posted' : 'draft' } });
    },
    onError: (err) => {
      setReview(null);
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  /** Checks the form, then shows the "check before saving" summary. Nothing is saved here. */
  function attemptSave(post: boolean) {
    const issues: Record<string, string> = {};
    if (lines.length === 0) issues.lines = mode === 'PO' ? 'Tick at least one item that has arrived.' : 'Add at least one item.';
    if (mode === 'DIRECT' && !directSupplierId) issues.supplierId = 'Choose the supplier.';
    const noQty = lines.find((l) => !l.grnQty || Number(l.grnQty) <= 0);
    if (noQty) issues.lines = `Enter the received quantity for ${noQty.itemCode}. If it did not arrive, remove it from this GRN.`;
    if (overEntry.length > 0) {
      const o = overEntry[0]!;
      issues.lines = `${o.itemCode}: only ${qty(o.pendingGrnQty!)} is pending on PO ${o.poNo ?? ''}. Enter ${qty(o.pendingGrnQty!)} or less.`;
    }
    if (supplierMismatch) issues.supplier = 'These items are from more than one supplier. One GRN is for one supplier — remove the other supplier’s items, or make a separate GRN for them.';
    setErrors(issues);
    if (Object.keys(issues).length > 0) {
      toast.error('Please complete the GRN', Object.values(issues)[0]);
      return;
    }
    setReview({ post });
  }

  if (isEdit && existing.isLoading) return <LoadingBlock label="Loading GRN…" />;

  // A GRN being edited may carry a type that is no longer offered. It must
  // still show, and survive the save.
  const existingTypeName = (existing.data as { grn_type_name?: string | null } | undefined)?.grn_type_name ?? null;
  const grnTypeChoices = grnTypeId != null && existingTypeName && !grnTypeOptions.options.some((o) => o.value === grnTypeId)
    ? [{ value: grnTypeId, label: existingTypeName }, ...grnTypeOptions.options]
    : grnTypeOptions.options;

  const showForm = isEdit || mode === 'DIRECT' || (mode === 'PO' && step === 'build');
  const lessThanPending = lines.filter(
    (l) => l.pendingGrnQty != null && Number(l.grnQty || 0) > 0 && Number(l.grnQty) < Number(l.pendingGrnQty) - 0.0001,
  );

  /* ── The PO item list — step 1 when creating, a dialog when adding to an edit ── */
  const pickerList = (
    <>
      <div className="row" style={{ padding: 'var(--sp-3) var(--sp-4)', gap: 'var(--sp-3)', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: '1 1 280px', maxWidth: 460 }}>
          <Search size={15} style={{ position: 'absolute', left: 12, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)' }} aria-hidden />
          <Input
            value={pSearch}
            onChange={(e) => setPSearch(e.target.value)}
            placeholder="Search by PO no., supplier or item…"
            style={{ paddingLeft: 36, height: 42, fontSize: 'var(--text-md)' }}
            aria-label="Search purchase order items"
          />
        </div>
        <Button variant={activeFilters > 0 ? 'secondary' : 'ghost'} icon={<SlidersHorizontal size={14} />}
                onClick={() => setMoreFilters((v) => !v)}>
          More filters{activeFilters > 0 ? ` (${activeFilters})` : ''}
        </Button>
      </div>

      {moreFilters && (
        <div className="form-grid" style={{ padding: '0 var(--sp-4) var(--sp-3)' }}>
          <Field label="Supplier">
            <SupplierSelect
              value={pSupplierId} selectedName={pSupplierName} placeholder="Any supplier"
              onChange={(sid, s) => { setPSupplierId(sid); setPSupplierName(s?.supplier_name ?? ''); }}
            />
          </Field>
          <Field label="PO type">
            <SearchSelect
              value={pPoTypeId} onChange={(v) => setPPoTypeId(v === null ? null : Number(v))}
              options={poTypeOptions.options} placeholder="Any type" emptyText="No PO types"
            />
          </Field>
          <Field label="PO date from"><Input type="date" value={pDateFrom} onChange={(e) => setPDateFrom(e.target.value)} /></Field>
          <Field label="PO date to"><Input type="date" value={pDateTo} onChange={(e) => setPDateTo(e.target.value)} /></Field>
          <Field label="Show">
            <SearchSelect
              value={pView}
              onChange={(v) => setPView((v as 'pending' | 'all') ?? 'pending')}
              options={[{ value: 'pending', label: 'Pending only' }, { value: 'all', label: 'All, including completed' }]}
            />
          </Field>
          {activeFilters > 0 && (
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <Button variant="ghost" size="sm" onClick={() => {
                setPSupplierId(null); setPSupplierName(''); setPPoTypeId(null); setPDateFrom(''); setPDateTo(''); setPView('pending');
              }}>Clear filters</Button>
            </div>
          )}
        </div>
      )}

      {poItems.isLoading ? (
        <LoadingBlock height={200} label="Loading purchase orders…" />
      ) : poItems.error ? (
        <ErrorState error={poItems.error} onRetry={() => void poItems.refetch()} />
      ) : poRows.length === 0 ? (
        <EmptyState
          icon={<FileText />}
          title={pTerm || activeFilters > 0 ? 'Nothing matches' : 'No material is pending'}
          message={pTerm || activeFilters > 0
            ? 'Try a different PO number, supplier or item, or clear the filters.'
            : 'Every issued purchase order has been fully received. If material came without a PO, use Direct GRN.'}
          action={pTerm || activeFilters > 0 ? (
            <Button variant="secondary" onClick={() => {
              setPSearch(''); setPSupplierId(null); setPSupplierName(''); setPPoTypeId(null); setPDateFrom(''); setPDateTo(''); setPView('pending');
            }}>Clear search and filters</Button>
          ) : undefined}
        />
      ) : (
        <div className="pick-wrap">
          <table className="pick-table">
            <thead>
              <tr>
                <th style={{ width: 46 }} />
                <th>Purchase order / Item</th>
                <th className="right">Ordered</th>
                <th className="right">Already received</th>
                <th className="right">Pending to receive</th>
                <th className="right">Rate</th>
              </tr>
            </thead>
            <tbody>
              {poGroups.map((g) => {
                const head = g.rows[0]!;
                const state = groupState(picked, g.rows, poLineIdOf, canPick);
                const pickable = g.rows.some((r) => canPick(r) || picked.has(r.po_line_id));
                const otherSupplier = lockSupplierId != null && head.supplier_id !== lockSupplierId;
                return [
                  <tr key={`g${g.key}`} className={`pick-group ${pickable ? '' : 'is-blocked'}`}
                      onClick={() => { if (pickable) pickPo(g.rows); }}>
                    <td>
                      <TriCheck state={state} disabled={!pickable} onChange={() => pickPo(g.rows)}
                                label={`Select all pending items of PO ${head.po_no}`} />
                    </td>
                    <td colSpan={2}>
                      <span className="cell-code" style={{ fontSize: 'var(--text-md)' }}>{head.po_no}</span>
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
                        {formatDate(head.po_date)} · {head.supplier_name}
                        {head.po_type_name ? ` · ${head.po_type_name}` : ''}
                      </span>
                      {otherSupplier && (
                        <span className="pick-reason">
                          Different supplier. One GRN is for one supplier ({lockSupplierName}). Make a separate GRN for this PO.
                        </span>
                      )}
                    </td>
                    <td colSpan={3} className="right" style={{ fontWeight: 400, color: 'var(--text-muted)' }}>
                      {!pickable ? 'Cannot be added'
                        : state === 'all' ? 'All pending items selected'
                          : state === 'some' ? 'Some items selected'
                            : `${count(g.rows.length)} item(s) — tick to take all`}
                    </td>
                  </tr>,
                  ...g.rows.map((r) => {
                    const on = picked.has(r.po_line_id);
                    const reason = on ? null : blockReason(r);
                    return (
                      <tr key={r.po_line_id}
                          className={`pick-line ${on ? 'is-picked' : ''} ${reason ? 'is-blocked' : ''}`}
                          onClick={() => pickLine(r)}>
                        <td style={{ paddingLeft: 26 }}>
                          <input type="checkbox" className="pick-check" checked={on} disabled={Boolean(reason)}
                                 aria-label={`Select ${r.item_code} from PO ${r.po_no}`}
                                 onChange={() => pickLine(r)} onClick={(e) => e.stopPropagation()} />
                        </td>
                        <td>
                          <div className="cell-code">{r.item_code}</div>
                          <div style={{ fontWeight: 600 }}>{r.item_description}</div>
                          {r.item_specification && (
                            <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.item_specification}</div>
                          )}
                          {/* The different-supplier reason is already stated once on the PO row. */}
                          {reason && reason !== 'Different supplier' && <span className="pick-reason">{reason}</span>}
                        </td>
                        <td className="right num">{qty(r.po_qty)} {text(r.uom_code)}</td>
                        <td className="right num" style={{ color: 'var(--text-muted)' }}>{qty(r.received_qty)}</td>
                        <td className="right num" style={{ fontWeight: 700, color: 'var(--warning-700)' }}>
                          {qty(r.pending_grn_qty)} {text(r.uom_code)}
                        </td>
                        <td className="right num">{money(r.final_rate, 4)}</td>
                      </tr>
                    );
                  }),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
      {poRows.length >= 500 && (
        <div style={{ padding: 'var(--sp-3) var(--sp-4)', fontSize: 'var(--text-sm)', color: 'var(--text-muted)', borderTop: '1px solid var(--border-subtle)' }}>
          Showing the first 500 pending items. Use the search box to find others.
        </div>
      )}
    </>
  );

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit GRN' : 'Receive Material (GRN)'}
        subtitle={
          isEdit ? 'Change what is needed, then save.'
            : mode === 'choose' ? 'First choose how this material came.'
              : mode === 'PO' ? 'Against Purchase Order — receive material that was ordered on a PO.'
                : 'Direct GRN — receive material that has no purchase order.'
        }
        breadcrumbs={[{ label: 'GRN', to: '/grn' }, { label: isEdit ? 'Edit' : 'Receive' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/grn')}>Cancel</Button>
            {showForm && (isPostedEdit ? (
              <Button variant="primary" size="sm" icon={<Save size={13} />}
                      disabled={save.isPending}
                      onClick={() => attemptSave(true)}>
                Save changes
              </Button>
            ) : (
              <>
                <Button variant="secondary" size="sm" icon={<Save size={13} />}
                        disabled={save.isPending}
                        onClick={() => attemptSave(false)}>
                  Save draft
                </Button>
                {can('grn.approve') && (
                  <Button variant="primary" size="sm" icon={<Send size={13} />}
                          disabled={save.isPending}
                          onClick={() => attemptSave(true)}>
                    Post GRN
                  </Button>
                )}
              </>
            ))}
          </>
        }
      />

      {/* ── One entry point, two clearly explained ways ───────────────────────── */}
      {!isEdit && mode === 'choose' && (
        <>
          <HelpStrip>
            <strong>How did this material come?</strong> Choose one. You can come back and choose the other.
          </HelpStrip>
          <ChoiceCards
            onChoose={(k) => chooseMode(k as Mode)}
            choices={[
              {
                key: 'PO',
                title: 'Against Purchase Order',
                text: 'Use this when the material was ordered on a PO. You can receive one PO, many POs of the same supplier, or only some items.',
                icon: <ClipboardCheck size={28} />,
                go: 'Choose what arrived',
                note: poItems.isLoading ? 'Checking what is pending…'
                  : poItems.error ? 'Could not check what is pending.'
                    : poRows.length === 0 ? 'No material is pending on any purchase order right now.'
                      : `${count(poRows.length)} item(s) on ${count(poGroups.length)} purchase order(s) are pending.`,
              },
              {
                key: 'DIRECT',
                title: 'Direct GRN',
                text: 'Use this when material came without any purchase order. You choose the supplier and the items yourself.',
                icon: <PackagePlus size={28} />,
                go: 'Add items',
              },
            ]}
          />
        </>
      )}

      {!isEdit && mode !== 'choose' && (
        <div className="row" style={{ flexWrap: 'wrap', gap: 'var(--sp-3)', marginBottom: 'var(--sp-2)' }}>
          <div className="grow">
            {mode === 'PO'
              ? <StepBar steps={['Choose what arrived', 'Fill receipt details', 'Check and save']} current={review ? 2 : onSelectStep ? 0 : 1} />
              : <StepBar steps={['Fill receipt details', 'Check and save']} current={review ? 1 : 0} />}
          </div>
          <Button variant="ghost" size="sm" onClick={() => chooseMode('choose')} style={{ marginBottom: 'var(--sp-4)' }}>
            {mode === 'PO' ? 'Switch to Direct GRN or go back' : 'Switch to Against PO or go back'}
          </Button>
        </div>
      )}

      {/* ── Step 1 (Against PO): tick what arrived ─────────────────────────────── */}
      {onSelectStep && (
        <>
          <HelpStrip>
            <strong>Tick what has arrived.</strong> Tick a <strong>purchase order</strong> to take all of its pending items,
            or tick single <strong>items</strong>. You can mix items from many POs of the <strong>same supplier</strong> —
            they all go on <strong>one</strong> GRN.
          </HelpStrip>

          <Card>{pickerList}</Card>

          <SelectionBar
            empty={picked.size === 0}
            text={picked.size === 0
              ? 'Nothing selected yet'
              : `${count(picked.size)} item(s) selected from ${count(pickedPoCount)} PO(s)`}
            sub={picked.size === 0
              ? 'Tick a purchase order, or tick items, to continue.'
              : `Supplier: ${lockSupplierName} · PO: ${pickedPoNos.join(', ')}`}
          >
            {picked.size > 0 && (
              <Button variant="ghost" icon={<X size={14} />} onClick={() => setPicked(new Map())}>Clear</Button>
            )}
            <Button variant="primary" size="lg" disabled={picked.size === 0} iconRight={<ArrowRight size={16} />}
                    onClick={continueWithPicks}>
              Continue
            </Button>
          </SelectionBar>
        </>
      )}

      {showForm && (
        <>
      {!isEdit && mode === 'PO' && (
        <div className="row" style={{ gap: 8, marginBottom: 'var(--sp-4)', padding: 'var(--sp-3) var(--sp-4)', background: 'var(--bg-inset)', border: '1px solid var(--border-subtle)', borderRadius: 'var(--radius-sm)', flexWrap: 'wrap' }}>
          <ClipboardCheck size={16} style={{ color: 'var(--brand-500)', flexShrink: 0 }} />
          <span style={{ fontSize: 'var(--text-md)' }}>
            <strong>{count(lines.length)}</strong> item(s) from <strong>{count(distinctPoNos.length)}</strong> PO(s):{' '}
            {distinctPoNos.join(', ') || '—'}
          </span>
          <Button variant="secondary" size="sm" icon={<ArrowLeft size={13} />} onClick={() => setStep('select')} style={{ marginLeft: 'auto' }}>
            Change items
          </Button>
        </div>
      )}

      {supplierMismatch && (
        <HelpStrip tone="danger">
          <strong>More than one supplier:</strong> {distinctSuppliers.map(([, n]) => n).join(', ')}.
          One GRN is for one supplier — remove the other supplier’s items, or save them as a separate GRN.
        </HelpStrip>
      )}

      {/* ── Basic details ─────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Receipt details" subtitle="The GRN number is given by the system when you save" />
        <CardBody>
          <div className="form-grid">
            <Field label="GRN No.">
              <Input value={isEdit ? text((existing.data as { grn_no?: string } | undefined)?.grn_no) : 'Auto-generated on save'} disabled />
            </Field>
            <Field label="GRN date" required error={errors.grnDate}>
              <Input type="date" value={grnDate} max={today()} invalid={Boolean(errors.grnDate)}
                     onChange={(e) => setGrnDate(e.target.value)}
                     title="Goods cannot be received in the future — backdating for late paperwork is fine" />
            </Field>
            <Field label="GRN type">
              <SearchSelect
                value={grnTypeId} onChange={(v) => setGrnTypeId(v === null ? null : Number(v))}
                options={grnTypeChoices} placeholder="Select GRN type…" emptyText="No GRN types found. Ask the administrator to run the Google Sheets sync."
              />
            </Field>

            {mode === 'PO' ? (
              <>
                <Field label="PO No.">
                  <Input value={distinctPoNos.length === 0 ? '—' : distinctPoNos.join(', ')} disabled title={distinctPoNos.join(', ')} />
                </Field>
                <Field label="PO type">
                  <Input value={distinctPoTypeNames.length === 0 ? '—' : distinctPoTypeNames.join(', ')} disabled />
                </Field>
                <Field label="Supplier">
                  <Input value={distinctSuppliers.length === 1 ? distinctSuppliers[0]![1] : distinctSuppliers.length > 1 ? 'More than one — see above' : '—'} disabled />
                </Field>
              </>
            ) : (
              <Field label="Supplier" required error={errors.supplierId}
                     hint={isPostedEdit ? 'Already posted for this supplier — it cannot be changed on edit.' : undefined}>
                <SupplierSelect
                  value={directSupplierId} selectedName={directSupplier?.supplier_name}
                  invalid={Boolean(errors.supplierId)} disabled={isPostedEdit}
                  onChange={(sid, s) => { setDirectSupplierId(sid); setDirectSupplier(s); }}
                />
              </Field>
            )}

            <Field label="Bill / Invoice No.">
              <Input value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} placeholder="Number on the supplier's bill" />
            </Field>
            <Field label="Bill / Invoice date">
              <Input type="date" value={invoiceDate} max={today()} onChange={(e) => setInvoiceDate(e.target.value)} />
            </Field>
            <Field label="Challan No.">
              <Input value={challanNo} onChange={(e) => setChallanNo(e.target.value)} />
            </Field>
            <Field label="Challan date">
              <Input type="date" value={challanDate} max={today()} onChange={(e) => setChallanDate(e.target.value)} />
            </Field>
          </div>

          {mode === 'DIRECT' && directSupplier && (directSupplier.city || directSupplier.gst_no) && (
            <div style={{ marginTop: 'var(--sp-3)', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              {[directSupplier.city, directSupplier.state].filter(Boolean).join(', ')}
              {directSupplier.gst_no ? ` · GST ${directSupplier.gst_no}` : ''}
            </div>
          )}
        </CardBody>
      </Card>

      {/* ── Transport details — optional, so folded away until wanted ───────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader
          icon={<Truck size={15} />} title="Transport details"
          subtitle="Not required. Fill in what is on the delivery paper."
          actions={
            <Button variant="ghost" size="sm" icon={transportOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
                    onClick={() => setTransportOpen((v) => !v)}>
              {transportOpen ? 'Hide' : 'Add transport details'}
            </Button>
          }
        />
        {transportOpen && (
          <CardBody>
            <div className="form-grid">
              <Field label="Transporter"><Input value={transporterName} onChange={(e) => setTransporterName(e.target.value)} /></Field>
              <Field label="Vehicle No."><Input value={vehicleNo} onChange={(e) => setVehicleNo(e.target.value)} /></Field>
              <Field label="Driver name"><Input value={driverName} onChange={(e) => setDriverName(e.target.value)} /></Field>
              <Field label="L.R. No."><Input value={lrNo} onChange={(e) => setLrNo(e.target.value)} /></Field>
              <Field label="L.R. date"><Input type="date" value={lrDate} max={today()} onChange={(e) => setLrDate(e.target.value)} /></Field>
            </div>
          </CardBody>
        )}
      </Card>

      {/* ── Lines ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Items received"
          subtitle={lines.length > 0
            ? `${lines.length} item(s) · ${qty(totals.qty)} received. Enter the quantity that actually came.`
            : 'Add items below'}
          actions={
            mode === 'PO' ? (
              isEdit && !isPostedEdit ? (
                <Button variant="secondary" size="sm" icon={<ListPlus size={14} />} onClick={() => { setPicked(new Map()); setPickerOpen(true); }}>
                  Add PO items
                </Button>
              ) : undefined
            ) : (
              <div style={{ width: 320 }}>
                <ItemSelect
                  value={null}
                  placeholder="Search item to add…"
                  onChange={(itemId) => { if (itemId != null) void addDirectItem(itemId); }}
                />
              </div>
            )
          }
        />
        <CardBody flush>
          {errors.lines && (
            <div role="alert" style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--danger-50)', color: 'var(--danger-700)', fontSize: 'var(--text-md)', borderBottom: '1px solid var(--danger-100)' }}>
              {errors.lines}
            </div>
          )}

          {lines.length === 0 ? (
            <EmptyState
              icon={mode === 'PO' ? <ListPlus /> : <PackagePlus />}
              title="No items yet"
              message={mode === 'PO' ? 'Go back and tick the items that have arrived.' : 'Search an item above to add it.'}
              action={mode === 'PO' && !isEdit
                ? <Button variant="primary" icon={<ArrowLeft size={14} />} onClick={() => setStep('select')}>Choose items</Button>
                : undefined}
            />
          ) : (
            <div className="table-wrap" style={{ overflowX: 'auto' }}>
              <table className="table table-compact" style={{ minWidth: 1060 }}>
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    {mode === 'PO' && <th style={{ minWidth: 130 }}>PO No</th>}
                    <th style={{ minWidth: 220 }}>Item</th>
                    <th className="right" style={{ width: 90 }}>Ordered</th>
                    <th className="right" style={{ width: 100 }}>Already received</th>
                    <th className="right" style={{ width: 90 }}>Pending</th>
                    <th className="right" style={{ width: 110 }}>Bill Qty</th>
                    <th className="right" style={{ width: 120 }}>Received Qty *</th>
                    <th className="right" style={{ width: 110 }}>Rate</th>
                    <th className="right" style={{ width: 110 }}>Amount</th>
                    <th style={{ width: 130 }} />
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, idx) => {
                    const over = l.pendingGrnQty != null && Number(l.grnQty || 0) > Number(l.pendingGrnQty) + 0.0001;
                    const open = openDetails.has(l.uid);
                    const colCount = mode === 'PO' ? 11 : 10;
                    return [
                      <tr key={l.uid}>
                        <td className="cell-muted num">{idx + 1}</td>
                        {mode === 'PO' && (
                          <td>
                            <div className="cell-code">{text(l.poNo)}</div>
                            {l.indentNo && <div className="cell-muted" style={{ fontSize: 'var(--text-2xs)' }}>Indent {l.indentNo}</div>}
                          </td>
                        )}
                        <td>
                          <div className="row" style={{ gap: 4 }}>
                            <span className="cell-code">{l.itemCode}</span>
                            {l.itemId != null && (
                              <Button variant="ghost" size="sm" title="Item history" icon={<History size={13} />}
                                      onClick={() => setHistoryItemId(l.itemId)} />
                            )}
                          </div>
                          <div className="cell-wrap cell-strong">{l.itemDescription}</div>
                          {l.itemSpecification && (
                            <div className="cell-wrap cell-muted" style={{ fontSize: 'var(--text-2xs)' }}>{l.itemSpecification}</div>
                          )}
                          <div className="cell-muted" style={{ fontSize: 'var(--text-2xs)' }}
                               title={l.mlnNo ? 'Assigned when this line was posted — never reissued' : 'MLN is issued automatically when this GRN is posted'}>
                            MLN: {l.mlnNo ?? 'given when posted'}
                          </div>
                        </td>
                        <td className="right num cell-muted">{l.orderQty != null ? `${qty(l.orderQty)} ${text(l.uomCode)}` : '—'}</td>
                        <td className="right num cell-muted">{l.previouslyReceivedQty != null ? qty(l.previouslyReceivedQty) : '—'}</td>
                        <td className="right num" style={{ fontWeight: 700, color: 'var(--warning-700)' }}>
                          {l.pendingGrnQty != null ? qty(l.pendingGrnQty) : '—'}
                        </td>
                        <td>
                          <Input numeric type="number" step="0.0001" min="0" className="input-sm" value={l.invoiceQty}
                                 placeholder="0" aria-label={`Bill quantity for ${l.itemCode}`}
                                 onChange={(e) => updateLine(l.uid, { invoiceQty: e.target.value })} />
                        </td>
                        <td>
                          <Input
                            numeric type="number" step="0.0001" min="0"
                            max={l.pendingGrnQty ?? undefined}
                            className="input-sm" value={l.grnQty} placeholder="0" invalid={over}
                            disabled={l.qtyLocked}
                            aria-label={`Received quantity for ${l.itemCode}`}
                            title={l.qtyLocked
                              ? 'Already issued against a Requisition — the received quantity can no longer be corrected'
                              : l.pendingGrnQty != null ? `Maximum ${qty(l.pendingGrnQty)}` : undefined}
                            onChange={(e) => updateLine(l.uid, { grnQty: e.target.value })}
                          />
                          {l.qtyLocked && (
                            <div className="row" style={{ gap: 3, marginTop: 3, fontSize: '10px', color: 'var(--text-faint)', fontWeight: 600 }}>
                              <Lock size={10} /> Requisitioned
                            </div>
                          )}
                          {over && (
                            <div className="row" style={{ gap: 3, marginTop: 3, fontSize: '11px', color: 'var(--danger-600)', fontWeight: 600 }}>
                              <AlertTriangle size={11} /> Only {qty(l.pendingGrnQty!)} pending
                            </div>
                          )}
                        </td>
                        <td>
                          {mode === 'DIRECT' ? (
                            <Input numeric type="number" step="0.0001" min="0" className="input-sm" value={l.rate}
                                   aria-label={`Rate for ${l.itemCode}`}
                                   onChange={(e) => updateLine(l.uid, { rate: e.target.value })} />
                          ) : (
                            <span className="cell-muted num" style={{ display: 'block', textAlign: 'right' }}>{money(l.rate, 4)}</span>
                          )}
                        </td>
                        <td className="right num cell-strong">{money(amountOf(l))}</td>
                        <td className="right">
                          <div className="row" style={{ gap: 2, justifyContent: 'flex-end' }}>
                            <Button variant="ghost" size="sm" onClick={() => toggleDetails(l.uid)}
                                    icon={open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                                    title="Batch, packing, labels, location and remark">
                              {open ? 'Less' : hasDetails(l) ? 'Details ✓' : 'More'}
                            </Button>
                            <Button
                              variant="ghost" size="sm" disabled={l.id != null}
                              title={l.id != null ? 'Already posted — it cannot be removed' : `Remove ${l.itemCode}`}
                              onClick={() => removeLine(l.uid)}
                            >
                              <X size={14} style={{ color: l.id != null ? 'var(--text-faint)' : 'var(--danger-600)' }} />
                            </Button>
                          </div>
                        </td>
                      </tr>,
                      open && (
                        <tr key={`${l.uid}-d`}>
                          <td colSpan={colCount} style={{ background: 'var(--bg-inset)' }}>
                            <div className="form-grid" style={{ padding: 'var(--sp-2) 0' }}>
                              <Field label="Batch No"><Input className="input-sm" value={l.batchNo} onChange={(e) => updateLine(l.uid, { batchNo: e.target.value })} /></Field>
                              <Field label="No. of packages"><Input numeric type="number" min="0" className="input-sm" value={l.packageCount} onChange={(e) => updateLine(l.uid, { packageCount: e.target.value })} /></Field>
                              <Field label="Packing type">
                                <SearchSelect
                                  value={l.packingType || null}
                                  onChange={(v) => updateLine(l.uid, { packingType: v == null ? '' : String(v) })}
                                  options={packingTypeChoices}
                                  placeholder="—" emptyText="None set up. Add in Master → Supporting Masters."
                                />
                              </Field>
                              <Field label="Expiry date"><Input type="date" className="input-sm" value={l.expiryDate} onChange={(e) => updateLine(l.uid, { expiryDate: e.target.value })} /></Field>
                              <Field label="No. of labels"><Input numeric type="number" min="0" max="500" step="1" className="input-sm" value={l.labelCount} onChange={(e) => updateLine(l.uid, { labelCount: e.target.value })} /></Field>
                              <Field label="Qty per label"><Input numeric type="number" min="0" step="0.0001" className="input-sm" value={l.labelQty} onChange={(e) => updateLine(l.uid, { labelQty: e.target.value })} /></Field>
                              <Field label="Location">
                                <SearchSelect
                                  value={l.location || null}
                                  onChange={(v) => updateLine(l.uid, { location: v == null ? '' : String(v) })}
                                  options={locationChoices}
                                  placeholder="—" emptyText="None set up. Add in Master → Supporting Masters."
                                />
                              </Field>
                              <Field label="Remark"><Input className="input-sm" value={l.remarks} onChange={(e) => updateLine(l.uid, { remarks: e.target.value })} /></Field>
                            </div>
                          </td>
                        </tr>
                      ),
                    ];
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      {lines.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 'var(--sp-3)', marginTop: 'var(--sp-4)' }}>
          <StatTile label="Total Bill Qty" value={qty(totals.invoiceQty)} />
          <StatTile label="Total Received Qty" value={qty(totals.qty)} tone="success" />
          <StatTile label="Total Amount" value={money(totals.amount)} />
          {mode === 'PO' && <StatTile label="Still pending after this GRN" value={qty(totals.pending)} tone={totals.pending > 0 ? 'warning' : undefined} />}
        </div>
      )}

      <div className="row" style={{
        gap: 8, marginTop: 'var(--sp-4)', marginBottom: 'var(--sp-4)', padding: 'var(--sp-3) var(--sp-4)',
        background: 'var(--info-50)', border: '1px solid var(--info-100)',
        borderRadius: 'var(--radius-sm)', fontSize: 'var(--text-xs)', color: 'var(--info-700)',
      }}>
        <Info size={14} style={{ flexShrink: 0 }} />
        <span>
          A <strong>draft</strong> changes nothing. <strong>Posting</strong> is what updates the purchase order
          balance(s) and their status, and quantities are re-validated against the live outstanding balance at
          that moment — two people can never receive the same pending quantity twice.
        </span>
      </div>

      <Field label="Remarks">
        <Textarea rows={2} value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Optional notes about this receipt" />
      </Field>

      {/* The same actions as the top of the page, where the user ends up after
          filling the lines — nobody should have to scroll back up to save. */}
      <SelectionBar
        empty={lines.length === 0}
        text={lines.length === 0 ? 'Add an item to continue' : `${count(lines.length)} item(s) · ${qty(totals.qty)} received`}
        sub="Nothing is saved until you check and confirm."
      >
        {isPostedEdit ? (
          <Button variant="primary" size="lg" icon={<Save size={16} />} disabled={save.isPending} onClick={() => attemptSave(true)}>
            Save changes
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="lg" icon={<Save size={16} />} disabled={save.isPending} onClick={() => attemptSave(false)}>
              Save draft
            </Button>
            {can('grn.approve') && (
              <Button variant="primary" size="lg" icon={<Send size={16} />} disabled={save.isPending} onClick={() => attemptSave(true)}>
                Post GRN
              </Button>
            )}
          </>
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
        subtitle={isPostedEdit ? 'If this is correct, your changes will be saved.'
          : review?.post
            ? 'If this is correct, the GRN will be posted: stock goes up and the purchase order balance goes down.'
            : 'If this is correct, it will be saved as a draft. A draft does not change stock until it is posted.'}
        footer={
          <>
            <Button variant="ghost" disabled={save.isPending} onClick={() => setReview(null)}>Go back and change</Button>
            <Button variant="primary" size="lg" loading={save.isPending}
                    icon={review?.post ? <Send size={16} /> : <Save size={16} />}
                    onClick={() => {
                      if (!review || submitting.current) return;
                      submitting.current = true;
                      save.mutate({ post: review.post }, { onSettled: () => { submitting.current = false; } });
                    }}>
              {isPostedEdit ? 'Yes, save changes' : review?.post ? 'Yes, post GRN' : 'Yes, save draft'}
            </Button>
          </>
        }
      >
        <ReviewGrid cells={[
          { label: 'Supplier', value: text(mode === 'DIRECT' ? directSupplier?.supplier_name : distinctSuppliers[0]?.[1]) },
          { label: 'GRN date', value: formatDate(grnDate) },
          { label: 'Bill / Invoice No.', value: invoiceNo || 'Not given' },
          { label: 'GRN type', value: text(grnTypeChoices.find((o) => o.value === grnTypeId)?.label) },
          { label: 'Items', value: count(lines.length) },
          { label: 'Total received', value: qty(totals.qty) },
        ]} />
        {distinctPoNos.length > 0 && (
          <HelpStrip>
            Against purchase order(s): <strong>{distinctPoNos.join(', ')}</strong>.
          </HelpStrip>
        )}
        {lessThanPending.length > 0 && (
          <HelpStrip tone="warning">
            <strong>{count(lessThanPending.length)} item(s) are received in part.</strong> The rest stays pending on the
            purchase order and can be received on another GRN later.
          </HelpStrip>
        )}
        <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
          <table className="table table-compact">
            <thead>
              <tr>
                {mode === 'PO' && <th>PO No</th>}
                <th>Item</th>
                {mode === 'PO' && <th className="right">Pending</th>}
                <th className="right">Received now</th>
                {mode === 'PO' && <th className="right">Left after this</th>}
                <th className="right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.uid}>
                  {mode === 'PO' && <td className="cell-code">{text(l.poNo)}</td>}
                  <td>
                    <div className="cell-code">{l.itemCode}</div>
                    <div className="cell-wrap">{l.itemDescription}</div>
                  </td>
                  {mode === 'PO' && <td className="right num cell-muted">{l.pendingGrnQty != null ? qty(l.pendingGrnQty) : '—'}</td>}
                  <td className="right num cell-strong">{qty(l.grnQty)} {text(l.uomCode)}</td>
                  {mode === 'PO' && (
                    <td className="right num">
                      {l.pendingGrnQty != null ? qty(Math.max(Number(l.pendingGrnQty) - Number(l.grnQty || 0), 0)) : '—'}
                    </td>
                  )}
                  <td className="right num">{money(amountOf(l))}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td colSpan={mode === 'PO' ? 5 : 2} className="right">Total amount</td>
                <td className="right num">{money(totals.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
      </Modal>

      {/* ── "Add PO items" while editing a draft ──────────────────────────────── */}
      <Modal
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        title="Add PO items"
        subtitle="Tick a purchase order to take all of its pending items, or tick single items."
        size="xl"
        footer={
          <>
            <span className="grow" style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {count(picked.size)} item(s) selected{picked.size > 0 ? ` from ${count(pickedPoCount)} PO(s)` : ''}
            </span>
            <Button variant="ghost" onClick={() => setPickerOpen(false)}>Cancel</Button>
            <Button variant="primary" disabled={picked.size === 0} onClick={addSelectedPoLines}>
              Add selected
            </Button>
          </>
        }
      >
        {pickerOpen && pickerList}
      </Modal>

      <ItemHistoryModal itemId={historyItemId} onClose={() => setHistoryItemId(null)} />
    </>
  );
}
