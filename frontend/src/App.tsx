/**
 * Routing and route guards.
 *
 * `RequireAuth` gates the shell; `RequirePermission` gates individual screens.
 * Both are ergonomic guards — the server re-checks every request regardless
 * (SRS §25), so a hand-typed URL cannot reach data the user may not see.
 */
import { Suspense, lazy, useState, type ReactNode } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate, useNavigationType } from 'react-router-dom';
import { useAuth } from './lib/auth';
import { AppShell } from './layout/AppShell';
import { LoadingBlock, EmptyState, Button, Spinner } from './components/ui';
import { ShieldAlert, Compass, Home as HomeIcon } from 'lucide-react';

/* Public */
import Landing from './pages/Landing';
import Login from './pages/Login';

/* Lazily loaded so the initial bundle stays small (SRS §30). */
const Home           = lazy(() => import('./pages/Home'));
const Dashboard      = lazy(() => import('./pages/Dashboard'));
const Suppliers      = lazy(() => import('./pages/masters/Suppliers'));
const Items          = lazy(() => import('./pages/masters/Items'));
const Lookups        = lazy(() => import('./pages/masters/Lookups'));
const StockReconciliation = lazy(() => import('./pages/masters/StockReconciliation'));
const IndentList     = lazy(() => import('./pages/indent/IndentList'));
const IndentForm     = lazy(() => import('./pages/indent/IndentForm'));
const IndentDetail   = lazy(() => import('./pages/indent/IndentDetail'));
const IndentAnalysis = lazy(() => import('./pages/indent/IndentAnalysis'));
const PoList         = lazy(() => import('./pages/po/PoList'));
const PoAwaitingIndent = lazy(() => import('./pages/po/PoAwaitingIndent'));
const PoForm         = lazy(() => import('./pages/po/PoForm'));
const PoDetail       = lazy(() => import('./pages/po/PoDetail'));
const PoAnalysis     = lazy(() => import('./pages/po/PoAnalysis'));
const GrnList        = lazy(() => import('./pages/grn/GrnList'));
const GrnPending     = lazy(() => import('./pages/grn/GrnPending'));
const GrnForm        = lazy(() => import('./pages/grn/GrnForm'));
const GrnDetail      = lazy(() => import('./pages/grn/GrnDetail'));
const GrnAnalysis    = lazy(() => import('./pages/grn/GrnAnalysis'));
const GrnLabels      = lazy(() => import('./pages/grn/GrnLabels'));
const RequisitionList     = lazy(() => import('./pages/requisition/RequisitionList'));
const RequisitionForm     = lazy(() => import('./pages/requisition/RequisitionForm'));
const RequisitionDetail   = lazy(() => import('./pages/requisition/RequisitionDetail'));
const RequisitionAnalysis = lazy(() => import('./pages/requisition/RequisitionAnalysis'));
const InventoryStockPage  = lazy(() => import('./pages/inventory/InventoryStockPage'));
const DirectIssuePage     = lazy(() => import('./pages/inventory/DirectIssuePage'));
const QcPage              = lazy(() => import('./pages/qc/QcPage'));
const Users          = lazy(() => import('./pages/admin/Users'));
const Roles          = lazy(() => import('./pages/admin/Roles'));
const AuditLog       = lazy(() => import('./pages/admin/AuditLog'));
const Backup         = lazy(() => import('./pages/admin/Backup'));
const ImportExport   = lazy(() => import('./pages/admin/ImportExport'));
const SyncAdmin      = lazy(() => import('./pages/admin/SyncAdmin'));
const SettingsPage   = lazy(() => import('./pages/admin/SettingsPage'));
const DataManagement = lazy(() => import('./pages/admin/DataManagement'));
const Profile        = lazy(() => import('./pages/Profile'));

function FullPageLoader() {
  return (
    <div style={{ minHeight: '100vh', display: 'grid', placeItems: 'center' }}>
      <div className="row" style={{ gap: 10, color: 'var(--text-3)', fontSize: 'var(--fs-14)' }}>
        <Spinner /> Loading ZOLEX…
      </div>
    </div>
  );
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  // A user who owes a password change gets no shell at all — the API answers
  // nothing else until they change it — only the change-password step of the
  // sign-in screen, which then continues to the page they asked for.
  if (!user || user.mustChangePassword) {
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />;
  }

  return <AppShell>{children}</AppShell>;
}

