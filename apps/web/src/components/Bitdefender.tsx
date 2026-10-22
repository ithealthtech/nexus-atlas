import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BITDEFENDER_HEALTH_LABELS,
  type BitdefenderClientView,
  type BitdefenderEndpointView,
  type BitdefenderHealth,
  type BitdefenderLicence,
} from '@atlas/shared';
import { AppLink } from '@/components/AppLink';
import { Badge, Button, Card, CardHeader, Skeleton } from '@/components/ui';
import { api } from '@/lib/api';
import { cn } from '@/lib/cn';
import { relativeTime } from '@/lib/format';

const TONE: Record<BitdefenderHealth, 'danger' | 'warning' | 'success'> = {
  infected: 'danger',
  attention: 'warning',
  protected: 'success',
};
const LICENCE: Record<BitdefenderLicence, string> = {
  active: 'Active',
  expired: 'Expired',
  pending: 'Waiting for activation',
  none: 'None',
  unknown: 'Not reported',
};
/** GravityZone's module names, as people read them. */
const MODULES: Record<string, string> = {
  advancedThreatControl: 'Advanced Threat Control',
  antimalware: 'Antimalware',
  contentControl: 'Content Control',
  deviceControl: 'Device Control',
  firewall: 'Firewall',
  powerUser: 'Power User',
  encryption: 'Encryption',
  edrSensor: 'EDR sensor',
  hyperDetect: 'HyperDetect',
  patchManagement: 'Patch Management',
  relay: 'Relay',
  sandboxAnalyzer: 'Sandbox Analyzer',
  exchange: 'Exchange protection',
  advancedAntiExploit: 'Advanced Anti-Exploit',
  containerProtection: 'Container protection',
  networkAttackDefense: 'Network Attack Defense',
  integrityMonitoring: 'Integrity Monitoring',
};

function Count({ label, value, tone }: { label: string; value: number; tone?: 'danger' | 'warning' | 'success' }) {
  return (
    <div>
      <div className="text-xs text-muted">{label}</div>
      <div
        className={cn(
          'text-xl font-semibold tabular-nums',
          value > 0 && tone === 'danger' && 'text-danger',
          value > 0 && tone === 'warning' && 'text-warning',
          tone === 'success' && 'text-success',
        )}
      >
        {value}
      </div>
    </div>
  );
}

const EndpointName = ({ e }: { e: BitdefenderEndpointView }) =>
  e.assetId ? (
    <AppLink to={`/assets/${e.assetId}`} className="min-w-0 truncate font-medium hover:underline">
      {e.assetName ?? e.name}
    </AppLink>
  ) : (
    <span className="min-w-0 truncate font-medium">{e.name}</span>
  );

const SHOWN = 8;

