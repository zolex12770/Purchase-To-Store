/**
 * Application shell (SRS §4, §15, §29).
 *
 * Sidebar · top header · breadcrumbs · page header · content area.
 * The header carries the Zolex brand, global search, the Google Sheets Live Sync
 * toggle, notifications and the user menu, exactly as §29 of the brief requires.
 */
import { useState, useEffect, useRef, type ReactNode } from 'react';
import { NavLink, useNavigate, useLocation, Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  LayoutDashboard, Database, FileText, ShoppingCart, Truck, Shield,
  Search, Bell, ChevronDown, ChevronRight, LogOut, User as UserIcon, KeyRound,
  PanelLeftClose, PanelLeft, RefreshCw, Package, Building2, Tags, Users as UsersIcon,
  ScrollText, HardDriveDownload, ArrowLeftRight, Settings, CircleAlert, Zap, X,
  Sun, Moon, MonitorCog, Tag, ClipboardList, PackageSearch, PackageCheck, ListChecks, Home,
  ShieldCheck, Boxes,
} from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useTheme, type ThemePreference } from '../lib/theme';
import { useToast } from '../components/Toast';
import { api } from '../lib/api';
import { useSettings } from '../lib/masters';
import { Badge, Button } from '../components/ui';
import { initials, relativeTime } from '../lib/format';

/* ── Navigation model ────────────────────────────────────────────────────── */

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: string;
  /** When set, the entry shows for a holder of ANY of these rights (takes the place of `permission`). */
  anyOf?: string[];
  end?: boolean;
  /** Module signature colour; tints the icon and the active rail. */
  accent?: string;
}
interface NavGroup {
  label: string;
  icon: ReactNode;
  base: string;
  permission?: string;
  accent?: string;
  items: NavItem[];
}

/** Whether a menu entry is shown to this user. Must agree with the route guards in App.tsx. */
const navAllowed = (item: { permission?: string; anyOf?: string[] }, can: (p: string) => boolean): boolean =>
  item.anyOf ? item.anyOf.some((p) => can(p)) : !item.permission || can(item.permission);

/** Analysis screens open for the module's own "analyze" right or the dashboard-wide one — the analytics API's rule. */
const analysisRights = (module: string) => ({ permission: `${module}.analyze`, anyOf: [`${module}.analyze`, 'dashboard.analyze'] });

