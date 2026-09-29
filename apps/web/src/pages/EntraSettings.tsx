import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, LogIn } from 'lucide-react';
import type { EntraView } from '@atlas/shared';
import { Button, Card, CardHeader, Checkbox, Field, FormError, Input, Skeleton, useToast } from '@/components/ui';
import { ApiError, api } from '@/lib/api';

/** Staff sign in with Microsoft Entra ID: an app registration used for sign-in only (separate from the mail one). */
export function EntraSettings() {
  const toast = useToast();
  const view = useQuery({
    queryKey: ['entra-settings'],
    queryFn: () => api<Partial<EntraView> & { redirectUri: string }>('/settings/entra'),
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const data = view.data;
  const configured = !!data?.clientId;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const secret = String(form.get('clientSecret') ?? '');
    setBusy('save');
    setError(null);
    try {
      await api('/settings/entra', {
        method: 'PUT',
        body: {
          tenantId: form.get('tenantId'),
          clientId: form.get('clientId'),
          ...(secret ? { clientSecret: secret } : {}),
          enabled: form.get('enabled') === 'on',
          trustMfa: form.get('trustMfa') === 'on',
          requireSso: form.get('requireSso') === 'on',
        },
      });
      await view.refetch();
      toast('Microsoft sign-in settings saved.');
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const act = async (name: string, work: () => Promise<void>) => {
    setBusy(name);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Microsoft sign-in"
        description="Let staff sign in with their Microsoft 365 account. People still have to exist in Atlas first; an account is never created by signing in."
      />
      {view.isLoading || !data ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : (
        <form key={JSON.stringify(data)} onSubmit={save} className="space-y-5 p-5" noValidate>
          <div className="rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-2">
            <p className="font-medium text-text">
              In Microsoft Entra → App registrations, make a separate app for sign-in:
            </p>
            <ol className="mt-1 list-decimal space-y-0.5 pl-5">
              <li>
                Add a <strong>Web</strong> redirect address:
              </li>
            </ol>
            <div className="mt-1 flex items-center gap-2">
              <code className="min-w-0 flex-1 truncate rounded bg-surface px-2 py-1 font-mono text-xs">
                {data.redirectUri}
              </code>
              <Button
                size="sm"
                variant="ghost"
                aria-label="Copy the redirect address"
                onClick={() => navigator.clipboard.writeText(data.redirectUri).then(() => toast('Address copied.'))}
              >
                <Copy />
              </Button>
            </div>
            <p className="mt-2">
              Then create a client secret (copy its <strong>Value</strong>) and paste the IDs below. No API permissions
              beyond the default <em>User.Read</em> are needed.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Sign-in tenant ID" error={error?.fields?.tenantId}>
              {(p) => (
                <Input
                  {...p}
                  name="tenantId"
                  defaultValue={data.tenantId}
                  className="font-mono"
                  autoComplete="off"
                  required
                />
              )}
            </Field>
            <Field label="Sign-in app ID" error={error?.fields?.clientId}>
              {(p) => (
                <Input
                  {...p}
                  name="clientId"
                  defaultValue={data.clientId}
                  className="font-mono"
                  autoComplete="off"
                  required
                />
              )}
            </Field>
          </div>
          <Field
            label="Sign-in secret"
            error={error?.fields?.clientSecret}
            help={
              configured ? 'Saved and encrypted. Leave empty to keep it; paste a new one before it expires.' : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                name="clientSecret"
                type="password"
                autoComplete="off"
                placeholder={configured ? '••••••••' : ''}
              />
            )}
          </Field>
          <div className="space-y-3">
            <Checkbox
              name="enabled"
              defaultChecked={data.enabled}
              label="Show “Sign in with Microsoft” on the sign-in page"
            />
            <Checkbox
              name="trustMfa"
              defaultChecked={data.trustMfa}
              label="Trust Microsoft’s multi-factor sign-in"
              description="When Microsoft asked for more than a password (conditional access or Security Defaults), don’t also ask for an Atlas code. Off: people still use Atlas MFA."
            />
            <Checkbox
              name="requireSso"
              defaultChecked={data.requireSso}
              label="Require Microsoft sign-in for staff"
              description="Staff can no longer sign in with a password. The owner always can, so a problem with Microsoft never locks everyone out."
            />
          </div>
          <FormError message={error && !error.fields ? error.message : null} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === 'save'}>
              <LogIn /> Save Microsoft sign-in
            </Button>
            {configured && (
              <>
                <Button
                  variant="secondary"
                  loading={busy === 'test'}
                  onClick={() =>
                    act('test', async () => {
                      await api('/settings/entra/test', { method: 'POST', body: {} });
                      toast('Microsoft knows that tenant.');
                    })
                  }
                >
                  Check the tenant
                </Button>
                <Button
                  variant="ghost"
                  className="ml-auto"
                  loading={busy === 'remove'}
                  onClick={() =>
                    act('remove', async () => {
                      await api('/settings/entra', { method: 'DELETE' });
                      await view.refetch();
                      toast('Microsoft sign-in removed.');
                    })
                  }
                >
                  Remove
                </Button>
              </>
            )}
          </div>
          <p className="text-xs text-muted">
            New people are matched to Microsoft accounts by email the first time they sign in. An administrator confirms
            each match under People &amp; access before it works.
          </p>
        </form>
      )}
    </Card>
  );
}
