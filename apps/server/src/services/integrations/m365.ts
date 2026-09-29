import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { schema, type Database } from '@atlas/db';
import {
  m365SyncOptionsSchema,
  type Actor,
  type ContactView,
  type LayoutField,
  type M365SyncOptions,
  type M365TenantLink,
} from '@atlas/shared';
import { HttpError } from '../../errors.js';
import { AssetService } from '../assets.js';
import type { ImportRun } from '../importers/common.js';
import { LayoutService } from '../layouts.js';
import { contacts } from '../people.js';
import { Scope } from '../scope.js';
import type { StoredM365 } from '../settings.js';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const SOURCE_NOTE = 'Synced from Microsoft 365.';
type Json = Record<string, unknown>;

/** Sign-in errors people hit when setting up a multi-tenant app, and what to do about each. */
const TOKEN_HINTS: [RegExp, string][] = [
  [/AADSTS7000215/, 'The client secret is wrong. Paste the secret’s Value, not its Secret ID.'],
  [/AADSTS7000222/, 'The client secret has expired. Create a new one in the app registration and save it here.'],
  [
    /AADSTS700016|AADSTS650051|AADSTS65001|AADSTS7000229/,
    'This tenant hasn’t granted consent to the app yet. Open the consent link as one of its Global Administrators.',
  ],
  [/AADSTS90002|AADSTS900023|AADSTS90072/, 'Microsoft doesn’t know that tenant. Check the tenant ID or domain.'],
  [/AADSTS700027|AADSTS50194/, 'The app isn’t multi-tenant. Set Supported account types to “Multiple Entra ID tenants”.'],
];

/** Friendly names for the subscriptions MSPs see most; anything else shows its part number. */
const SKU_NAMES: Record<string, string> = {
  O365_BUSINESS_ESSENTIALS: 'Microsoft 365 Business Basic',
  O365_BUSINESS_PREMIUM: 'Microsoft 365 Business Standard',
  SPB: 'Microsoft 365 Business Premium',
  O365_BUSINESS: 'Microsoft 365 Apps for business',
  OFFICESUBSCRIPTION: 'Microsoft 365 Apps for enterprise',
  SPE_E3: 'Microsoft 365 E3',
  SPE_E5: 'Microsoft 365 E5',
  SPE_F1: 'Microsoft 365 F3',
  STANDARDPACK: 'Office 365 E1',
  ENTERPRISEPACK: 'Office 365 E3',
  ENTERPRISEPREMIUM: 'Office 365 E5',
  EXCHANGESTANDARD: 'Exchange Online (Plan 1)',
  EXCHANGEENTERPRISE: 'Exchange Online (Plan 2)',
  EXCHANGEARCHIVE_ADDON: 'Exchange Online Archiving',
  AAD_PREMIUM: 'Microsoft Entra ID P1',
  AAD_PREMIUM_P2: 'Microsoft Entra ID P2',
  EMS: 'Enterprise Mobility + Security E3',
  EMSPREMIUM: 'Enterprise Mobility + Security E5',
  INTUNE_A: 'Microsoft Intune Plan 1',
  ATP_ENTERPRISE: 'Microsoft Defender for Office 365 (Plan 1)',
  THREAT_INTELLIGENCE: 'Microsoft Defender for Office 365 (Plan 2)',
  MDATP_XPLAT: 'Microsoft Defender for Endpoint P2',
  DEFENDER_ENDPOINT_P1: 'Microsoft Defender for Endpoint P1',
  POWER_BI_PRO: 'Power BI Pro',
  VISIOCLIENT: 'Visio Plan 2',
  PROJECTPROFESSIONAL: 'Project Plan 3',
  MCOEV: 'Microsoft Teams Phone Standard',
  MCOPSTN1: 'Microsoft Teams Domestic Calling Plan',
  Microsoft_365_Copilot: 'Microsoft 365 Copilot',
  Microsoft_Teams_Premium: 'Microsoft Teams Premium',
};
const skuName = (part: string) => SKU_NAMES[part] ?? part.replace(/_/g, ' ');