const NAV: (NavItem | NavGroup)[] = [
  // Everyone's landing page: the work that is waiting for them. No permission —
  // it shows only the cards the signed-in user is allowed to act on.
  { to: '/home', label: 'My Work', icon: <Home size={17} />, end: true, accent: 'var(--module-dashboard)' },
  {
    to: '/dashboard', label: 'Management Analysis', icon: <LayoutDashboard size={17} />,
    permission: 'dashboard.view', end: true, accent: 'var(--module-dashboard)',
  },
  {
    label: 'Master', icon: <Database size={17} />, base: '/masters', permission: 'item.view', accent: 'var(--module-master)',
    items: [
      { to: '/masters/suppliers', label: 'Supplier Master', icon: <Building2 size={15} />, permission: 'supplier.view' },
      { to: '/masters/items', label: 'Item Master', icon: <Package size={15} />, permission: 'item.view' },
      { to: '/masters/lookups', label: 'Supporting Masters', icon: <Tags size={15} />, permission: 'lookup.view' },
      { to: '/masters/stock-reconciliation', label: 'Stock Reconciliation', icon: <ListChecks size={15} />, permission: 'item.view' },
    ],
  },
  {
    label: 'Purchase Indent', icon: <FileText size={17} />, base: '/indents', permission: 'indent.view', accent: 'var(--module-indent)',
    items: [
      { to: '/indents', label: 'All Indents', icon: <FileText size={15} />, permission: 'indent.view', end: true },
      { to: '/indents/analysis', label: 'Analysis', icon: <LayoutDashboard size={15} />, ...analysisRights('indent') },
    ],
  },
  {
    label: 'Purchase Order', icon: <ShoppingCart size={17} />, base: '/purchase-orders', permission: 'po.view', accent: 'var(--module-po)',
    items: [
      { to: '/purchase-orders', label: 'All Purchase Orders', icon: <ShoppingCart size={15} />, permission: 'po.view', end: true },
      { to: '/purchase-orders/awaiting', label: 'Indents Ready for PO', icon: <ClipboardList size={15} />, permission: 'po.create' },
      { to: '/purchase-orders/pending', label: 'PO Pending', icon: <CircleAlert size={15} />, permission: 'po.view' },
      { to: '/purchase-orders/complete', label: 'Completed PO', icon: <Package size={15} />, permission: 'po.view' },
      { to: '/purchase-orders/analysis', label: 'Analysis', icon: <LayoutDashboard size={15} />, ...analysisRights('po') },
    ],
  },
  {
    label: 'GRN', icon: <Truck size={17} />, base: '/grn', permission: 'grn.view', accent: 'var(--module-grn)',
    items: [
      { to: '/grn', label: 'All GRNs', icon: <Truck size={15} />, permission: 'grn.view', end: true },
      { to: '/grn/pending', label: 'Material Pending to Receive', icon: <PackageSearch size={15} />, permission: 'grn.create' },
      { to: '/grn/labels', label: 'Labels', icon: <Tag size={15} />, permission: 'grn.view' },
      { to: '/grn/analysis', label: 'Analysis', icon: <LayoutDashboard size={15} />, ...analysisRights('grn') },
    ],
  },
  {
    label: 'Quality Control', icon: <ShieldCheck size={17} />, base: '/qc', permission: 'qc.view', accent: 'var(--module-grn)',
    items: [
      { to: '/qc', label: 'QC Inspections', icon: <ShieldCheck size={15} />, permission: 'qc.view', end: true },
    ],
  },
  {
    label: 'Requisition', icon: <PackageCheck size={17} />, base: '/requisitions', permission: 'requisition.view', accent: 'var(--module-requisition)',
    items: [
      { to: '/requisitions', label: 'All Requisitions', icon: <PackageCheck size={15} />, permission: 'requisition.view', end: true },
      { to: '/requisitions/mine', label: 'My Requisitions', icon: <FileText size={15} />, permission: 'requisition.view' },
      { to: '/requisitions/hod-queue', label: 'Waiting for Approval', icon: <ListChecks size={15} />, permission: 'requisition.approve' },
      { to: '/requisitions/store-queue', label: 'Material to Issue', icon: <PackageSearch size={15} />, permission: 'requisition.issue' },
      { to: '/requisitions/analysis', label: 'Analysis', icon: <LayoutDashboard size={15} />, ...analysisRights('requisition') },
    ],
  },
  {
    label: 'Inventory & Stock', icon: <Boxes size={17} />, base: '/inventory', permission: 'auto_indent.view', accent: 'var(--module-master)',
    items: [
      { to: '/inventory?tab=stock', label: 'Stock & Reorder Status', icon: <Package size={15} />, permission: 'auto_indent.view' },
      { to: '/inventory?tab=auto-indent', label: 'Auto Indent Queue', icon: <Zap size={15} />, permission: 'auto_indent.view' },
    ],
  },
  {
    label: 'Admin', icon: <Shield size={17} />, base: '/admin', permission: 'user.view', accent: 'var(--module-admin)',
    items: [
      { to: '/admin/users', label: 'User Management', icon: <UsersIcon size={15} />, permission: 'user.view' },
      { to: '/admin/roles', label: 'Roles & Permissions', icon: <Shield size={15} />, permission: 'role.view' },
      { to: '/admin/import-export', label: 'Import / Export', icon: <ArrowLeftRight size={15} />, permission: 'item.view' },
      { to: '/admin/sync', label: 'Google Sheets Sync', icon: <RefreshCw size={15} />, permission: 'sync.view' },
      { to: '/admin/backup', label: 'Backup & Restore', icon: <HardDriveDownload size={15} />, permission: 'backup.view' },
      { to: '/admin/audit', label: 'Audit Log', icon: <ScrollText size={15} />, permission: 'audit.view' },
      { to: '/admin/settings', label: 'Settings', icon: <Settings size={15} />, permission: 'system.admin' },
    ],
  },
];

const isGroup = (n: NavItem | NavGroup): n is NavGroup => 'items' in n;

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

/* ── Shell ───────────────────────────────────────────────────────────────── */

