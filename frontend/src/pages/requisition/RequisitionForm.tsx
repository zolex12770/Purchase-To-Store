/**
 * Requisition — create / edit (Purchase Module tab 4).
 *
 * A material REQUEST, not a purchase document — no rate/GST is collected.
 * Department and HOD are never chosen here: they are resolved server-side
 * from the signed-in requester's own user record (department -> HOD mapping,
 * lookups.extra), exactly as the brief requires ("HOD must NOT be hardcoded
 * in the frontend"). Stock is deliberately NOT checked at this stage — Live
 * Stock is shown next to each line purely for the requester's information;
 * requesting more than what is on hand is allowed (Rule 2).
 */
import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2, Save, Send, ArrowLeft, Info, Package } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { useToast } from '../../components/Toast';
import { useLookupOptions, useUserOptions, fetchItemProfile, type ItemProfile } from '../../lib/masters';
import { ItemSelect } from '../../components/MasterSelect';
import { matchCostCentre } from '../../lib/costCentreMatch';
import { PageHeader } from '../../layout/AppShell';
import {
  Button, Card, CardBody, CardHeader, Field, Input, Select, EmptyState, LoadingBlock,
} from '../../components/ui';
import { qty, money, today, text, toShortUom } from '../../lib/format';

interface LineDraft {
  uid: string;
  itemId: number | null;
  itemCode: string;
  itemDescription: string;
  mainGroupName: string;
  requestedQty: string;
  rate: string;
  uomId: number | null;
  uomCode: string;
  remarks: string;
  live?: ItemProfile['live'];
}

const newLine = (): LineDraft => ({
  uid: `L${Date.now()}${Math.round(performance.now() * 1000) % 1000}`,
  itemId: null, itemCode: '', itemDescription: '', mainGroupName: '',
  requestedQty: '', rate: '', uomId: null, uomCode: '', remarks: '',
});

const lineValue = (l: LineDraft) => Number(l.requestedQty || 0) * Number(l.rate || 0);

