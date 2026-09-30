import { and, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { ClientSoftware, DeviceInventory, DeviceSignIn, DeviceSoftware } from '@atlas/shared';
import { requireItem } from './items.js';
import type { Scope } from './scope.js';
import { licensedFamily, softwareFlagger, type LicenseRecord } from './software-rules.js';

type StoredApp = Omit<DeviceSoftware, 'flag' | 'flagReason'>;
type StoredSignIn = Omit<DeviceSignIn, 'contactName'>;

/** Installed software and sign-ins the RMM sync saved, with software flagged against the client's license records. */
export class DeviceInventoryService {
  /** One device's inventory; null when the RMM has never reported on it. */
  async forAsset(scope: Scope, assetId: string): Promise<DeviceInventory | null> {
    const asset = await requireItem(scope, 'asset', assetId, 'read');
    const [row] = await scope.db
      .select({
        software: schema.rmmDeviceStatus.software,
        signIns: schema.rmmDeviceStatus.signIns,
        inventoryAt: schema.rmmDeviceStatus.inventoryAt,
      })
      .from(schema.rmmDeviceStatus)
      .where(and(eq(schema.rmmDeviceStatus.orgId, scope.actor.orgId), eq(schema.rmmDeviceStatus.assetId, assetId)));
    // Never read (switched off, or ConnectWise wouldn't say) is not the same as nothing installed.
    if (!row?.inventoryAt) return null;
    const flag = await this.flagger(scope, asset.clientId!);
    const signIns = (row.signIns ?? []) as StoredSignIn[];
    const ids = signIns.flatMap((u) => (u.contactId ? [u.contactId] : []));
    const names = new Map(
      ids.length
        ? (
            await scope.db
              .select({ id: schema.contacts.id, name: schema.contacts.name })
              .from(schema.contacts)
              .where(and(eq(schema.contacts.clientId, asset.clientId!), inArray(schema.contacts.id, ids)))
          ).map((c) => [c.id, c.name])
        : [],
    );
    return {
      software: row.software ? (row.software as StoredApp[]).map((a) => ({ ...a, ...flag(a.name) })) : null,
      signIns: row.signIns
        ? signIns.map((u) => {
            // A contact deleted since the sync is no longer named.
            const contactName = (u.contactId && names.get(u.contactId)) || null;
            return { ...u, contactId: contactName ? u.contactId : null, contactName };
          })
        : null,
      updatedAt: row.inventoryAt.toISOString(),
    };
  }

  /** Every application across the client's devices, flagged ones first, then the most installed. */
  async forClient(scope: Scope, clientId: string): Promise<ClientSoftware[]> {
    await scope.require(clientId, 'read', 'Client');
    const flag = await this.flagger(scope, clientId);
    const byName = new Map<string, ClientSoftware & { seen: Set<string> }>();
    for (const row of await this.softwareRows(scope, clientId)) {
      for (const a of (row.software ?? []) as StoredApp[]) {
        const key = a.name.toLowerCase();
        let entry = byName.get(key);
        if (!entry)
          byName.set(
            key,
            (entry = {
              name: a.name,
              publisher: a.publisher,
              versions: [],
              devices: 0,
              ...flag(a.name),
              seen: new Set(),
            }),
          );
        if (a.version && !entry.versions.includes(a.version)) entry.versions.push(a.version);
        if (!entry.seen.has(row.assetId)) {
          entry.seen.add(row.assetId);
          entry.devices++;
        }
      }
    }
    return [...byName.values()]
      .map(({ seen: _seen, ...entry }) => ({ ...entry, versions: entry.versions.sort().slice(0, 20) }))
      .sort((a, b) => Number(!a.flag) - Number(!b.flag) || b.devices - a.devices || a.name.localeCompare(b.name));
  }

  private softwareRows(scope: Scope, clientId: string) {
    return scope.db
      .select({ assetId: schema.rmmDeviceStatus.assetId, software: schema.rmmDeviceStatus.software })
      .from(schema.rmmDeviceStatus)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.rmmDeviceStatus.assetId))
      .where(
        and(
          eq(schema.rmmDeviceStatus.orgId, scope.actor.orgId),
          eq(schema.rmmDeviceStatus.clientId, clientId),
          eq(schema.assets.archived, false),
        ),
      );
  }

  /**
   * Flags applications for this client: its license records are the non-archived assets in the Licenses layout (by
   * name, product, and vendor), and seats are checked against how many of its devices have each paid product.
   */
  private async flagger(scope: Scope, clientId: string) {
    const rows = await scope.db
      .select({ name: schema.assets.name, fields: schema.assets.fields })
      .from(schema.assets)
      .innerJoin(schema.assetLayouts, eq(schema.assetLayouts.id, schema.assets.layoutId))
      .where(
        and(
          eq(schema.assets.orgId, scope.actor.orgId),
          eq(schema.assets.clientId, clientId),
          eq(schema.assets.archived, false),
          eq(schema.assetLayouts.key, 'license'),
        ),
      );
    const licenses: LicenseRecord[] = rows.map((r) => {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      const seats = Number(f.seats);
      return {
        text: [r.name, f.product, f.vendor].filter((v) => typeof v === 'string').join(' '),
        seats: f.seats !== undefined && f.seats !== null && f.seats !== '' && Number.isFinite(seats) ? seats : null,
      };
    });
    const installs = new Map<string, number>();
    for (const row of await this.softwareRows(scope, clientId)) {
      const families = new Set(
        ((row.software ?? []) as StoredApp[]).flatMap((a) => licensedFamily(a.name)?.family ?? []),
      );
      for (const family of families) installs.set(family, (installs.get(family) ?? 0) + 1);
    }
    return softwareFlagger(licenses, installs);
  }
}
