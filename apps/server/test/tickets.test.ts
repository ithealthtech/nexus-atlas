import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { mapNote, mapTicket, ticketLink, ticketNumberIn } from '../src/services/integrations/cw-tickets.js';
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
    if (/companies\/\w+\/sites$/.test(url.pathname)) return json([]);
    if (url.pathname === '/api/platform/v2/device/categories/all/endpoints')
      return json({ message: 'resource not found' }, 404);
    if (url.pathname.includes('/ticketing/') && auth !== 'Bearer ticket-tok')
      return json({ message: 'missing scope' }, 403);
    if (url.pathname === '/api/platform/v1/service/ticketing/statuses') return json(STATUSES);
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
  return { fetcher, calls, notes, fields, definitions };
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

  it('shows and links the portal ID a CW-System note gives a dotted platform ticket', async () => {
    tickets.get('c1')!.push(
      {
        id: 't-a1',
        number: '133023.1670',
        summary: 'Network attack',
        status: { id: 's-new', name: 'New' },
        createdAt: ago(2),
      },
      {
        id: 't-a2',
        number: '133023.1671',
        summary: 'No note yet',
        status: { id: 's-new', name: 'New' },
        createdAt: ago(3),
      },
      {
        id: 't-a3',
        number: '133023.1672',
        summary: 'Mismatched note',
        status: { id: 's-new', name: 'New' },
        createdAt: ago(4),
      },
    );
    await connect(tickets);
    platform.notes.set('t-a1', [
      {
        id: 'n-1',
        detail: 'Connectwise ticket id 5283 is created to match ASIO ticket id 133023.1670',
        createdBy: 'CW-System',
      },
    ]);
    // A note naming another ticket's number (pasted in, say) is not this ticket's portal ID.
    platform.notes.set('t-a3', [
      { id: 'n-2', detail: 'Connectwise ticket id 5283 is created to match ASIO ticket id 133023.1670.' },
    ]);
    expect((await link()).status).toBe(200);
    expect((await sync()).status).toBe('done');
    const list = (await owner.call('GET', `/api/tickets/list?client=${harbor}`)).data;
    const shown = (s: string) => list.find((k: { summary: string }) => k.summary === s);
    expect(shown('Network attack')).toMatchObject({
      number: '5283',
      url: expect.stringContaining('ticketId=5283&companyId=19304'),
    });
    expect(shown('Mismatched note')).toMatchObject({ number: '133023.1672', url: null });
    expect(shown('No note yet')).toMatchObject({ number: '133023.1671', url: null });
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
    // Without a link of its own, a ticket links to the platform's web app by ticket and company number.
    expect(list[1].url).toBe(
      'https://control.itsupport247.net/QADashB/QuickAccess/NewDesktops/service-tickets?SSECTION=10020&STAB=10020#??asio_route=/service-tickets/bms-ticket-overview?ticketId=102&companyId=19304&projectIssue=false&tabId=unified-ticket-detail-screen??',
    );
    // Open tickets and recently closed ones are asked for separately, by status.
    const lists = platform.calls.filter((c) => c.includes('/v2/service/ticketing/tickets?companyIds=c1'));
    expect(lists.map((c) => new URL(c.split(' ')[1], 'https://x').searchParams.get('statusIds'))).toEqual([
      '[notIn],s-done',
      's-done',
    ]);
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

  it('keeps closed tickets already synced when ConnectWise refuses to list closed ones', async () => {
    const opts = { closedFails: false };
    await connect(tickets, opts);
    await link();
    await sync();
    expect((await owner.call('GET', `/api/tickets/list?client=${harbor}&status=Closed`)).data).toHaveLength(1);
    opts.closedFails = true;
    const job = await sync();
    expect(job.status).toBe('done');
    expect(job.messages.join(' ')).toMatch(/Closed tickets couldn't be listed/);
    expect((await owner.call('GET', `/api/tickets/list?client=${harbor}&status=Closed`)).data).toHaveLength(1);
    expect((await owner.call('GET', `/api/tickets?client=${harbor}`)).data.open).toBe(3);
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

  it('writes Atlas links into ConnectWise custom fields only when switched on, and only when changed', async () => {
    await connect(tickets);
    await link();
    await sync();
    expect(platform.calls.filter((c) => c.includes('custom-field'))).toEqual([]);

    await allOptions({ atlasLinks: true });
    const job = await sync();
    expect(job.counts.atlasLinks).toMatchObject({ created: 2, failed: 0 });
    // The field is made once, for companies.
    expect(platform.definitions).toEqual([
      expect.objectContaining({ entityType: 'client', name: 'Atlas link', attributeType: 'string' }),
    ]);
    expect(platform.fields.get('/api/platform/v1/company/companies/c1/custom-fields')).toEqual([
      { entityId: 'c1', attributeId: 'def-1', value: expect.stringMatching(new RegExp(`/clients/${harbor}$`)) },
    ]);

    // Unchanged links aren't written again.
    const before = platform.calls.length;
    expect((await sync()).counts.atlasLinks).toMatchObject({ created: 0, skipped: 2 });
    expect(platform.calls.slice(before).filter((c) => c.startsWith('PUT'))).toEqual([]);

    // Switched off and on again, they're all written again.
    await allOptions({ atlasLinks: false });
    await allOptions({ atlasLinks: true });
    expect((await sync()).counts.atlasLinks).toMatchObject({ created: 2 });
  });
});
