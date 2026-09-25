// In-browser stand-in for the Atlas API, used only by the clickable demo build.
// State lives in memory: reloading the page starts over with the sample data.
import {
  DEFAULT_BRANDING,
  LEVEL_INFO,
  ROLE_INFO,
  guessPasswordCategory,
  passwordStrength,
  type PasswordCategory,
  type AccessLevel,
  type ActivityView,
  type ApiKeyView,
  type BackupRunView,
  type SystemStatus,
  type Branding,
  type CsvImportResult,
  type ImportJobView,
  type ExpirationItem,
  type ItemType,
  type LayoutField,
  type RichText,
  type Role,
  type SessionStage,
} from '@atlas/shared';
import { relativeTime } from '@/lib/format';
import { ago, daysFromNow, seed, uuid } from './seed';

type Json = Record<string, unknown>;
export class MockError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string,
  ) {
    super(message);
  }
}

const db = seed();
const now = () => new Date().toISOString();
const clientName = (id: string | null) => db.clients.find((c) => c.id === id)?.name ?? null;
const layoutOf = (id: string) => db.layouts.find((l) => l.id === id)!;
const today = () => new Date().toISOString().slice(0, 10);
const daysUntil = (d: string) =>
  Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today()}T00:00:00Z`)) / 86_400_000);

// ---------- session ----------
let stage: SessionStage | null = null;
const methods = { totp: true, passkey: true };
const actor = () => ({
  id: db.owner.id,
  orgId: db.orgId,
  name: db.owner.name,
  email: db.owner.email,
  role: 'owner' as Role,
  mfa: true,
  allClients: 'edit_passwords' as AccessLevel,
});
const sessionView = () => ({
  actor: actor(),
  csrf: 'demo',
  stage: stage!,
  organization: { id: db.orgId, name: 'IT Done Right' },
  ...(stage === 'mfa' ? { methods } : {}),
});

// ---------- versions, activity, events ----------
type Versioned = { version: number; updatedAt: string; updatedByName: string | null; archived: boolean };
const meta = (): Versioned => ({
  version: 1,
  updatedAt: ago(60 * 24 * 3),
  updatedByName: db.owner.name,
  archived: false,
});
const revisions = new Map<string, { version: number; authorName: string; createdAt: string; snapshot: Json }[]>();
const snapshot = (id: string, version: number, data: Json) => {
  const list = revisions.get(id) ?? [];
  list.push({ version, authorName: db.owner.name, createdAt: now(), snapshot: structuredClone(data) });
  revisions.set(id, list);
};

const activity: ActivityView[] = [];
const record = (action: string, entityType: string, entityId: string | null, title: string, clientId: string | null) =>
  activity.unshift({
    id: uuid(),
    clientId,
    clientName: clientName(clientId),
    actorName: db.owner.name,
    action,
    entityType,
    entityId,
    title,
    createdAt: now(),
  });
const event = (action: string, detail = '') =>
  db.events.unshift({
    id: String(Number(db.events[0]?.id ?? 100) + 1),
    actor: db.owner.name,
    action,
    detail,
    ip: '203.0.113.24',
    createdAt: now(),
  });

// ---------- documentation ----------
const assets = db.assets.map((a) => ({ ...a, ...meta() }));
const documents = db.documents.map((d) => ({ ...d, ...meta() }));
const folders: { id: string; clientId: string | null; name: string }[] = [];
const contacts = [...db.contacts];
const locations = [...db.locations];
const relations: { id: string; a: { type: ItemType; id: string }; b: { type: ItemType; id: string }; note: string }[] =
  [];
// Sample links: a password named after an asset ("HDG-FW-01 admin") is linked to it.
for (const p of db.passwords)
  for (const a of db.assets)
    if (a.clientId === p.clientId && p.name.startsWith(`${a.name} `))
      relations.push({ id: uuid(), a: { type: 'asset', id: a.id }, b: { type: 'password', id: p.id }, note: '' });
for (const a of assets) snapshot(a.id, 1, a as unknown as Json);
for (const d of documents) snapshot(d.id, 1, d as unknown as Json);
for (const a of assets.slice(0, 4)) record('Updated', 'asset', a.id, a.name, a.clientId);
record('Created', 'document', documents[0]!.id, documents[0]!.title, documents[0]!.clientId);

const assetView = (a: (typeof assets)[0]) => {
  const l = layoutOf(a.layoutId);
  return { ...a, clientName: clientName(a.clientId)!, layoutName: l.name, layoutIcon: l.icon };
};
const docSummary = (d: (typeof documents)[0]) => {
  const { content: _content, ...rest } = d;
  return { ...rest, clientName: clientName(d.clientId) };
};

// ---------- vault ----------
const passwords = db.passwords.map((p) => ({ ...p, ...meta(), updatedAt: p.changedAt }));
const history = new Map<string, { id: string; secret: string; changedByName: string; createdAt: string }[]>();
const access = new Map<string, { userIds: string[]; groupIds: string[] }>();
const shares: {
  id: string;
  passwordId: string;
  token: string;
  ciphertext: string;
  maxViews: number;
  views: number;
  expiresAt: string;
  revoked: boolean;
  createdByName: string;
  createdAt: string;
}[] = [];
const vaultAudit: Json[] = [];
const rotationDue = (p: (typeof passwords)[0]) =>
  p.rotationDays ? new Date(Date.parse(p.changedAt) + p.rotationDays * 86_400_000).toISOString().slice(0, 10) : null;
// Personal to the demo user: their stars and when they last used each password.
const favorites = new Set<string>();
const lastUsed = new Map<string, string>();
const passwordView = (p: (typeof passwords)[0]) => ({
  favorite: favorites.has(p.id),
  lastUsedAt: lastUsed.get(p.id) ?? null,
  id: p.id,
  clientId: p.clientId,
  clientName: clientName(p.clientId)!,
  kind: p.kind,
  name: p.name,
  username: p.username,
  url: p.url,
  hasNotes: !!p.notes,
  hasTotp: p.totp,
  strength: passwordStrength(p.secret),
  reused: 0,
  rotationDays: p.rotationDays,
  changedAt: p.changedAt,
  rotationDue: rotationDue(p),
  restricted: p.restricted,
  clientVisible: p.clientVisible,
  version: p.version,
  archived: p.archived,
  updatedAt: p.updatedAt,
  updatedByName: p.updatedByName,
  requireReason: !!db.clients.find((c) => c.id === p.clientId)?.requireRevealReason,
  ...(() => {
    const chosen = (p as { category?: PasswordCategory | null }).category ?? null;
    return {
      category: chosen ?? guessPasswordCategory(p.name, p.username, p.url),
      categoryGuessed: !chosen,
    };
  })(),
  linkedAssets: relations
    .filter((r) => (r.a.type === 'password' && r.a.id === p.id) || (r.b.type === 'password' && r.b.id === p.id))
    .map((r) => (r.a.type === 'asset' ? r.a.id : r.b.type === 'asset' ? r.b.id : null))
    .map((id) => assets.find((a) => a.id === id && !a.archived))
    .filter((a) => !!a)
    .map((a) => ({ id: a.id, name: a.name })),
});
const audit = (p: (typeof passwords)[0], action: string, reason = '') =>
  vaultAudit.unshift({
    id: uuid(),
    passwordId: p.id,
    passwordName: p.name,
    clientName: clientName(p.clientId),
    actorName: db.owner.name,
    action,
    reason,
    ip: '203.0.113.24',
    createdAt: now(),
  });

// ---------- admin ----------
const users = db.users.map((u) => ({
  ...u,
  disabled: false,
  locked: false,
  mustChangePassword: false,
  createdAt: ago(60 * 24 * 120),
}));
const groups = [...db.groups];
let smtp = {
  enabled: true,
  method: 'graph',
  tenantId: 'itdoneright.onmicrosoft.com',
  clientId: '3f2b8c1e-5d4a-4e7b-9c6d-0a1b2c3d4e5f',
  hasClientSecret: true,
  preset: 'm365',
  host: 'smtp.office365.com',
  port: 587,
  security: 'starttls',
  username: 'atlas@itdoneright.demo',
  hasPassword: true,
  fromAddress: 'atlas@itdoneright.demo',
  fromName: 'IT Done Right',
};
let notifications = { alertDays: [30, 14, 7], weeklyDigest: true, auditRetentionDays: 365 as number | null };
const passkeys = [
  { id: 'demo-passkey-1', name: 'Office laptop', createdAt: ago(60 * 24 * 10), lastUsedAt: ago(60 * 5) },
];
let recoveryLeft = 10;
let notifyDigest = true;
const sessions = [
  {
    id: uuid(),
    current: true,
    ip: '203.0.113.24',
    userAgent: navigator.userAgent,
    createdAt: ago(3),
    lastSeenAt: now(),
  },
  {
    id: uuid(),
    current: false,
    ip: '198.51.100.7',
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Safari/605.1.15',
    createdAt: ago(60 * 20),
    lastSeenAt: ago(60 * 3),
  },
];
const devices = [
  {
    id: uuid(),
    userAgent: navigator.userAgent,
    ip: '203.0.113.24',
    createdAt: ago(60 * 24 * 4),
    expiresAt: new Date(Date.now() + 26 * 86_400_000).toISOString(),
  },
];
const codes = () =>
  Array.from({ length: 10 }, () => {
    const raw = Array.from(
      crypto.getRandomValues(new Uint8Array(10)),
      (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31],
    ).join('');
    return `${raw.slice(0, 5)}-${raw.slice(5)}`;
  });

function expirations(days: number): ExpirationItem[] {
  const cutoff = daysFromNow(days);
  const items: ExpirationItem[] = [];
  for (const a of assets.filter((x) => !x.archived)) {
    const l = layoutOf(a.layoutId);
    for (const f of l.fields as LayoutField[]) {
      const v = a.fields[f.key];
      if (f.expires && typeof v === 'string' && v <= cutoff)
        items.push({
          kind: 'asset',
          id: a.id,
          title: a.name,
          label: `${l.name} · ${f.label}`,
          clientId: a.clientId,
          clientName: clientName(a.clientId),
          date: v,
          daysLeft: daysUntil(v),
        });
    }
  }
  for (const p of passwords.filter((x) => !x.archived)) {
    const due = rotationDue(p);
    if (due && due <= cutoff)
      items.push({
        kind: 'password',
        id: p.id,
        title: p.name,
        label: 'Password rotation',
        clientId: p.clientId,
        clientName: clientName(p.clientId),
        date: due,
        daysLeft: daysUntil(due),
      });
  }
  for (const d of documents.filter((x) => !x.archived && x.reviewDate && x.reviewDate <= cutoff))
    items.push({
      kind: 'document',
      id: d.id,
      title: d.title,
      label: 'Document review',
      clientId: d.clientId,
      clientName: clientName(d.clientId),
      date: d.reviewDate!,
      daysLeft: daysUntil(d.reviewDate!),
    });
  return items.sort((a, b) => a.date.localeCompare(b.date));
}

function itemRef(type: ItemType, id: string) {
  const find = {
    asset: () =>
      assets.find((x) => x.id === id) && {
        title: assets.find((x) => x.id === id)!.name,
        subtitle: layoutOf(assets.find((x) => x.id === id)!.layoutId).name,
        clientId: assets.find((x) => x.id === id)!.clientId,
      },
    document: () =>
      documents.find((x) => x.id === id) && {
        title: documents.find((x) => x.id === id)!.title,
        subtitle: 'Document',
        clientId: documents.find((x) => x.id === id)!.clientId,
      },
    password: () =>
      passwords.find((x) => x.id === id) && {
        title: passwords.find((x) => x.id === id)!.name,
        subtitle: 'Password',
        clientId: passwords.find((x) => x.id === id)!.clientId,
      },
    contact: () =>
      contacts.find((x) => x.id === id) && {
        title: contacts.find((x) => x.id === id)!.name,
        subtitle: 'Contact',
        clientId: contacts.find((x) => x.id === id)!.clientId,
      },
    location: () =>
      locations.find((x) => x.id === id) && {
        title: locations.find((x) => x.id === id)!.name,
        subtitle: 'Location',
        clientId: locations.find((x) => x.id === id)!.clientId,
      },
  }[type]();
  return find ? { type, id, ...find, clientName: clientName(find.clientId) } : null;
}

function search(q: string, client?: string) {
  const term = q.toLowerCase();
  const out: Json[] = [];
  const add = (
    type: ItemType | 'client',
    id: string,
    title: string,
    subtitle: string,
    clientId: string | null,
    text: string,
  ) => {
    if ((title + ' ' + text).toLowerCase().includes(term) && (!client || clientId === client))
      out.push({ type, id, title, subtitle, clientId, clientName: clientName(clientId), snippet: text.slice(0, 120) });
  };
  for (const c of db.clients) add('client', c.id, c.name, c.type, c.id, c.notes);
  for (const a of assets)
    add('asset', a.id, a.name, layoutOf(a.layoutId).name, a.clientId, Object.values(a.fields).join(' '));
  for (const d of documents)
    add(
      'document',
      d.id,
      d.title,
      d.clientId ? 'Document' : 'Knowledge base',
      d.clientId,
      JSON.stringify(d.content).replace(/[{}[\]"]/g, ' '),
    );
  for (const p of passwords) add('password', p.id, p.name, 'Password', p.clientId, `${p.username} ${p.url}`);
  for (const c of contacts) add('contact', c.id, c.name, c.title || 'Contact', c.clientId, `${c.email} ${c.phone}`);
  return out.slice(0, 20);
}

const csv = (rows: unknown[][]) =>
  rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\r\n');

// ---------- router ----------
type Handler = (m: RegExpMatchArray, body: Json, q: URLSearchParams) => unknown;
const routes: [string, RegExp, Handler][] = [];
const on = (method: string, pattern: string, handler: Handler) =>
  routes.push([method, new RegExp(`^${pattern.replace(/:\w+/g, '([^/]+)')}$`), handler]);
const notInDemo = (what: string) => {
  throw new MockError(400, `${what} isn't available in the demo.`);
};
const find = <T extends { id: string }>(list: T[], id: string, what = 'Item') => {
  const item = list.find((x) => x.id === id);
  if (!item) throw new MockError(404, `${what} not found.`);
  return item;
};
const clientSummary = (c: (typeof db.clients)[0]) => ({ ...c, access: 'edit_passwords' });

