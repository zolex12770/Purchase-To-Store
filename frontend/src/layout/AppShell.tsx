/**
 * Application shell (SRS §4, §15, §29; redesign spec §3.1–§3.2).
 *
 * Ink sidebar · glass top bar · content area. The top bar carries global
 * search, a read-only data-sync status chip, notifications and the user menu
 * (profile, password, theme, sign out).
 *
 * Product decisions (16 Oct 2026): every sidebar route and URL stays; the
 * sidebar may be relabelled and regrouped. The Live Sync on/off switch left
 * the top bar — a global switch one click from the theme toggle on every page
 * was too easy to hit — and lives behind a confirmation in Admin › Google
 * Sheets sync; the top bar only reports the sync state.
 */
import { useState, useEffect, useLayoutEffect, useMemo, useRef, useId, type CSSProperties, type ReactNode } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  LayoutDashboard, Database, FileText, ShoppingCart, Truck, Shield,
  Search, Bell, ChevronDown, ChevronRight, LogOut, User as UserIcon, KeyRound,
  PanelLeftClose, PanelLeft, RefreshCw, Package, Building2, Tags, Users as UsersIcon,
  ScrollText, HardDriveDownload, ArrowLeftRight, Settings, CircleAlert, Zap, X,
  Tag, ClipboardList, PackageSearch, PackageCheck, ListChecks, Home, ShieldCheck,
  Boxes, PackageMinus, History, ClipboardCheck, Layers, BarChart3, Sun, Moon, Monitor,
  Factory, Warehouse, Wrench,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme, type ThemePreference } from '../lib/theme';
import { api } from '../lib/api';
import { useSettings } from '../lib/masters';
import {
  Button, IconButton, MenuList, Popover, Segmented, StatusBadge, Tooltip, menuKeyNav, useMenuAutofocus,
  type MenuAction,
} from '../components/ui';
import { initials, relativeTime } from '../lib/format';
import { LiveDataVerifyModal } from '../components/LiveDataVerifyModal';

export { PageHeader } from './PageHeader';
export type { PageAction, Crumb } from './PageHeader';

/* ── Navigation model ────────────────────────────────────────────────────── */

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: string;
  /** Shown to a holder of ANY of these rights (takes the place of `permission`). */
  anyOf?: string[];
  /** Sub-heading inside a long group (inventory). */
  section?: string;
}
interface NavLeaf extends NavItem {
  /** Module identity hue for the icon tile. */
  hue: string;
}
interface NavGroup {
  label: string;
  icon: ReactNode;
  base: string;
  hue: string;
  items: NavItem[];
}
type NavEntry = NavLeaf | NavGroup;

/** Whether a menu entry is shown to this user. Must agree with the route guards in App.tsx. */
const navAllowed = (item: { permission?: string; anyOf?: string[] }, can: (p: string) => boolean): boolean =>
  item.anyOf ? item.anyOf.some((p) => can(p)) : !item.permission || can(item.permission);

/** Analysis screens open for the module's own "analyze" right or the dashboard-wide one — the analytics API's rule. */
const analysisRights = (module: string) => ({ permission: `${module}.analyze`, anyOf: [`${module}.analyze`, 'dashboard.analyze'] });

const INVENTORY_VIEW = ['inventory.view', 'auto_indent.view'];

/*
 * Labels are sentence case and unique: the four children that were all called
 * "Analysis" now say whose analysis they are (audit UI-031). Every URL is the
 * one the sidebar always used.
 */
