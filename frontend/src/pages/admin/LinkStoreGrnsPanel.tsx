/**
 * Admin > Data Management: Link store GRNs to purchase orders (Super Admin only).
 *
 * The store's GRNs were imported on 2026-10-14 from the business sheet's GRN tab before
 * their purchase orders existed, so almost none carries a PO link and 2,000 of 2,003 POs
 * showed OPEN. The repair (backend admin/store-grn-links.ts) links a GRN line to a PO
 * line only on unambiguous GRN-tab evidence and holds every other line with its reason.
 * This panel runs its dry run, shows what it would link and why the rest is held, lets
 * purchase download the held list, and applies exactly the plan the dry run showed (its
 * selectionHash) after the typed confirmation. Each apply also records the held lines as
 * the store receipts awaiting link that the PO list and PO screen show.
 *
 * A line a Super Admin took back (undo) is kept out of the run by default: the tab still
 * names the PO, so the rules would link it again and the apply would erase its UNDONE
 * record (2026-10-17 review: ZG/TM/0159). Linking such lines again is an explicit choice.
 *
 * Supplier pairs are listed for review only: confirming two supplier records as one
 * company is not offered in this release.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Download, Play, RotateCcw, RefreshCw } from 'lucide-react';
import { api, saveBlob, ApiError } from '../../lib/api';
import {
  Banner, Button, Card, CardBody, CardHeader, Field, Input, Modal, SectionTitle, Skeleton, StatusBadge,
} from '../../components/ui';
import { StatStrip } from '../../components/KpiCard';
import { count, formatDateTime, money, qty } from '../../lib/format';
import {
  applyFailure, heldListCsv, type HeldLine, type ReceiptEvidenceSummary, type UndoneLine,
} from '../../lib/receiptEvidence';

const LINK = '/admin/data-management/repair/link-store-grns';
/** The confirmation the server asks for (data-management.routes.ts). */
const PHRASE = 'LINK STORE GRNS';
const SUMMARY_KEY = ['purchase-orders', 'receipt-evidence', 'summary', 'all'];

interface SupplierPair {
  grnSupplierId: number; grnSupplier: string; poSupplierId: number; poSupplier: string;
  confirmedSame: boolean; lines: number; grns: string[];
}

interface LinkPlan {
  selectionHash: string;
  message: string;
  totals: {
    unlinkedLines: number; linkable: number; held: number; byReason: Record<string, number>; qtyLinked: string;
    grns: number; affectedPos: number;
  };
  poStatusCounts: { before: Record<string, number>; after: Record<string, number> };
  pendingValue: { before: string; after: string };
  supplierPairs: SupplierPair[];
  held: HeldLine[];
  /** The review choices the plan was made with: an apply repeats them, as the hash covers them. */
  review: { excludeGrnLineIds: number[] };
  /** Each hold reason in the PO screen's words (dry run only). */
  reasonText?: Record<string, string>;
  /** Lines a Super Admin took back: linked again by this plan (wouldLink) or kept out (dry run only). */
  previouslyUndone?: UndoneLine[];
}

interface ApplyResult extends LinkPlan {
  linesLinked: number;
  holdsRecorded: number;
  heldLines: number;
  runId: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'The request failed.');

const useSummary = () => useQuery({
  queryKey: SUMMARY_KEY,
  queryFn: () => api.get<ReceiptEvidenceSummary>('/purchase-orders/receipt-evidence/summary'),
});
/** Which record of held receipts the summary shows: a new apply replaces it with its own run. */
const recordKey = (s: ReceiptEvidenceSummary | undefined) => (s ? `${s.runId ?? ''}|${s.asOf ?? ''}` : null);

