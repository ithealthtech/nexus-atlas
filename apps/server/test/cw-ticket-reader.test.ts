import { describe, expect, it } from 'vitest';
import { HttpError } from '../src/errors.js';
import { CwTicketReader } from '../src/services/integrations/cw-tickets.js';
import { ACCESS_DENIED, type CwRmmClient } from '../src/services/integrations/cw-rmm.js';

type Json = Record<string, unknown>;

const COMPANY = '72f2b461-1e35-4df0-be5c-d55f10b6052f';
const NOW = Date.parse('2026-09-30T12:00:00Z');
const NOTE = (portal: string, asio: string) => ({
  detail: `Connectwise ticket id ${portal} is created to match ASIO ticket id ${asio}`,
});

/**
 * A ConnectWise ticket API as the reader sees it, built from response shapes the platform has returned. `notes`
 * answers each ticket's notes; a function there can throw to stand in for a refusal.
 */
function fakeClient(pages: Json[][], notes: Record<string, Json[] | (() => never)> = {}) {
  const calls: string[] = [];
  const client = {
    get: async (path: string) => {
      calls.push(path);
      const url = new URL(path, 'https://api.example');
      const note = /\/tickets\/([^/]+)\/notes$/.exec(url.pathname);
      if (note) {
        const answer = notes[decodeURIComponent(note[1]!)] ?? [];
        return typeof answer === 'function' ? answer() : { data: answer };
      }
      const page = Number(url.searchParams.get('pageNum'));
      const records = pages[page - 1];
      if (!records) throw new HttpError(404, 'Not found');
      return { data: records, totalCount: pages.flat().length };
    },
  } as unknown as CwRmmClient;
  return { client, calls };
}

const ticket = (id: string, number: string, extra: Json = {}) => ({
  id,
  number,
  summary: `Ticket ${number}`,
  status: { id: 's-new', name: 'New' },
  createdAt: '2026-09-29T10:00:00Z',
  ...extra,
});

describe('ConnectWise ticket reader', () => {
  it('links a plain portal number straight away, without reading notes', async () => {
    const { client, calls } = fakeClient([[ticket('u-1', '5535')]]);
    const reader = new CwTicketReader(client);
    const [t] = await reader.tickets(COMPANY, NOW);
    expect(t).toMatchObject({ number: '5535' });
    expect(t!.url).toContain(`ticketId=5535&companyId=${COMPANY}`);
    expect(calls.some((c) => c.includes('/notes'))).toBe(false);
    expect(reader.noPortalId).toBe(0);
  });

  it("takes an automation ticket's portal number from its own CW-System note, not another ticket's", async () => {
    const { client } = fakeClient([[ticket('u-2', '133023.1670'), ticket('u-3', '133023.1671')]], {
      'u-2': [{ detail: 'Checked by tech' }, NOTE('5283', '133023.1670')],
      // A note naming a different ticket gives nothing.
      'u-3': [NOTE('5284', '133023.9999')],
    });
    const reader = new CwTicketReader(client);
    const list = await reader.tickets(COMPANY, NOW);
    expect(list.find((t) => t.id === 'u-2')).toMatchObject({ number: '5283' });
    expect(list.find((t) => t.id === 'u-2')!.url).toContain('ticketId=5283');
    expect(list.find((t) => t.id === 'u-3')).toMatchObject({ number: '133023.1671', url: null });
    expect(reader.noPortalId).toBe(1);
  });

  it('reuses a portal number found on an earlier sync instead of reading the notes again', async () => {
    const { client, calls } = fakeClient([[ticket('u-2', '133023.1670')]]);
    const reader = new CwTicketReader(client);
    reader.portalNumbers.set('u-2', '5283');
    const [t] = await reader.tickets(COMPANY, NOW);
    expect(t).toMatchObject({ number: '5283' });
    expect(t!.url).toContain('ticketId=5283');
    expect(calls.some((c) => c.includes('/notes'))).toBe(false);
  });

  it('stops reading notes once ConnectWise refuses them, and still lists the tickets', async () => {
    const denied = () => {
      throw new HttpError(403, 'Forbidden', ACCESS_DENIED);
    };
    const { client, calls } = fakeClient([[ticket('u-2', '133023.1670'), ticket('u-3', '133023.1671')]], {
      'u-2': denied,
      'u-3': denied,
    });
    const reader = new CwTicketReader(client);
    const list = await reader.tickets(COMPANY, NOW);
    expect(list).toHaveLength(2);
    expect(reader.notesDenied).toBe(true);
    expect(calls.filter((c) => c.includes('/notes'))).toHaveLength(1);
  });

  it('skips a ticket whose notes fail for another reason and carries on', async () => {
    const { client } = fakeClient([[ticket('u-2', '133023.1670'), ticket('u-3', '133023.1671')]], {
      'u-2': () => {
        throw new HttpError(500, 'Server error');
      },
      'u-3': [NOTE('5284', '133023.1671')],
    });
    const reader = new CwTicketReader(client);
    const list = await reader.tickets(COMPANY, NOW);
    expect(list.find((t) => t.id === 'u-3')).toMatchObject({ number: '5284' });
    expect(reader.notesDenied).toBe(false);
  });

  it('never shows or links the long alert ID as the ticket number', async () => {
    const { client } = fakeClient([[ticket('u-9', '133023.1533', { nocTicketId: '202609080102782' })]]);
    const [t] = await new CwTicketReader(client).tickets(COMPANY, NOW);
    expect(t!.number).toBe('133023.1533');
    expect(t!.url).toBeNull();
  });

  it('reads every page, drops repeats and tickets closed over 90 days ago', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ticket(`p1-${i}`, String(1000 + i)));
    const page2 = [
      ticket('p1-0', '1000'),
      ticket('old', '900', { status: { name: 'Closed' }, closedAt: '2026-05-01T00:00:00Z' }),
      ticket('recent', '901', { status: { name: 'Closed' }, closedAt: '2026-09-20T00:00:00Z' }),
    ];
    const { client } = fakeClient([page1, page2]);
    const reader = new CwTicketReader(client);
    const list = await reader.tickets(COMPANY, NOW);
    expect(list).toHaveLength(101);
    expect(list.some((t) => t.id === 'old')).toBe(false);
    expect(list.find((t) => t.id === 'recent')).toMatchObject({ closed: true });
    expect(reader.partial.has(COMPANY)).toBe(false);
  });

  it('treats "not found" as a company with no tickets', async () => {
    const { client } = fakeClient([]);
    const reader = new CwTicketReader(client);
    expect(await reader.tickets(COMPANY, NOW)).toEqual([]);
    expect(reader.lastList).toBe('ticket list: not found');
  });

  it('gives no links outside North America, where the web address is unknown', async () => {
    const { client } = fakeClient([[ticket('u-1', '5535')]]);
    const [t] = await new CwTicketReader(client, 'eu').tickets(COMPANY, NOW);
    expect(t).toMatchObject({ number: '5535', url: null });
  });
});