const NAV: NavEntry[] = [
  // Everyone's landing page: the work waiting for them. No permission — it
  // shows only the cards the signed-in user may act on.
  { to: '/home', label: 'My work', icon: <Home size={16} />, hue: 'var(--module-dashboard)' },
  { to: '/dashboard', label: 'Management analysis', icon: <LayoutDashboard size={16} />, permission: 'dashboard.view', hue: 'var(--module-dashboard)' },
  {
    label: 'Masters', icon: <Database size={16} />, base: '/masters', hue: 'var(--module-master)',
    items: [
      { to: '/masters/suppliers', label: 'Suppliers', icon: <Building2 size={14} />, permission: 'supplier.view' },
      { to: '/masters/items', label: 'Items', icon: <Package size={14} />, permission: 'item.view' },
      { to: '/masters/lookups', label: 'Supporting masters', icon: <Tags size={14} />, permission: 'lookup.view' },
      { to: '/masters/stock-reconciliation', label: 'Stock reconciliation', icon: <ListChecks size={14} />, permission: 'item.view' },
    ],
  },
  {
    label: 'Purchase indent', icon: <FileText size={16} />, base: '/indents', hue: 'var(--module-indent)',
    items: [
      { to: '/indents', label: 'All indents', icon: <FileText size={14} />, permission: 'indent.view' },
      { to: '/indents/analysis', label: 'Indent analysis', icon: <BarChart3 size={14} />, ...analysisRights('indent') },
    ],
  },
  {
    label: 'Purchase order', icon: <ShoppingCart size={16} />, base: '/purchase-orders', hue: 'var(--module-po)',
    items: [
      { to: '/purchase-orders', label: 'All purchase orders', icon: <ShoppingCart size={14} />, permission: 'po.view' },
      { to: '/purchase-orders/awaiting', label: 'Indents ready for PO', icon: <ClipboardList size={14} />, permission: 'po.create' },
      { to: '/purchase-orders/pending', label: 'Open POs', icon: <CircleAlert size={14} />, permission: 'po.view' },
      { to: '/purchase-orders/complete', label: 'Completed POs', icon: <PackageCheck size={14} />, permission: 'po.view' },
      { to: '/purchase-orders/analysis', label: 'PO analysis', icon: <BarChart3 size={14} />, ...analysisRights('po') },
    ],
  },
  {
    label: 'Goods receipt', icon: <Truck size={16} />, base: '/grn', hue: 'var(--module-grn)',
    items: [
      { to: '/grn', label: 'All GRNs', icon: <Truck size={14} />, permission: 'grn.view' },
      { to: '/grn/pending', label: 'Material to receive', icon: <PackageSearch size={14} />, permission: 'grn.create' },
      { to: '/grn/labels', label: 'Labels', icon: <Tag size={14} />, permission: 'grn.view' },
      { to: '/grn/analysis', label: 'GRN analysis', icon: <BarChart3 size={14} />, ...analysisRights('grn') },
    ],
  },
  // A group with one child is just a link.
  { to: '/qc', label: 'Quality control', icon: <ShieldCheck size={16} />, permission: 'qc.view', hue: 'var(--module-grn)' },
  {
    label: 'Requisition', icon: <PackageCheck size={16} />, base: '/requisitions', hue: 'var(--module-requisition)',
    items: [
      { to: '/requisitions', label: 'All requisitions', icon: <PackageCheck size={14} />, permission: 'requisition.view' },
      { to: '/requisitions/mine', label: 'My requisitions', icon: <FileText size={14} />, permission: 'requisition.view' },
      { to: '/requisitions/hod-queue', label: 'Waiting for my approval', icon: <ListChecks size={14} />, permission: 'requisition.approve' },
      { to: '/requisitions/store-queue', label: 'Material to issue', icon: <PackageSearch size={14} />, permission: 'requisition.issue' },
      { to: '/requisitions/analysis', label: 'Requisition analysis', icon: <BarChart3 size={14} />, ...analysisRights('requisition') },
    ],
  },
  {
    label: 'Inventory & stock', icon: <Boxes size={16} />, base: '/inventory', hue: 'var(--module-inventory)',
    items: [
      { to: '/inventory?tab=overview', label: 'Overview', icon: <LayoutDashboard size={14} />, anyOf: INVENTORY_VIEW },
      { to: '/inventory?tab=rm', label: 'Raw material (RM)', icon: <Layers size={14} />, anyOf: INVENTORY_VIEW, section: 'Stock by category' },
      { to: '/inventory?tab=fg', label: 'Finished goods (FG)', icon: <PackageCheck size={14} />, anyOf: INVENTORY_VIEW, section: 'Stock by category' },
      { to: '/inventory?tab=wip', label: 'Work in progress (WIP)', icon: <Factory size={14} />, anyOf: INVENTORY_VIEW, section: 'Stock by category' },
      { to: '/inventory?tab=trading', label: 'Trading materials', icon: <Tag size={14} />, anyOf: INVENTORY_VIEW, section: 'Stock by category' },
      { to: '/inventory?tab=general', label: 'General stores & spares', icon: <Wrench size={14} />, anyOf: INVENTORY_VIEW, section: 'Stock by category' },
      { to: '/inventory?tab=stock', label: 'Stock register', icon: <Warehouse size={14} />, anyOf: INVENTORY_VIEW, section: 'Registers' },
      { to: '/inventory?tab=ledger', label: 'Movement ledger', icon: <History size={14} />, anyOf: INVENTORY_VIEW, section: 'Registers' },
      { to: '/inventory?tab=adjustments', label: 'Count adjustments', icon: <ClipboardCheck size={14} />, anyOf: ['inventory.adjust', ...INVENTORY_VIEW], section: 'Registers' },
      { to: '/inventory?tab=requisition-queue', label: 'Requisition queue', icon: <PackageSearch size={14} />, anyOf: ['inventory.view', 'requisition.issue', 'auto_indent.view'], section: 'Store' },
      { to: '/inventory/direct-issue', label: 'Direct issue', icon: <PackageMinus size={14} />, permission: 'direct_issue.view', section: 'Store' },
      { to: '/inventory?tab=auto-indent', label: 'Auto-indent', icon: <Zap size={14} />, anyOf: ['auto_indent.view', 'inventory.view'], section: 'Store' },
    ],
  },
  {
    label: 'Admin', icon: <Shield size={16} />, base: '/admin', hue: 'var(--module-admin)',
    items: [
      { to: '/admin/users', label: 'Users', icon: <UsersIcon size={14} />, permission: 'user.view' },
      { to: '/admin/roles', label: 'Roles & permissions', icon: <Shield size={14} />, permission: 'role.view' },
      { to: '/admin/data-management', label: 'Data management & audit', icon: <Database size={14} />, anyOf: ['system.admin', 'user.admin', 'role.view'] },
      { to: '/admin/import-export', label: 'Import / export', icon: <ArrowLeftRight size={14} />, permission: 'item.view' },
      { to: '/admin/sync', label: 'Google Sheets sync', icon: <RefreshCw size={14} />, permission: 'sync.view' },
      { to: '/admin/backup', label: 'Backup & restore', icon: <HardDriveDownload size={14} />, permission: 'backup.view' },
      { to: '/admin/audit', label: 'Audit log', icon: <ScrollText size={14} />, permission: 'audit.view' },
      { to: '/admin/settings', label: 'Settings', icon: <Settings size={14} />, permission: 'system.admin' },
    ],
  },
];

