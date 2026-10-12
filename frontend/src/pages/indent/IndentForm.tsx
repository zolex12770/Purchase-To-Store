/**
 * Purchase Indent — create / edit (SRS §10).
 *
 * Header entered once, item lines added one at a time. Choosing an Item Code
 * auto-populates description, UOM, specification, department and cost centre
 * from the Item Master, and shows the item's live open-demand and
 * pending-receipt quantities so the requester can see what is already on order.
 *
 * UI fields are deliberately scoped to the Purchase Indent reference contract
 * (Indent No, Raised By, Indent Date/Time, Indent Type, Department, Cost
 * Centre — all required; line: Item Code, Item Description, Indent Qty, UOM,
 * Item Specification, Live Qty, Pending GRN Qty). Est. Rate/Value and
 * Suggested Supplier are outside that contract and are never collected or
 * shown. Remarks and Expected Date (Required By) are optional, admin-gated
 * fields (Admin → Settings → Form field configuration) — off/on by their own
 * default, never forced onto every deployment.
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Send, ArrowLeft, Info, Package, History } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { useLookupOptions, fetchItemProfile, useSettings, type ItemProfile } from '../../lib/masters';
import { ItemSelect } from '../../components/MasterSelect';
import { matchCostCentre } from '../../lib/costCentreMatch';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Select, EmptyState, LoadingBlock,
} from '../../components/ui';
import { ItemHistoryModal } from '../../components/ItemHistoryModal';
import { qty, today, text } from '../../lib/format';

interface LineDraft {
  uid: string;
  itemId: number | null;
  itemCode: string;
  itemDescription: string;
  indentQty: string;
  uomId: number | null;
  uomCode: string;
  itemSpecification: string;
  departmentId: number | null;
  costCentreId: number | null;
  /** Live Qty / Pending GRN Qty — read-only, fetched with the item profile. */
  live?: ItemProfile['live'];
}

const newLine = (): LineDraft => ({
  uid: `L${Date.now()}${Math.round(performance.now() * 1000) % 1000}`,
  itemId: null, itemCode: '', itemDescription: '', indentQty: '',
  uomId: null, uomCode: '', itemSpecification: '',
  departmentId: null, costCentreId: null,
});

