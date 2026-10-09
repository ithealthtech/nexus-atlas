import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const doc = (text: string) => ({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });

describe('sharing a document by link', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let article: { id: string; version: number };

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    article = (
      await owner.call('POST', '/api/documents', {
        clientId: harbor,
        title: 'How to connect to the VPN',
        content: doc('Open the VPN app and sign in.'),
      })
    ).data;
  });
  afterEach(async () => {
    await t.close();
  });

  /** A request with no session at all, as someone who was sent the link makes it. */
  const open = async (url: string) => {
    const token = url.split('/kb/')[1]!;
    const res = await t.app.inject({ method: 'GET', url: `/api/shared-articles/${token}` });
    return { status: res.statusCode, data: res.json(), headers: res.headers };
  };

  it('lets anyone with the link read that one document as it is now, and counts the views', async () => {
    const made = await owner.call('POST', `/api/documents/${article.id}/shares`, {});
    expect(made.status, JSON.stringify(made.data)).toBe(201);
    expect(made.data).toMatchObject({ status: 'active', expiresAt: null, views: 0 });
    expect(made.data.url).toMatch(/^http:\/\/localhost\/kb\/[A-Za-z0-9_-]{32}$/);

    const first = await open(made.data.url);
    expect(first.status).toBe(200);
    // Only the article and whose it is: no client name, IDs, or author.
    expect(first.data).toEqual({
      title: 'How to connect to the VPN',
      content: doc('Open the VPN app and sign in.'),
      updatedAt: expect.any(String),
      organization: 'IT Done Right',
    });
    expect(first.headers['x-robots-tag']).toContain('noindex');
    expect(first.headers['cache-control']).toBe('no-store');

    // An edit shows straight away: the link is to the document, not a copy of it.
    await owner.call('PATCH', `/api/documents/${article.id}`, {
      content: doc('Open the VPN app, sign in, and approve the prompt.'),
      version: article.version,
    });
    expect(JSON.stringify((await open(made.data.url)).data.content)).toContain('approve the prompt');
    const [listed] = (await owner.call('GET', `/api/documents/${article.id}/shares`)).data;
    expect(listed).toMatchObject({ views: 2, url: made.data.url, createdByName: 'Avery Owner' });
    expect(listed.lastViewedAt).not.toBeNull();
  });

  it('stops working when revoked, expired, or the document is archived, and never says which', async () => {
    const one = (await owner.call('POST', `/api/documents/${article.id}/shares`, { expiresDays: 7 })).data;
    expect(new Date(one.expiresAt).getTime()).toBeGreaterThan(Date.now() + 6 * 86_400_000);
    const two = (await owner.call('POST', `/api/documents/${article.id}/shares`, {})).data;
    expect((await owner.call('POST', `/api/documents/${article.id}/shares`, { expiresDays: 3 })).status).toBe(400);

    const gone = { status: 404, data: { error: 'This link doesn’t work any more, or was copied incompletely.' } };
    // Revoked.
    const after = (await owner.call('DELETE', `/api/document-shares/${two.id}`)).data;
    expect(after.find((s: { id: string }) => s.id === two.id).status).toBe('revoked');
    expect(await open(two.url)).toMatchObject(gone);
    // Expired.
    await t.handle.pool.query(`update document_shares set expires_at = now() - interval '1 minute' where id = $1`, [
      one.id,
    ]);
    expect(await open(one.url)).toMatchObject(gone);
    expect(
      (await owner.call('GET', `/api/documents/${article.id}/shares`)).data
        .map((s: { status: string }) => s.status)
        .sort(),
    ).toEqual(['expired', 'revoked']);
    // Archived: a working link stops, and a new one can't be made.
    const three = (await owner.call('POST', `/api/documents/${article.id}/shares`, {})).data;
    expect((await open(three.url)).status).toBe(200);
    await owner.call('POST', `/api/documents/${article.id}/archive`, { archived: true });
    expect(await open(three.url)).toMatchObject(gone);
    expect((await owner.call('POST', `/api/documents/${article.id}/shares`, {})).status).toBe(400);
    // Made up, or not even the right shape.
    expect(await open('http://localhost/kb/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toMatchObject(gone);
    expect(await open('http://localhost/kb/nope')).toMatchObject(gone);
  });

  it('needs edit access to the document to make, list, or revoke a link, and logs both', async () => {
    const made = (await owner.call('POST', `/api/documents/${article.id}/shares`, {})).data;
    const person = async (email: string, next: string, body: Record<string, unknown>) => {
      await owner.call('POST', '/api/users', {
        email,
        name: email.split('@')[0],
        password: 'temporary pass 1234',
        ...body,
      });
      const { b } = await signIn(t.app, email, 'temporary pass 1234');
      await b.call('POST', '/api/account/password', { current: 'temporary pass 1234', next });
      await enroll(b);
      return b;
    };
    const reader = await person('rowan@atlas.test', 'amber quiet lake 47', {
      role: 'readonly_technician',
      grants: [{ clientId: harbor, level: 'read' }],
    });
    expect((await reader.call('GET', `/api/documents/${article.id}/shares`)).status).toBe(403);
    expect((await reader.call('POST', `/api/documents/${article.id}/shares`, {})).status).toBe(403);
    expect((await reader.call('DELETE', `/api/document-shares/${made.id}`)).status).toBe(403);
    // No access to the client at all: the document doesn't exist for them.
    const other = (await owner.call('POST', '/api/clients', { name: 'Northline Architecture' })).data.id;
    const elsewhere = await person('quinn@atlas.test', 'maple north orbit 9', {
      role: 'technician',
      grants: [{ clientId: other, level: 'edit' }],
    });
    expect((await elsewhere.call('POST', `/api/documents/${article.id}/shares`, {})).status).toBe(404);
    expect((await elsewhere.call('DELETE', `/api/document-shares/${made.id}`)).status).toBe(404);

    await owner.call('DELETE', `/api/document-shares/${made.id}`);
    const events = (await t.handle.pool.query(`select action, detail from security_events order by id`)).rows as {
      action: string;
      detail: string;
    }[];
    expect(events.filter((e) => e.action.startsWith('Document'))).toEqual([
      { action: 'Document shared by link', detail: 'How to connect to the VPN (no expiry)' },
      { action: 'Document link revoked', detail: 'How to connect to the VPN' },
    ]);
  });
});