const isGroup = (n: NavEntry): n is NavGroup => 'items' in n;

/**
 * How well a sidebar entry matches the current URL; 0 = not at all.
 *   • an entry with a query (`/inventory?tab=rm`) matches only its own tab —
 *     v2 used NavLink, which ignores the query, so all 11 inventory links
 *     carried aria-current on every inventory page (audit UI-012);
 *   • an exact path beats a parent path;
 *   • a parent path highlights its detail, new and edit pages
 *     (/purchase-orders/1119 → All purchase orders).
 */
function matchScore(to: string, pathname: string, search: string): number {
  const [path = '', query] = to.split('?');
  if (query) {
    if (pathname !== path) return 0;
    const have = new URLSearchParams(search);
    for (const [k, v] of new URLSearchParams(query)) {
      const actual = have.get(k) ?? (path === '/inventory' && k === 'tab' ? 'overview' : null);
      if (actual !== v) return 0;
    }
    return 2000 + path.length;
  }
  if (pathname === path) return 1000 + path.length;
  if (pathname.startsWith(`${path}/`)) return path.length;
  return 0;
}

interface ActiveNav { to: string | null; groupBase: string | null; section: string | null }

/** The ONE sidebar entry the current URL belongs to. */
function findActive(nav: NavEntry[], pathname: string, search: string): ActiveNav {
  let best = { score: 0, to: null as string | null, groupBase: null as string | null, section: null as string | null };
  for (const n of nav) {
    const candidates = isGroup(n) ? n.items : [n];
    for (const i of candidates) {
      const s = matchScore(i.to, pathname, search);
      if (s > best.score) best = { score: s, to: i.to, groupBase: isGroup(n) ? n.base : null, section: n.label };
    }
  }
  if (!best.to && pathname.startsWith('/profile')) best.section = 'My profile';
  return { to: best.to, groupBase: best.groupBase, section: best.section };
}

/** Subscribes to a CSS media query so layout can respond to the viewport. */
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== 'undefined' && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

const readPref = (key: string): string | null => { try { return localStorage.getItem(key); } catch { return null; } };
const writePref = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* blocked storage */ } };

/* ── Shell ───────────────────────────────────────────────────────────────── */

