// Sample data for the clickable demo. Everything here is fictional.
import type { AccessLevel, DocumentStatus, LayoutField, RichText } from '@atlas/shared';
import { BUILT_IN_LAYOUTS, withDefaults } from '../../../server/src/services/layout-defaults';

export const uuid = (): string => crypto.randomUUID();
const DAY = 86_400_000;
export const daysFromNow = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);
export const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const p = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text }] });
const h = (level: number, text: string) => ({ type: 'heading', attrs: { level }, content: [{ type: 'text', text }] });
const list = (items: string[], ordered = false) => ({
  type: ordered ? 'orderedList' : 'bulletList',
  content: items.map((t) => ({ type: 'listItem', content: [p(t)] })),
});
const doc = (...content: unknown[]): RichText => ({ type: 'doc', content });

export function seed() {
  const orgId = uuid();
  const owner = { id: uuid(), name: 'Alex Rivera', email: 'alex@itdoneright.demo', role: 'owner' as const };
  const users = [
    { ...owner, allClients: 'edit_passwords' as const, grants: [], mfa: true, lastLoginAt: ago(2) },
    {
      id: uuid(),
      name: 'Jordan Blake',
      email: 'jordan@itdoneright.demo',
      role: 'technician' as const,
      allClients: 'edit' as const,
      grants: [],
      mfa: true,
      lastLoginAt: ago(95),
    },
    {
      id: uuid(),
      name: 'Sam Patel',
      email: 'sam@itdoneright.demo',
      role: 'readonly_technician' as const,
      allClients: 'read' as const,
      grants: [],
      mfa: true,
      lastLoginAt: ago(60 * 26),
    },
  ];

  const layouts = BUILT_IN_LAYOUTS.map((l) => ({
    id: uuid(),
    key: l.key,
    name: l.name,
    icon: l.icon,
    description: l.description,
    fields: l.fields.map(withDefaults) as LayoutField[],
    builtIn: true,
    archived: false,
  }));
  const layout = (key: string) => layouts.find((l) => l.key === key)!;

  const clients = [
    {
      name: 'Harbor Dental Group',
      type: 'Customer',
      notes: 'Three offices. Practice management runs on-prem (Dentrix).',
    },
    { name: 'Northline Architecture', type: 'Customer', notes: 'Heavy CAD users; large file shares on the NAS.' },
    {
      name: 'Cedar Ridge Credit Union',
      type: 'Customer',
      notes: 'Regulated: reasons are required to reveal passwords.',
    },
  ].map((c, i) => ({
    id: uuid(),
    ...c,
    status: 'active' as const,
    requireRevealReason: i === 2,
    createdAt: ago(60 * 24 * 90),
    updatedAt: ago(30 + i * 90),
  }));
  const [harbor, northline, cedar] = clients as [(typeof clients)[0], (typeof clients)[0], (typeof clients)[0]];

  type Asset = {
    id: string;
    clientId: string;
    layoutId: string;
    name: string;
    status: 'active' | 'inactive' | 'retired';
    fields: Record<string, unknown>;
    notes: string;
  };
  const asset = (clientId: string, key: string, name: string, fields: Record<string, unknown>, notes = ''): Asset => ({
    id: uuid(),
    clientId,
    layoutId: layout(key).id,
    name,
    status: 'active',
    fields,
    notes,
  });
  const assets: Asset[] = [
    asset(
      harbor.id,
      'configuration',
      'HDG-FW-01',
      {
        type: 'Firewall',
        manufacturer: 'Fortinet',
        model: 'FortiGate 60F',
        serial_number: 'FGT60FTK2209A1',
        hostname: 'hdg-fw-01',
        ip_address: '10.20.0.1',
        warranty_expires: daysFromNow(40),
      },
      'Primary firewall at the main office.',
    ),
    asset(harbor.id, 'configuration', 'HDG-DC-01', {
      type: 'Server',
      manufacturer: 'Dell',
      model: 'PowerEdge T350',
      ip_address: '10.20.0.10',
      operating_system: 'Windows Server 2022',
    }),
    asset(harbor.id, 'ssl_certificate', 'portal.harbordental.demo', {
      common_name: 'portal.harbordental.demo',
      issuer: "Let's Encrypt",
      expires: daysFromNow(5),
    }),
    asset(harbor.id, 'domain', 'harbordental.demo', {
      registrar: 'Cloudflare',
      dns_host: 'Cloudflare',
      expires: daysFromNow(14),
      auto_renew: false,
    }),
    asset(northline.id, 'configuration', 'NLA-NAS-01', {
      type: 'Storage',
      manufacturer: 'Synology',
      model: 'RS1221+',
      ip_address: '192.168.10.20',
    }),
    asset(northline.id, 'license', 'Autodesk AEC Collection', {
      product: 'AEC Collection',
      vendor: 'Autodesk',
      seats: 12,
      renewal_date: daysFromNow(62),
      billing: 'Annual',
    }),
    asset(cedar.id, 'configuration', 'CRCU-SW-CORE', {
      type: 'Switch',
      manufacturer: 'Aruba',
      model: 'CX 6300M',
      ip_address: '10.50.0.2',
    }),
    asset(cedar.id, 'ssl_certificate', 'online.cedarridgecu.demo', {
      common_name: 'online.cedarridgecu.demo',
      issuer: 'DigiCert',
      expires: daysFromNow(-2),
    }),
  ];

  type Doc = {
    id: string;
    clientId: string | null;
    folderId: string | null;
    title: string;
    status: DocumentStatus;
    reviewDate: string | null;
    content: RichText;
  };
  const documents: Doc[] = [
    {
      id: uuid(),
      clientId: harbor.id,
      folderId: null,
      title: 'Firewall reboot procedure',
      status: 'current' as const,
      reviewDate: daysFromNow(21),
      content: doc(
        h(2, 'Before you start'),
        p('Call the fiber carrier before rebooting the firewall. Schedule outside clinic hours (after 6 pm).'),
        h(2, 'Steps'),
        list(
          [
            'Export the running config from HDG-FW-01.',
            'Notify the office manager.',
            'Reboot from the web UI and confirm VPN tunnels return.',
          ],
          true,
        ),
        h(2, 'Afterwards'),
        p('Confirm Dentrix and the X-ray bridge reconnect, and note the reboot in the ticket.'),
      ),
    },
    {
      id: uuid(),
      clientId: null,
      folderId: null,
      title: 'New client onboarding checklist',
      status: 'current' as const,
      reviewDate: null,
      content: doc(
        p('Our standard steps for every new client.'),
        list([
          'Collect admin credentials into the vault.',
          'Document network and firewall.',
          'Set up backups and verify a restore.',
          'Add contacts and escalation paths.',
        ]),
      ),
    },
    {
      id: uuid(),
      clientId: northline.id,
      folderId: null,
      title: 'NAS backup verification',
      status: 'needs_review' as const,
      reviewDate: daysFromNow(-3),
      content: doc(
        p('Monthly: restore a random project folder from Hyper Backup to the scratch share and compare checksums.'),
      ),
    },
  ];

  const passwords = [
    {
      clientId: harbor.id,
      name: 'HDG-FW-01 admin',
      username: 'admin',
      url: 'https://10.20.0.1',
      secret: 'Fg!7rq-Harbor-2026',
      rotationDays: 90,
      changedDaysAgo: 80,
    },
    {
      clientId: harbor.id,
      name: 'Microsoft 365 global admin',
      username: 'admin@harbordental.demo',
      url: 'https://admin.microsoft.com',
      secret: 'Tidal-Crane-Copper-41',
      totp: true,
      rotationDays: 180,
      changedDaysAgo: 20,
    },
    {
      clientId: harbor.id,
      name: 'HDG-DC-01 · C:',
      kind: 'bitlocker' as const,
      secret: '123456-234567-345678-456789-567890-678901-789012-890123',
      changedDaysAgo: 200,
    },
    {
      clientId: northline.id,
      name: 'Synology DSM admin',
      username: 'nla-admin',
      url: 'https://192.168.10.20:5001',
      secret: 'Maple-Orbit-Quartz-88',
      rotationDays: 90,
      changedDaysAgo: 30,
    },
    {
      clientId: cedar.id,
      name: 'Core switch enable',
      username: 'manager',
      secret: 'Ced@rCore!2026',
      rotationDays: 60,
      changedDaysAgo: 58,
      restricted: true,
    },
  ].map((x) => ({
    id: uuid(),
    kind: 'login' as 'login' | 'bitlocker',
    username: '',
    url: '',
    notes: '',
    totp: false,
    rotationDays: null as number | null,
    restricted: false,
    ...x,
    changedAt: new Date(Date.now() - x.changedDaysAgo * DAY).toISOString(),
  }));

  const contacts = [
    {
      clientId: harbor.id,
      name: 'Dana Morales',
      title: 'Office manager',
      email: 'dana@harbordental.demo',
      phone: '(919) 555-0142',
      primary: true,
    },
    {
      clientId: northline.id,
      name: 'Chris Nakamura',
      title: 'Principal',
      email: 'chris@northline.demo',
      phone: '(919) 555-0188',
      primary: true,
    },
    {
      clientId: cedar.id,
      name: 'Robin Hale',
      title: 'VP Operations',
      email: 'rhale@cedarridgecu.demo',
      phone: '(336) 555-0107',
      primary: true,
    },
  ].map((c) => ({ id: uuid(), mobile: '', notes: '', updatedAt: ago(600), ...c }));
  const locations = [
    {
      clientId: harbor.id,
      name: 'Main office',
      address: '410 Harbor St',
      city: 'Raleigh',
      region: 'NC',
      postalCode: '27601',
      primary: true,
    },
    {
      clientId: harbor.id,
      name: 'Cary clinic',
      address: '88 Kildaire Farm Rd',
      city: 'Cary',
      region: 'NC',
      postalCode: '27511',
      primary: false,
    },
    {
      clientId: northline.id,
      name: 'Studio',
      address: '12 W Main St',
      city: 'Durham',
      region: 'NC',
      postalCode: '27701',
      primary: true,
    },
  ].map((l) => ({ id: uuid(), country: 'US', phone: '', notes: '', updatedAt: ago(900), ...l }));

  const groups = [
    {
      id: uuid(),
      name: 'Tier 1 helpdesk',
      description: 'Read access to every client for first-line support.',
      memberIds: [users[2]!.id],
      grants: clients.map((c) => ({ clientId: c.id, level: 'read' as AccessLevel })),
      updatedAt: ago(3000),
    },
  ];

  const events = [
    ['Signed in', 'Password and MFA', 2],
    ['Passkey added', 'Office laptop', 60],
    ['Email settings changed', 'smtp.office365.com:587', 120],
    ['Group created', 'Tier 1 helpdesk · 1 members · 3 clients', 3000],
    ['User created', 'sam@itdoneright.demo · Read-only technician', 3100],
    ['Signed in', 'Password and MFA', 3200],
  ].map(([action, detail, minutes], i) => ({
    id: String(100 - i),
    actor: owner.name,
    action: action as string,
    detail: detail as string,
    ip: '203.0.113.24',
    createdAt: ago(minutes as number),
  }));

  return { orgId, owner, users, layouts, clients, assets, documents, passwords, contacts, locations, groups, events };
}
