/**
 * Home — "My Work".
 *
 * The first screen after sign-in. It answers three questions and nothing else:
 *   • What work is waiting?         — one card per kind of pending work
 *   • What should I do now?         — each card names its action
 *   • What happens when I press it? — it opens that exact list, already filtered
 *
 * Every number is a live count from the SAME endpoint the list behind the card
 * uses, so a card can never disagree with the list it opens. Nothing here is
 * hard-coded or sampled, and a card whose count cannot be loaded says so
 * instead of showing a zero. A user only sees the cards their permissions
 * allow — the server enforces the same permissions on every list regardless.
 *
 * The analytical dashboard is unchanged and still available as Management
 * Analysis; this page does not replace it.
 */
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, PackageCheck, ShoppingCart, Truck, RefreshCw } from 'lucide-react';
import { api, qs, type PageMeta } from '../lib/api';
import { useAuth } from '../lib/auth';
import { PageHeader } from '../layout/AppShell';
import { Button } from '../components/ui';
import { WorkCard, ChoiceCards, type Choice } from '../components/simple';

/** How long a count may be shown before it is fetched again. */
const FRESH_MS = 20_000;

/** Total of a paged list — read from the list endpoint's own meta. */
function useListTotal(key: string, path: string, enabled: boolean) {
  return useQuery({
    queryKey: ['home-work', key],
    queryFn: async () => (await api.getWithMeta<unknown[], PageMeta>(path)).meta.total,
    enabled,
    staleTime: FRESH_MS,
    refetchInterval: 60_000,
  });
}

interface WorkDef {
  key: string;
  show: boolean;
  title: string;
  hint: string;
  action: string;
  accent: string;
  to: string;
  count: { data?: number; isLoading: boolean; isError: boolean };
}

