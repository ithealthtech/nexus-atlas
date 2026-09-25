import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { guessPasswordCategory } from '@atlas/shared';
import { setupOwner, startApp, type Browser, type TestApp } from './helpers.js';

describe('guessPasswordCategory', () => {
  it.each([
    ['Domain admin', 'HDG\\administrator', '', 'domain'],
    ['DC01 DSRM', '', '', 'domain'],
    ['Global admin', 'admin@harbordental.onmicrosoft.com', 'https://admin.microsoft.com', 'cloud'],
    ['Office Wi-Fi', '', '', 'wifi'],
    ['Guest SSID', '', '', 'wifi'],
    ['FortiGate 60F', 'admin', 'https://10.20.0.1:8443', 'network'],
    ['Meraki dashboard', '', '', 'network'],
    ['HDG-FW-01 admin', 'admin', '', 'network'],
    ['Server local admin', 'administrator', '', 'server'],
    ['iDRAC HDG-HV01', 'root', '', 'server'],
    ['SQL sa', 'sa', '', 'database'],
    ['ScreenConnect', '', '', 'remote'],
    ['Dentrix', '', '', 'application'],
    ['Copier scan-to-email', '', '', 'device'],
    ['GoDaddy', '', 'https://sso.godaddy.com', 'website'],
    ['Spectrum business portal', '', '', 'vendor'],
    ['Front desk', 'frontdesk@harbordental.test', '', 'email'],
    ['Thing', '', '', 'other'],
  ])('%s', (name, username, url, expected) => {
    expect(guessPasswordCategory(name, username, url)).toBe(expected);
  });
});

describe('password types', () => {
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

  const add = (body: Record<string, unknown>) =>
    owner.call('POST', `/api/clients/${harbor}/passwords`, { secret: 'Tr0ub4dor&3-Harbor!', ...body });

  it('guesses a type until one is chosen, and can go back to guessing', async () => {
    const guessed = (await add({ name: 'FortiGate admin', username: 'admin' })).data;
    expect(guessed).toMatchObject({ category: 'network', categoryGuessed: true });

    const chosen = await owner.call('PATCH', `/api/passwords/${guessed.id}`, {
      category: 'remote',
      version: guessed.version,
    });
    expect(chosen.data).toMatchObject({ category: 'remote', categoryGuessed: false });

    const auto = await owner.call('PATCH', `/api/passwords/${guessed.id}`, {
      category: null,
      version: chosen.data.version,
    });
    expect(auto.data).toMatchObject({ category: 'network', categoryGuessed: true });

    expect((await add({ name: 'x', category: 'not-a-type' })).status).toBe(400);
  });

  it('lists the assets a password is linked to', async () => {
    const layouts = (await owner.call('GET', '/api/layouts')).data as { id: string; key: string }[];
    const layoutId = layouts.find((l) => l.key === 'configuration')!.id;
    const fw = (await owner.call('POST', `/api/clients/${harbor}/assets`, { layoutId, name: 'HDG-FW-01' })).data;
    const pw = (await add({ name: 'Firewall admin' })).data;
    const linked = await owner.call('POST', `/api/items/password/${pw.id}/relations`, { type: 'asset', id: fw.id });
    expect(linked.status, JSON.stringify(linked.data)).toBe(200);

    const [row] = (await owner.call('GET', `/api/passwords?client=${harbor}`)).data;
    expect(row.linkedAssets).toEqual([{ id: fw.id, name: 'HDG-FW-01' }]);
    expect((await owner.call('GET', `/api/passwords/${pw.id}`)).data.linkedAssets).toHaveLength(1);

    // Archived assets aren't shown.
    await owner.call('POST', `/api/assets/${fw.id}/archive`, { archived: true });
    expect((await owner.call('GET', `/api/passwords?client=${harbor}`)).data[0].linkedAssets).toEqual([]);
  });
});