// session and account
on('GET', '/setup', () => ({ needed: false, passwordReset: true }));
on('GET', '/session', () => {
  if (!stage) throw new MockError(401, 'Sign in to continue.', 'session');
  return sessionView();
});
on('POST', '/session', (_m, b) => {
  if (!String(b.email ?? '').trim()) throw new MockError(400, 'Enter your email and password.');
  stage = 'mfa';
  return sessionView();
});
on('DELETE', '/session', () => {
  stage = null;
  return { ok: true };
});
const verified = () => {
  stage = 'active';
  event('Signed in', 'Password and MFA');
  return sessionView();
};
on('POST', '/session/mfa', (_m, b) => {
  if (!/^\d{6}$/.test(String(b.code ?? ''))) throw new MockError(400, 'Enter the 6-digit code.', 'mfa_invalid');
  return verified();
});
on('POST', '/session/recovery', () => {
  recoveryLeft = Math.max(0, recoveryLeft - 1);
  return verified();
});
on('POST', '/session/passkey/options', () => ({}));
on('POST', '/session/passkey', () => verified());
on('POST', '/passkey/options', () => ({ challengeId: uuid(), options: {} }));
on('POST', '/passkey/sign-in', () => verified());
on('POST', '/session/reauth', () => ({ ok: true }));
on('POST', '/password-reset', () => ({ ok: true }));
on('POST', '/password-reset/complete', () => ({ ok: true }));
on('POST', '/account/password', () => sessionView());
on('GET', '/account/security', () => ({
  totp: true,
  recoveryCodesLeft: recoveryLeft,
  passkeys,
  sessions,
  devices,
  notifyDigest,
}));
on('PATCH', '/account/preferences', (_m, b) => {
  notifyDigest = !!b.notifyDigest;
  return { totp: true, recoveryCodesLeft: recoveryLeft, passkeys, sessions, devices, notifyDigest };
});
on('POST', '/account/recovery-codes', () => {
  recoveryLeft = 10;
  event('Recovery codes replaced', 'Old codes no longer work');
  return { recoveryCodes: codes() };
});
on('POST', '/account/passkeys/options', () => ({}));
on('POST', '/account/passkeys', (_m, b) => {
  passkeys.push({
    id: uuid(),
    name: String(b.name || 'Passkey'),
    createdAt: now(),
    lastUsedAt: null as unknown as string,
  });
  event('Passkey added', String(b.name));
  return { ...sessionView(), recoveryCodes: [] };
});
on('DELETE', '/account/passkeys/:id', (m) => {
  passkeys.splice(
    passkeys.findIndex((k) => k.id === decodeURIComponent(m[1]!)),
    1,
  );
  event('Passkey removed');
  return sessionView();
});
on('DELETE', '/account/sessions/:id', (m) => {
  sessions.splice(
    sessions.findIndex((s) => s.id === m[1]),
    1,
  );
  return { ok: true };
});
on('POST', '/account/sessions/end-others', () => {
  const ended = sessions.filter((s) => !s.current).length;
  sessions.splice(0, sessions.length, ...sessions.filter((s) => s.current));
  return { ended };
});
on('DELETE', '/account/devices/:id', (m) => {
  devices.splice(
    devices.findIndex((d) => d.id === m[1]),
    1,
  );
  return { ok: true };
});
on('POST', '/account/mfa/setup', () => notInDemo('Setting up another authenticator'));

