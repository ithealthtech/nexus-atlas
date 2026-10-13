import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Download, TriangleAlert } from 'lucide-react';
import type { PortalCertificateStatus, PortalCertificateView } from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Badge, Button, Card, CardHeader, PageHeader, Skeleton, useToast, type Tone } from '@/components/ui';
import { api, download, type ApiError } from '@/lib/api';
import { formatDate } from '@/lib/format';

const FILE = 'atlas-certificate-authority.crt';
const STATUS: Record<PortalCertificateStatus, { label: string; tone: Tone }> = {
  trusted: { label: 'Trusted everywhere', tone: 'success' },
  private: { label: 'Not trusted until installed', tone: 'warning' },
  expired: { label: 'Expired', tone: 'danger' },
  mismatch: { label: 'For another address', tone: 'danger' },
  untrusted: { label: 'Refused', tone: 'danger' },
  none: { label: 'No HTTPS', tone: 'neutral' },
  unreachable: { label: 'Couldn’t check', tone: 'neutral' },
};

function summary(c: PortalCertificateView): string {
  switch (c.status) {
    case 'trusted':
      return 'A public certificate authority vouches for this certificate. Browsers and Atlas for Windows already trust it, so there is nothing to install.';
    case 'private':
      return c.authority && !c.authority.isAuthority
        ? 'This certificate vouches for itself, so no computer trusts it yet. Browsers warn about it, and Atlas for Windows won’t connect, until it is installed on the computer.'
        : 'This certificate comes from your Atlas server’s own certificate authority, which no computer knows yet. Browsers warn about it, and Atlas for Windows won’t connect, until that authority is installed on the computer.';
    case 'expired':
      return 'This certificate has run out, so computers refuse it. If the web proxy on this server issues it, restarting the proxy on the Services page gets a new one. Otherwise renew it where it was issued.';
    case 'mismatch':
      return `This certificate is for other addresses, not ${c.host}. People need to open Atlas at one of the addresses it covers, or it needs reissuing for this one.`;
    case 'untrusted':
      return c.problem ?? 'Computers refuse this certificate.';
    case 'none':
      return 'Atlas isn’t served over HTTPS at this address, so there is no certificate to show. That is expected on a development copy; a real server must use https://.';
    case 'unreachable':
      return c.problem ?? 'Atlas couldn’t read its own certificate.';
  }
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid gap-1 px-5 py-3 sm:grid-cols-[11rem_1fr] sm:gap-4">
      <dt className="text-xs font-medium text-muted sm:pt-0.5">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function Validity({ validTo, daysLeft }: { validTo: string; daysLeft: number }) {
  return (
    <>
      {formatDate(validTo)}{' '}
      <span className="text-muted">
        {daysLeft < 0 ? '(expired)' : daysLeft === 0 ? '(less than a day left)' : `(${daysLeft} days left)`}
      </span>
    </>
  );
}

function Command({ text, label }: { text: string; label: string }) {
  const toast = useToast();
  return (
    <div className="mt-1.5 flex items-start gap-2">
      <code className="min-w-0 flex-1 rounded-lg bg-surface-3 px-3 py-2 font-mono text-xs break-all">{text}</code>
      <Button
        variant="ghost"
        size="icon"
        aria-label={`Copy the command ${label}`}
        onClick={() => navigator.clipboard.writeText(text).then(() => toast('Command copied.'))}
      >
        <Copy />
      </Button>
    </div>
  );
}

export function Certificate() {
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const certificate = useQuery({
    queryKey: ['portal-certificate'],
    queryFn: () => api<PortalCertificateView>('/system/certificate'),
  });
  const c = certificate.data;
  const save = async () => {
    setSaving(true);
    try {
      await download('/system/certificate/authority', FILE);
    } catch (error) {
      toast((error as ApiError).message, 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Administration"
        title="Certificate"
        description="The certificate that secures the connection to Atlas, and how to get your computers to trust it."
      />
      {!c ? (
        <div className="space-y-4">
          <Skeleton className="h-64" />
          <Skeleton className="h-48" />
        </div>
      ) : (
        <div className="space-y-6">
          <Card>
            <CardHeader
              title={
                <span className="flex flex-wrap items-center gap-2">
                  What Atlas is served with <Badge tone={STATUS[c.status].tone}>{STATUS[c.status].label}</Badge>
                </span>
              }
              description={summary(c)}
            />
            <dl className="divide-y divide-border">
              <Fact label="Address">{c.url}</Fact>
              {c.certificate && (
                <>
                  <Fact label="Issued by">{c.certificate.issuer}</Fact>
                  <Fact label="Covers">
                    {c.certificate.names.length ? c.certificate.names.join(', ') : c.certificate.name}
                  </Fact>
                  <Fact label="Valid until">
                    <Validity validTo={c.certificate.validTo} daysLeft={c.certificate.daysLeft} />
                  </Fact>
                  <Fact label="Fingerprint (SHA-256)">
                    <span className="font-mono text-xs">{c.certificate.fingerprint}</span>
                  </Fact>
                </>
              )}
            </dl>
            {c.certificate && !c.coversHost && c.status !== 'mismatch' && (
              <p className="flex items-start gap-2 border-t border-border px-5 py-3.5 text-sm text-warning">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                This certificate doesn’t cover {c.host}. Even once it is trusted, people must open Atlas at an address
                it covers.
              </p>
            )}
          </Card>

          {c.authority ? (
            <Card>
              <CardHeader
                title="Trust it on your computers"
                description={
                  c.authority.isAuthority
                    ? `Install “${c.authority.name}” on a computer and it trusts the certificates this server issues. It is a public certificate; the key that signs with it never leaves the server.`
                    : 'Install this certificate on a computer and it trusts this one site. It is a public certificate, not a key.'
                }
                actions={
                  <Button loading={saving} onClick={() => void save()}>
                    <Download /> Download
                  </Button>
                }
              />
              <dl className="divide-y divide-border">
                <Fact label="File">{FILE}</Fact>
                <Fact label="Valid until">
                  <Validity validTo={c.authority.validTo} daysLeft={c.authority.daysLeft} />
                </Fact>
                <Fact label="Thumbprint (SHA-1)">
                  <span className="font-mono text-xs">{c.authority.thumbprint}</span>
                </Fact>
                <Fact label="Fingerprint (SHA-256)">
                  <span className="font-mono text-xs">{c.authority.fingerprint}</span>
                </Fact>
              </dl>
              <div className="space-y-4 border-t border-border px-5 py-4 text-sm text-text-2">
                <div>
                  <p className="font-medium text-text">First, check the file on the computer</p>
                  <p>
                    In PowerShell, in the folder you downloaded it to. The result must be the thumbprint above, whatever
                    the letter case. That is how you know the file wasn’t swapped on the way:
                  </p>
                  <Command
                    label="that shows the file’s thumbprint"
                    text={`(Get-PfxCertificate .\\${FILE}).Thumbprint`}
                  />
                </div>
                <div>
                  <p className="font-medium text-text">On Windows, for everyone who uses the computer</p>
                  <p>Run PowerShell as an administrator, in the folder you downloaded the file to:</p>
                  <Command
                    label="for everyone on the computer"
                    text={`Import-Certificate -FilePath .\\${FILE} -CertStoreLocation Cert:\\LocalMachine\\Root`}
                  />
                </div>
                <div>
                  <p className="font-medium text-text">On Windows, only for yourself</p>
                  <p>No administrator needed. Windows shows the thumbprint and asks you to confirm:</p>
                  <Command
                    label="for yourself only"
                    text={`Import-Certificate -FilePath .\\${FILE} -CertStoreLocation Cert:\\CurrentUser\\Root`}
                  />
                </div>
                <div>
                  <p className="font-medium text-text">On many computers</p>
                  <p>
                    Run the first command from your RMM, or add the file with Group Policy: Computer Configuration,
                    Policies, Windows Settings, Security Settings, Public Key Policies, Trusted Root Certification
                    Authorities.
                  </p>
                </div>
                <ul className="list-disc space-y-1 pl-5">
                  <li>
                    Then restart the browser and open Atlas at{' '}
                    {c.certificate?.names.length ? c.certificate.names.join(' or ') : c.host}. The certificate covers
                    only {c.certificate && c.certificate.names.length > 1 ? 'those addresses' : 'that address'}, not
                    another name for the same server.
                  </li>
                  <li>
                    Firefox keeps its own list of authorities unless <code>security.enterprise_roots.enabled</code> is
                    turned on.
                  </li>
                </ul>
              </div>
              {c.authority.isAuthority && (
                <p className="flex items-start gap-2 border-t border-border bg-warning-soft px-5 py-3.5 text-sm text-warning">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
                  <span>
                    A computer that trusts this authority accepts any certificate it issues, for any website. Its key is
                    on your Atlas server and is used only for Atlas, but someone who took the server over could misuse
                    it. Install it only on computers you manage, and remove it from any you stop managing.
                  </span>
                </p>
              )}
              {c.authority.source === 'proxy' && (
                <p className="border-t border-border px-5 py-3.5 text-sm text-text-2">
                  The web proxy on this server renews the portal’s own certificate by itself, often several times a day,
                  so its dates above are short. Computers trust the authority, which lasts until{' '}
                  {formatDate(c.authority.validTo)}. If the certificate ever looks stale, restart the web proxy on the{' '}
                  <AppLink to="/admin/services" className="text-primary underline-offset-4 hover:underline">
                    Services page
                  </AppLink>
                  .
                </p>
              )}
            </Card>
          ) : (
            c.status === 'private' && (
              <Card>
                <CardHeader
                  title="Atlas can’t offer the certificate to install"
                  description="The authority’s own certificate wasn’t sent with the portal’s, and the web proxy on this server didn’t provide it. Get it from whoever set up HTTPS for Atlas, then install it on your computers as a trusted root."
                />
              </Card>
            )
          )}
        </div>
      )}
    </>
  );
}
