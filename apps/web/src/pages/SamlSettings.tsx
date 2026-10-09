import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, LogIn } from 'lucide-react';
import type { SamlServiceProvider, SamlView } from '@atlas/shared';
import {
  Button,
  Card,
  CardHeader,
  Checkbox,
  Field,
  FormError,
  Input,
  Skeleton,
  Textarea,
  useToast,
} from '@/components/ui';
import { ApiError, api } from '@/lib/api';
import { formatDate } from '@/lib/format';

type SamlState = { serviceProvider: SamlServiceProvider; settings: SamlView | null; linksCleared?: boolean };

function CopyRow({ label, value }: { label: string; value: string }) {
  const toast = useToast();
  return (
    <div>
      <p className="text-xs font-medium text-text">{label}</p>
      <div className="mt-0.5 flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded bg-surface px-2 py-1 font-mono text-xs break-all">{value}</code>
        <Button
          size="sm"
          variant="ghost"
          aria-label={`Copy the ${label.toLowerCase()}`}
          onClick={() => navigator.clipboard.writeText(value).then(() => toast('Copied.'))}
        >
          <Copy />
        </Button>
      </div>
    </div>
  );
}

/** Staff sign in through a SAML 2.0 identity provider such as Okta, Google Workspace, Duo, or JumpCloud. */
export function SamlSettings() {
  const toast = useToast();
  const state = useQuery({ queryKey: ['saml-settings'], queryFn: () => api<SamlState>('/settings/saml') });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const data = state.data;
  const saved = data?.settings ?? null;

  const save = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const pasted = String(form.get('idpCert') ?? '').trim();
    if (!pasted && !saved) {
      setError(
        new ApiError(400, 'Paste the signing certificate.', undefined, { idpCert: 'Paste the signing certificate.' }),
      );
      return;
    }
    setBusy('save');
    setError(null);
    try {
      const result = await api<SamlState>('/settings/saml', {
        method: 'PUT',
        body: {
          name: form.get('name'),
          entryPoint: form.get('entryPoint'),
          idpIssuer: form.get('idpIssuer'),
          // Left empty, the certificate already saved is kept.
          ...(pasted ? { idpCert: pasted } : {}),
          enabled: form.get('enabled') === 'on',
          trustMfa: form.get('trustMfa') === 'on',
          requireSso: form.get('requireSso') === 'on',
        },
      });
      await state.refetch();
      toast(
        result.linksCleared
          ? 'Saved. The identity provider changed, so everyone’s link was cleared and needs confirming again.'
          : 'SAML sign-in settings saved.',
      );
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader
        title="SAML sign-in"
        description="Let staff sign in through a SAML identity provider such as Okta, Google Workspace, Duo, or JumpCloud. People still have to exist in Atlas first; an account is never created by signing in."
      />
      {state.isLoading || !data ? (
        <div className="p-5">
          <Skeleton className="h-40" />
        </div>
      ) : (
        <form key={JSON.stringify(saved)} onSubmit={save} className="space-y-5 p-5" noValidate>
          <div className="space-y-2 rounded-lg border border-border bg-surface-2 p-3 text-sm text-text-2">
            <p className="font-medium text-text">Add Atlas as a SAML app in your identity provider with these:</p>
            <CopyRow label="Single sign-on (ACS) URL" value={data.serviceProvider.acsUrl} />
            <CopyRow label="Audience (SP entity ID)" value={data.serviceProvider.entityId} />
            <p className="text-xs">
              Send the person’s <strong>email</strong> as an attribute named <em>email</em>, and choose a name ID that
              never changes for a person (a persistent ID rather than their email, if your provider offers one). The
              provider must sign the assertion. Providers that import metadata can read it from the audience address.
            </p>
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Identity provider name"
              help="Shown on the button: “Sign in with …”."
              error={error?.fields?.name}
            >
              {(p) => (
                <Input {...p} name="name" defaultValue={saved?.name ?? ''} placeholder="Okta" maxLength={40} required />
              )}
            </Field>
            <Field label="Provider issuer (entity ID)" error={error?.fields?.idpIssuer}>
              {(p) => (
                <Input
                  {...p}
                  name="idpIssuer"
                  defaultValue={saved?.idpIssuer}
                  className="font-mono"
                  autoComplete="off"
                  required
                />
              )}
            </Field>
          </div>
          <Field label="Provider sign-on URL" error={error?.fields?.entryPoint}>
            {(p) => (
              <Input
                {...p}
                name="entryPoint"
                type="url"
                defaultValue={saved?.entryPoint}
                className="font-mono"
                autoComplete="off"
                placeholder="https://"
                required
              />
            )}
          </Field>
          <Field
            label="Provider signing certificate"
            error={error?.fields?.idpCert}
            help={
              saved
                ? `Saved: ${saved.certificates
                    .map((c) => `${c.subject}, expires ${formatDate(c.expires)}`)
                    .join(
                      '; ',
                    )}. Leave empty to keep it. When the provider rolls its certificate over, paste the old and new ones together.`
                : 'The X.509 certificate, as the provider gives it (PEM text).'
            }
          >
            {(p) => <Textarea {...p} name="idpCert" rows={4} className="font-mono text-xs" spellCheck={false} />}
          </Field>
          <div className="space-y-3">
            <Checkbox
              name="enabled"
              defaultChecked={saved?.enabled}
              label={`Show “Sign in with ${saved?.name || 'your provider'}” on the sign-in page`}
            />
            <Checkbox
              name="trustMfa"
              defaultChecked={saved?.trustMfa}
              label="The identity provider enforces multi-factor sign-in"
              description="Atlas then doesn’t also ask for its own code. SAML can’t tell Atlas whether MFA was really used, so only tick this if the provider requires it for this app. Off: people still use Atlas MFA."
            />
            <Checkbox
              name="requireSso"
              defaultChecked={saved?.requireSso}
              label="Require single sign-on for staff"
              description="Staff can no longer sign in with a password. The owner always can, so a problem with the provider never locks everyone out."
            />
          </div>
          <FormError message={error && !error.fields ? error.message : null} />
          <div className="flex flex-wrap items-center gap-2">
            <Button type="submit" loading={busy === 'save'}>
              <LogIn /> Save SAML sign-in
            </Button>
            {saved && (
              <Button
                variant="ghost"
                className="ml-auto"
                loading={busy === 'remove'}
                onClick={async () => {
                  setBusy('remove');
                  try {
                    await api('/settings/saml', { method: 'DELETE' });
                    await state.refetch();
                    toast('SAML sign-in removed.');
                  } catch (err) {
                    setError(err as ApiError);
                  } finally {
                    setBusy(null);
                  }
                }}
              >
                Remove
              </Button>
            )}
          </div>
          <p className="text-xs text-muted">
            People are matched to provider accounts by email the first time they sign in. An administrator confirms each
            match under People &amp; access before it works.
          </p>
        </form>
      )}
    </Card>
  );
}
