import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  Outlet,
  RouterProvider,
  createRootRoute,
  createRoute,
  createHashHistory,
  createRouter,
  lazyRouteComponent,
} from '@tanstack/react-router';
import { Loader2, Lock } from 'lucide-react';
import type { ComponentType } from 'react';
import { Card, EmptyState, ToastProvider } from '@/components/ui';
import { AppShell, useSignOut } from '@/components/AppShell';
import { AuthScreen } from '@/auth/AuthScreen';
import { ApiError, onUnauthenticated } from '@/lib/api';
import { sessionKey, useActor, useSession, useSetupNeeded } from '@/lib/session';
import { applyTheme, storedTheme } from '@/lib/theme';
import { Dashboard } from '@/pages/Dashboard';
import { Clients } from '@/pages/Clients';
import { ClientLayout } from '@/pages/client/ClientLayout';
import { ClientOverview } from '@/pages/client/ClientOverview';
import { ClientActivity, ClientContacts, ClientLocations } from '@/pages/client/people';
import { AllAssets, AssetDetail, ClientAssets } from '@/pages/assets';
import { Layouts } from '@/pages/Layouts';
import { SharePage } from '@/pages/SharePage';
import { ReasonProvider } from '@/lib/vault';
import { ReauthProvider } from '@/components/Reauth';
import { Groups } from '@/pages/Groups';
import { Settings } from '@/pages/Settings';
import { Theme } from '@/pages/Theme';
import { Expirations } from '@/pages/Expirations';
import { Users } from '@/pages/Users';
import { Security } from '@/pages/Security';
import { Account } from '@/pages/Account';
import { NotFound } from '@/pages/NotFound';
import { DEMO } from '@/lib/demo';
import { useApplyBranding } from '@/lib/branding';
import { DataTools } from '@/pages/DataTools';
import { Status } from '@/pages/Status';
import { Updates } from '@/pages/Updates';
import './styles.css';

applyTheme(storedTheme());
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme(storedTheme()));

const queryClient = new QueryClient({
  defaultOptions: {
    // Retry network hiccups and server errors, never refusals (4xx) — those won't change on retry.
    queries: {
      staleTime: 15_000,
      refetchOnWindowFocus: true,
      retry: (count, error) => !(error instanceof ApiError && error.status >= 400 && error.status < 500) && count < 2,
    },
  },
});
// When the server says the session is gone, drop cached data and show sign-in.
onUnauthenticated(() => {
  queryClient.setQueryData(sessionKey, null);
  queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== 'session' });
});

function Loading() {
  return (
    <div className="grid min-h-screen place-items-center" role="status">
      <Loader2 className="size-6 animate-spin text-primary" aria-label="Loading Atlas" />
    </div>
  );
}

/** Decides between sign-in stages and the workspace. The server enforces the same stages. */
function Gate() {
  const session = useSession();
  const setup = useSetupNeeded(session.data === null);
  const signOut = useSignOut();
  if (session.isLoading || (session.data === null && setup.isLoading)) return <Loading />;
  if (session.isError)
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center">
        <div>
          <p className="font-semibold">Atlas could not be reached.</p>
          <button className="mt-2 text-sm font-semibold text-primary hover:underline" onClick={() => session.refetch()}>
            Try again
          </button>
        </div>
      </div>
    );
  if (!session.data)
    return <AuthScreen stage={setup.data?.needed ? 'setup' : 'signin'} passwordReset={setup.data?.passwordReset} />;
  if (session.data.stage !== 'active')
    return (
      <AuthScreen
        stage={session.data.stage}
        email={session.data.actor.email}
        methods={session.data.methods}
        onSignOut={signOut}
      />
    );
  return (
    <ReauthProvider>
      <ReasonProvider>
        <AppShell>
          <Outlet />
        </AppShell>
      </ReasonProvider>
    </ReauthProvider>
  );
}

/** Admin pages show a clear message instead of an empty page; the server enforces the same rule. */
function adminOnly(Page: ComponentType) {
  return function AdminPage() {
    const actor = useActor();
    if (actor.isAdmin) return <Page />;
    return (
      <Card>
        <EmptyState
          icon={Lock}
          title="Administrators only"
          description="Ask an Atlas administrator if you need access to this page."
        />
      </Card>
    );
  };
}

