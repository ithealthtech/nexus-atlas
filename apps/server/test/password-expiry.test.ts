import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

describe('password expiry dates', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('saves an expiry date, lists it with expirations, and can clear it', async () => {
    const pw = await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      name: 'Vendor trial login',
      secret: 'Tr0ub4dor&3-Harbor!',
      expiresOn: inDays(10),
    });
    expect(pw.status).toBe(201);
    expect(pw.data.expiresOn).toBe(inDays(10));

    const soon = (await owner.call('GET', '/api/expirations')).data as {
      id: string;
      label: string;
      daysLeft: number;
    }[];
    expect(soon).toContainEqual(expect.objectContaining({ id: pw.data.id, label: 'Password expires', daysLeft: 10 }));

    const cleared = await owner.call('PATCH', `/api/passwords/${pw.data.id}`, {
      version: pw.data.version,
      expiresOn: null,
    });
    expect(cleared.data.expiresOn).toBeNull();
    const after = (await owner.call('GET', '/api/expirations')).data as { id: string }[];
    expect(after.some((e) => e.id === pw.data.id)).toBe(false);
  });

  it('rejects dates that do not exist', async () => {
    const bad = await owner.call('POST', `/api/clients/${harbor}/passwords`, {
      name: 'Bad date',
      secret: 'Tr0ub4dor&3-Harbor!',
      expiresOn: '2026-02-30',
    });
    expect(bad.status).toBe(400);
  });
});