export interface M365Snapshot {
  tenantId: string;
  name: string;
  defaultDomain: string;
  domains: { name: string; isDefault: boolean; initial: boolean }[];
  skus: { id: string; part: string; name: string; enabled: number; assigned: number; status: string }[];
  users: {
    id: string;
    name: string;
    upn: string;
    email: string;
    title: string;
    phone: string;
    mobile: string;
    enabled: boolean;
    member: boolean;
    skuIds: string[];
  }[];
  /** Role name → member user IDs. */
  roles: { name: string; members: string[] }[];
}

/** Microsoft Graph, as the MSP's multi-tenant app, signed in to one client tenant at a time. */
export class M365Client {
  private tokens = new Map<string, { token: string; expires: number }>();

  constructor(
    private readonly appId: string,
    private readonly secret: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  private async token(tenant: string) {
    const key = `${tenant}|${createHash('sha256').update(this.secret).digest('hex').slice(0, 16)}`;
    const cached = this.tokens.get(key);
    if (cached && cached.expires > Date.now() + 60_000) return cached.token;
    let res: Response;
    try {
      res = await this.fetcher(
        `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/oauth2/v2.0/token`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: this.appId,
            client_secret: this.secret,
            scope: 'https://graph.microsoft.com/.default',
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
    } catch {
      throw new HttpError(502, 'Microsoft could not be reached from this server.');
    }
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      const said = body.error_description ?? '';
      const hint = TOKEN_HINTS.find(([pattern]) => pattern.test(said))?.[1];
      throw new HttpError(400, hint ?? `Microsoft refused the sign-in: ${said.split('\r\n')[0]?.slice(0, 200) || res.status}`);
    }
    this.tokens.set(key, { token: body.access_token, expires: Date.now() + (body.expires_in ?? 3600) * 1000 });
    return body.access_token;
  }

  /** Every item of a Graph collection, following @odata.nextLink. */
  private async all(tenant: string, path: string, max = 20_000): Promise<Json[]> {
    const token = await this.token(tenant);
    const out: Json[] = [];
    let url: string | undefined = `${GRAPH}${path}`;
    while (url && out.length < max) {
      // Only follow links back to Graph itself.
      if (!url.startsWith(`${GRAPH}/`)) break;
      let res: Response;
      try {
        res = await this.fetcher(url, {
          headers: { authorization: `Bearer ${token}`, consistencylevel: 'eventual' },
          signal: AbortSignal.timeout(30_000),
        });
      } catch {
        throw new HttpError(502, 'Microsoft Graph could not be reached from this server.');
      }
      if (res.status === 403 || res.status === 401)
        throw new HttpError(
          400,
          'The app can’t read this tenant’s directory. Give it the Directory.Read.All application permission, then grant consent in the tenant again.',
        );
      if (!res.ok) throw new HttpError(502, `Microsoft Graph answered ${res.status} for ${path.split('?')[0]}.`);
      const body = (await res.json()) as { value?: Json[]; '@odata.nextLink'?: string };
      out.push(...(body.value ?? []));
      url = body['@odata.nextLink'];
    }
    return out;
  }

  /** Signs in to the tenant and reads its name; used to check a link. */
  async check(tenant: string): Promise<{ tenantId: string; name: string }> {
    const [org] = await this.all(tenant, '/organization?$select=id,displayName');
    if (!org) throw new HttpError(400, 'Microsoft returned no organization for that tenant.');
    return { tenantId: String(org.id), name: String(org.displayName ?? '') };
  }

  async snapshot(tenant: string, options: M365SyncOptions): Promise<M365Snapshot> {
    const [org] = await this.all(tenant, '/organization?$select=id,displayName,verifiedDomains');
    if (!org) throw new HttpError(400, 'Microsoft returned no organization for that tenant.');
    const domains = ((org.verifiedDomains as Json[] | undefined) ?? []).map((d) => ({
      name: String(d.name ?? '').toLowerCase(),
      isDefault: !!d.isDefault,
      initial: !!d.isInitial,
    }));
    const skus = (await this.all(tenant, '/subscribedSkus')).map((s) => {
      const part = String(s.skuPartNumber ?? '');
      const prepaid = (s.prepaidUnits as Json | undefined) ?? {};
      return {
        id: String(s.skuId ?? ''),
        part,
        name: skuName(part),
        enabled: Number(prepaid.enabled ?? 0),
        assigned: Number(s.consumedUnits ?? 0),
        status: String(s.capabilityStatus ?? ''),
      };
    });
    const users = options.users
      ? (
          await this.all(
            tenant,
            '/users?$select=id,displayName,userPrincipalName,mail,jobTitle,businessPhones,mobilePhone,accountEnabled,assignedLicenses,userType&$top=999',
          )
        ).map((u) => ({
          id: String(u.id),
          name: String(u.displayName ?? u.userPrincipalName ?? ''),
          upn: String(u.userPrincipalName ?? '').toLowerCase(),
          email: String(u.mail ?? '').toLowerCase(),
          title: String(u.jobTitle ?? ''),
          phone: String(((u.businessPhones as string[] | undefined) ?? [])[0] ?? ''),
          mobile: String(u.mobilePhone ?? ''),
          enabled: u.accountEnabled !== false,
          member: u.userType !== 'Guest',
          skuIds: ((u.assignedLicenses as Json[] | undefined) ?? []).map((l) => String(l.skuId)),
        }))
      : [];
    const roles = (await this.all(tenant, '/directoryRoles?$expand=members($select=id)'))
      .map((r) => ({
        name: String(r.displayName ?? ''),
        members: ((r.members as Json[] | undefined) ?? []).map((m) => String(m.id)),
      }))
      .filter((r) => r.members.length);
    return {
      tenantId: String(org.id),
      name: String(org.displayName ?? ''),
      defaultDomain: domains.find((d) => d.isDefault)?.name ?? domains[0]?.name ?? '',
      domains,
      skus,
      users,
      roles,
    };
  }
}

/** Where a tenant's Global Administrator grants the app access to that tenant. */
export function consentUrl(appId: string, tenant: string, redirectUri: string, clientId: string) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: redirectUri, state: clientId });
  return `https://login.microsoftonline.com/${encodeURIComponent(tenant)}/adminconsent?${q}`;
}

