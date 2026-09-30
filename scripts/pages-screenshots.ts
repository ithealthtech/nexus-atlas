/**
 * Takes the screenshots on the documentation site (pages/images) from a demo organization.
 *
 * It starts Atlas in-process against a throwaway database, fills it with fictional clients, and stands in for the
 * ConnectWise platform, so the device, ticket, and RMM cards have something to show. Nothing leaves the machine.
 *
 *   npm run build
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npx tsx scripts/pages-screenshots.ts
 */
import { fileURLToPath } from 'node:url';
import { chromium, type Page } from '@playwright/test';
import { setupOwner, startApp, type Browser } from '../apps/server/test/helpers.js';

const PORT = 4411;
const BASE = `http://localhost:${PORT}`;
const OUT = fileURLToPath(new URL('../pages/images/', import.meta.url));
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
const inDays = (days: number) => new Date(Date.now() + days * DAY).toISOString().slice(0, 10);

const CLIENTS = [
  { id: 'c1', name: 'Harbor Dental Group', type: 'Healthcare' },
  { id: 'c2', name: 'Northline Architecture', type: 'Professional services' },
  { id: 'c3', name: 'Cedar Ridge Credit Union', type: 'Finance' },
  { id: 'c4', name: 'Bluewater Logistics', type: 'Transportation' },
  { id: 'c5', name: 'Summit Family Law', type: 'Legal' },
  { id: 'c6', name: 'Maple Street Bakery', type: 'Retail' },
];

type Json = Record<string, unknown>;
const MAKERS = [
  ['Dell Inc.', 'OptiPlex 7010'],
  ['LENOVO', 'ThinkPad T14 Gen 4'],
  ['HP', 'EliteBook 840 G10'],
  ['Dell Inc.', 'Latitude 5440'],
] as const;
const PROTECTION = ['Running', 'Running', 'Running', 'Running', 'Running', 'Stopped'];

/** Fictional devices for a company: a couple of servers and a handful of workstations. */
function devicesFor(prefix: string, index: number): Json[] {
  const list: Json[] = [];
  const servers = index < 3 ? 2 : 1;
  for (let i = 1; i <= servers; i++)
    list.push({
      endpointId: `${prefix}-srv-${i}`,
      friendlyName: `${prefix}-SRV-0${i}`,
      endpointType: 'Server',
      operatingSystem: i === 2 && index === 1 ? 'Windows Server 2012 R2 Standard' : 'Windows Server 2022 Standard',
      ipAddress: `10.${20 + index}.0.${10 + i}`,
      manufacturer: 'Dell Inc.',
      model: 'PowerEdge R650xs',
      serialNumber: `${prefix}S${i}X9Q`,
      lastSeen: ago(0.01),
      endpointProtection: { name: 'SentinelOne', status: 'Running' },
      warrantyExpirationDate: `${inDays(200 + i * 90)}T00:00:00Z`,
    });
  const workstations = 4 + ((index * 3) % 5);
  for (let i = 1; i <= workstations; i++) {
    const [maker, model] = MAKERS[(i + index) % MAKERS.length]!;
    const stale = i === workstations && index % 2 === 0;
    list.push({
      endpointId: `${prefix}-ws-${i}`,
      friendlyName: `${prefix}-${model.startsWith('Opti') ? 'DT' : 'LT'}-${String(i).padStart(2, '0')}`,
      endpointType: model.startsWith('Opti') ? 'Desktop' : 'Laptop',
      operatingSystem: i === 3 && index === 2 ? 'Windows 10 Pro 22H2' : 'Windows 11 Pro 23H2',
      ipAddress: `10.${20 + index}.1.${100 + i}`,
      manufacturer: maker,
      model,
      serialNumber: `${prefix}W${i}${index}7K`,
      lastSeen: ago(stale ? 12 : i * 0.02),
      endpointProtection: { name: 'SentinelOne', status: PROTECTION[(i + index) % PROTECTION.length] },
      warrantyExpirationDate: `${inDays(i === 2 ? 20 : 120 + i * 60 - index * 30)}T00:00:00Z`,
    });
  }
  return list;
}