// clients
on('GET', '/clients', () => db.clients.map(clientSummary));
on('POST', '/clients', (_m, b) => {
  const c = {
    id: uuid(),
    name: String(b.name ?? '').trim(),
    type: String(b.type || 'Customer'),
    status: 'active' as const,
    notes: String(b.notes ?? ''),
    requireRevealReason: false,
    createdAt: now(),
    updatedAt: now(),
  };
  if (!c.name) throw new MockError(400, 'Client name is required.');
  db.clients.push(c);
  record('Created', 'client', c.id, c.name, c.id);
  return clientSummary(c);
});
on('GET', '/clients/:id', (m) => clientSummary(find(db.clients, m[1]!, 'Client')));
on('PATCH', '/clients/:id', (m, b) => {
  const c = find(db.clients, m[1]!, 'Client');
  Object.assign(c, b, { updatedAt: now() });
  return clientSummary(c);
});

// layouts
on('GET', '/layouts', () =>
  db.layouts.map((l) => ({ ...l, assetCount: assets.filter((a) => a.layoutId === l.id).length })),
);
on('POST', '/layouts', (_m, b) => {
  const l = {
    id: uuid(),
    key: `custom_${Date.now()}`,
    name: String(b.name),
    icon: String(b.icon || 'box'),
    description: String(b.description ?? ''),
    fields: (b.fields as LayoutField[]) ?? [],
    builtIn: false,
    archived: false,
  };
  db.layouts.push(l);
  return { ...l, assetCount: 0 };
});
on('PATCH', '/layouts/:id', (m, b) => {
  const l = find(db.layouts, m[1]!, 'Layout');
  Object.assign(l, b);
  return { ...l, assetCount: assets.filter((a) => a.layoutId === l.id).length };
});