export function tenantLinks(
  saved: StoredM365,
  clients: { id: string; name: string }[],
  redirectUri: string,
): M365TenantLink[] {
  const names = new Map(clients.map((c) => [c.id, c.name]));
  return Object.entries(saved.tenants)
    .filter(([clientId]) => names.has(clientId))
    .map(([clientId, t]) => ({
      clientId,
      clientName: names.get(clientId)!,
      tenantId: t.tenantId,
      tenantName: t.tenantName,
      status: t.status,
      detail: t.detail,
      checkedAt: t.checkedAt,
      consentUrl: consentUrl(saved.clientId, t.tenantId, redirectUri, clientId),
    }))
    .sort((a, b) => a.clientName.localeCompare(b.clientName));
}

const TENANT_FIELDS: LayoutField[] = [
  ['tenant_id', 'Tenant ID', 'text', true],
  ['default_domain', 'Default domain', 'text', true],
  ['domains', 'Domains', 'textarea', false],
  ['subscriptions', 'Subscriptions', 'textarea', false],
  ['users', 'Licensed users', 'number', true],
  ['global_admins', 'Global administrators', 'textarea', false],
  ['admin_roles', 'Other admin roles', 'textarea', false],
].map(([key, label, type, showInList]) => ({
  key: key as string,
  label: label as string,
  type: type as LayoutField['type'],
  required: false,
  options: [],
  help: 'Kept up to date by the Microsoft 365 sync.',
  showInList: showInList as boolean,
  expires: false,
}));

