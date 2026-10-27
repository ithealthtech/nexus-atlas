import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AccessReviewView } from '@atlas/shared';
import { OWNER, enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('access reviews', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  async function technician(email: string, body: Record<string, unknown>) {
    const created = await owner.call('POST', '/api/users', {
      email,
      name: email.split('@')[0],
      password: TEMP,
      role: 'technician',
      ...body,
    });
    expect(created.status, JSON.stringify(created.data)).toBe(201);
    const { b } = await signIn(t.app, email, TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'review tech pass 77' });
    await enroll(b);
    return { b, id: created.data.id as string };
  }

  it('reviews who can open a client, removes direct access, and signs it off as a PDF', async () => {
    const direct = await technician('direct@atlas.test', { grants: [{ clientId: harbor, level: 'edit' }] });
    const everywhere = await technician('everywhere@atlas.test', { allClients: 'read' });

    const started = await owner.call('POST', `/api/clients/${harbor}/access-reviews`, {});
    expect(started.status, JSON.stringify(started.data)).toBe(201);
    const review = started.data as AccessReviewView;
    const person = (name: string) => review.items.find((i) => i.name === name)!;
    expect(review.items.map((i) => i.name).sort()).toEqual(['Avery Owner', 'direct', 'everywhere']);
    expect(person('direct')).toMatchObject({ level: 'edit', via: ['Direct'], decision: null });
    expect(person('everywhere')).toMatchObject({ level: 'read', via: ['All clients'] });
    // Starting again returns the open review rather than a second one.
    expect((await owner.call('POST', `/api/clients/${harbor}/access-reviews`, {})).data.id).toBe(review.id);

    const decide = (userId: string, decision: string) =>
      owner.call('POST', `/api/access-reviews/${review.id}/decisions`, { userId, decision });
    // Removing direct access takes effect at once.
    const removed = (await decide(direct.id, 'remove')).data as AccessReviewView;
    expect(removed.items.find((i) => i.userId === direct.id)).toMatchObject({
      decision: 'remove',
      decidedByName: OWNER.name,
      stillHasAccess: false,
    });
    expect((await direct.b.call('GET', `/api/clients/${harbor}`)).status).toBe(404);
    // Access through the all-clients level stays, and the review says so.
    const kept = (await decide(everywhere.id, 'remove')).data as AccessReviewView;
    expect(kept.items.find((i) => i.userId === everywhere.id)!.stillHasAccess).toBe(true);

    // Everyone needs a decision before it can be signed off.
    const early = await owner.call('POST', `/api/access-reviews/${review.id}/sign-off`, { signedName: 'Avery Owner' });
    expect([early.status, early.data.code]).toEqual([400, 'undecided']);
    await decide(review.items.find((i) => i.name === 'Avery Owner')!.userId, 'keep');
    const signed = await owner.call('POST', `/api/access-reviews/${review.id}/sign-off`, { signedName: 'Avery Owner' });
    expect(signed.data).toMatchObject({ signedName: 'Avery Owner', completedAt: expect.any(String) });
    expect((await decide(direct.id, 'keep')).status).toBe(409);

    const pdf = await owner.call('GET', `/api/access-reviews/${review.id}/pdf`);
    expect(pdf.status).toBe(200);
    expect(String(pdf.data).startsWith('%PDF-')).toBe(true);
    expect(pdf.headers['content-disposition']).toContain(encodeURIComponent('Harbor Dental access review'));
    expect((await owner.call('GET', `/api/clients/${harbor}/access-reviews`)).data).toHaveLength(1);

    const events = (await owner.call('GET', '/api/security-events')).data as { action: string }[];
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['Access review started', 'Access review: removed access', 'Access review signed off']),
    );
  });

  it('is for administrators only', async () => {
    const tech = await technician('tech@atlas.test', { grants: [{ clientId: harbor, level: 'edit_passwords' }] });
    expect((await tech.b.call('POST', `/api/clients/${harbor}/access-reviews`, {})).status).toBe(403);
    expect((await tech.b.call('GET', `/api/clients/${harbor}/access-reviews`)).status).toBe(403);
    const review = (await owner.call('POST', `/api/clients/${harbor}/access-reviews`, {})).data as AccessReviewView;
    expect((await tech.b.call('GET', `/api/access-reviews/${review.id}`)).status).toBe(403);
    expect((await owner.call('GET', `/api/access-reviews/${review.id}/pdf`)).status).toBe(409);
  });
});