export function AppShell({ children }: { children: ReactNode }) {
  const { can, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [userCollapsed, setCollapsed] = useState(() => readPref('zx.sidebar') === 'collapsed');
  // Below 1280 px the full sidebar squeezes tables into sideways scrolling,
  // so it becomes the icon rail (v2 waited until 1100 px).
  const narrow = useMediaQuery('(max-width: 1279px)');
  const rail = userCollapsed || narrow;

  useEffect(() => { writePref('zx.sidebar', userCollapsed ? 'collapsed' : 'expanded'); }, [userCollapsed]);

  const visibleNav = useMemo(() => NAV
    .map((n) => (isGroup(n) ? { ...n, items: n.items.filter((i) => navAllowed(i, can)) } : n))
    .filter((n) => (isGroup(n) ? n.items.length > 0 : navAllowed(n, can))), [can]);

  const active = useMemo(
    () => findActive(visibleNav, location.pathname, location.search),
    [visibleNav, location.pathname, location.search],
  );

  // Accordion: one group open at a time; the current route's group opens on
  // navigation (v2 kept every group ever opened, pushing the active entry
  // below the fold).
  const [openGroup, setOpenGroup] = useState<string | null>(active.groupBase);
  useEffect(() => { if (active.groupBase) setOpenGroup(active.groupBase); }, [active.groupBase]);

  // Keep the active entry in view inside the sidebar's own scroll area.
  const navRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    const nav = navRef.current;
    const el = nav?.querySelector<HTMLElement>('[aria-current="page"]');
    if (!nav || !el) return;
    const top = el.offsetTop - nav.offsetTop;
    if (top < nav.scrollTop + 8) nav.scrollTop = Math.max(0, top - 48);
    else if (top + el.offsetHeight > nav.scrollTop + nav.clientHeight - 8) nav.scrollTop = top + el.offsetHeight - nav.clientHeight + 48;
  }, [active.to, openGroup, rail]);

  return (
    <div className="app-shell" style={{ minHeight: '100vh', ['--shell-offset' as string]: rail ? 'var(--sidebar-w-rail)' : 'var(--sidebar-w)' } as CSSProperties}>
      <a href="#main-content" className="skip-link">Skip to content</a>

      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className={`sidebar no-print ${rail ? 'is-rail' : ''}`}
        aria-label="Main navigation"
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0,
          width: 'var(--shell-offset)',
          display: 'flex', flexDirection: 'column',
          zIndex: 'var(--z-sidebar)' as unknown as number,
          transition: 'width var(--dur-3) var(--ease-standard)',
        }}
      >
        <Link to="/home" className="sidebar-brand" aria-label="ZOLEX home" style={rail ? { justifyContent: 'center', padding: 0 } : undefined}>
          <span className="brand-mark" aria-hidden><Zap size={17} strokeWidth={2.5} /></span>
          {!rail && (
            <span style={{ minWidth: 0 }}>
              <span className="brand-word" style={{ display: 'block' }}>ZOLEX</span>
              <span className="brand-tag truncate" style={{ display: 'block' }}>Purchase-to-store ERP</span>
            </span>
          )}
        </Link>

        <nav ref={navRef} className="sidebar-nav">
          {visibleNav.map((n) => (isGroup(n) ? (
            <SidebarGroup
              key={n.base}
              group={n}
              rail={rail}
              open={openGroup === n.base}
              activeTo={active.to}
              current={active.groupBase === n.base}
              onToggle={() => setOpenGroup((g) => (g === n.base ? null : n.base))}
              onRailClick={() => navigate(n.items.find((i) => i.to === active.to)?.to ?? n.items[0]!.to)}
            />
          ) : (
            <SidebarLink key={n.to} item={n} hue={n.hue} rail={rail} active={active.to === n.to} topLevel />
          )))}
        </nav>

        {!narrow && (
          <div className="sidebar-foot">
            <button
              type="button"
              className="nav-item"
              onClick={() => setCollapsed((v) => !v)}
              aria-label={rail ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-expanded={!rail}
              style={rail ? { justifyContent: 'center', padding: 0 } : undefined}
            >
              <span className="nav-icon-sm" aria-hidden>{rail ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}</span>
              {!rail && <span className="nav-label">Collapse</span>}
            </button>
          </div>
        )}
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <div
        className="app-main"
        style={{
          marginLeft: 'var(--shell-offset)',
          transition: 'margin-left var(--dur-3) var(--ease-standard)',
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <TopBar section={active.section} onSignOut={async () => { await signOut(); navigate('/login'); }} />
        <main id="main-content" className="app-content" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}

function SidebarLink({
  item, hue, rail, active, topLevel,
}: { item: NavItem; hue: string; rail: boolean; active: boolean; topLevel?: boolean }) {
  const link = (
    <Link
      to={item.to}
      className={`nav-item ${active ? 'is-active' : ''}`}
      aria-current={active ? 'page' : undefined}
      aria-label={rail ? item.label : undefined}
      style={{ ['--nav-hue' as string]: hue } as CSSProperties}
    >
      {topLevel
        ? <span className="nav-icon" aria-hidden>{item.icon}</span>
        : <span className="nav-icon-sm" aria-hidden>{item.icon}</span>}
      {!rail && <span className="nav-label">{item.label}</span>}
    </Link>
  );
  return rail ? <Tooltip content={item.label} block>{link}</Tooltip> : link;
}

function SidebarGroup({
  group, rail, open, activeTo, current, onToggle, onRailClick,
}: {
  group: NavGroup; rail: boolean; open: boolean; activeTo: string | null; current: boolean;
  onToggle: () => void; onRailClick: () => void;
}) {
  const panelId = useId();
  const hueStyle = { ['--nav-hue' as string]: group.hue } as CSSProperties;

  if (rail) {
    // The rail shows the group icon; it opens the group's current or first screen.
    return (
      <Tooltip content={group.label} block>
        <button
          type="button"
          className={`nav-group-btn ${current ? 'is-current is-collapsed' : ''}`}
          onClick={onRailClick}
          aria-label={group.label}
          aria-current={current ? 'true' : undefined}
          style={hueStyle}
        >
          <span className="nav-icon" aria-hidden>{group.icon}</span>
        </button>
      </Tooltip>
    );
  }

  let lastSection: string | undefined;
  return (
    <div style={{ marginBottom: 2 }}>
      <button
        type="button"
        className={`nav-group-btn ${current ? 'is-current' : ''} ${current && !open ? 'is-collapsed' : ''}`}
        onClick={onToggle}
        aria-expanded={open}
        aria-controls={panelId}
        style={hueStyle}
      >
        <span className="nav-icon" aria-hidden>{group.icon}</span>
        <span className="nav-label">{group.label}</span>
        <ChevronRight size={14} className="nav-chevron" aria-hidden />
      </button>
      {open && (
        <div id={panelId} className="nav-children" role="group" aria-label={group.label}>
          {group.items.map((i) => {
            const heading = i.section && i.section !== lastSection ? i.section : null;
            lastSection = i.section;
            return (
              <div key={i.to}>
                {heading && <div className="nav-subhead">{heading}</div>}
                <SidebarLink item={i} hue={group.hue} rail={false} active={activeTo === i.to} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ── Top bar ─────────────────────────────────────────────────────────────── */

function TopBar({ section, onSignOut }: { section: string | null; onSignOut: () => void }) {
  const { can } = useAuth();
  return (
    <header className="topbar no-print">
      {section && <span className="topbar-section">{section}</span>}
      <GlobalSearch />
      <div className="spacer" />
      {can('sync.view') && <SyncStatusChip />}
      <NotificationBell />
      <div className="divider-v" style={{ height: 24, alignSelf: 'center' }} />
      <UserMenu onSignOut={onSignOut} />
    </header>
  );
}

/* ── User menu: profile, password, theme, sign out ───────────────────────── */

const THEME_OPTIONS: { value: ThemePreference; label: ReactNode }[] = [
  { value: 'light', label: <><Sun size={13} aria-hidden /> Light</> },
  { value: 'dark', label: <><Moon size={13} aria-hidden /> Dark</> },
  { value: 'system', label: <><Monitor size={13} aria-hidden /> System</> },
];

function UserMenu({ onSignOut }: { onSignOut: () => void }) {
  const { user } = useAuth();
  const { preference, setPreference } = useTheme();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();
  const menuId = useId();
  useMenuAutofocus(open, menuId);

  const items: MenuAction[] = [
    { key: 'profile', label: 'My profile', icon: <UserIcon size={16} />, onClick: () => navigate('/profile') },
    // The state nonce makes App.tsx remount Profile, so the password tab opens
    // even when /profile is already on screen (Profile reads ?tab once, on
    // mount — audit UI-017).
    { key: 'password', label: 'Change password', icon: <KeyRound size={16} />, onClick: () => navigate('/profile?tab=password', { state: { profileTab: Date.now() } }) },
    { key: 'signout', label: 'Sign out', icon: <LogOut size={16} />, onClick: onSignOut, separatorBefore: true },
  ];

  const role = user?.designation || user?.roles?.[0]?.replace(/_/g, ' ').toLowerCase();

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="user-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={`Account menu for ${user?.employeeName ?? 'user'}`}
      >
        <span className="avatar" aria-hidden>{initials(user?.employeeName ?? '?')}</span>
        <span style={{ textAlign: 'left', minWidth: 0 }}>
          <span className="user-name truncate" style={{ display: 'block' }}>{user?.employeeName}</span>
          <span className="user-role truncate" style={{ display: 'block' }}>{role}</span>
        </span>
        <ChevronDown size={14} style={{ color: 'var(--text-3)' }} aria-hidden />
      </button>

      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end" minWidth={268}>
        <div className="user-menu-head">
          <div style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--text-1)' }}>{user?.employeeName}</div>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', marginTop: 1 }}>Employee ID {user?.employeeId}</div>
          {(user?.roles?.length ?? 0) > 0 && (
            <div className="row" style={{ gap: 4, marginTop: 8, flexWrap: 'wrap' }}>
              {(user?.roles ?? []).map((r) => (
                <span key={r} className="chip chip-neutral" style={{ textTransform: 'capitalize' }}>{r.replace(/_/g, ' ').toLowerCase()}</span>
              ))}
            </div>
          )}
        </div>
        <div className="user-menu-theme">
          <span style={{ fontSize: 'var(--fs-12)', fontWeight: 500, color: 'var(--text-2)' }}>Theme</span>
          <Segmented size="sm" ariaLabel="Theme" options={THEME_OPTIONS} value={preference} onChange={(v) => setPreference(v as ThemePreference)} />
        </div>
        <div
          id={menuId}
          role="menu"
          aria-label="Account"
          className="menu-list"
          onKeyDown={(e) => { menuKeyNav(e); if (e.key === 'Tab') setOpen(false); }}
        >
          <MenuList items={items} onAction={(a) => { setOpen(false); a.onClick?.(); }} />
        </div>
      </Popover>
    </>
  );
}

/* ── Global search (SRS §30) ─────────────────────────────────────────────── */

interface SearchGroup {
  entity: string;
  label: string;
  results: { id: string; title: string; subtitle: string; meta?: string; route: string }[];
}

function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  useEffect(() => {
    // Debounce so typing does not fire a request per keystroke (SRS §30).
    const t = setTimeout(() => setDebounced(term.trim()), 280);
    return () => clearTimeout(t);
  }, [term]);

  const { data, isFetching } = useQuery({
    queryKey: ['search', debounced],
    queryFn: () => api.get<{ groups: SearchGroup[]; totalResults: number }>(`/search?q=${encodeURIComponent(debounced)}`),
    enabled: debounced.length >= 2,
    staleTime: 30_000,
  });

  // Ctrl/Cmd+K focuses search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
        setOpen(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const groups = data?.groups ?? [];
  const flat = useMemo(() => groups.flatMap((g) => g.results), [groups]);
  useEffect(() => { setActiveIdx(0); }, [debounced]);

  const go = (route: string) => {
    navigate(route);
    setOpen(false);
    setTerm('');
    inputRef.current?.blur();
  };

  const showPanel = open && debounced.length >= 2;
  let offset = 0;

  return (
    <div ref={boxRef} className="search-box" role="search">
      <Search size={15} className="search-icon" aria-hidden />
      <input
        ref={inputRef}
        className="input"
        placeholder="Search items, suppliers, indents, POs, GRNs…"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (!showPanel || flat.length === 0) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, flat.length - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); const r = flat[activeIdx]; if (r) go(r.route); }
        }}
        role="combobox"
        aria-expanded={showPanel}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showPanel && flat[activeIdx] ? `${listId}-${activeIdx}` : undefined}
        aria-label="Global search"
      />
      {term ? (
        <button
          type="button"
          onClick={() => { setTerm(''); inputRef.current?.focus(); }}
          aria-label="Clear search"
          style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', display: 'grid', placeItems: 'center', width: 22, height: 22, borderRadius: 4 }}
        >
          <X size={14} />
        </button>
      ) : (
        <span className="kbd" style={{ position: 'absolute', right: 8, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          Ctrl K
        </span>
      )}

      <Popover anchorRef={boxRef} open={showPanel} onClose={() => setOpen(false)} matchAnchorWidth restoreFocus={false}>
        <div id={listId} role="listbox" aria-label="Search results">
          {isFetching && (
            <div style={{ padding: 'var(--space-4)', textAlign: 'center', fontSize: 'var(--fs-13)', color: 'var(--text-3)' }}>
              Searching…
            </div>
          )}
          {!isFetching && (data?.totalResults ?? 0) === 0 && (
            <div style={{ padding: 'var(--space-5)', textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--fs-14)', color: 'var(--text-1)', fontWeight: 500 }}>No matches for “{debounced}”</div>
              <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', marginTop: 3 }}>
                Try an item code, supplier name or document number.
              </div>
            </div>
          )}
          {groups.map((g) => {
            const start = offset;
            offset += g.results.length;
            return (
              <div key={g.entity} role="group" aria-label={g.label}>
                <div className="search-group-label">{g.label}</div>
                {g.results.map((r, j) => {
                  const idx = start + j;
                  return (
                    <button
                      key={`${g.entity}-${r.id}`}
                      id={`${listId}-${idx}`}
                      type="button"
                      role="option"
                      tabIndex={-1}
                      aria-selected={idx === activeIdx}
                      className={`search-result ${idx === activeIdx ? 'is-active' : ''}`}
                      onMouseEnter={() => setActiveIdx(idx)}
                      onClick={() => go(r.route)}
                    >
                      <div className="row" style={{ gap: 8 }}>
                        <span className="search-result-title truncate grow">{r.title}</span>
                        {r.meta && <span className="search-result-meta">{r.meta}</span>}
                      </div>
                      <div className="search-result-sub truncate">{r.subtitle}</div>
                    </button>
                  );
                })}
              </div>
            );
          })}
        </div>
      </Popover>
    </div>
  );
}

/* ── Data-sync status chip (read-only) ───────────────────────────────────── */

interface SyncStatus {
  enabled: boolean;
  running: boolean;
  configured: boolean;
  mode: string;
  notConfiguredReason: string | null;
  lastJob: { status: string; finished_at: string | null; rows_inserted: number; rows_updated: number; rows_rejected: number; conflicts: number } | null;
  unresolvedIssues: number;
  unresolvedConflicts: number;
}

type SyncTone = 'success' | 'attention' | 'danger' | 'neutral';

function syncState(data: SyncStatus | undefined, failed: boolean): { tone: SyncTone; label: string } {
  if (failed) return { tone: 'danger', label: 'Sync status unavailable' };
  if (!data) return { tone: 'neutral', label: 'Sync' };
  if (!data.configured) return { tone: 'attention', label: 'Sync not configured' };
  if (!data.enabled) return { tone: 'neutral', label: 'Sync off' };
  const last = data.lastJob?.status?.toUpperCase();
  if (last === 'FAILED' || last === 'ERROR') return { tone: 'danger', label: 'Sync failed' };
  if (data.running) return { tone: 'success', label: 'Syncing…' };
  if (data.unresolvedConflicts > 0) return { tone: 'attention', label: `Sync · ${data.unresolvedConflicts} conflict${data.unresolvedConflicts === 1 ? '' : 's'}` };
  return { tone: 'success', label: 'Sync on' };
}

function SyncStatusChip() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [verifyOpen, setVerifyOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const { data, isError } = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: () => api.get<SyncStatus>('/google-sync/status'),
    refetchInterval: 60_000,
  });
  const state = syncState(data, isError);
  const last = data?.lastJob ?? null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="sync-chip"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <span className={`sync-dot is-${state.tone}`} aria-hidden />
        <RefreshCw size={13} aria-hidden style={{ color: 'var(--text-3)', animation: data?.running ? 'zx-spin 1.2s linear infinite' : undefined }} />
        <span>{state.label}</span>
        <ChevronDown size={13} aria-hidden style={{ color: 'var(--text-3)' }} />
      </button>

      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end" minWidth={320} role="dialog" label="Google Sheets sync status">
        <div className="sync-pop">
          <div className="row" style={{ gap: 8 }}>
            <span className={`sync-dot is-${state.tone}`} aria-hidden />
            <span style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--text-1)' }}>Google Sheets sync</span>
          </div>
          <dl className="sync-facts">
            <dt>Live sync</dt>
            <dd>{data ? (data.enabled ? 'On' : 'Off') : '—'}</dd>
            <dt>Connection</dt>
            <dd>{data ? (data.configured ? `Configured${data.mode ? ` (${data.mode.toLowerCase()})` : ''}` : (data.notConfiguredReason ?? 'Not configured')) : '—'}</dd>
            <dt>Last run</dt>
            <dd>
              {last ? (
                <span className="row" style={{ gap: 6, flexWrap: 'wrap' }}>
                  <StatusBadge status={last.status} />
                  <span>{last.finished_at ? relativeTime(last.finished_at) : 'running'}</span>
                </span>
              ) : 'No run yet'}
            </dd>
            {last && (
              <>
                <dt>Rows</dt>
                <dd className="num">{last.rows_inserted} added · {last.rows_updated} updated · {last.rows_rejected} rejected</dd>
              </>
            )}
            <dt>Open items</dt>
            <dd className="num">{data ? `${data.unresolvedConflicts} conflicts · ${data.unresolvedIssues} issues` : '—'}</dd>
          </dl>
          <div className="row" style={{ gap: 8, justifyContent: 'flex-end' }}>
            <Button variant="ghost" size="sm" onClick={() => { setOpen(false); navigate('/admin/sync'); }}>Open sync admin</Button>
            <Button variant="secondary" size="sm" icon={<ShieldCheck size={14} />} onClick={() => { setOpen(false); setVerifyOpen(true); }}>Verify now</Button>
          </div>
          <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)' }}>
            The on/off switch is in Admin › Google Sheets sync.
          </div>
        </div>
      </Popover>
      <LiveDataVerifyModal open={verifyOpen} onClose={() => setVerifyOpen(false)} />
    </>
  );
}