/** Finds a layout by key, creating the Microsoft 365 tenant layout when it's missing. Adds missing fields. */
async function layoutWith(
  db: Database,
  layouts: LayoutService,
  actor: Actor,
  key: string,
  fields: LayoutField[],
  create?: { name: string; icon: string; description: string },
): Promise<{ id: string; fields: LayoutField[] }> {
  const [row] = await db
    .select()
    .from(schema.assetLayouts)
    .where(and(eq(schema.assetLayouts.orgId, actor.orgId), eq(schema.assetLayouts.key, key)));
  if (!row) {
    if (!create) throw new HttpError(400, `The ${key} asset layout is missing.`);
    const made = await layouts.create(actor, { ...create, fields });
    await db.update(schema.assetLayouts).set({ key }).where(eq(schema.assetLayouts.id, made.id));
    return { id: made.id, fields };
  }
  if (row.archived) await layouts.update(actor, row.id, { archived: false });
  const current = row.fields as LayoutField[];
  const missing = fields.filter((f) => !current.some((c) => c.key === f.key));
  if (!missing.length) return { id: row.id, fields: current };
  const next = [...current, ...missing];
  await layouts.update(actor, row.id, { fields: next });
  return { id: row.id, fields: next };
}

/**
 * Syncs each linked client's tenant: a Microsoft 365 tenant asset (domains, subscriptions, admins), a License
 * asset per paid subscription, a Domain asset per custom domain, and a contact per user. Atlas edits to other
 * fields are kept; contacts that already exist (by email) are updated rather than duplicated.
 */
