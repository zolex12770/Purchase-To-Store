/**
 * The sidebar's navigation model and its active-entry rule, apart from the
 * shell so the rule is unit-tested (navModel.test.ts).
 */
import type { ReactNode } from 'react';
import {
  LayoutDashboard, Database, FileText, ShoppingCart, Truck, Shield, RefreshCw, Package, Building2, Tags,
  Users as UsersIcon, ScrollText, HardDriveDownload, ArrowLeftRight, Settings, CircleAlert, Zap, Tag,
  ClipboardList, PackageSearch, PackageCheck, ListChecks, Home, ShieldCheck, Boxes, PackageMinus, History,
  ClipboardCheck, Layers, BarChart3, Factory, Warehouse, Wrench,
} from 'lucide-react';

export interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
  permission?: string;
  /** Shown to a holder of ANY of these rights (takes the place of `permission`). */
  anyOf?: string[];
  /** Sub-heading inside a long group (inventory). */
  section?: string;
}
export interface NavLeaf extends NavItem {
  /** Module identity hue for the icon tile. */
  hue: string;
}
export interface NavGroup {
  label: string;
  icon: ReactNode;
  base: string;
  hue: string;
  items: NavItem[];
}
export type NavEntry = NavLeaf | NavGroup;

export const isGroup = (n: NavEntry): n is NavGroup => 'items' in n;

/** Whether a menu entry is shown to this user. Must agree with the route guards in App.tsx. */
export const navAllowed = (item: { permission?: string; anyOf?: string[] }, can: (p: string) => boolean): boolean =>
  item.anyOf ? item.anyOf.some((p) => can(p)) : !item.permission || can(item.permission);

/** Analysis screens open for the module's own "analyze" right or the dashboard-wide one — the analytics API's rule. */
const analysisRights = (module: string) => ({ permission: `${module}.analyze`, anyOf: [`${module}.analyze`, 'dashboard.analyze'] });

const INVENTORY_VIEW = ['inventory.view', 'auto_indent.view'];

/*
 * Labels are sentence case and unique: the four children that were all called
 * "Analysis" now say whose analysis they are (audit UI-031). Every URL is the
 * one the sidebar always used.
 */
export const NAV: NavEntry[] = [
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

/**
 * How well a sidebar entry matches the current URL; 0 = not at all.
 *   • an entry with a query (`/inventory?tab=rm`) matches only its own tab —
 *     v2 used NavLink, which ignores the query, so all 11 inventory links
 *     carried aria-current on every inventory page (audit UI-012);
 *   • an exact path beats a parent path;
 *   • a parent path highlights its detail, new and edit pages
 *     (/purchase-orders/1119 → All purchase orders).
 */
export function matchScore(to: string, pathname: string, search: string): number {
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

export interface ActiveNav { to: string | null; groupBase: string | null; section: string | null }

/** The ONE sidebar entry the current URL belongs to. */
export function findActive(nav: NavEntry[], pathname: string, search: string): ActiveNav {
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
