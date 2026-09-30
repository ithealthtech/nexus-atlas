import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import type {
  BackupJob,
  BackupStatus,
  ClientSecurity,
  DeviceSecurity,
  SecuritySection,
  VulnCounts,
  VulnSeverity,
} from '@atlas/shared';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';
import { AppLink } from './AppLink';
import { Badge, Card, CardHeader, Skeleton, type Tone } from './ui';

// Security and compliance from ConnectWise (patching, backup, vulnerabilities, MDR), read live by the server.

const SHOWN = 5;
const SEVERITIES: VulnSeverity[] = ['critical', 'high', 'medium', 'low', 'unknown'];
const SEVERITY_TONE: Record<VulnSeverity, Tone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
  unknown: 'neutral',
};
const BACKUP_TONE: Record<BackupStatus, Tone> = {
  success: 'success',
  failure: 'danger',
  missed: 'danger',
  warning: 'warning',
  running: 'info',
  paused: 'neutral',
  unknown: 'neutral',
};
const scoreTone = (score: number | null): Tone =>
  score === null ? 'neutral' : score >= 90 ? 'success' : score >= 70 ? 'warning' : 'danger';
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** One area of the card: its figures, or why ConnectWise has none. */
function Panel<T>({
  title,
  section,
  children,
}: {
  title: string;
  section: SecuritySection<T>;
  children: (data: T) => ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-border px-4 py-3">
      <h3 className="text-[13px] font-semibold text-text">{title}</h3>
      {section.state === 'ok' ? (
        <div className="mt-2 space-y-3 text-sm">{children(section.data)}</div>
      ) : (
        <div className="mt-2">
          <Badge>Not available</Badge>
          <p className="mt-1.5 text-xs text-muted">{section.reason}</p>
        </div>
      )}
    </section>
  );
}

function Figure({ label, value, tone }: { label: string; value: ReactNode; tone?: Tone }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums',
          tone === 'danger' && 'text-danger',
          tone === 'warning' && 'text-warning',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </div>
    </div>
  );
}

const score = (v: number | null) => (v === null ? 'None' : `${v}%`);

function Counts({ counts }: { counts: VulnCounts }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {SEVERITIES.filter((s) => counts[s] || s !== 'unknown').map((s) => (
        <Badge key={s} tone={counts[s] ? SEVERITY_TONE[s] : 'neutral'}>
          {capital(s)} <span className="tabular-nums">{counts[s]}</span>
        </Badge>
      ))}
    </div>
  );
}

function Rows<T>({ items, render, empty }: { items: T[]; render: (item: T) => ReactNode; empty: string }) {
  if (!items.length) return <p className="text-xs text-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-border">
      {items.slice(0, SHOWN).map((item, i) => (
        <li key={i} className="flex min-w-0 items-center justify-between gap-3 py-1.5">
          {render(item)}
        </li>
      ))}
      {items.length > SHOWN && <li className="py-1.5 text-xs text-muted">and {items.length - SHOWN} more</li>}
    </ul>
  );
}

const DeviceName = ({ name, assetId }: { name: string; assetId: string | null }) =>
  assetId ? (
    <AppLink to={`/assets/${assetId}`} className="min-w-0 truncate hover:underline">
      {name}
    </AppLink>
  ) : (
    <span className="min-w-0 truncate text-muted">{name}</span>
  );

const JobRow = ({ job, showDevice }: { job: BackupJob; showDevice: boolean }) => (
  <>
    <span className="min-w-0">
      <span className="block truncate">{job.name}</span>
      <span className="block truncate text-xs text-muted">
        {[showDevice && job.device, job.product, job.lastBackupAt && `last ${relativeTime(job.lastBackupAt)}`]
          .filter(Boolean)
          .join(' · ')}
      </span>
    </span>
    <Badge tone={BACKUP_TONE[job.status]}>{capital(job.status)}</Badge>
  </>
);