// assets
on('GET', '/assets', (_m, _b, q) =>
  assets
    .filter(
      (a) =>
        (!q.get('client') || a.clientId === q.get('client')) &&
        (!q.get('layout') || a.layoutId === q.get('layout')) &&
        a.archived === (q.get('archived') === 'true'),
    )
    .map(assetView),
);
on('POST', '/clients/:id/assets', (m, b) => {
  const a = {
    id: uuid(),
    clientId: m[1]!,
    layoutId: String(b.layoutId),
    name: String(b.name ?? '').trim(),
    status: (b.status as 'active') ?? 'active',
    fields: (b.fields as Json) ?? {},
    notes: String(b.notes ?? ''),
    ...meta(),
    updatedAt: now(),
  };
  if (!a.name) throw new MockError(400, 'Name is required.');
  assets.push(a);
  snapshot(a.id, 1, a as unknown as Json);
  record('Created', 'asset', a.id, a.name, a.clientId);
  return assetView(a);
});
on('GET', '/assets/:id', (m) => assetView(find(assets, m[1]!, 'Asset')));
on('PATCH', '/assets/:id', (m, b) => {
  const a = find(assets, m[1]!, 'Asset');
  const { version: _v, ...changes } = b;
  Object.assign(a, changes, { version: a.version + 1, updatedAt: now() });
  snapshot(a.id, a.version, a as unknown as Json);
  record('Updated', 'asset', a.id, a.name, a.clientId);
  return assetView(a);
});
on('POST', '/assets/:id/archive', (m, b) => {
  const a = find(assets, m[1]!, 'Asset');
  a.archived = !!b.archived;
  return assetView(a);
});