export function AppShell({ children }: { children: ReactNode }) {
  const { user, can, signOut } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [userCollapsed, setCollapsed] = useState(() => localStorage.getItem('zx.sidebar') === 'collapsed');

  // Below this width the full sidebar squeezes the content area enough to force
  // horizontal scrolling, so it collapses to the icon rail automatically (SRS §15
  // — responsive for desktop and tablet).
  const narrow = useMediaQuery('(max-width: 1100px)');
  const collapsed = userCollapsed || narrow;
  const [open, setOpen] = useState<Record<string, boolean>>(() => {
    const state: Record<string, boolean> = {};
    for (const n of NAV) if (isGroup(n)) state[n.base] = location.pathname.startsWith(n.base);
    return state;
  });

  useEffect(() => {
    localStorage.setItem('zx.sidebar', userCollapsed ? 'collapsed' : 'expanded');
  }, [userCollapsed]);

  // Keep the group containing the current route open.
  useEffect(() => {
    setOpen((prev) => {
      const next = { ...prev };
      for (const n of NAV) if (isGroup(n) && location.pathname.startsWith(n.base)) next[n.base] = true;
      return next;
    });
  }, [location.pathname]);

  const visibleNav = NAV.filter((n) => {
    if (isGroup(n)) return n.items.some((i) => navAllowed(i, can));
    return navAllowed(n, can);
  });

  return (
    <div style={{ minHeight: '100vh' }}>
      {/* ── Sidebar ─────────────────────────────────────────────────────── */}
      <aside
        className="sidebar no-print"
        style={{
          position: 'fixed', top: 0, left: 0, bottom: 0,
          width: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
          background: 'var(--grad-brand-deep)',
          display: 'flex', flexDirection: 'column',
          zIndex: 'var(--z-sticky)' as unknown as number,
          transition: 'width var(--dur) var(--ease)',
          borderRight: '1px solid rgba(255,255,255,0.07)',
        }}
      >
        <div
          className="row"
          style={{ height: 'var(--topbar-h)', padding: collapsed ? '0 14px' : '0 var(--sp-4)', gap: 10, flexShrink: 0, borderBottom: '1px solid rgba(255,255,255,0.08)' }}
        >
          <Link to="/home" className="row" style={{ gap: 10, textDecoration: 'none', minWidth: 0 }}>
            <span
              style={{
                width: 30, height: 30, borderRadius: 8, flexShrink: 0,
                background: 'var(--grad-accent)', display: 'grid', placeItems: 'center',
                boxShadow: '0 2px 8px rgba(217,122,40,0.4)',
              }}
            >
              <Zap size={17} color="#fff" strokeWidth={2.5} />
            </span>
            {!collapsed && (
              <span style={{ minWidth: 0 }}>
                <div style={{ color: '#fff', fontWeight: 700, fontSize: 'var(--text-md)', letterSpacing: '0.08em', lineHeight: 1 }}>
                  ZOLEX
                </div>
                <div className="truncate" style={{ color: 'rgba(255,255,255,0.55)', fontSize: '10px', letterSpacing: '0.03em', marginTop: 2 }}>
                  Purchase-to-Store ERP
                </div>
              </span>
            )}
          </Link>
        </div>

        <nav style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden', padding: 'var(--sp-3) var(--sp-2)' }}>
          {visibleNav.map((n) =>
            isGroup(n) ? (
              <SidebarGroup
                key={n.base}
                group={n}
                collapsed={collapsed}
                open={open[n.base] ?? false}
                onToggle={() => setOpen((p) => ({ ...p, [n.base]: !p[n.base] }))}
                can={can}
              />
            ) : (
              <SidebarLink key={n.to} item={n} collapsed={collapsed} />
            ),
          )}
        </nav>

        {!narrow && (
        <div style={{ padding: 'var(--sp-2)', borderTop: '1px solid rgba(255,255,255,0.08)' }}>
          <button
            onClick={() => setCollapsed((v) => !v)}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, width: '100%',
              padding: '8px 12px', borderRadius: 'var(--radius-sm)',
              color: 'rgba(255,255,255,0.6)', fontSize: 'var(--text-xs)',
              transition: 'background var(--dur-fast) var(--ease)',
            }}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'rgba(255,255,255,0.08)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          >
            {collapsed ? <PanelLeft size={16} /> : <PanelLeftClose size={16} />}
            {!collapsed && 'Collapse'}
          </button>
        </div>
        )}
      </aside>

      {/* ── Main ────────────────────────────────────────────────────────── */}
      <div
        className="app-main"
        style={{
          marginLeft: collapsed ? 'var(--sidebar-w-collapsed)' : 'var(--sidebar-w)',
          transition: 'margin-left var(--dur) var(--ease)',
          minHeight: '100vh', display: 'flex', flexDirection: 'column',
        }}
      >
        <TopBar user={user} onSignOut={async () => { await signOut(); navigate('/login'); }} />
        <main style={{ flex: 1, padding: 'var(--sp-5)', maxWidth: 'var(--content-max)', width: '100%' }}>
          {children}
        </main>
      </div>
    </div>
  );
}

/** Idle and active surfaces for a nav row, kept in one place so hover handlers
 *  and the style callback can never disagree about what "active" looks like. */
