import { useState } from 'react';
import { useParams } from '@tanstack/react-router';
import { AlertTriangle, Copy, Eye, KeyRound, ShieldCheck } from 'lucide-react';
import { Button, Card } from '@/components/ui';
import { Logo } from '@/components/Logo';
import { ApiError } from '@/lib/api';
import { decryptShare, type SharedPayload } from '@/lib/vault';

/**
 * Public page for a one-time share link. The decryption key is in the URL #fragment, which browsers never send
 * to the server; opening uses one of the link's views.
 */
export function SharePage() {
  const { token } = useParams({ strict: false }) as { token: string };
  // Read the key once and remove it from the address bar and history.
  const [key] = useState(() => {
    const k = location.hash.slice(1);
    if (k) history.replaceState(null, '', location.pathname);
    return k;
  });
  const [payload, setPayload] = useState<SharedPayload | null>(null);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(
    key ? null : 'This link is incomplete. Ask the sender for the full link.',
  );
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const open = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/shares/${encodeURIComponent(token)}/open`, { method: 'POST' });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new ApiError(response.status, data?.error ?? 'This link could not be opened.');
      setPayload(await decryptShare(data.ciphertext, key));
      setRemaining(data.remainingViews);
    } catch (e) {
      setError(
        e instanceof ApiError ? e.message : 'This link could not be decrypted. It may have been copied incompletely.',
      );
    } finally {
      setBusy(false);
    }
  };
  const copy = async (label: string, value: string) => {
    await navigator.clipboard.writeText(value);
    setCopied(label);
  };
  return (
    <main id="main" className="flex min-h-screen items-center justify-center bg-bg px-4 py-12">
      <div className="w-full max-w-lg">
        <Logo className="mb-8" />
        <Card className="p-6 sm:p-8">
          {!payload ? (
            <>
              <span className="mb-4 grid size-11 place-items-center rounded-xl bg-warning-soft text-warning">
                <KeyRound className="size-5" aria-hidden />
              </span>
              <h1 className="text-xl font-semibold">Someone shared a password with you</h1>
              <p className="mt-2 text-sm text-muted">
                It&rsquo;s encrypted, and this link can only be opened a limited number of times. Open it when
                you&rsquo;re ready to use it.
              </p>
              {error ? (
                <p
                  role="alert"
                  className="mt-5 flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2.5 text-sm text-danger"
                >
                  <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {error}
                </p>
              ) : (
                <Button size="lg" className="mt-6 w-full" onClick={open} loading={busy}>
                  <Eye /> Reveal the password
                </Button>
              )}
            </>
          ) : (
            <>
              <h1 className="text-xl font-semibold">{payload.name}</h1>
              <p className="mt-1 text-sm text-muted">
                {remaining === 0
                  ? 'This link has now been used up. Save the password somewhere safe before closing this page.'
                  : `This link can be opened ${remaining} more time${remaining === 1 ? '' : 's'}.`}
              </p>
              <ul className="mt-5 divide-y divide-border rounded-xl border border-border">
                {(
                  [
                    [payload.kind === 'bitlocker' ? 'Recovery key ID' : 'Username', payload.username],
                    [payload.kind === 'bitlocker' ? 'Recovery key' : 'Password', payload.secret],
                    ['Website', payload.url],
                  ] as const
                )
                  .filter(([, v]) => v)
                  .map(([label, value]) => (
                    <li key={label} className="flex items-center gap-3 px-4 py-3">
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-muted">{label}</p>
                        <p className="mt-0.5 font-mono text-sm break-all">{value}</p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Copy ${label.toLowerCase()}`}
                        onClick={() => copy(label, value)}
                      >
                        <Copy />
                      </Button>
                    </li>
                  ))}
              </ul>
              {copied && (
                <p className="mt-2 text-xs text-success" role="status">
                  {copied} copied.
                </p>
              )}
            </>
          )}
          <p className="mt-6 flex items-start gap-2 border-t border-border pt-4 text-xs text-muted">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            Decrypted in your browser. The server never had the key to read it.
          </p>
        </Card>
      </div>
    </main>
  );
}
