import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { mapNote, mapTicket, portalIdIn, ticketLink, ticketNumberIn } from '../src/services/integrations/cw-tickets.js';
import { CwLinkWriter } from '../src/services/integrations/cw-writeback.js';
import type { CwRmmClient } from '../src/services/integrations/cw-rmm.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const CLIENT_ID = 'asio-client-id-123';
const SECRET = 'asio-secret-value-456';
const TEMP = 'temporary pass 1234';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Ticket = Record<string, unknown>;

const STATUSES = [
  { id: 's-new', name: 'New', category: 'New' },
  { id: 's-wait', name: 'Waiting for parts', category: 'InProgress' },
  { id: 's-prog', name: 'In progress', category: 'InProgress' },
  { id: 's-done', name: 'Closed', category: 'Closed' },
];

/**
 * A fake ConnectWise platform API with two companies and its service ticketing API, which answers only to a token
 * that asked for the tickets scope.
 */
function fakePlatform(tickets: Map<string, Ticket[]>, opts: { ticketScope?: boolean; closedFails?: boolean } = {}) {
  const calls: string[] = [];
  /** Notes and custom field values ConnectWise was sent, by ticket and by path. */
  const notes = new Map<string, Ticket[]>();
  const fields = new Map<string, unknown>();
  const definitions: Ticket[] = [];
  /** Company records by ID, as their own endpoint returns them (the list carries less). */
  const companies = new Map<string, Ticket>();
  const sites = new Map<string, Ticket[]>();
  /** Tickets Atlas opened. */
  const opened: Ticket[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push(`${init?.method ?? 'GET'} ${url.pathname}${url.search}`);
    if (url.pathname === '/v1/token') {
      const scope = String(JSON.parse(String(init?.body)).scope);
      if (scope.includes('tickets') && opts.ticketScope === false) return json({ error: 'invalid_scope' }, 400);
      return json({ access_token: scope.includes('tickets') ? 'ticket-tok' : 'tok', expires_in: 3600 });
    }
    const auth = (init?.headers as Record<string, string>).Authorization;
    if (url.pathname === '/api/platform/v1/company/companies')
      return json([
        { id: 'c1', name: 'Harbor Dental Group', externalIds: [{ externalId: '19304' }] },
        { id: 'c2', name: 'Northline Architecture' },
      ]);
    const sitesOf = /companies\/(\w+)\/sites$/.exec(url.pathname);
    if (sitesOf) return json(sites.get(sitesOf[1]!) ?? []);
    const companyOf = /^\/api\/platform\/v1\/company\/companies\/(\w+)$/.exec(url.pathname);
    if (companyOf && companies.has(companyOf[1]!)) return json(companies.get(companyOf[1]!));
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints')
      return json({ message: 'resource not found' }, 404);
    if (url.pathname.includes('/ticketing/') && auth !== 'Bearer ticket-tok')
      return json({ message: 'missing scope' }, 403);
    if (url.pathname === '/api/platform/v1/service/ticketing/statuses') return json(STATUSES);
    if (url.pathname === '/api/platform/v1/service/ticketing/service-boards')
      return json([
        { id: 'b-help', name: 'Help Desk' },
        { id: 'b-renew', name: 'Renewals' },
      ]);
    if (url.pathname === '/api/platform/v1/service/ticketing/sources')
      return json([
        { id: 'src-phone', name: 'Phone' },
        { id: 'src-int', name: 'Internal' },
      ]);
    const noteOf = /^\/api\/platform\/v1\/service\/ticketing\/tickets\/([^/]+)\/notes$/.exec(url.pathname);
    if (noteOf) {
      const list = notes.get(noteOf[1]) ?? [];
      if (init?.method !== 'POST') return json(list);
      const note = {
        id: `n-${list.length + 1}`,
        createdAt: new Date().toISOString(),
        createdBy: 'API',
        ...JSON.parse(String(init.body)),
      };
      notes.set(noteOf[1], [...list, note]);
      return json(note, 201);
    }
    if (url.pathname === '/api/platform/v1/custom-field/definitions') {
      if (init?.method !== 'POST') return json(definitions);
      const created = { id: `def-${definitions.length + 1}`, ...JSON.parse(String(init.body)) };
      definitions.push(created);
      return json(created, 201);
    }
    if (url.pathname.endsWith('/custom-fields') && init?.method === 'PUT') {
      fields.set(url.pathname, JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }
    if (url.pathname === '/api/platform/v2/service/ticketing/tickets' && init?.method === 'POST') {
      opened.push(JSON.parse(String(init.body)));
      return json({ id: `new-${opened.length}`, number: String(9000 + opened.length) }, 201);
    }
    if (url.pathname === '/api/platform/v2/service/ticketing/tickets') {
      // As the spec defines it: "id1,id2" is in, "[notIn],id1,id2" is not in; anything else in brackets is refused,
      // as a real tenant did with "[in]".
      const given = url.searchParams.get('statusIds');
      const list = (given ?? '').split(',');
      const notIn = list[0] === '[notIn]';
      const ids = notIn ? list.slice(1) : list;
      if (ids.some((id) => id.startsWith('['))) return json({ message: "Invalid datatype for 'statusIds'" }, 400);
      if (given && !notIn && opts.closedFails) return json({ message: 'invalid filter' }, 400);
      const all = (tickets.get(url.searchParams.get('companyIds') ?? '') ?? []).filter((k) => {
        const status = (k.status as { id: string }).id;
        return given === null ? true : notIn ? !ids.includes(status) : ids.includes(status);
      });
      const size = Number(url.searchParams.get('pageSize'));
      const from = (Number(url.searchParams.get('pageNum')) - 1) * size;
      return json({ tickets: all.slice(from, from + size), totalCount: all.length });
    }
    return json({}, 404);
  }) as typeof fetch;
  return { fetcher, calls, notes, fields, definitions, companies, sites, opened };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('ticket values', () => {
  it('reads whichever field names are present, and keeps only web links', () => {
    const t = mapTicket({
      id: 4021,
      summary: '<img src=x onerror=alert(1)> Printer\u0007 offline',
      status: { name: 'Waiting on client' },
      priority: { name: 'Priority 2' },
      dateEntered: '2026-09-01T10:00:00Z',
      _info: { lastUpdated: '2026-09-02T10:00:00Z' },
      url: 'javascript:alert(1)',
    })!;
    expect(t).toMatchObject({
      id: '4021',
      number: '4021',
      status: 'Waiting on client',
      closed: false,
      priority: 'Priority 2',
      url: null,
    });
    // Kept as text (the page escapes it), without control characters.
    expect(t.summary).toBe('<img src=x onerror=alert(1)> Printer offline');
    expect(t.openedAt?.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(t.updatedAt?.toISOString()).toBe('2026-09-02T10:00:00.000Z');
    expect(mapTicket({ ticketId: 'T-9', statusName: 'Closed', url: 'https://cw.example/t/9' })).toMatchObject({
      closed: true,
      url: 'https://cw.example/t/9',
    });
    expect(mapTicket({ id: 1, status: 'Scheduled', closedFlag: false, closedDate: '2026-09-01' })!.closed).toBe(false);
    expect(mapTicket({ summary: 'no id' })).toBeNull();
    // Where the ticket sits and came from, and the portal's plain ticket ID over a dotted number.
    expect(
      mapTicket(
        {
          id: 'u-2',
          number: '133023.1533',
          nocTicketId: '5535',
          summary: 'Network attack found on computer: PC12',
          serviceBoard: { id: 'b', name: 'NOC Alerts' },
          source: { id: 's', name: 'Monitoring' },
          type: { id: 't', name: 'Incident' },
        },
        Date.now(),
        new Set(),
        (n) => ticketLink('https://control.itsupport247.net', n, '19304'),
      ),
    ).toMatchObject({
      number: '5535',
      board: 'NOC Alerts',
      origin: 'Monitoring',
      kind: 'Incident',
      url: 'https://control.itsupport247.net/QADashB/QuickAccess/NewDesktops/service-tickets?SSECTION=10020&STAB=10020#??asio_route=/service-tickets/bms-ticket-overview?ticketId=5535&companyId=19304&projectIssue=false&tabId=unified-ticket-detail-screen??',
    });
    expect(ticketLink('https://control.itsupport247.net', '133023.1533', '19304')).toBeNull();
    // Linked by the platform company ID.
    expect(ticketLink('https://control.itsupport247.net', '5535', '72f2b461-1e35-4df0-be5c-d55f10b6052f')).toContain(
      'ticketId=5535&companyId=72f2b461-1e35-4df0-be5c-d55f10b6052f',
    );
    expect(ticketLink('https://control.itsupport247.net', '5535', 'not an id')).toBeNull();
    // ConnectWise's long alert ID is never shown as the ticket number, or linked.
    expect(mapTicket({ id: 'u-9', number: '133023.1670', nocTicketId: '202609080102782' })?.number).toBe('133023.1670');
    expect(ticketLink('https://control.itsupport247.net', '202609080102782', 'c1')).toBeNull();
    expect(portalIdIn('Connectwise ticket id 5283 is created to match ASIO ticket id 133023.1670', '133023.1670')).toBe(
      '5283',
    );
    expect(
      portalIdIn('Connectwise ticket id 5283 is created to match ASIO ticket id 133023.1670', '133023.1671'),
    ).toBeNull();
    // The platform's shape: a status ID in the Closed category closes it, whatever the status is called.
    expect(
      mapTicket({ id: 'u-1', number: '7', status: { id: 's-x', name: 'Done' } }, Date.now(), new Set(['s-x'])),
    ).toMatchObject({ id: 'u-1', number: '7', status: 'Done', closed: true });
  });
});

describe('ticket notes', () => {
  it('finds a ticket number in a reveal reason', () => {
    expect(ticketNumberIn('Fixing #4512 for Jane')).toBe('4512');
    expect(ticketNumberIn('ticket 88 printer')).toBe('88');
    expect(ticketNumberIn('Ticket no. 301')).toBe('301');
    expect(ticketNumberIn('T1234')).toBe('1234');
    expect(ticketNumberIn('checking the backup')).toBeNull();
  });
  it('maps a note, dropping control characters', () => {
    expect(
      mapNote({ id: 'n1', detail: 'Called\u0007 client', createdAt: '2026-09-01T10:00:00Z', createdBy: 'Sam' }),
    ).toEqual({
      id: 'n1',
      text: 'Called client',
      createdAt: '2026-09-01T10:00:00.000Z',
      createdBy: 'Sam',
    });
    expect(mapNote({ id: 'n2', detail: '  ' })).toBeNull();
  });
});

describe('ticket sync and dashboard', () => {
  let t: TestApp;
  let owner: Browser;
  let tickets: Map<string, Ticket[]>;
  let platform: ReturnType<typeof fakePlatform>;
  let harbor: string;
  let northline: string;

  const connect = async (
    fetcherTickets: Map<string, Ticket[]>,
    opts?: { ticketScope?: boolean; closedFails?: boolean },
  ) => {
    platform = fakePlatform(fetcherTickets, opts);
    t = await startApp({}, { cwRmmFetch: platform.fetcher });
    owner = (await setupOwner(t.app)).b;
    await owner.call('PUT', '/api/integrations/cw-rmm', { clientId: CLIENT_ID, clientSecret: SECRET });
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
  };
  const link = () =>
    owner.call('PUT', '/api/integrations/cw-rmm/companies', {
      mappings: [
        { companyId: 'c1', action: 'link', clientId: harbor },
        { companyId: 'c2', action: 'link', clientId: northline },
      ],
    });
  const sync = async () => waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-rmm/sync', {})).data.id);

  beforeEach(() => {
    const status = (id: string) => ({ id, name: STATUSES.find((x) => x.id === id)!.name });
    tickets = new Map([
      [
        'c1',
        [
          {
            id: 't-101',
            number: '101',
            summary: 'Server down',
            status: status('s-new'),
            createdAt: ago(0.1),
            updatedAt: ago(0.1),
          },
          {
            id: 't-102',
            number: '102',
            summary: 'Printer',
            status: status('s-new'),
            createdAt: ago(3),
            updatedAt: ago(2),
          },
          {
            id: 't-103',
            number: '103',
            summary: 'Laptop order',
            status: status('s-wait'),
            createdAt: ago(20),
            updatedAt: ago(15),
            url: 'https://na.myconnectwise.net/ticket/103',
          },
          // Closed is told by the status's category, not its name.
          {
            id: 't-104',
            number: '104',
            summary: 'Password reset',
            status: status('s-done'),
            createdAt: ago(5),
            updatedAt: ago(4),
          },
          // Closed long ago: not kept.
          {
            id: 't-105',
            number: '105',
            summary: 'Old',
            status: status('s-done'),
            createdAt: ago(210),
            updatedAt: ago(200),
          },
        ],
      ],
      [
        'c2',
        [
          {
            id: 't-201',
            number: '201',
            summary: 'VPN',
            status: status('s-prog'),
            createdAt: ago(40),
            updatedAt: ago(1),
          },
        ],
      ],
    ]);
  });
  afterEach(async () => {
    await t.close();
  });

  it('syncs tickets read-only, with counts, a daily chart, and a list oldest-updated first', async () => {
    await connect(tickets);
    const before = (await owner.call('GET', `/api/tickets?client=${harbor}`)).data;
    expect(before).toMatchObject({ linked: false, open: 0, statuses: [] });

    expect((await link()).status).toBe(200);
    const job = await sync();
    expect(job.status).toBe('done');
    expect(job.counts.tickets).toMatchObject({ created: 5, failed: 0 });
    // Only reads: the platform never saw a write for tickets.
    expect(platform.calls.filter((c) => c.includes('ticket') && !c.startsWith('GET'))).toEqual([]);

    const report = (await owner.call('GET', `/api/tickets?client=${harbor}&days=7`)).data;
    expect(report).toMatchObject({ linked: true, days: 7, open: 3 });
    expect(report.statuses).toEqual([
      { name: 'New', count: 2, closed: false },
      { name: 'Waiting for parts', count: 1, closed: false },
      { name: 'Closed', count: 1, closed: true },
    ]);
    expect(report.trend).toHaveLength(7);
    expect(report.trend.reduce((n: number, p: { opened: number }) => n + p.opened, 0)).toBe(3);
    expect(report.trend.reduce((n: number, p: { closed: number }) => n + p.closed, 0)).toBe(1);
    expect(report.trend.at(-1).day).toBe(new Date().toISOString().slice(0, 10));
    // An unknown period is 30 days.
    expect((await owner.call('GET', '/api/tickets?days=12')).data.days).toBe(30);

    const all = (await owner.call('GET', '/api/tickets')).data;
    expect(all.open).toBe(4);

    const list = (await owner.call('GET', `/api/tickets/list?client=${harbor}`)).data;
    expect(list.map((k: { number: string }) => k.number)).toEqual(['103', '102', '101']);
    expect(list[0]).toMatchObject({ status: 'Waiting for parts', url: 'https://na.myconnectwise.net/ticket/103' });
    // Without a link of its own, a ticket links to the platform's web app by ticket number and platform company ID.
    expect(list[1].url).toBe(
      'https://control.itsupport247.net/QADashB/QuickAccess/NewDesktops/service-tickets?SSECTION=10020&STAB=10020#??asio_route=/service-tickets/bms-ticket-overview?ticketId=102&companyId=c1&projectIssue=false&tabId=unified-ticket-detail-screen??',
    );
    // Only the v2 ticket list is asked: no legacy v1 company, status or note lookups.
    const lists = platform.calls.filter((c) => c.includes('/v2/service/ticketing/tickets?companyIds=c1'));
    expect(lists).toHaveLength(1);
    expect(platform.calls.filter((c) => c.includes('/ticketing/') && c.includes('/v1/'))).toEqual([]);
    const closed = (await owner.call('GET', `/api/tickets/list?client=${harbor}&status=Closed`)).data;
    expect(closed.map((k: { number: string }) => k.number)).toEqual(['104']);

    // A ticket gone from ConnectWise is removed; an unlinked company's tickets go.
    tickets.set(
      'c1',
      tickets.get('c1')!.filter((k) => k.id !== 't-101'),
    );
    await owner.call('PUT', '/api/integrations/cw-rmm/companies', { mappings: [{ companyId: 'c2', action: 'skip' }] });
    expect((await sync()).status).toBe('done');
    const after = (await owner.call('GET', '/api/tickets')).data;
    expect(after.open).toBe(2);
    expect((await owner.call('GET', `/api/tickets?client=${northline}`)).data).toMatchObject({
      linked: false,
      open: 0,
    });
  });

  it('shows only clients the viewer can read, and hides others as not found', async () => {
    await connect(tickets);
    await link();
    await sync();
    const created = await owner.call('POST', '/api/users', {
      email: 'viewer@northline.test',
      name: 'Northline Viewer',
      role: 'client_viewer',
      password: TEMP,
      grants: [{ clientId: northline, level: 'read' }],
    });
    expect(created.status).toBe(201);
    const { b } = await signIn(t.app, 'viewer@northline.test', TEMP);
    const changed = await b.call('POST', '/api/account/password', { current: TEMP, next: 'harbor lights read only 7' });
    expect(changed.data.stage, JSON.stringify(changed.data)).toBe('active');

    const report = (await b.call('GET', '/api/tickets')).data;
    expect(report).toMatchObject({ linked: true, open: 1 });
    expect(report.statuses).toEqual([{ name: 'In progress', count: 1, closed: false }]);
    const list = (await b.call('GET', '/api/tickets/list')).data;
    expect(list.map((k: { clientId: string }) => k.clientId)).toEqual([northline]);
    expect((await b.call('GET', `/api/tickets?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/tickets?client=not-a-uuid')).status).toBe(404);
    expect((await b.call('GET', `/api/tickets/list?client=${harbor}`)).status).toBe(404);
    expect((await b.call('GET', '/api/tickets/list?status=New')).data).toEqual([]);
  });

  it('keeps syncing devices when the key has no ticket access, signing in for tickets only once', async () => {
    await connect(tickets, { ticketScope: false });
    await link();
    const job = await sync();
    expect(job.status).toBe('done');
    expect(job.counts.tickets).toMatchObject({ failed: 1 });
    expect(job.messages.join(' ')).toMatch(/Tickets for company c1: ConnectWise RMM rejected .*invalid_scope/);
    expect(job.messages).toContain('Tickets not read for the other 1 company.');
    // No other request shape or company is tried once the key can't sign in, so it isn't locked for signing in often.
    expect(platform.calls.filter((c) => c.startsWith('POST /v1/token')).length).toBe(2);
    expect(platform.calls.some((c) => c.includes('/ticket'))).toBe(false);
    const rows = await t.handle.db.execute(sql`select count(*)::int as n from tickets`);
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  it('drops tickets when switched off or disconnected, and syncs none while off', async () => {
    await connect(tickets);
    await link();
    await sync();
    expect((await owner.call('GET', '/api/tickets')).data.open).toBe(4);
    const options = await owner.call('PUT', '/api/integrations/cw-rmm/options', {
      locations: true,
      devices: true,
      tickets: false,
    });
    expect(options.data.options.tickets).toBe(false);
    // Gone at once, not frozen at the last sync.
    expect((await owner.call('GET', `/api/tickets?client=${harbor}`)).data).toMatchObject({ linked: false, open: 0 });
    expect((await owner.call('GET', '/api/tickets/list')).data).toEqual([]);
    const calls = platform.calls.length;
    await sync();
    expect(platform.calls.slice(calls).some((c) => c.includes('/ticket'))).toBe(false);

    await owner.call('PUT', '/api/integrations/cw-rmm/options', { locations: true, devices: true, tickets: true });
    await sync();
    expect((await owner.call('GET', '/api/tickets')).data.open).toBe(4);
    expect((await owner.call('DELETE', '/api/integrations/cw-rmm')).status).toBe(200);
    const rows = await t.handle.db.execute(sql`select count(*)::int as n from tickets`);
    expect(rows.rows[0]).toEqual({ n: 0 });
  });

  const allOptions = (extra: Record<string, unknown>) =>
    owner.call('PUT', '/api/integrations/cw-rmm/options', { locations: true, devices: true, tickets: true, ...extra });

  it('shows ticket notes, and adds them from Atlas and on a password reveal only when switched on', async () => {
    await connect(tickets);
    await link();
    await sync();
    platform.notes.set('t-101', [{ id: 'n-0', detail: 'Rebooted the server', createdBy: 'Sam', createdAt: ago(0.05) }]);
    const shown = (await owner.call('GET', '/api/tickets/t-101/notes')).data;
    expect(shown).toMatchObject({ canAdd: false, notes: [{ text: 'Rebooted the server', createdBy: 'Sam' }] });
    expect((await owner.call('GET', '/api/tickets/nope/notes')).status).toBe(404);

    // Off by default: nothing is written, from the ticket or from a reveal.
    expect((await owner.call('POST', '/api/tickets/t-101/notes', { text: 'Hello' })).status).toBe(403);
    const pw = await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Server admin', secret: TEMP });
    expect(pw.status).toBe(201);
    await owner.call('POST', `/api/passwords/${pw.data.id}/reveal`, { reason: 'Working #101' });
    expect(platform.calls.filter((c) => c.startsWith('POST') && c.includes('/notes'))).toEqual([]);

    expect((await allOptions({ ticketNotes: true })).data.options.ticketNotes).toBe(true);
    const added = await owner.call('POST', '/api/tickets/t-101/notes', { text: 'Replaced the disk' });
    expect(added.status).toBe(200);
    expect(added.data.canAdd).toBe(true);
    expect(platform.notes.get('t-101')!.at(-1)).toMatchObject({
      detail: expect.stringMatching(/^Replaced the disk\n\n\(Added from Nexus Atlas by /),
      visibility: 2,
    });

    // A reveal naming the ticket notes who looked and why, never the password.
    await owner.call('POST', `/api/passwords/${pw.data.id}/reveal`, { reason: 'Working #101', copy: true });
    await owner.call('POST', `/api/passwords/${pw.data.id}/reveal`, { reason: 'Working #201' });
    await owner.call('POST', `/api/passwords/${pw.data.id}/reveal`, { reason: 'no ticket' });
    const onTicket = platform.notes.get('t-101')!.at(-1)!;
    expect(onTicket.detail).toMatch(/copied the password of “Server admin” in Nexus Atlas\.\nReason: Working #101$/);
    expect(JSON.stringify([...platform.notes.values()])).not.toContain(TEMP);
    // Ticket 201 belongs to another client, so it gets nothing.
    expect(platform.notes.get('t-201')).toBeUndefined();
    expect(platform.notes.get('t-101')).toHaveLength(3);
  });

  it('writes Atlas links only when switched on, never through the legacy v1 custom field API', async () => {
    await connect(tickets);
    await link();
    await sync();
    expect(platform.calls.filter((c) => c.includes('custom-field'))).toEqual([]);

    await allOptions({ atlasLinks: true });
    const job = await sync();
    expect(job.status).toBe('done');
    // Companies have no v2 custom field API, so only devices are written, and nothing touches v1.
    expect(platform.calls.filter((c) => c.includes('/v1/') && c.includes('custom-field'))).toEqual([]);
    expect(platform.calls.filter((c) => c.startsWith('PUT'))).toEqual([]);
  });

  it('opens one ConnectWise ticket per expiry coming due, only when switched on', async () => {
    await connect(tickets);
    await link();
    const domains = (await owner.call('GET', '/api/layouts')).data.find((l: { key: string }) => l.key === 'domain');
    const soon = new Date(Date.now() + 10 * DAY).toISOString().slice(0, 10);
    const later = new Date(Date.now() + 120 * DAY).toISOString().slice(0, 10);
    const domain = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: domains.id,
        name: 'harbordental.test',
        fields: { expires: soon },
      })
    ).data;
    await owner.call('POST', `/api/clients/${northline}/assets`, {
      layoutId: domains.id,
      name: 'northline.test',
      fields: { expires: later },
    });
    await sync();
    expect(platform.opened).toEqual([]);

    await allOptions({ expiryTickets: true, expiryTicketBoard: 'renewals' });
    const job = await sync();
    expect(job.counts.expiryTickets, JSON.stringify(job.messages)).toMatchObject({ created: 1 });
    expect(platform.opened).toHaveLength(1);
    expect(platform.opened[0]).toMatchObject({
      summary: `Domains: harbordental.test expires on ${soon}`,
      company: { id: 'c1' },
      serviceBoard: { id: 'b-renew' },
      source: { id: 'src-int' },
    });
    expect(job.messages.join(' ')).toContain('"Renewals" board with source "Internal"');

    // Not again on the next sync, even with the layout renamed; a renewed date that comes due gets its own.
    expect((await owner.call('PATCH', `/api/layouts/${domains.id}`, { name: 'Web domains' })).status).toBe(200);
    await sync();
    expect(platform.opened).toHaveLength(1);
    const renewed = new Date(Date.now() + 20 * DAY).toISOString().slice(0, 10);
    await owner.call('PATCH', `/api/assets/${domain.id}`, {
      name: domain.name,
      fields: { expires: renewed },
      version: domain.version,
    });
    await sync();
    expect(platform.opened).toHaveLength(2);

    // A board that doesn't exist opens nothing and says so.
    await allOptions({ expiryTickets: true, expiryTicketBoard: 'Nope', expiryTicketDays: 180 });
    const none = await sync();
    expect(platform.opened).toHaveLength(2);
    expect(none.messages.join(' ')).toContain('no service board named "Nope"');
  });
});

describe('Atlas link writer', () => {
  it('finds the "Atlas link" device field through v2 and writes to it, never calling v1', async () => {
    const calls: string[] = [];
    const fields = [{ attributeId: 'attr-1', name: 'Atlas link', value: null }];
    const client = {
      get: async (path: string) => (calls.push(`GET ${path}`), fields),
      put: async (path: string, body: unknown) => (calls.push(`PUT ${path} ${JSON.stringify(body)}`), []),
    } as unknown as CwRmmClient;
    const writer = new CwLinkWriter(client);
    await writer.write('e-1', 'https://atlas.test/assets/a1');
    await writer.write('e-2', 'https://atlas.test/assets/a2');
    expect(calls).toEqual([
      'GET /api/platform/v2/device/endpoints/e-1/custom-fields?withDefaults=true',
      'PUT /api/platform/v2/device/endpoints/e-1/custom-fields [{"entityId":"e-1","attributeId":"attr-1","value":"https://atlas.test/assets/a1"}]',
      'PUT /api/platform/v2/device/endpoints/e-2/custom-fields [{"entityId":"e-2","attributeId":"attr-1","value":"https://atlas.test/assets/a2"}]',
    ]);
    fields.length = 0;
    await expect(new CwLinkWriter(client).write('e-3', 'x')).rejects.toThrow(
      /no device custom field named "Atlas link"/,
    );
  });
});
