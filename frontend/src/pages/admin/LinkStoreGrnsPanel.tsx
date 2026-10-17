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
 * Supplier pairs are listed for review only: confirming two supplier records as one
 * company is not offered in this release.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link2, Download, Play, RotateCcw } from 'lucide-react';
import { api, saveBlob, ApiError } from '../../lib/api';
import {
  Banner, Button, Card, CardBody, CardHeader, Field, Input, Modal, SectionTitle, Skeleton, StatusBadge,
} from '../../components/ui';
import { StatStrip } from '../../components/KpiCard';
import { count, formatDateTime, money, qty } from '../../lib/format';
import { heldListCsv, type HeldLine, type ReceiptEvidenceSummary } from '../../lib/receiptEvidence';

const LINK = '/admin/data-management/repair/link-store-grns';
/** The confirmation the server asks for (data-management.routes.ts). */
const PHRASE = 'LINK STORE GRNS';

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
  /** Each hold reason in the PO screen's words (dry run only). */
  reasonText?: Record<string, string>;
}

interface ApplyResult extends LinkPlan {
  linesLinked: number;
  holdsRecorded: number;
  heldLines: number;
  runId: string;
}

const errorText = (e: unknown) => (e instanceof Error ? e.message : 'The request failed.');

/** When the held receipts were last recorded: the summary's own figure, or why it cannot be read. */
function LastRecord() {
  const snapshot = useQuery({
    queryKey: ['purchase-orders', 'receipt-evidence', 'summary', 'all'],
    queryFn: () => api.get<ReceiptEvidenceSummary>('/purchase-orders/receipt-evidence/summary'),
  });
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

function PlanView({ plan, onDownload, onApply }: { plan: LinkPlan; onDownload: () => void; onApply: () => void }) {
  const t = plan.totals;
  const reasons = Object.entries(t.byReason).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const statuses = [...new Set([...Object.keys(plan.poStatusCounts.before), ...Object.keys(plan.poStatusCounts.after)])].sort();
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
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [applied, setApplied] = useState<ApplyResult | null>(null);

  const dry = useMutation({
    mutationFn: () => api.post<LinkPlan>(LINK, {}),
    onSuccess: () => setApplied(null),
  });
  const apply = useMutation({
    mutationFn: (expectedHash: string) => api.post<ApplyResult>(LINK, { dryRun: false, confirm: phrase, expectedHash }),
    onSuccess: (res) => {
      setApplied(res);
      setConfirmOpen(false);
      setPhrase('');
      // The plan is spent: a further apply needs a fresh dry run.
      dry.reset();
      void qc.invalidateQueries({ queryKey: ['purchase-orders'] });
      void qc.invalidateQueries({ queryKey: ['purchase-order'] });
    },
  });
  const plan = dry.data;
  // 409: the tab, the ERP or the review choices changed after the dry run; nothing was written.
  const changed = apply.error instanceof ApiError && apply.error.status === 409;

  const download = () => {
    if (!plan) return;
    const stamp = new Date().toISOString().slice(0, 10);
    saveBlob(new Blob([heldListCsv(plan.held, plan.reasonText ?? {})], { type: 'text/csv;charset=utf-8' }), `held-store-receipts-${stamp}.csv`);
  };
  const closeConfirm = () => {
    if (apply.isPending) return;
    setConfirmOpen(false);
    setPhrase('');
    apply.reset();
  };

  return (
    <Card id="link-store-grns" style={{ marginTop: 'var(--sp-4)' }}>
      <CardHeader
        icon={<Link2 size={15} />}
        title="Link store GRNs to purchase orders"
        subtitle="Super Admin only. Links a store receipt to its PO line only on unambiguous GRN-tab evidence; every other line is held with its reason."
        actions={
          <Button variant="secondary" size="sm" icon={<Play size={13} />} loading={dry.isPending} onClick={() => dry.mutate()}>
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
        <div style={{ marginTop: 'var(--space-2)', fontSize: 'var(--fs-13)' }}><LastRecord /></div>

        {dry.isPending && <div style={{ marginTop: 'var(--space-3)' }}><Skeleton w="60%" h={14} /><Skeleton w="90%" h={10} /></div>}
        {dry.error && (
          <div style={{ marginTop: 'var(--space-3)' }}>
            <Banner tone="danger" action={<Button size="sm" variant="secondary" onClick={() => dry.mutate()}>Try again</Button>}>
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
        {plan && <PlanView plan={plan} onDownload={download} onApply={() => { apply.reset(); setConfirmOpen(true); }} />}
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
                disabled={phrase !== PHRASE || changed}
                onClick={() => apply.mutate(plan.selectionHash)}
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
            <div>Take a verified backup first (Admin &gt; Backup).</div>
            {apply.error && (
              <Banner
                tone="danger"
                action={changed ? (
                  <Button size="sm" variant="secondary" icon={<RotateCcw size={13} />} onClick={() => { closeConfirm(); dry.mutate(); }}>
                    Run the dry run again
                  </Button>
                ) : undefined}
              >
                {changed
                  ? <>The GRN tab or the ERP changed after this dry run, so nothing was linked. Run the dry run again and review it. <span className="cell-muted">{errorText(apply.error)}</span></>
                  : <>Nothing was linked: {errorText(apply.error)}</>}
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
