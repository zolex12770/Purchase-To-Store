import { describe, it, expect } from 'vitest';
import { NAV, SCREEN_ACCESS, findActive, isGroup, matchScore, navAllowed, type NavItem } from './navModel';

type Entry = NavItem & { group: string | null };
const entries: Entry[] = NAV.flatMap((n): Entry[] => (isGroup(n) ? n.items.map((i) => ({ ...i, group: n.base })) : [{ ...n, group: null }]));
const at = (url: string) => {
  const [pathname = '', search = ''] = url.split('?');
  return findActive(NAV, pathname, search ? `?${search}` : '');
};
/** Every entry that matches a URL as well as the active one does: there must be exactly one. */
const bestMatches = (url: string) => {
  const [pathname = '', search = ''] = url.split('?');
  const scores = entries.map((e) => matchScore(e.to, pathname, search ? `?${search}` : ''));
  const best = Math.max(...scores);
  return best === 0 ? [] : entries.filter((_, i) => scores[i] === best).map((e) => e.to);
};

describe('sidebar active entry', () => {
  it('gives every sidebar URL exactly one active entry: its own', () => {
    for (const e of entries) {
      expect(bestMatches(e.to), e.to).toEqual([e.to]);
      expect(at(e.to).to, e.to).toBe(e.to);
      expect(at(e.to).groupBase, e.to).toBe(e.group);
    }
  });

  it('labels are unique (the four "Analysis" entries were not, audit UI-031)', () => {
    const labels = entries.map((e) => e.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('highlights the parent list on detail, new and edit pages', () => {
    expect(at('/purchase-orders/1063').to).toBe('/purchase-orders');
    expect(at('/purchase-orders/1063/edit').to).toBe('/purchase-orders');
    expect(at('/indents/new').to).toBe('/indents');
    expect(at('/grn/7781').to).toBe('/grn');
    expect(at('/requisitions/2736').to).toBe('/requisitions');
    expect(at('/masters/items/55').to).toBe('/masters/items');
    expect(at('/admin/users/12').to).toBe('/admin/users');
  });

  it('prefers the exact sub-list over its parent list', () => {
    expect(at('/purchase-orders/pending').to).toBe('/purchase-orders/pending');
    expect(at('/purchase-orders/analysis').to).toBe('/purchase-orders/analysis');
    expect(at('/requisitions/hod-queue').to).toBe('/requisitions/hod-queue');
    expect(at('/grn/pending').to).toBe('/grn/pending');
  });

  // v2 NavLink ignored the query, so all 11 inventory links were active at once (audit UI-012).
  it('matches inventory entries by their tab, ignoring other parameters', () => {
    expect(at('/inventory?tab=stock&category=RM').to).toBe('/inventory?tab=stock');
    expect(bestMatches('/inventory?tab=stock&category=RM')).toEqual(['/inventory?tab=stock']);
    expect(at('/inventory?tab=rm').to).toBe('/inventory?tab=rm');
    expect(at('/inventory?tab=requisition-queue').groupBase).toBe('/inventory');
  });

  it('treats /inventory with no tab as the overview, and direct issue as its own entry', () => {
    expect(at('/inventory').to).toBe('/inventory?tab=overview');
    expect(at('/inventory/direct-issue').to).toBe('/inventory/direct-issue');
    expect(bestMatches('/inventory/direct-issue')).toEqual(['/inventory/direct-issue']);
  });

  it('has no active entry off the sidebar, but names the profile section', () => {
    expect(at('/profile')).toEqual({ to: null, groupBase: null, section: 'My profile' });
    expect(at('/no/such/page').to).toBeNull();
    expect(at('/inventory?tab=unknown').to).toBeNull();
  });
});

describe('navAllowed', () => {
  const can = (held: string[]) => (p: string) => held.includes(p);

  it('shows an entry with no permission to everyone', () => {
    expect(navAllowed({}, can([]))).toBe(true);
  });

  it('needs the one permission, or any one of anyOf', () => {
    expect(navAllowed({ permission: 'po.view' }, can(['po.view']))).toBe(true);
    expect(navAllowed({ permission: 'po.view' }, can(['grn.view']))).toBe(false);
    expect(navAllowed({ permission: 'po.analyze', anyOf: ['po.analyze', 'dashboard.analyze'] }, can(['dashboard.analyze']))).toBe(true);
    expect(navAllowed({ anyOf: ['inventory.view', 'auto_indent.view'] }, can([]))).toBe(false);
  });
});

// C17: the menu and the route guard admitted users to screens whose API refused them.
describe('menu entries ask what their API asks', () => {
  const can = (held: string[]) => (p: string) => held.includes(p);
  const entry = (to: string) => entries.find((e) => e.to === to)!;
  /** Every right any menu entry or screen rule names, each held alone. */
  const singles = [...new Set([...entries.flatMap((e) => [e.permission, ...(e.anyOf ?? [])]),
    ...Object.values(SCREEN_ACCESS).flatMap((a: { permission: string; anyOf?: string[] }) => [a.permission, ...(a.anyOf ?? [])]),
    'user.admin', 'role.view', 'user.view', 'requisition.issue', 'inventory.adjust'])].filter(Boolean) as string[];

  it('Data management only for system.admin, which every one of its routes requires (S1-D8)', () => {
    const dm = entry('/admin/data-management');
    expect(navAllowed(dm, can(['system.admin']))).toBe(true);
    for (const p of ['role.view', 'user.admin', 'user.view', 'user.edit']) expect(navAllowed(dm, can([p])), p).toBe(false);
    expect(SCREEN_ACCESS['/admin/data-management']).toEqual({ permission: 'system.admin' });
  });

  it('Direct issue only for direct_issue.view, which its register requires (S4 observation 2)', () => {
    const di = entry('/inventory/direct-issue');
    expect(navAllowed(di, can(['direct_issue.view']))).toBe(true);
    for (const p of ['inventory.view', 'requisition.issue', 'auto_indent.view']) expect(navAllowed(di, can([p])), p).toBe(false);
    expect(SCREEN_ACCESS['/inventory/direct-issue']).toEqual({ permission: 'direct_issue.view' });
  });

  it('no menu entry is shown to a user its route refuses', () => {
    for (const e of entries) {
      const path = e.to.split('?')[0]! as keyof typeof SCREEN_ACCESS;
      const route = SCREEN_ACCESS[path] as { permission: string; anyOf?: string[] } | undefined;
      if (!route) continue;
      for (const p of singles) {
        if (navAllowed(e, can([p]))) expect(navAllowed(route, can([p])), `${e.to} shown to ${p}`).toBe(true);
      }
    }
  });

  it('each inventory tab asks what its own list asks', () => {
    for (const tab of ['rm', 'fg', 'wip', 'trading', 'general']) {
      const e = entry(`/inventory?tab=${tab}`);
      expect([navAllowed(e, can(['inventory.view'])), navAllowed(e, can(['auto_indent.view']))], tab).toEqual([true, false]);
    }
    const auto = entry('/inventory?tab=auto-indent');
    expect([navAllowed(auto, can(['auto_indent.view'])), navAllowed(auto, can(['inventory.view']))]).toEqual([true, false]);
    expect(navAllowed(entry('/inventory?tab=adjustments'), can(['inventory.adjust']))).toBe(false);
    expect(navAllowed(entry('/inventory?tab=requisition-queue'), can(['requisition.issue']))).toBe(false);
  });

  it('App.tsx guards these routes with the same rules', () => {
    const app = Object.values(import.meta.glob('../App.tsx', { query: '?raw', import: 'default', eager: true }))[0] as string;
    for (const path of Object.keys(SCREEN_ACCESS)) {
      const escaped = path.replace(/[/]/g, '\\/');
      expect(app, path).toMatch(new RegExp(`<Route path="${escaped}" element=\\{guardScreen\\('${escaped}', `));
    }
  });
});