function Root() {
  useApplyBranding();
  return (
    <>
      <Outlet />
      {DEMO && (
        <p className="pointer-events-none fixed right-3 bottom-3 z-40 rounded-full bg-warning-soft px-3 py-1.5 text-xs font-semibold text-warning shadow-md">
          Demo · sample data · resets when you reload
        </p>
      )}
    </>
  );
}

const rootRoute = createRootRoute({ component: Root, notFoundComponent: NotFound });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: Gate });
// Search params used by list pages (folder and layout filters, archived toggle).
// The rich-text editor is large, so document pages load on first use.
const documentsPage = (name: 'ClientDocuments' | 'DocumentPage' | 'KnowledgeBase' | 'NewDocument') =>
  lazyRouteComponent(() => import('@/pages/documents'), name);
// The vault pages load on first use too.
const vaultPage = (name: 'ClientPasswords' | 'AllPasswords' | 'PasswordDetail') =>
  lazyRouteComponent(() => import('@/pages/vault'), name);
const listSearch = (search: Record<string, unknown>) => ({
  layout: typeof search.layout === 'string' ? search.layout : undefined,
  folder: typeof search.folder === 'string' ? search.folder : undefined,
  archived: search.archived === true || search.archived === 'true' ? true : undefined,
});
const newDocSearch = (search: Record<string, unknown>) => ({
  client: typeof search.client === 'string' ? search.client : undefined,
  folder: typeof search.folder === 'string' ? search.folder : undefined,
});
const clientRoute = createRoute({
  getParentRoute: () => appRoute,
  path: '/clients/$clientId',
  component: ClientLayout,
});
const clientRoutes = [
  createRoute({ getParentRoute: () => clientRoute, path: '/', component: ClientOverview }),
  createRoute({
    getParentRoute: () => clientRoute,
    path: '/assets',
    component: ClientAssets,
    validateSearch: listSearch,
  }),
  createRoute({
    getParentRoute: () => clientRoute,
    path: '/documents',
    component: documentsPage('ClientDocuments'),
    validateSearch: listSearch,
  }),
  createRoute({
    getParentRoute: () => clientRoute,
    path: '/passwords',
    component: vaultPage('ClientPasswords'),
    validateSearch: listSearch,
  }),
  createRoute({ getParentRoute: () => clientRoute, path: '/contacts', component: ClientContacts }),
  createRoute({ getParentRoute: () => clientRoute, path: '/locations', component: ClientLocations }),
  createRoute({ getParentRoute: () => clientRoute, path: '/activity', component: ClientActivity }),
];
const routes = [
  createRoute({ getParentRoute: () => appRoute, path: '/', component: Dashboard }),
  createRoute({ getParentRoute: () => appRoute, path: '/clients', component: Clients }),
  clientRoute.addChildren(clientRoutes),
  createRoute({ getParentRoute: () => appRoute, path: '/assets', component: AllAssets, validateSearch: listSearch }),
  createRoute({ getParentRoute: () => appRoute, path: '/assets/$assetId', component: AssetDetail }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/documents',
    component: documentsPage('KnowledgeBase'),
    validateSearch: listSearch,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/documents/new',
    component: documentsPage('NewDocument'),
    validateSearch: newDocSearch,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/documents/$documentId',
    component: documentsPage('DocumentPage'),
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/passwords',
    component: vaultPage('AllPasswords'),
    validateSearch: listSearch,
  }),
  createRoute({
    getParentRoute: () => appRoute,
    path: '/passwords/$passwordId',
    component: vaultPage('PasswordDetail'),
  }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/users', component: adminOnly(Users) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/layouts', component: adminOnly(Layouts) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/security', component: adminOnly(Security) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/groups', component: adminOnly(Groups) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/settings', component: adminOnly(Settings) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/theme', component: adminOnly(Theme) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/data', component: adminOnly(DataTools) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/status', component: adminOnly(Status) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/updates', component: adminOnly(Updates) }),
  createRoute({ getParentRoute: () => appRoute, path: '/expirations', component: Expirations }),
  createRoute({ getParentRoute: () => appRoute, path: '/account', component: Account }),
];
const router = createRouter({
  routeTree: rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: '/share/$token', component: SharePage }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/reset-password',
      component: () => <AuthScreen stage="reset" />,
    }),
    appRoute.addChildren(routes),
  ]),
  defaultPreload: 'intent',
  // The demo is a single published page, so routes live in the URL fragment.
  ...(DEMO ? { history: createHashHistory() } : {}),
});
declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