/** When the held receipts were last recorded: the summary's own figure, or why it cannot be read. */
function LastRecord({ snapshot }: { snapshot: ReturnType<typeof useSummary> }) {
  if (snapshot.isLoading) return <Skeleton w={320} h={14} />;
  if (snapshot.error) return <span className="cell-muted">Last record could not be read: {errorText(snapshot.error)}</span>;
  const s = snapshot.data;
  if (!s?.asOf) return <span>No link run has recorded the held receipts yet.</span>;
  return (
    <span>
      Held receipts last recorded <strong>{formatDateTime(s.asOf)}</strong>
      {s.runId && <span className="cell-muted"> · link run {s.runId.slice(0, 8)}</span>}
      {' '}· {count(s.awaitingLink.pos)} pending PO(s) with a store receipt awaiting link.
    </span>
  );
}

/** The lines a Super Admin took back that this plan keeps out, or (by choice) links again. */
function UndoneLines({ lines, onRelink, onKeepOut }: { lines: UndoneLine[]; onRelink: () => void; onKeepOut: () => void }) {
  const relinked = lines.filter((l) => l.wouldLink);
  const grns = new Set(lines.map((l) => l.grnId)).size;
  return (
    <div style={{ marginTop: 'var(--space-3)' }}>
      <Banner
        tone={relinked.length > 0 ? 'warning' : 'info'}
        block
        action={relinked.length > 0
          ? <Button size="sm" variant="secondary" onClick={onKeepOut}>Keep them out</Button>
          : <Button size="sm" variant="secondary" onClick={onRelink}>Link them again</Button>}
      >
        <div className="banner-title">
          {relinked.length > 0
            ? `This run links again ${count(relinked.length)} line(s) on ${count(grns)} GRN(s) that a Super Admin took back`
            : `${count(lines.length)} line(s) on ${count(grns)} GRN(s) that a Super Admin took back are kept out of this run`}
        </div>
        <div className="banner-text">
          {relinked.length > 0
            ? 'The GRN tab still names the PO they were taken back from. Link them again only if purchase has confirmed that PO line since.'
            : 'The GRN tab still names the PO they were taken back from, so the rules would link them again. They stay recorded as awaiting link.'}
        </div>
        <div className="banner-table">
          <table className="table table-compact">
            <thead><tr><th>GRN No</th><th>Item</th><th className="right">Qty</th><th>PO</th><th>Taken back</th><th>Why</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={l.grnLineId}>
                  <td className="cell-code">{l.grnNo}</td>
                  <td className="cell-code">{l.itemCode}</td>
                  <td className="right num">{qty(l.grnQty)}</td>
                  <td className="cell-code">{l.poNo ?? '—'}</td>
                  <td>{formatDateTime(l.undoneAt)} <span className="cell-muted">(audit #{l.undoAuditId})</span></td>
                  <td className="cell-wrap">{l.undoReason}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Banner>
    </div>
  );
}

function PlanView({ plan, onDownload, onApply, onRelink, onKeepOut }: {
  plan: LinkPlan; onDownload: () => void; onApply: () => void; onRelink: () => void; onKeepOut: () => void;
}) {
  const t = plan.totals;
  const reasons = Object.entries(t.byReason).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const statuses = [...new Set([...Object.keys(plan.poStatusCounts.before), ...Object.keys(plan.poStatusCounts.after)])].sort();
  const undone = plan.previouslyUndone ?? [];
  return (
    <div className="link-plan">
      <p className="cell-muted" style={{ margin: 'var(--space-3) 0' }}>{plan.message}</p>
      <StatStrip
        label="Dry run totals"
        items={[
          { label: 'Unlinked store GRN lines', value: count(t.unlinkedLines) },
          { label: 'Would link', value: count(t.linkable), sub: `${count(t.grns)} GRNs · ${count(t.affectedPos)} POs`, tone: 'success' },
          { label: 'Held', value: count(t.held), sub: 'recorded as awaiting link', tone: 'warning' },
          { label: 'Pending PO value now', value: money(plan.pendingValue.before), title: 'Open quantity on receivable PO lines, at the final rate' },
          { label: 'Pending PO value after', value: money(plan.pendingValue.after), tone: 'info' },
        ]}
      />
      {undone.length > 0 && <UndoneLines lines={undone} onRelink={onRelink} onKeepOut={onKeepOut} />}
      <div className="link-plan-grid">
        <div>
          <SectionTitle>Held lines by reason</SectionTitle>
          <table className="table table-compact">
            <thead><tr><th>Reason</th><th className="right">Lines</th></tr></thead>
            <tbody>
              {reasons.length === 0 && <tr><td colSpan={2} className="cell-muted">Nothing is held.</td></tr>}
              {reasons.map(([reason, n]) => (
                <tr key={reason}>
                  <td className="cell-wrap">
                    <div>{plan.reasonText?.[reason] ?? reason}</div>
                    <div className="cell-muted cell-code">{reason}</div>
                  </td>
                  <td className="right num">{count(n)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div>
          <SectionTitle>Purchase orders by status</SectionTitle>
          <table className="table table-compact">
            <thead><tr><th>Status</th><th className="right">Now</th><th className="right">After</th></tr></thead>
            <tbody>
              {statuses.map((s) => (
                <tr key={s}>
                  <td><StatusBadge status={s} /></td>
                  <td className="right num">{count(plan.poStatusCounts.before[s] ?? 0)}</td>
                  <td className="right num">{count(plan.poStatusCounts.after[s] ?? 0)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      {plan.supplierPairs.length > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }}>
          <SectionTitle>Supplier pairs on otherwise linkable lines</SectionTitle>
          <p className="cell-muted" style={{ margin: '0 0 var(--space-2)' }}>
            The GRN's supplier and the supplier of the PO the tab names differ. Listed for review only: these lines stay held,
            and confirming two supplier records as one company is not offered in this release.
          </p>
          <div className="table-wrap">
            <table className="table table-compact">
              <thead><tr><th>GRN supplier</th><th>PO supplier</th><th className="right">Lines</th><th>GRNs</th></tr></thead>
              <tbody>
                {plan.supplierPairs.map((p) => (
                  <tr key={`${p.grnSupplierId}>${p.poSupplierId}`}>
                    <td className="cell-wrap">{p.grnSupplier}</td>
                    <td className="cell-wrap">{p.poSupplier}</td>
                    <td className="right num">{count(p.lines)}</td>
                    <td className="cell-code cell-wrap">{p.grns.slice(0, 3).join(', ')}{p.grns.length > 3 ? ` +${p.grns.length - 3} more` : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      <div className="row" style={{ gap: 'var(--space-2)', marginTop: 'var(--space-4)', flexWrap: 'wrap' }}>
        <Button variant="secondary" icon={<Download size={14} />} onClick={onDownload} disabled={plan.held.length === 0}>
          Download held list (CSV)
        </Button>
        <span className="spacer" />
        <Button variant="primary" icon={<Link2 size={14} />} onClick={onApply}>Apply</Button>
      </div>
    </div>
  );
}

export function LinkStoreGrnsPanel() {
  const qc = useQueryClient();
  const snapshot = useSummary();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [applied, setApplied] = useState<ApplyResult | null>(null);
  // Lines a Super Admin took back stay out of the run unless linking them again is chosen.
  const [relinkUndone, setRelinkUndone] = useState(false);
  // The record of held receipts when Apply was pressed: another one afterwards came from that apply.
  const [recordAtApply, setRecordAtApply] = useState<string | null>(null);

  const dry = useMutation({
    mutationFn: (relink: boolean) => api.post<LinkPlan>(LINK, { keepOutUndone: !relink }),
    onSuccess: () => setApplied(null),
  });
  const runDry = (relink = relinkUndone) => { setRelinkUndone(relink); dry.mutate(relink); };
  const apply = useMutation({
    // The plan's own exclusions (the lines taken back among them): the hash covers them.
    mutationFn: (p: LinkPlan) => api.post<ApplyResult>(LINK, {
      dryRun: false, confirm: phrase, expectedHash: p.selectionHash, excludeGrnLineIds: p.review.excludeGrnLineIds,
    }),
    onSuccess: (res) => {
      setApplied(res);
      setConfirmOpen(false);
      setPhrase('');
      // The plan is spent: a further apply needs a fresh dry run.
      dry.reset();
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['purchase-order'] });
    },
    onError: (err) => {
      // No answer is not "nothing happened": the server may have committed. Read the record again.
      if (applyFailure(err) === 'unknown') void qc.invalidateQueries({ queryKey: SUMMARY_KEY });
    },
  });
  const plan = dry.data;
  const failure = apply.error ? applyFailure(apply.error) : null;
  // What the plan would be now, from a 409's details (store-grn-links.ts applyStoreGrnLinks).
  const now = failure === 'changed' ? (apply.error as ApiError).details as { linkable?: number; held?: number } | undefined : undefined;
  const nowPlan = now?.linkable !== undefined && now.held !== undefined
    ? <span className="cell-muted"> It would now link {count(now.linkable)} line(s) and hold {count(now.held)}.</span>
    : null;
  // After an apply whose answer never came: has its own record of held receipts appeared?
  const wentThrough = failure === 'unknown' && !snapshot.isFetching && recordAtApply !== null
    && recordKey(snapshot.data) !== null && recordKey(snapshot.data) !== recordAtApply;

  const download = () => {
    if (!plan) return;
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(new Blob([heldListCsv(plan.held, plan.reasonText ?? {})], { type: 'text/csv;charset=utf-8' }), `held-store-receipts-${stamp}.csv`);
  };
  const closeConfirm = () => {
    if (apply.isPending) return;
    setConfirmOpen(false);
    setPhrase('');
    // An unknown outcome stays on screen until a fresh dry run: the plan may be spent.
    if (failure !== 'unknown') apply.reset();
  };
  const keptOut = (plan?.previouslyUndone ?? []).filter((u) => !u.wouldLink).length;
  const relinked = (plan?.previouslyUndone ?? []).filter((u) => u.wouldLink).length;

  return (
    <Card id="link-store-grns" style={{ marginTop: 'var(--sp-4)' }}>
      <CardHeader
        icon={<Link2 size={15} />}
        title="Link store GRNs to purchase orders"
        subtitle="Super Admin only. Links a store receipt to its PO line only on unambiguous GRN-tab evidence; every other line is held with its reason."
        actions={
          <Button variant="secondary" size="sm" icon={<Play size={13} />} loading={dry.isPending} onClick={() => { apply.reset(); runDry(false); }}>
            Run dry run
          </Button>
        }
      />
      <CardBody>
        <p style={{ margin: 0, color: 'var(--text-2)', lineHeight: 'var(--lh-normal)' }}>
          The store's GRNs were imported on 14 Oct 2026 before their purchase orders existed, so most carry no PO link and their
          orders look unreceived. The dry run reads the business sheet's GRN tab and lists what it would link and why each other
          line is held. Nothing changes until you apply it; quantities, stock and the ledger never change.
        </p>
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-13)' }}><LastRecord snapshot={snapshot} /></div>

        {failure === 'unknown' && !confirmOpen && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner
              tone="warning"
              block
              action={(
                <div className="row" style={{ gap: 'var(--space-2)' }}>
                  <Button size="sm" variant="secondary" icon={<RefreshCw size={13} />} loading={snapshot.isFetching} onClick={() => void snapshot.refetch()}>
                    Check again
                  </Button>
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => { apply.reset(); runDry(false); }}>
                    Run the dry run again
                  </Button>
                </div>
              )}
            >
              <div className="banner-title">The outcome of the apply is not known</div>
              <div className="banner-text">
                {wentThrough
                  ? <>It went through: the held receipts were recorded at {formatDateTime(snapshot.data!.asOf)}
                    {snapshot.data!.runId ? ` (link run ${snapshot.data!.runId.slice(0, 8)})` : ''}. Run the dry run again to see what is left.</>
                  : <>No answer came ({errorText(apply.error)}), so the links may still have been written. No newer record of held receipts
                    has appeared yet; check again in a minute, and run the dry run again before applying anything.</>}
              </div>
            </Banner>
          </div>
        )}
        {dry.isPending && <div style={{ marginTop: 'var(--space-3)' }}><Skeleton w="60%" h={14} /><Skeleton w="90%" h={10} /></div>}
        {dry.error && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => runDry()}>Try again</Button>}>
              The dry run could not be completed: {errorText(dry.error)}
            </Banner>
          </div>
        )}
        {applied && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="info">
              <strong>Applied.</strong> {count(applied.linesLinked)} line(s) linked; {count(applied.heldLines)} held line(s) recorded
              as store receipts awaiting link. {applied.message}
            </Banner>
          </div>
        )}
        {plan && failure !== 'unknown' && (
          <PlanView
            plan={plan}
            onDownload={download}
            onApply={() => { apply.reset(); setConfirmOpen(true); }}
            onRelink={() => runDry(true)}
            onKeepOut={() => runDry(false)}
          />
        )}
      </CardBody>

      {plan && (
        <Modal
          open={confirmOpen}
          onClose={closeConfirm}
          title="Apply Link store GRNs?"
          size="md"
          role="alertdialog"
          busy={apply.isPending}
          footer={
            <>
              <Button variant="secondary" onClick={closeConfirm} disabled={apply.isPending}>Cancel</Button>
              <Button
                variant="primary"
                icon={<Link2 size={14} />}
                loading={apply.isPending}
                disabled={phrase !== PHRASE || failure === 'changed' || failure === 'unknown'}
                onClick={() => { setRecordAtApply(recordKey(snapshot.data)); apply.mutate(plan); }}
              >
                Apply
              </Button>
            </>
          }
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)', color: 'var(--text-2)', lineHeight: 'var(--lh-normal)' }}>
            <div>
              This links <strong>{count(plan.totals.linkable)}</strong> store GRN line(s) ({qty(plan.totals.qtyLinked)} received) on{' '}
              {count(plan.totals.grns)} GRN(s) to {count(plan.totals.affectedPos)} purchase order(s), exactly as the dry run listed,
              and records the <strong>{count(plan.totals.held)}</strong> held line(s) as store receipts awaiting link, replacing the
              earlier record. Quantities, stock and the ledger are not changed; every link is audited and can be undone.
            </div>
            {keptOut > 0 && <div>{count(keptOut)} line(s) a Super Admin took back stay out of this run.</div>}
            {relinked > 0 && <div><strong>{count(relinked)} line(s) a Super Admin took back are linked again by this run.</strong></div>}
            <div>Take a verified backup first (Admin &gt; Backup).</div>
            {apply.error && failure !== 'unknown' && (
              <Banner
                tone="danger"
                action={failure === 'changed' ? (
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => { closeConfirm(); runDry(); }}>
                    Run the dry run again
                  </Button>
                ) : undefined}
              >
                {failure === 'changed'
                  ? <>The GRN tab or the ERP changed after this dry run, so nothing was linked. Run the dry run again and review it.{nowPlan}</>
                  : <>Nothing was linked: {errorText(apply.error)}</>}
              </Banner>
            )}
            {failure === 'unknown' && (
              <Banner tone="warning">
                No answer came ({errorText(apply.error)}), so the outcome is not known: the links may have been written. Close this
                and check the last record before doing anything else.
              </Banner>
            )}
            <Field label={<>Type <strong>{PHRASE}</strong> to confirm</>} required>
              <Input value={phrase} onChange={(e) => setPhrase(e.target.value)} autoComplete="off" spellCheck={false} placeholder={PHRASE} />
            </Field>
          </div>
        </Modal>
      )}
    </Card>
  );
}