const NAV_IDLE = 'transparent';
const NAV_HOVER = 'rgba(255,255,255,0.09)';
const NAV_ACTIVE = 'linear-gradient(100deg, rgba(255,255,255,0.20), rgba(255,255,255,0.08))';

function SidebarLink({ item, collapsed, nested }: { item: NavItem; collapsed: boolean; nested?: boolean }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      style={({ isActive }) => ({
        display: 'flex', alignItems: 'center', gap: 10,
        padding: nested ? '7px 12px 7px 34px' : '9px 12px',
        borderRadius: 'var(--radius-sm)',
        color: isActive ? '#fff' : 'rgba(255,255,255,0.68)',
        background: isActive ? NAV_ACTIVE : NAV_IDLE,
        fontSize: nested ? 'var(--text-xs)' : 'var(--text-sm)',
        fontWeight: isActive ? 600 : 400,
        textDecoration: 'none',
        marginBottom: 2,
        transition: 'background var(--dur-fast) var(--ease), color var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)',
        position: 'relative',
        justifyContent: collapsed && !nested ? 'center' : undefined,
        // The active rail is tinted with the module's own accent, so the
        // current area is identifiable from peripheral vision alone.
        boxShadow: isActive && !nested
          ? `inset 3px 0 0 ${item.accent ?? 'var(--accent-500)'}, 0 2px 12px rgba(0,0,0,0.20)`
          : undefined,
      })}
      onMouseEnter={(e) => {
        if (e.currentTarget.getAttribute('aria-current') !== 'page') e.currentTarget.style.background = NAV_HOVER;
      }}
      onMouseLeave={(e) => {
        const active = e.currentTarget.getAttribute('aria-current') === 'page';
        e.currentTarget.style.background = active ? NAV_ACTIVE : NAV_IDLE;
      }}
    >
      <span
        style={{
          flexShrink: 0, display: 'grid', placeItems: 'center',
          color: item.accent ?? 'inherit', opacity: item.accent ? 0.95 : 1,
        }}
      >
        {item.icon}
      </span>
      {(!collapsed || nested) && <span className="truncate">{item.label}</span>}
    </NavLink>
  );
}

