/**
 * Page header — one contract for every screen (redesign spec §3.3).
 *
 *   [breadcrumb]                                         [Last updated · chip]
 *   [H1]  [status]                 [secondary] [secondary] [More ▾] [PRIMARY]
 *   [meta line: supplier · date · lines]
 *
 * The contract is enforced here rather than left to each page: at most one
 * filled (primary) button; at most two secondary buttons, the rest fold into
 * the "More" menu; destructive actions (reject, cancel, short-close, delete,
 * unapprove) always go to the menu, in the danger tone. v2 accepted any
 * `actions` node, so PO detail carried seven header buttons and indent detail
 * a green and a red button with no primary at all (audit UI-013). `actions`
 * still works for pages that have not moved to the props yet.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ChevronRight, Clock3 } from 'lucide-react';
import { Button, OverflowMenu, type MenuAction } from '../components/ui';
import { relativeTime } from '../lib/format';

export interface PageAction {
  key?: string;
  label: string;
  /** Run on click. */
  onClick?: () => void;
  /** Or navigate to this in-app path. */
  to?: string;
  icon?: ReactNode;
  disabled?: boolean;
  loading?: boolean;
  /** Reject, cancel, delete…: rendered in the More menu, in the danger tone. */
  destructive?: boolean;
  /** Tooltip, e.g. why it is disabled. */
  title?: string;
}

export interface Crumb { label: string; to?: string }

const MAX_SECONDARY = 2;

export function PageHeader({
  title, subtitle, breadcrumbs, actions, freshness,
  status, meta, primaryAction, secondaryActions, overflowActions, condensed,
}: {
  title: ReactNode;
  /** One line under the title. */
  subtitle?: ReactNode;
  breadcrumbs?: Crumb[];
  /** v2 free-form actions; prefer primaryAction / secondaryActions / overflowActions. */
  actions?: ReactNode;
  /** ISO timestamp — rendered as "Last updated …" (SRS §38, §44). */
  freshness?: string | null;
  /** Status badge(s) beside the title. */
  status?: ReactNode;
  /** Meta line: supplier · date · lines. */
  meta?: ReactNode;
  /** The ONE filled action. On a pending document that is Approve. */
  primaryAction?: PageAction | null;
  /** Up to two outline actions; extras fold into More. */
  secondaryActions?: (PageAction | null | false | undefined)[];
  /** Everything else (print, export, PDF, destructive actions). */
  overflowActions?: (PageAction | null | false | undefined)[];
  /** Keep a condensed title + primary action strip in view on long pages. */
  condensed?: boolean;
}) {
  const navigate = useNavigate();
  const run = (a: PageAction) => (a.onClick ? a.onClick() : a.to ? navigate(a.to) : undefined);

  const secondary = (secondaryActions ?? []).filter((a): a is PageAction => Boolean(a));
  const overflow = (overflowActions ?? []).filter((a): a is PageAction => Boolean(a));
  const primary = primaryAction && !primaryAction.destructive ? primaryAction : null;

  const inline = secondary.filter((a) => !a.destructive).slice(0, MAX_SECONDARY);
  const folded = [
    ...secondary.filter((a) => !a.destructive).slice(MAX_SECONDARY),
    ...overflow.filter((a) => !a.destructive),
    ...(primaryAction?.destructive ? [primaryAction] : []),
    ...secondary.filter((a) => a.destructive),
    ...overflow.filter((a) => a.destructive),
  ];
  const menuItems: MenuAction[] = folded.map((a, i) => ({
    key: a.key ?? `${a.label}-${i}`,
    label: a.loading ? `${a.label}…` : a.label,
    icon: a.icon,
    onClick: () => run(a),
    disabled: a.disabled || a.loading,
    destructive: a.destructive,
    title: a.title,
    // A rule between the ordinary and the destructive actions.
    separatorBefore: Boolean(a.destructive) && i > 0 && !folded[i - 1]!.destructive,
  }));

  const renderButton = (a: PageAction, variant: 'primary' | 'secondary') => (
    <Button
      key={a.key ?? a.label}
      variant={variant}
      size="sm"
      icon={a.icon}
      onClick={() => run(a)}
      disabled={a.disabled}
      loading={a.loading}
      title={a.title}
    >
      {a.label}
    </Button>
  );

  // Condensed strip: shown once the full header has scrolled under the top bar.
  const sentinelRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    if (!condensed) return;
    const el = sentinelRef.current;
    if (!el) return;
    const topbar = parseInt(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h'), 10) || 56;
    const io = new IntersectionObserver(([entry]) => setStuck(!entry!.isIntersecting && entry!.boundingClientRect.top < topbar), {
      rootMargin: `-${topbar}px 0px 0px 0px`,
    });
    io.observe(el);
    return () => io.disconnect();
  }, [condensed]);

  const hasActions = Boolean(primary || inline.length || menuItems.length || actions);

  return (
    <header className="page-header">
      {((breadcrumbs && breadcrumbs.length > 0) || freshness) && (
        <div className="page-header-top">
          {breadcrumbs && breadcrumbs.length > 0 && (
            <nav aria-label="Breadcrumb" className="breadcrumbs no-print">
              {breadcrumbs.map((b, i) => {
                const last = i === breadcrumbs.length - 1;
                return (
                  <span key={i} className="row" style={{ gap: 4 }}>
                    {i > 0 && <ChevronRight size={12} style={{ color: 'var(--text-4)' }} aria-hidden />}
                    {b.to && !last ? (
                      <Link to={b.to}>{b.label}</Link>
                    ) : (
                      <span aria-current={last ? 'page' : undefined}>{b.label}</span>
                    )}
                  </span>
                );
              })}
            </nav>
          )}
          <span className="spacer" />
          {freshness && (
            <span className="freshness-chip no-print">
              <Clock3 size={12} aria-hidden />
              Last updated {relativeTime(freshness)}
            </span>
          )}
        </div>
      )}

      <div className="page-header-main">
        <div className="page-title-block">
          <div className="page-title-row">
            <h1 className="page-title">{title}</h1>
            {status}
          </div>
          {subtitle && <p className="page-subtitle">{subtitle}</p>}
          {meta && <div className="page-meta">{meta}</div>}
        </div>
        {hasActions && (
          <div className="page-actions no-print">
            {inline.map((a) => renderButton(a, 'secondary'))}
            {actions}
            {menuItems.length > 0 && <OverflowMenu triggerLabel="More" variant="secondary" items={menuItems} />}
            {primary && renderButton(primary, 'primary')}
          </div>
        )}
      </div>

      {condensed && <div ref={sentinelRef} aria-hidden style={{ height: 1 }} />}
      {condensed && stuck && (
        <div className="page-header-condensed no-print">
          <span className="page-title truncate">{title}</span>
          {status}
          <span className="spacer" />
          {primary && renderButton(primary, 'primary')}
        </div>
      )}
    </header>
  );
}
