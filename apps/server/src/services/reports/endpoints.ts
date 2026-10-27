import { BITDEFENDER_HEALTH_LABELS, type BitdefenderLicence } from '@atlas/shared';
import { iso, onlineText, type Collector, type ReportContext } from './context.js';

const LICENCE: Record<BitdefenderLicence, string> = {
  active: 'Active',
  expired: 'Expired',
  pending: 'Pending',
  none: 'None',
  unknown: 'Not reported',
};
/** What a device shows in a Bitdefender column when its client is linked but GravityZone doesn't manage it. */
export const NOT_MANAGED = 'Not managed';

/**
 * Every Bitdefender endpoint of the linked clients, most serious first, then the RMM devices GravityZone doesn't
 * manage (likely unprotected). Nothing is added when no chosen client is linked.
 */
export async function bitdefenderSection(report: ReportContext) {
  const linked = await report.bitdefender();
  if (!linked.size) return;
  report.section(
    'Bitdefender endpoints',
    ['Client', 'Endpoint', 'Bitdefender', 'Issues', 'Policy', 'Licence', 'Last seen'],
    [...linked].flatMap(([clientId, view]) => [
      ...view.endpoints.map((e) => [
        report.client(clientId),
        e.assetName ?? e.name,
        BITDEFENDER_HEALTH_LABELS[e.health],
        e.issues.join('; '),
        e.policyName ? `${e.policyName}${e.policyApplied === false ? ' (not applied)' : ''}` : '',
        LICENCE[e.licence],
        e.lastSeenAt ?? '',
      ]),
      ...view.missing.map((d) => [
        report.client(clientId),
        d.name,
        NOT_MANAGED,
        'In the RMM, but not managed in GravityZone',
        '',
        '',
        '',
      ]),
    ]),
  );
}

/** Every RMM device: online, last check-in, and endpoint protection (and Bitdefender's view, where linked). */
export const endpoints: Collector = async (report) => {
  const devices = await report.endpoints();
  const linked = await report.bitdefender();
  // A device's Bitdefender state, by the asset it's matched to; empty for clients not linked to GravityZone.
  const state = new Map(
    [...linked.values()].flatMap((v) =>
      v.endpoints.flatMap((e) => (e.assetId ? [[e.assetId, BITDEFENDER_HEALTH_LABELS[e.health]] as const] : [])),
    ),
  );
  const bitdefender = (e: { clientId: string; assetId: string }) =>
    linked.has(e.clientId) ? (state.get(e.assetId) ?? NOT_MANAGED) : '';
  const extra = linked.size > 0;
  report.section(
    'Endpoint health',
    [
      'Client',
      'Device',
      'Type',
      'Online',
      'Last check-in',
      'Protection',
      ...(extra ? ['Bitdefender'] : []),
      'Last sync',
    ],
    devices.map((e) => [
      report.client(e.clientId),
      e.name,
      e.kind,
      onlineText(e.online),
      iso(e.lastSeenAt) || 'Unknown',
      e.protection ?? 'Unknown',
      ...(extra ? [bitdefender(e)] : []),
      iso(e.updatedAt),
    ]),
  );
  await bitdefenderSection(report);
};
