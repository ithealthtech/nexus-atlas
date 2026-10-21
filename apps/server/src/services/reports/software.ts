import { and, asc, eq, inArray } from 'drizzle-orm';
import { schema } from '@atlas/db';
import type { DeviceSignIn, SoftwareFlag } from '@atlas/shared';
import { DeviceInventoryService } from '../device-inventory.js';
import { MAX_REPORT_ROWS, capped, newest, type Collector } from './context.js';

const FLAG_LABEL: Record<SoftwareFlag, string> = {
  end_of_life: 'End of life',
  unlicensed: 'Unlicensed',
  over_seats: 'Over seats',
};
type SignIn = Omit<DeviceSignIn, 'contactName'>;
const account = (u: SignIn) => (u.domain ? `${u.domain}\\${u.username}` : u.username);

/** Installed software (flagged the same way as a client's Software tab) and who signs in, from the RMM inventory. */
export const software: Collector = async (report) => {
  // The device inventory the RMM sync saved: never read is not the same as nothing installed.
  const devices = capped(
    await report.db
      .select({
        clientId: schema.rmmDeviceStatus.clientId,
        name: schema.assets.name,
        signIns: schema.rmmDeviceStatus.signIns,
        inventoryAt: schema.rmmDeviceStatus.inventoryAt,
      })
      .from(schema.rmmDeviceStatus)
      .innerJoin(schema.assets, eq(schema.assets.id, schema.rmmDeviceStatus.assetId))
      .where(
        and(
          eq(schema.rmmDeviceStatus.orgId, report.actor.orgId),
          inArray(schema.rmmDeviceStatus.clientId, report.definition.clientIds),
          eq(schema.assets.orgId, report.actor.orgId),
          eq(schema.assets.archived, false),
        ),
      )
      .orderBy(asc(schema.assets.name))
      .limit(MAX_REPORT_ROWS + 1),
  );
  const signInsOf = (d: (typeof devices)[number]) => (d.signIns ?? []) as SignIn[];
  const inventory = new DeviceInventoryService();
  const apps = new Map<string, Awaited<ReturnType<DeviceInventoryService['forClient']>>>();
  for (const c of report.clients) apps.set(c.id, await inventory.forClient(report.scope, c.id));
  const contactIds = [...new Set(devices.flatMap((d) => signInsOf(d).flatMap((u) => u.contactId ?? [])))];
  const contacts = new Map(
    contactIds.length
      ? (
          await report.db
            .select({ id: schema.contacts.id, name: schema.contacts.name })
            .from(schema.contacts)
            .where(
              and(
                eq(schema.contacts.orgId, report.actor.orgId),
                inArray(schema.contacts.clientId, report.definition.clientIds),
                inArray(schema.contacts.id, contactIds),
              ),
            )
        ).map((c) => [c.id, c.name])
      : [],
  );
  for (const c of report.clients) {
    const mine = devices.filter((d) => d.clientId === c.id);
    report.source(
      `RMM inventory: ${c.name}`,
      'Installed applications and sign-ins from the last RMM inventory. Flags use the client license records.',
      newest(mine.map((d) => d.inventoryAt)),
    );
    const missing = mine.filter((d) => !d.inventoryAt).length;
    if (!mine.length) report.warn(`${c.name}: no RMM devices are linked to this client.`);
    else if (missing)
      report.warn(`${c.name}: ${missing} of ${mine.length} devices have not reported software or sign-ins.`);
  }
  report.section(
    'Summary',
    ['Client', 'Devices reporting', 'Applications', 'End of life', 'Unlicensed', 'Over seats', 'Sign-in accounts'],
    report.clients.map((c) => {
      const theirs = apps.get(c.id) ?? [];
      const reporting = devices.filter((d) => d.clientId === c.id && d.inventoryAt);
      const accounts = new Set(
        reporting.flatMap((d) => signInsOf(d).map((u) => `${u.domain}\\${u.username}`.toLowerCase())),
      );
      const flagged = (flag: SoftwareFlag) => String(theirs.filter((a) => a.flag === flag).length);
      return [
        c.name,
        `${reporting.length} of ${devices.filter((d) => d.clientId === c.id).length}`,
        String(theirs.length),
        flagged('end_of_life'),
        flagged('unlicensed'),
        flagged('over_seats'),
        String(accounts.size),
      ];
    }),
  );
  // Flagged applications first, then the most installed, as on the client's Software tab.
  report.section(
    'Software',
    ['Client', 'Application', 'Publisher', 'Versions', 'Devices', 'Flag', 'Reason'],
    report.clients.flatMap((c) =>
      (apps.get(c.id) ?? []).map((a) => [
        c.name,
        a.name,
        a.publisher,
        a.versions.join(', '),
        String(a.devices),
        a.flag ? FLAG_LABEL[a.flag] : '',
        a.flagReason,
      ]),
    ),
  );
  report.section(
    'Sign-ins',
    ['Client', 'Device', 'Account', 'Contact', 'Last sign-in'],
    devices.flatMap((d) =>
      signInsOf(d).map((u) => [
        report.client(d.clientId),
        d.name,
        account(u),
        (u.contactId && contacts.get(u.contactId)) || '',
        u.lastLogonAt ?? 'Not reported',
      ]),
    ),
  );
};