export async function runM365Sync(
  db: Database,
  actor: Actor,
  client: M365Client,
  run: ImportRun,
  saved: StoredM365,
  onTenant: (clientId: string, result: { ok: boolean; name?: string; detail?: string }) => Promise<void>,
) {
  const options = m365SyncOptionsSchema.parse(saved.options ?? {});
  const scope = new Scope(db, actor);
  const layouts = new LayoutService(db);
  const assets = new AssetService(layouts);
  const linked = Object.entries(saved.tenants);
  if (!linked.length) run.note('No clients are linked to a Microsoft 365 tenant yet.');

  const tenantLayout = await layoutWith(db, layouts, actor, 'm365_tenant', TENANT_FIELDS, {
    name: 'Microsoft 365',
    icon: 'mail',
    description: 'The client’s Microsoft 365 tenant: domains, subscriptions, and administrators.',
  });
  const licenseLayout = options.licenses
    ? await layoutWith(db, layouts, actor, 'license', [
        {
          key: 'assigned',
          label: 'Assigned',
          type: 'number',
          required: false,
          options: [],
          help: 'Seats in use. Kept up to date by the Microsoft 365 sync.',
          showInList: true,
          expires: false,
        },
      ])
    : null;
  const domainLayout = options.domains ? await layoutWith(db, layouts, actor, 'domain', []) : null;

  /** Creates or refreshes an asset; a same-named asset of the layout already in the client is taken over. */
  const upsertAsset = async (
    clientId: string,
    kind: string,
    externalId: string,
    layout: { id: string },
    name: string,
    fields: Record<string, string>,
  ) => {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ''));
    return run.upsert(
      kind,
      externalId,
      name,
      async () => {
        const [same] = await db
          .select({ id: schema.assets.id })
          .from(schema.assets)
          .where(
            and(
              eq(schema.assets.clientId, clientId),
              eq(schema.assets.layoutId, layout.id),
              eq(schema.assets.name, name),
            ),
          );
        if (same) {
          await refresh(same.id, name, clean);
          return same.id;
        }
        return (await assets.create(scope, clientId, { layoutId: layout.id, name, fields: clean, notes: SOURCE_NOTE }))
          .id;
      },
      (id) => refresh(id, name, clean),
    );
  };
  const refresh = async (id: string, name: string, fields: Record<string, string>) => {
    const current = await assets.get(scope, id);
    if (current.archived) await assets.setArchived(scope, id, false);
    const merged = { ...current.fields, ...fields };
    if (current.name !== name || JSON.stringify(merged) !== JSON.stringify(current.fields))
      await assets.update(scope, id, { name, fields: merged, version: current.version }, 'Synced from Microsoft 365');
  };

  for (const [clientId, link] of linked) {
    let snap: M365Snapshot;
    try {
      snap = await client.snapshot(link.tenantId, options);
    } catch (error) {
      const detail = error instanceof HttpError ? error.message : 'The tenant could not be read.';
      run.count('tenants', 'failed');
      run.note(`${link.tenantName ?? link.tenantId}: ${detail}`);
      await onTenant(clientId, { ok: false, detail });
      continue;
    }
    await onTenant(clientId, { ok: true, name: snap.name });

    const userName = new Map(snap.users.map((u) => [u.id, u.upn || u.name]));
    const skuById = new Map(snap.skus.map((s) => [s.id, s]));
    const paid = snap.skus.filter((s) => s.enabled > 0 && s.enabled < 10_000 && s.status !== 'Deleted');
    const admins = snap.roles.find((r) => r.name === 'Global Administrator')?.members ?? [];
    const licensed = snap.users.filter((u) => u.enabled && u.member && u.skuIds.length);
    await upsertAsset(clientId, 'tenants', snap.tenantId, tenantLayout, `Microsoft 365: ${snap.name || snap.defaultDomain}`, {
      tenant_id: snap.tenantId,
      default_domain: snap.defaultDomain,
      domains: snap.domains.map((d) => d.name).join('\n'),
      subscriptions: paid.map((s) => `${s.name}: ${s.assigned} of ${s.enabled}`).join('\n'),
      users: options.users ? String(licensed.length) : '',
      global_admins: admins.map((id) => userName.get(id) ?? id).join('\n'),
      admin_roles: snap.roles
        .filter((r) => r.name !== 'Global Administrator')
        .map((r) => `${r.name}: ${r.members.map((id) => userName.get(id) ?? id).join(', ')}`)
        .join('\n'),
    });

    if (licenseLayout)
      for (const s of paid)
        await upsertAsset(clientId, 'licenses', `${snap.tenantId}:${s.id}`, licenseLayout, s.name, {
          product: s.name,
          vendor: 'Microsoft',
          seats: String(s.enabled),
          assigned: String(s.assigned),
        });

    if (domainLayout)
      for (const d of snap.domains.filter((x) => !x.initial))
        await upsertAsset(clientId, 'domains', `${snap.tenantId}:${d.name}`, domainLayout, d.name, {});

    if (options.users) {
      const existing = await contacts.list(scope, clientId);
      const byEmail = new Map(existing.filter((c) => c.email).map((c) => [c.email.toLowerCase(), c]));
      const people = options.licensedOnly ? licensed : snap.users.filter((u) => u.member);
      for (const u of people) {
        const roles = snap.roles.filter((r) => r.members.includes(u.id)).map((r) => r.name);
        const licenses = u.skuIds.map((id) => skuById.get(id)?.name).filter(Boolean);
        const summary = [
          `Microsoft 365: ${u.upn}${u.enabled ? '' : ' (sign-in blocked)'}`,
          licenses.length ? `Licenses: ${licenses.join(', ')}` : 'No license',
          ...(roles.length ? [`Admin roles: ${roles.join(', ')}`] : []),
        ].join('\n');
        const email = u.email || u.upn;
        const body = (current?: ContactView) => ({
          name: u.name.slice(0, 120) || email,
          title: (u.title || current?.title || '').slice(0, 120),
          email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email.slice(0, 254) : (current?.email ?? ''),
          phone: (u.phone || current?.phone || '').slice(0, 40),
          mobile: (u.mobile || current?.mobile || '').slice(0, 40),
          // The sync's summary is kept at the top of the notes; anything written below it stays.
          notes: [summary, (current?.notes ?? '').replace(/^Microsoft 365: [\s\S]*?(?:\n\n|$)/, '')]
            .filter(Boolean)
            .join('\n\n')
            .slice(0, 5000),
          primary: current?.primary ?? false,
        });
        await run.upsert(
          'contacts',
          `${snap.tenantId}:${u.id}`,
          u.name,
          async () => {
            const same = byEmail.get(email);
            if (same) {
              await contacts.update(scope, same.id, body(same));
              return same.id;
            }
            return (await contacts.create(scope, clientId, body())).id;
          },
          async (id) => {
            const current = existing.find((c) => c.id === id);
            if (!current) throw new HttpError(404, 'gone');
            await contacts.update(scope, id, body(current));
          },
        );
      }
    }
  }
}