export default function RequisitionForm() {
  const { id } = useParams();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const { user, can, isSuperAdmin } = useAuth();
  const canSeeFinancials = can('requisition.approve') || isSuperAdmin;
  const canCreateOnBehalf = can('user.admin') || user?.roles.includes('ADMIN') || user?.roles.includes('STORE') || isSuperAdmin;

  const { data: userOptions } = useUserOptions();
  const [selectedUserId, setSelectedUserId] = useState<number | null>(user?.id ?? null);

  const [requisitionDate, setRequisitionDate] = useState(today());
  const [machineId, setMachineId] = useState<number | null>(null);
  const [costCentreId, setCostCentreId] = useState<number | null>(null);
  const [remarks, setRemarks] = useState('');
  const [lines, setLines] = useState<LineDraft[]>([newLine()]);
  const [errors, setErrors] = useState<Record<string, string>>({});

  const costCentreManualRef = useRef(false);
  const submitting = useRef(false);

  const { options: costCentres } = useLookupOptions('COST_CENTRE');
  const { raw: allDepartments } = useLookupOptions('DEPARTMENT');
  const { raw: allMachines } = useLookupOptions('MACHINE');

  const effectiveUser = userOptions?.find((u) => u.id === selectedUserId) ?? user;
  const effectiveDepartmentId = effectiveUser?.departmentId;
  const effectiveDepartmentName = (effectiveUser as { departmentName?: string | null })?.departmentName ?? (effectiveUser as { department?: string })?.department;

  const userDept = allDepartments.find((d) => d.id === effectiveDepartmentId || d.name === effectiveDepartmentName);
  const hodName = ((userDept?.extra as { hodName?: string } | undefined)?.hodName) || '';

  const machines = allMachines
    .filter((m) => !effectiveDepartmentId || m.parentId === effectiveDepartmentId)
    .map((m) => ({ value: m.id, label: m.name }));

  const existing = useQuery({
    queryKey: ['requisition', id],
    queryFn: () => api.get<Record<string, unknown>>(`/requisitions/${id}`),
    enabled: isEdit,
  });

  useEffect(() => {
    if (!existing.data) return;
    const d = existing.data as {
      requisition_date: string; machine_id: number | null; cost_centre_id: number | null;
      remarks: string; lines: Record<string, unknown>[];
    };
    setRequisitionDate(String(d.requisition_date).slice(0, 10));
    setMachineId(d.machine_id);
    setCostCentreId(d.cost_centre_id);
    if (d.cost_centre_id) costCentreManualRef.current = true;
    if ((d as { requester_user_id?: number }).requester_user_id) {
      setSelectedUserId(Number((d as { requester_user_id?: number }).requester_user_id));
    }
    setRemarks(d.remarks ?? '');
    const loaded: LineDraft[] = (d.lines ?? []).map((l, i) => ({
      uid: `E${i}`,
      itemId: Number(l.item_id),
      itemCode: String(l.item_code ?? ''),
      itemDescription: String(l.item_description ?? ''),
      mainGroupName: String(l.main_group_name ?? ''),
      requestedQty: String(l.requested_qty ?? ''),
      rate: '', // requisition_lines carries no rate (Sections 5-8) — fetched below from the live Item Master
      uomId: l.uom_id ? Number(l.uom_id) : null,
      uomCode: String(l.uom_code ?? ''),
      remarks: String(l.remarks ?? ''),
    }));
    setLines(loaded);

    // Current standard rate is informational display only — fetched
    // per line, same as a fresh item selection, never persisted.
    void Promise.all(loaded.map(async (l) => {
      if (!l.itemId) return;
      try {
        const p = await fetchItemProfile(l.itemId);
        setLines((ls) => ls.map((x) => (x.uid === l.uid ? { ...x, rate: p.standardRate ?? '0', live: p.live } : x)));
      } catch {
        // A deleted/inactive item still shows its snapshot fields; rate simply stays blank.
      }
    }));
  }, [existing.data]);

  // Department -> Cost Centre auto-match
  useEffect(() => {
    if (costCentreManualRef.current) return;
    if (!effectiveDepartmentName || costCentres.length === 0) return;
    const matched = matchCostCentre(effectiveDepartmentName, costCentres);
    if (matched != null) setCostCentreId(matched);
  }, [effectiveDepartmentName, costCentres]);

  async function selectItem(uid: string, itemId: number | null) {
    if (itemId === null) {
      setLines((ls) => ls.map((l) => (l.uid === uid ? { ...newLine(), uid: l.uid, requestedQty: l.requestedQty } : l)));
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
                mainGroupName: p.mainGroupName ?? '',
                uomId: p.uomId,
                uomCode: p.uomCode ?? '',
                rate: p.standardRate ?? '0',
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

  const validLines = lines.filter((l) => l.itemId && Number(l.requestedQty) > 0);
  const totals = {
    items: validLines.length,
    qty: validLines.reduce((s, l) => s + Number(l.requestedQty || 0), 0),
    value: validLines.reduce((s, l) => s + lineValue(l), 0),
  };
  const existingStatus = (existing.data as { status?: string } | undefined)?.status;
  const editingPending = isEdit && (existingStatus === 'PENDING_APPROVAL' || existingStatus === 'RETURNED');

  const save = useMutation({
    mutationFn: ({ submit }: { submit: boolean }) => {
      const payload = {
        requesterUserId: selectedUserId,
        requisitionDate, machineId, costCentreId, remarks, submit,
        lines: validLines.map((l) => ({ itemId: l.itemId, requestedQty: l.requestedQty, remarks: l.remarks })),
      };
      return isEdit
        ? api.put<{ id: number; requisition_no: string }>(`/requisitions/${id}`, payload)
        : api.post<{ id: number; requisition_no: string }>('/requisitions', payload);
    },
    onSuccess: (res, vars) => {
      toast.success(
        vars.submit ? 'Requisition submitted for HOD approval' : isEdit ? 'Requisition saved' : 'Requisition created',
        res.requisition_no,
      );
      void qc.invalidateQueries({ queryKey: ['requisitions'] });
      navigate(`/requisitions/${res.id}`);
    },
    onError: (err) => {
      if (err instanceof ApiError) setErrors(err.fieldErrors);
      toast.fromError(err);
    },
  });

  function attemptSave(submit: boolean) {
    const issues: Record<string, string> = {};
    if (!costCentreId) issues.costCentreId = 'Select a cost centre.';
    if (validLines.length === 0) issues.lines = 'Add at least one item line with a quantity.';
    setErrors(issues);
    if (Object.keys(issues).length > 0) {
      toast.error('Please complete the requisition', Object.values(issues)[0]);
      return;
    }
    if (submitting.current) return;
    submitting.current = true;
    save.mutate({ submit }, { onSettled: () => { submitting.current = false; } });
  }

  if (isEdit && existing.isLoading) return <LoadingBlock label="Loading requisition…" />;

  return (
    <>
      <PageHeader
        title={isEdit ? 'Edit Requisition' : 'Create Requisition'}
        subtitle="Request material for your department. Stock availability is checked by Stores at issue time, not here."
        breadcrumbs={[{ label: 'Requisition', to: '/requisitions' }, { label: isEdit ? 'Edit' : 'New' }]}
        actions={
          <>
            <Button variant="ghost" size="sm" icon={<ArrowLeft size={13} />} onClick={() => navigate('/requisitions')}>
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
                Submit for HOD approval
              </Button>
            )}
          </>
        }
      />

      <Card style={{ marginBottom: 'var(--sp-4)' }}>
        <CardHeader title="Requisition header" subtitle="The requisition number is issued by the system when you save" />
        <CardBody>
          <div className="form-grid">
            <Field label="Requisition no.">
              <Input value={isEdit ? String((existing.data as { requisition_no?: string })?.requisition_no ?? '') : 'Auto-generated'} disabled />
            </Field>
            <Field
              label="Requested by"
              hint={canCreateOnBehalf ? 'Select employee requesting material' : 'From your signed-in session — not editable'}
            >
              {canCreateOnBehalf && !isEdit ? (
                <Select
                  value={selectedUserId ?? ''}
                  placeholder="Select employee"
                  onChange={(e) => {
                    costCentreManualRef.current = false;
                    setSelectedUserId(e.target.value ? Number(e.target.value) : null);
                  }}
                  options={(userOptions ?? []).map((u) => ({
                    value: u.id,
                    label: `${u.employeeName} (${u.employeeId})${u.departmentName ? ' · ' + u.departmentName : ''}`,
                  }))}
                />
              ) : (
                <Input value={effectiveUser ? `${effectiveUser.employeeName} (${effectiveUser.employeeId})` : ''} disabled />
              )}
            </Field>
            <Field label="Department" hint="Auto-resolved from user profile">
              <Input value={effectiveDepartmentName ?? '—'} disabled />
            </Field>
            <Field
              label="Approving HOD"
              hint={!hodName ? '⚠️ No HOD is currently configured for this department' : 'Auto-resolved from department master'}
            >
              <Input
                value={hodName || '— (No HOD configured)'}
                disabled
                style={!hodName ? { borderColor: 'var(--warning-400)', color: 'var(--warning-700)' } : undefined}
              />
            </Field>
            <Field label="Date" required>
              <Input type="date" value={requisitionDate} onChange={(e) => setRequisitionDate(e.target.value)} />
            </Field>
            <Field label="Machine no." hint="Only your department's machines are listed">
              <Select value={machineId ?? ''} placeholder="Select machine" onChange={(e) => setMachineId(e.target.value ? Number(e.target.value) : null)} options={machines} />
            </Field>
            <Field label="Cost centre" required error={errors.costCentreId} hint="Compulsory cost centre allocation">
              <Select
                value={costCentreId ?? ''} placeholder="Select cost centre"
                invalid={Boolean(errors.costCentreId)}
                onChange={(e) => {
                  costCentreManualRef.current = true;
                  setCostCentreId(e.target.value ? Number(e.target.value) : null);
                }}
                options={costCentres}
              />
            </Field>
            <Field label="Remarks" span={2}>
              <Input value={remarks} onChange={(e) => setRemarks(e.target.value)} placeholder="Purpose of this requisition" />
            </Field>
          </div>
        </CardBody>
      </Card>

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
                    <th style={{ minWidth: 190 }}>Item Name</th>
                    <th style={{ minWidth: 120 }}>Main Group</th>
                    <th className="right" style={{ width: 100 }}>Requested Qty</th>
                    <th style={{ width: 80 }}>UOM</th>
                    <th className="right" style={{ width: 100 }}>Live Stock</th>
                    {canSeeFinancials && <th className="right" style={{ width: 100 }}>Rate</th>}
                    {canSeeFinancials && <th className="right" style={{ width: 110 }}>Value</th>}
                    <th style={{ minWidth: 160 }}>Remarks</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((l, i) => (
                    <tr key={l.uid}>
                      <td className="cell-muted num">{i + 1}</td>
                      <td>
                        <ItemSelect
                          value={l.itemId}
                          selectedCode={l.itemCode}
                          selectedDescription={l.itemDescription}
                          onChange={(itemId) => void selectItem(l.uid, itemId)}
                        />
                      </td>
                      <td className="cell-wrap cell-strong" style={{ minWidth: 160, maxWidth: 280 }}>{text(l.itemDescription)}</td>
                      <td className="cell-muted">{text(l.mainGroupName)}</td>
                      <td>
                        <Input
                          numeric type="number" step="0.0001" min="0" className="input-sm"
                          value={l.requestedQty}
                          onChange={(e) => updateLine(l.uid, { requestedQty: e.target.value })}
                          placeholder="0"
                          invalid={Boolean(l.itemId && !(Number(l.requestedQty) > 0))}
                        />
                      </td>
                      <td className="cell-muted">{toShortUom(l.uomCode)}</td>
                      <td
                        className="right num"
                        style={{
                          color: l.live && Number(l.live.liveStockQty) < Number(l.requestedQty || 0) ? 'var(--warning-600)' : 'var(--text-faint)',
                          fontWeight: l.live && Number(l.live.liveStockQty) < Number(l.requestedQty || 0) ? 600 : 400,
                        }}
                        title="Informational only — availability is checked by Stores at issue time"
                      >
                        {l.live ? qty(l.live.liveStockQty) : '—'}
                      </td>
                      {canSeeFinancials && (
                        <td>
                          <Input
                            numeric type="number" step="0.0001" min="0" className="input-sm"
                            value={l.rate} placeholder="0"
                            onChange={(e) => updateLine(l.uid, { rate: e.target.value })}
                            title="Informational only — for visibility and reporting, not a purchase price"
                          />
                        </td>
                      )}
                      {canSeeFinancials && (
                        <td className="right num cell-strong">{l.itemId ? money(lineValue(l)) : '—'}</td>
                      )}
                      <td>
                        <Input className="input-sm" value={l.remarks} onChange={(e) => updateLine(l.uid, { remarks: e.target.value })} placeholder="Optional" />
                      </td>
                    </tr>
                  ))}
                </tbody>
                {validLines.length > 0 && (
                  <tfoot>
                    <tr>
                      <td colSpan={4} className="cell-strong" style={{ textAlign: 'right' }}>
                        Total — {totals.items} item{totals.items === 1 ? '' : 's'}
                      </td>
                      <td className="right num cell-strong">{qty(totals.qty)}</td>
                      <td />
                      <td />
                      {canSeeFinancials && <td />}
                      {canSeeFinancials && <td className="right num cell-strong">{money(totals.value)}</td>}
                      <td />
                    </tr>
                  </tfoot>
                )}
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
              message="Search an Item Code above — description, UOM and Live Stock fill in automatically from the Item Master."
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
            <>This requisition is <strong>awaiting HOD approval</strong> (or was returned for correction). Saving keeps it in the workflow — no need to resubmit unless returned.</>
          ) : (
            <>
              <strong>Save draft</strong> keeps this editable. <strong>Submit for HOD approval</strong> sends it to your
              department's HOD — Requesting more than the current Live Stock is allowed; Stores decides the actual
              issue quantity later, limited only by what is physically on hand at that time.
            </>
          )}
        </span>
      </div>
    </>
  );
}