const DEVICES = new Map(CLIENTS.map((c, i) => [c.id, devicesFor(c.name.slice(0, 3).toUpperCase(), i)]));
const ONLINE = new Map([...DEVICES.values()].flat().map((d, i) => [d.endpointId as string, i % 9 !== 4]));

const STATUSES = [
  { id: 's-new', name: 'New', category: 'New' },
  { id: 's-prog', name: 'In progress', category: 'InProgress' },
  { id: 's-wait', name: 'Waiting on client', category: 'InProgress' },
  { id: 's-sched', name: 'Scheduled', category: 'InProgress' },
  { id: 's-done', name: 'Closed', category: 'Closed' },
];
const SUMMARIES = [
  'Outlook keeps asking for a password',
  'New hire laptop setup',
  'Printer on second floor offline',
  'VPN disconnects every hour',
  'Replace failing drive on file server',
  'Add user to shared mailbox',
  'Scanner to email not working',
  'Quarterly firewall firmware update',
  'Wi-Fi slow in conference room',
  'Reset MFA for returning employee',
];
function ticketsFor(company: string, index: number): Json[] {
  const list: Json[] = [];
  for (let i = 0; i < 14 + index * 2; i++) {
    const status = STATUSES[(i * 7 + index) % STATUSES.length]!;
    const opened = ((i * 5 + index * 3) % 28) + 0.2;
    list.push({
      id: `${company}-t${i}`,
      number: String(48200 + index * 100 + i),
      summary: SUMMARIES[(i + index) % SUMMARIES.length],
      status: { id: status.id, name: status.name },
      createdAt: ago(opened),
      updatedAt: ago(status.category === 'Closed' ? Math.max(0.1, opened - 1) : opened / 3),
    });
  }
  return list;
}
const TICKETS = new Map(CLIENTS.map((c, i) => [c.id, ticketsFor(c.id, i)]));

/** Stands in for the ConnectWise platform API: companies, devices, heartbeat, and service tickets. */
const platform = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  if (url.pathname === '/v1/token') {
    const scope = String(JSON.parse(String(init?.body)).scope);
    return json({ access_token: scope.includes('tickets') ? 'ticket-tok' : 'tok', expires_in: 3600 });
  }
  if (url.pathname === '/api/platform/v1/company/companies')
    return json(CLIENTS.map((c, i) => ({ id: c.id, name: c.name, externalIds: [{ externalId: String(19300 + i) }] })));
  if (/companies\/\w+\/sites$/.test(url.pathname)) return json([]);
  if (url.pathname === '/api/platform/v2/device/categories/all/endpoints') {
    const request = JSON.parse(String(init?.body));
    const all = DEVICES.get(request.resources[0] as string) ?? [];
    const cursor = Number(url.searchParams.get('cursor'));
    return json({ endpoints: all.slice(cursor, cursor + Number(url.searchParams.get('limit'))) });
  }
  if (url.pathname === '/api/platform/v2/device/endpoints/heartbeat') {
    const company = url.searchParams.get('resources')!;
    const endpoints = (DEVICES.get(company) ?? []).map((d) => ({
      EndpointID: d.endpointId,
      Availability: ONLINE.get(d.endpointId as string),
    }));
    return json({ status: 'success', successfulRecords: [{ companyID: company, endpoints }], failedRecords: [] });
  }
  if (url.pathname === '/api/platform/v1/service/ticketing/statuses') return json(STATUSES);
  if (url.pathname === '/api/platform/v2/service/ticketing/tickets') {
    const given = url.searchParams.get('statusIds');
    const list = (given ?? '').split(',');
    const notIn = list[0] === '[notIn]';
    const ids = notIn ? list.slice(1) : list;
    const all = (TICKETS.get(url.searchParams.get('companyIds') ?? '') ?? []).filter((k) => {
      const status = (k.status as { id: string }).id;
      return given === null ? true : notIn ? !ids.includes(status) : ids.includes(status);
    });
    const size = Number(url.searchParams.get('pageSize'));
    const from = (Number(url.searchParams.get('pageNum')) - 1) * size;
    return json({ tickets: all.slice(from, from + size), totalCount: all.length });
  }
  return json({ message: 'resource not found' }, 404);
}) as typeof fetch;