export default function IndentForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { user } = useAuth();

  const [indentDate, setIndentDate] = useState(today());
  const [requiredByDate, setRequiredByDate] = useState('');
  const [indentTypeId, setIndentTypeId] = useState<number | null>(null);
  const [departmentId, setDepartmentId] = useState<number | null>(null);
  const [costCentreId, setCostCentreId] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [historyItemId, setHistoryItemId] = useState<number | null>(null);

  // Cost Centre auto-match tracking (pinpoint fix — Raised By → Department →
  // Cost Centre auto-fill). `costCentreManualRef` is true once the user has
  // explicitly picked a cost centre for the CURRENTLY selected department;
  // while true, auto-matching does not overwrite their choice. Changing
  // Department resets it, so a new department always gets a fresh match.
  const costCentreManualRef = useRef(false);
  // Set synchronously on the first click: a second click can arrive before React
  // has re-rendered the button as disabled, and would otherwise save twice.
  const submitting = useRef(false);
  const deptAutoFilledRef = useRef(false);

  // Remarks and Expected Date are not part of the core Indent field contract —
  // each is shown only when an administrator has turned it on (Admin →
  // Settings → Form field configuration). Every other field is always shown.
  const { data: settings } = useSettings();
  const remarksVisible = settings?.['form_fields.indent.remarks_visible'] === true;
  const requiredByVisible = settings?.['form_fields.indent.required_by_visible'] !== false;

  const { options: indentTypeBase } = useLookupOptions('INDENT_TYPE');
  // An indent being edited may carry a type that is no longer offered (an older
  // value since switched off). It must still show, and survive the save.
  const [savedTypeName, setSavedTypeName] = useState<string | null>(null);
  const indentTypes = indentTypeId != null && savedTypeName && !indentTypeBase.some((o) => o.value === indentTypeId)
    ? [{ value: indentTypeId, label: savedTypeName }, ...indentTypeBase]
    : indentTypeBase;
  const { options: departments } = useLookupOptions('DEPARTMENT');
  const { options: costCentres } = useLookupOptions('COST_CENTRE');
  const { options: uoms } = useLookupOptions('UOM');


  /* Load an existing draft for editing. */
  const existing = useQuery({
    queryKey: ['indent', id],
    queryFn: () => api.get<Record<string, unknown>>(`/indents/${id}`),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data as {
      indent_date: string; indent_type_id: number | null; department_id: number | null;
      cost_centre_id: number | null; remarks: string; required_by_date: string | null;
      lines: Record<string, unknown>[];
    };
    setIndentDate(String(d.indent_date).slice(0, 10));
    setRequiredByDate(d.required_by_date ? String(d.required_by_date).slice(0, 10) : '');
    setIndentTypeId(d.indent_type_id);
    setSavedTypeName((d as { indent_type_name?: string | null }).indent_type_name ?? null);
    setDepartmentId(d.department_id);
    setCostCentreId(d.cost_centre_id);
    // A loaded record's saved cost centre is authoritative — never auto-overwrite
    // it on load. Re-matching still kicks in if the user changes Department again.
    deptAutoFilledRef.current = true;
    costCentreManualRef.current = true;
    setRemarks(d.remarks ?? '');
    setLines(
      (d.lines ?? []).map((l, i) => ({
        uid: `E${i}`,
        itemId: Number(l.item_id),
        itemCode: String(l.item_code ?? ''),
        itemDescription: String(l.item_description ?? ''),
        indentQty: String(l.indent_qty ?? ''),
        uomId: l.uom_id ? Number(l.uom_id) : null,
        uomCode: String(l.uom_code ?? ''),
        itemSpecification: String(l.item_specification ?? ''),
        departmentId: l.department_id ? Number(l.department_id) : null,
        costCentreId: l.cost_centre_id ? Number(l.cost_centre_id) : null,
      })),
    );
  }, [existing.data]);

  /* ── Raised By → Department auto-fill (new indent only) ──────────────────── */
  useEffect(() => {
    if (isEdit || deptAutoFilledRef.current) return;
    if (departmentId !== null) return;
    if (user?.departmentId) {
      deptAutoFilledRef.current = true;
      setDepartmentId(user.departmentId);
    }
  }, [isEdit, user, departmentId]);

  /* ── Department → Cost Centre auto-match ──────────────────────────────────
     Re-runs whenever Department changes (including the auto-fill above), but
     never overwrites a Cost Centre the user picked for the current Department. */
  useEffect(() => {
    if (departmentId === null || costCentreManualRef.current) return;
    const dept = departments.find((d) => d.value === departmentId);
    if (!dept) return;
    setCostCentreId(matchCostCentre(dept.label, costCentres));
  }, [departmentId, departments, costCentres]);

  /* ── Item auto-population (SRS §10) ─────────────────────────────────────── */
  async function selectItem(uid: string, itemId: number | null) {
    if (itemId === null) {
      setLines((ls) => ls.map((l) => (l.uid === uid ? { ...newLine(), uid: l.uid, indentQty: l.indentQty } : l)));
      return;
    }
    try {
      const p = await fetchItemProfile(itemId);
      setLines((ls) =>
        ls.map((l) =>
          l.uid === uid
            ? {
                ...l,
                itemId: p.id,
                itemCode: p.itemCode,
                itemDescription: p.itemDescription,
                // Everything the Item Master already knows fills itself in.
                uomId: p.uomId,
                uomCode: p.uomCode ?? '',
                itemSpecification: p.itemSpecification,
                departmentId: p.departmentId ?? departmentId,
                costCentreId: p.costCentreId ?? costCentreId,
                live: p.live,
              }
            : l,
        ),
      );
    } catch (err) {
      toast.fromError(err, 'Could not load item details');
    }
  }

  const updateLine = (uid: string, patch: Partial<LineDraft>) =>
    setLines((ls) => ls.map((l) => (l.uid === uid ? { ...l, ...patch } : l)));

  const removeLine = (uid: string) =>
    setLines((ls) => (ls.length === 1 ? [newLine()] : ls.filter((l) => l.uid !== uid)));

  const validLines = lines.filter((l) => l.itemId && Number(l.indentQty) > 0);
  // Editing a PENDING_APPROVAL indent (the raiser fixing a mistake, or an
  // approver adjusting it while reviewing) never reverts it to draft — label
  // the primary action accordingly instead of the misleading "Save draft".
  const existingStatus = (existing.data as { status?: string } | undefined)?.status;
  const editingPending = isEdit && existingStatus === 'PENDING_APPROVAL';

  const save = useMutation({
    mutationFn: ({ submit }: { submit: boolean }) => {
      const payload = {
        indentDate, indentTypeId, departmentId, costCentreId, submit,
        requiredByDate: requiredByDate || null,
        ...(remarksVisible ? { remarks } : {}),
        lines: validLines.map((l) => ({
          itemId: l.itemId,
          indentQty: l.indentQty,
          uomId: l.uomId,
          itemSpecification: l.itemSpecification,
          departmentId: l.departmentId,
          costCentreId: l.costCentreId,
        })),
      };
      return isEdit
        ? api.put<{ id: number; indent_no: string }>(`/indents/${id}`, payload)
        : api.post<{ id: number; indent_no: string }>('/indents', payload);
    },
    onSuccess: (res, vars) => {
      toast.success(
        vars.submit ? 'Indent submitted for approval' : isEdit ? 'Indent saved' : 'Indent created',
        res.indent_no,
      );
      void qc.invalidateQueries({ queryKey: ['indents'] });
      navigate(`/indents/${res.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  function attemptSave(submit: boolean) {
    const issues: Record<string, string> = {};
    if (validLines.length === 0) issues.lines = 'Add at least one item line with a quantity.';
    if (!indentTypeId) issues.indentTypeId = 'Select an indent type.';
    if (!departmentId) issues.departmentId = 'Select a department.';
    if (!costCentreId) issues.costCentreId = 'Select a cost centre.';
    setErrors(issues);
    if (Object.keys(issues).length > 0) {
      toast.error('Please complete the indent', Object.values(issues)[0]);
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    save.mutate({ submit }, { onSettled: () => { submitting.current = false; } });
  }

  if (isEdit && existing.isLoading) return <LoadingBlock label="Loading indent…" />;

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit Indent' : 'Create Indent'}
        subtitle="Enter the header once, then add item lines. Selecting an item fills in the rest."
        breadcrumbs={[
          { label: 'Purchase Indent', to: '/indents' },
          { label: isEdit ? 'Edit' : 'New' },
        ]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/indents')}>
              Cancel
            </Button>
            <Button variant="secondary" size="sm" icon={<Save size={13} />}
                    loading={save.isPending && !save.variables?.submit}
                    onClick={() => attemptSave(false)}>
              {editingPending ? 'Save changes' : 'Save draft'}
            </Button>
            {!editingPending && (
              <Button variant="primary" size="sm" icon={<Send size={13} />}
                      loading={save.isPending && save.variables?.submit === true}
                      onClick={() => attemptSave(true)}>
                Submit for approval
              </Button>
            )}
          </>
        }
      />

      {/* ── Header ────────────────────────────────────────────────────────── */}
      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Indent header" subtitle="The indent number is issued by the system when you save" />
        <CardBody>
          <div className="form-grid">
            <Field label="Indent no.">
              <Input value={isEdit ? String((existing.data as { indent_no?: string })?.indent_no ?? '') : 'Auto-generated'} disabled />
            </Field>
            <Field label="Raised by" hint="From your signed-in session — not editable">
              <Input value={user ? `${user.employeeName} (${user.employeeId})` : ''} disabled />
            </Field>
            <Field label="Date" required>
              <Input type="date" value={indentDate} onChange={(e) => setIndentDate(e.target.value)} />
            </Field>
            {requiredByVisible && (
              <Field label="Expected Date" hint="Optional">
                <Input type="date" value={requiredByDate} onChange={(e) => setRequiredByDate(e.target.value)} />
              </Field>
            )}
            <Field label="Indent type" required error={errors.indentTypeId}>
              <Select
                value={indentTypeId ?? ''} placeholder="Select type"
                invalid={Boolean(errors.indentTypeId)}
                onChange={(e) => setIndentTypeId(e.target.value ? Number(e.target.value) : null)}
                options={indentTypes}
              />
            </Field>
            <Field label="Department" required error={errors.departmentId} hint="Defaults onto each line">
              <Select value={departmentId ?? ''} placeholder="Select department"
                      invalid={Boolean(errors.departmentId)}
                      onChange={(e) => {
                        // A new department always gets a fresh Cost Centre match.
                        costCentreManualRef.current = false;
                        setDepartmentId(e.target.value ? Number(e.target.value) : null);
                      }}
                      options={departments} />
            </Field>
            <Field label="Cost centre" required error={errors.costCentreId} hint="Auto-matched from department — change anytime">
              <Select value={costCentreId ?? ''} placeholder="Select cost centre"
                      invalid={Boolean(errors.costCentreId)}
                      onChange={(e) => {
                        costCentreManualRef.current = true;
                        setCostCentreId(e.target.value ? Number(e.target.value) : null);
                      }}
                      options={costCentres} />
            </Field>
            {remarksVisible && (
              <Field label="Remarks" span={2}>
                <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Purpose of this requisition" />
              </Field>
            )}
          </div>
        </CardBody>
      </Card>

      {/* ── Lines ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader
          title="Item lines"
          subtitle={`${validLines.length} valid line(s)`}
          actions={<Button variant="secondary" size="sm" icon={<Plus size={13} />} onClick={() => setLines((ls) => [...ls, newLine()])}>Add line</Button>}
        />
        <CardBody flush>
          {errors.lines && (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--danger-50)', color: 'var(--danger-700)', fontSize: 'var(--text-sm)', borderBottom: '1px solid var(--danger-100)' }}>
              {errors.lines}
            </div>
          )}

          <div className="table-with-actions-rail">
            <div className="table-wrap">
              <table className="table table-compact">
                <thead>
                  <tr>
                    <th style={{ width: 34 }}>#</th>
                    <th style={{ minWidth: 220 }}>Item Code</th>
                    <th style={{ minWidth: 190 }}>Item Description</th>
                    <th className="right" style={{ width: 100 }}>Indent Qty</th>
                    <th style={{ width: 90 }}>UOM</th>
                    <th style={{ minWidth: 180 }}>Item Specification</th>
                    <th className="right" style={{ width: 90 }}>Live Qty</th>
                    <th className="right" style={{ width: 130 }}>Pending GRN Qty</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.uid}>
                      <td className="cell-muted num">{i + 1}</td>
                      <td>
                        <div className="row" style={{ gap: 4 }}>
                          <div className="grow" style={{ minWidth: 0 }}>
                            {/* Searches the whole Item Master on the server (it used to
                                filter only the first 50 items that had been preloaded). The
                                line's own code/description keep an already-chosen item
                                showing whatever the latest results are. */}
                            <ItemSelect
                              value={l.itemId}
                              selectedCode={l.itemCode}
                              selectedDescription={l.itemDescription}
                              onChange={(itemId) => void selectItem(l.uid, itemId)}
                            />
                          </div>
                          {l.itemId != null && (
                            <Button variant="ghost" size="sm" title="Item history" icon={<History size={13} />}
                                    onClick={() => setHistoryItemId(l.itemId)} />
                          )}
                        </div>
                      </td>
                      <td className="cell-wrap cell-strong" style={{ minWidth: 160, maxWidth: 280 }}>{text(l.itemDescription)}</td>
                      <td>
                        <Input
                          numeric type="number" step="0.0001" min="0" className="input-sm"
                          value={l.indentQty}
                          onChange={(e) => updateLine(l.uid, { indentQty: e.target.value })}
                          placeholder="0"
                          invalid={Boolean(l.itemId && !(Number(l.indentQty) > 0))}
                        />
                      </td>
                      <td>
                        <Select
                          className="input-sm" value={l.uomId ?? ''}
                          onChange={(e) => updateLine(l.uid, { uomId: e.target.value ? Number(e.target.value) : null })}
                          options={uoms} placeholder="—"
                        />
                      </td>
                      <td className="cell-wrap cell-muted" style={{ minWidth: 140, maxWidth: 240 }}>
                        {text(l.itemSpecification)}
                      </td>
                      <td className="right num cell-muted">{l.live ? qty(l.live.openIndentQty) : '—'}</td>
                      <td className="right num cell-muted">{l.live ? qty(l.live.pendingGrnQty) : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {lines.length > 0 && (
              <div className="actions-rail">
                <table className="table table-compact">
                  <thead><tr><th style={{ width: 44 }} /></tr></thead>
                  <tbody>
                    {lines.map((l) => (
                      <tr key={l.uid}>
                        <td className="right">
                          <Button variant="ghost" size="sm" onClick={() => removeLine(l.uid)} title="Remove line" icon={<Trash2 size={13} />} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {lines.every((l) => !l.itemId) && (
            <EmptyState
              icon={<Package />}
              title="No items selected yet"
              message="Search an Item Code above — description, UOM and specification fill in automatically from the Item Master."
            />
          )}
        </CardBody>
      </Card>

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
          {editingPending ? (
            <>This indent is <strong>awaiting approval</strong>. Saving keeps it pending — no need to resubmit.</>
          ) : (
            <>
              <strong>Save draft</strong> keeps this editable. <strong>Submit for approval</strong> sends it to
              the Purchase Head — approved indents can then be converted into purchase orders. A Purchase Head
              may still adjust it while it is pending approval.
            </>
          )}
        </span>
      </div>

      <ItemHistoryModal itemId={historyItemId} onClose={() => setHistoryItemId(null)} />
    </>
  );
}
