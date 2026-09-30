import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DASHBOARD_WIDGETS } from '@atlas/shared';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('favorites, quick notes, and workspace preferences', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let summit: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    summit = (await owner.call('POST', '/api/clients', { name: 'Summit Legal' })).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  async function technician(email: string, grants: { clientId: string; level: string }[], role = 'technician') {
    await owner.call('POST', '/api/users', { email, name: email.split('@')[0], password: TEMP, role, grants });
    const { b } = await signIn(t.app, email, TEMP);
    await b.call('POST', '/api/account/password', { current: TEMP, next: 'workspace tech pass 12' });
    if (role !== 'client_viewer' && role !== 'client_editor') await enroll(b);
    return b;
  }
  const layoutId = async () => (await owner.call('GET', '/api/layouts')).data[0].id as string;

  it('keeps favorites per person and lists every kind, passwords included', async () => {
    const asset = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: await layoutId(), name: 'FW-01' })
    ).data;
    const doc = (
      await owner.call('POST', '/api/documents', {
        clientId: harbor,
        title: 'Onboarding runbook',
        content: { type: 'doc', content: [] },
      })
    ).data;
    const kb = (
      await owner.call('POST', '/api/documents', { title: 'Printer SOP', content: { type: 'doc', content: [] } })
    ).data;
    const pw = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Firewall admin', secret: 'Tr0ub4dor&3!' })
    ).data;

    for (const [type, id] of [
      ['client', harbor],
      ['asset', asset.id],
      ['document', doc.id],
      ['document', kb.id],
    ])
      expect((await owner.call('PUT', `/api/favorites/${type}/${id}`, {})).data).toEqual({ favorite: true });
    // Idempotent.
    expect((await owner.call('PUT', `/api/favorites/client/${harbor}`, {})).status).toBe(200);
    await owner.call('PUT', `/api/passwords/${pw.id}/favorite`, {});

    const list = (await owner.call('GET', '/api/favorites')).data;
    expect(list).toEqual([
      { type: 'client', id: harbor, name: 'Harbor Dental Group', clientId: null, clientName: null },
      { type: 'document', id: doc.id, name: 'Onboarding runbook', clientId: harbor, clientName: 'Harbor Dental Group' },
      { type: 'document', id: kb.id, name: 'Printer SOP', clientId: null, clientName: null },
      { type: 'asset', id: asset.id, name: 'FW-01', clientId: harbor, clientName: 'Harbor Dental Group' },
      { type: 'password', id: pw.id, name: 'Firewall admin', clientId: harbor, clientName: 'Harbor Dental Group' },
    ]);

    // Nobody else sees them.
    const tess = await technician('tess@atlas.test', [{ clientId: harbor, level: 'edit_passwords' }]);
    expect((await tess.call('GET', '/api/favorites')).data).toEqual([]);

    // Archived items drop out; unstarring removes them.
    await owner.call('POST', `/api/assets/${asset.id}/archive`, { archived: true });
    await owner.call('DELETE', `/api/favorites/client/${harbor}`);
    const after = (await owner.call('GET', '/api/favorites')).data as { type: string }[];
    expect(after.map((f) => f.type)).toEqual(['document', 'document', 'password']);
  });

  it('only lets people star what they can see, and hides stars when access goes', async () => {
    const asset = (
      await owner.call('POST', `/api/clients/${summit}/assets`, { layoutId: await layoutId(), name: 'Summit NAS' })
    ).data;
    const kb = (
      await owner.call('POST', '/api/documents', { title: 'MSP-wide', content: { type: 'doc', content: [] } })
    ).data;
    const tess = await technician('tess@atlas.test', [
      { clientId: harbor, level: 'read' },
      { clientId: summit, level: 'read' },
    ]);
    expect((await tess.call('PUT', `/api/favorites/asset/${asset.id}`, {})).status).toBe(200);
    expect((await tess.call('PUT', `/api/favorites/client/${summit}`, {})).status).toBe(200);

    const viewer = await technician('cora@client.test', [{ clientId: harbor, level: 'read' }], 'client_viewer');
    // Another client's items, the knowledge base, unknown ids, and unknown types all look missing.
    for (const url of [
      `/api/favorites/client/${summit}`,
      `/api/favorites/asset/${asset.id}`,
      `/api/favorites/document/${kb.id}`,
      '/api/favorites/client/not-a-uuid',
      `/api/favorites/password/${harbor}`,
    ])
      expect((await viewer.call('PUT', url, {})).status).toBe(404);
    expect((await viewer.call('PUT', `/api/favorites/client/${harbor}`, {})).status).toBe(200);

    // Losing access to Summit hides the stars without deleting them.
    const users = (await owner.call('GET', '/api/users')).data as { id: string; email: string }[];
    const tessId = users.find((u) => u.email === 'tess@atlas.test')!.id;
    await owner.call('PATCH', `/api/users/${tessId}`, { grants: [{ clientId: harbor, level: 'read' }] });
    expect((await tess.call('GET', '/api/favorites')).data).toEqual([]);
    await owner.call('PATCH', `/api/users/${tessId}`, {
      grants: [
        { clientId: harbor, level: 'read' },
        { clientId: summit, level: 'read' },
      ],
    });
    expect(((await tess.call('GET', '/api/favorites')).data as unknown[]).length).toBe(2);
  });

  it('versions quick notes and records who changed them', async () => {
    expect((await owner.call('GET', `/api/clients/${harbor}`)).data).toMatchObject({
      notes: '',
      notesVersion: 0,
      notesUpdatedByName: null,
      hours: '',
      maintenanceWindow: '',
    });
    const saved = (
      await owner.call('PATCH', `/api/clients/${harbor}`, {
        notes: 'Call before touching the firewall',
        notesVersion: 0,
        hours: 'Mon–Fri 8–5',
        maintenanceWindow: 'Sundays 22:00–02:00',
      })
    ).data;
    expect(saved).toMatchObject({
      notes: 'Call before touching the firewall',
      notesVersion: 1,
      notesUpdatedByName: 'Avery Owner',
      hours: 'Mon–Fri 8–5',
      maintenanceWindow: 'Sundays 22:00–02:00',
    });
    expect(Date.now() - Date.parse(saved.notesUpdatedAt)).toBeLessThan(60_000);

    // Other edits don't make a new notes version.
    expect((await owner.call('PATCH', `/api/clients/${harbor}`, { type: 'Partner' })).data.notesVersion).toBe(1);
    expect((await owner.call('PATCH', `/api/clients/${harbor}`, { notes: saved.notes })).data.notesVersion).toBe(1);

    await owner.call('PATCH', `/api/clients/${harbor}`, { notes: 'Firewall is managed by the ISP', notesVersion: 1 });
    // Saving from an old version is a conflict, not a silent overwrite.
    const stale = await owner.call('PATCH', `/api/clients/${harbor}`, { notes: 'Old tab', notesVersion: 1 });
    expect(stale.status).toBe(409);

    const history = (await owner.call('GET', `/api/clients/${harbor}/notes/revisions`)).data;
    expect(history.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect((await owner.call('GET', `/api/clients/${harbor}/notes/revisions/1`)).data).toEqual({
      notes: 'Call before touching the firewall',
    });
    const restored = (
      await owner.call('POST', `/api/clients/${harbor}/notes/restore`, { version: 1, expectedVersion: 2 })
    ).data;
    expect(restored).toMatchObject({ notes: 'Call before touching the firewall', notesVersion: 3 });

    const activity = (await owner.call('GET', `/api/activity?client=${harbor}`)).data as { action: string }[];
    expect(activity.filter((a) => a.action === 'Updated quick notes of')).toHaveLength(3);

    // Another client's notes are invisible; read-only access can read the history but not restore.
    const reader = await technician('rita@atlas.test', [{ clientId: summit, level: 'read' }]);
    expect((await reader.call('GET', `/api/clients/${harbor}/notes/revisions`)).status).toBe(404);
    expect((await reader.call('GET', `/api/clients/${harbor}/notes/revisions/1`)).status).toBe(404);
    const summitNotes = await owner.call('PATCH', `/api/clients/${summit}`, { notes: 'Partner firm' });
    expect(summitNotes.data.notesVersion).toBe(1);
    expect((await reader.call('GET', `/api/clients/${summit}/notes/revisions`)).data).toHaveLength(1);
    const denied = await reader.call('POST', `/api/clients/${summit}/notes/restore`, {
      version: 1,
      expectedVersion: 1,
    });
    expect(denied.status).toBe(403);
  });

  it('starts a new client’s notes history when it is created with notes', async () => {
    const id = (await owner.call('POST', '/api/clients', { name: 'Coastal Vet', notes: 'After-hours line only' })).data
      .id;
    expect((await owner.call('GET', `/api/clients/${id}`)).data).toMatchObject({ notesVersion: 1 });
    expect((await owner.call('GET', `/api/clients/${id}/notes/revisions`)).data).toHaveLength(1);
  });

  it('keeps notes that arrived without a version (from an import) as version 1', async () => {
    await t.handle.db.execute(sql`update clients set notes = 'Imported from Hudu' where id = ${harbor}`);
    const saved = (await owner.call('PATCH', `/api/clients/${harbor}`, { notes: 'Rewritten', notesVersion: 0 })).data;
    expect(saved.notesVersion).toBe(2);
    const history = (await owner.call('GET', `/api/clients/${harbor}/notes/revisions`)).data;
    expect(history.map((r: { authorName: string }) => r.authorName)).toEqual(['Avery Owner', 'Before version history']);
    expect((await owner.call('GET', `/api/clients/${harbor}/notes/revisions/1`)).data).toEqual({
      notes: 'Imported from Hudu',
    });
  });

  it('saves dashboard cards and hidden sections per person', async () => {
    const defaults = (await owner.call('GET', '/api/account/workspace')).data;
    expect(defaults.widgets.map((w: { id: string }) => w.id)).toEqual([...DASHBOARD_WIDGETS]);
    expect(defaults.widgets.every((w: { visible: boolean }) => w.visible)).toBe(true);
    expect(defaults.hiddenSections).toEqual([]);

    const saved = (
      await owner.call('PUT', '/api/account/workspace', {
        widgets: [
          { id: 'favorites', visible: true },
          { id: 'stats', visible: false },
        ],
        hiddenSections: ['map', 'checklists'],
      })
    ).data;
    // Saved cards keep their order; the rest follow in their default order.
    expect(saved.widgets.slice(0, 3)).toEqual([
      { id: 'favorites', visible: true },
      { id: 'stats', visible: false },
      { id: 'rmm-health', visible: true },
    ]);
    expect(saved.widgets).toHaveLength(DASHBOARD_WIDGETS.length);
    expect(saved.hiddenSections).toEqual(['map', 'checklists']);

    for (const bad of [
      { widgets: [{ id: 'tickets-from-nowhere', visible: true }], hiddenSections: [] },
      { widgets: [], hiddenSections: ['overview'] },
      {
        widgets: [
          { id: 'stats', visible: true },
          { id: 'stats', visible: false },
        ],
        hiddenSections: [],
      },
    ])
      expect((await owner.call('PUT', '/api/account/workspace', bad)).status).toBe(400);

    // It changes nothing for anyone else.
    const tess = await technician('tess@atlas.test', [{ clientId: harbor, level: 'read' }]);
    expect((await tess.call('GET', '/api/account/workspace')).data).toEqual(defaults);

    // Reset goes back to the defaults.
    expect((await owner.call('DELETE', '/api/account/workspace')).data).toEqual(defaults);
  });

  it('counts each client section, and passwords only for people who can open the vault', async () => {
    const layout = await layoutId();
    await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: layout, name: 'FW-01' });
    const old = (await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId: layout, name: 'Old' })).data;
    await owner.call('POST', `/api/assets/${old.id}/archive`, { archived: true });
    await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Dana Lee' });
    await owner.call('POST', `/api/clients/${harbor}/locations`, { name: 'Main office' });
    await owner.call('POST', `/api/clients/${harbor}/passwords`, { name: 'Wi-Fi', secret: 'Tr0ub4dor&3!' });
    await owner.call('POST', `/api/clients/${summit}/contacts`, { name: 'Other client' });

    expect((await owner.call('GET', `/api/workspace/clients/${harbor}/counts`)).data).toEqual({
      assets: 1,
      documents: 0,
      passwords: 1,
      contacts: 1,
      locations: 1,
      checklists: 0,
    });
    const reader = await technician('rita@atlas.test', [{ clientId: harbor, level: 'edit' }]);
    expect((await reader.call('GET', `/api/workspace/clients/${harbor}/counts`)).data.passwords).toBeNull();
    expect((await reader.call('GET', `/api/workspace/clients/${summit}/counts`)).status).toBe(404);
  });

  it('keeps the personal routes away from API keys', async () => {
    const key = (await owner.call('POST', '/api/api-keys', { name: 'Sync', scopes: ['read', 'write'] })).data;
    const get = async (url: string) =>
      (await t.app.inject({ method: 'GET', url: `/api/v1${url}`, headers: { authorization: `Bearer ${key.token}` } }))
        .statusCode;
    for (const url of ['/favorites', '/account/workspace', `/workspace/clients/${harbor}/counts`])
      expect(await get(url)).toBe(403);
    // The notes history is documentation, so read keys can use it.
    expect(await get(`/clients/${harbor}/notes/revisions`)).toBe(200);
  });
});
