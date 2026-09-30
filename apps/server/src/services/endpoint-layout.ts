import { and, asc, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';

/** The one layout for PCs, Macs, Linux workstations and servers, which Hudu and ConnectWise RMM both import into. */
export const ENDPOINTS = 'Endpoints';
export const ENDPOINTS_DESCRIPTION = 'Any PC, Mac, Linux workstation or server.';
export const ENDPOINTS_ICON = 'monitor-smartphone';

// Names that mean the same layout: Atlas's "Devices", Hudu's "Computer Assets", "Endpoints", and the like.
const ENDPOINT_NAME = /^(managed |rmm )?(devices?|endpoints?|computers?|workstations?)( assets?)?$/;
const DEVICE_NAME = /^(managed |rmm )?devices?( assets?)?$/;

export const isEndpointName = (name: string) => ENDPOINT_NAME.test(name.trim().toLowerCase());

/**
 * The organization's endpoint layout, renamed to Endpoints if it isn't already, or null when there is none.
 * Configurations and archived layouts don't count. One already named Endpoints comes first, then one named for
 * devices, then the oldest other match (such as an earlier import's "Computer Assets").
 */
export async function endpointLayout(db: Database, orgId: string): Promise<string | null> {
  const layouts = (
    await db
      .select({
        id: schema.assetLayouts.id,
        key: schema.assetLayouts.key,
        name: schema.assetLayouts.name,
      })
      .from(schema.assetLayouts)
      .where(and(eq(schema.assetLayouts.orgId, orgId), eq(schema.assetLayouts.archived, false)))
      .orderBy(asc(schema.assetLayouts.createdAt))
  ).filter((l) => l.key !== 'configuration' && (isEndpointName(l.name) || isEndpointName(l.key)));
  const lower = (s: string) => s.trim().toLowerCase();
  const picked =
    layouts.find((l) => lower(l.name) === lower(ENDPOINTS)) ??
    layouts.find((l) => DEVICE_NAME.test(lower(l.name)) || DEVICE_NAME.test(l.key)) ??
    layouts[0];
  if (!picked) return null;
  if (picked.name !== ENDPOINTS)
    await db
      .update(schema.assetLayouts)
      .set({ name: ENDPOINTS, description: ENDPOINTS_DESCRIPTION, updatedAt: new Date() })
      .where(eq(schema.assetLayouts.id, picked.id));
  return picked.id;
}