function RequirePermission({ permission, anyOf, children }: { permission: string; anyOf?: string[]; children: ReactNode }) {
  const { can, canAny } = useAuth();
  // `anyOf` screens open for a holder of ANY listed right — the same rule the
  // analytics API applies — instead of for one fixed permission.
  const allowed = anyOf ? canAny(...anyOf) : can(permission);
  if (!allowed) {
    return (
      <div className="card">
        <EmptyState
          icon={<ShieldAlert />}
          title="You don't have access to this screen"
          message={
            <>
              It needs the <code style={{ fontFamily: 'var(--font-mono)', fontSize: '0.9em', color: 'var(--text-1)' }}>{permission}</code>{' '}
              permission. Ask your administrator if you should have it.
            </>
          }
        />
      </div>
    );
  }
  return <>{children}</>;
}

const guard = (permission: string, element: ReactNode) => (
  <RequirePermission permission={permission}>{element}</RequirePermission>
);

/**
 * Guard for the Analysis screens. They are drawn from the analytics API, which
 * serves a module's charts to holders of that module's "analyze" right or of the
 * dashboard-wide one. Guarding them with the plain "view" right (as before) let
 * view-only roles open a screen whose every chart then answered "You do not
 * have permission to view this information".
 */
const guardAnalysis = (module: 'indent' | 'po' | 'grn' | 'requisition', element: ReactNode) => (
  <RequirePermission permission={`${module}.analyze`} anyOf={[`${module}.analyze`, 'dashboard.analyze']}>{element}</RequirePermission>
);

/**
 * The sign-in screen. Once signed in, the user is sent on to the page they first
 * asked for — `RequireAuth` records it in the navigation state — and to Home
 * only when there is none. The redirect used to be a fixed "/home", which won
 * the race against the sign-in form's own navigation, so someone who opened a
 * link to a document always landed on Home after signing in.
 */
function LoginRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) return <FullPageLoader />;
  if (user && !user.mustChangePassword) {
    const from = (location.state as { from?: string } | null)?.from;
    // Only ever an address inside this application.
    const target = from && from.startsWith('/') && !from.startsWith('//') && !from.startsWith('/login') ? from : '/home';
    return <Navigate to={target} replace />;
  }
  return <Login />;
}