/* ── Notifications: real operational signals, not decoration ─────────────── */

interface ExceptionRow {
  key: string;
  label: string;
  count: number;
  severity: string;
  description: string;
  drilldown: string;
}

const SEVERITY_DOT: Record<string, string> = {
  high: 'var(--tone-danger-solid)',
  medium: 'var(--tone-attention-solid)',
  low: 'var(--tone-info-solid)',
};

function NotificationBell() {
  const { can } = useAuth();
  const allowed = can('dashboard.analyze');
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['analytics', 'exceptions', 'bell'],
    queryFn: () => api.get<ExceptionRow[]>('/analytics/exceptions'),
    enabled: allowed,
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const alerts = (data ?? []).filter((e) => e.count > 0);
  if (!allowed) return null;

  return (
    <span style={{ position: 'relative', display: 'inline-flex' }}>
      <IconButton
        ref={triggerRef}
        label={alerts.length > 0 ? `Notifications: ${alerts.length} need attention` : 'Notifications'}
        icon={<Bell size={18} />}
        size="md"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="dialog"
        aria-expanded={open}
        tooltip={open ? false : 'Notifications'}
      />
      {alerts.length > 0 && <span className="count-badge" aria-hidden>{alerts.length}</span>}

      <Popover anchorRef={triggerRef} open={open} onClose={() => setOpen(false)} align="end" minWidth={340} role="dialog" label="Attention required">
        <div style={{ width: 340 }}>
          <div style={{ padding: 'var(--space-3) var(--space-4)', borderBottom: '1px solid var(--border-subtle)' }}>
            <div style={{ fontSize: 'var(--fs-14)', fontWeight: 600, color: 'var(--text-1)' }}>Attention required</div>
            <div style={{ fontSize: 'var(--fs-12)', color: 'var(--text-3)', marginTop: 1 }}>Operational exceptions across procurement</div>
          </div>
          {alerts.length === 0 ? (
            <div style={{ padding: 'var(--space-6)', textAlign: 'center', fontSize: 'var(--fs-13)', color: 'var(--text-3)' }}>
              Nothing needs attention right now.
            </div>
          ) : (
            alerts.map((a) => (
              <button
                key={a.key}
                type="button"
                className="notif-item"
                onClick={() => { setOpen(false); navigate(a.drilldown); }}
              >
                <span className="row" style={{ gap: 8 }}>
                  <span style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: SEVERITY_DOT[a.severity] ?? SEVERITY_DOT.low }} aria-hidden />
                  <span className="sr-only">{a.severity} severity:</span>
                  <span className="grow truncate" style={{ fontSize: 'var(--fs-13)', fontWeight: 600, color: 'var(--text-1)' }}>{a.label}</span>
                  <span className="num" style={{ fontSize: 'var(--fs-13)', fontWeight: 700, color: 'var(--text-1)' }}>{a.count}</span>
                </span>
                <span style={{ display: 'block', fontSize: 'var(--fs-12)', color: 'var(--text-3)', marginTop: 2, lineHeight: 1.4, paddingLeft: 16 }}>{a.description}</span>
              </button>
            ))
          )}
        </div>
      </Popover>
    </span>
  );
}

/** Branded header shown only when printing (SRS §35). */
export function PrintHeader({ title, filterContext }: { title: string; filterContext?: string }) {
  const { data: settings } = useSettings();
  return (
    <div className="print-only" style={{ marginBottom: 16, borderBottom: '2px solid #333', paddingBottom: 8 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: '0.08em' }}>
            {String(settings?.['company.brand'] ?? 'ZOLEX')}
          </div>
          <div style={{ fontSize: 11 }}>
            {String(settings?.['company.name'] ?? 'Zeeta Electrical Engineering Pvt. Ltd.')}
          </div>
        </div>
        <div style={{ textAlign: 'right', fontSize: 11 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <div>Generated: {new Date().toLocaleString('en-IN')}</div>
        </div>
      </div>
      {filterContext && (
        <div style={{ fontSize: 11, marginTop: 5, fontStyle: 'italic' }}>Filters — {filterContext}</div>
      )}
    </div>
  );
}
