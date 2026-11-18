import { afterEach, describe, expect, it } from 'vitest';
import { psaSiteUrl } from '@atlas/shared';
import { mapPsaTicket, psaString } from '../src/services/integrations/cw-psa-tickets.js';
import { setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const SITE = 'api-na.myconnectwise.net';
const API = `https://${SITE}/v4_6_release/apis/3.0`;
const LOGIN = {
  companyId: 'itdr',
  publicKey: 'public-key-123',
  privateKey: 'private-key-456',
  clientId: 'client-id-789',
};
const TEMP = 'temporary pass 1234';
const DAY = 86_400_000;
const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();

type Json = Record<string, unknown>;

/** The value PSA conditions compare a field to, as in `name="Help Desk"`. */
const valueOf = (conditions: string, field: string) =>
  new RegExp(`${field.replace('/', '\\/')}=("((?:[^"\\\\]|\\\\.)*)"|\\d+)`).exec(conditions)?.[2] ??
  new RegExp(`${field.replace('/', '\\/')}=(\\d+)`).exec(conditions)?.[1];

/**
 * A fake ConnectWise PSA REST API: two companies, boards, sources, one contact, and service tickets with notes. It
 * answers only to the right keys and clientId, as PSA does.
 */
function fakePsa() {
  const calls: string[] = [];
  const opened: Json[] = [];
  const tickets: Json[] = [
    {
      id: 8100,
      summary: 'Laptop order',
      company: { id: 250 },
      board: { name: 'Help Desk' },
      status: { name: 'Waiting on client' },
      priority: { name: 'Priority 3 - Normal' },
      closedFlag: false,
      dateEntered: ago(3),
      _info: { lastUpdated: ago(1) },
    },
    {
      id: 8101,
      summary: 'Closed last year',
      company: { id: 250 },
      status: { name: 'Closed' },
      closedFlag: true,
      closedDate: ago(400),
      dateEntered: ago(410),
    },
    { id: 8200, summary: 'Northline VPN', company: { id: 251 }, status: { name: 'New' }, closedFlag: false },
  ];
  const notes = new Map<string, Json[]>();
  const auth = `Basic ${Buffer.from(`${LOGIN.companyId}+${LOGIN.publicKey}:${LOGIN.privateKey}`).toString('base64')}`;
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    calls.push(`${method} ${url.pathname}${url.search}`);
    const headers = init?.headers as Record<string, string>;
    if (!url.href.startsWith(API)) return json({ message: 'not found' }, 404);
    if (headers.Authorization !== auth || headers.clientId !== LOGIN.clientId)
      return json({ code: 'Unauthorized', message: 'Invalid credentials' }, 401);
    const path = url.pathname.slice(new URL(API).pathname.length);
    const conditions = url.searchParams.get('conditions') ?? '';
    if (path === '/company/companies')
      return json([
        { id: 250, identifier: 'HarborDental', name: 'Harbor Dental Group' },
        { id: 251, identifier: 'Northline', name: 'Northline Architecture' },
      ]);
    if (path === '/service/boards') {
      const boards = [
        { id: 5, name: 'Help Desk', inactiveFlag: true },
        { id: 1, name: 'Help Desk', inactiveFlag: false },
        { id: 2, name: 'Projects', inactiveFlag: false },
      ];
      const name = valueOf(conditions, 'name')?.toLowerCase();
      return json(boards.filter((b) => !b.inactiveFlag && (!name || b.name.toLowerCase() === name)));
    }
    if (path === '/service/sources')
      return json([
        { id: 3, name: 'Phone' },
        { id: 4, name: 'Portal' },
      ]);
    if (path === '/company/contacts') {
      const email = /value="([^"]+)"/.exec(url.searchParams.get('childConditions') ?? '')?.[1];
      return json(valueOf(conditions, 'company/id') === '250' && email === 'editor@harbor.test' ? [{ id: 77 }] : []);
    }
    if (path === '/service/tickets' && method === 'POST') {
      const body = JSON.parse(String(init!.body)) as Json;
      opened.push(body);
      const created = {
        id: 9000 + opened.length,
        summary: body.summary,
        company: body.company,
        board: { id: 1, name: 'Help Desk' },
        status: { name: 'New' },
        priority: { name: 'Priority 3 - Normal' },
        closedFlag: false,
        _info: { dateEntered: new Date().toISOString(), lastUpdated: new Date().toISOString() },
      };
      tickets.push(created);
      return json(created, 201);
    }
    if (path === '/service/tickets') {
      const ids = /company\/id in \(([\d,]+)\)/.exec(conditions)?.[1]?.split(',') ?? [];
      return json(tickets.filter((t) => ids.includes(String((t.company as Json).id))));
    }
    const noteOf = /^\/service\/tickets\/(\d+)\/notes$/.exec(path);
    if (noteOf) {
      const list = notes.get(noteOf[1]!) ?? [];
      if (method !== 'POST') return json(list);
      const note = { id: 500 + list.length, dateCreated: new Date().toISOString(), ...JSON.parse(String(init!.body)) };
      notes.set(noteOf[1]!, [...list, note]);
      return json(note, 201);
    }
    return json({ message: `no fake for ${path}` }, 404);
  }) as typeof fetch;
  return { fetcher, calls, opened, tickets, notes };
}