export default function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      {/* ── Public ──────────────────────────────────────────────────────── */}
      <Route
        path="/"
        element={loading ? <FullPageLoader /> : user ? <Navigate to="/home" replace /> : <Landing />}
      />
      <Route path="/login" element={<LoginRoute />} />

      {/* ── Authenticated ───────────────────────────────────────────────── */}
      <Route
        path="/*"
        element={
          <RequireAuth>
            <Suspense fallback={<LoadingBlock height={400} />}>
              <Routes>
                {/* Home is everyone's landing page: it shows only the work cards the
                    signed-in user's permissions allow, so it needs no guard of its own. */}
                <Route path="/home" element={<Home />} />
                <Route path="/dashboard" element={guard('dashboard.view', <Dashboard />)} />
                <Route path="/profile" element={<ProfileRoute />} />

                <Route path="/masters/suppliers" element={guard('supplier.view', <Suppliers />)} />
                <Route path="/masters/suppliers/:id" element={guard('supplier.view', <Suppliers />)} />
                <Route path="/masters/items" element={guard('item.view', <Items />)} />
                <Route path="/masters/items/:id" element={guard('item.view', <Items />)} />
                <Route path="/masters/lookups" element={guard('lookup.view', <Lookups />)} />
                <Route path="/masters/stock-reconciliation" element={guard('item.view', <StockReconciliation />)} />

                <Route path="/indents" element={guard('indent.view', <IndentList />)} />
                <Route path="/indents/new" element={guard('indent.create', <IndentForm />)} />
                <Route path="/indents/analysis" element={guardAnalysis('indent', <IndentAnalysis />)} />
                <Route path="/indents/:id" element={guard('indent.view', <IndentDetail />)} />
                <Route path="/indents/:id/edit" element={guard('indent.edit', <IndentForm />)} />

                <Route path="/purchase-orders" element={guard('po.view', <PoList />)} />
                <Route path="/purchase-orders/new" element={guard('po.create', <PoForm />)} />
                <Route path="/purchase-orders/pending" element={guard('po.view', <PoList />)} />
                <Route path="/purchase-orders/awaiting" element={guard('po.create', <PoAwaitingIndent />)} />
                <Route path="/purchase-orders/complete" element={guard('po.view', <PoList />)} />
                <Route path="/purchase-orders/analysis" element={guardAnalysis('po', <PoAnalysis />)} />
                <Route path="/purchase-orders/:id" element={guard('po.view', <PoDetail />)} />
                <Route path="/purchase-orders/:id/edit" element={guard('po.edit', <PoForm />)} />

                <Route path="/grn" element={guard('grn.view', <GrnList />)} />
                <Route path="/grn/new" element={guard('grn.create', <GrnForm />)} />
                <Route path="/grn/pending" element={guard('grn.create', <GrnPending />)} />
                <Route path="/grn/labels" element={guard('grn.view', <GrnLabels />)} />
                <Route path="/grn/analysis" element={guardAnalysis('grn', <GrnAnalysis />)} />
                <Route path="/grn/:id" element={guard('grn.view', <GrnDetail />)} />
                <Route path="/grn/:id/edit" element={guard('grn.edit', <GrnForm />)} />

                <Route path="/requisitions" element={guard('requisition.view', <RequisitionList />)} />
                <Route path="/requisitions/new" element={guard('requisition.create', <RequisitionForm />)} />
                <Route path="/requisitions/mine" element={guard('requisition.view', <RequisitionList scope="mine" />)} />
                <Route path="/requisitions/hod-queue" element={guard('requisition.approve', <RequisitionList scope="hod-pending" />)} />
                <Route path="/requisitions/store-queue" element={guard('requisition.issue', <RequisitionList scope="store-queue" />)} />
                <Route path="/requisitions/analysis" element={guardAnalysis('requisition', <RequisitionAnalysis />)} />
                <Route path="/requisitions/:id" element={guard('requisition.view', <RequisitionDetail />)} />
                <Route path="/requisitions/:id/edit" element={guard('requisition.edit', <RequisitionForm />)} />

                <Route path="/inventory" element={<RequirePermission permission="inventory.view" anyOf={['inventory.view', 'auto_indent.view']}><InventoryStockPage /></RequirePermission>} />
                {/* Old addresses of two inventory views. They rendered the Overview
                    (the page defaults to it), so a bookmark opened the wrong screen;
                    they now redirect to the view they name (audit UI-017). */}
                <Route path="/inventory/stock" element={<Navigate to="/inventory?tab=stock" replace />} />
                <Route path="/inventory/direct-issue" element={<RequirePermission permission="direct_issue.view" anyOf={['direct_issue.view', 'auto_indent.view', 'requisition.issue', 'inventory.view']}><DirectIssuePage /></RequirePermission>} />
                <Route path="/inventory/auto-indent" element={<Navigate to="/inventory?tab=auto-indent" replace />} />

                <Route path="/qc" element={guard('qc.view', <QcPage />)} />
                <Route path="/qc/inspections" element={<Navigate to="/qc" replace />} />

                <Route path="/admin/users" element={guard('user.view', <Users />)} />
                <Route path="/admin/users/:id" element={guard('user.view', <Users />)} />
                <Route path="/admin/roles" element={guard('role.view', <Roles />)} />
                <Route path="/admin/audit" element={guard('audit.view', <AuditLog />)} />
                <Route path="/admin/backup" element={guard('backup.view', <Backup />)} />
                <Route path="/admin/import-export" element={<ImportExport />} />
                <Route path="/admin/sync" element={guard('sync.view', <SyncAdmin />)} />
                <Route path="/admin/settings" element={guard('system.admin', <SettingsPage />)} />
                <Route path="/admin/data-management" element={<RequirePermission permission="system.admin" anyOf={['system.admin', 'user.admin', 'role.view']}><DataManagement /></RequirePermission>} />

                <Route path="*" element={<NotFound />} />
              </Routes>
            </Suspense>
          </RequireAuth>
        }
      />
    </Routes>
  );
}

/**
 * Profile reads its ?tab only when it mounts, and keeps the address in step
 * with its own tab clicks by REPLACE navigations. Every other arrival — the
 * user menu's "My profile" or "Change password", a link, Back or Forward —
 * remounts it, so the tab shown is the one the address names (audit UI-017).
 * The first fix remounted only on a nonce that "Change password" sent, so
 * "My profile" and Back left the password tab on screen under /profile
 * (review 2026-10-16). A tab click keeps the page mounted, and its focus.
 */
function ProfileRoute() {
  const location = useLocation();
  const navigationType = useNavigationType();
  const [mount, setMount] = useState({ key: location.key, n: 0 });
  if (mount.key !== location.key) {
    setMount({ key: location.key, n: navigationType === 'REPLACE' ? mount.n : mount.n + 1 });
  }
  return <Profile key={mount.n} />;
}

function NotFound() {
  const navigate = useNavigate();
  return (
    <div className="card" style={{ padding: 'var(--space-6)' }}>
      <EmptyState
        icon={<Compass />}
        title="That page does not exist"
        message="The link may be out of date, or the record may have been removed."
        action={<Button variant="primary" icon={<HomeIcon size={15} />} onClick={() => navigate('/home')}>Back to My work</Button>}
      />
    </div>
  );
}