const doc = (...blocks: Json[]) => ({ type: 'doc', content: blocks });
const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (text: string) => ({ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text }] });
const tasks = (...items: [string, boolean][]) => ({
  type: 'taskList',
  content: items.map(([text, checked]) => ({ type: 'taskItem', attrs: { checked }, content: [p(text)] })),
});

async function ok(b: Browser, method: 'POST' | 'PUT' | 'PATCH', url: string, body: unknown) {
  const r = await b.call(method, url, body);
  if (r.status >= 300) throw new Error(`${method} ${url}: ${r.status} ${JSON.stringify(r.data)}`);
  return r.data;
}

async function seed(owner: Browser) {
  const ids: Record<string, string> = {};
  for (const c of CLIENTS) ids[c.id] = (await ok(owner, 'POST', '/api/clients', { name: c.name, type: c.type })).id;
  const harbor = ids.c1!;
  await ok(owner, 'PATCH', `/api/clients/${harbor}`, {
    notes: 'Front desk opens at 7:30. Call Dr. Patel before any change to the imaging server.',
    hours: 'Mon to Fri, 7:30 AM to 5:30 PM',
    maintenanceWindow: 'Thursdays after 7 PM',
  });

  await ok(owner, 'PUT', '/api/integrations/cw-rmm', {
    clientId: 'demo-client-id',
    clientSecret: 'demo-client-secret',
  });
  await ok(owner, 'PUT', '/api/integrations/cw-rmm/companies', {
    mappings: CLIENTS.map((c) => ({ companyId: c.id, action: 'link', clientId: ids[c.id] })),
  });
  const job = await ok(owner, 'POST', '/api/integrations/cw-rmm/sync', {});
  for (let i = 0; i < 300; i++) {
    const state = (await owner.call('GET', `/api/import/jobs/${job.id}`)).data;
    if (state.status !== 'running') {
      if (state.status !== 'done') console.warn('ConnectWise sync:', JSON.stringify(state).slice(0, 500));
      break;
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
  const layout = (key: string) => layouts.find((l) => l.key === key)!.id;
  const asset = (clientId: string, key: string, name: string, fields: Json) =>
    ok(owner, 'POST', `/api/clients/${clientId}/assets`, { layoutId: layout(key), name, fields });

  const firewall = await asset(harbor, 'configuration', 'HDG-FW-01', {
    type: 'Firewall',
    hostname: 'hdg-fw-01',
    ip_address: '10.20.0.1',
    manufacturer: 'Fortinet',
    model: 'FortiGate 60F',
    serial_number: 'FGT60FTK23001234',
    management_url: 'https://10.20.0.1',
    location: 'Main office, network closet',
    warranty_expires: inDays(410),
  });
  await asset(harbor, 'network', 'Office LAN', { subnet: '10.20.0.0/24', vlan: '10', gateway: '10.20.0.1' });
  await asset(harbor, 'internet', 'Spectrum Business fiber', { provider: 'Spectrum Business', bandwidth: '500/500' });
  await asset(harbor, 'license', 'Microsoft 365 Business Premium', {
    product: 'Microsoft 365 Business Premium',
    seats: '24',
    renewal_date: inDays(45),
  });
  const domains: [string, string, number][] = [
    [ids.c1!, 'harbordental.example', 12],
    [ids.c1!, 'harborsmiles.example', 280],
    [ids.c2!, 'northline-arch.example', 150],
    [ids.c3!, 'cedarridgecu.example', -4],
    [ids.c4!, 'bluewaterlogistics.example', 64],
    [ids.c5!, 'summitfamilylaw.example', 330],
  ];
  for (const [client, name, days] of domains)
    await asset(client, 'domain', name, { registrar: 'Cloudflare', expires: inDays(days) });
  const certs: [string, string, number][] = [
    [ids.c1!, 'portal.harbordental.example', 9],
    [ids.c2!, '*.northline-arch.example', 71],
    [ids.c3!, 'online.cedarridgecu.example', 26],
    [ids.c4!, 'track.bluewaterlogistics.example', 190],
  ];
  for (const [client, name, days] of certs)
    await asset(client, 'ssl_certificate', name, { common_name: name, issuer: "Let's Encrypt", expires: inDays(days) });

  const runbook = await ok(owner, 'POST', '/api/documents', {
    clientId: harbor,
    title: 'Internet outage runbook',
    content: doc(
      p(
        'Use this when the office loses internet. The firewall fails over to LTE on its own; this covers what to check.',
      ),
      h('Checklist'),
      tasks(
        ['Confirm the outage from the RMM heartbeat and the ISP status page', true],
        ['Check the FortiGate WAN1 link and the LTE failover status', true],
        ['Open a ticket with Spectrum Business (account on the ISP asset)', false],
        ['Tell the front desk which systems are on LTE', false],
      ),
      h('Escalation'),
      p('If the outage lasts more than an hour, call the practice manager and move imaging uploads to the evening.'),
    ),
  });
  await ok(owner, 'POST', '/api/documents', {
    clientId: harbor,
    title: 'New hire onboarding',
    content: doc(p('Steps.')),
  });
  await ok(owner, 'POST', '/api/documents', { title: 'Firewall build standard', content: doc(p('Our baseline.')) });

  const pw = (client: string, body: Json) => ok(owner, 'POST', `/api/clients/${client}/passwords`, body);
  const fwLogin = await pw(harbor, {
    name: 'HDG-FW-01 admin',
    username: 'admin',
    url: 'https://10.20.0.1',
    secret: 'Tide-Anchor-Harbor-2026!',
    totp: 'JBSWY3DPEHPK3PXP',
    rotationDays: 90,
    notes: 'Local admin on the FortiGate. Use the break-glass account only if SSO is down.',
  });
  await pw(harbor, {
    name: 'Microsoft 365 global admin',
    username: 'admin@harbordental.example',
    url: 'https://admin.microsoft.com',
    secret: 'Correct-Molar-Staple-81',
    rotationDays: 180,
  });
  await pw(harbor, { name: 'Imaging server local admin', username: '.\\localadmin', secret: 'Lighthouse#Beacon42' });
  await pw(ids.c2!, { name: 'Autodesk account', username: 'it@northline.example', secret: 'Blueprint-Level-73' });
  await pw(ids.c3!, { name: 'Core banking VPN', username: 'msp-support', secret: 'Vault-Teller-Oak-19' });
  await ok(owner, 'POST', `/api/items/asset/${firewall.id}/relations`, { type: 'password', id: fwLogin.id });
  await ok(owner, 'POST', `/api/items/asset/${firewall.id}/relations`, { type: 'document', id: runbook.id });
  await ok(owner, 'POST', `/api/clients/${harbor}/contacts`, {
    name: 'Dr. Anita Patel',
    title: 'Practice owner',
    email: 'anita@harbordental.example',
    phone: '(919) 555-0142',
    primary: true,
  });
  await ok(owner, 'POST', `/api/clients/${harbor}/contacts`, { name: 'Lena Brooks', title: 'Office manager' });
  await ok(owner, 'POST', `/api/clients/${harbor}/locations`, {
    name: 'Main office',
    address: '214 Harbor Street',
    city: 'Wilmington',
    region: 'NC',
    primary: true,
  });
  for (const [type, id] of [
    ['client', harbor],
    ['client', ids.c3!],
    ['document', runbook.id],
    ['asset', firewall.id],
  ] as const)
    await ok(owner, 'PUT', `/api/favorites/${type}/${id}`, {});
  await owner.call('POST', `/api/passwords/${fwLogin.id}/reveal`, {});

  for (const [name, email, role] of [
    ['Jordan Reyes', 'jordan@itdoneright.example', 'admin'],
    ['Sam Whitaker', 'sam@itdoneright.example', 'technician'],
    ['Priya Nair', 'priya@itdoneright.example', 'technician'],
  ] as const)
    await ok(owner, 'POST', '/api/users', {
      name,
      email,
      role,
      allClients: role === 'admin' ? 'edit_passwords' : 'edit',
      password: 'temporary pass 1234',
    }).catch((e) => console.warn(String(e).slice(0, 200)));
  await ok(owner, 'POST', '/api/users', {
    name: 'Morgan Ellis',
    email: 'morgan@harbordental.example',
    role: 'client_viewer',
    grants: [{ clientId: harbor, level: 'read' }],
    password: 'temporary pass 1234',
  });
  return { ids, harbor, firewall: firewall.id as string, fwLogin: fwLogin.id as string, runbook: runbook.id as string };
}

async function shot(page: Page, name: string, opts: { fullPage?: boolean } = {}) {
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${OUT}${name}.png`, ...opts });
  console.log(`saved ${name}.png`);
}

const t = await startApp(
  { PUBLIC_URL: BASE, WEB_DIST: fileURLToPath(new URL('../apps/web/dist', import.meta.url)) },
  {
    cwRmmFetch: platform,
    warrantyFetch: (async () => new Response('{}', { status: 404 })) as typeof fetch,
    domainLookup: { lookup: async () => null } as never,
    certProbe: async () => {
      throw new Error('Demo: not probed.');
    },
  },
);
try {
  await t.app.listen({ host: 'localhost', port: PORT });
  const { b: owner } = await setupOwner(t.app);
  await ok(owner, 'PATCH', '/api/account/preferences', { theme: 'light' }).catch(() => undefined);
  const demo = await seed(owner);

  const browser = await chromium.launch(
    process.env.PLAYWRIGHT_CHROMIUM ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM } : {},
  );
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
    colorScheme: 'light',
    reducedMotion: 'reduce',
  });
  await context.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: BASE })));
  const page = await context.newPage();

  await page.goto(`${BASE}/`);
  await page.getByRole('heading', { name: /Good (morning|afternoon|evening)/ }).waitFor();
  await shot(page, 'dashboard');
  // Dashboard cards on their own, found by their description line.
  for (const [name, text] of [
    ['rmm-health', 'From ConnectWise RMM'],
    ['tickets', 'From ConnectWise · updated'],
    ['asset-stats', 'Documented devices by kind'],
  ] as const) {
    const card = page.getByText(text).first().locator('xpath=ancestor::div[contains(@class,"shadow-card")][1]');
    await card.scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await card.screenshot({ path: `${OUT}${name}.png` });
    console.log(`saved ${name}.png`);
  }

  await page.goto(`${BASE}/clients/${demo.harbor}`);

  // Opened from the client's list, the way a technician gets there.
  await page.goto(`${BASE}/clients/${demo.harbor}/assets`);
  await page
    .getByRole('link', { name: /HDG-FW-01/ })
    .first()
    .click();
  await page.getByRole('heading', { name: /HDG-FW-01/ }).waitFor();
  await shot(page, 'asset', { fullPage: true });
  await page.goto(`${BASE}/passwords/${demo.fwLogin}`);
  await shot(page, 'password', { fullPage: true });
  await page.goto(`${BASE}/documents/${demo.runbook}`);
  await shot(page, 'document');
  await page.goto(`${BASE}/clients/${demo.harbor}/trackers/domains`);
  await shot(page, 'trackers');
  await page.goto(`${BASE}/admin/users`);
  await shot(page, 'people');

  const mobile = await browser.newContext({
    viewport: { width: 430, height: 932 },
    deviceScaleFactor: 2,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
  });
  await mobile.addCookies([...owner.jar].map(([name, value]) => ({ name, value, url: BASE })));
  const phone = await mobile.newPage();
  await phone.goto(`${BASE}/passwords/${demo.fwLogin}`);
  await shot(phone, 'mobile-dark');

  if (process.env.PAUSE) await new Promise((r) => setTimeout(r, Number(process.env.PAUSE)));
  await browser.close();
} finally {
  await t.close();
}
