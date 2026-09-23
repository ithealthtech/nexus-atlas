import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Outlet, RouterProvider, createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
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
import { ClientDetail } from '@/pages/ClientDetail';
import { Users } from '@/pages/Users';
import { Security } from '@/pages/Security';
import { Account } from '@/pages/Account';
import { NotFound } from '@/pages/NotFound';
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
  if (!session.data) return <AuthScreen stage={setup.data?.needed ? 'setup' : 'signin'} />;
  if (session.data.stage !== 'active')
    return <AuthScreen stage={session.data.stage} email={session.data.actor.email} onSignOut={signOut} />;
  return (
    <AppShell>
      <Outlet />
    </AppShell>
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

const rootRoute = createRootRoute({ component: Outlet, notFoundComponent: NotFound });
const appRoute = createRoute({ getParentRoute: () => rootRoute, id: 'app', component: Gate });
const routes = [
  createRoute({ getParentRoute: () => appRoute, path: '/', component: Dashboard }),
  createRoute({ getParentRoute: () => appRoute, path: '/clients', component: Clients }),
  createRoute({ getParentRoute: () => appRoute, path: '/clients/$clientId', component: ClientDetail }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/users', component: adminOnly(Users) }),
  createRoute({ getParentRoute: () => appRoute, path: '/admin/security', component: adminOnly(Security) }),
  createRoute({ getParentRoute: () => appRoute, path: '/account', component: Account }),
];
const router = createRouter({
  routeTree: rootRoute.addChildren([appRoute.addChildren(routes)]),
  defaultPreload: 'intent',
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