/** Patch compliance, backup and DR, vulnerabilities and MDR cases for a client linked to ConnectWise. */
export function ClientSecurityCard({ clientId }: { clientId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['cw-security', 'client', clientId],
    queryFn: () => api<ClientSecurity>(`/clients/${clientId}/security`),
    staleTime: 5 * 60_000,
  });
  if (isLoading)
    return (
      <Card className="p-5">
        <Skeleton className="h-32" />
      </Card>
    );
  if (!data?.linked) return null;
  return (
    <Card>
      <CardHeader
        title="Security and compliance"
        description={`From ConnectWise, read ${relativeTime(data.fetchedAt)}.`}
      />
      <div className="grid gap-4 px-5 py-4 md:grid-cols-2">
        <Panel title="Patch compliance" section={data.patching}>
          {(p) => (
            <>
              <div className="flex flex-wrap gap-6">
                <Figure label="Windows updates" value={score(p.osScore)} tone={scoreTone(p.osScore)} />
                <Figure label="Third-party" value={score(p.thirdPartyScore)} tone={scoreTone(p.thirdPartyScore)} />
                <Figure label="Fully patched" value={`${p.compliant} of ${p.assessed}`} />
              </div>
              <Rows
                items={p.devices.filter((d) => d.missing || d.thirdPartyPending)}
                empty="Every device is fully patched."
                render={(d) => (
                  <>
                    <DeviceName name={d.name} assetId={d.assetId} />
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {d.missing} missing · {d.thirdPartyPending} apps
                    </span>
                  </>
                )}
              />
            </>
          )}
        </Panel>
        <Panel title="Backup and DR readiness" section={data.backup}>
          {(b) => (
            <>
              <div className="flex flex-wrap gap-6">
                <Figure label="Last backup" value={b.lastBackupAt ? relativeTime(b.lastBackupAt) : 'None'} />
                <Figure
                  label="Failing jobs"
                  value={`${b.failing.length} of ${b.jobs}`}
                  tone={b.failing.length ? 'danger' : 'success'}
                />
                <Figure label="DR readiness" value={score(b.drScore)} tone={scoreTone(b.drScore)} />
              </div>
              <Rows
                items={b.failing}
                empty="No failing or missed backup jobs."
                render={(j) => <JobRow job={j} showDevice />}
              />
              {b.alarms.length > 0 && (
                <Rows
                  items={b.alarms}
                  empty=""
                  render={(a) => (
                    <>
                      <span className="min-w-0">
                        <span className="block truncate">{a.name}</span>
                        <span className="block truncate text-xs text-muted">
                          {[a.device, a.description].filter(Boolean).join(' · ')}
                        </span>
                      </span>
                      <Badge tone={/critical|high/i.test(a.severity) ? 'danger' : 'warning'}>
                        {a.severity || 'Alarm'}
                      </Badge>
                    </>
                  )}
                />
              )}
            </>
          )}
        </Panel>
        <Panel title="Vulnerabilities" section={data.vulnerabilities}>
          {(v) => (
            <>
              <Counts counts={v.counts} />
              <Rows
                items={v.devices}
                empty="No known vulnerabilities on this client's devices."
                render={(d) => (
                  <>
                    <DeviceName name={d.name} assetId={d.assetId} />
                    <span className="shrink-0 text-xs text-muted tabular-nums">
                      {d.counts.critical} critical · {d.counts.high} high
                    </span>
                  </>
                )}
              />
            </>
          )}
        </Panel>
        <Panel title="Security incidents (MDR)" section={data.incidents}>
          {(cases) => (
            <Rows
              items={cases}
              empty="No open security cases."
              render={(c) => (
                <>
                  <span className="min-w-0">
                    <span className="block truncate">{c.title}</span>
                    <span className="block truncate text-xs text-muted">
                      {[
                        c.category,
                        c.status,
                        c.impacted.length ? `affects ${c.impacted.join(', ')}` : '',
                        c.updatedAt && `updated ${relativeTime(c.updatedAt)}`,
                      ]
                        .filter(Boolean)
                        .join(' · ')}
                    </span>
                  </span>
                  <Badge tone={/critical|high/i.test(c.severity) ? 'danger' : 'warning'}>
                    {c.severity ? capital(c.severity) : 'Case'}
                  </Badge>
                </>
              )}
            />
          )}
        </Panel>
      </div>
    </Card>
  );
}

/** A device's missing patches, backup jobs and vulnerabilities, when it was synced from ConnectWise RMM. */
export function DeviceSecurityCard({ assetId }: { assetId: string }) {
  const { data } = useQuery({
    queryKey: ['cw-security', 'device', assetId],
    queryFn: () => api<DeviceSecurity>(`/assets/${assetId}/security`),
    staleTime: 5 * 60_000,
  });
  if (!data?.linked) return null;
  return (
    <Card>
      <CardHeader
        title="Security and compliance"
        description={`From ConnectWise, read ${relativeTime(data.fetchedAt)}.`}
      />
      <div className="grid gap-4 px-5 py-4">
        <Panel title="Patches" section={data.patching}>
          {({ device, missing }) => (
            <>
              {device && (
                <div className="flex flex-wrap gap-6">
                  <Figure label="Windows updates" value={score(device.osScore)} tone={scoreTone(device.osScore)} />
                  <Figure
                    label="Third-party"
                    value={score(device.thirdPartyScore)}
                    tone={scoreTone(device.thirdPartyScore)}
                  />
                  <Figure label="Pending reboot" value={device.pendingReboot} />
                  {device.outOfSupport && <Badge tone="danger">OS out of support</Badge>}
                </div>
              )}
              <Rows
                items={missing}
                empty="No missing patches."
                render={(m) => (
                  <>
                    <span className="min-w-0">
                      <span className="flex items-center gap-1 truncate">
                        {m.name}
                        {m.link && (
                          <a href={m.link} target="_blank" rel="noreferrer noopener" aria-label={`About ${m.name}`}>
                            <ExternalLink className="size-3 text-muted" />
                          </a>
                        )}
                      </span>
                      {m.detail && <span className="block truncate text-xs text-muted">{m.detail}</span>}
                    </span>
                    <Badge>{m.kind === 'os' ? 'Windows' : 'App'}</Badge>
                  </>
                )}
              />
            </>
          )}
        </Panel>
        <Panel title="Backup" section={data.backup}>
          {(jobs) => <Rows items={jobs} empty="" render={(j) => <JobRow job={j} showDevice={false} />} />}
        </Panel>
        <Panel title="Vulnerabilities" section={data.vulnerabilities}>
          {({ counts, list }) => (
            <>
              <Counts counts={counts} />
              <Rows
                items={list}
                empty="No known vulnerabilities."
                render={(v) => (
                  <>
                    <a
                      href={`https://nvd.nist.gov/vuln/detail/${encodeURIComponent(v.cve)}`}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="truncate hover:underline"
                    >
                      {v.cve}
                    </a>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted tabular-nums">
                      {v.cvss !== null && `CVSS ${v.cvss.toFixed(1)}`}
                      <Badge tone={SEVERITY_TONE[v.severity]}>{capital(v.severity)}</Badge>
                    </span>
                  </>
                )}
              />
            </>
          )}
        </Panel>
      </div>
    </Card>
  );
}