// documents and folders
on('GET', '/documents', (_m, _b, q) => {
  const client = q.get('client');
  return documents
    .filter(
      (d) =>
        (!client || (client === 'global' ? d.clientId === null : d.clientId === client)) &&
        (!q.get('folder') || d.folderId === q.get('folder')) &&
        d.archived === (q.get('archived') === 'true'),
    )
    .map(docSummary);
});
on('POST', '/documents', (_m, b) => {
  const d = {
    id: uuid(),
    clientId: (b.clientId as string) ?? null,
    folderId: (b.folderId as string) ?? null,
    title: String(b.title ?? '').trim(),
    status: (b.status as 'current') ?? 'current',
    reviewDate: (b.reviewDate as string) ?? null,
    content: (b.content as RichText) ?? { type: 'doc', content: [] },
    ...meta(),
    updatedAt: now(),
  };
  if (!d.title) throw new MockError(400, 'Title is required.');
  documents.push(d);
  snapshot(d.id, 1, d as unknown as Json);
  record('Created', 'document', d.id, d.title, d.clientId);
  return { ...docSummary(d), content: d.content, canEdit: true };
});
on('GET', '/documents/:id', (m) => {
  const d = find(documents, m[1]!, 'Document');
  return { ...docSummary(d), content: d.content, canEdit: true };
});
on('PATCH', '/documents/:id', (m, b) => {
  const d = find(documents, m[1]!, 'Document');
  const { version: _v, ...changes } = b;
  Object.assign(d, changes, { version: d.version + 1, updatedAt: now() });
  snapshot(d.id, d.version, d as unknown as Json);
  record('Updated', 'document', d.id, d.title, d.clientId);
  return { ...docSummary(d), content: d.content, canEdit: true };
});
on('POST', '/documents/:id/archive', (m, b) => {
  const d = find(documents, m[1]!, 'Document');
  d.archived = !!b.archived;
  return { ...docSummary(d), content: d.content, canEdit: true };
});
on('GET', '/(assets|documents)/:id/revisions', (m) =>
  [...(revisions.get(m[2]!) ?? [])]
    .reverse()
    .map(({ version, authorName, createdAt }) => ({ version, authorName, createdAt })),
);
on('GET', '/(assets|documents)/:id/revisions/:v', (m) => {
  const r = (revisions.get(m[2]!) ?? []).find((x) => x.version === Number(m[3]));
  if (!r) throw new MockError(404, 'Revision not found.');
  return r.snapshot;
});
on('POST', '/(assets|documents)/:id/restore', (m, b) => {
  const list = m[1] === 'assets' ? assets : documents;
  const item = find(list as { id: string; version: number }[], m[2]!);
  const r = (revisions.get(item.id) ?? []).find((x) => x.version === Number(b.version))!;
  Object.assign(item, structuredClone(r.snapshot), { version: item.version + 1, updatedAt: now() });
  snapshot(item.id, item.version, item as unknown as Json);
  return m[1] === 'assets'
    ? assetView(item as (typeof assets)[0])
    : { ...docSummary(item as (typeof documents)[0]), content: (item as (typeof documents)[0]).content, canEdit: true };
});
on('GET', '/folders', (_m, _b, q) =>
  folders
    .filter((f) => f.clientId === (q.get('client') || null))
    .map((f) => ({ ...f, documentCount: documents.filter((d) => d.folderId === f.id).length })),
);
on('POST', '/folders', (_m, b) => {
  const f = { id: uuid(), clientId: (b.clientId as string) ?? null, name: String(b.name) };
  folders.push(f);
  return { ...f, documentCount: 0 };
});
on('DELETE', '/folders/:id', (m) => {
  folders.splice(
    folders.findIndex((f) => f.id === m[1]),
    1,
  );
  return { ok: true };
});

// contacts and locations
for (const [path, list] of [
  ['contacts', contacts],
  ['locations', locations],
] as const) {
  const items = list as unknown as ({ id: string; clientId: string } & Json)[];
  on('GET', `/clients/:id/${path}`, (m) => items.filter((x) => x.clientId === m[1]));
  on('POST', `/clients/:id/${path}`, (m, b) => {
    const x = {
      mobile: '',
      notes: '',
      title: '',
      email: '',
      phone: '',
      address: '',
      city: '',
      region: '',
      postalCode: '',
      country: '',
      primary: false,
      ...b,
      id: uuid(),
      clientId: m[1]!,
      updatedAt: now(),
    };
    items.push(x);
    return x;
  });
  on('PATCH', `/${path}/:id`, (m, b) => Object.assign(find(items, m[1]!), b, { updatedAt: now() }));
  on('DELETE', `/${path}/:id`, (m) => {
    items.splice(
      items.findIndex((x) => x.id === m[1]),
      1,
    );
    return { ok: true };
  });
}

// relations, attachments, search, activity
on('GET', '/items/:type/:id/relations', (m) =>
  relations
    .filter((r) => r.a.id === m[2] || r.b.id === m[2])
    .map((r) => {
      const other = r.a.id === m[2] ? r.b : r.a;
      return { ...itemRef(other.type, other.id), relationId: r.id, note: r.note };
    })
    .filter((r) => r.id),
);
on('POST', '/items/:type/:id/relations', (m, b) => {
  relations.push({
    id: uuid(),
    a: { type: m[1] as ItemType, id: m[2]! },
    b: { type: b.type as ItemType, id: String(b.id) },
    note: String(b.note ?? ''),
  });
  return { ok: true };
});
on('DELETE', '/items/:type/:id/relations/:rid', (m) => {
  relations.splice(
    relations.findIndex((r) => r.id === m[3]),
    1,
  );
  return { ok: true };
});
on('GET', '/items/:type/:id/attachments', () => []);
on('GET', '/search', (_m, _b, q) => search(q.get('q') ?? '', q.get('client') ?? undefined));
on('GET', '/activity', (_m, _b, q) =>
  activity
    .filter(
      (a) => (!q.get('client') || a.clientId === q.get('client')) && (!q.get('item') || a.entityId === q.get('item')),
    )
    .slice(0, Number(q.get('limit')) || 50),
);