function SidebarGroup({
  group, collapsed, open, onToggle, can,
}: {
  group: NavGroup; collapsed: boolean; open: boolean;
  onToggle: () => void; can: (p: string) => boolean;
}) {
  const location = useLocation();
  // Every hook runs before the early return below. Calling useNavigate() after
  // it meant this component ran a different NUMBER of hooks depending on the
  // signed-in user's permissions, which React resolves by tearing down and
  // remounting — or by throwing "rendered fewer hooks than expected" when a
  // permission changes mid-session.
  const navigate = useNavigate();
  const active = location.pathname.startsWith(group.base);
  const items = group.items.filter((i) => navAllowed(i, can));
  if (items.length === 0) return null;

  return (
    <div style={{ marginBottom: 2 }}>
      <button
        onClick={() => {
          // Collapsed rail: clicking the group jumps to its first screen.
          if (collapsed) navigate(items[0]!.to);
          else onToggle();
        }}
        title={collapsed ? group.label : undefined}
        style={{
          display: 'flex', alignItems: 'center', gap: 10, width: '100%',
          padding: '9px 12px', borderRadius: 'var(--radius-sm)',
          color: active ? '#fff' : 'rgba(255,255,255,0.68)',
          background: active && !open ? NAV_ACTIVE : NAV_IDLE,
          fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400,
          justifyContent: collapsed ? 'center' : undefined,
          transition: 'background var(--dur-fast) var(--ease), box-shadow var(--dur-fast) var(--ease)',
          boxShadow: active && !open
            ? `inset 3px 0 0 ${group.accent ?? 'var(--accent-500)'}, 0 2px 12px rgba(0,0,0,0.20)`
            : undefined,
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = NAV_HOVER; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = active && !open ? NAV_ACTIVE : NAV_IDLE; }}
        aria-expanded={open}
      >
        <span
          style={{
            flexShrink: 0, display: 'grid', placeItems: 'center',
            color: group.accent ?? 'inherit',
            // Dim the accent when the area is idle so only the current module sings.
            opacity: active ? 1 : 0.78,
            transition: 'opacity var(--dur-fast) var(--ease)',
          }}
        >
          {group.icon}
        </span>
        {!collapsed && (
          <>
            <span className="grow truncate" style={{ textAlign: 'left' }}>{group.label}</span>
            <ChevronRight
              size={13}
              style={{ transform: open ? 'rotate(90deg)' : 'none', transition: 'transform var(--dur-fast) var(--ease)', opacity: 0.6 }}
            />
          </>
        )}
      </button>
      {!collapsed && open && (
        <div style={{ animation: 'zx-rise var(--dur-fast) var(--ease-out)' }}>
          {items.map((i) => (
            <SidebarLink key={i.to} item={{ ...i, accent: i.accent ?? group.accent }} collapsed={false} nested />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Theme toggle ────────────────────────────────────────────────────────── */

/**
 * Light / dark switch (SRS §15).
 *
 * Cycles light → dark → follow-system, so a user can always get back to "match
 * my OS" without hunting for a settings screen. The label announces the state
 * rather than the action, which is what screen readers need here.
 */
function ThemeToggle() {
  const { preference, resolved, setPreference } = useTheme();

  const next: ThemePreference =
    preference === 'light' ? 'dark' : preference === 'dark' ? 'system' : 'light';

  const label =
    preference === 'system' ? `Theme: follow system (${resolved})` : `Theme: ${preference}`;

  return (
    <button
      onClick={() => setPreference(next)}
      title={`${label} — click for ${next === 'system' ? 'system' : next}`}
      aria-label={label}
      className="btn btn-ghost btn-icon btn-sm"
      style={{ position: 'relative', overflow: 'hidden' }}
    >
      {preference === 'system'
        ? <MonitorCog size={16} />
        : resolved === 'dark'
          ? <Moon size={16} />
          : <Sun size={16} />}
    </button>
  );
}

/* ── Top bar ─────────────────────────────────────────────────────────────── */

function TopBar({ user, onSignOut }: { user: ReturnType<typeof useAuth>['user']; onSignOut: () => void }) {
  const { can } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();

  return (
    <header
      className="topbar no-print"
      style={{
        position: 'sticky', top: 0, zIndex: 'var(--z-sticky)' as unknown as number,
        height: 'var(--topbar-h)', flexShrink: 0,
        // Glass tokens rather than a literal white, so the bar reads correctly
        // in both themes instead of staying light on a dark page.
        background: 'var(--glass-bg)',
        backdropFilter: 'var(--glass-blur)',
        WebkitBackdropFilter: 'var(--glass-blur)',
        borderBottom: '1px solid var(--border)',
        display: 'flex', alignItems: 'center', gap: 'var(--sp-3)',
        padding: '0 var(--sp-5)',
      }}
    >
      <GlobalSearch />
      <div className="spacer" />
      {can('sync.view') && <SyncToggle />}
      <ThemeToggle />
      <NotificationBell />
      <div className="divider-v" style={{ height: 26 }} />

      <div style={{ position: 'relative' }}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="row"
          style={{ gap: 8, padding: '5px 8px', borderRadius: 'var(--radius-sm)', transition: 'background var(--dur-fast) var(--ease)' }}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink-100)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
        >
          <span
            style={{
              width: 30, height: 30, borderRadius: '50%', flexShrink: 0,
              background: 'var(--grad-brand)', color: '#fff',
              display: 'grid', placeItems: 'center',
              fontSize: 'var(--text-xs)', fontWeight: 700,
            }}
          >
            {initials(user?.employeeName ?? '?')}
          </span>
          <span style={{ textAlign: 'left', minWidth: 0 }}>
            <div className="truncate" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-800)', maxWidth: 150 }}>
              {user?.employeeName}
            </div>
            <div className="truncate" style={{ fontSize: '10px', color: 'var(--text-muted)', maxWidth: 150 }}>
              {user?.designation || user?.roles?.[0]?.replace(/_/g, ' ')}
            </div>
          </span>
          <ChevronDown size={13} style={{ color: 'var(--ink-400)', flexShrink: 0 }} />
        </button>

        {menuOpen && (
          <>
            <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setMenuOpen(false)} />
            <div
              role="menu"
              style={{
                position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 100,
                width: 250, background: 'var(--bg-surface)',
                border: '1px solid var(--border-strong)', borderRadius: 'var(--radius)',
                boxShadow: 'var(--shadow-lg)', overflow: 'hidden',
                animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
              }}
            >
              <div style={{ padding: 'var(--sp-3) var(--sp-4)', background: 'var(--bg-inset)', borderBottom: '1px solid var(--border-subtle)' }}>
                <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>{user?.employeeName}</div>
                <div className="mono" style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 1 }}>
                  ID {user?.employeeId}
                </div>
                <div className="row" style={{ gap: 4, marginTop: 6, flexWrap: 'wrap' }}>
                  {(user?.roles ?? []).map((r) => (
                    <Badge key={r} tone="info" plain>{r.replace(/_/g, ' ')}</Badge>
                  ))}
                </div>
              </div>
              <MenuItem icon={<UserIcon size={14} />} onClick={() => { setMenuOpen(false); navigate('/profile'); }}>
                My profile
              </MenuItem>
              <MenuItem icon={<KeyRound size={14} />} onClick={() => { setMenuOpen(false); navigate('/profile?tab=password'); }}>
                Change password
              </MenuItem>
              <div className="divider" />
              <MenuItem icon={<LogOut size={14} />} danger onClick={() => { setMenuOpen(false); onSignOut(); }}>
                Sign out
              </MenuItem>
            </div>
          </>
        )}
      </div>
    </header>
  );
}

function MenuItem({
  icon, children, onClick, danger,
}: { icon: ReactNode; children: ReactNode; onClick: () => void; danger?: boolean }) {
  return (
    <button
      role="menuitem"
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 10, width: '100%',
        padding: '9px var(--sp-4)', fontSize: 'var(--text-sm)',
        color: danger ? 'var(--danger-600)' : 'var(--ink-700)',
        transition: 'background var(--dur-fast) var(--ease)',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = danger ? 'var(--danger-50)' : 'var(--ink-50)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {icon}{children}
    </button>
  );
}

/* ── Global search (SRS §30 of the brief) ────────────────────────────────── */

interface SearchGroup {
  entity: string;
  label: string;
  results: { id: string; title: string; subtitle: string; meta?: string; route: string }[];
}

function GlobalSearch() {
  const [term, setTerm] = useState('');
  const [debounced, setDebounced] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

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
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const go = (route: string) => {
    navigate(route);
    setOpen(false);
    setTerm('');
  };

  return (
    <div ref={boxRef} style={{ position: 'relative', flex: '0 1 420px', minWidth: 200 }}>
      <Search size={14} aria-hidden style={{ position: 'absolute', left: 11, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', pointerEvents: 'none' }} />
      <input
        ref={inputRef}
        className="input"
        style={{ paddingLeft: 33, paddingRight: 52, height: 34, background: 'var(--bg-inset)' }}
        placeholder="Search items, suppliers, indents, POs, GRNs…"
        value={term}
        onChange={(e) => { setTerm(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        aria-label="Global search"
      />
      {term ? (
        <button
          onClick={() => { setTerm(''); inputRef.current?.focus(); }}
          aria-label="Clear"
          style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-400)', display: 'grid', placeItems: 'center' }}
        >
          <X size={13} />
        </button>
      ) : (
        <span className="kbd" style={{ position: 'absolute', right: 9, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
          Ctrl K
        </span>
      )}

      {open && debounced.length >= 2 && (
        <div
          style={{
            position: 'absolute', top: 'calc(100% + 6px)', left: 0, right: 0,
            background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-xl)',
            maxHeight: 460, overflowY: 'auto', zIndex: 200,
            animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
          }}
        >
          {isFetching && (
            <div style={{ padding: 'var(--sp-4)', textAlign: 'center', fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>
              Searching…
            </div>
          )}
          {!isFetching && (data?.totalResults ?? 0) === 0 && (
            <div style={{ padding: 'var(--sp-5)', textAlign: 'center' }}>
              <div style={{ fontSize: 'var(--text-sm)', color: 'var(--ink-600)', fontWeight: 500 }}>No matches for “{debounced}”</div>
              <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-faint)', marginTop: 3 }}>
                Try an item code, supplier name, or document number.
              </div>
            </div>
          )}
          {data?.groups.map((g) => (
            <div key={g.entity}>
              <div
                style={{
                  padding: '6px var(--sp-4)', background: 'var(--bg-inset)',
                  fontSize: '10px', fontWeight: 700, textTransform: 'uppercase',
                  letterSpacing: '0.06em', color: 'var(--text-faint)',
                  borderBottom: '1px solid var(--border-subtle)',
                  position: 'sticky', top: 0,
                }}
              >
                {g.label}
              </div>
              {g.results.map((r) => (
                <button
                  key={`${g.entity}-${r.id}`}
                  onClick={() => go(r.route)}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: '8px var(--sp-4)', borderBottom: '1px solid var(--border-subtle)',
                    transition: 'background var(--dur-fast) var(--ease)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--brand-50)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div className="row" style={{ gap: 8 }}>
                    <span className="truncate grow" style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--ink-800)' }}>
                      {r.title}
                    </span>
                    {r.meta && <span style={{ fontSize: '10px', color: 'var(--text-faint)', flexShrink: 0 }}>{r.meta}</span>}
                  </div>
                  <div className="truncate" style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)' }}>{r.subtitle}</div>
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Google Sheets Live Sync toggle (SRS §8) ─────────────────────────────── */

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

function SyncToggle() {
  const { can } = useAuth();
  const toast = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['sync', 'status'],
    queryFn: () => api.get<SyncStatus>('/google-sync/status'),
    refetchInterval: 60_000,
  });

  const toggle = useMutation({
    mutationFn: (enabled: boolean) => api.post<{ message: string }>('/google-sync/toggle', { enabled }),
    onSuccess: (res) => {
      toast.success('Live Sync updated', res.message);
      void qc.invalidateQueries({ queryKey: ['sync'] });
    },
    onError: (e) => toast.fromError(e),
  });

  if (!data) return null;

  const on = data.enabled;
  const canToggle = can('sync.admin');
  const problem = !data.configured;

  return (
    <div
      className="row"
      style={{
        gap: 8, padding: '5px 10px', borderRadius: 'var(--radius-full)',
        background: on ? 'var(--success-50)' : 'var(--ink-50)',
        border: `1px solid ${on ? 'var(--success-100)' : 'var(--border)'}`,
      }}
      title={
        problem
          ? (data.notConfiguredReason ?? 'Google Sheets is not configured.')
          : on
            ? 'Google Sheets Live Sync is ON. SQL remains the system of record.'
            : 'Google Sheets Live Sync is OFF. The ERP runs from its own database.'
      }
    >
      <RefreshCw
        size={13}
        style={{
          color: problem ? 'var(--warning-600)' : on ? 'var(--success-600)' : 'var(--ink-400)',
          animation: data.running ? 'zx-spin 1.2s linear infinite' : undefined,
          flexShrink: 0,
        }}
      />
      <span style={{ fontSize: '10px', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', color: on ? 'var(--success-700)' : 'var(--text-muted)', whiteSpace: 'nowrap' }}>
        Live Sync
      </span>

      <button
        role="switch"
        aria-checked={on}
        aria-label="Toggle Google Sheets Live Sync"
        disabled={!canToggle || toggle.isPending}
        onClick={() => canToggle && toggle.mutate(!on)}
        style={{
          width: 32, height: 17, borderRadius: 'var(--radius-full)', flexShrink: 0,
          background: on ? 'var(--success-500)' : 'var(--ink-300)',
          position: 'relative', transition: 'background var(--dur) var(--ease)',
          cursor: canToggle ? 'pointer' : 'not-allowed', opacity: canToggle ? 1 : 0.6,
        }}
      >
        <span
          style={{
            position: 'absolute', top: 2, left: on ? 17 : 2,
            width: 13, height: 13, borderRadius: '50%', background: '#fff',
            transition: 'left var(--dur) var(--ease-spring)',
            boxShadow: '0 1px 3px rgba(0,0,0,0.25)',
          }}
        />
      </button>

      {(problem || data.unresolvedConflicts > 0) && (
        <button
          onClick={() => navigate('/admin/sync')}
          title={problem ? 'Sync is not configured — open settings' : `${data.unresolvedConflicts} unresolved conflict(s)`}
          style={{ display: 'grid', placeItems: 'center', color: 'var(--warning-600)', flexShrink: 0 }}
        >
          <CircleAlert size={13} />
        </button>
      )}
    </div>
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

function NotificationBell() {
  const { can } = useAuth();
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();

  const { data } = useQuery({
    queryKey: ['analytics', 'exceptions', 'bell'],
    queryFn: () => api.get<ExceptionRow[]>('/analytics/exceptions'),
    enabled: can('dashboard.analyze'),
    refetchInterval: 120_000,
    staleTime: 60_000,
  });

  const alerts = (data ?? []).filter((e) => e.count > 0);
  const urgent = alerts.filter((e) => e.severity === 'high').length;

  if (!can('dashboard.analyze')) return null;

  return (
    <div style={{ position: 'relative' }}>
      <Button variant="ghost" size="sm" onClick={() => setOpen((v) => !v)} aria-label="Notifications">
        <span style={{ position: 'relative', display: 'grid', placeItems: 'center' }}>
          <Bell size={16} />
          {alerts.length > 0 && (
            <span
              style={{
                position: 'absolute', top: -4, right: -5,
                minWidth: 15, height: 15, padding: '0 3px',
                borderRadius: 'var(--radius-full)',
                background: urgent > 0 ? 'var(--danger-500)' : 'var(--warning-500)',
                color: '#fff', fontSize: '9px', fontWeight: 700,
                display: 'grid', placeItems: 'center',
                border: '1.5px solid var(--bg-surface)',
              }}
            >
              {alerts.length}
            </span>
          )}
        </span>
      </Button>

      {open && (
        <>
          <div style={{ position: 'fixed', inset: 0, zIndex: 90 }} onClick={() => setOpen(false)} />
          <div
            style={{
              position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 100,
              width: 340, maxHeight: 440, overflowY: 'auto',
              background: 'var(--bg-surface)', border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius)', boxShadow: 'var(--shadow-lg)',
              animation: 'zx-scale-in var(--dur-fast) var(--ease-out)',
            }}
          >
            <div style={{ padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border-subtle)', background: 'var(--bg-inset)' }}>
              <div style={{ fontSize: 'var(--text-sm)', fontWeight: 600 }}>Attention required</div>
              <div style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-muted)', marginTop: 1 }}>
                Operational exceptions across procurement
              </div>
            </div>
            {alerts.length === 0 ? (
              <div style={{ padding: 'var(--sp-6)', textAlign: 'center', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                Nothing needs attention right now.
              </div>
            ) : (
              alerts.map((a) => (
                <button
                  key={a.key}
                  onClick={() => { navigate(a.drilldown); setOpen(false); }}
                  style={{
                    display: 'block', width: '100%', textAlign: 'left',
                    padding: 'var(--sp-3) var(--sp-4)', borderBottom: '1px solid var(--border-subtle)',
                    transition: 'background var(--dur-fast) var(--ease)',
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--ink-50)'; }}
                  onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
                >
                  <div className="row" style={{ gap: 8 }}>
                    <span
                      style={{
                        width: 6, height: 6, borderRadius: '50%', flexShrink: 0,
                        background: a.severity === 'high' ? 'var(--danger-500)' : a.severity === 'medium' ? 'var(--warning-500)' : 'var(--info-500)',
                      }}
                    />
                    <span className="grow truncate" style={{ fontSize: 'var(--text-xs)', fontWeight: 600, color: 'var(--ink-800)' }}>
                      {a.label}
                    </span>
                    <span className="num" style={{ fontSize: 'var(--text-xs)', fontWeight: 700, color: 'var(--ink-900)' }}>{a.count}</span>
                  </div>
                  <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 }}>{a.description}</div>
                </button>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Page scaffolding ────────────────────────────────────────────────────── */

export function PageHeader({
  title, subtitle, breadcrumbs, actions, freshness,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  breadcrumbs?: { label: string; to?: string }[];
  actions?: ReactNode;
  /** ISO timestamp — rendered as "Last updated …" (SRS §38, §44). */
  freshness?: string | null;
}) {
  return (
    <div style={{ marginBottom: 'var(--sp-5)' }}>
      {breadcrumbs && breadcrumbs.length > 0 && (
        <nav className="row no-print" aria-label="Breadcrumb" style={{ gap: 5, marginBottom: 6, flexWrap: 'wrap' }}>
          {breadcrumbs.map((b, i) => (
            <span key={i} className="row" style={{ gap: 5 }}>
              {i > 0 && <ChevronRight size={11} style={{ color: 'var(--ink-300)' }} aria-hidden />}
              {b.to ? (
                <Link to={b.to} style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', textDecoration: 'none' }}>
                  {b.label}
                </Link>
              ) : (
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--ink-700)', fontWeight: 500 }}>{b.label}</span>
              )}
            </span>
          ))}
        </nav>
      )}
      <div className="row" style={{ gap: 'var(--sp-4)', flexWrap: 'wrap' }}>
        <div className="grow" style={{ minWidth: 220 }}>
          <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--ink-900)', letterSpacing: '-0.02em' }}>
            {title}
          </h1>
          {subtitle && (
            <p style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', marginTop: 3 }}>{subtitle}</p>
          )}
        </div>
        <div className="row no-print" style={{ gap: 'var(--sp-2)', flexWrap: 'wrap' }}>
          {freshness && (
            <span style={{ fontSize: 'var(--text-2xs)', color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
              Last updated {relativeTime(freshness)}
            </span>
          )}
          {actions}
        </div>
      </div>
    </div>
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
        <div style={{ textAlign: 'right', fontSize: 10 }}>
          <div style={{ fontSize: 13, fontWeight: 600 }}>{title}</div>
          <div>Generated: {new Date().toLocaleString('en-IN')}</div>
        </div>
      </div>
      {filterContext && (
        <div style={{ fontSize: 10, marginTop: 5, fontStyle: 'italic' }}>Filters — {filterContext}</div>
      )}
    </div>
  );
}