export default function Home() {
  const navigate = useNavigate();
  const { user, can } = useAuth();

  const reqApprove = useListTotal('req-approve', `/requisitions${qs({ view: 'hod-pending', pageSize: 1 })}`, can('requisition.approve'));
  const reqIssue = useListTotal('req-issue', `/requisitions${qs({ view: 'store-queue', pageSize: 1 })}`, can('requisition.issue'));
  const indentApprove = useListTotal('indent-approve', `/indents${qs({ status: 'PENDING_APPROVAL', pageSize: 1 })}`, can('indent.approve'));
  const readyForPo = useListTotal('ready-for-po', `/indents/eligible-lines${qs({ pageSize: 1 })}`, can('po.create'));
  const poDraft = useListTotal('po-draft', `/purchase-orders${qs({ status: 'DRAFT', pageSize: 1 })}`, can('po.view'));
  const poPending = useListTotal('po-pending', `/purchase-orders${qs({ view: 'pending', pageSize: 1 })}`, can('po.view'));
  const grnDraft = useListTotal('grn-draft', `/grn${qs({ status: 'DRAFT', pageSize: 1 })}`, can('grn.view'));
  const poDone = useListTotal('po-done', `/purchase-orders${qs({ view: 'complete', pageSize: 1 })}`, can('po.view'));
  const grnDone = useListTotal('grn-done', `/grn${qs({ status: 'POSTED', pageSize: 1 })}`, can('grn.view'));

  // Material pending to receive is counted in purchase orders, because that is
  // how the store thinks about it ("which PO has come?"), from the same
  // endpoint the Pending Receipt list and the Receive Material item list use.
  const toReceive = useQuery({
    queryKey: ['home-work', 'to-receive'],
    queryFn: async () => {
      const rows = await api.get<{ po_id: number }[]>(`/grn/po-items${qs({ view: 'pending', limit: 500 })}`);
      return new Set(rows.map((r) => r.po_id)).size;
    },
    enabled: can('grn.create'),
    staleTime: FRESH_MS,
    refetchInterval: 60_000,
  });

  const waiting: WorkDef[] = [
    {
      key: 'req-approve', show: can('requisition.approve'), count: reqApprove,
      title: 'Requisitions Waiting for Approval',
      hint: 'Material requests that need your approval.',
      action: 'Approve', accent: 'var(--module-requisition)', to: '/requisitions/hod-queue',
    },
    {
      key: 'req-issue', show: can('requisition.issue'), count: reqIssue,
      title: 'Material to Issue',
      hint: 'Approved requisitions waiting for the store to issue material.',
      action: 'Issue Material', accent: 'var(--module-requisition)', to: '/requisitions/store-queue',
    },
    {
      key: 'indent-approve', show: can('indent.approve'), count: indentApprove,
      title: 'Indents Waiting for Approval',
      hint: 'Purchase indents that need approval before they can be ordered.',
      action: 'Approve', accent: 'var(--module-indent)', to: '/indents?status=PENDING_APPROVAL',
    },
    {
      key: 'ready-for-po', show: can('po.create'), count: readyForPo,
      title: 'Indents Ready for PO',
      hint: 'Approved indent items that do not have a purchase order yet.',
      action: 'Create PO', accent: 'var(--module-po)', to: '/purchase-orders/awaiting',
    },
    {
      key: 'po-draft', show: can('po.view'), count: poDraft,
      title: 'Draft POs (Not Issued)',
      hint: 'Purchase orders that are saved but not yet issued to the supplier.',
      action: 'Open', accent: 'var(--module-po)', to: '/purchase-orders?status=DRAFT',
    },
    {
      key: 'po-pending', show: can('po.view'), count: poPending,
      title: 'PO Pending',
      hint: 'Issued purchase orders where material has not fully come.',
      action: 'Open', accent: 'var(--module-po)', to: '/purchase-orders/pending',
    },
    {
      key: 'to-receive', show: can('grn.create'), count: toReceive,
      title: 'Material Pending to Receive',
      hint: 'Purchase orders waiting for material. Press when material arrives.',
      action: 'Receive Material', accent: 'var(--module-grn)', to: '/grn/pending',
    },
    {
      key: 'grn-draft', show: can('grn.view'), count: grnDraft,
      title: 'GRNs Pending (Draft)',
      hint: 'Receipts that are saved but not yet posted. Stock changes only after posting.',
      action: 'Open', accent: 'var(--module-grn)', to: '/grn?status=DRAFT',
    },
  ].filter((w) => w.show);

  const done: WorkDef[] = [
    {
      key: 'po-done', show: can('po.view'), count: poDone,
      title: 'Completed POs', hint: 'Purchase orders that are fully received or closed.',
      action: 'View', accent: 'var(--success-500)', to: '/purchase-orders/complete',
    },
    {
      key: 'grn-done', show: can('grn.view'), count: grnDone,
      title: 'Posted GRNs', hint: 'Receipts that are posted and added to stock.',
      action: 'View', accent: 'var(--success-500)', to: '/grn?status=POSTED',
    },
  ].filter((w) => w.show);

  const start: (Choice & { to: string; show: boolean })[] = [
    {
      key: 'req', show: can('requisition.create'), to: '/requisitions/new',
      title: 'Create Requisition', text: 'Ask the store for material you need for your work.',
      icon: <PackageCheck size={28} />, go: 'Create',
    },
    {
      key: 'indent', show: can('indent.create'), to: '/indents/new',
      title: 'Create Indent', text: 'Ask the purchase team to buy material.',
      icon: <FileText size={28} />, go: 'Create',
    },
    {
      key: 'po', show: can('po.create'), to: '/purchase-orders/new',
      title: 'Create Purchase Order', text: 'Order material from a supplier — from an indent, or directly.',
      icon: <ShoppingCart size={28} />, go: 'Create',
    },
    {
      key: 'grn', show: can('grn.create'), to: '/grn/new',
      title: 'Receive Material', text: 'Enter material that has arrived at the store.',
      icon: <Truck size={28} />, go: 'Receive',
    },
  ].filter((s) => s.show);

  const all = [reqApprove, reqIssue, indentApprove, readyForPo, poDraft, poPending, grnDraft, poDone, grnDone, toReceive];
  const refreshing = all.some((q) => q.isFetching);
  const refresh = () => { for (const q of all) void q.refetch(); };

  const section = (title: string, cards: WorkDef[]): ReactNode => cards.length > 0 && (
    <>
      <h2 className="work-section-title">{title}</h2>
      <div className="work-grid">
        {cards.map((w) => (
          <WorkCard
            key={w.key} title={w.title} hint={w.hint} action={w.action} accent={w.accent}
            count={w.count.data ?? null} loading={w.count.isLoading} failed={w.count.isError}
            onClick={() => navigate(w.to)}
          />
        ))}
      </div>
    </>
  );

  return (
    <>
      <PageHeader
        title={`Welcome${user?.employeeName ? `, ${user.employeeName}` : ''}`}
        subtitle="This is your work for today. Press a card to open it."
        actions={
          <Button variant="secondary" size="sm" icon={<RefreshCw size={13} />} loading={refreshing} onClick={refresh}>
            Refresh
          </Button>
        }
      />

      {section('Work waiting', waiting)}

      {start.length > 0 && (
        <>
          <h2 className="work-section-title">Start new work</h2>
          <ChoiceCards choices={start} onChoose={(k) => { const s = start.find((x) => x.key === k); if (s) navigate(s.to); }} />
        </>
      )}

      {section('Completed', done)}

      {waiting.length === 0 && start.length === 0 && done.length === 0 && (
        <div className="card" style={{ padding: 'var(--sp-8)', textAlign: 'center', color: 'var(--text-muted)' }}>
          You do not have any work screens yet. Please ask your administrator to give you access.
        </div>
      )}
    </>
  );
}