// vault
on('GET', '/passwords', (_m, _b, q) =>
  passwords
    .filter(
      (p) => (!q.get('client') || p.clientId === q.get('client')) && p.archived === (q.get('archived') === 'true'),
    )
    .map(passwordView),
);
on('GET', '/passwords/rotation-due', () =>
  passwords.filter((p) => (rotationDue(p) ?? '9') <= daysFromNow(14)).map(passwordView),
);
on('POST', '/clients/:id/passwords', (m, b) => {
  const p = {
    id: uuid(),
    clientId: m[1]!,
    kind: (b.kind as 'login') ?? 'login',
    category: (b.category as PasswordCategory | null) ?? null,
    name: String(b.name ?? '').trim(),
    username: String(b.username ?? ''),
    url: String(b.url ?? ''),
    secret: String(b.secret ?? ''),
    notes: String(b.notes ?? ''),
    totp: !!b.totp,
    rotationDays: (b.rotationDays as number) ?? null,
    restricted: !!b.restricted,
    clientVisible: !!b.clientVisible,
    changedDaysAgo: 0,
    changedAt: now(),
    ...meta(),
    updatedAt: now(),
  };
  if (!p.name || !p.secret) throw new MockError(400, 'Name and password are required.');
  passwords.push(p);
  record('Added a password', 'password', p.id, p.name, p.clientId);
  return passwordView(p);
});
on('GET', '/passwords/:id', (m) => passwordView(find(passwords, m[1]!, 'Password')));
on('PATCH', '/passwords/:id', (m, b) => {
  const p = find(passwords, m[1]!, 'Password');
  const { version: _v, secret, totp, ...changes } = b;
  if (typeof secret === 'string' && secret !== p.secret) {
    history.set(p.id, [
      { id: uuid(), secret: p.secret, changedByName: db.owner.name, createdAt: now() },
      ...(history.get(p.id) ?? []),
    ]);
    p.secret = secret;
    p.changedAt = now();
  }
  if (totp !== undefined) p.totp = !!totp;
  Object.assign(p, changes, { version: p.version + 1, updatedAt: now() });
  audit(p, 'Changed');
  record('Updated', 'password', p.id, p.name, p.clientId);
  return passwordView(p);
});
on('POST', '/passwords/:id/archive', (m, b) => {
  const p = find(passwords, m[1]!, 'Password');
  p.archived = !!b.archived;
  return passwordView(p);
});
on('PUT', '/passwords/:id/favorite', (m) => {
  const p = find(passwords, m[1]!, 'Password');
  favorites.add(p.id);
  return passwordView(p);
});
on('DELETE', '/passwords/:id/favorite', (m) => {
  const p = find(passwords, m[1]!, 'Password');
  favorites.delete(p.id);
  return passwordView(p);
});
on('POST', '/passwords/:id/reveal', (m, b) => {
  const p = find(passwords, m[1]!, 'Password');
  const field = String(b.field ?? 'secret');
  if (passwordView(p).requireReason && !String(b.reason ?? '').trim())
    throw new MockError(400, 'This client requires a reason.', 'reason_required');
  audit(
    p,
    b.copy
      ? `Copied ${field === 'secret' ? 'password' : field}`
      : `Revealed ${field === 'secret' ? 'password' : field}`,
    String(b.reason ?? ''),
  );
  lastUsed.set(p.id, new Date().toISOString());
  if (field === 'totp')
    return {
      value: String(Math.floor(Math.random() * 1e6)).padStart(6, '0'),
      expiresIn: 30 - (Math.floor(Date.now() / 1000) % 30),
    };
  return { value: field === 'notes' ? p.notes : p.secret };
});
on('GET', '/passwords/:id/history', (m) => (history.get(m[1]!) ?? []).map(({ secret: _s, ...h }) => h));
on('POST', '/passwords/:id/history/:hid/reveal', (m) => ({
  value: (history.get(m[1]!) ?? []).find((h) => h.id === m[2])?.secret ?? '',
}));
on('GET', '/passwords/:id/access', (m) => access.get(m[1]!) ?? { userIds: [], groupIds: [] });
on('PUT', '/passwords/:id/access', (m, b) => {
  const v = { userIds: (b.userIds as string[]) ?? [], groupIds: (b.groupIds as string[]) ?? [] };
  access.set(m[1]!, v);
  return v;
});
on('GET', '/passwords/:id/audit', (m) => vaultAudit.filter((a) => a.passwordId === m[1]));
on('GET', '/vault/audit', () => vaultAudit);
on('GET', '/passwords/:id/shares', (m) =>
  shares.filter((s) => s.passwordId === m[1]).map(({ token: _t, ciphertext: _c, passwordId: _p, ...s }) => s),
);
on('POST', '/passwords/:id/shares', (m, b) => {
  const p = find(passwords, m[1]!, 'Password');
  const token = uuid().replace(/-/g, '');
  const s = {
    id: uuid(),
    passwordId: p.id,
    token,
    ciphertext: String(b.ciphertext),
    maxViews: Number(b.maxViews ?? 1),
    views: 0,
    expiresAt: new Date(Date.now() + Number(b.expiresHours ?? 24) * 3_600_000).toISOString(),
    revoked: false,
    createdByName: db.owner.name,
    createdAt: now(),
  };
  shares.push(s);
  audit(p, 'Created a share link');
  return { id: s.id, token, expiresAt: s.expiresAt };
});
on('DELETE', '/passwords/:id/shares/:sid', (m) => {
  const s = find(shares, m[2]!);
  s.revoked = true;
  return { ok: true };
});
on('POST', '/shares/:token/open', (m) => {
  const s = shares.find(
    (x) => x.token === m[1] && !x.revoked && x.views < x.maxViews && Date.parse(x.expiresAt) > Date.now(),
  );
  if (!s) throw new MockError(404, 'This link has expired or was already used.');
  s.views++;
  return {
    ciphertext: s.ciphertext,
    name: passwords.find((p) => p.id === s.passwordId)?.name ?? '',
    viewsLeft: s.maxViews - s.views,
  };
});

