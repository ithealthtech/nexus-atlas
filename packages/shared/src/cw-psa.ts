import { z } from 'zod';

// ---------- ConnectWise PSA (Manage) ----------
/** The PSA site's address, as https://host: a bare host name gets https:// in front, and paths are dropped. */
export function psaSiteUrl(value: string): string | null {
  const raw = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'https:' && url.hostname.includes('.') && !url.username && !url.password
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

export const cwPsaConnectionSchema = z.object({
  site: z
    .string()
    .trim()
    .max(200)
    .refine((v) => psaSiteUrl(v) !== null, 'Enter the PSA site, such as api-na.myconnectwise.net.'),
  /** The company ID people sign in to PSA with. */
  companyId: z.string().trim().min(1, 'Enter the PSA company ID.').max(100),
  publicKey: z.string().trim().min(8, 'Enter the API member’s public key.').max(200),
  // Omitted keeps the saved key.
  privateKey: z.string().trim().min(8).max(200).optional(),
  /** The clientId ConnectWise's developer portal gives an integration. */
  clientId: z.string().trim().min(8, 'Enter the clientId from the ConnectWise developer portal.').max(200),
  autoSync: z.boolean().default(true),
});
export type CwPsaConnection = z.infer<typeof cwPsaConnectionSchema>;

/** What the PSA connection does. Each option that changes PSA is off by default. */
export const cwPsaOptionsSchema = z.object({
  /**
   * Lets client accounts (and staff) open PSA service tickets for a linked client from Atlas, and read and answer
   * the notes PSA shows to the customer.
   */
  portalTickets: z.boolean().default(false),
  /** The service board portal tickets go on, by name. Required for portal tickets. */
  portalTicketBoard: z.string().trim().max(100).default(''),
});
export type CwPsaOptions = z.infer<typeof cwPsaOptionsSchema>;

export interface CwPsaView {
  site: string;
  companyId: string;
  publicKey: string;
  clientId: string;
  hasPrivateKey: boolean;
  autoSync: boolean;
  lastSyncAt: string | null;
  options: CwPsaOptions;
}