async function waitForJob(b: Browser, id: string) {
  for (let i = 0; i < 200; i++) {
    const job = (await b.call('GET', `/api/import/jobs/${id}`)).data;
    if (job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('sync did not finish');
}

describe('ConnectWise PSA values', () => {
  it('takes a site as a bare host or an https address, and nothing else', () => {
    expect(psaSiteUrl('api-na.myconnectwise.net')).toBe('https://api-na.myconnectwise.net');
    expect(psaSiteUrl('https://psa.example.com/v4_6_release/')).toBe('https://psa.example.com');
    expect(psaSiteUrl('http://psa.example.com')).toBeNull();
    expect(psaSiteUrl('https://user:pw@psa.example.com')).toBeNull();
    expect(psaSiteUrl('localhost')).toBeNull();
  });

  it('maps a PSA ticket, with its record ID as its number and a link into PSA', () => {
    const t = mapPsaTicket(
      { id: 6209, summary: 'OS patching', status: { name: 'New' }, board: { name: 'Help Desk' }, closedFlag: false },
      'https://na.myconnectwise.net',
      'itdr',
    );
    expect(t).toMatchObject({ id: '6209', number: '6209', status: 'New', board: 'Help Desk', closed: false });
    expect(t!.url).toBe(
      'https://na.myconnectwise.net/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=6209&companyName=itdr',
    );
    // A dotted RMM number is not a PSA ticket.
    expect(mapPsaTicket({ id: '133023.2687' }, 'https://na.myconnectwise.net', 'itdr')).toBeNull();
  });

  it('escapes quotes in condition strings', () => {
    expect(psaString('say "hi" \\ bye')).toBe('"say \\"hi\\" \\\\ bye"');
  });
});

describe('ConnectWise PSA tickets', () => {
  let t: TestApp;
  afterEach(async () => {
    await t.close();
  });

  it('opens real PSA tickets from the client portal, syncs them, and keeps internal notes hidden', async () => {
    const psa = fakePsa();
    t = await startApp({}, { cwPsaFetch: psa.fetcher });
    const owner = (await setupOwner(t.app)).b;
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const northline = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;

    // Wrong keys are refused before anything is saved; the private key never comes back.
    const wrong = await owner.call('PUT', '/api/integrations/cw-psa', {
      site: SITE,
      ...LOGIN,
      privateKey: 'nope-nope-nope',
    });
    expect(wrong.status).toBe(400);
    expect((await owner.call('GET', '/api/integrations/cw-psa')).data).toBeFalsy();
    const saved = await owner.call('PUT', '/api/integrations/cw-psa', { site: SITE, ...LOGIN });
    expect(saved.status, JSON.stringify(saved.data)).toBe(200);
    expect(saved.data).toMatchObject({ site: `https://${SITE}`, hasPrivateKey: true, companies: 2 });
    expect(JSON.stringify(saved.data)).not.toContain(LOGIN.privateKey);
    // Saving again without the private key keeps it.
    expect(
      (await owner.call('PUT', '/api/integrations/cw-psa', { site: SITE, ...LOGIN, privateKey: undefined })).status,
    ).toBe(200);

    const companies = (await owner.call('GET', '/api/integrations/cw-psa/companies')).data;
    expect(companies.find((c: Json) => c.id === '250')).toMatchObject({ suggestedClientId: harbor, action: null });
    await owner.call('PUT', '/api/integrations/cw-psa/companies', {
      mappings: [{ companyId: '250', action: 'link', clientId: harbor }],
    });

    const created = await owner.call('POST', '/api/users', {
      email: 'editor@harbor.test',
      name: 'Harbor Editor',
      role: 'client_editor',
      password: TEMP,
      grants: [{ clientId: harbor, level: 'edit' }],
    });
    expect(created.status).toBe(201);
    const { b } = await signIn(t.app, 'editor@harbor.test', TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'harbor lights portal desk 9' });
    const ask = { summary: 'Printer offline', details: 'The reception printer shows offline since this morning.' };

    // Off by default; turning it on needs a board.
    expect((await b.call('GET', `/api/tickets?client=${harbor}`)).data.canOpen).toBe(false);
    expect((await b.call('POST', `/api/clients/${harbor}/tickets`, ask)).status).toBe(403);
    expect((await owner.call('PUT', '/api/integrations/cw-psa/options', { portalTickets: true })).status).toBe(400);
    const on = await owner.call('PUT', '/api/integrations/cw-psa/options', {
      portalTickets: true,
      portalTicketBoard: 'help desk',
    });
    expect(on.status).toBe(200);
    expect((await b.call('GET', `/api/tickets?client=${harbor}`)).data.canOpen).toBe(true);
    // A client portal user can't change the connection.
    expect((await b.call('PUT', '/api/integrations/cw-psa/options', { portalTickets: false })).status).toBe(403);
    // Only for clients the person can read, and only with a summary and details.
    expect((await b.call('POST', `/api/clients/${northline}/tickets`, ask)).status).toBe(404);
    expect((await b.call('POST', `/api/clients/${harbor}/tickets`, { summary: 'x', details: ' ' })).status).toBe(400);
    expect(psa.opened).toEqual([]);

    const opened = await b.call('POST', `/api/clients/${harbor}/tickets`, ask);
    expect(opened.status, JSON.stringify(opened.data)).toBe(201);
    expect(opened.data).toMatchObject({ id: '9001', number: '9001', summary: 'Printer offline', clientId: harbor });
    // A PSA service ticket: the linked company, the active board by name, the Portal source, the person as contact.
    expect(psa.opened[0]).toEqual({
      summary: 'Printer offline',
      company: { id: 250 },
      board: { id: 1 },
      source: { id: 4 },
      contact: { id: 77 },
      initialDescription: `${ask.details}\n\nSubmitted by Harbor Editor (editor@harbor.test) through Nexus Atlas.`,
    });
    expect(psa.calls.some((c) => c.includes('/platform/'))).toBe(false);
    // It shows straight away, before the next sync, linked into PSA.
    const list = (await b.call('GET', `/api/tickets/list?client=${harbor}`)).data;
    expect(list.find((k: Json) => k.id === '9001')).toMatchObject({
      number: '9001',
      url: `https://${SITE}/v4_6_release/services/system_io/Service/fv_sr100_request.rails?service_recid=9001&companyName=itdr`,
    });

    // Someone PSA has no contact for is named on the ticket instead.
    await owner.call('POST', `/api/clients/${harbor}/tickets`, ask);
    expect(psa.opened[1]).toMatchObject({
      contactEmailAddress: expect.stringContaining('@'),
      contactName: expect.any(String),
    });
    expect(psa.opened[1]!.contact).toBeUndefined();

    // Only Discussion and Resolution notes reach the client; internal ones never do.
    psa.notes.set('9001', [
      { id: 1, text: 'Check the toner', internalAnalysisFlag: true, dateCreated: ago(0.03) },
      {
        id: 2,
        text: 'We are on our way',
        detailDescriptionFlag: true,
        member: { name: 'Sam' },
        dateCreated: ago(0.02),
      },
      { id: 3, text: 'Internal and discussion', detailDescriptionFlag: true, internalAnalysisFlag: true },
      { id: 4, text: 'Replaced the toner', resolutionFlag: true, member: { name: 'Sam' }, dateCreated: ago(0.01) },
    ]);
    const replies = (await b.call('GET', '/api/tickets/9001/replies')).data;
    expect(replies.canReply).toBe(true);
    expect(replies.replies.map((r: Json) => [r.text, r.createdBy])).toEqual([
      ['We are on our way', 'Sam'],
      ['Replaced the toner', 'Sam'],
    ]);
    const answered = await b.call('POST', '/api/tickets/9001/replies', { text: 'Thanks, it is still offline' });
    expect(answered.data).toEqual({ sent: true });
    expect(psa.notes.get('9001')!.at(-1)).toMatchObject({
      text: 'Thanks, it is still offline\n\n(Reply from Harbor Editor through Nexus Atlas)',
      detailDescriptionFlag: true,
      internalAnalysisFlag: false,
    });

    // The sync brings in the linked company's PSA tickets (not the unlinked one's, nor long-closed ones).
    const job = await waitForJob(owner, (await owner.call('POST', '/api/integrations/cw-psa/sync', {})).data.id);
    expect(job.status, JSON.stringify(job.messages)).toBe('done');
    const ids = (await owner.call('GET', '/api/tickets/list')).data.map((k: Json) => k.id).sort();
    expect(ids).toEqual(['8100', '9001', '9002']);
    const listed = psa.calls.find((c) => c.startsWith('GET /v4_6_release/apis/3.0/service/tickets?'))!;
    expect(new URLSearchParams(listed.split('?')[1]).get('conditions')).toContain('company/id in (250)');
    // Another client's ticket is not found for this person.
    expect((await b.call('GET', '/api/tickets/8200/replies')).status).toBe(404);

    // Twenty tickets an hour per person, counted before PSA is called, so a burst can't slip past it.
    const burst = await Promise.all(
      Array.from({ length: 20 }, () => b.call('POST', `/api/clients/${harbor}/tickets`, ask)),
    );
    expect(burst.filter((r) => r.status === 201)).toHaveLength(19);
    expect(burst.filter((r) => r.status === 429)).toHaveLength(1);

    // Switched off: replies can be read but not sent.
    await owner.call('PUT', '/api/integrations/cw-psa/options', {
      portalTickets: false,
      portalTicketBoard: 'Help Desk',
    });
    expect((await b.call('POST', '/api/tickets/9001/replies', { text: 'Hello?' })).status).toBe(403);
    expect((await b.call('GET', '/api/tickets/9001/replies')).data.canReply).toBe(false);

    // Unlinking a company drops its tickets; disconnecting drops them all.
    await owner.call('PUT', '/api/integrations/cw-psa/companies', {
      mappings: [{ companyId: '250', action: 'clear' }],
    });
    expect((await owner.call('GET', '/api/tickets/list')).data).toEqual([]);
    expect((await owner.call('DELETE', '/api/integrations/cw-psa')).status).toBe(200);
    expect((await owner.call('GET', '/api/integrations/cw-psa')).data).toBeFalsy();
  });

  it('names a missing board clearly, and opens nothing', async () => {
    const psa = fakePsa();
    t = await startApp({}, { cwPsaFetch: psa.fetcher });
    const owner = (await setupOwner(t.app)).b;
    const harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    await owner.call('PUT', '/api/integrations/cw-psa', { site: SITE, ...LOGIN });
    await owner.call('PUT', '/api/integrations/cw-psa/companies', {
      mappings: [{ companyId: '250', action: 'link', clientId: harbor }],
    });
    await owner.call('PUT', '/api/integrations/cw-psa/options', { portalTickets: true, portalTicketBoard: 'Nope' });
    const res = await owner.call('POST', `/api/clients/${harbor}/tickets`, { summary: 'Hi', details: 'There' });
    expect(res.status).toBe(424);
    expect(res.data.error ?? res.data.message).toContain('no active service board named "Nope"');
    expect(psa.opened).toEqual([]);
  });
});
