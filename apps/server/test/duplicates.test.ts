import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { enroll, setupOwner, signIn, startApp, type Browser, type TestApp } from './helpers.js';

const TEMP = 'temporary pass 1234';

describe('duplicates', () => {
  let t: TestApp;
  let owner: Browser;
  let harbor: string;
  let configurations: string;
  let computers: string;

  beforeEach(async () => {
    t = await startApp();
    owner = (await setupOwner(t.app)).b;
    harbor = (await owner.call('POST', '/api/clients', { name: 'Harbor Dental Group' })).data.id;
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    configurations = layouts.find((l) => l.key === 'configuration')!.id;
    // Like Hudu's layout: differently named fields, one Atlas's Configurations layout doesn't have.
    computers = (
      await owner.call('POST', '/api/layouts', {
        name: 'Computer Assets',
        icon: 'box',
        fields: [
          { key: 'host', label: 'Hostname', type: 'text' },
          { key: 'ram', label: 'RAM', type: 'text' },
          { key: 'type', label: 'Type', type: 'text' },
        ],
      })
    ).data.id;
  });
  afterEach(async () => {
    await t.close();
  });

  it('finds same-named records and merges assets across layouts, keeping every value', async () => {
    const keep = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: configurations,
        name: '3551-IoT-2019',
        fields: { type: 'Workstation', ip_address: '10.0.0.5' },
      })
    ).data;
    const hudu = (
      await owner.call('POST', `/api/clients/${harbor}/assets`, {
        layoutId: computers,
        name: '3551-IOT-2019',
        fields: { host: '3551-IOT-2019', ram: '16 GB', type: 'Not an option' },
        notes: 'From Hudu.',
      })
    ).data;
    const pw = (
      await owner.call('POST', `/api/clients/${harbor}/passwords`, {
        name: 'Local admin',
        secret: 'Tr0ub4dor&3-Harbor!',
      })
    ).data;
    await owner.call('POST', `/api/items/password/${pw.id}/relations`, { type: 'asset', id: hudu.id });

    const groups = (await owner.call('GET', '/api/duplicates')).data as {
      type: string;
      items: { id: string; detail: string }[];
    }[];
    const assetGroup = groups.find((g) => g.type === 'assets')!;
    expect(assetGroup.items.map((i) => i.id).sort()).toEqual([keep.id, hudu.id].sort());
    expect(assetGroup.items.map((i) => i.detail).sort()).toEqual(['Computer Assets', 'Configurations']);

    const result = await owner.call('POST', '/api/duplicates/merge', {
      type: 'assets',
      keepId: keep.id,
      mergeIds: [hudu.id],
    });
    expect(result.status).toBe(200);
    expect(result.data.fieldsAdded).toEqual(['RAM']);

    const kept = (await owner.call('GET', `/api/assets/${keep.id}`)).data;
    // Hostname matched by label; RAM got a new field; Type kept its own value (not overwritten).
    expect(kept.fields).toMatchObject({
      type: 'Workstation',
      ip_address: '10.0.0.5',
      hostname: '3551-IOT-2019',
      ram: '16 GB',
    });
    expect(kept.notes).toContain('From Hudu.');
    // The link moved; the copy is archived and says where it went.
    const links = (await owner.call('GET', `/api/items/asset/${keep.id}/relations`)).data as { id: string }[];
    expect(links.map((l) => l.id)).toContain(pw.id);
    const old = (await owner.call('GET', `/api/assets/${hudu.id}`)).data;
    expect(old.archived).toBe(true);
    expect(old.notes).toContain('Merged into 3551-IoT-2019');
    expect((await owner.call('GET', '/api/duplicates')).data.some((g: { type: string }) => g.type === 'assets')).toBe(
      false,
    );
  });

  it('merges clients, moving everything in them, and contacts, filling blanks', async () => {
    const copy = (await owner.call('POST', '/api/clients', { name: 'harbor  dental group' })).data.id;
    await owner.call('POST', `/api/clients/${copy}/passwords`, { name: 'Wi-Fi', secret: 'Tr0ub4dor&3-Harbor!' });
    await owner.call('POST', `/api/clients/${copy}/contacts`, { name: 'Dana Reyes', email: 'dana@harbor.test' });
    await owner.call('POST', `/api/clients/${harbor}/contacts`, { name: 'Dana Reyes', phone: '919-555-0142' });
    await t.handle.db.execute(
      sql`insert into external_refs (org_id, source, kind, external_id, entity_id) select org_id, 'hudu', 'clients', '42', id from clients where id = ${copy}`,
    );

    const clients = await owner.call('POST', '/api/duplicates/merge', {
      type: 'clients',
      keepId: harbor,
      mergeIds: [copy],
    });
    expect(clients.status).toBe(200);
    expect((await owner.call('GET', '/api/clients')).data).toHaveLength(1);
    expect(
      (await owner.call('GET', `/api/passwords?client=${harbor}`)).data.map((p: { name: string }) => p.name),
    ).toEqual(['Wi-Fi']);
    // Later imports update the kept client.
    const ref = (await t.handle.db.execute(sql`select entity_id from external_refs where external_id = '42'`)).rows[0];
    expect(ref).toEqual({ entity_id: harbor });

    // The two Dana Reyes contacts are now in one client, so they're a duplicate group too.
    const group = (
      (await owner.call('GET', '/api/duplicates')).data as { type: string; items: { id: string }[] }[]
    ).find((g) => g.type === 'contacts')!;
    const [a, b] = group.items.map((i) => i.id);
    await owner.call('POST', '/api/duplicates/merge', { type: 'contacts', keepId: a, mergeIds: [b] });
    const contacts = (await owner.call('GET', `/api/clients/${harbor}/contacts`)).data as {
      email: string;
      phone: string;
    }[];
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({ email: 'dana@harbor.test', phone: '919-555-0142' });
  });

  it('is for administrators only', async () => {
    await owner.call('POST', '/api/users', {
      email: 'tess@atlas.test',
      name: 'Tess Tech',
      password: TEMP,
      role: 'technician',
      allClients: 'edit_passwords',
    });
    const { b: tech } = await signIn(t.app, 'tess@atlas.test', TEMP);
    await tech.call('POST', '/api/account/password', { current: TEMP, next: 'merge reviewer pass 7' });
    await enroll(tech);
    expect((await tech.call('GET', '/api/duplicates')).status).toBe(403);
    expect(
      (await tech.call('POST', '/api/duplicates/merge', { type: 'clients', keepId: harbor, mergeIds: [harbor] }))
        .status,
    ).toBe(403);
  });
});
