import { z } from 'zod';

// ---------- Bitdefender GravityZone ----------

/**
 * GravityZone's API address, from Control Center → My account → Control Center API ("Access URL"), such as
 * https://cloud.gravityzone.bitdefender.com/api. Only Bitdefender's own cloud hosts are accepted, so a saved key is
 * never sent anywhere else.
 */
export const BITDEFENDER_HOST = /^(?:[a-z0-9-]+\.)*gravityzone\.bitdefender\.com$/i;
export const DEFAULT_BITDEFENDER_URL = 'https://cloud.gravityzone.bitdefender.com/api';

/** The access URL as Atlas stores it: https, a Bitdefender host, and the path up to the API version. */
export function bitdefenderAccessUrl(input: string): string | null {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !BITDEFENDER_HOST.test(url.hostname) || url.port || url.username) return null;
  // A pasted method address (…/api/v1.0/jsonrpc/network) is cut back to the API root.
  const path = url.pathname.replace(/\/v\d+\.\d+(?:\/.*)?$/, '').replace(/\/+$/, '');
  return `https://${url.hostname.toLowerCase()}${path || '/api'}`;
}

export const bitdefenderConnectionSchema = z.object({
  accessUrl: z
    .string()
    .trim()
    .max(300)
    .transform((v, ctx) => {
      const url = bitdefenderAccessUrl(v || DEFAULT_BITDEFENDER_URL);
      if (!url) {
        ctx.addIssue({
          code: 'custom',
          message:
            'Use the Access URL from GravityZone (My account → Control Center API), on gravityzone.bitdefender.com.',
        });
        return z.NEVER;
      }
      return url;
    }),
  /** Left out to keep the saved key. */
  apiKey: z.string().trim().min(10).max(500).optional(),
  autoSync: z.boolean().default(true),
});

export const bitdefenderSyncOptionsSchema = z.object({
  /** Endpoints with no matching asset are added as assets, in the same layout ConnectWise RMM devices use. */
  createAssets: z.boolean().default(false),
});
export type BitdefenderSyncOptions = z.infer<typeof bitdefenderSyncOptionsSchema>;

export interface BitdefenderView {
  accessUrl: string;
  hasKey: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  options: BitdefenderSyncOptions;
}

/** GravityZone's licence state for an endpoint's agent. */
export type BitdefenderLicence = 'active' | 'expired' | 'pending' | 'none' | 'unknown';

/** How an endpoint stands: malware found, something to fix, or protected. */
export type BitdefenderHealth = 'infected' | 'attention' | 'protected';
export const BITDEFENDER_HEALTH_LABELS: Record<BitdefenderHealth, string> = {
  infected: 'Infected',
  attention: 'Needs attention',
  protected: 'Protected',
};

/** An endpoint stops counting as current once it hasn't checked in for this long. */
export const BITDEFENDER_STALE_DAYS = 7;

export interface BitdefenderEndpointView {
  id: string;
  name: string;
  assetId: string | null;
  assetName: string | null;
  os: string;
  ip: string;
  online: boolean | null;
  lastSeenAt: string | null;
  /** Still infected: the antimalware couldn't remove what it found. */
  infected: boolean;
  /** Malware was found (and dealt with) in the last 24 hours. */
  detection: boolean;
  signaturesOutdated: boolean | null;
  productOutdated: boolean | null;
  licence: BitdefenderLicence;
  policyName: string;
  policyApplied: boolean | null;
  isolated: boolean;
  /** GravityZone's risk score, 0–100, and its impact (Low, Medium, High). */
  riskScore: number | null;
  riskImpact: string;
  modules: string[];
  productVersion: string;
  health: BitdefenderHealth;
  /** Plain-language reasons the endpoint isn't simply protected, most serious first. */
  issues: string[];
  syncedAt: string;
}

export interface BitdefenderClientView {
  /** Whether any GravityZone company is linked to this client. */
  linked: boolean;
  syncedAt: string | null;
  counts: Record<BitdefenderHealth, number>;
  /** Most serious first. */
  endpoints: BitdefenderEndpointView[];
  /** Devices the RMM knows about that Bitdefender doesn't: likely unprotected. */
  missing: { assetId: string; name: string }[];
}

/** The fields an endpoint's health is worked out from. */
export type BitdefenderFacts = Pick<
  BitdefenderEndpointView,
  | 'infected'
  | 'detection'
  | 'signaturesOutdated'
  | 'productOutdated'
  | 'licence'
  | 'policyApplied'
  | 'isolated'
  | 'lastSeenAt'
>;

/** An endpoint's health and the reasons for it, most serious first. */
export function bitdefenderHealth(
  e: BitdefenderFacts,
  now = Date.now(),
): { health: BitdefenderHealth; issues: string[] } {
  const issues: string[] = [];
  if (e.infected) issues.push('Still infected: the malware found could not be removed');
  if (e.isolated) issues.push('Isolated from the network');
  if (e.licence === 'expired') issues.push('Licence expired');
  else if (e.licence === 'none') issues.push('No licence');
  else if (e.licence === 'pending') issues.push('Licence waiting for activation');
  if (e.signaturesOutdated) issues.push('Malware signatures out of date');
  if (e.policyApplied === false) issues.push('Policy not applied');
  const seen = e.lastSeenAt ? Date.parse(e.lastSeenAt) : NaN;
  if (Number.isFinite(seen) && now - seen > BITDEFENDER_STALE_DAYS * 86_400_000)
    issues.push(`Not seen for ${Math.floor((now - seen) / 86_400_000)} days`);
  if (e.detection && !e.infected) issues.push('Malware found and removed in the last 24 hours');
  if (e.productOutdated) issues.push('Agent out of date');
  return { health: e.infected ? 'infected' : issues.length ? 'attention' : 'protected', issues };
}