// people, groups, settings, expirations, audit log
on('GET', '/users', () => users);
on('POST', '/users', (_m, b) => {
  const u = {
    id: uuid(),
    name: String(b.name),
    email: String(b.email),
    role: b.role as Role,
    allClients: (b.allClients as AccessLevel) ?? 'none',
    grants: (b.grants as never[]) ?? [],
    mfa: false,
    disabled: false,
    locked: false,
    mustChangePassword: true,
    lastLoginAt: null as unknown as string,
    createdAt: now(),
  };
  users.push(u as (typeof users)[0]);
  event('User created', `${u.email} · ${ROLE_INFO[u.role].label}`);
  return u;
});
on('PATCH', '/users/:id', (m, b) => Object.assign(find(users, m[1]!, 'User'), b));
on('POST', '/users/:id/reset', (m) => find(users, m[1]!, 'User'));
on('POST', '/users/:id/sign-out', (m) => {
  event('User signed out everywhere', find(users, m[1]!, 'User').email);
  return { ok: true };
});
on('GET', '/groups', () => groups);
on('POST', '/groups', (_m, b) => {
  const g = {
    id: uuid(),
    name: String(b.name ?? '').trim(),
    description: String(b.description ?? ''),
    memberIds: (b.memberIds as string[]) ?? [],
    grants: ((b.grants as { clientId: string; level: AccessLevel }[]) ?? []).filter(
      (x) => x.level !== 'none',
    ) as never[],
    updatedAt: now(),
  };
  if (!g.name) throw new MockError(400, 'Name is required.');
  groups.push(g);
  event('Group created', `${g.name} · ${g.memberIds.length} members · ${g.grants.length} clients`);
  return g;
});
on('PUT', '/groups/:id', (m, b) => {
  const g = find(groups, m[1]!, 'Group');
  Object.assign(g, b, {
    grants: ((b.grants as { level: AccessLevel }[]) ?? []).filter((x) => LEVEL_INFO[x.level].rank > 0),
    updatedAt: now(),
  });
  return g;
});
on('DELETE', '/groups/:id', (m) => {
  groups.splice(
    groups.findIndex((g) => g.id === m[1]),
    1,
  );
  return { ok: true };
});
on('GET', '/settings/email', () => smtp);
on('PUT', '/settings/email', (_m, b) => {
  const { password, clientSecret, ...rest } = b;
  smtp = {
    ...smtp,
    ...(rest as typeof smtp),
    hasPassword: smtp.hasPassword || !!password,
    hasClientSecret: smtp.hasClientSecret || !!clientSecret,
  };
  event(
    'Email settings changed',
    !smtp.enabled ? 'Email off' : smtp.method === 'graph' ? 'Microsoft 365 (Graph)' : `${smtp.host}:${smtp.port}`,
  );
  return smtp;
});
on('POST', '/settings/email/test', () => notInDemo('Sending email'));
on('GET', '/settings/notifications', () => notifications);
on('PUT', '/settings/notifications', (_m, b) => (notifications = { ...notifications, ...(b as typeof notifications) }));
on('GET', '/expirations', (_m, _b, q) => expirations(Number(q.get('days')) || 90));
on('GET', '/security-events', () => db.events);
on('POST', '/audit/verify', () => ({
  ok: true,
  checked: db.events.length,
  firstId: db.events.at(-1)?.id ?? null,
  lastId: db.events[0]?.id ?? null,
  brokenAt: null,
  checkpoint: 'ok',
  checkedAt: now(),
}));
on('GET', '/audit/export/:kind', (m) =>
  m[1] === 'vault'
    ? csv([
        ['time_utc', 'actor', 'action', 'client', 'password', 'reason'],
        ...vaultAudit.map((a) => [a.createdAt, a.actorName, a.action, a.clientName, a.passwordName, a.reason]),
      ])
    : csv([
        ['id', 'time_utc', 'actor', 'action', 'detail', 'ip'],
        ...db.events.map((e) => [e.id, e.createdAt, e.actor, e.action, e.detail, e.ip]),
      ]),
);