/** A client's Bitdefender GravityZone endpoints: what's infected or needs attention first, and devices it doesn't cover. */
export function BitdefenderClientCard({ clientId }: { clientId: string }) {
  const [all, setAll] = useState(false);
  const { data, isLoading } = useQuery({
    queryKey: ['bitdefender', 'client', clientId],
    queryFn: () => api<BitdefenderClientView>(`/clients/${clientId}/bitdefender`),
    staleTime: 5 * 60_000,
  });
  if (isLoading)
    return (
      <Card className="p-5">
        <Skeleton className="h-24" />
      </Card>
    );
  if (!data?.linked) return null;
  const flagged = data.endpoints.filter((e) => e.health !== 'protected');
  const listed = all ? data.endpoints : flagged;
  return (
    <Card>
      <CardHeader
        title="Bitdefender"
        description={
          data.syncedAt
            ? `Endpoint protection from GravityZone, synced ${relativeTime(data.syncedAt)}.`
            : 'Linked to GravityZone. Endpoints show here after the next sync.'
        }
        actions={
          data.endpoints.length > 0 &&
          flagged.length < data.endpoints.length && (
            <Button variant="ghost" size="sm" onClick={() => setAll(!all)} aria-pressed={all}>
              {all ? 'Only what needs attention' : `All ${data.endpoints.length} endpoints`}
            </Button>
          )
        }
      />
      <div className="space-y-4 px-5 py-4">
        <div className="flex flex-wrap gap-x-8 gap-y-3">
          <Count label="Infected" value={data.counts.infected} tone="danger" />
          <Count label="Needs attention" value={data.counts.attention} tone="warning" />
          <Count label="Protected" value={data.counts.protected} tone="success" />
          <Count label="Devices without Bitdefender" value={data.missing.length} tone="warning" />
        </div>
        {listed.length > 0 ? (
          <ul className="divide-y divide-border text-sm">
            {listed.slice(0, all ? undefined : SHOWN).map((e) => (
              <li key={e.id} className="flex min-w-0 items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <EndpointName e={e} />
                  <p className="truncate text-xs text-muted">
                    {e.issues[0] ?? [e.policyName && `Policy ${e.policyName}`, e.os].filter(Boolean).join(' · ')}
                    {e.issues.length > 1 && ` and ${e.issues.length - 1} more`}
                  </p>
                </div>
                <Badge tone={TONE[e.health]}>{BITDEFENDER_HEALTH_LABELS[e.health]}</Badge>
              </li>
            ))}
            {!all && flagged.length > SHOWN && (
              <li className="py-2 text-xs text-muted">and {flagged.length - SHOWN} more needing attention</li>
            )}
          </ul>
        ) : (
          data.endpoints.length > 0 && <p className="text-sm text-muted">Every endpoint is protected.</p>
        )}
        {data.missing.length > 0 && (
          <div>
            <h3 className="text-[13px] font-semibold">Devices without Bitdefender</h3>
            <p className="text-xs text-muted">In the RMM, but not managed in GravityZone, so likely unprotected.</p>
            <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-sm">
              {data.missing.slice(0, 30).map((d) => (
                <li key={d.assetId}>
                  <AppLink to={`/assets/${d.assetId}`} className="hover:underline">
                    {d.name}
                  </AppLink>
                </li>
              ))}
              {data.missing.length > 30 && <li className="text-muted">and {data.missing.length - 30} more</li>}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}

/** One asset's Bitdefender endpoint: its state, what needs fixing, and the agent's details. */
export function BitdefenderDeviceCard({ assetId }: { assetId: string }) {
  const { data } = useQuery({
    queryKey: ['bitdefender', 'asset', assetId],
    queryFn: () => api<{ endpoint: BitdefenderEndpointView | null }>(`/assets/${assetId}/bitdefender`),
    staleTime: 5 * 60_000,
  });
  const e = data?.endpoint;
  if (!e) return null;
  const facts: [string, string][] = [
    ['Policy', e.policyName ? `${e.policyName}${e.policyApplied === false ? ' (not applied)' : ''}` : 'Not reported'],
    ['Licence', LICENCE[e.licence]],
    ['Last seen', e.lastSeenAt ? relativeTime(e.lastSeenAt) : 'Not reported'],
    ['Agent', e.productVersion || 'Not reported'],
    [
      'Risk score',
      e.riskScore === null ? 'Not reported' : `${e.riskScore}%${e.riskImpact ? ` (${e.riskImpact})` : ''}`,
    ],
    [
      'Signatures',
      e.signaturesOutdated === null ? 'Not reported' : e.signaturesOutdated ? 'Out of date' : 'Up to date',
    ],
  ];
  return (
    <Card>
      <CardHeader
        title="Bitdefender"
        description={`From GravityZone, synced ${relativeTime(e.syncedAt)}.`}
        actions={<Badge tone={TONE[e.health]}>{BITDEFENDER_HEALTH_LABELS[e.health]}</Badge>}
      />
      <div className="space-y-4 px-5 py-4">
        {e.issues.length > 0 && (
          <ul className="space-y-1 text-sm">
            {e.issues.map((issue) => (
              <li key={issue} className={cn(e.health === 'infected' ? 'text-danger' : 'text-warning', 'font-medium')}>
                {issue}
              </li>
            ))}
          </ul>
        )}
        <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
          {facts.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="text-xs font-medium text-muted">{label}</dt>
              <dd className="mt-0.5 text-sm">{value}</dd>
            </div>
          ))}
        </dl>
        {e.modules.length > 0 && (
          <div>
            <h3 className="text-xs font-medium text-muted">Modules on</h3>
            <p className="mt-0.5 text-sm">{e.modules.map((m) => MODULES[m] ?? m).join(', ')}</p>
          </div>
        )}
      </div>
    </Card>
  );
}