// data in and out
let branding: Branding = { ...DEFAULT_BRANDING };
let hudu: { url: string; hasKey: boolean } | null = null;
const importJobs: ImportJobView[] = [];
const apiKeys: ApiKeyView[] = [];
on('GET', '/branding', () => ({ name: 'IT Done Right', ...branding }));
on('PUT', '/branding', (_m, b) => {
  branding = { ...branding, ...(b as Partial<Branding>) };
  event('Theme changed', [branding.brandName || 'Default name', branding.accent ?? 'default colour'].join(', '));
  return branding;
});
on('GET', '/api-keys', () => apiKeys);
on('POST', '/api-keys', (_m, b) => {
  const name = String(b.name ?? '').trim();
  if (!name) throw new MockError(400, 'Name is required.');
  const prefix = uuid().replace(/-/g, '').slice(0, 10);
  const days = b.expiresDays === null ? null : Number(b.expiresDays ?? 365);
  const key: ApiKeyView = {
    id: uuid(),
    name,
    prefix,
    scopes: (b.scopes as ApiKeyView['scopes']) ?? ['read'],
    userName: db.owner.name,
    expiresAt: days ? new Date(Date.now() + days * 86_400_000).toISOString() : null,
    lastUsedAt: null,
    lastUsedIp: '',
    revoked: false,
    createdAt: now(),
  };
  apiKeys.unshift(key);
  event('API key created', name);
  return { ...key, token: `atlas_${prefix}_demo-only-this-key-does-not-work-anywhere` };
});
on('DELETE', '/api-keys/:id', (m) => {
  const key = find(apiKeys, m[1]!, 'API key');
  key.revoked = true;
  event('API key revoked', key.name);
  return { ok: true };
});
on('GET', '/import/hudu', () => hudu);
on('PUT', '/import/hudu', (_m, b) => {
  const url = String(b.url ?? '').trim();
  if (!/^https:\/\//.test(url)) throw new MockError(400, 'Use the https:// address of your Hudu site.');
  return (hudu = { url, hasKey: true });
});
on('DELETE', '/import/hudu', () => ((hudu = null), { ok: true }));
on('POST', '/import/hudu/preview', () => ({
  companies: 38,
  assetLayouts: 9,
  assets: 612,
  articles: 147,
  passwords: 903,
}));
on('POST', '/import/hudu/run', () => notInDemo('Importing from a real Hudu site'));
on('GET', '/import/jobs', () => importJobs);
on('GET', '/import/jobs/:id', (m) => find(importJobs, m[1]!, 'Import'));
on('POST', '/import/csv', (_m, b) => {
  const rows = (b.rows as Record<string, string>[]) ?? [];
  const target = String(b.target);
  if (!b.dryRun && target !== 'clients') notInDemo('Importing anything but clients');
  const errors: CsvImportResult['errors'] = [];
  let created = 0;
  let updated = 0;
  rows.forEach((r, i) => {
    const name = (r.name ?? r.title ?? '').trim();
    if (!name) return errors.push({ row: i + 2, message: 'Name is required.' });
    if (target !== 'clients' && !db.clients.some((c) => c.name.toLowerCase() === (r.client ?? '').trim().toLowerCase()))
      return errors.push({ row: i + 2, message: `No client named "${r.client ?? ''}".` });
    const existing = target === 'clients' && db.clients.find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) updated++;
    else created++;
    if (b.dryRun || target !== 'clients' || existing) return;
    const c = {
      id: uuid(),
      name,
      type: r.type || 'Customer',
      status: 'active' as const,
      notes: r.notes ?? '',
      requireRevealReason: false,
      createdAt: now(),
      updatedAt: now(),
    };
    db.clients.push(c);
    record('Created', 'client', c.id, c.name, c.id);
  });
  if (!b.dryRun) {
    importJobs.unshift({
      id: uuid(),
      source: 'csv',
      status: 'done',
      counts: { [target]: { created, updated, skipped: 0, failed: errors.length } },
      messages: errors.map((e) => `Row ${e.row}: ${e.message}`),
      startedByName: db.owner.name,
      createdAt: now(),
      finishedAt: now(),
    });
  }
  return { created, updated, errors } satisfies CsvImportResult;
});
on('GET', '/clients/:id/export', () => notInDemo('Downloading a client export'));

// operations
const backupRuns: BackupRunView[] = [
  {
    id: uuid(),
    trigger: 'schedule',
    status: 'done',
    fileName: 'atlas-demo.atlasbak',
    size: 48_213_504,
    rows: 18_422,
    files: 312,
    error: null,
    startedByName: 'Scheduled backup',
    createdAt: ago(9 * 60),
    finishedAt: ago(9 * 60),
  },
];
on('GET', '/backups', () => backupRuns);
on('POST', '/backups', () => {
  const run: BackupRunView = {
    ...backupRuns[0]!,
    id: uuid(),
    trigger: 'manual',
    startedByName: db.owner.name,
    createdAt: now(),
    finishedAt: now(),
  };
  backupRuns.unshift(run);
  event('Backup started', run.id);
  return run;
});
on('GET', '/backups/:id/download', () => notInDemo('Downloading a backup'));
on('GET', '/status', (): SystemStatus => ({
  version: '1.0.1',
  node: 'v22.12.0',
  platform: 'linux x64',
  startedAt: ago(3 * 24 * 60),
  publicUrl: 'https://atlas.example.com',
  checks: [
    {
      id: 'backup-location',
      level: 'warn',
      title: 'Backups are on the same disk as Atlas',
      detail: 'Copy the backup folder somewhere else, or set ATLAS_BACKUP_DIR to a network share.',
    },
    {
      id: 'backups',
      level: 'ok',
      title: 'Backups are current',
      detail: `The last backup finished ${relativeTime(backupRuns[0]!.finishedAt ?? backupRuns[0]!.createdAt)}.`,
    },
  ],
  database: { version: '16.4', sizeBytes: 187_000_000, migrationsApplied: 8, migrationsAvailable: 8 },
  storage: {
    dataDir: '/data',
    freeBytes: 412_000_000_000,
    totalBytes: 500_000_000_000,
    attachments: 312,
    attachmentBytes: 1_240_000_000,
  },
  backups: {
    enabled: true,
    dir: '/data/backups',
    hour: 2,
    keep: 14,
    freeBytes: 412_000_000_000,
    lastSuccessAt: backupRuns[0]!.createdAt,
    nextAt: new Date(Date.now() + 14 * 3_600_000).toISOString(),
    runs: backupRuns,
  },
  email: { enabled: smtp.enabled, host: smtp.host },
  keys: { current: 'k7Qe2xLp', loaded: 1 },
  audit: { events: db.events.length, lastCheckpointAt: ago(5 * 60) },
  background: { lastRunAt: new Date(Date.now() - 4 * 60_000).toISOString() },
}));

/** Answers an API request from memory, after a short delay so loading states show as they would for real. */
export async function mockRequest(path: string, method: string, body: unknown): Promise<unknown> {
  await new Promise((r) => setTimeout(r, 120 + Math.random() * 180));
  const url = new URL(path, 'https://demo.invalid');
  for (const [m, pattern, handler] of routes) {
    if (m !== method) continue;
    const match = url.pathname.match(pattern);
    if (match) return structuredClone(handler(match, (body as Json) ?? {}, url.searchParams));
  }
  throw new MockError(404, 'Not found.');
}
